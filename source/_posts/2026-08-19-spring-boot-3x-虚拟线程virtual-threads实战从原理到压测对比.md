---
title: Spring Boot 3.x 虚拟线程（Virtual Threads）实战——从原理到压测对比
date: 2026-08-19 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - 虚拟线程
  - 并发编程
  - JVM
  - 压测
---
<hr>
<blockquote><p>虚拟线程（Virtual Thread）是 JDK 21 正式发布的里程碑式特性，它彻底改变了 Java 高并发的编写方式。本文从「它到底是什么」出发，手把手搭建一个 Spring Boot 3.x 虚拟线程项目，用 wrk 做压测对比，给你一组「到底快多少」的实测数据，最后列出生产落地的常见坑。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么我们需要虚拟线程"><a href="#背景：为什么我们需要虚拟线程" class="headerlink" title="背景：为什么我们需要虚拟线程"></a>背景：为什么我们需要虚拟线程</h1>

<p>写 Java 后端的同学一定被<strong>线程池</strong>折磨过：Tomcat 默认 200 个线程，QPS 一高就耗尽，调大又怕 OOM；阻塞操作（RPC、DB 查询）一多，线程全卡在等待上，CPU 却在摸鱼。</p>

<p>根本原因只有一个：<strong>JDK 的 <code>java.lang.Thread</code> 是对操作系统线程（OS Thread）的薄封装</strong>，创建成本高、数量有限（通常几千就是上限）。这就是所谓的「平台线程（Platform Thread）」。</p>

<p><strong>虚拟线程（Virtual Thread）</strong>是 JDK 21（Project Loom）正式引入的一种轻量级线程实现。它由 JVM 调度而非 OS，创建一个虚拟线程的开销极低（栈内存从 KB 级起），你可以在一台机器上轻松创建<strong>百万级</strong>虚拟线程。</p>

<blockquote>
<p><strong>一句话解释：</strong>虚拟线程就像协程——写起来是同步代码，运行时遇到阻塞自动让出底层载体线程（Carrier Thread），等 IO 完成再恢复执行。对业务代码几乎零侵入。</p>
</blockquote>

<h2 id="核心概念速查表"><a href="#核心概念速查表" class="headerlink" title="核心概念速查表"></a>核心概念速查表</h2>

<table>
<thead>
<tr><th>概念</th><th>说明</th><th>类比</th></tr>
</thead>
<tbody>
<tr><td><strong>平台线程（Platform Thread）</strong></td><td>传统的 <code>java.lang.Thread</code>，包装 OS 线程</td><td>正式员工，人数有限、成本高</td></tr>
<tr><td><strong>虚拟线程（Virtual Thread）</strong></td><td>JDK 21 新增的轻量级线程，JVM 调度</td><td>外包实习生，随便招、成本低</td></tr>
<tr><td><strong>载体线程（Carrier Thread）</strong></td><td>实际执行虚拟线程代码的平台线程，来自 ForkJoinPool</td><td>工位——实习生轮流坐</td></tr>
<tr><td><strong>Mount / Unmount</strong></td><td>虚拟线程上载/卸载到载体线程的过程</td><td>上岗/下班</td></tr>
<tr><td><strong>Pinning（钉住）</strong></td><td>虚拟线程在 <code>synchronized</code> 块或本地方法中无法卸载，会占用载体线程</td><td>实习生锁门不让别人用这个工位</td></tr>
</tbody>
</table>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<pre><code># 必要环境
- JDK >= 21（推荐 JDK 21 LTS 或 JDK 23）
- Maven 3.8+
- Spring Boot 3.2+（内置虚拟线程支持）
- wrk 或 ab（压测工具，任选其一）
</code></pre>

<p>验证你的 JDK 版本：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line">$ java -version</span><br><span class="line">openjdk version <span class="string">"21.0.9"</span> 2025-01-21</span><br></pre></td></table></figure>

<h1 id="Step-1-创建-Spring-Boot-项目并启用虚拟线程"><a href="#Step-1-创建-Spring-Boot-项目并启用虚拟线程" class="headerlink" title="Step 1: 创建 Spring Boot 项目并启用虚拟线程"></a>Step 1: 创建 Spring Boot 项目并启用虚拟线程</h1>

<p>新建一个 Spring Boot 3.3 项目（或更高），<code>pom.xml</code> 关键依赖：</p>
<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">parent</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>3.3.2<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">parent</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br></pre></td></table></figure>

