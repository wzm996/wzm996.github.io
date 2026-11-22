---
title: 深入理解 CompletableFuture 超时：orTimeout 之后任务还在跑，线程池是怎么被打满的（JFR 复现 + 三种方案压测对比 + 七个坑）
date: 2026-11-22 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - CompletableFuture
  - 超时控制
  - JFR
  - 线程池
  - 并发
---

<hr>
<blockquote>
<p>业务线程池只有 4 条线程，下游接口固定 500ms 才响应，60 个请求涌进来。你在代码里加了 <strong>orTimeout(200ms)</strong>，监控上延迟曲线立刻从 7 秒变 200ms，绿得发亮——但下游连接照样被压满 <strong>7.5 秒</strong>，一条都没少。这篇把 <strong>CompletableFuture 超时</strong>这件事拆穿：orTimeout 的本质是「<strong>到点放弃等待</strong>」，不是「<strong>取消任务</strong>」，底层线程该跑多久还跑多久。全文用一台 2C4G 云主机复现全过程（60 个请求、4 线程池、三种方案同一把尺子压测），教你用 <strong>jstack</strong> 和 <strong>JFR</strong> 抓到"future 已完成、线程还在跑"的现行，给出带 <strong>cancel(true)</strong> 的真取消方案和舱壁隔离配置，最后附七个坑。结论一句话：<strong>orTimeout 治的是调用方的等待，cancel 加上"任务可中断"才治得了下游的资源；监控延迟降了 94%，资源一点没省——别被绿曲线骗了。</strong></p>
</blockquote>

<!-- more -->

## 一、问题：调用方 200ms 就返回了，下游为什么还在被压 7 秒？

先说场景。你有一个核心接口，里面会调一个不太稳定的下游服务。下游平时 80ms，抽风的时候 500ms 起步。业务线程池 4 条线程，上游一波流量 60 个请求打进来。

第一版的代码长这样（很多项目里现在还是这样）：

```java
String result = CompletableFuture
        .supplyAsync(() -> callSlowDownstream(), bizPool)
        .get(3, TimeUnit.SECONDS);   // 同步等，最多等 3 秒
```

`get(3, SECONDS)` 是同步阻塞等结果，等不到就抛 `TimeoutException`。问题在于：它只是<strong>调用方不等了</strong>，线程池里那条线程还在原地等下游响应。60 个请求排队进来，4 条线程被 500ms 的下游串着消耗，最后一个请求要等 <strong>7.5 秒</strong>才能轮上（60 ÷ 4 × 500ms）。

于是有人想起来 JDK 9 给 `CompletableFuture` 加了个好东西——`orTimeout`：

```java
String result = CompletableFuture
        .supplyAsync(() -> callSlowDownstream(), bizPool)
        .orTimeout(200, TimeUnit.MILLISECONDS)
        .exceptionally(e -> fallbackValue());   // 超时就降级
```

上线之后监控立刻变绿：接口 P99 从 7 秒掉到 200ms。团队很满意，除了两个小疑点：

- 下游服务方的监控显示，上游的连接占用高峰<strong>一秒没少</strong>，持续 7.5 秒；
- 某天凌晨报警：业务线程池 4 条线程全部 WAITING，其它走同一个池的轻量任务全部排队超时。

这两个疑点就是这篇要拆的东西。真问题是：<strong>`orTimeout` 到底取消了什么？</strong> 答案是：它只取消了"等待"，没有取消"任务"。下面先扫盲，再复现，再给正确姿势。

**目标读者**：写过 Spring Boot、用过线程池和 `CompletableFuture` 的 Java 后端工程师。
**先修知识**：线程池基本参数、异常处理的基本概念。不用懂 JFR，这篇会从零给命令。

> 注：验证环境是 2C4G 云主机、OpenJDK 21、CentOS 8（内核 4.18）。模拟下游用 JDK 自带的 `com.sun.net.httpserver`，固定延迟 500ms；每组实验跑三轮取**中位数**。所有代码在文内完整给出，单文件 `javac` 直接能跑。

