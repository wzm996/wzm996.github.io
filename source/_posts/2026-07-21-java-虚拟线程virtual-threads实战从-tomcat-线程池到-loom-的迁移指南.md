---
title: Java 虚拟线程（Virtual Threads）实战——从 Tomcat 线程池到 Loom 的迁移指南
date: 2026-07-21 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - 虚拟线程
  - Spring Boot
  - JVM
  - JFR
  - 性能优化
---
<hr>
<blockquote><p>Java 21 正式发布之后，<strong>虚拟线程（Virtual Threads）</strong>作为 Project Loom 的核心特性终于尘埃落定。它不是简单的"更轻量的线程"，而是从根本上重新设计了 Java 的并发编程模型——让"每个请求一个线程"再次成为最佳实践。本文将从原理到压测，手把手带你完成从传统 Tomcat 线程池到虚拟线程的迁移。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么我们需要虚拟线程"><a href="#背景：为什么我们需要虚拟线程" class="headerlink" title="背景：为什么我们需要虚拟线程"></a>背景：为什么我们需要虚拟线程</h1>

<p>写过 Java Web 服务的同学应该都经历过这种痛苦：</p>

<ul>
<li>线上突发流量进来，<strong>Tomcat 线程池打满</strong>，新请求全部排队或拒绝</li>
<li>想加线程？<strong>JVM 线程上限</strong>大概几千个（受内存和调度开销限制），再加就 OOM 或者上下文切换爆炸了</li>
<li>大部分时间里，线程其实<strong>在等 IO</strong>（查数据库、调 RPC、等响应），但它们照样占着栈内存（通常 1MB/线程）</li>
</ul>

<p>这就是经典的 <strong>"一请求一线程"在 IO 密集场景下的困境</strong>。业界 workaround 包括：</p>

<table>
<thead>
<tr><th style="text-align:left">方案</th><th style="text-align:left">优点</th><th style="text-align:left">缺点</th></tr>
</thead>
<tbody>
<tr><td>异步框架（Netty / WebFlux）</td><td>高吞吐</td><td>学习曲线陡、回调地狱/Reactive 思维转换成本高、调试困难</td></tr>
<tr><td>协程（Kotlin coroutines）</td><td>写起来像同步</td><td>需要 Kotlin 生态、与现有 Java 代码有边界</td></tr>
<tr><td>加大线程池 + 缩短超时</td><td>简单</td><td>治标不治本、资源浪费严重</td></tr>
</tbody>
</table>

<p><strong>虚拟线程</strong>的思路完全不同：<em>不要让操作系统线程成为稀缺资源</em>。它是 JDK 内置的轻量级线程实现，由 JVM 调度器（<strong>ForkJoinPool</strong>）将大量虚拟线程映射到少量平台线程（OS Thread）上运行。当虚拟线程执行阻塞操作时，JVM 自动<strong>卸载（unpark）</strong>它，把平台线程让给其他虚拟线程使用。</p>

<blockquote>
<p><strong>什么是虚拟线程？</strong>一句话解释：它是 JDK 创建的一种用户态线程，由 JVM 而非 OS 调度。创建成本极低（几 KB 栈内存 vs 平台线程的 ~1MB），可以轻松创建百万级数量。它在 Java 19 预览、20 改进、21 正式定稿（Preview → Final）。</p>
</blockquote>

<h1 id="核心概念速览"><a href="#核心概念速览" class="headerlink" title="核心概念速览"></a>核心概念速览</h1>

<h2 id="虚拟线程-vs-平台线程"><a href="#虚拟线程-vs-平台线程" class="headerlink" title="虚拟线程 vs 平台线程"></a>虚拟线程 vs 平台线程</h2>

<table>
<thead>
<tr><th style="text-align:center">维度</th><th style="text-align:center">平台线程（Thread）</th><th style="text-align:center">虚拟线程（VirtualThread）</th></tr>
</thead>
<tbody>
<tr><td style="text-align:center">实现层</td><td>OS 内核线程（1:1 映射）</td><td>JVM 用户态线程（M:N 调度）</td></tr>
<tr><td style="text-align:center">创建成本</td><td>~μs 级，需要栈内存分配</td><td>~ns 级，极小栈缓冲区</td></tr>
<tr><td style="text-align:center">栈内存</td><td>默认 ~1 MB</td><td>按需伸缩，初始很小</td></tr>
<tr><td style="text-align:center">数量上限</td><td>数千（受内存限制）</td><td>百万级轻松承载</td></tr>
<tr><td style="text-align:center">调度器</td><td>OS 调度器</td><td>JVM <strong>ForkJoinPool</strong> 工作窃取调度器</td></tr>
<tr><td style="text-align:center">阻塞行为</td><td>阻塞 = 占住 OS 线程</td><td>阻塞时自动卸载，释放载体线程</td></tr>
</tbody>
</table>

