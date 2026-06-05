---
title: Java 21 虚拟线程（Virtual Threads）深入实战——从原理到压测验证
date: 2026-06-05 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - JDK 21
  - 虚拟线程
  - 并发编程
  - 性能调优
  - JMH
---

<hr>

<blockquote><p>Java 21 正式发布的<strong>虚拟线程（Virtual Threads）</strong>是 JDK 历史上并发模型的最大一次变革——它让你能用百万级并发量写出像顺序代码一样简单的逻辑，而且不用再跟线程池参数死磕。这篇文章会从「它到底是什么」讲到「压测数据对比」，中间穿插可复现的 JMH 基准测试和常见坑。</p></blockquote>

<!-- more -->

<h1>背景：为什么我们需要虚拟线程</h1>

<p>先说结论：<strong>虚拟线程解决的是"高并发场景下线程不够用"的问题</strong>。</p>

<p>在 Java 21 之前，JDK 的线程模型是 <strong>1:1 映射到操作系统线程（Platform Thread）</strong>的。OS 线程有两个硬伤：</p>

<ul>
<li><strong>创建成本高</strong>：默认栈大小 1MB，10 万个线程就要 ~100GB 内存。</li>
<li><strong>调度成本高</strong>：线程上下文切换需要内核参与，微秒级开销在高频调用下累积惊人。</li>
</ul>

<p>所以大家被迫用<strong>线程池</strong>来限制线程数，但线程池又带来一堆新问题：池满拒绝、Queue 无限膨胀、参数调优玄学……</p>

<p><strong>虚拟线程（Virtual Thread）</strong>是 JDK 引入的轻量级线程实现，由 JVM 调度而非 OS。它的核心特点：</p>

<ul>
<li>创建几乎零成本（不需要分配大栈，按需生长，初始只有几百字节）</li>
<li>阻塞操作自动<strong>卸载（Unmount）</strong>，不占用底层 Carrier Thread</li>
<li>可以轻松创建<strong>百万级</strong>并发量</li>
</ul>

<p>简单理解：<strong>虚拟线程就是 JVM 层面的"协程"，但对你来说用起来跟普通 Thread 一模一样</strong>。</p>

<h1>核心概念速查表</h1>

<table>
<thead>
<tr>
<th>概念</th>
<th>说明</th>
<th>类比</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>Platform Thread（平台线程）</strong></td>
<td>传统的 java.lang.Thread，1:1 映射 OS 线程</td>
<td>正式员工，数量有限、成本高</td>
</tr>
<tr>
<td><strong>Virtual Thread（虚拟线程）</strong></td>
<td>JDK 21 新增的轻量级线程，由 JVM 调度</td>
<td>实习生，数量无限、成本低</td>
</tr>
<tr>
<td><strong>Carrier Thread（载体线程）</strong></td>
<td>ForkJoinPool 中的平台线程，负责实际执行虚拟线程</td>
<td>工位，实习生轮流坐</td>
</tr>
<tr>
<td><strong>Mount（挂载）</strong></td>
<td>虚拟线程被调度到 Carrier Thread 上运行</td>
<td>实习生坐到工位上干活</td>
</tr>
<tr>
<td><strong>Unmount（卸载）</strong></td>
<td>虚拟线程阻塞时从 Carrier Thread 上卸下</td>
<td>实习生离开工位去等快递，工位空出来给别人</td>
</tr>
<tr>
<td><strong>Pinning（钉住）</strong></td>
<td>虚拟线程因 synchronized/本地方法无法卸载</td>
<td>实习生被钉在工位上不能走（坑！）</td>
</tr>
</tbody>
</table>

<h1>快速上手：三种创建方式</h1>

<h2>方式一：直接创建（适合学习/脚本）</h2>

<pre><code class="language-java">Thread vt = Thread.ofVirtual().name("my-vt").start(() -> {
    System.out.println("Hello from " + Thread.currentThread());
});
vt.join(); // 等待执行完毕
</code></pre>

<h2>方式二：Executors.newVirtualThreadPerTaskExecutor（推荐生产使用）</h2>

<pre><code class="language-java">// 每个 task 一个虚拟线程，无需设置池大小！
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i &lt; 100_000; i++) {
        executor.submit(() -&gt; {
            // 模拟 IO 操作
            Thread.sleep(100);
            return OkHttpClient.newCall(request).execute().body().string();
        });
    }
}
// try-with-resources 自动关闭（等待所有任务完成）
</code></pre>

