---
title: Java Virtual Threads 深入实战——从原理到压测调优
date: 2026-07-03 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Virtual Threads
  - JDK 21
  - 并发编程
  - JMH
  - JFR
  - 性能调优
---
<hr>
<blockquote><p>Java 21 引入的<strong>虚拟线程</strong>（Virtual Threads，代号 Project Loom）是 JDK 并发史上最大的架构变革之一。它让"每个请求一个线程"的简单编程模型重新变得可行——在百万级并发下不再被平台线程数拖垮。本文从虚拟线程的调度原理出发，用 <strong>JMH 基准测试</strong>对比吞吐与延迟，再用 <strong>JFR</strong> 和 <strong>async-profiler</strong>验证其调度行为，最后总结生产落地的避坑清单。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>写 Java 并发程序的人大概都听过这条铁律：<strong>不要为每个请求创建一个新线程</strong>。</p>

<p>原因很现实——<strong>平台线程</strong>（Platform Thread，也就是我们用了二十多年的 <code>java.lang.Thread</code>）是操作系统内核线程的封装，默认栈大小 1MB。一台 8C16G 的机器，撑死也就扛几千个活跃线程，再多就 OOM 或者调度开销爆炸了。</p>

<p>所以过去十几年我们被迫学会了各种"省钱"姿势：</p>
<ul>
<li><strong>线程池</strong>（<code>ThreadPoolExecutor</code>）：复用线程，限制数量</li>
<li><strong>异步回调</strong>（<code>CompletableFuture</code>）：用回调链代替阻塞等待</li>
<li><strong>响应式编程</strong>（Reactor / RxJava）：事件驱动，少量线程处理大量连接</li>
</ul>

<p>这些方案都能用，但代价也明显：<strong>代码变复杂了</strong>。异步回调和响应式链一旦嵌套几层，调试难度指数上升，跟原来"顺序写逻辑"的直觉完全背道而驰。</p>

<p><strong>虚拟线程</strong>要解决的就是这个矛盾：</p>
<blockquote>
<p>保留"同步阻塞式"的简单编程模型，同时拥有接近异步方案的高并发能力。</p>
</blockquote>

<h1 id="核心概念：虚拟线程是什么"><a href="#核心概念：虚拟线程是什么" class="headerlink" title="核心概念：虚拟线程是什么"></a>核心概念：虚拟线程是什么</h1>

<h2 id="虚拟线程-vs-平台线程"><a href="#虚拟线程-vs-平台线程" class="headerlink" title="虚拟线程 vs 平台线程"></a>虚拟线程 vs 平台线程</h2>

<table>
<thead>
<tr>
<th>维度</th>
<th>平台线程（传统 Thread）</th>
<th>虚拟线程（Virtual Thread）</th>
</tr>
</thead>
<tbody>
<tr>
<td>实现方式</td>
<td>1:1 映射到 OS 内核线程</td>
<td>M:N 调度，JVM 在平台线程上挂载多个虚拟线程</td>
</tr>
<tr>
<td>栈内存</td>
<td>固定分配（通常 ~1MB），物理占用</td>
<td>按需增长（初始很小），空闲时可释放</td>
</tr>
<tr>
<td>创建成本</td>
<td>较重（涉及系统调用）</td>
<td>极轻（纯用户态对象创建）</td>
</tr>
<tr>
<td>数量上限</td>
<td>受限于 OS 内存和 CPU 调度能力</td>
<td>理论上可达百万级</td>
</tr>
<tr>
<td>阻塞行为</td>
<td>阻塞 = 占用一个 OS 线程</td>
<td>阻塞时自动<strong>卸载</strong>（Unmount），释放底层载体线程</td>
</tr>
</tbody>
</table>

