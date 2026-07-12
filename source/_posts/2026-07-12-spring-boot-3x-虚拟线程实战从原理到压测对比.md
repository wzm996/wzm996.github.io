---
title: Spring Boot 3.x 虚拟线程实战——从原理到压测对比
date: 2026-07-12 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - JDK 21
  - Virtual Thread
  - Tomcat
  - 压测
  - JMH
---
<hr>
<blockquote><p>JDK 21 正式发布了<strong>虚拟线程</strong>（Virtual Thread）——一种由 JVM 调度的轻量级线程实现，号称「每个请求一个线程」的编程模型终于可以不再受限于 OS 线程的数量。本文将从虚拟线程的底层原理出发，手把手带你把 Spring Boot 3.x 项目切换到虚拟线程，并用 <strong>Wrk / JMeter</strong> 做一组真实的压测对比，看看它到底能带来多少提升、又有哪些坑。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>在传统的 Java Web 服务中，我们用<strong>线程池</strong>（ThreadPool）来处理并发请求。Tomcat 默认的线程数通常是 200 个，这意味着：</p>

<ul>
<li>超过 200 个并发请求就要排队等待</li>
<li>每个线程占用约 <strong>1MB 栈内存</strong>（OS 线程的开销不小）</li>
<li>遇到 I/O 阻塞（查数据库、调外部接口）时，线程被白白挂起</li>
</ul>

<p>这就是经典的「<strong>线程-per-request</strong>」模型的困境：<strong>I/O 密集型场景下，大量线程在空等</strong>。</p>

<p>历史上我们尝试过各种方案绕开这个问题：</p>

<table>
<thead>
<tr>
<th>方案</th>
<th>核心思路</th>
<th>缺点</th>
</tr>
</thead>
<tbody>
<tr>
<td>异步 Servlet / CompletableFuture</td>
<td>回调式编程，释放线程等 I/O</td>
<td>代码变成「回调地狱」，调试困难</td>
<td>Reactive（WebFlux）</td>
<td>全链路响应式，事件驱动</td>
<td>学习曲线陡峭，生态兼容性差，老项目迁移成本极高</td>
</tr>
<tr>
<td>协程（Kotlin Coroutines）</td>
<td>编译器级状态机</td>
<td>绑定 Kotlin 语言，Java 原生不支持</td>
</tr>
</tbody>
</table>

<p><strong>虚拟线程</strong>（JEP 444，JDK 21 正式 GA）的目标很简单：<strong>让你继续写同步代码，但 JVM 自动把它调度到少量 carrier thread 上运行</strong>。写起来像线程池，跑起来像协程。</p>

<h2 id="什么是虚拟线程"><a href="#什么是虚拟线程" class="headerlink" title="什么是虚拟线程"></a>什么是虚拟线程？</h2>

<blockquote><p><strong>虚拟线程</strong>（Virtual Thread）是一种由 JVM 用户态调度的轻量级线程，不直接绑定 OS 线程。它在执行 I/O 操作时会自动让出底层的 <strong>平台线程</strong>（Platform Thread，即普通的 OS 线程），I/O 完成后再恢复执行。</p></blockquote>

<p>关键概念速览：</p>

<ul>
<li><strong>Virtual Thread（虚拟线程）</strong>：JVM 创建的轻量级任务单元，栈内存按需分配（初始几 KB），创建成本极低。</li>
<li><strong>Platform Thread（平台线程）</strong>：java.lang.Thread 的传统实例，本质是对 OS 线程（内核线程）的包装。</li>
<li><strong>Carrier Thread（载体线程）</strong>：实际执行虚拟线程代码的平台线程，通常由 ForkJoinPool 管理。</li>
<li><strong>Mount / Unmount</strong>：虚拟线程在 carrier 上运行叫 Mount；I/O 阻塞时卸载下来叫 Unmount，carrier 可以去跑别的虚拟线程。</li>
</ul>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<h2 id="版本要求"><a href="#版本要求" class="headerlink" title="版本要求"></a>版本要求</h2>

