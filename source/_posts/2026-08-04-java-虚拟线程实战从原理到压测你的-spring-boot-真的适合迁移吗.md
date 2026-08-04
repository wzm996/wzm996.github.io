---
title: Java 虚拟线程实战——从原理到压测，你的 Spring Boot 真的适合迁移吗？
date: 2026-08-04 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Virtual Threads
  - Project Loom
  - Spring Boot
  - JVM
  - 性能压测
---
<hr>
<blockquote><p>虚拟线程（Virtual Threads）是 JDK 21 正式发布的里程碑式特性，它让 Java 终于可以像 Go 协程一样轻松处理百万级并发。但"能用"和"用好"之间隔着不少坑——本文从底层原理出发，用真实压测数据告诉你：虚拟线程到底快在哪？什么时候该用？什么场景下反而更慢？以及 Spring Boot 项目如何安全迁移。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么我们需要虚拟线程"><a href="#背景：为什么我们需要虚拟线程" class="headerlink" title="背景：为什么我们需要虚拟线程"></a>背景：为什么我们需要虚拟线程</h1>

<p>在聊虚拟线程之前，我们先回顾一下 Java 传统并发模型的痛点。</p>

<p>你知道的，Java 从诞生第一天起就采用<strong>平台线程</strong>（Platform Thread，也就是我们常说的"操作系统线程"）来做并发。每个 <code>new Thread()</code> 都会对应一个 OS 线程。这个模型简单直观——<strong>一个请求一个线程</strong>（thread-per-request），代码写起来就是普通的顺序调用，阻塞就阻塞，非常符合人类思维。</p>

<p>但问题来了：<strong>OS 线程很贵</strong>。</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">平台线程</th>
<th style="text-align:center">虚拟线程</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">内存占用（约）</td>
<td style="text-align:center">~1 MB 栈空间</td>
<td style="text-align:center">~400 字节起</td>
</tr>
<tr>
<td style="text-align:center">创建开销</td>
<td style="text-align:center">高（需要系统调用）</td>
<td style="text-align:center">极低（纯用户态分配）</td>
</tr>
<tr>
<td style="text-align:center">上下文切换</td>
<td style="text-align:center">操作系统内核态</td>
<td style="text-align:center">JVM 用户态调度</td>
</tr>
<tr>
<td style="text-align:center">一台机器能跑多少个</td>
<td style="text-align:center">几千个就到头了</td>
<td style="text-align:center">百万级没问题</td>
</tr>
</tbody>
</table>

<p><strong>注：</strong>上表中的"平台线程"就是我们用了二十多年的普通 <code>java.lang.Thread</code>，它底层直接包装了一个操作系统内核线程。而"虚拟线程"是 JVM 在用户态自己调度的一种轻量级线程，多个虚拟线程可以复用少量的平台线程（叫<strong>载体线程 / Carrier Thread</strong>），有点像 Nginx 的事件循环模型，但对业务代码完全透明。</p>

<p>所以传统做法是什么？<strong>线程池</strong>。我们用固定大小的线程池来限制 OS 线程数量，比如 Tomcat 默认 200 个线程。请求来了从池里取一个线程，用完还回去。这招管用了二十年，但在高并发场景下暴露了致命缺陷：</p>

<ul>
<li><strong>线程池满了，请求就只能排队</strong>——P99 延迟飙升</li>
<li><strong>调参像玄学</>——CPU 密集型该设多少？IO 密集型又该设多少？</li>
<li><strong>代码被异步污染</strong>——为了绕开阻塞，大家被迫写 <code>CompletableFuture</code> 链式调用甚至 Reactive 代码，调试体验极差</li>
</ul>

<p>虚拟线程要解决的就是这个问题：<strong>让你继续用简单的阻塞代码，同时获得接近异步编程的性能</strong>。</p>

<h1 id="核心概念：虚拟线程是怎么工作的"><a href="#核心概念：虚拟线程是怎么工作的" class="headerlink" title="核心概念：虚拟线程是怎么工作的"></a>核心概念：虚拟线程是怎么工作的</h1>

<h2 id="基本使用"><a href="#基本使用" class="headerlink" title="基本使用"></a>基本使用</h2>

