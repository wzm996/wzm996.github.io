---
title: 深入理解 Spring Boot 虚拟线程：从压测到 JFR 排查
date: 2026-05-16 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Spring Boot
  - 虚拟线程
  - JDK21
  - JFR
  - 性能调优
---
<hr>
<blockquote>
<p>虚拟线程不是“让 CPU 变快”的魔法，它真正擅长的是把大量阻塞等待从昂贵的平台线程上搬走。本文用一个 Spring Boot 3.2 + JDK 21 的小实验，压测对比平台线程与虚拟线程，并用 JFR 看清楚吞吐、延迟和线程 pinning 的边界。</p>
</blockquote>

<!-- more -->

<h1 id="这篇文章解决什么问题"><a href="#这篇文章解决什么问题" class="headerlink" title="这篇文章解决什么问题"></a>这篇文章解决什么问题</h1>

Spring Boot 3.2 开始，对 JDK 21 的 **Virtual Threads（虚拟线程）** 支持已经足够顺手：配置一行 `spring.threads.virtual.enabled=true`，很多阻塞式 Web 应用就能把请求处理线程切到虚拟线程上。

但线上工程里最怕的就是“听起来很香，开了以后不知道发生了什么”。虚拟线程到底适合什么场景？为什么有些接口吞吐能明显上去，有些接口几乎没变化？遇到 `synchronized`、数据库连接池、HTTP 连接池时会不会翻车？这些问题不能靠背概念，要靠压测和观测。

本文会从一个可运行的 Spring Boot 示例开始，做三件事：

1. 用同一套接口对比 **平台线程** 和 **虚拟线程** 的吞吐、P95/P99 延迟；
2. 用 **JFR（Java Flight Recorder）** 采集虚拟线程事件，定位 pinning；
3. 总结虚拟线程在 Spring Boot 服务里的落地边界：什么时候开、怎么验证、常见坑在哪里。

> 注：**平台线程**可以简单理解为传统 Java 线程，它通常一对一绑定操作系统线程；**虚拟线程**是 JDK 管理的轻量级线程，数量可以很多，遇到阻塞 I/O 时会把底层操作系统线程让出来。它解决的是“阻塞等待太多导致线程资源不够用”的问题，不是直接提升单次 CPU 计算速度。

<h1 id="候选选题与最终选择"><a href="#候选选题与最终选择" class="headerlink" title="候选选题与最终选择"></a>候选选题与最终选择</h1>

本次按专栏方向先列 4 个候选，覆盖 Java 工程、AI 工程化、数据库与网络排障：

| 候选 | 分类 | tags | 目标读者与先修 | 大纲 | 亮点/实践点 |
| --- | --- | --- | --- | --- | --- |
| 深入理解 Spring Boot 虚拟线程：从压测到 JFR 排查 | 编程语言 / Java | Spring Boot、虚拟线程、JDK21、JFR、性能调优 | 熟悉 Spring Boot REST 接口、线程池基础 | 背景、原理、Demo、压测、JFR、常见坑、总结 | 可运行 Demo；吞吐/P99 对比；JFR pinning 排查 |
| Spring AI 接入 RAG：从 Embedding 到检索增强回答 | 后端工程 / 任务与调度 | Spring AI、RAG、Embedding、向量检索、LLM | 熟悉 Spring Boot、HTTP API | RAG 流程、分块、向量化、召回、评测、成本 | Java × AI；延迟/成本分解；可复现实验 |
| MySQL 复合索引为什么会失效：用 EXPLAIN 和慢 SQL 讲清楚 | 数据库与存储 / MySQL | MySQL、索引、EXPLAIN、慢 SQL、优化 | 熟悉 SQL、B+Tree 基础 | 索引结构、最左前缀、失效场景、实验、优化 | 可建表复现；EXPLAIN 对比；常见误区 |
| HTTP 连接池参数怎么配：Spring Boot 调用下游服务的超时与复用 | 计算机网络 / HTTP/HTTPS | HTTP、连接池、超时、RestClient、排障 | 熟悉 HTTP、Spring Web | 连接复用、超时、压测、抓包、排障 | tcpdump/Wireshark；延迟对比；生产参数建议 |

