---
title: Java 虚拟线程（Virtual Threads）实战——从原理到 Spring Boot 集成压测
date: 2026-08-05 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - VirtualThreads
  - 并发编程
  - SpringBoot
  - 性能调优
  - JVM
---
<hr>
<blockquote><p>Java 21 正式发布了 <strong>虚拟线程</strong>（Virtual Threads）——这是一种由 JVM 调度的轻量级线程实现，能在少量平台线程上承载百万级并发量。本文从「它到底解决了什么问题」出发，手把手搭建可复现的压测实验，对比虚拟线程与传统线程池的吞吐和延迟差异，并给出在 Spring Boot 项目中的集成方式与避坑指南。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>在 Java 21 之前，我们写高并发服务基本就一套姿势：<code>ThreadPoolExecutor</code> + 阻塞 I/O（或者上 Netty 上异步）。这套方案能用，但它有个<strong>根本性的尴尬</strong>：</p>

<ul>
<li><strong>平台线程（Platform Thread）很贵</strong>：每个线程默认栈大小 ~1MB，创建和上下文切换都要走内核调度。一台 8C16G 的机器，线程数撑死几千个（通常建议 200~500）。</li>
<li><strong>阻塞 I/O 会「占着茅坑不拉屎」</strong>：一个请求在等数据库返回、等 RPC 响应、等 HTTP 回包的时候，线程是 <strong>阻塞（blocked）</strong> 的——但这个线程本身还占着资源。</li>
<li><strong>要吞吐量？加机器</strong>：想扛 1 万 QPS？传统方案下你得横向扩容，成本直线上升。</li>
</ul>

<p><strong>虚拟线程</strong>就是冲着这个问题来的。它的核心思路非常简单：</p>

<blockquote><p>把「Java 线程」和「操作系统线程」解耦。<br>
JVM 用极少的<strong>载体线程（Carrier Thread，也就是平台线程）</strong>去调度大量的虚拟线程；当虚拟线程阻塞时，JVM 自动把它「挂起」，把载体线程让给别的虚拟线程用。</p></blockquote>

<p>这跟 Go 的 goroutine、Node.js 的 async/await 是同一类思想——<strong>用户态协程</strong>。只不过 Java 把它做成了让你几乎无感知的「看起来就像普通 Thread」。</p>

<h2 id="适用场景速查"><a href="#适用场景速查" class="headerlink" title="适用场景速查"></a>适用场景速查</h2>

<table>
<thead><tr><th>场景</th><th>虚拟线程效果</th><th>说明</th></tr></thead>
<tbody>
<tr><td>大量阻塞 I/O（DB/RPC/HTTP）</td><td>🟢 显著提升</td><td>典型 Web 后端场景，收益最大</td></tr>
<tr><td>计算密集型任务</td><td>🔴 无提升</td><td>CPU 已经打满，换调度器没用</td></tr>
<tr><td>synchronized 重依赖</td><td>🟡 有风险</td><td>synchronized 会让虚拟线程<strong>固定（pin）</strong>在载体线程上</td></tr>
<tr><td>已有纯异步框架（Netty/WebFlux）</td><td>🟢 可简化代码</td><td>用虚拟线程可以写同步风格但享受异步性能</td></tr>
</tbody>
</table>

<h1 id="核心概念快速过一遍"><a href="#核心概念快速过一遍" class="headerlink" title="核心概念快速过一遍"></a>核心概念快速过一遍</h1>

<h2 id="1-虚拟线程-vs-平台线程"><a href="#1-虚拟线程-vs-平台线程" class="headerlink" title="1. 虚拟线程 vs 平台线程"></a>1. 虚拟线程 vs 平台线程</h2>

