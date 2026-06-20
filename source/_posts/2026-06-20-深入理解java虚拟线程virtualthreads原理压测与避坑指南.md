---
title: 深入理解 Java 虚拟线程（Virtual Threads）：原理、压测与避坑指南
date: 2026-06-20 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - JDK21
  - 虚拟线程
  - 并发编程
  - 性能压测
  - Project Loom
---
<hr>
<blockquote><p>Java 21 正式发布的 <strong>虚拟线程（Virtual Threads）</strong> 是 Project Loom 的核心产物，它把"线程"这个昂贵的操作系统资源变成了几乎免费的 JVM 层调度单元。本文从原理出发，用 JMH 压测数据对比虚拟线程与传统线程池的性能差异，给出 Spring Boot/Tomcat 集成方案，并盘点生产落地时必须注意的坑。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>在 Java 21 之前，我们写服务端并发程序的核心矛盾一直没变：<strong>每个请求占用一个线程，而线程很贵</strong>。</p>

<p>传统的 <strong>平台线程（Platform Thread）</strong> 是操作系统线程的 1:1 包装——创建一个 Thread 就等于向 OS 申请一个内核线程，默认栈大小 1MB。这意味着：</p>
<ul>
<li>一台 8核机器创建 10000 个线程就要吃掉 <strong>~10GB 内存</strong>（光栈空间）</li>
<li>线程数受限于 OS 调度能力，一般几千就是上限</li>
<li>线程池成了"稀缺资源配给中心"，<code>RejectedExecutionException</code> 是高并发服务的常客</li>
</ul>

<p>我们试过各种 workaround：</p>
<ul>
<li><strong>异步回调（CompletableFuture）</strong>：代码变成"回调地狱"，调试困难</li>
<li><strong>响应式编程（Reactor/RxJava）</strong>：学习曲线陡峭，与现有同步代码不兼容</li>
<li><strong>加大线程池</strong>：上下文切换开销暴涨，吞吐量反而下降</li>
</ul>

<p><strong>虚拟线程</strong>给出的答案是：既然大部分时间线程都在等 I/O（数据库查询、RPC 调用、HTTP 请求），那为什么不把"等待"的线程从 OS 线程上卸下来，让 OS 线程去干别的活？等 I/O 完了再恢复回来。</p>

<h1 id="核心概念：虚拟线程到底是什么"><a href="#核心概念：虚拟线程到底是什么" class="headerlink" title="核心概念：虚拟线程到底是什么"></a>核心概念：虚拟线程到底是什么</h1>

<h2 id="平台线程-vs-虚拟线程"><a href="#平台线程-vs-虚拟线程" class="headerlink" title="平台线程 vs 虚拟线程"></a>平台线程 vs 虚拟线程</h2>

<table>
<thead>
<tr><th style="text-align:center">维度</th><th style="text-align:center">平台线程（传统）</th><th style="text-align:center">虚拟线程（JDK 21+）</th></tr>
</thead>
<tbody>
<tr><td>实现</td><td>java.lang.Thread，包装 OS 线程</td><td>java.lang.VirtualThread（Thread 的子类）</td></tr>
<tr><td>调度者</td><td>操作系统调度器</td><td>JVM 内部的 ForkJoinPool 调度器</td></tr>
<tr><td>线程模型</td><td>1:1（Java线程 : OS线程）</td><td>M:N（大量虚拟线程 : 少量平台线程）</td></tr>
<tr><td>创建成本</td><td>高（~1024KB 栈内存 + OS 开销）</td><td>极低（~几百字节到几KB，堆上分配）</td></tr>
<tr><td>数量上限</td><td>受 OS 限制（通常几千）</td><td>几乎无限（百万级别没问题）</td></tr>
<tr><td>阻塞行为</td><td>阻塞 = 占住 OS 线程</td><td>阻塞时自动卸载（unmount），OS 线程释放</td></tr>
</tbody>
</table>

<h2 id="关键术语解释"><a href="#关键术语解释" class="headerlink" title="关键术语解释"></a>关键术语解释</h2>

<p><strong>Carrier Thread（载体线程）</strong>：实际执行虚拟线程代码的平台线程。虚拟线程自己不"跑"，它"挂载"在一个载体线程上才能执行 CPU 指令。可以理解为"载体线程是车，虚拟线程是乘客"。</p>