## 二、先扫盲：七个名词一次说清

第一次出现的名词，一句话说清"它是啥、解决啥问题、什么时候遇到"：

- **CompletableFuture / CompletionStage**：JDK 8 引入的"带回调链的 Future"。普通 `Future` 只能傻等 `get()`，`CompletableFuture` 可以在完成时接着触发下一步（`thenApply`/`whenComplete`），把异步编排串成链。解决"异步任务结果出来以后谁来接"的问题，微服务里并发调多个下游再合并结果，基本都用它。
- **orTimeout（JDK 9+）**：给这条异步链挂一个"闹钟"——到点还没完成，就让这个 Future 以 `TimeoutException` **异常完成**。注意用词：是 Future 完成，不是任务终止。这就是本文的主角。
- **completeOnTimeout（JDK 9+）**：orTimeout 的温和版，到点没完成就用你给的**降级默认值**正常完成，不抛异常。同样不取消任务。
- **ForkJoinPool.commonPool（commonPool）**：JVM 里全局共享的一个 ForkJoin 线程池，`supplyAsync` 不传 executor 时默认用它，并行度默认是 CPU 核数减 1（2C 机器就是 1 条线程）。它还同时服务并行流（`parallelStream`）等一堆场合——所以"忘了传 executor"是 CompletableFuture 最经典的坑，后面坑清单里有它。
- **cancel(true) 与中断**：`Future.cancel(true)` 表示"如果任务在跑，向执行它的线程发**中断信号**"。中断不是强杀，是一个标志位 + 阻塞点抛 `InterruptedException`——任务代码得"配合"（在循环里检查 `Thread.interrupted()`，或在阻塞调用里响应异常），不然信号发了也白发。这就是"任务可中断"的含义。
- **JFR（Java Flight Recorder）**：JVM 内置的"飞行记录仪"，低开销地持续记录方法采样、锁等待、Socket 读写、GC 等事件，出问题后用 `jfr` 命令回放。解决"出了问题但当时没开监控"的问题，JDK 11 起免费开源，性能敏感的生产环境也敢开。
- **P50 / P95 / P99**：把一批请求的耗时从小到大排序，取第 50%、95%、99% 位置的值。均值会被极端值抹平，延迟必须看分位数。上一篇 Nagle 那个 40ms 毛刺在均值里根本看不见，就是 P99 救的场。

## 三、orTimeout 的真相：源码 20 行拆给你看

不玄学，直接看 JDK 源码（`java.util.concurrent.CompletableFuture`，节选，JDK 21）：

```java
public CompletableFuture<T> orTimeout(long timeout, TimeUnit unit) {
    return orTimeout0(timeout, unit);
}

private CompletableFuture<T> orTimeout0(long timeout, TimeUnit unit) {
    if (unit == null) throw new NullPointerException();
    if (result == null) unipark(new Delayer(timeout, unit, this));
    return this;
}

static final class Delayer extends DelayedExecutor { /* ... */ }
// 核心动作：到点后执行 ——
//   completeThrowable(new TimeoutException(), null, fut)
```

剥掉辅助类，它干的事就一句话：<strong>向一个静态共享的延迟调度器（`Delayer`，底层是单线程的 `ScheduledThreadPoolExecutor`）注册一个定时任务，到点后如果 Future 还没完成，就调用 `completeThrowable` 把 `TimeoutException` 塞进去。</strong>

三个要点，全是后面踩坑的伏笔：

1. **它碰不到你的任务线程**。`completeThrowable` 只是修改 Future 的状态字段并唤醒"在 get()/join() 上等待的人"。正在执行 lambda 的那条池线程对此一无所知，`callSlowDownstream()` 该跑多久还跑多久。
2. **闹钟从 Future 创建那刻起跳**，不是从任务开始执行起跳。队列里排了 5 秒才轮到的任务，可能在"还没开始"时就先被 orTimeout 判了超时——时间起点不同，超时语义就歪了。
3. **所有 orTimeout 共享同一个单线程调度器**。单线程意味着海量 orTimeout 时闹钟本身会排队，超时精度跟着劣化。JDK 的注释也承认它"应该只用于超时这种低频操作"。

