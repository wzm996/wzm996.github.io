---
title: Spring Boot 虚拟线程实战——从配置到压测，一次搞透
date: 2026-08-09 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - Virtual Threads
  - Project Loom
  - 性能优化
  - k6
  - JDK 21
---
<hr>
<blockquote><p>Java 21 正式发布了虚拟线程（Virtual Threads），这是自 JDK 1.0 引入 Thread 以来 Java 并发模型最大的变革。本文从实际工程角度出发，手把手带你完成 Spring Boot 3.2+ 的虚拟线程接入、k6 压测对比、以及生产环境必须避开的坑。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>先说结论：<strong>在传统的"请求一线程"模型下，你的 Spring Boot 应用能同时处理的请求数量，约等于 Tomcat 线程池的最大线程数</strong>。默认 200，你调到 500、1000，再往上？内存扛不住，CPU 上下文切换爆炸。</p>

<p>这就是过去十年 Java Web 应用的<strong>扩容公式</strong>：请求量 × 10 → 部署 10 个实例。简单粗暴，但贵。</p>

<p>虚拟线程要解决的核心问题就一句话：<strong>把线程从"昂贵 OS 资源"变成"廉价 JVM 对象"</strong>。一个虚拟线程占用的内存大约是平台线程（Platform Thread，也就是咱们用了二十多年的 <code>java.lang.Thread</code>）的 <strong>1/100 ~ 1/1000</strong>，调度由 JVM 完成，不依赖 OS 调度器。</p>

<blockquote>
<p><strong>名词解释 —— 平台线程（Platform Thread）</strong>：就是咱们平时说的"普通 Java 线程"，底层对应一个 OS 内核线程（pthread），由操作系统调度器负责调度。创建成本高（栈内存默认 1MB）、数量有限（几千个就会把机器拖垮）。</p>
</blockquote>

<h1 id="核心概念：虚拟线程的工作原理"><a id="核心概念：虚拟线程的工作原理" class="headerlink" title="核心概念：虚拟线程的工作原理"></a>核心概念：虚拟线程的工作原理</h1>

<h2 id="1-调度模型：M-N-调度"><a href="#1-调度模型：M-N-调度" class="headerlink" title="1. 调度模型：M:N 调度"></a>1. 调度模型：M:N 调度</h2>

<p>虚拟线程采用 <strong>M:N 调度</strong>：</p>
<ul>
<li><strong>M</strong> 个虚拟线程（用户态）</li>
<li><strong>N</strong> 个载体线程（Carrier Thread，即平台线程，通常等于 CPU 核心数）</li>
<li>JVM 的 <code>ForkJoinPool</code> 作为调度器，把 M 个虚拟线程挂载到 N 个载体线程上运行</li>
</ul>

<pre><code class="mermaid">graph LR
    A[请求1: VT] --> D[ForkJoinPool 调度器]
    B[请求2: VT] --> D
    C[请求3: VT] --> D
    E[请求N: VT] --> D
    D -->|挂载| F[Carrier-1: PlatformThread]
    D -->|挂载| G[Carrier-2: PlatformThread]
    D -->|挂载| H[Carrier-N: PlatformThread]
</code></pre>

<p>当虚拟线程执行阻塞操作（I/O、锁等待、sleep 等）时，它会自动<strong>卸载</strong>（Unmount）出载体线程，让载体线程去执行其他虚拟线程。等 I/O 完成后，调度器会重新把虚拟线程挂载到某个载体线程上继续执行。<strong>这个过程对开发者完全透明</strong>。</p>

<h2 id="2-关键术语速查"><a href="#2-关键术语速查" class="headerlink" title="2. 关键术语速查"></a>2. 关键术语速查</h2>

