---
title: Java 虚拟线程实战——从原理到 Spring Boot 压测全链路
date: 2026-08-20 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Virtual Threads
  - Project Loom
  - Spring Boot
  - JVM
  - 性能优化
---
<hr>
<blockquote><p>虚拟线程（Virtual Threads）是 JDK 21 正式转正的轻量级并发模型，它让「每个请求一个线程」的同步编程风格在高并发 I/O 场景下重新变得可扩展。本文从原理出发，用实际压测数据对比虚拟线程与传统线程池的性能差异，并给出 Spring Boot 集成、Pinning 排查和生产注意事项。</p></blockquote>

<!-- more -->

<h1 id="背景为什么要关心虚拟线程">背景：为什么要关心虚拟线程？</h1>

<p>先说一个大多数后端开发者都遇到过的问题：</p>

<pre><code>你的 Spring MVC 接口平均耗时 50ms（其中 40ms 在等数据库和网络 I/O），
系统要撑到 2000 QPS → 按 Little's Law 大约需要 100 个并发线程。
如果接口慢到 500ms（下游变慢了），同样 2000 QPS 就需要约 1000 个并发线程。
而每个平台线程默认吃 ~1MB 栈内存 + 操作系统调度开销……</code></pre>

<p><strong>平台线程</strong>（Platform Thread）就是咱们用了二十多年的 <code>java.lang.Thread</code>，它本质上是对操作系统内核线程的一层薄封装——<strong>一对一映射</strong>。创建它、销毁它、在它之间切换上下文，都要经过操作系统内核，代价不低。</p>

<p>传统解法是<strong>线程池</strong>（<code>ThreadPoolExecutor</code>）。线程池能复用线程、限制最大并发数，但它改变不了一个根本事实：<strong>平台线程数量仍然受操作系统线程数、内存和调度成本的限制</strong>。当并发请求继续增加，线程池里的线程会被排队任务占满，吞吐量很快卡住。</p>

<p>还有一条路是<strong>异步/响应式编程</strong>（Reactor/WebFlux/CompletableFuture），把线程从等待 I/O 中释放出来。但代价也明显：调用链被拆成回调或链式调用，异常处理、调试、火焰图分析都会变复杂。</p>

<p><strong>虚拟线程</strong>（Virtual Thread）就是为这个问题来的。它是 JDK 21 通过 <a href="https://openjdk.org/jeps/444"><strong>JEP 444</strong></a>正式引入的轻量级线程，由 JDK 自己调度而不是操作系统。一个虚拟线程阻塞等 I/O 时，JDK 可以把它从底层平台线程上<strong>卸载</strong>下来，让这个平台线程去干别的活。等 I/O 就绪了，再把它挂回去继续执行。</p>

<p>简单类比：</p>
<table>
<thead>
<tr><th style="text-align:center">概念</th><th style="text-align:center">类比</th></tr>
</thead>
<tbody>
<tr><td>平台线程 ↔ OS 线程</td><td>每个快递员只能送一单，送完才能接下一单</td></tr>
<tr><td>虚拟线程 ↔ 平台线程</td><td>每个快递员同时拿 100 单，到了某个地方放下货就去下一家，回头再取件</td></tr>
</tbody>
</table>

<h1 id="核心原理虚拟线程是怎么工作的">核心原理：虚拟线程是怎么工作的？</h1>

<h2 id="三层关系">三层关系</h2>

<p>理解虚拟线程需要搞清三个层次的关系：</p>

<pre><code>┌─────────────────────────────────┐
│         虚拟线程 (Virtual Thread)   │  ← 业务代码看到的 Thread
│  （由 JDK 调度器管理，非常轻量）    │
├─────────────────────────────────┤
│        平台线程 (Platform Thread)  │  ← Carrier Thread（载体线程）
│     （= 操作系统线程的薄封装）       │
├─────────────────────────────────┤
│          操作系统线程               │  ← OS 内核调度
└─────────────────────────────────┘</code></pre>

<ul>
<li><strong>虚拟线程</strong>：任务的承载者。<code>Thread.currentThread()</code> 返回的就是它。数量可以非常多（百万级不是梦）。</li>
<li><strong>平台线程</strong>：虚拟线程的载体（Carrier Thread）。真正执行 Java 代码的是它。</li>
<li><strong>操作系统线程</strong>：只认识平台线程，不知道虚拟线程的存在。</li>
</ul>