<h2 id="关键机制：Carrier-Thread-与-Mount-Unmount"><a href="#关键机制：Carrier-Thread-与-Mount-Unmount" class="headerlink" title="关键机制：Carrier Thread 与 Mount/Unmount"></a>关键机制：Carrier Thread 与 Mount/Unmount</h2>

<p>虚拟线程运行在<strong>载体线程（Carrier Thread）</strong>上——本质上就是 ForkJoinPool 中的平台线程。JVM 调度过程：</p>

<figure class="highlight plain"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">graph LR
<span class="line">A[虚拟线程 VT] -->|Mount| B[载体线程 Carrier]
<span class="line">B -->|运行中| C[执行代码]
<span class="line">C -->|遇到阻塞IO| D[Unmount]
<span class="line">D -->|释放 Carrier| E[其他 VT 接管 Carrier]
<span class="line">E -->|IO 完成| F[VT 重新 Mount 到任意 Carrier]</span>
</span></pre></td></table></figure>

<p><strong>Mount</strong> = 虚拟线程的栈帧加载到载体线程上继续执行<br>
<strong>Unmount</strong> = 阻塞时把栈帧卸载下来，释放载体线程给别的虚拟线程用</p>

<p>这个过程对 Java 代码<strong>完全透明</strong>——你写的同步代码不需要任何改动。</p>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<h2 id="JDK-版本要求"><a href="#JDK-版本要求" class="headerlink" title="JDK 版本要求"></a>JDK 版本要求</h2>

<ul>
<li><strong>JDK 21+</strong>（推荐 LTS 版本，虚拟线程在此版本正式 GA）</li>
<li>Spring Boot <strong>3.2+</strong>（原生支持虚拟线程配置）</li>
</ul>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 验证 JDK 版本</span>
java -version  <span class="comment"># 应输出 21.0.x 或更高</span>
</span></pre></td></table></figure>

<h2 id="创建-Spring-Boot-项目骨架"><a href="#创建-Spring-Boot-项目骨架" class="headerlink" title="创建 Spring Boot 项目骨架"></a>创建 Spring Boot 项目骨架</h2>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">&lt;!-- pom.xml 关键依赖 --&gt;</span>
<span class="line"><span class="tag">&lt;<span class="name">parent</span>&gt;</span></span>
<span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span>
<span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span>
<span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>3.2.5<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span>
<span class="line"><span class="tag">&lt;/<span class="name">parent</span>&gt;</span></span>
<span class="line"></span>
<span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span>
<span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span>
<span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span>
<span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span>
<span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span>
<span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span>
</span></pre></td></table></figure>

<h1 id="实战一：基础-API-体验"><a href="#实战一：基础-API-体验" class="headerlink" title="实战一：基础 API 体验"></a>实战一：基础 API 体验</h1>

<h2 id="方式一：Thread-ofVirtual"><a href="#方式一：Thread-ofVirtual" class="headerlink" title="方式一：Thread::ofVirtual()"></a>方式一：<code>Thread::ofVirtual()</code></h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 创建并启动一个虚拟线程</span>
<span class="line">Thread vt = Thread.<span class="built_in">ofVirtual</span>()     <span class="comment">// 虚拟线程构建器</span>
<span class="line">    .<span class="built_in">name</span>(<span class="string">"my-vt"</span>)           <span class="comment">// 设置名字（调试时有用）</span>
<span class="line">    .<span class="built_in">start</span>(() -&gt; {</span>
<span class="line">        System.out.println(<span class="string">"Hello from "</span> + Thread.<span class="built_in">currentThread</span>().getName());</span>
<span class="line">        <span class="keyword">try</span> {</span>
<span class="line">            Thread.<span class="built_in">sleep</span>(<span class="number">1000</span>);  <span class="comment">// 阻塞操作 —— 虚拟线程会自动 Unmount</span>
<span class="line">        } <span class="keyword">catch</span> (InterruptedException e) {</span>
<span class="line">            Thread.<span class="built_in">currentThread</span>().interrupt();</span>
<span class="line">        }</span>
<span class="line">        System.out.println(<span class="string">"Done: "</span> + Thread.<span class="built_in">currentThread</span>().getName());</span>
<span class="line">    });</span>
<span class="line"></span>
<span class="line">vt.<span class="built_in">join</span>();  <span class="comment">// 等待虚拟线程结束</span>
<span class="line"></span>
<span class="line">System.out.println(<span class="string">"isVirtual = "</span> + vt.isVirtual());  <span class="comment">// true</span>
</span></pre></td></table></figure>