<p>先看一段最简单的代码对比：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 传统方式：平台线程（JDK 8+ 都能跑）</span></span><br><span class="line">Thread platformThread = <span class="keyword">new</span> Thread(() -&gt; {</span><br><span class="line">    System.out.println(<span class="string">"Hello from "</span> + Thread.currentThread());</span><br><span class="line">});</span><br><span class="line">platformThread.start();</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 新方式：虚拟线程（JDK 19 preview, JDK 21 正式）</span></span><br><span class="line">Thread virtualThread = Thread.ofVirtual().name(<span class="string">"my-vt"</span>).start(() -&gt; {</span><br><span class="line">    System.out.println(<span class="string">"Hello from "</span> + Thread.currentThread());</span><br><span class="line">});</span><br><span class="line"></span><br><span class="line"><span class="comment">// 或者更简洁的工厂方法</span></span><br><span class="line">Thread.startVirtualThread(() -&gt; {</span><br><span class="line">    System.out.println(<span class="string">"Hello from virtual thread"</span>);</span><br><span class="line">});</span><br></pre></td></table></figure>

<p>看起来没什么区别对吧？这就是虚拟线程设计的精髓——<strong>API 变化极小，心智负担几乎为零</strong>。</p>

<h2 id="调度模型：M-N-线程调度"><a href="#调度模型：M-N-线程调度" class="headerlink" title="调度模型：M:N 线程调度"></a>调度模型：M:N 线程调度</h2>

<p>虚拟线程的核心是一个 <strong>M:N 调度器</strong>：</p>

<ul>
<li><strong>M</strong> = 大量的虚拟线程（可以百万级）</li>
<li><strong>N</strong> = 少量的载体线程（默认等于 CPU 核心数）</li>
<li>JVM 的 <code>ForkJoinPool</code> 负责把 M 个虚拟线程"mount"到 N 个载体线程上执行</li>
</ul>

<p>关键机制——<strong>挂载（Mount）与卸载（Unmount）</strong>：</p>

<figure class="highlight plain"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line">graph LR
    A[VT-1 执行 IO 操作] -->|阻塞| B[VT-1 从 Carrier 卸载]
    C[VT-2 被挂载到 Carrier]
    C -->|阻塞| D[VT-2 卸载]
    A -->|IO 完成| E[VT-1 重新挂载执行]
    D -->|IO 完成| F[VT-2 重新挂载执行]
    style B fill:#f9f,stroke:#333
    style D fill:#f9f,stroke:#333</span><br></pre></td></table></figure>

<p>当虚拟线程执行到阻塞操作（如 <code>Thread.sleep()</code>、网络 IO、锁等待）时，JVM 会自动把它从载体线程上<strong>卸载</strong>下来，把载体线程让给其他虚拟线程用。等 IO 完成后，再找机会<strong>重新挂载</strong>上去继续执行。</p>

<p><strong>注：</strong>"卸载"这个操作是 JVM 自动完成的，不需要你写任何特殊代码。这也是为什么说"阻塞代码在虚拟线程里不再昂贵"——因为阻塞的不再是昂贵的 OS 线程，而是几乎零成本的虚拟线程。</p>

<h2 id="在-Spring-Boot-中启用虚拟线程"><a href="#在-Spring-Boot-中启用虚拟线程" class="headerlink" title="在 Spring Boot 中启用虚拟线程"></a>在 Spring Boot 中启用虚拟线程</h2>

<p>如果你用的是 Spring Boot 3.2+，启用虚拟线程只需要一行配置：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.yml</span></span><br><span class="line"><span class="string">spring:</span></span><br><span class="line">  <span class="string">threads:</span></span><br><span class="line">    <span class="string">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>

<p>就这么简单。Tomcat（或 Jetty/Undertow）的请求处理线程会被自动替换为虚拟线程。你原有的 <code>@Async</code>、<code>CompletableFuture</code>、同步 Controller 代码全部不用改。</p>

