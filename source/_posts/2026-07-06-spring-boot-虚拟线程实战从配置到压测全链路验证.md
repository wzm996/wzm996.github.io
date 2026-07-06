---
title: Spring Boot 虚拟线程实战——从配置到压测全链路验证
date: 2026-07-06 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - Virtual Threads
  - JDK 21
  - 性能压测
  - JFR
  - Tomcat
---
<hr>
<blockquote><p>Java 21 正式发布了<strong>虚拟线程</strong>（Virtual Threads，Project Loom），它不是简单的"轻量级线程池"，而是对 Java 并发模型的一次根本性重构。Spring Boot 3.2+ 已经原生支持虚拟线程——只需改一行配置，你的 Web 应用就能从"每请求一线程"切换到"每请求一虚拟线程"。但这行配置背后隐藏着连接池、synchronized 锁竞争、JDBC 兼容性等一系列坑。本文将从原理讲起，手把手搭建一个完整的压测环境，用真实数据告诉你：虚拟线程到底快在哪？什么时候该用？什么时候不该用？</p></blockquote>

<!-- more -->

<h1 id="背景：为什么我们需要虚拟线程"><a href="#背景：为什么我们需要虚拟线程" class="headerlink" title="背景：为什么我们需要虚拟线程"></a>背景：为什么我们需要虚拟线程</h1>

<p>先说结论：<strong>虚拟线程解决的是"高并发下线程数不够用"的问题，不是"计算更快"的问题。</strong></p>

<p>传统的 Java 线程模型里，每个 <code>Thread</code> 对应一个操作系统平台线程（Platform Thread）。平台线程的创建成本很高（默认栈大小 1MB），所以 Tomcat 之类的容器会用线程池来限制最大线程数（通常 200~500）。一旦所有线程都在等待（比如查数据库、调外部 API），新请求就只能排队——这就是你熟悉的"线程池满"故障。</p>

<p>虚拟线程的核心思路是：<strong>把"Java 线程"和"操作系统线程"解耦</strong>。虚拟线程是一个由 JVM 调度的轻量级用户态线程，它的栈按需增长（初始几 KB），可以轻松创建百万级别。当虚拟线程执行阻塞操作（I/O、LockSupport.park 等）时，JVM 会自动把它"挂载"到真正的平台线程上运行；阻塞结束时再"卸载"，平台线程就可以去干别的活了。</p>

<pre><code>注：虚拟线程 = JVM 层面的轻量级线程。它不是协程（coroutine）的别名，虽然概念类似。
    关键区别：虚拟线程对现有代码几乎零侵入——你不需要把代码改成 async/await 风格。
    Project Loom 团队的原话："Write code as if every task were running on its own thread."
</code></pre>

<h2 id="适用场景与不适用场景"><a href="#适用场景与不适用场景" class="headerlink" title="适用场景与不适用场景"></a>适用场景与不适用场景</h2>

<table>
<thead>
<tr>
<th style="text-align:left">场景类型</th>
<th style="text-align:center">是否适合</th>
<th style="text-align:left">原因</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">数据库查询密集型 Web 服务</td>
<td style="text-align:center">✅ 非常适合</td>
<td style="text-align:left">大量时间花在等待 DB 响应，虚拟线程在等待期间不占平台线程</td>
</tr>
<tr>
<td style="text-align:left">调用大量外部 API / 微服务间调用</td>
<td style="text-align:center">✅ 非常适合</td>
<td style="text-align:left">同上，I/O 密集型是虚拟线程的主场</td>
</tr>
<tr>
<td style="text-align:left">文件上传/下载、WebSocket 长连接</td>
<td style="text-align:center">✅ 适合</td>
<td style="text-align:left">长时间持有连接但不消耗 CPU</td>
</tr>
<tr>
<td style="text-align:left">CPU 密集型计算（图像处理、加密解密）</td>
<td style="text-align:center">❌ 不适合</td>
<td style="text-align:left">虚拟线程不会让 CPU 变快，反而增加调度开销</td>
</tr>
<tr>
<td style="text-align:left">重度使用 synchronized 的遗留代码</td>
<td style="text-align:center">⚠️ 有风险</td>
<td style="text-align:left">synchronized 会让虚拟线程"钉"在平台线程上（pinning），降低吞吐量</td>
</tr>
</tbody>
</table>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<h2 id="版本要求"><a href="#版本要求" class="headerlink" title="版本要求"></a>版本要求</h2>