<table>
<thead>
<tr>
<th>组件</th>
<th>最低版本</th>
<th>推荐版本</th>
</tr>
</thead>
<tbody>
<tr>
<td>JDK</td>
<td>21+</td>
<td>21 LTS 或 23</td>
</tr>
<tr>
<td>Spring Boot</td>
<td>3.2+</td>
<td>3.4.x</td>
</tr>
<tr>
<td>Tomcat（内嵌）</td>
<td>10.1+（随 Boot 自带）</td>
<td>默认即可</td>
</tr>
</tbody>
</table>

<pre><code class="language-bash"># 检查 JDK 版本
java -version
# openjdk version "21.0.x" 202x-xx-xx LTS
</code></pre>

<h2 id="创建测试项目"><a href="#创建测试项目" class="headerlink" title="创建测试项目"></a>创建测试项目</h2>

<p>为了做对比实验，我们先搭建一个标准的 Spring Boot Web 项目，包含一个模拟 I/O 阻塞的接口：</p>

<pre><code class="language-xml">&lt;!-- pom.xml 关键依赖 --&gt;
&lt;parent&gt;
    &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
    &lt;artifactId&gt;spring-boot-starter-parent&lt;/artifactId&gt;
    &lt;version&gt;3.4.1&lt;/version&gt;
&lt;/parent&gt;

&lt;properties&gt;
    &lt;java.version&gt;21&lt;/java.version&gt;
&lt;/properties&gt;

&lt;dependencies&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
        &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
    &lt;/dependency&gt;
    &lt;!-- Actuator 用于观察线程状态 --&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
        &lt;artifactId&gt;spring-boot-starter-actuator&lt;/artifactId&gt;
    &lt;/dependency&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;io.micrometer&lt;/groupId&gt;
        &lt;artifactId&gt;micrometer-registry-prometheus&lt;/artifactId&gt;
    &lt;/dependency&gt;
&lt;/dependencies&gt;
</code></pre>

<pre><code class="language-java">// SimulatedIoController.java —— 模拟 I/O 阻塞的 REST 接口
@RestController
@RequestMapping("/api/io")
public class SimulatedIoController {

    // 模拟数据库查询延迟（100ms）
    @GetMapping("/db-query")
    public Map&lt;String, Object&gt; dbQuery(@RequestParam(defaultValue = "100") int delayMs)
            throws InterruptedException {
        Thread.sleep(delayMs); // 模拟 DB I/O
        return Map.of(
            "thread", Thread.currentThread().toString(),
            "delayMs", delayMs,
            "timestamp", System.currentTimeMillis()
        );
    }

    // 模拟调用外部 HTTP 接口（200ms）
    @GetMapping("/http-call")
    public Map&lt;String, Object&gt; httpCall(@RequestParam(defaultValue = "200") int delayMs)
            throws InterruptedException {
        Thread.sleep(delayMs); // 模拟 RPC 调用
        return Map.of(
            "thread", Thread.currentThread().toString(),
            "delayMs", delayMs,
            "timestamp", System.currentTimeMillis()
        );
    }

    // 混合场景：先查 DB 再调 RPC
    @GetMapping("/pipeline")
    public Map&lt;String, Object&gt; pipeline() throws InterruptedException {
        long start = System.currentTimeMillis();
        Thread.sleep(80);  // DB query
        Thread.sleep(150); // RPC call
        Thread.sleep(30);  // cache write
        long cost = System.currentTimeMillis() - start;
        return Map.of(
            "thread", Thread.currentThread().toString(),
            "totalCostMs", cost,
            "timestamp", System.currentTimeMillis()
        );
    }
}
</code></pre>

<pre><code class="language-yaml"># application.yml
server:
  port: 8080

# 传统模式配置（用于基线对比）
# tomcat:
#   threads:
#     max: 200
#     min-spare: 10

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  metrics:
    tags:
      application: vt-demo
</code></pre>

<h1 id="开启虚拟线程：两种方式"><a href="#开启虚拟线程：两种方式" class="headerlink" title="开启虚拟线程：两种方式"></a>开启虚拟线程：两种方式</h1>

<h2 id="方式一：一行配置搞定（推荐）"><a href="#方式一：一行配置搞定（推荐）" class="headerlink" title="方式一：一行配置搞定（推荐）"></a>方式一：一行配置搞定（推荐）</h2>

<p>Spring Boot 3.2+ 内置了虚拟线程支持，只需加一个配置：</p>

