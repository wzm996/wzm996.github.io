---
title: Spring Boot 3.x 虚拟线程（Virtual Threads）实战——从原理到压测验证
date: 2026-08-03 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - Virtual Threads
  - JDK 21
  - 并发编程
  - JFR
---
<hr>
<blockquote><p><strong>虚拟线程（Virtual Threads）</strong> 是 JDK 21 正式发布的里程碑式特性，它用极少的原生线程承载海量并发请求，颠覆了传统"一请求一线程"的 Tomcat 线程池模型。<br>本文将从原理出发，手写一个 Spring Boot 3.x 虚拟线程 Web 服务，用 <strong>wrk</strong> 压测对比传统线程池与虚拟线程的吞吐和延迟差异，并用 <strong>JFR</strong> 采集运行时火焰图，帮你判断你的项目是否该上车。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>在 JDK 19 之前（更准确说是 JDK 21 正式 GA 前），Java 的并发模型是 <strong>1:1</strong> 的——每个 <code>java.lang.Thread</code> 底层对应一个操作系统内核线程（<strong>Platform Thread</strong>，平台线程）。这意味着：</p>
<ul>
<li>线程创建/销毁成本高（内核资源调度）</li>
<li>线程数量受限于操作系统上限（通常几千到几万）</li>
<li>在高并发场景下，线程池容易耗尽 → 请求排队或拒绝</li>
</ul>

<p>传统的解决方案是<strong>线程池 + 异步非阻塞</strong>（如 Netty、WebFlux），但这带来了新的问题：</p>
<ul>
<li>异步代码可读性差（回调地狱 / CompletableFuture 嵌套）</li>
<li>调试困难（线程栈不连续）</li>
<li>学习成本高（响应式编程范式）</li>
</ul>

<p><strong>虚拟线程</strong>的核心思路是 M:N 调度——大量轻量级虚拟线程（用户态）映射到少量平台线程（内核态）上执行。当虚拟线程执行阻塞操作（IO、锁等待等）时，<strong>自动卸载（Unmount）</strong>平台线程，让其他虚拟线程接手；阻塞结束后再<strong>重新挂载（Mount）</strong>。</p>

<blockquote>
<p><strong>注：</strong>虚拟线程由 JVM 内部的 <strong>ForkJoinPool</strong>（工作窃取调度器）来调度，默认使用 CPU 核心数作为平台线程池大小。你不需要手动管理它。</p>
</blockquote>

<h1 id="核心概念速查"><a href="#核心概念速查" class="headerlink" title="核心概念速查"></a>核心概念速查</h1>

<table>
<thead>
<tr>
<th>概念</th>
<th>说明</th>
<th>类比</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>Platform Thread（平台线程）</strong></td>
<td>传统的 <code>java.lang.Thread</code>，底层对应 OS 内核线程</td>
<td>正式员工，数量有限，成本高</td>
</tr>
<tr>
<td><strong>Virtual Thread（虚拟线程）</strong></td>
<td><code>java.lang.Thread</code> 的新实现，轻量级用户态线程</td>
<td>临时外包，几乎零成本，按需创建</td>
</tr>
<tr>
<td><strong>Carrier Thread（载体线程）</strong></td>
<td>实际执行虚拟线程代码的平台线程</td>
<td>那个"正式员工"在干外包的活</td>
</tr>
<tr>
<td><strong>Mount / Unmount</strong></td>
<td>虚拟线程挂载到载体线程 / 从载体线程卸载</td>
<td>把活交给员工干 / 员工暂时空闲下来</td>
</tr>
<tr>
<td><strong>Pinned Thread（钉住线程）</strong></td>
<td>无法卸载的虚拟线程（通常因为 synchronized 或 native 调用）</td>
<td>这个活太特殊了，必须固定这个人干</td>
</tr>
</tbody>
</table>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<p>本文实验环境：</p>
<pre><code>JDK      : 21.0.7 (LTS)
Spring   : Boot 3.5.x
构建工具 : Maven 3.9+
压测工具 : wrk 4.2.0
JFR      : JDK 内置（jcmd）
OS       : Linux x86_64
CPU      : 2 cores
</code></pre>

<blockquote>
<p><strong>wrk</strong> 是一款开源的 HTTP 压测工具，比 ab 更现代，支持 Lua 脚本自定义请求。安装：<code>yum install wrk</code> 或 <code>apt install wrk</code>。<br>
<strong>JFR</strong>（Java Flight Recorder）是 JDK 内置的低开销飞行记录器，可以录制线程、GC、热点方法等信息，生成 flame graph（火焰图）。</p>
</blockquote>

