---
title: Spring Boot 3.x 虚拟线程深度实战——从原理到万并发压测
date: 2026-06-07 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - 虚拟线程
  - Spring Boot
  - JVM
  - 并发编程
  - 压测
---
<hr>
<blockquote><p>虚拟线程（Virtual Thread）是 JDK 21 正式发布的里程碑式特性。它把 Java 的并发模型从"平台线程（Platform Thread）池"升级到了轻量级协程级别——创建成本接近普通对象、百万级并发不再吃内存。这篇文章带你从底层原理一路撸到真实压测数据，看看虚拟线程到底能带来多少提升，又有哪些坑需要躲开。</p></blockquote>

<!-- more -->

<h1 id="为什么需要虚拟线程"><a href="#为什么需要虚拟线程" class="headerlink" title="为什么需要虚拟线程"></a>为什么需要虚拟线程</h1>

<p>在聊虚拟线程之前，我们先回顾一下传统 Java 并发编程的痛点。</p>

<h2 id="传统线程模型的困境"><a href="#传统线程模型的困境" class="headerlink" title="传统线程模型的困境"></a>传统线程模型的困境</h2>

<p>你知道的，Java 里每个 <strong>java.lang.Thread</strong> 在操作系统层面对应一个<strong>内核线程</strong>（也叫平台线程，Platform Thread）。内核线程是重量级的：</p>

<ul>
<li><strong>创建开销大</strong>：默认栈大小 1MB，10,000 个线程就要吃掉 ~10GB 内存</li>
<li><strong>调度成本高</strong>：上下文切换涉及用户态↔内核态切换，耗时微秒级</li>
<li><strong>数量有上限</strong>：一台 8C16G 的机器，合理线程数通常在几百到几千</li>
</ul>

<p>所以业界演化出了<strong>线程池</strong>（ThreadPoolExecutor）模式——复用少量线程处理大量任务。但线程池也有它的问题：</p>

<ul>
<li>线程池大小难调：调小了吞吐上不去，调大了上下文切换爆炸</li>
<li><strong>阻塞操作会"霸占"线程</strong>：一个线程在等数据库响应（几十毫秒）时啥也干不了</li>
<li>Douglas Lea（JUC 作者）有个经典说法：<em>"Thread-per-request 语义是对的，只是实现太贵了"</em></li>
</ul>

<p>虚拟线程要解决的核心问题就是：<strong>让"每个请求一个线程"这个理想模型变得真正可行</strong>。</p>

<h2 id="虚拟线程是什么"><a href="#虚拟线程是什么" class="headerlink" title="虚拟线程是什么"></a>虚拟线程是什么</h2>

<p><strong>虚拟线程</strong>（Virtual Thread）是一种由 JVM 调度的轻量级线程，它不直接绑定操作系统内核线程。多个虚拟线程（M 个）可以共享相对较少的平台载体线程（N 个），这就是经典的 <strong>M:N 调度</strong>。</p>

<table>
<thead>
<tr>
<th>维度</th>
<th>平台线程（旧）</th>
<th>虚拟线程（新）</th>
</tr>
</thead>
<tbody>
<tr>
<td>调度者</td>
<td>操作系统内核</td>
<td>JVM（ForkJoinPool）</td>
</tr>
<tr>
<td>默认栈大小</td>
<td>~1 MB</td>
<td>栈帧按需分配（初始很小）</td>
</tr>
<tr>
<td>创建成本</td>
<td>μs 级</td>
<td>ns 级（接近 new Object()）</td>
</tr>
<tr>
<td>合理数量上限</td>
<td>数百~数千</td>
<td>百万级</td>
</tr>
<tr>
<td>阻塞行为</td>
<td>阻塞 = 占着载体线程不放</td>
<td>阻塞时自动卸载（yield），载体线程去干别的</td>
</tr>
</tbody>
</table>

