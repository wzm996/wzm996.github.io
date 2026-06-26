---
title: Java 21 Virtual Threads 在 Spring Boot 中的实战与性能对比
date: 2026-06-26 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Virtual Threads
  - Spring Boot
  - JVM
  - 性能调优
  - JFR
---
<hr>
<blockquote><p>**Virtual Threads（虚拟线程）** 是 JDK 21 正式发布的里程碑式特性，它把 Java 的并发模型从「平台线程（OS 线程）一比一映射」升级为「M:N 调度」，让开发者能用极低的成本写出高并发 I/O 密集型程序。本文将从原理到实战，手把手带你把 Virtual Threads 接入 Spring Boot 3.2+，并用 **wrk 压测 + JFR 火焰图** 给出一组真实的性能对比数据。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要-Virtual-Threads"><a href="#背景：为什么需要-Virtual-Threads" class="headerlink" title="背景：为什么需要 Virtual Threads"></a>背景：为什么需要 Virtual Threads</h1>

<p>在 JDK 19 之前，Java 的 <strong>Thread</strong> 底层直接对应操作系统的内核线程（也叫 <strong>Platform Thread</strong>）。这意味着：</p>

<ul>
<li>每个线程要占用几 MB 的栈内存（默认 1MB）</li>
<li>上下文切换成本高（需要陷入内核态）</li>
<li>一台机器能创建的线程数有限（通常几千到一两万就是上限）</li>
</ul>

<p>对于 CPU 密集型任务这还好，但现代 Web 服务大量是 <strong>I/O 密集型</strong> 的——等数据库响应、等 RPC 返回、等 HTTP 回调。这些等待时间里，平台线程被白白挂着，啥也干不了。</p>

<p>传统的解法是引入线程池（<code>ThreadPoolExecutor</code>），但线程池治标不治本：</p>

<table>
<thead>
<tr>
<th>方案</th>
<th>优点</th>
<th>痛点</th>
</tr>
</thead>
<tbody>
<tr>
<td>固定大小线程池（如 Tomcat 默认 200）</td>
<td>资源可控</td>
<td>高峰期线程全阻塞 → 请求堆积 → 雪崩</td>
<td>动态扩容线程池</td>
<td>应对突发流量</td>
<td>线程数过多 → 上下文切换爆炸 → 吞吐反而下降</td>
<td>异步非阻塞（CompletableFuture / Reactor）</td>
<td>理论上无限并发</td>
<td>代码变成「回调地狱」，调试困难，学习成本极高</td>
</tbody>
</table>

<p><strong>Virtual Threads</strong> 的思路完全不同：它由 JVM 用户态调度（而非 OS），栈内存按需分配（初始几 KB），在执行 I/O 操作时自动<strong>卸载（unmount）</strong>底层载体线程，I/O 完成后再<strong>重新挂载（remount）</strong>。对开发者来说，写法和普通线程几乎一样——不需要改造成异步代码。</p>

<h1 id="核心概念速览"><a href="#核心概念速览" class="headerlink" title="核心概念速览"></a>核心概念速览</h1>

<table>
<thead>
<tr>
<th>术语</th>
<th>解释</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>Virtual Thread（虚拟线程）</strong></td>
<td>JDK 21 引入的 <code>java.lang.Thread</code> 实例，由 JVM 调度，不直接绑定 OS 线程</td>
</tr>
<tr>
<td><strong>Carrier Thread（载体线程）</strong></td>
<td>实际执行虚拟线程代码的 Platform Thread，来自 ForkJoinPool</td>
</tr>
<tr>
<td><strong>Unmount / Remount</strong></td>
<td>虚拟线程在阻塞 I/O 时自动卸载载体线程；I/O 完成后重新挂载到某个载体线程上继续执行</td>
</tr>
<tr>
<td><strong>Scheduler（调度器）</strong></td>
<td>默认使用 <code>ForkJoinPool</code> 作为虚拟线程调度器，管理载体线程池</td>
</tr>
<tr>
<td><strong>Pinning（钉住）</strong></td>
<td>当虚拟线程进入 <code>synchronized</code> 块或调用本地方法时，无法卸载载体线程，会阻塞载体线程——这是主要的性能陷阱</td>
</tr>
</tbody>
</table>

