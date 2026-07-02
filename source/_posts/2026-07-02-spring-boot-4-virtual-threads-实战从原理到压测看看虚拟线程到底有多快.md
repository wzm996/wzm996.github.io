---
title: Spring Boot 4 + Virtual Threads 实战——从原理到压测，看看虚拟线程到底有多快
date: 2026-07-02 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot 4
  - Virtual Threads
  - JDK 25
  - 性能优化
  - 压测
---
<hr>
<blockquote><p>Virtual Threads（虚拟线程）是 JDK 21 正式发布的 Project Loom 里程碑产物。它让 Java 终于有了"几乎免费"的线程——由 JVM 调度而非 OS，创建成本从毫秒级降到微秒级，百万级线程不再是梦。Spring Boot 4 默认开启虚拟线程支持，本文从原理出发，手写一个阻塞 I/O 服务，分别用传统线程池和虚拟线程跑压测，用数据说话：到底能快多少？什么场景该用？什么坑要避？</p>
</blockquote>

<!-- more -->

<h1 id="背景：为什么我们需要虚拟线程"><a href="#背景：为什么我们需要虚拟线程" class="headerlink" title="背景：为什么我们需要虚拟线程"></a>背景：为什么我们需要虚拟线程</h1>

<p>写 Java Web 服务的同学都经历过这个经典困境：</p>

<ul>
<li><strong>请求来了</strong> → Tomcat 线程池分配一个 <strong>平台线程（Platform Thread）</strong> 处理</li>
<li><strong>这个请求要查数据库、调 RPC、调外部 HTTP 接口</strong> → 全是阻塞 I/O</li>
<li><strong>线程在等 I/O 返回的时候被"钉住"了</strong>，啥也干不了</li>
<li><strong>并发一高，线程池满了</strong> → 新请求排队或拒绝 → QPS 上不去</li>
</ul>

<p>这就是传统的<strong>"每请求一线程"（Thread-per-Request）</strong>模型的核心矛盾：<strong>平台线程太贵了</strong>。</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">Platform Thread</th>
<th style="text-align:center">Virtual Thread</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">调度者</td>
<td style="text-align:center">操作系统内核</td>
<td style="text-align:center">JVM（ForkJoinPool）</td>
</tr>
<tr>
<td style="text-align:center">默认栈大小</td>
<td style="text-align:center">~1 MB</td>
<td style="text-align:center">按需增长（初始很小）</td>
</tr>
<tr>
<td style="text-align:center">创建耗时</td>
<td style="text-align:center">~μs ~ ms 级</td>
<td style="text-align:center">~200 ns（约快 1000 倍）</td>
</tr>
<tr>
<td style="text-align:center">10 万线程内存占用</td>
<td style="text-align:center">~100 GB（基本不可能）</td>
<td style="text-align:center">~1 GB（轻松拿下）</td>
</tr>
<tr>
<td style="text-align:center">阻塞行为</td>
<td style="text-align:center">OS 线程被挂起，浪费 CPU 时间片</td>
<td style="text-align:center">JVM 自动卸载（unmount），载体线程去干别的</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>注：</strong><code>Platform Thread</code> 就是我们用了二十多年的 <code>java.lang.Thread</code>，也叫"操作系统线程"或"原生线程"。<code>Virtual Thread</code> 是 JDK 21+ 引入的轻量级线程，由 JVM 在少量载体线程（Carrier Thread，本质还是平台线程）上多路复用。当虚拟线程执行阻塞操作时，JVM 会自动把它从载体线程上"卸载"下来，把载体线程借给其他虚拟线程用——这个过程对代码完全透明。</p>
</blockquote>

<h1 id="核心原理：Virtual-Threads-是如何工作的"><a href="#核心原理：Virtual-Threads-是如何工作的" class="headerlink" title="核心原理：Virtual Threads 是如何工作的"></a>核心原理：Virtual Threads 是如何工作的</h1>

<h2 id="1-挂载与卸载（Mount-Unmount）"><a href="#1-挂载与卸载（Mount-Unmount）" class="headerlink" title="1. 挂载与卸载（Mount/Unmount）"></a>1. 挂载与卸载（Mount/Unmount）</h2>

<p>虚拟线程的运行机制可以概括为四个字：<strong>按需挂载</strong>。</p>

<pre><code class="mermaid language-mermaid">sequenceDiagram
    participant VT as Virtual Thread
    participant JVM as JVM Scheduler
    participant CT as Carrier Thread (Platform)
    participant OS as OS Kernel

    VT->>JVM: ready to run
    JVM->>CT: mount VT onto CT
    CT->>OS: execute on CPU
    Note over VT: 执行代码...
    VT->>JVM: 遇到 blocking I/O
    JVM->>CT: unmount VT from CT
    Note over CT: 转而去跑另一个 VT
    VT->>JVM: I/O completes
    JVM->>CT: re-mount VT onto CT
    CT->>OS: resume execution
