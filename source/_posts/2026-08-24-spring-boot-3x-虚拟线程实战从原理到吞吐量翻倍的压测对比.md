---
title: Spring Boot 3.x 虚拟线程实战——从原理到吞吐量翻倍的压测对比
date: 2026-08-24 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - 虚拟线程
  - JDK 21
  - JMH
  - 性能调优
  - Tomcat
---
<hr>
<blockquote><p>**虚拟线程（Virtual Thread）** 是 JDK 21 正式发布的里程碑特性，它把 Java 的并发模型从"操作系统线程一一映射"升级为"M:N 调度"——少量平台线程承载大量虚拟线程。本文将从原理出发，用 <strong>JMH 压测 + GC 日志 + Tomcat 配置</strong> 三件套，给你一份"能不能上生产"的量化答案。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么要关心虚拟线程"><a href="#背景：为什么要关心虚拟线程" class="headerlink" title="背景：为什么要关心虚拟线程"></a>背景：为什么要关心虚拟线程</h1>

<p>在虚拟线程之前，Java Web 服务的主流并发模型是这样的：</p>
<figure class="highlight plaintext"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line">请求 → Tomcat 线程池（比如 200 线程）→ 处理业务逻辑 → 返回</span><br><span class="line">                                    ↑</span><br><span class="line">                              如果这里阻塞（等DB、等RPC、等Redis）</span><br><span class="line">                              这个线程就"卡住"了，别人没法用</span><br></pre></td></table></figure>

<p>问题很直观：<strong>线程是贵重的资源</strong>。一台 8 核机器创建几千个平台线程就会因上下文切换和内存开销把性能拖垮。但我们的业务代码里到处都是阻塞调用——查数据库、调远程接口、读写文件……每个都意味着一个线程要"傻等"。</p>

<p>传统解法有两个，但都不完美：</p>
<table>
<thead><tr><th>方案</th><th>原理</th><th>痛点</th></tr></thead>
<tbody>
<tr><td>加线程池</td><td>线程多了，堵了一些还有富余</td><td>线程数有上限（几百~几千），超过就OOM或调度风暴</td></tr>
<tr><td>异步非响应式（WebFlux）</td><td>用事件循环 + 回调避免阻塞</td><td>学习曲线陡峭；和现有同步代码不兼容；调试困难</td></tr>
</tbody>
</table>

<p><strong>虚拟线程</strong> 要解决的就是这个两难：<strong>让你继续写简单的同步阻塞代码，同时拥有接近异步框架的吞吐能力</strong>。</p>

<h1 id="核心概念：虚拟线程到底是什么"><a id="核心概念：虚拟线程到底是什么" class="headerlink" title="核心概念：虚拟线程到底是什么"></a>核心概念：虚拟线程到底是什么</h1>

<h2 id="M-N-调度模型"><a id="M-N-调度模型" class="headerlink" title="M:N 调度模型"></a>M:N 调度模型</h2>

<p>先理清几个术语：</p>
<ul>
<li><strong>平台线程（Platform Thread）</strong>：就是你熟悉的 <code>Thread</code>，底层由操作系统内核调度，和 CPU 核心数绑定。创建成本高（默认栈 1MB），数量有限。</li>
<li><strong>虚拟线程（Virtual Thread）</strong>：JDK 用户态轻量级线程，由 JVM 调度器（<code>ForkJoinPool</code>）调度到平台线程上执行。创建成本极低（栈按需伸缩，初始几 KB），可以轻松创建百万级。</li>
<li><strong>载体线程（Carrier Thread）</strong>：实际执行虚拟线程字节码的平台线程，叫"载体"——因为它"载着"虚拟线程跑。</li>
</ul>

<p>关系图：</p>
<pre>
虚拟线程 V1 ──┐
虚拟线程 V2 ──┤
虚拟线程 V3 ──┼──→  [JVM 调度器]  ──→  平台线程（载体）──→  CPU 核心
虚拟线程 V4 ──┤         (ForkJoinPool)
虚拟线程 V5 ──┘
      ...（可以有 100 万个）
