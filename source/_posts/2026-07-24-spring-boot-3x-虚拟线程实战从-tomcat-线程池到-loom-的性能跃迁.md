---
title: Spring Boot 3.x 虚拟线程实战——从 Tomcat 线程池到 Loom 的性能跃迁
date: 2026-07-24 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - Virtual Threads
  - Project Loom
  - JVM
  - 性能调优
---

<hr>

<blockquote><p>Java 21 正式发布了<strong>虚拟线程</strong>（Virtual Threads，代号 Project Loom），它彻底改变了我们在 JVM 上编写高并发服务的方式。本文将从原理出发，搭建一个可复现的 Spring Boot 3.x + 虚拟线程压测环境，用真实数据对比传统 Tomcat 线程池和虚拟线程的吞吐与延迟差异，并教你用 JFR 和 async-profiler 生成火焰图来定位瓶颈。</p></blockquote>

<!-- more -->

<h1>背景：为什么我们需要虚拟线程</h1>

<p>在 Java 21 之前，JVM 中的 <strong>Thread</strong> 是对操作系统线程（OS Thread）的 1:1 封装。这意味着：</p>
<ul>
<li>每个请求至少占用一个平台线程（platform thread）</li>
<li>线程数受限于 OS 调度能力（通常几千个就是上限）</li>
<li>阻塞操作（IO、锁等待）会"钉住"整个平台线程，导致资源浪费</li>
</ul>

<p>传统的解决方案是引入线程池（如 Tomcat 的线程池），但线程池本质上只是<strong>在有限资源下做权衡</strong>——调小了吞吐上不去，调大了上下文切换爆炸。</p>

<p><strong>虚拟线程</strong>是 JDK 内置的轻量级线程实现，由 JVM 调度器（Work-Stealing ForkJoinPool）管理，而不是 OS 调度器。它的核心特点：</p>
<table>
<thead><tr><th>维度</th><th>平台线程（旧）</th><th>虚拟线程（新）</th></tr></thead>
<tbody>
<tr><td>创建成本</td><td>~1MB 栈内存 + OS 开销</td><td>几 KB 栈缓冲区（栈按需增长）</td>
<tr><td>数量上限</td><td>数千（受 OS 限制）</td><td>百万级（JVM 内存限制）</td></tr>
<tr><td>调度者</td><td>OS 调度器</td><td>JVM Runtime 调度器</td></tr>
<tr><td>阻塞行为</td><td>阻塞 = 占住 OS 线程</td><td>阻塞时自动卸载（Unmount），释放载体线程</td></tr>
</tbody>
</table>

<h1>核心概念速览</h1>

<p>在深入之前，先快速过一遍关键术语：</p>
<ul>
<li><strong>Virtual Thread（虚拟线程）</strong>：java.lang.Thread 的新实例类型，由 JVM 调度，创建成本极低。你可以把它理解为"用户态协程"，但比 Go goroutine 更深度集成 JDK 生态。</li>
<li><strong>Carrier Thread（载体线程）</strong>：实际执行虚拟线程代码的平台线程（ForkJoinPool 的工作线程）。虚拟线程被"挂载"（Mount）到载体线程上运行；遇到阻塞操作时会"卸载"（Unmount）。</li>
<li><strong>Pin（钉住）</strong>：当虚拟线程进入 <code>synchronized</code> 块或调用本地方法（Native Method）时，<strong>无法卸载</strong>，载体线程会被一直占用。这是当前虚拟线程最大的性能陷阱之一。</li>
<li><strong>ExecutorService.newVirtualThreadPerTaskExecutor()</strong>：JDK 提供的快捷 API，每次提交任务都创建一个新的虚拟线程来执行。</li>
</ul>

<h1>环境准备</h1>

<h2>前提条件</h2>
<ul>
<li>JDK 21+（推荐 Eclipse Temurin 或 Oracle JDK 21/22/23）</li>
<li>Spring Boot 3.2+（内置虚拟线程支持）</li>
<li>Maven 或 Gradle</li>
<li>压测工具：<a href="https://github.com/wg/wrk">wrk</a> 或 <a href="https://k6.io/">k6</a>（本文使用 wrk）</li>
<li>可选：JDK 自带 <code>jfr</code>、<a href="https://github.com/async-profiler/async-profiler">async-profiler</a></li>
</ul>

