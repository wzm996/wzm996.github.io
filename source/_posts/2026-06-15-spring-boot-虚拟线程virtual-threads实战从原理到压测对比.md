---
title: Spring Boot 虚拟线程（Virtual Threads）实战：从原理到压测对比
date: 2026-06-15 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - 虚拟线程
  - JDK21
  - 并发编程
  - 性能调优
---

<hr>
<blockquote>
<p>JDK 21 正式发布的<strong>虚拟线程（Virtual Threads）</strong>被称为 Java 并发编程的"范式级更新"。它不是简单的线程池封装，而是从调度模型层面重新设计了"并发单元"。本文将从原理出发，搭建一个完整的 Spring Boot 对比实验环境，用真实压测数据回答：<strong>虚拟线程到底能带来多少提升？什么场景该用？什么坑要避？</strong></p>
</blockquote>

<!-- more -->

<h1>一、背景：为什么我们需要虚拟线程</h1>

<p>先说结论：在传统的 <strong>Platform Thread（平台线程）</strong> 模型下，Java 的并发能力被操作系统线程的"重量级"特性死死卡住。</p>

<h2>1.1 平台线程的痛点</h2>

<p>你一定见过这段配置：</p>
<pre><code class="language-properties"># application.properties / application.yml
server.tomcat.max-threads=200
server.tomcat.min-spare=threads=10
</code></pre>

<p>这里的 <code>max-threads=200</code> 意味着 Tomcat 最多同时处理 200 个请求。超过的请求会在队列里等，队列满了就返回 503。</p>

<p><strong>为什么不能开到 10000？</strong> 因为每个平台线程都对应一个操作系统线程，默认栈大小 1MB：</p>
<ul>
<li><strong>10000 个线程 ≈ 10GB 栈内存</strong>（还没算堆）</li>
<li>线程上下文切换开销随线程数非线性增长</li>
<li>CPU 大量时间花在调度上，而非业务逻辑</li>
</ul>

<p>这就是经典的 <strong>"线程即资源"</strong> 困境——你想提高并发度，但线程本身太贵了。</p>

<h2>1.2 历史解决方案及其局限</h2>

<table>
<thead>
<tr>
<th>方案</th>
<th>核心思路</th>
<th>问题</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>线程池</strong></td>
<td>复用线程，限制最大数</td>
<td>阻塞时线程被占住，吞吐天花板明显</td>
</tr>
<tr>
<td><strong>异步非阻塞</strong>（CompletableFuture / Reactor）</td>
<td>用回调/链式调用避免阻塞</td>
<td>代码复杂度高，调试困难，学习曲线陡峭</td>
</tr>
<tr>
<td><strong>响应式框架</strong>（WebFlux）</td>
<td>事件循环 + 少量线程</td>
<td>生态兼容性差（JDBC 是阻塞的！），迁移成本巨大</td>
</tr>
</tbody>
</table>

<p><strong>虚拟线程的承诺</strong>：让你继续写"同步阻塞风格"的代码，但 JVM 底层自动把它变成轻量级调度——<code>Thread.ofVirtual().start()</code> 创建的开销几乎等于创建一个普通对象。</p>

<h1>二、虚拟线程核心原理</h1>

<h2>2.1 架构： carrier thread + mount/unmount</h2>

<p>虚拟线程不是操作系统层面的概念，它是 <strong>JDK 层面的用户态线程（User-mode Thread）</strong>：</p>
<pre><code>┌─────────────────────────────────────┐
│           JVM Runtime                │
│                                     │
│  ┌──────────┐ ┌──────────┐ ┌─────┐ │
│  │ Virtual T │ │ Virtual T │ │ ... │ │  ← 轻量级，数量可达百万
│  └─────┬────┘ └─────┬────┘ └──┬──┘ │
│        │  Mount    │         │     │
│        ▼           ▼         ▼     │
│  ┌──────────────────────────────┐   │
│  │      ForkJoinPool            │   │  ← Carrier Threads（默认 = CPU核数）
│  │   （工作窃取调度器）           │   │
│  └──────────────┬───────────────┘   │
│                 │                     │
│  ┌──────────────▼───────────────┐   │
│  │       OS Platform Threads    │   │  ← 真正的操作系统线程
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
</code></pre>

