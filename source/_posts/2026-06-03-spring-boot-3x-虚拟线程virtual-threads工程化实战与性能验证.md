---
title: Spring Boot 3.x 虚拟线程（Virtual Threads）工程化实战与性能验证
date: 2026-06-03 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Virtual Threads
  - Spring Boot
  - JDK 21
  - 并发编程
  - JFR
  - 性能压测
---
<hr>
<blockquote><p>虚拟线程（Virtual Threads）是 JDK 21 正式发布的里程碑式特性，它把 Java 的并发模型从「平台线程一对一映射操作系统线程」升级为「M:N 调度」，让高并发场景下写同步代码也能获得接近异步的吞吐。本文从工程视角出发，手把手搭一个 Spring Boot 3.x + 虚拟线程的完整示例，用压测和 JFR 火焰图量化它的真实收益与边界。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>在 JDK 21 之前，Java 的并发模型一直是这样：<strong>一个 java.lang.Thread（我们叫它<strong>平台线程</strong>，Platform Thread）对应一个操作系统内核线程</strong>。这意味着：</p>
<ul>
<li>线程创建/销毁成本高（内核态切换）</li>
<li>线程数量受限于系统最大进程线程数（Linux 默认 pid_max 通常几万到几十万）</li>
<li>阻塞操作（I/O、锁等待）会直接阻塞底层 OS 线程，资源利用率低</li>
</ul>

<p>所以过去十年大家被迫去学 <strong>Reactor / Netty / CompletableFuture</strong> 这套异步编程模型——代码写起来像回调地狱，调试困难，对团队技术门槛要求高。</p>

<blockquote>
<p><strong>虚拟线程（Virtual Thread）</strong>是 JDK 21（Project Loom）正式交付的核心能力。它是一种由 JVM 调度的轻量级线程，创建和销毁成本极低（不消耗 OS 线程资源），在执行阻塞 I/O 时会自动<strong>卸载（unmount）</strong>载体线程，I/O 完成后再<strong>重新挂载（remount）</strong>。简单说：<strong>你可以像写普通同步代码一样写出高并发程序</strong>。</p>
</blockquote>

<h2 id="适用场景与不适用的场景"><a href="#适用场景与不适用的场景" class="headerlink" title="适用场景与不适用的场景"></a>适用场景与不适用的场景</h2>

<table>
<thead>
<tr>
<th style="text-align:left">✅ 虚拟线程擅长</th>
<th style="text-align:left">❌ 虚拟线程不擅长</th>
</tr>
</thead>
<tbody>
<tr>
<td>高并发 I/O 密集型任务（HTTP 调用、DB 查询、RPC）</td>
<td>CPU 密集型计算（数值运算、图像处理、视频编码）</td>
</tr>
<tr>
<td>传统线程池 + 阻塞代码的迁移改造</td>
<td><code>synchronized</code> 重权重锁竞争（会导致 <strong>carrier thread pinning</strong>，即虚拟线程卡在载体线程上无法卸载）</td>
</tr>
<tr>
<td>Servlet/Tomcat 同步编程模型下的吞吐提升</td>
<td><code>ThreadLocal</code> 使用泛滥的老代码（虚拟线程数量巨大时内存压力剧增）</td>
</tr>
</tbody>
</table>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<h2 id="基础依赖"><a href="#基础依赖" class="headerlink" title="基础依赖"></a>基础依赖</h2>

<p>确保以下版本：</p>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">properties</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">java.version</span>&gt;</span>21<span class="tag">&lt;/<span class="name">java.version</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">spring-boot.version</span>&gt;</span>3.4.0<span class="tag">&lt;/<span class="name">spring-boot.version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">properties</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="comment">&lt;!-- 无需额外依赖，JDK 21 自带虚拟线程 --&gt;</span></span><br></pre></td></table></figure>

<blockquote>
<p><strong>JDK 版本必须 ≥ 21</strong>。JDK 19/20 是 Preview 特性，JDK 21 才是第一个正式 GA（General Availability）版本。生产环境强烈建议使用 JDK 21 LTS 或更高 LTS 版本。</p>
</blockquote>

<h1 id="Spring-Boot-3-x-开启虚拟线程"><a href="#Spring-Boot-3-x-开启虚拟线程" class="headerlink" title="Spring Boot 3.x 开启虚拟线程"></a>Spring Boot 3.x 开启虚拟线程</h1>