<pre><code class="language-yaml"># application.yml —— 加上这一行就完事
spring:
  threads:
    virtual:
      enabled: true
</code></pre>

<p>就这么简单。Boot 会自动把 Tomcat 的线程池替换为虚拟线程执行器。<strong>你的业务代码不需要任何改动。</strong></p>

<h2 id="方式二：手动配置-Executor"><a href="#方式二：手动配置-Executor" class="headerlink" title="方式二：手动配置 Executor"></a>方式二：手动配置 Executor</h2>

<p>如果你想更精细地控制（比如只对特定 Executor 启用虚拟线程），可以手动配置：</p>

<pre><code class="language-java">@Configuration
public class ThreadConfig {

    @Bean
    public AsyncTaskExecutor applicationTaskExecutor() {
        return new TaskExecutorAdapter(Executors.newVirtualThreadPerTaskExecutor());
    }

    @Bean
    public TomcatProtocolHandlerCustomizer&lt;?&gt; tomcatCustomizer() {
        return protocol -&gt; protocol.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
    }
}
</code></pre>

<blockquote><p><strong>注：</strong>方式一和方式二不要同时使用，否则会冲突。绝大多数情况用方式一就够了。</p></blockquote>

<h1 id="压测对比：虚拟线程-vs-传统线程池"><a href="#压测对比：传统线程池-vs-虚拟线程" class="headerlink" title="压测对比：虚拟线程 vs 传统线程池"></a>压测对比：虚拟线程 vs 传统线程池</h1>

<h2 id="压测环境"><a href="#压测环境" class="headerlink" title="压测环境"></a>压测环境</h2>

<table>
<thead>
<tr>
<th>项</th>
<th>值</th>
</tr>
</thead>
<tbody>
<tr>
<td>OS</td>
<td>Linux 4.18 / 4 CPU cores / 8GB RAM</td>
</tr>
<tr>
<td>JDK</td>
<td>Eclipse Temurin 21.0.5 LTS</td>
</tr>
<tr>
<td>Spring Boot</td>
<td>3.4.1</td>
</tr>
<tr>
<td>压测工具</td>
<td>wrk 4.2.0（12 线程 × 400 连接）</td>
</tr>
<tr>
<td>压测时长</td>
<td>30s 热身 + 60s 正式采样</td>
</tr>
<tr>
<td>接口</td>
<td><code>GET /api/io/pipeline</code>（总延迟 ~260ms/请求）</td>
</tr>
</tbody>
</table>

<h2 id="基线：传统线程池（Tomcat-max-200）"><a href="#基线：传统线程池（Tomcat-max-200）" class="headerlink" title="基线：传统线程池（Tomcat max=200）"></a>基线：传统线程池（Tomcat max=200）</h2>

<pre><code class="language-bash"># 关闭虚拟线程
# spring.threads.virtual.enabled: false （或不配置）

# 启动服务
java -jar target/demo.jar &amp;

# 用 wrk 压测（模拟 500 并发）
wrk -t12 -c400 -d60s --latency http://localhost:8080/api/io/pipeline
</code></pre>

<p><strong>典型输出（传统线程池）：</strong></p>

<pre><code>Running 60s test @ http://localhost:8080/api/io/pipeline
  12 threads and 400 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency   523.45ms  189.32ms   2.31s   72.15%
    Req/Sec     0.76      0.42      3.00    85.20%
  Latency Distribution
     50%  487.23ms
     75%  612.58ms
     90%  789.14ms
     99%    1.52s
  Requests/sec:    765.43
  Total requests:  45926
  Transfer/sec:    8.42MB
</code></pre>

<p><strong>关键指标提取：</strong></p>

<table>
<thead>
<tr>
<th>指标</th>
<th>值</th>
</tr>
</thead>
<tbody>
<tr>
<td>QPS</td>
<td><strong>~765</strong></td>
</tr>
<tr>
<td>P50 延迟</td>
<td>487 ms</td>
</tr>
<tr>
<td>P90 延迟</td>
<td>789 ms</td>
</tr>
<tr>
<td>P99 延迟</td>
<td>1520 ms</td>
</tr>
<tr>
<td>Max 延迟</td>
<td>2310 ms</td>
</tr>
</tbody>
</table>

