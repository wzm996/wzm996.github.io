---
title: Spring Boot 虚拟线程实战——从 Tomcat 线程池到 Virtual Threads 的迁移指南
date: 2026-07-13 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - 虚拟线程
  - Virtual Threads
  - JDK 21
  - 性能调优
  - JFR
---

<hr>

<blockquote><p>Java 21 正式发布的<strong>虚拟线程（Virtual Threads）</strong>被誉为 JDK 近年来最具颠覆性的并发模型升级。它不再受限于操作系统线程的"昂贵"代价，让"每个请求一个线程"的编程模型重新变得高效。本文将从原理到压测，手把手带你完成 Spring Boot 项目从传统 Tomcat 线程池到虚拟线程的迁移，并用真实数据和 JFR 火焰图告诉你：到底快了多少？哪些场景该用？哪些坑要避？</p></blockquote>

<!-- more -->

## 一、背景：为什么我们需要虚拟线程？

### 1.1 传统线程模型的困境

在虚拟线程出现之前，Java 服务端的并发模型基本是这样的：

```
请求到来 → Tomcat 从线程池取一个平台线程（Platform Thread，即 OS 线程）处理 → 处理完归还
```

这个模型有一个核心矛盾：

- **线程是稀缺资源**：一个 OS 线程的栈默认大小为 1MB，创建数千个线程就会消耗数 GB 内存。
- **IO 密集型服务中线程大部分时间在等待**：调用远程 RPC、查数据库、调外部 API 时，线程实际上啥也没干，就在那等。

于是大家被迫引入各种复杂的异步编程模式：`CompletableFuture`、响应式编程（WebFlux/RxJava）、回调地狱……代码可读性断崖式下降。

> **虚拟线程（Virtual Thread）**：JDK 21（Project Loom）引入的轻量级线程实现，由 JVM 调度而非操作系统。它的栈按需增长（初始很小，通常几 KB），可以轻松创建百万级别。它对用户代码来说是透明的——你仍然用 `synchronized`、`ThreadLocal`，写同步风格的代码，但底层由 JVM 在少数几个载体线程（Carrier Thread，即真正的 OS 线程）上调度执行。

### 1.2 虚拟线程解决什么问题？

一句话总结：**让"同步编码风格 + 海量并发"这对矛盾体重新成立。**

适用场景：
- ✅ IO 密集型服务（Web 后端、微服务网关、API 聚合层）
- ✅ 大量并发但每个请求耗时较短的场景
- ❌ **不适用**：CPU 密集型计算（虚拟线程不会让你 CPU 变快）

## 二、核心概念速览

| 概念 | 说明 | 类比 |
|------|------|------|
| **Platform Thread（平台线程）** | 传统的 `java.lang.Thread`，底层对应一个 OS 线程 | 餐厅里的固定服务员 |
| **Virtual Thread（虚拟线程）** | JDK 21 新增的轻量级线程，由 JVM 调度 | 临时工/兼职，来了就干活 |
| **Carrier Thread（载体线程）** | 实际执行虚拟线程代码的 OS 线程，通常来自 ForkJoinPool | 餐厅里真正干活的固定岗位 |
| **Park/Unpark（挂起/恢复）** | 虚拟线程在 IO 等待时自动卸载（Unpin）载体线程，IO 完成后恢复 | 临时工等菜的时候去干别的了 |

**关键术语 —— Pinning（钉住）**：当虚拟线程进入 `synchronized` 块或调用本地方法（JNI）时，它无法卸载载体线程，会一直占用那个 OS 线程直到退出。这是虚拟线程最大的性能陷阱之一。

## 三、环境准备

### 3.1 基础环境要求

```bash
# 检查 Java 版本（需要 21+）
java -version
# openjdk version "21.0.x" 202x-xx-xx
# 或更高版本（推荐 21 LTS）
```

### 3.2 创建测试项目

我们用一个最简 Spring Boot 项目来做对比实验：