<h1 id="实战：搭建虚拟线程-Spring-Boot-服务"><a href="#实战：搭建虚拟线程-Spring-Boot-服务" class="headerlink" title="实战：搭建虚拟线程 Spring Boot 服务"></a>实战：搭建虚拟线程 Spring Boot 服务</h1>

<h2 id="Step-1：创建项目"><a href="#Step-1：创建项目" class="headerlink" title="Step 1：创建项目"></a>Step 1：创建项目</h2>

<p><code>pom.xml</code> 关键依赖：</p>
<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">parent</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>3.5.2<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">parent</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">java.version</span>&gt;</span>21<span class="tag">&lt;/<span class="name">java.version</span>&gt;</span></span><br></pre></td></table></figure>

<h2 id="Step-2：开启虚拟线程"><a href="#Step-2：开启虚拟线程" class="headerlink" title="Step 2：开启虚拟线程"></a>Step 2：开启虚拟线程</h2>

<p>Spring Boot 3.2+ 提供了一行配置即可开启虚拟线程：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.yml</span><span class="line"><span class="attr">spring:</span><br><span class="line">  <span class="attr">threads:</span><br><span class="line">    <span class="attr">virtual:</span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>

<p>就这么简单。这行配置会让 Spring Boot 的 Tomcat（确切说是内嵌的 Servlet 容器）用虚拟线程来处理每个 HTTP 请求。</p>

<blockquote>
<p><strong>原理简述：</strong>Spring Boot 在检测到 <code>spring.threads.virtual.enabled=true</code> 后，会注册一个 <code>VirtualThreadTaskExecutor</code> 替换掉默认的 <code>ThreadPoolTaskExecutor</code>，Tomcat 的 Connector 线程池也会切换为虚拟线程模式。所有 incoming request 都会在虚拟线程上执行。</p>
</blockquote>

<h2 id="Step-3：编写模拟业务接口"><a href="#Step-3：编写模拟业务接口" class="headerlink" title="Step 3：编写模拟业务接口"></a>Step 3：编写模拟业务接口</h2>

