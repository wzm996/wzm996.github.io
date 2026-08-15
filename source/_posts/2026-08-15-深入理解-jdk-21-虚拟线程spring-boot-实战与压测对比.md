---
title: 深入理解 JDK 21 虚拟线程——Spring Boot 实战与压测对比
date: 2026-08-15 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java 21
  - Virtual Threads
  - Spring Boot
  - Project Loom
  - 压测
  - JFR
---
<hr>
<blockquote><p>虚拟线程（Virtual Threads）是 JDK 21 正式发布的里程碑式特性，它用极低的创建成本和 M:N 调度模型解决了传统平台线程在高并发 I/O 场景下的扩展瓶颈。本文从原理出发，通过 Spring Boot 3.2+ 的真实压测数据，对比虚拟线程与传统 Tomcat 线程池的吞吐与延迟差异，并给出生产落地的避坑指南。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>写过一个 Spring Boot 服务的人都知道这个经典配置：</p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span></span><br><span class="line">  <span class="attr">tomcat:</span></span><br><span class="line">    <span class="attr">threads:</span></span><br><span class="line">      <span class="attr">max:</span> <span class="string">200</span></span><br></pre></td></table></figure>

<p>200 这个数字不是拍脑袋来的——一个传统 <strong>平台线程</strong>（Platform Thread）默认栈大小约 1MB，200 个线程光栈就要吃掉 ~200MB 内存，再加上 OS 线程调度的上下文切换开销，一台 4C8G 的机器撑死也就跑几百到上千个线程。</p>

<p>但现实是：<strong>绝大多数 Web 请求都是 I/O 密集型的</strong>——查数据库、调远程接口、读写缓存、等下游响应。请求处理过程中 80%~95% 的时间线程都在"干等"，真正用 CPU 的时间很少。这就是所谓的<strong>一线程一请求（Thread-per-Request）模型</strong>的浪费之处：昂贵的平台线程被廉价地阻塞在 I/O 等待上。</p>

<p>过去我们用线程池来缓解这个问题，但线程池只是控制了线程数量上限，并没有改变"线程阻塞 = 资源浪费"的本质。当并发量上来之后，线程池满了，新请求只能排队，吞吐量直接卡住。</p>

<p><strong>虚拟线程</strong>（Virtual Threads，代号 Project Loom）就是为了解决这个问题而生的。它的核心思路很简单：</p>
<ul>
<li>虚拟线程是 JVM 层面的轻量级线程，不绑定 OS 线程</li>
<li>遇到阻塞操作时，自动把虚拟线程从载体线程上"卸载"，让出载体线程给其他虚拟线程用</li>
<li>阻塞结束后再"重新装载"回来继续执行</li>
<li>创建成本极低（栈按需分配，初始仅几十 KB），可以轻松创建数十万甚至上百万个</li>
</ul>

<h1 id="核心概念速览"><a href="#核心概念速览" class="headerlink" title="核心概念速览"></a>核心概念速览</h1>

<table>
<thead>
<tr>
<th style="text-align:center">术语</th>
<th style="text-align:left">解释</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center"><strong>平台线程</strong>（Platform Thread）</td>
<td style="text-align:left">传统的 java.lang.Thread 实例，底层 1:1 映射到一个 OS 内核线程。创建成本高、数量受限于操作系统。</td>
</tr>
<tr>
<td style="text-align:center"><strong>虚拟线程</strong>（Virtual Thread）</td>
<td style="text-align:left">JDK 21 新增的轻量级线程实现，由 JVM 调度，不独占 OS 线程。是 java.lang.Thread 的一种子类型。</td>
</tr>
<tr>
<td style="text-align:center"><strong>载体线程</strong>（Carrier Thread）</td>
<td style="text-align:left">实际执行虚拟线程代码的平台线程。JDK 默认使用 ForkJoinPool 作为载体线程池。</td>
</tr>
<tr>
<td style="text-align:center"><strong>Pinning（钉住）</strong></td>
<td style="text-align:left">当虚拟线程在 synchronized 块或 JNI 调用时无法卸载，会一直占住载体线程，这是虚拟线程性能的主要杀手。</td>
</tr>
<tr>
<td style="text-align:center"><strong>M:N 调度</strong></td>
<td style="text-align:left">M 个虚拟线程映射到 N 个平台线程（N 通常等于 CPU 核心数），由 JVM 在用户态完成调度。</td>
</tr>
</tbody>
</table>

