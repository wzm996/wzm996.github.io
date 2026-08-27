---
title: 深入理解 Java 虚拟线程——原理、压测与 Spring Boot 实践
date: 2026-08-27 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java 21
  - Virtual Threads
  - Spring Boot
  - Project Loom
  - 性能压测
  - Tomcat
---
<hr>
<blockquote><p>Java 21 正式发布了虚拟线程（Virtual Threads，JEP 444），这是自 JDK 1.0 引入 Thread 以来 Java 并发模型的最大变革。它不是"更快的线程"，而是"几乎免费创建、阻塞成本极低的线程"——让"一请求一线程"这个最直观的编程模型终于能扛住高并发 I/O 场景。本文从底层原理出发，用真实压测数据对比虚拟线程与传统平台线程的差异，并给出在 Spring Boot 中落地的完整步骤和生产注意事项。</p></blockquote>

<!-- more -->

<h1 id="背景-为什么需要虚拟线程"><a href="#背景-为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>写 Java Web 服务时，我们一直在用<strong>平台线程</strong>（Platform Thread）——也就是操作系统线程的 Java 包装。Tomcat 默认线程池 200 个线程，每个请求占一个线程，线程在等数据库、等 RPC、等 Redis 时就傻等着，啥也不干。</p>

<p>问题很明确：</p>
<ul>
<li><strong>线程贵</strong>：每个平台线程默认栈大小 ~1MB，1000 个线程就是 1GB 内存</li>
<li><strong>线程数有上限</strong>：一台机器能跑多少 OS 线程受内存和 CPU 调度开销限制，通常几千个就是极限</li>
<li><strong>线程池参数难调</strong>：设小了吞吐上不去，设大了上下文切换把 CPU 吃光</li>
</ul>

<p>以前要解决这个问题，只能走 <strong>异步非阻塞</strong>路线（Node.js 风格、Netty/WebFlux），但异步代码写起来反直觉、调试困难、迁移成本高。</p>

<p><strong>虚拟线程</strong>（Virtual Threads，Project Loom 的核心产出）给出的答案是：<strong>保留"一请求一线程"的简单编程模型，但让线程变得极其轻量</strong>。</p>

<h1 id="核心概念-虚拟线程到底是什么"><a href="#核心概念-虚拟线程到底是什么" class="headerlink" title="核心概念：虚拟线程到底是什么"></a>核心概念：虚拟线程到底是什么</h1>

<h2 id="基本定义"><a href="#基本定义" class="headerlink" title="基本定义"></a>基本定义</h2>

<p><strong>虚拟线程</strong>（Virtual Thread）是一种由 JVM 调度管理的轻量级线程实现。它依然是 <code>java.lang.Thread</code> 的实例，但不再一一映射到操作系统线程。当虚拟线程执行阻塞操作（I/O、<code>Thread.sleep()</code>、<code>BlockingQueue.take()</code> 等）时，JVM 会自动把它<strong>卸载</strong>（mount off），释放底层的平台线程给其他虚拟线程用。</p>

<p>关键特性：</p>
<ul>
<li><strong>创建/销毁开销极低</strong>：栈初始只有几百字节，存放在 Java 堆上</li>
<li><strong>支持百万级并发</strong>：一台机器轻松创建 100 万+ 虚拟线程</li>
<li><strong>完全兼容现有 API</strong>：<code>synchronized</code> 除外（见后文"常见坑"），其他 <code>Thread</code>/<code>ExecutorService</code> 代码无需改动</li>
</ul>

<h2 id="调度模型-载体线程与-forkjoinpool"><a href="#调度模型-载体线程与-forkjoinpool" class="headerlink" title="调度模型：载体线程与 ForkJoinPool"></a>调度模型：载体线程与 ForkJoinPool</h2>

<p>虚拟线程的调度关系可以用一句话概括：</p>

<pre><code>平台线程 : OS 线程 = 1 : 1（传统模型）
虚拟线程 : 平台线程 = M : N（M >> N，Loom 模型）
</code></pre>

<p>JVM 内部维护一个 <strong>ForkJoinPool</strong> 作为虚拟线程调度器（FIFO 模式，work-stealing），它和并行流用的 common pool <strong>不是同一个</strong>。调度器把虚拟线程挂载到<strong>载体线程</strong>（Carrier Thread，即平台线程）上执行；遇到阻塞操作时，虚拟线程被卸载，载体线程空闲出来执行下一个虚拟线程。</p>