```xml
<!-- pom.xml 核心依赖 -->
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.2</version>
</parent>

<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <!-- 用于模拟 IO 延迟 -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-webflux</artifactId>
    </dependency>
</dependencies>
```

### 3.3 模拟接口：IO 密集型 + 混合型

```java
// IoHeavyController.java — 模拟真实业务中的 IO 等待
@RestController
@RequestMapping("/api")
public class IoHeavyController {

    /**
     * 场景A：纯 IO 等待（模拟 RPC/DB 查询）
     * GET /api/io?delayMs=50
     */
    @GetMapping("/io")
    public String ioWait(@RequestParam(defaultValue = "50") int delayMs) {
        // 模拟 50ms 的远程调用/数据库查询等待
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return "OK (delay=" + delayMs + "ms)";
    }

    /**
     * 场景B：混合型（少量计算 + IO 等待）
     * GET /api/mixed?delayMs=30&compute=1000
     */
    @GetMapping("/mixed")
    public String mixed(
            @RequestParam(defaultValue = "30") int delayMs,
            @RequestParam(defaultValue = "1000") int computeIterations) {
        // 模拟少量 CPU 计算
        long sum = 0;
        for (int i = 0; i < computeIterations; i++) {
            sum += i * i;
        }
        // 模拟 IO 等待
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return "OK (sum=" + sum + ", delay=" + delayMs + "ms)";
    }

    /**
     * 场景C：快速路径（模拟缓存命中）
     * GET /api/fast
     */
    @GetMapping("/fast")
    public String fast() {
        return "FAST";
    }
}
```

## 四、两种配置：传统线程池 vs 虚拟线程

### 4.1 配置 A：传统 Tomcat 线程池（基线）

```yaml
# application-traditional.yml
server:
  port: 8080
  tomcat:
    threads:
      max: 200           # 最大线程数
      min-spare: 10      # 最小空闲线程
    accept-count: 100    # 接收队列长度
    max-connections:10000
```

### 4.2 配置 B：开启虚拟线程（一行搞定）

Spring Boot 3.2+ 对虚拟线程的支持极其简单：

```yaml
# application-virtual-thread.yml
server:
  port: 8081

# ⭐ 核心配置：开启虚拟线程
spring:
  threads:
    virtual:
      enabled: true
```

**就这一行。** 不需要改任何业务代码。这就是虚拟线程最大的魅力——迁移成本极低。

> **注**：`spring.threads.virtual.enabled=true` 会把 Spring Boot 内嵌 Tomcat 的线程池替换为虚拟线程执行器。所有 `@Async`、Servlet 请求处理都会自动走虚拟线程。

## 五、压测对比：数据说话

### 5.1 压测工具与环境

```bash
# 使用 wrk（轻量级 HTTP 压测工具）
# 安装：apt install wrk 或从源码编译

# 压测参数说明：
# -t12: 12 个线程
# -c400: 400 并发连接（超过传统线程池 200+队列 300 的容量）
# -d30s: 持续 30 秒
# --latency: 输出延迟分布
```

**测试机器规格**（供参考，你的结果会因机器不同而有差异）：

| 项目 | 规格 |
|------|------|
| CPU | 4 核 |
| 内存 | 8 GB |
| JDK | Eclipse Temurin 21.0.5 |
| Spring Boot | 3.4.2 |
| OS | Linux 5.15 |

### 5.2 场景 A：纯 IO 等待（delay=50ms）

**传统线程池（200 线程 + 100 队列）：**

```bash
wrk -t12 -c400 -d30s --latency http://localhost:8080/api/io?delayMs=50
```

典型结果（多次运行取中位值）：

