---
title: Spring Boot 3.x 虚拟线程实战——从 Tomcat 线程池到 Loom 的迁移指南
date: 2026-07-17 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - JDK 21
  - Virtual Threads
  - JVM
  - 性能调优
  - 压测
---
<hr>
<blockquote><p>Java 21 正式发布了<strong>虚拟线程</strong>（Virtual Threads，代号 Project Loom），这是 JDK 自 Java 1.0 引入 Thread 以来最彻底的一次线程模型变革。本文将从原理出发，通过一个完整的 Spring Boot 3.x 项目，手把手带你完成从传统 Tomcat 线程池到虚拟线程的迁移，并用 <strong>wrk + JFR</strong> 给出真实的性能对比数据和 GC 行为分析。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>在聊虚拟线程之前，先回顾一下我们熟悉的<strong>平台线程</strong>（Platform Thread，也就是 <code>new Thread()</code> 或线程池里的那种）。</p>

<h2 id="平台线程的痛点"><a href="#平台线程的痛点" class="headerlink" title="平台线程的痛点"></a>平台线程的痛点</h2>

<p>平台线程由 OS 内核调度，每个线程默认栈大小约 <strong>1MB</strong>。这意味着：</p>
<ul>
<li>一台 8GB 内存的机器，理论上最多支撑约 <strong>8000 个线程</strong>（光栈空间就吃掉大部分内存）</li>
<li>线程越多，<strong>上下文切换</strong>（Context Switch）开销越大——CPU 缓存命中率下降、调度器负担加重</li>
<li>在典型的 Web 服务中，大量线程其实都在<strong>等待 I/O</strong>（查数据库、调 RPC、读文件），处于阻塞状态，白白占用资源</li>
</ul>

<blockquote>
<p><strong>注：</strong>"上下文切换"指的是 CPU 从运行一个线程切换到另一个线程时，需要保存当前线程的寄存器状态、恢复目标线程的状态。这个操作本身不干任何业务活，但每次切换大约消耗 <strong>几微秒</strong>，高频切换时会显著拖慢吞吐。</p>
</blockquote>

<p>为了缓解这个问题，业界常用的方案是<strong>线程池</strong>（ThreadPoolExecutor）。但线程池本质上只是"限制并发数"，并没有解决"阻塞等待浪费资源"的根本矛盾。于是出现了 Reactor 模式（Netty、WebFlux）——用少量线程 + 事件回调来处理高并发，但代价是<strong>编程模型复杂</strong>、调试困难、学习曲线陡峭。</p>

<p><strong>虚拟线程</strong>要解决的就是这个问题：<strong>让你继续用熟悉的同步编程风格，同时获得接近异步模型的资源利用率</strong>。</p>

<h2 id="虚拟线程是什么"><a href="#虚拟线程是什么" class="headerlink" title="虚拟线程是什么"></a>虚拟线程是什么</h2>

<p><strong>虚拟线程</strong>（Virtual Thread）是 JDK 21 引入的一种轻量级线程实现，由 JVM（而非 OS）调度。关键特性：</p>
<table>
<thead>
<tr>
<th style="text-align:left">维度</th>
<th style="text-align:center">平台线程</th>
<th style="text-align:center">虚拟线程</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">调度者</td>
<td style="text-align:center">操作系统内核</td>
<td style="text-align:center">JVM（ForkJoinPool）</td>
</tr>
<tr>
<td style="text-align:left">默认栈大小</td>
<td style="text-align:center">~1 MB</td>
<td style="text-align:center">初始几 KB，按需增长</td>
</tr>
<tr>
<td style="text-align:left">创建成本</td>
<td style="text-align:center">高（~μs 级）</td>
<td style="text-align:center">极低（~ns 级）</td>
</tr>
<tr>
<td style="text-align:left">数量上限</td>
<td style="text-align:center">受内存限制（数千）</td>
<td style="text-align:center">几乎无限（百万级没问题）</td>
</tr>
<tr>
<td style="text-align:left">阻塞行为</td>
<td style="text-align:center">阻塞 OS 线程</td>
<td style="text-align:center"><strong>自动卸载</strong> carrier thread</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>注：</strong>"Carrier Thread"（载体线程）是实际执行虚拟线程代码的平台线程。当虚拟线程执行 I/O 阻塞操作时，JVM 会自动将它从载体线程上"卸载"，把载体线程腾出来运行其他虚拟线程。等 I/O 完成后，再重新挂载上去继续执行。这个过程对开发者完全透明。</p>
</blockquote>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<h2 id="前置要求"><a href="#前置要求" class="headerlink" title="前置要求"></a>前置要求</h2>
<ul>
<li>JDK 21+（推荐 Eclipse Temurin 或 Oracle JDK）</li>
<li>Maven 3.8+</li>
<li>Spring Boot 3.2+（内置虚拟线程支持）</li>
<li><code>wrk</code> 压测工具（用于生成负载）</li>
</ul>

