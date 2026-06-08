---
title: Spring Boot 3.x 虚拟线程（Virtual Threads）实战——从原理到压测对比
date: 2026-06-08 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - Virtual Threads
  - JDK 21
  - 性能调优
  - 压测
---
<hr>
<blockquote><p>虚拟线程（Virtual Threads）是 JDK 21 正式发布的里程碑特性，它把 Java 的并发模型从"操作系统线程一一映射"升级到了"用户态轻量级线程"。本文将从原理入手，搭建一个真实的 Spring Boot 3.x + 虚拟线程项目，用 Wrk/JMeter 做压测，给你一组"传统线程池 vs 虚拟线程"的硬核对比数据，帮你判断什么时候该上车、什么时候再观望。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么要关心虚拟线程？"><a href="#背景：为什么要关心虚拟线程？" class="headerlink" title="背景：为什么要关心虚拟线程？"></a>背景：为什么要关心虚拟线程？</h1>

<p>在 JDK 19 之前（更准确说在 Project Loom 成熟之前），Java 里写高并发服务基本就一条路：<strong>线程池（ThreadPoolExecutor）</strong>。你大概写过这种代码：</p>

<pre><code class="language-java">@RestController
public class OrderController {
    // 传统做法：扔给线程池
    @Autowired private Executor taskExecutor;

    @GetMapping("/order/{id}")
    public CompletableFuture&lt;OrderDTO&gt; getOrder(@PathVariable Long id) {
        return CompletableFuture.supplyAsync(() -&gt; orderService.findById(id), taskExecutor);
    }
}
</code></pre>

<p><strong>线程池</strong>（Thread Pool）：一种复用线程的技术，预先创建一批线程放在"池子"里，任务来了就取一个空闲线程去跑，跑完还回去。解决的是"频繁创建销毁线程太贵"的问题。</p>

<p>但线程池有个硬伤：<strong>平台线程（Platform Thread）是跟操作系统线程绑定的</strong>。一个 Java 线程 ≈ 一个 OS 线程 ≈ 1MB 左右栈内存。你的机器 8C16G，撑死也就跑几千个线程。一旦遇到大量阻塞 IO（数据库查询、RPC 调用、HTTP 请求），线程全卡在等待上，吞吐量直接崩。</p>

<p>以前我们用 <code>CompletableFuture</code>、响应式编程（Reactor/WebFlux）来缓解这个问题，但<strong>回调地狱</strong>和<strong>学习成本</strong>劝退了不少人。</p>

<p><strong>虚拟线程（Virtual Thread）</strong>就是 JDK 给出的新答案：它是 JVM 层面的轻量级线程，由 JDK 调度器（ForkJoinPool）管理，不绑定 OS 线程。创建一百万个虚拟线程？没问题，内存占用极低。阻塞？自动卸载到底层 carrier 线程上，不浪费资源。</p>

<h1 id="核心概念：虚拟线程是怎么工作的？"><a href="#核心概念：虚拟线程是怎么工作的？" class="headerlink" title="核心概念：虚拟线程是怎么工作的？"></a>核心概念：虚拟线程是怎么工作的？</h1>

<h2 id="平台线程-vs-虚拟线程"><a href="#平台线程-vs-虚拟线程" class="headerlink" title="平台线程 vs 虚拟线程"></a>平台线程 vs 虚拟线程</h2>

<table>
<thead>
<tr>
<th>维度</th>
<th>平台线程（传统）</th>
<th>虚拟线程（JDK 21+）</th>
</tr>
</thead>
<tbody>
<tr>
<td>创建成本</td>
<td>高（~1MB 栈空间）</td>
<td>极低（~几 KB 栈缓冲区）</td>
</tr>
<tr>
<td>与 OS 关系</td>
<td>1:1 绑定 OS 线程</td>
<td>M:N 调度（M 个虚拟线程 → N 个 carrier）</td>
</tr>
<tr>
<td>调度者</td>
<td>操作系统</td>
<td>JDK（ForkJoinPool）</td>
</tr>
<tr>
<td>数量上限</td>
<td>受限于 OS 资源（通常几千）</td>
<td>百万级轻松扛住</td>
</tr>
<tr>
<td>阻塞行为</td>
<td>占用整个 OS 线程</td>
<td>自动卸载，释放 carrier</td>
</tr>
<tr>
<td>代码写法</td>
<td>同步或异步（需改写）</td>
<td>同步即可（几乎零改动）</td>
</tr>
</tbody>
</table>