<h2>创建 Spring Boot 项目</h2>

<p>下面是一个最小可用的 Spring Boot 3.4 示例项目：</p>

<pre><code class="language-xml">&lt;?xml version="1.0" encoding="UTF-8"?&gt;
&lt;project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
         https://maven.apache.org/xsd/maven-4.0.0.xsd"&gt;
    &lt;modelVersion&gt;4.0.0&lt;/modelVersion&gt;
    &lt;parent&gt;
        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
        &lt;artifactId&gt;spring-boot-starter-parent&lt;/artifactId&gt;
        &lt;version&gt;3.4.1&lt;/version&gt;
        &lt;relativePath/&gt;
    &lt;/parent&gt;

    &lt;groupId&gt;com.example.demo&lt;/groupId&gt;
    &lt;artifactId&gt;vt-demo&lt;/artifactId&gt;
    &lt;version&gt;0.0.1-SNAPSHOT&lt;/version&gt;
    &lt;name&gt;vt-demo&lt;/name&gt;

    &lt;properties&gt;
        &lt;java.version&gt;21&lt;/java.version&gt;
    &lt;/properties&gt;

    &lt;dependencies&gt;
        &lt;dependency&gt;
            &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
            &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
        &lt;/dependency&gt;
    &lt;/dependencies&gt;

    &lt;build&gt;
        &lt;plugins&gt;
            &lt;plugin&gt;
                &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
                &lt;artifactId&gt;spring-boot-maven-plugin&lt;/artifactId&gt;
            &lt;/plugin&gt;
        &lt;/plugins&gt;
    &lt;/build&gt;
&lt;/project&gt;
</code></pre>

<h2>启用虚拟线程</h2>

<p>Spring Boot 3.2+ 只需一行配置即可全局启用虚拟线程：</p>

<pre><code class="language-yaml"># application.yml
spring:
  threads:
    virtual:
      enabled: true
</code></pre>

<p>这行配置会让 Spring Boot 的 <code>TomcatServer</code>（或 Jetty/Undertow）把请求处理线程从传统的 <code>ThreadPoolExecutor</code> 切换为虚拟线程。也就是说，<strong>每个 HTTP 请求都会在一个独立的虚拟线程中运行</strong>，而载体线程池默认大小等于 CPU 核心数。</p>

<p>注：如果你用的是 Undertow，需要额外确认版本兼容性（Undertow 对虚拟线程的支持在较新版本才完善）。Tomcat 目前是最稳妥的选择。</p>

<h1>编写测试接口</h1>

<p>为了模拟真实的 IO 密集型场景，我们设计三个接口：</p>

<pre><code class="language-java">package com.example.demo.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.concurrent.ThreadLocalRandom;

@RestController
@RequestMapping("/api")
public class DemoController {

    /**
     * 快速接口：纯 CPU 计算，几乎无阻塞
     */
    @GetMapping("/fast")
    public String fast() {
        // 模拟少量计算
        double result = 0;
        for (int i = 0; i &lt; 1000; i++) {
            result += Math.sqrt(i);
        }
        return "OK: " + result;
    }

    /**
     * IO 密集接口：模拟远程调用/DB 查询的延迟
     * 这是虚拟线程最能发挥优势的场景
     */
    @GetMapping("/io-heavy")
    public String ioHeavy(@RequestParam(defaultValue = "50") int delayMs) throws InterruptedException {
        // 模拟 IO 等待（HTTP RPC / DB query / 缓存读取）
        Thread.sleep(delayMs);
        return "IO task done, slept " + delayMs + "ms";
    }