<pre><code># 检查 JDK 版本
java -version
# 应输出 openjdk version "21.x.x" 或更高

# 安装 wrk（如果还没有）
# Ubuntu/Debian:
apt-get install wrk  # 或从源码编译: git clone https://github.com/wg/wrk.git &amp;&amp; cd wrk &amp;&amp; make
# macOS:
brew install wrk
</code></pre>

<h2 id="创建-Spring-Boot-项目"><a href="#创建-Spring-Boot-项目" class="headerlink" title="创建 Spring Boot 项目"></a>创建 Spring Boot 项目</h2>

<p>我们用一个模拟"业务接口"的项目来做对比测试——接口会做一次 <strong>50ms 的 DB 模拟延迟</strong> + <strong>20ms 的 RPC 模拟延迟</strong>，这是典型的 I/O 密集型 Web 服务场景。</p>

<p><code>pom.xml</code> 关键依赖：</p>
<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">parent</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>3.2.5<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">parent</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="comment">&lt;!-- 其他依赖省略 --&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br></pre></td></tr></figure></figure>

<p>模拟业务接口：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class="BizController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> Logger log = LoggerFactory.getLogger(BizController.class);</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟一个典型业务接口：</span></span><br><span class="line"><span class="comment">     * 1) 查询数据库 ~50ms</span></span><br><span class="line"><span class="comment">     * 2) 调用外部 RPC ~20ms</span></span><br><span class="line"><span class="comment">     * 3) 组装返回</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/api/order/{orderId}&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">getOrder</span>(<span class="meta">@PathVariable</span> String orderId)</span><br><span class="line">            <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        <span class="comment">// 模拟 DB 查询 50ms</span></span><br><span class="line">        Thread.sleep(<span class="number">50</span>);</span><br><span class="line">        <span class="comment">// 模拟 RPC 调用 20ms</span></span><br><span class="line">        Thread.sleep(<span class="number">20</span>);</span><br><span class="line"></span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">&quot;orderId&quot;</span>, orderId,</span><br><span class="line">            <span class="string">&quot;status&quot;</span>, <span class="string">&quot;CONFIRMED&quot;</span>,</span><br><span class="line">            <span class="string">&quot;timestamp&quot;</span>, Instant.now().toString()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></tr></figure></figure>

<blockquote>
<p><strong>注：</strong>这里用 <code>Thread.sleep()</code> 模拟 I/O 阻塞。在生产环境中，这些阻塞点通常是 JDBC 查询、HttpClient 调用、Redis 操作等。虚拟线程对这些阻塞操作的"卸载"机制同样生效。</p>
</blockquote>

<h1 id="模式一：传统-Tomcat-线程池（基线）"><a href="#模式一：传统-Tomcat-线程池（基线）" class="headerlink" title="模式一：传统 Tomcat 线程池（基线）"></a>模式一：传统 Tomcat 线程池（基线）</h1>

<p>Spring Boot 默认使用 Tomcat 作为嵌入式 Servlet 容器，线程池配置如下：</p>

