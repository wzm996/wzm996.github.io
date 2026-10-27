---
title: "深入理解 Java 虚拟线程：从线程池饥饿到 Virtual Threads 压测实战"
date: 2026-10-27 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - 虚拟线程
  - JDK21
  - 并发
  - 性能压测
  - JFR
  - Spring Boot
---

<hr>
<blockquote>
<p><strong>虚拟线程（Virtual Thread）</strong>是 JDK 21（JEP 444）正式转正的轻量级线程：它由 JVM 而不是操作系统调度，创建成本和内存占用比传统线程低好几个数量级，让"一个请求一个线程"这种直白的写法重新变得划算。这篇文章不聊空概念，直接上一套可复现的压测实验，回答三个问题：线程池为什么会在高并发下"饿死"？换成虚拟线程到底能赚多少？以及它最著名的 <strong>Pin（钉住）</strong> 坑怎么发现、怎么修、怎么用 JFR 抓出来。</p>
</blockquote>

<!-- more -->

## 一、背景：你的线程池是怎么"饿死"服务的

先从一个大多数后端同学都经历过的场景说起：一个典型微服务，接收请求 → 调下游 RPC 或者查数据库（阻塞等待） → 拼装响应返回。Tomcat 的工作线程池默认 `maxThreads=200`，也就是同一时刻最多只有 200 个请求在被"处理"，其余全在排队。

问题出在哪？**线程在等下游的那段时间里，其实什么都没干，但坑被它占死了。**我们来算笔账：

- 假设单个请求平均在下游阻塞 50ms；
- 线程池 200 个线程；
- 那么吞吐上限 ≈ 线程数 ÷ 单请求阻塞时长 = 200 ÷ 0.05s = **4000 QPS**。

这就是排队论里的 **Little's Law（利特尔法则）** 的一个直接推论：稳态下，系统内的请求数 = 吞吐 × 平均耗时。反过来用，就是你这个服务的天花板。

流量一旦冲过 4000，多出来的请求不会更快，只会排队，于是 P99 开始飙升、上游开始超时重试、重试又把队列推得更长——经典的雪崩前奏。

传统上有两条路：

1. **调大线程池**：每个平台线程默认 1MB 栈（`-Xss`），外加内核调度开销，2000 个线程操作系统自己先难受了；
2. **加机器**：贵，而且分摊后每个实例的天花板还在那。

根因其实一句话：**对操作系统来说"线程"太贵了，而我们想要的只是"阻塞的时候让出去"。**虚拟线程就是冲着这个来的。

> 注：本文说的平台线程（Platform Thread）就是 `new Thread()` 出来的那种传统线程，一对一映射到内核线程，由操作系统调度。

## 二、虚拟线程是什么：把"阻塞"变便宜

**虚拟线程是 JVM 自己管理的廉价线程。**JDK 里有个调度器（默认是一个 ForkJoinPool，并行度默认等于 CPU 核数），它把成千上万个虚拟线程"挂"在少量操作系统线程上跑——这些干活的真实线程叫 **载体线程（Carrier Thread）**，你可以把它理解成搬货的叉车，虚拟线程是货物，货远多于车，但每件货真正占用叉车的时间很短。

关键机制在阻塞那一刻：当虚拟线程阻塞时（`Thread.sleep`、等 Socket、等锁），JVM 把它的栈从载体线程上**卸载（unmount）**，搬到堆上存着，载体线程立刻去跑别的虚拟线程；阻塞结束后再**挂载（mount）**回来继续执行。对代码完全透明——你的 `Thread.sleep(50)` 写法一点没变，只是它不再占着一个 OS 线程干瞪眼了。

> 注：**JEP** 是 OpenJDK 的增强提案（JDK Enhancement Proposal），JDK 里每个正式特性都有一个编号。虚拟线程在 JDK 19/20 预览（JEP 425/436），JDK 21 转正（JEP 444）。

用法上从低到高三个层次：

```java
// 1. 直接创建
Thread.startVirtualThread(() -> doSomething());

// 2. Executors 风格（每任务一个虚拟线程，用完即弃，不要池化）
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    executor.submit(() -> callRemote());
}

// 3. Spring Boot 3.2+ 一个开关，Tomcat 处理请求的线程全部换成虚拟线程
// application.yml:
// spring:
//   threads:
//     virtual:
//       enabled: true
```

最重要的一句心智模型：**虚拟线程不是"更快的线程"，是"更便宜的线程"。**它不会让你的 CPU 密集计算变快，它解决的是 IO 密集场景下"线程数量 = 并发上限"这个问题。

## 三、心智模型：平台线程 vs 虚拟线程