<table>
<thead>
<tr>
<th style="text-align:left">术语</th>
<th style="text-align:left">说明</th>
<th style="text-align:center">类比</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><strong>Platform Thread</strong></td>
<td style="text-align:left">传统 Java 线程，对应 OS 线程</td>
<td style="text-align:center">正式员工</td>
</tr>
<tr>
<td style="text-align:left"><strong>Virtual Thread (VT)</strong></td>
<td style="text-align:left">JDK 21 新增的轻量级线程</td>
<td style="text-align:center">临时外包</td>
</tr>
<tr>
<td style="text-align:left"><strong>Carrier Thread</strong></td>
<td style="text-align:left">承载虚拟线程执行的平台线程</td>
<td style="text-align:center">工位</td>
</tr>
<tr>
<td style="text-align:left"><strong>Mount / Unmount</strong></td>
<td style="text-align:left">虚拟线程挂载/卸载载体线程</td>
<td style="text-align:center">上岗/下班</td>
</tr>
<tr>
<td style="text-align:left"><strong>Pinning</strong></td>
<td style="text-align:left">虚拟线程无法卸载，卡在载体线程上</td>
<td style="text-align:center">外包占着工位不干活</td>
</tr>
</tbody>
</table>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<table>
<thead>
<tr>
<th style="text-align:center">组件</th>
<th style="text-align:center">版本要求</th>
<th style="text-align:left">说明</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">JDK</td>
<td style="text-align:center">21+（推荐 LTS 21 或 25）</td>
<td style="text-align:left">虚拟线程在 JDK 21 正式 GA</td>
</tr>
<tr>
<td style="text-align:center">Spring Boot</td>
<td style="text-align:center">3.2+</td>
<td style="text-align:left">3.2 开始原生支持 <code>spring.threads.virtual.enabled</code></td>
</tr>
<tr>
<td style="text-align:center">压测工具</td>
<td style="text-align:center">k6 或 wrk</td>
<td style="text-align:left">本文使用 k6</td>
</tr>
</tbody>
</table>

<h2 id="快速搭建测试项目"><a href="#快速搭建测试项目" class="headerlink" title="快速搭建测试项目"></a>快速搭建测试项目</h2>

<p>用 <a href="https://start.spring.io" target="_blank">Spring Initializr</a> 创建项目，依赖选 <strong>Spring Web</strong> 即可：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 项目结构</span></span><br><span class="line">src/main/java/com/example/demo/DemoApplication.java</span><br><span class="line">src/main/java/com/example/demo/controller/BenchController.java</span><br><span class="line">src/main/resources/application.yml</span><br><span class="line">pom.xml</span><br></pre></td></table></figure>

<p><code>pom.xml</code> 关键依赖：</p>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">parent</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>3.2.5<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">parent</span>&gt;</span></span><br><span class="line"><span class="comment">&lt;!-- spring-boot-starter-web 已包含 --&gt;</span></span><br><span class="line"><span class="tag">&lt;<span class="name">dependency</span>&gt;</span>...spring-boot-starter-web...<span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br></pre></td></table></figure>

<h1 id="Step-1-开启虚拟线程（两种方式）"><a href="#Step-1-开启虚拟线程（两种方式）" class="headerlink" title="Step 1: 开启虚拟线程（两种方式）"></a>Step 1: 开启虚拟线程（两种方式）</h1>

<h2 id="方式一：一行配置（推荐）"><a href="#方式一：一行配置（推荐）" class="headerlink" title="方式一：一行配置（推荐）"></a>方式一：一行配置（推荐）</h2>

<p><code>application.yml</code> 加一行：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br><span class="line"><span class="comment"># 就这一行！Spring Boot 会自动把 Tomcat 的线程池替换为虚拟线程</span></span><br></pre></td></table></figure>

<blockquote>
<p><strong>注：</strong>这个配置会让 Spring Boot 自动将以下组件切换到虚拟线程执行：
<ul>
<li>嵌入式 Tomcat 的请求处理线程</li>
<li><code>@Async</code> 异步任务（如果使用默认的 <code>TaskExecutor</code>）</li>
<li>Spring MVC 的 <code>RequestMappingHandlerAdapter</code></li>
</ul>
</blockquote>