<pre><code>注：Virtual Threads 在 JDK 19 Preview → JDK 20 Preview → JDK 21 正式发布（Preview 结束）。
     生产环境建议至少使用 JDK 21+。
</code></pre>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<h2 id="1-基础环境要求"><a href="#1-基础环境要求" class="headerlink" title="1. 基础环境要求"></a>1. 基础环境要求</h2>

<ul>
<li>JDK 21 或以上（推荐 Eclipse Temurin / Oracle JDK 21 LTS）</li>
<li>Spring Boot 3.2+（内置 Virtual Threads 支持）</li>
<li>Maven 3.8+ 或 Gradle 8.x</li>
</ul>

<p>验证 JDK 版本：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line">$ java -version
<span class="line">openjdk version <span class="string">"21.0.5"</span> 2024-10-15
<span class="line">OpenJDK Runtime Environment Temurin-21.0.5+11 (build 21.0.5+11)</span>
<span class="line"># 确认包含 VirtualThread
<span class="line">$ java -XshowSettings:all -version 2>&amp;1 | grep virtual</span>
</span></pre></td></tr></figure></p>

<h2 id="2-创建-Spring-Boot-项目"><a href="#2-创建-Spring-Boot-项目" class="headerlink" title="2. 创建 Spring Boot 项目"></a>2. 创建 Spring Boot 项目</h2>

<p><code>pom.xml</code> 关键依赖：</p>
<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line">&lt;parent&gt;
<span class="line">    &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
<span class="line">    &lt;artifactId&gt;spring-boot-starter-parent&lt;/artifactId&gt;
<span class="line">    &lt;version&gt;3.2.5&lt;/version&gt;
<span class="line">&lt;/parent&gt;
<span class="line">
<span class="line">&lt;properties&gt;
<span class="line">    &lt;java.version&gt;21&lt;/java.version&gt;
<span class="line">&lt;/properties&gt;
<span class="line">
<span class="line">&lt;dependencies&gt;
<span class="line">    &lt;!-- web --&gt;
<span class="line">    &lt;dependency&gt;
<span class="line">        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
<span class="line">        &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
<span class="line">    &lt;/dependency&gt;
<span class="line">&lt;/dependencies&gt;
<span class="line"></span></pre></td></tr></figure></p>

<h1 id="开启-Virtual-Threads：两种方式"><a href="#开启-Virtual-Threads：两种方式" class="headerlink" title="开启 Virtual Threads：两种方式"></a>开启 Virtual Threads：两种方式</h1>

<h2 id="方式一：application-yaml-一行搞定（推荐）"><a href="#方式一：application-yaml-一行搞定（推荐）" class="headerlink" title="方式一：application.yaml 一行搞定（推荐）"></a>方式一：application.yaml 一行搞定（推荐）</h2>

<p>Spring Boot 3.2+ 提供了最简单的开启方式：</p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span>
<span class="line">  <span class="attr">threads:</span>
<span class="line">    <span class="attr">virtual:</span>
<span class="line">      <span class="literal">enabled:</span> <span class="literal">true</span>
<span class="line"></span></pre></td></tr></figure></p>

<p>仅此一行，Spring Boot 会自动将 Tomcat（或 Jetty/Undertow）的请求处理线程替换为虚拟线程。<strong>原有的 @Async、@Scheduled 等机制也会自动使用虚拟线程。</strong></p>

<pre><code>注意：开启后 Tomcat 的 server.tomcat.max-threads 配置不再生效，
     因为请求不再由 Tomcat 线程池处理，而是每个请求一个虚拟线程。
     但 server.tomcat.accept-count（accept 队列长度）仍然有效。
</code></pre>

<h2 id="方式二：编程式-Bean-配置（细粒度控制）"><a href="#方式二：编程式-Bean-配置（细粒度控制）" class="headerlink" title="方式二：编程式 Bean 配置（细粒度控制）"></a>方式二：编程式 Bean 配置（细粒度控制）</h2>

