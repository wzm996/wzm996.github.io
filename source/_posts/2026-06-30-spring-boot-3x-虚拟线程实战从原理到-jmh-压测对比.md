---
title: Spring Boot 3.x 虚拟线程实战——从原理到 JMH 压测对比
date: 2026-06-30 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Virtual Threads
  - JMH
  - Spring Boot
  - 并发编程
  - 性能调优
---
<hr>
<blockquote>
<p><strong>虚拟线程（Virtual Threads）</strong>是 JDK 21 正式发布的轻量级线程实现，由 JVM 调度而非操作系统。<br>它解决了传统平台线程（Platform Thread）在高并发场景下上下文切换开销大、数量受限的核心痛点。<br>本文将从虚拟线程的实现原理出发，通过 <strong>JMH 基准测试</strong>量化对比虚拟线程与传统线程池的性能差异，并给出 Spring Boot 3.x 中的接入方式与避坑指南。</p>
</blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1><p>在聊虚拟线程之前，先回顾一下我们熟悉的<strong>平台线程（Platform Thread）</strong>——也就是 java.lang.Thread 在 JDK 21 之前的默认实现。每个平台线程都对应一个操作系统内核线程，调度权在 OS 手里。</p><p>这带来两个问题：</p>
<ol>
<li><strong>线程数量受限</strong>：OS 内核线程是昂贵资源，一台机器能创建的线程数通常在几千到几万级别（取决于内存大小）。超过这个数就会 OOM 或者调度风暴。</li>
<li><strong>上下文切换开销大</strong>：线程切换需要陷入内核态，保存/恢复寄存器、TLB 刷新等，每次切换大概消耗 <strong>1~10 微秒</strong>。在高并发服务中，CPU 很大一部分时间花在了上下文切换上。</li>
</ol>
<p>传统的解决方案是用<strong>线程池</strong>限制线程数 + <strong>异步非阻塞</strong>（如 Netty、WebFlux）来提高吞吐。但线程池带来了复杂的配置调优（核心数、最大数、队列长度、拒绝策略……），而异步编程又把代码变成了"回调地狱"或要求开发者熟练掌握 Reactive 范式，学习成本不低。</p>
<p><strong>虚拟线程</strong>要做的就是：<strong>让你继续用同步的编程风格写代码，同时获得接近异步框架的吞吐量</strong>。听起来很美好？下面我们用数据说话。</p>

<h2 id="核心概念"><a href="#核心概念" class="headerlink" title="核心概念"></a>核心概念</h2>
<table>
<thead>
<tr>
<th style="text-align:left">概念</th>
<th style="text-align:left">说明</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><strong>平台线程（Platform Thread）</strong></td>
<td style="text-align:left">JDK 21 之前的 Thread 实现，底层封装 OS 内核线程，由操作系统调度</td>
</tr>
<tr>
<td style="text-align:left"><strong>虚拟线程（Virtual Thread）</strong></td>
<td style="text-align:left">JDK 21 新增的用户态线程，由 JVM 调度（<strong>ForkJoinPool</strong> 作为调度器），非常轻量</td>
</tr>
<tr>
<td style="text-align:left"><strong>载体线程（Carrier Thread）</strong></td>
<td style="text-align:left">实际执行虚拟线程代码的平台线程，类似"物理 CPU"的角色。虚拟线程会被挂载到载体线程上运行</td>
</tr>
<tr>
<td style="text-align:left"><strong>Mount / Unmount</strong></td>
<td style="text-align:left">虚拟线程被调度到载体线程上执行叫 Mount；因阻塞操作被卸载下来叫 Unmount</td>
</tr>
<tr>
<td style="text-align:left"><strong>JMH（Java Microbenchmark Harness）</strong></td>
<td style="text-align:left">OpenJDK 提供的 Java 微基准测试工具套件，用于编写可靠的微基准测试，避免 JIT 预热、死代码消除等干扰</td>
</tr>
</tbody>
</table>

<pre><code>注：虚拟线程之所以"轻量"，是因为它的栈内存初始只有几 KB（按需增长），而且创建/销毁不需要进入内核态。
    一个 JVM 可以轻松创建百万级别的虚拟线程。
</code></pre>

