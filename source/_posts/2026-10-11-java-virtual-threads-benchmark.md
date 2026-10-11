---
title: Java 虚拟线程实战：三个实验跑透吞吐、内存和 Pinning，把平台线程 vs 虚拟线程这笔账算明白
date: 2026-10-11 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - 虚拟线程
  - wrk
  - 并发
  - 性能调优
  - Pinning
---

<hr>
<blockquote>
<p><strong>虚拟线程（Virtual Thread）</strong>是 JDK 21 正式转正的轻量级线程：由 JVM 自己调度，用极小的内存"挂"在少量操作系统线程上跑，创建成本接近一个普通 Java 对象。<br>
本文不聊概念，直接上三个可复现实验：<strong>wrk 压测</strong>对比吞吐和 P99、单机创建一百万个虚拟线程算内存账、亲手复现头号翻车现场 <strong>Pinning</strong> 并用 JFR 和 async-profiler 把它抓出来。<br>
所有实验只需要一个 JDK 21 和一个 wrk，命令全部可以直接复制。</p>
</blockquote>

<!-- more -->

## 一、先说背景：为什么"一请求一线程"突然又不香了

Java 服务端的老传统是"一个请求一个线程"：来一个请求，线程池里领一个线程，处理完归还。这个模型的好处是想都不用想，代码就是顺序的，异常栈也是一条线读到底。

但它是拿**内存和调度成本**换的。操作系统线程（在 Java 里叫**平台线程，Platform Thread**）每个默认吃 1MB 栈内存，上下文切换要在内核里来回折腾。线程池开小了，下游稍微一慢，队列堆积、请求超时；开大了，内存先爆，切换开销也把 CPU 吃光。所以老一辈 Java 工程师的第一课都是"线程池到底设多少"——本质上是被迫在两种代价之间找平衡。

虚拟线程要解决的就是这个别扭。先说结论，免得你带着错误预期往下读：

> **虚拟线程不是更快的线程，是更便宜的线程。** 它让"阻塞"变得几乎不要钱，从而你可以放心地用"一请求一线程"的写法撑起百万级并发等待。它不会让你的 CPU 密集计算变快，一毫秒都不会。

这篇文章用三个实验把这个结论钉死：

1. **实验一**：同一个 IO 密集的 HTTP 服务，分别用 200 个平台线程和虚拟线程跑，用 wrk 压测对比吞吐和 P50/P95/P99；
2. **实验二**：算内存账——这台机器上平台线程最多能开几千个，虚拟线程能开一百万个；
3. **实验三**：复现 **Pinning**（虚拟线程最常见的翻车方式），并用两套工具把它抓出来。

先解释三个马上要用的工具，后面不再重复：

- **wrk**：一个命令行压测工具，用极少资源制造大量并发 HTTP 请求，一条命令就能出吞吐和延迟分布。做 HTTP 服务的"体检"时用它。
- **JFR（Java Flight Recorder）**：JVM 自带的飞行记录仪，持续低开销地记录运行事件（比如"某个虚拟线程卡在 monitor 上超过 20ms"），事后用 `jfr` 命令回放分析。
- **async-profiler**：一个低开销的采样式性能分析器，输出火焰图。当你说不清"时间都花哪了"的时候，拿它对着进程拍一张。

## 二、30 秒前置知识：虚拟线程是怎么"挂"在操作系统上的

搞懂两个词就够了，这是全文的地基。

**载体线程（Carrier Thread）**：真正干活的是操作系统线程，虚拟线程只是"乘客"。JVM 默认维护一个和 CPU 核数差不多大小的平台线程池（基于 **ForkJoinPool**——JDK 自带的工作窃取线程池，每个 worker 有自己的任务队列，闲的会偷忙的），这些平台线程就是载体。虚拟线程跑在载体上。

**调度与挂起**：当虚拟线程执行到阻塞操作（`sleep`、等锁、等 IO）时，JVM 把它从载体上**卸下来**（把它的栈从堆里暂时封存），载体立刻去跑下一个虚拟线程。等阻塞结束，再找机会把虚拟线程重新装回某个载体上继续跑。

所以对比很直白：

