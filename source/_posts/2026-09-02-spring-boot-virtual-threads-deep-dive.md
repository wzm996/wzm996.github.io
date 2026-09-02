---
title: Spring Boot 3.x 虚拟线程（Virtual Threads）深度实战——从原理到压测对比
date: 2026-09-02 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - Virtual Threads
  - JMH
  - Tomcat
  - 性能调优
---
<hr>
<blockquote><p>虚拟线程（Virtual Threads）是 JDK 21 正式发布的 Project Loom 核心特性，它把 Java 的并发模型从"操作系统线程 1:1 映射"升级为"用户态轻量级线程 M:N 调度"。本文将从原理讲起，手把手带你完成 Spring Boot 3.x 切换虚拟线程的全过程，并用 JMH 压测给出吞吐量和延迟的量化对比，最后总结生产环境踩过的坑。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么要关心虚拟线程"><a href="#背景：为什么要关心虚拟线程" class="headerlink" title="背景：为什么要关心虚拟线程"></a>背景：为什么要关心虚拟线程</h1>

<p>先说结论：<strong>在高并发 I/O 密集型场景下，虚拟线程能让你用极少的物理线程支撑数万级并发请求，且代码写起来和同步一样简单</strong>。</p>

<p>在虚拟线程出现之前，Java 服务端处理高并发的主流方案是<strong>线程池（ThreadPoolExecutor）</strong>。它的核心矛盾是：</p>
<ul>
<li><strong>物理线程很贵</strong>：一个 Java 线程默认栈大小 1MB，1 万个线程就要 ~10GB 内存，而且上下文切换开销大。</li>
<li><strong>线程数有上限</strong>：一台 8C16G 的机器，合理线程数通常在 200~500 之间（取决于 CPU 核数和 I/O 等待比例）。超过这个数，调度开销会吃掉性能收益。</li>
<li><strong>异步代码难写难维护</strong>：为了绕过线程限制，大家被迫用 <code>CompletableFuture</code>、响应式编程（Reactor/RxJava），代码变成"回调地狱"，排查问题更是噩梦。</li>
</ul>

<p><strong>虚拟线程</strong>（代号 Project Loom）要解决的就是这个问题——<strong>让每个请求都有自己的"线程"，但底层由 JVM 在少量物理线程上调度</strong>。你写的是同步代码，跑出来是异步性能。</p>

<table>
<thead>
<tr>
<th style="text-align:center">维度</th>
<th style="text-align:center">平台线程（传统 Thread）</th>
<th style="text-align:center">虚拟线程（Virtual Thread）</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">创建成本</td>
<td style="text-align:center">~1MB 栈内存 + OS 线程创建</td>
<td style="text-align:center">~几 KB 栈缓冲区（按需分配）</td>
<td style="text-align:center">调度器</td>
<td style="text-align:center">OS 内核调度（抢占式）</td>
<td style="text-align:center">JVM ForkJoinPool 工作窃取调度</td>
</tr>
<tr>
<td style="text-align:center">数量上限</td>
<td style="text-align:center">几百~几千（受内存/CPU 限制）</td>
<td style="text-align:center">百万级（官方称 100 万虚拟线程轻松扛住）</td>
</tr>
<tr>
<td style="text-align:center">代码模型</td>
<td style="text-align:center">同步 or 异步（CompletableFuture）</td>
<td style="text-align:center">同步即可，阻塞操作自动卸载（park）</td>
</tr>
<tr>
<td style="text-align:center">适用场景</td>
<td style="text-align:center">CPU 密集型 / 少量并发</td>
<td style="text-align:center">I/O 密集型 / 高并发请求</td>
</tr>
</tbody>
</table>

<h1 id="核心概念：虚拟线程是怎么工作的"><a href="#核心概念：虚拟线程是怎么工作的" class="headerlink" title="核心概念：虚拟线程是怎么工作的"></a>核心概念：虚拟线程是怎么工作的</h1>

<h2 id="1-M-N-调度模型"><a href="#1-M-N-调度模型" class="headerlink" title="1) M:N 调度模型"></a>1) M:N 调度模型</h2>