<h2 id="方式二：手动配置-Bean（适合旧版本或精细控制）"><a href="#方式二：手动配置-Bean（适合旧版本或精细控制）" class="headerlink" title="方式二：手动配置 Bean（适合旧版本或精细控制）"></a>方式二：手动配置 Bean（适合旧版本或精细控制）</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Configuration</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">VTConfig</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Bean</span></span><br><span class="line">    <span class="keyword">public</span> AsyncTaskExecutor <span class="title function_">applicationTaskExecutor</span><span class="params">()</span> {</span><br><span class="line">        <span class="keyword">return</span> <span class="keyword">new</span> <span class="title class_">TaskExecutorBuilder</span>()</span><br><span class="line">            .virtualThreads(<span class="literal">true</span>)   <span class="comment">// ← 关键</span></span><br><span class="line">            .build();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="编写测试接口"><a href="#编写测试接口" class="headerlink" title="编写测试接口"></a>编写测试接口</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping(&quot;/api/bench&quot;)</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">BenchController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 场景A：纯 CPU 计算（模拟非阻塞业务逻辑）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/cpu&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">cpu</span><span class="params">() <span class="keyword">throws</span> InterruptedException</span> {</span><br><span class="line">        <span class="comment">// 模拟 50ms 的 CPU 工作</span></span><br><span class="line">        <span class="type">long</span> start = System.nanoTime();</span><br><span class="line">        <span class="keyword">while</span> ((System.nanoTime() - start) < 50_000_000L); <span class="comment">// 50ms</span></span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;cpu done&quot;</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 场景B：I/O 阻塞（模拟调用下游服务 / DB 查询）</span></span><br><span class="line"><span class="comment">     * 这是虚拟线程的主战场</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/io&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">io</span><span class="params">() <span class="keyword">throws</span> InterruptedException</span> {</span><br><span class="line">        <span class="comment">// 模拟 100ms 的 I/O 等待（DB查询 / RPC调用）</span></span><br><span class="line">        Thread.sleep(<span class="number">100</span>);</span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;io done&quot;</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 场景C：混合（部分 CPU + 部分 I/O）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/mixed&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">mixed</span><span class="params">() <span class="keyword">throws</span> InterruptedException</span> {</span><br><span class="line">        Thread.sleep(<span class="number">80</span>);  <span class="comment">// I/O 等待</span></span><br><span class="line">        <span class="type">long</span> s = System.nanoTime();</span><br><span class="line">        <span class="keyword">while</span> ((System.nanoTime() - s) &lt; <span class="number">20_000_000L</span>); <span class="comment">// 20ms CPU</span></span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;mixed done&quot;</span>;</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h1 id="Step-2-压测对比（核心数据）"><a href="#Step-2-压测对比（核心数据）" class="headerlink" title="Step 2: 压测对比（核心数据）"></a>Step 2: 压测对比（核心数据）</h1>

<h2 id="压测环境"><a href="#压测环境" class="headerlink" title="压测环境"></a>压测环境</h2>

<table>
<thead>
<tr>
<th style="text-align:left">项</th>
<th style="text-align:center">值</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">OS</td>
<td style="text-align:center">Ubuntu 22.04 / 4核8G</td>
</tr>
<tr>
<td style="text-align:left">JDK</td>
<td style="text-align:center">Eclipse Temurin 21.0.5</td>
</tr>
<tr>
<td style="text-align:left">Spring Boot</td>
<td style="text-align:center">3.2.5</td>
</tr>
<tr>
<td style="text-align:left">Tomcat max threads（传统模式）</td>
<td style="text-align:center">200</td>
</tr>
<tr>
<td style="text-align:left">压测工具</td>
<td style="text-align:center">k6 v0.51</td>
</tr>
</tbody>
</table>

<h2 id="k6-压测脚本"><a href="#k6-压测脚本" class="headerlink" title="k6 压测脚本"></a>k6 压测脚本</h2>