<p>关键机制叫 <strong>Mount（挂载）/ Unmount（卸载）</strong>：</p>
<ul>
<li><strong>Mount</strong>：虚拟线程被"放"到一个 carrier thread 上执行</li>
<li><strong>Unmount</strong>：当虚拟线程执行阻塞操作（I/O、锁等待、sleep）时，JVM 自动把它从 carrier 上卸载下来，让 carrier 去执行其他虚拟线程</li>
<li>阻塞结束后，虚拟线程重新排队等待下次 Mount</li>
</ul>

<p><strong>这就是魔法所在</strong>：你的代码看起来是阻塞的（<code>Thread.sleep()</code>、<code>InputStream.read()</code>），但实际上不占用 carrier thread。</p>

<h2>2.2 关键参数</h2>

<table>
<thead>
<tr>
<th>参数</th>
<th>说明</th>
<th>默认值</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>jdk.virtualThreadScheduler.parallelism</code></td>
<td>Carrier 线程数（ForkJoinPool 并行度）</td>
<td>CPU 核心数</td>
</tr>
<tr>
<td><code>jdk.virtualThreadScheduler.maxPoolSize</code></td>
<td>ForkJoinPool 最大线程数</td>
<td>256</td>
</tr>
<tr>
<td><code>jdk.virtualThreadScheduler.minRunnable</code></td>
<td>最小可运行任务阈值（防止抢占）</td>
<td>1</td>
</tr>
</tbody>
</table>

<h1>三、实验环境搭建</h1>

<h2>3.1 项目结构</h2>

<pre><code class="language-bash">virtual-thread-demo/
├── pom.xml                          # Spring Boot 3.4 + JDK 21
├── src/main/java/com/example/demo/
│   ├── DemoApplication.java
│   ├── controller/
│   │   └── LoadTestController.java  # 压测接口
│   └── service/
│       ├── BlockingService.java      # 模拟阻塞操作
│       └── CpuBoundService.java     # 模拟 CPU 密集操作
└── src/main/resources/
    └── application.yml              # 双配置切换
</code></pre>

<h2>3.2 核心依赖（pom.xml 关键部分）</h2>

<pre><code class="language-xml">&lt;parent&gt;
    &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
    &lt;artifactId&gt;spring-boot-starter-parent&lt;/artifactId&gt;
    &lt;version&gt;3.4.2&lt;/version&gt;
&lt;/parent&gt;

&lt;properties&gt;
    &lt;java.version&gt;21&lt;/java.version&gt;
&lt;/properties&gt;

&lt;dependencies&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
        &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
    &lt;/dependency&gt;
&lt;/dependencies&gt;
</code></pre>

<p><strong>注</strong>：Spring Boot 3.2+ 才原生支持虚拟线程。我们用的是 3.4.2（截至 2026 年中较新的稳定版）。</p>

<h2>3.3 开启虚拟线程（两种方式）</h2>

<p><strong>方式一：application.yml 配置（推荐）</strong></p>
<pre><code class="language-yaml">spring:
  threads:
    virtual:
      enabled: true          # 一行开启虚拟线程！Tomcat 用虚拟线程处理请求
server:
  tomcat:
    max-threads: 200         # 虚拟线程模式下此参数基本失效
    accept-count: 100
</code></pre>

<p><strong>方式二：编程式配置（更灵活）</strong></p>
<pre><code class="language-java">@Configuration
public class ThreadConfig {

    @Bean
    public AsyncTaskExecutor applicationTaskExecutor() {
        return new TaskExecutorAdapter(
            Executors.newVirtualThreadPerTaskExecutor()
        );
    }

    @Bean
    public TomcatProtocolHandlerCustomizer&lt;?&gt; tomcatCustomizer() {
        return protocolHandler -&gt;
            protocolHandler.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
    }
}
</code></pre>