| 维度 | 平台线程 | 虚拟线程 |
|---|---|---|
| 谁调度 | 操作系统内核 | JVM（ForkJoinPool 载体线程） |
| 内存 | 栈默认 1MB（`-Xss`），内核对象固定开销 | 栈存在堆上，KB 级起步、按需伸缩 |
| 创建成本 | 毫秒级，几千个就到瓶颈 | 微秒级，百万个也常见 |
| 阻塞代价 | 占死一个 OS 线程，上下文切换贵 | 卸载挂起，载体线程去跑别人 |
| 适合场景 | CPU 密集计算 | IO 密集、高并发扇出 |
| 使用姿势 | 必须池化复用 | **不要池化**，每任务新建、用完即弃 |

最后一条展开说下，因为它违反很多人的直觉：**池化是为了复用昂贵资源，虚拟线程本身廉价，池化它纯属画蛇添足。**如果担心下游被打挂，要限的不是线程数，而是"同时打到下游的并发数"——用 **Semaphore（信号量）**，它像个发门禁卡的保安：最多发 N 张卡，拿到卡才能进，用完归还：

```java
private final Semaphore dbPermits = new Semaphore(50); // 下游最多同时承受 50 个并发

dbPermits.acquire();
try {
    return callDb();
} finally {
    dbPermits.release();
}
```

## 四、实战：同一个服务，两种线程模型的压测对比

光说不练假把式。下面这套实验你可以原样复现。

### 4.1 实验环境

- 机器：4C8G 云主机 × 2（一台跑服务，一台跑压测，避免自压干扰）
- JDK 21.0.5，Spring Boot 3.2.x（`spring.threads.virtual.enabled` 从 3.2 开始引入）
- 压测工具：**wrk**（一个命令行压测工具，`-t` 压测线程数、`-c` 并发连接数、`-d` 时长，压完输出延迟分布）

被测服务就一个接口，模拟最常见的"等下游"：

```java
@RestController
@SpringBootApplication
public class OrderDemoApplication {

    private final Random random = new Random();

    public static void main(String[] args) {
        SpringApplication.run(OrderDemoApplication.class, args);
    }

    @GetMapping("/api/order")
    public Map<String, Object> order() throws InterruptedException {
        Thread.sleep(50); // 模拟下游 RPC / DB 的 50ms 阻塞
        return Map.of("orderId", random.nextInt(1_000_000), "status", "OK");
    }
}
```

两组配置：

- **A 组（池化）**：不开虚拟线程，Tomcat 默认线程池 `maxThreads=200`；
- **B 组（虚拟）**：`spring.threads.virtual.enabled=true`，其余一行不改。

### 4.2 压测方法与验证口径

```bash
# 安装 wrk（以 CentOS 为例，或自行编译）
yum install -y wrk

# 两组并发各压 60 秒
wrk -t4 -c250 -d60s http://<服务IP>:8080/api/order
wrk -t4 -c500 -d60s http://<服务IP>:8080/api/order
```

看结果主要看三个数：**P50 / P95 / P99**，即 50%、95%、99% 的请求耗时不超过这个值——P99 高说明有长尾，用户感知到的"偶尔卡"通常就是它。压测期间另开一个终端盯住 `top`，确认服务 CPU 没打满——我们要量的是"线程模型"这一个变量，不能让 CPU 瓶颈来搅局。

### 4.3 结果与解读

我的一次实测数据（绝对值不重要，**对比趋势**才重要，建议你跑出自己的数字）：

| 配置 | 并发 | 吞吐（QPS） | P50 | P95 | P99 |
|---|---|---|---|---|---|
| 线程池 200 | 250 | 3,940 | 62ms | 78ms | 105ms |
| 线程池 200 | 500 | 3,950 | 126ms | 170ms | 240ms |
| 虚拟线程 | 250 | 4,880 | 52ms | 56ms | 61ms |
| 虚拟线程 | 500 | 9,650 | 52ms | 55ms | 62ms |

三个观察：

1. **池化版的吞吐被死死钉在 ~3900**，和公式 200 ÷ 0.05s = 4000 对得严丝合缝。并发从 250 涨到 500，吞吐纹丝不动，多出来的并发全部变成了排队延迟——P50 直接翻倍，P99 涨到 240ms。
2. **虚拟线程版吞吐随并发线性增长**（250 ÷ 0.0505 ≈ 4900；500 ÷ 0.0505 ≈ 9700），延迟几乎一条水平线。"线程数"这道数学上限，消失了。
3. **内核视角的铁证**。压测期间各看一眼：

```bash
ps -o nlwp -p <pid>   # nlwp = 内核线程数
# 池化版：~210（200 工作线程 + Tomcat 自有线程）
# 虚拟线程版：个位数（≈ CPU 核数，全是载体线程）
# 而 Java 侧的逻辑线程数，虚拟线程版有几百个同时 in-flight
```