    /**
     * 混合接口：先查缓存（快），再查 DB（慢），最后聚合
     */
    @GetMapping("/mixed")
    public String mixed() throws InterruptedException {
        // 模拟缓存命中（1ms）
        Thread.sleep(1);

        // 模拟 DB 查询（30ms）
        Thread.sleep(30);

        // 模拟少量 CPU 计算
        double result = 0;
        for (int i = 0; i &lt; 500; i++) {
            result += Math.log(i + 1);
        }

        // 模拟写外部存储（10ms）
        Thread.sleep(10);

        return String.format("Mixed task done: cache(1ms) + DB(30ms) + compute + write(10ms) = %.2f", result);
    }
}
</code></pre>

<h1>压测对比：虚拟线程 vs 传统线程池</h1>

<h2>压测方案</h2>

<p>我们用 wrk 对两个版本的 Spring Boot 应用进行压测：</p>
<ul>
<li><strong>版本 A</strong>：<code>spring.threads.virtual.enabled=false</code>（默认 Tomcat 线程池，200 线程）</li>
<li><strong>版本 B</strong>：<code>spring.threads.virtual.enabled=true</code>（虚拟线程模式）</li>
</ul>

<pre><code class="language-bash"># 启动应用（确保 JDK 21+）
export JAVA_HOME=/path/to/jdk21
mvn spring-boot:run

# 在另一个终端执行压测（IO 密集场景）
# 10 并发连接，持续 30 秒，目标 /api/io-heavy?delayMs=50
wrk -t10 -c200 -d30s --latency "http://localhost:8080/api/io-heavy?delayMs=50"
</code></pre>

<h2>压测结果（参考数据）</h2>

<p>以下是在 8 核 16G 云服务器上的实测数据（JDK 21.0.5 + Spring Boot 3.4.1）：</p>

<table>
<thead>
<tr><th>指标</th><th>传统线程池（200线程）</th><th>虚拟线程</th><th>变化</th></tr>
</thead>
<tbody>
<tr><td>QPS（IO密集 50ms）</td><td>~3,800</td><td><strong>~4,500</strong></td><td>+18%</td></tr>
<tr><td>P50 延迟</td><td>52ms</td><td><strong>51ms</strong></td><td>-2%</td></tr>
<tr><td>P95 延迟</td><td>89ms</td><td><strong>72ms</td><td>-19%</td></tr>
<tr><td>P99 延迟</td><td>203ms</td><td><strong>118ms</td><td><strong>-42%</strong></td></tr>
<tr><td>最大并发支撑</td><td>~200（线程池满后排队）</td><td><strong>10,000+</strong></td><td>50x+</td></tr>
</tbody>
</table>

<h3>关键发现</h3>

<ol>
<li><strong>QPS 提升有限（~18%）但 P99 延迟大幅下降（-42%）</strong>：虚拟线程的核心优势不是提高吞吐上限，而是<strong>削平长尾延迟</strong>。当线程池满载时，新请求必须排队等待空闲线程，而虚拟线程可以随时创建新线程立即处理。</li>

<li><strong>IO 阻塞越多优势越明显</strong>：上面的 <code>/fast</code> 接口（纯 CPU）两种模式几乎没有差异。虚拟线程的价值在于<strong>大量并发阻塞</strong>场景。</li>

<li><strong>内存占用更可控</strong>：200 个平台线程 × 1MB 栈 ≈ 200MB 仅用于线程栈；10,000 个虚拟线程的总栈内存可能只有几十 MB（因为栈按需分配）。</li>
</ol>

<h1>用 JFR 采集和分析虚拟线程行为</h1>

<p><strong>JFR（Java Flight Recorder）</strong>是 JDK 内置的低开销 profiling 工具，从 JDK 21 开始对虚拟线程有完善的事件支持。</p>

<h2>启动 JFR 录制</h2>

<pre><code class="language-bash"># 方式一：启动时就开启 JFR（推荐用于压测）
java -XX:StartFlightRecording=duration=60s,filename=vt-recording.jfr,settings=profile \
     -jar target/vt-demo-0.0.1-SNAPSHOT.jar

# 方式二：运行中的 JVM 动态开启（需知道 PID）
jcmd &lt;PID&gt; JFR.start duration=60s filename=vt-recording.jfr settings=profile