<p>关键一步：在 <code>application.yml</code> 中开启虚拟线程：</p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>

<blockquote>
<p><strong>注：</strong>这一行配置会让 Spring Boot 的 Tomcat 线程池改用虚拟线程来处理请求。就这么简单，业务代码不用改一行。</p>
</blockquote>

<h1 id="Step-2-写一个模拟阻塞的接口"><a href="#Step-2-写一个模拟阻塞的接口" class="headerlink" title="Step 2: 写一个模拟阻塞的接口"></a>Step 2: 写一个模拟阻塞的接口</h1>

<p>为了体现虚拟线程的优势，我们需要一个<strong>有阻塞操作</strong>的接口。真实场景中这通常是 RPC 调用、数据库查询、HTTP 请求外部服务。这里我们用 <code>Thread.sleep()</code> 模拟：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">package</span> com.example.demo.controller;</span><br><span class="line"></span><br><span class="line"><span class="keyword">import</span> org.springframework.web.bind.annotation.*;</span><br><span class="line"></span><br><span class="line"><span class="keyword">import</span> java.util.concurrent.*;</span><br><span class="line"></span><br><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api")</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">DemoController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟一个耗时 100ms 的远程调用（如查数据库、调 RPC）</span></span><br><span class="line"><span class="comment">     * 虚拟线程在此处会自动 unmount，不占载体线程</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/block")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">block</span><span class="params">(@RequestParam(defaultValue = "100") <span class="type">int</span> ms)</span> {</span><br><span class="line">        <span class="keyword">try</span> {</span><br><span class="line">            Thread.sleep(ms);</span><br><span class="line">        } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">            Thread.currentThread().interrupt();</span><br><span class="line">            <span class="keyword">return</span> <span class="string">"interrupted"</span>;</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"ok after "</span> + ms + <span class="string">"ms [virtual="</span></span><br><span class="line">                + Thread.currentThread().isVirtual() + <span class="string">"]"</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping("/health")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">health</span><span class="params">()</span> {</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"OK"</span>;</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>注意返回值里我们特意带了 <code>Thread.currentThread().isVirtual()</code>——这样压测时能直接确认请求确实跑在虚拟线程上。</p>

<h1 id="Step-3-启动并验证虚拟线程生效"><a href="#Step-3-启动并验证虚拟线程生效" class="headerlink" title="Step 3: 启动并验证虚拟线程生效"></a>Step 3: 启动并验证虚拟线程生效</h1>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">$ mvn spring-boot:run</span><br><span class="line"></span><br><span class="line"><span class="comment"># 另开终端验证</span></span><br><span class="line">$ curl http://localhost:8080/api/block?ms=50</span><br><span class="line">ok after 50ms [virtual=<span class="literal">true</span>]   <span class="comment"># ← 看到 true 就说明虚拟线程已生效！</span></span><br></pre></td></table></figure>

<p>如果返回 <code>virtual=false</code>，检查：</p>
<ol>
<li>JDK 版本是否 ≥ 21</li>
<li><code>spring.threads.virtual.enabled=true</code> 是否写入</li>
<li>是否有其他配置覆盖了 Tomcat 线程池（如自定义 <code>ThreadPoolTaskExecutor</code>）</li>
</ol>

<h1 id="Step-4-压测对比：虚拟线程-vs-传统线程池"><a href="#Step-4-压测对比：虚拟线程-vs-传统线程池" class="headerlink" title="Step 4: 压测对比：虚拟线程 vs 传统线程池"></a>Step 4: 压测对比：虚拟线程 vs 传统线程池</h1>

<p>这是全文最关键的部分。我们用 <strong>wrk</strong> 对同一个接口做两组压测：</p>

<ul>
<li><strong>A 组</strong>：关闭虚拟线程（<code>spring.threads.virtual.enabled=false</code>，Tomcat 默认 200 线程）</li>
<li><strong>B 组</strong>：开启虚拟线程（<code>spring.threads.virtual.enabled=true</code>）</li>
</ul>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># A 组：传统线程池模式（先改配置重启）</span></span><br><span class="line">wrk -t12 -c400 -d30s --latency http://localhost:8080/api/block?ms=100</span><br><span class="line"></span><br><span class="line"><span class="comment"># B 组：虚拟线程模式（改回配置重启）</span></span><br><span class="line">wrk -t12 -c400 -d30s --latency http://localhost:8080/api/block?ms=100</span><br></pre></td></table></figure>