<table>
<thead><tr><th>维度</th><th>平台线程（Thread）</th><th>虚拟线程（Virtual Thread）</th></tr></thead>
<tbody>
<tr><td>调度者</td><td>操作系统内核</td><td>JVM（ForkJoinPool 作为调度器）</td></tr>
<tr><td>创建成本</td><td>高（~10μs+，需内核参与）</td><td>极低（~200ns，纯用户态）</td></tr>
<tr><td>默认栈大小</td><td>~1MB（物理内存）</td><td>按需增长（栈帧存在堆上）</td></tr>
<tr><td>一台机器合理上限</td><td>几百~几千</td><td>百万级</td></tr>
<tr><td>阻塞行为</td><td>占用 OS 线程</td><td>自动让出载体线程（卸载 mount）</td></tr>
</tbody>
</table>

<h2 id="2-两个关键机制：Mount-与-Pin"><a href="#2-两个关键机制：Mount-与-Pin" class="headerlink" title="2. 两个关键机制：Mount 与 Pin"></a>2. 两个关键机制：Mount 与 Pin</h2>

<p><strong>Mount（挂载）</strong>：虚拟线程运行时，会被安排到一个载体线程（Carrier Thread，本质上是平台线程）上去执行代码。这叫 mount。</p>

<p><strong>Unmount（卸载）</strong>：当虚拟线程执行阻塞操作（如 LockSupport.park、Socket 读写的 blocking call）时，JVM 会把虚拟线程从载体线程上「摘下来」，把载体线程释放回去调度其他虚拟线程。这叫 unmount。</p>

<p><strong>Pin（固定）——最大的坑</strong>：如果虚拟线程在执行 <code>synchronized</code> 代码块或调用本地方法（native method）时发生阻塞，<strong>JVM 无法将其卸载</strong>，虚拟线程会一直占着载体线程。这种现象叫 pin。严重的 pin 会直接退化成「跟以前一样」的性能。</p>

<pre><code>注：Java 24+ 已开始对 synchronized 做 pin-elimination 优化，
     但截至 Java 21 LTS，synchronized 仍然会导致 pin。
     替代方案：用 ReentrantLock 替代 synchronized。
</code></pre>

<h2 id="3-创建虚拟线程的方式"><a href="#3-创建虚拟线程的方式" class="headerlink" title="3. 创建虚拟线程的方式"></a>3. 创建虚拟线程的方式</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 方式1：直接创建（类似 new Thread）</span></span><br><span class="line">Thread vt = Thread.<span class="built_in">ofVirtual</span>().name(<span class="string">"my-vt"</span>).start(() -&gt; {</span><br><span class="line">    System.out.println(<span class="string">"Hello from "</span> + Thread.currentThread());</span><br><span class="line">});</span><br><span class="line"></span><br><span class="line"><span class="comment">// 方式2：Executors.newVirtualThreadPerTaskExecutor()（推荐）</span></span><br><span class="line"><span class="keyword">try</span> (<span class="keyword">var</span> executor = Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()) {</span><br><span class="line">    executor.submit(() -&gt; {</span><br><span class="line">        <span class="comment">// 每个 submit 都会创建一个新的虚拟线程</span></span><br><span class="line">        doSomethingBlocking();</span><br><span class="line">    });</span><br><span class="line">}</span><br><span class="line"><span class="comment">// ⚠️ 注意：这里不需要配置线程池大小！每个任务一个虚拟线程！</span></span><br></pre></td></table></figure>

<h1 id="实验环境准备"><a href="#实验环境准备" class="headerlink" title="实验环境准备"></a>实验环境准备</h1>

<h2 id="环境信息"><a href="#环境信息" class="headerlink" title="环境信息"></a>环境信息</h2>

<table>
<thead><tr><th>项</th><th>值</th></tr></thead>
<tbody>
<tr><td>JDK</td><td>Eclipse Temurin 21.0.5 LTS</td></tr>
<tr><td>操作系统</td><td>Linux 4.18 (x86_64)</td></tr>
<tr><td>CPU</td><td>核数见 <code>Runtime.getRuntime().availableProcessors()</code></td></tr>
<tr><td>压测工具</td><td>JMeter 5.x 或 wrk / k6</td></tr>
<tr><td>Web 框架</td><td>Spring Boot 3.4.x（内嵌 Tomcat）</td></tr>
</tbody>
</table>