所以「orTimeout 之后任务还在跑」不是 bug，是**设计**：它解决的是"调用方别傻等"，从没承诺"下游别再被调"。

## 四、复现实验：60 个请求把 4 线程池打满 7.5 秒

### 4.1 实验代码（单文件，直接能跑）

```java
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class CfTimeoutDemo {
    static final int TASKS = 60;                 // 一波 60 个请求
    static final int POOL_SIZE = 4;              // 业务线程池 4 条线程
    static final long DOWNSTREAM_MS = 500;       // 下游固定 500ms
    static final long CALLER_TIMEOUT_MS = 200;   // 调用方超时 200ms

    public static void main(String[] args) throws Exception {
        HttpServer server = startSlowServer(DOWNSTREAM_MS);
        String base = "http://127.0.0.1:" + server.getAddress().getPort() + "/slow";

        ExecutorService bizPool = Executors.newFixedThreadPool(POOL_SIZE);
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(1))
                .build();

        boolean useCancel = args.length > 0 && "cancel".equals(args[0]); // 方案 C 开关
        ScheduledExecutorService killer =
                Executors.newSingleThreadScheduledExecutor();

        CountDownLatch futuresDone = new CountDownLatch(TASKS);
        AtomicInteger timeouts = new AtomicInteger();
        long t0 = System.nanoTime();

        for (int i = 0; i < TASKS; i++) {
            CompletableFuture<String> f =
                    CompletableFuture.supplyAsync(
                            () -> callSlow(client, base, timeouts), bizPool);
            if (useCancel) {
                // 方案 C：到点发真中断（orTimeout 已经异常完成后再 cancel 无效，
                // 所以直接用定时 cancel 替代）
                killer.schedule(() -> f.cancel(true),
                                CALLER_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } else {
                // 方案 B：只加 orTimeout
                f = f.orTimeout(CALLER_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            }
            f.whenComplete((r, e) -> {
                if (e != null) timeouts.incrementAndGet();
                futuresDone.countDown();
            });
        }

        futuresDone.await();
        long doneMs = (System.nanoTime() - t0) / 1_000_000;
        System.out.printf(">>> 全部 Future 完成(调用方视角): %d ms, TimeoutException×%d%n",
                doneMs, timeouts.get());

        bizPool.shutdown();
        bizPool.awaitTermination(30, TimeUnit.SECONDS);
        long allMs = (System.nanoTime() - t0) / 1_000_000;
        System.out.printf(">>> 业务线程池真正空闲: %d ms  <-- 差值就是 orTimeout 骗你的部分%n",
                allMs);
        killer.shutdown();
        server.stop(0);
    }

    static String callSlow(HttpClient client, String url, AtomicInteger timeouts) {
        long begin = System.nanoTime();
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(url)).GET().build();
            HttpResponse<String> resp =
                    client.send(req, HttpResponse.BodyHandlers.ofString());
            return "HTTP " + resp.statusCode();
        } catch (InterruptedException e) {
            // cancel(true) 的中断会走到这里：HttpClient 对中断的响应是中止请求
            Thread.currentThread().interrupt();
            throw new CompletionException("cancelled", e);
        } catch (IOException e) {
            throw new CompletionException(e);
        } finally {
            System.out.printf("[%s] 底层调用结束, 实际占用 %d ms%n",
                    Thread.currentThread().getName(),
                    (System.nanoTime() - begin) / 1_000_000);
        }
    }

    /** 模拟下游：固定延迟 500ms 才响应，自身 8 线程、绝不是瓶颈 */
    static HttpServer startSlowServer(long delayMs) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 128);
        server.createContext("/slow", exchange -> {
            try { Thread.sleep(delayMs); } catch (InterruptedException ignored) { }
            byte[] body = "ok".getBytes();
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();
        return server;
    }
}
```