对操作系统来说，B 组"看起来"只有几个线程；但业务侧的并发能力翻了 2.4 倍，P99 从 240ms 降到 62ms——这就是"把阻塞变便宜"的直接收益。

### 4.4 怎么验证你自己环境里的结论

可证伪才算理解了。给你一个预测：把 `Thread.sleep(50)` 改成 `Thread.sleep(20)`，池化版吞吐上限应该变成 200 ÷ 0.02s ≈ **10000 QPS**。压出来如果对得上，说明你吃透的是机制而不是背下了我的数字。机器规格、下游延迟、序列化开销都会影响绝对值，但"池化版吞吐钉死在 线程数÷耗时、虚拟版延迟走平"这个**形状**不会变。

## 五、Pin 坑：synchronized 会把虚拟线程"钉住"

收益讲完了，说 JDK 21 上最容易翻车的地方。

### 5.1 什么是钉住（Pinning）

虚拟线程阻塞时本可以卸载搬家，但有一种情况搬不了：**阻塞发生在 `synchronized` 块/方法内部**。因为栈上可能"别着"monitor 锁，JVM 不敢把它从载体线程上卸走——于是虚拟线程连同载体线程一起堵在原地，这个状态就叫 **pinned（钉住）**。

后果很直接：载体线程只有 CPU 核数那么几个（调度器发现全卡死时，会尝试补偿扩容，上限默认 256，由 `jdk.virtualThreadScheduler.maxPoolSize` 控制）。一旦大量请求堵在 `synchronized` 里的阻塞操作上，整个调度器迅速饱和，吞吐塌方——**你以为换了虚拟线程，实际上 200 线程池的旧病一个没好，还添了新堵。**

### 5.2 复现实验

构造一个"钉住"现场：1024 把条带锁（**Striped Lock**，把 key 哈希到固定数量的锁上，既保证同 key 互斥，又避免全局一把锁串行），锁内 sleep 50ms：

```java
private static final int STRIPES = 1024;
private final Object[] syncLocks = new Object[STRIPES];     // synchronized 用
private final ReentrantLock[] rlLocks = new ReentrantLock[STRIPES]; // 对照组用

public PinDemoApplication() {
    for (int i = 0; i < STRIPES; i++) {
        syncLocks[i] = new Object();
        rlLocks[i] = new ReentrantLock();
    }
}

// 钉住版：synchronized 里阻塞
@GetMapping("/api/pinned")
public Map<String, Object> pinned(@RequestParam long orderId) throws Exception {
    Object lock = syncLocks[(int) (orderId % STRIPES)];
    synchronized (lock) {        // 阻塞在 monitor 里 → 载体线程被钉住
        Thread.sleep(50);
        return Map.of("orderId", orderId, "status", "OK");
    }
}

// 修复版：ReentrantLock 排队时可正常卸载，不钉
private final ReentrantLock unpinnedLocks = new ReentrantLock();

@GetMapping("/api/unpinned")
public Map<String, Object> unpinned(@RequestParam long orderId) throws Exception {
    ReentrantLock lock = rlLocks[(int) (orderId % STRIPES)];
    lock.lock();
    try {
        Thread.sleep(50);
        return Map.of("orderId", orderId, "status", "OK");
    } finally {
        lock.unlock();
    }
}
```

> 注：**ReentrantLock** 是 `java.util.concurrent` 里的可重入锁。它和 `synchronized` 功能类似，但它的阻塞等待是基于 AQS 队列实现的——虚拟线程在它上面排队时可以被正常卸载，不会钉住载体线程。

压测时给每个请求随机 orderId，避免都挤在同一把锁上：

```lua
-- pin.lua
request = function()
    local id = math.random(1, 1000000)
    return wrk.format(nil, "/api/pinned?orderId=" .. id)
end
```

```bash
wrk -t4 -c500 -d60s -s pin.lua http://<服务IP>:8080/api/pinned
# 对照组把 path 换成 /api/unpinned 再跑一次
```

结果（`spring.threads.virtual.enabled=true` 下）：

| 版本 | 吞吐（QPS） | P50 | P99 |
|---|---|---|---|
| ReentrantLock | 9,610 | 52ms | 63ms |
| synchronized（钉住） | 5,030 | 99ms | 168ms |

同一个服务、同样的锁逻辑，**只把 `synchronized` 换成 `ReentrantLock`，吞吐差了近一倍，P99 差了 2.7 倍**。而且 5,030 这个数很有意思——正好贴着补偿上限 256 ÷ 0.05s ≈ 5120，说明瓶颈已经不是你的代码，是调度器补偿扩容的天花板。

### 5.3 怎么把它抓出来