<h2 id="挂载与卸载mount--unmount">挂载与卸载（Mount / Unmount）</h2>

<p>这是虚拟线程的核心魔法：</p>

<ol>
<li>虚拟线程开始执行时，被 JDK 调度器<strong>挂载</strong>（mount）到某个空闲的平台线程上。</li>
<li>当虚拟线程执行到支持挂起的阻塞操作（如网络 I/O、<code>BlockingQueue.take()</code>、<code>Future.get()</code>）时，JDK 把它从平台线程上<strong>卸载</strong>（unmount）下来，平台线程立刻腾出来服务其他虚拟线程。</li>
<li>等阻塞操作就绪后，虚拟线程被重新提交回调度器，再次挂载到某个平台线程继续执行。</li>
</ol>

<p><strong>关键点</strong>：这个过程对业务代码完全透明。你写的仍然是普通的同步代码：</p>

<pre><code class="language-java">// 这段代码在虚拟线程里跑的时候，
// 每次 httpClient.send() 和 repository.query() 阻塞期间，
// 底层平台线程都会被释放给其他虚拟线程使用
String body = httpClient.send(request, BodyHandlers.ofString()).body();
Result result = repository.query(body);
return service.handle(result);</code></pre>

<h2 id="调度器是谁">调度器是谁？</h2>

<p>JDK 的虚拟线程调度器是一个采用 <strong>FIFO 模式</strong> 的 work-stealing <strong>ForkJoinPool</strong>（注意：和并行流用的 common pool <strong>不是同一个</strong>池子）。</p>

<p>可以通过以下 JVM 参数调整：</p>

<table>
<thead>
<tr><th style="text-align:left">参数</th><th style="text-align:left">含义</th><th style="text-align:center">默认值</th></tr>
</thead>
<tbody>
<tr><td><code>jdk.virtualThreadScheduler.parallelism</code></td><td>调度器目标并行度</td><td>≈ CPU 核心数</td></tr>
<tr><td><code>jdk.virtualThreadScheduler.maxPoolSize</code></td><td>载体线程上限</td><td>256</td></tr>
</tbody>
</table>

<pre><code>注：绝大多数业务系统不需要改这两个参数。
优先排查连接池、限流、锁和阻塞点，通常比调整调度器参数更有效。</code></pre>

<h2 id="什么是-pinning-固定">什么是 Pinning（固定）？</h2>

<p><strong>Pinning</strong> 是虚拟线程最著名的坑。意思是：虚拟线程在某些情况下<strong>没法从载体线程上卸载</strong>，会连带占住底层的操作系统线程，扩展性大打折扣。</p>

<p>在 <strong>JDK 21~23</strong> 中，最典型的 Pinning 场景是：</p>

<pre><code class="language-java">// ❌ JDK 21-23 中：synchronized 里做阻塞 I/O 会导致 Pinning
public synchronized String loadConfig() throws IOException {
    return remoteClient.get("/config");  // 阻塞期间占住载体线程！
}</code></pre>

<p><strong>为什么？</strong> 因为 <code>synchronized</code> 锁的实现依赖对象头的 mark word，而虚拟线程卸载/重挂载时难以保证锁状态的正确迁移。所以 JDK 选择在进入 <code>synchronized</code> 块时把虚拟线程「钉」在当前载体线程上。</p>

<p><strong>JDK 24 的 JEP 491</strong> 改进了这一点，使虚拟线程在 <code>synchronized</code> 中阻塞时也能释放底层平台线程，消除了绝大多数 Pinning 场景。但 native 方法调用和 FFM（Foreign Function & Memory API）相关代码仍需关注。</p>

<h1 id="实战一创建虚拟线程的四种方式">实战一：创建虚拟线程的四种方式</h1>

<h2 id="方式一-threadstartvirtualthread-最简">方式一：<code>Thread.startVirtualThread()</code> —— 最简</h2>

<pre><code class="language-java">public class Demo1 {
    public static void main(String[] args) throws InterruptedException {
        Thread thread = Thread.startVirtualThread(() -> {
            System.out.println("Hello from " + Thread.currentThread());
        });
        thread.join(); // 虚拟线程是守护线程，main 不等它的话 JVM 可能直接退出
    }
}
// 输出类似：Hello from VirtualThread[#1]/runnable@ForkJoinPool-1-worker-1</code></pre>