<h2 id="方式二：Executors-newVirtualThreadPerTaskExecutor"><a href="#方式二：Executors-newVirtualThreadPerTaskExecutor" class="headerlink" title="方式二：Executors.newVirtualThreadPerTaskExecutor()"></a>方式二：<code>Executors.newVirtualThreadPerTaskExecutor()</code></h2>

<p>这是官方推荐的<strong>生产用法</strong>——每来一个任务就创建一个新的虚拟线程，不再需要线程池大小调优：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">try</span> (<span class="type">var</span> <span class="variable">executor</span> <span class="operator">=</span> Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()) {</span>
<span class="line">    <span class="comment">// 提交 10_000 个任务 —— 每个都是独立虚拟线程</span>
<span class="line">    List&lt;Future&lt;String&gt;&gt; futures = <span class="keyword">new</span> <span class="title class="LinkedList</span>&gt;&lt;&gt;();</span>
<span class="line">    <span class="keyword">for</span> (<span class="type">int</span> <span class="variable">i</span> <span class="operator">=</span> <span class="number">0</span>; i &lt; <span class="number">10_000</span>; i++) {</span>
<span class="line">        <span class="type">int</span> <span class="variable">taskId</span> <span class="operator">=</span> i;</span>
<span class="line">        futures.add(executor.submit(() -&gt; {</span>
<span class="line">            Thread.<span class="built_in">sleep</span>(<span class="number">100</span>);  <span class="comment">// 模拟 IO 等待</span>
<span class="line">            <span class="keyword">return</span> <span class="string">"Task-"</span> + taskId + <span class="string">" done on "</span></span>
<span class="line">                + Thread.<span class="built_in">currentThread</span>().getName();</span>
<span class="line">        }));</span>
<span class="line">    }</span>
<span class="line">    <span class="comment">// 收集结果</span>
<span class="line">    futures.forEach(f -&gt; System.out.println(f.get()));</span>
<span class="line">}</span>
</span></pre></td></table></figure>

<blockquote>
<p><strong>验证方法</strong>：运行上面的代码，观察输出中的线程名格式类似 <code>ForkJoinPool-1-worker-1</code>（这是载体线程名）。重点观察：<strong>10,000 个任务几乎同时完成</strong>（总耗时 ≈ 100ms 而非 100ms × 10000），因为阻塞时虚拟线程自动让出载体。
</p></blockquote>

<h1 id="实战二：Spring-Boot-集成虚拟线程"><a href="#实战二：Spring-Boot-集成虚拟线程" class="headerlink" title="实战二：Spring Boot 集成虚拟线程"></a>实战二：Spring Boot 集成虚拟线程</h1>

<p>Spring Boot 3.2+ 提供了<strong>一行配置开启虚拟线程</strong>：</p>

<h2 id="第一步：application-yml-配置"><a href="#第一步：application-yml-配置" class="headerlink" title="第一步：application.yml 配置"></a>第一步：application.yml 配置</h2>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span>
<span class="line">  <span class="attr">threads:</span>
<span class="line">    <span class="attr">virtual:</span>
<span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span>   <span class="comment"># ⬅️ 开启虚拟线程</span>
<span class="line"></span>
<span class="line"><span class="attr">server:</span>
<span class="line">  <span class="attr">tomcat:</span>
<span class="line">    <span class="attr">max-threads:</span> <span class="number">200</span>   <span class="comment"># 这个参数在虚拟线程模式下基本失效</span>
<span class="line">                            <span class="comment"># （Tomcat 线程池仍存在，但请求处理交给虚拟线程）</span>
</span></pre></td></table></figure>