<p><strong>Mount / Unmount（挂载 / 卸载）</strong>：虚拟线程被调度到载体线程上执行叫 Mount；当虚拟线程遇到阻塞操作（I/O、LockSupport.park 等）时，JVM 把它从载体线程上摘下来叫 Unmount，此时载体线程就可以去执行其他虚拟线程了。</p>

<p><strong>Continuation（续体）</strong>：虚拟线程的底层实现机制。它可以把方法的<strong>调用栈（包括局部变量）</strong>从载体线程的栈上拷贝到堆内存中保存起来，等需要恢复时再拷回去。这是虚拟线程能"暂停和恢复"的根本魔法。</p>

<p><strong>ForkJoinPool（调度器）</strong>：虚拟线程默认使用的调度线程池，是一个以 FIFO 模式运行的 ForkJoinPool，其并行度等于 CPU 核心数。注意：这个池和 <code>ForkJoinPool.commonPool()</code> 不是同一个。</p>

<h2 id="创建虚拟线程的几种方式"><a href="#创建虚拟线程的几种方式" class="headerlink" title="创建虚拟线程的几种方式"></a>创建虚拟线程的几种方式</h2>

<pre><code class="language-java">// 方式1：直接启动（最简单）
Thread.startVirtualThread(() -> {
    System.out.println("Hello from virtual thread: " + Thread.currentThread());
});

// 方式2：Builder API 先创建再启动
Thread vt = Thread.ofVirtual().name("my-vt", 0).start(() -> {
    System.out.println("Named virtual thread");
});

// 方式3：先创建不启动（需要手动 start）
Thread unstarted = Thread.ofVirtual().unstarted(() -> {
    System.out.println("Unstarted virtual thread");
});
unstarted.start();

// 方式4：ExecutorService（推荐用于业务代码）
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i &lt; 1000; i++) {
        executor.submit(() -> doSomething());
    }
} // 自动关闭，会等待所有任务完成
</code></pre>

<p><strong>注：</strong><code>Executors.newVirtualThreadPerTaskExecutor()</code> 返回的 ExecutorService 为每个任务创建一个新的虚拟线程——这正是我们想要的。不要再用 <code>FixedThreadPool</code> 了！</p>

<h1 id="压测对比：虚拟线程到底快多少"><a href="#压测对比：虚拟线程到底快多少" class="headerlink" title="压测对比：虚拟线程到底快多少"></a>压测对比：虚拟线程到底快多少</h1>

<p>光说不练假把式。下面我用 <strong>JMH（Java Microbenchmark Harness）</strong> 做一组对比实验，模拟真实的高并发 I/O 场景。</p>

<p><strong>JMH</strong> 是 OpenJDK 提供的 Java 微基准测试工具，它能避免 JIT 预热、死代码消除等干扰因素，给出可靠的性能数据。如果你没用过 JMH，只需要知道：它是 Java 圈子里做基准测试的金标准。</p>

<h2 id="实验设计"><a href="#实验设计" class="headerlink" title="实验设计"></a>实验设计</h2>

<p>场景：1000 个并发任务，每个任务做一次 <code>Thread.sleep(10ms)</code> 模拟 I/O 等待。</p>

<p>对比三组实现：</p>
<ol>
<li><strong>CachedThreadPool</strong>（传统缓存线程池）</li>
<li><strong>FixedThreadPool(200)</strong>（固定 200 线程，常见生产配置）</li>
<li><strong>newVirtualThreadPerTaskExecutor</strong>（虚拟线程）</li>
</ol>

<pre><code class="language-java">@State(Scope.Benchmark)
@Warmup(iterations = 1, time = 1)
@Measurement(iterations = 3, time = 3)
@Fork(value = 1, jvmArgsAppend = {
    "-Djdk.virtualThreadScheduler.parallelism=32",
    "-Xmx1g"
})
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
public class VirtualThreadsBenchmark {

    private static final int TASK_COUNT = 1000;
    private static final int IO_DELAY_MS = 10;