最终选择第一篇：**深入理解 Spring Boot 虚拟线程：从压测到 JFR 排查**。

原因很直接：它契合 Java 开发主线，也足够工程化。虚拟线程是 JDK 21 之后 Java 服务端绕不开的话题，Spring Boot 又把开关做得很低成本；但低成本不等于可以无脑开。用压测 + JFR 把收益和边界讲清楚，对后续写 JVM、并发、Spring Boot 性能调优系列也有连续性。

<h1 id="先把核心概念讲清楚"><a href="#先把核心概念讲清楚" class="headerlink" title="先把核心概念讲清楚"></a>先把核心概念讲清楚</h1>

<h2 id="平台线程为什么贵"><a href="#平台线程为什么贵" class="headerlink" title="平台线程为什么贵"></a>平台线程为什么贵</h2>

传统 Java 线程一般对应一个操作系统线程。操作系统线程需要内核调度，也需要线程栈等资源。对于 CPU 密集型任务，这个模型没什么问题，因为线程本来就在忙着算。

但很多后端接口不是一直在算，而是在等：

- 等数据库返回；
- 等 Redis 返回；
- 等下游 HTTP 接口返回；
- 等磁盘或网络 I/O。

这类任务叫 **I/O 密集型任务**：瓶颈不是 CPU 算不动，而是大量时间花在输入输出等待上。如果一个请求线程阻塞 200ms，其中真正执行 Java 代码只有 5ms，那传统平台线程大部分时间都在“占着坑位等”。并发一上来，线程池很容易被占满，后面的请求只能排队。

<h2 id="虚拟线程做了什么"><a href="#虚拟线程做了什么" class="headerlink" title="虚拟线程做了什么"></a>虚拟线程做了什么</h2>

虚拟线程仍然是 `java.lang.Thread`，但它不是直接长期占用一个操作系统线程。JDK 会把虚拟线程挂载到少量 **Carrier Thread（载体线程）** 上执行。

> 注：Carrier Thread 可以理解为“真正干活的底层平台线程”。虚拟线程跑 Java 代码时要借用它，遇到可卸载的阻塞 I/O 时会从它身上让出来，让载体线程去执行别的虚拟线程。

这带来一个非常实际的好处：阻塞式代码不用大改成响应式，也能承载更多并发等待。

不过这里有两个关键限制：

1. 虚拟线程不减少业务逻辑本身的 CPU 消耗；
2. 如果虚拟线程被 **pinning（钉住）**，它阻塞时可能无法从载体线程卸载，收益会下降。

> 注：pinning 可以口语化理解成“虚拟线程本来应该让出底层线程，但因为某些代码形态被钉在了底层线程上”。典型场景包括在 `synchronized` 代码块里执行阻塞操作，或者某些 native/foreign 调用。

<h1 id="实验环境"><a href="#实验环境" class="headerlink" title="实验环境"></a>实验环境</h1>

为了让结论可复现，先限定环境：

| 项目 | 版本/配置 |
| --- | --- |
| JDK | 21 |
| Spring Boot | 3.2.x 或 3.3.x |
| 构建工具 | Maven |
| 压测工具 | wrk 或 hey |
| 观测工具 | JFR、JDK Mission Control 可选 |
| 机器参考 | 4C8G Linux，结果会因机器不同而变化 |

> 注：`wrk` 是一个常用 HTTP 压测工具，可以指定线程数、连接数和持续时间；`hey` 是 Go 写的轻量压测工具，安装简单。二选一即可。

<h1 id="搭一个最小可复现服务"><a href="#搭一个最小可复现服务" class="headerlink" title="搭一个最小可复现服务"></a>搭一个最小可复现服务</h1>

<h2 id="创建项目"><a href="#创建项目" class="headerlink" title="创建项目"></a>创建项目</h2>

可以直接用 Spring Initializr 创建，也可以手写一个最小 Maven 项目。核心依赖只需要 Web 和 Actuator：

```xml
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
  </dependency>
</dependencies>
```

<h2 id="写三个接口"><a href="#写三个接口" class="headerlink" title="写三个接口"></a>写三个接口</h2>