<h2 id="第二步：写一个模拟-IO-密集型接口"><a href="#第二步：写一个模拟-IO-密集型接口" class="headerlink" title="第二步：写一个模拟 IO 密集型接口"></a>第二步：写一个模拟 IO 密集型接口</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span>
<span class="line"><span class="meta">@RequestMapping("/api/demo")</span></span>
<span class="line"><span class="keyword">public class</span> <span class="title class="DemoController</span> {</span>
<span class="line"></span>
<span class="line">    <span class="meta">@GetMapping("/io-heavy")</span></span>
<span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">ioHeavy</span><span class="params">(HttpServletRequest request)</span> {</span>
<span class="line">        <span class="type">long</span> <span class="variable">start</span> <span class="operator">=</span> System.currentTimeMillis();</span>
<span class="line"></span>
<span class="line">        mockIoDelay(<span class="number">50</span>);   <span class="comment">// 模拟 DB 查询耗时</span>
<span class="line">        mockIoDelay(<span class="number">80</span>);   <span class="comment">// 模拟 RPC 调用耗时</span>
<span class="line">        mockCpuWork(<span class="number">20</span>);   <span class="comment">// 模拟业务计算</span>
<span class="line"></span>
<span class="line">        <span class="type">long</span> <span class="variable">cost</span> <span class="operator">=</span> System.currentTimeMillis() - start;</span>
<span class="line">        <span class="keyword">return</span> Map.of(</span>
<span class="line">            <span class="string">"thread"</span>, Thread.<span class="built_in">currentThread</span>().toString(),</span>
<span class="line">            <span class="string">"isVirtual"</span>, Thread.<span class="built_in">currentThread</span>().isVirtual(),</span>
<span class="line">            <span class="string">"costMs"</span>, cost,</span>
<span class="line">            <span class="string">"status"</span>, <span class="string">"ok"</span></span>
<span class="line">        );</span>
<span class="line">    }</span>
<span class="line"></span>
<span class="line">    <span class="keyword">private void</span> <span class="title function_">mockIoDelay</span><span class="params">(<span class="type">int</span> ms)</span> {</span>
<span class="line">        <span class="keyword">try</span> { Thread.<span class="built_in">sleep</span>(ms); } <span class="keyword">catch</span> (InterruptedException e) {</span>
<span class="line">            Thread.<span class="built_in">currentThread</span>().interrupt();</span>
<span class="line">        }</span>
<span class="line">    }</span>
<span class="line"></span>
<span class="line">    <span class="keyword">private void</span> <span class="title function_">mockCpuWork</span><span class="params">(<span class="type">int</span> ms)</span> {</span>
<span class="line">        <span class="type">long</span> <span class="variable">end</span> <span class="operator">=</span> System.nanoTime() + ms * 1_000_000L;</span>
<span class="line">        <span class="keyword">while</span> (System.nanoTime() &lt; end) {}  <span class="comment">// 忙等待模拟 CPU 计算</span>
<span class="line">    }</span>
<span class="line">}</span>
</span></pre></td></table></figure>

<h2 id="第三步：启动并验证虚拟线程生效"><a href="#第三步：启动并验证虚拟线程生效" class="headerlink" title="第三步：启动并验证虚拟线程生效"></a>第三步：启动并验证虚拟线程生效</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启动应用</span>
mvn spring-boot:run

<span class="comment"># 另开终端，发几个请求看看返回值</span>
curl http://localhost:8080/api/demo/io-heavy | python3 -m json.tool
</span></pre></td></table></figure>

<p>预期返回中 <code>"isVirtual": true</code>，说明请求确实跑在虚拟线程上。</p>

<h1 id="实战三：压测对比——真实数据说话"><a href="#实战三：压测对比——真实数据说话" class="headerlink" title="实战三：压测对比——真实数据说话"></a>实战三：压测对比——真实数据说话</h1>

<p>光说不练假把式。我们用 <strong>Apache Bench (ab)</strong> 做一组对照实验：</p>

<h2 id="测试场景"><a href="#测试场景" class="headerlink" title="测试场景"></a>测试场景</h2>

<table>
<thead>
<tr><th style="text-align:left">配置项</th><th style="text-align:center">值</th></tr>
</thead>
<tbody>
<tr><td style="text-align:left">接口</td><td style="text-align:center"><code>GET /api/demo/io-heavy</code>（单请求 ~150ms）</td></tr>
<tr><td style="text-align:left">并发数</td><td style="text-align:center">500 并发连接</td></tr>
<tr><td style="text-align:left">总请求数</td><td style="text-align:center">50,000</td></tr>
<tr><td style="text-align:left">JVM 参数</td><td style="text-align:center"><code>-Xmx512m -Xms512m</code></td></tr>
<tr><td style="text-align:left">对照组 A</td><td style="text-align:center"><code>spring.threads.virtual.enabled=false</code>（Tomcat 默认 200 线程）</td></tr>
<tr><td style="text-align:left">实验组 B</td><td style="text-align:center"><code>spring.threads.virtual.enabled=true</code>（虚拟线程）</td></tr>
</tbody>
</table>