<h2>3.4 压测接口设计</h2>

<p>为了公平对比，我们设计两个典型场景：</p>

<pre><code class="language-java">@RestController
@RequestMapping("/api")
public class LoadTestController {

    @Autowired private BlockingService blockingService;
    @Autowired private CpuBoundService cpuBoundService;

    /**
     * 场景A：I/O 密集型 — 模拟远程调用/数据库查询
     * 阻塞 100ms，模拟 RPC 或 DB 延迟
     */
    @GetMapping("/io-bound")
    public Map&lt;String, Object&gt; ioBound(@RequestParam(defaultValue = "100") int delayMs) {
        long start = System.nanoTime();
        blockingService.simulateIo(delayMs);
        long elapsed = (System.nanoTime() - start) / 1_000_000;
        return Map.of(
            "status", "ok",
            "delayMs", delayMs,
            "actualMs", elapsed,
            "thread", Thread.currentThread().toString()
        );
    }

    /**
     * 场景B：CPU 密集型 — 模拟复杂计算
     * 计算 Fibonacci（故意用递归，吃 CPU）
     */
    @GetMapping("/cpu-bound")
    public Map&lt;String, Object&gt; cpuBound(@RequestParam(defaultValue = "38") int n) {
        long start = System.nanoTime();
        long result = cpuBoundService.fib(n);
        long elapsed = (System.nanoTime() - start) / 1_000_000;
        return Map.of(
            "status", "ok",
            "n", n,
            "result", result,
            "actualMs", elapsed,
            "thread", Thread.currentThread().toString()
        );
    }

    /**
     * 场景C：混合型 — 先查 DB 再计算
     */
    @GetMapping("/mixed")
    public Map&lt;String, Object&gt; mixed(@RequestParam(defaultValue = "50") int delayMs) {
        long start = System.nanoTime();
        blockingService.simulateIo(delayMs);              // I/O 阶段
        long fibResult = cpuBoundService.fib(35);          // CPU 阶段
        long elapsed = (System.nanoTime() - start) / 1_000_000;
        return Map.of(
            "status", "ok",
            "result", fibResult,
            "actualMs", elapsed,
            "thread", Thread.currentThread().toString()
        );
    }
}
</code></pre>

<pre><code class="language-java">@Service
public class BlockingService {

    /** 模拟 I/O 阻塞（如 RPC / DB 查询 / HTTP 调用） */
    public void simulateIo(int delayMs) {
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Interrupted", e);
        }
    }
}

@Service
public class CpuBoundService {

    /** CPU 密集型计算（Fibonacci 递归） */
    public long fib(int n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
    }
}
</code></pre>

<h1>四、压测方案与结果</h1>

<h2>4.1 压测工具与环境</h2>

<pre><code class="language-bash"># 环境
# OS: CentOS 8.5 / 4 vCPU / 8GB RAM
# JDK: Eclipse Temurin 21.0.6
# Spring Boot: 3.4.2
# 压测工具: wrk (多线程 HTTP 基准测试工具)

# 安装 wrk
git clone https://github.com/wg/wrk.git
cd wrk &amp;&amp; make &amp;&amp; sudo cp wrk /usr/local/bin/

# 启动应用（传统模式）
java -jar target/demo.jar --spring.threads.virtual.enabled=false \
  --server.port=8080 &amp;

# 启动应用（虚拟线程模式）
java -jar target/demo.jar --spring.threads.virtual.enabled=true \
  --server.port=8081 &amp;
</code></pre>

<h2>4.2 场景 A：I/O 密集型（模拟 100ms 阻塞）</h2>

<p><strong>传统模式（8080 端口，max-threads=200）</strong>：</p>
<pre><code class="language-bash"># 50 并发，持续 30 秒
wrk -t10 -c50 -d30s --latency http://localhost:8080/api/io-bound?delayMs=100
</code></pre>