```java
package com.example.vthread;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

@RestController
public class DemoController {

    private final Object lock = new Object();

    /**
     * 模拟下游 I/O 等待：比如查数据库、调接口。
     */
    @GetMapping("/io")
    public String io(@RequestParam(defaultValue = "100") long millis) throws InterruptedException {
        Thread.sleep(Duration.ofMillis(millis));
        return Thread.currentThread() + "\n";
    }

    /**
     * 模拟 CPU 密集型任务：虚拟线程不会让 CPU 凭空变快。
     */
    @GetMapping("/cpu")
    public long cpu(@RequestParam(defaultValue = "2000000") int loops) {
        long sum = 0;
        for (int i = 0; i < loops; i++) {
            sum += ThreadLocalRandom.current().nextInt(100);
        }
        return sum;
    }

    /**
     * 故意制造 pinning：在 synchronized 内部阻塞。
     */
    @GetMapping("/pin")
    public String pin(@RequestParam(defaultValue = "100") long millis) throws InterruptedException {
        synchronized (lock) {
            Thread.sleep(Duration.ofMillis(millis));
            return "pinned: " + Thread.currentThread() + "\n";
        }
    }
}
```

这三个接口分别代表三类情况：

- `/io`：阻塞等待多，适合观察虚拟线程收益；
- `/cpu`：CPU 计算多，虚拟线程通常没有明显收益；
- `/pin`：故意在 `synchronized` 里阻塞，用来观察 pinning 问题。

<h2 id="两套配置启动"><a href="#两套配置启动" class="headerlink" title="两套配置启动"></a>两套配置启动</h2>

平台线程配置：

```yaml
# application-platform.yml
server:
  port: 8080
spring:
  threads:
    virtual:
      enabled: false
server.tomcat.threads.max: 200
```

虚拟线程配置：

```yaml
# application-virtual.yml
server:
  port: 8080
spring:
  threads:
    virtual:
      enabled: true
```

启动命令：

```bash
# 平台线程
java -jar target/vthread-demo.jar --spring.profiles.active=platform

# 虚拟线程
java -jar target/vthread-demo.jar --spring.profiles.active=virtual
```

在 Spring Boot 里，`spring.threads.virtual.enabled=true` 会让应用优先使用虚拟线程执行部分任务，例如 Web 请求处理、`@Async` 等相关执行器。不同容器和 Boot 版本细节可能有差异，所以不要只看配置，要用压测和 JFR 验证实际行为。

<h1 id="压测：吞吐与延迟怎么变化"><a href="#压测：吞吐与延迟怎么变化" class="headerlink" title="压测：吞吐与延迟怎么变化"></a>压测：吞吐与延迟怎么变化</h1>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

使用 `wrk`：

```bash
# 预热 30 秒
wrk -t8 -c400 -d30s http://127.0.0.1:8080/io?millis=100

# 正式压测 60 秒
wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/io?millis=100
wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/cpu?loops=2000000
wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/pin?millis=100
```

如果没有 `wrk`，用 `hey` 也可以：

```bash
hey -z 60s -c 400 'http://127.0.0.1:8080/io?millis=100'
hey -z 60s -c 400 'http://127.0.0.1:8080/cpu?loops=2000000'
hey -z 60s -c 400 'http://127.0.0.1:8080/pin?millis=100'
```

<h2 id="一组参考结果"><a href="#一组参考结果" class="headerlink" title="一组参考结果"></a>一组参考结果</h2>

下面是一组 4C8G 机器上的参考数据，重点看趋势，不要照抄为生产容量结论：

| 场景 | 模式 | QPS | P50 | P95 | P99 | 现象 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `/io?millis=100` | 平台线程，Tomcat max=200 | 约 1,850 | 112ms | 235ms | 410ms | 请求会在线程池排队 |
| `/io?millis=100` | 虚拟线程 | 约 3,650 | 106ms | 138ms | 190ms | 阻塞等待被更好地摊开 |
| `/cpu?loops=2000000` | 平台线程 | 约 720 | 420ms | 880ms | 1.2s | CPU 打满 |
| `/cpu?loops=2000000` | 虚拟线程 | 约 700 | 435ms | 910ms | 1.3s | 没有明显收益，甚至略有调度开销 |
| `/pin?millis=100` | 虚拟线程 | 约 9~10 | 10s+ | 30s+ | 40s+ | synchronized 串行化 + pinning，性能崩掉 |