<h2 id="项目结构"><a href="#项目结构" class="headerlink" title="项目结构"></a>项目结构</h2>

<p>我们创建一个最小化的 Spring Boot 项目来做对照实验：</p>

<figure class="highlight plaintext"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br></pre></td><td class="code"><pre><span class="line">src/main/java/demo/</span><br><span class="line">├── VtDemoApplication.java          // 启动类</span><br><span class="line">├── controller/</span><br><span class="line">│   └── BlockingController.java      // 模拟阻塞接口</span><br><span class="line">├── service/</span><br><span class="line">│   └── BlockingService.java         // 模拟业务逻辑（含可调延迟）</span><br><span class="line">└── config/</span><br><span class="line">    └── ThreadConfig.java            // 线程池配置（传统 vs 虚拟线程）</span><br></pre></td></table></figure>

<h2 id="模拟阻塞型接口"><a href="#模拟阻塞型接口" class="headerlink" title="模拟阻塞型接口"></a>模拟阻塞型接口</h2>

<p>真实后端的瓶颈大多来自 I/O 等待（数据库查询、RPC 调用、缓存读取）。我们用一个可控延迟来模拟：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ========== BlockingService.java ==========</span></span><br><span class="line"><span class="meta">@Service</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">BlockingService</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟一次远程调用：先查库(50ms)，再调RPC(80ms)，最后写缓存(20ms)</span></span><br><span class="line"><span class="comment">     * 总计阻塞约 150ms —— 这就是典型的 I/O 密集型业务</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">simulateBusinessCall</span>(<span class="params">String requestId</span>) {</span><br><span class="line">        <span class="type">long</span> <span class="variable">start</span> <span class="operator">=</span> System.nanoTime();</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 模拟数据库查询</span></span><br><span class="line">        sleepQuietly(<span class="number">50</span>);</span><br><span class="line">        <span class="comment">// 模拟 RPC 调用</span></span><br><span class="line">        sleepQuietly(<span class="number">80</span>);</span><br><span class="line">        <span class="comment">// 模拟缓存写入</span></span><br><span class="line">        sleepQuietly(<span class="number">20</span>);</span><br><span class="line"></span><br><span class="line">        <span class="type">long</span> <span class="variable">elapsed</span> <span class="operator">=</span> (System.nanoTime() - start) / <span class="number">1_000_000</span>;</span><br><span class="line">        <span class="keyword">return</span> String.format(<span class="string">"[req=%s] done in %dms | thread=%s"</span>,</span><br><span class="line">                requestId, elapsed, Thread.currentThread().getName());</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">void</span> <span class="title">sleepQuietly</span>(<span class="params"><span class="type">int</span> ms</span>) {</span><br><span class="line">        <span class="keyword">try</span> {</span><br><span class="line">            Thread.sleep(ms);</span><br><span class="line">        } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">            Thread.currentThread().interrupt();</span><br><span class="line">            <span class="keyword">throw</span> <span class="keyword">new</span> <span class="title class_">RuntimeException</span>(e);</span><br><span class="line">        }</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ========== BlockingController.java ==========</span></span><br><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api/demo")</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">BlockingController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Autowired</span></span><br><span class="line">    <span class="keyword">private</span> BlockingService blockingService;</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping("/blocking")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">blocking</span>(span class="params">(<span class="meta">@RequestParam(defaultValue = "demo")</span> String reqId</span>) {</span><br><span class="line">        <span class="keyword">return</span> blockingService.simulateBusinessCall(reqId);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 用于验证虚拟线程是否真的在工作：打印当前线程信息</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/thread-info")</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">threadInfo</span><span class="params">()</span> {</span><br><span class="line">        Thread <span class="variable">t</span> <span class="operator">=</span> Thread.currentThread();</span><br><span class="line">        Map&lt;String, Object&gt; info = <span class="keyword">new</span> <span class="title class_">LinkedHashMap</span>&lt;&gt;();</span><br><span class="line">        info.put(<span class="string">"name"</span>, t.getName());</span><br><span class="line">        info.put(<span class="string">"isVirtual"</span>, t.isVirtual());</span><br><span class="line">        info.put(<span class="string">"isDaemon"</span>, t.isDaemon());</span><br><span class="line">        info.put(<span class="string">"state"</span>, t.state().name());</span><br><span class="line">        info.put(<span class="string">"threadGroup"</span>, t.getThreadGroup() != <span class="literal">null</span></span><br><span class="line">                ? t.getThreadGroup().getName() : <span class="string">"null"</span>);</span><br><span class="line">        info.put(<span class="string">"activeThreads"</span>, Thread.activeCount());</span><br><span class="line">        <span class="keyword">return</span> info;</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h1 id="两种模式配置"><a href="#两种模式配置" class="headerlink" title="两种模式配置"></a>两种模式配置</h1>

<h2 id="模式A：传统-Tomcat-线程池"><a href="#模式A：传统-Tomcat-线程池" class="headerlink" title="模式 A：传统 Tomcat 线程池"></a>模式 A：传统 Tomcat 线程池</h2>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application-traditional.yml</span></span><br><span class="line"><span class="attr">server:</span></span><br><span class="line">  <span class="attr">tomcat:</span></span><br><span class="line">    <span class="attr">threads:</span></span><br><span class="line">      <span class="attr">max:</span> <span class="number">200</span>       <span class="comment"># 最大 200 个处理线程（生产常见值）</span></span><br><span class="line">      <span class="attr">min-spare:</span> <span class="number">10</span></span><br><span class="line">    <span class="attr">accept-count:</span> <span class="number">100</span>   <span class="comment"># 等待队列容量</span></span><br></pre></td></table></figure>

<h2 id="模式B：虚拟线程（Spring-Boot-34-原生支持）"><a href="#模式B：虚拟线程（Spring-Boot-34-原生支持）" class="headerlink" title="模式 B：虚拟线程（Spring Boot 3.4+ 原生支持）"></a>模式 B：虚拟线程（Spring Boot 3.4+ 原生支持）</h2>

<p>Spring Boot 3.4+ 只需一行配置就能开启虚拟线程：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application-virtual-thread.yml</span></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span>    <span class="comment"># 就这一行！Tomcat 请求处理线程全部切换为虚拟线程</span></span><br></pre></td></table></figure>

<pre><code>注：spring.threads.virtual.enabled=true 会让：
  1) Tomcat 的请求处理使用虚拟线程
  2) @Async 注解也默认使用虚拟线程
  3) Tomcat threads.max 配置不再有实际意义（不再限制请求数）
  
  但要注意：它不会影响 Servlet Filter 中手动提交到自定义 ExecutorService 的任务。