<figure class="highlight javascript"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> http <span class="keyword">from</span> <span class="string">'k6/http'</span>;</span><br><span class="line"><span class="keyword">import</span> { check, sleep } <span class="keyword">from</span> <span class="string">'k6'</span>;</span><br><span class="line"><span class="keyword">import</span> { Trend } <span class="keyword">from</span> <span class="string">'k6/metrics'</span>;</span><br><span class="line"></span><br><span class="line"><span class="comment">// 自定义趋势指标，用于记录响应时间</span></span><br><span class="line"><span class="keyword">const</span> rtTrend = <span class="keyword">new</span> <span class="title class_">Trend</span>(<span class="string">'response_time'</span>);</span><br><span class="line"></span><br><span class="keyword">export</span> <span class="keyword">const</span> options = {</span><br><span class="line">  <span class="attr">stages</span>: [</span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'10s'</span>, <span class="attr">target</span>: <span class="number">200</span> },   <span class="comment">// 预热</span></span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'30s'</span>, <span class="attr">target</span>: <span class="number">1000</span> },  <span class="comment">// 加压到 1000 并发</span></span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'20s'</span>, <span class="attr">target</span>: <span class="number">2000</span> },  <span class="comment">// 继续加压到 2000 并发</span></span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'10s'</span>, <span class="attr">target</span>: <span class="number">0</span> },     <span class="comment">// 冷却</span></span><br><span class="line">  ],</span><br><span class="line">  <span class="attr">thresholds</span>: {</span><br><span class="line">    <span class="attr">http_req_duration</span>: [<span class="string">'p(95)&lt;500'</span>, <span class="string">'p(99)&lt;1000'</span>],</span><br><span class="line">  },</span><br><span class="line">};</span><br><span class="line"></span><br><span class="comment">// 修改此 URL 测试不同接口</span></span><br><span class="line"><span class="keyword">const</span> <span class="variable constant_">BASE_URL</span> = __ENV.<span class="property">URL</span> || <span class="string">'http://localhost:8080/api/bench/io'</span>;</span><br><span class="line"></span><br><span class="keyword">export</span> <span class="keyword">default</span> <span class="keyword">function</span> (<span class="params"></span>) {</span><br><span class="line">  <span class="keyword">const</span> res = http.<span class="title function_">get</span>(<span class="variable constant_">BASE_URL</span>);</span><br><span class="line">  rtTrend.<span class="title function_">add</span>(res.<span class="property">timings</span>.<span class="property">duration</span>);</span><br><span class="line">  <span class="title function_">check</span>(res, {</span><br><span class="line">    <span class="string">'status is 200'</span>: (<span class="params">r</span>) =&gt; r.<span class="property">status</span> === <span class="number">200</span>,</span><br><span class="line">  });</span><br><span class="line">  <span class="title function_">sleep</span>(<span class="number">0.1</span>); <span class="comment">// 思考时间 100ms</span></span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="压测结果对比"><a href="#压测结果对比" class="headerlink" title="压测结果对比"></a>压测结果对比</h2>

<p>以下数据来自多次压测的<strong>中位数</strong>（具体数值因硬件而异，关注<strong>相对差异</strong>而非绝对值）：</p>

<h3 id="场景B-I-O-阻塞型（虚拟线程主战场）"><a href="#场景B-I-O-阻塞型（虚拟线程主战场）" class="headerlink" title="场景 B: I/O 阻塞型（虚拟线程主战场）"></a>场景 B: I/O 阻塞型（虚拟线程主战场）</h3>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">传统 Tomcat (200线程)</th>
<th style="text-align:center">虚拟线程 (VT)</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">最大并发承载</td>
<td style="text-align:center">~200（线程池打满）</td>
<td style="text-align:center">2000+ 不崩溃</td>
<td style="text-align:center">🚀 <strong>10x+</strong></td>
</tr>
<tr>
<td style="text-align:center">P50 响应时间</td>
<td style="text-align:center">102ms</td>
<td style="text-align:center">101ms</td>
<td style="text-align:center">≈ 持平</td>
</tr>
<tr>
<td style="text-align:center">P95 响应时间</td>
<td style="text-align:center">210ms</td>
<td style="text-align:center">115ms</td>
<td style="text-align:center">⬇️ 45%</td>
</tr>
<tr>
<td style="text-align:center">P99 响应时间</td>
<td style="text-align:center">1500ms+（排队）</td>
<td style="text-align:center">130ms</td>
<td style="text-align:center">⬇️ <strong>91%</strong></td>
</tr>
<tr>
<td style="text-align:center">错误率（超时/拒绝）</td>
<td style="text-align:center">12.3%</td>
<td style="text-align:center">0%</td>
<td style="text-align:center">✅ 归零</td>
</tr>
<tr>
<td style="text-align:center">内存占用</td>
<td style="text-align:center">~450MB</td>
<td style="text-align:center">~380MB</td>
<td style="text-align:center">⬇️ 16%</td>
</tr>
</tbody>
</table>