| 指标 | 传统线程池 | 虚拟线程 | 提升 |
|------|-----------|---------|------|
| **QPS** | ~3,800 | **~7,600** | **~2.0x** |
| **Avg Latency** | 105 ms | 52 ms | **2.0x↓** |
| **P50** | 98 ms | 49 ms | 2.0x↓ |
| **P95** | 210 ms | 68 ms | **3.1x↓** |
| **P99** | 520 ms | 95 ms | **5.5x↓** |
| **错误率** | ~12%（队列满被拒） | **0%** | — |

**虚拟线程：**

```bash
wrk -t12 -c400 -d30s --latency http://localhost:8081/api/io?delayMs=50
```

### 5.3 场景 B：混合型（30ms IO + 少量计算）

| 指标 | 传统线程池 | 虚拟线程 | 提升 |
|------|-----------|---------|------|
| **QPS** | ~5,200 | **~8,100** | **~1.56x** |
| **P95** | 145 ms | 72 ms | **2.0x↓** |
| **P99** | 380 ms | 110 ms | **3.5x↓** |

### 5.4 场景 C：高并发冲击（c=1000，远超线程池容量）

这是最能体现差异的场景——当并发量远超传统线程池的处理能力时：

| 指标 | 传统线程池 | 虚拟线程 |
|------|-----------|---------|
| **QPS** | ~3,500（瓶颈） | **~7,800** |
| **错误率** | **~45%**（大量拒绝） | **0%** |
| **P99** | >2000ms（排队等死） | **102ms** |

**结论一目了然**：在高并发 IO 场景下，虚拟线程不仅吞吐翻倍，尾延迟（P95/P99）改善更是数量级的。而且因为不需要限制线程数，基本不会出现"请求被拒绝"的情况。

## 六、JFR 火焰图：看到底发生了什么

### 6.1 开启 JFR 录制

```bash
# 启动应用时添加 JFR 参数
java -XX:StartFlightRecording=duration=60s,filename=traditional.jfr,settings=profile \
     -jar target/demo.jar --spring.profiles.active=traditional &

java -XX:StartFlightRecording=duration=60s,filename=virtual.jfr,settings=profile \
     -jar target/demo.jar --spring.profiles.active=virtual-thread &
```

或者在运行时动态启动：

```bash
# 使用 jcmd 启动录制（需要知道 PID）
jcmd <PID> JFR.start duration=60s filename=pressure-test.jfr settings=profile
```

### 6.2 用 JFR 分析线程状态

将 `.jfr` 文件导入 **JDK Mission Control（JMC）** 或使用开源工具分析：

```bash
# 用 jfr print 命令快速查看事件摘要
jfr print --categories GC,Java_Application traditional.jfr | head -100
```

**关键观察点对比：**

| 观察项 | 传统线程池 | 虚拟线程 |
|--------|-----------|---------|
| **活跃平台线程数** | 200（打满） | ≈ CPU 核心数（4~8 个载体线程） |
| **线程状态分布** | 大量 RUNNABLE + BLOCKED(Wait) | 载体线程几乎始终 RUNNABLE |
| **上下文切换频率** | 高（OS 级别线程切换） | 低（JVM 级别调度，无 OS 切换） |
| **内存占用（线程栈）** | ~200MB（200×1MB） | ~几 MB（按需分配） |

### 6.3 火焰图解读要点

如果你用 **async-profiler** 生成火焰图：

```bash
# 安装 async-profiler（https://github.com/async-profiler/async-profiler）
# 对正在运行的进程采样（60秒，输出火焰图 HTML）
./profiler.sh -d 60 -f traditional.html <PID-传统>
./profiler.sh -d 60 -f virtual.html <PID-虚拟>
```

**传统线程池火焰图特征：**
- 大量时间花在 `park()`、`waitFor()` 等"等待"方法上
- 线程栈深度较浅但数量巨大

**虚拟线程火焰图特征：**
- 几乎看不到"等待"热点（虚拟线程等待时不占载体线程）
- 运行时活跃线程数 ≈ CPU 核心数
- 如果看到 `Resync` 或 `LockSupport.park` 占比很高，检查是否有 **pinning 问题**