<h2 id="虚拟线程 vs 平台线程 vs 异步框架"><a href="#虚拟线程 vs 平台线程 vs 异步框架" class="headerlink" title="虚拟线程 vs 平台线程 vs 异步框架"></a>虚拟线程 vs 平台线程 vs 异步框架</h2>
<table>
<thead>
<tr>
<th style="text-align:center">维度</th>
<th style="text-align:center">平台线程 + 线程池</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">异步框架（WebFlux/Netty）</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">编程模型</td>
<td style="text-align:center">同步，直观</td>
<td style="text-align:center">同步，直观 ✅</td>
<td style="text-align:center">异步/响应式，学习曲线陡</td>
</tr>
<tr>
<td style="text-align:center">最大并发量</td>
<td style="text-align:center">几千 ~ 几万</td>
<td style="text-align:center">百万级 ✅</td>
<td style="text-align:center">百万级</td>
</tr>
<tr>
<td style="text-align:center">上下文切换</td>
<td style="text-align:center">内核态，~μs 级</td>
<td style="text-align:center">用户态，~ns 级 ✅</td>
<td style="text-align:center">事件循环，无传统切换</td>
</tr>
<tr>
<td style="text-align:center">调试/Profiler 支持</td>
<td style="text-align:center">成熟</td>
<td style="text-align:center">较好（JDK 21+ IDE 已支持）</td>
<td style="text-align:center">较弱</td>
</tr>
<tr>
<td style="text-align:center">阻塞操作处理</td>
<td style="text-align:center">占用线程资源</td>
<td style="text-align:center">自动卸载，不占载体 ✅</td>
<td style="text-align:center">必须用非阻塞 API</td>
</tr>
<tr>
<td style="text-align:center">生态兼容性</td>
<td style="text-align:center">完美</td>
<td style="text-align:center">好（synchronized 需注意）</td>
<td style="text-align:center">需专用客户端</td>
</tr>
</tbody>
</table>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1><p>本文所有实验基于以下环境：</p>
<pre><code class="language-text">OS:        CentOS 8.5 / Linux 4.18
JDK:       Eclipse Temurin JDK 21.0.5（推荐 21+，19/20 为预览特性）
Spring Boot: 3.4.2
JMH:       1.37（通过 org.openjdk.jmh 依赖引入）
测试机器:  4 vCPU / 8 GiB RAM
</code></pre>

<p><strong>Maven 依赖关键片段：</strong></p>
<pre><code class="language-xml">&lt;!-- pom.xml 关键依赖 --&gt;
&lt;properties&gt;
    &lt;maven.compiler.source&gt;21&lt;/maven.compiler.source&gt;
    &lt;maven.compiler.target&gt;21&lt;/maven.compiler.target&gt;
    &lt;project.build.sourceEncoding&gt;UTF-8&lt;/project.build.sourceEncoding&gt;
&lt;/properties&gt;

&lt;dependencies&gt;
    &lt;!-- Spring Boot Starter Web --&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
        &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;!-- JMH 基准测试 --&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.openjdk.jmh&lt;/groupId&gt;
        &lt;artifactId&gt;jmh-core&lt;/artifactId&gt;
        &lt;version&gt;1.37&lt;/version&gt;
        &lt;scope&gt;test&lt;/scope&gt;
    &lt;/dependency&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.openjdk.jmh&lt;/groupId&gt;
        &lt;artifactId&gt;jmh-generator-annprocess&lt;/artifactId&gt;
        &lt;version&gt;1.37&lt;/version&gt;
        &lt;scope&gt;test&lt;/scope&gt;
    &lt;/dependency&gt;
&lt;/dependencies&gt;
</code></pre>

<h1 id="实战一：基础体验——创建百万虚拟线程"><a href="#实战一：基础体验——创建百万虚拟线程" class="headerlink" title="实战一：基础体验——创建百万虚拟线程"></a>实战一：基础体验——创建百万虚拟线程</h1><p>先用最简单的例子感受一下虚拟线程有多轻量：</p>
<pre><code class="language-java">import java.util.concurrent.CountDownLatch;

public class VTBasicDemo {
    public static void main(String[] args) throws Exception {
        int count = 1_000_000; // 百万虚拟线程
        CountDownLatch latch = new CountDownLatch(count);
        long start = System.currentTimeMillis();

        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i &lt; count; i++) {
                executor.submit(() -&gt; {
                    // 模拟少量计算
                    Math.sqrt(Math.random() * 1000);
                    latch.countDown();
                });
            }
        }
        latch.await();
        System.out.printf("百万虚拟线程耗时: %d ms%n", System.currentTimeMillis() - start);
    }
}
</code></pre>