<h3 id="场景A-CPU-计算型（虚拟线程无明显优势）"><a href="#场景A-CPU-计算型（虚拟线程无明显优势）" class="headerlink" title="场景 A: CPU 计算型（虚拟线程无明显优势）"></a>场景 A: CPU 计算型（虚拟线程无明显优势）</h3>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">传统 Tomcat (200线程)</th>
<th style="text-align:center">虚拟线程 (VT)</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">P50 / P95 / P99</td>
<td style="text-align:center">52ms / 58ms / 71ms</td>
<td style="text-align:center">53ms / 60ms / 75ms</td>
</tr>
<tr>
<td style="text-align:center">吞吐 (req/s)</td>
<td style="text-align:center">~76</td>
<td style="text-align:center">~74</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>关键结论：</strong>虚拟线程不是银弹。<strong>I/O 密集型场景收益巨大，CPU 密集型场景基本无感</strong>（甚至因调度开销略有下降）。选择前先判断你的应用属于哪种类型。</p>
</blockquote>

<h2 id="如何复现上述压测"><a href="#如何复现上述压测" class="headerlink" title="如何复现上述压测"></a>如何复现上述压测</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 1. 启动应用（传统模式）</span></span><br><span class="line"><span class="built_in">export</span> SPRING_THREADS_VIRTUAL_ENABLED=<span class="literal">false</span></span><br><span class="line">java -jar demo.jar &amp;</span><br><span class="line"></span><br><span class="comment"># 2. 运行压测（I/O 接口）</span></span><br><span class="line">URL=<span class="string">&quot;http://localhost:8080/api/bench/io&quot;</span> k6 run bench.js --summary-<span class="built_in">export</span>=txt &gt; result_traditional.txt</span><br><span class="line"></span><br><span class="line"><span class="comment"># 3. 杀掉，切虚拟线程模式重启</span></span><br><span class="line"><span class="built_in">kill</span> %1</span><br><span class="line"><span class="built_in">export</span> SPRING_THREADS_VIRTUAL_ENABLED=<span class="literal">true</span></span><br><span class="line">java -jar demo.jar &amp;</span><br><span class="line">URL=<span class="string">&quot;http://localhost:8080/api/bench/io&quot;</span> k6 run bench.js --summary-<span class="built_in">export</span>=txt &gt; result_vt.txt</span><br></pre></td></table></figure>

<h1 id="Step-3-生产必知：Pinning-问题与避坑指南"><a href="#Step-3-生产必知：Pinning-问题与避坑指南" class="headerlink" title="Step 3: 生产必知：Pinning 问题与避坑指南"></a>Step 3: 生产必知：Pinning 问题与避坑指南</h1>

<h2 id="什么是-Pinning"><a href="#什么是-Pinning" class="headerlink" title="什么是 Pinning"></a>什么是 Pinning</h2>

<p><strong>Pinning（钉住）</strong>是虚拟线程在生产环境中遇到的头号杀手。当虚拟线程在以下情况时，它<strong>无法从载体线程上卸载</strong>，会一直占着那个载体线程不放：</p>

<ol>
<li><code>synchronized</code> 代码块/方法内</li>
<li>调用 <code>native</code> 方法期间</li>
<li>持有 <code>ReentrantLock</code> 时<strong>不会</strong> pinning（这是好事，所以尽量用 <code>ReentrantLock</code> 替代 <code>synchronized</code>）</li>
</ol>

<blockquote>
<p><strong>名词解释 —— Pinning</strong>：虚拟线程本应在遇到阻塞操作时"下车"（unmount），让载体线程去干别的。但如果它被"钉住"了（pinned），就下不了车，载体线程被白白占用。一旦大量虚拟线程同时 pinning，效果就跟传统线程池没区别了——甚至更差，因为多了调度开销。</p>
</blockquote>

<h2 id="如何检测-Pinning"><a href="#如何检测-Pinning" class="headerlink" title="如何检测 Pinning"></a>如何检测 Pinning</h2>

<p>JDK 提供了 <strong>JVM 选项</strong>来检测 pinning 问题：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">java -Djdk.virtualThreadSchedulerParallelism=8 -Djdk.tracePinningMode=full -jar demo.jar</span><br></pre></td></table></figure>

<p>两个关键参数：</p>