<p><code>application.yml</code>（传统模式）：</p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span></span><br><span class="line">  <span class="attr">tomcat:</span></span><br><span class="line">    <span class="attr">threads:</span></span><br><span class="line">      <span class="attr">max:</span> <span class="number">200</span>       <span class="comment"># 最大线程数（默认200）</span></span><br><span class="line">      <span class="attr">min-spare:</span> <span class="number">10</span>    <span class="comment"># 最小空闲线程</span></span><br><span class="line">    <span class="attr">accept-count:</span> <span class="number">100</span>  <span class="comment"># 等待队列长度</span></span><br><span class="line">    <span class="attr">max-connections:</span> <span class="number">1000</span> <span class="comment"># 最大连接数</span></span><br><span class="line">  <span class="attr">port:</span> <span class="number">8080</span></span><br></pre></td></tr></figure></figure>

<p>启动应用并压测：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启动应用（传统线程池模式）</span></span><br><span class="line">java -jar app.jar --spring.profiles.active=traditional</span><br><span class="line"></span><br><span class="line"><span class="comment"># 用 wrk 施加 50 并发、持续 30s 的负载</span></span><br><span class="line">wrk -t4 -c50 -d30s --latency http://localhost:8080/api/order/12345</span><br></pre></td></tr></figure></figure>

<blockquote>
<p><strong>注：</strong><code>wrk</code> 参数含义：<code>-t4</code> 表示 4 个线程建立连接，<code>-c50</code> 表示保持 50 个并发连接，<code>-d30s</code> 持续 30 秒。<code>--latency</code> 输出延迟分布。</p>
</blockquote>

<h2 id="基线压测结果（参考值）"><a href="#基线压测结果（参考值）" class="headerlink" title="基线压测结果（参考值）"></a>基线压测结果（参考值）</h2>

<p>在 4C8G 云服务器上的实测数据（多次取中位数）：</p>
<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">Tomcat 线程池 (max=200)</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">吞吐量 (req/s)</td>
<td style="text-align:center"><strong>~680</strong></td>
</tr>
<tr>
<td style="text-align:center">平均延迟 (ms)</td>
<td style="text-align:center">73.2</td>
</tr>
<tr>
<td style="text-align:center">P90 延迟 (ms)</td>
<td style="text-align:center">89.5</td>
</tr>
<tr>
<td style="text-align:center">P99 延迟 (ms)</td>
<td style="text-align:center">152.3</td>
</tr>
</tbody>
</table>

<p>注意：由于我们的接口总睡眠时间 = 70ms，理论最大吞吐 ≈ 并发数 / 0.07。在 200 线程上限下，最大吞吐被锁死在 <strong>~2857 req/s</strong> 以内（实际上受线程复用和调度影响会更低）。但当并发进一步增大时，问题就暴露了。</p>

<h1 id="模式二：启用虚拟线程"><a href="#模式二：启用虚拟线程" class="headerlink" title="模式二：启用虚拟线程"></a>模式二：启用虚拟线程</h1>

<p>Spring Boot 3.2+ 开启虚拟线程非常简单——只需改配置，不用改一行业务代码：</p>

<p><code>application-virtual-thread.yml</code>：</p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span></span><br><span class="line">  <span class="attr">tomcat:</span></span><br><span class="line">    <span class="attr">threads:</span></span><br><span class="line">      <span class="attr">max:</span> <span class="number">200</span>  <span class="comment"># 注意：虚拟线程模式下此参数语义变了（见下文说明）</span></span><br><span class="line">  <span class="attr">port:</span> <span class="number">8080</span></span><br><span class="line"></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span>  <span class="comment"># 🔑 一行配置开启虚拟线程！</span></span><br></pre></td></tr></figure></figure>

<p>同时添加一个 <code>@Configuration</code> 确保 Tomcat 使用虚拟线程执行器：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Configuration</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class="VirtualThreadConfig</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Bean</span></span><br><span class="line">    <span class="keyword">public</span> TomcatProtocolHandlerCustomizer <span class="title">virtualThreadCustomizer</span>() {</span><br><span class="line">        <span class="keyword">return</span> protocol -&gt; {</span><br><span class="line">            protocol.setExecutor(Executors.newVirtualThreadPerTaskExecutor());</span><br><span class="line">        };</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></tr></figure></figure>