<table>
<thead>
<tr>
<th>维度</th>
<th>平台线程（传统）</th>
<th>虚拟线程（Loom）</th>
</tr>
</thead>
<tbody>
<tr>
<td>调度者</td>
<td>操作系统</td>
<td>JVM（ForkJoinPool）</td>
</tr>
<tr>
<td>栈大小</td>
<td>~1MB（原生内存）</td>
<td>几百字节~几 KB（Java 堆，按需扩展）</td>
</tr>
<tr>
<td>创建成本</td>
<td>高（系统调用）</td>
<td>极低（纯用户态）</td>
</tr>
<tr>
<td>阻塞行为</td>
<td>阻塞整个 OS 线程</td>
<td>自动卸载，释放载体线程</td>
</tr>
<tr>
<td>最大数量</td>
<td>几千~几万</td>
<td>百万级</td>
</tr>
</tbody>
</table>

<h2 id="什么时候会触发卸载"><a href="#什么时候会触发卸载" class="headerlink" title="什么时候会触发卸载？"></a>什么时候会触发卸载？</h2>

<p>以下操作会让虚拟线程从载体线程上<strong>卸载</strong>：</p>
<ul>
<li><code>Thread.sleep()</code></li>
<li><code>BlockingQueue.put()/take()</code>、<code>LockSupport.park()</code></li>
<li><strong>I/O 操作</strong>：Socket 读写的阻塞调用（前提是用 java.nio.channels.SocketChannel 或已适配的 API）</li>
<li><code>CompletableFuture.join()</code> 等等待操作</li>
</ul>

<p><strong>注意</strong>：<code>synchronized</code> 块<strong>不会</strong>触发卸载！这是目前虚拟线程最大的坑之一，后面详细说。</p>

<h1 id="实战-在-spring-boot-中启用虚拟线程"><a href="#实战-在-spring-boot-中启用虚拟线程" class="headerlink" title="实战：在 Spring Boot 中启用虚拟线程"></a>实战：在 Spring Boot 中启用虚拟线程</h1>

<h2 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h2>

<ul>
<li><strong>JDK</strong>：21+（推荐 LTS 版本，如 Eclipse Temurin 21、Liberica JDK 21）</li>
<li><strong>Spring Boot</strong>：3.2+（3.2 才正式支持 <code>spring.threads.virtual.enabled</code>）</li>
<li><strong>Maven/Gradle</strong>：确保 <code>java.version</code> 设为 21</li>
</ul>

<h2 id="第一步-一行配置开启"><a href="#第一步-一行配置开启" class="headerlink" title="第一步：一行配置开启"></a>第一步：一行配置开启</h2>

<p>在 <code>application.properties</code> 或 <code>application.yml</code> 中加一行：</p>

<figure class="highlight properties"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"># application.properties</span><br><span class="line"><span class="attr">spring.threads.virtual.enabled</span>=<span class="string">true</span><br></span></td></tr></table></figure>

<p>就这么简单。Spring Boot 会自动把内嵌 Tomcat（或 Jetty）的请求处理线程池替换为虚拟线程池。<strong>每个 HTTP 请求都会由一个独立的虚拟线程处理</strong>，不再受 Tomcat 默认 200 线程的限制。</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.yml 写法</span><br><span class="line"><span class="attr">spring:</span><br><span class="line">  <span class="attr">threads:</span><br><span class="line">    <span class="attr">virtual:</span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span><br></span></td></tr></table></figure>

<h2 id="第二步-编写一个模拟-io-阻塞的接口"><a href="#第二步-编写一个模拟-io-阻塞的接口" class="headerlink" title="第二步：编写一个模拟 I/O 阻塞的接口"></a>第二步：编写一个模拟 I/O 阻塞的接口</h2>