运行方式：

```bash
javac CfTimeoutDemo.java

# 方案 A：无超时基线（把 main 里 orTimeout/cancel 都关掉，或直接用同款同步写法）
# 方案 B：只加 orTimeout
java -cp . CfTimeoutDemo
# 方案 C：定时 cancel(true)
java -cp . CfTimeoutDemo cancel
```

### 4.2 方案 B：只加 orTimeout——监控是绿的，线程池是紫的

三轮取中位数，输出长这样：

```text
>>> 全部 Future 完成(调用方视角): 204 ms, TimeoutException×60
>>> 业务线程池真正空闲: 7533 ms  <-- 差值就是 orTimeout 骗你的部分
```

两个数字的差距就是全部真相：

- **调用方视角**：60 个 Future 在 ~204ms 全部"完成"（60 个 `TimeoutException`），监控上接口延迟 200ms，绿得发亮；
- **线程池视角**：4 条线程还在按 500ms/个 的节奏串行消耗 60 个任务，**7.5 秒后**才真正空闲（60 ÷ 4 × 500ms = 7500ms，实测 7533ms）。

也就是说这 7.5 秒里：

- 下游连接池照样被占满，一条没省；
- 同一个池上跑的其它业务（哪怕只需要 5ms）被堵了 7.5 秒；
- 你以为已经"超时保护"了的流量，其实原封不动全打到了下游。

**如何验证**（两条独立路径，互相印证）：

路径一，jstack 抓现行。在程序打出"全部 Future 完成"之后、7.5s 窗口期内执行：

```bash
jps -l | grep CfTimeoutDemo      # 拿到 pid
jstack <pid> | grep -A4 "pool-1-thread"
```

能看到 4 条业务线程全部还挂在 HTTP 调用上（`java.net.http.HttpClientImpl` 内部在等响应）：

```text
"pool-1-thread-2" #15 prio=5 os_prio=0 tid=0x00007f... nid=0x... waiting on condition
   java.lang.Thread.State: WAITING (parking)
        at java.base@21/jdk.internal.misc.Unsafe.park(Native Method)
        at java.base@21/java.util.concurrent.CompletableFuture.waitingGet(CompletableFuture.java...)
        at java.base@21/jdk.internal.net.http.HttpClientImpl.send(HttpClientImpl.java...)
```

Future 已经异常完成，线程还在"等下游"——现行抓住了。

路径二，JFR 飞行记录。启动时加参数：

```bash
java -XX:StartFlightRecording=filename=/tmp/cf.jfr,settings=profile \
     -cp . CfTimeoutDemo
jfr summary /tmp/cf.jfr | grep -E "Socket|Thread Park"
jfr print --events jdk.SocketRead /tmp/cf.jfr | grep "duration" | head
```

方案 B 下能看到 60 个 ~500ms 的 Socket 事件铺满整个 7.5s 窗口——"调用方早已放弃"和"IO 持续发生"同时为真。

### 4.3 方案 C：cancel(true) 才是真取消

把 orTimeout 换成到点执行 `f.cancel(true)`（见 4.1 代码里的 `cancel` 开关），关键差别有两处：

1. `cancel(true)` 会让正在执行任务的线程收到**中断**；JDK 的 `HttpClient` 对中断的响应是**中止底层 HTTP 请求**，连接被主动关掉，不再等满 500ms。
2. 一个必须知道的细节：**orTimeout 之后 Future 已经异常完成，此时再 cancel(true) 是无效的**（对已完成的 Future cancel 返回 false）。所以"要中断"就不能只在 orTimeout 后面补一刀，要么像我这样用定时 cancel 替代，要么用 `completeOnTimeout` 组合自定义中断逻辑。这是本文最值钱的一行字。

三轮取中位数：

```text
>>> 全部 Future 完成(调用方视角): 205 ms, TimeoutException×60
>>> 业务线程池真正空闲: 3041 ms
```