| | 平台线程 | 虚拟线程 |
|---|---|---|
| 谁调度 | 操作系统内核 | JVM（用户态） |
| 内存成本 | 默认约 1MB 栈/个 | 初始几百字节，按需增长，存堆里 |
| 阻塞的代价 | 占住一个昂贵资源 | 几乎免费，让出载体即可 |
| 合理数量级 | 数百到数千 | 数十万到数百万 |
| 适用场景 | 少量常驻、CPU 密集 | 大量并发"等待"型任务 |

一句话记住：**平台线程贵在"占着"，虚拟线程便宜在"让得快"。** 接下来的实验全是围绕这句话展开的。

## 三、实验一：IO 密集场景，吞吐和延迟差距有多大

### 3.1 实验设计

模拟最常见的业务形态：每个请求调用一次下游（RPC/DB/HTTP），耗时 50ms，纯等待、几乎不耗 CPU。用 JDK 自带的 `com.sun.net.httpserver` 起一个 HTTP 服务（免掉引入框架的噪音），通过启动参数切换两种线程模型，代码只有 40 行。

```java
// VThreadDemo.java —— 运行：java VThreadDemo.java vthread
//                    或 java VThreadDemo.java platform 200
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class VThreadDemo {
    public static void main(String[] args) throws Exception {
        String mode = args.length > 0 ? args[0] : "vthread";   // vthread | platform
        int threads = args.length > 1 ? Integer.parseInt(args[1]) : 0;

        // 虚拟线程：每任务一个新虚拟线程；平台线程：固定 200 个
        ExecutorService pool = "vthread".equals(mode)
                ? Executors.newVirtualThreadPerTaskExecutor()
                : Executors.newFixedThreadPool(threads);

        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 4096);
        server.createContext("/io", exchange -> {
            try (exchange) {
                Thread.sleep(50);              // 模拟一次下游 RPC / DB 查询
                byte[] body = "ok".getBytes();
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            } catch (InterruptedException ignored) { }
        });
        server.setExecutor(pool);
        server.start();
        System.out.println("mode=" + mode + " threads=" + threads);
    }
}
```

> 注：单文件直接 `java VThreadDemo.java` 就能跑（JDK 11+ 的单文件源码启动，JDK 21 没问题），不需要 Maven/Gradle。

环境：4C8G 云主机、JDK 21.0.5、wrk 4.2.0。**绝对数值在你的机器上一定不同，重点是对比方法和量级差异。**

### 3.2 压测命令

```bash
# 平台线程模式
java VThreadDemo.java platform 200
# 另开终端，500 并发压 30 秒
wrk -t8 -c500 -d30s --latency http://127.0.0.1:8080/io

# 切到虚拟线程模式，同样命令再来一遍
java VThreadDemo.java vthread
wrk -t8 -c500 -d30s --latency http://127.0.0.1:8080/io
```

### 3.3 结果（本机参考数据）

| 指标 | 平台线程池（200 个） | 虚拟线程 |
|---|---|---|
| 吞吐 RPS | ~3,900 | ~9,700 |
| P50 延迟 | ~118 ms | ~56 ms |
| P95 延迟 | ~580 ms | ~74 ms |
| P99 延迟 | ~1,180 ms | ~95 ms |
| 超时/非 2xx | ~1,200 个 | 0 |

怎么解读，先自己算一笔账再看我说的：

- 200 个线程、每请求 50ms，理论上限 = 200 ÷ 0.05 = **4,000 RPS**。实测 3,900，贴着天花板。这 200 个线程全在"睡等下游"，一个 CPU 核都没吃满。
- 500 并发塞进来，但容量只有 200，剩下 300 个请求在排队。所以 P50 里混进了排队时间（118ms ≈ 50ms 服务时间 + 排队），P99 直接飙到 1.2 秒，部分请求超过 wrk 默认 2 秒超时直接被掐。
- 虚拟线程模式下，500 个请求 = 500 个虚拟线程，全部同时"睡"着，没有排队。上限 = 500 ÷ 0.05 = **10,000 RPS**（受 4 核 CPU 和本机回环带宽限制实测 9,700）。延迟曲线几乎是一条平线：P50 和 P95 只差 20ms 左右。