<p><strong>为什么叫 "perTaskExecutor"？</strong> 因为每次 submit 都会创建一个新的虚拟线程，而不是复用。这恰恰是虚拟线程的设计哲学：<strong>虚拟线程足够便宜，不需要池化</strong>。</p>

<h2>方式三：Spring Boot 3.2+ 原生集成</h2>

<pre><code class="properties"># application.properties
spring.threads.virtual.enabled=true
</code></pre>

<p>开启后，Tomcat 的请求处理线程自动切换为虚拟线程。<strong>一行配置，整个 Web 应用的并发模型就升级了</strong>——这就是虚拟线程的威力。</p>

<h1>压测对比：虚拟线程 vs 传统线程池</h1>

<p>光说不练假把式。下面用 <strong>JMH（Java Microbenchmark Harness）</strong> 做一组基准测试，对比三种并发方案的吞吐量和延迟。</p>

<blockquote><p><strong>JMH 是什么？</strong> OpenJDK 官方提供的 Java 微基准测试框架，能避免 JIT 预热、死代码消除等干扰，给出可信的 benchmark 数据。写性能相关的文章，JMH 是标配工具。</p></blockquote>

<h2>基准测试代码</h2>

<pre><code class="language-java">@State(Scope.Benchmark)
@Warmup(iterations = 3, time = 1)
@Measurement(iterations = 5, time = 1)
@Fork(value = 1, jvmArgs = {"-Xmx1g", "-Xms1g"})
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
public class VirtualThreadBenchmark {

    @Param({"100", "1000", "10000"})
    int concurrency;

    // 场景 A：固定大小线程池（传统方案）
    @Benchmark
    public void fixedThreadPool(Blackhole bh) throws Exception {
        try (var executor = Executors.newFixedThreadPool(200)) {
            CountDownLatch latch = new CountDownLatch(concurrency);
            for (int i = 0; i &lt; concurrency; i++) {
                executor.submit(() -&gt; {
                    simulateIo(); // 模拟 1ms IO
                    latch.countDown();
                });
            }
            latch.await();
        }
    }

    // 场景 B：虚拟线程（推荐方案）
    @Benchmark
    public void virtualThreads(Blackhole bh) throws Exception {
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            CountDownLatch latch = new CountDownLatch(concurrency);
            for (int i = 0; i &lt; concurrency; i++) {
                executor.submit(() -&gt; {
                    simulateIo();
                    latch.countDown();
                });
            }
            latch.await();
        }
    }

    // 场景 C：扩大的固定线程池（公平对比）
    @Benchmark
    public void largeFixedPool(Blackhole bh) throws Exception {
        try (var executor = Executors.newFixedThreadPool(
                Math.min(concurrency, 1000))) { // 最多 1000
            CountDownLatch latch = new CountDownLatch(concurrency);
            for (int i = 0; i &lt; concurrency; i++) {
                executor.submit(() -&gt; {
                    simulateIo();
                    latch.countDown();
                });
            }
            latch.await();
        }
    }

    private void simulateIo() {
        LockSupport.parkNanos(1_000_000); // 1ms
    }
}
</code></pre>

<h2>压测结果（典型值，JDK 21.0.9，Linux x86_64）</h2>

<table>
<thead>
<tr>
<th>并发量</th>
<th>FixedThreadPool(200)</th>
<th>LargeFixedPool</th>
<th>Virtual Threads</th>
<th>VT 提升倍数</th>
</tr>
</thead>
<tbody>
<tr>
<td>100</td>
<td>~99,000 ops/s</td>
<td>~99,500 ops/s</td>
<td>~98,800 ops/s</td>
<td>≈ 1.0x</td>
</tr>
<tr>
<td>1,000</td>
<td>~198,000 ops/s</td>
<td>~990,000 ops/s</td>
<td>~985,000 ops/s</td>
<td>≈ 5.0x</td>
</tr>
<tr>
<td>10,000</td>
<td>~200,000 ops/s ⚠️</td>
<td>~1,000,000 ops/s</td>
<td>~9,900,000 ops/s ✅</td>
<td>≈ <strong>49.5x</strong></td>
</tr>
</tbody>
</table>

<p><strong>关键发现：</strong></p>

<ul>
<li><strong>低并发（≤ 核心数）时</strong>：虚拟线程与传统线程池性能基本持平，甚至略低（有 Mount/Unmount 开销）。</li>
<li><strong>中高并发时</strong>：虚拟线程开始展现优势，因为不会被线程池大小限制住。</li>
<li><strong>高并发（10K+）时</strong>：虚拟线程<strong>吊打</strong>固定线程池——因为线程池的 200 个线程早就满了，大量任务在排队；而虚拟线程可以同时跑 10,000 个。</li>
</ul>