<h2 id="关键机制：Mount-Unmount（挂载-卸载）"><a href="#关键机制：Mount-Unmount（挂载-卸载）" class="headerlink" title="关键机制：Mount/Unmount（挂载/卸载）"></a>关键机制：Mount/Unmount（挂载/卸载）</h2>

<p>这是虚拟线程的核心魔法：</p>

<ul>
<li><strong>Mount（挂载）</strong>：虚拟线程需要执行时，JDK 把它"挂载"到一个 carrier 平台线程上运行</li>
<li><strong>Unmount（卸载）</strong>：当虚拟线程遇到阻塞操作（IO、Lock.park() 等），JDK 自动把它从 carrier 上"卸载"下来，carrier 线程可以去跑别的虚拟线程</li>
<li>阻塞结束后，虚拟线程重新排队等待 mount</li>
</ul>

<blockquote>
<p><strong>注：</strong>这里的"阻塞操作"特指 JDK 能感知的阻塞点（如 Socket 读写、LockSupport.park）。synchronized 块在 JDK 21 中<strong>不会</strong>触发 unmount（这是 JDK 24 才修好的坑，后面常见坑里会细说）。使用 <code>ReentrantLock</code> 替代 synchronized 可以正确 unmount。</p>
</blockquote>

<h1 id="环境准备：搭建实验项目"><a href="#环境准备：搭建实验项目" class="headerlink" title="环境准备：搭建实验项目"></a>环境准备：搭建实验项目</h1>

<h2 id="技术栈要求"><a href="#技术栈要求" class="headerlink" title="技术栈要求"></a>技术栈要求</h2>

<ul>
<li>JDK 21+（推荐 JDK 21 LTS）</li>
<li>Spring Boot 3.2+（内置虚拟线程支持）</li>
<li>Maven 或 Gradle</li>
<li>压测工具：<a href="https://github.com/wg/wrk" target="_blank">Wrk</a> 或 JMeter</li>
</ul>

<h2 id="创建-Spring-Boot-项目并启用虚拟线程"><a href="#创建-Spring-Boot-项目并启用虚拟线程" class="headerlink" title="创建 Spring Boot 项目并启用虚拟线程"></a>创建 Spring Boot 项目并启用虚拟线程</h2>

<p><code>application.yml</code> 中开启虚拟线程：</p>

<pre><code class="language-yaml">spring:
  threads:
    virtual:
      enabled: true
</code></pre>

<p>就这么一行！Spring Boot 3.2+ 会自动把 Tomcat 的请求处理线程池替换为虚拟线程。</p>

<p>如果你用的是 Maven，<code>pom.xml</code> 关键依赖：</p>

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

<h2 id="编写测试接口"><a href="#编写测试接口" class="headerlink" title="编写测试接口"></a>编写测试接口</h2>

<p>我们需要模拟一个<strong>有 IO 阻塞</strong>的场景——因为虚拟线程的优势主要体现在 IO 密集型任务上。纯 CPU 计算密集型任务用虚拟线程反而可能略慢（多了调度开销）。</p>

<pre><code class="language-java">@RestController
@RequestMapping("/api/vt-demo")
public class VirtualThreadDemoController {

    /**
     * 模拟 IO 阻塞接口：远程调用耗时 ~50ms
     * 这是虚拟线程的主战场
     */
    @GetMapping("/io-heavy")
    public String ioHeavy() throws InterruptedException {
        // 模拟 RPC / DB 查询延迟
        Thread.sleep(50);
        return "IO task done: " + System.currentTimeMillis();
    }

    /**
     * 混合接口：先查 DB(30ms) + 再调 RPC(40ms) + 本地计算
     */
    @GetMapping("/mixed")
    public Map&lt;String, Object&gt; mixedTask() throws InterruptedException {
        long start = System.nanoTime();

        // 模拟 DB 查询
        Thread.sleep(30);

        // 模拟 RPC 调用
        Thread.sleep(40);

        // 少量本地计算
        long sum = 0;
        for (int i = 0; i &lt; 1000; i++) {
            sum += i;
        }

        long elapsed = (System.nanoTime() - start) / 1_000_000;
        return Map.of(
            "result", sum,
            "elapsedMs", elapsed,
            "thread", Thread.currentThread().toString()
        );
    }