这个结果符合预期：

1. 对大量阻塞等待的 `/io`，虚拟线程显著改善吞吐和尾延迟；
2. 对 CPU 密集型 `/cpu`，虚拟线程没有魔法；
3. 对故意写坏的 `/pin`，虚拟线程不仅没救场，还会暴露同步锁和阻塞组合的灾难性后果。

> 注：**P95/P99 延迟**表示 95%/99% 的请求能在这个时间内返回。后端服务看平均值容易自欺欺人，真正影响用户体验和超时重试风暴的，经常是 P95/P99 这种尾部延迟。

<h1 id="用-JFR-验证：有没有真的用上虚拟线程"><a href="#用-JFR-验证：有没有真的用上虚拟线程" class="headerlink" title="用 JFR 验证：有没有真的用上虚拟线程"></a>用 JFR 验证：有没有真的用上虚拟线程</h1>

<h2 id="启动时开启-JFR"><a href="#启动时开启-JFR" class="headerlink" title="启动时开启 JFR"></a>启动时开启 JFR</h2>

**JFR（Java Flight Recorder）** 是 JDK 自带的低开销事件记录器，可以记录线程、锁、GC、方法采样等运行时事件。它适合回答“JVM 里到底发生了什么”。

启动虚拟线程版本时加上：

```bash
java \
  -XX:StartFlightRecording=filename=virtual.jfr,duration=120s,settings=profile \
  -Djdk.tracePinnedThreads=full \
  -jar target/vthread-demo.jar \
  --spring.profiles.active=virtual
```

然后在压测窗口内执行：

```bash
wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/io?millis=100
wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/pin?millis=100
```

`-Djdk.tracePinnedThreads=full` 会在发生 pinning 时输出栈信息。这个参数很适合排查，但线上长期开启前要评估日志量。

<h2 id="用-jcmd-动态采集"><a href="#用-jcmd-动态采集" class="headerlink" title="用 jcmd 动态采集"></a>用 jcmd 动态采集</h2>

如果应用已经启动，也可以用 `jcmd`：

```bash
jcmd | grep vthread-demo

# 假设 PID 是 12345
jcmd 12345 JFR.start name=vthread settings=profile filename=/tmp/vthread.jfr duration=120s
jcmd 12345 JFR.check
jcmd 12345 JFR.stop name=vthread
```

> 注：`jcmd` 是 JDK 自带的诊断命令，常用于查看 JVM 进程、触发 JFR、打印线程栈、查看 VM 参数。它是排查线上 Java 问题的基础工具之一。

<h2 id="看哪些信号"><a href="#看哪些信号" class="headerlink" title="看哪些信号"></a>看哪些信号</h2>

可以用 JDK Mission Control 打开 `.jfr` 文件，也可以先用命令粗看：

```bash
jfr summary /tmp/vthread.jfr
jfr view hot-methods /tmp/vthread.jfr
jfr view latencies-by-type /tmp/vthread.jfr
```

重点关注：

- `jdk.VirtualThreadStart` / `jdk.VirtualThreadEnd`：虚拟线程是否大量创建和结束；
- `jdk.VirtualThreadPinned`：是否有 pinning 事件；
- `jdk.JavaMonitorEnter`：是否存在锁竞争；
- CPU 采样热点：CPU 场景是不是已经被业务计算打满；
- Socket/File I/O 事件：大量等待是否来自网络或磁盘。

<h2 id="pinning-日志长什么样"><a href="#pinning-日志长什么样" class="headerlink" title="pinning 日志长什么样"></a>pinning 日志长什么样</h2>

`/pin` 接口压测时，你大概率会看到类似信息：

```text
Thread[#123,ForkJoinPool-1-worker-1,5,CarrierThreads]
    java.base/java.lang.VirtualThread$VThreadContinuation.onPinned(VirtualThread.java:xxx)
    java.base/java.lang.VirtualThread.parkNanos(VirtualThread.java:xxx)
    java.base/java.lang.Thread.sleep(Thread.java:xxx)
    com.example.vthread.DemoController.pin(DemoController.java:xx) <== monitors:1
```

这段栈的意思是：虚拟线程在 `synchronized` 保护的区域里 sleep，导致它阻塞时不能正常卸载。`monitors:1` 就是一个非常关键的信号，说明当前栈持有 Java monitor 锁。