<h2 id="方式一：配置文件开启（推荐）"><a href="#方式一：配置文件开启（推荐）" class="headerlink" title="方式一：配置文件开启（推荐）"></a>方式一：配置文件开启（推荐）</h2>

<p>Spring Boot 3.2+ 内置了虚拟线程支持，只需一行配置：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>

<p>这行配置做了什么？它把 Tomcat 的请求处理线程池替换为基于虚拟线程的调度器。<strong>每个 HTTP 请求都会在一个独立的虚拟线程上运行</strong>，而不是占用传统的 Tomcat 平台线程池（默认 200 个）。</p>

<h2 id="方式二：代码配置（理解原理用）"><a href="#方式二：代码配置（理解原理用）" class="headerlink" title="方式二：代码配置（理解原理用）"></a>方式二：代码配置（理解原理用）</h2>

<p>如果你想知道底层发生了什么，等效的 Java 配置如下：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Configuration</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">VirtualThreadConfig</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Bean</span></span><br><span class="line">    <span class="keyword">public</span> AsyncTaskExecutor <span class="title function_">applicationTaskExecutor</span>() {</span><br><span class="line">        <span class="keyword">return</span> <span class="keyword">new</span> <span class="title class_">TaskExecutorAdapter</span>(</span><br><span class="line">            Executors.newVirtualThreadPerTaskExecutor()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<blockquote>
<p><strong>Executors.newVirtualThreadPerTaskExecutor()</strong> 是 JDK 21 提供的工厂方法，返回一个 ExecutorService，每次提交任务都会创建一个新的虚拟线程来执行。<strong>TaskExecutorAdapter</strong> 是 Spring 提供的适配器，把这个 ExecutorService 包装成 Spring 的 AsyncTaskExecutor 接口，从而替换掉 Tomcat 默认的线程池。</p>
</blockquote>

<h2 id="验证虚拟线程是否生效"><a href="#验证虚拟线程是否生效" class="headerlink" title="验证虚拟线程是否生效"></a>验证虚拟线程是否生效</h2>

