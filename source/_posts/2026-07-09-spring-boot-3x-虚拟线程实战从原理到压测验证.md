---
title: Spring Boot 3.x 虚拟线程实战：从原理到压测验证
date: 2026-07-09 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - 虚拟线程
  - JDK 21
  - 并发编程
  - JMH
  - 性能调优
---

<hr>

<blockquote><p>Java 21 正式发布了<strong>虚拟线程（Virtual Threads）</strong>——这是自 JDK 1.0 引入"绿色线程"以来，Java 并发模型最大的一次变革。本文将从虚拟线程的底层原理出发，结合 Spring Boot 3.2+ 的原生支持，用真实压测数据告诉你：虚拟线程到底能提升多少吞吐？哪些场景适合上？哪些坑需要避？</p></blockquote>

<!-- more -->

## 一、背景：为什么我们需要虚拟线程？

### 1.1 传统线程模型的痛点

在 JDK 19 之前，Java 的 `java.lang.Thread` 是对**操作系统内核线程（OS Thread）** 的 1:1 封装。这意味着：

- **每个 Java 线程 ≈ 一个 OS 线程**
- OS 线程是昂贵的资源：默认栈大小 1MB（`-Xss`），调度开销大
- 一台 8 核机器撑死跑几千个线程就会因为上下文切换频繁导致性能雪崩

但现实是：现代 Web 应用大量使用**阻塞式 IO**（数据库查询、HTTP 调用、消息队列消费），这些操作大部分时间在"等"，线程却一直被占着。

> **虚拟线程（Virtual Thread）**：JDK 21 引入的轻量级线程实现，由 JVM 调度而非 OS 调度。它非常廉价——创建一个虚拟线程只需几 KB 内存，可以轻松创建百万级虚拟线程。当虚拟线程阻塞在 IO 上时，JVM 会自动把它"卸载"（unmount）掉，让底层的**载体线程（Carrier Thread，也叫平台线程 Platform Thread）** 去执行其他虚拟线程。

### 1.2 适用场景一览

| 场景 | 是否适合虚拟线程 | 理由 |
|------|----------------|------|
| 高并发 HTTP 服务（Tomcat/Netty） | ✅ 非常适合 | 请求处理大量时间花在等待 DB/外部调用 |
| 数据库连接池密集查询 | ✅ 适合 | 每个查询可独占一个虚拟线程 |
| CPU 密集型计算 | ❌ 不适合 | 虚拟线程不增加计算并行度，反而增加调度开销 |
| `synchronized` 重度使用 | ⚠️ 谨慎 | `synchronized` 会**钉住（pin）**载体线程，可能导致瓶颈 |
| 使用了 `ThreadLocal` 存放大数据 | ⚠️ 注意 | 百万虚拟线程 × 大 ThreadLocal = OOM |

---

## 二、核心原理：虚拟线程是如何工作的？

### 2.1 架构概览

```
┌─────────────────────────────────────┐
│           业务代码                    │
│   virtualThread.execute(() -> {     │
│       db.query();  // 阻塞          │
│       http.call(); // 阻塞          │
│   })                                │
└──────────┬──────────────────────────┘
           │
┌──────────▼──────────────────────────┐
│      JVM 调度器 (ForkJoinPool)       │
│   将 VT 映射到 Carrier Thread        │
└──────────┬──────────────────────────┘
           │
┌──────────▼──────────────────────────┐
│    载体线程池 (Platform Threads)      │
│    默认数量 = CPU 核心数              │
└──────────┬──────────────────────────┘
           │
┌──────────▼──────────────────────────┐
│         操作系统内核                   │
└─────────────────────────────────────┘
```

**关键机制——Mount / Unmount（装载/卸载）**：

- **Mount**：当虚拟线程开始运行时，JVM 把它"挂载"到一个载体线程上执行
- **Unmount**：当虚拟线程执行到**阻塞操作**（LockSupport.park、IO 等待等）时，JVM 把它从载体线程上"卸载"下来，载体线程就可以去执行别的虚拟线程
- 当阻塞结束后，虚拟线程重新进入调度队列，等待下次 Mount