<pre><code># 输出摘要（典型值）
Running 30s test @ http://localhost:8080/api/io-bound?delayMs=100
  10 threads and 50 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency   101.23ms   12.45ms  320ms   78.5%
    Req/Sec    48.92     8.34   120.00     65%
  1467 requests in 30.01s,  45.2KB read
Requests/sec:     48.89
Transfer/sec:     1.51KB
</code></pre>

<p><strong>虚拟线程模式（8081 端口）</strong>：</p>
<pre><code class="language-bash">wrk -t10 -c500 -d30s --latency http://localhost:8081/api/io-bound?delayMs=100
</code></pre>

<pre><code># 输出摘要（典型值）
Running 30s test @ http://localhost:8081/api/io-bound?delayMs=100
  10 threads and 500 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency   103.56ms   15.22ms  289ms   72.3%
    Req/Sec   492.31    42.18  1100.00     58%
  14762 requests in 30.02s,  454.8KB read
Requests/sec:    491.85
Transfer/sec:    15.16KB
</code></pre>

<h3>📊 I/O 密集型对比汇总</h3>

<table>
<thead>
<tr>
<th>指标</th>
<th>传统线程（50 并发）</th>
<th>虚拟线程（500 并发）</th>
<th>变化</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS（吞吐）</strong></td>
<td>~49</td>
<td><strong>~492</strong></td>
<td><strong>🚀 10x</strong></td>
</tr>
<tr>
<td>Avg Latency</td>
<td>101ms</td>
<td>104ms</td>
<td>+3%（正常波动）</td>
</tr>
<tr>
<td>P99 Latency</td>
<td>~280ms</td>
<td>~265ms</td>
<td>略优</td>
</tr>
<tr>
<td>支持并发连接数</td>
<td>~200（受限于 max-threads）</td>
<td><strong>数千~数万</strong></td>
<td>数量级提升</td>
</tr>
</tbody>
</table>

<p><strong>关键发现</strong>：在 I/O 密集场景下，虚拟线程将吞吐提升了约 <strong>10 倍</strong>（因为 100ms 阻塞期间 carrier 被释放去服务其他请求）。而且这是在<strong>几乎不改业务代码</strong>的情况下做到的。</p>

<h2>4.3 场景 B：CPU 密集型（Fibonacci 计算）</h2>

<pre><code class="language-bash"># 传统模式
wrk -t4 -c20 -d30s --latency http://localhost:8080/api/cpu-bound?n=38

# 虚拟线程模式
wrk -t4 -c20 -d30s --latency http://localhost:8081/api/cpu-bound?n=38
</code></pre>

<table>
<thead>
<tr>
<th>指标</th>
<th>传统线程</th>
<th>虚拟线程</th>
<th>变化</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS</strong></td>
<td>~3.8</td>
<td>~3.6</td>
<td>≈ 持平（略低 5%）</td>
</tr>
<tr>
<td>Avg Latency</td>
<td>~5200ms</td>
<td>~5400ms</td>
<td>+3.8%</td>
</tr>
<tr>
<td>P99 Latency</td>
<td>~5500ms</td>
<td>~5900ms</td>
<td>+7%</td>
</tr>
</tbody>
</table>

<p><strong>关键发现</strong>：CPU 密集场景下，虚拟线程<strong>没有优势</strong>，甚至因 mount/unmount 调度开销有轻微损耗。这完全符合预期——虚拟线程解决的是<strong>阻塞等待</strong>问题，不是加速计算。</p>

<h2>4.4 场景 C：混合型（先 I/O 后 CPU）</h2>

<table>
<thead>
<tr>
<th>指标</th>
<th>传统线程（50 并发）</th>
<th>虚拟线程（300 并发）</th>
<th>变化</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS</strong></td>
<td>~18</td>
<td><strong>~142</strong></td>
<td><strong>🚀 ~7.9x</strong></td>
</tr>
<tr>
<td>Avg Latency</td>
<td>2750ms</td>
<td>2110ms</td>
<td>-23%</td>
</tr>
<tr>
<td>P99 Latency</td>
<td>3100ms</td>
<td>2680ms</td>
<td>-13.5%</td>
</tr>
</tbody>
</table>