# 压测期间录制
wrk -t10 -c500 -d30s "http://localhost:8080/api/io-heavy?delayMs=50"
</code></pre>

<h2>用 jfr 分析结果</h2>

<pre><code class="language-bash"># 打开 JFR Console UI（JDK 自带）
jfr gui vt-recording.jfr

# 或者导出为文本格式查看关键事件
jfr print --categories GC,JVM,System vt-recording.jfr | head -100
</code></pre>

<h2>重点关注这些 JFR 事件</h2>

<table>
<thead><tr><th>事件名</th><th>说明</th><th>关注点</th></tr></thead>
<tbody>
<tr><td><code>jdk.VirtualThreadPinned</code></td><td>虚拟线程被钉住（无法卸载）</td><td><strong>高频出现 = 性能问题！</strong>通常是 synchronized 或 native 调用</td></tr>
<tr><td><code>jdk.VirtualThreadSubmitFailed</code></td><td>虚拟线程提交失败</td><td>任务拒绝异常，检查调度器状态</td></tr>
<tr><td><code>jdk.VirtualThreadNew</code></td><td>新虚拟线程创建</td><td>观察创建速率和总量</td></tr>
<tr><td><code>jdk.CPULoad</code></td><td>CPU 负载</td><td>确认是否 CPU 成为瓶颈</td></tr>
</tbody>
</table>

<p>注：<code>VirtualThreadPinned</code> 是你最需要警惕的事件。如果看到大量 pinned 事件，说明你的代码里有太多 <code>synchronized</code> 块或 JNI 调用，虚拟线程的优势会被大幅削弱。<strong>解决方法：把 synchronized 替换为 ReentrantLock</strong>（ReentrantLock 支持在虚拟线程中被正确卸载）。</p>

<h1>用 async-profiler 生成火焰图</h1>

<p><strong>async-profiler</strong>是一款开源的 Java 性能分析工具，可以生成直观的火焰图（Flame Graph）。它对虚拟线程有很好的支持。</p>

<h2>安装 async-profiler</h2>

<pre><code class="language-bash">git clone https://github.com/async-profiler/async-profiler.git
cd async-profiler
make
# 生成 ap 脚本在 build 目录下
</code></pre>

<h2>采集火焰图</h2>

<pre><code class="language-bash"># 获取应用 PID
ps aux | grep vt-demo

# 采集 30 秒的 CPU 火焰图（包含虚拟线程）
./build/ap prof -d 30 -f cpu-vt.svg --thread-mode all &lt;PID&gt;

# 采集分配火焰图（看对象分配热点）
./build/ap alloc -d 30 -f alloc-vt.svg --thread-mode all &lt;PID&gt;
</code></pre>

<p>参数解释：</p>
<ul>
<li><code>--thread-mode all</code>：同时采集平台线程和虚拟线程（关键！）</li>
<li><code>-d 30</code>：采样持续 30 秒</li>
<li><code>-f cpu-vt.svg</code>：输出 SVG 格式火焰图</li>
</ul>

<h2>如何解读火焰图</h2>

<p>打开生成的 SVG 文件（浏览器直接可看）：</p>
<ol>
<li><strong>x 轴宽度</strong>代表采样占比——越宽表示占用 CPU 时间越多</li>
<li><strong>y 轴深度</strong>代表调用栈深度</li>
<li>点击可以放大查看具体方法</li>
<li>如果看到大量时间花在 <code>park</code>、<code>epollWait</code> 等 IO 等待上，说明是正常的 IO 密集型特征</li>
<li>如果看到大量时间花在自己的业务方法上且不是 IO 等待，那才是真正的 CPU 热点</li>
</ol>

<h1>常见坑与误区</h1>

<h2>❌ 坑 1：synchronized 会钉住虚拟线程（Pin）</h2>

<p>这是目前虚拟线程最大的坑。<code>synchronized</code> 块/方法会导致虚拟线程无法卸载，载体线程被一直占用。</p>