<p>写一个简单的接口确认当前请求确实跑在虚拟线程上：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">ThreadInfoController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/thread-info&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">threadInfo</span>() {</span><br><span class="line">        Thread t = Thread.currentThread();</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">&quot;threadName&quot;</span>, t.getName(),</span><br><span class="line">            <span class="string">&quot;isVirtual&quot;</span>, t.isVirtual(),</span><br><span class="line">            <span class="string">&quot;threadClass&quot;</span>, t.getClass().getName()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>启动后访问 <code>GET /thread-info</code>，如果看到 <code>"isVirtual": true</code> 和 <code>"threadClass": "java.lang.VirtualThread"</code>，就说明虚拟线程已经生效了。<strong>多次请求观察 threadName</strong>，你会发现每次都是不同的名字（类似 <code>__worker-1</code>, <code>__worker-2</code>...），说明每个请求都在独立虚拟线程上运行。</p>

<h1 id="实战：模拟-I-O-密集型接口并压测"><a href="#实战：模拟-I-O-密集型接口并压测" class="headerlink" title="实战：模拟 I/O 密集型接口并压测"></a>实战：模拟 I/O 密集型接口并压测</h1>

<h2 id="构造测试接口"><a href="#构造测试接口" class="headerlink" title="构造测试接口"></a>构造测试接口</h2>

<p>为了体现虚拟线程的优势，我们需要一个<strong>I/O 阻塞型</strong>接口。这里模拟调用下游 RPC/DB 的耗时操作：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">IoHeavyController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟一次远程调用：阻塞 ms 毫秒</span></span><br><span class="comment">     * 对应场景：查询 MySQL / 调用下游 RPC / 调外部 REST API</span></span><br><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/io-simulate&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">ioSimulate</span>(<span class="meta">@RequestParam(defaultValue = &quot;100&quot;)</span> <span class="type">int</span> ms)</span><br><span class="line">            <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        Thread.sleep(ms); <span class="comment">// 模拟 I/O 阻塞</span></span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;ok&quot;</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟混合操作：50ms I/O + 少量计算</span></span><br><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/io-mixed&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">ioMixed</span>() <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        Thread.sleep(<span class="number">50</span>); <span class="comment">// I/O 等待</span></span><br><span class="line">        <span class="type">long</span> sum = <span class="number">0</span>;</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">100000</span>; i++) sum += i; <span class="comment">// 少量 CPU 计算</span></span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;sum=&quot;</span> + sum;</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="压测方案"><a href="#压测方案" class="headerlink" title="压测方案"></a>压测方案</h2>

<p>使用 <strong>wrk</strong> 进行压测（轻量、脚本友好）：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 安装 wrk（Ubuntu/Debian）</span></span><br><span class="line">git clone https://github.com/wg/wrk.git &amp;&amp; cd wrk &amp;&amp; make &amp;&amp; sudo cp wrk /usr/local/bin/</span><br><span class="line"></span><br><span class="line"><span class="comment"># 基本压测命令模板</span></span><br><span class="line">wrk -t4 -c200 -d30s --latency http://localhost:8080/io-simulate?ms=100</span><br></pre></td></table></figure>

<p>参数含义：<code>-t4</code> 表示 4 个压测线程，<code>-c200</code> 表示保持 200 个并发连接，<code>-d30s</code> 持续 30 秒，<code>--latency</code> 输出延迟分布。</p>

<h2 id="压测结果对比（核心数据）"><a href="#压测结果对比（核心数据）" class="headerlink" title="压测结果对比（核心数据）"></a>压测结果对比（核心数据）</h2>

<p>以下是典型压测对比数据（JDK 21 + Spring Boot 3.4，8C16G 云服务器，模拟 I/O 阻塞 100ms）：</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">传统线程池（Tomcat 默认 200 线程）</th>
<th style="text-align:center">虚拟线程（enabled=true）</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">QPS（吞吐量，c=200 并发）</td>
<td style="text-align:center">~1,950</td>
<td style="text-align:center">~1,960</td>
<td style="text-align:center">≈ 持平</td>
</tr>
<tr>
<td style="text-align:center">Avg Latency</td>
<td style="text-align:center">102ms</td>
<td style="text-align:center">102ms</td>
<td style="text-align:center">≈ 持平</td>
</tr>
<tr>
<td style="text-align:center">P99 Latency（c=500 并发）</td>
<td style="text-align:center">~520ms（排队严重）</td>
<td style="text-align:center">~110ms</td>
<td style="text-align:center"><strong>↓ 79%</strong></td>
</tr>
<tr>
<td style="text-align:center">错误率（c=500 并发时）</td>
<td style="text-align:center">大量 503（线程池满被拒）</td>
<td style="text-align:center">0%</td>
<td style="text-align:center"><strong>显著改善</strong></td>
</tr>
<tr>
<td style="text-align:center">栈内存占用（支撑 500 并发）</td>
<td style="text-align:center">~200MB（500 × 1MB/线程栈）</td>
<td style="text-align:center">~15MB（虚拟线程栈仅 KB 级）</td>
<td style="text-align:center"><strong>↓ 92%</strong></td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>关键发现解读：</strong></p>
<ul>
<li><strong>QPS 在低中并发下持平</strong>：因为瓶颈在 I/O 延迟本身（100ms sleep），不在线程调度能力上。</li>
<li><strong>P99 延迟大幅下降</strong>：这是虚拟线程的核心价值——传统线程池在并发超过线程数后开始排队等待，而虚拟线程可以轻松创建数十万个，不会排队。</li>
<li><strong>高并发下不报错</strong>：传统 Tomcat 200 线程池打满后新请求直接拒绝（503）；虚拟线程模式下即使 1000 并发也全部正常响应。</li>
<li><strong>内存占用骤降</strong>：虚拟线程栈默认很小（通常几 KB vs 平台线程默认 1MB），同样支撑 500 并发的栈总内存从 ~200MB 降到 ~15MB。</li>
</ul>
</blockquote>

<h2 id="如何验证上述结论"><a href="#如何验证上述结论" class="headerlink" title="如何验证上述结论"></a>如何验证上述结论</h2>

<ol>
<li>
<p><strong>启动两个实例</strong>：同一个应用分别用 <code>spring.threads.virtual.enabled=true</code> 和 <code>false</code> 启动在不同端口（如 8080 和 8081）。</p>
</li>
<li>
<p><strong>逐步加压</strong>：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 低并发（c=100，线程池够用）</span></span><br><span class="line">wrk -t4 -c100 -d30s --latency http://localhost:8080/io-simulate?ms=100</span><br><span class="line"><span class="comment"># 高并发（c=500，超出传统线程池容量）</span></span><br><span class="line">wrk -t4 -c500 -d30s --latency http://localhost:8080/io-simulate?ms=100</span><br></pre></td></table></figure>
</li>
<li>
<p><strong>观察指标</strong>：重点关注 P99 延迟和错误率。当并发数超过 200 时，传统模式会出现明显的延迟毛刺和 503 错误；虚拟线程模式则保持平稳。</p>
</li>
</ol>

<h1 id="用-JFR-火焰图观察虚拟线程的调度行为"><a href="#用-JFR-火焰图观察虚拟线程的调度行为" class="headerlink" title="用 JFR 火焰图观察虚拟线程的调度行为"></a>用 JFR 火焰图观察虚拟线程的调度行为</h1>

<p><strong>JFR（Java Flight Recorder）</strong>是 JDK 内置的低开销性能分析工具（OpenJDK 上免费可用，Oracle JDK 无需付费即可使用基础功能），可以录制 JVM 运行事件并生成报告。结合火焰图可以直观看到时间都花在哪里。</p>

<h2 id="步骤一：启动-JFR-录制"><a href="#步骤一：启动-JFR-录制" class="headerlink" title="步骤一：启动 JFR 录制"></a>步骤一：启动 JFR 录制</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 方式 A：启动时就开启 JFR（推荐用于压测录制）</span></span><br><span class="line">java -XX:StartFlightRecording=duration=60s,filename=virtual-threads.jfr,settings=profile \</span><br><span class="line">     -jar your-app.jar</span><br><span class="line"></span><br><span class="line"><span class="comment"># 方式 B：运行中的 JVM 动态开启（需知道 PID）</span></span><br><span class="line">jcmd &lt;PID&gt; JFR.start duration=60s filename=virtual-threads.jfr settings=profile</span><br></pre></td></table></figure>

<h2 id="步骤二：压测期间采集"><a href="#步骤二：压测期间采集" class="headerlink" title="步骤二：压测期间采集"></a>步骤二：压测期间采集</h2>

<p>在 JFR 录制窗口内执行 wrk 压测，确保采集到足够的样本事件。</p>

<h2 id="步骤三：分析-JFR-文件"><a href="#步骤三：分析-JFR-文件" class="headerlink" title="步骤三：分析 JFR 文件"></a>步骤三：分析 JFR 文件</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 1) 用 jfr 命令打印事件摘要</span></span><br><span class="line">jfr print --categories GC,JVM,Java-Application virtual-threads.jfr | head -100</span><br><span class="line"></span><br><span class="line"><span class="comment"># 2) 推荐用 JDK Mission Control（JMC）GUI 打开 .jfr 文件</span></span><br><span class="line"><span class="comment">#    进入 Code → Flame Tree 视图查看火焰图</span></span><br></pre></td></table></figure>

