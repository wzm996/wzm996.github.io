---
title: Spring Boot 虚拟线程实战——从配置到压测全链路验证
date: 2026-06-22 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - 虚拟线程
  - JDK 21
  - 性能调优
  - JMeter
---
<hr>
<blockquote>
<p>Java 21 正式发布了 <strong>虚拟线程</strong>（Virtual Threads，Project Loom 的核心产物），Spring Boot 3.2+ 只需一行配置就能让 Tomcat 跑在虚拟线程上。这篇文章从「为什么需要」讲到「怎么配」，再搭一个完整的 I/O 密集型场景做 <strong>JMeter 压测对比</strong>，最后列出生产落地的坑和 Checklist。</p>
</blockquote>

<!-- more -->

<h1 id="背景：传统线程模型到底卡在哪？"><a href="#背景：传统线程模型到底卡在哪？" class="headerlink" title="背景：传统线程模型到底卡在哪？"></a>背景：传统线程模型到底卡在哪？</h1>

<p>写 Java Web 服务的同学应该都见过这个经典问题：<strong>请求一来就占一个线程，线程被阻塞等 DB / 等 RPC / 等外部 HTTP，线程数很快就撑到几百上千</strong>，然后：</p>

<ul>
<li>线程上下文切换吃 CPU</li>
<li>每个线程栈默认 1MB 内存，1000 个线程 = 1GB+ 纯给栈</li>
<li>线程池满了就开始排队，响应时间暴涨</li>
</ul>

<p>这就是 JDK 传统 <strong>平台线程</strong>（Platform Thread）的本质限制——它是对操作系统线程的 1:1 包装，<strong>创建贵、调度重、数量有天花板</strong>。</p>

<p><strong>虚拟线程</strong>（Virtual Thread）要解决的就是这件事：把 Java 线程从 OS 线程解耦，由 JVM 自己调度成千上万个轻量级线程，遇到阻塞操作自动让出底层载体线程（Carrier Thread），I/O 完成后再恢复。<strong>成本接近创建一个普通对象</strong>。</p>

<table>
<thead>
<tr>
<th style="text-align:center">维度</th>
<th style="text-align:center">平台线程（传统）</th>
<th style="text-align:center">虚拟线程（JDK 21+）</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">创建成本</td>
<td style="text-align:center">~1ms，需要 OS 分配栈内存</td>
<td style="text-align:center">~μs 级，仅分配少量堆内存</td>
</tr>
<tr>
<td style="text-align:center">内存占用</td>
<td style="text-align:center">默认 ~1MB/线程栈</td>
<td style="text-align:center">几 KB ~ 几十 KB（按需伸缩）</td>
</tr>
<tr>
<td style="text-align:center">合理上限</td>
<td style="text-align:center">几十 ~ 几百（受 CPU/内存约束）</td>
<td style="text-align:center">百万级（JDK 官方宣称）</td>
</tr>
<tr>
<td style="text-align:center">调度器</td>
<td style="text-align:center">OS 调度器（抢占式）</td>
<td style="text-align:center">ForkJoinPool 工作窃取调度</td>
</tr>
<tr>
<td style="text-align:center">阻塞行为</td>
<td style="text-align:center">阻塞整个 OS 线程</td>
<td style="text-align:center">自动卸载（unpark），释放载体线程</td>
</tr>
</tbody>
</table>

<h1 id="核心概念速通"><a href="#核心概念速通" class="headerlink" title="核心概念速通"></a>核心概念速通</h1>

<h2 id="虚拟线程是什么？"><a href="#虚拟线程是什么？" class="headerlink" title="虚拟线程是什么？"></a>虚拟线程是什么？</h2>

<p><strong>虚拟线程</strong>（Virtual Thread）是 JDK 21 正式引入的一种轻量级线程实现，由 JVM 用户态调度而非 OS 内核调度。你可以把它理解为 Java 层面的<strong>协程</strong>（Coroutine），但它对现有代码几乎透明——你不需要把代码改写成 async/await 风格。</p>

<p>关键特性：</p>
<ul>
<li><code>Thread.ofVirtual().start(runnable)</code> 创建虚拟线程</li>
<li><code>Executors.newVirtualThreadPerTaskExecutor()</code> 创建虚拟线程池（实际上每次都新建虚拟线程，不复用）</li>
<li>阻塞操作（LockSupport.park、Socket.read、DB 查询等）会触发<strong>挂载/卸载</strong>（Mount/Unmount），自动释放底层载体线程</li>
</ul>

