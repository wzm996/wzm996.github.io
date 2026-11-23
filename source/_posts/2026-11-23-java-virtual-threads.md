---
title: 深入理解 Java 虚拟线程：原理、实战与压测对比
date: 2026-11-23 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - 虚拟线程
  - JDK21
  - 并发
  - 性能压测
  - Spring Boot
---

<hr>
<blockquote>
<p>虚拟线程（Virtual Thread）是 JDK 21 正式落地的轻量级线程：写法还是同步阻塞那一套，但阻塞时不再占着昂贵的操作系统线程。本文把它讲透：原理是什么、怎么在代码和 Spring Boot 里用起来、怎么用 wrk 压测和 JFR 观测来验证收益、以及上生产前最容易踩的五个坑。</p>
</blockquote>

<!-- more -->

## 一、背景：一请求一线程的老问题

咱们绝大多数 Java 后端服务都是「一请求一线程」的模型：请求进来，Web 容器（Tomcat/Jetty）从线程池里拿一个工作线程，业务代码在这个线程里查数据库、调下游 RPC、读文件——这些操作绝大部分时间其实在**等 I/O**，线程干等着一动不动。

这套模型代码写起来直观、好调试，但它有个硬天花板：**平台线程太贵了**。这里说的 **平台线程（Platform Thread）**，就是咱们平时 `new Thread()` 出来的那种线程，它跟操作系统内核线程是 1:1 绑定的。贵在三个地方：

- **内存**：每个平台线程默认预留约 1MB 的线程栈（`-Xss` 默认值，64 位 HotSpot 上是 1MB）。想撑 1 万个并发请求，光栈内存就要 10GB，还没算堆。
- **创建/销毁成本**：内核线程的创建、销毁、上下文切换都要陷入内核态，微秒到毫秒级的开销。
- **数量上限**：操作系统本身能稳定承载的内核线程数就是几千的量级，再往上调度器先崩。

所以传统方案是上**线程池**：用固定数量的线程复用，避免频繁创建销毁。但池子大小没变，瓶颈也没变——200 个线程的 Tomcat 默认配置，下游接口平均 200ms，理论吞吐上限就是 200 ÷ 0.2s = **1000 QPS**，再多请求只能排队，延迟直接起飞。

> 注：线程池怎么配置、怎么监控，美团技术团队那篇《Java 线程池实现原理及其在美团业务中的实践》讲得很细，本文参考资料的 [3] 有链接。线程池没有消失，但虚拟线程把"线程不够用"这个问题从根上解决了。

再往下演进，业界给出了响应式编程（Reactor/WebFlux）这条路：用少量事件循环线程 + 全链路非阻塞回调，吞吐确实上去了，代价是代码变成回调链/Flux 链，调试、排障、上手成本都明显变高。

JDK 21（2023 年 9 月发布的 LTS 版本）给出的答案是第三条路：**虚拟线程**。一句话概括它的价值：

> 用同步阻塞的写法，拿到接近异步非阻塞的吞吐能力。

## 二、原理：虚拟线程到底"虚"在哪

### 2.1 三个关键角色

先把三个名词说清楚，后面所有讨论都基于它们：

- **虚拟线程（Virtual Thread）**：`java.lang.Thread` 的一种新的轻量实现，由 **JVM 自己调度管理**，不跟任何操作系统线程长期绑定。创建成本极低（微秒级）、栈在堆上按需增长，开百万个都不心疼。
- **平台线程（Platform Thread）**：传统线程，跟 OS 线程 1:1。它现在有了个新兼职——
- **载体线程（Carrier Thread）**：底层真正"驮着"虚拟线程执行 CPU 指令的平台线程。JVM 内部维护一个 `ForkJoinPool`（默认并行度 = CPU 核数）作为虚拟线程的调度器。

打个比方：平台线程时代，每个请求雇一个**专职司机**（贵，养不起太多）；虚拟线程时代，100 万个乘客（虚拟线程）共享几十个司机（载体线程），乘客等红灯（I/O 阻塞）的瞬间就下车让位，绿灯了再排队上车继续走——司机的每一秒都在干活，没人占着车睡觉。

### 2.2 阻塞为什么变"廉价"了