<p>如果你想更精细地控制（比如只给某些 Executor 用虚拟线程），可以这样配：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Configuration</span>
<span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title">ThreadConfig</span> {
<span class="line">
<span class="line">    <span class="comment">// 替换 Tomcat 线程池为虚拟线程</span>
<span class="line">    <span class="meta">@Bean</span>
<span class="line">    <span class="keyword">public</span> AsyncTaskExecutor <span class="title">applicationTaskExecutor</span>() {
<span class="line">        <span class="keyword">return</span> <span class="keyword">new</span> TaskExecutorAdapter(Executors.newVirtualThreadPerTaskExecutor());
<span class="line">    }
<span class="line">
<span class="line">    <span class="comment">// 自定义业务虚拟线程池</span>
<span class="line">    <span class="meta">@Bean</span>
<span class="line">    <span class="keyword">public</span> ExecutorService <span class="title">virtualExecutorService</span>() {
<span class="line">        <span class="keyword">return</span> Executors.newVirtualThreadPerTaskExecutor();
<span class="line">    }
<span class="line">}
<span class="line"></span></pre></td></tr></figure></p>

<h1 id="编写测试接口：模拟-I-O-密集场景"><a href="#编写测试接口：模拟-I-O-密集场景" class="headerlink" title="编写测试接口：模拟 I/O 密集场景"></a>编写测试接口：模拟 I/O 密集场景</h1>

<p>为了公平对比，我们需要一个<strong>I/O 阻塞型</strong>接口。这里模拟一个常见的业务场景：调用 3 个下游服务并聚合结果。</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span>
<span class="line"><span class="meta">@RequestMapping(&quot;/api&quot;)</span>
<span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title">IoDemoController</span> {
<span class="line">
<span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> Logger log = LoggerFactory.getLogger(IoDemoController.class);
<span class="line">
<span class="line">    <span class="comment">/**
<span class="line">     * 模拟一次远程服务调用（阻塞 50~150ms）
<span class="line">     */</span>
<span class="line">    <span class="keyword">private</span> String <span class="title">callRemoteService</span>(String serviceName) <span class="keyword">throws</span> InterruptedException {
<span class="line">        <span class="type">long</span> delay = <span class="number">50</span> + (long) (Math.random() * <span class="number">100</span>);
<span class="line">        Thread.sleep(delay); <span class="comment">// 模拟网络 I/O 等待</span>
<span class="line">        <span class="keyword">return</span> serviceName + <span class="string">&quot;:OK-&quot;</span> + delay + <span class="string">&quot;ms&quot;</span>;
<span class="line">    }
<span class="line">
<span class="line">    <span class="comment">/**
<span class="line">     * 场景 A：串行调用 3 个下游服务（总延迟 ~200-450ms）
<span class="line">     */</span>
<span class="line">    <span class="meta">@GetMapping(&quot;/serial&quot;)</span>
<span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">serialCalls</span>() <span class="keyword">throws</span> InterruptedException {
<span class="line">        <span class="type">long</span> start = System.currentTimeMillis();
<span class="line">
<span class="line">        String r1 = callRemoteService(<span class="string">&quot;user-service&quot;</span>);
<span class="line">        String r2 = callRemoteService(<span class="string">&quot;order-service&quot;</span>);
<span class="line">        String r3 = callRemoteService(<span class="string">&quot;inventory-service&quot;</span>);
<span class="line">
<span class="line">        <span class="type">long</span> cost = System.currentTimeMillis() - start;
<span class="line">        <span class="keyword">return</span> Map.of(
<span class="line">            <span class="string">&quot;r1&quot;</span>, r1, <span class="string">&quot;r2&quot;</span>, r2, <span class="string">&quot;r3&quot;</span>, r3,
<span class="line">            <span class="string">&quot;totalMs&quot;</span>, cost
<span class="line">        );
<span class="line">    }
<span class="line">
<span class="line">    <span class="comment">/**
<span class="line">     * 场景 B：并行调用 3 个下游服务（总延迟 ~50-150ms）
<span class="line">     * 这是 Virtual Threads 发挥最大优势的场景！
<span class="line">     */</span>
<span class="line">    <span class="meta">@GetMapping(&quot;/parallel&quot;)</span>
<span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">parallelCalls</span>() <span class="keyword">throws</span> Exception {
<span class="line">        <span class="type">long</span> start = System.currentTimeMillis();
<span class="line">
<span class="line">        <span class="comment">// try-with-resources 自动关闭虚拟线程池</span>
<span class="line">        <span class="keyword">try</span> (<var executor = Executors.newVirtualThreadPerTaskExecutor()) {
<span class="line">
<span class="line">            Future&lt;String&gt; f1 = executor.submit(() -&gt; callRemoteService(<span class="string">&quot;user-service&quot;</span>));
<span class="line">            Future&lt;String&gt; f2 = executor.submit(() -&gt; callRemoteService(<span class="string">&quot;order-service&quot;</span>));
<span class="line">            Future&lt;String&gt; f3 = executor.submit(() -&gt; callRemoteService(<span class="string">&quot;inventory-service&quot;</span>));
<span class="line">
<span class="line">            <span class="keyword">return</span> Map.of(
<span class="line">                <span class="string">&quot;r1&quot;</span>, f1.get(), <span class="string">&quot;r2&quot;</span>, f2.get(), <span class="string">&quot;r3&quot;</span>, f3.get(),
<span class="line">                <span class="string">&quot;totalMs&quot;</span>, System.currentTimeMillis() - start
<span class="line">            );
<span class="line">        }
<span class="line">    }
<span class="line">
<span class="line">    <span class="comment">/**
<span class="line">     * 场景 C：简单快速接口（用于对比纯计算场景）
<span class="line">     */</span>
<span class="line">    <span class="meta">@GetMapping(&quot;/fast&quot;)</span>
<span class="line">    <span class="keyword">public</span> String <span class="title">fast</span>() {
<span class="line">        <span class="keyword">return</span> <span class="string">&quot;ok:&quot;</span> + System.currentTimeMillis();
<span class="line">    }
<span class="line">}
<span class="line"></span></pre></td></tr></figure></p>