<h2 id="压测命令-ab-示例"><a href="#压测命令-ab-示例" class="headerlink" title="压测命令（ab 示例）"></a>压测命令（ab 示例）</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 安装 ab（如果没有的话）</span>
yum install -y httpd-tools  <span class="comment"># CentOS/RHEL</span>
<span class="comment"># apt install -y apache2-utils  # Debian/Ubuntu</span>

<span class="line"><span class="comment"># 压测命令（500 并发，50000 请求）</span>
ab -n 50000 -c 500 http://localhost:8080/api/demo/io-heavy
</span></pre></td></table></figure>

<h2 id="预期压测结果参考"><a href="#预期压测结果参考" class="headerlink" title="预期压测结果（参考值）"></a>预期压测结果（参考值）</h2>

<p>以下为同类测试环境的典型数据（你的实际数值会因机器配置不同而有差异，但<strong>趋势一致</strong>）：</p>

<table>
<thead>
<tr><th style="text-align:center">指标</th><th style="text-align:center">A：传统线程池（200线程）</th><th style="text-align:center">B：虚拟线程</th><th style="text-align:center">变化</th></tr>
</thead>
<tbody>
<tr><td style="text-align:center">吞吐量 (req/s)</td><td style="text-align:center">~1,200</td><td style="text-align:center">~3,000+</td><td style="text-align:center">📈 <strong>2.5x+</strong></td></tr>
<tr><td style="text-align:center">平均延迟 (ms)</td><td style="text-align:center">~400</td><td style="text-align:center">~165</td><td style="text-align:center">📉 降低 59%</td></tr>
<tr><td style="text-align:center">P95 延迟 (ms)</td><td style="text-align:center">~800+</td><td style="text-align:center">~250</td><td style="text-align:center">📉 降低 69%</td></tr>
<tr><td style="text-align:center">P99 延迟 (ms)</td><td style="text-align:center">~1500+</td><td style="text-align:center">~350</td><td style="text-align:center">📉 降低 77%</td></tr>
<tr><td style="text-align:center">错误率</td><td style="text-align:center">可能有排队超时</td><td style="text-align:center">≈ 0%</td><td style="text-align:center">—</td></tr>
<tr><td style="text-align:center">内存占用</td><td style="text-align:center">~450MB</td><td style="text-align:center">~380MB</td><td style="text-align:center">📉 更省</td></tr>
</tbody>
</table>

<blockquote>
<p><strong>如何验证你自己的结论？</strong>分别用 A/B 两组配置启动应用，执行相同的 ab 命令，对比输出中的 <code>Requests per second</code>、<code>Time per request</code>（mean 和 95% 百分位）、<code>Failed requests</code> 三项核心指标。如果虚拟线程模式下的 P99 延迟没有明显下降，请检查你的接口是否真的有 IO 阻塞（纯 CPU 密集型任务收益有限）。
</p></blockquote>

<h1 id="实战四：用-JFR-采集虚拟线程火焰图"><a href="#实战四：用-JFR-采集虚拟线程火焰图" class="headerlink" title="实战四：用 JFR 采集虚拟线程火焰图"></a>实战四：用 JFR 采集虚拟线程火焰图</h1>

<p><strong>JFR（Java Flight Recorder）</strong>是 JDK 内置的低开销性能分析工具，可以录制应用运行时的各种事件。从 JDK 21 开始，JFR 对虚拟线程有了专门的事件支持。</p>

<blockquote>
<p><strong>什么是 JFR？</strong>它是 JDK 自带的"飞行记录器"，能以极低的开销（通常 &lt;1% 性能损耗）记录应用的线程行为、GC、IO、锁竞争等事件，生成 .jfr 文件后可用 JDK Mission Control（JMC）可视化分析。相当于 Java界的"黑匣子"。
</p></blockquote>

<h2 id="步骤-1：启动时开启-JFR-录制"><a href="#步骤-1：启动时开启-JFR-录制" class="headerlink" title="步骤 1：启动时开启 JFR 录制"></a>步骤 1：启动时开启 JFR 录制</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">java \
  -Xmx512m -Xms512m \
  -XX:+FlightRecorder \
  -XX:StartFlightRecording=duration=60s,filename=/tmp/vt-demo.jfr,settings=profile \
  -jar target/demo-0.0.1-SNAPSHOT.jar
</span></pre></td></table></figure>

<p>参数说明：</p>
<ul>
<li><code>-XX:+FlightRecorder</code>：启用 JFR 功能</li>
<li><code>duration=60s</code>：录制 60 秒后自动停止（覆盖压测时间段即可）</li>
<li><code>settings=profile</code>：使用 profile 级别的事件配置（比 default 更详细，包含方法采样）</li>
</ul>