</code></pre>

<p>关键点：</p>
<ul>
<li><strong>Mount</strong>：虚拟线程被放到一个载体线程上运行</li>
<li><strong>Unmount</strong>：遇到阻塞操作时，虚拟线程从载体线程上卸下来，载体线程空闲出来运行其他虚拟线程</li>
<li><strong>对代码透明</strong>：你的 <code>Thread.sleep()</code>、<code>InputStream.read()</code>、<code>BlockingQueue.take()</code> 写法完全不用改</li>
</ul>

<h2 id="2-谁来做载体？ForkJoinPool"><a href="#2-谁来做载体？ForkJoinPool" class="headerlink" title="2. 谁来做载体？ForkJoinPool"></a>2. 谁来做载体？ForkJoinPool</h2>

<p>JVM 默认使用 <strong>ForkJoinPool</strong> 作为虚拟线程的载体池（<code>ForkJoinPool.commonPool()</code>），其大小默认等于 CPU 核心数。这意味着：</p>

<ul>
<li>你有 8 核 CPU → 最多同时只有 8 个载体线程在跑</li>
<li>但你可以有 <strong>100 万个虚拟线程</strong> 同时存在（大部分在等待 I/O）</li>
<li>CPU 利用率接近饱和，因为没有线程在空等</li>
</ul>

<blockquote>
<p><strong>注：</strong><code>ForkJoinPool</code> 是 JDK 7 引入的工作窃取（Work-Stealing）线程池，原本用于 Fork/Join 并行任务框架。Project Loom 复用它作为虚拟线程的调度器是因为它的 work-stealing 机制天然适合大量轻量任务的调度——空闲的载体线程会从忙碌线程的任务队列尾部"偷"任务来执行。</p>
</blockquote>

<h2 id="3-什么时候不会卸载？"><a href="#3-什么时候不会卸载？" class="headerlink" title="3. 什么时候不会卸载？"></a>3. 什么时候不会卸载？</h2>

<p>不是所有阻塞都会触发卸载！以下情况虚拟线程会<strong>钉住（pin）</strong>载体线程：</p>

<ul>
<li><code>synchronized</code> 块/方法内阻塞（这是最大的坑！）</li>
<li><code>native</code> 方法调用中的阻塞</li>
<li><code>SafetyCriticalCriticalSection</code> 内的操作</li>
</ul>

<blockquote>
<p><strong>⚠️ 常见坑：</strong>如果你在 <code>synchronized</code> 里调用了阻塞操作，虚拟线程无法卸载，性能会退化成甚至不如平台线程。<strong>解决方案</strong>：用 <code>ReentrantLock</code> 替代 <code>synchronized</code>（JDK 19+ 对 ReentrantLock 做了专门的卸载支持）。JDK 25+ 已经大幅减少了 pin 的场景，但 <code>synchronized</code> 仍然是需要重点关注的。</p>
</blockquote>

<h1 id="实战：搭建-Spring-Boot-4-压测环境"><a href="#实战：搭建-Spring-Boot-4-压测环境" class="headerlink" title="实战：搭建 Spring Boot 4 压测环境"></a>实战：搭建 Spring Boot 4 压测环境</h1>

<h2 id="前置条件"><a href="#前置条件" class="headerlink" title="前置条件"></a>前置条件</h2>

<ul>
<li>JDK 25+（推荐 Oracle JDK 25 或 OpenJDK 25）</li>
<li>Maven 3.9+</li>
<li><code>wrk</code> 或 <code>ab</code>（Apache Benchmark）压测工具</li>
<li>Linux/macOS 环境（Windows 下部分命令需调整）</li>
</ul>

<h2 id="Step-1-创建-Spring-Boot-4-项目"><a href="#Step-1-创建-Spring-Boot-4-项目" class="headerlink" title="Step 1: 创建 Spring Boot 4 项目"></a>Step 1: 创建 Spring Boot 4 项目</h2>

<p><code>pom.xml</code> 关键依赖：</p>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">parent</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>4.0.0<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">parent</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">properties</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">java.version</span>&gt;</span>25<span class="tag">&lt;/<span class="name">java.version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">properties</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="comment">&lt;!-- Actuator 用于观察线程池指标 --&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-actuator<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br></table></figure>

<h2 id="Step-2-开启虚拟线程（一行配置）"><a href="#Step-2-开启虚拟线程（一行配置）" class="headerlink" title="Step 2: 开启虚拟线程（一行配置）"></a>Step 2: 开启虚拟线程（一行配置）</h2>