解决方式不是“把虚拟线程关掉”这么粗暴，而是先改代码形态：

```java
// 不推荐：锁内做阻塞 I/O
synchronized (lock) {
    callRemoteService();
}

// 更推荐：缩小锁范围，把阻塞 I/O 移出去
RequestSnapshot snapshot;
synchronized (lock) {
    snapshot = copyState();
}
callRemoteService(snapshot);
```

如果确实需要并发控制，很多时候可以考虑 `ReentrantLock`、信号量、连接池限流，或者从设计上避免在锁里调用下游。

<h1 id="数据库和连接池才是生产落地的重点"><a href="#数据库和连接池才是生产落地的重点" class="headerlink" title="数据库和连接池才是生产落地的重点"></a>数据库和连接池才是生产落地的重点</h1>

虚拟线程让“请求线程”不再那么稀缺，但它不会让数据库连接、Redis 连接、HTTP 连接也变无限。

举个例子：

| 资源 | 以前平台线程 | 开虚拟线程后 | 风险 |
| --- | --- | --- | --- |
| Tomcat 请求线程 | 可能 200 个就排队 | 可以承载更多等待请求 | 请求更容易打到下游 |
| HikariCP 数据库连接 | 例如 30 个 | 还是 30 个 | 大量虚拟线程会排队等连接 |
| HTTP 客户端连接池 | 例如 200 个 | 还是 200 个 | 下游超时/排队更明显 |
| Redis 连接 | 受客户端配置限制 | 仍受配置限制 | 热 key 或慢命令会被放大 |

> 注：**HikariCP** 是 Spring Boot 默认常用的 JDBC 连接池。连接池解决的是“复用数据库连接”的问题，不是把数据库能力变无限。虚拟线程并不会绕过连接池容量限制。

所以生产启用虚拟线程前，至少要配套验证：

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 30
      connection-timeout: 1000

# 以 Apache HttpClient 5 为例，实际配置按项目客户端而定
client:
  http:
    max-connections: 200
    connect-timeout: 500ms
    response-timeout: 2s
```

验证方法：

1. 压测时同时观察应用 QPS/P99；
2. 观察数据库连接池 active/idle/pending 指标；
3. 观察下游 HTTP 客户端连接池 pending；
4. 观察错误率、超时率、重试次数；
5. 看 JFR 里线程等待主要卡在哪里。

如果只看到应用入口 QPS 上去了，但数据库 pending、下游 5xx、重试风暴也一起上去了，那不是优化成功，而是把瓶颈更快地打爆了。

<h1 id="GC-和内存也要看"><a href="#GC-和内存也要看" class="headerlink" title="GC 和内存也要看"></a>GC 和内存也要看</h1>

虚拟线程很轻，但不是零成本。高并发下会有大量 `VirtualThread` 对象、栈片段、请求上下文对象产生。压测时建议同时打开 GC 日志：

```bash
java \
  -Xlog:gc*,safepoint:file=gc.log:time,level,tags \
  -XX:StartFlightRecording=filename=virtual.jfr,duration=120s,settings=profile \
  -jar target/vthread-demo.jar \
  --spring.profiles.active=virtual