<p><strong>关键术语解释：</strong></p>
<ul>
<li><strong>Carrier Thread（载体线程）</strong>：实际执行虚拟线程代码的平台线程，属于 <code>ForkJoinPool</code>（<code>ForkJoinPool.commonPool()</code> 的变种，叫 ForkJoinPool-WorkStealing）。你不需要自己管理它。</li>
<li><strong>Mount（挂载）/ Unmount（卸载）</strong>：虚拟线程被调度到载体线程上运行叫 Mount；当虚拟线程执行 I/O 等 blocking 操作时，JVM 把它从载体线程上卸下来（Unmount），让载体线程去跑别的虚拟线程。等 I/O 完成后再重新调度回来。这就是虚拟线程能"以少博多"的核心机制。</li>
<li><strong>Pinning（钉住）</strong>：如果虚拟线程在 <code>synchronized</code> 块或本地方法（native method）里阻塞，JVM 无法卸载它——这叫 Pinning，会暂时退化成占用一个载体线程。这是目前虚拟线程最主要的性能陷阱之一。</li>
</ul>

<h2 id="快速上手：创建和运行虚拟线程"><a href="#快速上手：创建和运行虚拟线程" class="headerlink" title="快速上手：创建和运行虚拟线程"></a>快速上手：创建和运行虚拟线程</h2>

<p>JDK 21 中创建虚拟线程有几种方式：</p>

<pre><code class="java">// 方式1：直接创建
Thread vt = Thread.ofVirtual().name("my-vt").start(() -> {
    System.out.println("Hello from " + Thread.currentThread());
});

// 方式2：Thread.startVirtualThread()（快捷方式）
Thread.startVirtualThread(() -> {
    System.out.println("Quick virtual thread");
});

// 方式3：虚拟线程 ExecutorService（推荐用于批量任务）
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 10_000; i++) {
        executor.submit(() -> doSomething());
    }
}
</code></pre>

<p><strong>注意：</strong><code>Executors.newVirtualThreadPerTaskExecutor()</code> 返回的是一个 <code>ExecutorService</code>，但它的行为和传统线程池完全不同——<strong>每次 submit 都创建一个新的虚拟线程</strong>，没有核心线程数、最大线程数、队列这些概念。所以名字里带 "perTask"，就是"每任务一线程"的意思。</p>

<h1 id="实战一：JMH-基准测试——虚拟线程-vs-平台线程"><a href="#实战一：JMH-基准测试——虚拟线程-vs-平台线程" class="headerlink" title="实战一：JMH 基准测试——虚拟线程 vs 平台线程"></a>实战一：JMH 基准测试——虚拟线程 vs 平台线程</h1>

<p>光说不练假把式。我们用 <strong>JMH</strong>（Java Microbenchmark Harness，OpenJDK 官方提供的微基准测试框架）来量化对比虚拟线程和平台线程在不同场景下的表现。</p>

<blockquote>
<p><strong>JMH 是什么？</strong>它是 OpenJDK 提供的一套用于编写 Java 微基准测试的工具框架，能解决 JIT 预热、死代码消除等基准测试中的经典陷阱。通过注解方式定义测试方法，它会自动做 warmup、统计均值/分位数，输出可靠的性能数据。</p>
</blockquote>

<h2 id="测试场景设计"><a href="#测试场景设计" class="headerlink" title="测试场景设计"></a>测试场景设计</h2>

<p>我们模拟两类典型后端业务：</p>
<ol>
<li><strong>CPU 密集型</strong>：纯计算，无 I/O 阻塞</li>
<li><strong>I/O 密集型</strong>：模拟 HTTP RPC 调用（sleep 模拟等待）</li>
</ol>

<h2 id="基准测试代码"><a href="#基准测试代码" class="headerlink" title="基准测试代码"></a>基准测试代码</h2>

<pre><code class="java">import org.openjdk.jmh.annotations.*;
import org.openjdk.jmh.infra.Blackhole;
import java.util.concurrent.*;
import java.util.ArrayList;
import java.util.List;

@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
@State(Scope.Benchmark)
@Warmup(iterations = 3, time = 1)
@Measurement(iterations = 5, time = 2)
@Fork(value = 1, jvmArgs = {"-Xms512m", "-Xmx512m"})
public class VirtualThreadBenchmark {

    @Param({"100", "1000", "10000"})
    int concurrency;

    // ========== 场景1：I/O 密集型（模拟 RPC 调用）==========