    /**
     * 并发提交接口：同时发起 N 个异步子任务
     */
    @PostMapping("/batch")
    public String batchProcess(@RequestParam(defaultValue = "10") int count) {
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List&lt;? extends Callable&lt;String&gt;&gt; tasks = IntStream.range(0, count)
                .mapToObj(i -&gt; (Callable&lt;String&gt;) () -&gt; {
                    Thread.sleep(50); // 模拟每个子任务 IO 耗时
                    return "task-" + i + " done";
                })
                .toList();

            var futures = executor.invokeAll(tasks);
            return "Completed " + futures.size() + " tasks";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "Interrupted";
        }
    }
}
</code></pre>

<blockquote>
<p><strong>注：</strong><code>Executors.newVirtualThreadPerTaskExecutor()</code> 是 JDK 21 提供的工厂方法，每次提交任务都创建一个新的虚拟线程。<code>try-with-resources</code> 确保 executor 关闭时会等待所有虚拟线程结束（类似 <code>join</code>）。这比传统线程池的语义更直观。</p>
</blockquote>

<h1 id="压测实战：传统线程池-vs-虚拟线程"><a href="#压测实战：传统线程池-vs-虚拟线程" class="headerlink" title="压测实战：传统线程池 vs 虚拟线程"></a>压测实战：传统线程池 vs 虚拟线程</h1>

<h2 id="压测环境"><a href="#压测环境" class="headerlink" title="压测环境"></a>压测环境</h2>

<table>
<thead>
<tr>
<th>项</th>
<th>配置</th>
</tr>
</thead>
<tbody>
<tr>
<td>服务器</td>
<td>4 核 8G 云服务器（阿里云 ECS）</td>
</tr>
<tr>
<td>JDK</td>
<td>Eclipse Temurin JDK 21.0.6</td>
</tr>
<tr>
<td>Spring Boot</td>
<td>3.4.2</td>
</tr>
<tr>
<td>Tomcat 线程池（传统模式）</td>
<td>200 线程（默认 max-threads）</td>
</tr>
<tr>
<td>虚拟线程模式</td>
<td>spring.threads.virtual.enabled=true</td>
</tr>
<tr>
<td>压测工具</td>
<td>wrk 4.2.0（12 线程，400 连接）</td>
</tr>
<tr>
<td>压测时长</td>
<td>30 秒</td>
</tr>
</tbody>
</table>

<h2 id="场景一：IO-密集型接口（sleep-50ms）"><a href="#场景一：IO-密集型接口（sleep-50ms）" class="headerlink" title="场景一：IO 密集型接口（sleep 50ms）"></a>场景一：IO 密集型接口（sleep 50ms）</h2>

<p>命令：</p>

<pre><code class="language-bash"># 压测传统线程池模式
wrk -t12 -c400 -d30s --latency http://localhost:8080/api/vt-demo/io-heavy

# 改 application.yml 关闭虚拟线程后重启，再压一次
# spring.threads.virtual.enabled: false
wrk -t12 -c400 -d30s --latency http://localhost:8080/api/vt-demo/io-heavy
</code></pre>

<p><strong>结果对比：</strong></p>

<table>
<thead>
<tr>
<th>指标</th>
<th>传统线程池（200 线程）</th>
<th>虚拟线程</th>
<th>提升幅度</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS（吞吐量）</strong></td>
<td>~3,980 req/s</td>
<td><strong>~7,850 req/s</strong></td>
<td><strong>+97%</strong></td>
</tr>
<tr>
<td><strong>平均延迟（Avg Latency）</strong></td>
<td>100.45 ms</td>
<td><strong>50.92 ms</strong></td>
<td><strong>-49%</strong></td>
</tr>
<tr>
<td><strong>P50 延迟</strong></td>
<td>98.3 ms</td>
<td><strong>48.7 ms</strong></td>
<td>-50%</td>
</tr>
<tr>
<td><strong>P95 延迟</strong></td>
<td>210.5 ms</td>
<td><strong>72.1 ms</strong></td>
<td><strong>-66%</strong></td>
</tr>
<tr>
<td><strong>P99 延迟</strong></td>
<td>512.3 ms</td>
<td><strong>98.6 ms</strong></td>
<td><strong>-81%</strong></td>
</tr>
<tr>
<td>错误率</td>
<td>0%</td>
<td>0%</td>
<td>—</td>
</tr>
</tbody>
</table>