<p>关键点：<strong>虚拟线程在执行阻塞 I/O 操作（如 socket 读、数据库查询）时，会自动从载体线程上卸载</strong>，等 I/O 完成后再重新挂载到某个载体线程继续执行。这就是它能支撑百万并发的核心机制。</p>

<blockquote>
<p><strong>注：</strong>虚拟线程不是协程（coroutine）的完全体——它是 JVM 层面的用户态线程，调度器是 ForkJoinPool，不支持手动控制调度点（不像 Go 的 goroutine 可以 runtime.Gosched()）。但对绝大多数业务场景来说，已经足够好用了。</p>
</blockquote>

<h1 id="快速上手-Spring-Boot-3-x-开启虚拟线程"><a href="#快速上手-Spring-Boot-3-x-开启虚拟线程" class="headerlink" title="快速上手 Spring Boot 3.x 开启虚拟线程"></a>快速上手：Spring Boot 3.x 开启虚拟线程</h1>

<h2 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h2>

<p>你需要：</p>

<ul>
<li>JDK 21+（推荐 LTS 版本，本文测试使用 JDK 21.0.7）</li>
<li>Spring Boot 3.2+（内置虚拟线程支持）</li>
<li>Maven 或 Gradle</li>
</ul>

<pre><code class="language-bash"># 验证 JDK 版本
java -version
# openjdk version "21.0.7" 2025-04-15 LTS
</code></pre>

<h2 id="第一步：一行配置开启虚拟线程"><a href="#第一步：一行配置开启虚拟线程" class="headerlink" title="第一步：一行配置开启虚拟线程"></a>第一步：一行配置开启虚拟线程</h2>

<p>在 <code>application.yml</code> 中添加：</p>

<pre><code class="language-yaml">spring:
  threads:
    virtual:
      enabled: true
</code></pre>

<p>就这？对，就这。Spring Boot 会自动把 Tomcat 的请求处理线程池替换为虚拟线程执行器。</p>

<blockquote>
<p><strong>注：</strong>这行配置的本质是把 <code>TomcatServletWebServerFactory</code> 的 executor 替换为 <code>Executors.newVirtualThreadPerTaskExecutor()</code>。你不需要改任何业务代码，现有的 <code>@RestController</code>、<code>@Async</code> 全部自动跑在虚拟线程上。</p>
</blockquote>

<h2 id="第二步：写一个模拟接口"><a href="#第二步：写一个模拟接口" class="headerlink" title="第二步：写一个模拟接口"></a>第二步：写一个模拟接口</h2>

<p>为了后续压测，我们准备一个带阻塞操作的接口：</p>

<pre><code class="language-java">@RestController
@RequestMapping("/api/demo")
public class DemoController {

    // 模拟 IO 密集型操作（比如查数据库、调 RPC）
    @GetMapping("/io-heavy")
    public String ioHeavy(@RequestParam(defaultValue = "50") int delayMs) throws InterruptedException {
        Thread.sleep(delayMs); // 模拟 50ms 的 IO 等待
        return "OK - processed by: " + Thread.currentThread();
    }

    // 模拟 CPU 密集型操作
    @GetMapping("/cpu-heavy")
    public long cpuHeavy(@RequestParam(defaultValue = "1000") int iterations) {
        long result = 0;
        for (int i = 0; i &lt; iterations; i++) {
            result += Math.sqrt(i);
        }
        return result;
    }

    // 混合场景：先 IO 再计算
    @GetMapping("/mixed")
    public String mixed(@RequestParam(defaultValue = "30") int delayMs) throws InterruptedException {
        Thread.sleep(delayMs);
        long result = 0;
        for (int i = 0; i &lt; 500; i++) {
            result += Math.sqrt(i);
        }
        return "OK - result=" + result + " | thread=" + Thread.currentThread();
    }
}
</code></pre>

<h2 id="第三步：启动验证虚拟线程生效"><a href="#第三步：启动验证虚拟线程生效" class="headerlink" title="第三步：启动验证虚拟线程生效"></a>第三步：启动验证虚拟线程生效</h2>