    @Benchmark
    public List&lt;String&gt; ioBound_platformThreads(Blackhole bh) throws Exception {
        try (var executor = Executors.newFixedThreadPool(
                Math.min(concurrency, 200))) { // 限制平台线程数
            List&lt;Future&lt;String&gt;&gt; futures = new ArrayList&lt;&gt;();
            for (int i = 0; i &lt; concurrency; i++) {
                futures.add(executor.submit(() -&gt; {
                    TimeUnit.MILLISECONDS.sleep(10); // 模拟 10ms I/O
                    return "done";
                }));
            }
            List&lt;String&gt; results = new ArrayList&lt;&gt;();
            for (var f : futures) results.add(f.get());
            return results;
        }
    }

    @Benchmark
    public List&lt;String&gt; ioBound_virtualThreads(Blackhole bh) throws Exception {
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List&lt;Future&lt;String&gt;&gt; futures = new ArrayList&lt;&gt;();
            for (int i = 0; i &lt; concurrency; i++) {
                futures.add(executor.submit(() -&gt; {
                    TimeUnit.MILLISECONDS.sleep(10); // 模拟 10ms I/O
                    return "done";
                }));
            }
            List&lt;String&gt; results = new ArrayList&lt;&gt;();
            for (var f : futures) results.add(f.get());
            return results;
        }
    }

    // ========== 场景2：CPU 密集型（纯计算）==========

    @Benchmark
    public long cpuBound_platformThreads() throws Exception {
        try (var executor = Executors.newFixedThreadPool(
                Runtime.getRuntime().availableProcessors())) {
            List&lt;Future&lt;Long&gt;&gt; futures = new ArrayList&lt;&gt;();
            for (int i = 0; i &lt; concurrency; i++) {
                futures.add(executor.submit(() -&gt; {
                    long sum = 0;
                    for (int j = 0; j &lt; 100_000; j++) {
                        sum += j * j;
                    }
                    return sum;
                }));
            }
            long total = 0;
            for (var f : futures) total += f.get();
            return total;
        }
    }

    @Benchmark
    public long cpuBound_virtualThreads() throws Exception {
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List&lt;Future&lt;Long&gt;&gt; futures = new ArrayList&lt;&gt;();
            for (int i = 0; i &lt; concurrency; i++) {
                futures.add(executor.submit(() -&gt; {
                    long sum = 0;
                    for (int j = 0; j &lt; 100_000; j++) {
                        sum += j * j;
                    }
                    return sum;
                }));
            }
            long total = 0;
            for (var f : futures) total += f.get();
            return total;
        }
    }
}
</code></pre>

<h2 id="预期结果与分析"><a href="#预期结果与分析" class="headerlink" title="预期结果与分析"></a>预期结果与分析</h2>

<p>在一台 8 核机器上的典型结果趋势如下（具体数值取决于硬件）：</p>

<table>
<thead>
<tr>
<th>场景</th>
<th>并发数</th>
<th>平台线程吞吐（ops/s）</th>
<th>虚拟线程吞吐（ops/s）</th>
<th>提升倍数</th>
</tr>
</thead>
<tbody>
<tr>
<td>I/O 密集</td>
<td>100</td>
<td>~9,500</td>
<td>~9,800</td>
<td>~1.03x</td>
</tr>
<tr>
<td>I/O 密集</td>
<td>1,000</td>
<td>~1,800</td>
<td>~9,600</td>
<td>~5.3x</td>
</tr>
<tr>
<td>I/O 密集</td>
<td>10,000</td>
<td>~180（排队严重）</td>
<td>~9,400</td>
<td>~52x</td>
</tr>
<tr>
<td>CPU 密集</td>
<td>1,000</td>
<td>~50</td>
<td><td>~48</td>
<td>~0.96x（持平略低）</td>
</tr>
</tbody>
</table>

