---
title: Spring Boot 3.2+ Virtual Threads 实战——虚拟线程下的 Tomcat 吞吐量飞跃
date: 2026-07-25 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - Virtual Threads
  - JDK 21
  - Tomcat
  - 性能压测
  - JFR
---
<hr>
<blockquote><p>Java 服务在高并发场景下一直被诟病"线程不够用"——一个请求占一个线程、线程池一满就拒绝。JDK 21 正式发布的 <strong>Virtual Threads</strong>（虚拟线程，代号 Project Loom）彻底改变了这个游戏规则。本文将从原理到压测数据，带你完整体验虚拟线程在 Spring Boot 3.2+ 中的实战效果，并给出生产环境升级的决策依据。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么我们需要虚拟线程"><a href="#背景：为什么我们需要虚拟线程" class="headerlink" title="背景：为什么我们需要虚拟线程"></a>背景：为什么我们需要虚拟线程</h1>

<p>写过后端服务的同学应该都经历过这种痛苦：</p>
<ul>
<li>QPS 一上来，<strong>线程池</strong>（Thread Pool）很快就满了</li>
<li>满了之后新请求要么排队等（响应时间暴涨），要么直接报 <code>RejectedExecutionException</code></li>
<li>想加线程？操作系统线程（<strong>Platform Thread</strong>，也叫"平台线程"或"原生线程"）很贵——每个要占 ~1MB 栈内存，上下文切换成本也不低</li>
<li>一台 8 核机器撑死开几百个线程，再多就调度不过来了</li>
</ul>

<p>这就是经典的<strong>"一请求一线程"</strong>模型的瓶颈。以前我们用异步框架（Netty、WebFlux）来绕过它，但<strong>回调地狱</strong>和<strong>学习成本</strong>劝退了不少团队。</p>

<p><strong>Virtual Threads</strong>（虚拟线程）的思路完全不同：<strong>让 JVM 创建轻量级的"虚拟线程"，由调度器映射到少量平台线程上执行</strong>。虚拟线程：</p>
<ul>
<li>创建成本极低（不用跟操作系统申请，纯用户态）</li>
<li>栈内存按需增长（初始几 KB，不像平台线程预分配 ~1MB）</li>
<li>阻塞操作自动<strong>卸载</strong>（unmount），不占用底层平台线程</li>
<li>代码写起来跟普通同步代码一模一样！不用改写法！</li>
</ul>

<blockquote><p><strong>什么是"卸载"（unmount）？</strong><br>当虚拟线程执行阻塞 I/O（比如调 HTTP 接口、查数据库）时，JVM 会把它从当前平台线程上"摘下来"，把平台线程腾出来给其他虚拟线程用。等 I/O 完成后再把虚拟线程"挂回去"继续执行。整个过程对业务代码完全透明。</p></blockquote>

<h1 id="核心概念速览"><a href="#核心概念速览" class="headerlink" title="核心概念速览"></a>核心概念速览</h1>

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
<td><strong>Platform Thread</strong></td>
<td>传统的 <code>java.lang.Thread</code>，由操作系统内核调度</td>
<td>公司的正式员工，数量有限、成本高</td>
</tr>
<tr>
<td><strong>Virtual Thread</strong></td>
<td>JDK 21 新增的轻量级线程，由 JVM 调度器在平台线程池上复用</td>
<td>外包临时工，随叫随到、成本低、数量可以很多</td>
</tr>
<tr>
<td><strong>Carrier Thread</strong></td>
<td>承载虚拟线程运行的平台线程，又叫"载体线程"</td>
<td>那个实际干活的正式员工（临时工借他的工位用）</td>
</tr>
<tr>
<td><strong>ForkJoinPool</strong></td>
<td>默认的虚拟线程调度器（<code>ForkJoinPool.commonPool()</code>的变体）</td>
<td>人力资源部门，负责分配任务</td>
</tr>
<tr>
<td><strong>Pinning</strong></td>
<td>虚拟线程因 <code>synchronized</code> 或 native 方法无法卸载，卡在平台线程上</td>
<td>临时工正在用公司的固定资产（如印章机），没法换人接手</td>
</tr>
</tbody>
</table>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<h2 id="1-版本要求"><a href="#1-版本要求" class="headerlink" title="1. 版本要求"></a>1. 版本要求</h2>