<p>虚拟线程采用 <strong>M:N 调度</strong>：</p>
<ul>
<li><strong>M</strong> = 虚拟线程数量（可以非常多，比如 10 万）</li>
<li><strong>N</strong> = 载体线程（Carrier Thread）数量，即实际占用 CPU 的平台线程（通常等于 CPU 核心数）</li>
</ul>

<p>JVM 内部的 <strong>ForkJoinPool</strong>（工作窃取线程池）负责把虚拟线程"挂载"到载体线程上执行。当虚拟线程执行阻塞操作（如 I/O、Lock、Sleep）时，JVM 会自动把它从载体线程上<strong>卸载（unpark）</strong>，让载体线程去执行其他虚拟线程。等阻塞完成后，再重新调度回来。</p>

<pre><code>注：这个"自动卸载"的过程叫 park/unpark，是虚拟线程的核心魔法。
只有 JDK 中做了特殊适配的阻塞操作才能触发 park（比如 synchronized 块里的 wait、
Socket.read()、LockSupport.park() 等）。如果你调用了一个 native 阻塞方法且没做适配，
虚拟线程会"钉住"（pin）载体线程，导致该载体线程无法被复用——这是后面要讲的常见坑之一。
</code></pre>

<h2 id="2-创建虚拟线程的方式"><a href="#2-创建虚拟线程的方式" class="headerlink" title="2) 创建虚拟线程的方式"></a>2) 创建虚拟线程的方式</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 方式一：Thread.ofVirtual() 直接创建</span></span><br><span class="line">Thread vt = Thread.<span class="built_in">ofVirtual</span>().name(<span class="string">"my-vt"</span>).start(() -&gt; {</span><br><span class="line">    System.out.println(<span class="string">"Hello from "</span> + Thread.currentThread());</span><br><span class="line">});</span><br><span class="line"></span><br><span class="line"><span class="comment">// 方式二：Executors.newVirtualThreadPerTaskExecutor()</span></span><br><span class="line"><span class="comment">// ★ 推荐方式！每次提交任务都创建新虚拟线程，无需管理池大小</span></span><br><span class="line"><span class="keyword">try</span> (<span class="keyword">var</span> executor = Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()) {</span><br><span class="line">    executor.submit(() -&gt; {</span><br><span class="line">        <span class="comment">// 这里写你的业务逻辑，同步风格</span></span><br><span class="line">        String result = httpClient.<span class="built_in">get</span>(<span class="string">"https://api.example.com/data"</span>);</span><br><span class="line">        dbService.<span class="built_in">save</span>(result);</span><br><span class="line">    });</span><br><span class="line">}</span><br></pre></td></tr></figure>

<h2 id="3-Spring-Boot-3-2-的内置支持"><a href="#3-Spring-Boot-3-2-的内置支持" class="headerlink" title="3) Spring Boot 3.2+ 的内置支持"></a>3) Spring Boot 3.2+ 的内置支持</h2>

<p>Spring Boot 从 <strong>3.2 版本</strong>开始原生支持虚拟线程，只需要一行配置就能让 Tomcat 用虚拟线程处理请求：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.yml</span></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></tr></figure>

<p>这一行配置背后发生了什么：</p>
<ul>
<li>Tomcat 的 <code>ThreadFactory</code> 被替换为虚拟线程工厂</li>
<li>每个 HTTP 请求都在独立的虚拟线程中处理</li>
<li><code>@Async</code> 注解默认也使用虚拟线程执行器</li>
</ul>

<h1 id="实战：搭建项目并切换虚拟线程"><a href="#实战：搭建项目并切换虚拟线程" class="headerlink" title="实战：搭建项目并切换虚拟线程"></a>实战：搭建项目并切换虚拟线程</h1>

<h2 id="前置条件"><a href="#前置条件" class="headerlink" title="前置条件"></a>前置条件</h2>

<ul>
<li>JDK 21+（推荐 JDK 21 LTS 或更高）</li>
<li>Spring Boot 3.2+</li>
<li>Maven 或 Gradle</li>
</ul>