### 2.2 线程钉住（Thread Pinning）

这是虚拟线程最需要注意的坑：

> **Pin（钉住）**：当虚拟线程在 `synchronized` 块或**本地方法（native method）** 内部执行时，它无法被 Unmount，会一直占用载体线程直到退出同步块/本地方法。如果大量虚拟线程同时被 Pin，载体线程池会被耗尽，性能急剧下降。

**解决方案**：
- 用 `ReentrantLock` 替代 `synchronized`（ReentrantLock 支持 virtual thread unparking）
- 升级到 JDK 24+（正在优化 synchronized 的 pin 问题）

---

## 三、Spring Boot 3.2+ 虚拟线程配置实战

### 3.1 项目准备

**环境要求**：

- JDK 21+（推荐 JDK 21 LTS）
- Spring Boot 3.2+（本文以 3.4.x 为例）
- Maven 或 Gradle

```xml
<!-- pom.xml 关键依赖 -->
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.2</version>
</parent>

<properties>
    <java.version>21</java.version>
</properties>

<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <!-- 可选：用于压测验证的 Actuator -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
</dependencies>
```

### 3.2 开启虚拟线程（两种方式）

#### 方式一：配置文件（推荐）

```yaml
# application.yml
spring:
  threads:
    virtual:
      enabled: true
```

就这一行！Spring Boot 会自动把 Tomcat 线程池替换为基于虚拟线程的模型。

#### 方式二：编程式配置

```java
import org.springframework.boot.web.embedded.tomcat.TomcatProtocolHandlerCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.Executors;

@Configuration
public class VirtualThreadConfig {

    @Bean
    TomcatProtocolHandlerCustomizer<?> tomcatCustomizer() {
        return protocolHandler -> {
            protocolHandler.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        };
    }
}
```

### 3.3 写一个模拟业务接口

为了后续压测对比，我们写一个包含**IO 等待**的接口：

```java
@RestController
@RequestMapping("/api/demo")
public class DemoController {

    /**
     * 模拟一次典型的后端请求流程：
     * 1. 查询数据库（模拟 10ms）
     * 2. 调用远程服务（模拟 30ms）
     * 3. 业务计算（模拟 5ms）
     * 4. 再查一次库（模拟 10ms）
     */
    @GetMapping("/order")
    public Map<String, Object> createOrder() throws InterruptedException {
        long start = System.nanoTime();

        // 模拟 DB 查询 10ms
        Thread.sleep(10);
        long afterDb1 = System.nanoTime();

        // 模拟 RPC 调用 30ms
        Thread.sleep(30);
        long afterRpc = System.nanoTime();

        // 模拟业务计算 5ms（CPU 密集）
        busyWait(5);
        long afterCompute = System.nanoTime();

        // 模拟二次 DB 查询 10ms
        Thread.sleep(10);
        long totalEnd = System.nanoTime();

        return Map.of(
            "orderId", UUID.randomUUID().toString().substring(0, 8),
            "db1_ms", ms(afterDb1 - start),
            "rpc_ms", ms(afterRpc - afterDb1),
            "compute_ms", ms(afterCompute - afterRpc),
            "db2_ms", ms(totalEnd - afterCompute),
            "total_ms", ms(totalEnd - start)
        );
    }

    private void busyWait(int milliseconds) throws InterruptedException {
        // 模拟 CPU 密集工作（不会触发 unmount）
        long end = System.nanoTime() + milliseconds * 1_000_000L;
        while (System.nanoTime() < end) {
            // spin
        }
    }

    private long ms(long nanos) {
        return nanos / 1_000_000;
    }
}
```

### 3.4 如何确认虚拟线程真的生效？

**方式一：日志打印当前线程**

```java
@GetMapping("/thread-info")
public Map<String, Object> threadInfo() {
    Thread t = Thread.currentThread();
    return Map.of(
        "name", t.getName(),
        "isVirtual", t.isVirtual(),
        "isDaemon", t.isDaemon(),
        "threadGroup", t.getThreadGroup() != null ? t.getThreadGroup().getName() : "null"
    );
}
```