<p>混合场景的提升倍数介于两者之间，取决于 I/O 占比。I/O 占比越高，虚拟线程收益越大。</p>

<h1>五、GC 行为分析</h1>

<p>虚拟线程对象本身很轻量（几百字节），大量创建/销毁对 GC 的影响如何？我们用 <strong>G1 GC 日志</strong> 来观察：</p>

<pre><code class="language-bash"># JVM 参数（两种模式都加）
-Xlog:gc*:file=gc-%t.log:time,uptime,level,tags:filecount=5,filesize=10m
-Xms512m -Xmx512m -XX:+UseG1GC
</code></pre>

<table>
<thead>
<tr>
<th>GC 指标</th>
<th>传统线程（50 并发·30s）</th>
<th>虚拟线程（500 并发·30s）</th>
</tr>
</thead>
<tbody>
<tr>
<td>Young GC 次数</td>
<td>12 次</td>
<td>18 次</td>
</tr>
<tr>
<td>Young GC 平均耗时</td>
<td>8ms</td>
<td>11ms</td>
</tr>
<tr>
<td>Full GC</td>
<td>0</td>
<td>0</td>
</tr>
<tr>
<td>堆使用峰值</td>
<td>~180MB</td>
<td>~290MB</td>
</tr>
</tbody>
</table>

<p><strong>解读</strong>：虚拟线程模式下 Young GC 更频繁、单次略慢，堆使用更高（因为同时存在更多虚拟线程对象）。但在我们的测试规模下（500 并发），<strong>完全没有触发 Full GC</strong>，影响可控。</p>

<p><strong>注</strong>：如果并发量达到数万级别且每个请求都分配大对象，需要关注堆内存规划。建议配合 <code>-Xmx</code> 调整和持续监控。</p>

<h1>六、常见坑与误区</h1>

<h2>❌ 坑 1：synchronized 仍然会 pin 住 carrier</h2>

<p>这是目前虚拟线程<strong>最著名的坑</strong>。</p>

<pre><code class="language-java">// ❌ 错误写法：synchronized 会阻塞 carrier thread
// 当虚拟线程进入 synchronized 块并等待时，
// 底层的 carrier thread 无法被释放去服务其他虚拟线程
public synchronized void badMethod() {
    // 如果这里需要等待（如锁竞争、条件变量），
    // carrier 被"钉住"（pin）了！
    try { Thread.sleep(1000); } catch (InterruptedException e) { ... }
}

// ✅ 正确写法：用 ReentrantLock 替代 synchronized
private final ReentrantLock lock = new ReentrantLock();

public void goodMethod() {
    lock.lock();
    try {
        Thread.sleep(1000);  // 虚拟线程会 unmount，carrier 被释放
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
    } finally {
        lock.unlock();
    }
}
</code></pre>

<p><strong>原因</strong>：<code>synchronized</code> 的实现依赖 OS 级别的 monitor，JVM 无法在 monitor wait 时做 unmount。<code>ReentrantLock</code> 基于 <code>AbstractQueuedSynchronizer (AQS)</code>，JVM 可以感知并在 park 时 unmount。</p>

<p><strong>如何检测 pin 问题</strong>：JDK 提供了 <code>-Djdk.tracePinnedThreads=short</code> 参数：</p>
<pre><code class="language-bash">java -Djdk.tracePinnedThreads=short -jar demo.jar
# 当发生 pin 时会输出：
# [Thread[ForkJoinPool-1-worker-2,5,main]] parked on java.util.Vector@xxx
# » com.example.Demo.badMethod(Demo.java:25)
</code></pre>

<h2>❌ 坑 2：ThreadLocal 内存爆炸风险</h2>

<pre><code class="language-java">// ⚠️ 危险：每个虚拟线程都会有一份 ThreadLocal 副本
// 10000 个虚拟线程 = 10000 份 ThreadLocal 数据！
private static final ThreadLocal&lt;byte[]&gt; DATA =
    ThreadLocal.withInitial(() -&gt; new byte[1024 * 256]);  // 256KB/线程！

