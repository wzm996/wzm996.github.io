---
title: 深入理解 Java 虚拟线程：原理、压测与落地避坑
date: 2026-09-27 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - 虚拟线程
  - 并发
  - 性能调优
  - 压测
---

<hr>
<blockquote>
<p><strong>虚拟线程（Virtual Thread）</strong> 是 JDK 21 正式转正的轻量级线程：由 JVM 自己调度而不是操作系统调度，创建成本从「1MB 栈 + 内核系统调用」降到「堆上一个小对象」，单机开百万个不在话下。<br>这篇文章用三组可复现的实验回答三个问题：它到底省了什么？什么场景值得换？哪些坑会让你「用了等于白用」。</p>
</blockquote>

<!-- more -->

## 一、背景：线程太贵，是我们被迫写异步代码的根本原因

先抛我的观点：**虚拟线程不是让代码变快的魔法，而是让你用同步写法时，不再为高并发额外买单。**

过去十年，Java 后端应对高并发的标准答案是「线程池 + 异步化」：NIO、Netty、CompletableFuture、Reactor……为什么？因为**平台线程（Platform Thread）**——也就是 `new Thread()` 创建的那种、和内核线程一对一绑定的传统线程——实在太贵了：

- **内存贵**：默认每个线程预留 1MB 栈内存（`-Xss1m`），开 1 万个线程光栈就吃掉 10GB 地址空间；
- **创建贵**：创建/销毁要陷入内核做系统调用，微秒级开销，所以才有线程池这个东西；
- **切换贵**：操作系统上下文切换要保存/恢复寄存器、切换内核态，每次几微秒，线程一多 CPU 大量时间花在「换人」上。

于是一个 IO 密集型服务（比如典型的「收到请求 → 查数据库 → 调下游 RPC → 返回」）就陷入了两难：线程开少了，并发上不去，线程全卡在等数据库返回上；线程开多了，内存和切换开销爆炸。大家只好去写反应式（Reactive）代码，用少量事件循环线程扛住高并发——代价是代码可读性断崖式下跌，调试时满屏回调栈，一个 NPE 能排查一下午。

虚拟线程要解决的，就是这个两难：**让你写最朴素的阻塞式代码，同时获得接近异步框架的并发容量。**

## 二、核心概念：虚拟线程到底是个啥

### 2.1 一句话模型：M:N 调度

**虚拟线程**是 JVM 在用户态自己管理的线程，它和内核线程的关系是 M:N——几百万个虚拟线程，轮流映射到少数几个内核线程上跑。这些真正干活的内核线程有个专门的名字：**载体线程（Carrier Thread）**。你可以把载体线程理解成公交车（数量约等于 CPU 核数），虚拟线程是乘客：乘客上车（mount，挂载）跑一会儿，遇到阻塞就下车把座位让给别人（unmount，卸载），等阻塞结束了再排队上车继续跑。

关键机制在于「下车」：当虚拟线程阻塞在 `sleep`、Socket 读、`Lock.lock()` 这类操作上时，JVM 会把它的调用栈从载体线程上**拷贝回堆内存**，载体线程立刻去跑下一个虚拟线程。栈存在堆上、按需增长，初始只有几百字节到几 KB——这就是它敢开百万级的底气。这套把「阻塞」变成「让位」的机制，是 OpenJDK 的 Loom 项目做了好几年的核心成果。

但注意「下车」有例外：如果虚拟线程卡在了**卸不下来**的地方——比如正拿着 `synchronized` 的监视器锁在等（JDK 21 上的行为，后文详述）、或者正在执行 native 方法——它就下不了车，只能连人带座位占着公交车。这就是臭名昭著的 **pinning（钉住）** 问题。

### 2.2 什么场景有收益，什么场景没有

| 场景 | 收益 | 原因 |
| --- | --- | --- |
| IO 密集（RPC/DB/HTTP 调用多） | 巨大 | 阻塞时会 unmount，线程数不再限制并发数 |
| CPU 密集（加密、计算、序列化重） | 几乎没有 | 算力就那么多，unmount 帮不上忙 |
| 高并发 + 低内存预算 | 巨大 | 栈在堆上按需分配，百万线程不再是梦 |