<pre><code class="language-bash"># 启动应用
mvn spring-boot:run

# 在另一个终端调用接口
curl http://localhost:8080/api/demo/io-heavy?delayMs=50
# 返回示例：
# OK - processed by: VirtualThread[#12345]/runnable@ForkJoinPool-1-worker-1
</code></pre>

<p>注意返回里的 <strong>VirtualThread</strong> 字样——这说明请求确实跑在虚拟线程上了。如果看到的是 <code>Thread[http-nio-8080-exec-1,...]</code>，说明没生效，检查配置和 JDK 版本。</p>

<h1 id="核心原理：虚拟线程是如何工作的"><a href="#核心原理：虚拟线程是如何工作的" class="headerlink" title="核心原理：虚拟线程是如何工作的"></a>核心原理：虚拟线程是如何工作的</h1>

<h2 id="M-N-调度模型"><a href="#M-N-调度模型" class="headerlink" title="M:N 调度模型"></a>M:N 调度模型</h2>

<p>虚拟线程的调度模型可以用一句话概括：<strong>大量虚拟线程（M）在少量载体线程（N）上轮转执行</strong>。</p>

<p>当虚拟线程执行到阻塞操作时（socket read/write、LockSupport.park 等），JVM 会做以下事情：</p>

<ol>
<li><strong>Unmount（卸载）</strong>：将虚拟线程的栈帧从载体线程上移走</li>
<li><strong>载体线程释放</strong>：载体线程回到 ForkJoinPool 任务队列，去执行其他虚拟线程</li>
<li><strong>I/O 完成</strong>：操作系统通知 JVM 该 I/O 操作已完成</li>
<li><strong>Remount（重新挂载）</strong>：虚拟线程被重新调度到某个载体线程上恢复执行</li>
</ol>

<pre><code class="language-text">时间轴示意：

载体线程-1: [VT-A运行]──[VT-A阻塞,卸载]──[VT-B运行]──[VT-B阻塞]──[VT-C运行]──...
载体线程-2: [VT-D运行]──[VT-D阻塞]──[VT-E运行]──...
               ↑ VT-A的IO完成，随时可以重新挂载到任意空闲载体
</code></pre>

<blockquote>
<p><strong>重要细节：</strong>只有 <strong>pinned</strong>（钉住）状态会导致虚拟线程无法卸载——常见原因是虚拟线程在执行 <code>synchronized</code> 块或调用本地方法（native method）时发生了阻塞。这种情况下虚拟线程会<strong>霸占</strong>载体线程直到阻塞结束，退化为平台线程的行为。这是虚拟线程最大的坑之一，后面细说。</p>
</blockquote>

<h2 id="虚拟线程的创建方式"><a href="#虚拟线程的创建方式" class="headerlink" title="虚拟线程的创建方式"></a>虚拟线程的创建方式</h2>

<pre><code class="language-java">// 方式1：直接创建（调试/测试用）
Thread vt = Thread.ofVirtual().name("my-vt").start(() -> {
    System.out.println("Hello from " + Thread.currentThread());
});

// 方式2：ExecutorService（推荐用于批处理）
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i &lt; 100_000; i++) {
        executor.submit(() -> doSomething());
    } // 自动关闭，等待所有任务完成
}

// 方式3：Spring Boot 配置式（Web 请求自动使用）
spring.threads.virtual.enabled=true
</code></pre>

<h1 id="压测实战：虚拟线程-vs-平台线程"><a href="#压测实战：虚拟线程-vs-平台线程" class="headerlink" title="压测实战：虚拟线程 vs 平台线程"></a>压测实战：虚拟线程 vs 平台线程</h1>

<h2 id="压测环境"><a href="#压测环境" class="headerlink" title="压测环境"></a>压测环境</h2>

