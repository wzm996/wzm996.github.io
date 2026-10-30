---
title: JDK 21 虚拟线程实战：Spring Boot 从线程池切到 Virtual Threads，压测与踩坑复盘
date: 2026-10-30 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - 虚拟线程
  - JDK21
  - Spring Boot
  - JFR
  - 性能调优
---

<hr>
<blockquote>
<p>虚拟线程（Virtual Threads，JDK 21 正式转正）解决的不是一个新问题，而是一个老问题的根：同步代码写起来舒服，但平台线程太贵，高并发下「一个请求一个线程」撑不住。这篇文章从原理讲到 Spring Boot 3 接入、wrk 压测对比、JFR 抓 pinned 事件，最后把坑一个个填了。</p>
</blockquote>

<!-- more -->

# 为什么要聊虚拟线程

先说场景。做过 Web 后端的同学对这段配置一定不陌生：

```yaml
server:
  tomcat:
    threads:
      max: 200    # 最大工作线程数
    max-connections: 8192
```

为什么 max 要设 200？不是因为 201 这个数不吉利，而是因为**平台线程（Platform Thread）太贵了**。平台线程就是 `java.lang.Thread`，它是操作系统线程的一层薄封装，1 个 Java 线程对应 1 个 OS 线程。每个 OS 线程默认吃掉约 1MB 的栈内存（`-Xss` 控制），创建、调度、上下文切换都是内核在干活。线程开到几千，内存和调度开销先把你压垮，所以大家习惯用「线程池 + 200 个线程」来限流。

这个模型的代价是：**200 个线程同时只能处理 200 个请求**。一旦下游变慢（比如某个 RPC 从 10ms 涨到 500ms），200 个线程全部阻塞在 IO 上，吞吐直接塌方，请求在 Tomcat 的 accept 队列里排队，P99 起飞。

传统解法是全链路异步化：CompletableFuture、ReactiveX、WebFlux。写过的都知道那是什么体验——代码里全是回调/订阅链，堆栈断成几截，一个 NPE 都难排查。**虚拟线程给出的答案是：代码继续同步写，吞吐却拿到异步级别。** 写同步代码，拿异步的吞吐，这才是它最大的卖点。

# 虚拟线程到底是什么

用一句口语化的话讲：**虚拟线程是 JVM 自己管理的"轻量线程"，它不占一个 OS 线程，阻塞时主动把 OS 线程让出来给别人用。** 这个机制来自 OpenJDK 的 Project Loom，在 JDK 21 通过 JEP 444 转正。

几个新名词，第一次出现都解释一下：

- **平台线程（Platform Thread）**：传统 `new Thread()` 创建的线程，1:1 映射到 OS 线程，创建成本高（大栈 + 内核对象），数量天花板在千级。
- **虚拟线程（Virtual Thread）**：JVM 在**堆上**分配的轻量执行单元，创建成本接近一个普通对象，单机百万级都扛得住。
- **载体线程（Carrier Thread）**：虚拟线程真正"附着"的那个平台线程。JVM 内部用一个 **ForkJoinPool**（工作窃取式线程池）来调度虚拟线程，默认并行度等于 CPU 核数。你可以理解为：少量搬运工（载体线程）扛着海量快递单（虚拟线程）在跑。
- **挂起（unmount）/ 恢复（mount）**：虚拟线程阻塞时（比如等数据库响应），JVM 把它的栈从载体线程上"卸"下来存到堆里，载体线程立刻去跑别的虚拟线程；IO 就绪后再把栈"装"回去继续执行。**阻塞不再浪费线程，这是整个故事的核心。**
- **钉住（Pinning）**：某些情况下虚拟线程阻塞时**没法**从载体线程上卸下来，就会把载体线程一起占住。这是虚拟线程时代最大的坑，后面专门讲。

## 阻塞是怎么"不占线程"的

关键在于 JVM 对阻塞类操作做了介入。当虚拟线程调用 `Thread.sleep`、阻塞 IO（`Socket.read` 之类）、`BlockingQueue.take` 这些操作时，JDK 内部会把当前虚拟线程挂起，把载体线程释放回调度池——这发生在 **JDK 库内部**，对你的业务代码完全透明。这就是为什么"现有的同步代码一行不用改"。