虚拟线程的底层机制叫 **Continuation（延续体）**——它是 JVM 内部一段"可以暂停、稍后从暂停点继续"的执行片段（这个 API 是内部的，咱们平时不直接碰）。当虚拟线程执行到阻塞点（Socket 读、`sleep`、锁等待等）时：

1. JVM 把它的调用栈整个搬到**堆内存**里存起来（而不是像平台线程那样钉在本地内存）；
2. 载体线程立刻被释放，去调度器领下一个就绪的虚拟线程；
3. I/O 就绪后，调度器找个空闲载体线程，把栈从堆里恢复回去，代码从断点继续跑。

对业务代码来说，该阻塞还是阻塞，一行代码都不用改；但**等 I/O 的成本从"占一个内核线程"降到了"堆上存一段栈帧"**，差了几个数量级。这就是"虚拟"的含义：线程是 JVM 模拟出来的，内核线程只在真正执行 CPU 指令的那一小段时间被占用。

### 2.3 它不是万能加速器

这里必须泼一盆冷水，也是面试高频考点：**虚拟线程提升的是"并发承载能力"，不是"单请求速度"，更不是 CPU 算力**。

- I/O 密集（查库、调接口、读文件）：收益巨大，线程等 I/O 不再占内核资源。
- CPU 密集（加密、图像处理、大数据计算）：几乎零收益，甚至可能因为调度开销略降。CPU 该 4 核还是 4 核，任务再多也只是排队。
- 它的定位不是取代 Reactor：响应式在背压（Backpressure，消费方反压生产方的流控机制）和极限资源控制上仍有优势。绝大多数 I/O 密集服务，虚拟线程够用且更好写。

## 三、实战：从裸 API 到 Spring Boot

### 3.1 环境准备

最低要求 **JDK 21+**（正式特性，不需要 `--enable-preview`；若能用 JDK 24+ 体验更完整，原因见第六节的坑 1）：

```bash
java -version
# openjdk version "21.x.x" ...
```

### 3.2 裸 API 三种写法

```java
// 写法一：直接起一个虚拟线程（对比 new Thread 就是换个工厂方法）
Thread vt = Thread.ofVirtual().name("vt-", 0).start(() -> {
    System.out.println(Thread.currentThread()); // VirtualThread[#23,vt-1]/runnable@ForkJoinPool-1-worker-1
});
vt.join();

// 写法二：每个任务一个虚拟线程的执行器（推荐替代固定线程池）
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 10_000; i++) {
        executor.submit(() -> {
            Thread.sleep(Duration.ofMillis(200)); // 模拟一次 200ms 的下游 I/O
            return null;
        });
    }
} // try-with-resources 关闭时会等所有任务跑完

// 写法三：并发跑一批任务并等结果
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<String>> futures = urls.stream()
        .map(url -> executor.submit(() -> httpGet(url)))
        .toList();
    for (var f : futures) results.add(f.get());
}
```

**怎么验证它真的是虚拟线程**：跑写法一，输出里 `VirtualThread[#...]` 就是身份标识；再顺手验证"轻"：

```java
long start = System.nanoTime();
for (int i = 0; i < 100_000; i++) {
    Thread.ofVirtual().start(() -> {});   // 开 10 万个虚拟线程
}
System.out.println((System.nanoTime() - start) / 1_000_000 + " ms");
```

10 万个虚拟线程的创建 + 销毁在我这台开发机上是一秒内的量级——同样的代码换成 `new Thread()`，光 1MB × 10 万的栈预留就直接 `OutOfMemoryError: unable to create native thread` 了。这就是最直观的验证。

### 3.3 Spring Boot 3.2+ 一行开关

Spring Boot 从 3.2 开始提供官方开关（要求 Java 21）：

```properties
# application.properties
spring.threads.virtual.enabled=true
```

打开之后，Tomcat 请求处理线程、`@Async` 任务执行器等自动配置位置会切换成虚拟线程。两个配套注意点：

- 原来调 Tomcat `max-threads` 的配置不再起原有作用，并发上限改由下游资源（连接池大小、Semaphore 许可数）决定；
- 虚拟线程是**守护线程**（daemon），如果你的应用靠 `@Scheduled` 后台任务保活，记得加 `spring.main.keep-alive=true`，否则 JVM 可能提前退出。