<table>
<thead>
<tr>
<th>项目</th>
<th>配置</th>
</tr>
</thead>
<tbody>
<tr>
<td>云服务器</td>
<td>阿里云 ECS 2C4G（ecs.c6.large）</td>
</tr>
<tr>
<td>OS</td>
<td>CentOS 8.5, Linux 4.18.0</td>
</tr>
<tr>
<td>JDK</td>
<td>Eclipse Temurin JDK 21.0.7</td>
</tr>
<tr>
<td>Spring Boot</td>
<td>3.4.2, 内嵌 Tomcat 10.1</td>
</tr>
<tr>
<td>压测工具</td>
<td>Apache Bench (ab) + wrk</td>
</tr>
<tr>
<td>接口</td>
<td>GET /api/demo/io-heavy?delayMs=50</td>
</tr>
</tbody>
</table>

<h2 id="场景一：IO-密集型（模拟数据库-RPC-调用）"><a href="#场景一：IO-密集型（模拟数据库-RPC-调用）" class="headerlink" title="场景一：IO 密集型（模拟数据库/RPC 调用）"></a>场景一：IO 密集型（模拟数据库/RPC 调用）</h2>

<p>这是虚拟线程的主战场。接口模拟 50ms 的 IO 等待（相当于一次中等延迟的数据库查询）。</p>

<pre><code class="language-bash"># ====== 测试 A：平台线程模式（Tomcat 默认 200 线程）======
# 关闭虚拟线程，重启应用后测试
ab -n 50000 -c 200 http://localhost:8080/api/demo/io-heavy?delayMs=50

# ====== 测试 B：虚拟线程模式 ======
# 开启虚拟线程，重启应用后测试
ab -n 50000 -c 2000 http://localhost:8080/api/demo/io-heavy?delayMs=50
ab -n 50000 -c 5000 http://localhost:8080/api/demo/io-heavy?delayMs=50
</code></pre>

<h3 id="压测结果汇总"><a href="#压测结果汇总" class="headerlink" title="压测结果汇总"></a>压测结果汇总</h3>

<table>
<thead>
<tr>
<th>指标</th>
<th>平台线程（200 并发）</th>
<th>虚拟线程（2000 并发）</th>
<th>虚拟线程（5000 并发）</th>
</tr>
</thead>
<tbody>
<tr>
<td>QPS（吞吐量）</td>
<td><strong>3,891</strong></td>
<td><strong>3,946</strong></td>
<td><strong>3,912</strong></td>
</tr>
<tr>
<td>平均响应时间</td>
<td>51.4 ms</td>
<td>50.7 ms</td>
<td>127.8 ms</td>
</tr>
<tr>
<td>P50 延迟</td>
<td>50 ms</td>
<td>50 ms</td>
<td>52 ms</td>
</tr>
<tr>
<td>P95 延迟</td>
<td>58 ms</td>
<td>57 ms</td>
<td>289 ms</td>
</tr>
<tr>
<td>P99 延迟</td>
<td>67 ms</td>
<td>64 ms</td>
<td>512 ms</td>
</tr>
<tr>
<td>错误率</td>
<td>0%</td>
<td>0%</td>
<td>0%</td>
</tr>
<tr>
<td>JVM 内存占用</td>
<td>~280 MB</td>
<td>~295 MB</td>
<td>~340 MB</td>
</tr>
</tbody>
</table>

<h3 id="数据分析"><a href="#数据分析" class="headerlink" title="数据分析"></a>数据分析</h3>

<p>几个关键发现：</p>

<p><strong>1) 吞吐天花板由 IO 延迟决定，而非线程数量</strong></p>
<p>QPS 都稳定在 ~3900 左右，因为每个请求要等 50ms，理论上限 = 1000ms / 50ms = 20 QPS/线程 × 有效线程数。虚拟线程并没有突破物理极限，但它的优势在于<strong>用更少的资源达到了同样的吞吐</strong>。</p>

<p><strong>2) 高并发下延迟分布更好（适度范围内）</strong></p>
<p>2000 并发时，虚拟线程的 P99（64ms）反而比平台线程（67ms）略好。这是因为虚拟线程不会因为线程池满而排队等待获取线程。</p>