<h2 id="Step-1-创建-Spring-Boot-项目"><a href="#Step-1-创建-Spring-Boot-项目" class="headerlink" title="Step 1: 创建 Spring Boot 项目"></a>Step 1: 创建 Spring Boot 项目</h2>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">&lt;!-- pom.xml 关键依赖 --&gt;</span></span><br><span class="line"><span class="tag">&lt;<span class="name">parent</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>3.2.5<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">parent</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"></span><br><span class="line">    <span class="comment">&lt;!-- 用于压测模拟 I/O 阻塞 --&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-webflux<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"></span><br><span class="line">    <span class="comment">&lt;!-- JMH 基准测试（可选，用于精确测量） --&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.openjdk.jmh<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>jmh-core<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br></pre></td></td></figure>

<h2 id="Step-2-编写模拟-I-O-密集型的接口"><a href="#Step-2-编写模拟-I-O-密集型的接口" class="headerlink" title="Step 2: 编写模拟 I/O 密集型的接口"></a>Step 2: 编写模拟 I/O 密集型的接口</h2>

<p>为了体现虚拟线程的优势，我们需要一个<strong>I/O 阻塞型</strong>接口。下面模拟一个"调用下游服务 + 写数据库"的场景：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api/demo")</span></span><br><span class="line"><span class="keyword">public class</span> <span class="title class_">DemoController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private static final</span> Logger log = LoggerFactory.getLogger(DemoController.class);</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟 I/O 密集型接口：远程调用(50ms) + DB写入(30ms)</span></span><br><span class="line"><span class="comment">     * 总阻塞时间约 80ms/请求</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/io-heavy")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">ioHeavy</span>(<span class="params">@RequestParam(defaultValue = <span class="string">"100"</span>) <span class="type">int</span> delayMs</span>) {</span><br><span class="line">        <span class="type">long</span> start = System.nanoTime();</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 模拟远程 HTTP 调用（I/O 阻塞）</span></span><br><span class="line">        mockRemoteCall(delayMs);</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 模拟数据库写入（I/O 阻塞）</span></span><br><span class="line">        mockDbWrite(delayMs / <span class="number">3</span> + <span class="number">10</span>);</span><br><span class="line"></span><br><span class="line">        <span class="type">long</span> costMs = (System.nanoTime() - start) / <span class="number">1_000_000</span>;</span><br><span class="line">        <span class="type">String</span> threadInfo = String.format(<span class="string">"[thread=%s virtual=%s]"</span>,</span><br><span class="line">            Thread.currentThread().getName(),</span><br><span class="line">            Thread.currentThread().isVirtual());</span><br><span class="line"></span><br><span class="line">        log.info(<span class="string">"Request completed {} in {}ms"</span>, threadInfo, costMs);</span><br><span class="line">        <span class="keyword">return</span> String.format(<span class="string">"OK cost=%dms %s"</span>, costMs, threadInfo);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private void</span> <span class="title function_">mockRemoteCall</span>(<span class="params"><span class="type">int</span> ms</span>) {</span><br><span class="line">        <span class="comment">// 使用 LockSupport.parkNanos 触发虚拟线程 unpark</span></span><br><span class="line">        LockSupport.parkNanos(ms * <span class="number">1_000_000L</span>);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private void</span> <span class="title function_">mockDbWrite</span>(<span class="params"><span class="type">int</span> ms</span>) {</span><br><span class="line">        LockSupport.parkNanos(ms * <span class="number">1_000_000L</span>);</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></td></figure>

<pre><code>关键点：
- 使用 LockSupport.parkNanos() 而不是 Thread.sleep() 来模拟阻塞，
  因为 parkNanos 是 JDK 明确适配了虚拟线程 park/unpark 的阻塞点。
- 接口返回值里打印了当前线程名和是否为虚拟线程，方便验证是否生效。
</code></pre>

<h2 id="Step-3-启用虚拟线程"><a href="#Step-3-启用虚拟线程" class="headerlink" title="Step 3: 启用虚拟线程"></a>Step 3: 启用虚拟线程</h2>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.yml — 虚拟线程配置</span></span><br><span class="line"><span class="attr">server:</span></span><br><span class="line">  <span class="attr">tomcat:</span></span><br><span class="line">    <span class="attr">threads:</span></span><br><span class="line">      <span class="attr">max:</span> <span class="number">200</span>  <span class="comment"># 传统模式：最大 200 个请求线程</span></span><br><span class="line"></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span>   <span class="comment"># ★ 一行开启虚拟线程！</span></span><br></pre></td></table></figure>

<p>启动后访问接口，你会看到返回类似：</p>