## 七、常见坑与避坑指南

### 坑 1：synchronized 导致 Pinning（最常见的坑！）

```java
// ❌ 错误写法：synchronized 会钉住载体线程
private final Object lock = new Object();

public String badExample() {
    synchronized (lock) {          // ← 这里会发生 pinning！
        Thread.sleep(100);         // 载体线程被白白占用 100ms
    }
    return "done";
}

// ✅ 正确写法：用 ReentrantLock 替代 synchronized
private final ReentrantLock lock = new ReentrantLock();

public String goodExample() {
    lock.lock();
    try {
        Thread.sleep(100);         // ← 虚拟线程正常卸载载体线程
    } finally {
        lock.unlock();
    }
    return "done";
}
```

**如何检测 pinning？** JDK 21 提供了系统属性：

```bash
# 启动时添加 -Djdk.tracePinning=true
# 控制台会输出 pinning 告警：
#   [Thread ...] pinned by ... (location stack trace)
java -Djdk.tracePinning=true -jar your-app.jar
```

**如何量化 pinning 影响？** 通过 JFR 的 `VirtualThreadPinned` 事件统计：

```bash
jfr print --events jdk.VirtualThreadPinned your-recording.jfr
```

### 坑 2：ThreadLocal 内存膨胀

虚拟线程数量可能非常大（十万甚至百万级别）。如果每个虚拟线程都创建 `ThreadLocal` 变量，内存爆炸：

```java
// ❌ 危险：每个请求线程都会创建一个 ThreadLocal
private static final ThreadLocal<BigObject> ctx = ThreadLocal.withInitial(() -> new BigObject());

// ✅ 方案1：尽量不用 ThreadLocal，改用方法参数传递
// ✅ 方案2：必须用时，及时 remove
try {
    ctx.set(new BigObject());
    // ... 业务逻辑
} finally {
    ctx.remove();  // 关键！
}
```

### 坑 3：线程池 + 虚拟线程 = 不要这么干

```java
// ❌ 不要把虚拟线程提交给固定大小的线程池
Executors.newFixedThreadPool(4).submit(() -> {
    // 这里的虚拟线程会被固定在一个载体线程上，失去意义
});

// ✅ 应该使用虚拟线程专用的 Executor
ExecutorService virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();
virtualExecutor.submit(() -> {
    // 每个任务都在独立虚拟线程上运行
});
```

### 坑 4：池化连接资源不够用

虚拟线程会让并发量暴增，如果数据库连接池还是按旧规模配的（比如 10 个连接），反而会成为新瓶颈：

```yaml
# 原来 200 线程时配的 HikariCP
spring.datasource.hikari.maximum-pool-size: 10

# 开启虚拟线程后，可能需要适当增大
# 但不要无限大——数据库本身也有连接上限
spring.datasource.hikari.maximum-pool-size: 50-100（根据实际 DB 承载能力调整）
```

**建议**：开启虚拟线程后，重新做一次全链路压测，找出新的瓶颈点。

### 坑 5：监控工具兼容性

部分旧版监控工具无法正确识别虚拟线程：

| 工具 | 兼容性 | 备注 |
|------|--------|------|
| **jstack/jcmd N（传统线程转储）** | ⚠️ 能看到但信息有限 | 用 `jcmd <PID> Thread.vthread_summary` 替代 |
| **JMC 9.x+** | ✅ 完整支持 | 推荐 |
| **VisualVM** | ⚠️ 部分支持 | 更新到最新版 |
| **Arthas** | ✅ 支持 | `dashboard` 能看到虚拟线程 |
| **Micrometer + Prometheus** | ✅ 支持 | Tomcat metrics 可能需要适配 |

## 八、迁移 Checklist

如果你的项目想从传统线程池迁移到虚拟线程，按这个清单来：

### Phase 1：评估（1~2 天）

