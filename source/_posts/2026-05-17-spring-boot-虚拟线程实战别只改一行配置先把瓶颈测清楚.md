---
title: Spring Boot 虚拟线程实战：别只改一行配置，先把瓶颈测清楚
date: 2026-05-17 10:02:06
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java21
  - Spring Boot
  - 虚拟线程
  - JFR
  - 性能压测
---

<hr>
<blockquote>
<p>Java 21 的<strong>虚拟线程</strong>让“一请求一线程”重新变得很香，但它不是性能银弹。本文用一个 Spring Boot 小实验，把平台线程和虚拟线程在阻塞 I/O 场景下的吞吐、P95/P99 延迟、JFR 观察方法和常见坑一次讲清楚。</p>
</blockquote>

<!-- more -->

## 1. 为什么要聊虚拟线程

很多 Java Web 服务的慢，不是 CPU 算不动，而是线程卡在了等待上：等数据库、等 Redis、等下游 HTTP、等文件 I/O。传统 Spring MVC + Tomcat 模型里，一个请求通常会占住一个<strong>平台线程</strong>。平台线程可以简单理解为“Java 线程和操作系统线程基本一一绑定”的线程，创建和上下文切换成本都不低，所以 Tomcat 常见默认最大工作线程数是 200 左右。

当 200 个线程都在等下游返回时，第 201 个请求就只能排队。CPU 明明很闲，接口却开始超时，这就是典型的阻塞 I/O 型服务瓶颈。

<strong>虚拟线程</strong>（Virtual Thread）是 Java 21 正式可用的一种轻量级线程。它解决的问题不是“让 CPU 计算更快”，而是“当线程阻塞等待 I/O 时，不要一直霸占昂贵的操作系统线程”。一句大白话：以前等外卖的人把整个柜台占着，现在等外卖的人拿号坐旁边，柜台可以继续服务下一个人。

这篇文章不打算只说“加一行配置”：

```properties
spring.threads.virtual.enabled=true
```

我们会用一个可复现实验回答 4 个问题：

1. 什么场景下虚拟线程收益明显？
2. 怎么用 wrk 看吞吐和 P95/P99 延迟？
3. 怎么用 JFR 看线程阻塞和虚拟线程事件？
4. 哪些坑会让虚拟线程看起来“没效果”甚至更糟？

> 注：本文默认读者熟悉 Spring Boot 基本项目结构，知道 HTTP 接口、线程池、压测这几个概念；不要求提前用过 JFR。

## 2. 先把概念摆正：虚拟线程不是“更快的 CPU”

先区分几个词。

- <strong>平台线程</strong>：传统 Java 线程，通常由操作系统线程承载，数量不能无限开。线程多了会带来内存占用、调度和上下文切换成本。
- <strong>虚拟线程</strong>：JVM 管理的轻量线程，数量可以非常多，适合大量阻塞等待场景。
- <strong>载体线程</strong>（Carrier Thread）：真正执行虚拟线程代码的平台线程。虚拟线程阻塞时，JVM 通常会把它从载体线程上卸载，让载体线程去执行别的虚拟线程。
- <strong>JFR</strong>（Java Flight Recorder）：JDK 自带的低开销运行时记录器，可以记录线程、锁、GC、方法采样等事件，适合线上或准线上诊断。
- <strong>P95/P99 延迟</strong>：把所有请求耗时从小到大排序，95%/99% 位置的请求耗时。平均值容易掩盖长尾，P95/P99 更能说明用户体感。

虚拟线程最适合的是<strong>阻塞 I/O 密集</strong>场景：

| 场景 | 是否适合虚拟线程 | 原因 |
| --- | --- | --- |
| 等 HTTP 下游 50~200ms | 适合 | 等待期间可释放载体线程 |
| JDBC 查询较多且连接池充足 | 适合，但要控连接池 | 请求线程不再是第一瓶颈，DB 可能变成瓶颈 |
| CPU 密集计算、加解密、图片处理 | 不适合期待明显收益 | CPU 就那么多核，虚拟线程不会让计算变快 |
| 大量 `synchronized` 临界区 | 谨慎 | 可能出现 pinning，虚拟线程被钉在载体线程上 |
| Reactor/WebFlux 已经全链路非阻塞 | 收益不一定明显 | 原本就不靠大量阻塞线程撑并发 |

一句话：虚拟线程是“降低阻塞等待的线程成本”，不是“提高单次业务逻辑速度”。

## 3. 实验环境和项目准备

为了减少变量，我们做一个最小 Spring Boot 服务：接口只 sleep 100ms 模拟下游阻塞 I/O。`Thread.sleep` 在这里不是为了模拟 CPU 计算，而是模拟“线程等下游结果”的状态。

推荐环境：

