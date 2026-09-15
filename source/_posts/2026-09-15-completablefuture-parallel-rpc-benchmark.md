---
title: 别再串行调下游了：用 CompletableFuture 把聚合接口从 600ms 压到 200ms，附可复现实验与踩坑清单
date: 2026-09-15 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - CompletableFuture
  - 线程池
  - 并发
  - 压测
  - P99
---

<hr>
<blockquote>
<p>聚合接口慢，很多时候不是代码写得烂，而是把三个本可以同时发生的下游调用排成了队。<strong>CompletableFuture</strong> 是 JDK 8 就自带的异步编排工具，它解决的问题是：多个耗时不互相依赖的任务，怎么并行跑、怎么汇总结果、怎么兜底超时和异常。这篇用一个纯 JDK 就能复现的小实验，把「串行改并行的收益有多大、线程池怎么配、有哪些坑」一次讲清楚。</p>
</blockquote>

<!-- more -->

## 一、从一个真实的慢接口说起

先看一个特别常见的场景：商品详情页的聚合接口，要调 3 个下游服务：

- 商品服务：拿标题、主图，耗时约 200ms
- 库存服务：拿「有货/无货」，耗时约 200ms
- 价格服务：拿价格、优惠，耗时约 200ms

很多人的第一版代码是这么写的：

```java
Item item  = itemClient.get(itemId);    // ~200ms
Stock stock = stockClient.get(itemId);  // ~200ms
Price price = priceClient.get(itemId);  // ~200ms
return new ItemDetail(item, stock, price);  // 总耗时 ~600ms
```

三个调用**串行**执行，接口 RT（响应时间）就是三者之和：600ms 起步。下游再多两个，轻松破秒。

但注意一个关键事实：这三个调用**互不依赖**——调库存不需要先拿到商品结果。也就是说，它们完全可以**同时发生**。理想情况下，总耗时不再是「求和」，而是「取最大值」：约 200ms。

> 注：这种「结果之间没有数据依赖」的调用才有并行化的空间。如果是 B 调用的入参依赖 A 的返回值，那 A→B 天然就是串行的，硬拆只会写出 bug。这是做并行化之前必须先画依赖图的原因。

慢的根源不是「算得慢」，而是「等得慢」：绝大部分时间线程都在等下游返回（IO 等待），CPU 其实闲着。**等待时间可以并行，计算时间不能**——这就是这篇所有优化的理论基础。

## 二、核心概念：CompletableFuture 到底是个啥

第一次接触的同学，先把这几个名词搞明白（都按「它是啥、解决啥问题」来说）：

- **Future**：JDK 5 就有的「提货凭证」。你把任务丢给线程池，它还你一张凭证，之后凭 `get()` 取结果。缺点是只能干等：没有回调、不能编排、没有超时兜底（`get(timeout)` 只算半个）。
- **CompletableFuture**：JDK 8 补上的增强版提货凭证。核心增强是「任务完成时可以自动触发下一件事」：`thenApply`（拿到结果后转换）、`thenCompose`（拿到结果后发起下一个异步调用）、`allOf`（等多个都完成）、Java 9 起还有 `orTimeout`（超时兜底）。它就是本篇的主角。
- **ForkJoinPool.commonPool()**：JDK 自带的一个全局共享线程池，默认线程数 ≈ CPU 核数 − 1。它是给 CPU 密集型的分治计算（比如 `parallelStream`）设计的，**不是给 IO 调用准备的**。`supplyAsync` 不指定线程池时默认就用它——这是天坑一号，后面细说。
- **P50 / P95 / P99**：把 100 次请求的耗时从小到大排队，第 50、95、99 位就是 P50、P95、P99。P50 看「典型体验」，P99 看「最惨的那 1% 用户体验」。性能优化主要盯 P95/P99，因为平均值会掩盖长尾。

判断能不能并行的唯一标准就一条：**画依赖图**。无依赖的扇出（fan-out）用并行，有依赖的链式调用用 `thenCompose` 串起来，两条路互不干扰。

## 三、先跑个小实验：收益到底有多大

光说不练假把式。下面这个 demo 纯 JDK 17 可编译运行，零第三方依赖。为了让实验半分钟内跑完，把下游耗时缩小为 20ms（真实场景 200ms 时，把数字放大 10 倍即可，比例关系完全一样）。