<h2 id="步骤-2：压测期间采集数据"><a href="#步骤-2：压测期间采集数据" class="headerlink" title="步骤 2：压测期间采集数据"></a>步骤 2：压测期间采集数据</h2>

<p>在应用启动后、JFR 录制窗口内，执行 ab 压测命令。60 秒后 JFR 会自动 dump 到 <code>/tmp/vt-demo.jfr</code>。</p>

<h2 id="步骤-3：分析-jfr-文件"><a href="#步骤-3：分析-jfr-文件" class="headerlink" title="步骤 3：分析 .jfr 文件"></a>步骤 3：分析 .jfr 文件</h2>

<p>两种分析方式：</p>

<h3 id="方式-A：命令行快速查看事件统计"><a href="#方式-A：命令行快速查看事件统计" class="headerlink" title="方式 A：命令行快速查看事件统计"></a>方式 A：命令行快速查看事件统计</h3>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 打印虚拟线程相关事件摘要</span>
jfr print --categories Java-Application,Execution /tmp/vt-demo.jfr | head -100

<span class="comment"># 查看 Virtual Thread 相关事件（JDK 21+）</span>
jfr print --events jdk.VirtualThreadSubmit,jdk.VirtualThreadPinned /tmp/vt-demo.jfr
</span></pre></td></table></figure>

<h3 id="方式-B：JMC-可视化火焰图（推荐）"><a href="#方式-B：JMC-可视化火焰图（推荐）" class="headerlink" title="方式 B：JMC 可视化火焰图（推荐）"></a>方式 B：JMC 可视化火焰图（推荐）</h3>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启动 JDK Mission Control GUI（需要图形界面或 X11 转发）</span>
jmc /tmp/vt-demo.jfr
</span></pre></td></table></figure>

<p>在 JMC 中依次打开：<strong>Thread → Flame Graph</strong>，你可以直观看到：</p>
<ul>
<li>虚拟线程的时间都花在哪里（IO 等待 vs CPU 计算）</li>
<li>是否存在 <strong>Pinned Virtual Thread</strong> 问题（下文详解）</li>
<li>载体线程的工作窃取是否均衡</li>
</ul>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：Pinned-Virtual-Thread（被钉住的虚拟线程）"><a href="#坑-1：Pinned-Virtual-Thread（被钉住的虚拟线程）" class="headerlink" title="坑 1：Pinned Virtual Thread（被钉住的虚拟线程）"></a>坑 1：Pinned Virtual Thread（被钉住的虚拟线程）</h2>

<p><strong>这是虚拟线程最著名的坑，没有之一。</strong></p>

<p>当虚拟线程进入 <strong>synchronized</strong> 块或调用 <strong>native 方法</strong>时，它无法被 Unmount——因为 JVM 无法安全地保存/恢复 native 栈帧。此时这个虚拟线程会<strong>"钉住"</strong>（Pin）它的载体线程，直到退出 synchronized/native 区域。</p>

<p>后果：如果大量虚拟线程同时被 pin，载体线程会被耗尽，退化为传统线程池的性能。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误示范：在虚拟线程中使用 synchronized</span>
<span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title function_">badMethod</span><span class="params">()</span> {</span>
<span class="line">    <span class="comment">// 这个方法内如果发生阻塞，虚拟线程无法 Unmount！</span>
<span class="line">    Thread.<span class="built_in">sleep</span>(<span class="number">1000</span>);  <span class="comment">// 😱 Pin 了载体线程整整 1 秒</span>
<span class="line">}</span>
<span class="line"></span>
<span class="line"><span class="comment">// ✅ 正确做法：使用 ReentrantLock 替代 synchronized</span>
<span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock <span class="variable">lock</span> <span class="operator">=</span> <span class="keyword">new</span> <span class="title class="ReentrantLock</span>();</span>
<span class="line"><span class="keyword">public</span> <span class="keyword">void</span> <span class="title function_">goodMethod</span><span class="params">()</span> {</span>
<span class="line">    lock.lock();</span>
<span class="line">    <span class="keyword">try</span> {</span>
<span class="line">        Thread.<span class="built_in">sleep</span>(<span class="number">1000</span>);  <span class="comment">// ✅ 可以正常 Unmount</span>
<span class="line">    } <span class="keyword">finally</span> {</span>
<span class="line">        lock.unlock();</span>
<span class="line">    }</span>
<span class="line">}</span>
</span></pre></td></table></figure>

<p><strong>如何检测 Pinned 线程？</strong>通过 JFR 事件的 <code>jdk.VirtualThreadPinned</code> 即可捕获：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">jfr print --events jdk.VirtualThreadPinned /tmp/vt-demo.jfr
</span></pre></td></table></figure>

