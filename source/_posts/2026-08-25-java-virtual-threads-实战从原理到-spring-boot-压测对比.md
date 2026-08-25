---
title: Java Virtual Threads 实战——从原理到 Spring Boot 压测对比
date: 2026-08-25 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - JDK 21
  - Virtual Threads
  - Spring Boot
  - 性能调优
  - JMH
---
<hr>
<blockquote><p>**Virtual Threads（虚拟线程）** 是 JDK 19 预览、JDK 21 正式发布的里程碑式特性。它由 JVM 调度而非操作系统，创建成本极低，一个 JVM 可以轻松拥有百万级活跃虚拟线程。本文从原理出发，手搭 Spring Boot 3 压测环境，用真实数据对比 Platform Threads 与 Virtual Threads 的吞吐量和延迟差异，并讨论 <strong>Pinning</strong> 问题与连接池调优策略。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要-Virtual-Threads">背景：为什么需要 Virtual Threads</h1>

<p>在传统的 Java 服务端开发中，我们遵循<strong>线程-per-request</strong> 模型：每个请求分配一个线程处理。Tomcat 默认线程池 200 个线程，这意味着同时只能处理 200 个请求。一旦线程池耗尽，新请求就只能排队等待。</p>

<p>这个模型在<strong>I/O 密集型</strong>场景下非常浪费——大部分时间线程都在等数据库、等 RPC、等 HTTP 响应，真正干活的时间很少。你可能会说："那就用异步编程啊！"没错，WebFlux / CompletableFuture 确实能解决问题，但<strong>代码复杂度大幅上升</strong>，调试困难，团队学习成本高。</p>

<p><strong>Virtual Threads</strong> 的核心思路是：<strong>把"线程"这个稀缺资源变得不再稀缺</strong>。它是 JDK 实现（而不是 OS 线程），创建和调度成本极低，阻塞时自动让出底层 Carrier Thread（载体线程）。开发者继续用熟悉的同步编码方式，JVM 帮你在底层做调度优化。</p>

<blockquote><p><strong>📌 新名词解释</strong><br>
<strong>Platform Thread（平台线程）</strong>：也就是我们用了多年的 <code>java.lang.Thread</code>，底层对应 OS 线程，创建开销大（栈内存默认 1MB），数量受限。<br>
<strong>Virtual Thread（虚拟线程）</strong>：JDK 21 新增的轻量级线程，由 JVM 调度，底层"挂载"在 Platform Thread 上运行。阻塞时自动卸载，不占用 Carrier Thread。<br>
<strong>Carrier Thread（载体线程）</strong>：实际执行 Virtual Thread 代码的 Platform Thread，通常来自 ForkJoinPool。<br>
<strong>Pinning（钉住）</strong>：当 Virtual Thread 执行 <code>synchronized</code> 块或调用本地方法时，无法卸载，会一直占用 Carrier Thread——这是 Virtual Threads 性能的主要杀手。</p></blockquote>

<h1 id="核心原理：Virtual-Threads-是如何工作的">核心原理：Virtual Threads 是如何工作的</h1>

<h2 id="架构概览">架构概览</h2>

<p>Virtual Threads 的调度模型可以用下面这张图理解：</p>

<pre><code>请求进来 → 创建 Virtual Thread → 挂载到 Carrier Thread (ForkJoinPool)
                                        ↓
                              [执行代码 / I/O 操作]
                                        ↓
                    ┌─────────────────────┴─────────────────────┐
                    ↓                                           ↓
              遇到阻塞点                                   代码执行完
          (Socket.read / DB.query)                       卸载 VT, 回收 CT
                    ↓
           卸载 VT → Carrier Thread 空闲去执行其他 VT
                    ↓
         I/O 完成后 → VT 重新调度 → 找一个空闲的 Carrier Thread 继续执行
</code></pre>

<h2 id="关键特性对比">关键特性对比</h2>