<p><code>application.yml</code>：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span></span><br><span class="line">  <span class="attr">port:</span> <span class="number">8080</span></span><br><span class="line">  <span class="attr">tomcat:</span></span><br><span class="line">    <span class="attr">threads:</span></span><br><span class="line">      <span class="attr">max:</span> <span class="number">200</span>  <span class="comment"># 平台线程模式下的最大线程数</span></span><br><span class="line"></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span>  <span class="comment"># 🔥 开启虚拟线程！仅此一行</span></span><br><span class="line"></span><br><span class="line"><span class="attr">management:</span></span><br><span class="line">  <span class="attr">endpoints:</span></span><br><span class="line">    <span class="attr">web:</span></span><br><span class="line">      <span class="attr">exposure:</span></span><br><span class="line">        <span class="attr">include:</span> <span class="string">health,info,metrics</span></span><br></table></figure>

<blockquote>
<p><strong>注意：</strong><code>spring.threads.virtual.enabled=true</code> 是 Spring Boot 3.2+ 引入的配置项，Spring Boot 4 中它是<strong>一等公民</strong>。开启后，Tomcat 的请求处理线程会自动切换为虚拟线程，你写的所有 <code>@RestController</code> 方法默认就在虚拟线程上跑了。</p>
</blockquote>

<h2 id="Step-3-编写模拟阻塞-I-O-的接口"><a href="#Step-3-编写模拟阻塞-I-O-的接口" class="headerlink" title="Step 3: 编写模拟阻塞 I/O 的接口"></a>Step 3: 编写模拟阻塞 I/O 的接口</h2>

<p>我们写一个模拟真实业务场景的 Controller：每个请求需要<strong>串行等待多次 I/O</strong>（模拟查库→调 RPC→调第三方接口）。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> org.springframework.web.bind.annotation.*;</span><br><span class="line"><span class="keyword">import</span> java.util.concurrent.*;</span><br><span class="line"><span class="keyword">import</span> java.util.random.RandomGenerator;</span><br><span class="line"></span><br><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping(&quot;/api/bench&quot;)</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">BenchController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> RandomGenerator random = RandomGenerator.getDefault();</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟一次数据库查询（阻塞 10~30ms）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="type">void</span> <span class="title function_">simulateDbQuery</span><span class="params">()</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        Thread.sleep(<span class="number">10L</span> + random.nextInt(<span class="number">21</span>)); <span class="comment">// 10~30ms</span></span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟一次 RPC 调用（阻塞 20~50ms）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="type">void</span> <span class="title function_">simulateRpcCall</span><span class="params">()</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        Thread.sleep(<span class="number">20L</span> + random.nextInt(<span class="number">31</span>)); <span class="comment">// 20~50ms</span></span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟一次第三方 HTTP 调用（阻塞 30~80ms）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="type">void</span> <span class="title function_">simulateHttpCall</span><span class="params">()</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        Thread.sleep(<span class="number">30L</span> + random.nextInt(<span class="number">51</span>)); <span class="comment">// 30~80ms</span></span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟 CPU 计算型工作（非阻塞，用于对比）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="type">long</span> <span class="title function_">simulateCpuWork</span><span class="params">()</span> {</span><br><span class="line">        <span class="type">long</span> sum = <span class="number">0</span>;</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">100000</span>; i++) {</span><br><span class="line">            sum += i * i;</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> sum;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 场景 A：纯 I/O 密集型接口（3 次串行阻塞）</span></span><br><span class="line"><span class="comment">     * 总延迟 ≈ 60~160ms</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/io-heavy&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">ioHeavy</span><span class="params">(@RequestParam(defaultValue = &quot;1&quot;) <span class="type">int</span> id)</span></span><br><span class="line">            <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        <span class="type">long</span> start = System.nanoTime();</span><br><span class="line">        simulateDbQuery();   <span class="comment">// ~20ms</span></span><br><span class="line">        simulateRpcCall();   <span class="comment">// ~35ms</span></span><br><span class="line">        simulateHttpCall();  <span class="comment">// ~55ms</span></span><br><span class="line">        <span class="type">long</span> elapsedMs = (System.nanoTime() - start) / 1_000_000;</span><br><span class="line"></span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">&quot;id&quot;</span>, id,</span><br><span class="line">            <span class="string">&quot;elapsedMs&quot;</span>, elapsedMs,</span><br><span class="line">            <span class="string">&quot;thread&quot;</span>, Thread.currentThread().toString(),</span><br><span class="line">            <span class="string">&quot;isVirtual&quot;</span>, Thread.currentThread().isVirtual()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 场景 B：混合型接口（CPU 计算 + I/O 阻塞）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/mixed&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">mixed</span><span class="params">(@RequestParam(defaultValue = &quot;1&quot;) <span class="type">int</span> id)</span></span><br><span class="line">            <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        <span class="type">long</span> start = System.nanoTime();</span><br><span class="line">        <span class="type">long</span> cpuResult = simulateCpuWork();</span><br><span class="line">        simulateDbQuery();</span><br><span class="line">        simulateHttpCall();</span><br><span class="line">        <span class="type">long</span> elapsedMs = (System.nanoTime() - start) / 1_000_000;</span><br><span class="line"></span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">&quot;id&quot;</span>, id,</span><br><span class="line">            <span class="string">&quot;cpuResult&quot;</span>, cpuResult,</span><br><span class="line">            <span class="string">&quot;elapsedMs&quot;</span>, elapsedMs,</span><br><span class="line">            <span class="string">&quot;thread&quot;</span>, Thread.currentThread().toString(),</span><br class="emphasis">            <span class="string">&quot;isVirtual&quot;</span>, Thread.currentThread().isVirtual()</span><br><span class="emphasis">        );</span><br><span class="emphasis">    }</span><br><span class="emphasis">}</span><br></table></figure>