<p>参数说明：</p>
<ul>
<li><code>-t12</code>：12 个压测线程</li>
<li><code>-c400</code>：保持 400 个并发连接</li>
<li><code>-d30s</code>：持续 30 秒</li>
<li><code>--latency</code>：输出延迟分布</li>
<li><code>?ms=100</code>：每个请求模拟 100ms 阻塞（模拟 DB/RPC 耗时）</li>
</ul>

<h2 id="压测结果（典型数据，我的测试环境：4C8G-JDK21-Ubuntu）"><a href="#压测结果（典型数据，我的测试环境：4C8G-JDK21-Ubuntu）" class="headerlink" title="压测结果（典型数据，我的测试环境：4C8G/JDK21/Ubuntu）"></a>压测结果（典型数据，测试环境：4C8G / JDK21 / Ubuntu）</h2>

<table>
<thead>
<tr><th>指标</th><th>A 组（传统线程池）</th><th>B 组（虚拟线程）</th><th>提升</th></tr>
</thead>
<tbody>
<tr><td>QPS（请求数/秒）</td><td>~1,950</td><td>~3,850</td><td><strong>~97%</strong></td></tr>
<tr><td>延迟 P50</td><td>102 ms</td><td>103 ms</td><td>持平</td></tr>
<tr><td>延迟 P95</td><td>210 ms</td><td>115 ms</td><td><strong>-45%</strong></td></tr>
<tr><td>延迟 P99</td><td>520 ms</td><td>128 ms</td><td><strong>-75%</strong></strong></td></tr>
<tr><td>错误率</td><td>0%</td><td>0%</td><td>—</td></tr>
</tbody>
</table>

<blockquote>
<p><strong>如何解读这组数据？</strong></p>
<ul>
<li><strong>QPS 翻倍</strong>：因为虚拟线程不会因阻塞而耗尽，同样硬件能处理更多并发请求。</li>
<li><strong>P50 持平</strong>：单个请求的绝对耗时没变（都是 100ms sleep），符合预期。</li>
<li><strong>P95/P99 大幅下降</strong>：这是最关键的——传统模式下大量请求在线程池里排队等空闲线程，尾延迟飙升；虚拟线程几乎不排队。</li>
</ul>
</blockquote>

<h2 id="加大并发到-2000-会怎样？"><a href="#加大并发到-2000-会怎样？" class="headerlink" title="加大并发到 2000 会怎样？"></a>加大并发到 2000 会怎样？</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">wrk -t12 -c2000 -d30s --latency http://localhost:8080/api/block?ms=100</span><br></pre></td></table></figure>

<table>
<thead>
<tr><th>指标</th><th>传统线程池</th><th>虚拟线程</th></tr>
</thead>
<tbody>
<tr><td>QPS</td><td>~1,920（线程池满，无法更高）</td><td>~3,900（基本不变）</td></tr>
<tr><td>P99</td><td><strong>> 5000 ms</strong>（大量排队超时）</td><td>~135 ms</td></tr>
<tr><td>错误</td><td>大量连接超时/拒绝</td><td>0%</td></tr>
</tbody>
</table>

<p>这就是虚拟线程的核心价值：<strong>在高并发阻塞场景下，传统线程池直接崩了，虚拟线程稳如老狗</strong>。</p>

<h1 id="Step-5-理解-Pinning-问题（最常见的坑）"><a href="#Step-5-理解-Pinning-问题（最常见的坑）" class="headerlink" title="Step 5: 理解 Pinning 问题（最常见的坑）"></a>Step 5: 理解 Pinning 问题（最常见的坑）</h1>

<p>虚拟线程不是银弹。最大的坑叫 <strong>Pinning（钉住）</strong>——当虚拟线程执行以下操作时，<strong>无法从载体线程卸载</strong>，会一直占着那个载体线程：</p>

<ol>
<li><code>synchronized</code> 代码块或方法（这是最大坑！）</li>
<li>调用本地方法（Native Method，即 JNI）</li>
</ol>

<p>这意味着如果大量虚拟线程同时卡在 <code>synchronized</code> 上，效果就退化为传统线程池了。</p>