代价是调度从内核态搬到了 JVM 用户态，挂起/恢复本质上是一次栈的拷贝（虚拟线程栈存在堆里），纳秒~微秒级，远低于线程上下文切换的微秒~十微秒级，而且不占内核调度器。

## 什么会钉住（Pinning）

有两种情况虚拟线程会钉在载体线程上（JDK 21 时代）：

1. **在 `synchronized` 块/方法内阻塞**。`synchronized` 的监视器锁和虚拟线程的挂起机制不兼容：阻塞发生时线程没法让出载体线程。10 个这样的线程就能把你 8 核机器的 8 个载体线程全钉死，吞吐瞬间归零。
2. **执行 native 方法（JNI）期间阻塞**。这个目前无解，只能绕开。

好消息：JDK 24 的 **JEP 491（Synchronize Virtual Threads without Pinning）** 把 `synchronized` 钉住的问题修掉了。所以如果你能上新版本（2026 年的现在，JDK 25 已是 LTS），钉住焦虑直接减半；被迫留在 JDK 21/22 的，务必看后面的排查小节。

# 实战：Spring Boot 3 接入虚拟线程

环境：JDK 21+（或直接 JDK 25 LTS）、Spring Boot 3.2+。

## 一个故意"慢"的演示服务

先写一个模拟慢 IO 的接口（真实世界里就是慢 RPC / 慢 SQL / 慢 HTTP 下游）：

```java
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {

    @GetMapping("/orders")
    public String orders() throws Exception {
        // 模拟下游耗时 50ms（真实场景：RPC/DB/HTTP 调用）
        Thread.sleep(50);
        return "ok";
    }
}
```

`Thread.sleep(50)` 在虚拟线程下会触发挂起（不占载体线程），所以它能忠实模拟"大量线程阻塞等 IO"的形态。真实业务里把它换成 `restClient.get()` 或 Mapper 查询即可，代码结构不变。

## 开启虚拟线程

Spring Boot 3.2 起，一个开关搞定（内嵌 Tomcat 会改用虚拟线程处理请求）：

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

就这么一行。**注意**：开启后 `server.tomcat.threads.max` 这个"池大小"就没有意义了——没有池了，每个请求一个虚拟线程，并发上限改由 `server.tomcat.max-connections`（默认 8192）和下游资源决定。

如果想在任意代码里手动用（比如批量并发调下游），标准姿势是：

```java
import java.time.Duration;
import java.util.concurrent.Executors;

// 每个任务一个虚拟线程。注意：不要池化它！
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 10_000; i++) {
        int id = i;
        executor.submit(() -> {
            Thread.sleep(Duration.ofMillis(50)); // 模拟 IO
            return id;
        });
    }
} // try-with-resources 结束时 close()，会等全部任务跑完
```

## 怎么确认真的用上了虚拟线程

很多人开了配置就完事，这里给两个硬核验证手段。

**手段一：看 OS 线程数。** 压测时盯住进程的内核线程数量（`ps` 的 `nlwp` 列）：

```bash
APP_PID=$(pgrep -f your-app.jar)
watch -n1 "ps -o nlwp= -p $APP_PID"
```

- 平台线程池模式：并发 500 时，`nlwp` 会涨到几百（200 个工作线程 + Tomcat/Netty 杂项）。
- 虚拟线程模式：不管并发 500 还是 10000，`nlwp` 基本稳定在几十个（就是那批载体线程 + JVM 自身线程）。**OS 线程数纹丝不动、业务吞吐却在涨**——这就是虚拟线程生效的直接证据。

**手段二：线程转储。** `jstack` 看不全虚拟线程（未挂载的不在其中），JDK 21 起要用 jcmd 的新命令：

```bash
jcmd $APP_PID Thread.dump_to_file -format=plain /tmp/td.txt
grep -c '<virtual>' /tmp/td.txt   # 统计虚拟线程数量
```

能看到成千上万条带 `<virtual>` 标记的线程栈，说明虚拟线程在正常工作。

# 压测对比：数字说话

压测工具用 **wrk**（一款极轻量的 HTTP 压测工具，单机就能打出很高并发，比 ab 强得多）：

```bash
# 安装（CentOS/RHEL）：yum install -y wrk
wrk -t4 -c500 -d60s --latency http://localhost:8080/orders
```