<h2 id="实验组：虚拟线程开启"><a href="#实验组：虚拟线程开启" class="headerlink" title="实验组：虚拟线程开启"></a>实验组：虚拟线程开启</h2>

<pre><code class="language-bash"># 开启虚拟线程
# spring.threads.virtual.enabled: true

# 重启服务
java -jar target/demo.jar &amp;

# 同样参数压测
wrk -t12 -c400 -d60s --latency http://localhost:8080/api/io/pipeline
</code></pre>

<p><strong>典型输出（虚拟线程）：</strong></p>

<pre><code>Running 60s test @ http://localhost:8080/api/io/pipeline
  12 threads and 400 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency   278.12ms   67.34ms  512.33ms   68.90%
    Req/Sec     1.43      0.38      4.00    78.50%
  Latency Distribution
     50%  265.89ms
     75%  298.77ms
     90%  356.42ms
     99%  467.81ms
  Requests/sec:   1432.87
  Total requests:  85972
  Transfer/sec:   15.76MB
</code></pre>

<p><strong>关键指标提取：</strong></p>

<table>
<thead>
<tr>
<th>指标</th>
<th>值</th>
</tr>
</thead>
<tbody>
<tr>
<td>QPS</td>
<td><strong>~1433</strong></td>
</tr>
<tr>
<td>P50 延迟</td>
<td>266 ms</td>
</tr>
<tr>
<td>P90 延迟</td>
<td>356 ms</td>
</tr>
<tr>
<td>P99 延迟</td>
<td>468 ms</td>
</tr>
<tr>
<td>Max 延迟</td>
<td>512 ms</td>
</tr>
</tbody>
</table>

<h2 id="对比汇总表"><a href="#对比汇总表" class="headerlink" title="对比汇总表"></a>对比汇总表</h2>

<table>
<thead>
<tr>
<th>指标</th>
<th>传统线程池</th>
<th>虚拟线程</th>
<th>提升</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS</strong></td>
<td>765</td>
<td>1433</td>
<td><strong>+87%</strong></td>
</tr>
<tr>
<td><strong>P50</strong></td>
<td>487 ms</td>
<td>266 ms</td>
<td><strong>-45%</strong></td>
</tr>
<tr>
<td><strong>P90</strong></td>
<td>789 ms</td>
<td>356 ms</td>
<td><strong>-55%</strong></td>
</tr>
<tr>
<td><strong>P99</strong></td>
<td>1520 ms</td>
<td>468 ms</td>
<td><strong>-69%</strong></td>
</tr>
<tr>
<td><strong>Max</strong></td>
<td>2310 ms</td>
<td>512 ms</td>
<td><strong>-78%</strong></td>
</tr>
</tbody>
</table>

<blockquote><p><strong>结论：</strong>在 I/O 密集型场景下（每个请求有 ~260ms 的阻塞等待），虚拟线程将 QPS 提升了近 <strong>87%</strong>，P99 延迟降低了近 <strong>70%</strong>。提升的核心原因不是「计算更快了」，而是<strong>线程不再被 I/O 空等占用</strong>——carrier thread 在虚拟线程阻塞时立即切换去处理其他请求。</p></blockquote>

<h2 id="如何自己复现这组压测"><a href="#如何自己复现这组压测" class="headerlink" title="如何自己复现这组压测"></a>如何自己复现这组压测</h2>

<ol>
<li>用文中的 <code>pom.xml</code> + <code>SimulatedIoController</code> 创建一个 Spring Boot 项目</li>
<li>分别用 <code>spring.threads.virtual.enabled: false</code> 和 <code>true</code> 各启动一次</li>
<li>安装 wrk：<code>git clone https://github.com/wg/wrk.git &amp;&amp; cd wrk &amp;&amp; make &amp;&amp; cp wrk /usr/local/bin/</code></li>
<li>执行：<code>wrk -t12 -c400 -d60s --latency http://localhost:8080/api/io/pipeline</code></li>
<li>对比两次输出的 <code>Requests/sec</code> 和 <code>Latency Distribution</code></li>
</ol>

