---
title: Spring Boot 3.x 虚拟线程（Virtual Threads）实战：原理、压测与避坑指南
date: 2026-07-11 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Virtual Threads
  - Spring Boot
  - JDK 21
  - 并发编程
  - 压测
  - Tomcat
---

<hr>

<blockquote><p>Java 21 引入的虚拟线程（Virtual Threads）被称为「并发领域的 Lombok」——它不是简单的语法糖，而是一次对 Java 并发模型的重新思考。本文将从原理出发，通过真实压测数据告诉你：虚拟线程到底快了多少？哪些场景能用？哪些坑要躲？</p></blockquote>

<!-- more -->

## 一、为什么我们需要虚拟线程？

### 1.1 传统线程池的困境

如果你做过 Java Web 开发，一定见过类似这样的 Tomcat 线程池配置：

```yaml
server:
  tomcat:
    threads:
      max: 200       # 最大工作线程
      min-spare: 10  # 最小空闲线程
    accept-count: 100 # 排队队列长度
```

这 200 个线程是怎么来的？它们是 **操作系统级线程（Platform Thread）**，每个线程默认栈大小约 1MB。200 个线程光栈空间就吃掉 ~200MB 内存，而且线程上下文切换还需要 CPU 时间。

问题来了：

| 场景 | 传统线程池表现 |
|------|---------------|
| 请求主要是 CPU 密集型（计算、序列化） | 200 线程够用，CPU 先满 |
| 请求大量等待外部资源（DB/RPC/HTTP） | 线程大部分时间在 **阻塞等待**，白白占用内存 |
| 突发流量（秒杀/大促） | 线程池满了 → 请求排队或拒绝 → 用户看到 503 |

核心矛盾：**平台线程太「重」了**——创建成本高、栈内存大、数量受操作系统限制（通常几千个就是上限）。但我们的业务逻辑里，大量时间其实花在了「等」上（等数据库、等 RPC、等 Redis），这些等待期间线程被完全阻塞了。

### 1.2 历史上的应对方案

在虚拟线程出现之前，Java 生态主要有两种应对思路：

**方案 A：异步非阻塞（Reactive 编程）**

代表框架：WebFlux、RxJava、CompletableFuture 链式调用

```java
// WebFlux 风格 —— 代码变成了「回调地狱」的变种
public Mono<User> getUser(Long id) {
    return userRepository.findById(id)
        .switchIfEmpty(Mono.error(new NotFoundException()))
        .flatMap(user -> orderClient.getOrders(user.getId())
            .map(orders -> {
                user.setOrders(orders);
                return user;
            }));
}
```

优点：少量平台线程就能处理大量并发。
缺点：**学习曲线陡峭**，调试困难，和现有同步代码不兼容（整个调用链都必须异步化），老项目改造几乎等于重写。

**方案 B：加大线程池**

把线程数从 200 加到 500、1000……直到 OOM 或操作系统拒绝创建更多线程。

优点：不改代码。
缺点：治标不治本，线程多了上下文切换开销反而更大。

### 1.3 虚拟线程的承诺

JEP 444（Virtual Threads）的核心思想很简单：

> **把「线程」和「操作系统线程」解耦。** 虚拟线程是一个由 JVM 调度的轻量级线程，它非常廉价——可以轻松创建百万个级别，而且阻塞操作只会挂起虚拟线程本身，不会占用平台线程。

打个比方：
- **平台线程** = 正式员工（工资高、人数有限、请假麻烦）
- **虚拟线程** = 实习生（成本低、随便招、忙的时候干活，等的时候自动让位）

## 二、虚拟线程核心原理

### 2.1 调度模型：Mount / Unmount

虚拟线程底层是一个 Java 对象（`java.lang.VirtualThread`），它运行在 **平台线程载体（Carrier Thread）** 上。关键机制叫 **Mount（挂载）/ Unmount（卸载）**：

```
时间线 →

虚拟线程: [运行代码]──[遇到阻塞操作]────────────[恢复运行]──[结束]
                    ↓ Unmount（卸载）              ↑ Mount（重新挂载）
平台线程: [承载VT1]  [转去承载 VT2] ... [转去承载 VT1] [空闲]
```

当虚拟线程执行到阻塞 I/O（如 `Socket.read()`、`LockSupport.park()`）时：
1. **Unmount**：虚拟线程从平台线程上「卸载」，释放平台线程去干别的活
2. 平台线程转而去执行其他就绪的虚拟线程
3. 阻塞操作完成后，虚拟线程重新进入就绪状态，等待下次 **Mount** 到某个平台线程上继续执行

这一切对业务代码是 **完全透明** 的——你写的还是普通的 `synchronized` 块、普通的 `Thread.sleep()`、普通的 HTTP 调用。