</code></pre>

<h1 id="压测实验与结果分析"><a href="#压测实验与结果分析" class="headerlink" title="压测实验与结果分析"></a>压测实验与结果分析</h1>

<h2 id="压测方案"><a href="#压测方案" class="headerlink" title="压测方案"></a>压测方案</h2>

<table>
<thead><tr><th>参数</th><th>值</th></tr></thead>
<tbody>
<tr><td>接口</td><td><code>GET /api/demo/blocking?reqId={id}</code></td></tr>
<tr><td>单次请求耗时</td><td>~150ms（50+80+20ms 模拟阻塞）</td></tr>
<tr><td>并发级别</td><td>50 / 200 / 500 / 1000 / 2000 并发</td></tr>
<tr><td>压测工具</td><td>wrk（或 JMeter / k6 / ab）</td></tr>
<tr><td>预热</td><td>1000 requests warm-up</td></tr>
<tr><td>采集指标</td><td>QPS、Latency P50/P95/P99、Error %</td></tr>
</tbody>
</table>

<h2 id="wrk-命令示例"><a href="#wrk-命令示例" class="headerlink" title="wrk 命令示例"></a>wrk 命令示例</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 500 并发，压测 30 秒，12 线程</span></span><br><span class="line">wrk -t12 -c500 -d30s --latency \</span><br><span class="line">    <span class="string">"http://localhost:8080/api/demo/blocking?reqId=__rand__"</span></span><br><span class="line"></span><br><span class="line"><span class="comment"># 如果没有 __rand__ 支持，可以用 Lua 脚本生成随机参数</span></span><br></pre></td></table></figure>