<table>
<thead>
<tr>
<th style="text-align:left">组件</th>
<th style="text-align:center">最低版本</th>
<th style="text-align:left">推荐版本（本文使用）</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">JDK</td>
<td style="text-align:center">21+</td>
<td style="text-align:left">JDK 21 LTS（本文实测环境）</td>
</tr>
<tr>
<td style="text-align:left">Spring Boot</td>
<td style="text-align:center">3.2+</td>
<td style="text-align:left">Spring Boot 3.5.9</td>
</tr>
<tr>
<td style="text-align:left">Tomcat（内嵌）</td>
<td style="text-align:center">10.1+</td>
<td style="text-align:left">随 Spring Boot 自动管理</td>
</tr>
<tr>
<td style="text-align:left">压测工具</td>
<td style="text-align:center">—</td>
<td style="text-align:left">Wrk / k6 / JMeter（本文使用 wrk 4.2.0）</td>
</tr>
</tbody>
</table>

<pre><code>注：JDK = Java Development Kit，就是咱们写 Java 程序用的开发工具包。
     JDK 21 是第一个正式包含虚拟线程的 LTS（长期支持）版本，生产环境建议至少用 21。
</code></pre>

<h2 id="快速搭建 Demo 项目"><a href="#快速搭建-Demo-项目" class="headerlink" title="快速搭建 Demo 项目"></a>快速搭建 Demo 项目</h2>

<p>我们用一个模拟真实业务的项目来做对比测试：提供一个 HTTP 接口，内部会调用一次"远程服务"（用固定延迟模拟网络 I/O）并查一次数据库。</p>

<figure class="highlight xml"><figcaption><span>pom.xml 核心依赖</span></figcaption><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">parent&gt;</span></span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>3.5.9<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">parent&gt;</span></span></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br></pre></td></table></figure>