| 项目 | 版本 |
| --- | --- |
| JDK | 21+ |
| Spring Boot | 3.2+ |
| 构建工具 | Maven 3.9+ |
| 压测工具 | wrk 或 hey |
| 诊断工具 | JFR / jcmd，JDK 自带 |

### 3.1 创建项目

可以用 Spring Initializr 创建，也可以直接准备下面的关键文件。

`pom.xml`：

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>demo</groupId>
  <artifactId>virtual-thread-demo</artifactId>
  <version>0.0.1-SNAPSHOT</version>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
    <relativePath/>
  </parent>

  <properties>
    <java.version>21</java.version>
  </properties>

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
</project>
```

启动类：

```java
package demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class VirtualThreadDemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(VirtualThreadDemoApplication.class, args);
    }
}
```

测试接口：

```java
package demo;

import java.time.Duration;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DemoController {

    @GetMapping("/io")
    public Map<String, Object> io() throws InterruptedException {
        // 模拟一次阻塞式下游调用，比如 JDBC/HTTP/Redis 等。
        Thread.sleep(Duration.ofMillis(100));
        Thread t = Thread.currentThread();
        return Map.of(
                "thread", t.toString(),
                "virtual", t.isVirtual()
        );
    }

    @GetMapping("/cpu")
    public Map<String, Object> cpu() {
        long sum = 0;
        for (int i = 0; i < 50_000_000; i++) {
            sum += i;
        }
        Thread t = Thread.currentThread();
        return Map.of(
                "sum", sum,
                "thread", t.toString(),
                "virtual", t.isVirtual()
        );
    }
}
```

### 3.2 两套配置

`application-platform.properties`：

```properties
server.port=8080
server.tomcat.threads.max=200
management.endpoints.web.exposure.include=health,metrics
```

`application-virtual.properties`：

```properties
server.port=8080
spring.threads.virtual.enabled=true
management.endpoints.web.exposure.include=health,metrics
```

Spring Boot 3.2+ 在 JDK 21 下开启 `spring.threads.virtual.enabled=true` 后，会让部分自动配置的执行器使用虚拟线程；对于 Web 场景，嵌入式 Tomcat 处理请求时也会走支持虚拟线程的执行模型。验证方式很简单：请求 `/io`，看返回里的 `virtual` 是否为 `true`。

## 4. 压测：平台线程 vs 虚拟线程

先打包：

```bash
mvn -DskipTests package
```

启动平台线程版本：

```bash
java -jar target/virtual-thread-demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=platform
```

压测：

```bash
wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/io
```

再启动虚拟线程版本：

```bash
java -jar target/virtual-thread-demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=virtual
```

同样压测：

```bash
wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/io
```

如果没有 wrk，可以用 hey：

```bash
hey -z 60s -c 400 http://127.0.0.1:8080/io
```

### 4.1 一组参考结果

下面是一组 8C16G 开发机上的示例结果。它不是“官方性能数据”，只是为了说明趋势；你的机器、JDK 小版本、容器限制、后台负载都会影响数字。

| 模式 | 并发 | Tomcat 工作线程上限 | QPS | P50 | P95 | P99 | CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 平台线程 | 400 | 200 | 1,880/s | 204ms | 231ms | 285ms | 18% |
| 虚拟线程 | 400 | 不再按 200 平台线程卡死 | 3,720/s | 108ms | 129ms | 168ms | 26% |

为什么 `/io` 场景差异明显？因为每个请求固定等待 100ms。平台线程版本最多约 200 个请求同时等待，剩下的请求排队；虚拟线程版本可以让更多请求同时处在等待状态，载体线程不用被这些等待“占死”。

再压 `/cpu`：

```bash
wrk -t8 -c100 -d60s --latency http://127.0.0.1:8080/cpu
```

示例趋势通常会变成这样：

| 模式 | QPS | P95 | 结论 |
| --- | ---: | ---: | --- |
| 平台线程 | 受 CPU 核数限制 | 接近 | CPU 忙，线程模型不是主瓶颈 |
| 虚拟线程 | 受 CPU 核数限制 | 接近或略差 | 虚拟线程不能凭空增加 CPU |

这一步很关键：如果你的接口主要消耗 CPU，开虚拟线程不会神奇提升吞吐。甚至因为调度和对象数量变化，个别情况下会略差。

## 5. 用 JFR 验证：不要只看 QPS

只看压测结果容易误判。建议同时抓一份 JFR，看线程状态、阻塞、锁和虚拟线程事件。

### 5.1 启动时直接开启 JFR

```bash
java \
  -XX:StartFlightRecording=filename=vt.jfr,duration=70s,settings=profile \
  -jar target/virtual-thread-demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=virtual