<p>为了体现虚拟线程的优势，我们需要一个<strong>I/O 密集型</strong>的接口。下面这个 Controller 模拟了一个耗时 200ms 的下游调用：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping(&quot;/api&quot;)</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">DemoController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/hello&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">hello</span><span class="params">(HttpServletRequest request)</span> {</span><br><span class="line">        <span class="comment">// 模拟 I/O 阻塞：查数据库 / 调 RPC / 等 Redis</span><br></span><br><span class="line">        <span class="keyword">try</span> {</span><br><span class="line">            Thread.<span class="built_in">sleep</span>(<span class="number">200</span>); <span class="comment">// 模拟 200ms 的下游 RT</span><br></span><br><span class="line">        } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">            Thread.currentThread().interrupt();</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;Hello from &quot;</span> + Thread.currentThread().getName();</span><br><span class="line">    }</span><br><span class="line">}</span><br></td></tr></table></figure>

<p>返回值里带上线程名是为了方便观察：虚拟线程的名字类似 <code>__reactor-tomcat-internal-nio-82-exec-1</code>，而平台线程类似 <code>http-nio-8080-exec-123</code>。</p>

<h2 id="第三步-手动创建虚拟线程非-web-场景"><a href="#第三步-手动创建虚拟线程非-web-场景" class="headerlink" title="第三步：手动创建虚拟线程（非 Web 场景）"></a>第三步：手动创建虚拟线程（非 Web 场景）</h2>

<p>除了 Spring Boot 自动配置，你还可以在业务代码中直接创建虚拟线程：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 方式一：直接启动</span><br></span><br><span class="line">Thread.startVirtualThread(() -&gt; {</span><br><span class="line">    System.out.println(<span class="string">&quot;我是虚拟线程: &quot;</span> + Thread.currentThread());</span><br><span class="line">});</span><br><span class="line"></span><br><span class="line"><span class="comment">// 方式二：使用 ExecutorService（推荐批量任务）</span><br></span><br><span class="line"><span class="keyword">try</span> (<span class="type">var executor</span> = Executors.newVirtualThreadPerTaskExecutor()) {</span><br><span class="line">    <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">10_000</span>; i++) {</span><br><span class="line">        executor.submit(() -&gt; {</span><br><span class="line">            <span class="comment">// 每次提交都会创建一个新的虚拟线程</span><br></span><br><span class="line">            Thread.<span class="built_in">sleep</span>(<span class="number">1000</span>); <span class="comment">// 模拟 IO 等待</span><br></span><br><span class="line">            System.out.println(<span class="string">&quot;完成! &quot;</span> + Thread.currentThread());</span><br><span class="line">        });</span><br><span class="line">    }</span><br><span class="line">} <span class="comment">// try-with-resources 会自动调用 executor.close()（等待所有任务完成或关闭）</span><br></span><br></td></tr></table></figure>

<p><strong>关键区别</strong>：<code>newVirtualThreadPerTaskExecutor()</code> 和传统的 <code>newFixedThreadPool(200)</code> 不同——它不限制线程数量，每次 submit 都是一个新虚拟线程，线程数随任务数增长，但内存占用极低。</p>

<h1 id="压测对比-用数据说话"><a href="#压测对比-用数据说话" class="headerlink" title="压测对比：用数据说话"></a>压测对比：用数据说话</h1>

<h2 id="测试方案"><a href="#测试方案" class="headerlink" title="测试方案"></a>测试方案</h2>

<p>我们用 <strong>Apache Bench（ab）</strong>对上面那个 <code>/api/hello</code> 接口进行压测，对比两种模式：</p>

<table>
<thead>
<tr>
<th>配置项</th>
<th>场景 A（平台线程）</th>
<th>场景 B（虚拟线程）</th>
</tr>
</thead>
<tbody>
<tr>
<td>JDK</td>
<td>Eclipse Temurin 21</td>
<td>Eclipse Temurin 21</td>
</tr>
<tr>
<td>Spring Boot</td>
<td>3.2.x</td>
<td>3.2.x</td>
</tr>
<tr>
<td>Tomcat 线程池</td>
<td>默认 200</td>
<td>虚拟线程（无上限）</td>
</tr>
<tr>
<td>接口耗时</td>
<td>sleep(200ms)</td>
<td>sleep(200ms)</td>
</tr>
<tr>
<td>总请求数</td>
<td>3000</td>
<td>3000</td>
</tr>
<tr>
<td>并发数</td>
<td>250</td>
<td>250</td>
</tr>
</tbody>
</table>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 平台线程模式（spring.threads.virtual.enabled=false 或不设置）</span><br></span><br><span class="line">ab -n 3000 -c 250 http://localhost:8080/api/hello</span><br><span class="line"></span><br><span class="line"><span class="comment"># 虚拟线程模式（spring.threads.virtual.enabled=true）</span><br></span><br><span class="line">ab -n 3000 -c 250 http://localhost:8080/api/hello<br></span></td></tr></table></figure>

<h2 id="压测结果汇总多源数据"><a href="#压测结果汇总多源数据" class="headerlink" title="压测结果汇总（多源数据）"></a>压测结果汇总（多源数据）</h2>

<p>以下数据综合了得物技术团队、Bell-Sw、Soham Kamani 以及 CSDN 的公开压测结果，均采用类似的 I/O 阻塞场景（sleep/模拟下游 RPC 100~300ms）：</p>

<table>
<thead>
<tr>
<th>指标</th>
<th>平台线程（Tomcat 200）</th>
<th>平台线程（Tomcat 500）</th>
<th>虚拟线程</th>
<th>提升倍数</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS（吞吐）</strong></td>
<td>~388 req/s</td>
<td>~900 req/s</td>
<td>~1800~2200 req/s</td>
<td><strong>2x~5x</strong></td>
</tr>
<tr>
<td><strong>平均响应时间</strong></td>
<td>500~600ms</td>
<td>~250ms</td>
<td>~200ms</td>
<td>接近理论值</td>
</tr>
<tr>
<td><strong>P95 延迟</strong></td>
<td>800~1200ms</td>
<td>400~600ms</td>
<td>200~210ms</td>
<td><strong>4x~5x</strong></td>
</tr>
<tr>
<td><strong>P99 延迟</strong></td>
<td>1500ms+</td>
<td>800ms+</td>
<td>205~210ms</td>
<td><strong>7x+</strong></td>
</tr>
<tr>
<td><strong>总耗时（3000 req）</strong></td>
<td>~50s</td>
<td>~15s</td>
<td>~7~8s</td>
<td>~6x</td>
</tr>
</tbody>
</table>

<p>数据来源说明：</p>
<ul>
<li>得物技术团队的测试（默认 200 线程池）：QPS 388 req/s，RT 接近 500ms（等于 sleep 时间 × 线程池排队因子）</li>
<li>Bell-Sw 测试（500 并发、1000 请求）：虚拟线程约 <strong>2 倍</strong>于 500 线程的平台线程吞吐</li>
<li>Soham Kamani 测试（3000 req / 250 并发 / 200ms sleep）：虚拟线程总耗时 <strong>26.4s</strong> vs 平台线程 <strong>50s+</strong>，P99 仅 2055ms vs 严重抖动</li>
<li>CSDN 综合测试：引入虚拟线程后吞吐提升超 <strong>320%</strong></li>
</ul>

<h2 id="如何验证结论"><a href="#如何验证结论" class="headerlink" title="如何验证结论？"></a>如何验证结论？</h2>

<p>你可以自己复现这套实验：</p>

<ol>
<li>
<p><strong>搭建项目</strong>：用 <a href="https://start.spring.io/" target="_blank">Spring Initializr</a> 创建 Spring Boot 3.2+ 项目，选 JDK 21</p>
</li>
<li>
<p><strong>加入上面的 DemoController</strong>（sleep 200ms）</p>
</li>
<li>
<p><strong>分别用两种配置启动</strong>：
  <ul>
<li>A：不加 <code>spring.threads.virtual.enabled</code>（默认平台线程）</li>
<li>B：加 <code>spring.threads.virtual.enabled=true</code></li>
</ul>
</li>
<li>
<p><strong>用 ab 压测并记录结果</strong>：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">ab -n 3000 -c 250 http://localhost:8080/api/hello 2>&amp;1 | tee ab_result_<span class="variable">${mode}</span>.txt<br></span></td></tr></table></figure>
</li>
<li>
<p><strong>重点看三个指标</strong>：Requests per second（QPS）、95%/99% 百分位延迟、Time taken for tests</p>
</li>
<li>
<p><strong>观察线程名</strong>：返回值中的线程名可以确认是否真的走了虚拟线程</p>
</li>
</ol>

<h1 id="常见坑与误区-生产落地前必读"><a href="#常见坑与误区-生产落地前必读" class="headerlink" title="常见坑与误区：生产落地前必读"></a>常见坑与误区：生产落地前必读</h1>

<h2 id="坑-1-synchronized-不会释放载体线程"><a href="#坑-1-synchronized-不会释放载体线程" class="headerlink" title="坑 1：synchronized 不会释放载体线程"></a>坑 1：<code>synchronized</code> 不会释放载体线程</h2>

<p>这是当前虚拟线程<strong>最大的兼容性问题</strong>。当一个虚拟线程进入 <code>synchronized</code> 块时，<strong>不会被卸载</strong>——它会一直占用载体线程，直到退出同步块。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 危险！synchronized 会 pin 住载体线程</span><br></span><br><span class="line"><span class="keyword">synchronized</span> (lockObj) {</span><br><span class="line">    Thread.<span class="built_in">sleep</span>(<span class="number">1000</span>); <span class="comment">// 这 1 秒内载体线程被白白占用！</span><br></span><br><span class="line">}</span><br></td></tr></table></figure>

<p><strong>解决方案</strong>：改用 <code>ReentrantLock</code>（它在虚拟线程中能正确触发出卸载）：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ✅ 推荐：ReentrantLock 支持卸载</span><br></span><br><span class="keyword">private static final</span> ReentrantLock lock = <span class="keyword">new</span> <span class="title class_">ReentrantLock</span>();</span><br><span class="line">lock.lock();</span><br><span class="line"><span class="keyword">try</span> {</span><br><span class="line">    Thread.<span class="built_in">sleep</span>(<span class="number">1000</span>); <span class="comment">// 虚拟线程会被卸载，载体线程释放</span><br></span><span class="line">} <span class="keyword">finally</span> { lock.unlock(); }<br></span></td></tr></table></figure>

<h2 id="坑-2-瓶颈转移连接池成为新短板"><a href="#坑-2-瓶颈转移连接池成为新短板" class="headerlink" title="坑 2：瓶颈转移——连接池成为新短板"></a>坑 2：瓶颈转移——连接池成为新短板</h2>

<p>用了虚拟线程之后，线程不再是瓶颈了。但<strong>数据库连接池、HTTP 连接池、Redis 连接</strong>这些有限资源会立刻暴露出来。</p>

<p>典型现象：开了虚拟线程后 QPS 没涨，反而出现大量连接池等待超时。</p>

<p><strong>应对策略</strong>：</p>
<ul>
<li>检查并适当调大 <code>HikariCP.maximumPoolSize</code>（但别超过数据库最大连接数）</li>
<li>监控连接池活跃数、等待队列长度</li>
<li>考虑用 <strong>虚拟线程并行查询</strong>优化串行依赖：</li>
</ul>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ✅ 利用虚拟线程并行化多个独立查询</span><br></span><br><span class="keyword">public</span> UserSummary <span class="title function_">loadUserSummary</span><span class="params">(Long userId)</span> {</span><br><span class="line">    <span class="keyword">var</span> posts = Thread.startVirtualThread(() -&gt; postRepo.findByUser(userId));</span><br><span class="line">    <span class="keyword">var</span> orders = Thread.startVirtualThread(() -&gt; orderRepo.findByUser(userId));</span><br><span class="line">    <span class="keyword">var</span> profile = Thread.startVirtualThread(() -&gt; userRepo.findProfile(userId));</span><br><span class="line"></span><br><span class="line">    <span class="keyword">return new</span> <span class="title class_">UserSummary</span>(posts.join(), orders.join(), profile.join());</span><br><span class="line">    <span class="comment">// 三个查询并行执行，总耗时 ≈ max(单个耗时) 而非三者之和</span><br></span><br><span class="line">}<br></span></td></tr></table></figure>

<h2 id="坑-3-cpu-密集型任务不会更快"><a href="#坑-3-cpu-密集型任务不会更快" class="headerlink" title="坑 3：CPU 密集型任务不会更快"></a>坑 3：CPU 密集型任务不会更快</h2>

<p>虚拟线程解决的是<strong>等待</strong>问题，不是<strong>计算</strong>问题。如果你的服务是 CPU 密集型的（图像处理、加密解密、复杂计算），虚拟线程不会带来加速，甚至因为调度开销略慢于平台线程。</p>

<p><strong>判断标准</strong>：如果线程大部分时间在 <code>sleep()</code>、等 I/O、等锁 → 虚拟线程有帮助；如果在疯狂做运算 → 虚拟线程没优势。</p>

<h2 id="坑-4-threadlocal-内存膨胀风险"><a href="#坑-4-threadlocal-内存膨胀风险" class="headerlink" title="坑 4：ThreadLocal 内存膨胀风险"></a>坑 4：ThreadLocal 内存膨胀风险</h2>

<p>以前 ThreadLocal 数量 = 平台线程数（几百个）。现在 ThreadLocal 数量 = 虚拟线程数（可能几十万个）。如果你在每个线程的 ThreadLocal 里放了个大的对象（比如缓存、解析器实例），内存会爆炸。</p>

<p><strong>解决方案</strong>：</p>
<ul>
<li>审查 ThreadLocal 使用，尽量替换为<strong>请求作用域</strong>的对象传递</li>
<li>JDK 21+ 提供了 <code>ScopedValue</code>（预览特性）作为 ThreadLocal 的替代方案</li>
<li>如果必须用 ThreadLocal，确保存储的对象很小，并在用完后 <code>remove()</code></li>
</ul>

<h2 id="坑-5-jstack-看到的线程信息不同"><a href="#坑-5-jstack-看到的线程信息不同" class="headerlink" title="坑 5：jstack 看到的线程信息不同"></a>坑 5：<code>jstack</code> 看到的线程信息不同</h2>

<p>用 <code>jstack</code> 查看线程 dump 时，虚拟线程显示为 <code>VirtualThread[#xxx]</code> 格式，而且默认情况下 <strong>不会展示全部虚拟线程</strong>（因为可能有几十万个）。建议用以下方式获取虚拟线程信息：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># jcmd 可以查看虚拟线程统计</span><br></span><br><span class="line">jcmd &lt;PID&gt; Thread.vthread_summary</span><br><span class="line">jcmd &lt;PID&gt; VM.info<br></span></td></tr></table></figure>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>我们回顾一下全文的关键要点：</p>

<ul>
<li><strong>虚拟线程是什么</strong>：JVM 层面的轻量级线程，M:N 调度到平台线程上，阻塞时自动卸载</li>
<li><strong>怎么用</strong>：Spring Boot 3.2+ 只需 <code>spring.threads.virtual.enabled=true</code> 一行配置</li>
<li><strong>效果如何</strong>：I/O 密集场景下 QPS 提升 2~5 倍，P99 延迟降低 5~7 倍（来自多源压测数据）</li>
<li><strong>适用场景</strong>：大量 I/O 阻塞的 Web 服务、微服务网关、RPC 客户端</li>
<li><strong>不适用场景</strong>：CPU 密集计算、已经全链路异步的系统（WebFlux/Netty）</li>
<li><strong>生产注意事项</strong>：
  <ol>
    <li>避免 <code>synchronized</code>，改用 <code>ReentrantLock</code></li>
    <li>关注连接池容量（DB/HTTP/Redis）</li>
    <li>警惕 ThreadLocal 内存膨胀</li>
    <li>CPU 密集任务不要指望虚拟线程加速</li>
  </ol>
</li>
</ul>

<p>虚拟线程不是银弹，但它确实让 Java 在高并发 I/O 场景下重新拥有了竞争力——不用放弃熟悉的"一请求一线程"编程模型，就能获得接近 Reactor 模式的吞吐能力。对于大多数 Spring MVC 项目来说，这可能是 JDK 21 最值得升级的理由之一。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[JavaGuide] 《虚拟线程常见问题总结》 — https://javaguide.cn/java/concurrent/virtual-thread.html （中文，全面且权威）</li>
<li>[得物技术] 《虚拟线程原理及性能分析》 — https://tech.dewu.com/article?id=89 （中文，含 Tomcat 线程池/WebFlux/虚拟线程三方对比压测）</li>
<li>[XCloudAPI] 《JDK21 虚拟线程原理及实践》 — https://blog.xcloudapi.com/p/jdk21%E8%99%9A%E6%8B%9F%E7%BA%BF%E7%A8%8B%E5%8E%9F%E7%90%86%E5%8F%8A%E5%AE%9E%E8%B7%B5 （中文，含 K6 压测 + JMH 基准测试）</li>
<li>[Soham Kamani] 《What are Virtual Threads? (And How to Use Them in Spring Boot)》 — https://www.sohamkamani.com/java/virtual-threads-spring-boot （外文，含完整 ab 压测过程与结果输出）</li>
<li>[Bell-Sw] 《A Guide to Using Virtual Threads with Spring Boot》 — https://bell-sw.com/blog/a-guide-to-using-virtual-threads-with-spring-boot （外文，Spring Boot 3.2 + JMH benchmark）</li>
<li>[OpenJDK] JEP 444: Virtual Threads — https://openjdk.org/jeps/444 （官方规范文档）</li>
<li>[拿个offer] 《虚拟线程能取代动态线程池吗？》 — https://nageoffer.com/onethread/virtual-threads-vs-threadpools （中文，虚拟线程 vs Hippo4j 动态线程池对比）</li>
</ol>