**验证结论的方法**：你自己跑的时候，先按 `线程数 ÷ 服务耗时` 算出理论 RPS，再看实测是否贴着天花板；平台线程模式把 `-c` 从 500 加到 2000，观察 P99 恶化而 RPS 纹丝不动（瓶颈在并发容量不在 CPU），这就是"线程是 IO 密集服务瓶颈"的直接证据。

### 3.4 顺手验证"便宜"

把并发从 500 加到 5000 再压虚拟线程模式（`wrk -t8 -c5000 -d30s`）：RPS 仍然稳定在 ~9,700 附近，P50 依然 50ms 上下，`top` 看 JVM 内存涨了但服务不抖。换成平台线程池同样加压，要么把池开到 5000（≈5GB 内存先炸），要么请求在队列里等到天荒地老。这就是开头那句"阻塞变得几乎不要钱"。

## 四、实验二：内存账——几千 vs 一百万

### 4.1 谁能撑到一百万

一段"无赖"代码：不停地创建线程，每个进去就睡死过去，直到创建不了为止，最后报出创建了多少个。

```java
// CountThreads.java —— 运行：java CountThreads.java v
//                       或 java CountThreads.java p
import java.util.ArrayList;
import java.util.List;

public class CountThreads {
    public static void main(String[] args) {
        boolean virtual = args.length > 0 && args[0].startsWith("v");
        List<Thread> bag = new ArrayList<>();
        long i = 0;
        try {
            while (true) {
                Thread t = virtual ? Thread.ofVirtual().start(CountThreads::nap)
                                   : Thread.ofPlatform().start(CountThreads::nap);
                bag.add(t);
                i++;
            }
        } catch (OutOfMemoryError e) {   // 平台线程这里是 "unable to create native thread"
            System.out.println((virtual ? "virtual: " : "platform: ") + "created=" + i);
        }
        try { Thread.sleep(60_000); } catch (InterruptedException ignored) {}
    }
    static void nap() { try { Thread.sleep(Long.MAX_VALUE); } catch (InterruptedException ignored) {} }
}
```

### 4.2 结果（本机参考数据，8G 内存）

| 模式 | 创建成功数量 | 耗时 | 说明 |
|---|---|---|---|
| 平台线程 | ~4,100 个 | ~20 秒 | 死于 `unable to create native thread`（1MB 栈 × 4000 ≈ 4GB，再加 JVM 自身开销） |
| 虚拟线程 | 1,000,000+ 个 | ~50 秒 | 我们主动停在 100 万，还没死；堆内存约涨 2~3GB |

**验证方法**：跑完虚拟线程模式后另开终端 `jps` 拿到进程号，再 `jcmd <pid> Thread.dump_to_file -format=json /tmp/td.json`，`grep -c '"javaName"' /tmp/td.json` 数一下，一百万个线程明明白白躺在堆里。这件事用平台线程在 8G 机器上做不到，物理上就不允许。

> 注：虚拟线程数量级上去了，**不代表业务可以无脑无限开**。每一万个任务里若每个都持有 10MB 的数据，那就是 100GB 堆——虚拟线程省的是"线程本身"，不省你业务对象。这也是后面"常见坑"的主题。

## 五、实验三：Pinning——虚拟线程翻车头号现场

### 5.1 什么是 Pinning

前面说虚拟线程阻塞时"从载体上让下来"，但有一个例外：**当它卡在 `synchronized` 块/方法内部时，JDK 21 里它无法让出载体线程**，只能把载体一起拖住。这个现象叫 **Pinning（钉住）**。

危害在哪？载体线程总共只有 CPU 核数那么几个（4 核机器就 4 个）。只要有两三个虚拟线程抱着 `synchronized` 在里面慢慢等下游，载体就全被钉死，其他几万个虚拟线程集体趴窝——服务表现为"莫名卡死、但 CPU 和内存都正常"，是虚拟线程上线后翻车率最高的事故。

### 5.2 亲手复现