<p><strong>注：</strong><code>spring.threads.virtual.enabled=true</code> 是 Spring Boot 3.2 新增的配置项，它会将嵌入式 Servlet 容器的线程池替换为虚拟线程执行器。但注意：这<strong>只影响 HTTP 请求处理线程</strong>，不会影响你自己手动创建的线程池（如 <code>ThreadPoolTaskExecutor</code>）。如果你想让自定义的 <code>Executor</code> 也用虚拟线程，需要显式创建：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 创建一个使用虚拟线程的 ExecutorService</span></span><br><span class="line">ExecutorService virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();</span><br><span class="line">virtualExecutor.submit(() -&gt; doSomethingBlocking());</span><br></pre></td></table></figure>

<h1 id="压测数据：虚拟线程到底快多少"><a href="#压测数据：虚拟线程到底快多少" class="headerlink" title="压测数据：虚拟线程到底快多少"></a>压测数据：虚拟线程到底快多少</h1>

<p>光说不练假把式。下面我整理了来自多方基准测试的数据，覆盖不同场景。</p>

<h2 id="测试环境说明"><a href="#测试环境说明" class="headerlink" title="测试环境说明"></a>测试环境说明</h2>

<table>
<thead>
<tr>
<th style="text-align:center">参数</th>
<th style="text-align:center">值</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">JDK 版本</td>
<td style="text-align:center">OpenJDK / Eclipse Temurin 21+</td>
</tr>
<tr>
<td style="text-align:center">框架</td>
<td style="text-align:center">Spring Boot 3.2+ / 3.3</td>
</tr>
<tr>
<td style="text-align:center">数据库</td>
<td style="text-align:center">PostgreSQL / MySQL（JDBC）</td>
</tr>
<tr>
<td style="text-align:center">压测工具</td>
<td style="text-align:center">Apache JMeter / k6 / wrk</td>
</tr>
<tr>
<td style="text-align:center">并发级别</td>
<td style="text-align:center">200 ~ 1000 并发用户</td>
</tr>
</tbody>
</table>

<h2 id="场景一：IO密集型-REST-API-数据库查询为主"><a href="#场景一：IO密集型-REST-API-数据库查询为主" class="headerlink" title="场景一：IO 密集型 REST API（数据库查询为主）"></a>场景一：IO 密集型 REST API（数据库查询为主）</h2>

<p>这是虚拟线程的主战场——大量请求大部分时间都在等数据库/外部服务响应。</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">平台线程（200 线程池）</th>
<th style="text-align:center">虚拟线程（无限制）</th>
<th style="text-align:center">提升幅度</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">吞吐量（req/s）</td>
<td style="text-align:center">2,400</td>
<td style="text-align:center">8,700</td>
<td style="text-align:center"><strong>3.6x ⬆️</strong></td>
</tr>
<tr>
<td style="text-align:center">P99 延迟</td>
<td style="text-align:center">850 ms</td>
<td style="text-align:center">45 ms</td>
<td style="text-align:center"><strong>18.9x ⬇️</strong></td>
</tr>
<tr>
<td style="text-align:center">内存占用（10K 连接）</td>
<td style="text-align:center">~10 GB</td>
<td style="text-align:center">~50 MB</td>
<td style="text-align:center"><strong>200x ⬇️</strong></td>
</tr>
<tr>
<td style="text-align:center">请求失败率</td>
<td style="text-align:center">12.2%（线程池满拒绝）</td>
<td style="text-align:center">0%</td>
<td style="text-align:center">—</td>
</tr>
</tbody>
</table>

<p><strong>数据来源：</strong>MetaDesign Solutions 2025 年基准测试（Spring Boot 3.2 + PostgreSQL + 1000 并发）、Medium @mikemaza9 对比测试（Java 17 vs Java 21 相同负载）</p>

<p>为什么差距这么大？原因很简单：</p>

<ul>
<li><strong>平台线程池模式</strong>：200 个线程全在等数据库响应时，新来的请求只能排队→排队时间 = P99 延迟飙升</li>
<li><strong>虚拟线程模式</strong>：每个请求立刻获得一个虚拟线程，阻塞时自动让出载体线程→几乎没有排队</li>
</ul>

<h2 id="场景二：CPU密集型任务"><a href="#场景二：CPU密集型任务" class="headerlink" title="场景二：CPU 密集型任务"></a>场景二：CPU 密集型任务</h2>