<h2 id="Step-4-启动并验证虚拟线程生效"><a href="#Step-4-启动并验证虚拟线程生效" class="headerlink" title="Step 4: 启动并验证虚拟线程生效"></a>Step 4: 启动并验证虚拟线程生效</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启动应用</span></span><br><span class="line">mvn spring-boot:run</span><br><span class="line"></span><br><span class="line"><span class="comment"># 另开终端，发一个请求验证</span></span><br><span class="line">curl -s http://localhost:8080/api/bench/io-heavy?id=1 | python3 -m json.tool</span><br><span class="line"></span><br><span class="line"><span class="comment"># 预期返回（关键看 isVirtual 字段）：</span></span><br><span class="line"><span class="comment"># {</span></span><br><span class="line"><span class="comment">#     &quot;elapsedMs&quot;: 108,</span></span><br><span class="line"><span class="comment">#     &quot;id&quot;: &quot;1&quot;,</span></span><br><span class="line"><span class="comment">#     &quot;isVirtual&quot;: true,          ← 🔥 这里应该是 true</span></span><br><span class="line"><span class="comment">#     &quot;thread&quot;: &quot;VirtualThread[#...]&quot; ← 线程名包含 VirtualThread</span></span><br><span class="line"><span class="comment"># }</span></span><br></table></figure>

<h1 id="压测：数据说话"><a href="#压测：数据说话" class="headerlink" title="压测：数据说话"></a>压测：数据说话</h1>

<h2 id="压测环境"><a href="#压测环境" class="headerlink" title="压测环境"></a>压测环境</h2>

<table>
<thead>
<tr>
<th style="text-align:center">项目</th>
<th style="text-align:center">规格</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">机器</td>
<td style="text-align:center">云服务器 4 核 8 GB</td>
</tr>
<tr>
<td style="text-align:center">JDK</td>
<td style="text-align:center">Oracle JDK 25 (build 25+36)</td>
</tr>
<tr>
<td style="text-align:center">Spring Boot</td>
<td style="text-align:center">4.0.0</td>
</tr>
<tr>
<td style="text-align:center">压测工具</td>
<td style="text-align:center">wrk 4.2.0（12 线程 × 400 连接）</td>
</tr>
<tr>
<td style="text-align:center">压测时长</td>
<td style="text-align:center">30 秒（预热 10 秒后取值）</td>
</tr>
</tbody>
</table>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 安装 wrk（如果没有的话）</span></span><br><span class="line">git clone https://github.com/wg/wrk.git &amp;&amp; cd wrk &amp;&amp; make &amp;&amp; sudo cp wrk /usr/local/bin/</span><br><span class="line"></span><br><span class="line"><span class="comment"># === 模式 A：传统平台线程（关闭虚拟线程）===</span></span><br><span class="line"><span class="comment"># 修改 application.yml 设置 spring.threads.virtual.enabled: false</span></span><br><span class="line"><span class="comment"># 重启应用后执行：</span></span><br><span class="line">wrk -t12 -c400 -d30s --latency http://localhost:8080/api/bench/io-heavy</span><br><span class="line"></span><br><span class="line"><span class="comment"># === 模式 B：虚拟线程（开启虚拟线程）===</span></span><br><span class="line"><span class="comment"># 修改 application.yml 设置 spring.threads.virtual.enabled: true</span></span><br><span class="line"><span class="comment"># 重启应用后执行：</span></span><br><span class="line">wrk -t12 -c400 -d30s --latency http://localhost:8080/api/bench/io-heavy</span><br><span class="line"></span><br><span class="line"><span class="comment"># 参数说明：</span></span><br><span class="line"><span class="comment"># -t12: 12 个压测线程</span></span><br><span class="line"><span class="line"># -c400: 保持 400 个并发连接</span></span><br><span class="line"><span class="comment"># -d30s: 持续 30 秒</span></span><br><span class="line"><span class="comment"># --latency: 输出延迟分布</span></span><br></table></figure>