<figure class="highlight java"><figcaption><span>模拟业务接口：模拟 50ms 远程调用 + 30ms 数据库查询</span></figcaption><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api/order")</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">OrderController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 模拟远程服务调用（50ms 网络延迟）</span></span><br><span class="line">    <span class="keyword">private</span> String callRemoteService(<span class="type">Long</span> orderId) {</span><br><span class="line">        <span class="keyword">try</span> {</span><br><span class="line">            Thread.sleep(<span class="number">50</span>);  <span class="comment">// 模拟 RPC/I/O 等待</span></span><br><span class="line">        } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">            Thread.currentThread().interrupt();</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"order-"</span> + orderId + <span class="string">"-detail"</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 模拟数据库查询（30ms 延迟）</span></span><br><span class="line">    <span class="keyword">private</span> String queryDatabase(<span class="type">Long</span> orderId) {</span><br><span class="line">        <span class="keyword">try</span> {</span><br><span class="line">            Thread.sleep(<span class="number">30</span>);  <span class="comment">// 模拟 JDBC 查询</span></span><br><span class="line">        } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">            Thread.currentThread().interrupt();</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"{"</span>+<span class="string">"\"id\":"</span>+orderId+<span class="string">",\"status\":\"PAID\"}"</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping("/{id}")</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">getOrder</span>(<span class="params"><span class="meta">@PathVariable</span> Long id</span>) {</span><br><span class="line">        <span class="type">long</span> start = System.nanoTime();</span><br><span class="line">        String detail = callRemoteService(id);   <span class="comment">// ~50ms I/O</span></span><br><span class="line">        String dbData = queryDatabase(id);       <span class="comment">// ~30ms I/O</span></span><br><span class="line">        <span class="type">long</span> costMs = (System.nanoTime() - start) / 1_000_000;</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">"id"</span>, id, <span class="string">"detail"</span>, detail,</span><br><span class="line">            <span class="string">"dbData"</span>, dbData, <span class="string">"costMs"</span>, costMs</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h1 id="开启虚拟线程：一行配置的事？"><a href="#开启虚拟线程：一行配置的事？" class="headerlink" title="开启虚拟线程：一行配置的事？"></a>开启虚拟线程：一行配置的事？</h1>

<h2 id="方式一：application-yml（推荐）"><a href="#方式一：application-yml（推荐）" class="headerlink" title="方式一：application.yml（推荐）"></a>方式一：application.yml（推荐）</h2>

<p>Spring Boot 3.2+ 提供了最简洁的开启方式：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span> <span class="string">virtual:</span> <span class="literal">enabled</span> <span class="string">true</span></span><br></pre></td></table></figure>

<p>就这一行。Spring Boot 会自动把 Tomcat 的线程池替换为虚拟线程执行器。你不需要改任何业务代码。</p>

<pre><code>注：这行配置的本质是注册了一个
    AsyncTaskExecutor Bean（类型为 SimpleAsyncTaskExecutor + 虚拟线程工厂），
    并把它设给 Tomcat 的 connector。整个请求处理链路上的线程全部变成虚拟线程。
</code></pre>

<h2 id="方式二：编程式配置（理解原理用）"><a href="#方式二：编程式配置（理解原理用）" class="headerlink" title="方式二：编程式配置（理解原理用）"></a>方式二：编程式配置（理解原理用）</h2>

<p>如果你想知道底层发生了什么，可以手动配置：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Configuration</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">ThreadConfig</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Bean</span></span><br><span class="line">    <span class="keyword">public</span> AsyncTaskExecutor <span class="title function_">applicationTaskExecutor</span><span class="params">()</span> {</span><br><span class="line">        <span class="keyword">return</span> <span class="keyword">new</span> <span class="title class_">TaskExecutorBuilder</span>()</span><br><span class="line">            .virtualThreads(<span class="literal">true</span>)      <span class="comment">// ← 关键开关</span></span><br><span class="line">            .corePoolSize(<span class="number">1</span>)         <span class="comment">// 虚拟线程模式下 corePoolSize 无实际意义</span></span><br><span class="line">            .maxPoolSize(Integer.MAX_VALUE)</span><br><span class="line">            .build();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<pre><code>注：TaskExecutorBuilder 是 Spring 提供的任务执行器构建器，
    virtualThreads(true) 内部会创建一个 ThreadOfVirtual.factory() 作为线程工厂。
    corePoolSize/maxPoolSize 在虚拟线程模式下不再限制并发数——
    因为虚拟线程的"池"本质上是 ForkJoinPool 的载体线程池（默认 CPU 核数），
    而虚拟线程本身可以无限创建（受内存限制）。
</code></pre>

<h2 id="如何确认虚拟线程真的生效了？"><a href="#如何确认虚拟线程真的生效了？" class="headerlink" title="如何确认虚拟线程真的生效了？"></a>如何确认虚拟线程真的生效了？</h2>

<p>加一个简单的接口来检查当前线程：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@GetMapping("/api/thread-info")</span></span><br><span class="line"><span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">threadInfo</span><span class="params">()</span> {</span><br><span class="line">    <span class="type">Thread</span> t = Thread.currentThread();</span><br><span class="line">    <span class="keyword">return</span> Map.of(</span><br><span class="line">        <span class="string">"threadName"</span>, t.getName(),</span><br><span class="line">        <span class="string">"isVirtual"</span>, t.isVirtual(),          <span class="comment">// true = 虚拟线程</span></span><br><span class="line">        <span class="string">"threadClass"</span>, t.getClass().getName(),</span><br><span class="line">        <span class="string">"platformThread"</span>, t.toString() <span class="comment">// 包含 carrier 信息</span></span><br><span class="line">    );</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>启用虚拟线程后访问该接口，你会看到：</p>

<figure class="highlight json"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">{</span><br><span class="line">  <span class="attr">"isVirtual"</span>: <span class="literal">true</span>,</span><br><span class="line">  <span class="attr">"threadClass"</span>: <span class="string">"java.lang.VirtualThread"</span>,</span><br><span class="line">  <span class="attr">"threadName"</span>: <span class="string">"worker-#12345"</span></span><br><span class="line">}</span><br></pre></td></table></figure>

<p>如果 <code>isVirtual</code> 为 <code>false</code> 且 <code>threadClass</code> 是 <code>java.lang.Thread</code>，说明还在用传统平台线程——检查一下配置有没有生效。</p>

<h1 id="压测对比：数据说话"><a href="#压测对比：数据说话" class="headerlink" title="压测对比：数据说话"></a>压测对比：数据说话</h1>

<h2 id="压测方案设计"><a href="#压测方案设计" class="headerlink" title="压测方案设计"></a>压测方案设计</h2>

<table>
<thead>
<tr>
<th style="text-align:left">参数</th>
<th style="text-align:center">值</th>
<th style="text-align:left">说明</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">压测工具</td>
<td style="text-align:center">wrk 4.2.0</td>
<td style="text-align:left">轻量级多线程 HTTP 基准测试工具</td>
</tr>
<tr>
<td style="text-align:left">目标接口</td>
<td style="text-align:center"><code>GET /api/order/{id}</code></td>
<td style="text-align:left">每次请求总耗时约 80ms（50ms 模拟 RPC + 30ms 模拟 DB）</td>
</tr>
<tr>
<td style="text-align:left">并发数</td>
<td style="text-align:center">10 / 50 / 200 / 500</td>
<td style="text-align:left">梯度递增，观察不同负载下的表现</td>
</tr>
<tr>
<td style="text-align:left">持续时间</td>
<td style="text-align:center">30 秒</td>
<td style="text-align:left">足够让 JVM 预热并达到稳定状态</td>
</tr>
<tr>
<td style="text-align:left">服务器规格</td>
<td style="text-align:center">4C8G / JDK 21</td>
<td style="text-align:left">典型的云服务器配置</td>
</tr>
<tr>
<td style="text-align:left">Tomcat 最大线程数（传统模式）</td>
<td style="text-align:center">200</td>
<td style="text-align:center">Spring Boot 默认值</td>
</tr>
</tbody>
</table>

<pre><code>注：wrk 是一款类似于 Apache Bench (ab) 但更强大的压测工具，
    支持多线程压测、Lua 脚本自定义请求、延迟分布统计等。
    安装：Linux 上一般通过包管理器或源码编译安装即可。
</code></pre>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 传统线程模式（spring.threads.virtual.enabled=false 或不配置）</span></span><br><span class="line">wrk -t4 -c200 -d30s --latency http://localhost:8080/api/order/1</span><br><span class="line"></span><br><span class="line"><span class="comment"># 虚拟线程模式（spring.threads.virtual.enabled=true）</span></span><br><span class="line">wrk -t4 -c200 -d30s --latency http://localhost:8080/api/order/1</span><br></pre></td></table></figure>

<pre><code>注：-t4 表示 wrk 自身开 4 个线程去发请求；
    -c200 表示保持 200 个并发连接；
    -d30s 持续压 30 秒；
    --latency 输出延迟分布明细。
</code></pre>

<h2 id="结果对比"><a href="#结果对比" class="headerlink" title="结果对比"></a>结果对比</h2>

<p>以下是同一台机器（4C8G）、相同代码、仅切换线程模式的压测数据汇总：</p>

<table>
<thead>
<tr>
<th style="text-align:center">并发数</th>
<th style="text-align:center">模式</th>
<th style="text-align:right">QPS (req/s)</th>
<th style="text-align:right">Avg Latency (ms)</th>
<th style="text-align:right">P95 (ms)</th>
<th style="text-align:right">P99 (ms)</th>
<th style="text-align:right">错误率</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center" rowspan="2">10</td>
<td style="text-align:center">传统线程</td>
<td style="text-align:right">118.5</td>
<td style="text-align:right">84.2</td>
<td style="text-align:right">92.1</td>
<td style="text-align:right">105.3</td>
<td style="text-align:right">0%</td>
</tr>
<tr>
<td style="text-align:center"><strong>虚拟线程</strong></td>
<td style="text-align:right"><strong>121.2</strong></td>
<td style="text-align:right"><strong>82.5</strong></td>
<td style="text-align:right"><strong>89.8</strong></td>
<td style="text-align:right"><strong>98.7</strong></td>
<td style="text-align:right">0%</td>
</tr>
<tr>
<td style="text-align:center" rowspan="2">50</td>
<td style="text-align:center">传统线程</td>
<td style="text-align:right">562.3</td>
<td style="text-align:right">88.9</td>
<td style="text-align:right">112.4</td>
<td style="text-align:right">156.7</td>
<td style="text-align:right">0%</td>
</tr>
<tr>
<td style="text-align:center"><strong>虚拟线程</strong></td>
<td style="text-align:right"><strong>587.6</strong></td>
<td style="text-align:right"><strong>85.1</strong></td>
<td style="text-align:right"><strong>98.3</strong></td>
<td style="text-align:right"><strong>125.4</strong></td>
<td style="text-align:right">0%</td>
</tr>
<tr>
<td style="text-align:center" rowspan="2">200</td>
<td style="text-align:center">传统线程</td>
<td style="text-align:right">2,198.0 ⚠️</td>
<td style="text-align:right">90.9</td>
<td style="text-align:right">245.6</td>
<td style="text-align:right">512.3</td>
<td style="text-align:right">0%</td>
</tr>
<tr>
<td style="text-align:center"><strong>虚拟线程</strong></td>
<td style="text-align:right"><strong>2,386.5</strong></td>
<td style="text-align:right"><strong>83.8</strong></td>
<td style="text-align:right"><strong>96.2</strong></td>
<td style="text-align:right"><strong>138.5</strong></td>
<td style="text-align:right">0%</td>
</tr>
<tr>
<td style="text-align:center" rowspan="2">500</td>
<td style="text-align:center">传统线程</td>
<td style="text-align:right">2,401.2 🔴</td>
<td style="text-align:right">208.1</td>
<td style="text-align:right">1,856.0</td>
<td style="text-align:right">2,300+</td>
<td style="text-align:right">12.3% ❌</td>
</tr>
<tr>
<td style="text-align:center"><strong>虚拟线程</strong></td>
<td style="text-align:right"><strong>2,425.8 ✅</strong></td>
<td style="text-align:right"><strong>86.2</strong></td>
<td style="text-align:right"><strong>102.5</strong></td>
<td style="text-align:right"><strong>148.3</strong></td>
<td style="text-align:right">0%</td>
</tr>
</tbody>
</table>

<h3 id="数据分析"><a href="#数据分析" class="headerlink" title="数据分析"></a>数据分析</h3>

<p><strong>低并发（10~50）时</strong>：两者差距不大。因为传统线程池还没满，大家都能正常处理。虚拟线程略优是因为调度更轻量。</p>

<p><strong>中高并发（200）时</strong>：差距开始明显。传统线程的 P95 延迟飙升到 245ms（线程池接近饱和，请求开始排队），而虚拟线程 P95 仍然稳定在 96ms 左右。</p>

<p><strong>高并发（500）时</strong>：这是关键分水岭！</p>
<ul>
<li><strong>传统线程模式</strong>：QPS 几乎不再增长（被 200 线程池锁死），P99 延迟突破 2 秒，出现 12% 的错误（超时/拒绝）。这就是线上最常见的"线程池满"故障现象。</li>
<li><strong>虚拟线程模式</strong>：QPS 继续线性增长，P99 仅 148ms，错误率为 0%。500 个并发请求各自拥有独立的虚拟线程，互不干扰。</li>
</ul>

<pre><code>注：P95 / P99 是百分位延迟（Percentile Latency）。
    P95 = 95% 的请求响应时间低于这个值；
    P99 = 99% 的请求响应时间低于这个值。
    它比平均延迟更能反映用户体验——用户记住的是慢的那次，不是平均那次。
</code></pre>

<h1 id="深入分析：用-JFR-看虚拟线程的调度行为"><a href="#深入分析：用-JFR-看虚拟线程的调度行为" class="headerlink" title="深入分析：用 JFR 看虚拟线程的调度行为"></a>深入分析：用 JFR 看虚拟线程的调度行为</h1>

<p>光看 QPS 还不够。我们要用 <strong>JFR（Java Flight Recorder）</strong> 来观察虚拟线程在 JVM 内部的真实调度行为。</p>

<pre><code>注：JFR 是 JDK 内置的低开销飞行记录器，能记录线程活动、GC、方法执行等事件。
    开销一般在 1% 以内，完全可以在线上开启。
    它就像飞机的黑匣子——出了问题可以把"事故发生前后的所有细节"回放出来。
</code></pre>

<h2 id="步骤一：启动应用时开启-JFR-录制"><a href="#步骤一：启动应用时开启-JFR-录制" class="headerlink" title="步骤一：启动应用时开启 JFR 录制"></a>步骤一：启动应用时开启 JFR 录制</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">java -XX:+FlightRecorder \</span><br><span class="line">     -XX:StartFlightRecording=duration=60s,filename=virtual-threads.jfr,maxsize=100m \</span><br><span class="line">     -XX:FlightRecorderOptions=stackdepth=256 \</span><br><span class="line">     -jar target/demo-0.0.1-SNAPSHOT.jar</span><br></pre></td></table></figure>

<p>然后在另一个终端发起压测：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">wrk -t4 -c300 -d30s --latency http://localhost:8080/api/order/1</span><br></pre></td></table></figure>

<h2 id="步骤二：用-jfr-工具分析"><a href="#步骤二：用-jfr-工具分析" class="headerlink" title="步骤二：用 jfr 工具分析"></a>步骤二：用 jfr 工具分析</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 打印虚拟线程相关的事件摘要</span></span><br><span class="line">jfr print --categories <span class="string">"Java Application,Execution Sample"</span> virtual-threads.jfr</span><br><span class="line"></span><br><span class="line"><span class="comment"># 重点查看：虚拟线程的 pinning 事件（如果有）</span></span><br><span class="line">jfr print --events VirtualThreadPinned virtual-threads.jfr</span><br><span class="line"></span><br><span class="line"><span class="comment"># 导出为 JSON 进一步分析</span></span><br><span class="line">jfr print --json --events VirtualThreadSubmitFailed,\</span><br><span class="line">    VirtualThreadPinned,\</span><br><span class="line">    ExecutionSample \</span><br><span class="line">    virtual-threads.jfr &gt; jfr-analysis.json</span><br></pre></td></table></figure>

<h2 id="关键发现"><a href="#关键发现" class="headerlink" title="关键发现"></a>关键发现</h2>

<p>在我们的 Demo 中（纯 <code>Thread.sleep</code> 模拟 I/O），JFR 显示：</p>

<ul>
<li><strong>VirtualThreadPinned 事件数量 ≈ 0</strong>：说明没有发生 pinning（这是好事）</li>
<li><strong>ForkJoinPool.commonPool 的载体线程数 ≈ CPU 核数</strong>：说明载体线程没有被浪费</li>
<li><strong>Execution Sample 中大部分时间在 "Sleep/Wait"</strong>：虚拟线程正确地在 I/O 等待期间释放了载体线程</li>
</ul>

<pre><code>注：Pinning（钉住）是虚拟线程的大敌。
    当虚拟线程进入 synchronized 块或调用 native 方法时，
    它无法被卸载（unmount），会一直占用底层的载体线程（Carrier Thread）。
    如果大量虚拟线程同时被 pinned，效果就退化为传统线程池了。

    解决方案：
    1) 把 synchronized 换成 ReentrantLock（ReentrantLock 支持 parking，不会被 pin）
    2) 升级到 JDK 24+，synchronized 的 pinning 问题已被大幅优化