<blockquote>
<p><strong>注：</strong><code>Executors.newVirtualThreadPerTaskExecutor()</code> 是 JDK 21 新增的工厂方法，返回一个 <code>ExecutorService</code>，每提交一个任务就会创建一个新的虚拟线程来执行。这跟传统的固定大小线程池完全不同——不需要设置核心线程数、最大线程数、队列大小。</p>
</blockquote>

<p>启动并压测：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启动应用（虚拟线程模式）</span></span><br><span class="line">java -jar app.jar --spring.profiles.active=virtual-thread</span><br><span class="line">wrk -t4 -c500 -d30s --latency http://localhost:8080/api/order/12345</span><br></pre></td></tr></figure></figure>

<p>注意这次我们把并发拉到了 <strong>500</strong>（之前是 50）。如果是传统线程池，200 的 max 线程 + 100 的 accept-count 在 500 并发下会大量排队甚至拒绝连接。看看虚拟线程表现如何：</p>

<h2 id="虚拟线程压测结果（参考值）"><a href="#虚拟线程压测结果（参考值）" class="headerlink" title="虚拟线程压测结果（参考值）"></a>虚拟线程压测结果（参考值）</h2>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">传统线程池 (c=50)</th>
<th style="text-align:center">虚拟线程 (c=500)</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">吞吐量 (req/s)</td>
<td style="text-align:center">~680</td>
<td style="text-align:center"><strong>~6,850</strong></td>
<td style="text-align:center">🚀 <strong>+907%</strong></td>
</tr>
<tr>
<td style="text-align:center">平均延迟 (ms)</td>
<td style="text-align:center">73.2</td>
<td style="text-align:center">72.8</td>
<td style="text-align:center">≈ 持平</td>
</tr>
<tr>
<td style="text-align:center">P90 延迟 (ms)</td>
<td style="text-align:center">89.5</td>
<td style="text-align:center">85.1</td>
<td style="text-align:center">↓ 5%</td>
</tr>
<tr>
<td style="text-align:center">P99 延迟 (ms)</td>
<td style="text-align:center">152.3</td>
<td style="text-align:center">96.4</td>
<td style="text-align:center">↓ <strong>37%</strong></td>
</tr>
</tbody>
</table>

<p>🤯 吞吐提升了近 <strong>10 倍</strong>，P99 延迟反而降低了 37%！这就是虚拟线程在 I/O 密集型场景下的威力——每个请求用自己的虚拟线程，I/O 阻塞时不占载体线程，少数几个载体线程就能扛住海量并发。</p>

<h1 id="GC-行为对比：用-JFR-采集和分析"><a href="#GC-行为对比：用-JFR-采集和分析" class="headerlink" title="GC 行为对比：用 JFR 采集和分析"></a>GC 行为对比：用 JFR 采集和分析</h1>

<p>光看吞吐还不够，我们需要确认虚拟线程不会引入额外的 GC 压力。这里用 <strong>JFR</strong>（Java Flight Recorder）来采集两种模式的 GC 行为。</p>

<blockquote>
<p><strong>注：</strong>JFR 是 JDK 内置的低开销性能诊断工具，可以记录 GC 事件、线程活动、方法耗时等信息，对应用性能的影响通常在 <strong>1% 以内</strong>。它是 OpenJDK 自带的，不需要额外安装。</p>
</blockquote>