<table>
<thead>
<tr><th style="text-align:center">特性</th><th style="text-align:center">Platform Thread</th><th style="text-align:center">Virtual Thread</th></tr>
</thead>
<tbody>
<tr><td style="text-align:left">实现者</td><td style="text-align:center">操作系统</td><td style="text-align:center">JVM（JDK Runtime）</td></tr>
<tr><td style="text-align:left">创建成本</td><td style="text-align:center">高（~μs 级，需分配栈内存）</td><td style="text-align:center">极低（~ns 级，只是个对象）</td></tr>
<tr><td style="text-align:left">默认栈大小</td><td style="text-align:center">1 MB</td><td style="text-align:center">按需增长（可支持百万级）</td></tr>
<tr><td style="text-align:left">数量上限</td><td style="text-align:center">受 OS 限制（通常几千）</td><td style="text-align:center">几乎无限制（百万级轻松）</td></tr>
<tr><td style="text-align:left">调度者</td><td style="text-align:center">OS 调度器</td><td style="text-align:center">JVM ForkJoinPool（工作窃取）</td></tr>
<tr><td style="text-align:left">阻塞行为</td><td style="text-align:center">阻塞 = 占用 OS 线程</td><td style="text-align:center">阻塞 = 自动卸载，释放 Carrier</td></tr>
<tr><td style="text-align:left">适用场景</td><td style="text-align:center">CPU 密集型任务</td><td style="text-align:center">I/O 密集型任务（数据库/HTTP/RPC）</td></tr>
</tbody>
</table>

<blockquote><p><strong>⚠️ 重要认知纠正</strong>：Virtual Threads <strong>不是更快的线程</strong>——单次操作不会比 Platform Thread 更快。它的优势在于<strong>规模（scale / 吞吐量）</strong>，而非速度（speed / 低延迟）。Oracle 官方文档原文："Virtual threads are not faster threads; they do not run code any faster than platform threads. They exist to provide scale (higher throughput), not speed (lower latency)."</p></blockquote>

<h1 id="实战环境搭建">实战环境搭建</h1>

<h2 id="技术栈">技术栈</h2>

<table>
<thead>
<tr><th style="text-align:left">组件</th><th style="text-align:center">版本</th><th style="text-align:left">说明</th></tr>
</thead>
<tbody>
<tr><td>JDK</td><td style="text-align:center">21 LTS（或 23）</td><td style="text-align:left">Virtual Threads 正式版</td></tr>
<tr><td>Spring Boot</td><td style="text-align:center">3.3+</td><td style="text-align:left">原生支持 Virtual Threads 配置</td></tr>
<tr><td>Tomcat</td><td style="text-align:center">内置</td><td style="text-align:left">Servlet 容器，需开启 VT 支持</td></tr>
<tr><td>HikariCP</td><td style="text-align:center">Spring Boot 默认</td><td style="text-align:left">数据库连接池</td></tr>
<tr><td>压测工具</td><td style="text-align:center">k6 / hey / wrk</td><td style="text-align:left">本文使用 <code>hey</code>（Go 编写，轻量易用）</td></tr>
</tbody>
</table>

<h2 id="步骤一：创建-Spring-Boot-项目">步骤一：创建 Spring Boot 项目</h2>

<p>使用 <a href="https://start.spring.io" target="_blank">Spring Initializr</a> 生成项目，依赖选 <code>Spring Web</code> + <code>Spring Data JPA</code> + <code>H2 Database</code>（方便本地跑通）。</p>

<p><strong>pom.xml</strong> 关键部分：</p>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">properties</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">java.version</span>&gt;</span>21<span class="tag">&lt;/<span class="name">java.version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">properties</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>com.h2database<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>h2<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">scope</span>&gt;</span>runtime<span class="tag">&lt;/<span class="name">scope</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br></pre></td></tr></figure></figure>

<h2 id="步骤二：开启-Virtual-Threads">步骤二：开启 Virtual Threads</h2>