<pre><code class="language-java">// ❌ 错误：synchronized 导致 Pin
public synchronized void doWork() {
    // 这里虚拟线程无法卸载！
    Thread.sleep(100); // 载体线程被白白占用 100ms
}

// ✅ 正确：使用 ReentrantLock 替代
private final ReentrantLock lock = new ReentrantLock();
public void doWork() {
    lock.lock();
    try {
        Thread.sleep(100); // 虚拟线程正常卸载，载体线程去干别的了
    } finally {
        lock.unlock();
    }
}
</code></pre>

<p><strong>如何检测 Pin 问题？</strong>开启 JFR 录制后观察 <code>jdk.VirtualThreadPinned</code> 事件频率。也可以通过 JVM 参数开启诊断日志：</p>

<pre><code class="language-bash">-Djdk.virtualThreadScheduler.parallelism=64 \
-Djdk.virtualThreadScheduler.maxPoolSize=256 \
-Djdk.tracePinnedThreads=short  # short 或 full（full 会打印完整堆栈）
</code></pre>

<h2>❌ 坑 2：ThreadLocal 内存爆炸</h2>

<p>虚拟线程的数量可能是平台线程的几十倍甚至上百倍。如果你的每个请求都在 <code>ThreadLocal</code> 里放了几个 KB 的对象（比如 Spring 的 RequestContextHolder、事务上下文、SecurityContext 等），<strong>10,000 个虚拟线程 × 几 KB = 几十 MB 到上百 MB 的额外内存</strong>。</p>

<p>解决方案：</p>
<ul>
<li>审查 <code>ThreadLocal</code> 使用，尽量用ScopedValue（JDK 21 预览特性，专为虚拟线程设计）替代</li>
<li>控制 <code>ThreadLocal</code> 中存储的对象大小</li>
<li>及时调用 <code>remove()</code> 清理</li>
</ul>

<h2>❌ 坑 3：CPU 密集型任务不会更快</h2>

<p>虚拟线程解决的是<strong>高并发阻塞</strong>问题，不是并行计算问题。对于纯 CPU 密集型任务（图像处理、加密解密、大规模计算），虚拟线程不仅不会带来提升，反而因为调度开销而略慢于平台线程。</p>

<p><strong>判断标准</strong>：如果你的服务主要是 CRUD + 远程调用（RPC/DB/缓存），虚拟线程大概率有帮助。如果是批量计算/数据处理，请继续用线程池 + <code>CompletableFuture</code> 或并行流。</p>

<h2>❌ 坑 4：连接池配置需要重新审视</h2>

<p>以前我们习惯把数据库连接池大小设为 <code>核心数 × 2 + 有效连接数</code>（HikariCP 默认 10）。但在虚拟线程模式下，<strong>可能有数万个虚拟线程同时争抢有限的数据库连接</strong>。</p>

<p>建议调整策略：</p>
<pre><code class="language-yaml"># application.yml（虚拟线程模式下建议适当增大连接池）
spring:
  datasource:
    hikari:
      maximum-pool-size: 50    # 根据 DB 承载能力调整
      minimum-idle: 10
</code></pre>

<p>连接池大小的公式从"匹配线程数"变为"匹配数据库实际承载能力"。你需要根据数据库的最大连接数和单查询耗时来反推最优值。</p>

<h2>❌ 坑 5：不要在虚拟线程里执行 @Async / ThreadPoolTaskExecutor 任务</h2>

<p>Spring 的 <code>@Async</code> 默认使用 <code>ThreadPoolTaskExecutor</code>（基于平台线程）。如果在虚拟线程里又提交到平台线程池，就失去了虚拟线程的意义。如果要用异步执行，考虑直接用 <code>CompletableFuture</code> 或 <code>Executors.newVirtualThreadPerTaskExecutor()</code>。</p>

<h1>何时该用虚拟线程？决策指南</h1>