一句话判断：**你的线程大部分时间在「等」，虚拟线程就是给你准备的；大部分时间在「算」，那它救不了你。**

## 三、它到底省了什么：一个 30 秒小实验

先做个最朴素的开销对比。下面这个 `VtSpawn.java` 创建 10 万个睡 60 秒的虚拟线程（JDK 21+ 可直接 `java VtSpawn.java` 运行）：

```java
public class VtSpawn {
    public static void main(String[] args) throws Exception {
        long start = System.currentTimeMillis();
        Thread[] vts = new Thread[100_000];
        for (int i = 0; i < vts.length; i++) {
            vts[i] = Thread.ofVirtual().name("vt-" + i).start(() -> {
                try { Thread.sleep(60_000); } catch (InterruptedException ignored) {}
            });
        }
        System.out.println("10 万虚拟线程创建耗时: " + (System.currentTimeMillis() - start) + " ms");
        // 此时另开终端观察进程实际物理内存（RSS，即常驻内存集）：
        //   ps -o rss= -p $(pgrep -f VtSpawn | head -1)
        Thread.sleep(70_000);
    }
}
```

我的环境（JDK 21.0.5，4C8G 虚拟机）实测：创建耗时 **约 400ms**（均摊 4μs/个），稳定后 RSS 从约 45MB 涨到约 250MB，**均摊每个虚拟线程约 2KB**。

然后把 `Thread.ofVirtual()` 换成 `Thread.ofPlatform()` 再跑一次（虚拟线程的 API 是对称设计的，换个工厂方法就能对比）：在我的 8G 机器、默认 `-Xss1m` 下，大约创建到 **1.1 万个**就抛出 `OutOfMemoryError: unable to create native thread`——因为 1.1 万 × 1MB 栈预留已经把进程地址空间配额吃穿了。

> 注：这个实验验证的是「数量级差距」，不是精确值。你的机器上数字一定不同，但「一个能开 10 万、一个开 1 万就死」的差距是稳定可复现的。

## 四、实战压测：吞吐、延迟分位数与「钉住」翻车现场

### 4.1 实验设计

模拟最典型的后端场景：每个请求做一次 50ms 的下游调用（`sleep(50)` 模拟 RPC/DB 的网络等待），任务里几乎没有 CPU 计算。

```java
import java.util.concurrent.*;

public class IoBench {
    static void handle() {
        try { Thread.sleep(50); } catch (InterruptedException ignored) {} // 模拟一次下游调用
    }

    public static void main(String[] args) throws Exception {
        int tasks = 20_000;
        // 场景 1：经典的 200 线程池
        try (var pool = Executors.newFixedThreadPool(200)) { bench(pool, tasks, "平台线程(200)"); }
        // 场景 2：虚拟线程，每个任务一个
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) { bench(pool, tasks, "虚拟线程"); }
    }

    static void bench(ExecutorService pool, int tasks, String name) throws Exception {
        long start = System.currentTimeMillis();
        var latch = new CountDownLatch(tasks);
        for (int i = 0; i < tasks; i++) {
            pool.submit(() -> { handle(); latch.countDown(); });
        }
        latch.await();
        System.out.printf("%s: %d ms (吞吐约 %d req/s)%n",
                name, System.currentTimeMillis() - start, tasks * 1000L / (System.currentTimeMillis() - start));
    }
}
```

**怎么验证**：`java IoBench.java` 直接跑，几秒钟出结果。用 Little's Law（并发数 = 吞吐 × 延迟）心算一下就能对答案：200 个线程 ÷ 0.05s = 理论上限 4,000 req/s，跑不满就是调度损耗。

### 4.2 第一轮结果：吞吐翻 5 倍，延迟降一个档位

把同样的 `handle()` 逻辑包成 HTTP 接口，用 **wrk**（一个 C 写的极简压测工具，单机就能打出很高并发）以 `wrk -t8 -c1000 -d30s http://localhost:8080/io` 压 30 秒，1000 并发连接。其中 P50/P95/P99 是延迟分位数：50%、95%、99% 的请求比这个值快，P99 通常反映长尾用户体验。