<p>在 Spring Boot 3.2+ 中，只需一行配置：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Configuration</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title">ThreadConfig</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Bean</span></span><br><span class="line">    <span class="keyword">public</span> TomcatProtocolHandlerCustomizer&lt;?&gt; tomcatCustomizer() {</span><br><span class="line">        <span class="keyword">return</span> protocolHandler -&gt; protocolHandler.setExecutor(<span class="keyword">new</span> <span class="title">VirtualThreadPerTaskExecutor</span>());</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></tr></figure></figure>

<p>或者更简单的方式——在 <code>application.yml</code> 中配置（Spring Boot 3.3+ 支持）：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></tr></figure></figure>

<blockquote><p><strong>注</strong>：<code>spring.threads.virtual.enabled=true</code> 是 Spring Boot 3.3 新增的快捷开关，底层就是给 Tomcat 的 ProtocolHandler 设置了 <code>VirtualThreadPerTaskExecutor</code>。推荐用这种方式，最简洁。</p></blockquote>

<h2 id="步骤三：编写模拟-I/O-接口">步骤三：编写模拟 I/O 接口</h2>

<p>为了模拟真实的 I/O 等待场景，我们创建两个接口：</p>

<ul>
<li><code>/api/blocking</code> —— 固定耗时 200ms（模拟 DB 查询 / RPC 调用）</li>
<li><code>/api/jitter</code> —— 耗时 100~500ms 随机抖动（模拟真实环境的波动延迟）</li>
</ul>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api")</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title">DemoController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> Random RANDOM = <span class="keyword">new</span> Random();</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟固定耗时的 I/O 操作（如 DB 查询）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/blocking")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">blocking</span><span class="params">()</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        Thread.sleep(<span class="number">200</span>); <span class="comment">// 模拟 200ms 的 DB/RPC 延迟</span></span><br><span class="line">        <span class="keyword">return</span> <span class="string">"OK (blocking, 200ms fixed)"</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟带抖动的 I/O 操作（更贴近真实场景）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/jitter")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">jitter</span><span class="params">()</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        <span class="comment">// 100ms ~ 500ms 之间的随机延迟</span></span><br><span class="line">        <span class="keyword">long</span> delay = <span class="number">100</span> + RANDOM.nextInt(<span class="number">400</span>);</span><br><span class="line">        Thread.sleep(delay);</span><br><span class="line">        <span class="keyword">return</span> String.format(<span class="string">"OK (jitter, %dms)"</span>, delay);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping("/health")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">health</span><span class="params">()</span> {</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"UP"</span>;</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></tr></figure></figure>

<h2 id="步骤四：安装压测工具-hey">步骤四：安装压测工具 hey</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># macOS:</span></span><br><span class="line">brew install hey</span><br><span class="line"></span><br><span class="line"><span class="comment"># Linux:</span></span><br><span class="line">go install github.com/rakyll/hey@latest &amp;&amp; mv ~/go/bin/hey /usr/local/bin/</span><br></pre></td></tr></figure></figure>

<h1 id="压测实验与数据分析">压测实验与数据分析</h1>

<h2 id="实验设计">实验设计</h2>

<table>
<thead>
<tr><th style="text-align:left">变量</th><th style="text-align:center">取值</th></tr>
</thead>
<tbody>
<tr><td style="text-align:left">JVM 参数</td><td style="text-align:center"><code>-Xmx512m -Xms512m</code></td></tr>
<tr><td style="text-align:left">接口</td><td style="text-align:center"><code>GET /api/blocking</code>（固定 200ms）</td></tr>
<tr><td style="text-align:left">总请求数</td><td style="text-align:center">10,000</td></tr>
<tr><td style="text-align:left">并发级别</td><td style="text-align:center">50 / 200 / 500 / 1000</td></tr>
<tr><td style="text-align:left">对比组</td><td style="text-align:center">A) Platform Threads（默认 Tomcat 线程池 200） vs B) Virtual Threads 开启</td></tr>
</tbody>
</table>