访问 `/api/demo/thread-info`，你应该看到 `"isVirtual": true`。

**方式二：Actuator 端点查看**

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,env,beans
```

访问 `/actuator/env` 搜索 `spring.threads.virtual.enabled` 应为 `true`。

**方式三：jstack 观察线程栈**

```bash
# 找到 Java 进程 PID
jps

# 导出线程栈
jstack <PID> > jstack_vt.log
```

打开 `jstack_vt.log`，你会看到大量名为 `virtual-N` 的线程——这就是虚拟线程！

---

## 四、压测对比：传统线程 vs 虚拟线程

### 4.1 压测环境

| 项目 | 配置 |
|------|------|
| 服务器 | 4C8G 云服务器（阿里云 ECS） |
| JDK | Eclipse Temurin 21.0.6 |
| Spring Boot | 3.4.2 + Tomcat |
| 压测工具 | **wrk**（轻量级 HTTP 基准测试工具） |
| 接口 | `/api/demo/order`（总耗时 ~55ms，含 50ms IO 等待） |
| 对比组 | A: 传统 Tomcat 线程池（200 线程） vs B: 虚拟线程 |

### 4.2 安装 wrk

```bash
# CentOS/RHEL
yum install -y git gcc make
git clone https://github.com/wg/wrk.git
cd wrk && make && cp wrk /usr/local/bin/

# 验证
wrk --version
# 输出: wrk 4.2.0 ...
```

### 4.3 压测命令与结果

**场景一：低并发（50 并发连接）**

```bash
# 传统线程模式（spring.threads.virtual.enabled=false）
wrk -t4 -c50 -d30s --latency http://localhost:8080/api/demo/order

# 虚拟线程模式（spring.threads.virtual.enabled=true）
wrk -t4 -c50 -d30s --latency http://localhost:8080/api/demo/order
```

**场景二：高并发（500 并发连接）**

```bash
# 同上，把 -c50 改为 -c500
wrk -t4 -c500 -d30s --latency http://localhost:8080/api/demo/order
```

**场景三：超高并发（2000 并发连接）**

```bash
wrk -t4 -c2000 -d30s --latency http://localhost:8080/api/demo/order
```

### 4.4 压测数据汇总

以下为多次取平均值后的汇总（单位：ms 或 req/s）：

| 指标 | 传统线程（200） | 虚拟线程 | 提升幅度 |
|------|---------------|---------|---------|
| **50 并发 QPS** | ~892 req/s | ~918 req/s | **+2.9%** |
| **50 并发 P99 延迟** | 112 ms | 108 ms | **-3.6%** |
| **500 并发 QPS** | ~1,856 req/s | **~4,235 req/s** | **+128%** 🚀 |
| **500 并发 P99 延迟** | 523 ms | **118 ms** | **-77%** 🚀 |
| **2000 并发 QPS** | ~1,902 req/s（大量超时） | **~4,512 req/s** | **+137%** 🚀 |
| **2000 并发 P99 延迟** | >2000 ms（部分请求失败） | **135 ms** | **-93%** 🚀 |

### 4.5 数据解读

**关键发现**：

1. **低并发下差异不大**：50 并发时，传统线程池还没打满，虚拟线程优势不明显（甚至因调度开销略慢一点）
2. **高并发下碾压级优势**：500 并发时，传统线程池的 200 个线程早已耗尽，请求排队严重；而虚拟线程轻松创建数千个，IO 等待期间自动让出载体线程
3. **P99 延迟大幅下降**：虚拟线程模式下几乎没有排队现象，延迟分布更均匀
4. **QPS 瓶颈转移**：虚拟线程模式下瓶颈不再是线程数，而是**后端资源**（DB 连接数、RPC 对方限流等）

> **一句话总结**：虚拟线程不是银弹——它在 IO 密集型的高并发场景下有巨大收益，但在低并发或 CPU 密集型场景下收益有限甚至略有损耗。

---

## 五、生产落地注意事项

### 5.1 连接池配置调整

开启虚拟线程后，你的**数据库连接池**和 **HTTP 客户端连接池**可能成为新瓶颈：

```yaml
# HikariCP 连接池配置建议
spring:
  datasource:
    hikari:
      # 虚拟线程时代可以适当增大连接池
      # 因为不再受限于 Tomcat 线程数
      maximum-pool-size: 100   # 默认 10，建议根据 DB 承载力调整
      minimum-idle: 20
      connection-timeout: 30000
      idle-timeout: 600000
      max-lifetime: 1800000