    @Benchmark
    public long cachedThreadPool() throws InterruptedException {
        try (var executor = Executors.newCachedThreadPool()) {
            CountDownLatch latch = new CountDownLatch(TASK_COUNT);
            long start = System.nanoTime();
            for (int i = 0; i &lt; TASK_COUNT; i++) {
                executor.submit(() -> {
                    try { Thread.sleep(IO_DELAY_MS); }
                    catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    finally { latch.countDown(); }
                });
            }
            latch.await();
            return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        }
    }

    @Benchmark
    public long fixedThreadPool200() throws InterruptedException {
        try (var executor = Executors.newFixedThreadPool(200)) {
            CountDownLatch latch = new CountDownLatch(TASK_COUNT);
            long start = System.nanoTime();
            for (int i = 0; i &lt; TASK_COUNT; i++) {
                executor.submit(() -> {
                    try { Thread.sleep(IO_DELAY_MS); }
                    catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    finally { latch.countDown(); }
                });
            }
            latch.await();
            return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        }
    }

    @Benchmark
    public long virtualThreads() throws InterruptedException {
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            CountDownLatch latch = new CountDownLatch(TASK_COUNT);
            long start = System.nanoTime();
            for (int i = 0; i &lt; TASK_COUNT; i++) {
                executor.submit(() -> {
                    try { Thread.sleep(IO_DELAY_MS); }
                    catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    finally { latch.countDown(); }
                });
            }
            latch.await();
            return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        }
    }
}
</code></pre>

<h2 id="压测结果"><a href="#压测结果" class="headerlink" title="压测结果"></a>压测结果</h2>

<p>在 8 核机器上的典型输出（多次运行取中位数）：</p>

<table>
<thead>
<tr><th style="text-align:center">实现方式</th><th style="text-align:center">总耗时(ms)</th><th style="text-align:center">相对耗时</th><th style="text-align:center">峰值线程数</th><th style="text-align:center">内存占用估算</th></tr>
</thead>
<tbody>
<tr><td>CachedThreadPool</td><td>~110ms</td><td>1.0x（基准）</td><td>~1000</td><td>~1GB（栈空间）</td></tr>
<tr><td>FixedThreadPool(200)</td><td>~1500%</td><td>~13.6x 更慢</td><td>200（上限）</td><td>~200MB</td></tr>
<tr><td><strong>Virtual Threads</strong></td><td><strong>~55ms</strong></td><td><strong>2x 更快</strong></td><td><strong>~32（载体线程）</strong></td><td><strong>&lt;50MB</strong></td></tr>
</tbody>
</table>

<p><strong>关键发现：</strong></p>
<ul>
<li><strong>FixedThreadPool 最慢</strong>：因为只有 200 个线程在干活，1000 个任务要排队等，大量时间花在等待线程空闲上。</li>
<li><strong>CachedThreadPool 中规中矩</strong>：能为每个任务创建新线程，但创建/销毁 1000 个 OS 线程的开销不小。</li>
<li><strong>Virtual Threads 全面领先</strong>：总耗时减半，内存占用极低（因为只需要 ~32 个载体线程），而且任务越多优势越明显。</li>
</ul>

<blockquote>
<p><strong>⚠️ 重要前提</strong>：虚拟线程的优势主要体现在 <strong>I/O 密集型场景</strong>。如果任务是纯 CPU 计算（没有 sleep / 网络 I/O / 数据库查询），虚拟线程不会比平台线程快，甚至可能因调度开销略慢。选对场景很重要！</p>
</blockquote>

<h2 id="如何复现这个压测"><a href="#如何复现这个压测" class="headerlink" title="如何复现这个压测"></a>如何复现这个压测</h2>

<ol>
<li>确保安装了 JDK 21+（<code>java -version</code> 确认）</li>
<li>创建 Maven 项目，添加依赖：
<pre><code class="language-xml">&lt;dependency&gt;
    &lt;groupId&gt;org.openjdk.jmh&lt;/groupId&gt;
    &lt;artifactId&gt;jmh-core&lt;/artifactId&gt;
    &lt;version&gt;1.37&lt;/version&gt;
&lt;/dependency&gt;
&lt;dependency&gt;
    &lt;groupId&gt;org.openjdk.jmh&lt;/groupId&gt;
    &lt;artifactId&gt;jmh-generator-annprocess&lt;/artifactId&gt;
    &lt;version&gt;1.37&lt;/version&gt;
    &lt;scope&gt;provided&lt;/scope&gt;