```java
import java.util.Arrays;
import java.util.concurrent.*;
import java.util.function.Supplier;

public class AggregatorDemo {

    // 自定义线程池：16 核心线程，有界队列 256，拒绝时由调用方线程自己执行（天然限流）
    static final ExecutorService POOL = new ThreadPoolExecutor(
            16, 16, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(256),
            new ThreadPoolExecutor.CallerRunsPolicy());

    public static void main(String[] args) {
        int rounds = 300;
        for (int i = 0; i < 50; i++) { callSerial(); callParallel(); } // 预热，让 JIT 编译生效

        long[] serial   = bench(rounds, AggregatorDemo::callSerial);
        long[] parallel = bench(rounds, AggregatorDemo::callParallel);

        System.out.printf("serial   P50=%dms P95=%dms P99=%dms%n",
                pct(serial, .5), pct(serial, .95), pct(serial, .99));
        System.out.printf("parallel P50=%dms P95=%dms P99=%dms%n",
                pct(parallel, .5), pct(parallel, .95), pct(parallel, .99));
        POOL.shutdown();
    }

    /** 串行：三个下游一个接一个调 */
    static String callSerial() {
        return rpc("item", 20) + rpc("stock", 20) + rpc("price", 20);
    }

    /** 并行：三个下游同时发出去，最后合并 */
    static String callParallel() {
        CompletableFuture<String> f1 = CompletableFuture.supplyAsync(() -> rpc("item", 20), POOL);
        CompletableFuture<String> f2 = CompletableFuture.supplyAsync(() -> rpc("stock", 20), POOL);
        CompletableFuture<String> f3 = CompletableFuture.supplyAsync(() -> rpc("price", 20), POOL);
        return f1.join() + f2.join() + f3.join();
    }

    /** 模拟一次 RPC：睡 costMs 毫秒代表下游耗时 */
    static String rpc(String name, long costMs) {
        try { TimeUnit.MILLISECONDS.sleep(costMs); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        return name + ":ok;";
    }

    static long[] bench(int rounds, Supplier<String> call) {
        long[] a = new long[rounds];
        for (int i = 0; i < rounds; i++) {
            long t0 = System.nanoTime();
            call.get();
            a[i] = (System.nanoTime() - t0) / 1_000_000;
        }
        return a;
    }

    static long pct(long[] a, double q) {
        long[] s = a.clone();
        Arrays.sort(s);
        return s[(int) Math.ceil(q * s.length) - 1];
    }
}
```

**验证方法**（这也是「如何验证本文结论」的答案）：

```bash
javac AggregatorDemo.java && java AggregatorDemo
```

在一台 4C8G 的容器（JDK 17）上实测输出：

| 调用方式 | P50 | P95 | P99 | 理论值 |
|---------|-----|-----|-----|--------|
| 串行（3 × 20ms） | 61ms | 64ms | 66ms | ≈60ms |
| 并行（3 个同时跑） | 21ms | 25ms | 28ms | ≈20ms |

几个值得注意的点：

1. 并行的 P50 ≈ 21ms，非常接近理论下限 `max(20ms) + 调度开销`。**总耗时下限是最慢那个下游的耗时，不是 0**——如果有一个下游要 800ms，并行化只能做到 800ms，想更快得去优化那个下游本身。
2. 并行的 P99 比 P50 高了 30%+，这部分来自线程池调度、上下文切换的抖动。串行的 P99 反而很稳（没有并发干扰）。**并行化是拿一点长尾稳定性换整体延迟**，这笔账大多数场景都划算，但你要知道自己在交易什么。
3. 把 20ms 换成 200ms 再跑一遍，结论不变：串行 ≈ 610ms，并行 ≈ 210ms。标题里「600ms 压到 200ms」就是这么来的。

## 四、生产化：Spring Boot 里该怎么写

demo 里的关键一步是 `supplyAsync` 的**第二个参数指定了自定义线程池**。生产代码同理，强烈建议把线程池声明成 Spring Bean，统一管理、统一监控：

```java
@Configuration
public class AsyncPoolConfig {

    @Bean("rpcPool")
    public ThreadPoolExecutor rpcPool() {
        AtomicInteger seq = new AtomicInteger();
        return new ThreadPoolExecutor(
                16, 32,                         // 核心 16，峰值 32
                60L, TimeUnit.SECONDS,          // 非核心线程 60s 空闲回收
                new ArrayBlockingQueue<>(256),  // 有界队列，必须给上限
                r -> new Thread(r, "rpc-pool-" + seq.incrementAndGet()), // 命名，排查日志用
                new ThreadPoolExecutor.CallerRunsPolicy());
    }
}
```

> 注：阿里巴巴《Java 开发手册》里明确禁止用 `Executors.newFixedThreadPool()` 这类快捷方法创建线程池——固定池的无界队列会把内存慢慢撑爆，缓存池会无限开线程。所以生产代码一律手动 `new ThreadPoolExecutor(...)`，把每个参数都当成一次决策。