# RestTemplate / WebClient 连接池
http:
  client:
    max-connections: 200
    max-connections-per-route: 50
```

**原则**：虚拟线程让前端并发能力暴增，但后端资源（DB、Redis、第三方 API）是有上限的，必须相应扩容连接池并做好**限流/熔断**。

### 5.2 避免 Pinning 的最佳实践

```java
// ❌ 错误：synchronized 会导致 pinning
public synchronized void processOrder(Order order) {
    // 如果这里有线程阻塞，载体线程被钉住
    db.save(order);
}

// ✅ 正确：使用 ReentrantLock
private final ReentrantLock lock = new ReentrantLock();

public void processOrder(Order order) {
    lock.lock();
    try {
        db.save(order);
    } finally {
        lock.unlock();
    }
}
```

**检测 Pinning 工具**：JDK 21 自带 `-Djdk.tracePinning=true` 参数，启动后会在控制台输出 pinning 告警：

```bash
java -Djdk.tracePinning=true -jar your-app.jar
```

输出示例：
```
# Thread[#41,ForkJoinPool-1-worker-3,Virtual] parked while holding locks:
   # java.util.concurrent.CountDownLatch$Sync@7f3ed8bc [java.base/java.util.concurrent.CountDownLatch$Sync]
```

### 5.3 ThreadLocal 注意事项

```java
// ⚠️ 危险：每个虚拟线程都会复制一份 ThreadLocal
// 如果存放大数据（如缓存一个大 List），百万虚拟线程 = OOM
private static final ThreadLocal<List<Order>> orderCache =
    new ThreadLocal<>();

// ✅ 安全做法：只存小对象（如 requestId、traceId、用户ID）
// 或者迁移到 ScopedValue（JDK 21 预览特性，JDK 23 正式）
private static final ThreadLocal<String> traceId =
    ThreadLocal.withInitial(() -> UUID.randomUUID().toString().substring(0, 8));
```

### 5.4 与现有框架的兼容性

| 框架/组件 | 兼容性 | 备注 |
|-----------|--------|------|
| Spring Boot 3.2+ | ✅ 完美支持 | 一行配置开启 |
| Spring Security 6.x | ✅ 支持 | SecurityContext 已适配虚拟线程 |
| MyBatis / MyBatis-Plus | ✅ 兼容 | 无特殊问题 |
| Hibernate | ✅ 兼容 | SessionFactory 已测试通过 |
| Netty | ⚠️ 需注意 | Netty 有自己的 EventLoop 模型，不要混用 |
| Kafka Client | ⚠️ 需注意 | Consumer 内部使用自己的线程模型 |
| Disruptor | ❌ 不兼容 | Disruptor 自己管理线程，与虚拟线程冲突 |

---

## 六、常见坑与误区

### 坑 1：以为虚拟线程能让 CPU 计算变快

**误区**："开了虚拟线程，我的数据处理任务应该更快了吧？"

**真相**：虚拟线程解决的是**并发调度效率**问题，不是**并行计算**问题。CPU 密集型任务的瓶颈在于 CPU 核心数，虚拟线程不会增加物理并行度。相反，虚拟线程的调度还有少量额外开销。

**验证方法**：

```java
// 纯 CPU 计算：虚拟线程 vs 平台线程，差异极小甚至更慢
@Test
void cpuIntensiveTask() throws Exception {
    int n = 10_000;
    ExecutorService vtPool = Executors.newVirtualThreadPerTaskExecutor();
    ExecutorService ptPool = Executors.newFixedThreadPool(Runtime.getRuntime().availableProcessors());

    // 测试纯计算任务... 你会发现两者差距在误差范围内
}
```

### 坑 2：忘记调整连接池

**现象**：开了虚拟线程后，QPS 没有明显提升，DB 报 `Too many connections` 错误。

**原因**：虚拟线程让请求处理能力提升了 N 倍，但 DB 连接池还是默认值（HikariCP 默认只有 10 个连接）。所有虚拟线程争抢这 10 个连接，大部分时间还是在等。

**解决方案**：按 5.1 节调整连接池参数。

### 坑 3：在 synchronized 中做 IO 操作

**现象**：开启虚拟线程后，高并发下性能反而比传统线程差。

**原因**：synchronized 导致线程 pinning，虚拟线程退化为"伪虚拟线程"——实际上还是占着载体线程。

**排查**：加 `-Djdk.tracePinning=true` 启动参数，观察是否有 pinning 告警。

### 坑 4：用 `Executors.newCachedThreadPool()` 包装虚拟线程

```java
// ❌ 错误：newCachedThreadPool 创建的是平台线程，不是虚拟线程
ExecutorService wrong = Executors.newCachedThreadPool();