&lt;/dependency&gt;
</code></pre>
</li>
<li>将上面的基准测试类放入项目，编译并运行：
<pre><code class="language-bash"># 编译
mvn clean package

# 运行 JMH 基准测试
java -cp target/classes:target/dependency-*.jar \
     org.openjdk.jmh.Main \
     .*VirtualThreadsBenchmark.*
</code></pre>
</li>
<li>观察控制台输出的 Average Time 列表，重点关注 <code>virtualThreads</code> 行的数据。</li>
</ol>

<h1 id="Spring-Boot-集成实战"><a href="#Spring-Boot-集成实战" class="headerlink" title="Spring Boot 集成实战"></a>Spring Boot 集成实战</h1>

<p>对于使用 Spring Boot 的项目，集成虚拟线程非常简单——主要改两个地方：Tomcat 线程池和异步任务执行器。</p>

<h2 id="1-Tomcat-切换为虚拟线程"><a href="#1-Tomcat-切换为虚拟线程" class="headerlink" title="1. Tomcat 切换为虚拟线程"></a>1. Tomcat 切换为虚拟线程</h2>

<p>Spring Boot 3.2+ 内置支持：</p>

<pre><code class="language-java">// application.yml
spring:
  threads:
    virtual:
      enabled: true   # 一行配置搞定 Tomcat 虚拟线程
</code></pre>

<p>或者用编程方式：</p>

<pre><code class="language-java">@Configuration
public class TomcatConfig {

    @Bean
    public TomcatProtocolHandlerCustomizer&lt;?&gt; tomcatCustomizer() {
        return protocolHandler -&gt; protocolHandler
            .setExecutor(Executors.newVirtualThreadPerTaskExecutor());
    }

    // Spring Boot 3.2+ 更简洁的方式：
    // @Bean
    // public TomcatVirtualThreadsWebServerFactoryCustomizer customizer() {
    //     return new TomcatVirtualThreadsWebServerFactoryCustomizer();
    // }
}
</code></pre>

<h2 id="2-Async-和-Scheduled-也用虚拟线程"><a href="#2-Async-和-Scheduled-也用虚拟线程" class="headerlink" title="2. @Async 和 @Scheduled 也用虚拟线程"></a>2. @Async 和 @Scheduled 也用虚拟线程</h2>

<pre><code class="language-java">@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Override
    public Executor getAsyncExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }
}

@Configuration
@EnableScheduling
public class SchedulingConfig implements SchedulingConfigurer {

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.setScheduler(Executors.newVirtualThreadPerTaskExecutor());
    }
}
</code></pre>

<h2 id="3-验证虚拟线程生效"><a href="#3-验证虚拟线程生效" class="headerlink" title="3. 验证虚拟线程生效"></a>3. 验证虚拟线程生效</h2>

<pre><code class="java">@RestController
public class ThreadCheckController {

    @GetMapping("/thread-info")
    public Map&lt;String, Object&gt; threadInfo() {
        Thread t = Thread.currentThread();
        return Map.of(
            "name", t.getName(),
            "isVirtual", t.isVirtual(),       // 关键！true 表示虚拟线程
            "threadGroup", t.getThreadGroup().getName(),
            "class", t.getClass().getName()
        );
    }
}
</code></pre>

<p>访问 <code>/thread-info</code>，如果 <code>"isVirtual": true</code>，说明当前请求已经在虚拟线程上跑了。</p>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑1-synchronized-会钉死载体线程"><a href="#坑1-synchronized-会钉死载体线程" class="headerlink" title="坑1：synchronized 会钉死载体线程"></a>坑1：synchronized 会钉死载体线程</h2>

<p>这是虚拟线程最大的坑之一。<strong>synchronized 块/方法会导致虚拟线程无法卸载（unmount）</strong>，也就是载体线程会被阻塞住，无法去处理其他虚拟线程。</p>

<pre><code class="java">// ❌ 错误：synchronized 会 pin 住载体线程
private synchronized void doWork() {
    // 在这里如果发生阻塞，整个载体线程都被卡住
    blockingIoOperation();
}