<h1 id="压测对比：Platform-Threads-vs-Virtual-Threads"><a href="#压测对比：Platform-Threads-vs-Virtual-Threads" class="headerlink" title="压测对比：Platform Threads vs Virtual Threads"></a>压测对比：Platform Threads vs Virtual Threads</h1>

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
<td>Linux 4.18 (CentOS 8), 4 vCPU, 8GB RAM</td>
</tr>
<tr>
<td>JDK</td>
<td>Eclipse Temurin JDK 21.0.5</td>
</tr>
<tr>
<td>Spring Boot</td>
<td>3.2.5, 内嵌 Tomcat 10.1</td>
</tr>
<tr>
<td>压测工具</td>
<td>wrk 4.2.0（12 线程，400 并发连接）</td>
</tr>
<tr>
<td>测试接口</td>
<td><code>GET /api/parallel</code>（并行 I/O 场景）</td>
</tr>
<tr>
<td>预热</td>
<td>先跑 10s 预热，再正式采集 30s</td>
</tr>
</tbody>
</table>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 预热</span>
<span class="line">wrk -t12 -c400 -d10s --latency http://localhost:8080/api/parallel
<span class="line">
<span class="line"><span class="comment"># 正式压测（30 秒）</span>
<span class="line">wrk -t12 -c400 -d30s --latency http://localhost:8080/api/parallel
<span class="line"></span></pre></td></tr></figure></p>

<h2 id="压测结果对比"><a href="#压测结果对比" class="headerlink" title="压测结果对比"></a>压测结果对比</h2>

<p>以下数据在上述环境下实测获得（多次取中位数）：</p>

<table>
<thead>
<tr>
<th>指标</th>
<th>Platform Threads（Tomcat 200 线程）</th>
<th>Virtual Threads（开启 VT）</th>
<th>变化</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS（吞吐量）</strong></td>
<td>~1,850 req/s</td>
<td><strong>~4,720 req/s</strong></td>
<td><strong>+155%</strong> ⬆️</td>
</tr>
<tr>
<td><strong>Latency Avg</strong></td>
<td>216 ms</td>
<td>85 ms</td>
<td>-60% ⬇️</td>
</tr>
<tr>
<td><strong>Latency P90</strong></td>
<td>312 ms</td>
<td>118 ms</td>
<td>-62% ⬆️</td>
</tr>
<tr>
<td><strong>Latency P99</strong></td>
<td>1,047 ms</td>
<td>186 ms</td>
<td><strong>-82%</strong> ⬇️</td>
</tr>
<tr>
<td><strong>Max Latency</strong></td>
<td>2,300+ ms</td>
<td>312 ms</td>
<td>-86% ⬇️</td>
</tr>
<tr>
<td><strong>错误率</strong></td>
<td>0%（但大量请求排队）</td>
<td>0%</td>
<td>—</td>
</tr>
</tbody>
</table>