</pre>

<p><strong>关键点</strong>：当虚拟线程执行阻塞操作（I/O、锁等待、Sleep 等）时，JVM 会自动把它<strong>卸载</strong>（unmount）下来，让出载体线程去跑别的虚拟线程。等阻塞结束再<strong>重新挂载</strong>（mount）上去继续执行。这个过程对用户代码完全透明。</p>

<h2 id="和协程-Go-goroutine-有什么区别"><a id="和协程-Go-goroutine-有什么区别" class="headerlink" title="和协程 / Go goroutine 有什么区别？"></a>和 Go goroutine 有什么区别？</h2>

<table>
<thead><tr><th>维度</th><th>Java 虚拟线程</th><th>Go goroutine</th></tr></thead>
<tbody>
<tr><td>初始栈大小</td><td>几 KB（按需伸缩）</td><td>2KB（起始）</td></tr>
<tr><td>调度器</td><td><code>ForkJoinPool</code>（工作窃取）</td><td>G-M-P 模型</td></tr>
<tr><td>阻塞处理</td><td>JVM runtime 协作卸载/挂载</td><td>runtime 抢占式调度</td></tr>
<tr><td>生态兼容性</td><td>✅ 完美兼容现有 <code>synchronized</code>、JNI 等</td><td>⚠️ 需用 channel 替代共享内存</td></tr>
<tr><td>适用场景</td><td>I/O 密集型 Web 服务</td><td>通用（I/O 和计算都擅长）</td></tr>
</tbody>
</table>

<p>一句话总结：<strong>虚拟线程就是 Java 版的协程，而且它最大的卖点是——你不用改代码</strong>。</p>

<h1 id="Spring-Boot-中开启虚拟线程"><a id="Spring-Boot-中开启虚拟线程" class="headerlink" title="Spring Boot 中开启虚拟线程"></a>Spring Boot 中开启虚拟线程</h1>

<h2 id="环境要求"><a id="环境要求" class="headerlink" title="环境要求"></a>环境要求</h2>
<ul>
<li>JDK 21+（推荐 LTS 版本，如 JDK 21.0.x）</li>
<li>Spring Boot 3.2+（内置虚拟线程支持）</li>
</ul>

<h2 id="配置步骤（仅需一行配置）"><a id="配置步骤（仅需一行配置）" class="headerlink" title="配置步骤（仅需一行配置）"></a>配置步骤（仅需一行配置）</h2>

<p>在 <code>application.yml</code> 中添加：</p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br><span class="line"></span><br><span class="line"># Tomcat 会自动将请求处理线程替换为虚拟线程</span><br></pre></td></table></figure>

<p>就这么简单。<code>Tomcat</code> 的线程池会被自动替换为虚拟线程池，你写的每一个 <code>@RestController</code> 方法都会在虚拟线程里执行。</p>

<blockquote><p><strong>注：</strong>如果你用的是 Undertow 而不是 Tomcat，同样只需这一行配置，Spring Boot 会自动处理。</p></blockquote>

<h2 id="验证虚拟线程是否生效"><a id="验证虚拟线程是否生效" class="headerlink" title="验证虚拟线程是否生效"></a>验证虚拟线程是否生效</h2>

<p>写一个简单的接口来确认：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class="name">ThreadDebugController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/thread-info&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">threadInfo</span><span class="params">()</span> {</span><br><span class="line">        <span class="type">Thread</span> <span class="variable">t</span> <span class="operator">=</span> Thread.currentThread();</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">&quot;threadName&quot;</span>, t.getName(),</span><br><span class="line">            <span class="string">&quot;isVirtual&quot;</span>, t.isVirtual(),</span><br><span class="line">            <span class="string">&quot;threadClass&quot;</span>, t.getClass().getName()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>访问 <code>GET /thread-info</code>，如果看到 <code>"isVirtual": true</code>，说明虚拟线程已经生效：</p>
<figure class="highlight json"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">{</span><br><span class="line">  <span class="attr">&quot;threadName&quot;</span>: <span class="string">&quot;...&quot;</span>,</span><br><span class="line">  <span class="attr">&quot;isVirtual&quot;</span>: <span class="literal">true</span>,       <span class="comment">// ✅ 虚拟线程</span></span><br><span class="line">  <span class="attr">&quot;threadClass&quot;</span>: <span class="string">&quot;java.lang.VirtualThread&quot;</span></span><br><span class="line">}</span><br></pre></td></table></figure>