<h2 id="预期结果（基于社区公开基准+实测趋势）"><a href="#预期结果（基于社区公开基准+实测趋势）" class="headerlink" title="预期结果（基于社区公开基准 + 实测趋势）"></a>预期结果（基于社区公开基准 + 实测趋势）</h2>

<p>以下数据为典型 I/O 密集场景下的<strong>量级参考</strong>（具体数值因机器而异，但趋势一致）：</p>

<table>
<thead><tr><th>并发数</th><th>模式</th><th>QPS（约）</th><th>P99 Latency</th><th>Error Rate</th><th>备注</th></tr></thead>
<tbody>
<tr><td>50</td><td>传统线程池(200)</td><td>~330</td><td>~180ms</td><td>0%</td><td>两者接近</td></tr>
<tr><td>50</td><td>虚拟线程</td><td>~330</td><td>~175ms</td><td>0%</td><td>低负载下持平</td></tr>
<tr><td>200</td><td>传统线程池(200)</td><td>~1300</td><td>~300ms</td><td>0%</td><td>线程池刚好打满</td></tr>
<tr><td>200</td><td>虚拟线程</td><td>~1300</td><td>~190ms</td><td>0%</td><td>延迟明显更低</td></tr>
<tr><td>500</td><td>传统线程池(200)</td><td>~1300</td><td><strong>P99 &gt; 2s</strong></td><td>大量超时</td><td>队列堆积 + 拒绝</td></tr>
<tr><td>500</td><td>虚拟线程</td><td><strong>~3200+</strong></td><td>~250ms</td><td>0%</td><td>吞吐翻倍+</td></tr>
<tr><td>2000</td><td>传统线程池(200)</td><td>~1300（封顶）</td><td>大量 timeout</td><td>&gt;50%</td><td>基本不可用</td></tr>
<tr><td>2000</td><td>虚拟线程</td><td><strong>~3300+</strong></td><td>~400ms</td><td>~0%</td><td>稳定承接</td></tr>
</tbody>
</table>

<h3 id="关键结论"><a href="#关键结论" class="headerlink" title="关键结论"></a>关键结论</h3>

<ol>
<li><strong>低并发（&lt;= 线程池大小）</strong>：两者性能几乎一样。虚拟线程不是银弹，不会让你的单请求变快。</li>
<li><strong>中高并发（&gt; 线程池大小）</strong>：虚拟线程开始展现优势——<strong>主要体现为 P99 延迟大幅降低</strong>，因为请求不会被卡在线程池队列里排队。</li>
<li><strong>超高并发（5x~10x 线程池大小）</strong>：传统线程池直接崩（大量拒绝/超时），虚拟线程依然稳定。QPS 提升幅度取决于 I/O 等待占比——等待越多，收益越大。</li>
</ol>

<h2 id="如何验证你自己的结果"><a href="#如何验证你自己的结果" class="headerlink" title="如何验证你自己的结果"></a>如何验证你自己的结果</h2>

<ol>
<li>启动应用：<code>java -jar your-app.jar --spring.profiles.active=traditional</code> 先跑一轮</li>
<li>用 wrk/JMeter 按上述方案压测，记录数据</li>
<li>切 profile：<code>--spring.profiles.active=virtual-thread</code> 再跑一轮</li>
<li>对比两张表的数据，重点关注：<strong>P99 延迟</strong> 和 <strong>Error Rate</strong></li>
<li>额外验证：访问 <code>/api/demo/thread-info</code>，确认 <code>"isVirtual": true</code></li>
</ol>

<h1 id="Spring-Boot-集成要点"><a href="#Spring-Boot-集成要点" class="headerlink" title="Spring Boot 集成要点"></a>Spring Boot 集成要点</h1>

<h2 id="1-版本要求"><a href="#1-版本要求" class="headerlink" title="1. 版本要求"></a>1. 版本要求</h2>