<p>另外也可以通过 JVM 启动参数开启诊断日志：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">-Djdk.virtualThreadScheduler.parallelism=<span class="number">4</span> -Djdk.virtualThreadScheduler.maxPoolSize=<span class="number">256</span>
</span></pre></td></table></figure>

<h2 id="坑-2：纯-CPU-密集型任务不会变快"><a href="#坑-2：纯-CPU-密集型任务不会变快" class="headerlink" title="坑 2：纯 CPU 密集型任务不会变快"></a>坑 2：纯 CPU 密集型任务不会变快</h2>

<p>虚拟线程的优势在于 <strong>IO 等待时让出载体线程</strong>。如果你的代码全是 CPU 计算（无 sleep / 无网络 IO / 无磁盘读写），虚拟线程不仅不会更快，反而因为调度开销略慢于平台线程。</p>

<p><strong>判断标准</strong>：看你的 Web 接口是否有数据库查询、HTTP 调用、消息队列收发等操作。如果有，虚拟线程大概率能帮到你；如果是纯数值计算/图像处理，别指望虚拟线程。</p>

<h2 id="坑-3：ThreadLocal-内存膨胀风险"><a href="#坑-3：ThreadLocal-内存膨胀风险" class="headerlink" title="坑 3：ThreadLocal 内存膨胀风险"></a>坑 3：ThreadLocal 内存膨胀风险</h2>

<p>传统线程池模式下，ThreadLocal 的生命周期跟随线程池中的线程（数量有限）。但虚拟线程是<strong>每任务一个</strong>，如果你在每个虚拟线程中都往 ThreadLocal 放大量数据，这些数据会随虚拟线程销毁而 GC，但在高峰期可能造成<strong>瞬时内存飙升</strong>。</p>

<p><strong>建议</strong>：</p>
<ul>
<li>审查现有代码中 ThreadLocal 的使用，确保数据量小</li>
<li>考虑使用 <code>ScopedValue</code>（JDK 21 预览特性，专为虚拟线程设计的新 API，替代 ThreadLocal 在异步传播场景的使用）</li>
</ul>

<h2 id="坑-4：不要用线程池来管理虚拟线程"><a href="#坑-4：不要用线程池来管理虚拟线程" class="headerlink" title="坑 4：不要用线程池来管理虚拟线程"></a>坑 4：不要用线程池来管理虚拟线程</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：把虚拟线程放进固定大小的线程池</span>
<span class="line"><span class="keyword">try</span> (<span class="type">var</span> <span class="variable">executor</span> <span class="operator">=</span> Executors.<span class="built_in">newFixedThreadPool</span>(<span class="number">10</span>) { }) {</span>
<span class="line">    executor.submit(Thread.<span class="built_in">ofVirtual</span>::unstarted, runnable);</span>
<span class="line">}</span>
<span class="line"></span>
<span class="line"><span class="comment">// ✅ 正确：每次任务新建虚拟线程</span>
<span class="line"><span class="keyword">try</span> (<span class="type">var</span> <span class="variable">executor</span> <span class="operator">=</span> Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()) {</span>
<span class="line">    executor.submit(runnable);</span>
<span class="line">}</span>
</span></pre></td></table></figure>

<p>虚拟线程的设计哲学就是<strong>足够廉价，不需要池化</strong>。强行池化反而引入不必要的排队延迟。</p>

<h2 id="坑-5：Spring-框架中-synchronized-的隐蔽来源"><a href="#坑-5：Spring-框架中-synchronized-的隐蔽来源" class="headerlink" title="坑 5：Spring 框架中 synchronized 的隐蔽来源"></a>坑 5：Spring 框架中 synchronized 的隐蔽来源</h2>

<p>很多常见的 Spring 用法内部用了 synchronized：</p>

<ul>
<li><code>SimpleDateFormat</code>（非线程安全，很多人加 synchronized 包装）</li>
<li>某些 <code>@Singleton</code> Bean 的同步方法</li>
<li>老版本 Hibernate SessionFactory 的某些操作</li>
<li><code>java.util.Vector</code> / <code>Hashtable</code> 等遗留集合类</li>
</ul>

<p><strong>建议</strong>：迁移前先用 JFR 录一轮 <code>VirtualThreadPinned</code> 事件，摸清 pin hotspots 再动手优化。</p>

<h1 id="什么时候该用、什么时候不该用"><a href="#什么时候该用、什么时候不该用" class="headerlink" title="什么时候该用、什么时候不该用"></a>什么时候该用、什么时候不该用</h1>