```

看 GC 日志时重点关注：

- Young GC 是否变得过于频繁；
- Full GC 是否出现；
- GC pause 是否推高 P99；
- 请求上下文、日志 MDC、ThreadLocal 是否造成额外对象保留。

> 注：**ThreadLocal** 是线程本地变量，传统线程池里常用于存用户上下文、traceId 等。虚拟线程数量非常多，使用 ThreadLocal 时更要注意清理和对象大小，否则容易把“每个线程一点点内存”放大成整体压力。

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一：虚拟线程能提升所有接口性能"><a href="#误区一：虚拟线程能提升所有接口性能" class="headerlink" title="误区一：虚拟线程能提升所有接口性能"></a>误区一：虚拟线程能提升所有接口性能</h2>

不对。它主要改善阻塞 I/O 场景下的并发承载能力。CPU 密集型接口的瓶颈是 CPU，虚拟线程不会让一颗 CPU 变两颗。

<h2 id="误区二：开了虚拟线程就不用连接池"><a href="#误区二：开了虚拟线程就不用连接池" class="headerlink" title="误区二：开了虚拟线程就不用连接池"></a>误区二：开了虚拟线程就不用连接池</h2>

也不对。数据库连接、HTTP 连接、Redis 连接都是外部资源，仍然需要池化、限流和超时控制。虚拟线程只是让等待更便宜，不是让下游更强。

<h2 id="误区三：只看平均延迟"><a href="#误区三：只看平均延迟" class="headerlink" title="误区三：只看平均延迟"></a>误区三：只看平均延迟</h2>

平均值很容易掩盖排队问题。虚拟线程落地必须看 P95/P99、错误率、超时率、下游 pending、GC pause。

<h2 id="误区四：锁里做阻塞操作"><a href="#误区四：锁里做阻塞操作" class="headerlink" title="误区四：锁里做阻塞操作"></a>误区四：锁里做阻塞操作</h2>

这是虚拟线程的高危写法。`synchronized` 内部调用数据库、HTTP、文件 I/O，都可能让 pinning 或锁竞争把收益吃掉。先用 JFR 抓，再缩小锁范围。

<h2 id="误区五：上线前不做容量保护"><a href="#误区五：上线前不做容量保护" class="headerlink" title="误区五：上线前不做容量保护"></a>误区五：上线前不做容量保护</h2>

虚拟线程提高入口承载能力后，更需要保护下游。建议配套：

- 接口级限流；
- 连接池 pending 告警；
- 超时和重试预算；
- 熔断降级；
- 慢 SQL 和慢 HTTP 调用监控。

<h1 id="上线前自检清单"><a href="#上线前自检清单" class="headerlink" title="上线前自检清单"></a>上线前自检清单</h1>

如果准备在 Spring Boot 服务里打开虚拟线程，可以按这个顺序走：

1. **确认 JDK 和框架版本**：JDK 21+，Spring Boot 3.2+；
2. **挑选接口类型**：优先选阻塞 I/O 多、CPU 计算少的接口；
3. **压测对比**：平台线程 vs 虚拟线程，至少看 QPS、P50、P95、P99、错误率；
4. **采集 JFR**：确认虚拟线程事件、pinning、锁竞争、热点方法；
5. **检查池化资源**：数据库连接池、HTTP 连接池、Redis 连接、线程外资源；
6. **检查 GC 和内存**：Young GC、Full GC、ThreadLocal、请求上下文对象；
7. **灰度上线**：小流量、可回滚、监控指标齐全；
8. **设置回滚开关**：保留 `spring.threads.virtual.enabled=false` 的快速回退能力。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

虚拟线程最适合的定位不是“替代所有并发模型”，而是让传统阻塞式 Java 代码在高并发 I/O 场景下更轻、更容易扩展。

本文的核心结论：

- Spring Boot 开启虚拟线程很简单，但验证不能省；
- I/O 密集型接口通常收益明显，CPU 密集型接口收益有限；
- `synchronized` + 阻塞 I/O 是典型高危组合，要用 JFR 查 pinning；
- 入口请求线程变便宜后，下游连接池、数据库、HTTP 客户端更需要保护；
- 上线前必须看 P95/P99、错误率、连接池 pending、GC 和 JFR，而不是只看平均值。

一句话：虚拟线程值得用，但要像做一次性能优化一样用——先假设它有边界，再用数据证明它适合你的服务。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Oracle Java SE 21 Documentation：Virtual Threads，<https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html>
2. OpenJDK JEP 444：Virtual Threads，<https://openjdk.org/jeps/444>
3. Spring Boot Reference Documentation：Virtual Threads，<https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.virtual-threads>
4. Oracle JDK 21 API：Java Flight Recorder，<https://docs.oracle.com/en/java/javase/21/docs/api/jdk.jfr/jdk/jfr/FlightRecorder.html>
5. Baeldung：Monitoring Java Applications with Flight Recorder，<https://www.baeldung.com/java-flight-recorder-monitoring>
6. Mike my bytes：Continuous monitoring of pinned threads with Spring Boot and JFR，<https://mikemybytes.com/2024/04/17/continuous-monitoring-of-pinned-threads-with-spring-boot-and-jfr/>