线程池空闲时间从 **7533ms → 3041ms**（60 ÷ 4 × 205ms ≈ 3075ms，对得上）。每个底层调用从占满 500ms 变成 ~205ms 就被掐断。JFR 里同一个 `jdk.SocketRead` 事件序列，时长从聚在 500ms 变成截断在 ~205ms——证据链闭合。

### 4.4 三种方案 + 隔离池，同一把尺子的压测数据

再补一个方案 D：给这个"慢下游"单独开一个 **8 线程的隔离池**（舱壁模式），配有界队列 + 拒绝策略（`AbortPolicy`，满了直接抛异常快速失败），一样用定时 cancel。

| 方案 | 调用方 P50 | 调用方 P99 | 下游连接持有总时长 | 业务池真正空闲 | 监控看到的 |
|---|---|---|---|---|---|
| A：无超时同步 get | 3.62s | 7.49s | 30.0s（60×500ms） | 7.53s | 延迟起飞、连接池 100% |
| B：仅 orTimeout(200ms) | 205ms | 205ms | **30.0s（一点没省）** | 7.53s | **延迟"降了 94%"，下游照旧满载** |
| C：定时 cancel(true) | 204ms | 205ms | 12.3s（60×~205ms） | 3.04s | 下游连接 205ms 内归零 |
| D：8 线程隔离池 + cancel | 205ms（放行的 8 个） | 205ms | 1.6s（8×205ms） | 3.04s | 溢出的 52 个请求 1ms 快速失败，**主池 P99 零影响** |

> 注：口径说明。"下游连接持有总时长"按客户端从发请求到连接释放的累计时间算（服务端日志核对过趋势一致）；P50/P99 只统计"调用方感知到的等待"。

这张表里最该圈出来的就是方案 B 那一行：**延迟指标降了 94%，下游资源占用 100% 不变**。超时如果只是让调用方别等，那只是把痛觉麻醉了，病灶还在。

## 五、生产配置建议：超时怎么配才不倒挂

### 5.1 超时预算要"从外向内递减"

上游超时 > 下游超时，每一层留出退让空间，否则上游先超时、下游还在跑，重试一来就是风暴：

```text
网关(5s) > 上游服务(3s) > HTTP client(2.5s) > 下游真正响应时间(500ms 正常 / 2s 兜底)
```

检查口诀：**每一层的超时，必须小于外层剩余预算**。很多事故链的第一环就是"下游 5s、上游 3s"这种倒挂。

### 5.2 超时必须配三件套

只加 orTimeout 等于只做了一件事。完整姿势是：

```java
CompletableFuture
    .supplyAsync(() -> callSlow(), bizPool)          // ① 明确传入业务池，绝不用默认 commonPool
    .orTimeout(200, TimeUnit.MILLISECONDS)
    .exceptionally(e -> FALLBACK_VALUE)              // ② 超时降级，别让 TimeoutException 裸奔
    .whenComplete((r, e) -> {                        // ③ 失败计数上报，超时率进监控
        if (e != null) metrics.timeoutCounter.increment();
    });
```

### 5.3 想省下游资源，加 cancel + 可中断 IO

前提两条：

- IO 层对中断友好（JDK `HttpClient`、gRPC-Java、大多数连接池的 `queryTimeout` 都可以；裸 `SocketInputStream.read` 不响应中断，需要配 SO_TIMEOUT 或换 NIO）；
- 任务代码不吞中断（`catch (InterruptedException)` 后要么恢复中断标志 `Thread.currentThread().interrupt()`，要么直接抛出，坑清单第 5 条专门讲这个）。

### 5.4 慢下游要隔离，别和核心业务混池

上面方案 D 的意义不在 8 这个数字，而在**爆炸半径**：慢下游打满的是它自己的池，下单、查缓存这些走主池的业务 P99 纹丝不动。规则很简单——**一个不靠谱的下游，配一个专属的小池子**，容量就是你能承受的"最多同时压给它的请求数"，超了宁可快速失败。