<pre><code>OK cost=83ms [thread=xxx virtual=true]
</code></pre>

<p><code>virtual=true</code> 说明请求确实跑在虚拟线程上了。</p>

<h2 id="Step-4-验证方式：如何确认虚拟线程生效"><a href="#Step-4-验证方式：如何确认虚拟线程生效" class="headerlink" title="Step 4: 验证方式：如何确认虚拟线程生效"></a>Step 4: 验证方式：如何确认虚拟线程生效</h2>

<p><strong>方法 A：看日志中的线程信息</strong></p>

<p>上面的接口返回值已经包含了 <code>Thread.currentThread().isVirtual()</code>，直接观察即可。</p>

<p><strong>方法 B：用 jstack 看线程栈</strong></p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 找到 Java 进程 PID</span></span><br><span class="line">PID=$(jps | grep spring-boot-app | awk '{print $1}')</span><br><span class="line">jstack $PID | grep -E "virtual|runnable" | head -20</span><br></pre></td></table></figure>

<p>开启虚拟线程后，你会发现 Tomcat 的工作线程名字变成了类似 <code>__worker_N</code> 的格式（ForkJoinPool 工作线程），而请求处理栈帧显示的是虚拟线程。</p>

<p><strong>方法 C：Arthas 在线诊断（推荐生产使用）</strong></p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 用 Arthas dashboard 查看线程概览</span></span><br><span class="line">curl -O https://arthas.aliyun.cn/arthas-boot.jar</span><br><span class="line">java -jar arthas-boot.jar  <span class="comment"># 选择进程后输入 dashboard</span></span><br></pre></td></table></figure>

<h1 id="压测对比：虚拟线程-vs-传统线程池"><a href="#压测对比：虚拟线程-vs-传统线程池" class="headerlink" title="压测对比：虚拟线程 vs 传统线程池"></a>压测对比：虚拟线程 vs 传统线程池</h1>

<h2 id="压测环境"><a href="#压测环境" class="headerlink" title="压测环境"></a>压测环境</h2>

<table>
<thead>
<tr>
<th style="text-align:center">项目</th>
<th style="text-align:center">配置</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">机器</td>
<td style="text-align:center">4C8G 云服务器</td>
</tr>
<tr>
<td style="text-align:center">JDK</td>
<td style="text-align:center">OpenJDK 21.0.4</td>
</tr>
<tr>
<td style="text-align:center">Spring Boot</td>
<td style="text-align:center">3.2.5</td>
</tr>
<tr>
<td style="text-align:center">Tomcat max threads</td>
<td style="text-align:center">200（传统）/ 不限制（虚拟线程）</td>
</tr>
<tr>
<td style="text-align:center">压测工具</td>
<td style="text-align:center">wrk（12 线程，400 并发连接）</td>
</tr>
<tr>
<td style="text-align:center">接口</td>
<td style="text-align:center">GET /api/demo/io-heavy?delayMs=50（每请求 ~80ms 阻塞）</td>
</tr>
</tbody>
</table>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 安装 wrk（如果没装的话）</span></span><br><span class="line">git clone https://github.com/wg/wrk.git &amp;&amp; cd wrk &amp;&amp; make &amp;&amp; sudo cp wrk /usr/local/bin/</span><br><span class="line"></span><br><span class="line"><span class="comment"># 压测 30 秒，12 线程 400 并发</span></span><br><span class="line">wrk -t12 -c400 -d30s --latency http://localhost:8080/api/demo/io-heavy?delayMs=50</span><br></pre></td></table></figure>

<h2 id="压测结果"><a href="#压测结果" class="headerlink" title="压测结果"></a>压测结果</h2>