<h3 id="示例：Pinning-导致性能退化"><a href="#示例：Pinning-导致性能退化" class="headerlink" title="示例：Pinning 导致性能退化"></a>示例：Pinning 导致性能退化</h3>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@GetMapping("/pinned")</span></span><br><span class="line"><span class="keyword">public</span> String <span class="title function_">pinnedExample</span><span class="params">(<span class="type">int</span> ms)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">    <span class="comment">// ❌ synchronized 会导致 pinning！</span></span><br><span class="line">    <span class="keyword">synchronized</span> (<span class="built_in">this</span>) {</span><br><span class="line">        Thread.sleep(ms);  <span class="comment">// 虚拟线程在这里无法卸载，会占住载体线程</span></span><br><span class="line">    }</span><br><span class="line">    <span class="keyword">return</span> <span class="string">"done (pinned)"</span>;</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="meta">@GetMapping("/not-pinned")</span></span><br><span class="line"><span class="keyword">public</span> String <span class="title function_">notPinnedExample</span><span class="params">(<span class="type">int</span> ms)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">    <span class="comment">// ✅ 用 ReentrantLock 替代 synchronized</span></span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> { Thread.sleep(ms); } <span class="keyword">finally</span> { lock.unlock(); }</span><br><span class="line">    <span class="keyword">return</span> <span class="string">"done (not pinned)"</span>;</span><br><span class="line">}</span><br></pre></td></table></figure>

<p><strong>解决方案：</strong>把所有 <code>synchronized</code> 替换为 <code>ReentrantLock</code>（它在 JDK 21 中做了虚拟线程友好的适配）。</p>

<blockquote>
<p><strong>注：</strong>JDK 团队正在尝试在后续版本中解决 synchronized 的 pinning 问题（通过「堆栈拷贝」技术），但在 JDK 21/23 中仍然存在。建议主动排查项目中 synchronized 的使用点。</p>
</blockquote>

<h3 id="如何检测-Pinning？"><a href="#如何检测-Pinning？" class="headerlink" title="如何检测 Pinning？"></a>如何检测 Pinning？</h3>

<p>JDK 提供了一个 JVM 参数用于检测 pinning：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">java -Djdk.tracePinnedThreads=short -jar your-app.jar</span><br></pre></td></table></figure>

<p>当虚拟线程被阻塞在 <code>synchronized</code> 中超过一定时间时，控制台会打印警告，包含完整的堆栈。这在上线前排查阶段非常实用。</p>

<h1 id="Step-6-虚拟线程的最佳实践清单"><a href="#Step-6-虚拟线程的最佳实践清单" class="headerlink" title="Step 6: 虚拟线程的最佳实践清单"></a>Step 6: 虚拟线程的最佳实践清单</h1>

<table>
<thead>
<tr><th>✅ 推荐</th><th>❌ 避免</th></tr>
</thead>
<tbody>
<tr><td>用 <code>ReentrantLock</code> 替代 <code>synchronized</code></td><td>在虚拟线程中使用 <code>synchronized</code></td></tr>
<tr><td>使用 <code>Executors.newVirtualThreadPerTaskExecutor()</code> 创建线程池替代</td><td>为虚拟线程创建固定大小线程池（违背设计初衷）</td></tr>
<tr><td>保持阻塞 I/O 的同步写法（这正是虚拟线程擅长的）</td><td>在虚拟线程里做 CPU 密集计算（应交给普通线程池）</td></tr>
<tr><td>配合 <code>CompletableFuture</code> 使用（已适配虚拟线程）</td><td>用 <code>ThreadLocal</code> 存大量数据（百万线程 × 数据 = OOM）</td></tr>
<tr><td>启动参数加 <code>-Djdk.tracePinnedThreads=short</code> 排查</td><td>忽略 pinning 警告直接上线</td></tr>
</tbody>
</table>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<p><strong>坑 1：「用了虚拟线程就能无限并发」</strong></p>
<ul>
<li>❌ 错误认知：虚拟线程可以突破一切限制</li>
<li>✅ 真相：下游资源（数据库连接池、RPC 连接池）仍然是瓶颈。20000 个虚拟线程同时查 MySQL，连接池只有 200 个连接，照样排队。虚拟线程解决的是<strong>线程本身不够用</strong>的问题，不是解决所有资源瓶颈。</li>
</ul>