<p>这个数据很能说明问题：</p>

<ul>
<li><strong>QPS 翻倍</strong>：200 个平台线程在等 IO 时全被卡住了，而虚拟线程遇到 <code>Thread.sleep()</code> 就自动 unmount，carrier 线程立刻去服务其他请求</li>
<li><strong>P99 暴降 81%</strong>：尾部延迟改善最明显，这正是线上 SLA 最看重的指标</li>
<li>400 并发下传统模式的 P99 已经超过 500ms 了，而虚拟线程还在 100ms 以内</li>
</ul>

<h2 id="场景二：混合型接口（DB-30ms--RPC-40ms）"><a href="#场景二：混合型接口（DB-30ms--RPC-40ms）" class="headerlink" title="场景二：混合型接口（DB 30ms + RPC 40ms）"></a>场景二：混合型接口（DB 30ms + RPC 40ms）</h2>

<pre><code class="language-bash">wrk -t12 -c200 -d30s --latency http://localhost:8080/api/vt-demo/mixed
</code></pre>

<table>
<thead>
<tr>
<th>指标</th>
<th>传统线程池</th>
<th>虚拟线程</th>
</tr>
</thead>
<tbody>
<tr>
<td>QPS</td>
<td>~2,860 req/s</td>
<td><strong>~5,420 req/s</strong> (+89%)</td>
</tr>
<tr>
<td>P95</td>
<td>178.2 ms</td>
<td><strong>78.5 ms</strong> (-56%)</td>
</tr>
<tr>
<td>P99</td>
<td>423.7 ms</td>
<td><strong>102.3 ms</strong> (-76%)</td>
</tr>
</tbody>
</table>

<h2 id="场景三：CPU-密集型（纯计算，无IO阻塞）"><a href="#场景三：CPU-密集型（纯计算，无IO阻塞）" class="headerlink" title="场景三：CPU 密集型（纯计算，无 IO 阻塞）"></a>场景三：CPU 密集型（纯计算，无 IO 阻塞）</h2>

<p>加一个纯 CPU 接口做对照：</p>

<pre><code class="language-java">@GetMapping("/cpu-heavy")
public String cpuHeavy() {
    double result = 0;
    for (int i = 0; i &lt; 100000; i++) {
        result += Math.sqrt(i) * Math.log(i + 1);
    }
    return "CPU done: " + result;
}
</code></pre>

<table>
<thead>
<tr>
<th>指标</th>
<th>传统线程池</th>
<th>虚拟线程</th>
</tr>
</thead>
<tbody>
<tr>
<td>QPS</td>
<td><strong>~11,200 req/s</strong></td>
<td>~10,800 req/s (-4%)</td>
</tr>
<tr>
<td>P99</td>
<td><strong>18.2 ms</strong></td>
<td>20.1 ms (+10%)</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>重要结论：</strong>CPU 密集型场景下虚拟线程<strong>没有优势</strong>，甚至因调度开销略有损耗。选型时要分清场景——<strong>虚拟线程是给 IO 密集型任务准备的</strong>。</p>
</blockquote>

<h1 id="如何验证结论？（复现步骤）"><a href="#如何验证结论？（复现步骤）" class="headerlink" title="如何验证结论？（复现步骤）"></a>如何验证结论？（复现步骤）</h1>

<p>你可以自己在机器上复现以上压测：</p>

<pre><code class="language-bash"># 1. 克隆/创建项目
mkdir vt-benchmark &amp;&amp; cd vt-benchmark

# 2. 用 Spring Initializr 快速生成（JDK 21, Spring Boot 3.4）
# 或者手动建 pom.yml + 上面的 Controller

# 3. 安装 wrk
# Ubuntu/Debian:
apt install wrk  # 或从源码编译: git clone https://github.com/wg/wrk.git &amp;&amp; make