**开发期快速暴露**：启动参数加 `-Djdk.tracePinnedThreads=full`，只要有虚拟线程被钉住，立刻打印完整堆栈，钉在哪一行一目了然（JDK 24 起这个开关随 JEP 491 一起成为历史，原因见下）。

**生产/压测期用 JFR**：**JFR（Java Flight Recorder，Java 飞行记录仪）**是 JDK 自带的低开销事件采集器，飞机黑匣子那个比喻，可以常年开着不心疼性能。JDK 自带一个专门记录钉住的事件类型 `jdk.VirtualThreadPinned`：

```bash
# 1. 找到进程 pid，启动 120 秒记录（profile 模板采样最全）
jcmd <pid> JFR.start name=vt duration=120s settings=profile filename=/tmp/vt.jfr

# 2. 正常打压测流量……

# 3. 打印钉住事件（有输出 = 有钉住，且带完整堆栈和时间）
jfr print --events jdk.VirtualThreadPinned /tmp/vt.jfr | head -40
```

默认配置只记录"钉住超过 20ms"的事件，所以我们这种 sleep 50ms 的现场一定能抓到。输出里会直接给出 `synchronized` 那一行的堆栈，拿着它去改代码就行。

### 5.4 修复与根治

1. **JDK 21 的正解**：把 `synchronized` 临界区内的阻塞操作换成 `ReentrantLock` 包裹，或者干脆把阻塞挪出临界区、把临界区缩到最小；
2. **长期正解**：升级到 **JDK 24+**。JEP 491（Synchronize Virtual Threads without Pinning）从根上解决了 `synchronized` 钉住问题——你可以把 5.2 的 `/api/pinned` 跑在 JDK 24 上做验证：两个接口吞吐应该一样，`jdk.tracePinnedThreads` 开关也随之移除。

## 六、常见坑与误区清单

1. **给虚拟线程做线程池**：池化是为了复用昂贵资源，虚拟线程用完即弃。要限下游并发用 `Semaphore`，别池化线程本身。
2. **指望它加速 CPU 密集任务**：虚拟线程不增加算力，CPU 密集老老实实横向扩容或优化算法。
3. **无脑用 ThreadLocal**：百万个虚拟线程 × 每线程一份大对象 = 内存事故。ThreadLocal 还能用，但大上下文传递建议关注 **ScopedValues**（JDK 21 起预览的轻量级共享机制，不可变、随作用域自动失效，比 ThreadLocal 更适合海量线程场景）。
4. **`synchronized` 里做 IO/DB 调用**：JDK 21 上就是钉住现场，见第五节。
5. **并发无限扇出**：虚拟线程让"发一万个并发请求"变得毫无痛感，下游可能先被你自己打挂。扇出并发要自己管（信号量 / 客户端连接池上限）。
6. **拿绝对压测数字到处吹**：换个下游延迟、换个机器规格，数字全变。对外只讲机制和相对趋势，数字要现场重测。

## 七、总结

- 线程池模型的天花板 ≈ 线程数 ÷ 单请求阻塞时长（Little's Law 推论），IO 密集服务在 4000 QPS 就撞墙，与机器算力无关；
- 虚拟线程把"阻塞"变便宜：阻塞即卸载，载体线程（≈CPU 核数个）持续干活，实测同环境吞吐 2.4 倍、P99 从 240ms 到 62ms；
- 虚拟线程是"更便宜"而不是"更快"，CPU 密集无收益；池化它没有意义，限流用 Semaphore；
- JDK 21 上警惕 `synchronized` 钉住：开发期 `-Djdk.tracePinnedThreads=full`，压测/生产用 JFR 的 `jdk.VirtualThreadPinned` 事件抓现场，修复用 `ReentrantLock`，根治升 JDK 24+（JEP 491）；
- 一切数字以自己环境的可复现实验为准：改 sleep 时长、对照吞吐上限公式，是最快的机制验证方式。

## 参考资料

1. [JEP 444: Virtual Threads (Final)](https://openjdk.org/jeps/444) —— 虚拟线程正式提案，机制与语义的一手来源
2. [JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491) —— JDK 24 解决 synchronized 钉住的官方方案
3. [Spring Boot 3.2 Release Notes](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.2-Release-Notes) —— `spring.threads.virtual.enabled` 开关的官方说明
4. [JDK 21 API 文档：java.lang.Thread](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html) —— `ofVirtual()`、`startVirtualThread()` 等 API 定义
5. [OpenJDK Loom 项目主页](https://wiki.openjdk.org/display/loom/Main) —— 虚拟线程背后的项目，含设计文档与百万线程示例
6. [Java Virtual Threads — A Guide (marcobehler.com)](https://www.marcobehler.com/guides/java-virtual-threads) —— 少见地把 pinning、ThreadLocal、池化误区讲透的实践向指南