<h2 id="方式二-threadofvirtual-带名字">方式二：<code>Thread.ofVirtual()</code> —— 带名字</h2>

<pre><code class="language-java">public class Demo2 {
    public static void main(String[] args) throws InterruptedException {
        // 先创建不启动
        Thread unstarted = Thread.ofVirtual()
            .name("order-query")
            .unstarted(() -> System.out.println("querying order..."));
        unstarted.start();
        unstarted.join();

        // 创建并立即启动
        Thread started = Thread.ofVirtual()
            .name("payment-check")
            .start(() -> System.out.println("checking payment..."));
        started.join();
    }
}</code></pre>

<h2 id="方式三-threadfactory-交给框架用">方式三：<code>ThreadFactory</code> —— 交给框架用</h2>

<pre><code class="language-java">import java.util.concurrent.ThreadFactory;

public class Demo3 {
    public static void main(String[] args) throws InterruptedException {
        ThreadFactory factory = Thread.ofVirtual()
            .name("worker-", 0)  // 自动编号：worker-0, worker-1, ...
            .factory();

        Thread t1 = factory.newThread(() -> System.out.println("task-1 on " + Thread.currentThread()));
        Thread t2 = factory.newThread(() -> System.out.println("task-2 on " + Thread.currentThread()));
        t1.start(); t1.join();
        t2.start(); t2.join();
    }
}</code></pre>

<h2 id="方式四-executorsnewvirtualthreadpertaskexecutor-最常用">方式四：<code>Executors.newVirtualThreadPerTaskExecutor()</code> —— 最常用</h2>

<pre><code class="language-java">import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public class Demo4 {
    public static void main(String[] args) throws Exception {
        // 注意：这不是传统意义上的线程池！
        // 它不会复用虚拟线程，而是每个任务创建一个新的虚拟线程
        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            Future&lt;String&gt; f1 = executor.submit(() -&gt; "result from task-1");
            Future&lt;Integer&gt; f2 = executor.submit(() -&gt; 42);
            
            System.out.println(f1.get());  // result from task-1
            System.out.println(f2.get());  // 42
        }
        // close() 会等待已提交的任务完成（类似 shutdown() + awaitTermination()）
    }
}

/*
 * ⚠️ 关键认知转变：
 *   平台线程时代：线程很贵 → 必须池化复用
 *   虚拟线程时代：线程很便宜 → 每个任务一个新线程，不要池化！
 */</code></pre>

<h1 id="实战二压测对比虚拟线程-vs-传统线程池">实战二：压测对比——虚拟线程 vs 传统线程池</h1>

<h2 id="测试场景设计">测试场景设计</h2>

<p>我们用一个模拟高并发 I/O 的基准测试来对比两种方案：</p>

<ul>
<li><strong>任务</strong>：10,000 个并发任务，每个任务模拟 100ms 的 I/O 等待（<code>Thread.sleep(100)</code>）</li>
<li><strong>方案 A</strong>：传统固定大小线程池（200 线程）</li>
<li><strong>方案 B</strong>：虚拟线程（<code>newVirtualThreadPerTaskExecutor</code>）</li>
<li><strong>指标</strong>：总耗时、吞吐量（tasks/sec）、内存占用估算</li>
</ul>

<pre><code class="language-java">import java.time.Duration;
import java.util.concurrent.*;
import java.util.stream.IntStream;

/**
 * 虚拟线程 vs 传统线程池 压测对比
 *
 * 运行要求：JDK 21+
 * 编译：javac BenchmarkCompare.java
 * 运行：java BenchmarkCompare
 */
public class BenchmarkCompare {

    static final int TASK_COUNT = 10_000;
    static final Duration IO_WAIT = Duration.ofMillis(100);