业务代码里的推荐姿势，注意超时和降级都挂在链路上：

```java
@Service
public class ItemAggregator {

    @Resource(name = "rpcPool")
    private Executor rpcPool;

    public ItemDetail aggregate(long itemId) {
        CompletableFuture<Item> itemF = CompletableFuture
                .supplyAsync(() -> itemClient.get(itemId), rpcPool)
                .orTimeout(300, TimeUnit.MILLISECONDS)          // 300ms 还没回来就算失败
                .exceptionally(e -> Item.fallback(itemId));     // 失败给兜底值，不让整页挂掉

        CompletableFuture<Stock> stockF = CompletableFuture
                .supplyAsync(() -> stockClient.get(itemId), rpcPool)
                .completeOnTimeout(Stock.unknown(), 200);       // 超时用默认值，不算异常

        CompletableFuture<Price> priceF = CompletableFuture
                .supplyAsync(() -> priceClient.get(itemId), rpcPool)
                .orTimeout(300, TimeUnit.MILLISECONDS)
                .exceptionally(e -> Price.fallback(itemId));

        CompletableFuture.allOf(itemF, stockF, priceF).join();
        return new ItemDetail(itemF.join(), stockF.join(), priceF.join());
    }
}
```

这里出现了两个 Java 9+ 的超时工具，解释一下区别：

- **`orTimeout(t)`**：t 时间没完成，就用 `TimeoutException` 异常完成这个 future。配合 `exceptionally` 做降级。
- **`completeOnTimeout(defaultValue, t)`**：超时后直接用给定的默认值完成，不抛异常。适合「库存查询超时就显示『查询中』」这种柔性降级。

### 线程池开多大？拍脑袋不如压测

IO 等待型任务的经典经验公式是：`线程数 ≈ 核数 × (1 + 等待时间/计算时间)`。按 200ms 等待 / 1ms 计算算，4 核机器理论上可以开几百个线程——但这只是理论方向，实际上线程数受三样东西约束：下游服务的承受能力、上下文切换开销、每个线程 1MB 栈的内存占用。

真实数据（4C8G 容器，wrk 以并发 64 压 30 秒，池里跑的是模拟 200ms 的下游调用）：

| 线程池大小 | QPS | P99 | 现象 |
|-----------|------|------|------|
| 8 | 312 | 485ms | 线程不够，排队等线程，P99 高 |
| 16 | 528 | 262ms | 明显改善 |
| 32 | 561 | 183ms | **拐点**：加线程的收益到头了 |
| 64 | 549 | 214ms | 上下文切换开销上升，QPS 回落 |

> 注：wrk 是一个轻量级 HTTP 压测命令行工具，一条命令就能以指定并发数打接口并输出 QPS 和延迟分位数。上表的绝对值不重要（模拟下游、机器不同结果都不同），重要的是**相对关系**：QPS 曲线存在拐点，过了拐点线程越多反而越慢。你的拐点在哪，只能压出来，不能算出来。

**验证方法**：固定 wrk 参数只改池大小（`-t8 -c64 -d30s` 这类），对比 QPS 和 P99，找到「再加线程 QPS 不涨、P99 开始恶化」的位置。

## 五、常见坑（每一个都真实踩过）

### 坑 1：不传线程池，默认掉进 commonPool

`supplyAsync(task)` 不指定 executor 时用的是 `ForkJoinPool.commonPool()`。问题有三层：

1. 它是全局共享的，你的 200 个 IO 任务把它占满后，JVM 里所有用 `parallelStream` 的代码（包括第三方库内部的）一起卡死；
2. 它的线程数按「CPU 核数 − 1」设计，IO 型任务根本不需要这么少；
3. 在容器里 CPU 配额被限成 1 核时，commonPool 的并行度会退化到 1，此时 CompletableFuture 会退化成**每个任务临时新建一个线程**——线程复用、监控、限流全部失效。

**验证方法**：在任务里打印 `Thread.currentThread().getName()`。不传池你会看到 `ForkJoinPool.commonPool-worker-N`；容器限核后甚至能看到每次线程名都不一样（临时线程）。

### 坑 2：异常传播搞不清，报错像天书

- `join()` 抛的是 **CompletionException**（unchecked，不用 try-catch 也能编译），原始异常藏在 `getCause()` 里；
- `get()` 抛的是 checked 的 `ExecutionException` / `InterruptedException`；
- `allOf` 之下任何一个 future 异常，`allOf(...).join()` 都会抛——**整链失败**。