```

然后执行 60 秒压测。结束后会得到 `vt.jfr`。

### 5.2 运行中用 jcmd 开启 JFR

先找 PID：

```bash
jcmd | grep virtual-thread-demo
```

启动记录：

```bash
jcmd <PID> JFR.start name=vt settings=profile duration=70s filename=vt.jfr
```

查看虚拟线程相关事件，可以用 JDK Mission Control 打开 `vt.jfr`，重点看这些方向：

- <strong>Java Thread Statistics</strong>：线程数量是否暴涨，载体线程是否稳定。
- <strong>Socket Read/Write、File Read/Write</strong>：是否真的卡在 I/O。
- <strong>Monitor Blocked</strong>：是否有大量锁竞争。
- <strong>VirtualThreadPinned</strong>：虚拟线程是否被 pin 住。

<strong>Pinning</strong> 是虚拟线程里很重要的坑。它的意思是：虚拟线程本来应该在阻塞时从载体线程上卸载，但某些情况下卸不下来，只能继续占着载体线程。常见诱因包括在 `synchronized` 代码块里做阻塞 I/O，或者调用某些还没有很好适配虚拟线程的 native/底层阻塞操作。

可以额外加一个参数把 pinning 打到控制台：

```bash
java -Djdk.tracePinnedThreads=full \
  -jar target/virtual-thread-demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=virtual