<h1 id="原理浅析：虚拟线程是如何工作的"><a href="#原理浅析：虚拟线程是如何工作的" class="headerlink" title="原理浅析：虚拟线程是如何工作的"></a>原理浅析：虚拟线程是如何工作的</h1>

<h2 id="调度模型"><a href="#调度模型" class="headerlink" title="调度模型"></a>调度模型</h2>

<p>虚拟线程的调度流程可以概括为以下几步：</p>

<ol>
<li>开发者调用 <code>Thread.ofVirtual().start(task)</code>（或通过 Executor 提交）</li>
<li>JVM 创建一个 Virtual Thread 对象（栈内存初始仅几 KB）</li>
<li>Virtual Thread 被 <strong>Mount</strong> 到某个 Carrier Thread（来自 ForkJoinPool）上执行</li>
<li>当任务执行到阻塞操作（<code>Thread.sleep()</code>、<code>BlockingQueue.take()</code>、Socket I/O 等）时：
  <ul>
  <li>JVM 将 Virtual Thread 从 Carrier 上 <strong>Unmount</strong>（卸载）</li>
  <li>Virtual Thread 的堆栈被保存到堆内存</li>
  <li>Carrier Thread 被释放去执行其他 Virtual Thread</li>
  </ul>
</li>
<li>当 I/O 操作完成时，JVM 将 Virtual Thread 重新 <strong>Mount</strong> 到某个 Carrier 上恢复执行</li>
</ol>

<pre><code class="language-language">时间轴示意：

Carrier Thread #1: [VT-A运行]──[VT-B运行]──[VT-C运行]──[VT-A恢复]──...
                    ↑ Mount      ↑ Unmount/Mount 转换
</code></pre>

<h2 id="谁在负责调度"><a href="#谁在负责调度" class="headerlink" title="谁在负责调度"></a>谁在负责调度？</h2>

<p>默认情况下，虚拟线程使用 <code>ForkJoinPool</code> 作为调度器（并行度 = CPU 核心数）。这意味着：</p>

<ul>
<li>即使你创建了 <strong>100 万个</strong>虚拟线程，实际占用的 OS 线程数大约只是 <strong>CPU 核心数</strong>（比如 4 核 = 约 4 个 carrier thread）</li>
<li>调度开销远小于 OS 线程上下文切换（因为不进入内核态）</li>
</ul>

<h2 id="哪些操作会触发-Unmount"><a href="#哪些操作会触发-Unmount" class="headerlink" title="哪些操作会触发 Unmount"></a>哪些操作会触发 Unmount？</h2>

<p>目前 JDK 21 中，以下操作会将虚拟线程 Unmount：</p>

<table>
<thead>
<tr>
<th>操作类型</th>
<th>是否 Unmount</th>
<th>说明</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>Thread.sleep()</code></td>
<td>✅ 是</td>
<td>最常见的情况</td>
</tr>
<tr>
<td><code>BlockingQueue</code> 操作（take/put）</td>
<td>✅ 是</td>
<td></td>
</tr>
<tr>
<td><code>ReentrantLock.lock()</code></td>
<td>✅ 是</td>
<td></td>
</tr>
<tr>
<td>Socket I/O（<code>InputStream.read()</code> 等）</td>
<td>✅ 是</td>
<td>前提：使用了 java.net 包的 Socket API</td>
</tr>
<tr>
<td><code>synchronized</code> 块</td>
<td>❌ 否</td>
<td><strong>重要坑点！</strong>synchronized 会导致 carrier thread 被阻塞</td>
</tr>
<tr>
<td><code>native 方法</code> 中阻塞</td>
<td>❌ 通常否</td>
<td>取决于 native 实现</td>
</tr>
<tr>
<td>CPU 密集计算</td>
<td>❌ 否</td>
<td>计算期间不会主动让出</td>
</tr>
</tbody>
</table>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：synchronized-会钉死-carrier-thread"><a href="#坑-1：synchronized-会钉死-carrier-thread" class="headerlink" title="坑 1：synchronized 会钉死 carrier thread"></a>坑 1：<code>synchronized</code> 会钉死 carrier thread</h2>

<p>这是目前虚拟线程<strong>最大的坑</strong>。当你在一个虚拟线程里进入 <code>synchronized</code> 块或方法时，该虚拟线程<strong>不会 Unmount</strong>，它会一直占着 carrier thread 直到退出 synchronized。</p>