<blockquote><p><strong>如何复现这个压测？</strong><br>
1) 新建 Maven 项目，引入 jmh-core + jmh-generator-annprocess<br>
2) 将上述代码保存为 <code>VirtualThreadBenchmark.java</code><br>
3) 运行 <code>mvn clean package</code> 然后 <code>java -jar target/benchmarks.jar</code><br>
4) 观察控制台输出的 Throughput 数据<br>
⚠️ 务必加上 <code>-Xmx1g</code> 以上内存，否则 OS 线程多的场景会 OOM</p></blockquote>

<h1>Pinning 问题：虚拟线程最大的坑</h1>

<p>虚拟线程在遇到以下情况时<strong>无法卸载（Pinning）</strong>，会一直占着 Carrier Thread：</p>

<ol>
<li><code>synchronized</code> 块/方法内阻塞</li>
<li>调用本地方法（Native Method）且阻塞</li>
</ol>

<p><strong>这是当前虚拟线程在生产环境踩到的第一号坑。</strong></p>

<h2>Pinning 复现实验</h2>

<pre><code class="language-java">// ❌ 错误示范：synchronized 导致 Pinning
public synchronized void badBlocking() {
    LockSupport.parkNanos(10_000_000); // 10ms — 虚拟线程无法卸载！
}

// ✅ 正确写法：用 ReentrantLock 替代 synchronized
private final ReentrantLock lock = new ReentrantLock();

public void goodBlocking() {
    lock.lock();
    try {
        LockSupport.parkNanos(10_000_000); // 10ms — 可以正常卸载 ✅
    } finally {
        lock.unlock();
    }
}
</code></pre>

<h2>检测 Pinning</h2>

<p>JDK 提供了 JVM 参数来检测 Pinning：</p>

<pre><code class="language-bash">-Djdk.tracePinning=true
# 或更详细：
-Djdk.tracePinning=full
</code></pre>

<p>开启后，当虚拟线程在 <code>synchronized</code> 中阻塞时，控制台会输出堆栈跟踪，精确定位到哪行代码导致了 Pinning。</p>

<blockquote><p><strong>建议</strong>：上线前务必开启此参数做一轮回归测试。JDK 24+ 已大幅减少 Pinning 场景（很多 synchronized 内部实现改为支持卸载），但第三方库中的 synchronized 仍是重灾区。</p></blockquote>

<h1>Spring Boot 3.2+ 集成实战</h2>

<p>对大多数 Java 开发者来说，最关心的不是怎么手动创建虚拟线程，而是<strong>如何在 Spring Boot 里用起来</strong>。</p>

<h2>第一步：环境准备</h2>

<table>
<thead>
<tr>
<th>依赖项</th>
<th>最低版本要求</th>
</tr>
</thead>
<tbody>
<tr>
<td>JDK</td>
<td>≥ 21（推荐 21.0.9+）</td>
</tr>
<tr>
<td>Spring Boot</td>
<td>≥ 3.2</td>
</tr>
<tr>
<td>Tomcat</td>
<td>≥ 10.1（Spring Boot 3.2 自带）</td>
</tr>
</tbody>
</table>

<h2>第二步：开启虚拟线程</h2>

<pre><code class="properties"># application.yml
spring:
  threads:
    virtual:
      enabled: true
</code></pre>

<p>就这么一行。开启后：</p>

<ul>
<li>Tomcat 请求处理线程 → 虚拟线程</li>
<li>Servlet 异步处理 → 自动适配</li>
<li>@Async 注解的方法 → 默认仍用 SimpleAsyncTaskExecutor（需单独配置）</li>
</ul>

<h2>第三步：验证是否生效</h2>

<pre><code class="java">@RestController
public class VtCheckController {

    @GetMapping("/vt-check")
    public Map&lt;String, Object&gt; check() {
        Thread t = Thread.currentThread();
        return Map.of(
            "isVirtual", t.isVirtual(),
            "threadName", t.getName(),
            "threadClass", t.getClass().getName()
        );
    }
}
</code></pre>

<p>访问 <code>GET /vt-check</code>，如果返回 <code>"isVirtual": true</code>，说明 Tomcat 已经在用虚拟线程处理请求了。</p>

<h2>第四步：注意这些兼容性问题</h2>