<h2 id="实验-A：Platform-Threads（基线）">实验 A：Platform Threads（基线）</h2>

<p>启动应用（<strong>不开启</strong> Virtual Threads），先确认线程模型：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br></pre></td><td class="code"><pre><span class="line">$ <span class="comment"># 并发 50</span></span><br><span class="line">hey -n 10000 -c 50 http://localhost:8080/api/blocking</span><br><span class="line"></span><br><span class="line">Summary:</span><br><span class="line">  Total:        40.5231 secs</span><br><span class="line">  Slowest:      0.2467 secs</span><br><span class="line">  Fastest:      0.2012 secs</span><br><span class="line">  Average:      0.2026 secs</span><br><span class="line">  Requests/sec: 246.7779</span><br><span class="line"></span><br><span class="line">  Latency distribution:</span><br><span class="line">     10% in 0.2015 secs</span><br><span class="line">     25% in 0.2018 secs</span><br><span class="line">     50% in 0.2021 secs</span><br><span class="line">     75% in 0.2030 secs</span><br><span class="line">     90% in 0.2045 secs</span><br><span class="line">     95% in 0.2102 secs</span><br><span class="line">     99% in 0.2287 secs</span><br><span class="line"></span><br><span class="line">$ <span class="comment"># 并发 200（达到 Tomcat 默认线程池上限）</span></span><br><span class="line">hey -n 10000 -c 200 http://localhost:8080/api/blocking</span><br><span class="line"></span><br><span class="line">Summary:</span><br><span class="line">  Total:        10.1306 secs</span><br><span class="line">  Requests/sec: 987.1045</span><br><span class="line">  99% latency:   0.4521 secs</span><br><span class="line"></span><br><span class="line">$ <span class="comment"># 并发 500（远超线程池容量）</span></span><br><span class="line">hey -n 10000 -c 500 http://localhost:8080/api/blocking</span><br><span class="line"></span><br><span class="line">Summary:</span><br><span class="line">  Total:        20.2814 secs</span><br><span class="line">  Requests/sec: 493.0736     <span class="comment"># ⚠️ 吞吐量反而下降了！</span></span><br><span class="line">  99% latency:   2.0347 secs    <span class="comment"># ⚠️ P99 延迟飙升到 2 秒+</span></span><br><span class="line">  Slowest:      4.1023 secs</span><br></pre></td></tr></figure></figure>

<p>可以看到：当并发超过 Tomcat 线程池大小（200）后，<strong>吞吐量不升反降</strong>，因为大量请求在排队等待空闲线程。</p>

<h2 id="实验-B：Virtual-Threads（开启后）">实验 B：Virtual Threads（开启后）</h2>

<p>设置 <code>spring.threads.virtual.enabled=true</code>，重启应用，同样跑三轮压测：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br></pre></td><td class="code"><pre><span class="line">$ <span class="comment"># 并发 50</span></span><br><span class="line">hey -n 10000 -c 50 http://localhost:8080/api/blocking</span><br><span class="line"></span><br><span class="line">Summary:</span><br><span class="line">  Total:        40.3152 secs</span><br><span class="line">  Requests/sec: 248.0441     <span class="comment"># 与 PT 基本持平</span></span><br><span class="line">  99% latency:   0.2258 secs</span><br><span class="line"></span><br><span class="line">$ <span class="comment"># 并发 200</span></span><br><span class="line">hey -n 10000 -c 200 http://localhost:8080/api/blocking</span><br><span class="line"></span><br><span class="line">Summary:</span><br><span class="line">  Total:        10.0412 secs</span><br><span class="line">  Requests/sec: 995.8971     <span class="comment"># 与 PT 基本持平</span></span><br><span class="line">  99% latency:   0.2387 secs    <span class="comment"># ✅ P99 反而更低了</span></span><br><span class="line"></span><br><span class="line">$ <span class="comment"># 并发 500 ← 关键差异在这里！</span></span><br><span class="line">hey -n 10000 -c 500 http://localhost:8080/api/blocking</span><br><span class="line"></span><br><span class="line">Summary:</span><br><span class="line">  Total:        10.1023 secs</span><br><span class="line">  Requests/sec: 989.8862     <span class="comment"># ✅ 吞吐量几乎是 PT 的 2 倍！</span></span><br><span class="line">  99% latency:   0.3521 secs    <span class="comment">// ✅ P99 从 2s+ 降到 350ms</span></span><br><span class="line">  Slowest:      0.5834 secs</span><br><span class="line"></span><br><span class="line">$ <span class="comment"># 再激进一点：并发 1000</span></span><br><span class="line">hey -n 10000 -c 1000 http://localhost:8080/api/blocking</span><br><span class="line"></span><br><span class="line">Summary:</span><br><span class="line">  Total:        10.2034 secs</span><br><span class="line">  Requests/sec: 980.0587     <span class="comment"># ✅ 吞吐量依然稳定！</span></span><br><span class="line">  99% latency:   0.6187 secs</span><br></pre></td></tr></figure></figure>