```

如果压测期间控制台出现大量 pinned stack trace，就别急着庆祝 QPS，先把栈里的同步块和阻塞调用拆开。

## 6. 更像真实业务：加一个“下游容量”限制

上面的 `/io` 只是模拟等待，它没有数据库连接池、HTTP 连接池这样的真实限制。生产里开虚拟线程后，常见变化是：请求线程不再是瓶颈，真正的下游瓶颈暴露出来了。

比如 JDBC 连接池只有 30 个连接，即使你能创建 5000 个虚拟线程，也最多只有 30 个请求在真正查库，其他请求会卡在等连接。

可以用 `Semaphore` 模拟下游容量：

```java
package demo;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.Semaphore;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class LimitedDownstreamController {
    private final Semaphore pool = new Semaphore(30);

    @GetMapping("/db-like")
    public Map<String, Object> dbLike() throws InterruptedException {
        long begin = System.nanoTime();
        pool.acquire();
        try {
            Thread.sleep(Duration.ofMillis(80));
            return Map.of(
                    "waitMs", (System.nanoTime() - begin) / 1_000_000,
                    "virtual", Thread.currentThread().isVirtual()
            );
        } finally {
            pool.release();
        }
    }
}
```

压测：

```bash
wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/db-like
```

理论上限大约是：

```text
30 个并发下游槽位 / 0.08 秒 ≈ 375 QPS
```

这时虚拟线程不会突破下游容量。它能改善的是“等待线程的成本”，不是“数据库连接池、Redis、第三方接口的真实吞吐”。

这也是生产改造里最容易踩的坑：以前 Tomcat 200 线程顺手帮你限流；开启虚拟线程后，请求能更快涌到下游，数据库或外部 API 可能先被打爆。所以虚拟线程上线时，必须配套限流、连接池、超时和舱壁隔离。

## 7. 生产落地建议

### 7.1 先选阻塞 I/O 明显的接口试点

优先挑这些接口：

- 下游 HTTP 调用多；
- JDBC 查询等待时间长，但 SQL 本身不算重；
- 线程池经常打满，但 CPU 利用率不高；
- P95/P99 主要来自排队等待。

不要一上来全站开启，然后只看平均响应时间。建议按接口或服务灰度，对比这些指标：

| 指标 | 为什么看 |
| --- | --- |
| QPS / 吞吐 | 判断承载能力是否提升 |
| P95/P99 延迟 | 判断长尾是否改善或恶化 |
| CPU 使用率 | 防止从线程瓶颈转成 CPU 瓶颈 |
| 下游连接池等待时间 | 判断 DB/HTTP 连接池是否变成瓶颈 |
| 错误率/超时率 | 判断是否把下游打穿 |
| JFR pinned 事件 | 判断是否有虚拟线程 pinning |

### 7.2 超时和限流要重新校准

虚拟线程让并发等待变便宜，但不代表下游更强。建议至少检查：

```properties
# HTTP 客户端连接池、连接超时、读取超时
# JDBC/Hikari 最大连接数、connectionTimeout
# Resilience4j bulkhead / rateLimiter / timeLimiter
# Tomcat accept-count、max-connections
```

<strong>Bulkhead</strong>（舱壁隔离）可以理解为“给不同下游或不同业务池子单独限额”，避免一个慢下游拖死全站。虚拟线程时代尤其需要它，因为入口线程不再天然限制请求涌入速度。

### 7.3 谨慎处理 synchronized + 阻塞 I/O

不要在 `synchronized` 里做网络调用、数据库调用或长时间 sleep：

```java
public synchronized String bad() {
    // 这里如果是阻塞 I/O，虚拟线程可能被 pin 住
    return remoteClient.call();
}
```

更好的方式是缩小同步范围，只保护内存状态：

```java
public String better() {
    String snapshot;
    synchronized (this) {
        snapshot = this.state;
    }
    return remoteClient.call(snapshot);
}
```

如果确实需要锁，优先评估 `ReentrantLock`、无锁结构或把阻塞调用移出临界区。最终以 JFR 和 `-Djdk.tracePinnedThreads=full` 的结果为准。

### 7.4 不要把线程池治理全删掉

虚拟线程不是让你彻底告别并发治理。以前线程池有两个作用：

1. 执行任务；
2. 顺手限制并发。

虚拟线程让第一个作用变轻了，但第二个作用仍然需要。只是限流位置要从“入口工作线程数”迁移到更明确的业务边界，比如：

- 每个下游服务的并发上限；
- 每类任务的队列长度；
- 每个租户/用户的请求速率；
- 每条慢路径的超时时间。

## 8. 常见坑和误区

### 8.1 “开了虚拟线程，QPS 一定上涨”

不一定。只有阻塞等待占主要时间时才明显。如果 CPU 已经 90% 以上，虚拟线程没有魔法。

### 8.2 “虚拟线程越多越好”

虚拟线程很轻，但不是零成本。每个请求对象、栈帧、上下文、日志 MDC、链路追踪上下文都要占内存。并发越高，下游排队和超时风暴也越容易出现。

### 8.3 “以前的连接池配置不用改”

往往要改，但不是盲目调大。比如 HikariCP 从 30 调到 300，数据库不一定扛得住。正确做法是看连接等待时间、DB CPU、慢 SQL、锁等待，再决定是扩连接、优化 SQL，还是加限流。

### 8.4 “WebFlux 可以全部换回 MVC + 虚拟线程”

别这么粗暴。WebFlux 是完整的非阻塞编程模型，适合高并发 I/O 和流式处理；MVC + 虚拟线程是让阻塞式代码更便宜。两者不是谁淘汰谁，而是团队复杂度、生态、调用链形态不同。

### 8.5 “只在本地 sleep 压测就能代表生产”

`sleep` 只能说明线程等待成本，不能代表真实数据库、缓存、网关、序列化、TLS、日志、链路追踪。上线前至少要在预发环境用真实调用链做一轮压测和 JFR。

## 9. 一套上线前检查清单

建议按这个顺序做：

1. 确认 JDK 21+、Spring Boot 3.2+；
2. 开启 `spring.threads.virtual.enabled=true`；
3. 用 `/actuator/metrics` 或接口返回确认请求线程是虚拟线程；
4. 对阻塞 I/O 接口压测，记录 QPS、P50、P95、P99、错误率；
5. 同时抓 JFR，检查锁竞争和 `VirtualThreadPinned`；
6. 检查 DB/Redis/HTTP 连接池等待时间；
7. 为关键下游配置超时、限流、舱壁隔离；
8. 灰度小流量上线，对比真实流量下的长尾延迟和错误率；
9. 有异常随时回滚配置，而不是继续硬扛。

## 10. 总结

虚拟线程值得 Java 后端认真用，但要用在正确地方。

- 它适合阻塞 I/O 密集服务，尤其是“CPU 不高但线程池经常满”的 Spring MVC 应用。
- 它不能提升 CPU 密集任务性能，也不能突破数据库、Redis、第三方 API 的真实容量。
- `spring.threads.virtual.enabled=true` 只是起点，压测、JFR、连接池、限流和灰度才是落地关键。
- 生产里最危险的不是“虚拟线程没提升”，而是“入口更能接了，下游先被打穿”。

我的建议是：先挑一个下游等待明显、业务风险可控的接口试点，用本文这套压测 + JFR 方法拿到数据，再决定是否扩大范围。别迷信一行配置，也别因为它简单就低估它对系统压力模型的改变。

## 参考资料

1. Oracle Java Documentation：Virtual Threads，https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html
2. JEP 444: Virtual Threads，https://openjdk.org/jeps/444
3. Spring Boot Reference Documentation：Virtual Threads，https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.virtual-threads
4. Spring Framework Documentation：Threading and Virtual Threads，https://docs.spring.io/spring-framework/reference/integration/scheduling.html
5. Apache Tomcat Documentation：VirtualThreadExecutor，https://tomcat.apache.org/tomcat-10.1-doc/api/org/apache/catalina/core/StandardVirtualThreadExecutor.html
6. Oracle JDK Mission Control / JFR 文档，https://docs.oracle.com/javacomponents/jmc-8-3/jmc-user-guide/toc.htm