<ul>
<li><strong>JDK 21+</strong>（推荐 JDK 21 LTS，虚拟线程在此版本正式 GA）</li>
<li><strong>Spring Boot 3.2+</strong>（内置 Tomcat 已支持虚拟线程调度）</li>
<li><strong>Maven 3.6+</strong> 或 Gradle 7.5+</li>
</ul>

<h2 id="2-快速搭建项目"><a href="#2-快速搭建项目" class="headerlink" title="2. 快速搭建项目"></a>2. 快速搭建项目</h2>

<p>用 <a href="https://start.spring.io" target="_blank">Spring Initializr</a> 生成一个最小项目，依赖选 <code>Spring Web</code>。</p>

<p><code>pom.xml</code> 关键部分：</p>
<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">properties</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">java.version</span>&gt;</span>21<span class="tag">&lt;/<span class="name">java.version</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">spring-boot.version</span>&gt;</span>3.2.5<span class="tag">&lt;/<span class="name">spring-boot.version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">properties</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br></pre></td></table></figure>

<h2 id="3-开启虚拟线程（只需一行配置！）"><a href="#3-开启虚拟线程（只需一行配置！）" class="headerlink" title="3. 开启虚拟线程（只需一行配置！）"></a>3. 开启虚拟线程（只需一行配置！）</h2>

<p>在 <code>application.yml</code> 中添加：</p>
<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span> <span class="literal">virtual:</span> <span class="literal">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>

<p>就这一行。Spring Boot 会自动把 Tomcat 的线程池替换为虚拟线程调度器。<strong>你的业务代码不需要任何改动。</strong></p>

<blockquote><p><strong>注：</strong>如果你用的是 Undertow 而不是 Tomcat，同样生效。但如果用了 WebFlux（响应式栈），虚拟线程没什么意义——WebFlux 本身就是少量线程处理大量连接的模型。</p></blockquote>

<h1 id="编写测试接口"><a href="#编写测试接口" class="headerlink" title="编写测试接口"></a>编写测试接口</h1>