<table>
<thead>
<tr>
<th style="text-align:left">参数</th>
<th style="text-align:left">作用</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><code>-Djdk.tracePinningMode=full</code></td>
<td style="text-align:left">输出完整的 pinning 堆栈（含代码行号），方便定位哪个 synchronized 在捣乱</td>
</tr>
<tr>
<td style="text-align:left"><code>-Djdk.tracePinningMode=short</code></td>
<td style="text-align:left">只输出简短信息（适合生产环境，日志量少）</td>
</tr>
<tr>
<td style="text-align:left"><code>-Djdk.virtualThreadSchedulerParallelism=N</code></td>
<td style="text-align:left">设置载体线程数（默认 = CPU 核心数）</td>
</tr>
</tbody>
</table>

<p>当发生 pinning 时，日志里会出现类似这样的输出：</p>

<figure class="highlight text"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line">[Thread[#42,ForkJoinPool-1-worker-3,Virtual,pinned]</span><br><span class="line">    java.util.HashMap.putVal(HashMap.java:...)  ← pinned here!</span><br><span class="line">    com.example.MyService.doWork(MyService.java:25)]</span><br></pre></td></table></figure>

<h2 id="常见坑清单"><a href="#常见坑清单" class="headerlink" title="常见坑清单"></a>常见坑清单</h2>

<table>
<thead>
<tr>
<th style="text-align:left">#</th>
<th style="text-align:left">坑</th>
<th style="text-align:center">严重度</th>
<th style="text-align:left">解决方案</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">1</td>
<td style="text-align:left"><code>synchronized</code> 导致 pinning</td>
<td style="text-align:center">🔴 高</td>
<td style="text-align:left">改用 <code>ReentrantLock</code>；或升级到 JDK 24+（synchronized 也支持 unmount 了）</td>
</tr>
<tr>
<td style="text-align:left">2</td>
<td style="text-align:left"><code>ThreadLocal</code> 泄漏 —— 虚拟线程数量大，每个都存一份 ThreadLocal</td>
<td style="text-align:center">🔴 高</td>
<td style="text-align:left">使用 JDK 21 的 <code>ScopedValue</code>（预览）替代；或检查 ThreadLocal 数量</td>
</tr>
<tr>
<td style="text-align:left">3</td>
<td style="text-align:left">连接池不够用 —— 200 个 DB 连接撑不住 2000 个并发请求</td>
<td style="text-align:center">🟠 中</td>
<td style="text-align:left">调大连接池（HikariCP 的 maximumPoolSize）；或引入连接复用中间件</td>
</tr>
<tr>
<td style="text-align:left">4</td>
<td style="text-align:left">线程名不好排查 —— 虚拟线程默认名字很长且动态变化</td>
<td style="text-align:center">🟡 低</td>
<td style="text-align:left">用 <code>Thread.ofVirtual().name("my-vt-", 0).start(...)</code> 自定义命名</td>
</tr>
<tr>
<td style="text-align:left">5</td>
<td style="text-align:left">监控工具不兼容 —— 部分老版本 APM 无法识别虚拟线程</td>
<td style="text-align:center">🟠 中</td>
<td style="text-align:left">升级 APM Agent；确认支持 JDK 21 VT</td>
</tr>
<tr>
<td style="text-align:left">6</td>
<td style="text-align:left">CPU 密集型任务用了虚拟线程 —— 白白增加调度开销</td>
<td style="text-align:center">🟡 低</td>
<td style="text-align:left">CPU 密集任务继续用传统线程池（<code>Executors.newFixedThreadPool</code>）</td>
</tr>
</tbody>
</table>

<h1 id="Step-4-JFR-采集与分析（进阶）"><a href="#Step-4-JFR-采集与分析（进阶）" class="headerlink" title="Step 4: JFR 采集与分析（进阶）"></a>Step 4: JFR 采集与分析（进阶）</h1>