<table>
<thead><tr><th>组件</th><th>最低版本</th><th>推荐版本</th></tr></thead>
<tbody>
<tr><td>JDK</td><td>21（LTS）</td><td>21 LTS</td></tr>
<tr><td>Spring Boot</td><td>3.2（预览）</td><td>3.4+（正式支持）</td></tr>
<tr><td>Tomcat</td><td>11+（内嵌于 SB 3.2+）</td><td>自动满足</td></tr>
</tbody>
</table>

<h2 id="2-开启虚拟线程的完整配置"><a href="#2-开启虚拟线程的完整配置" class="headerlink" title="2. 开启虚拟线程的完整配置"></a>2. 开启虚拟线程的完整配置</h2>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span></span><br><span class="line">  <span class="attr">tomcat:</span></span><br><span class="line">    <span class="attr">threads:</span></span><br><span class="line">      <span class="attr">max:</span> <span class="number">200</span>  <span class="comment"># 虚拟线程模式下此配置不再限制并发，可忽略</span></span><br><span class="line"></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br><span class="line"></span><br><span class="line"><span class="comment"># JVM 参数建议（可选但有帮助）</span></span><br><span class="line"><span class="comment"># jdk.virtualThreadScheduler.parallelism=N</span></span><br><span class="line"><span class="comment">#   → 控制调度器并行度（默认 = CPU 核心数）</span></span><br><span class="line"><span class="comment"># jdk.virtualThreadScheduler.maxPoolSize=N</span></span><br><span class="line"><span class="comment">#   → 控制调度器的最大载体线程数（默认 = CPU 核心数）</span></span><br></pre></td></table></figure>

<h2 id="3-自定义-Async-也走虚拟线程"><a href="#3-自定义-Async-也走虚拟线程" class="headerlink" title="3. 自定义 @Async 也走虚拟线程"></a>3. 自定义 @Async 也走虚拟线程</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Configuration</span></span><br><span class="meta">@EnableAsync</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">AsyncConfig</span> <span class="keyword">implements</span> <span class="title class_">AsyncConfigurer</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Override</span></span><br><span class="line">    <span class="keyword">public</span> Executor <span class="title">getAsyncExecutor</span><span class="params">()</span> {</span><br><span class="line">        <span class="keyword">return</span> Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>();</span><br><span class="line">    }</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// 使用</span></span><br><span class="line"><span class="meta">@Async</span></span><br><span class="line"><span class="keyword">public</span> CompletableFuture&lt;String&gt; <span class="title">doSomethingAsync</span><span class="params">()</span> { ... }</span><br></pre></td></table></figure>

<h1 id="常见坑与误区（必读）"><a href="#常见坑与误区（必读）" class="headerlink" title="常见坑与误区（必读）"></a>常见坑与误区（必读）</h1>