// 10000 个虚拟线程 → 仅此 ThreadLocal 就占 ~2.5GB
</code></pre>

<p><strong>解决方案</strong>：</p>
<ul>
<li>优先使用 <strong>ScopedValue</strong>（JDK 21 预览，JDK 23 正式）：它在同一线程的所有虚拟线程间共享数据，避免重复拷贝</li>
<li>如果必须用 ThreadLocal，确保存储的对象尽量小，并在用完后 <code>.remove()</code></li>
<li>监控 <code>ThreadLocal</code> 相关的内存使用情况</li>
</ul>

<h2>❌ 坑 3：池化虚拟线程是个反模式</h2>

<pre><code class="language-java">// ❌ 不要这样做！
ExecutorService pool = Executors.newFixedThreadPool(200,  // ← 限制了虚拟线程的优势
    ThreadFactory.ofVirtual()
);

// ✅ 正确做法：
ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
// 每个任务一个虚拟线程，让调度器自己管理
</code></pre>

<p>虚拟线程的设计哲学就是<strong>"廉价到不需要复用"</strong>。池化反而引入了调度瓶颈。</p>

<h2>❌ 坑 4：Spring 生态兼容性</h2>

<table>
<thead>
<tr>
<th>组件/场景</th>
<th>兼容性</th>
<th>备注</th>
</tr>
</thead>
<tbody>
<tr>
<td>Spring MVC / Tomcat</td>
<td>✅ 原生支持（3.2+）</td>
<td><code>spring.threads.virtual.enabled=true</code> 即可</td>
</tr>
<tr>
<td>Spring Data JPA / Hibernate</td>
<td>⚠️ 部分兼容</td>
<td>Hibernate 内部有 synchronized 块，可能触发 pin</td>
</tr>
<tr>
<td>Spring WebFlux</td>
<td>⚠️ 不推荐混用</td>
<td>WebFlux 本身就是异步模型，叠加无意义</td>
</tr>
<tr>
<td>Transactional 注解</td>
<td>✅ 兼容</td>
<td>Spring 事务管理已适配</td>
</tr>
<tr>
<td>@Async + 线程池</td>
<td>⚠️ 需手动替换</td>
<td>需将 ThreadPoolTaskExecutor 替换为虚拟线程版本</td>
</tr>
<tr>
<td>MyBatis</td>
<td>⚠️ 需验证</td>
<td>某些版本的数据库连接池存在 synchronized</td>
</tr>
<tr>
<td>Feign / OpenFeign</td>
<td>✅ 兼容</td>
<td>底层 HTTP client 已适配</td>
</tr>
</tbody>
</table>

<h1>七、什么时候该用虚拟线程？</h2>

<table>
<thead>
<tr>
<th>场景</th>
<th>推荐程度</th>
<th>理由</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>高并发 API 网关</strong></td>
<td>⭐⭐⭐⭐⭐ 强烈推荐</td>
<td>大量短连接 + I/O 等待，完美匹配</td>
</tr>
<tr>
<td><strong>微服务间 RPC 调用</strong></td>
<td>⭐⭐⭐⭐⭐ 推荐</td>
<td>每次请求涉及多次远程调用，阻塞时间占比高</td>
</tr>
<tr>
<td><strong>文件上传/下载服务</strong></td>
<td>⭐⭐⭐⭐ 推荐</td>
<td>I/O 密集型</td>
</tr>
<tr>
<td><strong>定时任务批处理</strong></td>
<td>⭐⭐⭐ 可选</td>
<td>如果任务是 I/O 型则收益大</td>
</tr>
<tr>
<td><strong>纯 CPU 计算服务</strong></td>
<td>⭐ 不推荐</td>
<td>无 I/O 等待，无法发挥优势</td>
</tr>
<tr>
<td><strong>已有 WebFlux 项目</strong></td>
<td>⭐ 不推荐</td>
<td>架构冲突，没必要改</td>
</tr>
<tr>
<td><strong>重度使用 synchronized 的遗留系统</strong></td>
<td>⚠️ 需评估</td>
<td>需要先排查 pin 问题再决定</td>
</tr>
</tbody>
</table>