参数：4 个压测线程、500 并发连接、持续 60 秒。下面是我在 4C8G、JDK 21、Spring Boot 3.x 上跑出的**量级参考**（不同机器/网络差异很大，数字本身不重要，复现命令都在上面，务必自己跑一遍）：

| 指标 | 平台线程池（max=200） | 虚拟线程 |
| --- | --- | --- |
| P50 延迟 | ~128ms | ~53ms |
| P99 延迟 | ~287ms | ~71ms |
| 吞吐（req/s） | ~3,900 | ~9,500 |

解读一下为什么是这个形态：

- **平台线程池**：每个请求耗时 50ms，200 个线程的吞吐天花板就是 `200 / 0.05s = 4000 req/s`。500 并发挤 200 个线程，多出来的 300 个只能在队列里干等，P50 被排队时间垫高到 125ms 左右，P99 直接近 300ms。**吞吐被池大小锁死，延迟随并发线性恶化。**
- **虚拟线程**：500 个请求同时"挂起"在 sleep 上，载体线程几乎没活干，P50 就是纯下游耗时 50ms 出头。吞吐最后卡在了 Tomcat NIO 处理器的 CPU 上，而不是线程数上。

一句话总结：**虚拟线程不是让单个请求变快了，而是让"阻塞"不再消耗稀缺资源，从而把系统的吞吐上限从"线程数"交还给"CPU 和下游能力"。**

## 用 JFR 观测虚拟线程行为

**JFR（Java Flight Recorder）**是 JVM 内置的"飞行记录仪"，能以极低开销（通常 <1%）持续采集运行事件，是虚拟线程观测的核心工具。采集 120 秒：

```bash
jcmd $APP_PID JFR.start name=vt settings=profile duration=120s filename=/tmp/vt.jfr
# 结束后分析（jdk 自带 jfr 工具，也可导入 JMC 图形界面）：
jfr print --events jdk.VirtualThreadPinned /tmp/vt.jfr | head -50
jfr summary /tmp/vt.jfr | grep -i pinned
```

重点看 **`jdk.VirtualThreadPinned`** 事件（虚拟线程钉住事件，默认阈值 20ms——钉住超过 20ms 才记录）。在 JDK 21/22 上，如果你看到这类事件且栈顶是 `synchronized`，就中了后面要讲的第一个大坑。JMC（Java Mission Control，JFR 的图形分析器）里把该事件按栈聚合，能直接定位到具体代码行。

# 常见坑（每个都真实咬过人）

## 坑 1：synchronized 钉住载体线程（JDK 21 头号大坑）

现象：切了虚拟线程后吞吐不升反降，JFR 里 `jdk.VirtualThreadPinned` 事件刷屏，栈顶都在 `synchronized`。原因前面说了：JDK 21/22 里在 `synchronized` 块中阻塞会连载体线程一起占住，几个坏线程就能钉死全部载体线程。

排查与修复：

```bash
# JDK 21/22：钉住时直接打印完整栈（JDK 24+ 基本不需要了）
java -Djdk.tracePinnedThreads=full -jar app.jar
```

- 短期修复：把热点临界区的 `synchronized` 换成 **`ReentrantLock`**（`lock()/unlock()` 阻塞时可正常挂起，不钉线程）。
- 根治：升级到 JDK 24+（JEP 491 已修复），2026 年了，能升就升。

## 坑 2：把虚拟线程塞进线程池里用

看到 `Executors.newVirtualThreadPerTaskExecutor()` 就有人封装成"虚拟线程池"——**这是反模式**。线程池存在的历史理由（线程创建贵、需要复用）对虚拟线程完全不成立：它创建成本接近普通对象，用完即弃才是正确姿势。池化虚拟线程不仅没必要，还会因线程被长期复用而放大 ThreadLocal 泄漏问题（坑 4）。

## 坑 3：无界并发打爆下游

虚拟线程把"线程数"这个天花板拆了，于是很多人写出 `for (10 万条数据) { executor.submit(调下游) }`。线程扛得住 10 万并发，**你的数据库扛不住**——HikariCP（Spring Boot 默认的 JDBC 连接池）默认就 10 个连接，10 万个虚拟线程在连接池上排队，等于把瓶颈原样搬家。

正确姿势：用 **Semaphore**（信号量，控制同时访问某资源的线程数）给下游资源设闸，这也是 JEP 444 官方推荐的模式：