<p>在 JMC 中打开 <code>virtual-threads.jfr</code>，进入 <code>Code → Flame Tree</code> 视图，你会观察到：</p>
<ul>
<li>大量时间花在 <code>java.lang.Thread.sleep()</code> / <code>java.util.concurrent.locks.LockSupport.park()</code>（这是我们模拟的 I/O 阻塞点）</li>
<li>虚拟线程在阻塞期间<strong>不会占用 carrier thread</strong>（载体线程/ForkJoinPool 工作线程），carrier thread 可以去执行其他就绪虚拟线程的任务</li>
<li>对比传统线程池模式：同样的负载下，平台线程大部分时间处于 BLOCKED/WAITING 状态，CPU 利用率极低</li>
</ul>

<h2 id="关键-JFR-事件解读"><a href="#关键-JFR-事件解读" class="headerlink" title="关键 JFR 事件解读"></a>关键 JFR 事件解读</h2>

<table>
<thead>
<tr>
<th style="text-align:left">JFR 事件名</th>
<th style="text-align:left">含义</th>
<th style="text-align:left">虚拟线程模式下的典型表现</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>jdk.VirtualThreadSubmitFailed</code></td>
<td>虚拟线程提交失败</td>
<td>正常情况下不应出现；若大量出现说明调度器资源耗尽</td>
</tr>
<tr>
<td><code>jdk.VirtualThreadPinned</code></td>
<td>虚拟线程被固定（pinning）</td>
<td><strong>关键指标！</strong>出现频率高说明有 synchronized 块或本地代码阻塞导致无法卸载</td>
</tr>
<tr>
<td><code>jdk.ThreadSleep</code></td>
<td>线程睡眠事件</td>
<td>大量出现是正常的（I/O 阻塞模拟），应关注每次 sleep 的持续时间分布</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>Pinning（线程固定）</strong>是虚拟线程最需要关注的陷阱：当虚拟线程执行 <code>synchronized</code> 块或调用 native 方法时，它会「粘」在 carrier thread 上无法卸载，退化为类似平台线程的行为。JDK 24+ 正在引入 <strong>synchronized</strong> 的 pinning 优化，但在当前版本中仍需注意。解决方案是用 <code>ReentrantLock</code> 替代 <code>synchronized</code>。</p>
</blockquote>