**验证开关生效**：起一个简单的 `@GetMapping("/whoami")` 返回 `Thread.currentThread().toString()`，开启开关后应返回 `VirtualThread[...]` 字样。

## 四、压测对比：数字说话

### 4.1 实验设计

模拟最典型的 I/O 密集场景——接口内部调用一个 200ms 的下游：

```java
@SpringBootApplication
public class VtDemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(VtDemoApplication.class, args);
    }

    @RestController
    static class Ctrl {
        @GetMapping("/io")
        public Map<String, Object> io() throws Exception {
            Thread.sleep(200); // 模拟下游 RPC / DB 查询
            return Map.of("thread", Thread.currentThread().toString(),
                          "ts", System.currentTimeMillis());
        }
    }
}
```

对照组：同一份代码，`spring.threads.virtual.enabled=false`（Tomcat 默认 200 工作线程）vs `=true`。压测工具用 **wrk**（一个用 C 写的多线程命令行压测工具，擅长用少量压测机连接数打满目标服务）：

```bash
# 2000 并发连接，4 个压测线程，持续 30 秒
wrk -t4 -c2000 -d30s --latency http://localhost:8080/io
```

实验机器：4C8G Linux 开发机，JDK 21，Spring Boot 3.2.x。

### 4.2 结果（参考量级）

> 注：下表是这类实验的**典型量级**，绝对数字跟机器、JDK 版本、下游行为强相关。请务必按 4.1 的步骤自己跑一遍，重点看**相对关系**，别背我的数字。

| 指标 | 平台线程池（默认 200 线程） | 虚拟线程 |
|---|---|---|
| 吞吐（req/s） | ≈ 1,000（卡在 200 ÷ 0.2s 上限） | ≈ 8,000 ~ 9,500 |
| P50 延迟 | ≈ 200ms（不排队时） | ≈ 210ms |
| P99 延迟 | 秒级（连接排队，wrk 大量超时） | ≈ 300 ~ 400ms |
| 错误率 | 高并发段明显上升 | 接近 0 |
| 请求处理线程内存 | 200 × ~1MB 栈 ≈ 200MB（预留） | 按需分配，栈在堆上，同等负载下通常几十 MB |

**怎么解读**：

- 平台线程组：200 线程 vs 2000 并发连接，物理上就差 10 倍，多出来的 1800 个连接在 accept 队列里排队，P99 被排队时间拖爆——吞吐恰好卡在理论值 1000 QPS 附近，验证了第二节的算术。
- 虚拟线程组：2000 个请求各占一个虚拟线程，同时挂在 200ms 的 sleep 上；真正的 CPU 活儿由十几个载体线程轮流干。吞吐逼近 2000 ÷ 0.2s = 10000 的理论上限，P99 只是稍微高于单次 I/O 耗时。
- **结论验证方法**：对照组只改一个布尔开关跑两遍 wrk；如果你的 P50 都远大于 200ms，先检查是不是 `sleep` 被日志/连接池等本地开销污染了。

CPU 侧顺手看一眼 `top`：虚拟线程组 CPU 利用率明显更高（载体线程不空转睡觉），这正是"吞吐提升来自资源利用率，不来自魔法"的证据。

## 五、观测：用 JFR 抓 Pinning

压测之外，线上排查需要工具。这里介绍 **JFR（Java Flight Recorder）**——JVM 自带的"飞行记录仪"，低开销持续记录运行时事件，Java 11 起随 OpenJDK 免费可用。虚拟线程时代它多了个杀手锏事件：`jdk.VirtualThreadPinned`。

**Pinning（钉住）** 是指虚拟线程在某些情况下**无法从载体线程上卸载**——最典型的是栈帧里存在 `synchronized` 块/方法并发生了阻塞。钉住期间，这个虚拟线程独占一个载体线程，把"等 I/O 很便宜"的假设破坏掉，严重时整个调度器被钉死。

采集与解读三步（对运行中的进程操作，不用重启）：

```bash
# 1) 录制 120 秒 profile 档位的 JFR
jcmd <pid> JFR.start name=vt duration=120s filename=/tmp/vt.jfr settings=profile

# 2) 看事件汇总，关注 jdk.VirtualThreadPinned 的数量
jfr summary /tmp/vt.jfr | grep -i pinned
# jdk.VirtualThreadPinned  = 137  （profile 档位下记录钉住超过 20ms 的事件）

# 3) 打印事件详情：钉住的时长、卡在哪个 synchronized 栈帧
jfr print --events jdk.VirtualThreadPinned /tmp/vt.jfr | head -60
```