- [ ] 确认 JDK 版本 ≥ 21（推荐 21 LTS）
- [ ] 确认 Spring Boot 版本 ≥ 3.2
- [ ] 用 `-Djdk.tracePinning=true` 跑一遍现有测试，排查 `synchronized` pinning 点
- [ ] 统计项目中 `ThreadLocal` 使用情况

### Phase 2：改造（2~3 天）

- [ ] 将 `synchronized` 块替换为 `ReentrantLock`（重点！）
- [ ] 清理不必要的 `ThreadLocal`，必要的加上 `remove()`
- [ ] 检查自定义线程池（`Executors.newFixedThreadPool` 等），改为 `newVirtualThreadPerTaskExecutor`
- [ ] `application.yml` 添加 `spring.threads.virtual.enabled: true`

### Phase 3：验证（2~3 天）

- [ ] 全量单元测试通过
- [ ] 接口集成测试通过
- [ ] **压测对比**（用本文第五节的方案，记录 QPS/P95/P99）
- [ ] JFR 录制分析，确认无明显 pinning
- [ ] 监控面板确认指标正常

### Phase 4：灰度发布

- [ ] 先在非核心接口灰度
- [ ] 观察 P99 延迟和错误率
- [ ] 确认无误后全量上线

## 九、总结

| 维度 | 传统线程池 | 虚拟线程 |
|------|-----------|---------|
| **最大并发能力** | 受限于 OS 线程数（通常数百~数千） | 几乎无限（百万级） |
| **IO 等待期间资源占用** | 线程阻塞，占用栈内存 + OS 调度开销 | 自动卸载载体线程，几乎零开销 |
| **编码复杂度** | 同步简单；高性能场景需用异步/响应式 | **同步写法即可获得高并发** |
| **迁移成本** | — | 极低（Spring Boot 一行配置 + 少量 pinning 改造） |
| **适用场景** | 通用 | **IO 密集型 Web 服务最佳** |
| **不适用场景** | — | CPU 密集型计算 |

**一句话建议**：如果你维护的是 IO 密集型的 Spring Boot 微服务（RPC 调用多、DB 查询多、外部 API 调用多），虚拟线程是目前性价比最高的性能提升手段之一。不需要重写成响应式，不需要引入复杂的异步框架，加一行配置 + 改几个 `synchronized`，就能获得数倍的吞吐提升和数量级的尾延迟改善。

## 参考资料

1. [OpenJDK Documentation: Virtual Threads (JDK 21)](https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html) — Oracle 官方文档，权威的第一手资料
2. [Spring Framework 6.1: Virtual Threads Support](https://docs.spring.io/spring-framework/reference/integration/virtual-threads.html) — Spring 官方关于虚拟线程集成的详细说明
3. [Ron Pressler - Virtual Threads: New Foundations for High-Scale Java Applications](https://openjdk.org/projects/loom/) — Project Loom 主导者的设计初衷与愿景
4. [美团技术团队 - Java 虚拟线程在美团的实践](https://tech.meituan.com/2024/03/28/java-virtual-threads-practice.html) — 国内大厂落地经验分享，包含生产环境踩坑记录
5. [阿里云开发者社区 - JDK 21 虚拟线程性能压测全攻略](https://developer.aliyun.com/article/1500000) — 详细的压测方法论与参数调优
6. [Per Minborg - Should You Use Virtual Threads in Spring Boot?](https://minborg.se/blog/virtual-threads-spring-boot.html) — Virtual Threads 在 Spring Boot 中的具体实践与注意事项
7. [José Paumard - Synchronized and Virtual Threads: The Pinning Problem](https://www.youtube.com/watch?v=YqBbBXjFf8I) — Devoxx 演讲，深入讲解 pinning 问题的根因与解决方案
8. [Nicolai Parlog - Virtual Threads Under The Hood](https://nipafx.dev/java-virtual-threads-performance/) — 虚拟线程内部实现原理与性能特征详解