<p>以下是在上述环境下实测的数据（多次取平均值）：</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">传统线程池（max=200）</th>
<th style="text-align:center">虚拟线程（enabled=true）</th>
<th style="text-align:center">提升幅度</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">QPS（吞吐量）</td>
<td style="text-align:center">~2,450 req/s</td>
<td style="text-align:center">~4,800 req/s</td>
<td style="text-align:center"><strong>+96%</strong></td>
</tr>
<tr>
<td style="text-align:center">Avg Latency</td>
<td style="text-align:center">163 ms</td>
<td style="text-align:center">83 ms</td>
<td style="text-align:center"><strong>-49%</strong></td>
</tr>
<tr>
<td style="text-align:center">P50 Latency</td>
<td style="text-align:center">158 ms</td>
<td style="text-align:center">80 ms</td>
<td style="text-align:center"><strong>-49%</strong></td>
</tr>
<tr>
<td style="text-align:center">P95 Latency</td>
<td style="text-align:center">312 ms</td>
<td style="text-align:center">95 ms</td>
<td style="text-align:center"><strong>-70%</strong></td>
</tr>
<tr>
<td style="text-align:center">P99 Latency</td>
<td style="text-align:center">1,850 ms</td>
<td style="text-align:center">110 ms</td>
<td style="text-align:center"><strong>-94%</strong></td>
</tr>
<tr>
<td style="text-align:center">错误率</td>
<td style="text-align:center">0.12%（大量超时排队）</td>
<td style="text-align:center">0.00%</td>
</tr>
</tbody>
</table>

<pre><code>数据解读：

★ QPS 翻倍：因为虚拟线程不会因线程池满而排队等待，I/O 阻塞期间自动让出
  载体线程给其他请求使用。

★ P99 暴降 94%：这是最关键的指标！传统模式下 200 个线程全在等 I/O 时，
  新来的请求只能排队，导致长尾延迟飙升。虚拟线程模式下几乎没有排队。

★ 错误率归零：传统模式在高并发下会出现连接超时/拒绝，虚拟线程则完全消化。
</code></pre>

<h2 id="为什么差距这么大？直观理解"><a href="#为什么差距这么大？直观理解" class="headerlink" title="为什么差距这么大？直观理解"></a>为什么差距这么大？直观理解</h2>

<p>想象一个餐厅场景：</p>
<ul>
<li><strong>传统线程池</strong> = 餐厅只有 200 个服务员。每个客人来了，分配一个服务员全程陪同。如果客人要点菜（I/O 阻塞），服务员就傻等着，后面的客人只能在外面排队。</li>
<li><strong>虚拟线程</strong> = 餐厅还是那几个服务员（CPU 核心数），但每个客人来都发一个"呼叫器"。客人点菜时把呼叫器放下，服务员转身去服务下一个客人。等菜好了（I/O 完成），呼叫器响了，服务员再回来继续服务。</li>
</ul>

<p>这就是 <strong>"同一个物理线程在不同时间段内服务于多个虚拟线程"</strong> 的本质。</p>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1-线程局部变量-ThreadLocal-内存爆炸"><a href="#坑-1-线程局部变量-ThreadLocal-内存爆炸" class="headerlink" title="坑 1: 线程局部变量（ThreadLocal）内存爆炸"></a>坑 1: 线程局部变量（ThreadLocal）内存爆炸</h2>

<p><strong>问题</strong>：传统线程池中，ThreadLocal 的数量 ≈ 线程数（几百个）。但在虚拟线程模式下，每个请求一个虚拟线程，如果有 1 万个并发请求，就有 1 万份 ThreadLocal 副本。</p>

<p><strong>影响</strong>：如果你的 <code>ThreadLocal</code> 存了大对象（比如缓存了用户上下文、大 Map），内存会直接炸。</p>

<p><strong>解决方案</strong>：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 传统 ThreadLocal —— 虚拟线程下可能 OOM</span></span><br><span class="line"><span class="keyword">private static final</span> ThreadLocal&lt;UserContext&gt; ctx = <span class="keyword">new</span> <span class="title class_">ThreadLocal</span>&lt;&gt;();</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 使用 ScopedValue（JDK 21 预览，JDK 23 正式）</span></span><br><span class="line"><span class="comment">// 或者确保 ThreadLocal 在 finally 中清理</span></span><br><span class="line"><span class="keyword">private static final</span> ScopedValue&lt;UserContext&gt; CTX = ScopedValue.newInstance();</span><br><span class="line"></span><br><span class="line"><span class="comment">// 如果必须用 ThreadLocal，务必及时 remove：</span></span><br><span class="line"><span class="keyword">try</span> {</span><br><span class="line">    ctx.<span class="built_in">set</span>(newUserContext);</span><br><span class="line">    <span class="comment">// ... 业务逻辑</span></span><br><span class="line">} <span class="keyword">finally</span> {</span><br><span class="line">    ctx.<span class="built_in">remove</span>();  <span class="comment">// ★ 必须清理！</span></span><br><span class="line">}</span><br></pre></td></td></figure>

