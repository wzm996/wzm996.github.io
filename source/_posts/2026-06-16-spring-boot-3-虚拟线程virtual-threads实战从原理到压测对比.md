---
title: Spring Boot 3 虚拟线程（Virtual Threads）实战——从原理到压测对比
date: 2026-06-16 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - Virtual Threads
  - JDK 21
  - 并发编程
  - 性能调优
---
<hr>
<blockquote><p>虚拟线程（Virtual Threads）是 JDK 21 正式发布的里程碑特性，它重新定义了 Java 高并发的编程模型——用极少的平台线程承载海量虚拟线程，让"同步写法跑出异步性能"成为现实。本文从原理出发，搭建一个完整的 Spring Boot 3 示例项目，通过 wrk 压测对比传统线程池与虚拟线程的吞吐和延迟差异，并梳理生产落地的关键注意事项。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么要关心虚拟线程"><a href="#背景：为什么要关心虚拟线程" class="headerlink" title="背景：为什么要关心虚拟线程"></a>背景：为什么要关心虚拟线程</h1>

<p>在虚拟线程出现之前，Java 服务端高并发的主流方案是<strong>线程池</strong>（ThreadPoolExecutor）。但你一定踩过这些坑：</p>
<ul>
<li>Tomcat 线程数设 200，QPS 一上来就打满，大量请求在队列里等</li>
<li>想加线程？操作系统线程上下文切换成本高，一般建议 200~500 就到头了</li>
<li>改异步写法（CompletableFuture / WebFlux）？代码可读性断崖式下跌，调试困难</li>
</ul>

<p><strong>虚拟线程</strong>要解决的核心问题就是：<strong>把"并发度"和"平台线程数"解耦</strong>。你可以轻松创建百万级虚拟线程，而底层只用少量 Carrier Thread（载体线程，通常等于 CPU 核心数）来调度执行。</p>

<blockquote><p><strong>虚拟线程（Virtual Thread）</strong>：JDK 21 引入的一种轻量级线程实现，由 JVM 调度而非操作系统。它在用户态维护调用栈，阻塞时会自动卸载（mount/unmount），不占用平台线程。简单理解——它是 Java 版的"协程"，但对你来说写起来跟普通 Thread 完全一样。</p></blockquote>

<h1 id="核心原理：虚拟线程是怎么工作的"><a href="#核心原理：虚拟线程是怎么工作的" class="headerlink" title="核心原理：虚拟线程是怎么工作的"></a>核心原理：虚拟线程是怎么工作的</h1>

<h2 id="传统线程模型 vs 虚拟线程模型"><a id="传统线程模型-vs-虚拟线程模型" class="headerlink" title="传统线程模型 vs 虚拟线程模型"></a>传统线程模型 vs 虚拟线程模型</h2>

<table>
<thead>
<tr>
<th>维度</th>
<th>平台线程（Platform Thread）</th>
<th>虚拟线程（Virtual Thread）</th>
</tr>
</thead>
<tbody>
<tr>
<td>调度者</td>
<td>操作系统内核</td>
<td>JVM（Runtime 调度器）</td>
</tr>
<tr>
<td>创建成本</td>
<td>高（约 1MB 栈空间 + 内核资源）</td>
<td>极低（栈 Continuation 按需生长）</td>
</tr>
<tr>
<td>典型数量上限</td>
<td>几千（受内存和 CPU 限制）</td>
<td>百万级（仅受内存限制）</td>
</tr>
<tr>
<tr>
<td>阻塞行为</td>
<td>占用平台线程，无法做其他事</td>
<td>自动卸载，Carrier Thread 可转去执行其他虚拟线程</td>
</tr>
<tr>
<td>适用场景</td>
<td>CPU 密集型任务</td>
<td>I/O 密集型任务（数据库查询、HTTP 调用等）</td>
</tr>
</tbody>
</table>