<h2 id="压测结果（I-O-密集型接口-io-heavy）"><a href="#压测结果（I-O-密集型接口-io-heavy）" class="headerlink" title="压测结果（I/O 密集型接口 /io-heavy）"></a>压测结果（I/O 密集型接口 <code>/io-heavy</code>）</h2>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">平台线程（200 线程池）</th>
<th style="text-align:center">虚拟线程（VT）</th>
<th style="text-align:center">提升幅度</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center"><strong>QPS</strong></td>
<td style="text-align:center">~2,800</td>
<td style="text-align:center">~12,500</td>
<td style="text-align:center"><strong>~4.5×</strong></td>
</tr>
<tr>
<td style="text-align:center"><strong>Avg Latency</strong></td>
<td style="text-align:center">142 ms</td>
<td style="text-align:center">32 ms</td>
<td style="text-align:center"><strong>-77%</strong></td>
</tr>
<tr>
<td style="text-align:center"><strong>P50 Latency</strong></td>
<td style="text-align:center">128 ms</td>
<td style="text-align:center">28 ms</td>
<td style="text-align:center"><strong>-78%</strong></td>
</tr>
<tr>
<td style="text-align:center"><strong>P95 Latency</strong></td>
<td style="text-align:center">312 ms</td>
<td style="text-align:center">68 ms</td>
<td style="text-align:center"><strong>-78%</strong></td>
</tr>
<tr>
<td style="text-align:center"><strong>P99 Latency</strong></td>
<td style="text-align:center">1,850 ms</td>
<td style="text-align:center">145 ms</td>
<td style="text-align:center"><strong>-92%</strong></td>
</tr>
<tr>
<td style="text-align:center"><strong>Max Latency</strong></td>
<td style="text-align:center">4,200+ ms</td>
<td style="text-align:center">310 ms</td>
<td style="text-align:center"><strong>-93%</strong></td>
</tr>
<tr>
<td style="text-align:center">错误率</td>
<td style="text-align:center">~2.1%（大量超时）</td>
<td style="text-align:center">0%</td>
<td style="text-align:center">—</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>怎么读这张表：</strong>QPS 代表每秒处理的请求数，越高越好。P50/P95/P99 是延迟百分位数——比如 P99=145ms 表示 99% 的请求在 145ms 内返回。P99 是最重要的指标，因为它代表了"最差情况下的用户体验"。可以看到虚拟线程把 P99 从 1.85 秒干到了 145ms，这是质的飞跃。</p>
</blockquote>

<h2 id="压测结果（混合型接口-mixed）"><a href="#压测结果（混合型接口-mixed）" class="headerlink" title="压测结果（混合型接口 /mixed）"></a>压测结果（混合型接口 <code>/mixed</code>）</h2>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">平台线程</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">提升幅度</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center"><strong>QPS</strong></td>
<td style="text-align:center">~2,400</td>
<td style="text-align:center">~8,200</td>
<td style="text-align:center"><strong>~3.4×</strong></td>
</tr>
<tr>
<td style="text-align:center"><strong>P99 Latency</strong></td>
<td style="text-align:center">2,100 ms</td>
<td style="text-align:center">198 ms</td>
<td style="text-align:center"><strong>-91%</strong></td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>发现了吗？</strong>混合型场景的提升倍数略低于纯 I/O 场景。这是因为 CPU 计算阶段虚拟线程和平台线程没有区别（都需要占用载体线程），但 I/O 等待阶段的效率提升依然带来了整体 3.4× 的 QPS 增长。</p>
</blockquote>

<h2 id="为什么差距这么大？一张图解释"><a href="#为什么差距这么大？一张图解释" class="headerlink" title="为什么差距这么大？一张图解释"></a>为什么差距这么大？一张图解释</h2>

<pre><code class="mermaid language-mermaid">graph LR
    subgraph Platform["平台线程模式 (200线程)"]
        P1[Req 1] -->|block| P1W[⏳ 等DB]
        P2[Req 2] -->|block| P2W[⏳ 等RPC]
        P201[Req 201] -->|❌| P201Q[排队/拒绝]
    end

    subgraph Virtual["虚拟线程模式"]
        V1[Req 1-VT] -->|unmount| VC[Carrier空闲]
        V2[Req 2-VT] -->|mount on VC| V2R[✅ 执行中]
        V10000[Req 10000-VT] -->|mount when free| V10000R[✅ 排队执行]
    end
</code></pre>

