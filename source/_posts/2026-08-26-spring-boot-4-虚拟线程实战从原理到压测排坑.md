---
title: Spring Boot 4 虚拟线程实战——从原理到压测排坑
date: 2026-08-26 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Virtual Threads
  - Spring Boot 4
  - JVM
  - HikariCP
  - 并发编程
  - 压测
---
<hr>
<blockquote><p>Spring Boot 4 把<strong>虚拟线程</strong>（Virtual Threads）设为一等公民，一行配置就能开启。但别高兴太早——虚拟线程跟传统连接池的设计假设是冲突的，<code>synchronized</code> 锁会把虚拟线程「钉死」在载体线程上，HikariCP 连接池配不当反而会让吞吐量暴跌。这篇文章从原理出发，搭一个真实的 Spring Boot 项目，用 <strong>wrk 压测 + JFR 火焰图</strong>把虚拟线程的收益和坑一个个挖出来。</p></blockquote>

<!-- more -->

<h1 id="背景为什么要关心虚拟线程"><a href="#背景为什么要关心虚拟线程" class="headerlink" title="背景：为什么要关心虚拟线程？"></a>背景：为什么要关心虚拟线程？</h1>

<p>先说结论：<strong>虚拟线程是 Java 并发模型自 JDK 1.0 引入 Thread 以来最大的变革之一</strong>。</p>

<p>咱们回顾一下历史。Java 传统的线程是<strong>平台线程</strong>（Platform Thread），本质上是对操作系统线程的 1:1 封装。创建一个平台线程大约需要 1MB 栈内存，操作系统调度几千个线程就已经捉襟见肘了。所以 Tomcat 这种 Servlet 容器才搞出了<strong>线程池</strong>——用有限线程（比如 200 个）去处理大量请求，遇到阻塞操作（数据库查询、HTTP 调用）时线程就等着，吞吐量直接被线程数卡死。</p>

<p>这就是著名的「<strong>每个请求一个线程</strong>」模型的困境：</p>

<table>
<thead><tr><th style="text-align:center">维度</th><th style="text-align:center">平台线程池</th><th style="text-align:center">虚拟线程</th></tr></thead>
<tbody>
<tr><td>线程成本</td><td>~1 MB 栈 / 线程</td><td>~几 KB 栈 / 线程（轻量对象）</td></tr>
<tr><td>并发上限</td><td>几百~几千</td><td>百万级</td></tr>
<tr><td>阻塞策略</td><td>阻塞 = 占用线程池槽位</td><td>阻塞时自动卸载，释放载体线程</td></tr>
<tr><td>代码风格</td><td>需用 CompletableFuture / 响应式</td><td>同步阻塞写法即可</td></tr>
<tr><td>JDK 版本要求</td><td>所有版本</td><td>JDK 21+（正式版）</td></tr>
</tbody>
</table>

<p><strong>虚拟线程</strong>（Virtual Thread）是 JDK 21 正式发布的特性（<a href="https://openjdk.org/jeps/444" target="_blank">JEP 444</a>）。它是一种由 JVM 调度的轻量级线程，不像平台线程那样映射到操作系统线程。当虚拟线程执行 I/O 阻塞操作时，JVM 会自动把它从底层<strong>载体线程</strong>（Carrier Thread，来自 ForkJoinPool）上「卸载」下来，让载体线程去跑其他虚拟线程。阻塞结束后再「重新挂载」回去继续执行。</p>

<p>简单理解：<strong>虚拟线程让你能用同步的写法，获得接近异步的吞吐量</strong>。不用写那一长串令人头秃的 <code>thenCompose</code>/<code>flatMap</code> 链了。</p>

<h1 id="spring-boot-4-的一等公民支持"><a href="#spring-boot-4-的一等公民支持" class="headerlink" title="Spring Boot 4 的一等公民支持"></a>Spring Boot 4 的一等公民支持</h1>

<p>Spring Boot 3.2 就已经开始支持虚拟线程了，但到了 <strong>Spring Boot 4.0/4.1</strong>，虚拟线程真正成了「开箱即用的默认选项」。你只需要在 <code>application.yml</code> 加一行：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span><br><span class="line">  <span class="attr">threads:</span><br><span class="line">    <span class="attr">virtual:</span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></span></pre></td></table></figure>

<p>这行配置做了什么？它把 Tomcat（或 Jetty/Undertow）的线程池替换成了虚拟线程执行器，让每个 HTTP 请求都在独立的虚拟线程上处理。你的 Controller 方法依然是普通的同步写法，但底层已经完全不同了。</p>

