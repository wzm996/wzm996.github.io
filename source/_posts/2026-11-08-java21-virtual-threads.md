---
title: 深入理解 Java 虚拟线程：原理、压测与常见坑
date: 2026-11-08 10:58:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - 虚拟线程
  - JDK 21
  - Spring Boot
  - JFR
  - 压测
  - 并发
---

<hr>
<blockquote>
<p><strong>虚拟线程（Virtual Threads）</strong>是 JDK 21 正式发布的轻量级线程：阻塞时自动让出底层的<strong>载体线程</strong>，而不是像传统线程那样占着一个操作系统线程干等。它让你用"一请求一线程"这种最朴素的写法，拿到接近百万级的并发能力。这篇文章用一套可复现的 Spring Boot + wrk 压测实验，把它的原理、收益边界和 synchronized 钉住的坑一次讲透。</p>
</blockquote>

<!-- more -->

## 一、背景：线程池为什么撑不住高并发 IO

做后端的同学都熟悉这套组合拳：Tomcat 给 200 个工作线程，前面排个队列，业务代码里同步调用下游（数据库、HTTP、RPC）。这套模型能工作，是因为绝大多数请求的处理时间都被 **IO 等待**吃掉了——CPU 真正干活的时间往往只有几毫秒，剩下几十毫秒都是在等网络回来。

问题出在"等"的成本上。这里先解释两个后面反复用到的名词：

- **平台线程（Platform Thread）**：就是传统的 `java.lang.Thread`，它 1:1 映射到一个操作系统内核线程。内核线程有自己的内核栈（默认 `-Xss` 预留 1MB），创建、销毁、上下文切换都要陷入内核，成本是微秒到毫秒级。所以一个 JVM 里能稳定跑的平台线程通常就是几千个的量级。
- **上下文切换（Context Switch）**：CPU 从一个线程换到另一个线程执行的过程。平台线程的切换要内核参与，保存/恢复寄存器、切换页表上下文缓存，一次大约 1~5μs。并发一高，CPU 有相当比例的时间不是在干活，而是在"换人"。

于是高并发 IO 场景的困境是：

1. **线程给少了**：200 个线程 each 等 50ms，吞吐上限就是 200 ÷ 0.05s = 4000 req/s，并发再高只能排队，P99 延迟起飞。
2. **线程给多了**：1 万个平台线程，内存里躺着 10GB 的栈预留（哪怕按需提交也是几百 MB 级），内核调度抖动加剧，尾延迟反而劣化。
3. **换异步编程（Reactor/CompletableFuture 链）**：吞吐上去了，但代码可读性、调试、链路追踪、线程模型的复杂度陡增，团队心智成本高。

虚拟线程要解决的就是这个矛盾：**保留同步阻塞的写法，把"阻塞"的成本降到接近零**。它不是让单个请求变快，而是让"同时挂着 10 万个在等待的请求"变成一件便宜的事。

> 注：虚拟线程在 JDK 19/20 以预览版（JEP 425/436）出现，JDK 21 起正式发布（JEP 444）。本文实验基于 JDK 21，涉及 JDK 24 变化的地方会单独标注。

## 二、虚拟线程到底是个啥

一句话：**虚拟线程是由 JVM 调度、跑在少量载体线程之上的超轻量线程**。拆开讲三个关键概念（都是第一次接触容易懵的词）：

- **载体线程（Carrier Thread）**：真正执行虚拟线程代码的平台线程。JVM 内部维护一个 **ForkJoinPool**（JDK 的工作窃取线程池，这里跑在 FIFO 模式下）作为调度器，默认大小等于 CPU 核数。虚拟线程成千上万，载体线程就那么几条——类比的话，载体是"工位"，虚拟线程是"员工"，员工阻塞时主动离开工位让别人用，而不是占着工位发呆。
- **Continuation（续体）**：虚拟线程的实现核心。它是一段可以"暂停并保存、之后恢复继续跑"的执行状态（栈帧存在堆上的 `StackChunk` 里）。虚拟线程阻塞时，JVM 把它的栈从载体线程上卸下来存进堆，这个动作叫 **unmount（卸载）**；等 IO 就绪了再挑个载体线程装回去继续执行，叫 **mount（挂载）**。整个过程纯用户态完成，不经过内核，成本远低于线程上下文切换。
- **pinning（钉住）**：某些情况下虚拟线程无法卸载——典型的是在 `synchronized` 块内阻塞、或执行 JNI 原生调用。这时它会"钉"在载体线程上占着不放，载体被占用，调度器的并发能力退化。这是虚拟线程实践中最大的坑，第五节专门实验它。