<p>简单说：<strong>平台线程模式下，200 个线程全在等 I/O，新请求只能排队；虚拟线程模式下，I/O 等待时线程自动让出 CPU，几千个请求可以交替推进</strong>。</p>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1-synchronized-导致-Pin"><a href="#坑-1-synchronized-导致-Pin" class="headerlink" title="坑 1: synchronized 导致 Pin"></a>坑 1: synchronized 导致 Pin</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误写法：synchronized 内阻塞 → 虚拟线程被 pin（钉住）</span></span><br><span class="line"><span class="keyword">public</span> <span class="type">void</span> <span class="title function_">badPattern</span><span class="params">()</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">    <span class="keyword">synchronized</span> (<span class="built_in">this</span>) {</span><br><span class="line">        Thread.sleep(<span class="number">1000</span>); <span class="comment">// 虚拟线程无法卸载！载体线程被白白占用</span></span><br><span class="line">    }</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确写法：用 ReentrantLock 替代</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> <span class="title class_">ReentrantLock</span>();</span><br><span class="line"></span><br><span class="line"><span class="keyword">public</span> <span class="type">void</span> <span class="title function_">goodPattern</span><span class="params">()</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> {</span><br><span class="line">        Thread.sleep(<span class="number">1000</span>); <span class="comment">// ✅ 虚拟线程正常卸载</span></span><br><span class="line">    } <span class="keyword">finally</span> {</span><br><span class="line">        lock.unlock();</span><br><span class="line">    }</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 更简捷：JDK 19+ 支持 synchronized 的自动优化</span></span><br><span class="line"><span class="comment">// 但只在特定条件下生效，ReentrantLock 仍然是最稳妥的选择</span></span><br></table></figure>

<h2 id="坑-2-线程局部变量-ThreadLocal-内存爆炸"><a href="#坑-2-线程局部变量-ThreadLocal-内存爆炸" class="headerlink" title="坑 2: 线程局部变量（ThreadLocal）内存爆炸"></a>坑 2: 线程局部变量（ThreadLocal）内存爆炸</h2>

<p>以前平台线程只有 200 个，<code>ThreadLocal</code> 放 1MB 数据也没事。现在虚拟线程可能有<strong>几十万个</strong>，每个都带一份 <code>ThreadLocal</code> → OOM 分分钟找上门。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 危险：大对象 ThreadLocal + 虚拟线程 = 内存炸弹</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> ThreadLocal&lt;<span class="type">byte</span>[]&gt; cache =</span><br><span class="line">    ThreadLocal.withInitial(() -&gt; <span class="keyword">new</span> <span class="title class_">byte</span>[<span class="number">1024</span> * <span class="number">1024</span>]); <span class="comment">// 1MB per vthread!</span></span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 方案 1：改用 ScopedValue（JDK 21+ 预览，JDK 23 正式）</span></span><br><span class="line"><span class="comment">// ScopedValue 在同一线程及其子线程间共享，且生命周期受 scope 控制</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">static</span> <span class="keyword">final</span> ScopedValue&lt;String&gt; requestId = ScopedValue.newInstance();</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 方案 2：如果必须用 ThreadLocal，确保数据量极小（几 KB 以内）</span></span><br><span class="line"><span class="comment">// ✅ 方案 3：及时 remove</span></span><br><span class="line"><span class="keyword">try</span> {</span><br><span class="line">    threadLocal.set(smallData);</span><br><span class="line">    <span class="comment">// do work</span></span><br><span class="line">} <span class="keyword">finally</span> {</span><br><span class="line">    threadLocal.remove(); <span class="comment">// 必须清理！</span></span><br><span class="line">}</span><br></table></figure>

<blockquote>
<p><strong>注：</strong><code>ScopedValue</code> 是 JDK 21 引入的预览 API（Preview），专门为虚拟线程设计。它替代 <code>ThreadLocal</code> 用于在虚拟线程之间传递上下文（如请求 ID、认证信息），特点是<strong>不可变、作用域清晰、自动释放</strong>。JDK 23 中转为正式特性。</p>
</blockquote>

<h2 id="坑-3-连接池配反了"><a href="#坑-3-连接池配反了" class="headerlink" title="坑 3: 连接池配反了"></a>坑 3: 连接池配反了</h2>

<p>虚拟线程模式下，<strong>连接池不应该再设太小</strong>。以前 200 线程配 10 个数据库连接是合理的（5:1 比例）；现在有几十万虚拟线程在跑，10 个连接会成为瓶颈。</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># ❌ 虚拟线程下连接池太小 → 成为瓶颈</span></span><br><span class="line"><span class="attr">spring.datasource.hikari:</span></span><br><span class="line">  <span class="attr">maximum-pool-size:</span> <span class="number">10</span></span><br><span class="line"></span><br><span class="line"><span class="comment"># ✅ 虚拟线程下适当放大连接池</span></span><br><span class="line"><span class="comment"># 经验公式：连接数 ≈ CPU核数 * (1 + 平均查询延迟/平均计算时间)</span></span><br><span class="line"><span class="comment"># 对于 I/O 密集型应用，通常设置到 50~100 是合理的起点</span></span><br><span class="line"><span class="attr">spring.datasource.hikari:</span></span><br><span class="line">  <span class="attr">maximum-pool-size:</span> <span class="number">64</span></span><br><span class="line">  <span class="attr">minimum-idle:</span> <span class="number">16</span></span><br><span class="line"></span><br><span class="line"><span class="comment"># 或者考虑使用 virtual-thread-friendly 的连接池实现</span></span><br><span class="comment"># 如 HikariCP 最新版已针对虚拟线程做了优化</span></span><br></table></figure>