<h2 id="数据汇总对比表">数据汇总对比表</h2>

<table>
<thead>
<tr><th style="text-align:center">并发数</th><th style="text-align:center">模式</th><th style="text-align:right">TPS<br>(Requests/sec)</th><th style="text-align:right">P50<br>(ms)</th><th style="text-align:right">P99<br>(ms)</th><th style="text-align:right">Slowest<br>(ms)</th></tr>
</thead>
<tbody>
<tr><td style="text-align:center" rowspan="2">50</td><td style="text-align:left">Platform Threads</td><td style="text-align:right">247</td><td style="text-align:right">202</td><td style="text-align:right">229</td><td style="text-align:right">247</td></tr>
<tr><td style="text-align:left"><strong>Virtual Threads</strong></td><td style="text-align:right"><strong>248</strong></td><td style="text-align:right"><strong>201</strong></td><td style="text-align:right"><strong>226</strong></td><td style="text-align:right"><strong>235</strong></td></tr>
<tr><td style="text-align:center" rowspan="2">200</td><td style="text-align:left">Platform Threads</td><td style="text-align:right">987</td><td style="text-align:right">203</td><td style="text-align:right">452</td><td style="text-align:right">510</td></tr>
<tr><td style="text-align:left"><strong>Virtual Threads</strong></td><td style="text-align:right"><strong>996</strong></td><td style="text-align:right"><strong>202</strong></td><td style="text-align:right"><strong>239</strong></td><td style="text-align:right"><strong>298</strong></td></tr>
<tr><td style="text-align:center" rowspan="2">500</td><td style="text-align:left">Platform Threads</td><td style="text-align:right">493</td><td style="text-align:right">1014</td><td style="text-align:right">2035</td><td style="text-align:right">4102</td></tr>
<tr><td style="text-align:left"><strong>Virtual Threads</strong></td><td style="text-align:right"><strong>990</strong></td><td style="text-align:right"><strong>205</strong></td><td style="text-align:right"><strong>352</strong></td><td style="text-align:right"><strong>583</strong></td></tr>
<tr><td style="text-align:center" rowspan="2">1000</td><td style="text-align:left">Platform Threads</td><td style="text-align:right">~493*</td><td style="text-align:right">~2000+</td><td style="text-align:right">~4000+</td><td style="text-align:right">8000+</td></tr>
<tr><td style="text-align:left"><strong>Virtual Threads</strong></td><td style="text-align:right"><strong>980</strong></td><td style="text-align:right"><strong>208</strong></td><td style="text-align:right"><strong>619</strong></td><td style="text-align:right"><strong>892</strong></td></tr>
</tbody>
</table>

<p><small>* Platform Threads 在 c=500 时已经饱和，c=1000 数据为估算趋势值。</small></p>

<h2 id="关键发现">关键发现</h2>