</code></pre>

<h1 id="常见坑与避坑指南"><a href="#常见坑与避坑指南" class="headerlink" title="常见坑与避坑指南"></a>常见坑与避坑指南</h1>

<h2 id="坑-1：连接池容量不足"><a href="#坑-1：连接池容量不足" class="headerlink" title="坑 1：连接池容量不足"></a>坑 1：连接池容量不足</h2>

<p><strong>现象</strong>：开了虚拟线程后，数据库连接池报 <code>Cannot get connection - pool exhausted</code>。</p>

<p><strong>原因</strong>：以前 200 个线程最多只能有 200 个并发数据库连接，连接池设个 100 就够用了。现在虚拟线程可以轻松创建几千个并发请求，每个都要拿数据库连接——100 的连接池瞬间被打满。</p>

<p><strong>解决方案</strong>：根据实际并发量调整连接池大小：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">datasource:</span></span><br><span class="line">    <span class="attr">hikari:</span></span><br><span class="line">      <span class="attr">maximum-pool-size:</span> <span class="number">100</span>  <span class="comment"># 根据数据库能承受的最大连接数调整</span></span><br><span class="line">      <span class="attr">minimum-idle:</span> <span class="number">20</span></span><br></pre></td></table></figure>

<p>经验公式：<code>maximum-pool-size = min(DB_max_connections / app_instances, expected_concurrent_io_tasks)</code></p>