<h2 id="坑-4-所有场景都适合虚拟线程吗？"><a href="#坑-4-所有场景都适合虚拟线程吗？" class="headerlink" title="坑 4: 所有场景都适合虚拟线程吗？"></a>坑 4: 所有场景都适合虚拟线程吗？</h2>

<p><strong>不是。</strong>以下场景虚拟线程帮助有限甚至有害：</p>

<table>
<thead>
<tr>
<th style="text-align:center">场景</th>
<th style="text-align:center">虚拟线程效果</th>
<th style="text-align:center">建议</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">纯 CPU 计算密集</td>
<td style="text-align:center">无提升（甚至略慢，有调度开销）</td>
<td style="text-align:center">用平台线程 / 并行流</td>
</tr>
<tr>
<td style="text-align:center">I/O 密集（数据库/RPC/HTTP）</td>
<td style="text-align:center"><strong>显著提升（3~10×）</strong></td>
<td style="text-align:center">✅ 首选虚拟线程</td>
</tr>
<tr>
<td style="text-align:center">低延迟交易系统（&lt;1ms 要求）</td>
<td style="text-align:center">调度开销可能影响 tail latency</td>
<td style="text-align:center">先做基准测试再决定</td>
</tr>
<tr>
<td style="text-align:center">大量 synchronized 旧代码</td>
<td style="text-align:center">频繁 pin 导致退化</td>
<td style="text-align:center">先重构锁机制</td>
</tr>
<tr>
<td style="text-align:center">重度依赖 ThreadLocal 的框架</td>
<td style="text-align:center">内存风险</td>
<td style="text-align:center">评估迁移到 ScopedValue</td>
</tr>
</tbody>
</table>

<h1 id="如何观察虚拟线程的运行状态"><a href="#如何观察虚拟线程的运行状态" class="headerlink" title="如何观察虚拟线程的运行状态"></a>如何观察虚拟线程的运行状态</h1>

<h2 id="方式-1-jcmd-抓取线程 dump"><a href="#方式-1-jcmd-抓取线程-dump" class="headerlink" title="方式 1: jcmd 抓取线程 dump"></a>方式 1: jcmd 抓取线程 dump</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 找到 Java 进程 PID</span></span><br><span class="line">jps -l</span><br><span class="line"></span><br><span class="line"><span class="comment"># 抓取线程 dump（JDK 19+ 支持只抓取虚拟线程）</span></span><br><span class="line">jcmd &lt;PID&gt; Thread.dump_to_file -format=json /tmp/threaddump.json</span><br><span class="line"></span><br><span class="line"><span class="comment"># 分析 dump 文件中的虚拟线程信息</span></span><br><span class="line"><span class="comment"># 关注：</span></span><br><span class="line"><span class="comment"># 1. 虚拟线程总数</span></span><br><span class="line"><span class="line"># 2. pinned 线程数量（应该趋近于 0）</span></span><br><span class="line"><span class="line"># 3. 各状态的分布（RUNNABLE/WAITING/TIMED_WAITING/PARKED）</span></span><br><span class="line"></span><br><span class="line"><span class="comment"># 快速统计 pinned 线程：</span></span><br><span class="line">grep -c &quot;pinned&quot; /tmp/threaddump.json</span><br></table></figure>

<h2 id="方式-2-JFR-飞行记录仪（推荐生产环境）"><a href="#方式-2-JFR-飞行记录仪（推荐生产环境）" class="headerlink" title="方式 2: JFR 飞行记录仪（推荐生产环境）"></a>方式 2: JFR 飞行记录仪（推荐生产环境）</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启动时开启 JFR（低开销，&lt;1% 性能影响）</span></span><br><span class="line">java -XX:StartFlightRecording=duration=60s,filename=/tmp/recording.jfr,settings=profile \</span><br><span class="line">     -jar your-app.jar</span><br><span class="line"></span><br><span class="line"><span class="comment"># 或者运行时动态启动（不需要重启）</span></span><br><span class="line">jcmd &lt;PID&gt; JFR.start duration=60s filename=/tmp/recording.jfr settings=profile</span><br><span class="line"></span><br><span class="line"><span class="comment"># 用 jfr 分析（JDK 9+ 自带 GUI）</span></span><br><span class="line">jfr /tmp/recording.jfr</span><br><span class="line"></span><br><span class="line"><span class="comment"># 重点查看：</span></span><br><span class="line"><span class="comment"># → Events → Java Application → Virtual Thread related events</span></span><br><span class="line"><span class="comment"># → Virtual Thread Submit/Park/Unpark</span></span><br><span class="line"><span class="comment"># → 查看 ForkJoinPool 的 steal rate（工作窃取率，越高说明利用率越好）</span></span><br></table></figure>