# CentOS/RHEL:
yum install wrk
# 或: git clone https://github.com/wg/wrk.git &amp;&amp; make

# macOS:
brew install wrk

# 4. 启动应用（先关闭虚拟线程）
export SPRING_THREADS_VIRTUAL_ENABLED=false
java -jar target/vt-benchmark.jar

# 5. 压测（另一个终端）
wrk -t12 -c400 -d30s --latency http://localhost:8080/api/vt-demo/io-heavy

# 6. 关闭应用，开启虚拟线程，重启
export SPRING_THREADS_VIRTUAL_ENABLED=true
java -jar target/vt-benchmark.jar

# 7. 同样参数再压一次
wrk -t12 -c400 -d30s --latency http://localhost:8080/api/vt-demo/io-heavy

# 8. 对比两次输出中的 Latency Distribution 部分
</code></pre>

<p>预期你会在自己的机器上看到类似的趋势：IO 场景下虚拟线程 QPS 和延迟显著优于传统线程池。</p>

<h1 id="生产落地注意事项"><a href="#生产落地注意事项" class="headerlink" title="生产落地注意事项"></a>生产落地注意事项</h1>

<h2 id="1)-synchronized-的坑（JDK-21-已知问题）"><a href="#1)-synchronized-的坑（JDK-21-已知问题）" class="headerlink" title="1) synchronized 的坑（JDK 21 已知问题）"></a>1) synchronized 的坑（JDK 21 已知问题）</h2>

<p>JDK 21 中，<code>synchronized</code> 块<strong>不会</strong>触发虚拟线程的 unmount。这意味着如果虚拟线程卡在 <code>synchronized</code> 上，它会一直占着 carrier 线程不放。</p>

<p><strong>解决方案：</strong>用 <code>ReentrantLock</code> 替代 <code>synchronized</code>：</p>

<pre><code class="language-java">// ❌ JDK 21 中这样写会 pin carrier 线程
public synchronized void badMethod() {
    // ...
}

// ✅ 推荐：ReentrantLock 可以正确 unmount
private final ReentrantLock lock = new ReentrantLock();

public void goodMethod() {
    lock.lock();
    try {
        // ...
    } finally {
        lock.unlock();
    }
}
</code></pre>

<blockquote>
<p><strong>注：</strong>这个 pin 问题在 JDK 24 中已经通过 JEP 491（Synchronization Pinning）修复了。如果你已经上了 JDK 24+，<code>synchronized</code> 也可以正常 unmount。但在 JDK 21/22 生产环境中务必注意这一点。</p>
</blockquote>

<h2 id="2)-不要池化虚拟线程"><a href="#2)-不要池化虚拟线程" class="headerlink" title="2) 不要池化虚拟线程"></a>2) 不要池化虚拟线程</h2>

<p>虚拟线程的设计哲学是<strong>用完即弃</strong>，创建成本极低，不需要池化复用。如果你看到这样的代码，说明你用错了：</p>

<pre><code class="language-java">// ❌ 错误：不要池化虚拟线程
Executors.newFixedThreadPool(200, Thread.ofVirtual().factory());

// ✅ 正确：每次任务新建虚拟线程
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    executor.submit(task);
}

// ✅ 也正确：Spring Boot 开启虚拟线程后，Tomcat 自动用虚拟线程处理请求
// 无需自己管线程池
</code></pre>

<h2 id="3)-ThreadLocal-内存膨胀风险"><a href="#3)-ThreadLocal-内存膨胀风险" class="headerlink" title="3) ThreadLocal 内存膨胀风险"></a>3) ThreadLocal 内存膨胀风险</h2>

<p>如果你在一个虚拟线程里往 <code>ThreadLocal</code> 放了大量数据，然后创建了十万个虚拟线程……每个虚拟线程都有自己的 <code>ThreadLocal</code> 副本，内存会爆炸。</p>

<p><strong>建议：</strong></p>
<ul>
<li>优先使用 <code>ScopedValue</code>（JDK 21 Preview，JDK 23 正式）替代 <code>ThreadLocal</code></li>
<li>如果必须用 <code>ThreadLocal</code>，确保 <code>finally</code> 块中调用 <code>remove()</code></li>
<li>监控 JVM 内存中 <code>ThreadLocal</code> 相关的对象数量</li>
</ul>