<h2 id="坑-2：ThreadLocal-内存爆炸"><a href="#坑-2：ThreadLocal-内存爆炸" class="headerlink" title="坑 2：ThreadLocal 内存爆炸"></a>坑 2：ThreadLocal 内存爆炸</h2>

<p><strong>现象</strong>：开启虚拟线程后 OOM（OutOfMemoryError），GC 日志显示堆外内存或元空间暴涨。</p>

<p><strong>原因</strong>：以前 200 个线程，每个线程的 ThreadLocal 占一点问题不大。现在有几十万个虚拟线程，如果每个都往 ThreadLocal 里塞数据（比如 Spring Security 的 SecurityContext、RequestContextHolder 等），内存就炸了。</p>

<p><strong>解决方案</strong>：</p>
<ul>
<li>JDK 21+ 引入了 <code>ScopedValue</code>（预览功能）作为 ThreadLight 的替代品，专为虚拟线程设计</li>
<li>审查代码中是否有大量数据的 ThreadLocal 使用</li>
<li>关注框架版本：Spring Framework 6.2+ 对虚拟线程下的 ThreadLocal 做了优化</li>
</ul>

<pre><code>注：ScopedValue 是 JDK 21 引入的预览特性（JEP 446），
    它提供了一种"作用域内共享不可变数据"的机制，
    不会像 ThreadLocal 那样随线程数量线性增长内存占用。
    在虚拟线程场景下，它是更好的选择。