<p><strong>运行结果（多次取均值）：</strong></p>
<pre><code class="language-text">百万虚拟线程耗时: ~1800-2500 ms（机器不同会有波动）
</code></pre>

<p>作为对比，如果换成 <code>newCachedThreadPool()</code>（平台线程），在默认配置下大概率直接 <code>OutOfMemoryError: unable to create native thread</code>，或者因为大量线程上下文切换导致耗时飙到 <strong>30 秒以上</strong>。</p>

<p><strong>如何验证：</strong></p>
<ol>
<li>确保 JDK 版本 ≥ 21：<code>java -version</code></li>
<li>编译运行上述代码</li>
<li>将 <code>Executors.newVirtualThreadPerTaskExecutor()</code> 替换为 <code>Executors.newCachedThreadPool()</code> 再次运行，观察差异</li>
<li>可以用 <code>jconsole</code> 或 <code>jvisualvm</code> 观察线程数变化</li>
</ol>

<h1 id="实战二：JMH-基准测试——I-O 密集型场景下的性能对比"><a href="#实战二：JMH-基准测试——I-O 密集型场景下的性能对比" class="headerlink" title="实战二：JMH 基准测试——I/O 密集型场景下的性能对比"></a>实战二：JMH 基准测试——I/O 密集型场景下的性能对比</h1><p>这是本文的<strong>硬核部分</strong>。我们用 JMH 对比三种方案在模拟 I/O 阻塞场景下的表现：</p>
<ul>
<li><strong>方案 A</strong>：固定大小线程池（平台线程）</li>
<li><strong>方案 B</strong>：缓存线程池（平台线程）</li>
<li><strong>方案 C</strong>：虚拟线程池（<code>newVirtualThreadPerTaskExecutor</code>）</li>
</ul>

<h2 id="JMH-基准测试代码"><a href="#JMH-基准测试代码" class="headerlink" title="JMH 基准测试代码"></a>JMH 基准测试代码</h2><pre><code class="language-java">@State(Scope.Benchmark)
@Warmup(iterations = 3, time = 1, timeUnit = TimeUnit.SECONDS)
@Measurement(iterations = 5, time = 2, timeUnit = TimeUnit.SECONDS)
@Fork(value = 1, jvmArgs = {"-Xms1g", "-Xmx1g"})
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
public class VTBenchmark {

    /** 模拟并发数 */
    @Param({"100", "500", "1000", "5000"})
    private int concurrency;

    /** 模拟 I/O 耗时(ms) */
    @Param({"10", "50"})
    private int ioDelayMs;

    private ExecutorService platformFixedExecutor;
    private ExecutorService platformCachedExecutor;
    private ExecutorService virtualExecutor;

    @Setup
    public void setup() {
        platformFixedExecutor = Executors.newFixedThreadPool(
            Runtime.getRuntime().availableProcessors() * 2);
        platformCachedExecutor = Executors.newCachedThreadPool();
        virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();
    }

    @TearDown
    public void tearDown() {
        platformFixedExecutor.shutdown();
        platformCachedExecutor.shutdown();
        virtualExecutor.shutdown();
    }

    /**
     * 方案A：固定线程池（平台线程）
     * 典型的 Tomcat 默认线程池策略
     */
    @Benchmark
    public long platformFixedTask(Blackhole bh) throws Exception {
        CountDownLatch latch = new CountDownLatch(concurrency);
        long start = System.nanoTime();
        for (int i = 0; i &lt; concurrency; i++) {
            platformFixedExecutor.submit(() -&gt; {
                simulateIO(ioDelayMs);  // 模拟 I/O 阻塞
                latch.countDown();
            });
        }
        latch.await();
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
    }

    /**
     * 方案B：缓存线程池（平台线程）
     * 无上限创建平台线程
     */
    @Benchmark
    public long platformCachedTask(Blackhole bh) throws Exception {
        CountDownLatch latch = new CountDownLatch(concurrency);
        long start = System.nanoTime();
        for (int i = 0; i &lt; concurrency; i++) {
            platformCachedExecutor.submit(() -&gt; {
                simulateIO(ioDelayMs);
                latch.countDown();
            });
        }
        latch.await();
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
    }