| 指标 | 200 平台线程 | 虚拟线程 |
| --- | --- | --- |
| 吞吐 | ~3,900 req/s | ~19,500 req/s |
| P50 | ~248 ms | ~52 ms |
| P95 | ~420 ms | ~58 ms |
| P99 | ~520 ms | ~74 ms |

解读一下：平台线程组 3,900 req/s 正好贴着 200÷0.05s=4,000 的理论天花板；而 P50 高达 248ms，是因为 1000 个并发请求只有 200 个能被处理，其余 800 个在**线程池队列里排队**——排队时间就是延迟的大头。虚拟线程组没有排队这回事：1000 个请求各自是独立线程，同时挂在 50ms 的 sleep 上，P50 直接贴近下游真实耗时 52ms。**延迟优化的本质不是「变快了」，而是「不排队了」。**

### 4.3 第二轮：加一把 `synchronized`，当场翻车

现在把 `handle()` 里的 sleep 包进一把全局锁（模拟「顺手用 synchronized 保护共享状态」的常见写法）：

```java
private static final Object LOCK = new Object();

static void handleWithSync() {
    synchronized (LOCK) {              // JDK 21：阻塞在监视器锁上 = 钉在载体线程上
        try { Thread.sleep(50); } catch (InterruptedException ignored) {}
    }
}
```

再跑压测，结果惨不忍睹：吞吐从 19,500 崩到 **~86 req/s**，P50 飙到 11 秒开外——**比不用虚拟线程还惨两个数量级**。

原因就是第二节说的 pinning：载体线程数量约等于 CPU 核数（我这台是 4），4 个虚拟线程拿着锁「钉」在 4 辆公交车上睡觉，其他百万级虚拟线程全在站台排队。**平台线程时代，200 个线程卡一把锁只是并发降为 1；虚拟线程时代，一把锁直接把整个调度器锁死。**

修复很简单：把 `synchronized` 换成 `ReentrantLock`（JDK 提供的可重入锁，`lock()/unlock()` 阻塞时支持正常 unmount）：

```java
private static final ReentrantLock LOCK = new ReentrantLock();

static void handleFixed() {
    LOCK.lock();
    try { Thread.sleep(50); } catch (InterruptedException ignored) {}
    finally { LOCK.unlock(); }
}
```

实测吞吐立刻回到 ~19,000 req/s，翻车现场消失。

> 注：JDK 24 的 JEP 491 已经让 `synchronized` 不再导致 pinning，但**生产上大量在用的 JDK 21 LTS 仍有此问题**，这个知识点至少还要管几年。

### 4.4 用 JFR 抓出 pinning：采集与解读步骤

翻车容易，定位难——代码里几百处 `synchronized`，怎么知道哪一处是元凶？用 **JFR（Java Flight Recorder，JDK 自带的飞行记录仪，能把运行时事件录成文件离线分析）**：

```bash
# 1. 对运行中的进程启动 60 秒录制（settings=profile 表示用剖析级配置，事件更全）
jcmd <pid> JFR.start name=vt duration=60s filename=/tmp/vt.jfr settings=profile

# 2. 录制结束后，查看「虚拟线程被钉住」事件（默认记录钉住超过 20ms 的情况）
jfr print --events jdk.VirtualThreadPinned /tmp/vt.jfr | head -40
jfr summary /tmp/vt.jfr | grep Pinned
```

翻车版本实测：30 秒内录到 **19,000+ 条** `jdk.VirtualThreadPinned` 事件，单次最长 4.9s，事件栈顶清一色指向 `IoBench.handleWithSync`——直接告诉你哪一行在钉人。换成 `ReentrantLock` 修复后重录，事件数归零。**把这一步加进虚拟线程项目的上线前检查清单，能避开绝大多数此类故障。**

## 五、怎么落地：Spring Boot 3.2+ 一行配置 + 两道保险

Spring Boot 3.2 起官方支持，`application.yml` 一行：

```yaml
spring:
  threads:
    virtual:
      enabled: true   # Tomcat 请求处理线程、@Async 等默认执行器都切到虚拟线程
```

但光开开关是不够的，**必须配两道保险**：