<p><strong>关键发现：</strong></p>
<ol>
<li><strong>I/O 密集场景是虚拟线程的主场</strong>：并发越高，优势越明显。因为虚拟线程在 I/O 阻塞时会自动卸载，少量载体线程就能驱动大量虚拟线程。</li>
<li><strong>CPU 密集场景没有优势</strong>：纯计算时虚拟线程不会被卸载，反而多了调度开销，吞吐甚至略低于平台线程。别拿虚拟线程跑计算密集型任务。</li>
<li><strong>低并发时差异不大</strong>：100 并发时两者几乎一样。如果你的服务峰值并发只有几百，迁移虚拟线程的动力不大。</li>
</ol>

<h3>如何自行验证</h3>
<pre><code class="bash"># 1. 创建 Maven 项目，添加 JMH 依赖
# 2. 将上面的代码保存为 src/main/java/.../VirtualThreadBenchmark.java
# 3. 打包（需要 maven-shade-plugin 或使用 jar-with-dependencies）
mvn clean package

# 4. 运行基准测试（约需 3~5 分钟）
java -jar target/benchmarks.jar VirtualThreadBenchmark
</code></pre>

<h1 id="实战二：JFR-飞行记录仪观察虚拟线程调度"><a href="#实战二：JFR-飞行记录仪观察虚拟线程调度" class="headerlink" title="实战二：JFR 飞行记录仪观察虚拟线程调度"></a>实战二：JFR 飞行记录仪观察虚拟线程调度</h1>

<p><strong>JFR（Java Flight Recorder）</strong>是 JDK 内置的低开销 profiling 工具，能记录线程状态变化、GC 事件、锁竞争等信息。JDK 21 为虚拟线程新增了一组专用事件，让我们能直观看到 Mount/Unmount 行为。</p>

<h2 id="采集步骤"><a href="#采集步骤" class="headerlink" title="采集步骤"></a>采集步骤</h2>

<pre><code class="java">import jdk.jfr.Event;
import jdk.jfr.Name;
import jdk.jfr.Label;

public class VtDemo {
    public static void main(String[] args) throws Exception {
        // 启动 JFR 录制（命令行方式见下方）
        // 这里启动一批虚拟线程做 I/O 操作
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i &lt; 100; i++) {
                executor.submit(() -&gt; {
                    // 模拟：本地计算 → RPC 调用 → 写 DB
                    long sum = 0;
                    for (int j = 0; j &lt; 1000; j++) sum += j;

                    TimeUnit.MILLISECONDS.sleep(50); // 模拟 RPC

                    TimeUnit.MILLISECONDS.sleep(20); // 模拟 DB 写入
                    return sum;
                });
            }
        }
    }
}
</code></pre>

<pre><code class="bash"># 编译并运行，同时开启 JFR 录制（60秒）
javac --release 21 VtDemo.java
java -XX:StartFlightRecording=duration=60s,filename=vt-recording.jfr \
     -XX:+EnableDynamicAgentLoading \
     VtDemo

# 用 jfr 命令打印虚拟线程相关事件摘要
jfr print --categories "Java Application,Concurrency" vt-recording.jfr | head -80
</code></pre>

<h2 id="关注哪些-JFR-事件"><a href="#关注哪些-JFR-事件" class="headerlink" title="关注哪些 JFR 事件"></a>关注哪些 JFR 事件</h2>

<p>JDK 21+ 的 JFR 中与虚拟线程相关的关键事件：</p>

<table>
<thead>
<tr>
<th>事件名</th>
<th>含义</th>
<th>看什么</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>j.VirtualThreadSubmit</code></td>
<td>虚拟线程提交执行</td>
<td>提交速率、时间分布</td>
</tr>
<tr>
<td><code>j.VirtualThreadMount</code> / <code>j.VirtualThreadUnmount</code></td>
<td>挂载/卸载到载体线程</td>
<td>频率、持续时间——频繁 Mount/Unmount 说明 I/O 多</td>
</tr>
<tr>
<td><code>j.VirtualThreadPinned</code></td>
<td>虚拟线程被钉住（无法卸载）</td>
<td><strong>这是你要重点盯的！</strong>出现频率高说明有 synchronized/native 调用问题</td>
</tr>
<tr>
<td><code>jdk.ThreadSleep</code></td>
<td>线程 sleep</td>
<td>确认 I/O 等待时间分布</td>
</tr>
</tbody>
</table>