<h2 id="虚拟线程-vs-平台线程核心对比"><a href="#虚拟线程-vs-平台线程核心对比" class="headerlink" title="虚拟线程 vs 平台线程核心对比"></a>虚拟线程 vs 平台线程核心对比</h2>

<table>
<thead>
<tr>
<th style="text-align:center">维度</th>
<th style="text-align:center">平台线程</th>
<th style="text-align:center">虚拟线程</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">调度模型</td>
<td style="text-align:center">1:1（OS 内核调度）</td>
<td style="text-align:center">M:N（JVM 用户态调度）</td>
</tr>
<tr>
<td style="text-align:center">创建成本</td>
<td style="text-align:center">高（~1MB 栈空间）</td>
<td style="text-align:center">极低（栈按需分配，~几KB 起）</td>
</tr>
<tr>
<td style="text-align:center">并发上限</td>
<td style="text-align:center">数百 ~ 数千</td>
<td style="text-align:center">数万 ~ 百万级</td>
</tr>
<tr>
<td style="text-align:center">阻塞行为</td>
<td style="text-align:center">阻塞 = 占住 OS 线程</td>
<td style="text-align:center">阻塞 = 卸载，释放载体线程</td>
</tr>
<tr>
<td style="text-align:center">适用场景</td>
<td style="text-align:center">CPU 密集型计算</td>
<td style="text-align:center">I/O 密集型（网络/DB/文件）</td>
</tr>
</tbody>
</table>

<h1 id="Spring-Boot-中开启虚拟线程"><a href="#Spring-Boot-中开启虚拟线程" class="headerlink" title="Spring Boot 中开启虚拟线程"></a>Spring Boot 中开启虚拟线程</h1>

<h2 id="前提条件"><a href="#前提条件" class="headerlink" title="前提条件"></a>前提条件</h2>

<ul>
<li>JDK 21+（推荐 LTS 版本 21 或 23）</li>
<li>Spring Boot 3.2+（3.2 开始原生支持虚拟线程配置）</li>
</ul>

<h2 id="开启方式"><a href="#开启方式" class="headerlink" title="开启方式"></a>开启方式</h2>

<p>只需要一行配置，就这么简单：</p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>

<p>加上这一行后，Spring Boot 会自动将内嵌 Tomcat（或 Jetty/Undertow）的线程池替换为虚拟线程执行器。你的 Controller 方法、@Async 任务、WebFilter 等，都会运行在虚拟线程之上。</p>

<blockquote>
<p><strong>注：</strong>开启虚拟线程后，server.tomcat.threads.max 配置不再生效（因为不再使用 Tomcat 线程池）。如果同时配置了 spring.task.execution.pool 或自定义 ThreadPoolTaskExecutor，需要特别注意——这些自定义线程池不会自动变成虚拟线程，需要显式替换为 Executors.newVirtualThreadPerTaskExecutor()。</p>
</blockquote>

<h2 id="验证虚拟线程是否生效"><a href="#验证虚拟线程是否生效" class="headerlink" title="验证虚拟线程是否生效"></a>验证虚拟线程是否生效</h2>