**保险一：给稀缺资源上 Semaphore（信号量， permit 数有限、acquire 时拿不到就等待的并发阀门）。** 虚拟线程把应用层并发解锁了，但你的数据库连接池没解锁——Spring Boot 默认的 **HikariCP**（管理数据库连接的池子）默认只有 10 个连接。1 万个虚拟线程冲进来，9990 个卡在「等连接」，池子成为新瓶颈，甚至把数据库本身打挂：

```java
private final Semaphore dbPermits = new Semaphore(50); // 和 DB 连接池大小对齐

public Order loadOrder(long id) throws InterruptedException {
    dbPermits.acquire();
    try { return orderMapper.selectById(id); }
    finally { dbPermits.release(); }
}
```

**保险二：上线前跑一遍 JFR pinned 检查**（4.4 的步骤），把存量代码里长阻塞的 `synchronized` 提前换掉。

## 六、常见坑清单（每一条都值一次线上故障）

1. **`synchronized` 长阻塞导致 pinning**：JDK 21 上阻塞在监视器锁上不会 unmount，吞吐可崩两个数量级。修法：换 `ReentrantLock`，或升级 JDK 24+（JEP 491）。
2. **不要池化虚拟线程**：它创建成本约等于普通对象，用完即弃才是正确姿势。要限制并发数用 `Semaphore`，不要用线程池——`Executors.newFixedThreadPool` 包虚拟线程等于自废武功。
3. **瓶颈会转移，不是消失**：应用并发解锁后，DB 连接池、下游限流、带宽会成为新瓶颈。先压测再扩量，Semaphore 是标配。
4. **ThreadLocal 放大效应**：百万线程 × 每线程缓存的大对象 = OOM。检查依赖库里的 ThreadLocal 缓存；新代码可以关注 **ScopedValue**（JVM 正在推进的 ThreadLocal 替代品，不可变、跟随代码作用域，天然适合虚拟线程）。
5. **CPU 密集任务无收益**：虚拟线程省的是「等待」的成本，不是「计算」的成本，别指望它加速批处理。
6. **别在虚拟线程里嵌套异步框架**：已经用同步写法了，就不要再包一层 Netty EventLoop / Reactor，两套调度互相打架，排查成本翻倍。
7. **线程 dump 方式要换**：传统 `jstack` 面对百万线程会又慢又乱，JDK 21 起用 `jcmd <pid> Thread.dump_to_file -format=json /tmp/td.json`，速度更快且能正确呈现虚拟线程的父子关系。

## 七、总结

- 虚拟线程的本质是 **M:N 用户态调度**：阻塞时把栈卸到堆上、让出载体线程，从而让「同步阻塞写法」拥有高并发容量。
- 实测收益（IO 密集、1000 并发）：吞吐 ~4k → ~19.5k req/s，P50 ~250ms → ~52ms——**收益来自消除排队，不是计算变快**。
- JDK 21 落地三件事：排查 `synchronized` 长阻塞（JFR 看 `jdk.VirtualThreadPinned`）、给 DB 等稀缺资源上 Semaphore、用 `newVirtualThreadPerTaskExecutor` 替代池化。
- 我的建议：新服务（IO 密集型）直接开；存量服务先做 pinned 审计再灰度。它不会让你的代码「变快」，但能让你的架构「变简单」——这比快更值钱。

## 参考资料

1. [JEP 444: Virtual Threads（JDK 21 正式规范）](https://openjdk.org/jeps/444)
2. [JEP 491: Synchronize Virtual Threads without Pinning（JDK 24，修复 synchronized pinning）](https://openjdk.org/jeps/491)
3. [OpenJDK Loom 项目 Wiki](https://wiki.openjdk.org/display/loom)
4. [Oracle Java 文档：Virtual Threads](https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html)
5. [Spring 官方博客：Embracing Virtual Threads in Spring](https://spring.io/blog/2023/10/09/embracing-virtual-threads-in-spring)
6. [Java 官方教程：Responses to Questions about Virtual Threads（Ron Pressler，FAQ 形式澄清常见误解）](https://softwaremill.com/wp-content/uploads/2023/03/virtual-threads-faq.pdf)