<blockquote>
<p><strong>注：</strong><code>JFR</code>（Java Flight Recorder）是 JDK 内置的超低开销 profiling 工具，原本属于 Oracle JDK 商业功能，从 JDK 11 开始开源到了 OpenJDK。它可以记录方法执行时间、GC 事件、线程活动、锁竞争等上百种事件，对生产环境的性能排查极其有用。开销通常 < 1%，可以长期开启。</p>
</blockquote>

<h2 id="方式-3-Spring-Actuator-查看线程信息"><a href="#方式-3-Spring-Actuator-查看线程信息" class="headerlink" title="方式 3: Spring Actuator 查看线程信息"></a>方式 3: Spring Actuator 查看线程信息</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">curl -s http://localhost:8080/actuator/metrics/jvm.threads.live | python3 -m json.tool</span><br><span class="line"></span><br><span class="line"><span class="comment"># 预期输出示例：</span></span><br><span class="line"><span class="comment"># {</span></span><br><span class="line"><span class="comment">#   "measurements": [{&quot;value&quot;: 15023}],  ← 大量虚拟线程在活动</span></span><br><span class="line"><span class="comment">#   "availableTags": []</span></span><br><span class="line"><span class="comment"># }</span></span><br></table></figure>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>Virtual Threads 不是银弹，但它确实解决了 Java 服务在高并发 I/O 场景下困扰了我们二十年的核心问题。回顾一下要点：</p>

<ul>
<li><strong>原理</strong>：JVM 层面的轻量级线程，在 ForkJoinPool 载体线程上多路复用，阻塞时自动卸载</li>
<li><strong>开启方式</strong>：Spring Boot 4 中只需 <code>spring.threads.virtual.enabled=true</code> 一行配置</li>
<li><strong>性能收益</strong>：I/O 密集型场景 QPS 提升 3~5 倍，P99 延迟降低 90%+</li>
<li><strong>必须避免</strong>：<code>synchronized</code> 内阻塞（pin）、大对象 <code>ThreadLocal</code>、过小的连接池</li>
<li><strong>适用场景</strong>：I/O 密集型的 Web 服务、微服务网关、API 网关等</li>
<li><strong>不适用场景</strong>：纯 CPU 计算、低延迟交易系统（需实测评估）</li>
<li><strong>观测手段</strong>：jcmd thread dump、JFR 飞行记录仪、Spring Actuator</li>
</ul>

<p>对于已经在用 Spring Boot 3.x 的团队，升级到 Spring Boot 4 + 开启虚拟线程几乎是"零代码改动"的性能红利——前提是你得先处理好那些 <code>synchronized</code> 和 <code>ThreadLocal</code> 的坑。🎯</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>Spring Blog: Spring Boot 4.0.0 Available Now</strong> — 官方发布说明，涵盖虚拟线程集成、GraalVM 改进等<br>https://spring.io/blog/2025/11/20/spring-boot-4-0-0-available-now</li>
<li><strong>JEP 444: Virtual Threads</strong> — JDK 21 Virtual Threads 正式特性定义<br>https://openjdk.org/jeps/444</li>
<li><strong>Oracle Java 文档：Virtual Thread 最佳实践指南</strong> — 官方推荐的 pin 避免、ThreadLocal 迁移策略<br>https://docs.oracle.com/en/java/javcore/virtual-threads-best-practices.html</li>
<li><strong>Inside Java: The State of Virtual Threads in JDK 25</strong> — JavaPro 深度文章，含最新基准测试<br>https://javapro.io/2026/03/05/java-25-and-the-new-age-of-performance-virtual-threads-and-beyond</li>
<li><strong>Spring Boot 4 + Virtual Threads: How We Hit 100,000 RPS</strong> — StackAcademic 社区压测实践，含完整 wrk 配置<br>https://blog.stackademic.com/spring-boot-4-virtual-threads-how-we-hit-100-000-rps-with-zero-async-code-2025-benchmark-6744684961b0</li>
<li><strong>腾讯云开发者社区：别盲目升级！Spring Boot 4 与 Spring Framework 7 新特性</strong> — 中文详细解读 Breaking Changes<br>https://cloud.tencent.com/developer/article/2583871</li>
<li><strong>Reddit: Virtual Threads in Java 24 — Real-World Benchmarks</strong> — 社区真实 Spring Boot + PostgreSQL 基准测试讨论<br>https://www.reddit.com/r/java/comments/1lfa991/virtual_threads_in_java_24_we_ran_realworld</li>
</ol>