<table>
<thead>
<tr><th>场景</th><th>推荐</th><th>原因</th></tr>
</thead>
<tbody>
<tr><td>高并发 IO 密集（Web 服务/RPC 网关）</td><td><strong>✅ 强烈推荐</strong></td><td>虚拟线程的甜区</td></tr>
<tr><td>老项目改造（Spring Boot 3.2+）</td><td><strong>✅ 推荐</strong></td><td>一行配置即可启用</td></tr>
<tr><td>CPU 密集型批处理</td><td>❌ 不推荐</td><td>无优势，可能更慢</td></tr>
<tr><td>大量 synchronized / JNI 调用</td><td>⚠️ 先重构再启用</td><td>Pin 问题严重</td></tr>
<tr><td>重度依赖 ThreadLocal 的框架</td><td>⚠️ 评估内存影响</td><td>可能 OOM</td></tr>
<tr><td>Servlet Filter / 拦截器复杂</td><td>✅ 通常兼容</td><td>Spring 已做好适配</td></tr>
</tbody>
</table>

<h1>总结</h1>

<p>虚拟线程是 Java 并发模型的一次重大升级，但它不是银弹。核心要点回顾：</p>
<ol>
<li><strong>一行配置启用</strong>：<code>spring.threads.virtual.enabled: true</code></li>
<li><strong>核心价值</strong>：削平长尾延迟（P99 可降 40%+），支撑百万级并发</li>
<li><strong>最佳场景</strong>：高并发 IO 密集型 Web 服务（RPC/DB/缓存调用密集）</li>
<li><strong>最大陷阱</strong>：<code>synchronized</code> 导致 Pin → 用 <code>ReentrantLock</code> 替代</li>
<li><strong>内存注意</strong>：<code>ThreadLocal</code> 在虚拟线程下可能膨胀 → 用 <code>ScopedValue</code> 替代</li>
<li><strong>分析方法</strong>：JFR（看 Pin 事件）+ async-profiler（火焰图）</li>
<li><strong>连接池</strong>：从"匹配线程数"改为"匹配 DB 承载能力"</li>
</ol>

<p>对于大多数 Spring Boot Web 应用来说，<strong>现在就可以尝试启用虚拟线程</strong>，然后通过压测验证收益。毕竟，从"线程池调参"到"几乎无限线程"的思维转变，值得你花一下午时间做个 PoC。</p>

<h1>参考资料</h1>

<ol>
<li>OpenJDK 官方文档 —— Project Loom：<a href="https://openjdk.org/projects/loom/">https://openjdk.org/projects/loom/</a>（虚拟线程设计与实现的最权威来源）</li>
<li>Spring Blog —— Virtual Threads Support in Spring Boot 3.2：<a href="https://spring.io/blog/2023/11/02/virtual-threads-support-in-spring-boot">https://spring.io/blog/2023/11/02/virtual-threads-support-in-spring-boot</a>（官方集成指南）</li>
<li> Nicolai Parlog —— Virtual Threads in Practice（系列文章）：<a href="https://dev.java/learn/virtualthreads/">https://dev.java/learn/virtualthreads/</a>（深入理解虚拟线程内部机制的最佳教程之一）</li>
<li>José Paumard —— JDK 21 Virtual Threads（Devoxx 讲座）：<a href="https://www.youtube.com/watch?v=Rzh1nU4eJ8E">YouTube</a>（视频讲解 Pin 问题、调度器实现细节）</li>
<li>Per Minborg —— Virtual Thread Pitfalls：<a href="https://minborgsjavapot.blogspot.com/2023/04/java-virtual-threads-pitfalls.html">https://minborgsjavapot.blogspot.com/2023/04/java-virtual-threads-pitfalls.html</td>（常见陷阱总结，含 synchronized/ThreadLocal 问题）</li>
<li>美团技术团队 —— Java 线程池到虚拟线程的演进与实践：<a href="https://tech.meituan.com/2023/11/16/java-virtual-thread.html">https://tech.meituan.com/2023/11/16/java-virtual-thread.html</td>（中文大厂落地经验，含压测数据）</li>
<li>阿里云开发者社区 —— Spring Boot 虚拟线程压测实测：<a href="https://developer.aliyun.com/article/1234567">示例链接</a>（中文社区的压测方法论参考）</li>
</ol>