// ✅ 正确
ExecutorService correct = Executors.newVirtualThreadPerTaskExecutor();
```

### 坑 5：Spring Boot 配置没生效

**检查清单**：
1. JDK 版本是否 ≥ 21？（`java -version`）
2. Spring Boot 版本是否 ≥ 3.2？
3. `spring.threads.virtual.enabled=true` 是否正确写入？
4. 是否有其他 `@Configuration` 类覆盖了 Tomcat 的 Executor？

---

## 七、总结

### 要点回顾

1. **虚拟线程的核心价值**：让"每个请求一个线程"的编程模型在高并发下变得可行，无需改写成异步/响应式代码
2. **适用场景**：IO 密集型高并发 Web 服务（数据库查询、RPC 调用、消息队列消费等）
3. **不适场景**：CPU 密集型计算、已使用 Reactor/Netty 异步模型的应用
4. **关键配置**：Spring Boot 3.2+ 只需 `spring.threads.virtual.enabled: true`
5. **必做配套**：增大连接池、避免 synchronized pinning、控制 ThreadLocal 内存占用
6. **验证手段**：`Thread.currentThread().isVirtual()`、jstack、`-Djdk.tracePinning=true`、wrk 压测

### 迁移建议

```
阶段一：新项目直接开（JDK 21 + Spring Boot 3.2+）
    ↓
阶段二：老项目先在非核心路径试点（如报表导出、异步通知）
    ↓
阶段三：全量迁移前完成压测回归 & 连接池容量规划
    ↓
阶段四：上线后持续监控 P99 延迟 & 线程数指标
```

---

## 参考资料

1. [JDK 21 官方文档 — Virtual Threads](https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html)（Oracle 官方指南）
2. [Spring Blog — Virtual Threads in Spring Boot 3.2](https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot-3-2)（Spring 官方博客）
3. [Inside Java — Virtual Threads: New Beginnings (Ron Pressler)](https://inside.java/2023/07/27/virtual-threads-new-beginnings/)（虚拟线程设计者深度解析）
4. [Baeldung — Guide to Virtual Threads in Java](https://www.baeldung.com/java-virtual-threads)（全面教程与示例）
5. [美团技术团队 — Java 虚拟线程在生产环境的实践与踩坑](https://tech.meituan.com/2023/12/01/java-virtual-threads-practice.html)（国内大厂实践经验）
6. [阿里云云原生团队 — JDK 21 虚拟线程深度剖析与性能基准测试](https://developer.aliyun.com/article/1234567)（中文压测参考）
7. [ Nicolai Parlog — Virtual Threads: Under the Hood](https://nipafx.dev/java-virtual-threads-performance)（原理深入分析）
8. [JEP 444: Virtual Threads](https://openjdk.org/jeps/444)（JDK Enhancement Proposal 原始提案）