<p>写一个最简单的接口来验证：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping(&quot;/api&quot;)</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">DemoController</span> {</span><br><span class="line">    <span class="meta">@GetMapping(&quot;/hello&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">hello</span><span class="params">()</span> {</span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;当前线程: &quot;</span> + Thread.currentThread();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>访问后看到类似输出就说明虚拟线程已生效：</p>
<figure class="highlight text"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">当前线程: VirtualThread[#...]/runnable @ForkJoinPool.commonPool-worker-x</span><br></pre></td></table></figure>

<p>关键标志：<code>VirtualThread[...</code> 前缀。如果是传统模式，你会看到 <code>http-nio-8080-exec-x</code> 这种 Tomcat 线程名。</p>

<h1 id="实战：搭建压测环境"><a href="#实战：搭建压测环境" class="headerlink" title="实战：搭建压测环境"></a>实战：搭建压测环境</h1>

<h2 id="测试场景设计"><a href="#测试场景设计" class="headerlink" title="测试场景设计"></a>测试场景设计</h2>

<p>为了公平对比，我们需要模拟真实的 I/O 阻塞场景。设计两个接口：</p>

<p><strong>接口 A：纯 I/O 阻塞</strong>（模拟查数据库/调 RPC）</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@GetMapping(&quot;/io-blocking&quot;)</span></span><br><span class="line"><span class="keyword">public</span> String <span class="title function_">ioBlocking</span><span class="params">(<span class="meta">@RequestParam(defaultValue = &quot;50&quot;)</span> <span class="type">int</span> ms)</span></span><br><span class="line">        <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">    Thread.sleep(ms); <span class="comment">// 模拟 50ms 的 I/O 等待（DB/RPC）</span></span><br><span class="line">    <span class="keyword">return</span> <span class="string">&quot;OK (blocked &quot;</span> + ms + <span class="string">&quot;ms)&quot;</span>;</span><br><span class="line">}</span><br></pre></td></table></figure>

<p><strong>接口 B：混合 CPU + I/O</strong>（更贴近真实业务）</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@GetMapping(&quot;/mixed-workload&quot;)</span></span><br><span class="line"><span class="keyword">public</span> String <span class="title function_">mixedWorkload</span><span class="params">(<span class="meta">@RequestParam(defaultValue = &quot;30&quot;)</span> <span class="type">int</span> ioMs,</span></span><br><span class="line">                              <span class="meta">@RequestParam(defaultValue = &quot;5&quot;)</span> <span class="type">int</span> cpuMs)</span></span><br><span class="line">        <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">    <span class="comment">// 模拟少量 CPU 计算（JSON 序列化/业务逻辑）</span></span><br><span class="line">    <span class="type">long</span> start = System.nanoTime();</span><br><span class="line">    <span class="keyword">while</span> ((System.nanoTime() - start) < cpuMs * 1_000_000L) {</span><br><span class="line">        <span class="comment">// busy-wait 模拟 CPU 计算</span></span><br><span class="line">    }</span><br><span class="line">    Thread.sleep(ioMs); <span class="comment">// 模拟 I/O 等待</span></span><br><span class="line">    <span class="keyword">return</span> <span class="string">&quot;OK (cpu=&quot;</span> + cpuMs + <span class="string">&quot;ms, io=&quot;</span> + ioMs + <span class="string">&quot;ms)&quot;</span>;</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="压测工具与参数"><a href="#压测工具与参数" class="headerlink" title="压测工具与参数"></a>压测工具与参数</h2>

<p>使用 <strong>k6</strong> 或 <strong>Apache Bench (ab)</strong> 进行压测。这里以 k6 为例（支持更丰富的指标）： </p>
<figure class="highlight javascript"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> http <span class="keyword">from</span> <span class="string">'k6/http'</span>;</span><br><span class="line"><span class="keyword">import</span> { check } <span class="keyword">from</span> <span class="string">'k6'</span>;</span><br><span class="line"><span class="keyword">import</span> { Trend } <span class="keyword">from</span> <span class="string">'k6/metrics'</span>;</span><br><span class="line"></span><br><span class="line"><span class="comment">// 自定义趋势指标，用于记录响应时间分布</span></span><br><span class="line"><span class="keyword">const</span> rtTrend = <span class="keyword">new</span> <span class="title class_">Trend</span>(<span class="string">'response_time_trend'</span>);</span><br><span class="line"></span><br><span class="keyword">export</span> <span class="keyword">const</span> options = {</span><br><span class="line">  <span class="comment">// 阶梯式加压：逐步增加并发数</span></span><br><span class="line">  <span class="attr">stages</span>: [</span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'10s'</span>, <span class="attr">target</span>: <span class="number">100</span>   },  <span class="comment">// 预热</span></span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'20s'</span>, <span class="attr">target</span>: <span class="number">500</span>   },  <span class="comment">// 加压</span></span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'20s'</span>, <span class="attr">target</span>: <span class="number">1000</span>  },  <span class="comment">// 高负载</span></span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'20s'</span>, <span class="attr">target</span>: <span class="number">2000</span>  },  <span class="comment">// 极限压力</span></span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'10s'</span>, <span class="attr">target</span>: <span class="number">0</span>     },  <span class="comment">// 恢复</span></span><br><span class="line">  ],</span><br><span class="line">  <span class="attr">thresholds</span>: {</span><br><span class="line">    <span class="comment">// P99 响应时间不超过 500ms</span></span><br><span class="line">    <span class="attr">http_req_duration</span>: [<span class="string">'p(99)&lt;500'</span>],</span><br><span class="line">  },</span><br><span class="line">};</span><br><span class="line"></span><br><span class="keyword">export</span> <span class="keyword">default</span> <span class="keyword">function</span> (<span class="params"></span>) {</span><br><span class="line">  <span class="keyword">const</span> res = http.<span class="title function_">get</span>(</span><br><span class="line">    __ENV.URL || <span class="string">'http://localhost:8080/api/io-blocking?ms=50'</span></span><br><span class="line">  );</span><br><span class="line">  rtTrend.<span class="title function_">add</span>(res.<span class="property">timings</span>.<span class="property">waiting</span> + res.<span class="property">timings</span>.<span class="property">receiving</span>);</span><br><span class="line">  <span class="title function_">check</span>(res, {</span><br><span class="line">    <span class="attr">status is 200</span>: (r) =&gt; r.<span class="property">status</span> === <span class="number">200</span>,</span><br><span class="line">  });</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>运行命令：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">k6 run --out json=results.json script.js</span><br></pre></td></table></figure>

<h2 id="压测结果对比"><a href="#压测结果对比" class="headerlink" title="压测结果对比"></a>压测结果对比</h2>

<p>以下数据来自社区公开压测报告（Spring Boot 3.4 + JDK 21 + 4C8G 环境），以及得物技术团队和 Baeldung 的实测数据综合整理。<strong>测试接口为 /io-blocking?ms=50（50ms I/O 阻塞）</strong>：</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">传统线程池（max=200）</th>
<th style="text-align:center">传统线程池（max=500）</th>
<th style="text-align:center">虚拟线程（默认）</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">并发 100 时 QPS</td>
<td style="text-align:center">~1,900</td>
<td style="text-align:center">~1,950</td>
<td style="text-align:center">~1,980</td>
</tr>
<tr>
<td style="text-align:center">并发 500 时 QPS</td>
<td style="text-align:center">~2,000（饱和）</td>
<td style="text-align:center">~4,800</td>
<td style="text-align:center">~5,200</td>
</tr>
<tr>
<td style="text-align:center">并发 1000 时 QPS</td>
<td style="text-align:center">~2,000（排队）</td>
<td style="text-align:center">~5,000</td>
<td style="text-align:center">~8,500</td>
</tr>
<tr>
<td style="text-align:center">并发 2000 时 QPS</td>
<td style="text-align:center">~1,800（退化）</td>
<td style="text-align:center">~4,800</td>
<td style="text-align:center">~11,000</td>
</tr>
<tr>
<td style="text-align:center">P50 延迟（1000 并发）</td>
<td style="text-align:center">~450ms</td>
<td style="text-align:center">~98ms</td>
<td style="text-align:center">~52ms</td>
</tr>
<tr>
<td style="text-align:center">P99 延迟（1000 并发）</td>
<td style="text-align:center">&gt;2000ms</td>
<td style="text-align:center">~380ms</td>
<td style="text-align:center">~120ms</td>
</tr>
<tr>
<td style="text-align:center">内存占用（峰值）</td>
<td style="text-align:center">~350MB</td>
<td style="text-align:center">~650MB</td>
<td style="text-align:center">~380MB</td>
</tr>
</tbody>
</figure></table>

<blockquote>
<p><strong>注：</strong>以上数据为多来源综合近似值，实际数值因机器配置/JVM 参数/OS 调优而异。关键结论方向一致：<strong>I/O 密集场景下，虚拟线程在高并发时的吞吐优势显著，且内存占用并不比 200 线程池高多少</strong>。但低并发（&lt;= 线程池容量）时差距不大，甚至可能因为调度开销略慢几个毫秒。</p>
</blockquote>

<h3 id="数据解读"><a href="#数据解读" class="headerlink" title="数据解读"></a>数据解读</h3>

<ol>
<li><strong>QPS 翻倍甚至更高</strong>：传统 200 线程池在 50ms I/O 下理论极限 QPS ≈ 200 / 0.05s = 4,000，但实际只有 ~2,000（线程调度/GC/上下文切换开销）。虚拟线程突破了线程数量限制，QPS 随并发线性增长直到打满 CPU 或带宽。</li>
<li><strong>P99 延迟大幅下降</strong>：传统模式下线程池满后请求排队等待，尾延迟急剧恶化；虚拟线程几乎不排队，P99 保持稳定。</li>
<li><strong>内存没有爆炸</strong>：虽然创建了数万个虚拟线程，但它们的栈是按需分配的（ Continuation 栈通常几十 KB），总内存反而可控。</li>
</ol>

<h1 id="使用-JFR-观测虚拟线程行为"><a href="#使用-JFR-观测虚拟线程行为" class="headerlink" title="使用 JFR 观测虚拟线程行为"></a>使用 JFR 观测虚拟线程行为</h1>

<p><strong>JFR</strong>（Java Flight Recorder）是 JDK 自带的开销极低的飞行记录器。JDK 21 为虚拟线程新增了专门的 JFR 事件，可以用来诊断 Pinning 和调度问题。</p>

<h2 id="启动-JFR-录制"><a href="#启动-JFR-录制" class="headerlink" title="启动 JFR 录制"></a>启动 JFR 录制</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 方式一：启动应用时直接开启 JFR</span></span><br><span class="line">java -XX:StartFlightRecording=<span class="built_in">filename</span>=virtual-threads.jfr,duration=60s \</span><br><span class="line">     -jar your-app.jar</span><br><span class="line"></span><br><span class="line"># 方式二：对正在运行的进程使用 jcmd 开启录制</span></span><br><span class="line">jcmd &lt;pid&gt; JFR.start <span class="built_in">name</span>=vt-test duration=60s filename=vt.jfr settings=profile</span><br></pre></td></table></figure>

<h2 id="分析虚拟线程相关事件"><a href="#分析虚拟线程相关事件" class="headerlink" title="分析虚拟线程相关事件"></a>分析虚拟线程相关事件</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 打印虚拟线程专用事件</span></span><br><span class="line">jfr print --events \</span><br><span class="line">  jdk.VirtualThreadStart,jdk.VirtualThreadEnd,\</span><br><span class="line">  jdk.VirtualThreadPinned,jdk.VirtualThreadSubmitFailed \</span><br><span class="line">  vt.jfr</span><br></pre></td></table></figure>

<p>重点关注 <strong>jdk.VirtualThreadPinned</strong> 事件：</p>
<ul>
<li>该事件表示虚拟线程在执行阻塞操作时<strong>无法卸载</strong>（被"钉"在了载体线程上）</li>
<li>常见原因：<code>synchronized</code> 块/方法、JNI 调用、部分 native 方法</li>
<li>默认只在 Pinning 持续超过 20ms 时才触发事件（避免噪音）</li>
</ul>

<h2 id="导出线程转储（Thread-Dump）"><a href="#导出线程转储（Thread-Dump）" class="headerlink" title="导出线程转储（Thread Dump）"></a>导出线程转储（Thread Dump）</h2>

<p>当应用有数万甚至数十万虚拟线程时，传统的 <code>jstack</code> 输出会爆炸。JDK 21 提供了新的线程转储格式：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># JSON 格式（推荐，方便后续分析）</span></span><br><span class="line">jcmd &lt;pid&gt; Thread.dump_to_file -format=json thread-dump.json</span><br><span class="line"></span><br><span class="line"># 文本格式（简洁版，分组显示）</span></span><br><span class="line">jcmd &lt;pid&gt; Thread.print</span><br></pre></td></table></figure>

<h1 id="生产落地避坑指南"><a href="#生产落地避坑指南" class="headerlink" title="生产落地避坑指南"></a>生产落地避坑指南</h1>

<h2 id="坑-1：synchronized-导致-Pinning"><a href="#坑-1：synchronized-导致-Pinning" class="headerlink" title="坑 1：synchronized 导致 Pinning"></a>坑 1：synchronized 导致 Pinning</h2>

<p>这是目前虚拟线程在生产环境中<strong>最大的坑</strong>，没有之一。</p>

<p>当虚拟线程进入 <code>synchronized</code> 块或方法时，它会被"钉"在当前载体线程上，无法卸载。如果此时发生阻塞（比如在 synchronized 里调用了 Thread.sleep() 或数据库操作），载体线程就会被一直占用，退化为传统线程的行为。</p>

<p><strong>解决方案</strong>：</p>
<ul>
<li>将 <code>synchronized</code> 替换为 <code>ReentrantLock</code>（ReentrantLock 支持虚拟线程卸载）</li>
<li>使用 <strong>-Djdk.tracePinningThreads=</strong> 来排查哪些代码触发了 Pinning</li>
</ul>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">java -Djdk.tracePinningThreads=full -jar your-app.jar</span><br></pre></td></table></figure>

<p>开启后，控制台会在 Pinning 发生时打印完整的堆栈跟踪，精确定位问题代码位置。</p>

<h2 id="坑-2：ThreadLocal-内存膨胀"><a href="#坑-2：ThreadLocal-内存膨胀" class="headerlink" title="坑 2：ThreadLocal 内存膨胀"></a>坑 2：ThreadLocal 内存膨胀</h2>

<p>虚拟线程的数量可能是传统线程的 100 倍甚至更多。如果你的代码里大量使用 <code>ThreadLocal</code>（比如 Spring 的事务管理、SecurityContext、RequestContextHolder 等），每个虚拟线程都会持有自己的一份 ThreadLocal 副本。</p>

<p><strong>风险</strong>：10 万个虚拟线程 × 每个 ThreadLocal 存几 KB 对象 = 数百 MB 甚至 GB 级别的额外内存。</p>

<p><strong>解决方案</strong>：</p>
<ul>
<li>审查项目中自定义的 ThreadLocal 使用，尽量减少或改用其他传递机制</li>
<li>Spring 6.1+ 已经对 ScopedValue（JDK 21 预览特性）做了适配准备，未来可替代部分 ThreadLocal 场景</li>
<li>监控虚拟线程数量与堆内存的相关性</li>
</ul>

<h2 id="坑-3：线程池配额失效"><a href="#坑-3：线程池配额失效" class="headerlink" title="坑 3：线程池配额失效"></a>坑 3：线程池配额失效</h2>

<p>开启虚拟线程后，你不能再依赖线程池大小来做<strong>限流</strong>。以前 200 线程池天然限制了最大并发请求数；现在虚拟线程几乎无限，如果下游服务（数据库、第三方 API）没有做好限流，你可能瞬间把下游打挂。</p>

<p><strong>解决方案</strong>：</p>
<ul>
<li>使用 Sentinel / Resilience4j 等限流熔断框架做应用层限流</li>
<li>确保所有外部依赖都有合理的超时和连接池限制</li>
<li>不要移除数据库连接池（HikariCP 等）——连接数仍然是有限资源</li>
</ul>

<h2 id="坑-4：CPU-密集型任务更慢"><a href="#坑-4：CPU-密集型任务更慢" class="headerlink" title="坑 4：CPU 密集型任务更慢"></a>坑 4：CPU 密集型任务更慢</h2>

<p>虚拟线程的优势在于 I/O 阻塞时让出载体线程。对于纯 CPU 计算密集型任务（图像处理、加密解密、复杂算法），虚拟线程不仅没优势，还会因为额外的调度开销略慢于平台线程。</p>

<p><strong>原则</strong>：CPU 密集型任务继续用传统线程池（ThreadPoolTaskExecutor），不要放到虚拟线程上跑。</p>

<h2 id="坑-5：旧库兼容性问题"><a href="#坑-5：旧库兼容性问题" class="headerlink" title="坑 5：旧库兼容性问题"></a>坑 5：旧库兼容性问题</h2>

<p>一些老旧的第三方库可能在内部使用了：</p>
<ul>
<li><code>Thread.currentThread().setName()</code>（虚拟线程不支持 setName）</li>
<li>重写了 <code>ThreadGroup</code> 相关逻辑</li>
<li>依赖线程 ID 的唯一性和顺序</li>
</ul>

<p>升级前务必做全量回归测试，特别关注日志框架、监控 SDK、安全框架等基础设施组件。</p>

<h1 id="如何验证你的应用是否适合虚拟线程"><a href="#如何验证你的应用是否适合虚拟线程" class="headerlink" title="如何应用是否适合虚拟线程"></a>如何验证你的应用是否适合虚拟线程</h1>

<p>不要盲目开虚拟线程！按以下步骤评估：</p>

<ol>
<li>
<p><strong>判断请求特征</strong>：用 Arthas 或 async-profiler 统计一次典型请求的时间分布。如果 I/O 等待占比 &gt; 70%，虚拟线程大概率有收益。</p>
</li>
<li>
<p><strong>灰度开启</strong>：先在测试环境完整压测一遍，关注：
   - QPS 变化
   - P99/P95 延迟变化
   - GC 频率和暂停时间
   - 内存使用曲线</p>
</li>
<li>
<p><strong>Pinning 排查</strong>：加 <code>-Djdk.tracePinningThreads=full</code> 运行一段时间，确认没有严重的 Pinning 问题。</p>
</li>
<li>
<p><strong>小流量上线</strong>：生产环境先开 5% → 25% → 50% → 100% 逐步放量，每步观察至少 24 小时。</p>
</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发模型的一次重大升级，但它不是银弹。核心要点：</p>

<ul>
<li><strong>适用场景</strong>：I/O 密集型 Web 服务（数据库查询、RPC 调用、文件读写占比高的业务）</li>
<li><strong>性能提升</strong>：高并发下 QPS 可提升 2~5 倍，P99 延迟降低 60%~80%</li>
<li><strong>最大风险</strong>：synchronized 导致的 Pinning（可用 ReentrantLock 替代）</li>
<li><strong>内存注意</strong>：ThreadLocal 在海量虚拟线程下可能导致内存膨胀</li>
<li><strong>限流变局</strong>：不能再用线程池大小做限流了，必须引入独立的限流机制</li>
<li><strong>不适用的场景</strong>：CPU 密集型任务、已经用异步非阻塞（如 WebFlux）充分优化的系统</li>
</ul>

<p>对于大多数基于 Spring Boot 编写的传统同步阻塞式 Web 应用来说，虚拟线程是一次<strong>"改动最小、收益最大"</strong>的性能升级——只需要加一行配置。但上线前一定要做好压测和 Pinning 排查，否则可能会踩到意想不到的坑。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[Oracle 官方文档] <a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html" target="_blank">Virtual Threads（JDK 21 Documentation）</a> — 虚拟线程权威参考，含 JFR 事件说明与 Pinning 详解</li>
<li>[JavaGuide] <a href="https://javaguide.cn/java/concurrent/virtual-thread.html" target="_blank">虚拟线程常见问题总结</a> — 中文生态最全面的 FAQ，覆盖原理/配置/排障</li>
<li>[得物技术] <a href="https://tech.dewu.com/article?id=89" target="_blank">虚拟线程原理及性能分析</a> — 包含详细的 M:N 调度原理图解与内部实现分析</li>
<li>[廖雪峰教程] <a href="https://liaoxuefeng.com/books/java/threading/virtual-thread/index.html" target="_blank">使用虚拟线程</a> — 入门友好，示例丰富，适合快速上手</li>
<li>[Baeldung] <a href="https://www.baeldung.com/spring-6-virtual-threads" target="_blank">Working with Virtual Threads in Spring</a> — Spring Boot 集成虚拟线程的详细步骤与注意事项</li>
<li>[Marc Nuri] <a href="https://blog.marcnuri.com/java-virtual-threads-project-loom-complete-guide" target="_blank">Java Virtual Threads Complete Guide (Project Loom)</a> — 英文社区最全面的实践指南，持续更新至 2026</li>
<li>[Azul] <a href="https://www.azul.com/zh-hans/blog/how-do-virtual-threads-help-your-business" target="_blank">虚拟线程如何为您的业务提供帮助？</a> — Azul CTO 从商业价值角度解读虚拟线程的意义</li>
</ol>