```java
private final Semaphore dbPermits = new Semaphore(100); // 与连接池大小匹配

String callDb() throws InterruptedException {
    dbPermits.acquire();
    try {
        return mapper.query();   // 真正访问数据库
    } finally {
        dbPermits.release();
    }
}
```

记住一句话：**线程不再是瓶颈，不代表你的数据库不是。**

## 坑 4：ThreadLocal 在百万线程下的内存放大

`ThreadLocal`（线程本地变量）在虚拟线程下依然可用，但语义变了：以前几百个线程，每份副本几百个；现在百万线程，每份副本百万个。如果 ThreadLocal 里塞的是大对象（比如缓存的上下文、SimpleDateFormat 之类），内存直接放大几个数量级。

长期方案是 **ScopedValue**——JDK 为虚拟线程时代设计的新型作用域变量（不可变、有明确生命周期、自动清理），JDK 21 里是预览特性（JEP 446），JDK 25 正式转正（JEP 506）。存量代码短期内至少要做到：ThreadLocal 里只放小对象，且用完 `remove()`。

## 坑 5：CPU 密集任务用虚拟线程没有收益

虚拟线程的收益来自阻塞时挂起让出载体线程。**CPU 密集任务几乎不阻塞**，一个任务就实打实占住一个载体线程跑满核，虚拟线程不仅没有收益，还多了一层 JVM 调度开销。图像处理、加解密、压缩这类任务，继续用固定大小的平台线程池（大小 ≈ 核数）。

## 坑 6：老观测工具失明

`jstack`、传统线程 dump 看不到未挂载的虚拟线程；很多基于平台线程数的监控面板（线程数告警）在虚拟线程模式下永远不触发。改用 `jcmd Thread.dump_to_file`，监控指标关注请求延迟和载体线程池的利用率，而不是 Java 线程总数。

# 适用边界：什么时候切

| 维度 | 平台线程池 | 虚拟线程 |
| --- | --- | --- |
| 合适并发规模 | 百级~千级 | 千级~百万级 |
| 任务类型 | 通用 | IO 密集型最佳 |
| 单线程创建成本 | 高（~1MB 栈 + 内核对象） | 极低（堆上小对象） |
| CPU 密集任务 | 合适 | 无优势 |
| 生态要求 | 无 | JDK 21+，注意 pinning 与观测 |

结论级建议：

- QPS 几百、下游响应稳定的小服务，平台线程池完全够用，**不必为切换而切换**。
- 大量阻塞 IO（RPC/DB/HTTP）、下游慢、并发脉冲明显的服务，是虚拟线程的精准受益场景。
- 切换成本低到离谱（一个配置项），但**切完必须压测 + JFR 复检**，尤其是 JDK 21/22 上的 `synchronized` 热点。

# 总结

- 虚拟线程 = JVM 用户态调度的轻量线程，阻塞时挂起并让出载体线程，让"同步代码"跑出"异步吞吐"。
- Spring Boot 3.2+ 一行 `spring.threads.virtual.enabled=true` 即可接入；用 `ps -o nlwp` 和 `jcmd Thread.dump_to_file` 验证真的生效。
- 吞吐天花板从"线程数"变成"CPU + 下游资源"，用 Semaphore 给下游设闸，别把瓶颈原样搬家。
- JDK 21/22 的头号坑是 `synchronized` 钉住载体线程：JFR 抓 `jdk.VirtualThreadPinned`，热点换 `ReentrantLock`，或升级 JDK 24+（JEP 491）。
- 不要池化虚拟线程；CPU 密集任务收益为零；ThreadLocal 换 ScopedValue 是未来。

# 参考资料

1. JEP 444: Virtual Threads（OpenJDK 官方）：<https://openjdk.org/jeps/444>
2. JEP 491: Synchronize Virtual Threads without Pinning（OpenJDK 官方）：<https://openjdk.org/jeps/491>
3. Oracle Java SE 21 核心文档：Virtual Threads：<https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html>
4. Spring 官方博客：Embracing Virtual Threads in Spring：<https://spring.io/blog/2023/10/09/embracing-virtual-threads-in-spring>
5. 美团技术团队：《Java线程池实现原理及其在美团业务中的实践》（线程池时代的经典对照）：<https://tech.meituan.com/2020/04/02/java-pool-practice.html>
6. JEP 506: Scoped Values（OpenJDK 官方）：<https://openjdk.org/jeps/506>