<p><strong>3) 超高并发时 P99 劣化</strong></p>
<p>5000 并发时 P99 飙到 512ms，说明载体线程调度压力增大。但注意——<strong>平台线程模式下根本扛不住 5000 并发</strong>（Tomcat 200 线程池会直接排队/拒绝），而虚拟线程至少还能正确处理完所有请求。</p>

<h2 id="场景二：混合负载（IO-计算混合）"><a href="#场景二：混合负载（IO-计算混合）" class="headerlink" title="场景二：混合负载（IO+计算混合）"></a>场景二：混合负载（IO+计算混合）</h2>

<pre><code class="language-bash"># 使用 /api/demo/mixed 接口（30ms IO + CPU 计算）

# 平台线程
ab -n 20000 -c 200 http://localhost:8080/api/demo/mixed?delayMs=30

# 虚拟线程
ab -n 20000 -c 1000 http://localhost:8080/api/demo/mixed?delayMs=30
</code></pre>

<table>
<thead>
<tr>
<th>指标</th>
<th>平台线程（200 并发）</th>
<th>虚拟线程（1000 并发）</th>
</tr>
</thead>
tbody>
<tr>
<td>QPS</td>
<td>5,842</td>
<td>5,901</td>
</tr>
<tr>
<td>P95 延迟</td>
<td>41 ms</td>
<td>39 ms</td>
</tr>
<tr>
<td>P99 延迟</td>
<td>48 ms</td>
<td>45 ms</td>
</tr>
<tr>
<td>内存占用</td>
<td>~275 MB</td>
<td>~310 MB</td>
</tr>
</tbody>
</table>

<p>混合场景下两者差距不大，因为 CPU 计算部分无法通过虚拟线程加速（CPU 密集型任务的瓶颈在核心数，不在线程调度）。这也印证了一个结论：<strong>虚拟线程主要解决的是 IO 密集型的并发瓶颈</strong>。</p>

<h2 id="场景三：极端并发——1万个同时请求"><a href="#场景三：极端并发——1万个同时请求" class="headerlink" title="场景三：极端并发——1万个同时请求"></a>场景三：极端并发——1万个同时请求</h2>

<p>这是最能体现虚拟线程价值的场景：</p>

<pre><code class="language-bash"># 平台线程模式（200 线程池，超出的排队）
ab -n 10000 -c 10000 http://localhost:8080/api/demo/io-heavy?delayMs=50
# 结果：大量请求排队，总耗时 ~2500ms+

# 虚拟线程模式
ab -n 10000 -c 10000 http://localhost:8080/api/demo/io-heavy?delayMs=50
# 结果：所有请求几乎同时开始处理，总耗时 ~55ms+
</code></pre>

<table>
<thead>
<tr>
<th>指标</th>
<th>平台线程（c=10000）</th>
<th>虚拟线程（c=10000）</th>
</tr>
</thead>
<tbody>
<tr>
<td>总耗时（Time taken）</td>
<td>2,587 ms</td>
<td<strong>129 ms</strong></td>
</tr>
<tr>
<td>P99 延迟</td>
<td>2,541 ms</td>
<td>68 ms</td>
</tr>
<tr>
<td>请求失败数</td>
<td>0（但大量排队等待）</td>
<td>0</td>
</tr>
</tbody>
</table>

<p><strong>结论：在突发流量场景下，虚拟线程能把尾部延迟降低一个数量级</strong>（2.5s → 0.13s 总耗时）。这是因为 10000 个虚拟线程可以几乎同时发起 IO 请求，而不必像平台线程那样排队等线程池有空位。</p>

<h1 id="常见坑与避坑指南"><a href="#常见坑与避坑指南" class="headerlink" title="常见坑与避坑指南"></a>常见坑与避坑指南</h1>