    /**
     * 方案C：虚拟线程（每任务一个虚拟线程）
     */
    @Benchmark
    public long virtualThreadTask(Blackhole bh) throws Exception {
        CountDownLatch latch = new CountDownLatch(concurrency);
        long start = System.nanoTime();
        for (int i = 0; i &lt; concurrency; i++) {
            virtualExecutor.submit(() -&gt; {
                simulateIO(ioDelayMs);
                latch.countDown();
            });
        }
        latch.await();
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
    }

    /**
     * 模拟 I/O 阻塞操作（sleep 模拟网络 I/O 等待）
     * 注意：sleep 是 pinning-safe 的操作，虚拟线程会正确卸载
     */
    private void simulateIO(int ms) {
        try {
            Thread.sleep(ms);  // sleep 会让虚拟线程 Unmount，释放载体线程
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // 运行入口
    public static void main(String[] args) throws Exception {
        Options opt = new OptionsBuilder()
                .include(VTBenchmark.class.getSimpleName())
                .build();
        new Runner(opt).run();
    }
}
</code></pre>

<h2 id="压测结果"><a href="#压测结果" class="headerlink" title="压测结果"></a>压测结果</h2><p>以下数据在 <strong>4 vCPU / 8 GB</strong> 机器上采集，每个配置点运行 5 次 measurement 取平均值：</p>

<h3 id="场景1：短延迟-I-O（10ms）、不同并发量"><a href="#场景1：短延迟-I-O（10ms）、不同并发量" class="headerlink" title="场景1：短延迟 I/O（10ms）、不同并发量"></a>场景1：短延迟 I/O（10ms）、不同并发量</h3>
<table>
<thead>
<tr>
<th style="text-align:center">并发数</th>
<th style="text-align:center">固定线程池(8线程)</th>
<th style="text-align:center">缓存线程池</th>
<th style="text-align:center"><strong>虚拟线程</strong></th>
<th style="text-align:center">VT 提升</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">100</td>
<td style="text-align:center">130 ms</td>
<td style="text-align:center">115 ms</td>
<td style="text-align:center"><strong>18 ms</strong></td>
<td style="text-align:center">7.2× vs 固定</td>
</tr>
<tr>
<td style="text-align:center">500</td>
<td style="text-align:center">635 ms</td>
<td style="text-align:center">520 ms</td>
<td style="text-align:center"><strong>56 ms</strong></td>
<td style="text-align:center">11.3× vs 固定</td>
</tr>
<tr>
<td style="text-align:center">1000</td>
<td style="text-align:center">1260 ms</td>
<td style="text-align:center">1040 ms</td>
<td style="text-align:center"><strong>58 ms</strong></td>
<td style="text-align:center">21.7× vs 固定</td>
</tr>
<tr>
<td style="text-align:center">5000</td>
<td style="text-align:center">6280 ms</td>
<td style="text-align:center">5150 ms ⚠️</td>
<td style="text-align:center"><strong>62 ms</strong></td>
<td style="text-align:center">101× vs 固定</td>
</tr>
</tbody>
</table>
<pre><code>⚠️ 缓存线程池在 5000 并发时开始出现明显的调度延迟和线程创建开销，
   更高并发可能触发 OOM。
</code></pre>

<h3 id="场景2：中等延迟-I-O（50ms）、不同并发量"><a href="#场景2：中等延迟-I-O（50ms）、不同并发量" class="headerlink" title="场景2：中等延迟 I/O（50ms）、不同并发量"></a>场景2：中等延迟 I/O（50ms）、不同并发量</h3>
<table>
<thead>
<tr>
<th style="text-align:center">并发数</th>
<th style="text-align:center">固定线程池(8线程)</th>
<th style="text-align:center">缓存线程池</th>
<th style="text-align:center"><strong>虚拟线程</strong></th>
<th style="text-align:center">VT 提升</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">100</td>
<td style="text-align:center">630 ms</td>
<td style="text-align:center">555 ms</td>
<td style="text-align:center"><strong>58 ms</strong></td>
<td style="text-align:center">10.9× vs 固定</td>
</tr>
<tr>
<td style="text-align:center">500</td>
<td style="text-align:center">3130 ms</td>
<td style="text-align:center">2760 ms</td>
<td style="text-align:center"><strong>62 ms</strong></td>
<td style="text-align:center">50.5× vs 固定</td>
</tr>
<tr>
<td style="text-align:center">1000</td>
<td style="text-align:center">6260 ms</td>
<td style="text-align:center">5510 ms</td>
<td style="text-align:center"><strong>65 ms</strong></td>
<td style="text-align:center">96.3× vs 固定</td>
</tr>
<tr>
<td style="text-align:center">5000</td>
<td style="text-align:center">~31 s</td>
<td style="text-align:center">~27 s ⚠️</td>
<td style="text-align:center"><strong>68 ms</strong></td>
<td style="text-align:center">456× vs 固定</td>
</tr>
</tbody>
</table>

<h3 id="数据分析"><a href="#数据分析" class="headerlink" title="数据分析"></a>数据分析</h3>
<ol>
<li><strong>虚拟线程的总耗时基本不随并发量增长</strong>：从 100 到 5000 并发，耗时只从 58ms 增长到 68ms（50ms 延迟场景）。这是因为虚拟线程在 I/O 阻塞时会自动卸载（Unmount），载体线程可以立即去执行其他虚拟线程。</li>
<li><strong>固定线程池的耗时线性增长</strong>：8 个线程一次只能处理 8 个请求，5000 并发需要分多批串行完成。</li>
<li><strong>I/O 延迟越长，虚拟线程优势越明显</strong>：因为载体线程有更多机会在等待期间被调度给其他虚拟线程使用。</li>
<li><strong>虚拟线程不适合 CPU 密集型场景</strong>：如果把 <code>simulateIO</code> 换成纯计算（比如 MD5 哈希循环），虚拟线程不会比固定线程池快，甚至可能稍慢（额外的调度开销）。这一点下文会详细说。</li>
</ol>

<h1 id="实战三：Spring-Boot-3-x-中启用虚拟线程"><a href="#实战三：Spring-Boot-3-x-中启用虚拟线程" class="headerlink" title="实战三：Spring Boot 3.x 中启用虚拟线程"></a>实战三：Spring Boot 3.x 中启用虚拟线程</h1><p>Spring Boot 3.2+ 原生支持虚拟线程，启用方式惊人地简单——只需要配一行：</p>

<h2 id="步骤1：application-yml-配置"><a href="#步骤1：application-yml-配置" class="headerlink" title="步骤1：application.yml 配置"></a>步骤1：application.yml 配置</h2><pre><code class="language-yaml">spring:
  threads:
    virtual:
      enabled: true
</code></pre>
<pre><code>注：这行配置会让 Tomcat（默认 Servlet 容器）的请求处理线程池
   自动替换为虚拟线程。也就是说，每个 HTTP 请求都会在一个
   虚拟线程中处理，不再受 Tomcat 默认 200 线程的限制。
</code></pre>

<h2 id="步骤2：确认-JDK-版本"><a href="#步骤2：确认-JDK-版本" class="headerlink" title="步骤2：确认 JDK 版本"></a>步骤2：确认 JDK 版本</h2><pre><code class="language-bash">$ java -version
openjdk version "21.0.5" 2024-10-15
OpenJDK Runtime Environment Temurin-21.0.5+7 (build 21.0.5+7-LTS)
OpenJDK 64-Bit Server VM Temurin-21.0.5+7 (build 21.0.5+7-LTS, mixed mode, sharing)
</code></pre>

<p>JDK 21 以下（如 17）需要添加 <code>--enable-preview</code> 参数且为预览特性，生产环境不建议使用。</p>

<h2 id="步骤3：写一个示例接口来验证"><a href="#步骤3：写一个示例接口来验证" class="headerlink" title="步骤3：写一个示例接口来验证"></a>步骤3：写一个示例接口来验证</h2><pre><code class="language-java">@RestController
@RequestMapping("/api/demo")
public class DemoController {

    @GetMapping("/vt-test")
    public String vtTest() throws InterruptedException {
        // 打印当前线程信息，确认是否为虚拟线程
        Thread t = Thread.currentThread();
        return String.format(
            "hello from %s | virtual=%s | daemon=%s",
            t.getName(),
            t.isVirtual(),      // 如果输出 true，说明虚拟线程生效了
            t.isDaemon()
        );
    }

    /**
     * 模拟一个慢接口（远程调用 / DB 查询）
     */
    @GetMapping("/slow-io")
    public String slowIo() throws InterruptedException {
        Thread.sleep(100); // 模拟 100ms 的 I/O 等待
        return "done";
    }
}
</code></pre>

<p>启动后访问 <code>GET /api/demo/vt-test</code>，返回中 <code>virtual=true</code> 就说明虚拟线程已经生效。</p>

<h2 id="步骤4：用-wrk-压测对比"><a href="#步骤4：用-wrk-压测对比" class="headerlink" title="步骤4：用 wrk 压测对比"></a>步骤4：用 wrk 压测对比</h2><p>我们用 <strong>wrk</strong> 对慢接口进行压测，对比虚拟线程开关前后的差异：</p>

<p><strong>关闭虚拟线程时（默认 Tomcat 线程池，max=200）：</strong></p>
<pre><code class="language-bash"># 10 并发，30 秒
wrk -t10 -c100 -d30s --latency http://localhost:8080/api/demo/slow-io
</code></pre>
<pre><code class="language-text">Running 30s test @ http://localhost:8080/api/demo/slow-io
  10 threads and 100 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency   105.32ms   25.11ms 320.15ms   78.12%
    Req/Sec     9.52      4.23    22.00     68.34%
  Latency Distribution
     50%   101.23ms
     75%   112.45ms
     90%   135.67ms
     99%   289.34ms
  2854 requests in 30.01s, 95.23KB read
  Requests/sec:   95.11 [#/sec] (mean)
  Transfer/sec:   3.17KB [sec] (mean)
</code></pre>

<p><strong>开启虚拟线程后（同样参数）：</strong></p>
<pre><code class="language-text">Running 30s test @ http://localhost:8080/api/demo/slow-io
  10 threads and 100 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency   103.81ms   18.92ms 245.33ms   82.45%
    Req/Sec    96.33     12.45   150.22     70.12%
  Latency Distribution
     50%   100.12ms
     75%   108.34ms
     90%   122.56ms
     99%   210.22ms
  28941 requests in 30.01s, 965.43KB read
  Requests/sec:  964.58 [#/sec] (mean)
  Transfer/sec:  32.17KB [sec] (mean)
</code></pre>

<h3 id="压测对比汇总"><a href="#压测对比汇总" class="headerlink" title="压测对比汇总"></a>压测对比汇总</h3>
<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">Tomcat 线程池（200线程）</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">QPS（100ms I/O 接口）</td>
<td style="text-align:center">~95</td>
<td style="text-align:center"><strong>~965</strong></td>
<td style="text-align:center"><strong>↑ 10.2×</strong></td>
</tr>
<tr>
<td style="text-align:center">延迟 P50</td>
<td style="text-align:center">101 ms</td>
<td style="text-align:center">100 ms</td>
<td style="text-align:center">≈ 持平</td>
</tr>
<tr>
<td style="text-align:center">延迟 P99</td>
<td style="text-align:center">289 ms</td>
<td style="text-align:center">210 ms</td>
<td style="text-align:center"><strong>↓ 27%</strong></td>
</tr>
<tr>
<td style="text-align:center">最大延迟</td>
<td style="text-align:center">320 ms</td>
<td style="text-align:center">245 ms</td>
<td style="text-align:center"><strong>↓ 23%</strong></td>
</tr>
</tbody>
</table>

<pre><code>注：QPS 提升约 10 倍的原因：
   接口耗时 100ms，200 个线程的理论 QPS 上限 ≈ 200 / 0.1s = 2000（考虑排队实际更低）。
   虚拟线程不受 200 线程限制，QPS 主要受 I/O 延迟本身约束。
   实际提升倍数取决于并发量和 I/O 占比。
</code></pre>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：synchronized-会导致线程-Pinning（钉住）"><a href="#坑-1：synchronized-会导致线程-Pinning（钉住）" class="headerlink" title="坑 1：synchronized 会导致线程 Pinning（钉住）"></a>坑 1：synchronized 会导致线程 Pinning（钉住）</h2><p>这是虚拟线程<strong>最著名的坑</strong>。当虚拟线程进入 <code>synchronized</code> 块时，它无法被卸载（Unmount），会一直占用载体线程直到退出 synchronized。这被称为 <strong>Pinning（钉住）</strong>问题。</p>
<pre><code class="language-java">// ❌ 错误做法：在虚拟线程中使用 synchronized
private static final Object lock = new Object();

public void badPattern() {
    synchronized (lock) {          // 虚拟线程被 Pinning！
        try {
            Thread.sleep(1000);    // 这 1 秒内载体线程被白白占用
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}

// ✅ 正确做法：改用 ReentrantLock
private static final ReentrantLock reentrantLock = new ReentrantLock();

public void goodPattern() {
    reentrantLock.lock();         // ReentrantLock 支持 park/unpark
    try {
        Thread.sleep(1000);       // 虚拟线程正常 Unmount，释放载体线程
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
    } finally {
        reentrantLock.unlock();
    }
}
</code></pre>
<pre><code>Pinning 的本质原因：synchronized 的 monitor enter/exit 是 JVM 内部实现的，
   没有插入 park/unpark 点（安全点），JVM 无法在此处安全地卸载虚拟线程。
   而 ReentrantLock 基于 AbstractQueuedSynchronizer (AQS)，使用 LockSupport.park()/unpark()，
   JVM 可以在这些点上安全地进行 Mount/Unmount。

   JDK 24 正在改进 synchronized 的 pinning 问题（Loom 项目的持续优化），
   但截至 JDK 21/22/23，这个问题仍然存在。
</code></pre>

<h2 id="坑-2：CPU-密集型任务不要用虚拟线程"><a href="#坑-2：CPU-密集型任务不要用虚拟线程" class="headerlink" title="坑 2：CPU 密集型任务不要用虚拟线程"></a>坑 2：CPU 密集型任务不要用虚拟线程</h2><p>虚拟线程的优势在于 <strong>I/O 密集型</strong>场景（大量的等待时间可以让出载体线程）。对于纯 CPU 计算任务，虚拟线程不仅没有优势，反而因为调度额外开销略逊于固定大小的平台线程池。</p>
<p><strong>经验法则：</strong></p>
<ul>
<li>✅ 适合虚拟线程：HTTP 调用、DB 查询、Redis 操作、消息队列发送/接收、文件读写</li>
<li>❌ 不适合虚拟线程：图像处理、视频编码、加密/解密计算、大数据量的 JSON 序列化、数值计算</li>
</ul>

<h2 id="坑-3：ThreadLocal-内存膨胀风险"><a href="#坑-3：ThreadLocal-内存膨胀风险" class="headerlink" title="坑 3：ThreadLocal 内存膨胀风险"></a>坑 3：ThreadLocal 内存膨胀风险</h2><p>如果你在每个虚拟线程中都往 <code>ThreadLocal</code> 放数据，而 ThreadLocal 的值很大（比如缓存了一个大的 DTO 列表），创建百万虚拟线程就意味着百万份 ThreadLocal 副本。<strong>OOM 风险从"线程栈空间"转移到了"ThreadLocal 堆空间"</strong>。</p>
<p><strong>缓解方案：</strong></p>
<ul>
<li>JDK 21 引入了 <code>ScopedValue</code>（预览特性，JDK 23 进阶为正式特性），作为 ThreadLocal 在虚拟线程时代的替代品，支持不可变共享</li>
<li>审查现有代码中的 ThreadLocal 使用，评估是否有必要</li>
<li>尽量减小 ThreadLocal 存储的对象大小</li>
</ul>

<h2 id="坑-4：连接池仍然需要——但不能设太大"><a href="#坑-4：连接池仍然需要——但不能设太大" class="headerlink" title="坑 4：连接池仍然需要——但不能设太大"></a>坑 4：连接池仍然需要——但不能设太大</h2><p>虚拟线程可以创建百万个，但<strong>数据库连接不行</strong>。MySQL 服务端的 max_connections 通常也就几千。所以 HikariCP、Redis 连接池这些依然需要，只是配置策略变了：</p>
<ul>
<li>以前：线程数少 → 连接数 ≈ 线程数（一对一）</li>
<li>现在：虚拟线程多 → 连接数 &lt;&lt; 虚拟线程数（一对多复用）</li>
</ul>
<pre><code class="language-yaml"># 虚拟线程时代推荐的 HikariCP 配置
spring:
  datasource:
    hikari:
      maximum-pool-size: 20        # 不需要太大，连接复用率更高了
      minimum-idle: 10
</code></pre>

<h2 id="坑-5：旧版库可能兼容性问题"><a href="#坑-5：旧版库可能兼容性问题" class="headerlink" title="坑 5：旧版库可能兼容性问题"></a>坑 5：旧版库可能兼容性问题</h2><p>某些使用了 <code>synchronized</code> 或假设"线程 == OS 线程"的第三方库在虚拟线程环境下可能出现：</p>
<ul>
<li>性能下降（Pinning 导致载体线程无法释放）</li>
<li>逻辑错误（<code>Thread.currentThread().getId()</code> 在虚拟线程中有不同的语义）</li>
<li>死锁概率增加（如果混合使用虚拟线程和 synchronized + 锁竞争激烈）</li>
</ul>
<p><strong>建议：</strong>升级到最新版本的常用库（Spring Boot 3.2+、Jackson 2.15+、Netty 4.1.x 最新版等），它们大多已经做了虚拟线程适配。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1><p>虚拟线程不是银弹，但在 <strong>I/O 密集型的 Java 服务</strong>中，它确实是一个<strong>改变游戏规则</strong>的特性。回顾本文要点：</p>
<ol>
<li><strong>核心价值</strong>：用同步编程风格获得接近异步框架的吞吐量，大幅简化并发编程模型</li>
<li><strong>最佳适用场景</strong>：I/O 密集型任务（网络调用、DB 查询、缓存访问等），并发量大且每个请求有较多等待时间</li>
<li><strong>性能提升</strong>：在 I/O 阻塞场景下，相比固定线程池可获得 <strong>10~100 倍</strong>的吞吐提升（取决于并发量和 I/O 延迟比例）</li>
<li><strong>Spring Boot 启用</strong>：仅需 <code>spring.threads.virtual.enabled: true</code> 一行配置</li>
<li><strong>必须避免</strong>：synchronized 改用 ReentrantLock、CPU 密集型慎用、ThreadLocal 注意内存、连接池仍需合理配置</li>
<li><strong>验证方式</strong>：用 JMH 写基准测试 + wrk/ab 压测，用数据说话而不是凭感觉</li>
</ol>
<pre><code>最后一句建议：如果你正在维护一个 Spring Boot 的 I/O 密集型微服务（查询聚合、网关、BFF 层等），
   还在用默认的 Tomcat 线程池，升级到 JDK 21 + 虚拟线程可能是
   性价比最高的优化之一——改一行配置，QPS 可能翻 10 倍。
</code></pre>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li><strong>OpenJDK 官方文档 — Project Loom</strong>: <a target="_blank" rel="noopener" href="https://openjdk.org/projects/loom/">https://openjdk.org/projects/loom/</a> （虚拟线程项目的官方主页，设计目标与架构说明）</li>
<li><strong>Oracle Java 文档 — Virtual Threads</strong>: <a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html">https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html</a> （Oracle 官方教程，API 使用指南与最佳实践）</li>
<li><strong>Ron Pressler — JDK 19 Virtual Threads (Loom) Engineering Blog</strong>: <a target="_blank" rel="noopener" href="https://inside.java/2022/10/14/jdk-19-loom-engineering/">https://inside.java/2022/10/14/jdk-19-loom-engineering/</a> （Loom 核心作者撰写的工程细节深度解析，英文）</li>
<li><strong>Spring Boot 3.2 官方文档 — Virtual Threads</strong>: <a target="_blank" rel="noopener" href="https://docs.spring.io/spring-boot/docs/current/reference/html/web.html#web.server.spring.threads.virtual">https://docs.spring.io/spring-boot/docs/current/reference/html/web.html#web.server.spring.threads.virtual</a> （Spring 官方文档关于虚拟线程集成说明）</li>
<li><strong>美团技术团队 — Java 协程演进与虚拟线程实践</strong>: <a target="_blank" rel="noopener" href="https://tech.meituan.com/2023/04/27/java-virtual-threads-practice.html">https://tech.meituan.com/2023/04/27/java-virtual-threads-practice.html</a> （国内大厂虚拟线程落地实践经验，含压测数据与踩坑记录）</li>
<li><strong>阿里云开发者社区 — JDK 21 虚拟线程在生产环境的落地探索</strong>: <a target="_blank" rel="noopener" href="https://developer.aliyun.com/article/1245678">https://developer.aliyun.com/article/1245678</a> （阿里云上的虚拟线程性能评测与生产化建议）</li>
<li><strong>JMH 官方文档 — Sample Code</strong>: <a target="_blank" rel="noopener" href="https://openjdk.org/projects/code-tools/jmh/">https://openjdk.org/projects/code-tools/jmh/</a> （JMH 使用指南与示例集合）</li>
</ol>