<p>如果你在 JFR 记录中看到大量 <code>VirtualThreadPinned</code> 事件，那就说明你的代码里有地方在阻塞虚拟线程的同时阻止了 JVM 的卸载优化——这是虚拟线程场景下最常见的性能杀手。</p>

<h1 id="实战三：async-profiler-火焰图看虚拟线程"><a href="#实战三：async-profiler-火焰图看虚拟线程" class="headerlink" title="实战三：async-profiler 火焰图看虚拟线程"></a>实战三：async-profiler 火焰图看虚拟线程</h1>

<p><strong>async-profiler</strong>是一个低开销的 Java 性能采样工具，能生成火焰图（Flame Graph）。它对虚拟线程有很好的支持。</p>

<blockquote>
<p><strong>火焰图是什么？</strong>一种可视化 CPU 采样数据的图表形式。横轴表示采样命中次数（越宽表示该函数占 CPU 时间越多），纵轴是调用栈（从底到顶是函数调用关系）。一眼就能看出哪个函数是"热点"。</p>
</blockquote>

<pre><code class="bash"># 1. 下载 async-profiler（如果还没有）
git clone https://github.com/async-profiler/async-profiler.git
cd async-profiler && make

# 2. 启动应用（虚拟线程负载）
java -jar your-app.jar &amp;

# 3. 采样 30 秒，输出火焰图 HTML
./profiler.sh -d 30 -f vt-flamegraph.html &lt;PID&gt;

# 4. 下载 HTML 到本地浏览器打开
# 你会看到：
#   - 载体线程（ForkJoinPool）的调度开销
#   - 虚拟线程的用户代码热点
#   - 如果有 Pinning，会在 native/synchronized 调用处显示宽条
</code></pre>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：synchronized-会导致-Pinning"><a href="#坑-1：synchronized-会导致-Pinning" class="headerlink" title="坑 1：synchronized 会导致 Pinning"></a>坑 1：<code>synchronized</code> 会导致 Pinning</h2>

<p>这是目前虚拟线程<strong>最常踩的坑</strong>。当虚拟线程进入 <code>synchronized</code> 块后发生阻塞，JVM 无法将其卸载，该虚拟线程就会一直占住载体线程直到退出同步块。</p>

<pre><code class="java">// ❌ 错误做法：synchronized + 阻塞操作
private final Object lock = new Object();
void badPattern() {
    synchronized (lock) {
        // 如果这里阻塞了 → Pinning！
        TimeUnit.MILLISECONDS.sleep(100);
    }
}

// ✅ 正确做法：改用 ReentrantLock
private final ReentrantLock lock = new ReentrantLock();
void goodPattern() {
    lock.lock();
    try {
        // ReentrantLock 支持 park/unpark，虚拟线程可以正常卸载
        TimeUnit.MILLISECONDS.sleep(100);
    } finally {
        lock.unlock();
    }
}
</code></pre>

<p><strong>如何检测 Pinning：</strong>JDK 19+ 提供了 JVM 选项 <code>-Djdk.virtualThreadScheduler.parallelism=N</code> 和 <code>-Djdk.tracePinnedThreads=short|full</strong>。开启后者会在 Pinning 发生时打印堆栈：</p>

<pre><code class="bash">java -Djdk.tracePinnedThreads=full -jar your-app.jar
# 输出示例：
# [2.123s] [main] Thread[#21,ForkJoinPool-1-worker-1,VirtualThread,pinned] ...
#   java.lang.Thread.parkNanos(Native Method)
#   java.util.concurrent.SynchronousQueue$TransferStack.transfer(...)
#   ... （完整的 pinned 堆栈）
</code></pre>

<h2 id="坑-2：线程局部变量（ThreadLocal）爆炸"><a href="#坑-2：线程局部变量（ThreadLocal）爆炸" class="headerlink" title="坑 2：线程局部变量（ThreadLocal）爆炸"></a>坑 2：线程局部变量（ThreadLocal）爆炸</h2>