```java
// PinDemo.java —— 运行：java -Djdk.tracePinnedThreads=full PinDemo.java
public class PinDemo {
    static final Object LOCK = new Object();

    public static void main(String[] args) throws Exception {
        for (int i = 0; i < 2; i++) {           // 2 个虚拟线程，钉住 2 个载体
            Thread.startVirtualThread(() -> {
                synchronized (LOCK) {           // 在锁内做慢操作 = 灾难
                    try { Thread.sleep(5000); } catch (InterruptedException ignored) {}
                }
            });
        }
        Thread.sleep(60_000);
    }
}
```

加了 `-Djdk.tracePinnedThreads=full`（一个 JDK 自带的诊断开关，发生 pinning 时把完整调用栈打到标准输出）后，能看到类似这样的输出：

```text
Thread[#26,virtual#28,PinDemo.lambda$main$0/0x0000000800c6c418@...]/0x... <== monitors:1
    java.base/java.lang.VirtualThread$VThreadContinuation.onPinned(VirtualThread.java:183)
    java.base/java.lang.VirtualThread.lambda$pinCompiler$3(VirtualThread.java:484)
    ...
    PinDemo.lambda$main$0(PinDemo.java:8) <== monitors:1
```

关键字段是结尾的 **`<== monitors:1`**：表示"这个虚拟线程正持有 1 个 monitor（对象锁）被钉住了"。输出格式随 JDK 小版本略有差异，认准 `<==` 标记即可。

### 5.3 上工具：JFR 和火焰图

线上不可能到处挂着 trace 开关，标准姿势是 JFR 事件 + 火焰图：

```bash
# 1) 起一个 30 秒的飞行记录
jcmd PinDemo JFR.start duration=30s filename=/tmp/vt.jfr

# 2) 期间用 wrk 打一波流量（把 PinDemo 换成你的服务），然后回放 pinning 事件
jfr print --events jdk.VirtualThreadPinned /tmp/vt.jfr | head -40
```

**jdk.VirtualThreadPinned** 是 JDK 19+ 内置的 JFR 事件，默认只要某个虚拟线程"被钉住超过 20ms"就记录一条（含持续时间、持有栈）。压测期间这个事件数量暴涨，基本就是 pinning 拖垮吞吐的直接证据。

```bash
# 3) 火焰图：压测期间对进程采样 30 秒，输出交互式火焰图
./profiler.sh start <pid>
./profiler.sh stop -f /tmp/flame.html <pid>
```

解读火焰图的窍门：正常情况下虚拟线程的栈挂在 ForkJoinPool 载体上且很"浅"；如果看到大量采样停在载体线程的 `synchronized`/`pthread_cond_wait` 上、而业务线程明明在做 IO 等待，就是载体被钉住的画像。

### 5.4 怎么修

- 首选：把锁内的 `synchronized` 换成 **ReentrantLock**（JUC 提供的可重入锁，功能同 `synchronized`，但阻塞时虚拟线程可以让出载体）。注意只换"会产生长阻塞"的热点锁，别全局无脑替换。
- 根治：**JDK 24 的 JEP 491 已经把 `synchronized` pinning 修掉了**——升级后实验三不再复现。所以新项目直接上 JDK 21+ 没问题，但"钉住会传染"这类历史包袱要清楚：线上还在 21/22/23 的话，坑是真实存在的。
- 兜底：用 JFR 事件把 pinning 监控起来（持续超过阈值的次数/时长），作为虚拟线程上线的哨兵指标。

**验证修复**：把 PinDemo 里的 `synchronized` 换成 `ReentrantLock.lock()/unlock()` 再跑一遍，`tracePinnedThreads` 输出应完全消失；JFR 回放里 `jdk.VirtualThreadPinned` 事件数归零。

## 六、常见坑清单（每一条都是真实事故形态）