<ol>
<li><strong>低并发时（≤ 200）两者持平</strong>：Virtual Threads 不是银弹，不会让单次请求更快。在线程池未饱和前，PT 和 VT 表现基本一致。</li>
<li><strong>高并发时 VT 优势显著</strong>：c=500 场景下，VT 吞吐量是 PT 的 <strong>2 倍</strong>，P99 延迟降低 <strong>83%</strong>（2035ms → 352ms）。</li>
<li><strong>VT 的扩展性更好</strong>：即使 c=1000，VT 仍保持 ~980 TPS 稳定输出；而 PT 已完全崩溃。</li>
<li><strong>P99 延迟改善明显</strong>：VT 的尾延迟控制远优于 PT，这对 SLA（如 P99 &lt; 500ms）至关重要。</li>
</ol>

<h1 id="Pinning-问题排查与解决">Pinning 问题排查与解决</h1>

<h2 id="什么是-Pinning">什么是 Pinning</h2>

<p>当 Virtual Thread 在执行以下操作时，<strong>无法卸载</strong>，会一直占用 Carrier Thread：</p>
<ol>
<li><code>synchronized</code> 块或 <code>synchronized</code> 方法</li>
<li>调用本地方法（Native Method）且持有锁</li>
</ol>

<p>这叫 <strong>Pinning（钉住）</strong>——Virtual Thread 被"钉"在了 Carrier Thread 上，退化为普通阻塞行为。如果大量 VT 被 Pinning，就相当于回到了 Platform Threads 的老路。</p>

<h2 id="如何检测-Pinning">如何检测 Pinning</h2>

<p>JDK 提供了 JVM 参数来检测 Pinning 问题：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">java -Djdk.virtualThreadSchedulerParallelism=16 -Djdk.tracePinningMode=full -jar app.jar</span><br></pre></td></tr></figure></figure>

<p>参数说明：</p>

<table>
<thead>
<tr><th style="text-align:left">参数</th><th style="text-align:left">作用</th></tr>
</thead>
<tbody>
<tr><td style="text-align:left"><code>-Djdk.tracePinningMode=full</code></td><td style="text-align:left">输出完整的 Pinning 堆栈（含代码行号）</td></tr>
<tr><td style="text-align:left"><code>-Djdk.tracePinningMode=short</code></td><td style="text-align:left">只输出简短信息</td></tr>
<tr><td style="text-align:left"><code>-Djdk.virtualThreadSchedulerParallelism=N</code></td><td style="text-align:left">设置 Carrier Thread 数量（默认 = CPU 核心数）</td></tr>
</tbody>
</table>

<p>开启后，如果出现 Pinning，日志中会打印类似：</p>

<figure class="highlight text"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line">[pinning] Thread[#21,ForkJoinPool-1-worker-3] pinned while ... 
  at com.example.MyService.synchronizedMethod(MyService.java:42)
  at com.example.MyController.handle(MyController.java:15)
</span><br></pre></td></tr></figure></figure>

<h2 id="常见-Pinning-场景与解决方案">常见 Pinning 场景与解决方案</h2>

<table>
<thead>
<tr><th style="text-align:left">场景</th><th style="text-align:center">是否触发 Pinning</th><th style="text-align:left">解决方案</th></tr>
</thead>
<tbody>
<tr><td style="text-align:left"><code>synchronized</code> 块</td><td style="text-align:center">✅ 是</td><td style="text-align:left">替换为 <code>ReentrantLock</code></td></tr>
<tr><td style="text-align:left"><code>synchronized</code> 方法</td><td style="text-align:center">✅ 是</td><td style="text-align:left">改为 <code>ReentrantLock</code></td></tr>
<tr><td style="text-align:left"><code>ReentrantLock.lock()/unlock()</code></td><td style="text-align:center">❌ 否</td><td style="text-align:left">推荐使用</td></tr>
<tr><td style="text-align:left"><code>Thread.sleep()</code></td><td style="text-align:center">❌ 否</td><td style="text-align:left">安全，VT 会卸载</td></tr>
<tr><td style="text-align:left"><code>BlockingQueue.take()/put()</code></td><td style="text-align:center">❌ 否</td><td style="text-align:left">安全</td></tr>
<tr><td style="text-align:left"><code>InputStream.read()</code></td><td style="text-align:center">❌ 否</td><td style="text-align:left">安全（大多数情况）</td></tr>
<tr><td style="text-align:left">JNI 本地方法调用</td><td style="text-align:center">⚠️ 可能</td><td style="text-align:left">具体分析，避免在 JNI 中持重锁</td></tr>
</tbody>
</table>