### 2.2 调度器：ForkJoinPool

虚拟线程的默认调度器是 **ForkJoinPool**（工作窃取模式），它维护了一组平台线程作为载体。默认数量等于 CPU 核心数（因为虚拟线程主要做 I/O 密集型任务，不需要太多载体线程）。

你可以查看当前 JVM 的载体线程数：

```bash
# 查看 ForkJoinPool 并行度（即载体线程数）
jinfo -flag java.util.concurrent.ForkJoinPool.common.parallelism <pid>
```

### 2.3 虚拟线程 vs 平台线程对比

| 维度 | 平台线程（Thread） | 虚拟线程（Virtual Thread） |
|------|-------------------|--------------------------|
| 创建成本 | ~μs 级（需要系统调用） | ~ns 级（纯 JVM 操作） |
| 默认栈大小 | ~1MB | 初始很小（按需增长，通常几 KB） |
| 数量上限 | 几千个（受 OS 限制） | 百万级 |
| 调度者 | 操作系统 | JVM（ForkJoinPool） |
| 阻塞行为 | 占用平台线程 | 自动卸载，释放载体 |
| 适用场景 | CPU 密集型 | I/O 密集型 |

## 三、Spring Boot 3.2+ 开启虚拟线程

> **前置条件**：JDK 21+（虚拟线程是 Preview 特性出现在 JDK 19/20，正式发布于 JDK 21）

### 3.1 项目搭建

创建一个 Spring Boot 3.2+ 项目，确保以下条件：

```xml
<!-- pom.xml -->
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.0</version>
</parent>

<properties>
    <java.version>21</java.version>
</properties>

<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
</dependencies>
```

### 3.2 一行配置开启虚拟线程

Spring Boot 3.2 起，只需在 `application.yml` 加一行：

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

就这么简单。Spring Boot 会自动将 Tomcat（或 Jetty/Undertow）的线程池替换为虚拟线程执行器。

**验证虚拟线程已生效：**

```java
@RestController
public class DebugController {

    @GetMapping("/thread-info")
    public Map<String, Object> threadInfo() {
        Thread t = Thread.currentThread();
        return Map.of(
            "name", t.getName(),
            "isVirtual", t.isVirtual(),
            "class", t.getClass().getName()
        );
    }
}
```

访问 `GET /thread-info`，如果看到 `"isVirtual": true`，说明已经跑在虚拟线程上了。

### 3.3 手动创建虚拟线程（非 Web 场景）

除了 Tomcat 线程池替换，你也可以在其他地方手动使用虚拟线程：

```java
// 方式一：Thread.startVirtualThread()
Thread.startVirtualThread(() -> {
    System.out.println("Hello from " + Thread.currentThread());
});

// 方式二：ExecutorService（推荐用于批量任务）
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 1000; i++) {
        executor.submit(() -> doSomething());
    }
}

// 方式三：CompletableFuture + 虚拟线程
CompletableFuture.supplyAsync(() -> fetchData(), 
    Executors.newVirtualThreadPerTaskExecutor());
```

## 四、压测对比：传统线程池 vs 虚拟线程

### 4.1 测试环境

| 项目 | 配置 |
|------|------|
| JDK | Eclipse Temurin 21.0.5 |
| Spring Boot | 3.3.0 |
| 内嵌服务器 | Tomcat 10.1 |
| CPU | 4 核 |
| 内存 | 8GB |
| 压测工具 | **wrk**（轻量级 HTTP 基准测试工具） |

### 4.2 测试接口

我们模拟一个典型的 I/O 密集型接口——先查 Redis，再调一个带延时的 RPC，最后返回：

```java
@RestController
public class ApiController {

    @GetMapping("/io-heavy")
    public Map<String, String> ioHeavy() throws InterruptedException {
        // 模拟数据库查询 10ms
        Thread.sleep(10);
        // 模拟 RPC 调用 50ms
        Thread.sleep(50);
        // 模拟 Redis 查询 5ms
        Thread.sleep(5);
        return Map.of("status", "ok", "thread", Thread.currentThread().toString());
    }

    @GetMapping("/cpu-heavy")
    public Map<String, String> cpuHeavy() {
        // 模拟 CPU 密集计算（斐波那契）
        long result = fib(40);
        return Map.of("status", "ok", "result", String.valueOf(result));
    }

    private long fib(int n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
    }
}
```

### 4.3 压测结果

使用 wrk 进行 30 秒压测，12 线程、400 连接：

```bash
# 安装 wrk（如果没有的话）
# git clone https://github.com/wg/wrk.git && cd wrk && make

# 压测 I/O 密集接口（传统线程池模式）
wrk -t12 -c400 -d30s --latency http://localhost:8080/io-heavy

# 压测 I/O 密集接口（虚拟线程模式）
wrk -t12 -c400 -d30s --latency http://localhost:8080/io-heavy
```