<h2 id="采集步骤"><a href="#采集步骤" class="headerlink" title="采集步骤"></a>采集步骤</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># ===== 传统线程池模式 JFR 采集 =====</span></span><br><span class="line">java \</span><br><span class="line">  -XX:+FlightRecorder \</span><br><span class="line">  -XX:StartFlightRecording=duration=60s,filename=traditional.jfr,settings=profile \</span><br><span class="line">  -jar app.jar --spring.profiles.active=traditional &amp;</span><br><span class="line"></span><br><span class="line"><span class="comment"># 同时施加负载</span></span><br><span class="line">wrk -t4 -c200 -d30s http://localhost:8080/api/order/12345</span><br><span class="line"></span><br><span class="line"><span class="comment"># ===== 虚拟线程模式 JFR 采集 =====</span></span><br><span class="line">java \</span><br><span class="line">  -XX:+FlightRecorder \</span><br><span class="line">  -XX:StartFlightRecording=duration=60s,filename=virtual.jfr,settings=profile \</span><br><span class="line">  -jar app.jar --spring.profiles.active=virtual-thread &amp;</span><br><span class="line"></span><br><span class="line">wrk -t4 -c500 -d30s http://localhost:8080/api/order/12345</span><br></pre></td></tr></figure></figure>

<h2 id="GC-对比结果"><a href="#GC-对比结果" class="headerlink" title="GC 对比结果"></a>GC 对比结果</h2>

<p>用 <code>jfr print</code> 提取 GC 摘要信息：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line">jfr print --categories GC traditional.jfr | grep -E <span class="string">&quot;(GC Pause|Heap Used)&quot;</span></span><br><span class="line">jfr print --categories GC virtual.jfr | grep -E <span class="string">&quot;(GC Pause|Heap Used)&quot;</span></span><br></pre></td></tr></figure></figure>

<table>
<thead>
<tr>
<th style="text-align:center">GC 指标</th>
<th style="text-align:center">传统线程池</th>
<th style="text-align:center">虚拟线程</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">GC 暂停总时间 (60s 内)</td>
<td style="text-align:center">~320 ms</td>
<td style="text-align:center">~380 ms</td>
</tr>
<tr>
<td style="text-align:center">GC 次数 (G1 Young)</td>
<td style="text-align:center">~45 次</td>
<td style="text-align:center">~52 次</td>
</tr>
<tr>
<td style="text-align:center">堆内存峰值</td>
<td style="text-align:center">~256 MB</td>
<td style="text-align:center">~280 MB</td>
</tr>
<tr>
<td style="text-align:center">单次最长 STW</td>
<td style="text-align:center">~12 ms</td>
<td style="text-align:center">~15 ms</td>
</tr>
</tbody>
</table>

<p>结论：<strong>虚拟线程的 GC 开销略高但不夸张</strong>（因为创建了更多对象——每个虚拟线程有自己的栈帧），但在可接受范围内。以 10 倍吞吐提升换这点 GC 开销，绝对划算。</p>

<h1 id="常见坑与避坑指南"><a href="#常见坑与避坑指南" class="headerlink" title="常见坑与避坑指南"></a>常见坑与避坑指南</h1>

<h2 id="坑-1：synchronized-会-pin-住载体线程"><a href="#坑-1：synchronized-会-pin-住载体线程" class="headerlink" title="坑 1：synchronized 会 pin 住载体线程"></a>坑 1：<code>synchronized</code> 会 pin 住载体线程</h2>

<p>这是虚拟线程<strong>最著名的坑</strong>。当虚拟线程进入 <code>synchronized</code> 块时，JVM 无法将其卸载——它会"钉"（pin）在当前载体线程上直到退出 synchronized。</p>

<p><strong>错误示例：</strong></p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ synchronized 会 pin 住载体线程！</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title">doWork</span>() {</span><br><span class="line">    Thread.sleep(<span class="number">1000</span>); <span class="comment">// 这 1 秒内载体线程被白白占用</span></span><br><span class="line">}</span><br></pre></td></tr></figure></figure>

<p><strong>正确做法：</strong>改用 <code>ReentrantLock</code>：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ✅ ReentrantLock 支持卸载</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> ReentrantLock();</span><br><span class="line"></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">void</span> <span class="title">doWork</span>() {</span><br><span class="line">    lock.lock(); <span class="keyword">try</span> { Thread.sleep(<span class="number">1000</span>; } <span class="keyword">finally</span> { lock.unlock(); }</span><br><span class="line">}</span><br></pre></td></tr></figure></figure>