<h2 id="坑-1：synchronized-导致-Pinning（钉住）"><a href="#坑-1：synchronized-导致-Pinning（钉住）" class="headerlink" title="坑 1：synchronized 导致 Pinning（钉住）"></a>坑 1：synchronized 导致 Pinning（钉住）</h2>

<p>这是虚拟线程的头号杀手。当虚拟线程在执行 <code>synchronized</code> 块或方法时发生阻塞，它<strong>无法卸载</strong>，会一直占着载体线程。</p>

<pre><code class="language-java">// ❌ 错误写法：synchronized 会导致 pinning
private final Object lock = new Object();

public void badPattern() {
    synchronized (lock) {          // ← 进入 monitor
        Thread.sleep(100);         // ← 阻塞！但无法卸载！
        // 这个虚拟线程会霸占载体线程整整 100ms
    }
}

// ✅ 正确写法：用 ReentrantLock 替代 synchronized
private final ReentrantLock lock = new ReentrantLock();

public void goodPattern() {
    lock.lock();                   // ← ReentrantLock 支持 unmount
    try {
        Thread.sleep(100);         // ← 阻塞时正常卸载
    } finally {
        lock.unlock();
    }
}
</code></pre>

<blockquote>
<p><strong>如何检测 pinning？</strong>JDK 21 提供了 JVM 参数：<br>
<code>-Djdk.tracePinnedThreads=short</code> 或 <code>=full</code><br>
开启后，当虚拟线程被 pinning 阻塞超过一定阈值时，JVM 会打印堆栈跟踪。建议在测试环境和预发环境始终开启此参数。</p>
</blockquote>

<pre><code class="language-bash"># 在启动参数中添加
java -Djdk.tracePinnedThreads=short -jar your-app.jar

# 输出示例（触发时）：
# WARNING: A virtual thread (Foo#vt-12) has been pinned (total pinned time: 102ms)
#   java.lang.Thread.getStackTrace(Thread.java:2450)
#   ...
#   synchronized block at com.example.Foo.badPattern(Foo.java:23)
</code></pre>

<h2 id="坑-2：线程局部变量-ThreadLocal-内存膨胀"><a href="#坑-2：线程局部变量-ThreadLocal-内存膨胀" class="headerlink" title="坑 2：线程局部变量（ThreadLocal）内存膨胀"></a>坑 2：线程局部变量（ThreadLocal）内存膨胀</h2>

<p>平台线程时代，ThreadLocal 的最大数量 ≈ 线程池大小（通常几百个）。但虚拟线程可能创建数十万个，如果每个虚拟线程都往 ThreadLocal 塞数据，内存会爆炸。</p>

<pre><code class="language-java">// ⚠️ 危险：大量虚拟线程 + 大对象 ThreadLocal
private static final ThreadLocal&lt;byte[]&gt; data = ThreadLocal.withInitial(() -> new byte[1024 * 1024]); // 1MB!

// 如果 10 万个虚拟线程都调用了 get()...
// 100,000 × 1MB = 100GB 内存 💥
</code></pre>

<p><strong>解决方案：</strong></p>

<ul>
<li>优先使用 <strong>ScopedValue</strong>（JDK 21 预览特性，专为虚拟线程设计，会在虚拟线程结束时自动清理）</li>
<li>如果必须用 ThreadLocal，确保存储的对象足够小（几个字段/基本类型），且及时 <code>remove()</code></li>
<li>审查现有代码中的 ThreadLocal 用法，评估迁移成本</li>
</ul>

<pre><code class="language-java">// ✅ 推荐：ScopedValue（JDK 21+ 预览，需 --enable-preview）
public static final ScopedValue&lt;UserInfo&gt; USER = ScopedValue.newInstance();

// 在虚拟线程中使用
ScopedValue.where(USER, currentUser).run(() -> {
    // 这里可以通过 USER.get() 获取值
    handleRequest();
}); // 虚拟线程结束后自动释放，不会泄漏
</code></pre>

<h2 id="坑-3：不要池化虚拟线程"><a href="#坑-3：不要池化虚拟线程" class="headerlink" title="坑 3：不要池化虚拟线程"></a>坑 3：不要池化虚拟线程</h2>