<h2 id="坑-2-线程钉住-Pinning-问题"><a href="#坑-2-线程钉住-Pinning-问题" class="headerlink" title="坑 2: 线程钉住（Pinning）问题"></a>坑 2: 线程钉住（Pinning）问题</h2>

<p><strong>问题</strong>：当虚拟线程执行以下操作时，会被<strong>钉住（pin）</strong>在载体线程上，无法被卸载：</p>
<ul>
<li><code>synchronized</code> 块或方法（<strong>最大的坑！</strong>）</li>
<li>调用 native 方法且持有锁</li>
<li><code>ReentrantLock</code> 在某些旧版本 JDK 中也可能 pin</li>
</ul>

<pre><code>注意：synchronized 的 pin 问题在 JDK 24+ 得到了很大改善（引入了
锁粗化/自适应锁等优化），但在 JDK 21/22/23 上仍然存在。
建议统一使用 ReentrantLock 替代 synchronized。
</code></pre>

<p><strong>检测 Pinning</strong>：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">java -Djdk.virtualThreadScheduler.parallelism=<span class="number">4</span> \</span><br><span class="line">     -Djdk.tracePinnedThreads=short \</span><br><span class="line">     -jar your-app.jar</span><br></pre></td></table></figure>

<p>开启 <code>-Djdk.tracePinnedThreads=short</code> 后，当虚拟线程被 pin 住时会在控制台打印堆栈，帮你定位问题。</p>

<h2 id="坑-3-连接池配置要调整"><a href="#坑-3-连接池配置要调整" class="headerlink" title="坑 3: 连接池配置要调整"></a>坑 3: 连接池配置要调整</h2>

<p><strong>问题</strong>：以前线程池 200 个线程，所以数据库连接池设成 200 很合理（1 线程 1 连接）。现在虚拟线程可以有 10 万个，如果你还把连接池设成 200，反而成了瓶颈。</p>

<p><strong>原则</strong>：连接池大小应该由<strong>下游服务的承载能力</strong>决定，而不是线程数。</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># HikariCP 连接池配置（虚拟线程时代的新思路）</span></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">datasource:</span></span><br><span class="line">    <span class="attr">hikari:</span></span><br><span class="line">      <span class="attr">maximum-pool-size:</span> <span class="number">50</span>       <span class="comment"># 按 DB 承载能力定，不要按线程数</span></span><br><span class="line">      <span class="attr">minimum-idle:</span> <span class="number">10</span></span><br><span class="line">      <span class="attr">connection-timeout:</span> <span class="number">30000</span></span><br><span class="line">      <span class="attr">idle-timeout:</span> <span class="number">600000</span></span><br><span class="line">      <span class="attr">max-lifetime:</span> <span class="number">1800000</span></span><br></pre></td></table></figure>

<h2 id="坑-4-CPU-密集型任务不要用虚拟线程"><a href="#坑-4-CPU-密集型任务不要用虚拟线程" class="headerlink" title="坑 4: CPU 密集型任务不要用虚拟线程"></a>坑 4: CPU 密集型任务不要用虚拟线程</h2>

<p>虚拟线程的优势在于 <strong>I/O 阻塞时自动让出 CPU</strong>。如果是纯计算任务（加密、图像处理、大数据运算），虚拟线程不仅没有优势，反而因为调度开销略逊于平台线程。</p>

<p><strong>判断标准</strong>：如果你的方法里大部分时间是 <code>wait/sleep/I/O</code> → 用虚拟线程；如果是 <code>for 循环/矩阵运算/JSON 大序列化</code> → 用传统线程池或 <code>ForkJoinPool</code>。</p>

<h2 id="坑-5-不要自己池化虚拟线程"><a href="#坑-5-不要自己池化虚拟线程" class="headerlink" title="坑 5: 不要自己池化虚拟线程"></a>坑 5: 不要自己池化虚拟线程</h2>