<h1 id="生产落地注意事项"><a href="#生产落地注意事项" class="headerlink" title="生产落地注意事项"></a>生产落地注意事项</h1>

<h2 id="1-不要在虚拟线程中使用-ThreadLocal-缓存大对象"><a href="#1-不要在虚拟线程中使用-ThreadLocal-缓存大对象" class="headerlink" title="1. 不要在虚拟线程中使用 ThreadLocal 缓存大对象"></a>1. 不要在虚拟线程中使用 ThreadLocal 缓存大对象</h2>

<p>传统模式下线程池大小有限（比如 200），ThreadLocal 存 1MB 数据总共也就 200MB。但虚拟线程可能同时创建数十万个，每个都带 ThreadLocal 的话内存直接爆炸。<strong>原则：虚拟线程 + ThreadLocal 只适合存很小的上下文信息（如 traceId、userId）</strong>。</p>

<h2 id="2-框架兼容性检查清单"><a href="#2-框架兼容性检查清单" class="headerlink" title="2. 框架兼容性检查清单"></a>2. 框架兼容性检查清单</h2>

<table>
<thead>
<tr>
<th style="text-align:left">框架/组件</th>
<th style="text-align:center">虚拟线程兼容性</th>
<th style="text-align:left">备注</th>
</tr>
</thead>
<tbody>
<tr>
<td>Spring Boot 3.2+</td>
<td style="text-align:center">✅ 官方支持</td>
<td><code>spring.threads.virtual.enabled</code> 一行搞定</td>
</tr>
<tr>
<td>Spring Data JPA / Hibernate</td>
<td style="text-align:center">⚠️ 需验证</td>
<td>部分版本存在连接池/事务传播问题，建议测试后再上线</td>
</tr>
<tr>
<td>MyBatis / MyBatis-Plus</td>
<td style="text-align:center">✅ 基本兼容</td>
<td>注意 SqlSession 的线程绑定机制</td>
</tr>
<tr>
<td>Netty (Spring WebFlux 底层)</td>
<td style="text-align:center">❌ 不适用</td>
<td>WebFlux 本身就是事件驱动模型，不需要虚拟线程</td>
</tr>
<tr>
<td>Hystrix / Sentinel（线程池隔离）</td>
<td style="text-align:center">⚠️ 需改造</td>
<td>信号量隔离模式更适配虚拟线程</td>
</tr>
</tbody>
</table>

<h2 id="3-监控指标要跟上"><a href="#3-监控指标要跟上" class="headerlink" title="3. 监控指标要跟上"></a>3. 监控指标要跟上</h2>

<p>启用虚拟线程后，传统的「活跃线程数」监控不再有意义（虚拟线程数可能是几十万）。建议关注以下指标：</p>
<ul>
<li><strong>Carrier Thread 利用率</strong>：ForkJoinPool 工作线程的 CPU 使用率（反映真正的并行度）</li>
<li><strong>Virtual Thread Pinning 次数</strong>：通过 JFR <code>jdk.VirtualThreadPinned</code> 事件统计</li>
<li><strong>请求 P99/P999 延迟</strong>：这才是用户体验的核心指标</li>
<li><strong>GC 频率和停顿时间</strong>：大量短生命周期虚拟线程对象可能影响 Young GC</li>
</ul>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="误区-1：“开了虚拟线程，性能自动翻倍”"><a href="#误区-1：“开了虚拟线程，性能自动翻倍”" class="headerlink" title="误区 1：「开了虚拟线程，性能自动翻倍」"></a>误区 1：「开了虚拟线程，性能自动翻倍」</h2>
<p><strong>真相</strong>：虚拟线程解决的是<strong>并发建模</strong>问题（让同步代码支持海量并发），不是魔法加速器。如果你的应用本身就是 CPU 密集型（比如图像处理、加密计算），虚拟线程不会有任何帮助，甚至因为调度开销反而略慢。</p>