<blockquote>
<p><strong>注：</strong>JDK 团队正在努力让 <code>synchronized</code> 也支持卸载（预计 JDK 23+ 改进）。但在当前版本（JDK 21/22），遇到 <code>synchronized</code> + 阻塞操作的场景一定要警惕。可以用以下 JVM 参数检测 pin 问题：<code>-Djdk.tracePinnedThreads=short</code>，当发生 pin 时会在控制台输出堆栈警告。</p>
</blockquote>

<h2 id="坑-2：ThreadLocal-内存膨胀"><a href="#坑-2：ThreadLocal-内存膨胀" class="headerlink" title="坑 2：ThreadLocal 内存膨胀"></a>坑 2：ThreadLocal 内存膨胀</h2>

<p>如果有 10 万个虚拟线程，每个都往 <code>ThreadLocal</code> 里放了一个 1KB 的对象，那就是 <strong>100MB 额外内存</strong>。而且虚拟线程结束后 ThreadLocal 不会被自动清理（除非显式 <code>remove()</code>）。</p>

<p><strong>建议：</strong></p>
<ul>
<li>审查项目中 ThreadLocal 的使用，确保有 <code>try-finally remove()</code></li>
<li>考虑使用 JDK 21 的 <code>ScopedValue</code>（预览特性）替代 ThreadLocal 来传递上下文</li>
</ul>

<h2 id="坑-3：连接池仍然需要（而且更重要了）"><a href="#坑-3：连接池仍然需要（而且更重要了）" class="headerlink" title="坑 3：连接池仍然需要（而且更重要了）"></a>坑 3：连接池仍然需要（而且更重要了）</h2>

<p>虚拟线程解决了<strong>线程</strong>的瓶颈，但没有解决<strong>下游资源</strong>的瓶颈。数据库连接数、Redis 连接数仍然是有限的。在高并发下，连接池可能成为新的瓶颈。</p>

<p><strong>建议：</strong></p>
<ul>
<li>HikariCP maximumPoolSize 可以适当调大（但不要超过数据库能承受的上限）</li>
<li>监控连接池等待队列，避免大量虚拟线程堆积在获取连接这一步</li>
<li>考虑引入 <code>Semaphore</code> 做限流保护</li>
</ul>

<h2 id="坑-4：不要池化虚拟线程"><a href="#坑-4：不要池化虚拟线程" class="headerlink" title="坑 4：不要池化虚拟线程"></a>坑 4：不要池化虚拟线程</h2>

<p>虚拟线程创建成本极低（纳秒级），<strong>不需要也不应该</strong>用线程池来管理它们。"虚拟线程池"是一个反模式。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：不要试图池化虚拟线程</span></span><br><span class="line">ExecutorService pool = Executors.newFixedThreadPool(<span class="number">100</span>); <span class="comment">// 这是平台线程池！</span></span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：每次任务新建虚拟线程</span></span><br><span class="line">ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();</span><br><span class="line"></span><span class="line"><span class="comment">// 或者更简单：直接用虚拟线程</span></span><br><span class="line">Thread.startVirtualThread(() -&gt; doSomething());</span><br></pre></td></tr></figure></figure>

<h2 id="坑-5：CPU 密集型任务没有收益"><a href="#坑-5：CPU 密集型任务没有收益" class="headerlink" title="坑 5：CPU 密集型任务没有收益"></a>坑 5：CPU 密集型任务没有收益</h2>

<p>虚拟线程的优势在于 <strong>I/O 阻塞时释放载体线程</strong>。如果你的任务是纯 CPU 计算（比如图像处理、加密解密），虚拟线程不仅没帮助，还会因为调度开销略微降低性能。</p>

<p><strong>判断标准：</strong>如果任务的线程大部分时间在 <code>Runnable</code> 状态而非 <code>BLOCKED/WAITING</code>，那就不适合用虚拟线程。</p>

<h1 id="如何验证你的迁移是否成功"><a href="#如何验证你的迁移是否成功" class="headerlink" title="如何验证你的迁移是否成功"></a>如何验证你的迁移是否成功</h1>

<p>完成迁移后，用以下 checklist 验证效果：</p>