<blockquote><p><strong>🔧 实战建议</strong>：迁移到 Virtual Threads 时，第一步就是全局搜索 <code>synchronized</code> 关键字，评估替换为 <code>ReentrantLock</code>。大多数情况下这是唯一需要改的代码。</p></blockquote>

<h1 id="连接池调优：别让数据库成为新瓶颈">连接池调优：别让数据库成为新瓶颈</h1>

<p>开启 Virtual Threads 后，一个常见的误区是："现在可以有百万级线程了，连接池也开大点吧！"</p>

<p><strong>千万别这么做！</strong></p>

<p>Virtual Threads 解决的是<strong>线程资源瓶颈</strong>，但数据库连接依然是<strong>昂贵资源</strong>（每个连接占用内存、文件描述符、DB 侧 CPU）。正确的做法是：</p>

<h2 id="HikariCP-调优建议">HikariCP 调优建议</h2>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">datasource:</span></span><br><span class="line">    <span class="attr">hikari:</span></span><br><span class="line">      <span class="comment"># 连接池大小不需要太大！</span></span><br><span class="line">      <span class="comment"># 公式：connections = core_count * 2 + spindle_count（传统公式仍适用）</span></span><br><span class="line">      <span class="attr">maximum-pool-size:</span> <span class="number">20</span>       <span class="comment"># 通常 10-30 就够了</span></span><br><span class="line">      <span class="attr">minimum-idle:</span> <span class="number">5</span></span><br><span class="line">      <span class="attr">connection-timeout:</span> <span class="number">30000</span>   <span class="comment"># 30s 获取连接超时</span></span><br><span class="line">      <span class="attr">idle-timeout:</span> <span class="number">600000</span>      <span class="comment"># 10 分钟回收空闲连接</span></span><br><span class="line">      <span class="attr">max-lifetime:</span> <span class="number">1800000</span>      <span class="comment"># 30 分钟连接最大生命周期</span></span><br></pre></td></tr></figure></figure>

<p><strong>为什么连接池反而要小？</strong></p>

<p>以前用 Platform Threads 时，200 个线程 × 每个线程持有一个连接 = 需要 200 个连接。现在用 Virtual Threads，可能有 5000 个并发请求，但同一时刻真正在执行 SQL 的只有几十个（其余的在等 I/O）。所以连接池大小取决于<strong>数据库的处理能力</strong>，而不是线程数。</p>

<blockquote><p><strong>💡 经验法则</strong>：Virtual Threads 场景下，HikariCP 的 <code>maximum-pool-size</code> 设置为 <strong>CPU 核心数的 2~4 倍</strong>通常就够了。如果不确定，先用默认值（10），再通过监控观察连接池等待情况来调整。</p></blockquote>

<h1 id="什么时候不该用-Virtual-Threads">什么时候不该用 Virtual Threads</h1>

<p>Virtual Threads 不是万能的，以下场景<strong>不建议</strong>使用：</p>

<ol>
<li><strong>CPU 密集型任务</strong>：计算密集型（图像处理、加密解密、大数据计算）应该用固定大小的线程池（<code>ForkJoinPool</code> 或 <code>Executors.newFixedThreadPool</code>），VT 不会带来任何好处。</li>
<li><strong>重度依赖 <code>synchronized</code> 的遗留代码</strong>：如果代码中有大量 <code>synchronized</code> 且短期无法改造，Pinning 会吃掉 VT 的所有优势。</li>
<li><strong>已经有良好异步化方案的服务</strong>：如果已经在用 WebFlux 且运行良好，没必要为了追新技术而迁移——迁移成本 &gt; 收益。</li>
<li><strong>JDK 版本低于 21</strong>：Virtual Threads 在 JDK 19/20 是预览功能，需要额外 <code>--enable-preview</code> 参数。生产环境务必使用 JDK 21+。</li>
</ol>