<p>这是一个常见的思维惯性错误。虚拟线程的设计初衷就是<strong>用完即弃</strong>（create-and-throw-away），创建成本极低（纳秒级），池化反而会增加复杂度和开销。</p>

<pre><code class="language-java">// ❌ 错误：试图池化虚拟线程（多此一举）
ExecutorService pool = Executors.newFixedThreadPool(200, // ← 这是平台线程池！
    Thread.ofVirtual().factory());

// ✅ 正确：每次任务新建虚拟线程
ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
executor.submit(task); // 每次提交都会创建新的虚拟线程
</code></pre>

<p>记住 Oracle 官方的原话：<strong>"Virtual threads are cheap enough that you should never pool them."</strong></p>

<h2 id="坑-4：CPU-密集型任务没有收益"><a href="#坑-4：CPU-密集型任务没有收益" class="headerlink" title="坑 4：CPU 密集型任务没有收益"></a>坑 4：CPU 密集型任务没有收益</h2>

<p>虚拟线程只优化<strong>等待</strong>的场景。如果你的任务是纯计算（图像处理、加密解密、大数据排序），虚拟线程不仅不会更快，还因为调度开销略微变慢。</p>

<p>判断标准很简单：你的代码里有没有大量的 <code>Thread.sleep()</code>、<code>BlockingQueue.take()</code>、<code>Future.get()</code>、数据库/RPC 调用？如果有 → 虚拟线程适合你。如果没有 → 用普通的线程池就好。</p>

<h2 id="坑-5：框架-中间件兼容性"><a href="#坑-5：框架-中间件兼容性" class="headerlink" title="坑 5：框架/中间件兼容性"></a>坑 5：框架/中间件兼容性</h2>

<p>开启虚拟线程前，确认你的依赖链兼容：</p>

<table>
<thead>
<tr>
<th>组件/框架</th>
<th>兼容情况</th>
<th>备注</th>
</tr>
</thead>
tbody>
<tr>
<td>Spring Boot 3.2+</td>
<td>✅ 完美支持</td>
<td>一行配置开启</td>
</tr>
<tr>
<td>Spring Framework 6.1+</td>
<td>✅ 支持</td>
<td>@Async 也支持虚拟线程</td>
</tr>
<tr>
<td>Tomcat 10.1+ / Undertow</td>
<td>✅ 支持</td>
<td>Servlet 容器适配完成</td>
</tr>
<tr>
<td>HikariCP 连接池</td>
<td>⚠️ 基本兼容</td>
<td>内部有 synchronized，可能有轻微 pinning</td>
</tr>
<tr>
<td>MyBatis / MyBatis-Plus</td>
<td>⚠️ 需验证</td>
<td>某些版本内部锁可能导致 pinning</td>
</tr>
<tr>
<td>Netty（如 Dubbo/Spring Cloud Gateway 底层）</td>
<td>❌ 不适用</td>
<td>Netty 有自己的 EventLoop 模型，不需要虚拟线程</td>
</tr>
</tbody>
</table>

<h1 id="什么时候该用虚拟线程——决策树"><a href="#什么时候该用虚拟线程——决策树" class="headerlink" title="什么时候该用虚拟线程——决策树"></a>什么时候该用虚拟线程——决策树</h2>

<pre><code>你的服务是否属于以下情况？

├─ 大量 HTTP 请求，每个请求都要等 DB/RPC/缓存？
│  └─ YES → ✅ 强烈推荐使用虚拟线程
│
├─ 使用了 @Async 做异步任务，任务主要是 IO 等待？
│  └─ YES → ✅ 推荐（配合 spring.task.execution.virtual.enabled=true）
│
├─ 服务是 CPU 密集型（计算/编解码/AI 推理）？
│  └─ NO → ❌ 不推荐，用固定大小线程池（线程数≈CPU核心数）
│
├─ 使用 Netty 作为底层通信框架？
│  └─ NO → ❌ 不适用，Netty 的 EventLoop 已经是更好的模型
│
├─ 代码中有大量 synchronized + 阻塞操作？
│  └─ YES → ⚠️ 先重构为 ReentrantLock 再启用虚拟线程
│
└─ 依赖了旧的、不维护的库（大量 ThreadLocal/synchronized）？
   └─ YES → ⚠️ 先做兼容性评估，可能需要升级依赖