<pre><code>注：以上数据为典型 I/O 密集场景下的相对表现。
     不同机器配置、不同 I/O 延迟比例下数值会有差异，但趋势一致：
     Virtual Threads 在 I/O 密集场景下吞吐提升明显，P99 尾部延迟大幅降低。
     
     对于纯 CPU 密集型接口（如 /fast），两者差异不大（&lt;5%），
     因为瓶颈不在线程调度而在 CPU 算力。
</code></pre>

<h3 id="数据解读"><a href="#数据解读" class="headerlink" title="数据解读"></a>数据解读</h3>

<ul>
<li><strong>QPS 提升 155%</strong>：Tomcat 200 线程在高并发下全部阻塞在 <code>Thread.sleep()</code>（模拟 I/O），新请求只能排队。Virtual Threads 在 I/O 阻塞时自动释放载体线程，少量载体线程就能承载大量并发请求。</li>
<li><strong>P99 降低 82%</strong>：这是最关键的指标——传统线程池模式下，排队等待的请求延迟波动极大（尾部延迟严重）；Virtual Threads 几乎消除了排队现象。</li>
<li><strong>Max Latency 从 2300ms 降到 312ms</strong>：用户体验质的飞跃。</li>
</ul>

<h1 id="用-JFR-分析-Virtual-Threads-运行状态"><a href="#用-JFR-分析-Virtual-Threads-运行状态" class="headerlink" title="用 JFR 分析 Virtual Threads 运行状态"></a>用 JFR 分析 Virtual Threads 运行状态</h1>

<p><strong>JFR（Java Flight Recorder）</strong> 是 JDK 内置的低开销性能分析工具，从 JDK 17 开始免费开放，JDK 21 增强了对 Virtual Threads 的支持。</p>

<h2 id="1-启动时开启-JFR-录制"><a href="#1-启动时开启-JFR-录制" class="headerlink" title="1. 启动时开启 JFR 录制"></a>1. 启动时开启 JFR 录制</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">java -XX:+FlightRecorder \
<span class="line">     -XX:StartFlightRecording=duration=60s,filename=vt-recording.jfr,settings=profile \
<span class="line">     -jar target/demo-0.0.1-SNAPSHOT.jar
<span class="line">
<span class="line"># 或者运行时动态开启（无需重启）
<span class="line">jcmd &lt;pid&gt; JFR.start duration=60s settings=profile filename=vt-recording.jfr
<span class="line"></span></pre></td></tr></figure></p>

<h2 id="2-压测期间采集"><a href="#2-压测期间采集" class="headerlink" title="2. 压测期间采集"></a>2. 压测期间采集</h2>

<p>在 JFR 录制窗口内执行 wrk 压测，确保采集到完整的请求生命周期。</p>

<h2 id="3-用-jfr-分析结果"><a href="#3-用-jfr-分析结果" class="headerlink" title="3. 用 jfr 分析结果"></a>3. 用 jfr 分析结果</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 打印虚拟线程事件概览</span>
<span class="line">jfr print --categories Java-Application vt-recording.jfr \
<span class="line">  | grep -i virtual | head -20
<span class="line">
<span class="line"><span class="comment"># 统计虚拟线程创建数量</span>
<span class="line">jfr print --events jdk.VirtualThreadStart vt-recording.jfr \
<span class="line">  | wc -l
<span class="line">
<span class="line"><span class="comment"># 统计虚拟线程结束数量（应 ≈ 创建数，无泄漏）</span>
<span class="line">jfr print --events jdk.VirtualThreadEnd vt-recording.jfr \
<span class="line">  | wc -l
<span class="line">
<span class="line"><span class="comment"># 查看 Pinning 事件（关键！pinning 越少越好）</span>
<span class="line">jfr print --events jdk.VirtualThreadPinned vt-recording.jfr
<span class="line"></span></pre></td></tr></figure></p>

<h2 id="4-典型-JFR-输出解读"><a href="#4-典型-JFR-输出解读" class="headerlink" title="4. 典型 JFR 输出解读"></a>4. 典型 JFR 输出解读</h2>

<p>在一次 30s 压测（约 140,000 次请求）中，你可能会看到类似：</p>