<h2 id="坑-1：synchronized-导致-pin-（最常见）"><a href="#坑-1：synchronized-导致-pin-（最常见）" class="headerlink" title="坑 1：synchronized 导致 pin（最常见）"></a>坑 1：synchronized 导致 pin（最常见）</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：synchronized 会导致 pin</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title">badMethod</span><span class="params">()</span> {</span><br><span class="line">    doSomethingBlocking();  <span class="comment">// 虚拟线程无法卸载，一直占着载体线程！</span></span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：用 ReentrantLock 替代</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock <span class="variable">lock</span> <span class="operator">=</span> <span class="keyword">new</span> <span class="title class_">ReentrantLock</span>();</span><br><span class="line"></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">void</span> <span class="title">goodMethod</span><span class="params">()</span> {</span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> {</span><br><span class="line">        doSomethingBlocking();  <span class="comment">// 可以正常卸载 ✅</span></span><br><span class="line">    } <span class="keyword">finally</span> {</span><br><span class="line">        lock.unlock();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p><strong>如何检测 pin 问题？</strong>启动时加 JVM 参数：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">-Djdk.tracePinnedThreads=<span class="string">short</span>  <span class="comment"># 打印 pinned 线程的短堆栈</span></span><br></pre></td></table></figure>

<p>控制台会输出类似警告：</p>

<figure class="highlight plaintext"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">Thread[#38,ForkJoinPool-1-worker-3,Virtual,pinned] ... sun.misc.Unsafe.park(Native Method)</span><br></pre></td></table></figure>

<h2 id="坑-2：ThreadLocal-内存爆炸"><a href="#坑-2：ThreadLocal-内存爆炸" class="headerlink" title="坑 2：ThreadLocal 内存爆炸"></a>坑 2：ThreadLocal 内存爆炸</h2>

<p>虚拟线程可能创建百万级数量。如果你的代码里每个请求都往 <code>ThreadLocal</code> 塞数据（比如请求上下文、鉴权信息、TraceId），那内存会直接炸。</p>

<p><strong>解决方案</strong>：</p>
<ul>
<li>迁移到 <strong>ScopedValue</strong>（JDK 21 预览，JDK 23 正式）：专为虚拟线程设计的「作用域值」传递机制</li>
<li>或者减少 ThreadLocal 数据体积，确保及时清理</li>
</ul>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ScopedValue 示例（推荐替代 ThreadLocal）</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">final</span> <span class="keyword">static</span> ScopedValue&lt;UserInfo&gt; USER_INFO = ScopedValue.newInstance();</span><br><span class="line"></span><br><span class="line"><span class="comment">// 在 Filter/Interceptor 中绑定</span></span><br><span class="line">ScopedValue.<span class="built_in">where</span>(USER_INFO, userInfo).run(() -&gt; {</span><br><span class="line">    <span class="comment">// 整个调用链都能通过 UserInfo.current() 访问</span></span><br><span class="line">    handleRequest();</span><br><span class="line">});</span><br><span class="line"></span><br><span class="line"><span class="comment">// 在任意深度获取</span></span><br><span class="line">UserInfo info = USER_INFO.get();</span><br></pre></td></table></figure>

<h2 id="坑-3：连接池不够用了"><a href="#坑-3：连接池不够用了" class="headerlink" title="坑 3：连接池不够用了"></a>坑 3：连接池不够用了</h2>

<p>以前 200 个线程 → HikariCP 默认 10 个连接就够分了（10:1）。现在虚拟线程能开 5000 个并发请求 → 全部同时打数据库 → 连接池瞬间干满。</p>

<p><strong>对策</strong>：适当增大数据库/Redis/HTTP 连接池大小，但要结合数据库实例的实际承受能力来调。</p>

<figure class="yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.yml — HikariCP 连接池调参示例</span></span><br><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">datasource:</span></span><br><span class="line">    <span class="attr">hikari:</span></span><br><span class="line">      <span class="attr">maximum-pool-size:</span> <span class="number">50</span>  <span class="comment"># 从默认 10 往上调（具体值看 DB 承受力）</span></span><br></pre></td></table></figure>

<h2 id="坑-4：虚拟线程不等于更快"><a href="#坑-4：虚拟线程不等于更快" class="headerlink" title="坑 4：虚拟线程不等于更快"></a>坑 4：虚拟线程不等于更快</h2>

<p>单个请求的总耗时不会变少（150ms 的 I/O 等待还是 150ms）。虚拟线程解决的是<strong>吞吐量和资源利用率</strong>问题，不是让单次请求变快。不要拿它当加速器。</p>

<h2 id="坑-5：不要池化虚拟线程"><a href="#坑-5：不要池化虚拟线程" class="headerlink" title="坑 5：不要池化虚拟线程"></a>坑 5：不要池化虚拟线程</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：不要尝试创建“虚拟线程池”</span></span><br><span class="line"><span class="comment">// Executors.newFixedThreadPool(200) 即使包装虚拟线程也没意义</span></span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：每次任务一个新虚拟线程，JVM 会自动调度</span></span><br><span class="line"><span class="keyword">try</span> (<span class="keyword">var</span> executor = Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()) {</span><br><span class="line">    executor.submit(task);</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>虚拟线程足够轻量（创建 ~200ns，栈在堆上按需分配），<strong>不需要复用</strong>。线程池存在的初衷是避免频繁创建/销毁平台线程的开销，这个痛点在虚拟线程身上不存在。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发模型的一次<strong>范式转移</strong>：</p>

<table>
<thead><tr><th>✅ 适合</th><th>❌ 不适合</th></tr></thead>
<tbody>
<tr><td>I/O 密集型 Web 服务</td><td>CPU 密集型计算</td></tr>
<tr><td>遗留同步代码改造（不改写法就能升吞吐）</td><td>已高度优化的 Netty/WebFlux 异步架构</td></tr>
<tr><td>快速原型 &amp; 内部工具开发</td><td>对延迟极其敏感的场景（虚拟线程调度有额外开销）</td></tr>
<tr><td>降低运维复杂度（不用再纠结线程池配多少）</td><td>JDK &lt; 21 的老项目（升级成本高）</td></tr>
</tbody>
</table>

<p><strong>落地建议</strong>：</p>
<ol>
<li>新项目（JDK 21+ Spring Boot 3.4+）：直接开 <code>spring.threads.virtual.enabled=true</code>，几乎零成本。</li>
<li>老项目：先在非核心路径试水，收集 <code>-Djdk.tracePinnedThreads=short</code> 日志排查 pin 问题。</li>
<li>一定要压测！不同业务的 I/O 等待比例不同，收益差距很大。</li>
<li>关注连接池：并发上来之后，下游资源的连接池是新的瓶颈点。</li>
</ol>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>[Oracle 官方] JEP 444: Virtual Threads</strong><br>OpenJDK 官方提案，虚拟线程的完整设计与决策记录<br><a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>

<li><strong>[Spring 官方] Spring Framework 6.1 Virtual Threads Support</strong><br>Spring 对虚拟线程的官方集成文档<br><a target="_blank" rel="noopener" href="https://docs.spring.io/spring-framework/reference/integration/virtual-threads.html">https://docs.spring.io/spring-framework/reference/integration/virtual-threads.html</a></li>

<li><strong>[Ron Pressler] Virtual Threads: New Possibilities</strong>（Oracle 虚拟线程主设计师的深度分享）<br>介绍设计哲学、pin 问题、与 Loom 项目的关系<br><a target="_blank" rel="noopener" href="https://inside.java/2023/07/21/virtual-threads-new-possibilities/">https://inside.java/2023/07/21/virtual-threads-new-possibilities/</a></li>

<li><strong>[Per Minborg] Virtual Threads vs. CompletableFuture vs. RxJava</strong><br>多种并发模型的代码风格与性能对比<br><a target="_blank" rel="noopener" href="https://minborgsjavapot.blogspot.com/2023/04/java-virtual-threads-completablefuture.html">https://minborgsjavapot.blogspot.com/2023/04/java-virtual-threads-completablefuture.html</a></li>

<li><strong>[Baeldung] Guide to Java 21 Virtual Threads</strong><br>涵盖 API 用法、最佳实践、常见陷阱的综合教程<br><a target="_blank" rel="noopener" href="https://www.baeldung.com/java-21-virtual-threads">https://www.baeldung.com/java-21-virtual-threads</a></li>

<li><strong>[美团技术团队] Java 虚拟线程在服务端的实践与思考</strong><br>国内大厂在生产环境中落地虚拟线程的经验（含踩坑记录与监控方案）<br><a target="_blank" rel="noopener" href="https://tech.meituan.com/2024/03/01/java-virtual-threads-practice.html">https://tech.meituan.com/2024/03/01/java-virtual-threads-practice.html</a></li>

<li><strong>[阿里云开发者社区] 从线程池到虚拟线程：Java 并发编程演进</strong><br>中文视角的演进路线图，适合作为补充阅读理解「为什么要搞虚拟线程」<br><a target="_blank" rel="noopener" href="https://developer.aliyun.com/article/1521234">https://developer.aliyun.com/article/1521234</a></li>
</ol>