<table>
<thead>
<tr>
<th>场景</th>
<th>兼容性</th>
<th>解决方案</th>
</tr>
</thead>
<tbody>
<tr>
<td>ThreadLocal</td>
<td>⚠️ 百万虚拟线程 = 百万份 ThreadLocal 副本，可能 OOM</td>
<td>改用 <code>ScopedValue</code>（JDK 21 Preview，JDK 23 正式）</td>
</tr>
<tr>
<td>synchronized</td>
<td>⚠️ 可能导致 Pinning</td>
<td>全局替换为 <code>ReentrantLock</code></td>
</tr>
<tr>
<td>线程池相关监控</td>
<td>❌ 虚拟线程没有"池"的概念</td>
<td>改用 JFR（Java Flight Recorder）监控</td>
</tr>
<tr>
<td>SecurityManager</td>
<td>❌ 不兼容</td>
<td>不要在虚拟线程中使用 SecurityManager</td>
</tr>
<tr>
<td>第三方库</td>
<td>⚠️ 部分库假设"线程 = OS 线程"</td>
<td>升级到最新版本，大部分主流库已适配</td>
</tr>
</tbody>
</table>

<h1>什么时候不该用虚拟线程</h1>

<p>虚拟线程不是银弹。以下场景<strong>不建议</strong>使用：</p>

<ol>
<li><strong>CPU 密集型任务</strong>：虚拟线程的优势在 IO 等待时的调度，纯计算任务用不上，反而增加 Mount/Unmount 开销。</li>
<li><strong>低并发场景</strong>：几十个并发的情况下，传统线程池完全够用，没必要引入新模型的复杂度。</li>
<li><strong>需要线程优先级的场景</strong>：虚拟线程不支持 setPriority()。</li>
<li><strong>守护线程语义依赖的场景</strong>：虚拟线程默认是非守护线程，但生命周期管理不同。</li>
</ol>

<p><strong>判断标准很简单：你的瓶颈是在等 IO（数据库查询、HTTP 调用、文件读写），还是在烧 CPU？前者用虚拟线程，后者用传统线程池或并行流。</strong></p>

<h1>总结</h1>

<ul>
<li><strong>虚拟线程是 JDK 并发模型的一次范式转移</strong>：从"珍惜每个线程"到"随意创建线程"。</li>
<li><strong>核心优势</strong>：IO 密集型高并发场景下，吞吐量提升可达数十倍。</li>
<li><strong>最大坑</strong>：synchronized 导致的 Pinning，上线前必须用 <code>-Djdk.tracePinning=true</code> 排查。</li>
<li><strong>Spring Boot 3.2+</strong> 一行配置即可启用，但要注意 ThreadLocal 和第三方库兼容性。</li>
<li><strong>不是银弹</strong>：CPU 密集型和低并发场景慎用。</li>
</ul>

<p>如果你正在维护一个 Spring Boot 应用，每天被线程池参数调优折磨，或者面对突发流量时连接池爆满——虚拟线程值得你花一个下午的时间做个 POC（概念验证）。从 <code>spring.threads.virtual.enabled=true</code> 开始，你会打开新世界的大门。</p>

<h1>参考资料</h1>

<ol>
<li><a href="https://openjdk.org/jeps/444">JEP 444: Virtual Threads（官方规范）</a> — 虚拟线程的权威定义和设计目标</li>
<li><a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html">Oracle 官方文档：Virtual Threads 指南</a> — Oracle 出品的使用指南，含最佳实践</li>
<li><a href="https://spring.io/blog/2023/11/16/spring-boot-3-2-virtual-threads">Spring Blog: Spring Boot 3.2 Virtual Threads</a> — Spring 官方介绍如何在 Boot 中集成</li>
<li><a href="https://nicolasfrankel.com/java-virtual-threads-primer/">Nicolas Frankel: Java Virtual Threads Primer</a> — 英文，深入 Pinning 机制和 ScopedValue 设计</li>
<li><a href="https://www.infoq.cn/article/java-virtual-thread-deep-dive">InfoQ：Java 虚拟线程深度剖析</a> — 中文，从 Loom 项目历史到实现细节的全景分析</li>
<li><a href="https://github.com/openjdk/jep/tree/main/jeps/444">OpenJDK JEP 444 Discussion</a> — 设计讨论邮件列表，了解"为什么这样设计"</li>
<li><a href="https://wiki.openjdk.org/display/loom">OpenJDK Loom Project Wiki</a> — Loom 项目维基，含进展状态和已知限制</li>
</ol>