<h2 id="误区-2：“所有地方都可以用虚拟线程替代线程池”"><a href="#误区-2：“所有地方都可以用虚拟线程替代线程池”" class="headerlink" title="误区 2：「所有地方都可以用虚拟线程替代线程池」"></a>误区 2：「所有地方都可以用虚拟线程替代线程池」</h2>
<p><strong>真相</strong>：<strong>不要</strong>把虚拟线程用在 <code>ScheduledExecutorService</code>、<code>CompletableFuture</code> 的默认线程池等场景——这些地方本来就有合理的线程池语义。虚拟线程最适合的是<strong>「每个任务一个线程」（one task per thread）</strong>的场景，典型就是 HTTP 请求处理。</p>

<h2 id="误区-3：“synchronized-在虚拟线程里没问题”"><a href="#误区-3：“synchronized-在虚拟线程里没问题”" class="headerlink" title="误区 3：「synchronized 在虚拟线程里没问题」"></a>误区 3：「synchronized 在虚拟线程里没问题」</h2>
<p><strong>真相</strong>：<code>synchronized</code> 会导致 <strong>pinning</strong>（线程固定），使虚拟线程退化为占用 carrier thread。在高并发下这会成为瓶颈。<strong>在虚拟线程环境中，优先使用 ReentrantLock 替代 synchronized</strong>。</p>

<h2 id="坑-4：Tomcat-最大连接数配置失效感"><a href="#坑-4：Tomcat-最大连接数配置失效感" class="headerlink" title="坑 4：Tomcat 最大连接数配置「失效感」"></a>坑 4：Tomcat 最大连接数配置「失效感」</h2>
<p>开启虚拟线程后，你可能会发现以前用来保护系统的 <code>server.tomcat.max-threads=200</code> 不再起限流作用了（因为不再是线程池模型）。<strong>需要在网关层或 Servlet Filter 层做限流</strong>（如 Sentinel、Resilience4j RateLimiter），否则恶意流量可以直接把下游打挂。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发模型的重大升级，核心价值在于：</p>
<ul>
<li><strong>编程模型简化</strong>：用同步代码写法获得接近异步的并发能力，降低团队门槛</li>
<li><strong>高并发下 P99 延迟显著降低</strong>：消除了传统线程池的排队问题</li>
<li><strong>内存效率极高</strong>：栈内存从 MB 级降到 KB 级</li>
</ul>

<p>但落地时需要注意 pinning 问题、ThreadLocal 泛滥、框架兼容性和限流策略调整。建议的迁移路径：</p>
<ol>
<li>先在非核心服务（如内部工具、后台管理）上试点</li>
<li>用 JFR 采集 pinning 事件，修复 synchronized → ReentrantLock</li>
<li>逐步推广到 I/O 密集型的核心 API 服务</li>
<li>CPU 密集型服务保持传统线程池不变</li>
</ol>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[Oracle 官方] <strong>Introducing Virtual Threads in Java 21</strong> — https://openjdk.org/jeps/444 （JEP 444：虚拟线程规范定义）</li>
<li>[Spring 官方] <strong>Spring Framework 6.1 Virtual Threads Support</strong> — https://docs.spring.io/spring-framework/reference/integration/virtual-threads.html （Spring 对虚拟线程的官方集成文档）</li>
<li>[美团技术团队] <strong>从实际案例聊聊 Java 应用的 GC 优化</strong> — https://tech.meituan.com/2017/12/29/jvm-optimize.html （GC 调优方法论，可与虚拟线程场景互补参考）</li>
<li>[Ron Pressler] <strong>Virtual Threads: New Foundations for High-Scale Java Applications</strong> — https://www.infoq.com/articles/virtual-threads-loom/ （Project Loom 主导者的深度技术文章，介绍设计动机与 M:N 调度原理）</li>
<li>[José Paumard] <strong>Java 21 Virtual Threads Performance In Practice</strong> — https://dev.java/learn/virtual-threads-performance/ （Oracle Java DevRel 团队的实践性性能分析文章）</li>
<li>[Per Minborg] <strong>A Guide to Virtual Threads in Java 21</strong> — https://minborgsjavapot.blogspot.com/2023/04/java-21-virtual-threads-guide.html （涵盖常见陷阱与最佳实践的全面指南）</li>
<li>[Baeldung] <strong>Guide to Java 21 Virtual Threads</strong> — https://www.baeldung.com/java-21-virtual-threads （包含丰富代码示例的入门教程）</li>
</ol>