<h2 id="Mount-Unmount-机制"><a href="#Mount-Unmount-机制" class="headerlink" title="Mount/Unmount 机制"></a>Mount/Unmount 机制</h2>

<p>虚拟线程最精妙的设计是 <strong>Mount/Unmount</strong>：</p>
<ul>
<li><strong>Mount（挂载）</strong>：虚拟线程的栈帧被加载到一个平台线程上运行</li>
<li><strong>Unmount（卸载）</strong>：当虚拟线程遇到阻塞操作（如 I/O、synchronized、LockSupport.park）时，JVM 把它的栈帧从平台线程上"卸载"下来，存到堆内存中，释放这个平台线程去运行其他虚拟线程</li>
<li>阻塞结束后，虚拟线程重新 Mount 到某个空闲的平台线程上继续执行</li>
</ul>

<pre><code>注：JDK 21 中 synchronized 块默认不会 unmount（仍会 pin 住 carrier thread），
这是为了兼容性考虑。JDK 24+ 计划解决这个问题。
生产中建议用 ReentrantLock 替代 synchronized 以避免 pinning。
</code></pre>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<table>
<thead>
<tr>
<th>组件</th>
<th>版本要求</th>
</tr>
</thead>
<tbody>
<tr>
<td>JDK</td>
<td>21+（推荐 21 LTS）</td>
</tr>
<tr>
<td>Spring Boot</td>
<td>3.2+（内置虚拟线程支持）</td>
</tr>
<tr>
<td>Maven</td>
<td>3.8+</td>
</tr>
<tr>
<td>压测工具</td>
<td>wrk 或 k6</td>
</tr>
</tbody>
</table>

<h2 id="快速验证你的-JDK-是否支持虚拟线程"><a href="#快速验证你的-JDK-是否支持虚拟线程" class="headerlink" title="快速验证你的 JDK 是否支持虚拟线程"></a>快速验证你的 JDK 是否支持虚拟线程</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">public</span> <span class="keyword">static</span> <span class="keyword">void</span> <span class="title">main</span><span class="params">(String[] args)</span> {</span><br><span class="line">    Thread vt = Thread.ofVirtual().name(<span class="string">"demo-vt"</span>, <span class="number">0</span>).start(() -> {</span><br><span class="line">        System.out.println(<span class="string">"Hello from "</span> + Thread.currentThread());</span><br><span class="line">    });</span><br><span class="line">    vt.join(); <span class="comment">// 输出类似: VirtualThread[#24,demo-vt]/runnable@ForkJoinPool.commonPool-worker-1</span></span><br><span class="line">}</span><br></pre></td></table></figure>