<p>这是虚拟线程<strong>不擅长</strong>的场景，必须实事求是地展示数据：</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">平台线程（ForkJoinPool）</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">结论</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">吞吐量（计算密集）</td>
<td style="text-align:center">8,203 req/s</td>
<td style="text-align:center">8,153 req/s</td>
<td style="text-align:center">虚拟线程略低 0.63%</td>
</tr>
<tr>
<td style="text-align:center">平均延迟</td>
<td style="text-align:center">118 ms</td>
<td style="text-align:center">115 ms</td>
<td style="text-align:center">基本持平（2.5% 改善）</td>
</tr>
</tbody>
</table>

<p><strong>数据来源：</strong>NCIRL Vishesh Pandita 学位论文基准测试（2024）</p>

<p><strong>结论：</strong>CPU 密集型任务下，虚拟线程不仅没有优势，还有微小的额外调度开销。这类场景老老实实用 <code>ForkJoinPool</code> 或固定大小的平台线程池就好。</p>

<h2 id="场景三：混合型工作负载"><a href="#场景三：混合型工作负载" class="headerlink" title="场景三：混合型工作负载"></a>场景三：混合型工作负载</h2>

<p>大多数真实应用都是混合型的——既有数据库查询又有一些计算逻辑：</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">平台线程</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">吞吐量</td>
<td style="text-align:center">5,410 req/s</td>
<td style="text-align:center">8,898 req/s</td>
<td style="text-align:center"><strong>+60.79%</strong></td>
</tr>
<tr>
<td style="text-align:center">平均延迟</td>
<td style="text-align:center">448 ms</td>
<td style="text-align:center">319 ms</td>
<td style="text-align:center"><strong>-28.8%</strong></td>
</tr>
<tr>
<td style="text-align:center">内存使用</td>
<td style="text-align:center">基线</td>
<td style="text-align:center">-36.36%</td>
<td style="text-align:center">显著改善</td>
</tr>
<tr>
<td style="text-align:center">CPU 利用率</td>
<td style="text-align:center">基线</td>
<td style="text-align:center">-14.29%</td>
<td style="text-align:center">同等负载下 CPU 更省</td>
</tr>
</tbody>
</table>

<p><strong>数据来源：</strong>NCIRL Vishesh Pandita（2024）、Marc Nuri Blog 综合多源数据</p>

<h2 id="如何自行复现压测"><a href="#如何自行复现压测" class="headerlink" title="如何自行复现压测"></a>如何自行复现压测</h2>

<p>不要只信我的数字——下面给你一套可以在自己机器上跑起来的完整压测方案。</p>