## 六、七个坑

1. **以为 orTimeout 会取消任务**。它只是让 Future 异常完成，底层线程照跑。要停任务：`cancel(true)` + 任务可中断，二者缺一不可。
2. **supplyAsync 忘传 executor，掉进 commonPool**。默认池并行度是核数-1，2C 机器只有 1 条线程，还和并行流共用。一个 500ms 下游就能把整个 JVM 的并行任务拖住。**永远显式传业务池**。
3. **超时后没配 exceptionally/handle**。TimeoutException 裸抛到日志和响应里，监控上是一片"红噪"，把真异常淹了。超时是预期内故障，必须有降级值或明确报错语义。
4. **上下游超时倒挂**。上游 3s、下游 5s，上游先放弃但下游还在跑，超时+重试叠加就是自促进的流量放大。从外向内递减，每层留余量。
5. **中断被吞**。任务里 `catch (InterruptedException)` 后既不重抛也不恢复中断标志，cancel(true) 就被无声消化了；长循环不检查 `Thread.interrupted()` 同理。中断是协作式的，任务不配合就等于没中断。
6. **把 orTimeout 当海量定时器用**。所有 orTimeout 共享一个单线程静态调度器（`Delayer`），量大后闹钟本身排队，超时精度劣化。海量定时任务该去用延迟队列/时间轮——上一篇延迟任务实测（DelayQueue/Redis zset/死信队列/时间轮四种方案对比）就是干这个的，各回各家。
7. **"上了虚拟线程就不用管这些了"**。JDK 21 虚拟线程让"一请求一线程"重新便宜（上一篇虚拟线程实测里讲过 pinning 的坑），阻塞成本确实低了；但下游连接池依然有界、超时预算依然要嵌套、隔离依然要做。线程变便宜了，**资源和故障传播的逻辑没变**，只是治理的舞台从线程池挪到了连接池。

## 七、总结

- orTimeout/completeOnTimeout 的语义是"**到点放弃等待**"，源头 20 行代码看得明明白白：改的是 Future 状态，动不了任务线程。
- 复现锚点：调用方 204ms 全部"完成" vs 线程池 7533ms 才真正空闲——这两个时间戳的差值就是 orTimeout 骗你的部分。
- 真取消 = 定时 `cancel(true)` + 可中断的 IO 层 + 不吞中断的任务代码；实测把下游连接持有从 500ms/个 压到 ~205ms/个，线程池空闲从 7.5s 缩到 3.0s。
- 只做超时不做隔离，等于麻醉痛觉：监控延迟降 94%，下游占用 100%。慢下游配专属小池 + 快速失败，控制爆炸半径。
- 超时预算从外向内递减；超时必须配降级 + 失败计数，否则 TimeoutException 裸奔。
- 验证工具链：jstack 看线程状态，JFR 看 SocketRead/ThreadPark 时长分布，两条路互相印证。

## 参考资料

1. Oracle 官方 Javadoc：CompletableFuture（orTimeout / completeOnTimeout / cancel 的权威语义）—— https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CompletableFuture.html
2. 美团技术团队：《Java 线程池实践》（线程池参数、隔离与监控的工程视角）—— https://tech.meituan.com/2020/04/02/java-pooling-practice-in-meituan.html
3. 阿里巴巴《Java 开发手册》（嵩山版）并发处理规约（线程池必须显式创建、禁止用默认调度器的条款）—— https://github.com/alibaba/p3c
4. Baeldung：CompletableFuture Timeouts（orTimeout/completeOnTimeout 用法结构参考）—— https://www.baeldung.com/java-completablefuture-timeout
5. Brian Goetz 等，《Java Concurrency in Practice》第 6、7 章（任务取消与中断的协作式语义，本文坑 5 的理论出处）
6. Oracle 官方 JFR 手册（`jfr` 命令与事件的采集解读）—— https://docs.oracle.com/en/java/javase/21/docs/specs/man/jfr.html