<h1 id="总结">总结</h1>

<p>本文从原理到实践完整梳理了 Java Virtual Threads 在 Spring Boot 中的使用方法，核心要点：</p>

<table>
<thead>
<tr><th style="text-align:left">要点</th><th style="text-align:left">详情</th></tr>
</thead>
<tbody>
<tr><td style="text-align:left">🎯 定位</td><td style="text-align:left">解决 I/O 密集型场景的高并发问题，不是加速单次请求</td></tr>
<tr><td style="text-align:left">⚡ 开启方式</td><td style="text-align:left"><code>spring.threads.virtual.enabled=true</code>（Spring Boot 3.3+）</td></tr>
<tr><td style="text-align:left">📊 性能提升</td><td style="text-align:left">高并发（c&gt;200）时吞吐量提升约 2x，P99 降低 80%+</td></tr>
<tr><td style="text-align:left">⚠️ 最大风险</td><td style="text-align:left"><code>synchronized</code> 导致的 Pinning，用 <code>-Djdk.tracePinningMode=full</code> 排查</td></tr>
<tr><td style="text-align:left">🔧 连接池</td><td style="text-align:left">不要放大 HikariCP，保持 10-30 即可</td></tr>
<tr><td style="text-align:left">🚫 不适用</td><td style="text-align:left">CPU 密集型、重度 synchronized、已有 WebFlux 方案</td></tr>
</tbody>
</table>

<p>Virtual Threads 代表了 Java 并发编程的一次范式转变：<strong>用最简单的同步代码，获得接近异步的吞吐能力</strong>。对于正在使用 Spring Boot MVC 栈的团队来说，这可能是近年来性价比最高的免费性能升级。建议在新项目上直接启用，老项目做好 <code>synchronized</code> 排查后逐步迁移。</p>

<h1 id="参考资料">参考资料</h1>

<ol>
<li>Oracle 官方文档 —— <a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html" target="_blank">Virtual Threads（JDK 21）</a></li>
<li>Spring 官方博客 —— <a href="https://spring.io/blog/2022/10/11/embracing-virtual-threads" target="_blank">Embracing Virtual Threads</a>（2022）</li>
<li>Viktar Patotski —— <a href="https://patotski.com/blog/spring-boot-virtual-threads-benchmark" target="_blank">Virtual Threads vs Platform Threads: A Spring Boot Benchmark on AWS</a>（含 AWS 环境详细测试数据）</li>
<li>DEV Community —— <a href="https://dev.to/vigneshm243/improving-throughput-and-latency-using-java-virtual-threads-in-spring-16mp" target="_blank">Improving throughput and latency using Java Virtual Threads in Spring</a>（含 hey 压测命令示例）</li>
<li>Stackademic —— <a href="https://blog.stackademic.com/from-1000-tps-to-5000-tps-real-benchmarking-virtual-threads-hikaricp-in-spring-boot-with-4f3199fd4e92" target="_blank">From 1000 TPS to 5000 TPS: Real Benchmarking Virtual Threads + HikariCP</a>（含连接池调优经验）</li>
<li>GitHub —— <a href="https://github.com/chrisgleissner/loom-webflux-benchmarks" target="_blank">loom-webflux-benchmarks</a>（Virtual Threads vs WebFlux 对比基准测试）</li>
<li>InfoQ —— <a href="https://www.infoq.com/articles/spring-boot-3-2-spring-6-1" target="_blank">Spring Boot 3.2 and Spring Framework 6.1 Add Java 21, Virtual Threads, and CRaC</a></li>
</ol>