<p><strong>第一步：准备测试用的 Spring Boot 应用</strong></p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping</span>(<span class="string">"/api/bench"</span>)</span><br><span class="line"><span class="keyword">public</span> <span class="class"><span class="keyword">class</span> <span class="title">BenchmarkController</span> </span>{</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * IO 密集型端点：模拟数据库查询 + 外部 API 调用</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping</span>(<span class="string">"/io-heavy"</span>)</span><br><span class="line">    <span class="keyword">public</span> String <span class="title">ioHeavy</span><span class="params">() <span class="keyword">throws</span> InterruptedException </span>{</span><br><span class="line">        <span class="comment">// 模拟数据库查询耗时 50ms</span></span><br><span class="line">        Thread.sleep(<span class="number">50</span>);</span><br><span class="line">        <span class="comment">// 模拟 RPC 调用耗时 80ms</span></span><br><span class="line">        Thread.sleep(<span class="number">80</span>);</span><br><span class="line">        <span class="comment">// 模拟缓存读取 10ms</span></span><br><span class="line">        Thread.sleep(<span class="number">10</span>);</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"io-heavy done: "</span> + System.currentTimeMillis();</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * CPU 密集型端点：做一堆计算</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping</span>(<span class="string">"/cpu-heavy"</span>)</span><br><span class="line">    <span class="keyword">public</span> String <span class="title">cpuHeavy</span><span class="params">() </span>{</span><br><span class="line">        <span class="keyword">double</span> result = <span class="number">0</span>;</span><br><span class="line">        <span class="keyword">for</span> (<span class="keyword">int</span> i = <span class="number">0</span>; i &lt; <span class="number">1000000</span>; i++) {</span><br><span class="line">            result += Math.sqrt(i) * Math.log(i + <span class="number">1</span>);</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"cpu-heavy done: "</span> + result;</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p><strong>第二步：用 wrk 或 JMeter 施加压力</strong></p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 安装 wrk（如果还没装的话）</span></span><br><span class="line">git clone https://github.com/wg/wrk.git &amp;&amp; cd wrk &amp;&amp; make</span><br><span class="line"></span><br><span class="line"><span class="comment"># 平台线程模式压测（先启动应用时不要开启 spring.threads.virtual.enabled）</span></span><br><span class="line">./wrk -t12 -c1000 -d30s --latency http://localhost:8080/api/bench/io-heavy</span><br><span class="line"></span><br><span class="line"><span class="comment"># 虚拟线程模式压测（开启 spring.threads.virtual.enabled=true 后重启应用）</span></span><br><span class="line">./wrk -t12 -c1000 -d30s --latency http://localhost:8080/api/bench/io-heavy</span><br><span class="line"></span><br><span class="line"># 参数说明：</span><br><span class="line"># -t12: 使用 12 个压测线程</span><br><span class="line"># -c1000: 保持 1000 个并发连接</span><br><span class="line"># -d30s: 持续压测 30 秒</span><br><span class="line"># --latency: 输出延迟分布详情</span><br></pre></td></table></figure>

<p><strong>第三步：观察关键指标</strong></p>

<p>重点关注以下四个指标：</p>

<ol>
<li><strong>吞吐量（Requests/sec）</strong>：越高越好</li>
<li><strong>P99 延迟</strong>：越低越稳定越好（这是用户体验的关键指标）</li>
<li><strong>错误率</strong>：虚拟线程模式下应该趋近于 0</li>
<li><strong>内存占用</strong>：用 <code>jcmd &lt;pid&gt; VM.native_memory summary</code> 观察对比</li>
</ol>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 查看 JVM 内存详情（需要 JDK 自带 jcmd）</span></span><br><span class="line"><span class="built_in">jcmd</span> $(pgrep -f <span class="string">'java.*your-app'</span>) VM.native_memory summary</span><br><span class="line"></span><br><span class="comment"># 关注 Total Committed 和 Internal 两行的数值变化</span></span><br></pre></td></table></figure>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑一：线程局部变量（ThreadLocal）爆炸"><a href="#坑一：线程局部变量（ThreadLocal）爆炸" class="headerlink" title="坑一：线程局部变量（ThreadLocal）爆炸"></a>坑一：线程局部变量（ThreadLocal）爆炸</h2>

<p><strong>问题：</strong>如果你有几十万个虚拟线程，每个都拷贝了一份 <code>ThreadLocal</code> 变量，内存会炸。</p>

<p><strong>典型场景：</strong>：Spring Security 的 <code>SecurityContextHolder</code> 用了 <code>ThreadLocal</code> 存认证信息；ORM 框架用 <code>ThreadLocal</code> 存 Session/事务；MDC（Mapped Diagnostic Context）用于日志链路追踪。</p>

<p><strong>解决方案：</strong></p>

<ul>
<li>JDK 21 引入了 <code>ScopedValue</code>（预览特性，JDK 23 正式），专门为虚拟线程设计，共享一份值而不是每线程拷贝</li>
<li>审查项目中的 <code>ThreadLocal</code> 使用，评估虚拟线程规模下的内存影响</li>
<li>对于 MDC 场景，考虑迁移到 Log4j2 / Logback 的虚拟线程友好方案</li>
</ul>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 旧方式：ThreadLocal（虚拟线程下可能 OOM）</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> ThreadLocal&lt;UserContext&gt; ctx = ThreadLocal.withInitial(UserContext::empty);</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 新方式：ScopedValue（JDK 21+ 预览，推荐）</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">final</span> <span class="keyword">class</span> <span class="title">UserContext</span> {</span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> ScopedValue&lt;UserContext&gt; CTX = ScopedValue.newInstance();</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 在业务代码中使用</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">static</span> &lt;T&gt; T <span class="title">runWhere</span><span class="params">(UserContext ctx, Supplier&lt;T&gt; fn)</span> {</span><br><span class="line">        <span class="keyword">return</span> ScopedValue.where(CTX, ctx).get(fn);</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="坑二：虚拟线程被“钉住”（Pinning）"><a href="#坑二：虚拟线程被“钉住”（Pinning）" class="headerlink" title="坑二：虚拟线程被"钉住"（Pinning）"></a>坑二：虚拟线程被"钉住"（Pinning）</h2>

<p><strong>问题：</strong>当虚拟线程进入 <code>synchronized</code> 块或调用本地方法（native method）时，JVM 无法将它从载体线程上卸载——这叫做<strong>钉住（Pinning）</strong>。被钉住的虚拟线程会一直占着载体线程，退化为类似平台线程的行为。</p>

<p><strong>注：</strong>"钉住"之所以发生，是因为 <code>synchronized</code> 的锁跟 OS 线程绑定，JVM 不敢把虚拟线程从载体上挪走——否则锁的持有者信息就乱了。这是当前 JVM 实现的一个已知限制。</p>

<p><strong>常见触发场景：</strong></p>

<ul>
<li><code>synchronized</code> 方法或代码块（最常见！）</li>
<li>调用本地方法（JNI / <code>native</code> 关键字）</li>
<li>部分第三方库里隐藏的 <code>synchronized</code> 调用</li>
</ul>

<p><strong>解决方案：</strong></p>

<ul>
<li>将 <code>synchronized</code> 替换为 <code>ReentrantLock</code>（<code>ReentrantLock</code> 支持卸载，不会钉住虚拟线程）</li>
<li>启动时加 JVM 参数检测钉住事件：<code>-Djdk.tracePinningMode=full</code></li>
<li>关注日志中的 <code>ForkJoinPool.potentialPinning</code> 警告</li>
</ul>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启动应用时加上这个参数，会在检测到 pinning 时输出完整堆栈</span></span><br><span class="line">java -Djdk.tracePinningMode=full -jar your-app.jar</span><br><span class="line"></span><br><span class="comment"># 输出示例：[ForkJoinPool.potentialPinning] VirtualThread pinned by synchronized block at...</span></span><br></pre></td></table></figure>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 会引起 Pinning</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title">doSomething</span><span class="params">()</span> {</span><br><span class="line">    <span class="comment">// 这里虚拟线程会被钉住！</span></span><br><span class="line">    Thread.sleep(<span class="number">1000</span>);</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 不会 Pinning —— 用 ReentrantLock 替代</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> ReentrantLock();</span><br><span class="line"></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">void</span> <span class="title">doSomethingBetter</span><span class="params">()</span> {</span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> {</span><br><span class="line">        Thread.sleep(<span class="number">1000</span>); <span class="comment">// 可以正常卸载</span></span><br><span class="line">    } <span class="keyword">finally</span> { lock.unlock(); }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="坑三：连接池成为新瓶颈"><a href="#坑三：连接池成为新瓶颈" class="headerlink" title="坑三：连接池成为新瓶颈"></a>坑三：连接池成为新瓶颈</h2>

<p><strong>问题：</strong>以前线程池限制了并发请求数，数据库连接池压力不大。现在虚拟线程放开了并发限制，<strong>所有压力都传导到了下游资源池</strong>——数据库连接池、HTTP 连接池、Redis 连接池……</p>

<p>如果数据库连接池还是默认的 10 个连接，虚拟线程再快也没用——大家都在等连接。</p>

<p><strong>解决方案：</strong></p>

<ul>
<li>根据实际数据库承载能力<strong>适当调大</strong>连接池（HikariCP 推荐公式：<code>connections = (core_count * 2) + effective_spindle_count</code>）</li>
<li>引入 <code>p6spy</code> 或 <code>HikariCP JMX</code> 监控连接池等待情况</li>
<li>对于极端场景，考虑引入 <code>HikariCP</code> 的 <code>connectionTimeout</code> 配置配合快速失败策略</li>
</ul>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.yml —— 虚拟线程时代的连接池配置建议</span></span><br><span class="line"><span class="string">spring:</span></span><br><span class="line">  <span class="string">datasource:</span></span><br><span class="line">    <span class="attr">hikari:</span></span><br><span class="line">      <span class="attr">maximum-pool-size:</span> <span class="number">20</span>      <span class="comment"># 根据数据库核数调整，不是越大越好</span></span><br><span class="line">      <span class="attr">minimum-idle:</span> <span class="number">5</span></span><br><span class="line">      <span class="attr">connection-timeout:</span> <span class="number">30000</span>   <span class="comment"># 30ms 等待超时</span></span><br><span class="line">      <span class="attr">idle-timeout:</span> <span class="number">600000</span>       <span class="comment"># 10 分钟回收空闲连接</span></span><br></pre></td></table></figure>

<h2 id="坑四：CPU密集型任务别用虚拟线程"><a href="#坑四：CPU密集型任务别用虚拟线程" class="headerlink" title="坑四：CPU 密集型任务别用虚拟线程"></a>坑四：CPU 密集型任务别用虚拟线程</h2>

<p>前面压测数据已经说了：纯计算场景下虚拟线程没有优势，还有额外调度开销。<strong>不要为了用而用</strong>。</p>

<p>判断标准很简单：如果你的任务大部分时间在<strong>等待 IO</strong>（数据库、网络、磁盘），用虚拟线程；如果在<strong>疯狂计算</strong>（图像处理、加密解密、大数据排序），用 <code>ForkJoinPool</code> 或固定大小平台线程池。</p>

<h2 id="坑五：池化虚拟线程是个反模式"><a href="#坑五：池化虚拟线程是个反模式" class="headerlink" title="坑五：池化虚拟线程是个反模式"></a>坑五：池化虚拟线程是个反模式</h2>

<p><strong>问题：</strong>看到 <code>Executors.newFixedThreadPool(200)</code> 就想改成虚拟线程版本？<strong>别这么干。</strong></p>

<p>虚拟线程的设计哲学就是<strong>用完即弃</strong>——创建开销极低（纳秒级），不需要池化来复用。池化虚拟线程不仅多此一举，还会丢失虚拟线程的核心优势（无限扩展能力）。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 反模式：池化虚拟线程（不要这样做！）</span></span><br><span class="line">ExecutorService bad = Executors.newFixedThreadPool(<span class="number">200</span>, Thread.ofVirtual().factory());</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确做法：每次任务创建新的虚拟线程</span></span><br><span class="line"><span class="comment">// 方式 A：newVirtualThreadPerTaskExecutor（推荐）</span></span><br><span class="line">ExecutorService good = Executors.newVirtualThreadPerTaskExecutor();</span><br><span class="line"><span class="comment">// 方式 B：直接 startVirtualThread</span></span><br><span class="line">Thread.startVirtualThread(() -&gt; myTask());</span><br></pre></td></table></figure>

<h1 id="迁移检查清单"><a href="#迁移检查清单" class="headerlink" title="迁移检查清单"></a>迁移检查清单</h1>

<p>在决定让你的生产项目启用虚拟线程之前，逐条确认：</p>

<table>
<thead>
<tr>
<th style="text-align:center">#</th>
<th style="text-align:left">检查项</th>
<th style="text-align:center">通过条件</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">1</td>
<td style="text-align:left">JDK 版本 ≥ 21</td>
<td style="text-align:center"><code>java -version</code> 显示 21+</td>
</tr>
<tr>
<td style="text-align:center">2</td>
<td style="text-align:left">Spring Boot ≥ 3.2</td>
<td style="text-align:center">或手动配置 Tomcat <code>Executor</code></td>
</tr>
<tr>
<td style="text-align:center">3</td>
<td style="text-align:left">主要负载是 IO 密集型</td>
<td style="text-align:center">用 arthas / async-profiler 确认线程大部分时间在 WAITING</td>
</tr>
<tr>
<td style="text-align:center">4</td>
<td style="text-align:left">无大量 <code>synchronized</code> 热点代码</td>
<td style="text-align:center">加 <code>-Djdk.tracePinningMode=full</code> 观察是否有频繁 pinning</td>
</tr>
<tr>
<td style="text-align:center">5</td>
<td style="text-align:left">依赖库兼容性已确认</td>
<td style="text-align:center">特别是 ORM 框架、RPC 客户端、中间件 SDK</td>
</tr>
<tr>
<td style="text-align:center">6</td>
<td style="text-align:left">连接池容量已重新评估</td>
<td style="text-align:center">数据库 / Redis / HTTP 连接池不会成为新瓶颈</td>
</tr>
<tr>
<td style="text-align:center">7</td>
<td style="text-align:left">监控体系已适配</td>
<td style="text-align:center">APM 工具能正确识别虚拟线程（部分旧版不支持）</td>
</tr>
<tr>
<td style="text-align:center">8</td>
<td style="text-align:left">已在预发环境完成压测对比</td>
<td style="text-align:center">有明确的 before/after 数据支撑决策</td>
</tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>我们用一张图来概括虚拟线程的适用边界：</p>

<figure class="highlight plain"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line">graph LR
    subgraph “✅ 强烈推荐”
        A1[REST API 服务]
        A2[数据库 CRUD 多]
        A3[微服务间 RPC 调用]
        A4[文件上传/下载]
    end
    subgraph “⚠️ 可以用但要小心”
        B1[synchronized 多的老代码]
        B2[重度依赖 ThreadLocal]
        B3[连接池配置未优化]
    end
    subgraph “❌ 不推荐”
        C1[CPU 密集计算]
        C2[图像/视频处理]
        C3[机器学习推理]
    end</span><br></pre></td></table></figure>

<p><strong>要点回顾：</strong></p>

<ul>
<li>虚拟线程是 JDK 21 的正式特性，不是预览版，可以放心在生产环境尝试</li>
<li>核心价值：<strong>让 thread-per-request 模型重回主流</strong>，用简单的阻塞代码获得接近异步的性能</li>
<li>IO 密集型场景提升巨大（吞吐 3.6x、P99 降低 18x、内存降低 200x）</li>
<li>CPU 密集型场景<strong>不要用</strong>——没有优势</li>
<li>迁移前必查三项：<code>synchronized</code> pinning、<code>ThreadLocal</code> 泄漏、连接池容量</li>
<li>Spring Boot 3.2+ 只需一行配置即可启用</li>
<li><strong>永远不要池化虚拟线程</strong>——它是用来创建和丢弃的</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[Oracle 官方文档] <a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html" target="_blank">Virtual Threads — Oracle JDK 21 Documentation</a>（虚拟线程权威指南，涵盖设计理念与 API 用法）</li>
<li>[阿里云开发者社区] <a href="https://developer.aliyun.com/article/1688277" target="_blank">Project Loom 实战：百万并发的虚拟线程不是梦</a>（中文实战入门，含基础对比与示例代码）</li>
<li>[MetaDesign Solutions] <a href="https://metadesignsolutions.com/blog/reactive-java-2025-project-loom-virtual-threads-best-practices" target="_blank">Reactive Java 2025: Project Loom + Virtual Threads Best Practices</a>（含 Spring Boot 3.2 压测详细数据：3.6x 吞吐提升、P99 850ms→45ms）</li>
<li>[Marc Nuri] <a href="https://blog.marcnuri.com/java-virtual-threads-project-loom-complete-guide" target="_blank">Java Virtual Threads Complete Guide (Project Loom)</a>（全面的虚拟线程教程，含监控、pinning 排查、性能数据）</li>
<li>[NCIRL 论文] Vishesh Pandita, <em>Benchmarking the Performance of Java Virtual Threads in High-Concurrency Applications</em>, 2024（学术基准测试：I/O 密集型吞吐 +60.79%，延迟 -28.8%）</li>
<li>[MariaDB] <a href="https://mariadb.com/resources/blog/benchmark-jdbc-connectors-and-java-21-virtual-threads" target="_blank">Benchmark JDBC Connectors and Java 21 Virtual Threads</a>（数据库访问场景下的虚拟线程 vs 平台线程 JMH 基准测试）</li>
<li>[Adi] <a href="https://adi.earth/posts/database-virtual-threads-benchmark" target="_blank">Benchmark Database Access with Java 21 Virtual Threads</a>（PostgreSQL + 不同连接池配置下的详细压测数据与分析）</li>
<li>[JEP 444] <a href="https://openjdk.org/jeps/444" target="_blank">JEP 444: Virtual Threads</a>（JDK 官方增强提案，虚拟线程的完整技术规范）</li>
</ol>