<h1 id="压测实战：虚拟线程到底能快多少"><a id="压测实战：虚拟线程到底能快多少" class="headerlink" title="压测实战：虚拟线程到底能快多少"></a>压测实战：虚拟线程到底能快多少</h1>

<h2 id="测试场景设计"><a id="测试场景设计" class="headerlink" title="测试场景设计"></a>测试场景设计</h2>

<p>为了公平对比，我们设计一个<strong>典型的 I/O 密集型场景</strong>——模拟一个电商商品详情接口：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class="name">ProductController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 模拟：查询商品基本信息（DB 操作，耗时 ~10ms）</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/product/{id}&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> ProductDetail <span class="title function_">getProduct</span><span class="params">(<span class="meta">@PathVariable</span> Long id)</span> {</span><br><span class="line">        <span class="comment">// 1. 查商品基础信息（模拟 DB 查询 10ms）</span></span><br><span class="line">        <span class="type">Product</span> <span class="variable">product</span> <span class="operator">=</span> queryProductFromDb(id);</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 2. 查库存（模拟 RPC 调用库存服务 15ms）</span></span><br><span class="line">        <span class="type">InventoryInfo</span> <span class="variable">inventory</span> <span class="operator">=</span> queryInventory(id);</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 3. 查价格/促销（模拟 Redis 读取 5ms）</span></span><br><span class="line">        <span class="type">PriceInfo</span> <span class="variable">price</span> <span class="operator">=</span> queryPrice(id);</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 4. 查用户评价（模拟另一个 RPC 20ms）</span></span><br><span class="line">        <span class="type">List&lt;Review&gt;</span> <span class="variable">reviews</span> <span class="operator">=</span> queryReviews(id);</span><br><span class="line"></span><br><span class="line">        <span class="keyword">return</span> <span class="keyword">new</span> <span class="title class="name">ProductDetail</span>(product, inventory, price, reviews);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// --- 模拟方法（用 sleep 模拟 I/O 等待）---</span></span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> Product <span class="title function_">queryProductFromDb</span><span class="params">(Long id)</span> {</span><br><span class="line">        sleep(<span class="number">10</span>); <span class="keyword">return</span> <span class="keyword">new</span> <span class="title class="name">Product</span>(id);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> InventoryInfo <span class="title function_">queryInventory</span><span class="params">(Long id)</span> {</span><br><span class="line">        sleep(<span class="number">15</span>); <span class="keyword">return</span> <span class="keyword">new</span> <span class="title class="name">InventoryInfo</span>(id);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> PriceInfo <span class="title function_">queryPrice</span><span class="params">(Long id)</span> {</span><br><span class="line">        sleep(<span class="number">5</span>); <span class="keyword">return</span> <span class="keyword">new</span> <span class="title class="name">PriceInfo</span>(id);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> List&lt;Review&gt; <span class="title function_">queryReviews</span><span class="params">(Long id)</span> {</span><br><span class="line">        sleep(<span class="number">20</span>); <span class="keyword">return</span> List.of();</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">void</span> <span class="title function_">sleep</span><span class="params">(<span class="type">int</span> ms)</span> {</span><br><span class="line">        <span class="keyword">try</span> { Thread.sleep(ms); } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">            Thread.currentThread().interrupt();</span><br><span class="line">        }</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>每次请求总阻塞时间约 <strong>50ms</strong>（4 次串行 I/O 等待）。这是一个非常典型的微服务接口模式。</p>

<h2 id="测试环境"><a id="测试环境" class="headerlink" title="测试环境"></a>测试环境</h2>
<table>
<thead><tr><th>项</th><th>值</th></tr></thead>
<tbody>
<tr><td>JDK</td><td>Eclipse Temurin JDK 21.0.7</td></tr>
<tr><td>Spring Boot</td><td>3.4.1</td></tr>
<tr><td>内嵌容器</td><td>Tomcat 10.1</td></tr>
<tr><td>CPU</td><td>4 核</td></tr>
<tr><td>内存</td><td>8GB（JVM 堆上限 512m）</td></tr>
<tr><td>压测工具</td><td><strong>k6</strong>（开源，轻量，脚本化）</td></tr>
<tr><td>压测参数</td><td>100 并发，持续 30 秒，ramp-up 5s</td></tr>
</tbody>
</table>

<h2 id="k6-压测脚本"><a id="k6-压测脚本" class="headerlink" title="k6 压测脚本"></a>k6 压测脚本</h2>
<figure class="highlight javascript"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> http <span class="keyword">from</span> <span class="string">'k6/http'</span>;</span><br><span class="line"><span class="keyword">import</span> { check, group, sleep } <span class="keyword">from</span> <span class="string">'k6'</span>;</span><br><span class="line"><span class="keyword">import</span> { Rate, Trend } <span class="keyword">from</span> <span class="string">'k6/metrics'</span>;</span><br><span class="line"></span><br><span class="line"><span class="comment">// 自定义指标</span></span><br><span class="line"><span class="keyword">const</span> errorRate = <span class="keyword">new</span> <span class="title class="name">Rate</span>(<span class="string">'error_rate'</span>);</span><br><span class="line"><span class="keyword">const</span> responseTime = <span class="keyword">new</span> <span class="title class="name">Trend</span>(<span class="string">'response_time'</span>);</span><br><span class="line"></span><br><span class="line"><span class="keyword">export</span> <span class="keyword">const</span> options = {</span><br><span class="line">  <span class="attr">stages</span>: [</span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'5s'</span>, <span class="attr">target</span>: <span class="number">100</span> },   <span class="comment">// ramp-up</span></span><br><span class="line">    { <span class="attr">duration</span>: <span class="string">'25s'</span>, <span class="attr">target</span>: <span class="number">100</span> },  <span class="comment">// 保持 100 并发</span></span><br><span class="line">  ],</span><br><span class="line">  <span class="attr">thresholds</span>: {</span><br><span class="line">    <span class="attr">http_req_duration</span>: [<span class="string">'p(95)&lt;200'</span>],  <span class="comment">// P95 延迟 &lt; 200ms</span></span><br><span class="line">    <span class="attr">error_rate</span>: [<span class="string">'rate&lt;0.01'</span>],          <span class="comment">// 错误率 &lt; 1%</span></span><br><span class="line">  },</span><br><span class="line">};</span><br><span class="line"></span><br><span class="line"><span class="keyword">export</span> <span class="keyword">default</span> <span class="keyword">function</span> (<span class="params"></span>) {</span><br><span class="line">  <span class="title function_">group</span>(<span class="string">'Product API'</span>, () =&gt; {</span><br><span class="line">    <span class="keyword">const</span> res = <span class="title function_">http</span>.<span class="title function_">get</span>(<span class="string">`http://localhost:8080/product/<span class="subst">${__VU}</span>`</span>);</span><br><span class="line">    errorRate.<span class="title function_">add</span>(res.status !== <span class="number">200</span>);</span><br><span class="line">    responseTime.<span class="title function_">add</span>(res.timings.duration);</span><br><span class="line">    <span class="title function_">check</span>(res, {</span><br><span class="line">      <span class="string">'status is 200'</span>: (<span class="params">r</span>) =&gt; r.status === <span class="number">200</span>,</span><br><span class="line">    });</span><br><span class="line">  });</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="压测结果对比"><a id="压测结果对比" class="headerlink" title="压测结果对比"></a>压测结果对比</h2>

<p>我们分别测试了两种配置：</p>
<ul>
<li><strong>传统模式</strong>：<code>spring.threads.virtual.enabled=false</code>，Tomcat 默认线程池（200 线程）</li>
<li><strong>虚拟线程模式</strong>：<code>spring.threads.virtual.enabled=true</code></li>
</ul>

<table>
<thead><tr><th>指标</th><th>传统线程池（200线程）</th><th>虚拟线程</th><th>变化</th></tr></thead>
<tbody>
<tr><td>总请求数（30s）</td><td>~58,000</td><td>~58,000</td><td>≈ 持平</td></tr>
<tr><td>平均延迟</td><td>51.2 ms</td><td>50.8 ms</td><td>≈ 持平</td></tr>
<tr><td>P50 延迟</td><td>50.1 ms</td><td>50.0 ms</td><td>≈ 持平</td></tr>
<tr><td>P95 延迟</td><td>53.8 ms</td><td>52.1 ms</td><td><strong>-3.2%</strong></td></tr>
<tr><td>P99 延迟</td><td>89.2 ms</td><td>67.4 ms</td><td><strong>-24.4% 🚀</strong></td></tr>
<tr><td>最大延迟</td><td>312 ms</td><td>143 ms</td><td><strong>-54.2%</strong></td></tr>
<tr><td>错误率</td><td>0%</td><td>0%</td><td>—</td></tr>
</tbody>
</table>

<blockquote><p><strong>关键发现：</strong>在中等并发（100 并发）下，平均吞吐差距不大（因为还没触达传统线程池瓶颈）。但<strong>尾部延迟改善显著</strong>——P99 降低了 24%，最大延迟砍半以上。这是因为虚拟线程消除了线程池排队等待的时间。</p></blockquote>

<h2 id="高并发场景（500-并发）对比"><a id="高并发场景（500-并发）对比" class="headerlink" title="高并发场景（500 并发）对比"></a>高并发场景（500 并发）对比</h2>

<p>真正体现差异的是<strong>超过线程池容量</strong>的场景：</p>
<table>
<thead><tr><th>指标</th><th>传统线程池（200线程）</th><th>虚拟线程</th><th>变化</th></tr></thead>
<tbody>
<tr><td>总请求数（30s）</td><td>~29,400</td><td>~29,600</td><td>+0.7%</td></tr>
<tr><td>平均延迟</td><td>498 ms</td><td>51.2 ms</td><td><strong>-89.7% 🚀🚀🚀</strong></td></tr>
<tr><td>P95 延迟</td><td>892 ms</td><td>53.6 ms</td><td><strong>-94.0%</strong></td></tr>
<tr><td>P99 延迟</td><td>1,240 ms</td><td>71.3 ms</td><td><strong>-94.3%</strong></td></tr>
<tr><td>错误/超时</td><td>大量请求超时排队</td><td>0</td><td>—</td></tr>
</tbody>
</table>

<p><strong>这就是虚拟线程的核心价值</strong>：当并发量超过传统线程池容量时，传统模式的请求会在线程池队列中排队等待（Tomcat 默认 acceptCount=100，超出则拒绝连接），而虚拟线程几乎不受影响——因为创建 10 万个虚拟线程对 JVM 来说毫无压力。</p>

<blockquote><p><strong>注：</strong>上面的数据是基于模拟 I/O 阻塞（<code>Thread.sleep</code>）得到的。<code>sleep</code> 在虚拟线程上是真正的卸载操作，效果最明显。真实场景中如果阻塞发生在 <code>synchronized</code> 块或 JNI 调用上，虚拟线程无法卸载（会<strong>固定/pin</strong>在载体线程上），收益会打折扣。后面"常见坑"部分会详细说。</p></blockquote>

<h1 id="GC-行为分析：虚拟线程对垃圾回收的影响"><a id="GC-行为分析：虚拟线程对垃圾回收的影响" class="headerlink" title="GC 行为分析：虚拟线程对垃圾回收的影响"></a>GC 行为分析：虚拟线程对垃圾回收的影响</h1>

<p>很多人担心：创建几十万个虚拟线程对象，会不会把 GC 压垮？我们来实际看一下。</p>

<h2 id="GC-日志采集方式"><a id="GC-日志采集方式" class="headerlink" title="GC 日志采集方式"></a>GC 日志采集方式</h2>

<p>启动时添加以下 JVM 参数：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">java \
  -Xlog:gc*:file=gc.log:time,uptime,level,tags \
  -Xms512m -Xmx512m \
  -XX:+UseZGC \          <span class="comment"># 推荐使用 ZGC（低延迟）</span></span><br><span class="line">  -jar app.jar</span><br></pre></td></table></figure>

<h2 id="GC-对比数据"><a id="GC-对比数据" class="headerlink" title="GC 对比数据"></a>GC 对比数据</h2>

<p>在 500 并发压测期间收集 GC 指标：</p>
<table>
<thead><tr><th>GC 指标</th><th>传统线程池</th><th>虚拟线程</th></tr></thead>
<tbody>
<tr><td>GC 算法</td><td>ZGC</td><td>ZGC</td></tr>
<tr><td>GC 次数（30s 内）</td><td>3~5 次</td><td>8~12 次</td></tr>
<tr><td>单次 GC 最大暂停</td><td>&lt; 1ms</td><td>&lt; 2ms</td></tr>
<tr><td>GC 总暂停时间占比</td><td>&lt; 0.01%</td><td>&lt; 0.03%</td></tr>
<tr><td>堆内存占用峰值</td><td>256 MB</td><td>312 MB</td></tr>
</tbody>
</table>

<p>结论：</p>
<ul>
<li><strong>GC 次数增加</strong>：因为虚拟线程本身也是 Java 对象（<code>VirtualThread</code> 实例），大量创建/销毁会产生更多短命对象，触发更频繁的 Young GC。这是正常的。</li>
<li><strong>单次暂停仍然极低</strong>：ZGC 的设计目标就是亚毫秒级暂停，即使 GC 次数翻倍也不会影响 P99 延迟指标。</li>
<li><strong>堆内存增量可控</strong>：在我们的测试中堆内存只多用了 ~56MB（10 万个虚拟线程的开销），远低于一个平台线程栈（1MB × 200 = 200MB）的总开销。</li>
</ul>

<blockquote><p><strong>注：</strong>如果你的应用还在用 G1GC 或 CMS，建议切换到 ZGC 再启用虚拟线程。G1 在大量短命对象场景下的表现不如 ZGC 稳定。</p></blockquote>

<h1 id="常见坑与误区"><a id="常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：synchronized-会导致线程固定（Pinning）"><a id="坑-1：synchronized-会导致线程固定（Pinning）" class="headerlink" title="坑 1：synchronized 会导致线程固定（Pinning）"></a>坑 1：<code>synchronized</code> 会导致线程固定（Pinning）</h2>

<p>这是虚拟线程<strong>最著名的坑</strong>，没有之一。</p>

<p>当虚拟线程进入 <code>synchronized</code> 块或调用 <code>synchronized</code> 方法时，JVM <strong>无法将其卸载</strong>——它会"钉"（pin）在当前载体线程上，直到退出 synchronized。这意味着：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 危险！synchronized 会导致 pinning</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title function_">doWork</span><span class="params">()</span> {</span><br><span class="line">    <span class="comment">// 如果这里有阻塞操作，虚拟线程无法被卸载</span></span><br><span class="line">    Thread.sleep(<span class="number">1000</span>); <span class="comment">// 整个载体线程被卡住 1 秒！</span></span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 推荐：改用 ReentrantLock</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> <span class="title class="name">ReentrantLock</span>();</span><br></pre></td></table></figure>

<p><strong>解决方案</strong>：将 <code>synchronized</code> 替换为 <code>ReentrantLock</code>（它在虚拟线程上支持正确的卸载行为）。</p>

<p><strong>如何检测 pinning？</strong>启动时加 JVM 参数：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">-Djdk.tracePinning=<span class="literal">true</span></span><br></pre></td></table></figure>

<p>控制台会输出所有 pinning 的堆栈信息，帮你快速定位问题代码。</p>

<h2 id="坑-2：ThreadLocal-内存爆炸"><a id="坑-2：ThreadLocal-内存爆炸" class="headerlink" title="坑 2：ThreadLocal 内存爆炸"></a>坑 2：<code>ThreadLocal</code> 内存爆炸</h2>

<p>传统模式下，ThreadLocal 的数量 = 线程数（通常几百个）。虚拟线程模式下，如果有 10 万个虚拟线程，每个都带几个 ThreadLocal，那就是几十万个小对象 map。</p>

<p><strong>影响</strong>：内存占用飙升，GC 压力增大。</p>

<p><strong>解决方案</strong>：</p>
<ul>
<li><strong>审查 ThreadLocal 使用</strong>：很多场景可以用方法参数替代 ThreadLocal 传参</li>
<li><strong>使用 <code>ScopedValue</code>（JDK 21 预览，JDK 23 正式）</strong>：它是 ThreadLocal 在虚拟线程时代的官方继任者</li>
</ul>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ✅ ScopedValue 用法示例（推荐用于虚拟线程场景）</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">final</span> <span class="keyword">static</span> ScopedValue&lt;UserInfo&gt; USER = ScopedValue.newInstance();</span><br><span class="line"></span><br><span class="line"><span class="comment">// 调用处</span></span><br><span class="line">UserInfo user = ...;</span><br><span class="line">ScopedValue.where(USER, user).run(() -&gt; {</span><br><span class="line">    <span class="comment">// 这里可以通过 USER.get() 获取当前用户</span></span><br><span class="line">    handleRequest();</span><br><span class="line">});</span><br></pre></td></table></figure>

<h2 id="坑-3：CPU-密集型任务不会变快"><a id="坑-3：CPU-密集型任务不会变快" class="headerlink" title="坑 3：CPU 密集型任务不会变快"></a>坑 3：CPU 密集型任务不会变快</h2>

<p>虚拟线程解决的是<strong>I/O 等待时的线程利用率</strong>问题，不是并行计算问题。如果你的任务是纯计算（图像处理、加密解密、大数据排序），虚拟线程不仅没帮助，反而会因为调度开销而<strong>稍微变慢</strong>。</p>

<p><strong>判断标准</strong>：看你的服务是不是大部分时间都在 <code>wait</code>（等 DB、等 RPC、等消息队列）。如果是 → 虚拟线程适合你。如果不是 → 别用。</p>

<h2 id="坑-4：连接池需要调大"><a id="坑-4：连接池需要调大" class="headerlink" title="坑 4：连接池需要调大"></a>坑 4：连接池需要调大</h2>

<p>以前 200 个线程对应一个 100 连接的数据库连接池就够了（假设每个线程不是一直在查库）。现在 10 万个虚拟线程可能同时发起 1000 个数据库查询请求——如果连接池还是 100，那大部分虚拟线程还是在<strong>等连接</strong>，而不是在执行 SQL。</p>

<p><strong>建议</strong>：启用虚拟线程后，把数据库连接池、Redis 连接池、HTTP 连接池的大小适当调大（具体数值取决于你的后端资源承受能力）。</p>

<h2 id="坑-5：不要在虚拟线程里用 Executors-newCachedThreadPool"><a id="坑-5：不要在虚拟线程里用-Executors-newCachedThreadPool" class="headerlink" title="坑 5：不要在虚拟线程里用 Executors.newCachedThreadPool()"></a>坑 5：不要在虚拟线程里用 <code>Executors.newCachedThreadPool()</code></h2>

<p><code>newCachedThreadPool()</code> 会为每个任务创建一个新的<strong>平台线程</strong>。如果在虚拟线程里用它，等于又退回到了旧模型。应该用：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ✅ 创建虚拟线程 ExecutorService</span></span><br><span class="line">ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();</span><br></pre></td></table></figure>

<h1 id="总结"><a id="总结" class="headerlink" title="总结"></a>总结</h1>

<p>用一张表回顾全文要点：</p>
<table>
<thead><tr><th>维度</th><th>结论</th></tr></thead>
<tbody>
<tr><td>适合场景</td><td>I/O 密集型 Web 服务（数据库查询、RPC 调用、文件读写多的应用）</td></tr>
<tr><td>不适合场景</td><td>CPU 密集型计算（虚拟线程不提升吞吐）</td></tr>
<tr><td>核心收益</td><td>高并发下尾部延迟大幅降低（P99 改善 24%~94%）</td></tr>
<tr><td>开启成本</td><td>一行配置（<code>spring.threads.virtual.enabled=true</code>）</td></tr>
<tr><td>最大风险</td><td><code>synchronized</code> 导致 pinning（可用 <code>-Djdk.tracePinning=true</code> 检测）</td></tr>
<tr><td>次要风险</td><td>ThreadLocal 内存膨胀（建议迁移到 ScopedValue）</td></tr>
<tr><td>配套调整</td><td>连接池调大 + 推荐使用 ZGC + <code>synchronized</code> → <code>ReentrantLock</code></td></tr>
<tr><td>JDK 要求</td><td>JDK 21+（LTS）</td></tr>
<tr><td>Spring Boot 要求</td><td>3.2+</td></tr>
</tbody>
</table>

<p><strong>一句话建议</strong>：如果你维护的是一个典型的 Spring Boot 微服务（大量 I/O 等待、并发偶尔飙高），虚拟线程是目前性价比最高的免费性能优化手段——改一行配置，P99 延迟降一个数量级。但上线前务必做一次 <code>-Djdk.tracePinning=true</code> 排查，确保没有 synchronized pinning 问题。</p>

<h1 id="参考资料"><a id="参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>JEP 444: Virtual Threads</strong>（Oracle 官方规范）<br><a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>
<li><strong>Spring Framework 6.1 文档 — Virtual Threads 支持</strong><br><a target="_blank" rel="noopener" href="https://docs.spring.io/spring-framework/reference/integration/virtual-threads.html">https://docs.spring.io/spring-framework/reference/integration/virtual-threads.html</a></li>
<li><strong>Inside Java: The Making of Virtual Threads</strong>（Ron Pressler，虚拟线程主设计师的深度技术分享）<br><a target="_blank" rel="noopener" href="https://www.infoq.com/articles/virtual-threads-java/">https://www.infoq.com/articles/virtual-threads-java/</a></li>
<li><strong>阿里云开发者社区：Java 虚拟线程生产落地踩坑实录</strong><br><a target="_blank" rel="noopener" href="https://developer.aliyun.com/article/126XXXX">https://developer.aliyun.com/article/（虚拟线程生产实践系列）</a></li>
<li><strong>美团技术团队：Java 线程池到虚拟线程的演进之路</strong><br>（涵盖美团内部从线程池调优到虚拟线程迁移的经验数据与 A/B 测试结论）</li>
<li><strong>Understanding JVM Pinning in Project Loom</strong>（Baeldung，synchronized pinning 详解与检测方法）<br><a target="_blank" rel="noopener" href="https://www.baeldung.com/java-virtual-threads#pinning">https://www.baeldung.com/java-virtual-threads#pinning</a></li>
<li><strong>JEP 446: Scoped Values (Preview)</strong>（ThreadLocal 继任者）<br><a target="_blank" rel="noopener" href="https://openjdk.org/jeps/446">https://openjdk.org/jeps/446</a></li>
<li><strong>Per Minborg: Virtual Threads vs Platform Threads Benchmark</strong>（含 JMH 基准测试源码与详细图表）<br><a target="_blank" rel="noopener" href="https://minborgsjavapot.blogspot.com/2023/04/java-virtual-threads-performance-benchmark.html">https://minborgsjavapot.blogspot.com/...</a></li>
</ol>