1. **在锁内做慢操作（pinning）**：`synchronized` 里调下游/睡大觉。JDK 24 之前是头号坑，检测与修复见第五节。
2. **连接池没跟着想清楚**：虚拟线程 1 万个，数据库连接池只有 20 个——所有线程排队等连接，数据库没被打挂，但你的"百万并发"全堵在池门口。正确姿势：用 **Semaphore**（JUC 的计数信号量，用来限制同时访问某资源的线程数）在进入业务前限流，池大小按数据库的承载能力算，而不是按线程数算。虚拟线程时代，"并发度控制"从线程池参数挪到了业务入口的信号量上。
3. **滥用 ThreadLocal**：**ThreadLocal** 是"每个线程一份"的变量副本机制。平台线程几百个时很省；一百万个虚拟线程每个都塞一份缓存对象，内存直接放大几个数量级。能传参就传参；框架级需求关注后续版本的 **ScopedValue**（仍在预览阶段的 ThreadLocal 替代品，不可变、有作用域、随任务结束自动失效）。
4. **池化虚拟线程**：虚拟线程设计上就是"用完即弃"的，创建成本约等于一个对象。再给它套一个 `ExecutorService` 池属于脱裤子放屁，正确写法就是 `Executors.newVirtualThreadPerTaskExecutor()`——每任务一个，永不复用。
5. **CPU 密集任务也换虚拟线程**：虚拟线程解决"等"，不解决"算"。矩阵运算、编解码、压缩这类活儿，虚拟线程没有任何加速，还可能因为调度抖动带来 P99 毛刺。CPU 密集继续用固定大小的平台线程池（核数或核数+1）。
6. **版本差异没搞清就上线**：`synchronized` pinning 在 JDK 21/22/23 是真实存在的坑，JDK 24+（JEP 491）修复。上线前先确认运行时版本，别拿博客结论当成所有版本的事实。

## 七、决策表：什么时候该用，什么时候别碰

| 场景 | 建议 |
|---|---|
| Web 服务，大量等待下游（RPC/DB/HTTP/Redis） | ✅ 首选虚拟线程，写法不变、容量起飞 |
| 每请求做 CPU 密集计算 | ❌ 无收益，固定平台线程池 + 限流 |
| 批处理/定时任务里大量并行 IO | ✅ 配 Semaphore 控制下游并发 |
| 依赖小型连接池/有全局热点锁 | ⚠️ 先治理（扩池按 DB 承载算、锁内快进快出），再切虚拟线程 |
| 大量使用 ThreadLocal 存大对象 | ⚠️ 先改造传参，否则内存放大 |
| 需要精确控制线程优先级/亲和性 | ❌ 虚拟线程没有这些概念，留在平台线程 |

## 八、总结

- **虚拟线程 = 更便宜的线程，不是更快的线程**：它把"阻塞"的成本打到接近零，让"一请求一线程"的朴素写法重新成为高并发的最优解。
- 实验一（wrk 压测）：IO 密集场景下，200 平台线程吞吐顶在 `线程数 ÷ 耗时` 的天花板上，P99 因排队而爆炸；虚拟线程并发即容量，P50/P95/P99 几乎一条平线。
- 实验二（内存账）：8G 机器平台线程 ~4 千个见顶，虚拟线程 100 万个起步；省的是线程本身，不省业务对象。
- 实验三（Pinning）：JDK 21~23 上 `synchronized` 内阻塞会钉住载体线程，用 `-Djdk.tracePinnedThreads`、JFR 的 `jdk.VirtualThreadPinned` 事件和 async-profiler 火焰图定位；锁内慢操作换 ReentrantLock，或升级 JDK 24+。
- 迁移心法一句话：**线程池的"池"从并发容器变成了限流器**——用 Semaphore 控并发，连接池大小跟着下游承载走，别跟着线程数走。

## 参考资料

1. JEP 444: Virtual Threads（Final）—— <https://openjdk.org/jeps/444>
2. JEP 491: Synchronize Virtual Threads without Pinning —— <https://openjdk.org/jeps/491>
3. Oracle JDK 21 文档：java.lang 包中的虚拟线程说明 —— <https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/package-summary.html>
4. OpenJDK Project Loom Wiki —— <https://wiki.openjdk.org/display/loom>
5. Java 官方团队博客 inside.java 的 Loom/虚拟线程系列 —— <https://inside.java/>
6. wrk 压测工具 —— <https://github.com/wg/wrk>
7. async-profiler —— <https://github.com/async-profiler/async-profiler>
8. 中文补充：美团技术团队关于 Java 虚拟线程原理与生产实践的系列文章（在其技术博客站内搜索"虚拟线程"即可）