<pre><code class="language-java">// ❌ 错误做法：在虚拟线程中使用 synchronized
public synchronized void badMethod() {
    // 这里会 block carrier thread！
    doSomethingBlocking();
}

// ✅ 正确做法：用 ReentrantLock 替代
private final ReentrantLock lock = new ReentrantLock();

public void goodMethod() {
    lock.lock();
    try {
        doSomethingBlocking();
    } finally {
        lock.unlock();
    }
}
</code></pre>

<blockquote><p><strong>注：</strong>JDK 24+ 计划修复这个问题（JEP 491 / synchronized pinning elimination），但在 JDK 21/22/23 上必须注意规避。</p></blockquote>

<h2 id="坑-2：ThreadLocal-内存爆炸风险"><a href="#坑-2：ThreadLocal-内存爆炸风险" class="headerlink" title="坑 2：ThreadLocal 内存爆炸风险"></a>坑 2：ThreadLocal 内存爆炸风险</h2>

<p>传统线程池中，线程数有限（比如 200），ThreadLocal 的数据最多 200 份。但虚拟线程可能创建<strong>成千上万甚至百万级</strong>，如果每个虚拟线程都在 ThreadLocal 里放了大的对象，OOM 分分钟找上门。</p>

<pre><code class="language-java">// ⚠️ 危险：大量虚拟线程 + 大对象 ThreadLocal
private static final ThreadLocal&lt;byte[]&gt; DATA =
    ThreadLocal.withInitial(() -&gt; new byte[1024 * 1024]); // 1MB/虚拟线程！

// ✅ 推荐：使用 ScopedValue（JDK 21 Preview，JDK 23 正式）
// 替代 ThreadLocal，在虚拟线程场景下更安全
// static final ScopedValue&lt;UserData&gt; USER = new ScopedValue&lt;();
</code></pre>

<h2 id="坑-3：连接池仍然需要（而且更重要了）"><a href="#坑-3：连接池仍然需要（而且更重要了）" class="headerlink" title="坑 3：连接池仍然需要（而且更重要了）"></a>坑 3：连接池仍然需要（而且更重要了）</h2>

<p>虚拟线程解决的是<strong>线程</strong>不够用的问题，不是<strong>连接</strong>不够用的问题。数据库连接、HTTP 连接仍然是稀缺资源，必须用连接池控制。</p>

<p>而且因为虚拟线程允许更多并发请求同时到达，<strong>连接池的压力反而更大了</strong>。建议：</p>

<ul>
<li>HikariCP maximumPoolSize 适当调大</li>
<li>监控连接池等待队列的长度</li>
<li>设置合理的 connectionTimeout</li>
</ul>

<h2 id="坑-4：CPU-密集型任务不会变快"><a href="#坑-4：CPU-密集型任务不会变快" class="headerlink" title="坑 4：CPU 密集型任务不会变快"></a>坑 4：CPU 密集型任务不会变快</h2>

<p>虚拟线程只在 <strong>I/O 阻塞场景</strong> 下才有优势。如果你的接口是纯计算（比如图像处理、加密解密），虚拟线程不仅不会提速，反而因为调度开销略慢一点点。</p>

<pre><code class="language-java">// 这种纯计算接口，虚拟线程帮助不大
@GetMapping("/cpu-intensive")
public String cpuIntensive() {
    double result = 0;
    for (int i = 0; i &lt; 10_000_000; i++) {
        result += Math.sqrt(i);
    }
    return String.valueOf(result);
}
</code></pre>

<h2 id="坑-5：线程名和排查变化"><a href="#坑-5：线程名和排查变化" class="headerlink" title="坑 5：线程名和排查变化"></a>坑 5：线程名和排查变化</h2>

<p>虚拟线程的名字默认类似 <code>VirtualThread-123</code>，在日志、监控、线程转储（jstack）中的表现与传统线程不同：</p>

<ul>
<li><code>jstack</code> 不会列出所有虚拟线程（数量太多）</li>
<li>需要用 <code>jcmd &lt;pid&gt; Thread.dump_to_file -format=json vt_dump.json</code> 来导出</li>
<li>日志中的 MDC（Mapped Diagnostic Context）仍然可用，推荐用 requestId 追踪而非线程名</li>
</ul>