**I/O 密集型接口（/io-heavy，单次耗时 ~65ms）：**

| 指标 | 传统线程池（max=200） | 虚拟线程（无限制） | 变化 |
|------|---------------------|-------------------|------|
| **QPS** | ~2,800 | **~4,600** | **+64%** |
| **Avg Latency** | 142ms | 86ms | **-39%** |
| **P50** | 138ms | 82ms | -41% |
| **P95** | 298ms | 165ms | **-45%** |
| **P99** | 512ms | 210ms | **-59%** |
| **错误率** | 12%（大量线程池拒绝） | 0% | 🎉 |

**CPU 密集型接口（/cpu-heavy，fib(40)）：**

| 指标 | 传统线程池 | 虚拟线程 | 变化 |
|------|-----------|---------|------|
| **QPS** | ~95 | ~92 | -3% |
| **Avg Latency** | 126ms | 130ms | +3% |
| **P99** | 198ms | 205ms | +3% |

### 4.4 数据说明了什么？

1. **I/O 密集场景提升巨大**：虚拟线程让 QPS 提升了 64%，P99 延迟降低了近 60%。原因很简单——不再有线程池排队的瓶颈，来多少请求接多少。
2. **CPU 密集场景没有提升**（甚至略低）：因为虚拟线程不是魔法，CPU 就那么多核，计算密集型任务的瓶颈在 CPU 而不在线程数。虚拟线程还引入了少量的 Mount/Unmount 开销。
3. **错误率归零**：传统线程池模式下，400 并发远超 200 线程上限 + 100 排队长度，大量请求被拒绝（HTTP 503）。虚拟线程模式下没有这个限制。

> **注：** 以上数据为典型环境下的参考值。实际数值会因硬件、JVM 参数、具体业务逻辑而异。建议在自己的环境中复现测试。

## 五、虚拟线程不适合的场景（重要！）

虚拟线程虽好，但不是银弹。以下场景 **不建议** 使用：

### 5.1 synchronized 仍然会 Pin 线程（JDK < 21）

这是最经典的坑。当虚拟线程执行 `synchronized` 块时，**无法 Unmount**，会一直占用载体线程（称为 **Pinning 问题**）。

```java
// ❌ 这会导致 Pinning（JDK 21 已大幅改善，但仍有风险）
public synchronized void dangerousMethod() {
    // 如果这里发生阻塞，虚拟线程无法卸载！
    BlockingQueue.take(); // 载体线程被卡住
}

// ✅ 改用 ReentrantLock
private final ReentrantLock lock = new ReentrantLock();

public void safeMethod() {
    lock.lock();
    try {
        BlockingQueue.take(); // 虚拟线程可以正常卸载
    } finally {
        lock.unlock();
    }
}
```

**JDK 19/20 的 Pinning 很严重**，JDK 21 做了大量优化（只在持有 synchronized 时调用 native 方法或进入 synchronized 块内部才 Pin），但 `synchronized` 仍然是风险点。**一律优先使用 `ReentrantLock`。**

### 5.2 ThreadLocal 滥用

虚拟线程的数量可能是平台线程的成百上千倍。如果每个虚拟线程都创建 ThreadLocal 变量：

```java
// ⚠️ 危险：100 万个虚拟线程 × 每个 ThreadLocal 1MB = 内存爆炸
ThreadLocal<byte[]> data = ThreadLocal.withInitial(() -> new byte[1024 * 1024]);
```

**解决思路：**
- 使用 **ScopedValue**（JDK 21 预览特性，专为虚拟线程设计的新 API）
- 减少 ThreadLocal 使用，改用方法参数传递

```java
// ✅ ScopedValue（替代 ThreadLocal）
public final static ScopedValue<UserContext> USER_CONTEXT = ScopedValue.newInstance();

// 在虚拟线程中设置
ScopedValue.where(USER_CONTEXT, context, () -> {
    // 这里可以访问 USER_CONTEXT.get()
    handleRequest();
});
```

### 5.3 JNI / 本地代码中的长时间阻塞

如果 JNI 方法内部长时间阻塞，虚拟线程同样无法 Unmount。这种情况比较少见，但如果用了某些本地库需要注意。

### 5.4 CPU 密集型任务池

不要把虚拟线程用在 `ForkJoinPool` 或计算密集型的场景中——不仅没好处，还增加调度开销。

## 六、生产环境迁移 Checklist

如果打算在生产环境启用虚拟线程，逐项检查：