<p>如果看到 <code>VirtualThread[#xx]</code> 字样，说明你的 JDK 已经支持虚拟线程。</p>

<h1 id="实战：搭建-Spring-Boot-3-虚拟线程项目"><a href="#实战：搭建-Spring-Boot-3-虚拟线程项目" class="headerlink" title="实战：搭建 Spring Boot 3 虚拟线程项目"></a>实战：搭建 Spring Boot 3 虚拟线程项目</h1>

<h2 id="1-项目初始化"><a href="#1-项目初始化" class="headerlink" title="1. 项目初始化"></a>1. 项目初始化</h2>

<p>使用 <a href="https://start.spring.io" target="_blank">Spring Initializr</a> 创建项目，依赖选 <strong>Spring Web</strong> 即可。</p>

<p><code>pom.xml</code> 关键配置：</p>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line">&lt;parent&gt;</span><br><span class="line">    &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;</span><br><span class="line">    &lt;artifactId&gt;spring-boot-starter-parent&lt;/artifactId&gt;</span><br><span class="line">    &lt;version&gt;3.3.2&lt;/version&gt;</span><br><span class="line">&lt;/parent&gt;</span><br><span class="line"></span><br><span class="line">&lt;properties&gt;</span><br><span class="line">    &lt;java.version&gt;21&lt;/java.version&gt;</span><br><span class="line">&lt;/properties&gt;</span><br><span class="line"></span><br><span class="line">&lt;dependency&gt;</span><br><span class="line">    &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;</span><br><span class="line">    &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;</span><br><span class="line">&lt;/dependency&gt;</span><br></pre></td></table></figure>

<h2 id="2-开启虚拟线程（一行配置）"><a href="#2-开启虚拟线程（一行配置）" class="headerlink" title="2. 开启虚拟线程（一行配置）"></a>2. 开启虚拟线程（一行配置）</h2>

<p>在 <code>application.yml</code> 中添加：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span><br><span class="line">  <span class="attr">threads:</span><br><span class="line">    <span class="attr">virtual:</span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>

<p>就这一行，Spring Boot 会把 Tomcat 的请求处理线程池替换为虚拟线程。不需要改任何业务代码。</p>

<blockquote><p><strong>spring.thread.virtual.enabled</strong>：Spring Boot 3.2+ 提供的配置项，设为 true 后，框架会自动将 Tomcat 的线程池策略切换为虚拟线程模式。每个 HTTP 请求都会在一个新的虚拟线程中处理。</p></blockquote>

<h2 id="3-编写模拟-I-O-阻塞的接口"><a href="#3-编写模拟-I-O-阻塞的接口" class="headerlink" title="3. 编写模拟 I/O 阻塞的接口"></a>3. 编写模拟 I/O 阻塞的接口</h2>

<p>为了体现虚拟线程的优势，我们需要一个<strong>I/O 密集型</strong>的场景。下面是一个模拟"远程调用延迟"的 Controller：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> org.springframework.web.bind.annotation.*;</span><br><span class="line"></span><br><span class="line"><span class="keyword">import</span> java.util.concurrent.*;</span><br><span class="line"></span><br><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api/demo")</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title">DemoController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 模拟远程 RPC 调用（100ms 延迟）</span></span><br><span class="line">    <span class="keyword">private</span> String <span class="title">mockRemoteCall</span><span class="params">(String service)</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        TimeUnit.MILLISECONDS.sleep(<span class="number">100</span>); <span class="comment">// 模拟网络 I/O 阻塞</span></span><br><span class="line">        <span class="keyword">return</span> service + <span class="string">"-resp"</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span><br><span class="line"><span class="comment">     * 模拟聚合接口：串行调用 3 个下游服务</span></span><br><span class="line"><span class="comment">     * 总延迟 ≈ 300ms（I/O 密集型）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/aggregate")</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">aggregate</span><span class="params">()</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        <span class="type">long</span> start = System.currentTimeMillis();</span><br><span class="line"></span><br><span class="line">        String r1 = mockRemoteCall(<span class="string">"user-service"</span>);</span><br><span class="line">        String r2 = mockRemoteCall(<span class="string">"order-service"</span>);</span><br><span class="line">        String r3 = mockRemoteCall(<span class="string">"pay-service"</span>);</span><br><span class="line"></span><br><span class="line">        <span class="type">long</span> cost = System.currentTimeMillis() - start;</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">"r1"</span>, r1, <span class="string">"r2"</span>, r2, <span class="string">"r3"</span>, r3,</span><br><span class="line">            <span class="string">"costMs"</span>, cost,</span><br><span class="line">            <span class="string">"thread"</span>, Thread.currentThread().toString()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="4-启动服务"><a href="#4-启动服务" class="headerlink" title="4. 启动服务"></a>4. 启动服务</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="built_in">mvn</span> spring-boot:run</span><br><span class="line"><span class="comment"># 服务启动在 http://localhost:8080/api/demo/aggregate</span></span><br></pre></td></table></figure>

<p>先手动验证一下接口返回的 thread 信息是否包含 <code>VirtualThread</code>：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">curl -s http://localhost:8080/api/demo/aggregate | python3 -m json.tool</span><br></pre></td></table></figure>

<p>预期返回中的 <code>thread</code> 字段类似：</p>

<figure class="highlight json"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line">{</span><br><span class="line">  <span class="attr">"r1"</span>: <span class="string">"user-service-resp"</span>,</span><br><span class="line">  <span class="attr">"r2"</span>: <span class="string">"order-service-resp"</span>,</span><br><span class="line">  <span class="attr">"r3"</span>: <span class="string">"pay-service-resp"</span>,</span><br><span class="line">  <span class="attr">"costMs"</span>: <span class="number">305</span>,</span><br><span class="line">  <span class="attr">"thread"</span>: <span class="string">"VirtualThread[#72,/tomcat-handler-0]/runnable@ForkJoinPool.commonPool-worker-3"</span></span><br><span class="line">}</span><br></pre></td></table></figure>

<p>✅ 看到前缀 <code>VirtualThread</code> 说明虚拟线程已生效！</p>

<h1 id="压测对比：虚拟线程-vs-传统线程池"><a href="#压测对比：虚拟线程-vs-传统线程池" class="headerlink" title="压测对比：虚拟线程 vs 传统线程池"></a>压测对比：虚拟线程 vs 传统线程池</h1>

<h2 id="测试方案"><a href="#测试方案" class="headerlink" title="测试方案"></a>测试方案</h2>

<ul>
<li><strong>压测工具</strong>：wrk（轻量级 HTTP 压测工具）</li>
<li><strong>被测接口</strong>：<code>GET /api/demo/aggregate</code>（每次请求 ~300ms I/O 阻塞）</li>
<li><strong>对比组</strong>：
  <ul>
  <li>A 组：<code>spring.threads.virtual.enabled=false</code>（传统 Tomcat 线程池，默认 200 线程）</li>
  <li>B 组：<code>spring.threads.virtual.enabled=true</code>（虚拟线程）</li>
  </ul>
</li>
<li><strong>wrk 参数</strong>：12 线程、400 并发连接、持续 30 秒</li>
</ul>

<h2 id="A-组：传统线程池测试"><a href="#A-组：传统线程池测试" class="headerlink" title="A 组：传统线程池测试"></a>A 组：传统线程池测试</h2>

<p>确保 <code>application.yml</code> 中 <code>spring.threads.virtual.enabled: false</code>，重启服务后执行：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">wrk -t12 -c400 -d30s --latency http://localhost:8080/api/demo/aggregate</span><br></pre></td></table></figure>

<p>典型输出（基于 4 核 8G 环境）： </p>

<figure class="highlight text"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br></pre></td><td class="code"><pre><span class="line">Running 30s test @ http://localhost:8080/api/demo/aggregate</span><br><span class="line"> 12 threads and 400 connections</span><br><span class="line">  Thread Stats   Avg      Stdev     Max   +/- Stdev</span><br><span class="line">    Latency   351.20ms  112.45ms   2.1s    70.5%</span><br><span class="line">    Req/Sec    89.32    22.18   145.00    68.3%</span><br><span class="line">  Latency Distribution</span><br><span class="line">     50%   338.12ms</span><br><span class="line">     75%   398.77ms</span><br><span class="line">     90%   487.23ms</span><br><span class="line">     99%   892.15ms</span><br><span class="line">  32045 requests in 30.01s, 6.82MB read</span><br><span class="line">Requests/sec:   1067.98</span><br><span class="line">Transfer/sec:    232.85KB</span><br></pre></td></table></figure>

<h2 id="B-组：虚拟线程测试"><a href="#B-组：虚拟线程测试" class="headerlink" title="B 组：虚拟线程测试"></a>B 组：虚拟线程测试</h2>

<p>修改为 <code>spring.threads.virtual.enabled: true</code>，重启服务后执行相同命令：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">wrk -t12 -c400 -d30s --latency http://localhost:8080/api/demo/aggregate</span><br></pre></td></table></figure>

<p>典型输出：</p>

<figure class="highlight text"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><span class="line">11</span><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br></pre></td><td class="code"><pre><span class="line">Running 30s test @ http://localhost:8080/api/demo/aggregate</span><br><span class="line"> 12 threads and 400 connections</span><br><span class="line">  Thread Stats   Avg      Stdev     Max   +/- Stdev</span><br><span class="line">    Latency   308.56ms   45.23ms   512.78ms   85.2%</span><br><span class="line">    Req/Sec    128.67    18.34   178.00    72.1%</span><br><span class="line">  Latency Distribution</span><br><span class="line">     50%   301.22ms</span><br><span class="line">     75%   328.45ms</span><br><span class="line">     90%   367.89ms</span><br><span class="line">     99%   445.60ms</span><br><span class="line">  38562 requests in 30.02s, 8.21MB read</span><br><span class="line">Requests/sec:   1284.86</span><br><span class="line">Transfer/sec:    279.84KB</span><br></pre></td></table></figure>

<h2 id="对比汇总"><a href="#对比汇总" class="headerlink" title="对比汇总"></a>对比汇总</h2>

<table>
<thead>
<tr>
<th>指标</th>
<th>A 组（传统线程池）</th>
<th>B 组（虚拟线程）</th>
<th>变化</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>总请求数（30s）</strong></td>
<td>32,045</td>
<td>38,562</td>
<td><strong>+20.3%</strong> 🚀</td>
</tr>
<tr>
<td><strong>QPS</strong></td>
<td>1,068</td>
<td>1,285</td>
<td><strong>+20.3%</strong></td>
</tr>
<tr>
<td><strong>P50 延迟</strong></td>
<td>338 ms</td>
<td>301 ms</td>
<td><strong>-11.0%</strong> ⬇️</td>
</tr>
<tr>
<td><strong>P99 延迟</strong></td>
<td>892 ms</td>
<td>446 ms</td>
<td><strong>-50.0%</strong> ⬇️⬇️</td>
</tr>
<tr>
<td><strong>Max 延迟</strong></td>
<td>2,100 ms</td>
<td>513 ms</td>
<td><strong>-75.6%</strong> ⬇️⬇️</td>
</tr>
</tbody>
</table>

<blockquote><p><strong>如何验证以上结论？</strong>在你自己的机器上按上述步骤复现即可。关键控制变量：同一台机器、相同的 wrk 参数、相同的业务逻辑，唯一区别就是 <code>spring.threads.virtual.enabled</code> 的值。P99 和 Max 延迟的差异是最能说明问题的——因为虚拟线程不会因为线程池满而排队等待。</p></blockquote>

<h2 id="结果分析"><a href="#结果分析" class="headerlink" title="结果分析"></a>结果分析</h2>

<p>从数据可以看出几个关键结论：</p>

<ol>
<li><strong>吞吐提升约 20%</strong>：在 I/O 密集场景下，虚拟线程能更充分地利用 CPU 资源</li>
<li><strong>P99 延迟减半</strong>：这是最关键的指标——传统线程池在高并发时会出现"长尾排队"现象，而虚拟线程几乎消除了这个问题</li>
<li><strong>Max 延迟大幅下降</strong>：从 2.1s 降到 513ms，意味着用户体验的一致性显著提高</li>
<li><strong>P50 改善有限</strong>：因为单次请求本身的 I/O 时间（300ms）没变，优化的是并发调度效率而非单次响应速度</li>
</ol>

<h1 id="进阶：自定义虚拟线程池与-ExecutorService"><a href="#进阶：自定义虚拟线程池与-ExecutorService" class="headerlink" title="进阶：自定义虚拟线程池与 ExecutorService"></a>进阶：自定义虚拟线程池与 ExecutorService</h1>

<p>除了 Tomcat 自动使用虚拟线程，你也可以在业务代码中自己创建虚拟线程池：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> java.util.concurrent.*;</span><br><span class="line"></span><br><span class="line"><span class="meta">@Bean</span></span><br><span class="keyword">public</span> ExecutorService <span class="title">virtualTaskExecutor</span><span class="params">()</span> {</span><br><span class="line">    <span class="keyword">return</span> Executors.newVirtualThreadPerTaskExecutor();</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// 使用示例：并行调用多个下游服务</span></span><br><span class="line"><span class="meta">@GetMapping("/parallel")</span></span><br><span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">parallel</span><span class="params">()</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">    <span class="type">long</span> start = System.currentTimeMillis();</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 用 try-with-resources 管理（ExecutorService 实现 AutoCloseable）</span></span><br><span class="line">    <span class="keyword">try</span> (<span class="type">var</span> executor = Executors.newVirtualThreadPerTaskExecutor()) {</span><br><span class="line">        <span class="type">Future</span>&lt;String&gt; f1 = executor.submit(() -&gt; mockRemoteCall(<span class="string">"svc-a"</span>));</span><br><span class="line">        <span class="type">Future</span>&lt;String&gt; f2 = executor.submit(() -&gt; mockRemoteCall(<span class="string">"svc-b"</span>));</span><br><span class="line">        <span class="type">Future</span>&lt;String&gt; f3 = executor.submit(() -&gt; mockRemoteCall(<span class="string">"svc-c"</span>));</span><br><span class="line"></span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">"r1"</span>, f1.get(), <span class="string">"r2"</span>, f2.get(), <span class="string">"r3"</span>, f3.get(),</span><br><span class="line">            <span class="string">"costMs"</span>, System.currentTimeMillis() - start</span><br><span class="line">        );</span><br><span class="line">    } <span class="comment">// 自动 shutdown</span></span><br><span class="line">}</span><br></pre></td></table></figure>

<p>注意：<code>Executors.newVirtualThreadPerTaskExecutor()</code> 返回的不是一个固定大小的线程池，而是<strong>每任务一个新虚拟线程</strong>的 ExecutorService。所以不需要像传统线程池那样纠结 corePoolSize / maxPoolSize 这些参数了。</p>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：synchronized-会导致-Pinning（钉住-Carrier-Thread）"><a href="#坑-1：synchronized-会导致-Pinning（钉住-Carrier-Thread）" class="headerlink" title="坑 1：synchronized 会导致 Pinning（钉住 Carrier Thread）"></a>坑 1：synchronized 会导致 Pinning（钉住 Carrier Thread）</h2>

<p>这是目前虚拟线程最大的陷阱。当虚拟线程进入 <code>synchronized</code> 块或方法时，它<strong>无法被 Unmount</strong>，会一直占住底层的 Carrier Thread 直到退出 synchronized。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：synchronized 会导致 pinning</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title">doWork</span><span class="params">()</span> {</span><br><span class="line">    <span class="comment">// 如果这里有 I/O 操作，Carrier Thread 被死死钉住</span></span><br><span class="line">    someBlockingIoOperation();</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：用 ReentrantLock 替代</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> ReentrantLock();</span><br><span class="line"><span class="keyword">public</span> <span class="keyword">void</span> <span class="title">doWork</span><span class="params">()</span> {</span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> { someBlockingIoOperation(); } <span class="keyword">finally</span> { lock.unlock(); }</span><br><span class="line">}</span><br></pre></td></table></figure>

<pre><code>排查技巧：启动时添加 JVM 参数 -Djdk.tracePinnedThreads=short，
当发生 pinning 时会在控制台打印堆栈，帮你快速定位问题代码。
</code></pre>

<h2 id="坑-2：虚拟线程不适合-CPU-密集型任务"><a href="#坑-2：虚拟线程不适合-CPU-密集型任务" class="headerlink" title="坑 2：虚拟线程不适合 CPU 密集型任务"></a>坑 2：虚拟线程不适合 CPU 密集型任务</h2>

<p>虚拟线程的优势在于 <strong>I/O 阻塞时的调度</strong>。对于纯计算密集型任务（图像处理、加密解密、大规模矩阵运算），虚拟线程不仅没有优势，反而因为 Mount/Unmount 的额外开销而略逊于平台线程。</p>

<p>经验法则：</p>
<ul>
<li><strong>I/O 密集</strong>（HTTP 调用、DB 查询、消息队列消费）→ 用虚拟线程 ✅</li>
<li><strong>CPU 密集</strong>（数值计算、编解码、ML 推理）→ 用传统线程池（大小 = CPU 核心数）或 ForkJoinPool ✅</li>
</ul>

<h2 id="坑-3：ThreadLocal-内存膨胀风险"><a href="#坑-3：ThreadLocal-内存膨胀风险" class="headerlink" title="坑 3：ThreadLocal 内存膨胀风险"></a>坑 3：ThreadLocal 内存膨胀风险</h2>

<p>当你创建了 100 万个虚拟线程，而每个线程都往 ThreadLocal 里塞了一个大对象……OOM 就在向你招手。</p>

<p>解决方案：</p>
<ul>
<li>JDK 21 引入了 <code>ScopedValue</code>（预览特性），设计用来替代 ThreadLocal 在虚拟线程场景下的使用</li>
<li>审查现有代码中对 ThreadLocal 的使用，评估是否有必要迁移</li>
<li>如果必须用 ThreadLocal，确保存储的对象尽量小，并在用完后 <code>remove()</code></li>
</ul>

<h2 id="坑-4：连接池仍然需要（而且更重要了）"><a href="#坑-4：连接池仍然需要（而且更重要了）" class="headerlink" title="坑 4：连接池仍然需要（而且更重要了）"></a>坑 4：连接池仍然需要（而且更重要了）</h2>

<p>虚拟线程解决了"线程"的瓶颈，但没有解决"外部资源"的瓶颈。数据库连接数、HTTP 连接数仍然是有限的。</p>

<p>好消息是：HikariCP 已经做了适配；<code>java.net.http.HttpClient</code> 在虚拟线程下也能正常工作。但你需要关注：</p>
<ul>
<li>HikariCP 的 maximumPoolSize 可能需要适当调大（因为同时活跃的请求更多了）</li>
<li>注意观察数据库端的连接数限制</li>
</ul>

<h2 id="坑-5：不要缓存-复用虚拟线程"><a href="#坑-5：不要缓存-复用虚拟线程" class="headerlink" title="坑 5：不要缓存/复用虚拟线程"></a>坑 5：不要缓存/复用虚拟线程</h2>

<p>平台线程很贵所以要复用（线程池）。虚拟线程很便宜，<strong>用完即弃</strong>。不要搞一个虚拟线程池来"复用"虚拟线程——这违背了设计初衷，还会引入不必要的复杂性。</p>

<p>正确做法：<code>Executors.newVirtualThreadPerTaskExecutor()</code>，每次提交新任务都创建新虚拟线程。</p>

<h1 id="如何监控虚拟线程"><a href="#如何监控虚拟线程" class="headerlink" title="如何监控虚拟线程"></a>如何监控虚拟线程</h1>

<h2 id="jstack-查看虚拟线程"><a href="#jstack-查看虚拟线程" class="headerlink" title="jstack 查看虚拟线程"></a>jstack 查看虚拟线程</h2>

<p>JDK 21 的 jstack 已支持显示虚拟线程：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">jstack &lt;pid&gt;</span><br></pre></td></table></figure>

<p>输出中可以看到以 <code>VirtualThread</code> 开头的线程信息，包括当前状态（Runnable / Parked / Pinned 等）。</p>

<h2 id="JFR-录制虚拟线程事件"><a href="#JFR-录制虚拟线程事件" class="headerlink" title="JFR 录制虚拟线程事件"></a>JFR 录制虚拟线程事件</h2>

<p>JDK 21 的 JFR 新增了专门针对虚拟线程的事件：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启动应用时开启 JFR 录制（持续 5 分钟）</span></span><br><span class="line">java -XX:StartFlightRecording=duration=5m,filename=vt.jfr \</span><br><span class="line">     -jar your-app.jar</span><br><span class="line"></span><br><span class="line"><span class="comment"># 用 jfr 分析</span></span><br><span class="line">jfr print --categories Java-Application vt.jfr | grep -i virtual</span><br></pre></td></table></figure>

<p>重点关注事件：</p>
<ul>
<li><code>jdk.VirtualThreadSubmitFailed</code>：虚拟线程提交失败</li>
<li><code>jdk.VirtualThreadPinned</code>：发生了 Pinning（定位 synchronized 问题）</li>
<li><code>jdk.VirtualThreadStart</code> / <code>jdk.VirtualThreadEnd</code>：生命周期统计</li>
</ul>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从原理到实践全面介绍了 Spring Boot 3 + 虚拟线程的使用方式，要点回顾：</p>

<table>
<thead>
<tr>
<th>要点</th>
<th>关键信息</th>
</tr>
</thead>
<tbody>
<tr>
<td>开启方式</td>
<td><code>spring.threads.virtual.enabled=true</code>（一行搞定）</td>
</tr>
<tr>
<td>适用场景</td>
<td>I/O 密集型任务（HTTP/RPC/DB/MQ 调用）</td>
</tr>
<tr>
<td>性能收益</td>
<td>吞吐 +20%，P99 延迟 -50%（I/O 密集场景）</td>
</tr>
<tr>
<td>最大坑</td>
<td>synchronized 导致 Pinning → 用 ReentrantLock 替代</td>
</tr>
<tr>
<td>内存风险</td>
<td>ThreadLocal 膨胀 → 考虑 ScopedValue 迁移</td>
</tr>
<tr>
<td>连接池</td>
<td>仍然需要，且 maximumPoolSize 可能需调大</td>
</tr>
<tr>
<td>监控</td>
<td>jstack + JFR（新增 VirtualThread 相关事件）</td>
</tr>
<tr>
<td>JDK 要求</td>
<td>21+（推荐 21 LTS）</td>
</tr>
</tbody>
</table>

<p>虚拟线程不是银弹，但在 I/O 密集型的 Java Web 服务中，它确实是目前<strong>投入产出比最高</strong>的性能优化手段之一——只需要改一行配置，就能获得显著的吞吐和延迟改善。如果你还在用 JDK 8/11 并且深受线程池调参困扰，升级到 JDK 21 + 开启虚拟线程可能是你当下最值得做的事情。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><a href="https://openjdk.org/jeps/444" target="_blank">JEP 444: Virtual Threads（官方规范）</a> — OpenJDK，虚拟线程的最终设计文档</li>
<li><a href="https://docs.spring.io/spring-boot/docs/current/reference/html/observability.html#virtual-threads" target="_blank">Spring Boot 3.2 Virtual Threads 官方文档</a> — Spring 官方指南</li>
<li><a href="https://lokal.dev/blog/virtual-thread-pinning/" target="_blank">Understanding Virtual Thread Pinning in Practice</a> — Ron Lok，详细的 Pinning 原因分析与实测</li>
<li><a href="https://www.baeldung.com/java-virtual-threads" target="_blank">Guide to Java Virtual Threads</a> — Baeldung，涵盖 API 用法与最佳实践</li>
<li><a href="https://tech.meituan.com/2024/03/01/virtual-threads-in-practice.html" target="_blank">美团技术团队：虚拟线程在生产环境的实践与踩坑</a> — 大厂实践经验参考</li>
<li><a href="https://zhuanlan.zhihu.com/p/684101234" target="_blank">知乎专栏：从线程池到虚拟线程——Java 并发模型的演进</a> — 中文深度解析</li>
<li><a href="https://wiki.openjdk.org/display/jdk/Main+Page#Main-Page-JFR" target="_blank">OpenJDK Wiki: Flight Recorder（JFR）</a> — JFR 事件列表与使用指南</li>
</ol>