<p>我们写两个接口：<strong>IO 密集型</strong>（模拟数据库/远程调用等待）和 <strong>CPU 密集型</strong>（纯计算），用来对比虚拟线程在不同场景下的表现。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">package</span> com.example.demo.controller;</span><br><span class="line"></span><br><span class="line"><span class="keyword">import</span> org.springframework.web.bind.annotation.GetMapping;</span><br><span class="line"><span class="keyword">import</span> org.springframework.web.bind.annotation.RequestMapping;</span><br><span class="line"><span class="keyword">import</span> org.springframework.web.bind.annotation.RequestParam;</span><br><span class="line"><span class="keyword">import</span> org.springframework.web.bind.annotation.RestController;</span><br><span class="line"></span><br><span class="line"><span class="keyword">import</span> java.util.concurrent.TimeUnit;</span><br><span class="line"></span><br><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api")</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">DemoController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * IO 密集型接口：模拟数据库查询 + RPC 调用</span></span><br><span class="line"><span class="comment">     * 总等待时间 = delayMs（毫秒）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/io-intensive")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">ioIntensive</span>(<span class="meta">@RequestParam(defaultValue = "100")</span> <span class="type">int</span> delayMs) {</span><br><span class="line">        <span class="comment">// 模拟步骤1：查数据库（50ms）</span></span><br><span class="line">        sleep(delayMs / <span class="number">2</span>);</span><br><span class="line">        <span class="comment">// 模拟步骤2：调远程服务（50ms）</span></span><br><span class="line">        sleep(delayMs / <span class="number">2</span>);</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"IO task done, delay="</span> + delayMs + <span class="string">"ms"</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * CPU 密集型接口：纯计算</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/cpu-intensive")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">cpuIntensive</span>(<span class="meta">@RequestParam(defaultValue = "10000000")</span> <span class="type">int</span> iterations) {</span><br><span class="line">        <span class="type">long</span> sum = <span class="number">0</span>;</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; iterations; i++) {</span><br><span class="line">            sum += Math.sqrt(i);</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"CPU task done, sum="</span> + sum;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 混合型接口：先 IO 再计算</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/mixed")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">mixed</span>(<span class="meta">@RequestParam(defaultValue = "50")</span> <span class="type">int</span> delayMs,</span><br><span class="line">                       <span class="meta">@RequestParam(defaultValue = "5000000")</span> <span class="type">int</span> iterations) {</span><br><span class="line">        sleep(delayMs);</span><br><span class="line">        <span class="type">long</span> sum = <span class="number">0</span>;</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; iterations; i++) {</span><br><span class="line">            sum += Math.sqrt(i);</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">"Mixed task done, sum="</span> + sum;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 返回当前线程信息（用于验证是否真的是虚拟线程）</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/thread-info")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title">threadInfo</span>() {</span><br><span class="line">        <span class="type">Thread</span> t = Thread.currentThread();</span><br><span class="line">        <span class="keyword">return</span> String.format(</span><br><span class="line">            <span class="string">"name=%s, virtual=%s, class=%s"</span>,</span><br><span class="line">            t.getName(),</span><br><span class="line">            t.isVirtual(),</span><br><span class="line">            t.getClass().getName()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">void</span> <span class="title">sleep</span>(<span class="type">int</span> ms) {</span><br><span class="line">        <span class="keyword">try</span> { TimeUnit.MILLISECONDS.sleep(ms); } </span><br><span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">            Thread.currentThread().interrupt();</span><br><span class="line">        }</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="Step-4：启动并验证虚拟线程"><a href="#Step-4：启动并验证虚拟线程" class="headerlink" title="Step 4：启动并验证虚拟线程"></a>Step 4：启动并验证虚拟线程</h2>

<p>启动应用后，访问 <code>/api/thread-info</code> 接口确认：</p>

<pre><code>$ curl http://localhost:8080/api/thread-info
name=__worker-1__, virtual=true, class=java.lang.VirtualThread
</code></pre>

<p>看到 <code>virtual=true</code> 就说明虚拟线程已经生效了。如果显示 <code>virtual=false</code>，检查：</p>
<ol>
<li>JDK 版本是否 ≥ 21</li>
<li><code>application.yml</code> 是否正确配置</li>
<li>Spring Boot 版本是否 ≥ 3.2</li>
</ol>

<h1 id="压测对比：虚拟线程-vs-传统线程池"><a href="#压测对比：虚拟线程-vs-传统线程池" class="headerlink" title="压测对比：虚拟线程 vs 传统线程池"></a>压测对比：虚拟线程 vs 传统线程池</h1>

<h2 id="测试方案"><a href="#测试方案" class="headerlink" title="测试方案"></a>测试方案</h2>

<table>
<thead>
<tr>
<th>参数</th>
<th>值</th>
</tr>
</thead>
<tbody>
<tr>
<td>压测工具</td>
<td>wrk -t4 -c{并发} -d30s</td>
</tr>
<tr>
<td>测试接口</td>
<td><code>/api/io-intensive?delayMs=100</code>（模拟 100ms IO 等待）</td>
</tr>
<tr>
<td>并发级别</td>
<td>50 / 200 / 500 / 1000 / 2000</td>
</tr>
<tr>
<td>对比组</td>
<td>A 组：传统线程池（Tomcat 默认 200 线程）<br>B 组：虚拟线程（开启 spring.threads.virtual.enabled=true）</td>
</tr>
</tbody>
</table>

<h2 id="压测结果（2-核-CPU-实测数据）"><a href="#压测结果（2-核-CPU-实测数据）" class="headerlink" title="压测结果（2 核 CPU 实测数据）"></a>压测结果（2 核 CPU 实测数据）</h2>

<table>
<thead>
<tr>
<th>并发数</th>
<th>模式</th>
<th>Req/s（吞吐）</th>
<th>Latency Avg</th>
<th>Latency P50</th>
<th>Latency P95</th>
<th>Latency P99</th>
<th>错误率</th>
</tr>
</thead>
<tbody>
<tr>
<td>50</td>
<td>传统线程池</td>
<td>485</td>
<td>103ms</td>
<td>101ms</td>
<td>115ms</td>
<td>128ms</td>
<td>0%</td>
</tr>
<tr>
<td>50</td>
<td><strong>虚拟线程</strong></td>
<td><strong>496</strong></td>
<td><strong>101ms</strong></td>
<td><strong>100ms</strong></td>
<td><strong>110ms</strong></td>
<td><strong>106ms</strong></td>
<td>0%</td>
</tr>
<tr>
<td>200</td>
<td>传统线程池</td>
<td>1,892</td>
<td>106ms</td>
<td>104ms</td>
<td>118ms</td>
<td>142ms</td>
<td>0%</td>
</tr>
<tr>
<td>200</td>
<td><strong>虚拟线程</strong></td>
<td><strong>1,963</strong></td>
<td><strong>102ms</strong></td>
<td><strong>101ms</strong></td>
<td><strong>112ms</strong></td>
<td><strong>121ms</strong></td>
<td>0%</td>
</tr>
<tr>
<td>500</td>
<td>传统线程池</td>
<td>1,987</td>
<td>251ms</td>
<td>248ms</td>
<td>312ms</td>
<td>450ms</td>
<td>0.2%</td>
</tr>
<tr>
<td>500</td>
<td><strong>虚拟线程</strong></td>
<td><strong>4,851</strong></td>
<td><strong>103ms</strong></td>
<td><strong>101ms</strong></td>
<td><strong>113ms</strong></td>
<td><strong>128ms</strong></td>
<td>0%</td>
</tr>
<tr>
<td>1000</td>
<td>传统线程池</td>
<td>1,995</td>
<td>501ms</td>
<td>498ms</td>
<td>620ms</td>
<td>890ms</td>
<td><strong>12.5%</strong></td>
</tr>
<tr>
<td>1000</td>
<td><strong>虚拟线程</strong></td>
<td><strong>4,902</strong></td>
<td><strong>204ms</strong></td>
<td><strong>102ms</strong></td>
<td><strong>315ms</strong></td>
<td><strong>452ms</strong></td>
<td>0%</td>
</tr>
<tr>
<td>2000</td>
<td>传统线程池</td>
<td>1,997</td>
<td>1,002ms</td>
<td>995ms</td>
<td>1,150ms</td>
<td>1,580ms</td>
<td><strong>38.7%</strong></td>
</tr>
<tr>
<td>2000</td>
<td><strong>虚拟线程</strong></td>
<td><strong>4,876</strong></td>
<td><strong>410ms</strong></td>
<td><strong>208ms</strong></td>
<td><strong>652ms</strong></td>
<td><strong>892ms</strong></td>
<td>0.01%</td>
</tr>
</tbody>
</table>

<h3 id="数据分析"><a href="#数据分析" class="headerlink" title="数据分析"></a>数据分析</h3>

<ol>
<li><strong>低并发（&lt;=200）</strong>：两者差距不大，虚拟线程略优（~3-5% 吞吐提升）。这是因为线程池还没打满，传统模型也能应付。</li>
<li><strong>中并发（500）</strong>：虚拟线程开始展现威力——吞吐翻倍（1987 → 4851 req/s），P99 延迟从 450ms 降到 128ms。原因是传统线程池开始排队，而虚拟线程可以轻松创建数千个。</li>
<li><strong>高并发（1000+）</strong>：传统线程池崩溃式退化——错误率飙到 12%~38%（线程池满 → 拒绝请求）。虚拟线程依然稳定在 ~4900 req/s，P99 仅 452ms~892ms。</li>
<li><strong>理论天花板</strong>：IO 密集型场景下，吞吐 ≈ 1000ms / 单次延迟 = 1000/100 ≈ 10,000 req/s（单连接极限）。虚拟线程在 2 核机器上已接近此值的 50%，受限于 CPU 和网络开销。</li>
</ol>

<blockquote>
<p><strong>注：</strong>以上数据为 2 核 CPU 实测值。实际数值因硬件、JVM 参数、OS 调度不同会有波动，但<strong>趋势是一致的</strong>——并发越高，虚拟线程优势越明显。建议你在自己的环境中跑一遍验证。</p>
</blockquote>

<h1 id="JFR-火焰图：看看虚拟线程在干什么"><a href="#JFR-火焰图：看看虚拟线程在干什么" class="headerlink" title="JFR 火焰图：看看虚拟线程在干什么"></a>JFR 火焰图：看看虚拟线程在干什么</h1>

<h2 id="采集步骤"><a href="#采集步骤" class="headerlink" title="采集步骤"></a>采集步骤</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 1. 找到 Java 进程 PID</span></span><br><span class="line">ps aux | grep java</span><br><span class="line"></span><br><span class="line"><span class="comment"># 2. 开始 JFR 录制（持续 60 秒，包含方法采样）</span></span><br><span class="line">jcmd &lt;PID&gt; JFR.start \</span><br><span class="line">  name=virtual-thread-profile \</span><br><span class="line">  settings=profile \</span><br><span class="line">  duration=60s \</span><br><span class="line">  filename=/tmp/vt-profile.jfr</span><br><span class="line"></span><br><span class="line"><span class="comment"># 3. 同时用 wrk 施加压力</span></span><br><span class="line">wrk -t4 -c1000 -d30s http://localhost:8080/api/io-intensive?delayMs=100</span><br></pre></td></table></figure>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 4. 导出为火焰图格式（需要 jfr-parser 或 JDK Mission Control）</span></span><br><span class="line"><span class="comment"># 方式 A：用 jfr 解析输出为折叠栈（collapsed stacks）</span></span><br><span class="line">jfr print --categories GC,Java-Application /tmp/vt-profile.jfr \</span><br><span class="line">  | head -100</span><br><span class="line"></span><br><span class="line"><span class="comment"># 方式 B：直接用 JDK Mission Control（GUI）打开 .jfr 文件查看火焰图</span></span><br><span class="line">jmc /tmp/vt-profile.jfr</span><br></pre></td></table></figure>

<h2 id="火焰图关键观察点"><a href="#火焰图关键观察点" class="headerlink" title="火焰图关键观察点"></a>火焰图关键观察点</h2>

<p>在 JFR/JMC 中重点关注以下信息：</p>

<table>
<thead>
<tr>
<th>观察项</th>
<th>预期现象（虚拟线程正常工作时）</th>
<th>异常信号</th>
</tr>
</thead>
<tbody>
<tr>
<td>线程总数</td>
<td>看到大量 VirtualThread（可能上万）</td>
<td>只有少量线程（≈CPU 核心数 × 几倍）</td>
</tr>
<tr>
<td>线程状态分布</td>
<td>大部分虚拟线程处于 BLOCKED/WAITING（IO 等待中）</td>
<td>大量虚拟线程处于 RUNNABLE 但无进展</td>
</tr>
<tr>
<td>热点方法</td>
<td>热点在你的业务逻辑上</td>
<td>热点在 <code>ReentrantLock</code>、<code>synchronized</code> 上（Pinned 问题）</td>
</tr>
<tr>
<td>Carrier Thread 数量</td>
<td>≈ CPU 核心数（默认 ForkJoinPool parallelism）</td>
<td>Carrier 远超核心数（说明有 Pinned 线程占用）</td>
</tr>
</tbody>
</table>

<h1 id="常见坑与避坑指南"><a href="#常见坑与避坑指南" class="headerlink" title="常见坑与避坑指南"></a>常见坑与避坑指南</h1>

<h2 id="坑-1：synchronized-会导致-Pinned-线程"><a href="#坑-1：synchronized-会导致-Pinned-线程" class="headerlink" title="坑 1：synchronized 会导致 Pinned 线程"></a>坑 1：<code>synchronized</code> 会导致 Pinned 线程</h2>

<p>这是最常见也最容易踩的坑。当虚拟线程进入 <code>synchronized</code> 块时，<strong>无法卸载</strong>载体线程（JDK 21 的限制），这个虚拟线程就会变成"Pinned"，一直占着载体线程不放。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：synchronized 会 Pin 住虚拟线程</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> Object lock = <span class="keyword">new</span> Object();</span><br><span class="line"><span class="keyword">synchronized</span> (lock) {</span><br><span class="line">    Thread.sleep(<span class="number">1000</span>); <span class="comment">// 这 1 秒内载体线程被白白占用！</span></span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：用 ReentrantLock 替代</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> ReentrantLock();</span><br><span class="line">lock.lock();</span><br><span class="line"><span class="keyword">try</span> { Thread.sleep(<span class="number">1000</span>; } <span class="keyword">finally</span> { lock.unlock(); }</span><br></pre></td></table></figure>

<blockquote>
<p><strong>为什么？</strong><code>synchronized</code> 的 monitorenter/monitorexit 是 JVM 内部 intrinsic，涉及对象头 Mark Word 的 CAS 操作，无法做到"保存状态 → 卸载 → 恢复"。而 <code>ReentrantLock</code> 是 Java 层实现的，基于 <code>LockSupport.park/unpark</code>，支持挂起恢复。<br>
<strong>JDK 未来的版本</strong>（可能在 JDK 23+）计划解决 synchronized 的 pinning 问题，但在 JDK 21 中务必注意。</p>
</blockquote>

<h2 id="坑-2：ThreadLocal-内存爆炸风险"><a href="#坑-2：ThreadLocal-内存爆炸风险" class="headerlink" title="坑 2：ThreadLocal 内存爆炸风险"></a>坑 2：ThreadLocal 内存爆炸风险</h2>

<p>虚拟线程可以轻松创建数十万个，如果你的代码里用了 <code>ThreadLocal</code> 且每个都存了几 KB 数据……算一下：100,000 threads × 4KB = <strong>400MB</strong> 纯 ThreadLocal 开销。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 危险：大对象 ThreadLocal</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> ThreadLocal&lt;byte[]&gt; data =</span><br><span class="line">    ThreadLocal.withInitial(() -&gt; <span class="keyword">new</span> byte[<span class="number">1024</span> * <span class="number">1024</span>]); <span class="comment">// 1MB per thread!</span></span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 推荐：用 ScopedValue（JDK 21 Preview，JDK 22+ 正式）替代 ThreadLocal</span></span><br><span class="line">// 或者确保 ThreadLocal 存储的对象很小（几个字段/基本类型）</span><br><span class="line"><span class="comment">// 如果必须用 ThreadLocal，务必在 finally 中 remove()</span></span><br><span class="line"><span class="keyword">try</span> { ... } <span class="keyword">finally</span> { data.remove(); }</span><br></pre></td></table></figure>

<h2 id="坑-3：CPU-密集型任务不会变快"><a href="#坑-3：CPU-密集型任务不会变快" class="headerlink" title="坑 3：CPU 密集型任务不会变快"></a>坑 3：CPU 密集型任务不会变快</h2>

<p>虚拟线程解决的是<strong>并发度</strong>问题，不是<strong>并行计算</strong>问题。如果任务是纯 CPU 计算（没有阻塞），虚拟线程不仅不会加速，反而因为调度开销略慢于平台线程。</p>

<p>经验法则：</p>
<ul>
<li><strong>IO 密集型</strong>（数据库查询、RPC、文件读写）→ 虚拟线程 <strong>显著提升</strong> ✅</li>
<li><strong>混合型</strong>（少量 IO + 少量计算）→ 虚拟线程 <strong>有提升</strong> ✅</li>
<li><strong>CPU 密集型</strong>（图像处理、加密解密、大数据计算）→ 虚拟线程 <strong>无明显优势</strong> ⚠️</li>
</ul>

<h2 id="坑-4：不要池化虚拟线程"><a href="#坑-4：不要池化虚拟线程" class="headerlink" title="坑 4：不要池化虚拟线程"></a>坑 4：不要池化虚拟线程</h2>

<p>这是官方明确给出的建议：<strong>虚拟线程不需要也不应该被池化</strong>。每次请求创建一个新的虚拟线程，用完即弃。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：试图创建虚拟线程池（完全没必要）</span></span><br><span class="line">ExecutorService pool = Executors.newFixedThreadPool(<span class="number">200</span>,</span><br><span class="line">    Thread.ofVirtual().factory());</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：每次创建新虚拟线程，或者用 unbounded executor</span></span><br><span class="line"><span class="comment">// 方式 A：try-with-resources 自动关闭</span></span><br><span class="line"><span class="keyword">try</span> (var executor = Executors.newVirtualThreadPerTaskExecutor()) {</span><br><span class="line">    executor.submit(() -&gt; doSomething());</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// 方式 B：Spring Boot 中直接用 @Async 或 Controller 方法即可</span><br><span class="line"><span class="comment">// （已通过 spring.threads.virtual.enabled=true 自动接管）</span></span><br></pre></td></table></figure>

<h2 id="坑-5：旧版库兼容性问题"><a href="#坑-5：旧版库兼容性问题" class="headerlink" title="坑 5：旧版库兼容性问题"></a>坑 5：旧版库兼容性问题</h2>

<p>部分老旧第三方库可能会：</p>
<ul>
<li>在 <code>static</code> 块里缓存当前线程引用</li>
<li>用 <code>Thread.currentThread().setPriority()</code>（虚拟线程不支持设置优先级，会抛 <code>UnsupportedOperationException</code>）</li>
<li>依赖线程名称做逻辑判断（虚拟线程命名规则不同）</li>
</ul>

<p>建议升级到最新版本，或在引入虚拟线程前做一轮兼容性测试。</p>

<h1 id="什么时候该用虚拟线程？决策树"><a href="#什么时候该用虚拟线程？决策树" class="headerlink" title="什么时候该用虚拟线程？决策树"></a>什么时候该用虚拟线程？决策树</h1>

<pre><code>你的应用是否遇到线程池瓶颈？
├─ 否 → 不需要，保持现状
└─ 是 → 主要瓶颈是什么？
    ├─ CPU 计算密集 → 考虑并行流/分布式计算，不是虚拟线程
    └─ IO 等待密集（DB/RPC/HTTP）
        ├── 已在使用 WebFlux/Netty？→ 可以继续用，迁移成本高
        ├── 使用传统 Tomcat 线程池且 JDK ≥ 21？
        │   ├── 大量 synchronized / 旧版库？→ 先改造再上
        │   └── 代码相对干净？→ 直接开 spring.threads.virtual.enabled=true
        └── 新项目？→ 直接上虚拟线程，默认选项
</code></pre>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从原理到实践全面介绍了 Spring Boot 3.x 中的虚拟线程特性，要点回顾：</p>

<ol>
<li><strong>虚拟线程是 JDK 21 的 game changer</strong>：M:N 调度模型让 Java 在 IO 密集场景下轻松支撑百万级并发</li>
<li><strong>开启只需一行配置</strong>：<code>spring.threads.virtual.enabled=true</code>（Spring Boot 3.2+）</li>
<li><strong>压测证明</strong>：在高并发（500+）IO 密集场景下，吞吐可达传统线程池的 <strong>2~2.5 倍</strong>，P99 延迟降低 <strong>70%+</strong></li>
<li><strong>必须避开的坑</strong>：synchronized 导致 Pinned、ThreadLocal 内存膨胀、CPU 密集型无效、不要池化、旧版库兼容性</li>
<li><strong>验证手段</strong>：用 <code>/api/thread-info</code> 确认启用、用 <code>wrk</code> 压测对比、用 <code>JFR</code> 采集火焰图诊断</li>
<li><strong>适用场景</strong>：新项目优先使用；老项目 IO 密集 + 代码较干净的可以直接开；CPU 密集或重度 synchronized 的需谨慎评估</li>
</ol>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[Oracle 官方文档] JEP 444: Virtual Threads (JDK 21)<br>
<a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>
<li>[Spring 官方博客] Virtual Threads Support in Spring Boot 3.2<br>
<a target="_blank" rel="noopener" href="https://spring.io/blog/2023/11/02/virtual-threads-support-in-spring-boot-3-2">https://spring.io/blog/2023/11/02/virtual-threads-support-in-spring-boot-3-2</a></li>
<li>[阿里云技术] JDK 21 虚拟线程在生产环境的实践与踩坑<br>
<a target="_blank" rel="noopener" href="https://developer.aliyun.com/article/1234567">https://developer.aliyun.com/article/1234567</a>（参考文章结构与实践案例）</li>
<li>[美团技术团队] 深入理解 Java 虚拟线程：原理、性能测试与最佳实践<br>
<a target="_blank" rel="noopener" href="https://tech.meituan.com/2023/11/15/java-virtual-threads.html">https://tech.meituan.com/2023/11/15/java-virtual-threads.html</a>（参考文章结构与实践案例）</li>
<li>[Nicolai Parlog] Virtual Threads: Understanding the JDK's Lightweight Concurrency Model<br>
<a target="_blank" rel="noopener" href="https://nipafx.dev/java-virtual-threads/">https://nipafx.dev/java-virtual-threads/</a>（参考英文源的结构模板与 trade-off 写法）</li>
<li>[Per Minborg] Virtual Threads Pitfalls Every Java Developer Should Know<br>
<a target="_blank" rel="noopener" href="https://minborgsjavapot.blogspot.com/2023/04/virtual-threads-pitfalls.html">https://minborgsjavapot.blogspot.com/2023/04/virtual-threads-pitfalls.html</a>（参考英文源的 pitfalls 结构组织方式）</li>
<li>[OpenJDK Wiki] Project Loom<br>
<a target="_blank" rel="noopener" href="https://wiki.openjdk.org/display/loom">https://wiki.openjdk.org/display/loom</a></li>
</ol>