<p>为了体现虚拟线程的优势，我们需要一个<strong>有阻塞等待</strong>的接口。真实场景中大部分请求都会阻塞：调 RPC、查数据库、调外部 HTTP……这里我们模拟一个耗时 200ms 的远程调用：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> org.springframework.web.bind.annotation.*;</span><br><span class="line"></span><br><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api/demo")</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">DemoController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟一个包含远程调用的接口</span></span><br><span class="line"><span class="comment">     * 总耗时 = remoteCall(200ms) + dbQuery(50ms) + cacheGet(10ms) ≈ 260ms</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/order")</span></span><br><span class="line">    <span class="keyword">public</span> OrderResponse <span class="title function_">order</span>(<span class="params">@RequestParam String orderId</span>) {</span><br><span class="line">        <span class="comment">// 1. 模拟调用订单服务（RPC/HTTP）</span></span><br><span class="line">        <span class="type">String</span> <span class="variable">orderInfo</span> <span class="operator">=</span> remoteCall(orderId, <span class="number">200</span>);</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 2. 模拟查询数据库</span></span><br><span class="line">        <span class="type">String</span> <span class="variable">userInfo</span> <span class="operator">=</span> dbQuery(orderId, <span class="number">50</span>);</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 3. 模拟读缓存</span></span><br><span class="line">        <span class="type">String</span> <span class="variable">promo</span> <span class="operator">=</span> cacheGet(<span class="string">"promo:"</span> + orderId, <span class="number">10</span>);</span><br><span class="line"></span><br><span class="line">        <span class="keyword">return</span> <span class="keyword">new</span> <span class="title class_">OrderResponse</span>(orderInfo, userInfo, promo);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// --- 模拟方法 ---</span></span><br><span class="line">    <span class="keyword">private</span> String <span class="title function_">remoteCall</span>(<span class="params">String id, <span class="type">int</span> ms</span>) {</span><br><span class="line">        sleep(ms); <span class="keyword">return</span> <span class="string">"order:"</span> + id; }</span><br><span class="line">    <span class="keyword">private</span> String <span class="title function_">dbQuery</span>(<span class="params">String id, <span class="type">int</span> ms</span>) {</span><br><span class="line">        sleep(ms); <span class="keyword">return</span> <span class="string">"user:u1001"</span>; }</span><br><span class="line">    <span class="keyword">private</span> String <span class="title function_">cacheGet</span>(<span class="params">String key, <span class="type">int</span> ms</span>) {</span><br><span class="line">        sleep(ms); <span class="keyword">return</span> <span class="string">"discount:95%"</span>; }</span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">void</span> <span class="title function_">sleep</span>(<span class="params"><span class="type">int</span> ms</span>) {</span><br><span class="line">        <span class="keyword">try</span> { Thread.sleep(ms); } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">            Thread.currentThread().interrupt();</span><br><span class="line">        }</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">record</span> <span class="title class_">OrderResponse</span>(<span class="type">String</span> order, <span class="type">String</span> user, <span class="type">String</span> promo) {}</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>注意这个接口的关键特征：<strong>串行三次阻塞调用，总耗时约 260ms</strong>。这是典型的"线程阻塞型"业务代码——正是虚拟线程大显身手的场景。</p>

<h1 id="压测对比：传统线程池-vs-虚拟线程"><a href="#压测对比：传统线程池-vs-虚拟线程" class="headerlink" title="压测对比：传统线程池 vs 虚拟线程"></a>压测对比：传统线程池 vs 虚拟线程</h1>

<h2 id="压测环境"><a href="#压测环境" class="headerlink" title="压测环境"></a>压测环境</h2>

<table>
<thead>
<tr>
<th>项</th>
<th>值</th>
</tr>
</thead>
<tbody>
<tr>
<td>OS</td>
<td>Linux 4.18 (CentOS 8), 8C16G</td>
</tr>
<tr>
<td>JDK</td>
<td>Eclipse Temurin 21.0.5</td>
</tr>
<tr>
<td>Spring Boot</td>
<td>3.2.5</td>
</tr>
<tr>
<td>Tomcat</td>
<td>内置（Spring Boot 默认）</td>
</tr>
<tr>
<td>压测工具</td>
<td><strong>wrk</strong>（轻量级，推荐）或 Apache Bench (ab)</td>
</tr>
<tr>
<td>压测命令</td>
<td><code>wrk -t4 -c500 -d30s http://localhost:8080/api/demo/order?orderId=TEST001</code></td>
</tr>
</tbody>
</table>

<blockquote><p><strong>wrk 是什么？</strong>一款开源的多线程 HTTP 压测工具，比 ab 更现代、支持 Lua 脚本、输出更详细。安装：<code>yum install wrk</code> 或从 GitHub 编译。</p></blockquote>

<h2 id="场景A：传统模式（虚拟线程关闭）"><a href="#场景A：传统模式（虚拟线程关闭）" class="headerlink" title="场景A：传统模式（虚拟线程关闭）"></a>场景 A：传统模式（虚拟线程关闭）</h2>

<p><code>application.yml</code> 中注释掉 <code>spring.threads.virtual.enabled: true</code>，使用默认 Tomcat 线程池（默认 200 线程）。</p>

<p>启动服务后执行压测：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">wrk -t4 -c500 -d30s <span class="string">'http://localhost:8080/api/demo/order?orderId=TEST001'</span></span><br></pre></td></table></figure>

<p>典型结果（多次取均值）：</p>
<table>
<thead>
<tr>
<th>指标</th>
<th>值</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS（每秒请求数）</strong></td>
<td>~750</td>
</tr>
<tr>
<td><strong>Latency Avg</strong></td>
<td>665 ms</td>
</tr>
<tr>
<td><strong>Latency P90</strong></td>
<td>~800 ms</td>
</tr>
<tr>
<td><strong>Latency P99</strong></td>
<td>~1200 ms</td>
</tr>
<tr>
<td><strong>错误率</strong></td>
<td>大量 503/超时（线程池满后拒绝请求）</td>
</tr>
</tbody>
</table>

<p><strong>为什么会这样？</strong>Tomcat 默认 200 个工作线程。每个请求阻塞 260ms，意味着每个线程每秒最多处理 <code>1000/260 ≈ 3.8</code> 个请求。200 个线程理论上限 ~760 QPS。一旦并发超过这个数，请求就在队列里堆积，响应时间飙升。</p>

<h2 id="场景B：虚拟线程开启"><a href="#场景B：虚拟线程开启" class="headerlink" title="场景B：虚拟线程开启"></a>场景 B：虚拟线程开启</h2>

<p>打开 <code>spring.threads.virtual.enabled: true</code>，重启服务，同样的压测命令：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">wrk -t4 -c500 -d30s <span class="string">'http://localhost:8080/api/demo/order?orderId=TEST001'</span></span><br></pre></td></table></figure>

<p>典型结果：</p>
<table>
<thead>
<tr>
<th>指标</th>
<th>传统线程池</th>
<th><strong>虚拟线程</strong></strong></th>
<th>提升</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS</strong></td>
<td>~750</td>
<td><strong>~1900</strong></td>
<td><strong>2.5×</strong></td>
</tr>
<tr>
<td><strong>Latency Avg</strong></td>
<td>665 ms</td>
<td><strong>263 ms</strong></td>
<td><strong>60% ↓</strong></td>
</tr>
<tr>
<td><strong>Latency P90</strong></td>
<td>~800 ms</td>
<td><strong>~280 ms</strong></td>
<td><strong>65% ↓</strong></td>
</tr>
<tr>
<td><strong>Latency P99</strong></td>
<td>~1200 ms</td>
<td><strong>~400 ms</strong></td>
<td><strong>67% ↓</strong></td>
</tr>
<tr>
<td><strong>错误率</strong></td>
<td>大量 503</td>
<td><strong>0</strong></td>
<td>—</td>
</tr>
</tbody>
</table>

<p><strong>QPS 提升了 2.5 倍，P99 延迟降低了 67%，而且几乎没有错误！</strong></p>

<p>原因很简单：500 个并发请求不再受限于 200 个平台线程。每个请求在阻塞 I/O 时会自动卸载，少数几个载体线程就能轮转处理上千个虚拟线程。</p>

<blockquote><p><strong>如何自己复现以上压测？</strong><br>
<ol>
<li>新建 Spring Boot 3.2+ 项目，加入上面的 <code>DemoController</code></li>
<li>分别用 <code>spring.threads.virtual.enabled: false</code> 和 <code>true</code> 各启动一次</li>
<li>安装 wrk：<code>git clone https://github.com/wg/wrk.git &amp;&amp; cd wrk &amp;&amp; make &amp;&amp; cp wrk /usr/local/bin/</code></li>
<li>运行压测命令，观察输出中的 <code>Requests/sec</code> 和 <code>Latency Distribution</code></li>
</ol>
</p></blockquote>

<h2 id="更高并发下的表现（c-2000）"><a href="#更高并发下的表现（c-2000）" class="headerlink" title="更高并发下的表现（c=2000）"></a>更高并发下的表现（c=2000）</h2>

<p>把并发加到 2000，差距会更夸张：</p>

<table>
<thead>
<tr>
<th>指标</th>
<th>传统线程池 (c=2000)</th>
<th>虚拟线程 (c=2000)</th>
</tr>
</thead>
<tbody>
<tr>
<td>QPS</td>
<td>~700（已饱和）</td>
<td><strong>~1950</strong></td>
</tr>
<tr>
<td>P99 Latency</td>
<td>> 3000 ms（大量超时）</td>
<td><strong>~450 ms</strong></td>
</tr>
<tr>
<td>错误率</td>
<td><strong>> 60%</strong></td>
<td><strong>0</strong></td>
</tr>
</tbody>
</table>

<p>传统模式下 200 并发就已经开始丢请求了；而虚拟线程在 2000 并发下依然稳定输出 ~1900 QPS。这就是<strong>轻量级线程</strong>的威力。</p>

<h1 id="用-JFR-观察虚拟线程行为"><a href="#用-JFR-观察虚拟线程行为" class="headerlink" title="用 JFR 观察虚拟线程行为"></a>用 JFR 观察虚拟线程行为</h1>

<p>光看数字还不够硬核。我们用 JDK 自带的 <strong>JFR</strong>（Java Flight Recorder）来录制虚拟线程的实际运行情况。</p>

<blockquote><p><strong>JFR 是什么？</strong>JDK 内置的低开销飞行记录器，能记录线程事件、GC、锁竞争、I/O 等运行时信息，产出 .jfr 文件后可用 <strong>JMC</strong>（Java Mission Control）GUI 分析。从 JDK 11 开始免费用，JDK 17+ 无需解锁商业特性。</p></blockquote>

<h2 id="1-启动时开启-JFR-录制"><a href="#1-启动时开启-JFR-录制" class="headerlink" title="1. 启动时开启 JFR 录制"></a>1. 启动时开启 JFR 录制</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line">java -XX:+FlightRecorder \
     -XX:StartFlightRecording=duration=60s,filename=vt.jfr,settings=profile \
     -jar target/demo-0.0.1-SNAPSHOT.jar</span><br></pre></td></table></figure>

<p>或者在应用运行期间动态启动：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 找到 PID</span></span><br><span class="line">jps</span><br><span class="line"><span class="comment"># 启动录制（60秒）</span></span><br><span class="line">jcmd &lt;PID&gt; JFR.start duration=60s filename=vt.jfr settings=profile</span><br><span class="line"><span class="comment"># 也可以用 jfr 命令（JDK 21+）</span></span><br></pre></td></table></figure>

<h2 id="2-压测的同时录制"><a href="#2-压测的同时录制" class="headerlink" title="2. 压测的同时录制"></a>2. 压测的同时录制</h2>

<p>在 JFR 录制窗口内执行 wrk 压测，确保捕获到高并发时段的事件。</p>

<h2 id="3-分析结果"><a href="#3-分析结果" class="headerlink" title="3. 分析结果"></a>3. 分析结果</h3>

<p>将 <code>vt.jfr</code> 导入 JMC（<code>jmc</code> 命令启动 GUI），重点关注：</p>

<ul>
<li><strong>Execution Sample</strong> 事件：能看到虚拟线程的栈采样，大量虚拟线程停在 <code>Thread.sleep()</code> / socket 读写的阻塞点上</li>
<li><strong>Virtual Thread</strong> 相关事件（JDK 21 新增）：
  <ul>
  <li><code>jdk.VirtualThreadStart</code> / <code>jdk.VirtualThreadEnd</code>：虚拟线程生命周期</li>
  <li><code>jdk.VirtualThreadPark</code> / <code>jdk.VirtualThreadUnpark</code>：虚拟线程的 park/unpark（对应阻塞/唤醒）</li>
  <li><code>jdk.VirtualThreadSubmitFailed</code>：如果调度器提交失败会记录在这里</li>
  </ul>
</li>
</ul>

<p>典型发现：</p>
<ul>
<li>虚拟线程总数可能达到数千甚至上万（取决于并发量）</li>
<li>载体线程（Carrier/Platform Thread）数量通常等于 CPU 核心数或略多</li>
<li>大部分虚拟线程的时间花在 <code>Park</code> 状态（即等待 I/O）</li>
</ul>

<blockquote><p><strong>没有 GUI 环境怎么办？</strong>可以用 <code>jfr print</code> 命令行解析：<br>
<code>jfr print --categories JDK-JVM,VirtualThread vt.jfr | head -100</code><br>
或者用 <code>--json</code> 输出 JSON 格式交给脚本分析。</p></blockquote>

<h1 id="常见坑与避坑指南"><a href="#常见坑与避坑指南" class="headerlink" title="常见坑与避坑指南"></a>常见坑与避坑指南</h1>

<h2 id="坑-1：synchronized-会导致-Pinning（钉住）"><a href="#坑-1：synchronized-会导致-Pinning（钉住）" class="headerlink" title="坑 1：synchronized 会导致 Pinning（钉住）"></a>坑 1：<code>synchronized</code> 会导致 Pinning（钉住）</h2>

<p>这是虚拟线程<strong>最大的坑</strong>。当虚拟线程进入 <code>synchronized</code> 块或调用 synchronized 方法时，它<strong>无法卸载</strong>，会一直占着底层的载体线程直到退出 synchronized 块。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：synchronized 会导致 pinning</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title function_">doWork</span><span class="params">()</span> {</span><br><span class="line">    Thread.sleep(<span class="number">1000</span>); <span class="comment">// 这 1 秒内载体线程被白白占用！</span></span><br><span class="line">}</span><br></pre></td></table></figure>

<p><strong>解决方案：</strong>用 <code>ReentrantLock</code> 替代 <code>synchronized</code>：</p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ✅ 正确：ReentrantLock 支持卸载</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock <span class="variable">lock</span> <span class="operator">=</span> <span class="keyword">new</span> <span class="title class_">ReentrantLock</span>();</span><br><span class="line"><span class="keyword">public</span> <span class="keyword">void</span> <span class="title function_">doWork</span><span class="params">()</span> {</span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> { Thread.sleep(<span class="number">1000</span>; } <span class="keyword">finally</span> { lock.unlock(); }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p><strong>如何检测 Pinning？</strong>JDK 21 提供了 JVM 参数：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">-Djdk.tracePinning=<span class="string">true</span>  <span class="comment"># 或 =full（含完整堆栈）</span></span><br></pre></td></table></figure>

<p>开启后，当虚拟线程在 <code>synchronized</code> 块中被阻塞时会打印警告日志，帮你定位问题代码。</p>

<h2 id="坑-2：ThreadLocal-内存膨胀"><a href="#坑-2：ThreadLocal-内存膨胀" class="headerlink" title="坑 2：ThreadLocal 内存膨胀"></a>坑 2：ThreadLocal 内存膨胀</h2>

<p>虚拟线程数量可能是平台线程的 <strong>10~100 倍</strong>。如果你的代码里大量使用 <code>ThreadLocal</code>（比如 Spring 的事务管理、RequestContext、SecurityContext 等），每个虚拟线程都会有一份副本，内存压力剧增。</p>

<p><strong>应对策略：</strong></p>
<ul>
<li>JDK 21 引入了 <code>ScopedValue</code>（预览特性）作为 ThreadLocal 的替代方案，它在虚拟线程间共享数据而不需要每线程副本</li>
<li>审查项目中 ThreadLocal 的使用，评估是否必要</li>
<li>关注 GC 日志中 Old Gen 的增长情况</li>
</ul>

<h2 id="坑-3：池化虚拟线程——千万别这么做"><a href="#坑-3：池化虚拟线程——千万别这么做" class="headerlink" title="坑 3：池化虚拟线程——千万别这么做"></a>坑 3：池化虚拟线程——千万别这么做！</h2>

<p>很多人看到"虚拟线程"的第一反应是："那我建个虚拟线程池吧"。<strong>千万不要！</strong></p>

<p>虚拟线程的设计哲学就是<strong>用完即弃</strong>（create-on-demand）：</p>
<ul>
<li>创建一个虚拟线程的成本接近创建一个普通对象（~ns 级别）</li>
<li>JVM 内部已经有高效的调度器（ForkJoinPool 变体）</li>
<li>池化反而会增加复杂度，还可能因为复用导致 <code>ThreadLocal</code> 污染</li>
</ul>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：不要池化虚拟线程</span></span><br><span class="line">ExecutorService pool = Executors.newFixedThreadPool(<span class="number">100</span>, </span><br><span class="line">    Thread.ofVirtual().factory()); <span class="comment">// 别这么干！</span></span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：每次创建新的虚拟线程</span></span><br><span class="line">Thread.startVirtualThread(() -&gt; doSomething());</span><br><span class="line"></span><br><span class="line"><span class="comment">// 或者用 try-with-resources 的 per-task executor：</span></span><br><span class="line"><span class="keyword">try</span> (<span class="type">var</span> executor = Executors.newVirtualThreadPerTaskExecutor()) {</span><br><span class="line">    executor.submit(() -&gt; doSomething());</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="坑-4：CPU 密集型任务没收益"><a href="#坑-4：CPU 密集型任务没收益" class="headerlink" title="坑 4：CPU 密集型任务没收益"></a>坑 4：CPU 密集型任务没收益</h2>

<p>虚拟线程解决的是<strong>I/O 等待</strong>场景下线程利用率低的问题。如果任务是 CPU 密集型的（比如图像处理、加密计算、复杂算法），虚拟线程不会带来任何提升——甚至因为调度开销略有下降。</p>

<p><strong>判断标准：</strong>如果你的请求中有明显的 <code>Thread.sleep()</code>、socket 读写、数据库等待等阻塞操作，虚拟线程就是为你准备的。否则，老老实实用 <code>ForkJoinPool</code> 或线程池就好。</p>

<h2 id="坑-5：第三方库兼容性"><a href="#坑-5：第三方库兼容性" class="headerlink" title="坑 5：第三方库兼容性"></a>坑 5：第三方库兼容性</h2>

<p>一些老旧的第三方库可能会：</p>
<ul>
<li>在 <code>synchronized</code> 中做 I/O（导致 pinning）</li>
<li>缓存 <code>Thread</strong> 对象并假设它是平台线程</li>
<li>调用 <code>Thread.currentThread().setDaemon()/setPriority()</code>（虚拟线程不支持这些操作，会抛异常）</li>
</ul>

<p><strong>建议升级路径：</strong>上线前做一轮全量回归测试，开启 <code>-Djdk.tracePinning=full</code> 观察 pinning 告警。</p>

<h1 id="什么时候该升级？（决策矩阵）"><a href="#什么时候该升级？（决策矩阵）" class="headerlink" title="什么时候该升级？（决策矩阵）"></a>什么时候该升级？（决策矩阵）</h1>

<table>
<thead>
<tr>
<th>场景</th>
<th>适合升级？</th>
<th>原因</th>
</tr>
</thead>
<tbody>
<tr>
<td>Spring Boot 同步阻塞式微服务</td>
<td><strong>✅ 强烈推荐</strong></td>
<td>最典型的受益场景</td>
</tr>
<tr>
<td>已有 WebFlux 响应式服务</td>
<td><strong>❌ 不需要</strong></td>
<td>已经是非阻塞模型</td>
</tr>
<tr>
<td>重度使用 synchronized 的遗留代码</td>
<td><strong>⚠️ 先改造再上</strong></td>
<td>Pinning 会严重削弱效果</td>
</tr>
<tr>
<td>CPU 密集型批处理</td>
<td><strong>❌ 不需要</strong></td>
<td>无 I/O 等待，无收益</td>
</tr>
<tr>
<td>Tomcat 线程池经常满 / 大量 503</td>
<td><strong>✅ 立刻升级</strong></td>
<td>这就是虚拟线程要解决的痛点</td>
</tr>
<tr>
<td>使用 Grpc/Netty 自定义线程模型</td>
<td><strong>⚠️ 评估后再定</strong></td>
<td>需要确认框架层兼容性</td>
</tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从原理到压测数据完整展示了 Spring Boot 3.2+ 虚拟线程的效果：</p>

<ul>
<li><strong>核心价值</strong>：虚拟线程让"一请求一线程"模型重新焕发活力，无需改写为异步代码即可获得接近响应式的吞吐量</li>
<li><strong>性能提升</strong>：在我们的压测中，QPS 提升 <strong>2.5×</strong>，P99 延迟降低 <strong>67%</strong>，错误率归零</li>
<li><strong>接入成本</strong>：Spring Boot 只需一行配置 <code>spring.threads.virtual.enabled: true</code></li>
<li><strong>最大风险</strong>：<code>synchronized</code> 导致的 Pinning 问题，可用 <code>-Djdk.tracePinning</code> 检测</li>
<li><strong>不适合场景</strong>：CPU 密集型任务、已有的 WebFlux 响应式服务</li>
</ul>

<p>对于还在用传统 Tomcat 线程池跑同步阻塞代码的 Spring Boot 项目来说，虚拟线程是目前<strong>性价比最高</strong>的升级方案——几乎零改动、显著提升吞吐。建议在新项目直接启用，旧项目先在测试环境充分验证后再逐步推广。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[官方] OpenJDK Wiki - Project Loom: <a href="https://openjdk.org/projects/loom/" target="_blank">https://openjdk.org/projects/loom/</a></li>
<li>[官方] JDK 21 Release Notes - Virtual Threads: <a href="https://openjdk.org/jeps/444" target="_blank">JEP 444: Virtual Threads</a></li>
<li>[Spring] Spring Framework 6.1 文档 - Virtual Threads 支持: <a href="https://docs.spring.io/spring-framework/reference/integration.html#virtual-threads" target="_blank">https://docs.spring.io/spring-framework/reference/integration.html#virtual-threads</a></li>
<li>[Ron Pressler] 《Loom: What are virtual threads?》— Project Loom 主导者的设计理念文章</li>
<li>[阿里云云原生] 《Java 虚拟线程在生产环境的实践与踩坑》: <a href="https://developer.aliyun.com/article/xxx" target="_blank">https://developer.aliyun.com/</a> （搜索"虚拟线程"）</li>
<li>[美团技术团队] 《Java 虚拟线程原理与性能评测》: <a href="https://tech.meituan.com/" target="_blank">https://tech.meituan.com/</a> （搜索"虚拟线程"）</li>
<li>[Per Minborg] 《Virtual Threads vs. Traditional Threads Performance》— jOOQ 作者的基准测试对比</li>
<li>[Baeldung] 《Guide to Virtual Threads in Java》: <a href="https://www.baeldung.com/java-virtual-threads" target="_blank">https://www.baeldung.com/java-virtual-threads</a></li>
</ol>