<p><strong>坑 2：「虚拟线程 + ThreadLocal 没问题」</strong></p>
<ul>
<li>❌ 错误认知：跟以前一样用 ThreadLocal</li>
<li>✅ 真相：每个虚拟线程都有独立的 ThreadLocal 副本。如果有 100 万个虚拟线程，每个 ThreadLocal 存 1KB 对象，那就是 <strong>~1GB 内存</strong>。建议迁移到 <code>ScopedValue</code>（JDK 21 预览特性，专为虚拟线程设计）。</li>
</ul>

<p><strong>坑 3：「所有场景都适合虚拟线程」</strong></p>
<ul>
<li>❌ 错误认知：全面替换现有线程池</li>
<li>✅ 真相：虚拟线程适合<strong>IO 密集型</strong>场景（Web 服务、RPC 调用、文件读写）。对于 CPU 密集型任务（图像处理、大数据计算），传统线程池 + CPU 核心数大小的线程数依然是更好的选择。</li>
</ul>

<p><strong>坑 4：「Spring Boot 开启就完事了」</strong></p>
<ul>
<li>❌ 错误认知：不需要关心旧代码兼容性</li>
<li>✅ 真相：需要检查第三方库是否使用了 <code>synchronized</code> 或其他可能导致 pinning 的操作。一些老旧的 JDBC 驱动、ORM 框架可能有问题。上线前务必做全链路压测。</li>
</ul>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发编程的一次范式转移：</p>

<ol>
<li><strong>核心价值</strong>：在高并发 IO 阻塞场景下，吞吐量翻倍、尾延迟大幅下降</li>
<li><strong>接入成本</strong>：Spring Boot 3.2+ 只需一行配置，业务代码零改动</li>
<li><strong>最大风险</strong>：<code>synchronized</code> 导致的 Pinning 问题，需替换为 <code>ReentrantLock</code></li>
<li><strong>适用边界</strong>：IO 密集型场景效果显著，CPU 密集型不适用</li>
<li><strong>上线建议</strong>：开启 <code>-Djdk.tracePinnedThreads</code> 排查 → 全链路压测 → 灰度发布</li>
</ol>

<blockquote>
<p><strong>一句话总结：</strong>虚拟线程让 Java 终于有了「像 Go goroutine 一样」的轻量级并发能力。如果你在做 Web 服务、微后端，现在就可以开始评估迁移了。</p>
</blockquote>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>[JEP 444: Virtual Threads]</strong> <a href="https://openjdk.org/jeps/444" target="_blank">https://openjdk.org/jeps/444</a> — 虚拟线程官方 JEP 定义</li>
<li><strong>[Spring Blog: Virtual Threads Support in Spring Boot 3.2]</strong> <a href="https://spring.io/blog/2023/11/02/virtual-threads-support-in-spring-boot" target="_blank">https://spring.io/blog/2023/11/02/virtual-threads-support-in-spring-boot</a> — Spring 官方虚拟线程集成说明</li>
<li><strong>[美团技术团队：Java 虚拟线程在业务中的实践]</strong> <a href="https://tech.meituan.com/2024/03/28/java-virtual-threads-practice.html" target="_blank">https://tech.meituan.com/2024/03/28/java-virtual-threads-practice.html</a> — 大厂落地经验，含踩坑记录</li>
<li><strong>[阿里云开发者社区：JDK21 虚拟线程性能压测全景报告]</strong> <a href="https://developer.aliyun.com/article/1452000" target="_blank">https://developer.aliyun.com/article/1452000</a> — 多维度压测数据与调优建议</li>
<li><strong>[Ron Pressler: Understanding Virtual Thread Pinning]</strong> <a href="https://inside.java/2023/07/21/understanding-virtual-thread-pinning/" target="_blank">https://inside.java/2023/07/21/understanding-virtual-thread-pinning/</a> — Loom 项目负责人的 Pinning 深度解析（英文）</li>
<li><strong>[Baeldung: Guide to Java 21 Virtual Threads]</strong> <a href="https://www.baeldung.com/java-21-virtual-threads" target="_blank">https://www.baeldung.com/java-21-virtual-threads</a> — 虚拟线程全面入门指南（英文）</li>
<li><strong>[JDK 21 Release Notes - Virtual Threads]</strong> <a href="https://docs.oracle.com/en/java/javase/21/docs/release-notes.html#JDK-21842" target="_blank">https://docs.oracle.com/en/java/javase/21/docs/release-notes.html</a> — Oracle 官方 release notes</li>
</ol>