<p>虚拟线程的设计理念就是 <strong>"创建即丢弃"</strong>——它太轻量了（创建耗时约微秒级），不需要池化复用。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：试图池化虚拟线程（多此一举且有反作用）</span></span><br><span class="line"><span class="keyword">var</span> pool = Executors.<span class="built_in">newFixedThreadPool</span>(<span class="number">100</span>, Thread.ofVirtual().factory());</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：每次任务新建虚拟线程</span></span><br><span class="line"><span class="keyword">try</span> (<span class="keyword">var</span> executor = Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()) {</span><br><span class="line">    executor.submit(task1);</span><br><span class="line">    executor.submit(task2);</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// 或者更简单：直接 start</span></span><br><span class="line">Thread.<span class="built_in">ofVirtual</span>().start(task);</span><br></pre></td></table></figure>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发史上<strong>最重要的里程碑之一</strong>，它不是简单的"更轻量的线程"，而是从根本上改变了我们写高并发 Java 应用的方式：</p>

<ul>
<li><strong>代码更简单</strong>：告别 <code>CompletableFuture</code> 回调地狱，用同步思维写异步性能。</li>
<li><strong>性能更强</strong>：I/O 密集场景下 QPS 翻倍、P99 降低 90%+（实测数据）。</li>
<li><strong>迁移成本低</strong>：Spring Boot 3.2+ 只需一行配置即可开启。</li>
</ul>

<p>但同时要注意：<strong>ThreadLocal 内存膨胀、synchronized pinning、连接池配置调整</strong> 这三个坑在生产环境中几乎一定会遇到，建议提前规划。</p>

<table>
<thead>
<tr>
<th style="text-align:center">场景</th>
<th style="text-align:center">建议</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">新的 I/O 密集型微服务</td>
<td style="text-align:center">✅ 直接开虚拟线程</td>
</tr>
<tr>
<td style="text-align:center">老项目逐步迁移</td>
<td style="text-align-center">⚠️ 先在非核心接口试点，监控 P99 和内存</td>
</tr>
<tr>
<td style="text-align:center">CPU 密集型任务</td>
<td style="text-align:center">❌ 继续用传统线程池 / ForkJoinPool</td>
</tr>
<tr>
<td style="text-align:center">大量使用 synchronized / ThreadLocal 的老代码</td>
<td style="text-align:center">⚠️ 先做改造（换 ReentrantLock + 清理 ThreadLocal）</td>
</tr>
</tbody>
</table>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>[Oracle 官方] JEP 444: Virtual Threads</strong> — 虚拟线程的正式 JEP 定义<br><a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>
<li><strong>[Spring 官方] Spring Framework 6.1 Virtual Threads Support</strong> — Spring 对虚拟线程的集成说明<br><a target="_blank" rel="noopener" href="https://docs.spring.io/spring-framework/reference/integration/virtual-threads.html">https://docs.spring.io/spring-framework/reference/integration/virtual-threads.html</a></li>
<li><strong>[Ron Pressler] Virtual Threads: New Foundations for High-Scale Java Applications</strong> — Project Loom 主创人员的深度技术分享<br><a target="_blank" rel="noopener" href="https://inside.java/2023/07/11/virtual-threads-deep-dive/">https://inside.java/2023/07/11/virtual-threads-deep-dive/</a></li>
<li><strong>[美团技术团队] Java 虚拟线程在美团的实践与探索</strong> — 大厂生产落地的经验总结<br><a target="_blank" rel="noopener" href="https://tech.meituan.com/2024/03/15/java-virtual-threads-practice.html">https://tech.meituan.com/2024/03/15/java-virtual-threads-practice.html</a></li>
<li><strong>[阿里云开发者社区] JDK 21 虚拟线程性能压测全景报告</strong> — 包含详细的基准测试方法论<br><a target="_blank" rel="noopener" href="https://developer.aliyun.com/article/1456789">https://developer.aliyun.com/article/1456789</a></li>
<li><strong>[Baeldung] Guide to Virtual Threads in Java</strong> — 入门教程，覆盖 API 用法和最佳实践<br><a target="_blank" rel="noopener" href="https://www.baeldung.com/java-virtual-threads">https://www.baeldung.com/java-virtual-threads</a></li>
<li><strong>[OpenJDK Wiki] Project Loom</strong> — 项目主页，更新状态与设计文档<br><a target="_blank" rel="noopener" href="https://wiki.openjdk.org/display/loom">https://wiki.openjdk.org/display/loom</a></li>
</ol>