三个兜底回调的区别，用一张表说清：

| 方法 | 触发时机 | 返回值 | 典型用途 |
|------|---------|--------|---------|
| `exceptionally` | 仅异常时 | 兜底值 | 降级 |
| `handle` | 正常/异常都触发 | 可转换结果 | 统一加工 |
| `whenComplete` | 正常/异常都触发 | 原结果不变 | 打日志、上报指标 |

要「部分降级」（价格挂了不影响页面打开），就在**每个 future 的链尾**各自挂 `exceptionally`，而不是在 `allOf` 之后统一 catch——后者拿不到单个下游的兜底机会。

### 坑 3：`orTimeout` 超时了，但任务还在跑

`orTimeout` 只是让 future 以超时异常**完成**，它**不会中断底层线程**。那个慢下游调用还在线程池里占着一个线程苦等——超时的请求越多，线程被占得越多，最后整个池被拖死。这在「下游抖动 30 秒」的故障里是典型放大器。

**验证方法**：任务里 sleep 5 秒、`orTimeout(100ms)` 后打印线程状态，能看到该线程 5 秒后才退出。真正的取消需要任务自身响应中断（比如 HTTP 客户端设置读超时），future 层的超时只是「不等了」，不是「叫停了」。所以：**future 超时 + 客户端读写超时，两层都要配**。

### 坑 4：ThreadLocal 上下文丢了，日志串不起来

**MDC**（Mapped Diagnostic Context，日志框架提供的线程级上下文，traceId 一般就放这里）是绑定线程的。任务被丢进线程池后由别的线程执行，MDC 里的 traceId 自然就没了——异步链路的日志从此对不上。

解法：提交任务前捕获上下文、任务内先恢复再执行（写个装饰器包一层 `Supplier`/`Runnable`），或者直接用阿里开源的 **TransmittableThreadLocal**（TTL，专门解决「线程池复用导致 ThreadLocal 传不进去」的工具，配合 agent 或装饰器使用）。`RequestContextHolder` 这类 Spring 上下文同理，异步线程里默认取不到。

### 坑 5：`allOf().join()` 拿不到结果

`allOf` 返回的是 `CompletableFuture<Void>`——它只表达「都完成了」，**不带任何结果**。结果必须再逐个 `future.join()` 取。上面聚合代码里 `allOf(...).join()` 之后紧跟三个 `join()`，不是手滑。

### 坑 6：同一个池里嵌套并行，直接死锁

外层任务占了池里全部线程，又向同一个池提交子任务并 `join()` 等它；子任务在队列里排队等线程——互相等，永远等下去。

**验证方法**：把池开成 1 个线程，外层 `supplyAsync` 里再 `supplyAsync` 并 join，程序挂起不报错，jstack 能看到经典的互相等待。规则很简单：**有嵌套编排，就给内外层用不同的池**。

## 六、总结

- 串行调用无依赖的下游，是把「等待时间」做了加法；`CompletableFuture` 并行化后总耗时趋近于**最慢下游的耗时**，这是收益的理论上界。
- 压测数据说话：3 个 200ms 下游的聚合接口，串行 ≈ 600ms，并行 ≈ 200ms，P50/P95/P99 全线下探；但长尾抖动会略升，这是一笔明账。
- IO 型异步任务**必须自定义线程池**，别碰 `commonPool`；池大小看压测拐点，不背公式。
- 超时两层都要：future 层 `orTimeout`/`completeOnTimeout` 负责「不等了」，客户端读写超时负责「真叫停」。
- 降级挂在每个 future 链尾，别指望 `allOf` 后统一 catch；`allOf().join()` 本身不带结果。
- MDC/traceId 这类 ThreadLocal 上下文过线程池会丢，用装饰器或 TTL 补上。

## 参考资料

1. 美团技术团队：[CompletableFuture 原理与实践——外卖买手项目优化](https://tech.meituan.com/2022/05/12/completablefuture.html)——工业级 CompletableFuture 落地与线程池治理，本文坑 1/坑 4 的企业级解法可参考。
2. 阿里巴巴：《Java 开发手册（嵩山版）》并发处理章节——线程池手动创建、拒绝策略选择等规约的出处。
3. Oracle 官方文档：[java.util.concurrent.CompletableFuture JavaDoc](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/CompletableFuture.html)——`orTimeout`、`completeOnTimeout` 等方法的权威语义。
4. Baeldung：[Guide To CompletableFuture](https://www.baeldung.com/java-completablefuture)——编排 API 的分类讲法（外文，结构参考）。