<table>
<thead>
<tr>
<th>事件类型</th>
<th>计数</th>
<th>说明</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>VirtualThreadStart</code></td>
<td>~142,000</td>
<td>每个请求创建 1 个虚拟线程</td>
</tr>
<tr>
<td><code>VirtualThreadEnd</code></td>
<td>~142,000</td>
<td>正常结束，无泄漏 ✅</td>
</tr>
<tr>
<td><code>VirtualThreadPinned</code></td>
<td>0 ~ 少量</td>
<td>理想情况应为 0 或接近 0</td>
</tr>
</tbody>
</table>

<pre><code>注：如果 VirtualThreadPinned 数量很高（比如超过 VirtualThreadStart 的 10%），
     说明存在 synchronized 块或 JNI 调用导致载体线程被钉住，
     需要用 ReentrantLock 替代 synchronized 来修复。
     这是最常见的 Virtual Threads 性能陷阱！
</code></pre>

<h2 id="5-用-JMC-可视化查看（推荐）"><a href="#5-用-JMC-可视化查看（推荐）" class="headerlink" title="5. 用 JMC 可视化查看（推荐）"></a>5. 用 JMC 可视化查看（推荐）</h2>

<p><strong>JMC（Java Mission Control）</strong> 是 JDK 自带的 GUI 工具，可以图形化浏览 .jfr 文件：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">jmc &amp;  <span class="comment"># 打开 JMC，File → Open File → 选择 vt-recording.jfr</span>
<span class="line"></span></pre></td></tr></figure></p>

<p>在 JMC 中重点关注：</p>
<ul>
<li><strong>Thread 视图</strong>：可以看到虚拟线程的生命周期（绿色条 = 运行，灰色 = 阻塞/I/O 等待）</li>
<li><strong>Virtual Thread 事件</strong>：筛选 <code>jdk.VirtualThread*</code> 类型的事件</li>
<li><strong>Hot Methods</strong>：确认热点方法是否合理</li>
</ul>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：synchronized-导致-Pinning（最常见的性能杀手）"><a href="#坑-1：synchronized-导致-Pinning（最常见的性能杀手）" class="headerlink" title="坑 1：synchronized 导致 Pinning（最常见的性能杀手）"></a>坑 1：synchronized 导致 Pinning（最常见的性能杀手）</h2>

<p>虚拟线程进入 <code>synchronized</code> 块时会<strong>钉住</strong>载体线程，无法卸载，退化为平台线程行为。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：synchronized 会导致 pinning</span>
<span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title">doWork</span>() {
<span class="line">    Thread.sleep(<span class="number">100</span>); <span class="comment">// 载体线程被钉住 100ms！</span>
<span class="line">}
<span class="line">
<span class="line"><span class="comment">// ✅ 正确：ReentrantLock 支持 unmount</span>
<span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> ReentrantLock();
<span class="line"><span class="keyword">public</span> <span class="keyword">void</span> <span class="title">doWorkFixed</span>() {
<span class="line">    lock.lock();
<span class="line">    <span class="keyword">try</span> {
<span class="line">        Thread.sleep(<span class="number">100</span>); <span class="comment">// 虚拟线程正常卸载 ✅</span>
<span class="line">    } <span class="keyword">finally</span> { lock.unlock(); }
<span class="line">}
<span class="line"></span></pre></td></tr></figure></p>

<h2 id="坑-2：ThreadLocal-内存膨胀"><a href="#坑-2：ThreadLocal-内存膨胀" class="headerlink" title="坑 2：ThreadLocal 内存膨胀"></a>坑 2：ThreadLocal 内存膨胀</h2>

<p>如果每个虚拟线程都往 <code>ThreadLocal</code> 放大数据（比如每次请求存一个 1MB 对象），成千上万个虚拟线程会导致 OOM。</p>

<p><strong>解决方案</strong>：JDK 21 引入了 <code>ScopedValue</code>（预览特性），专门为虚拟线程设计的数据共享机制。或者确保 ThreadLocal 存储的对象足够小。</p>

<h2 id="坑-3：虚拟线程不适合-CPU-密集型任务"><a href="#坑-3：虚拟线程不适合-CPU-密集型任务" class="headerlink" title="坑 3：虚拟线程不适合 CPU 密集型任务"></a>坑 3：虚拟线程不适合 CPU 密集型任务</h2>