    public static void main(String[] args) throws Exception {
        System.out.println("=== 环境 ===");
        System.out.println("JVM: " + Runtime.version());
        System.out.println("CPU 核心: " + Runtime.getRuntime().availableProcessors());
        System.out.println("任务数: " + TASK_COUNT);
        System.out.println("每任务模拟 I/O 等待: " + IO_WAIT.toMillis() + "ms");
        System.out.println();

        // ---- 方案 A：传统线程池 ----
        System.out.println("--- 方案 A：FixedThreadPool(200) ---");
        long aStart = System.currentTimeMillis();
        try (var executor = Executors.newFixedThreadPool(200)) {
            CountDownLatch latch = new CountDownLatch(TASK_COUNT);
            IntStream.range(0, TASK_COUNT).forEach(i -&gt;
                executor.submit(() -&gt; {
                    try { Thread.sleep(IO_WAIT); } catch (InterruptedException e) {}
                    latch.countDown();
                })
            );
            latch.await();
        }
        long aCost = System.currentTimeMillis() - aStart;
        double aThroughput = TASK_COUNT * 1000.0 / aCost;
        System.out.printf("总耗时: %d ms\n", aCost);
        System.out.printf("吞吐量: %.0f tasks/sec\n", aThroughput);
        System.out.printf("理论最小批次数: %.0f 批（每批 200 任务 × 100ms）\n",
            Math.ceil(TASK_COUNT / 200.0));
        System.out.println();

        // ---- 方案 B：虚拟线程 ----
        System.out.println("--- 方案 B：Virtual Threads ---");
        long bStart = System.currentTimeMillis();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            CountDownLatch latch = new CountDownLatch(TASK_COUNT);
            IntStream.range(0, TASK_COUNT).forEach(i -&gt;
                executor.submit(() -&gt; {
                    try { Thread.sleep(IO_WAIT); } catch (InterruptedException e) {}
                    latch.countDown();
                })
            );
            latch.await();
        }
        long bCost = System.currentTimeMillis() - bStart;
        double bThroughput = TASK_COUNT * 1000.0 / bCost;
        System.out.printf("总耗时: %d ms\n", bCost);
        System.out.printf("吞吐量: %.0f tasks/sec\n", bThroughput);
        System.out.println();

        // ---- 对比汇总 ----
        System.out.println("=== 对比汇总 ===");
        System.out.printf("| 指标              | FixedThreadPool(200) | VirtualThreads |\n");
        System.out.printf("|-------------------|---------------------|---------------|\n");
        System.out.printf("| 总耗时 (ms)       | %,d                  | %,d            |\n", aCost, bCost);
        System.out.printf("| 吞吐 (tasks/sec)  | %,.0f                | %,.0f          |\n", aThroughput, bThroughput);
        System.out.printf("| 加速比            | 1x                  | %.1fx          |\n",
            (double) aCost / bCost);
    }
}</code></pre>

<h2 id="预期结果与分析">预期结果与分析</h2>

<p>在一台 4 核机器上的典型输出：</p>

<table>
<thead>
<tr><th style="text-align:center">指标</th><th style="text-align:center">FixedThreadPool(200)</th><th style="text-align:center">VirtualThreads</th></tr>
</thead>
<tbody>
<tr><td>总耗时</td><td>~5,000 ms</td><td>~150–300 ms</td></tr>
<tr><td>吞吐量</td><td>~2,000 tasks/sec</td><td>~33,000–66,000 tasks/sec</td></tr>
<tr><td>加速比</td><td>1x</td><td><strong>17~33x</strong></td></tr>
</tbody>
</table>

<p><strong>为什么差距这么大？</strong></p>

<ul>
<li><strong>方案 A</strong>：200 个线程同时 sleep，每批处理 200 个任务，10,000 ÷ 200 = 50 批，每批 ≥100ms → 总计 ≈5 秒。</li>
<li><strong>方案 B</strong>：10,000 个虚拟线程几乎同时进入 sleep 状态，sleep 期间全部卸载，载体线程去干别的了。所有任务在 ~100ms（加上调度开销）内完成。</li>
</ul>

<pre><code>⚠️ 重要提醒：
上面的数字是「纯 I/O 等待」场景的理想情况。
真实业务中你还会遇到：
  • 数据库连接池上限（比如 HikariCP 默认 10）
  • HTTP 客户端连接池限制
  • 下游接口限流（HTTP 429）
  • 锁竞争、GC 暂停、CPU 瓶颈

虚拟线程让「等待」变便宜了，但不会让数据库连接变多、不会让 CPU 变快。
压测时一定要同时观察连接池利用率和下游错误率！</code></pre>

<h1 id="实战三spring-boot-集成虚拟线程">实战三：Spring Boot 集成虚拟线程</h1>

<h2 id="前置条件">前置条件</h2>

<ul>
<li>JDK 21 或更高版本</li>
<li>Spring Boot 3.2+（官方推荐 3.4+ 以获得更好的 Tomcat 支持）</li>
</ul>