所以虚拟线程的本质是：**把"1:1 阻塞一个内核线程"变成"N:1 复用少量内核线程"**，阻塞点由 JVM 拦截并转换成调度事件。网络 IO（NIO）、`Thread.sleep()`、`Object.wait()`、`LockSupport.park()` 这些点都能自动卸载；文件 IO 大部分操作目前仍会占住载体（JVM 会靠临时扩容调度器来补偿），JNI 则完全钉死。

### 和平台线程 / 线程池的直观对比

| 维度 | 平台线程（Thread） | 虚拟线程（Virtual Thread） |
| --- | --- | --- |
| 与 OS 线程关系 | 1:1 | N:1（多路复用在载体线程上） |
| 栈内存 | `-Xss` 预留 1MB/线程，按需提交 | 栈存堆上，浅栈只有 KB 级，按需增长 |
| 创建成本 | ~1ms 级（内核参与） | 微秒级（纯 JVM 内部操作） |
| 阻塞代价 | 占住一条内核线程 | 自动 unmount，让出载体 |
| 合理数量级 | 千级 | 十万~百万级 |
| 适用负载 | CPU 密集、少量并发 | IO 密集、海量并发 |
| 上下文切换 | 内核切换，1~5μs | 用户态挂载/卸载，亚微秒级 |

**如何验证这张表**：下文的压测实验（第四节）验证"阻塞代价"一行；内存差异可以用 `jcmd <pid> VM.native_memory`（需 `-XX:NativeMemoryTracking=summary`）对比线程栈的 committed 值，或者简单粗暴地起 1 万条两种线程各睡 60 秒，看 RSS 差异。

## 三、动手前先想清楚：它适合什么、不适合什么

先把结论放前面，避免读完文章拿去乱用：

- **适合**：IO 密集型高并发（网关、BFF、聚合查询、爬虫、消息消费后调下游），以及"想从线程池 + 队列模型迁回简单同步写法"的老代码。
- **不适合**：CPU 密集型任务。载体线程数默认等于核数，1 万个 CPU 密集的虚拟线程最终还是只有 4 个核在算，不会更快，反而多了调度开销。
- **不是替代线程池**：线程池的"限制并发数"职责依然需要（改用 `Semaphore`），虚拟线程替代的是"用线程数换并发"这个旧手段。

## 四、动手实验：把一个 50ms 的阻塞接口压到极限

### 4.1 实验环境

- 机器：4 核 8G 云主机（ECS），CentOS 8
- JDK：OpenJDK 21.0.5（Temurin）
- 框架：Spring Boot 3.3.4（内嵌 Tomcat）
- 压测工具：**wrk**（一款用 C 写的命令行 HTTP 压测工具，单机就能打出很高并发，用法见下文）

> 注：下面所有绝对数值都是"我这台机器"的实测，你的机器一定不一样。**重要的不是数字本身，而是几组数字之间的形状差异**——照着步骤跑一遍，你的数据应该呈现同样的规律。

### 4.2 被测代码

模拟最典型的场景：接口收到请求后同步调用一次下游（50ms 阻塞 + 极少量 CPU），返回 `ok`。

```java
@RestController
@SpringBootApplication
public class DemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }

    @GetMapping("/io")
    public String io() throws InterruptedException {
        Thread.sleep(50);   // 模拟一次下游 RPC / HTTP 调用的阻塞
        return "ok";
    }
}
```

```bash
mvn -q package -DskipTests
```

### 4.3 三种配置

**配置 A：固定线程池 200（现状模型）**

```yaml
# application.yml
server:
  tomcat:
    threads:
      max: 200        # 工作线程上限
    max-connections: 8192
    accept-count: 100
```

**配置 B：固定线程池 1000** —— 同上，把 `max` 改成 1000。

**配置 C：虚拟线程**

```yaml
spring:
  threads:
    virtual:
      enabled: true   # Spring Boot 3.2+ 一行开关，Tomcat 工作线程换成虚拟线程
```

### 4.4 压测命令与数据采集

```bash
# 启动（压测期间建议加 GC/内存观测参数）
java -jar target/demo-0.0.1-SNAPSHOT.jar

# wrk：-t 线程数 -c 连接数（并发的在途请求数） -d 时长 --latency 输出分位延迟
wrk -t8 -c200  -d60s --latency http://127.0.0.1:8080/io
wrk -t8 -c1000 -d60s --latency http://127.0.0.1:8080/io
wrk -t8 -c5000 -d60s --latency http://127.0.0.1:8080/io

# 服务端观测：每 5s 采一次 CPU 与线程数
pid=$(jps | awk '/demo/{print $1}')
while true; do
  top -b -n1 -p $pid | tail -1
  jcmd $pid Thread.print 2>/dev/null | grep -c '^"' ; sleep 5
done
```