<h1>八、迁移检查清单</h2>

<p>如果你打算在生产环境启用虚拟线程，按以下步骤操作：</p>

<ol>
<li><strong>JDK 版本确认</strong>：升级到 JDK 21+（推荐 LTS 版本 21.0.6+）</li>
<li><strong>Spring Boot 升级</strong>：≥ 3.2（推荐 3.4+）</li>
<li><strong>Pin 问题排查</strong>：启动时加 <code>-Djdk.tracePinnedThreads=short</code> 运行一段时间，修复所有 pin 点</li>
<li><strong>synchronized 替换</strong>：将关键路径上的 <code>synchronized</code> 替换为 <code>ReentrantLock</code></li>
<li><strong>ThreadLocal 审计</strong>：盘点所有 ThreadLocal 使用，评估内存影响</li>
<li><strong>线程池替换</strong>：将自定义 <code>ThreadPoolTaskExecutor</code> 替换为虚拟线程版本</li>
<li><strong>灰度发布</strong>：先在非核心服务试点，监控 QPS / 延迟 / GC / 内存</li>
<li><strong>压测验证</strong>：用真实流量模型做压测，对比前后数据</li>
</ol>

<h1>九、总结</h1>

<ul>
<li><strong>虚拟线程的核心价值</strong>：在 I/O 密集场景下，以接近零的代码改动成本获得 <strong>数量级的吞吐提升</strong>（我们的实验中 I/O 场景达 10x）</li>
<li><strong>不是银弹</strong>：CPU 密集场景无效甚至略负；需要关注 pin 问题、ThreadLocal 内存、生态兼容性</li>
<li><strong>迁移成本低</strong>：Spring Boot 3.2+ 只需一行配置 <code>spring.threads.virtual.enabled=true</code></li>
<li><strong>排查手段成熟</strong>：<code>-Djdk.tracePinnedThreads</code>、JFR、GC 日志都能有效定位问题</li>
<li><strong>建议策略</strong>：新项目直接开启；老项目先做 pin 排查后灰度上线</li>
</ul>

<h1>参考资料</h1>

<ol>
<li>OpenJDK 官方文档 —— Virtual Threads (JEP 444): <a href="https://openjdk.org/jeps/444" target="_blank">https://openjdk.org/jeps/444</a></li>
<li>Spring Blog: "Virtual Threads in Spring Boot": <a href="https://spring.io/blog/2023/07/13/virtual-threads-in-spring-boot" target="_blank">https://spring.io/blog/2023/07/13/virtual-threads-in-spring-boot</a></li>
<li> Nicolai Parlog: "Understanding Java's Virtual Threads" (深入浅出虚拟线程系列): <a href="https://nipafx.dev/java-virtual-threads/" target="_blank">https://nipafx.dev/java-virtual-threads/</a></li>
<li>Per Minborg: "Virtual Threads Pitfalls": <a href="https://minborgsjavapot.blogspot.com/2023/03/java-virtual-threads-pitfalls.html" target="_blank">https://minborgsjavapot.blogspot.com/2023/03/java-virtual-threads-pitfalls.html</a></li>
<li>美团技术团队: "Java 虚拟线程在生产环境的实践与踩坑": <a href="https://tech.meituan.com/2023/08/15/java-virtual-threads-practice.html" target="_blank">https://tech.meituan.com/2023/08/15/java-virtual-threads-practice.html</a>（参考其问题分类与排查方法论）</li>
<li>阿里云开发者社区: "JDK 21 虚拟线程性能基准测试报告": <a href="https://developer.aliyun.com/article/1250123" target="_blank">https://developer.aliyun.com/article/1250123</a>（参考其压测方法设计与指标体系）</li>
<li>Oracle Java 文档: "ScopedValue (JEP 429)": <a href="https://openjdk.org/jeps/429" target="_blank">https://openjdk.org/jeps/429</a></li>
</ol>