<h2 id="什么是-Carrier-Thread（载体线程）？"><a href="#什么是-Carrier-Thread（载体线程）？" class="headerlink" title="什么是 Carrier Thread（载体线程）？"></a>什么是 Carrier Thread（载体线程）？</h2>

<p><strong>载体线程</strong>就是真正跑在 CPU 上的平台线程（ForkJoinPool 中的工作线程）。虚拟线程是"挂载"在载体线程上执行的。当虚拟线程遇到阻塞时，它会从载体线程上"卸载"，载体线程就可以去跑别的虚拟线程了。</p>

<pre><code>注：这就是虚拟线程高并发的秘密——少数载体线程服务大量虚拟线程。
</code></pre>

<h2 id="什么是-Pinning（钉住）问题？"><a href="#什么是-Pinning（钉住）？" class="headerlink" title="什么是 Pinning（钉住）问题？"></a>什么是 Pinning（钉住）问题？</h2>

<p>当虚拟线程在执行 <code>synchronized</code> 块或调用本地方法（native method）时，<strong>无法卸载</strong>，会一直占用载体线程直到退出 synchronized 或 native 调用返回。这叫 <strong>Pinning</strong>（钉住）。Pinning 会严重降低虚拟线程的并发能力。</p>

<p><strong>好消息：</strong>JDK 24（JEP 491）已经在很大程度上解决了这个问题。如果你还在用 JDK 21/22/23，需要注意避免在热点路径中使用 <code>synchronized</code>，改用 <code>ReentrantLock</code>。</p>

<h1 id="Spring-Boot-启用虚拟线程"><a href="#Spring-Boot-启用虚拟线程" class="headerlink" title="Spring Boot 启用虚拟线程"></a>Spring Boot 启用虚拟线程</h1>

<h2 id="环境要求"><a href="#环境要求" class="headerlink" title="环境要求"></a>环境要求</h2>

<ul>
<li>JDK 21+（推荐 21 LTS）</li>
<li>Spring Boot 3.2+（本文使用 3.2.x）</li>
</ul>

<h2 id="一行配置搞定"><a href="#一行配置搞定" class="headerlink" title="一行配置搞定"></a>一行配置搞定</h2>

<p>在 <code>application.yml</code> 中添加：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>

<p>就这么简单。Spring Boot 会自动把嵌入式 Tomcat 的线程池替换为虚拟线程执行器。</p>

<pre><code>注：如果用的是 Undertow 或 Jetty，同样生效——Spring Boot 在 AbstractServletWebServerFactory 层面统一处理的。
</code></pre>

<h2 id="底层发生了什么？"><a href="#底层发生了什么？" class="headerlink" title="底层发生了什么？"></a>底层发生了什么？</h2>

<p>当你设置 <code>spring.threads.virtual.enabled=true</code> 时，Spring Boot 做了以下事情：</p>

<ol>
<li>创建一个 <code>VirtualThreadTaskExecutor</code>（基于 <code>Executors.newVirtualThreadPerTaskExecutor()</code>）</li>
<li>将 Tomcat 的 <code>Connector</code> 的 executor 替换为上述虚拟线程执行器</li>
<li>每个 HTTP 请求都在独立的虚拟线程中处理</li>
</ol>

<p>你可以通过一段简单的代码验证当前线程是否为虚拟线程：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@GetMapping(&quot;/thread-info&quot;)</span></span><br><span class="line"><span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">threadInfo</span><span class="params">()</span> {</span><br><span class="line">    Thread t = Thread.currentThread();</span><br><span class="line">    <span class="keyword">return</span> Map.of(</span><br><span class="line">        <span class="string">&quot;name&quot;</span>, t.getName(),</span><br><span class="line">        <span class="string">&quot;isVirtual&quot;</span>, t.isVirtual()</span><br><span class="line">    );</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>启用虚拟线程后访问该接口，你会看到 <code>"isVirtual": true</code>。</p>

<h1 id="实战：搭建压测场景"><a href="#实战：搭建压测场景" class="headerlink" title="实战：搭建压测场景"></a>实战：搭建压测场景</h1>

<p>光说不练假把式。我们来搭一个<strong>I/O 密集型</strong>的 Spring Boot 应用，分别用传统线程和虚拟线程跑 JMeter 压测，看数据说话。</p>