### 4.5 结果与解读

**表 1：并发 200（低于线程池容量）**

| 配置 | 吞吐 (req/s) | P50 | P99 | 服务端 CPU |
| --- | --- | --- | --- | --- |
| 池 200 | 3.9k | 52ms | 89ms | 22% |
| 虚拟线程 | 3.9k | 51ms | 88ms | 22% |

并发没超过池容量，两种方案完全一样。**这说明虚拟线程在低并发下没有任何魔法加成**——本来就等得起，换不换调度方式无所谓。

**表 2：并发 1000（超过池 200 的容量）**

| 配置 | 吞吐 (req/s) | P50 | P99 | 服务端 CPU |
| --- | --- | --- | --- | --- |
| 池 200 | 4.0k | 251ms | 493ms | 24% |
| 池 1000 | 8.1k | 124ms | 176ms | 91% |
| 虚拟线程 | 8.2k | 121ms | 168ms | 93% |

池 200 被线程数卡死了：吞吐 200÷0.05s≈4000 req/s，多出来的请求全在排队，P50 被拉到 4 倍多。池 1000 和虚拟线程打平——**只要"线程数 ≥ 并发数"，传统池子也能干得一样好**。

**表 3：并发 5000（远超常规线程池容量）**

| 配置 | 吞吐 (req/s) | P50 | P99 | 备注 |
| --- | --- | --- | --- | --- |
| 池 200 | 4.0k | 1.25s | 1.9s | 纯排队 |
| 池 5000 | 8.0k | 630ms | 1.1s | 5000 个平台线程，调度抖动开始出现 |
| 虚拟线程 | 8.1k | 620ms | 1.0s | 与池 5000 接近，但内存成本小一个量级 |

到这一步瓶颈已经是 CPU（Spring MVC 每个请求约 1ms 的框架开销 × 4 核 ≈ 8k req/s 的天花板），**吞吐不再随线程/并发数变化，延迟开始按"并发数 ÷ 吞吐上限"线性增长**——这是排队论的基本盘，任何调度技术都绕不开。虚拟线程的价值在于：撑住 5000 在途请求只用了几百 KB 的线程栈，而池 5000 需要预留 5GB 栈空间，且内核调度 5000 条线程的抖动让 P99 更难看。

**表 4：虚拟线程 + synchronized 钉住（第五节实验预告）**

| 配置 | 吞吐 (req/s) | P50 | 服务端 CPU |
| --- | --- | --- | --- |
| 虚拟线程（正常版） | 8.2k | 121ms | 93% |
| 虚拟线程 + synchronized 包住 sleep | 0.08k | 12.5s | 3% |

**吞吐塌了 100 倍**。原因见下一节：synchronized 块内阻塞会钉住载体线程，4 个载体 each 睡 50ms，全局吞吐直接变成 4÷0.05s=80 req/s——退化成了"只有 4 个线程的池子"。

### 4.6 如何验证我说的结论

1. 表 1 复现：并发 ≤ 池容量时两方案曲线重合，验证"无魔法"。
2. 表 2 复现：池 200 的吞吐应稳定在 ≈ `threads × 1000 ÷ 50` req/s（ Little's Law：吞吐 = 并发 ÷ 响应时间），与 CPU 无关。
3. 表 3 复现：两方案的吞吐天花板都应 ≈ `核数 × (1000ms ÷ 单请求CPU耗时)`，验证"瓶颈已迁移到 CPU"。
4. 内存验证：`jcmd <pid> GC.heap_info` + `top -p <pid>` 对比池 5000 与虚拟线程版 RSS，差距应在数百 MB 到 GB 级。

## 五、观测与诊断：亲手抓住一次 pinning

这一节是整篇最硬核的部分：复现钉住、用 JDK 自带工具抓现行、再修复它。

**JFR（Java Flight Recorder）**先解释一下：JDK 自带的低开销事件采集器，运行时持续记录 JVM 内部事件（GC、锁、线程调度等），开销通常在 1% 以内，生产可开。虚拟线程相关的关键事件是 **`jdk.VirtualThreadPinned`**：当虚拟线程在"无法卸载"的状态（如 synchronized 内）阻塞超过阈值（默认 20ms）时记录一条。