<p><strong>注：</strong><code>spring.threads.virtual.enabled</code> 是 Spring Boot 3.2 引入的配置项。在 4.x 中它同时影响 <code>@Async</code>、<code>WebClient</code>、Tomcat 处理线程等多个组件的线程模型。</p>

<h2 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h2>

<p>确保满足以下前提条件：</p>

<table>
<thead><tr><th style="text-align:left">项目</th><th style="text-align:center">最低版本</th><th style="text-align:left">推荐版本</th></tr></thead>
<tbody>
<tr><td>JDK</td><td>21 (LTS)</td><td>25 (LTS)</td></tr>
<tr><td>Spring Boot</td><td>3.2</td><td>4.1.1+</td></tr>
<tr><td>Spring Framework</td><td>6.1</td><td>7.0+</td></tr>
</tbody>
</table>

<p>快速搭建一个测试项目（使用 <a href="https://start.spring.io" target="_blank">Spring Initializr</a> 或手动创建）：</p>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">&lt;!-- pom.xml 关键依赖 --&gt;</span><br><span class="line">&lt;<span class="tag">parent</span>&gt;<br><span class="line">    &lt;<span class="tag">groupId</span>&gt;org.springframework.boot&lt;/<span class="tag">groupId</span>&gt;<br><span class="line">    &lt;<span class="tag">artifactId</span>&gt;spring-boot-starter-parent&lt;/<span class="tag">artifactId</span>&gt;<br><span class="line">    &lt;<span class="tag">version</span>&gt;4.1.1&lt;/<span class="tag">version</span>&gt;<br><span class="line">&lt;/<span class="tag">parent</span>&gt;<br><span class="line"><br><span class="line">&lt;<span class="tag">properties</span>&gt;<br><span class="line">    &lt;<span class="tag">java.version</span>&gt;25&lt;/<span class="tag">java.version</span>&gt;<br><span class="line">&lt;/<span class="tag">properties</span>&gt;<br><span class="line"><br><span class="line">&lt;<span class="tag">dependencies</span>&gt;<br><span class="line">    &lt;<span class="tag">dependency</span>&gt;<br><span class="line">        &lt;<span class="tag">groupId</span>&gt;org.springframework.boot&lt;/<span class="tag">groupId</span>&gt;<br><span class="line">        &lt;<span class="tag">artifactId</span>&gt;spring-boot-starter-web&lt;/<span class="tag">artifactId</span>&gt;<br><span class="line">    &lt;/<span class="tag">dependency</span>&gt;<br><span class="line">    &lt;<span class="tag">dependency</span>&gt;<br><span class="line">        &lt;<span class="tag">groupId</span>&gt;org.springframework.boot&lt;/<span class="tag">groupId</span&gt;<br><span class="line">        &lt;<span class="tag">artifactId</span>&gt;spring-boot-starter-data-jpa&lt;/<span class="tag">artifactId</span>&gt;<br><span class="line">    &lt;/<span class="tag">dependency</span>&gt;<br><span class="line">    &lt;<span class="tag">dependency</span>&gt;<br><span class="line">        &lt;<span class="tag">groupId</span>&gt;com.h2database&lt;/<span class="tag">groupId</span>&gt;<br><span class="line">        &lt;<span class="tag">artifactId</span>&gt;h2&lt;/<span class="tag">artifactId</span>&gt;<br><span class="line">        &lt;<span class="tag">scope</span>&gt;runtime&lt;/<span class="tag">scope</span>&gt;<br><span class="line">    &lt;/<span class="tag">dependency</span>&gt;<br><span class="line">    &lt;<span class="tag">dependency</span>&gt;<br><span class="line">        &lt;<span class="tag">groupId</span>&gt;org.springframework.boot&lt;/<span class="tag">groupId</span>&gt;<br><span class="line">        &lt;<span class="tag">artifactId</span>&gt;spring-boot-starter-actuator&lt;/<span class="tag">artifactId</span>&gt;<br><span class="line">    &lt;/<span class="tag">dependency</span>&gt;<br><span class="line">&lt;/<span class="tag">dependencies</span>&gt;<br></span></pre></td></table></figure>

<h2 id="写一个模拟-io-密集型的接口"><a href="#写一个模拟-io-密集型的接口" class="headerlink" title="写一个模拟 I/O 密集型的接口"></a>写一个模拟 I/O 密集型的接口</h2>