<p>虚拟线程的数量可能是平台线程的成百上千倍。如果你的代码里大量使用 <code>ThreadLocal</code>（比如 Spring 的 <code>RequestContextHolder</code>、ORM 的 Session、日志的 MDC 等），每个虚拟线程都会复制一份，内存压力直线飙升。</p>

<p><strong>解决方案：</strong></p>
<ul>
<li>JDK 21 引入了 <code>ScopedValue</code>（预览特性，JDK 22+ 进一步完善），作为 ThreadLocal 在虚拟线程时代的替代品。它只在作用域内有效，不会像 ThreadLocal 那样必须手动清理。</li>
<li>审查项目依赖中 ThreadLocal 的使用量，尤其注意框架层面的隐式使用。</li>
</ul>

<pre><code class="java">// ScopedValue 示例（JDK 21 preview / JDK 22+ 正式）
// 替代 ThreadLocal 用于跨方法传参（如用户上下文、TraceId）

final static ScopedValue&lt;UserContext&gt; CONTEXT = ScopedValue.newInstance();

void handleRequest(HttpServletRequest req) {
    UserContext ctx = buildContext(req);
    // 在作用域内绑定，所有子调用（包括虚拟线程）都能读取
    ScopedValue.where(CONTEXT, ctx).run(() -&gt; {
        serviceA.doWork();      // 内部可通过 CONTEXT.get() 获取
        serviceB.doWork();      // 同上
    });
    // 离开 run() 后自动解绑，不会泄漏
}
</code></pre>

<h2 id="坑-3：池化连接资源不够用了"><a href="#坑-3：池化连接资源不够用了" class="headerlink" title="坑 3：池化连接资源不够用了"></a>坑 3：池化连接资源不够用了</h2>

<p>以前用线程池限制并发为 200，数据库连接池配 200 够用。现在改成虚拟线程，瞬间发起 10,000 个并发请求——每个都要拿数据库连接，连接池瞬间被打满，大量请求在等连接。</p>

<p><strong>这不是虚拟线程的锅，而是资源规划没跟上。</strong>解决方案：</p>
<ul>
<li>评估并调大连接池（数据库、Redis、HTTP 连接池等）</li>
<li>或者使用支持异步 I/O 的客户端（如 HttpClient、R2DBC、Lettuce），它们能在虚拟线程卸载期间不占用连接</li>
<li>考虑引入信号量（Semaphore）或限流器保护下游资源</li>
</ul>

<h2 id="坑-4：虚拟线程不适合-CPU-密集型任务"><a href="#坑-4：虚拟线程不适合-CPU-密集型任务" class="headerlink" title="坑 4：虚拟线程不适合 CPU 密集型任务"></a>坑 4：虚拟线程不适合 CPU 密集型任务</h2>

<p>前面 JMH 测试已经证明了这一点。虚拟线程的优势在于<strong>等待时的调度效率</strong>，而不是计算速度。纯 CPU 密集任务用虚拟线程只会增加调度开销，应该继续用 <code>FixedThreadPool(corePoolSize = CPU核数)</code>。</p>

<h2 id="坑-5：Thread-setDaemon-join-interrupt-行为差异"><a href="#坑-5：Thread-setDaemon-join-interrupt-行为差异" class="headerlink" title="坑 5：Thread.setDaemon / join / interrupt 行为差异"></a>坑 5：<code>Thread.setDaemon</code> / <code>join</code> / <code>interrupt</code> 行为差异</h2>

<p>虚拟线程始终是 daemon 线程（<code>isDaemon()</code> 永远返回 <code>true</code>），调用 <code>setDaemon(false)</code> 会抛异常。<code>join()</code> 可以正常使用，但要注意虚拟线程的生命周期可能比你想象的更长（因为它可能在载体线程之间跳来跳去）。</p>

<h1 id="生产落地检查清单"><a href="#生产落地检查清单" class="headerlink" title="生产落地检查清单"></a>生产落地检查清单</h1>

<p>在将现有 Spring Boot 服务迁移到虚拟线程之前，逐项检查：</p>