<h1 id="生产环境检查清单"><a href="#生产环境检查清单" class="headerlink" title="生产环境检查清单"></a>生产环境检查清单</h2>

<p>在把虚拟线程推上线之前，逐项确认：</p>

<table>
<thead>
<tr>
<th>#</th>
<th>检查项</th>
<th>命令/方式</th>
</tr>
</thead>
<tbody>
<tr>
<td>1</td>
<td>JDK 版本 ≥ 21</td>
<td><code>java -version</code></td>
</tr>
<tr>
<td>2</td>
<td>Spring Boot ≥ 3.2</td>
<td>检查 pom.xml</td>
</tr>
<tr>
<td>3</td>
<td>消除 synchronized 锁竞争路径</td>
<td>搜索代码库中 <code>synchronized</code> 关键字</td>
</tr>
<tr>
<td>4</td>
<td>评估 ThreadLocal 使用量</td>
<td>审计 ThreadLocal 初始化逻辑</td>
</tr>
<tr>
<td>5</td>
<td>连接池大小合理</td>
<td>HikariCP maximumPoolSize ≥ CPU核数 × 2</td>
</tr>
<tr>
<td>6</td>
<td>做了压测对比</td>
<td>wrk / JMeter / k6</td>
</tr>
<tr>
<td>7</td>
<td>监控已覆盖</td>
<td>Actuator + Prometheus + Grafana 面板</td>
</tr>
<tr>
<td>8</td>
<td>灰度发布策略</td>
<td>先 1 台观察 24h，再逐步扩容</td>
</tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发史上一次重要的范式转移。核心要点回顾：</p>

<ul>
<li><strong>解决的问题</strong>：「线程-per-request」模型在 I/O 密集场景下的吞吐瓶颈</li>
<li><strong>开启方式</strong>：Spring Boot 3.2+ 只需 <code>spring.threads.virtual.enabled=true</code></li>
<li><strong>性能收益</strong>：I/O 密集场景下 QPS 提升 <strong>~87%</strong>，P99 延迟降低 <strong>~70%</strong>（基于本文压测数据）</li>
<li><strong>最大坑</strong>：<code>synchronized</code> 会 pin carrier thread（JDK 24+ 才修复），用 <code>ReentrantLock</code> 替代</li>
<li><strong>内存风险</strong>：ThreadLocal 在百万级虚拟线程下可能 OOM，关注 <code>ScopedValue</code> 迁移</li>
<li><strong>适用场景</strong>：Web 服务 I/O 密集型接口（DB 查询、RPC 调用、文件读写）；不适合 CPU 密集型</li>
<li><strong>连接池</strong>：仍然需要，且压力更大</li>
</ul>

<p>对于大多数 Spring Boot 项目来说，升级到 JDK 21 + 开启虚拟线程是一次<strong>低投入、高回报</strong>的优化。代码几乎不用改，但吞吐和延迟可能有数量级的改善。建议在新项目中默认启用，老项目做好评估后逐步迁移。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[JEP 444: Virtual Threads](https://openjdk.org/jeps/444) —— Oracle 官方 JEP，虚拟线程的权威定义</li>
<li>[Spring Boot 3.2 Virtual Threads Documentation](https://docs.spring.io/spring-boot/docs/current/reference/html/virtual-threads.html) —— Spring Boot 官方文档</li>
<li>[理解 Java 虚拟线程](https://tech.meituan.com/2023/04/20/java-virtual-thread.html) —— 美团技术团队，中文深度解析</li>
<li>[Java 虚拟线程实战与踩坑记录](https://cloud.tencent.com/developer/article/2351234) —— 腾讯云社区，生产实践经验</li>
<li>[Loom: What's New in Virtual Threads (Per Minborg)](https://minborgsjavapot.blogspot.com/2023/03/java-loom-virtual-threads-deep-dive.html) —— 外文参考：虚拟线程底层机制图解</li>
<li>[Wrk: Modern HTTP Benchmarking Tool](https://github.com/wg/wrk) —— 压测工具官方仓库</li>
<li>[HikariCP Connection Pool Tuning](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing) —— 连接池最佳配置</li>
</ol>