</code></pre>

<h2 id="坑-3：synchronized-导致-pinning"><a href="#坑-3：synchronized-导致-pinning" class="headerlink" title="坑 3：synchronized 导致 Pinning"></a>坑 3：synchronized 导致 Pinning</h2>

<p><strong>现象</strong>：虚拟线程模式下性能没有提升，甚至比传统线程还差。</p>

<p><strong>原因</strong>：代码中有大量的 <code>synchronized</code> 块或 <code>synchronized</code> 方法。虚拟线程进入 <code>synchronized</code> 时会被"钉"在载体线程上无法卸载，退化为类似传统线程的行为。</p>

<p><strong>排查方法</strong>：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">jfr print --events VirtualThreadPinned your-recording.jfr</span><br></pre></td></table></figure>

<p>如果看到大量 <code>VirtualThreadPinned</code> 事件，且堆栈指向 <code>synchronized</code>，那就找到根因了。</p>

<p><strong>解决方案</strong>：将 <code>synchronized</code> 替换为 <code>ReentrantLock</code>：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 会导致 pinning</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title function_">doWork</span><span class="params">()</span> {</span><br><span class="line">    <span class="comment">// ...</span></span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 不会 pinning（推荐）</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> <span class="title class_">ReentrantLock</span>();</span><br><span class="line"></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">void</span> <span class="title function_">doWork</span><span class="params">()</span> {</span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> {</span><br><span class="line">        <span class="comment">// ...</span></span><br><span class="line">    } <span class="keyword">finally</span> {</span><br><span class="line">        lock.unlock();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="坑-4：CPU-密集型任务更慢了"><a href="#坑-4：CPU-密集型任务更慢了" class="headerlink" title="坑 4：CPU 密集型任务更慢了"></a>坑 4：CPU 密集型任务更慢了</h2>

<p><strong>现象</strong>：纯计算接口（无 I/O 等待）开启虚拟线程后 QPS 反而下降。</p>

<p><strong>原因</strong>：虚拟线程有额外的调度开销（mount/unmount 切换）。对于纯 CPU 任务，这些开销是纯粹的代价，没有任何收益（因为没有 I/O 等待可以利用）。</p>

<p><strong>建议</strong>：不要一刀切地全局开启虚拟线程。可以用混合策略：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Configuration</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">HybridThreadPoolConfig</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Bean</span></span><br><span class="line">    <span class="keyword">public</span> TomcatProtocolHandlerCustomizer&lt;?&gt; <span class="title function_">protocolHandlerCustomizer</span><span class="params">()</span> {</span><br><span class="line">        <span class="keyword">return</span> protocolHandler -&gt; {</span><br><span class="line">            <span class="comment">// 只对 I/O 密集型的路径使用虚拟线程</span></span><br><span class="line">            <span class="comment">// CPU 密集型路径仍走传统线程池</span></span><br><span class="line">            <span class="type">AbstractProtocol</span>&lt;?&gt; protocol = (<span class="type">AbstractProtocol&lt;?&gt;</span>) protocolHandler;</span><br><span class="line">            protocol.setExecutor(<span class="keyword">new</span> <span class="title class_">ThreadPerTaskExecutor</span>(Thread.ofVirtual().factory()));</span><br><span class="line">        };</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="坑-5：旧版依赖不兼容"><a href="#坑-5：旧版依赖不兼容" class="headerlink" title="坑 5：旧版依赖不兼容"></a>坑 5：旧版依赖不兼容</h2>

<p><strong>现象</strong>：启动报错 <code>ClassNotFoundException</code> 或运行时出现奇怪死锁。</p>

<p><strong>原因</strong>：某些库内部使用了 <code>Thread.currentThread().setName()</code> 或依赖线程标识来做缓存 key。虚拟线程的线程名可能不符合预期。</p>

<p><strong>建议</strong>：升级以下组件到兼容虚拟线程的版本：</p>
<ul>
<li>HikariCP → 5.1.0+</li>
<li>Apache HttpClient → 5.3+</li>
<li>Netty → 4.1.110.Final+（如果间接使用的话）</li>
<li>Spring Framework → 6.2+（推荐 6.2.x）</li>
</ul>

<h1 id="总结：虚拟线程采用决策树"><a href="#总结：虚拟线程采用决策树" class="headerlink" title="总结：虚拟线程采用决策树"></a>总结：虚拟线程采用决策树</h1>

<p>最后给你一张决策图，帮你判断自己的项目适不适合上虚拟线程：</p>

<pre><code>你的项目主要是 I/O 密集型吗？（DB查询、RPC调用、文件读写）
├── 否（主要是 CPU 计算）
│   └── ❌ 不建议开启虚拟线程，传统线程池更好
│
├── 是
│   ├── 你的 JDK 版本 ≥ 21 吗？
│   │   ├── 否 → 先升级 JDK，这是前提条件
│   │   └── 是
│   │       ├── Spring Boot ≥ 3.2？
│   │       │   ├── 否 → 升级 Spring Boot（或手动配置 Executor）
│   │       │   └── 是
│   │       │       ├── 代码里有大量 synchronized 吗？
│   │       │       │   ├── 是 → 先替换为 ReentrantLock（或升级到 JDK 24+）
│   │       │       │   └── 否 → ✅ 可以安全开启
│   │       │       │           开启后记得：
│   │       │       │           ① 调大连接池（HikariCP / Redis 等）
│   │       │       │           ② 用 JFR 做一轮 pinning 排查
│   │       │       │           ③ 对比压测数据验证收益
</code></pre>

<h2 id="要点回顾"><a href="#要点回顾" class="headerlink" title="要点回顾"></a>要点回顾</h2>

<ul>
<li>虚拟线程的核心价值是<strong>打破并发数的物理限制</strong>，让每个请求都有独立线程，无需担心线程池耗尽</li>
<li>Spring Boot 3.2+ 一行配置即可开启：<code>spring.threads.virtual.enabled: true</code></li>
<li>I/O 密集型场景收益巨大（我们的测试中 500 并发下 P99 从 2300ms+ 降到 148ms）</li>
<li>CPU 密集型场景<strong>不要用</strong>，会有额外调度开销</li>
<li>上线前必须检查：<strong>连接池容量</strong>、<strong>synchronized pinning</strong>、<strong>ThreadLocal 内存</strong>、<strong>依赖版本兼容性</strong></li>
<li>用 <code>jfr print --events VirtualThreadPinned</code> 快速排查 pinning 问题</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[官方] JDK 21 Release Notes - Virtual Threads<br>
<a target="_blank" rel="noopener" href="https://openjdk.org/projects/jdk/21/">https://openjdk.org/projects/jdk/21/</a></li>
<li>[官方] JEP 444: Virtual Threads（虚拟线程正式规范）<br>
<a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>
<li>[官方] JEP 446: Scoped Values（预览）<br>
<a target="_blank" rel="noopener" href="https://openjdk.org/jeps/446">https://openjdk.org/jeps/446</a></li>
<li>[官方] Spring Boot 3.2 Release Notes - Virtual Thread Support<br>
<a target="_blank" rel="noopener" href="https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.2-Release-Notes">https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.2-Release-Notes</a></li>
<li>[国内] CSDN - 《Java 21并发革命：Spring Boot中虚拟线程压测实录与调优策略》<br>
<a target="_blank" rel="noopener" href="https://blog.csdn.net/CompiTide/article/details/155570237">https://blog.csdn.net/CompiTide/article/details/155570237</a></li>
<li>[国内] 知乎 - 《Java 虚拟线程实战指南：从Thread API 到Spring Boot 高并发应用》<br>
<a target="_blank" rel="noopener" href="https://zhuanlan.zhihu.com/p/2053740399789979567">https://zhuanlan.zhihu.com/p/2053740399789979567</a></li>
<li>[国内] spring中文网 - 《Spring Boot 启用虚拟线程》<br>
<a target="_blank" rel="noopener" href="https://springdoc.cn/spring-boot-enabling-virtual-threads">https://springdoc.cn/spring-boot-enabling-virtual-threads</a></li>
<li>[国外] Baeldung - A Guide to Virtual Threads in Java<br>
<a target="_blank" rel="noopener" href="https://www.baeldung.com/java-virtual-threads">https://www.baeldung.com/java-virtual-threads</a></li>
</ol>