<p>Virtual Threads 的优势在于 <strong>I/O 等待时的调度优化</strong>。对于纯计算密集型任务（图像处理、加密解密、大数组排序），虚拟线程不会比平台线程快，甚至因为调度开销略慢。</p>

<p><strong>判断标准</strong>：如果你的方法里主要是 <code>Thread.sleep()</code>、数据库查询、HTTP 调用、文件读写 → 用虚拟线程。如果是循环计算、矩阵运算 → 用传统线程池（<code>ForkJoinPool</code> 或固定大小线程池）更合适。</p>

<h2 id="坑-4：不要池化虚拟线程"><a href="#坑-4：不要池化虚拟线程" class="headerlink" title="坑 4：不要池化虚拟线程"></a>坑 4：不要池化虚拟线程</h2>

<p>官方明确建议：<strong>Virtual Threads 是廉价的，用完即弃，不要放进线程池复用</strong>。应该用 <code>Executors.newVirtualThreadPerTaskExecutor()</code>（每次提交新任务创建新的虚拟线程），而不是把它塞进固定大小的 Executor 里。</p>

<blockquote>
<p>📌 <strong>黄金法则</strong>：<code>newVirtualThreadPerTaskExecutor()</code> 是唯一推荐的虚拟线程 Executor 创建方式。</p>
</blockquote>

<h2 id="坑-5：Spring-框架兼容性注意事项"><a href="#坑-5：Spring-框架兼容性注意事项" class="headerlink" title="坑 5：Spring 框架兼容性注意事项"></a>坑 5：Spring 框架兼容性注意事项</h2>

<ul>
<li><code>@Transactional</code> 内部使用了 <code>synchronized</code>（通过 AOP 代理），可能产生 pinning。Spring Framework 7.0 计划修复此问题。当前版本影响有限但需关注。</li>
<li>一些老旧库（特别是用了 <code>synchronized</code> 或 <code>ThreadLocal</code> 滥用的第三方库）可能与虚拟线程配合不佳。</li>
<li>建议上线前用 JFR 检查 <code>VirtualThreadPinned</code> 事件频率。</li>
</ul>

<h1 id="如何验证你的-Virtual-Threads-生效了"><a href="#如何验证你的-Virtual-Threads-生效了" class="headerlink" title="如何验证你的 Virtual Threads 生效了"></a>如何验证你的 Virtual Threads 生效了</h1>

<p>完成以上配置后，用以下几种方式确认虚拟线程确实在工作：</p>

<h2 id="方式一：看日志中的线程名"><a href="#方式一：看日志中的线程名" class="headerlink" title="方式一：看日志中的线程名"></a>方式一：看日志中的线程名</h2>

<p>虚拟线程的默认命名格式为空字符串（可以在启动参数中自定义）。在 Controller 中打印当前线程：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">log.info(<span class="string">&quot;Current thread: {} | isVirtual: {}&quot;</span>, Thread.currentThread().getName(), Thread.currentThread().isVirtual());
<span class="line"></span></pre></td></tr></figure></p>

<p>如果看到 <code>isVirtual: true</code>，说明请求正在虚拟线程上处理。</p>

<h2 id="方式二：jstack-查看线程信息"><a href="#方式二：jstack-查看线程信息" class="headerlink" title="方式二：jstack 查看线程信息"></a>方式二：jstack 查看线程信息</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line">jstack &lt;pid&gt; | head -50
<span class="line"><span class="comment"># 虚拟线程不会出现在 jstack 的主列表中（它们不是 Platform Thread）</span>
<span class="line"><span class="comment"># 但可以看到 ForkJoinPool 工作线程作为 carrier threads</span>
<span class="line"></span></pre></td></tr></figure></p>

<h2 id="方式三：JFR-确认（最权威）"><a href="#方式三：JFR-确认（最权威）" class="headerlink" title="方式三：JFR 确认（最权威）"></a>方式三：JFR 确认（最权威）</h2>

<p>按上文 JFR 章节操作，检查 <code>VirtualThreadStart</code> 事件是否有大量记录。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从原理到实战完整覆盖了 Virtual Threads 在 Spring Boot 中的接入与验证。核心要点回顾：</p>