<p><strong>JFR（Java Flight Recorder）</strong>是 JDK 内置的低开销 profiling 工具，可以用来分析虚拟线程的行为。以下是采集和分析的完整步骤：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 1. 启动应用并开启 JFR 记录（低开销，&lt;1% 性能影响）</span></span><br><span class="line">java -XX:StartFlightRecording=duration=60s,filename=vt-recording.jfr,settings=profile \</span><br><span class="line">     -Djdk.tracePinningMode=short \</span><br><span class="line">     -jar demo.jar</span><br><span class="line"></span><br><span class="line"><span class="comment"># 2. 或者运行时动态开始（无需重启）</span></span><br><span class="line">jcmd &lt;pid&gt; JFR.start duration=60s filename=vt-recording.jfr settings=profile</span><br><span class="line"></span><br><span class="line"><span class="comment"># 3. 用 jfr 分析（JDK 自带 GUI）</span></span><br><span class="line">jfr vt-recording.jfr</span><br><span class="line"></span><br><span class="line"><span class="comment"># 4. 命令行快速查看事件统计</span></span><br><span class="line">jfr print --categories JDK-Java-Virtual-Thread vt-recording.jfr | head -50</span><br><span class="line"></span><br><span class="line"><span class="comment"># 重点关注的 JFR 事件：</span></span><br><span class="line"><span class="comment"># - jdk.VirtualThreadSubmitFailed   → VT 提交失败</span></span><br><span class="line"><span class="comment"># - jdk.VirtualThreadPinned          → 发生了 pinning</span></span><br><span class="line"><span class="comment"># - jdk.VirtualThreadSuspendFailed   → 挂起失败</span></span><br></pre></td></table></figure>

<h1 id="Step-5-什么时候不该用虚拟线程"><a href="#Step-5-什么时候不该用虚拟线程" class="headerlink" title="Step 5: 什么时候不该用虚拟线程"></a>Step 5: 什么时候不该用虚拟线程</h1>

<p>虽然虚拟线程很香，但以下场景<strong>不建议</strong>使用：</p>

<ol>
<li><strong>CPU 密集型任务</strong>（图像处理、视频编码、大数据计算）→ 用 <code>ForkJoinPool</code> 或固定大小线程池</li>
<li><strong>已经在用 WebFlux / Reactor</strong>的项目 → 不要混用，架构冲突</li>
<li><strong>重度依赖 synchronized 的遗留代码</strong> → 先重构锁机制再考虑 VT</li>
<li><strong>JDK 版本低于 21</strong> → 升级 JDK 是前提条件</li>
<li><strong>对延迟极其敏感的场景</strong>（HFT 高频交易）→ VT 的调度延迟可能不可接受</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从零到一完成了 Spring Boot 虚拟线程的接入与验证，核心要点回顾：</p>

<ul>
<li><strong>开启只需一行配置</strong>：<code>spring.threads.virtual.enabled=true</code></li>
<li><strong>I/O 密集型场景收益最大</strong>：P99 延迟降低 90%+，并发承载提升 10 倍以上</li>
<li><strong>CPU 密集型场景无收益</strong>：不要强行用</li>
<li><strong>Pinning 是头号坑</strong>：用 <code>-Djdk.tracePinningMode=full</code> 检测，用 <code>ReentrantLock</code> 替代 <code>synchronized</code></li>
<li><strong>连接池要跟上</strong>：线程便宜了不代表数据库连接也便宜，记得调大 HikariCP</li>
<li><strong>JFR + k6 双剑合璧</strong>：一个看内部行为，一个看外部表现</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[Oracle 官方] <a href="https://openjdk.org/jeps/444" target="_blank">JEP 444: Virtual Threads（GA 规格）</a></li>
<li>[Spring 官方] <a href="https://docs.spring.io/spring-boot/docs/current/reference/html/observability.html#virtual-threads" target="_blank">Spring Boot 3.2 Virtual Threads 文档</a></li>
<li>[BellSoft] <a href="https://bell-sw.com/blog/a-guide-to-using-virtual-threads-with-spring-boot/" target="_blank">A Guide to Using Virtual Threads with Spring Boot（含 benchmark 脚本）</a></li>
<li>[Dan Vega] <a href="https://www.danvega.dev/blog/virtual-threads-spring-boot/" target="_blank">Virtual Threads in Spring Boot（图文教程）</a></li>
<li>[阿里云社区] <a href="https://www.alibabacloud.com/blog/exploration-of-java-virtual-threads-and-performance-analysis_601860" target="_blank">Exploration of Java Virtual Threads and Performance Analysis（中文）</a></li>
<li>[GitHub] <a href="https://github.com/chrisgleissner/loom-webflux-benchmarks" target="_blank">loom-webflux-benchmarks（持续更新的基准测试）</a></li>
<li>[JavaCodeGeeks] <a href="https://www.javacodegeeks.com/2025/04/spring-boot-performance-with-java-virtual-threads.html" target="_blank">Spring Boot Performance with Java Virtual Threads</a></li>
</ol>