<h2 id="一步开启">一步开启</h2>

<p>在 <code>application.yml</code> 中加一行配置：</p>

<pre><code class="language-yaml">spring:
  threads:
    virtual:
      enabled: true
  # 虚拟线程是守护线程，如果应用有 @Scheduled 等后台任务
  # 建议 keep-alive 防止 JVM 提前退出
  main:
    keep-alive: true</code></pre>

<p>就这么简单。开启之后，Tomcat 的请求处理线程会被替换为虚拟线程，你现有的 <code>@RestController</code>、<code>@Service</code> 代码<strong>不需要任何改动</strong>。</p>

<pre><code>注：开启虚拟线程后，以下配置不再按原来的方式生效：
  • spring.tomcat.max-threads（Tomcat 最大线程数）
  • spring.thread-pool 相关配置
  • 自定义 ThreadPoolTaskExecutor 作为 Web 异步处理器

因为虚拟线程调度依赖 JVM 内部的 ForkJoinPool，
不再是「配置 N 个线程排队处理请求」的模式。</code></pre>

<h2 id="写个接口验证一下">写个接口验证一下</h2>

<pre><code class="language-java">@RestController
@RequestMapping("/api/demo")
public class VtDemoController {

    @GetMapping("/info")
    public Map&lt;String, Object&gt; info() {
        Thread t = Thread.currentThread();
        return Map.of(
            "threadName", t.getName(),
            "isVirtual", t.isVirtual(),
            "threadClass", t.getClass().getName()
        );
    }

    @GetMapping("/io-simulate")
    public String ioSimulate() throws InterruptedException {
        // 模拟一次远程调用（100ms）
        Thread.sleep(100);
        // 再模拟一次数据库查询（50ms）
        Thread.sleep(50);
        return "done on " + Thread.currentThread().getName();
    }
}</code></pre>

<p>访问 <code>GET /api/demo/info</code>，你会看到类似：</p>

<pre><code>{
  "threadName": "tomcat-handler-0",
  "isVirtual": true,
  "threadClass": "java.lang.VirtualThread"
}</code></pre>

<p><code>isVirtual: true</code> 说明请求已经在虚拟线程上跑了 ✅</p>

<h2 id="用-wrk-或-ab-压测">用 wrk 或 ab 压测</h2>

<pre><code># 安装 wrk（如果没有的话）
# Ubuntu: apt install wrk
# Mac: brew install wrk

# 压测 I/O 密集型接口（建议在非生产环境运行）
wrk -t4 -c100 -d30s http://localhost:8080/api/demo/io-simulate

# 输出关注项：
#   Latency 分布（avg / max / p50 / p90 / p99）
#   Requests/sec
#   Socket errors（如果有说明连接池或端口不够）

# 对比方法：先把 spring.threads.virtual.enabled=false 重启，
# 再跑一遍同样的 wrk 命令，对比 QPS 和 P99 延迟</code></pre>

<h1 id="实战四用-jfr-排查-pinning-问题">实战四：用 JFR 排查 Pinning 问题</h1>

<h2 id="开启-jfr-录制">开启 JFR 录制</h2>

<pre><code class="language-bash"># 启动应用时添加 JFR 参数
java -XX:StartFlightRecording=duration=60s,filename=vt-recording.jfr,settings=profile \
     -Djdk.tracePinnedThreads=short \
     -jar your-app.jar

# jdk.tracePinnedThreads=short 会在发生 Pinning 时打印简要栈信息
# （仅用于开发/测试诊断，不要在生产环境长期开着）</code></pre>

<h2 id="虚拟线程相关事件">虚拟线程相关事件</h2>

<p>JFR 中和虚拟线程直接相关的事件：</p>

<table>
<thead>
<tr><th style="text-align:left">事件名</th><th style="text-align:left">含义</th><th style="text-align:center">用途</th></tr>
</thead>
<tbody>
<tr><td><code>jdk.VirtualThreadStart</code></td><td>虚拟线程启动</td><td>统计创建速率</td></tr>
<tr><td><code>jdk.VirtualThreadEnd</code></td><td>虚拟线程结束</td><td>生命周期分析</td></tr>
<tr><td><code>jdk.VirtualThreadPinned</code></td><td>虚拟线程被固定（无法卸载）</td><td><strong>Pinning 排查重点</strong></td></tr>
<tr><td><code>dk.VirtualThreadSubmitFailed</code></td><td>虚拟线程提交失败</td><td>调度器过载信号</td></tr>
</tbody>
</table>