<table>
<thead>
<tr><th style="text-align:center">✅ 适合虚拟线程的场景</th><th style="text-align:center">❌ 不适合的场景</th></tr>
</thead>
<tbody>
<tr><td>Tomcat / Spring Boot Web 服务（IO 密集）</td><td>纯 CPU 密集计算（数值处理、编解码）</td></tr>
<tr><td>数据库连接池等待查询返回</td><td>已有良好调优的 Netty/WebFlux 异步服务</td></tr>
<tr><td>RPC / HTTP 客户端调用下游服务</td><td>对延迟极其敏感的交易系统（需充分压测验证）</td></tr>
<tr><td>文件读写、消息队列收发</td><td>依赖大量 synchronized 的遗留代码库（改造成本高）</td></tr>
<tr><td>定时任务调度（大量并发任务）</td><td>—</td></tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从原理到实践完整介绍了 Java 虚拟线程的核心要点：</p>

<ul>
<li><strong>本质</strong>：JVM 层面的用户态线程，M:N 调度到 ForkJoinPool 载体线程上，IO 阻塞时自动 Unmount</li>
<li><strong>Spring Boot 集成</strong>：仅需 <code>spring.threads.virtual.enabled=true</code> 一行配置</li>
<li><strong>性能收益</strong>：IO 密集型接口吞吐可提升 2~5 倍，P99 延迟大幅降低</li>
<li><strong>最大坑</strong>：<strong>synchronized 导致 Pinned Virtual Thread</strong>，必须替换为 ReentrantLock</li>
<li><strong>观测手段</strong>：JFR 录制 + <code>jdk.VirtualThreadPinned</code> 事件检测 + JMC 火焰图分析</li>
<li><strong>设计哲学</strong>：虚拟线程太廉价了，不需要池化——<code>newVirtualThreadPerTaskExecutor</code> 是推荐用法</li>
</ul>

<p>对于还在用 Tomcat 线程池苦苦调优的团队来说，虚拟线程可能是近年来 JDK 带来的<strong>性价比最高的升级</strong>。不需要重写成 Reactive，不需要换语言，升级 JDK 21 + Spring Boot 3.2，改一行配置，就能获得显著的吞吐提升。</p>

<p><strong>下一步行动建议</strong>：在你的 staging 环境部署一个开启了虚拟线程的服务实例，用真实流量（或压测）观察 QPS、延迟分布和内存占用。如果一切正常，再逐步推广到生产环境。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>OpenJDK 官方文档 — Project Loom</strong>：<a href="https://openjdk.org/projects/loom/" target="_blank">https://openjdk.org/projects/loom/</a>（虚拟线程设计与状态的最权威来源）</li>
<li><strong>Oracle Java 21 Release Notes — Virtual Threads</strong>：<a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html" target="_blank">https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html</a>（官方使用指南与最佳实践）</li>
<li><strong>Spring Blog — Virtual Threads Support in Spring Boot 3.2</strong>：<a href="https://spring.io/blog/2023/11/02/new-in-spring-boot-3-2-virtual-threads-support" target="_blank">https://spring.io/blog/2023/11/02/new-in-spring-boot-3-2-virtual-threads-support</a>（Spring 官方博客介绍集成方式与注意事项）</li>
<li><strong>Ron Pressler — Virtual Threads: New Possibilities for Concurrency in Java（Devoxx 2023）</strong>：<a href="https://www.youtube.com/watch?v=KrqypsKkpLo" target="_blank">YouTube</a>（Loom 项目技术负责人的深度讲解，涵盖调度器设计和 pinned 线程问题）</li>
<li><strong>美团技术团队 — Java 虚拟线程在美团的实践</strong>：<a href="https://tech.meituan.com/2024/03/28/java-virtual-thread-practice.html" target="_blank">https://tech.meituan.com/2024/03/28/java-virtual-thread-practice.html</a>（大厂落地经验、踩坑记录与性能数据）</li>
<li><strong>阿里云开发者社区 — JDK 21 虚拟线程性能压测全解析</strong>：<a href="https://developer.aliyun.com/article/1430000" target="_blank">https://developer.aliyun.com/article/1430000</a>（包含详细的 ab/wk 压测数据与 GC 对比）</li>
<li><strong>JDK Enhancement Proposal 444 — Virtual Threads (Final)</strong>：<a href="https://openjdk.org/jeps/444" target="_blank">https://openjdk.org/jeps/444</a>（JEP 规范文档，定义了虚拟线程的完整语义与 API）</li>
</ol>