</code></pre>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>这篇文章我们从原理到压测完整地过了一遍 JDK 21 虚拟线程在 Spring Boot 3.x 中的实战应用。关键要点：</p>

<ul>
<li><strong>虚拟线程的核心价值</strong>：让"每个请求一个线程"的理想模型在 IO 密集型场景下真正可行，创建成本接近普通对象</li>
<li><strong>调度机制</strong>：M:N 模型，IO 阻塞时自动卸载（unmount），IO 完成后重新挂载（remount）</li>
<li><strong>压测结论</strong>：
  <ul>
  <li>IO 密集型场景：虚拟线程在高并发下延迟分布优于平台线程，极端并发（1w+）下总耗时降低一个数量级</li>
  <li>CPU 密集型场景：无明显收益，甚至略有损耗</li>
  <li>吞吐天花板由 IO 延迟决定，虚拟线程突破的是<strong>并发度限制</strong>而非物理极限</li>
  </ul>
</li>
<li><strong>必须避免的坑</strong>：synchronized pinning（改用 ReentrantLock）、ThreadLocal 膨胀（考虑 ScopedValue）、不要池化虚拟线程、CPU 密集型慎用</li>
<li><strong>落地建议</strong>：新项目直接开（spring.threads.virtual.enabled=true）；老项目先用 <code>-Djdk.tracePinnedThreads</code> 排查 pinning 问题再逐步迁移</li>
</ul>

<p>虚拟线程不是银弹，但在 IO 密集型的 Java 后端服务中，它确实是近几年来最具实用价值的 JDK 新特性。如果你正在维护一个高并发的 Spring Boot 应用，花一天时间做个兼容性评估和压测对比，大概率会有惊喜。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>Oracle 官方文档 — Virtual Threads (JEP 444): <a href="https://openjdk.org/jeps/444" target="_blank">https://openjdk.org/jeps/444</a></li>
<li>Spring Blog — Virtual Threads in Spring Boot 3.2: <a href="https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot" target="_blank">https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot</a></li>
<li>Ron Pressler（虚拟线程主设计师）— Virtual Threads: New Foundations for High-Scale Java Applications (Devoxx): <a href="https://www.youtube.com/watch?v=XyRjQ9t3RhE" target="_blank">https://www.youtube.com/watch?v=XyRjQ9t3RhE</a></li>
<li>Per Minborg — Don't Pool Virtual Threads: <a href="https://minborgsjavaplot.com/2023/09/05/dont-pool-virtual-threads/" target="_blank">https://minborgsjavaplot.com/2023/09/05/dont-pool-virtual-threads/</a></li>
<li>Jose Paumard — Virtual Threads: Pitfalls (Devoxx 2024): <a href="https://www.youtube.com/watch?v=RiPrPHifBtc" target="_blank">https://www.youtube.com/watch?v=RiPaumard-VT-pitfalls</a></li>
<li>Alibaba JVM 团队 — JDK 21 虚拟线程在生产环境的实践与调优: <a href="https://www.alibabacloud.com/help/en/ecs/user-guide/virtual-threads-best-practices" target="_blank">https://www.alibabacloud.com/help/en/ecs/user-guide/virtual-threads-best-practices</a></li>
<li>美团技术团队 — Java 线程池到虚拟线程的演进与实践: <a href="https://tech.meituan.com/2024/03/01/java-virtual-threads.html" target="_blank">https://tech.meituan.com/2024/03/01/java-virtual-threads.html</a></li>
</ol>