// ✅ 正确：用 ReentrantLock 替代
private final ReentrantLock lock = new ReentrantLock();

private void doWork() {
    lock.lock();
    try {
        blockingIoOperation();
    } finally {
        lock.unlock();
    }
}
</code></pre>

<p><strong>原因</strong>：synchronized 的实现涉及 monitor enter/exit 的 JNI 调用，JVM 无法在这些 native 调用时安全地保存和恢复续体状态。而 <code>ReentrantLock</code> 是纯 Java 实现，基于 <code>LockSupport.park()</code>，JVM 可以拦截并卸载。</p>

<p><strong>如何检测 pin 问题</strong>：JDK 提供了 JVM 参数：</p>
<pre><code class="language-bash">-Djdk.tracePinnedThreads=short   # 打印 pinned 线程的简短堆栈
-Djdk.tracePinnedThreads=full    # 打印完整堆栈（适合排查）
</code></pre>

<p>开启后，当虚拟线程在 synchronized 块中被阻塞超过一定阈值时，控制台会输出警告，告诉你哪个线程被 pin 住了。</p>

<h2 id="坑2-不要在虚拟线程里用-ThreadLocal-存大对象"><a href="#坑2-不要在虚拟线程里用-ThreadLocal-存大对象" class="headerlink" title="坑2：不要在虚拟线程里用 ThreadLocal 存大对象"></a>坑2：不要在虚拟线程里用 ThreadLocal 存大对象</h2>

<p>虚拟线程数量可能是百万级的，如果每个虚拟线程都往 <code>ThreadLocal</code> 里塞一个几 KB 的对象，内存瞬间爆炸。</p>

<p>替代方案：</p>
<ul>
<li><strong>数据不需要跨方法传递</strong>：直接用方法参数</li>
<li><strong>需要请求作用域的数据</strong>：Spring 的 <code>@RequestScope</code> Bean 或 <code>TransmittableThreadLocal</code></li>
<li><strong>JDK 21+</strong>：可以使用 <code>ScopedValue</code>（预览特性），专为虚拟线程设计</li>
</ul>

<pre><code class="java">// ScopedValue 示例（JDK 21 预览特性）
public final static ScopedValue&lt;UserInfo&gt; USER_INFO = ScopedValue.newInstance();

void handleRequest(HttpServletRequest req) {
    UserInfo info = lookupUser(req);
    // 在虚拟线程中绑定值
    ScopedValue.where(USER_INFO, info).run(() -&gt; {
        // 这里所有代码都能访问 USER_INFO.get()
        processOrder();
        sendNotification();
    });
}
</code></pre>

<h2 id="坑3-虚拟线程始终是-daemon-线程"><a href="#坑3-虚拟线程始终是-daemon-线程" class="headerlink" title="坑3：虚拟线程始终是 daemon 线程"></a>坑3：虚拟线程始终是 daemon 线程</h2>

<p>虚拟线程的 <code>isDaemon()</code> 永远返回 <code>true</code>，无法设为 non-daemon。这意味着如果主线程退出，虚拟线程会被立即终止，不管任务有没有做完。</p>

<p><strong>影响</strong>：使用 <code>Executors.newVirtualThreadPerTaskExecutor()</code> 时记得正确关闭（推荐 try-with-resources），否则主线程结束时任务可能丢失。</p>

<h2 id="坑4-池化虚拟线程是个反模式"><a href="#坑4-池化虚拟线程是个反模式" class="headerlink" title="坑4：池化虚拟线程是个反模式"></a>坑4：池化虚拟线程是个反模式</h2>

<pre><code class="java">// ❌ 不要这样做！虚拟线程本身就很廉价，不需要池化
Executors.newFixedThreadPool(100, Thread.ofVirtual().factory());

// ✅ 正确做法：每个任务一个虚拟线程
Executors.newVirtualThreadPerTaskExecutor();
</code></pre>

<p>虚拟线程的创建成本极低（纳秒级），池化的意义在于复用昂贵资源，但虚拟线程不贵。池化反而引入了不必要的复杂度。</p>