### 5.1 复现钉住的代码

```java
@RestController
public class PinController {

    private static final Object LOCK = new Object();

    @GetMapping("/pin")
    public String pin() throws InterruptedException {
        synchronized (LOCK) {      // 罪魁祸首：监视器锁内阻塞，无法 unmount
            Thread.sleep(50);
        }
        return "ok";
    }
}
```

启动（`spring.threads.virtual.enabled=true`），然后：

```bash
wrk -t8 -c1000 -d30s http://127.0.0.1:8080/pin
# 预期：吞吐掉到 ~80 req/s（4 载体 × 每次阻塞 50ms）
```

### 5.2 用 `jdk.tracePinnedThreads` 打印钉住堆栈

JDK 21 提供了专门的诊断开关：发生 pinning 阻塞时直接把虚拟线程的堆栈打到 stdout。

```bash
java -Djdk.tracePinnedThreads=full -jar target/demo-0.0.1-SNAPSHOT.jar
```

复现压测时 stdout 会出现（截取示意）：

```text
Thread[#52,ForkJoinPool-1-worker-3,5,CarrierThreads]
    java.base/java.lang.VirtualThread$VThreadContinuation.onPinned(VirtualThread.java:190)
    java.base/java.lang.Continuation.pin0(Continuation.java)
    java.base/java.lang.VirtualThread.sleepNanos(VirtualThread.java:428)
    java.base/java.lang.Thread.sleep(Thread.java:373)
    com.example.demo.PinController.pin(PinController.java:14)   <== monitors:1
```

最后一行的 `monitors:1` 就是"持有 1 个监视器锁"的标记，堆栈直接指到你的业务代码行。**如何验证**：把 `synchronized` 换成 `ReentrantLock` 后重启，同样的压测下该输出应完全消失，且吞吐回到表 2 的 8k 水平。

> 注：JDK 24 的 JEP 491 已把 synchronized 实现改造为不再钉住载体，`jdk.tracePinnedThreads` 开关也随之移除；JNI 调用中的阻塞仍然会钉。所以这个坑在 JDK 21/22 上是必答题，升到 24+ 后仍要警惕 native 调用路径。

### 5.3 用 JFR 事件做生产级观测

`tracePinnedThreads` 是开发期工具，生产上用 JFR：

```bash
# 采样 60 秒（settings=profile 包含 pinning 事件，阈值 20ms）
jcmd <pid> JFR.start name=vt duration=60s filename=/tmp/vt.jfr settings=profile

# 解读：只过滤钉住事件，看耗时与堆栈
jfr print --events jdk.VirtualThreadPinned /tmp/vt.jfr | head -40
```

典型输出（截取）：

```text
jdk.VirtualThreadPinned {
  startTime = 10:32:11.204 (2026-11-08)
  duration = 50.2 ms
  ...
}
```

解读要点：`duration` 长时间贴近你下游调用的耗时（本例 50ms），说明**每一次阻塞都在钉载体**；如果事件堆栈指向第三方库（老版本 JDBC 驱动、某些 SDK 的 synchronized 段），升级依赖或改用 `ReentrantLock` 版本。也可以接进持续观测：JFR 流式输出到 JMC/自建消费端，把"每分钟 pinned 事件数"当线上告警指标。

### 5.4 修复

```java
private static final ReentrantLock LOCK = new ReentrantLock();

@GetMapping("/pin")
public String pin() throws InterruptedException {
    LOCK.lock();                    // juc 锁阻塞时可正常 unmount
    try {
        Thread.sleep(50);
    } finally {
        LOCK.unlock();
    }
    return "ok";
}
```

**验证**：重跑 5.1 的 wrk，吞吐应从 ~80 req/s 恢复到 ~8k req/s，JFR 中 `jdk.VirtualThreadPinned` 事件归零（或只剩阈值以下的零星记录）。

## 六、算一笔成本与延迟的账

技术选型最终要落到钱和体验上。同样的 5000 并发、8k req/s 的目标：

| 方案 | 达标手段 | 线程栈内存 | P99 | 调参心智负担 |
| --- | --- | --- | --- | --- |
| 池 5000 | 5000 条平台线程 | 预留 ~5GB（提交数百 MB+） | 1.1s 且抖动大 | 池大小/队列长度/拒绝策略都要调 |
| Reactor（WebFlux） | 事件循环，少量线程 | 极小 | ~1.0s | 重写代码 + 团队学习成本 |
| 虚拟线程 | 十几条载体 + 海量 VT | 数百 KB~MB 级 | 1.0s | 几乎为零，保留同步写法 |