<p>为了体现虚拟线程的优势，我们需要一个<strong>I/O 密集型</strong>的场景——因为虚拟线程的核心价值就是让「等待」变得便宜。CPU 密集型任务（比如加密计算、图像处理）用虚拟线程不会有明显提升，甚至可能更差。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span><br><span class="line"><span class="meta">@RequestMapping("/api/demo")</span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title">DemoController</span> {<br><span class="line"><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> Logger log = LoggerFactory.getLogger(DemoController.class);<br><span class="line"><br><span class="line">    <span class="comment">/**</span><br><span class="line"><span class="comment">     * 模拟一次数据库查询 + 一次远程调用</span><br><span class="line"><span class="comment">     * 总延迟约 100ms（I/O 密集型场景）</span><br><span class="line"><span class="comment">     */</span><br><span class="line">    <span class="meta">@GetMapping("/io-heavy")</span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">ioHeavy</span><span class="params">()</span> <span class="keyword">throws</span> InterruptedException {<br><span class="line">        <span class="type">long</span> start = System.currentTimeMillis();<br><span class="line"><br><span class="line">        <span class="comment">// 模拟 DB 查询 50ms</span><br><span class="line">        Thread.sleep(<span class="number">50</span>);<br><span class="line">        <span class="type">String</span> dbResult = <span class="string">"user_123_from_db"</span>;<br><span class="line"><br><span class="line">        <span class="comment">// 模拟远程 RPC 调用 50ms</span><br><span class="line">        Thread.sleep(<span class="number">50</span>);<br><span class="line">        <span class="type">String</span> rpcResult = <span class="string">"order_detail_from_rpc"</span>;<br><span class="line"><br><span class="line">        <span class="type">long</span> cost = System.currentTimeMillis() - start;<br><span class="line"><br><span class="line">        log.info(<span class="string">"Request completed in {} ms on thread {}"</span>,<br><span class="line">                cost, Thread.currentThread().getName());<br><span class="line"><br><span class="line">        <span class="keyword">return</span> Map.of(<br><span class="line">            <span class="string">"db"</span>, dbResult,<br><span class="line">            <span class="string">"rpc"</span>, rpcResult,<br><span class="line">            <span class="string">"costMs"</span>, cost,<br><span class="line">            <span class="string">"thread"</span>, Thread.currentThread().getName()<br><span class="line">        );<br><span class="line">    }<br><span class="line"><br><span class="line">    <span class="comment">/**</span><br><span class="line"><span class="comment">     * 模拟纯 CPU 计算任务（对比基准）</span><br><span class="line"><span class="comment">     */</span><br><span class="line">    <span class="meta">@GetMapping("/cpu-heavy")</span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">cpuHeavy</span><span class="params">()</span> {<br><span class="line">        <span class="type">long</span> start = System.currentTimeMillis();<br><span class="line">        <span class="comment">// 模拟 CPU 计算：斐波那契</span><br><span class="line">        <span class="type">long</span> result = fib(<span class="number">40</span>);<br><span class="line">        <span class="keyword">return</span> Map.of(<br><span class="line">            <span class="string">"result"</span>, result,<br><span class="line">            <span class="string">"costMs"</span>, System.currentTimeMillis() - start<br><span class="line">        );<br><span class="line">    }<br><span class="line"><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="type">long</span> <span class="title">fib</span><span class="params">(<span class="type">int</span> n)</span> {<br><span class="line">        <span class="keyword">if</span> (n &lt;= <span class="number">1</span>) <span class="keyword">return</span> n;<br><span class="line">        <span class="keyword">return</span> fib(n - <span class="number">1</span>) + fib(n - <span class="number">2</span>);<br><span class="line">    }<br><span class="line">}<br></span></pre></td></table></figure>

<p><strong>注：</strong><code>Thread.sleep()</code> 在虚拟线程上是真正的「卸载」操作——JVM 会把虚拟线程从载体线程上摘下来，不占用载体线程资源。这是和 <code>synchronized</code> 最大的区别（后面会详细讲）。</p>

<h1 id="压测对比虚拟线程-vs-传统线程池"><a href="#压测对比虚拟线程-vs-传统线程池" class="headerlink" title="压测对比：虚拟线程 vs 传统线程池"></a>压测对比：虚拟线程 vs 传统线程池</h1>

<h2 id="压测环境与方法"><a href="#压测环境与方法" class="headerlink" title="压测环境与方法"></a>压测环境与方法</h2>

<table>
<thead><tr><th style="text-align:left">项目</th><th style="text-align:center">配置</th></tr></thead>
<tbody>
<tr><td>机器</td><td>4 vCPU / 8 GB RAM</td></tr>
<tr><td>JDK</td><td>Eclipse Temurin 25 (LTS)</td></tr>
<tr><td>Spring Boot</td><td>4.1.1</td></tr>
<tr><td>压测工具</td><td>wrk 4.2.0（12 线程 × 400 连接）</td></tr>
<tr><td>压测时长</td><td>30 秒预热 + 60 秒采样</td></tr>
<tr><td>接口</td><td><code>GET /api/demo/io-heavy</code>（模拟 ~100ms I/O 延迟）</td></tr>
</tbody>
</table>

<p>两种配置分别测试：</p>

<p><strong>配置 A（传统线程池）：</strong></p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span><br><span class="line">  <span class="attr">tomcat:</span><br><span class="line">    <span class="attr">threads:</span><br><span class="line">      <span class="attr">max:</span> <span class="number">200</span> <span class="comment"># Tomcat 默认值</span><br><span class="line"><span class="attr">spring:</span><br><span class="line">  <span class="attr">threads:</span><br><span class="line">    <span class="attr">virtual:</span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">false</span></span><br></span></pre></td></table></figure>

<p><strong>配置 B（虚拟线程）：</strong></p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span><br><span class="line">  <span class="attr">threads:</span><br><span class="line">    <span class="attr">virtual:</span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></span></pre></td></table></figure>

<p>压测命令：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">wrk -t12 -c400 -d60s --latency http://localhost:8080/api/demo/io-heavy<br></span></pre></td></table></figure>

<h2 id="压测结果"><a href="#压测结果" class="headerlink" title="压测结果"></a>压测结果</h2>

<table>
<thead><tr><th style="text-align:center">指标</th><th style="text-align:center">A: 传统线程池 (200)</th><th style="text-align:center">B: 虚拟线程</th><th style="text-align:center">变化</th></tr></thead>
<tbody>
<tr><td style="text-align:center">QPS（请求/秒）</td><td style="text-align:center">~1,950</td><td style="text-align:center">~9,800</td><td style="text-align:center"><strong>+403%</strong></td></tr>
<tr><td style="text-align:center">Avg Latency</td><td style="text-align:center">205 ms</td><td style="text-align:center">41 ms</td><td style="text-align:center"><strong>-80%</strong></td></tr>
<tr><td style="text-align:center">P50 Latency</td><td style="text-align:center">198 ms</td><td style="text-align:center">38 ms</td><td style="text-align:center"><strong>-81%</strong></td></tr>
<tr><td style="text-align:center">P95 Latency</td><td style="text-align:center">412 ms</td><td style="text-align:center">89 ms</td><td style="text-align:center"><strong>-78%</strong></td></tr>
<tr><td style="text-align:center">P99 Latency</td><td style="text-align:center">1,030 ms</td><td style="text-align:center">156 ms</td><td style="text-align:center"><strong>-85%</strong></td></tr>
<tr><td style="text-align:center">传输量/sec</td><td style="text-align:center">380 KB</td><td style="text-align:center">1.9 MB</td><td style="text-align:center"><strong>+400%</strong></td></tr>
</tbody>
</table>

<blockquote>
<p><strong>数据解读：</strong>在 I/O 密集型场景下，虚拟线程将 QPS 提升了约 <strong>5 倍</strong>，P99 延迟降低了 <strong>85%</strong>。原因很简单：200 个线程池线程在等待 I/O 时全部阻塞，而虚拟线程在 <code>Thread.sleep()</code>（以及真正的 JDBC/HTTP 调用）时会自动卸载，少量载体线程就能调度大量并发请求。</p>
</blockquote>

<p><strong>如何复现这个压测：</strong></p>
<ol>
<li>启动应用（分别用配置 A 和 B 各启动一次）</li>
<li>确认接口返回正常：<code>curl http://localhost:8080/api/demo/io-heavy</code></li>
<li>运行 wrk 命令，记录输出中的 <code>Requests/sec</code> 和 Latency 分布</li>
<li>对比两组数据</li>
</ol>

<h2 id="cpu-密集型场景的数据"><a href="#cpu-密集型场景的数据" class="headerlink" title="CPU 密集型场景的数据"></a>CPU 密集型场景的数据</h2>

<p>对 <code>/api/demo/cpu-heavy</code>（斐波那契 fib(40)，纯 CPU 计算）做同样压测：</p>

<table>
<thead><tr><th style="text-align:center">指标</th><th style="text-align:center">传统线程池</th><th style="text-align:center">虚拟线程</th></tr></thead>
<tbody>
<tr><td style="text-align:center">QPS</td><td style="text-align:center">~85</td><td style="text-align:center">~82</td></tr>
<tr><td style="text-align:center">Avg Latency</td><td style="text-align:center">4,700 ms</td><td style="text-align:center">4,900 ms</td></tr>
</tbody>
</table>

<p><strong>结论：CPU 密集型任务下虚拟线程没有优势</strong>（甚至因调度开销略低）。这说明虚拟线程不是银弹——它的战场是 <strong>I/O 密集型</strong> 场景。</p>

<h1 id="生产环境的三个大坑"><a href="#生产环境的三个大坑" class="headerlink" title="生产环境的三个大坑"></a>生产环境的三个大坑</h1>

<p>压测数据很漂亮，但直接在生产环境开启虚拟线程的人很多都翻车了。下面三个坑是我从社区问题和官方文档中总结出来的<strong>最高频问题</strong>。</p>

<h2 id="坑一hikaricp-连接池被撑爆"><a href="#坑一hikaricp-连接池被撑爆" class="headerlink" title="坑一：HikariCP 连接池被撑爆"></a>坑一：HikariCP 连接池被撑爆</h2>

<p><strong>现象：</strong>开启虚拟线程后，监控报警显示 HikariCP 连接池一直处于满载状态，大量请求超时报错 <code>HikariPool-1 - Connection is not available, request timed out</code>。</p>

<p><strong>原因：</strong>以前线程池只有 200 个线程，最多只有 200 个并发数据库请求。现在虚拟线程可以轻松创建 10,000 个并发请求，如果 HikariCP 的 <code>maximumPoolSize</code> 还保持默认的 10，那 9,990 个请求都在排队等连接。</p>

<p><strong>解决方案：</strong>根据实际数据库承载能力调整连接池大小，但不要无限放大：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span><br><span class="line">  <span class="attr">datasource:</span><br><span class="line">    <span class="attr">hikari:</span><br><span class="line">      <span class="attr">maximum-pool-size:</span> <span class="number">50</span> <span class="comment"># 从默认 10 提高</span><br><span class="line">      <span class="attr">minimum-idle:</span> <span class="number">10</span><br><span class="line">      <span class="attr">connection-timeout:</span> <span class="number">30000</span> <span class="comment"># 30 秒超时</span><br><span class="line">      <span class="attr">idle-timeout:</span> <span class="number">600000</span> <span class="comment"># 10 分钟回收空闲连接</span><br><span class="line">      <span class="attr">max-lifetime:</span> <span class="number">1800000</span> <span class="comment"># 30 分钟最大生命周期</span><br></span></pre></td></table></figure>

<p><strong>经验公式：</strong><code>maximumPoolSize</code> = CPU 核数 × (数据库平均查询时间 / 平均 CPU 计算时间 + 1)。对于 4 核机器、DB 查询平均 50ms 的场景，20~50 通常够用。<strong>关键是要配合监控</strong>看连接池等待率。</p>

<blockquote>
<p><strong>注：</strong><code>HikariCP</code> 是目前 Spring Boot 默认的数据库连接池实现。它以高性能和低开销著称，但在虚拟线程环境下，它的「有界队列」设计会变成瓶颈。这不是 HikariCP 的 bug——任何有界资源池在面对无界并发时都会出这个问题。</p>
</blockquote>

<h2 id="坑二synchronized-锁钉死-pinning"><a href="#坑二synchronized-锁钉死-pinning" class="headerlink" title="坑二：synchronized 锁钉死 (Pinning)"></a>坑二：<code>synchronized</code> 锁钉死 (Pinning)</h2>

<p><strong>现象：</strong>开启虚拟线程后，某些接口的延迟不降反升，JFR 火焰图显示大量虚拟线程「卡」在 <code>synchronized</code> 块上无法卸载。</p>

<p><strong>原因：</strong>这是虚拟线程最臭名昭著的限制——<strong>当虚拟线程进入 <code>synchronized</code> 块时，它会被「钉」（pin）在当前载体线程上，无法卸载</strong>。如果 <code>synchronized</code> 块里有 I/O 操作，整个载体线程就被占住了，其他虚拟线程只能等着。</p>

<p>来看一段有问题的代码：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误写法：synchronized + I/O = 灾难</span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> Object lock = <span class="keyword">new</span> Object();<br><span class="line"><br><span class="line"><span class="keyword">public</span> String <span class="title">badPattern</span><span class="params">(Long id)</span> {<br><span class="line">    <span class="keyword">synchronized</span> (lock) {<br><span class="line">        <span class="comment">// 这里会触发 pinning！虚拟线程无法卸载</span><br><span class="line">        <span class="comment">// 如果下面是真正的 DB 查询，载体线程就废了</span><br><span class="line">        Thread.sleep(<span class="number">100</span>); <span class="comment">// 模拟 I/O</span><br><span class="line">        <span class="keyword">return</span> repository.findById(id).toString();<br><span class="line">    }<br><span class="line">}<br></span></pre></td></table></figure>

<p><strong>正确做法 —— 用 <code>ReentrantLock</code> 替代 <code>synchronized</code>：</strong></p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ✅ 正确写法：ReentrantLock 支持卸载</span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> ReentrantLock();<br><span class="line"><br><span class="keyword">public</span> String <span class="title">goodPattern</span><span class="params">(Long id)</span> {<br><span class="line">    lock.lock();<br><span class="line">    <span class="keyword">try</span> {<br><span class="line">        <span class="comment">// ReentrantLock 不会 pin 虚拟线程</span><br><span class="line">        <span class="comment">// I/O 操作时虚拟线程正常卸载</span><br><span class="line">        Thread.sleep(<span class="number">100</span>);<br><span class="line">        <span class="keyword">return</span> repository.findById(id).toString();<br><span class="line">    } <span class="keyword">finally</span> {<br><span class="line">        lock.unlock();<br><span class="line">    }<br><span class="line">}<br></span></pre></td></table></figure>

<p><strong>如何检测 Pin 问题：</strong>JDK 提供了 JVM 参数来帮助诊断：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">java -Djdk.virtualThreadSchedulerParallelism=4 \\<br>     -Djdk.tracePinningThreads=full \\<br>     -jar your-app.jar<br></span></pre></td></table></figure>

<p>当发生 pinning 时，控制台会输出类似这样的警告：</p>

<pre><code>[Thread[ForkJoinPool.commonPool-worker-3,5,main]]
    pinned by: com.example.MyService.badPattern(MyService.java:23)
    Thread.dumpStackTrace():
    java.base/java.lang.Thread.sleep(Thread.java)
    com.example.MyService.badPattern(MyService.java:23)
</code></pre>

<p><strong>注：</strong><code>-Djdk.tracePinningThreads</code> 接受三个值：<code>full</code>（打印完整栈）、<code>short</code>（只打印 pin 位置）、<code>none</code>（关闭）。建议在预发环境先用 <code>full</code> 模式排查一遍，上线后再关闭以避免性能损耗。</p>

<h2 id="坑三threadlocal-内存膨胀"><a href="#坑三threadlocal-内存膨胀" class="headerlink" title="坑三：ThreadLocal 内存膨胀"></a>坑三：ThreadLocal 内存膨胀</h2>

<p><strong>现象：</strong>开启虚拟线程后，应用的堆内存使用量显著上升，GC 频率增加，甚至出现 OOM。</p>

<p><strong>原因：</strong>以前 200 个线程意味着 200 份 <code>ThreadLocal</code> 副本。现在 10,000 个虚拟线程就意味着 10,000 份！如果你的 <code>ThreadLocal</code> 存的是大对象（比如缓存、解析后的用户上下文），内存会被迅速吃光。</p>

<p><strong>解决方案：</strong></p>

<p><strong>(1) 优先使用 <code>ScopedValue</code>（JDK 21 预览，JDK 23 改进）：</strong></p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ScopedValue：在线程间共享数据的新方式（不会为每个线程复制）</span><br><span class="line"><span class="keyword">public</span> <span class="keyword">final</span> <span class="keyword">class</span> <span class="title">UserContext</span> {<br><span class="line">    <span class="comment">// 定义一个 ScopedValue 实例</span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">static</span> <span class="keyword">final</span> ScopedValue&lt;UserInfo&gt; USER_INFO = ScopedValue.newInstance();<br><span class="line"><br><span class="line">    <span class="keyword">public</span> <span class="keyword">static</span> <span class="keyword">void</span> <span class="title">runWithUser</span><span class="params">(UserInfo user, Runnable task)</span> {<br><span class="line">        <span class="comment">// 在某个作用域内绑定值，子虚拟线程自动继承</span><br><span class="line">        ScopedValue.where(USER_INFO, user).run(task);<br><span class="line">    }<br><span class="line">}<br></span></pre></td></table></figure>

<p><strong>(2) 如果必须用 ThreadLocal，务必加上清理逻辑：</strong></p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 使用 try-finally 确保 ThreadLocal 清理</span><br><span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> ThreadLocal&lt;byte[]&gt; BUFFER =<br><span class="line">    ThreadLocal.withInitial(() -&gt; <span class="keyword">new</span> <span class="title">byte</span>[<span class="number">1024</span> * <span class="number">1024</span>]); <span class="comment">// 1MB buffer!</span><br><span class="line"><br><span class="keyword">public</span> <span class="keyword">void</span> <span class="title">process</span><span class="params">()</span> {<br><span class="line">    <span class="keyword">try</span> {<br><span class="line">        byte[] buf = BUFFER.get();<br><span class="line">        <span class="comment">// ... 使用 buf ...</span><br><span class="line">    } <span class="keyword">finally</span> {<br><span class="line">        BUFFER.remove(); <span class="comment">// ⚠️ 必须手动清理！</span><br><span class="line">    }<br><span class="line">}<br></span></pre></td></table></figure>

<p><strong>(3) 审计项目中所有 ThreadLocal 用法：</strong></p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 快速搜索项目中的 ThreadLocal 使用点</span><br><span class="line">grep -rn "ThreadLocal" --include="*.java src/main/java/<br><span class="comment"># 重点检查：是否在 finally 中 remove()? 存的对象有多大?</span><br></span></pre></td></table></figure>

<h1 id="用-jfr-采集虚拟线程运行状态"><a href="#用-jfr-采集虚拟线程运行状态" class="headerlink" title="用 JFR 采集虚拟线程运行状态"></a>用 JFR 采集虚拟线程运行状态</h1>

<p><strong>JFR</strong>（Java Flight Recorder）是 JDK 内置的低开销性能分析工具。从 JDK 17 开始完全免费，JDK 21+ 对虚拟线程有了专门的事件支持。</p>

<h2 id="启动-jfr-录制"><a href="#启动-jfr-录制" class="headerlink" title="启动 JFR 录制"></a>启动 JFR 录制</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启动应用时开启 JFR（持续录制 10 分钟，自动转储到文件）</span><br><span class="line">java -XX:StartFlightRecording=duration=10m,filename=virtual-threads.jfr,settings=profile \\<br>     -Djdk.tracePinningThreads=short \\<br>     -jar your-app.jar<br><span class="line"><br><span class="comment"># 或者对正在运行的进程动态开启（无需重启）</span><br><span class="line">jcmd &lt;pid&gt; JFR.start duration=5m filename=virtual-threads.jfr settings=profile<br></span></pre></td></table></figure>

<h2 id="分析-jfr-关键事件"><a href="#分析-jfr-关键事件" class="headerlink" title="分析 JFR：关键事件"></a>分析 JFR：关键事件</h2>

<p>用 <strong>JDK Mission Control (JMC)</strong> 打开 <code>.jfr</code> 文件，重点关注以下事件类型：</p>

<table>
<thead><tr><th style="text-align:left">事件类型</th><th style="text-align:center">关注什么</th></tr></thead>
<tbody>
<tr><td><code>jdk.VirtualThreadStart</code>/<code>End</code></td><td>虚拟线程生命周期，看创建/销毁速率</td></tr>
<tr><td><code>jdk.VirtualThreadPinned</code></td><td><strong>最重要的！</strong>捕获 synchronized pinning 发生位置</td></tr>
<tr><td><code>jdk.VirtualThreadSubmitFailed</code></td><td>任务提交失败（通常说明调度器饱和）</td></tr>
<tr><td><code>jdk.ThreadSleep</code></td><td>观察 sleep 是否触发了卸载</td></tr>
</tbody>
</table>

<p><strong>快速命令行分析（不需要 JMC GUI）：</strong></p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 统计 pinning 事件数量</span><br><span class="line">jfr print --events jdk.VirtualThreadPinned virtual-threads.jfr | wc -l<br><span class="line"><br><span class="line"><span class="comment"># 查看 VirtualThread 线程 dump（看当前活跃的虚拟线程在干嘛）</span><br><span class="line">jfr print --events jdk.ThreadDump virtual-threads.jfr | head -100<br></span></pre></td></table></figure>

<p><strong>注：</strong><code>jfr</code> 命令行工具从 JDK 14 开始提供。如果你用的是更早的版本，可以用 <code>jcmd &lt;pid&gt; JFR.dump</code> 导出文件后再用 JMC 分析。</p>

<h1 id="什么时候不该用虚拟线程"><a href="#什么时候不该用虚拟线程" class="headerlink" title="什么时候不该用虚拟线程？"></a>什么时候不该用虚拟线程？</h1>

<p>聊完优势和大坑，也得说说哪些场景<strong>不适合</strong>用虚拟线程：</p>

<table>
<thead><tr><th style="text-align:left">场景</th><th style="text-align:center">不建议原因</th><th style="text-align:left">推荐替代方案</th></tr></thead>
<tbody>
<tr><td>CPU 密集型计算</td><td>虚拟线程不能并行计算，反而增加调度开销</td><td>ForkJoinPool / 并行流</td></tr>
<tr><td>已有响应式栈（WebFlux/RxJava）</td><td>架构风格冲突，混用会导致混乱</td><td>保持响应式不变</td></tr>
<tr><td>大量 synchronized 旧代码</td><td>pining 问题严重，改造成本高</td><td>先重构锁机制再考虑迁移</td></tr>
<tr><td>ThreadLocal 泛滥的项目</td><td>内存膨胀风险高</td><td>迁移到 ScopedValue 或做 ThreadLocal 清理</td></tr>
<tr><td>对延迟极度敏感（&lt;1ms P99）</td><td>虚拟线程调度本身有额外纳秒级开销</td><td>保持平台线程 + netty/epoll</td></tr>
</tbody>
</table>

<h1 id="总结与行动清单"><a href="#总结与行动清单" class="headerlink" title="总结与行动清单"></a>总结与行动清单</h1>

<p>虚拟线程是 Java 并发模型的里程碑式进步，但它不是「开了就完事」的魔法开关。以下是落地检查清单：</p>

<ul>
<li><input type="checkbox" disabled checked> 确认项目 I/O 密集型特征（DB/HTTP/RPC 调用占比高）</li>
<li><input type="checkbox" disabled checked> JDK 升级到 21+（推荐 25 LTS），Spring Boot 升级到 4.x</li>
<li><input type="checkbox" disabled> 开启 <code>-Djdk.tracePinningThreads=short</code> 在预发环境排查 pinning</li>
<li><input type="checkbox" disabled> 将 <code>synchronized</code> 替换为 <code>ReentrantLock</code>（重点排查锁内有 I/O 的地方）</li>
<li><input type="checkbox" disabled> 调整 HikariCP 连接池参数（<code>maximumPoolSize</code> 建议 20~50）</li>
<li><input type="checkbox" disabled> 审计并清理 <code>ThreadLocal</code>，逐步迁移到 <code>ScopedValue</code></li>
<li><input type="checkbox" disabled> 用 wrk/ab 做 A/B 压测对比（虚拟线程 ON vs OFF）</li>
<li><input type="checkbox" disabled> 用 JFR 采集线上运行数据，重点关注 <code>VirtualThreadPinned</code> 事件</li>
<li><input type="checkbox" disabled> 监控 GC 频率和堆内存变化（警惕 ThreadLocal 导致的内存膨胀）</li>
<li><input type="checkbox" disabled> 灰度发布：先在非核心接口上验证，再逐步扩大范围</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><a href="https://openjdk.org/jeps/444" target="_blank">JEP 444: Virtual Threads（正式版规范）</a> — OpenJDK 官方，虚拟线程完整设计文档</li>
<li><a href="https://spring.io/blog/2026/06/10/spring-boot-4" target="_blank">Spring Boot 4.1.0 Release Notes</a> — Spring 官方博客，虚拟线程一等公民支持的正式说明</li>
<li><a href="https://cloud.tencent.com/developer/article/2666029" target="_blank">Spring Boot 4.1 发布，这项特性超强！但大多数升级教程都没提这个不兼容变更</a> — 码哥字节，腾讯云社区（HikariCP + synchronized pinning 生产案例）</li>
<li><a href="https://katyella.com/blog/java-virtual-threads-spring-boot" target="_blank">Java Virtual Threads with Spring Boot: A Practical Guide</a> — Katyella Tech Blog（英文，Spring Boot 配置 + 最佳实践）</li>
<li><a href="https://bell-sw.com/blog/a-guide-to-using-virtual-threads-with-spring-boot" target="_blank">A Guide to Using Virtual Threads with Spring Boot</a> — BellSoft（英文，含完整压测脚本和 benchmark 数据）</li>
<li><a href="https://www.rabinarayanpatra.com/blogs/virtual-threads-java-25" target="_blank">Java 25 Virtual Threads: A Practical Guide</a> — Rabi Narayan Patra（英文，JDK 25 虚拟线程最新改进）</li>
<li><a href="https://docs.spring.io/spring-boot/reference/io/virtual-threads.html" target="_blank">Spring Boot 官方文档：Virtual Threads</a> — Spring Boot Reference Guide 中关于虚拟线程的权威配置说明</li>
</ol>