<p>使用 <code>jfr</code> 工具解析：</p>

<pre><code class="language-bash"># 查看 Pinning 事件
jfr print --events jdk.VirtualThreadPinned vt-recording.jfr

# 统计 Pinning 发生频率
jfr print --events jdk.VirtualThreadPinned vt-recording.jfr \
  | grep "startTime" | wc -l</code></pre>

<h2 id="线程转储">线程转储</h2>

<pre><code class="language-bash"># 获取进程 PID
jps -l | grep your-app

# 导出 JSON 格式线程转储（适合工具分析大量虚拟线程）
jcmd &lt;PID&gt; Thread.dump_to_file -format=json thread-dump.json

# 或者文本格式
jcmd &lt;PID&gt; Thread.dump_to_file -format=text thread-dump.txt</code></pre>

<h1 id="常见坑与误区">常见坑与误区</h1>

<h2 id="坑1虚拟线程不是-cpu-加速器">坑 1：虚拟线程不是 CPU 加速器</h2>

<p>如果你跑的是 CPU 密集型任务（加密、压缩、复杂计算、大数据排序），虚拟线程不会让它变快。CPU 密集型任务应该用并行流（<code>parallelStream()</code>）、专门的计算线程池、或者干脆减少计算量。</p>

<pre><code class="language-java">// ❌ 虚拟线程跑密集计算 → 不会更快，调度开销反而可能拖慢
executor.submit(() -&gt; {
    BigInteger result = BigInteger.ONE;
    for (int i = 0; i &lt; 1_000_000; i++) {
        result = result.multiply(BigInteger.valueOf(i));
    }
});

// ✅ CPU 密集型用 ForkJoinPool 或 parallelStream
List&lt;BigInteger&gt; results = data.parallelStream()
    .map(this::heavyComputation)
    .toList();</code></pre>

<h2 id="坑2不要池化虚拟线程">坑 2：不要池化虚拟线程</h2>

<p>这是官方文档反复强调的：<strong>Do not pool virtual threads</strong>。虚拟线程本身不贵，池化它们没有意义，还会把「每个任务一个线程」的好模型绕回旧思路。如果需要限制并发，应该限制具体资源（Semaphore、连接池、限流器），而不是限制线程数量。</p>

<h2 id="坑3threadlocal-可能成为内存杀手">坑 3：ThreadLocal 可能成为内存杀手</h2>

<p>以前在线程池里，一个 <code>ThreadLocal&lt;SimpleDateFormat&gt;</code> 只对应几十到几百个平台线程。切到虚拟线程后，「每个任务一个虚拟线程」意味着同样的写法可能变成<strong>每个任务一份缓存对象</strong>。如果 ThreadLocal 缓存的是大对象（数据库连接、大数组、复杂 Formatter），内存压力会被放大几十倍。</p>

<pre><code class="language-java">// ⚠️ 危险：每个虚拟线程都创建一份 DateFormat
private static final ThreadLocal&lt;DateFormat&gt; DF = ThreadLocal.withInitial(
    () -&gt; new SimpleDateFormat("yyyy-MM-dd HH:mm:ss")  // 每个虚拟线程一份！
);

// ✅ 更好的选择：用 DateTimeFormatter（不可变、线程安全）
private static final DateTimeFormatter DT_FMT =
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");</code></pre>

<p>JDK 25 通过 <a href="https://openjdk.org/jeps/506"><strong>JEP 506</strong></a> 将 Scoped Values 转正，更适合在大量虚拟线程之间传递不可变上下文。</p>

<h2 id="坑4连接池会成为新瓶颈">坑 4：连接池会成为新瓶颈</h2>

<p>很多服务迁移到虚拟线程后，第一个瓶颈不再是业务线程池，而是：</p>

<ul>
<li><strong>数据库连接池</strong>（HikariCP 默认最大 10 个连接）</li>
<li><strong>HTTP 客户端连接池</strong>（Apache HttpClient、OkHttp、RestTemplate 底层都有连接池）</li>
<li><strong>Redis 连接数</strong>（Lettuce/Jedis 连接限制）</li>
<li><strong>下游限流</strong>（HTTP 429 Too Many Requests）</li>
</ul>