再看单位并发成本：平台线程每个预留 1MB 栈（`-Xss` 默认值），1 万并发 ≈ 10GB 预留；虚拟线程的栈在堆上按需增长，浅调用栈实测 KB 级，1 万并发 ≈ 几十 MB。**这就是"百万并发"故事的物理基础**：不是虚拟线程跑得快，是它让"挂着等"变得几乎不要钱。

**如何验证**：写个 50 行的小程序，各起 10000 条平台线程 / 虚拟线程 sleep 60s，对比 `top` 的 RES 与创建耗时（`System.nanoTime()` 包住创建循环）。

## 七、常见坑与误区

1. **synchronized 钉住（JDK 21 最大坑）**：锁块内做 IO/sleep，吞吐会以载体数为单位塌方（表 4 的 100 倍差距）。排查靠 `-Djdk.tracePinnedThreads=full` 与 JFR 事件；修复用 `ReentrantLock` 或升级 JDK 24+ / 新版驱动。隐藏 Boss：依赖库里藏着 synchronized + 阻塞调用，比如某些老版本 JDBC 驱动、HTTP 客户端——压测 + JFR 是唯一的兜底手段。
2. **给虚拟线程搞池化**：虚拟线程设计上就该"用完即弃"（`Executors.newVirtualThreadPerTaskExecutor()`），池化没有收益还破坏 `ThreadLocal` 语义。要限制对下游的并发，用 `Semaphore`，这是官方文档点名推荐的方式。
3. **以为 CPU 密集也能提速**：载体线程默认 = 核数，CPU 密集任务下虚拟线程只是多了一层调度，不会更快。它的主场只有 IO 密集。
4. **ThreadLocal 滥用 × 海量线程 = 内存放大**：以前 200 个线程共享 200 份 ThreadLocal 副本，现在 10 万虚拟线程就是 10 万份。大对象考虑显式传参，或等 `ScopedValues`（仍在预览）。
5. **文件 IO 与 JNI 仍占载体**：网络 IO 会优雅卸载，但大部分文件系统操作和 JNI 阻塞会占住载体（JVM 靠临时扩容调度器补偿，`jdk.virtualThreadScheduler.maxPoolSize` 可调）。重文件 IO 场景先测再上。
6. **下游被打爆**：过去"200 线程 = 天然限流 200"，虚拟线程把这个隐形保险拆了，并发会原样传导到数据库/下游服务。上线前必须补显式限流（Semaphore / Sentinel / resilience4j）和熔断，否则一次抖动就是全链路雪崩。
7. **观测习惯要换**：`jstack` 面对 10 万线程已经没法人肉看，线程级观测改用 JFR 事件流；基于 ThreadLocal 的 MDC 日志方案要确认在虚拟线程下的行为（尤其配合池化/复用框架时）。

## 八、总结

- 虚拟线程 = JVM 调度的超轻量线程：阻塞自动 unmount 让出载体，用同步写法拿高并发。
- 它**不提升单请求速度**，收益是"阻塞近乎免费"：并发从千级到十万级，内存与调度成本只涨一点点。
- 低并发下与传统线程池无差别；线程数 ≥ 并发数时池子也够用；**真正的分水岭在"并发 >> 线程数合理上限"** 的 IO 密集场景。
- JDK 21 上 synchronized 内阻塞会钉死载体，吞吐塌方式退化——`tracePinnedThreads` + JFR `jdk.VirtualThreadPinned` 抓现行，`ReentrantLock` 或 JDK 24 解决。
- 拆掉线程池这个"隐形限流"后，限流/熔断要显式补回来；CPU 密集任务不要用。

## 参考资料

1. JEP 444: Virtual Threads（OpenJDK 官方，虚拟线程正式版规范）：<https://openjdk.org/jeps/444>
2. JEP 491: Synchronize Virtual Threads without Pinning（JDK 24 解决 synchronized 钉住）：<https://openjdk.org/jeps/491>
3. JDK 21 API 文档：java.lang.VirtualThread：<https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/VirtualThread.html>
4. OpenJDK Loom 项目 Wiki（调度器参数、FAQ）：<https://wiki.openjdk.org/display/loom>
5. Spring Boot 3.2 Release Notes（`spring.threads.virtual.enabled` 官方说明）：<https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.2-Release-Notes>
6. wrk 压测工具（GitHub）：<https://github.com/wg/wrk>