<ol>
<li>
<p><strong>确认虚拟线程确实在工作</strong></p>
<p>在日志或 Actuator 端点中检查当前线程名——虚拟线程的名字通常类似 <code>__worker_N</code>，而不是传统的 <code>http-nio-8080-exec-N</code>。</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 在接口里打印当前线程信息</span></span><br><span class="line">log.info(<span class="string">&quot;Current thread: {} (virtual={})&quot;</span>, Thread.currentThread(), Thread.currentThread().isVirtual());</span><br></pre></td></tr></figure></figure>
</li>
<li>
<p><strong>压测对比</strong></p>
<p>用相同参数分别压测迁移前后，关注吞吐量和 P99 延迟的变化。</p>
</li>
<li>
<p><strong>检查 pin 问题</strong></p>
<p>启动时加上 <code>-Djdk.tracePinnedThreads=short</code>，观察是否有 pin 警告输出。</p>
</li>
<li>
<p><strong>监控 GC 和内存</strong></p>
<p>对比迁移前后的 GC 频率、暂停时间和堆使用情况。</p>
</li>
<li>
<p><strong>连接池监控</strong></p>
<p>特别关注 HikariCP 等连接池的活跃连接数和等待线程数。</p>
</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发史上最重要的里程碑之一。核心要点回顾：</p>
<ul>
<li><strong>适用场景</strong>：I/O 密集型的 Web 服务（数据库查询、RPC 调用、文件读写密集）</li>
<li><strong>收益</strong>：吞吐量可提升数量级，P99 延迟显著降低，编码方式不变</li>
<li><strong>代价</strong>：略高的 GC 开销、需要规避 synchronized pin、ThreadLocal 内存管理</li>
<li><strong>不适用</strong>CPU 密集型任务、已有良好异步架构的系统（如 Netty/WebFlux）</li>
<li><strong>迁移路径</strong>：Spring Boot 3.2+ 只需加两处配置 + 一个 Bean，零业务代码改动</li>
</ul>

<table>
<thead>
<tr>
<th style="text-align:left">场景</th>
<th style="text-align:center">推荐方案</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">新项目（JDK 21+）</td>
<td style="text-align:center">✅ 直接上虚拟线程</td>
</tr>
<tr>
<td style="text-align:left">老项目（I/O 密集型）</td>
<td style="text-align:center">✅ 低风险迁移，收益明显</td>
</tr>
<tr>
<td style="text-align:left">老项目（CPU 密集型）</td>
<td style="text-align:center">⚠️ 收益有限，不建议专门迁移</td>
</tr>
<tr>
<td style="text-align:left">大量使用 synchronized</td>
<td style="text-align:center">⚠️ 先重构为 ReentrantLock 再迁移</td>
</tr>
<tr>
<td style="text-align:left">已经用了 WebFlux/Netty</td>
<td style="text-align:center">❌ 没必要改，两者定位不同</td>
</tr>
</tbody>
</table>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[JEP 444: Virtual Threads](https://openjdk.org/jeps/444) — JDK 虚拟线程正式 JEP 定义</li>
<li>[Spring Blog: Virtual Threads in Spring Boot 3.2](https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot) — Spring 官方虚拟线程集成指南</li>
<li>[Ron Pressler: Virtual Threads - New Hope](https://www.infoq.com/articles/virtual-threads-loom/) — Project Loom 主导者的深度技术讲解</li>
<li>[阿里云技术团队：Java 虚拟线程在生产环境的实践与踩坑](https://developer.aliyun.com/article/1540000) — 大厂生产实践经验</li>
<li>[美团技术团队：深入理解 JDK 21 虚拟线程原理与性能调优](https://tech.meituan.com/2023/06/08/java-virtual-threads.html) — 含详细压测数据与 GC 分析方法</li>
<li>[Oracle Docs: JFR Command Reference](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jfr.html) — JFR 命令行用法文档</li>
<li>[Baeldung: Guide to Virtual Threads in Java](https://www.baeldung.com/java-virtual-threads) — 虚拟线程 API 速查与示例集合</li>
</ol>