<p>这不是虚拟线程的问题——虚拟线程只是让更多任务有机会同时推进。<strong>真正的共享资源仍然要按容量管理</strong>。</p>

<pre><code class="language-yaml"># 典型的「虚拟线程开启后要跟着调」的配置
spring:
  datasource:
    hikari:
      maximum-pool-size: 20   # 从默认 10 往上调
      minimum-idle: 5

  # 如果用 WebClient / RestTemplate 调外部服务
http:
  client:
    max-connections: 200
    max-connections-per-route: 50</code></pre>

<h2 id="坑5不要混用太多异步模型">坑 5：不要混用太多异步模型</h2>

<p>虚拟线程最适合同步阻塞代码。已经用 Reactive/WebFlux/Netty 写成全链路异步的系统，不一定能因为打开虚拟线程就获得明显收益。</p>

<p>更麻烦的是<strong>混用</strong>：外层虚拟线程，内层又大量使用异步回调和线程池。排查问题时可能同时面对虚拟线程、事件循环、业务线程池、连接池几套上下文，调试体验极差。</p>

<pre><code>迁移建议：
  1. 先挑一个同步阻塞的 I/O 密集型接口试点
  2. 开启虚拟线程，压测对比 QPS/P99
  3. 观察 JFR 中是否有异常 Pinning
  4. 确认连接池没有成为新瓶颈
  5. 再逐步推广到其他接口</code></pre>

<h1 id="总结">总结</h1>

<table>
<thead>
<tr><th style="text-align:left">要点</th><th style="text-align:left">关键信息</th></tr>
</thead>
<tbody>
<tr><td><strong>是什么</strong></td><td>JDK 21 正式引入的轻量级线程，由 JDK 调度而非 OS</td></tr>
<tr><td><strong>解决什么</strong></td><td>高并发 I/O 场景下平台线程数量不足导致的吞吐瓶颈</td></tr>
<tr><td><strong>不适合什么</strong></td><td>CPU 密集型加速、替代所有异步模型</td></tr>
<tr><td><strong>Spring Boot 开启</strong></td><td><code>spring.threads.virtual.enabled=true</code>（需 JDK 21+ / Boot 3.2+）</td></tr>
<tr><td><strong>核心优势</strong></td><td>保留同步代码风格的同时大幅提升 I/O 密集型吞吐</td></tr>
<tr><td><strong>最大风险</strong></td><td>Pinning（JDK 24 已基本解决 synchronized 问题）、连接池成为新瓶颈、ThreadLocal 内存放大</td></tr>
<tr><td><strong>迁移策略</strong></td><td>选试点接口 → 压测对比 → 观察 JFR → 调整连接池 → 逐步推广</td></tr>
</tbody>
</table>

<p>虚拟线程不是银弹，但在正确的场景下（高并发 I/O 密集型同步代码），它能带来<strong>数量级的吞吐提升</strong>，而且不需要重写成复杂的异步链路。对于还在用传统线程池跑 Spring MVC 的团队来说，这可能是近几年 JDK 带来的最实用的性能红利之一。</p>

<h1 id="参考资料">参考资料</h1>

<ol>
<li><a href="https://openjdk.org/jeps/444">JEP 444: Virtual Threads（正式规范）</a> — OpenJDK 官方</li>
<li><a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html">Oracle Java 21 Documentation: Virtual Threads</a> — Oracle 官方文档</li>
<li><a href="https://openjdk.org/jeps/491">JEP 491: Synchronize Virtual Threads without Pinning</a> — JDK 24 Pinning 改进</li>
<li><a href="https://javaguide.cn/java/concurrent/virtual-thread.html">虚拟线程常见问题总结 — JavaGuide</a> — 中文社区最全面的 FAQ 级参考</li>
<li><a href="https://blog.marcnuri.com/java-virtual-threads-project-loom-complete-guide">Java Virtual Threads Complete Guide — Marc Nuri</a> — 含 JMH 基准测试代码</li>
<li><a href="https://spring.io/blog/2022/10/11/embracing-virtual-threads/">Spring Blog: Embracing Virtual Threads</a> — Spring 官方视角</li>
<li><a href="https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.virtual-threads">Spring Boot Reference Documentation: Virtual threads</a> — 配置指南</li>
<li><a href="https://inside.java/2024/02/04/sip094/">Inside Java: Managing Throughput with Virtual Threads</a> — Oracle 工程师的生产经验分享</li>
</ol>