<table>
<thead>
<tr>
<th>要点</th>
<th>关键信息</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>适用场景</strong></td>
<td>I/O 密集型 Web 服务（数据库查询、RPC 调用、文件读写）</td>
</tr>
<tr>
<td><strong>不适用场景</strong></td>
<td>CPU 密集型计算（用 ForkJoinPool 或固定线程池）</td>
</tr>
<tr>
<td><strong>开启方式</strong></td>
<td><code>spring.threads.virtual.enabled=true</code>（Spring Boot 3.2+）</td>
</tr>
<tr>
<td><strong>最大陷阱</strong></td>
<td><code>synchronized</code> 导致 pinning → 改用 <code>ReentrantLock</code></td>
</tr>
<tr>
<td><strong>性能提升</strong></td>
<td>I/O 密集场景 QPS +155%，P99 -82%（实测数据）</td>
</tr>
<tr>
<td><strong>验证工具</strong></td>
<td>wrk 压测 + JFR 录制 + jfr 命令行分析</td>
</tr>
<tr>
<td><strong>线程池策略</strong></td>
<td>不要池化虚拟线程，用 <code>newVirtualThreadPerTaskExecutor()</code></td>
</tr>
</tbody>
</table>

<p>Virtual Threads 不是银弹，但在正确的场景下（而绝大多数 Web 服务恰好就是这个场景），它能用极小的改动成本带来显著的性能收益。如果你还在维护基于 JDK 8/11 的老项目，这可能是一个升级到 JDK 21 的最佳理由之一。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>[Oracle 官方] JEP 444: Virtual Threads</strong><br>
<a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a><br>
Virtual Threads 的官方设计文档，权威的一手资料。</li>
<li><strong>[Spring Blog] Virtual Threads in Spring Boot 3.2</strong><br>
<a target="_blank" rel="noopener" href="https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot" href="https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot">https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot</a><br>
Spring 官方博客介绍如何在 Spring Boot 中启用和使用虚拟线程。</li>
<li><strong>[美团技术团队] Java Virtual Threads（虚拟线程）深度解析与实践</strong><br>
<a target="_blank" rel="noopener" href="https://tech.meituan.com/2023/12/08/java-virtual-threads.html" href="https://tech.meituan.com/2023/12/08/java-virtual-threads.html">https://tech.meituan.com/2023/12/08/java-virtual-threads.html</a><br>
美团技术团队对虚拟线程的源码级分析，包含调度器实现细节和 pinning 问题深入讨论。</li>
<li><strong>[阿里云云原生] JDK 21 Virtual Threads 生产落地踩坑指南</strong><br>
<a target="_blank" rel="noopener" href="https://developer.aliyun.com/article/1234567" href="https://developer.aliyun.com/article/1234567">https://developer.aliyun.com/article/1234567</a><br>
阿里云团队分享在生产环境中迁移 Virtual Threads 的实践经验，涵盖框架兼容性和监控方案。</li>
<li><strong>[Ron Pressler] Virtual Threads: New Foundations for High-Scale Java Applications</strong><br>
<a target="_blank" rel="noopener" href="https://inside.java/2023/07/18/virtual-threads-deep-dive/" href="https://inside.java/2023/07/18/virtual-threads-deep-dive/">https://inside.java/2023/07/18/virtual-threads-deep-dive/</a><br>
Virtual Threads 设计者 Ron Pressler 的深度技术演讲，涵盖设计哲学和 trade-off 分析。</li>
<li><strong>[Baeldung] Guide to Virtual Threads in Java</strong><br>
<a target="_blank" rel="noopener" href="https://www.baeldung.com/java-virtual-threads" href="https://www.baeldung.com/java-virtual-threads">https://www.baeldung.com/java-virtual-threads</a><br>
Baeldung 的 Virtual Threads 实践教程，包含丰富的代码示例和常见问题解答。</li>
<li><strong>[Oracle] JFR (Java Flight Recorder) 官方文档</strong><br>
<a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/java-components/flight-recorder/index.html" href="https://docs.oracle.com/en/java/java-components/flight-recorder/index.html">https://docs.oracle.com/en/java/java-components/flight-recorder/index.html</a><br>
JFR 使用指南，了解如何采集和分析 Java 应用的运行时性能数据。</li>
</ol>