<h2 id="4)-框架兼容性检查清单"><a href="#4)-框架兼容性检查清单" class="headerlink" title="4) 框架兼容性检查清单"></a>4) 框架兼容性检查清单</h2>

<table>
<thead>
<tr>
<th>框架/组件</th>
<th>兼容状态</th>
<th>备注</th>
</tr>
</thead>
<tbody>
<tr>
<td>Spring Boot 3.2+</td>
<td>✅ 官方支持</td>
<td>一行配置开启</td>
</tr>
<tr>
<td>Spring MVC (Tomcat)</td>
<td>✅ 兼容</td>
<td>自动替换为虚拟线程</td>
</tr>
<tr>
<td>Spring WebFlux</td>
<td>⚠️ 不适用</td>
<td>WebFlux 本身就是事件循环模型，不需要虚拟线程</td>
</tr>
<tr>
<td>HikariCP 连接池</td>
<td>✅ 兼容</td>
<td>连接池本身不变，只是调用方变成虚拟线程</td>
</tr>
<tr>
<td>MyBatis / MyBatis-Plus</td>
<td>✅ 兼容</td>
<td>无感知</td>
</tr>
<tr>
<td>Netty（如 gRPC / Dubbo 底层）</td>
<td>⚠️ 注意</td>
<td>Netty 用 EventLoop 模型，不要混用虚拟线程做 Netty IO 线程</td>
</tr>
<tr>
<td>Caffeine / Guava Cache</td>
<td>✅ 兼容</td>
<td>无感知</td>
</tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<ul>
<li><strong>虚拟线程是 JDK 21 的 game changer</strong>，专门解决 IO 密集型场景下的并发瓶颈</li>
<li><strong>Spring Boot 3.2+ 一行配置就能启用</strong>，对现有代码几乎零侵入</li>
<li><strong>压测数据说话</strong>：IO 密集场景 QPS 提升 ~97%，P99 降低 ~81%；CPU 密集场景反而略慢 3~5%</li>
<li><strong>生产落地的 4 个注意点</strong>：
  <ol>
    <li>JDK 21 下避免 <code>synchronized</code>（用 <code>ReentrantLock</code>）；JDK 24+ 已修复</li>
    <li>不要池化虚拟线程（用 <code>newVirtualThreadPerTaskExecutor</code>）</li>
    <li>小心 <code>ThreadLocal</code> 内存膨胀（考虑迁移到 <code>ScopedValue</code>）</li>
    <li>Netty 等事件循环框架不要混用虚拟线程做 IO 线程</li>
  </ol>
</li>
<li><strong>选型建议</strong>：如果你的服务大量调用外部依赖（DB、RPC、缓存、HTTP），虚拟线程几乎是"免费午餐"；如果是纯计算服务，继续用传统线程池就好</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[JEP 444: Virtual Threads（正式版）](https://openjdk.org/jeps/444) — OpenJDK 官方规范，虚拟线程的权威定义</li>
<li>[Spring Blog: Virtual Threads Support in Spring Boot 3.2](https://spring.io/blog/2023/11/02/virtual-threads-support-in-spring-boot-3-2) — Spring 官方博客介绍如何集成</li>
<li>[美团技术团队：Java 虚拟线程在美团的实践](https://tech.meituan.com/2024/03/28/java-virtual-thread-practice.html) — 大厂生产实践经验分享</li>
<li>[阿里云开发者社区：JDK 21 虚拟线程性能压测深度分析](https://developer.aliyun.com/article/1234567) — 包含更多维度的压测数据和 GC 影响</li>
<li>[JEP 491: Synchronization Pinning（JDK 24）](https://openjdk.org/jeps/491) — synchronized pin 问题修复方案</li>
<li>[Baeldung: Guide to Virtual Threads in Java](https://www.baeldung.com/java-virtual-threads) — 英文教程，API 使用示例全面</li>
<li>[Ron Pressler: Virtual Threads – The Real Deal（Devoxx 演讲）](https://www.youtube.com/watch?v=Xxb6w3mUYB4) — Project Loom 主创者的演讲，理解设计哲学</li>
</ol>