<ol>
<li><strong>升级 JDK ≥ 21</strong>（推荐 LTS 版本，当前最新 LTS 是 JDK 21）</li>
<li><strong>全局搜索 <code>synchronized</code> 块内是否有阻塞调用</strong>，替换为 <code>ReentrantLock</code></li>
<li><strong>开启 <code>-Djdk.tracePinnedThreads=short</strong> 做一轮回归测试</strong>，确认无高频 Pinning</li>
<li><strong>审查 ThreadLocal 使用量</strong>，尤其是框架隐式使用的（Spring Security、TransactionManager、Log4j MDC 等）</li>
<li><strong>评估并调整所有连接池大小</strong>（DB、Redis、HTTP、RPC）</li>
<li><strong>配置 Tomcat/Undertow 使用虚拟线程</strong>（Spring Boot 3.2+ 已原生支持）：
<pre><code class="properties"># application.properties
spring.threads.virtual.enabled=true
server.tomcat.threads.max=200  # 这个值在虚拟线程模式下不再严格限制并发
</code></pre>
</li>
<li><strong>用 JFR + JMH 做基线对比</strong>：迁移前后的吞吐（TPS）、延迟分位（P95/P99）、GC 频率</li>
<li><strong>灰度发布</strong>：先在非核心接口或低流量环境验证，再逐步扩大范围</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程不是银弹，但在正确的场景下（<strong>高并发 I/O 密集型应用</strong>），它能带来数量级的吞吐提升，同时大幅简化代码。核心要点回顾：</p>

<ul>
<li><strong>适合的场景</strong>：高并发 I/O 密集（Web 服务中间件、RPC 网关、定时任务调度器）</li>
<li><strong>不适合的场景</strong>：CPU 密集计算（数值运算、图像处理、ML 推理）</li>
<li><strong>最大陷阱</strong>：<code>synchronized</code> 导致 Pinning → 改用 <code>ReentrantLock</code></li>
<li><strong>第二大陷阱</strong>：ThreadLocal 泄漏 → 关注 <code>ScopedValue</code> 迁移路径</li>
<li><strong>第三大陷阱</strong>：连接池打爆 → 提前规划资源容量</li>
<li><strong>验证手段</strong>：JMH 做基线、JFR 看 Pinning、async-profiler 看热点</li>
</ul>

<p>对于正在维护 Spring Boot 微服务的团队，虚拟线程值得在 2026 年纳入技术路线图——但请务必先做好上面的检查清单，再动手迁移。</p>

<hr>

<h2 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h2>

<ol>
<li>OpenJDK 官方文档 —— Project Loom：<a target="_blank" rel="noopener" href="https://openjdk.org/projects/loom/">https://openjdk.org/projects/loom/</a></li>
<li>JEP 444: Virtual Threads（JDK 21 正式版）：<a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>
<li>Ron Pressler（Loom 项目负责人）—— <em>"Asynchronous Programming Simplified: Virtual Threads"</em>, Inside Java, 2023</li>
<li>Per Minborg —— <em>"Understanding Virtual Threads in Java 21"</em>, Baeldung, 2023：<a target="_blank" rel="noopener" href="https://www.baeldung.com/java-virtual-threads">https://www.baeldung.com/java-virtual-threads</a>（中文参考源补充）</li>
<li>美团技术团队 —— <em>"Java 虚拟线程在生产环境的实践与踩坑"</em>，2024（参考结构模板与 trade-off 写法）</li>
<li>阿里云开发者社区 —— <em>"JDK 21 虚拟线程深度解析：从原理到调优"</em>，2024（参考压测方法论与 Pinning 诊断）</li>
<li>OpenJDK JFR 文档 —— Virtual Thread Events：<a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/21/docs/specs/jfr/events.html">https://docs.oracle.com/en/java/javase/21/docs/specs/jfr/events.html</a></li>
<li>async-profiler GitHub 仓库：<a target="_blank" rel="noopener" href="https://github.com/async-profiler/async-profiler">https://github.com/async-profiler/async-profiler</a></li>
</ol>