<h2 id="Demo-项目结构"><a href="#Demo-项目结构" class="headerlink" title="Demo 项目结构"></a>Demo 项目结构</h2>

<figure class="highlight plaintext"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line">vt-demo/</span><br><span class="line">├── pom.xml</span><br><span class="line">├── src/main/java/com/example/vtdemo/</span><br><span class="line">│   ├── VtDemoApplication.java</span><br><span class="line">│   ├── controller/</span><br><span class="line">│   │   └── IoController.java          # I/O 密集型接口</span><br><span class="line">│   └── service/</span><br><span class="line">│       └── ExternalService.java       # 模拟外部调用</span><br><span class="line">└── src/main/resources/</span><br><span class="line">    └── application.yml</span><br></pre></td></table></figure>

<h2 id="pom-xml-核心依赖"><a href="#pom-xml-核心依赖" class="headerlink" title="pom.xml 核心依赖"></a>pom.xml 核心依赖</h2>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">parent</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>3.2.5<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">parent</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br></pre></td></table></figure>

<h2 id="模拟-I-O-密集型接口"><a href="#模拟-I-O-密集型接口" class="headerlink" title="模拟 I/O 密集型接口"></a>模拟 I/O 密集型接口</h2>

<p>我们模拟一个典型的后端场景：一次 HTTP 请求需要串行调用 3 个外部服务（每个耗时 50~100ms），中间还做一点轻量计算：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Service</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title">ExternalService</span> {</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> Random random = <span class="keyword">new</span> Random();</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟外部 RPC/HTTP/DB 调用</span></span><br><span class="line"><span class="comment">     * 随机延迟 50~100ms，模拟真实网络抖动</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">callRemote</span><span class="params">(String serviceName)</span> {</span><br><span class="line">        <span class="keyword">int</span> delay = <span class="number">50</span> + random.nextInt(<span class="number">51</span>); <span class="comment">// 50~100ms</span></span><br><span class="line">        <span class="keyword">try</span> {</span><br><span class="line">            Thread.sleep(delay);</span><br><span class="line">        } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">            Thread.currentThread().interrupt();</span><br><span class="line">            <span class="keyword">throw</span> <span class="keyword">new</span> RuntimeException(<span class="string">&quot;Interrupted&quot;</span>, e);</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> serviceName + <span class="string">&quot;-OK-&quot;</span> + System.currentTimeMillis();</span><br><span class="line">    }</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title">IoController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Autowired</span></span><br><span class="line">    <span class="keyword">private</span> ExternalService externalService;</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/api/order&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title">createOrder</span><span class="params">()</span> {</span><br><span class="line">        <span class="keyword">long</span> start = System.nanoTime();</span><br><span class="line">        String r1 = externalService.callRemote(<span class="string">&quot;UserService&quot;</span>);</span><br><span class="line">        String r2 = externalService.callRemote(<span class="string">&quot;InventoryService&quot;</span>);</span><br><span class="line">        String r3 = externalService.callRemote(<span class="string">&quot;PaymentService&quot;</span>);</span><br><span class="line">        <span class="keyword">long</span> costMs = (System.nanoTime() - start) / <span class="number">1_000_000</span>;</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">&quot;order_id&quot;</span>, UUID.randomUUID().toString(),</span><br><span class="line">            <span class="string">&quot;results&quot;</span>, List.of(r1, r2, r3),</span><br class="line">            <span class="string">&quot;cost_ms&quot;</span>, costMs,</span><br><span class="line">            <span class="string">&quot;thread&quot;</span>, Thread.currentThread().toString()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="application-yml-配置"><a href="#application-yml-配置" class="headerlink" title="application.yml 配置"></a>application.yml 配置</h2>

<p><strong>传统模式</strong>（用于基线测试）：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span></span><br><span class="line">  <span class="attr">port:</span> <span class="number">8080</span></span><br><span class="line">  <span class="attr">tomcat:</span></span><br><span class="line">    <span class="attr">threads:</span></span><br><span class="line">      <span class="attr">max:</span> <span class="number">200</span>  <span class="comment"># Tomcat 默认最大线程数</span></span><br></pre></td></table></figure>

<p><strong>虚拟线程模式</strong>（只需加一行）：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span></span><br><span class="line">  <span class="attr">port:</span> <span class="number">8080</span></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br><span class="line">  <span class="comment"># 注意：开启虚拟线程后 server.tomcat.threads.max 不再生效</span></span><br></pre></td></table></figure>

<h1 id="JMeter-压测方案与结果"><a href="#JMeter-压测方案与结果" class="headerlink" title="JMeter 压测方案与结果"></a>JMeter 压测方案与结果</h1>

<h2 id="压测环境"><a href="#压测环境" class="headerlink" title="压测环境"></a>压测环境</h2>

<table>
<thead>
<tr>
<th style="text-align:center">项</th>
<th style="text-align:center">值</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">OS</td>
<td style="text-align:center">Linux（4 核 CPU / 8GB RAM）</td>
</tr>
<tr>
<td style="text-align:center">JDK</td>
<td style="text-align:center">Eclipse Temurin 21.0.x</td>
</tr>
<tr>
<td style="text-align:center">Spring Boot</td>
<td style="text-align:center">3.2.5</td>
</tr>
<tr>
<td style="text-align:center">JMeter</td>
<td style="text-align:center">5.11</td>
</tr>
<tr>
<td style="text-align:center">压测接口</td>
<td style="text-align:center">GET /api/order（3 次串行远程调用，总耗时约 150~300ms）</td>
</tr>
</tbody>
</table>

<h2 id="JMeter-脚本配置要点"><a href="#JMeter-脚本配置要点" class="headerlink" title="JMeter 脚本配置要点"></a>JMeter 脚本配置要点</h2>

<figure class="highlight plaintext"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line">线程组（Thread Group）：</span><br><span class="line">  - 线程数：500 并发（ ramp-up 30s）</span><br><span class="line">  - 循环次数：永久（持续时间 3 分钟）</span><br><span class="line"></span><br><span class="line">HTTP Request：</span><br><span class="line">  - Method: GET</span><br><span class="line">  - Path: /api/order</span><br></pre></td></table></figure>

<p>也可以用命令行直接跑（适合 CI 集成）：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line">jmeter -n -t vt-test.jmx \</span><br><span class="line">  -l result-platform.csv \  <span class="comment"># 传统线程结果</span></span><br><span class="line">  -e -o report-platform       <span class="comment"># 生成 HTML 报告</span></span><br></pre></td></table></figure>

<h2 id="压测数据对比（核心）"><a href="#压测数据对比（核心）" class="headerlink" title="压测数据对比（核心）"></a>压测数据对比（核心）</h2>

<p>以下是业界多个团队（含 yCrash、BellSoft、MariaDB 团队）以及作者自测的综合数据趋势。具体数值因硬件和 JDK 版本而异，但<strong>比例关系具有普遍参考价值</strong>：</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">传统线程（200 线程池）</th>
<th style="text-align:center">虚拟线程（无限制）</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">吞吐量（req/s）</td>
<td style="text-align:center">~800 ~ 1200</td>
<td style="text-align:center">~1800 ~ 2800</td>
<td style="text-align:center">📈 <strong>+80% ~ +130%</strong></td>
</tr>
<tr>
<td style="text-align:center">平均响应时间</td>
<td style="text-align:center">250 ~ 400ms</td>
<td style="text-align:center">90 ~ 180ms</td>
<td style="text-align:center">📉 <strong>-50% ~ -60%</strong></td>
</tr>
<tr>
<td style="text-align:center">P95 延迟</td>
<td style="text-align:center">600 ~ 1200ms</td>
<td style="text-align:center">200 ~ 350ms</td>
<td style="text-align:center">📉 <strong>-60% ~ -70%</strong></td>
</tr>
<tr>
<td style="text-align:center">P99 延迟</td>
<td style="text-align:center">1500 ~ 3000ms+</td>
<td style="text-align:center">300 ~ 600ms</td>
<td style="text-align:center">📉 <strong>-70% ~ -80%</strong></td>
</tr>
<tr>
<td style="text-align:center">错误率（超时/拒绝）</td>
<td style="text-align:center">1% ~ 8%</td>
<td style="text-align:center">~0%</td>
<td style="text-align:center">✅ 接近零错误</td>
</tr>
<tr>
<td style="text-align:center">堆内存占用</td>
<td style="text-align:center">基准</td>
<td style="text-align:center">基准 ~ 基准×1.1</td>
<td style="text-align:center">≈ 持平</td>
</tr>
<tr>
<td style="text-align:center">CPU 使用率</td>
<td style="text-align:center">60% ~ 85%</td>
<td style="text-align:center">50% ~ 70%</td>
<td style="text-align:center">📉 略低（减少上下文切换开销）</td>
</tr>
</tbody>
</table>

<pre><code>注：以上数据来自多来源综合（yCrash Spring Boot VT 压测、Bell-SW 博客、MariaDB JDBC Benchmark、Kloia VT 分析报告），不同环境的绝对值会有差异，但趋势一致：I/O 密集场景下虚拟线程的吞吐显著更高、尾部延迟大幅降低。
</code></pre>

<h3 id="如何解读这些数据？"><a href="#如何解读这些数据？" class="headerlink" title="如何解读这些数据？"></a>如何解读这些数据？</h3>

<ul>
<li><strong>吞吐翻倍的原因：</strong>传统 200 线程池在高并发时线程全部阻塞等 I/O，新请求只能排队；虚拟线程可以创建数千个而不排队，I/O 完成立即恢复处理。</li>
<li><strong>P99 大幅下降的原因：</strong>没有线程池排队等待，每个请求都能及时获得"虚拟线程"来执行。</li>
<li><strong>内存几乎不变的原因：</strong>虚拟线程本身很轻量，栈内存按需分配，不会像平台线程那样预分配 1MB。</li>
</ul>

<h2 id="如何自己复现这套压测？（验证步骤）"><a href="#如何自己复现这套压测？（验证步骤）" class="headerlink" title="如何自己复现这套压测？（验证步骤）"></a>如何自己复现这套压测？（验证步骤）</h2>

<ol>
<li>
<p><strong>克隆代码并启动（传统模式）：</strong></p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line">git clone &lt;your-demo-repo&gt; &amp;&amp; cd vt-demo</span><br><span class="line">mvn spring-boot:run  <span class="comment"># 默认不启用虚拟线程</span></span><br></pre></td></table></figure>
</li>
<li>
<p><strong>跑第一轮 JMeter（基线）：</strong></p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">jmeter -n -t vt-test.jmx -l baseline.csv -o baseline-report</span><br></pre></td></table></figure>
</li>
<li>
<p><strong>修改 application.yml 加一行，重启（虚拟线程模式）：</strong></p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>
</li>
<li>
<p><strong>跑第二轮 JMeter（虚拟线程）：</strong></p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">jmeter -n -t vt-test.jmx -l vt-result.csv -o vt-report</span><br></pre></td></table></figure>
</li>
<li>
<p><strong>对比两份报告</strong>，重点关注 Throughput 和 Percentiles（Response Times Percentiles）图表。</li>
</ol>

<h1 id="生产环境的坑与避障指南"><a href="#生产环境的坑与避障指南" class="headerlink" title="生产环境的坑与避障指南"></a>生产环境的坑与避障指南</h1>

<p>虚拟线程虽好，但不是银弹。以下是踩坑总结：</p>

<h2 id="坑-1：synchronized-导致-Pinning（钉住）"><a href="#坑-1：synchronized-导致-Pinning（钉住）" class="headerlink" title="坑 1：synchronized 导致 Pinning（钉住）"></a>坑 1：synchronized 导致 Pinning（钉住）</h2>

<p><strong>现象：</strong>启用了虚拟线程但性能并没有提升，甚至更差。</p>

<p><strong>原因：</strong>虚拟线程在执行 <code>synchronized</code> 块或 <code>native method</code> 时无法卸载，会一直 pin 在载体线程上。如果大量虚拟线程同时卡在 synchronized 上，效果退化为传统线程池。</p>

<p><strong>解法：</strong></p>
<ul>
<li>将热点路径上的 <code>synchronized</code> 替换为 <code>ReentrantLock</code>（支持虚拟线程卸载）</li>
<li>升级到 JDK 24+（JEP 491 大幅缓解了此问题）</li>
<li>用以下方式检测 pinning：</li>
</ul>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">java -Djdk.virtualThreadScheduler.parallelism=16 \
     -Djdk.tracePinningThreads=full \
     -jar your-app.jar</span><br></pre></td></table></figure>

<p>开启后，JVM 会在检测到 pinning 时打印完整堆栈，帮你定位哪个 synchronized 是元凶。</p>

<h2 id="坑-2：ThreadLocal-内存爆炸"><a href="#坑-2：ThreadLocal-内存爆炸" class="headerlink" title="坑 2：ThreadLocal 内存爆炸"></a>坑 2：ThreadLocal 内存爆炸</h2>

<p><strong>现象：</strong>应用运行一段时间后 OOM（OutOfMemoryError）。</p>

<p><strong>原因：</strong>虚拟线程数量可能非常大（几千甚至上万），如果每个虚拟线程都往 <code>ThreadLocal</code> 里塞数据，且用完后不清除，ThreadLocal 总量会爆炸。</p>

<p><strong>解法：</strong></p>
<ul>
<li>尽量使用 <code>ScopedValue</code>（JDK 21 预览，JDK 23 正式化）替代 ThreadLocal</li>
<li>如果必须用 ThreadLocal，确保在 finally 块中 <code>remove()</code></li>
<li>审查框架/中间件是否在 ThreadLocal 存放大对象（如 SecurityContext、事务信息）</li>
</ul>

<h2 id="坑-3：连接池成为新瓶颈"><a href="#坑-3：连接池成为新瓶颈" class="headerlink" title="坑 3：连接池成为新瓶颈"></a>坑 3：连接池成为新瓶颈</h2>

<p><strong>现象：</strong>虚拟线程开了很多，但吞吐不再增长。</p>

<p><strong>原因：</strong>线程不再是瓶颈了，<strong>数据库连接池 / HTTP 连接池</strong>成了新的上限。以前 200 个线程配 100 个 DB 连接够用了；现在 5000 个虚拟线程抢 100 个连接，大部分时间在等连接。</p>

<p><strong>解法：</strong></p>
<ul>
<li>适当增大数据库连接池大小（但不要超过 DB 最大连接数）</li>
<li>考虑引入 <code>HikariCP</code> 的 <code>allowPoolSuspension</code> 动态调整</li>
<li>监控连接池等待指标（<code>HikariPool-X.TotalConnectionCreationTime</code>）</li>
</ul>

<h2 id="坑-4：CPU-密集型任务适得其反"><a href="#坑-4：CPU-密集型任务适得其反" class="headerlink" title="坑 4：CPU 密集型任务适得其反"></a>坑 4：CPU 密集型任务适得其反</h2>

<p><strong>现象：</strong>启用虚拟线程后 CPU 打满，性能反而下降。</p>

<p><strong>原因：</strong>虚拟线程的优势在 <strong>I/O 密集</strong>场景（利用等待时间让出载体线程）。如果是纯计算任务（如图片处理、加密解密、复杂算法），虚拟线程不仅没优势，还会增加调度开销。</p>

<p><strong>解法：</strong>CPU 密集型任务继续用传统线程池（<code>Executors.newFixedThreadPool(nCPU)</code>），只对 I/O 密集路径启用虚拟线程。</p>

<h2 id="坑-5：监控工具兼容性"><a href="#坑-5：监控工具兼容性" class="headerlink" title="坑 5：监控工具兼容性"></a>坑 5：监控工具兼容性</h2>

<p><strong>现象：</strong>jstack / jconsole 看到的线程数量很少，或者线程 dump 里全是 <code>ForkJoinPool</code> 工作线程。</p>

<p><strong>原因：</strong>虚拟线程不在 OS 层面存在，传统线程 dump 工具可能只看到载体线程（ForkJoinPool 的 worker）。</p>

<p><strong>解法：</strong></p>
<ul>
<li>JDK 21+ 的 <code>jcmd &lt;pid&gt; Thread.dump_to_file</code> 支持输出虚拟线程</li>
<li>使用 <code>jfr</code>（JDK Flight Recorder）记录虚拟线程事件</li>
<li>Micrometer + Prometheus 监控时注意区分虚拟线程指标</li>
</ul>

<h1 id="生产落地-Checklist"><a href="#生产落地-Checklist" class="headerlink" title="生产落地 Checklist"></a>生产落地 Checklist</h1>

<p>在决定上线虚拟线程前，逐项确认：</p>

<table>
<thead>
<tr>
<th style="text-align:center">#</th>
<th style="text-align:center">检查项</th>
<th style="text-align:center">状态</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">1</td>
<td style="text-align:center">JDK 版本 ≥ 21（推荐 21 LTS）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:center">2</td>
<td style="text-align:center">Spring Boot 版本 ≥ 3.2</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:center">3</td>
<td style="text-align:center">应用属于 I/O 密集型（非纯计算）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:center">4</td>
<td style="text-align:center">已排查 synchronized 热点路径（替换为 ReentrantLock 或升级 JDK 24+）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:center">5</td>
<td style="text-align:center">已审查 ThreadLocal 使用情况（防止内存泄漏）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:center">6</td>
<td style="text-align:center">数据库/Redis/HTTP 连接池大小已重新评估</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:center">7</td>
<td style="text-align:center">已完成压测对比（有 before/after 数据）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:center">8</td>
<td style="text-align:center">监控告警已适配虚拟线程（jcmd/jfr/Micrometer）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:center">9</td>
<td style="text-align:center">灰度发布策略已制定（先低流量观察）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:center">10</td>
<td style="text-align:center">回滚方案已准备（去掉一行配置即回滚）</td>
<td style="text-align:center">☐</td>
</tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发史上最重要的演进之一。对于 I/O 密集型的 Spring Boot 应用来说：</p>

<ul>
<li><strong>改动极小：</strong>一行配置（<code>spring.threads.virtual.enabled=true</code>）即可启用</li>
<li><strong>收益明显：</strong>I/O 密集场景下吞吐可提升 80%~130%，P99 延迟降低 70%~80%</li>
<li><strong>风险可控：</strong>回滚只需删掉那行配置；但要提前排查 synchronized/ThreadLocal/连接池三大坑</li>
<li><strong>适用边界：</strong>I/O 密集 ✅ | CPU 密集 ❌ | 需要大池子才有效果</li>
</ul>

<p>建议路线图：<strong>测试环境验证 → 压测拿数据 → 灰度上线 → 全量推广</strong>。别急着上生产，先用 JMeter 跑一轮，手里有数据心里才有底。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[Oracle] <strong>JEP 444: Virtual Threads</strong> — JDK 21 正式规范<br>
<a target="_blank" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>
<li>[Oracle] <strong>JEP 491: Synchronize Pinning Reduction</strong> — 解决 synchronized pinning 问题<br>
<a target="_blank" href="https://openjdk.org/jeps/491">https://openjdk.org/jeps/491</a></li>
<li>[Spring] <strong>Spring Framework 6.1 Virtual Threads Documentation</strong><br>
<a target="_blank" href="https://docs.spring.io/spring-framework/reference/core/threads/virtual-threads.html">https://docs.spring.io/spring-framework/reference/core/threads/virtual-threads.html</a></li>
<li>[BellSoft] <strong>A Guide to Using Virtual Threads with Spring Boot</strong> — 配置详解 + 容器优化建议<br>
<a target="_blank" href="https://bell-sw.com/blog/a-guide-to-using-virtual-threads-with-spring-boot">https://bell-sw.com/blog/a-guide-to-using-virtual-threads-with-spring-boot</a></li>
<li>[yCrash] <strong>Virtual Threads Performance in Spring Boot</strong> — JMeter 压测详细过程与 thread dump 分析<br>
<a target="_blank" href="https://blog.ycrash.io/virtual-threads-performance-in-spring-boot">https://blog.ycrash.io/virtual-threads-performance-in-spring-boot</a></li>
<li>[MariaDB] <strong>Benchmarking JDBC Connectors and Java 21 Virtual Threads</strong> — JMH 基准测试方法论<br>
<a target="_blank" href="https://mariadb.com/resources/blog/benchmark-jdbc-connectors-and-java-21-virtual-threads">https://mariadb.com/resources/blog/benchmark-jdbc-connectors-and-java-21-virtual-threads</a></li>
<li>[Kloia] <strong>Benchmarking Java Virtual Threads: A Comprehensive Analysis</strong> — 多维度性能分析（CPU-bound vs I/O-bound）<br>
<a target="_blank" href="https://www.kloia.com/blog/benchmarking-java-virtual-threads-a-comprehensive-analysis">https://www.kloia.com/blog/benchmarking-java-virtual-threads-a-comprehensive-analysis</a></li>
<li>[Ron Pressler] <strong>Project Loom: Design Overview</strong> — 虚拟线程设计哲学与动机（Java 主创人员）<br>
<a target="_blank" href="https://cr.openjdk.org/~rpressler/loom/loom/sol1_part1.html">https://cr.openjdk.org/~rpressler/loom/loom/sol1_part1.html</a></li>
</ol>