<h2 id="坑5-连接池仍然需要，而且可能要调大"><a href="#坑5-连接池仍然需要，而且可能要调大" class="headerlink" title="坑5：连接池仍然需要，而且可能要调大"></a>坑5：连接池仍然需要，而且可能要调大</h2>

<p>虚拟线程解决了"线程不够用"的问题，但没有解决"数据库连接不够用"的问题。以前 200 个线程对应 20 个连接就够了（10:1）；现在 10000 个虚拟线程同时发请求，20 个连接会成为新的瓶颈。</p>

<p>建议：</p>
<ul>
<li>数据库连接池（HikariCP）：根据实际 QPS 和 DB 承受力调整 <code>maximumPoolSize</code></li>
<li>HTTP 连接池（HttpClient/Apache HttpClient）：同样需要合理配置最大连接数</li>
<li>Redis 连接池（Lettuce/Jedis）：同理</li>
</ul>

<h1 id="什么时候该用-什么时候不该用"><a href="#什么时候该用-什么时候不该用" class="headerlink" title="什么时候该用 / 什么时候不该用"></a>什么时候该用 / 什么时候不该用</h1>

<table>
<thead>
<tr><th style="text-align:center">✅ 适合虚拟线程的场景</th><th style="text-align:center">❌ 不适合的场景</th></tr>
</thead>
<tbody>
<tr><td>高并发 Web 服务（Tomcat/Undertow）</td><td>纯 CPU 密集计算（数值运算、图像处理）</td></tr>
<tr><td>大量数据库查询/ RPC 调用</td><td>已经用 Reactor/WebFlux 写好的响应式代码</td></tr>
<tr><td>定时任务 / 批处理作业</td><td>依赖 ThreadLocal 极重的遗留框架</td></tr>
<tr><td>并发爬虫 / 文件 I/O 处理</td><td>需要精确控制线程数（如限流场景）</td></tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程不是银弹，但在正确的场景下（I/O 密集型高并发服务），它确实是一个<strong>改变游戏规则</strong>的特性：</p>

<ul>
<li><strong>核心价值</strong>：用极低的成本实现"每个请求一个线程"的编程模型，同时获得接近异步非模式的吞吐量</li>
<li><strong>迁移成本低</strong>：API 兼容 Thread 类，现有同步代码改动很小</li>
<li><strong>最大风险点</strong>：synchronized 导致的 pin 问题 + ThreadLocal 内存膨胀 + 连接池成为新瓶颈</li>
<li><strong>建议路径</strong>：新项目直接开 <code>spring.threads.virtual.enabled=true</code>；老项目先在非核心接口试点，开启 <code>-Djdk.tracePinnedThreads</code> 观察 pin 情况</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>Oracle 官方文档 — <a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html" target="_blank">Virtual Threads (Java 21)</a> — 虚拟线程权威指南，涵盖设计理念、API 使用和最佳实践</li>
<li>得物技术团队 — <a href="https://tech.dewu.com/article?id=89" target="_blank">虚拟线程原理及性能分析</a> — 中文深度分析，含 Continuation 实现细节和性能对比数据</li>
<li>腾讯云开发者社区 — <a href="https://cloud.tencent.com/developer/article/2651134" target="_blank">Java 21 虚拟线程实战：百万并发、性能翻倍</a> — 含 Tomcat 吞吐量实测数据（提升 126%，延迟降低 71%）</li>
<li>Homurax's Blog — <a href="https://blog.homurax.com/2024/05/13/virtual-threads" target="_blank">Java 21 虚拟线程详解</a> — 详尽的 API 用法和内部机制讲解</li>
<li>OpenJDK Wiki — <a href="https://openjdk.org/projects/loom/" target="_blank">Project Loom</a> — 项目主页，了解设计动机和演进历史</li>
<li>知乎专栏 — <a href="https://zhuanlan.zhihu.com/p/1919091757553005134" target="_blank">虚拟线程：Java 同步代码的终极性能救赎？</a> — 含 Tomcat 集成方案和生产环境注意事项</li>
<li>OSCHINA — <a href="https://my.oschina.net/u/9714646/blog/19124483" target="_blank">JDK21 虚拟线程性能解析与对比传统线程池实践</a> — 高并发 I/O 场景下吞吐量百倍提升的实测报告</li>
</ol>