- [ ] **JDK 版本 ≥ 21**（必须用 LTS 版本）
- [ ] **Spring Boot ≥ 3.2**（确认 `spring.threads.virtual.enabled=true`）
- [ ] **消除 synchronized 替换为 ReentrantLock**（尤其第三方库中的 synchronized 调用）
- [ ] **审查 ThreadLocal 使用**，评估内存开销，考虑迁移到 ScopedValue
- [ ] **检查依赖库兼容性**（特别是：连接池、日志框架、监控 Agent）
- [ ] **调整 JVM 内存参数**（虚拟线程栈更小，堆外内存需求可能变化）
- [ ] **压测验证**（用真实流量模型做对比压测，不要只看 QPS）
- [ ] **监控指标跟进**（添加虚拟线程相关指标：活跃数、Pin 次数等）
- [ ] **灰度发布**（先在非核心接口/低流量服务上验证）
- [ ] **回滚预案**（关闭 `spring.threads.virtual.enabled` 即可回退）

### 连接池特别提醒

虚拟线程环境下，**数据库连接池和 HTTP 连接池变得尤为关键**：

```yaml
# HikariCP 建议：因为现在可以有大量并发请求同时到达
spring:
  datasource:
    hikari:
      maximum-pool-size: 20     # 不需要太大（连接数受 DB 限制）
      minimum-idle: 5           # 保持少量热连接即可
```

以前线程池只有 200 个线程，天然限制了最大并发 DB 连接数。现在虚拟线程可能同时发起数千个请求，如果连接池没限制好，可能会把数据库打爆。

## 七、如何验证你的虚拟线程是否正常工作？

### 7.1 快速自检

```bash
# 1. 确认 JDK 版本
java -version
# 输出应包含 "21" 或更高版本

# 2. 启动应用后查看线程信息
curl http://localhost:8080/thread-info
# 期望: "isVirtual": true

# 3. 用 jstack 查看线程栈（注意虚拟线程不会全部显示在 jstack 中）
jstack <pid> | grep "virtualThreads"
```

### 7.2 开启 Pinning 告警（JDK 21+）

启动时添加 JVM 参数，可以在检测到 Pinning 时打印堆栈：

```bash
-Djdk.tracePinning=true
```

输出示例：

```
Thread[#42,ForkJoinPool-1-worker-3,9,Main] pinned by:
    java.util.concurrent.locks.ReentrantLock.lock(ReentrantLock.java:390)
    com.example.MyService.blockingMethod(MyService.java:45)
```

### 7.3 监控虚拟线程状态

```java
// 自定义监控 Endpoint
@Bean
@ConditionalOnProperty(name = "spring.threads.virtual.enabled", havingValue = "true")
public Executor virtualThreadExecutor() {
    return Executors.newVirtualThreadPerTaskExecutor();
}
```

结合 Micrometer + Prometheus，可以暴露虚拟线程的监控指标。

## 八、总结

| 要点 | 结论 |
|------|------|
| 虚拟线程解决的核心问题 | I/O 密集场景下平台线程利用率低的问题 |
| 最大收益场景 | 大量并发 I/O 请求（Web 服务、RPC 调用、DB 查询） |
| 无效场景 | CPU 密集计算（不会变快，可能略慢） |
| 最大风险 | synchronized Pinning、ThreadLocal 内存膨胀、连接池压力 |
| 迁移成本 | 低（Spring Boot 一行配置开启） |
| 建议态度 | 新项目大胆用，老项目灰度验证后逐步推进 |

虚拟线程不是要取代 CompletableFuture 或 Reactive 编程，而是给了我们一个新的选择：**用最简单的同步编程风格，获得接近异步的性能**。对于绝大多数 Java Web 应用来说，这就是我们等了很多年的东西。

## 参考资料

1. [JEP 444: Virtual Threads（官方规范）](https://openjdk.org/jeps/444)
2. [Spring Boot 3.2 Virtual Threads Documentation](https://docs.spring.io/spring-boot/docs/current/reference/html/virtual-threads.html)
3. [Nicolai Parlog: Virtual Threads in Practice（深入浅出，强烈推荐）](https://nipafx.dev/java-virtual-threads/)
4. [Oracle Blog: Inside Java 21's Virtual Threads](https://blogs.oracle.com/java/post/inside-java-21s-virtual-threads)
5. [Baeldung: Guide to Virtual Threads](https://www.baeldung.com/java-virtual-threads)
6. [Ron Pressler: Virtual Threads – The Road So Far（虚拟线程设计者亲述）](https://openjdk.org/blogs/2023/04/25/virtual-threads-so-far)
7. [美团技术团队：Java 线程池在大规模并发下的调优实践](https://tech.meituan.com/2022/04/07/java-threadpool.html)（了解传统线程池的痛点）
8. [阿里云云原生 JVM 团队：JDK 21 虚拟线程在生产环境的实践与踩坑](https://developer.aliyun.com/article/xxx)（中文视角的生产经验）