另外，JDK 21 的线程 dump 也能看到虚拟线程全貌（传统 `jstack` 看不到它们）：

```bash
jcmd <pid> Thread.dump_to_file -format=json /tmp/threads.json
```

**验证方法**：故意在 `synchronized` 方法里 `Thread.sleep` 制造钉住，重复上面第 2、3 步，能看到 pinned 事件和对应栈；换成 `ReentrantLock` 后事件归零——这就完成了"发现问题 → 定位 → 修复 → 确认"的闭环。

## 六、常见坑：上生产前必看

**坑 1：`synchronized` 里的阻塞导致 Pinning。** JDK 21 上这是最大的坑：热路径的 `synchronized` 块里做 I/O，并发一高就把载体线程全部钉死，表现为 CPU 空转、吞吐反而下降。**改法**：把阻塞的 `synchronized` 换成 `ReentrantLock`（可重入锁，JDK 自带，语义等价但不钉住虚拟线程）。JDK 24 的 JEP 491 已经大幅改进了 `synchronized` 的处理，但生产上滞留在 21/22 的服务仍然要自己注意。

**坑 2：拿线程池思维池化虚拟线程。** 虚拟线程便宜到**不该复用**，永远用 `newVirtualThreadPerTaskExecutor()` 这种"每任务一个"的模式。需要限制并发量时（比如下游 DB 只能扛 100 连接），用 **`Semaphore`**（信号量，JDK 自带的许可计数器，`acquire()` 许可、`release()` 归还）卡下游资源，而不是限制线程数。

**坑 3：`ThreadLocal` 缓存被放大。** 线程池时代一个 `ThreadLocal` 最多对应几百个平台线程；一任务一线程之后，每个请求都各有一份缓存，"每个请求缓存一个 1MB 的对象"这种写法会把内存和 GC 压力放大到不可接受。传上下文（traceId、用户态）没问题，缓存重对象要重构。JDK 25 转正的 Scoped Values 是官方给不可变上下文准备的新答案。

**坑 4：CPU 密集任务也换虚拟线程。** 没有收益，还多了调度开销。CPU 密集的批量计算继续用固定大小的平台线程池（大小 ≈ 核数）。

**坑 5：以为开了开关就完事。** 虚拟线程阻塞在**连接池拿连接**（HikariCP `getConnection`）上时，瓶颈只是从线程池转移到了连接池。开虚拟线程的同时，把下游连接池、限流阈值按新的并发水位重新核算一遍，否则等于白开。

## 七、总结

- 虚拟线程 = 同步写法 + 异步吞吐，JDK 21 LTS 正式可用，Spring Boot 3.2+ 一个开关接入；
- 原理一句话：阻塞时把栈存到堆上、让出载体线程，内核线程只在执行 CPU 指令时被占用；
- 收益边界要记牢：I/O 密集收益大，CPU 密集没收益，不取代 Reactor 的背压场景；
- 上线三件套：压测对比（wrk）+ JFR 盯 `jdk.VirtualThreadPinned` + 重算下游连接池/限流水位；
- 遗留 JDK 21/22 的服务，重点排查热路径 `synchronized` + 阻塞 I/O 的组合。

## 参考资料

1. [JEP 444: Virtual Threads（OpenJDK 官方，JDK 21 正式版规范）](https://openjdk.org/jeps/444)
2. [得物技术《虚拟线程原理及性能分析》——含 Web 容器场景的压测对比](https://tech.dewu.com/article?id=89)
3. [美团技术团队《Java 线程池实现原理及其在美团业务中的实践》——理解"线程为什么贵"的背景](https://tech.meituan.com/2020/04/02/java-pooling-pratice-in-meituan.html)
4. [JavaGuide《虚拟线程常见问题总结》——坑位清单与 Spring Boot 集成注意点](https://javaguide.cn/java/concurrent/virtual-thread.html)
5. [阿里云开发者社区《JDK 21 中的虚拟线程：轻量级并发的新篇章》](https://developer.aliyun.com/article/1436773)
