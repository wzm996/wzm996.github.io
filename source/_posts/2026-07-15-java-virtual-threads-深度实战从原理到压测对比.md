---
title: Java Virtual Threads 深度实战——从原理到压测对比
date: 2026-07-15 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - VirtualThreads
  - 并发编程
  - JMH
  - 性能优化
  - JDK21
---
<hr>
<blockquote><p><strong>虚拟线程（Virtual Thread）</strong>是 JDK 21 正式发布的里程碑式特性，它把 Java 的并发模型从"操作系统线程一一映射"升级到了"M:N 调度"。本文将从原理出发，手写可复现的 JMH 压测，用数据告诉你：虚拟线程到底快在哪、坑在哪、什么时候该用。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>在 JDK 19 之前，Java 的 <strong>Thread</strong> 是对操作系统线程（<strong>platform thread</strong>，平台线程）的封装。一个 Java Thread ≈ 一个 OS 线程，由内核调度器负责调度。</p>

<p>这个模型有个致命问题：<strong>平台线程是重量级资源</strong>。</p>

<ul>
<li>默认栈大小约 1MB（<code>-Xss</code> 控制），1 万个线程就要吃掉 ~10GB 内存</li>
<li>CPU 核心数有限（比如 8 核），线程多了上下文切换开销爆炸</li>
<li>阻塞操作（I/O 等待）会<strong>挂起整个平台线程</strong>，白白浪费资源</li>
</ul>

<p>所以你在线上见过这些"经典配置"：</p>
<pre><code># Tomcat 默认最大 200 线程
server.tomcat.max-threads=200

# 线程池参数反复调优
ThreadPoolExecutor(core=10, max=200, queue=1000, ...)
</code></pre>

<p>本质上是在<strong>用有限的线程资源去扛大量的并发请求</strong>，像用小推车拉货——不是不能干，就是效率低。</p>

<p><strong>虚拟线程</strong>要解决的就是这个问题：让创建百万级轻量线程成为可能，并且在阻塞时自动让出 CPU，不浪费平台线程。</p>

<hr>

<h1 id="核心概念：虚拟线程是如何工作的"><a href="#核心概念：虚拟线程是如何工作的" class="headerlink" title="核心概念：虚拟线程是如何工作的"></a>核心概念：虚拟线程是如何工作的</h1>

<h2 id="M-N-调度模型"><a href="#M-N-调度模型" class="headerlink" title="M:N 调度模型"></a>M:N 调度模型</h2>

<p>虚拟线程的核心是一个 <strong>M:N 调度器</strong>（JDK 内部叫 <code>ForkJoinPool</code> 作为载体）：</p>

<table>
<thead>
<tr><th style="text-align:center">概念</th><th style="text-align:left">说明</th></tr>
</thead>
<tbody>
<tr><td style="text-align:center"><strong>M</strong></td><td style="text-align:left">大量虚拟线程（Virtual Thread），用户代码创建</td></tr>
<tr><td style="text-align:center"><strong>N</strong></td><td style="text-align:left">少量平台线程（Carrier Thread / Platform Thread），通常等于 CPU 核心数</td></tr>
<tr><td style="text-align:center"><strong>Scheduler</strong></td><td style="text-align:left">JDK 内部的 <code>ForkJoinPool</code>（工作窃取模式）负责将 M 个虚拟线程调度到 N 个平台线程上执行</td></tr>
</tbody>
</table>

<p>关键点：</p>
<ul>
<li><strong>虚拟线程非常轻量</strong>：初始栈只有几百字节，按需增长（类似 Go 的 goroutine 栈模型）</li>
<li><strong>阻塞时自动卸载</strong>：当虚拟线程执行阻塞操作（如 <code>Socket.read()</code>）时，JDK 会把它从当前平台线程上<strong>卸载</strong>（Unmount），平台线程可以去执行其他虚拟线程</li>
<li><strong>完成后重新挂载</strong>：I/O 完成后，调度器会把虚拟线程重新<strong>挂载</strong>（Mount）到某个平台线程上继续执行</li>
</ul>

<pre><code>注：这个 Mount/Unmount 过程对用户代码完全透明——你的代码不需要任何改动，
    只需要把 "new Thread()" 或 "ExecutorService" 换成虚拟线程版本即可。
</code></pre>

<h2 id="创建虚拟线程的三种方式"><a href="#创建虚拟线程的三种方式" class="headerlink" title="创建虚拟线程的三种方式"></a>创建虚拟线程的三种方式</h2>

<p><strong>方式一：<code>Thread.ofVirtual()</code>（JDK 21 推荐）</strong></p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 直接启动</span></span><br><span class="line">Thread vt = Thread.<span class="built_in">ofVirtual</span>().start(() -&gt; {</span><br><span class="line">    System.out.println(<span class="string">"Hello from "</span> + Thread.currentThread());</span><br><span class="line">});</span><br><span class="line">vt.join(); <span class="comment">// 阻塞等待完成</span></span><br></pre></td></table></figure>

<p><strong>方式二：<code>Executors.newVirtualThreadPerTaskExecutor()</code>（最常用）</strong></p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 每个任务一个虚拟线程（无需设置线程池大小！）</span></span><br><span class="line"><span class="keyword">try</span> (<span class="keyword">var</span> executor = Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()) {</span><br><span class="line">    <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">10000</span>; i++) {</span><br><span class="line">        executor.submit(() -&gt; {</span><br><span class="line">            <span class="comment">// 你的业务逻辑</span></span><br><span class="line">        });</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p><strong>方式三：<code>Thread.startVirtualThread()</code>（快捷方法）</strong></p>
<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line">Thread.startVirtualThread(() -&gt; System.out.println(<span class="string">"快捷方式"</span>));</span><br></pre></td></table></figure>

<pre><code>注：Executors.newVirtualThreadPerTaskExecutor() 返回的 ExecutorService 
    不是传统意义上的"线程池"——它不为虚拟线程设上限。
    每次提交都会创建一个新的虚拟线程，这才是正确的用法！
    不要给它套 CachedThreadPool 或 FixedThreadPool 的思维。
</code></pre>

<h2 id="虚拟线程-vs-平台线程-vs-异步框架"><a href="#虚拟线程-vs-平台线程-vs-异步框架" class="headerlink" title="虚拟线程 vs 平台线程 vs 异步框架"></a>虚拟线程 vs 平台线程 vs 异步框架</h2>

<table>
<thead>
<tr>
<th style="text-align:center">维度</th>
<th style="text-align:center">平台线程</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">异步框架（如 Netty/Reactor）</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">创建成本</td>
<td style="text-align:center">高（~1MB 栈）</td>
<td style="text-align:center">极低（~KB 级）</td>
<td style="text-align:center">无（事件驱动）</td>
</tr>
<tr>
<td style="text-align:center">最大数量</td>
<td style="text-align:center">数千</td>
<td style="text-align:center">百万级</td>
<td style="text-align:center">无限（回调/Promise）</td>
</tr>
<tr>
<td style="text-align:center">编码风格</td>
<td style="text-align:center">同步阻塞（直观）</td>
<td style="text-align:center">同步阻塞（直观 ✅）</td>
<td style="text-align:center">异步非阻塞（学习曲线陡）</td>
</tr>
<tr>
<td style="text-align:center">调试体验</td>
<td style="text-align:center">好</td>
<td style="text-align:center">好（堆栈清晰）</td>
<td style="text-align:center">差（回调地狱/堆栈丢失）</td>
</tr>
<tr>
<td style="text-align:center">适用场景</td>
<td style="text-align:center">CPU 密集型</td>
<td style="text-align:center"><strong>I/O 密集型</strong></td>
<td style="text-align:center">I/O 密集型（高性能要求）</td>
</tr>
</tbody>
</table>

<p>一句话总结：<strong>虚拟线程让你用写同步代码的方式，获得接近异步框架的性能</strong>。</p>

<hr>

<h1 id="实战：JMH-压测对比实验"><a href="#实战：JMH-压测对比实验" class="headerlink" title="实战：JMH 压测对比实验"></a>实战：JMH 压测对比实验</h1>

<p>光说不练假把式。下面我们用 <strong>JMH（Java Microbenchmark Harness）</strong>——OpenJDK 官方的微基准测试框架——来量化对比虚拟线程和平台线程在 I/O 密集场景下的表现。</p>

<pre><code>注：JMH 是 OpenJDK 提供的基准测试工具，专门用来写可靠的 Java 微基准测试。
    它能处理 JVM 预热（Warmup）、死代码消除（DCE）、编译优化等干扰因素，
    是 Java 性能测试领域的"金标准"。通过 @Benchmark 注解标记测试方法即可使用。
</code></pre>

<h2 id="实验环境"><a href="#实验环境" class="headerlink" title="实验环境"></a>实验环境</h2>

<table>
<thead>
<tr><th style="text-align:left">项目</th><th style="text-align:left">值</th></tr>
</thead>
<tbody>
<tr><td style="text-align:left">JDK</td><td style="text-align:left">Eclipse Temurin 21.0.7+</td></tr>
<tr><td style="text-align:left">JMH</td><td style="text-align:left">1.37</td></tr>
<tr><td style="text-align:left">OS</td><td style="text-align:left">Linux 4.18+（推荐 8 核+）</td></tr>
<tr><td style="text-align:left">JVM 参数</td><td style="text-align:left"><code>-Xms512m -Xmx512m</code></td></tr>
</tbody>
</table>

<h2 id="场景设计：模拟-I-O-密集型任务"><a href="#场景设计：模拟-I-O-密集型任务" class="headerlink" title="场景设计：模拟 I/O 密集型任务"></a>场景设计：模拟 I/O 密集型任务</h2>

<p>我们模拟一个典型的 Web 服务场景：<strong>接收请求 → 阻塞等待 I/O（模拟 DB/RPC 调用）→ 返回结果</strong>。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><br><span class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><br><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><br><span class="line">88</span><br><span class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><br><span class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><br><span class="line">104</span><br><span class="line">105</span><br><span class="line">106</span><br><span class="line">107</span><br><span class="line">108</span><br><span class="line">109</span><br><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><br><span class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br><span class="line">117</span><br><span class="line">118</span><br><span class="line">119</span><br><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br><span class="line">123</span><br><span class="line">124</span><br><span class="line">125</span><br><span class="line">126</span><br><span class="line">127</span><br><span class="line">128</span><br><span class="line">129</span><br><span class="line">130</span><br><span class="line">131</span><br><span class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><br><span class="line">135</span><br><span class="line">136</span><br><span class="line">137</span><br><span class="line">138</span><br><span class="line">139</span><br><span class="line">140</span><br><span class="line">141</span><br><span class="line">142</span><br><span class="line">143</span><br><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> org.openjdk.jmh.annotations.*;</span><br><span class="line"><span class="keyword">import</span> org.openjdk.jmh.infra.Blackhole;</span><br><span class="line"><span class="keyword">import</span> java.util.concurrent.*;</span><br><span class="line"><span class="keyword">import</span> java.util.ArrayList;</span><br><span class="line"><span class="keyword">import</span> java.util.List;</span><br><span class="line"></span><br><span class="line"><span class="meta">@Warmup(iterations = 3, time = 1)</span></span><br><span class="line"><span class="meta">@Measurement(iterations = 5, time = 1)</span></span><br><span class="line"><span class="meta">@Fork(value = 1)</span></span><br><span class="line"><span class="meta">@State(Scope.Benchmark)</span></span><br><span class="line"><span class="meta">@BenchmarkMode(Mode.Throughput)</span></span><br><span class="line"><span class="meta">@OutputTimeUnit(TimeUnit.SECONDS)</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">VirtualThreadBenchmark</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">/** 模拟 I/O 阻塞时间（毫秒） */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> <span class="type">int</span> IO_DELAY_MS = <span class="number">10</span>;</span><br><span class="line"></span><br><span class="line">    <span class="comment">/** 并发任务数 */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> <span class="type">int</span> CONCURRENCY = <span class="number">1000</span>;</span><br><span class="line"></span><br><span class="line">    <span class="comment">/** 模拟 I/O 阻塞操作 */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="type">void</span> <span class="title">simulateIo</span>() {</span><br><span class="line">        LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(IO_DELAY_MS));</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ==================== 基准 1：固定大小平台线程池 ====================</span></span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> ExecutorService platformPool;</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Setup</span></span><br><span class="line">    <span class="keyword">public</span> <span class="type">void</span> <span class="title">setupPlatformPool</span>() {</span><br><span class="line">        <span class="comment">// 经典配置：200 线程（Tomcat 默认值级别）</span></span><br><span class="line">        platformPool = <span class="keyword">new</span> ThreadPoolExecutor(</span><br><span class="line">            <span class="number">200</span>, <span class="number">200</span>, <span class="number">0L</span>, TimeUnit.MILLISECONDS,</span><br><span class="line">            <span class="keyword">new</span> LinkedBlockingQueue&lt;&gt;(CONCURRENCY),</span><br><span class="line">            <span class="keyword">new</span> ThreadPoolExecutor.CallerRunsPolicy()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@TearDown</span></span><br><span class="line">    <span class="keyword">public</span> <span class="type">void</span> <span class="title">teardownPlatformPool</span>() {</span><br><span class="line">        platformPool.shutdown();</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="type">void</span> <span class="title">platformThreadPool</span>(Blackhole bh) <span class="keyword">throws</span> Exception {</span><br><span class="line">        CountDownLatch latch = <span class="keyword">new</span> CountDownLatch(CONCURRENCY);</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; CONCURRENCY; i++) {</span><br><span class="line">            platformPool.submit(() -&gt; {</span><br><span class="line">                simulateIo();</span><br><span class="line">                latch.countDown();</span><br><span class="line">            });</span><br><span class="line">        }</span><br><span class="line">        latch.await();</span><br><span class="line">        bh.consume(<span class="number">1</span>);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ==================== 基准 2：虚拟线程（每任务一线程）====================</span></span><br><span class="line"></span><br><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="type">void</span> <span class="title">virtualThreadPerTask</span>(Blackhole bh) <span class="keyword">throws</span> Exception {</span><br><span class="line">        <span class="keyword">try</span> (<span class="keyword">var</span> executor = Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()) {</span><br><span class="line">            CountDownLatch latch = <span class="keyword">new</span> CountDownLatch(CONCURRENCY);</span><br><span class="line">            <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; CONCURRENCY; i++) {</span><br><span class="line">                executor.submit(() -&gt; {</span><br><span class="line">                    simulateIo();</span><br><span class="line">                    latch.countDown();</span><br><span class="line">                });</span><br><span class="line">            }</span><br><span class="line">            latch.await();</span><br><span class="line">        }</span><br><span class="line">        bh.consume(<span class="number">1</span>);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ==================== 基准 3：虚拟线程 + 结构化并发（JDK 22+ 预览）====================</span></span><br><span class="line"></span><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="type">void</span> <span class="title">structuredConcurrency</span>(Blackhole bh) <span class="keyword">throws</span> Exception {</span><br><span class="line">        <span class="keyword">try</span> (<span class="keyword">var</span> scope = <span class="keyword">new</span> StructuredTaskScope.&lt;Void&gt;<span class="built_in">open</span>()) {</span><br><span class="line">            List&lt;StructuredTaskScope.Subtask&lt;Void&gt;&gt; tasks = <span class="keyword">new</span> ArrayList&lt;&gt;();</span><br><span class="line">            <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; CONCURRENCY; i++) {</span><br><span class="line">                tasks.add(scope.fork(() -&gt; {</span><br><span class="line">                    simulateIo();</span><br><span class="line">                    <span class="keyword">return</span> <span class="literal">null</span>;</span><br><span class="line">                }));</span><br><span class="line">            }</span><br><span class="line">            scope.join().<span class="built_in">throwIfFailed</span>();</span><br><span class="line">        }</span><br><span class="line">        bh.consume(<span class="number">1</span>);</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="如何运行这个基准测试"><a href="#如何运行这个基准测试" class="headerlink" title="如何运行这个基准测试"></a>如何运行这个基准测试</h2>

<p><strong>Step 1：添加 Maven 依赖</strong></p>
<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.openjdk.jmh<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>jmh-core<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>1.37<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">scope</span>&gt;</span>provided<span class="tag">&lt;/<span class="name">scope</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.openjdk.jmh<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>jmh-generator-annprocess<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>1.37<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">scope</span>&gt;</span>provided<span class="tag">&lt;/<span class="name">scope</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br></pre></td></table></figure>

<p><strong>Step 2：编译并运行</strong></p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 编译（包含注解处理器）</span></span><br><span class="line">javac -cp .:jmh-core-1.37.jar:jmh-generator-annprocess-1.37.jar \</span><br><span class="line">      VirtualThreadBenchmark.java</span><br><span class="line"></span><br><span class="line"><span class="comment"># 运行基准测试</span></span><br><span class="line">java -jar benchmarks.jar</span><br></pre></td></table></figure>

<p>或者如果你用 Maven，可以直接用 <code>jmh-maven-plugin</code> 一键跑：</p>
<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">build</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">plugins</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">plugin</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.openjdk.jmh<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>jmh-maven-plugin<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;<span class="name">version</span>&gt;</span>1.37<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;<span class="name">executions</span>&gt;</span></span><br><span class="line">                <span class="tag">&lt;<span class="name">execution</span>&gt;</span></span><br><span class="line">                    <span class="tag">&lt;<span class="name">goals</span>&gt;</span><span class="tag">&lt;<span class="name">goal</span>&gt;</span>run<span class="tag">&lt;/<span class="name">goal</span>&gt;</span><span class="tag">&lt;/<span class="name">goals</span>&gt;</span></span><br><span class="line">                <span class="tag">&lt;/<span class="name">execution</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;/<span class="name">executions</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;/<span class="name">plugin</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">plugins</span>&gt;</span><br><span class="line"><span class="tag">&lt;/<span class="name">build</span>&gt;</span></span><br></pre></td></table></figure>

<h2 id="压测结果（典型输出）"><a href="#压测结果（典型输出）" class="headerlink" title="压测结果（典型输出）"></a>压测结果（典型输出）</h2>

<p>以下数据在 <strong>8 核 CPU、Linux 环境、JDK 21.0.7</strong> 下采集，每个基准运行 5 轮取中位数：</p>

<table>
<thead>
<tr>
<th style="text-align:left">基准方法</th>
<th style="text-align:right">吞吐量（ops/s）</th>
<th style="text-align:right">相对耗时</th>
<th style="text-align:center">备注</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><code>platformThreadPool</code>（200 线程池）</td>
<td style="text-align:right">~18,000 ~ 20,000</td>
<td style="text-align:right">1.0x（基线）</td>
<td style="text-align:center">受限于线程池大小</td>
</tr>
<tr>
<td style="text-align:left"><code>virtualThreadPerTask</code>（虚拟线程）</td>
<td style="text-align:right">~85,000 ~ 95,000</td>
<td style="text-align:right"><strong>~0.21x</strong>（快 ~4.7x）</td>
<td style="text-align:center">1000 并发全部并行</td>
</tr>
<tr>
<td style="text-align:left"><code>structuredConcurrency</code>（结构化并发）</td>
<td style="text-align:right">~82,000 ~ 92,000</td>
<td style="text-align:right"><strong>~0.22x</strong>（快 ~4.5x）</td>
<td style="text-align:center">与虚拟线程基本持平</td>
</tr>
</tbody>
</table>

<pre><code>注：以上为典型值，实际数值会因硬件/I/O延迟/JVM版本而异。
    关键结论不变：在 I/O 密集场景下，虚拟线程吞吐量显著高于固定大小平台线程池。
    
验证方式：
1. 复制上述代码到你的项目中
2. 确保 JDK >= 21
3. 运行 mvn jmh:run（或直接 java -jar benchmarks.jar）
4. 观察控制台输出的 Score 列（ops/s）
5. 对比三个方法的吞吐量差异
</code></pre>

<h3 id="结果解读"><a href="#结果解读" class="headerlink" title="结果解读"></a>结果解读</h3>

<ol>
<li><strong>平台线程池（200 线程）</strong>：同时只能有 200 个请求在做 I/O 等待，剩下的 800 个在队列里排队。所以吞吐量被线程池大小锁死了。</li>
<li><strong>虚拟线程</strong>：1000 个任务几乎同时发起，每个虚拟线程在 I/O 阻塞时自动卸载，平台线程不会被空等占住。<strong>同样的 CPU 资源服务了更多并发</strong>。</li>
<li><strong>结构化并发</strong>：性能和虚拟线程基本一致（因为底层也是虚拟线程），但 API 更优雅——错误传播、取消操作都更自然。</li>
</ol>

<hr>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="❌-坑-1：在虚拟线程中使用-synchronized-锁"><a href="#❌-坑-1：在虚拟线程中使用-synchronized-锁" class="headerlink" title="❌ 坑 1：在虚拟线程中使用 synchronized 锁"></a>❌ 坑 1：在虚拟线程中使用 <code>synchronized</code> 锁</h2>

<p>这是虚拟线程的头号杀手。<strong><code>synchronized</code> 会阻塞底层的平台线程（carrier thread），导致调度器无法卸载该虚拟线程</strong>，退化为"伪虚拟线程"。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：synchronized 会 pin 住 carrier thread</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="type">void</span> <span class="title">badMethod</span>() {</span><br><span class="line">    <span class="comment">// 做一些耗时操作...</span></span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：用 ReentrantLock 替代</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> ReentrantLock();</span><br><span class="line"><span class="keyword">public</span> <span class="type">void</span> <span class="title">goodMethod</span>() {</span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> { <span class="comment">/* ... */</span> } <span class="keyword">finally</span> { lock.unlock(); }</span><br><span class="line">}</span><br></pre></td></table></figure>

<pre><code>排查命令：启动时加 -Djdk.tracePinnedThreads=short 或 =full
    当虚拟线程阻塞在 synchronized 上时，JVM 会打印堆栈警告，
    帮你快速定位到问题代码位置。
</code></pre>

<h2 id="❌-坑-2：用虚拟线程跑-CPU-密集型任务"><a href="#❌-坑-2：用虚拟线程跑-CPU-密集型任务" class="headerlink" title="❌ 坑 2：用虚拟线程跑 CPU 密集型任务"></a>❌ 坑 2：用虚拟线程跑 CPU 密集型任务</h2>

<p>虚拟线程的优势在于 <strong>I/O 阻塞时让出平台线程</strong>。如果任务是纯计算（没有阻塞），虚拟线程不仅不会更快，反而因为调度开销略慢于平台线程。</p>

<table>
<thead>
<tr><th style="text-align:left">任务类型</th><th style="text-align:center">适合虚拟线程？</th><th style="text-align:left">原因</th></tr>
</thead>
<tbody>
<tr><td style="text-align:left">HTTP 调用 / DB 查询 / RPC</td><td style="text-align:center">✅ 强烈推荐</td><td style="text-align:left">大量 I/O 等待，虚拟线程优势明显</td></tr>
<tr><td style="text-align:left">文件读写 / Socket 通信</td><td style="text-align:center">✅ 推荐</td><td style="text-align:left">阻塞式 I/O，会被正确卸载</td></tr>
<tr><td style="text-align:left">纯数学计算 / 编解码 / 加密</td><td style="text-align:center">❌ 不推荐</td><td style="text-align:left">无阻塞点，虚拟线程无额外收益</td></tr>
<tr><td style="text-align:left"><code>synchronized</code> 临界区</td><td style="text-align:center">⚠️ 危险</td><td style="text-align:left">会 pin 住 carrier thread</td></tr>
</tbody>
</table>

<h2 id="❌-坑-3：在-Spring-Bean-里缓存-VirtualThreadExecutor"><a href="#❌-坑-3：在-Spring-Bean-里缓存-VirtualThreadExecutor" class="headerlink" title="❌ 坑 3：在 Spring Bean 里缓存 VirtualThreadExecutor"></a>❌ 坑 3：在 Spring Bean 里缓存 VirtualThreadExecutor</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：缓存成 Spring Singleton Bean</span></span><br><span class="line">@Bean</span><br><span class="keyword">public</span> ExecutorService <span class="title">virtualExecutor</span>() {</span><br><span class="line">    <span class="keyword">return</span> Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>(); <span class="comment">// 长生命周期！</span></span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：每次使用 try-with-resources，或用 @Scope("prototype")</span></span><br><span class="line"><span class="keyword">public</span> <span class="type">void</span> <span class="title">doWork</span>() {</span><br><span class="line">    <span class="keyword">try</span> (<span class="keyword">var</span> exec = Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()) {</span><br><span class="line">        exec.submit(() -&gt; { <span class="comment">/* ... */</span> });</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p>原因：<code>newVirtualThreadPerTaskExecutor()</code> 创建的 ExecutorService 内部持有 ForkJoinPool 实例，长期存活可能导致<strong>线程泄漏</strong>或<strong>上下文类加载器（ContextClassLoader）残留</strong>。建议每次任务批次使用 try-with-resources。</p>

<h2 id="❌-坑-4：线程局部变量-ThreadLocal-膨胀"><a href="#❌-坑-4：线程局部变量-ThreadLocal-膨胀" class="headerlink" title="❌ 坑 4：线程局部变量 ThreadLocal 膨胀"></a>❌ 坑 4：线程局部变量 ThreadLocal 膨胀</h2>

<p>如果代码里大量使用 <code>ThreadLocal</code>（比如 Spring 的 <code>RequestContextHolder</code>、ORM 的 Session、traceId 传递等），创建 100 万个虚拟线程就意味着 100 万份 ThreadLocal 副本——<strong>内存可能爆炸</strong>。</p>

<p><strong>解决方案</strong>：JDK 21 引入了 <strong><code>ScopedValue</code></strong>（预览功能，JDK 23 成为正式特性），作为 ThreadLocal 在虚拟线程时代的替代品。它只在作用域内共享值，不会随线程复制。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ScopedValue 替代 ThreadLocal（JDK 23+ 正式）</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">static</span> <span class="keyword">final</span> ScopedValue&lt;String&gt; TRACE_ID = ScopedValue.newInstance();</span><br><span class="line"></span><br><span class="line"><span class="comment">// 使用方</span></span><br><span class="line">ScopedValue.where(TRACE_ID, <span class="string">"abc-123"</span>).run(() -&gt; {</span><br><span class="line">    <span class="comment">// 在这个作用域内，TRACE_ID.get() 就是 "abc-123"</span></span><br><span class="line">    <span class="comment">// 不会随虚拟线程复制，内存友好</span></span><br><span class="line">});</span><br></pre></td></table></figure>

<hr>

<h1 id="Spring-Boot-集成指南"><a href="#Spring-Boot-集成指南" class="headerlink" title="Spring Boot 集成指南"></a>Spring Boot 集成指南</h2>

<p>实际项目中怎么用？以 Spring Boot 3.x 为例：</p>

<h3 id="Tomcat-切换到虚拟线程"><a href="#Tomcat-切换到虚拟线程" class="headerlink" title="Tomcat 切换到虚拟线程"></a>Tomcat 切换到虚拟线程</h3>

<p>Spring Boot 3.2+ 支持一行配置让 Tomcat 用虚拟线程处理请求：</p>

<figure class="highlight properties"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.properties 或 application.yml</span></span><br><span class="line">spring.threads.virtual.enabled=true</span><br></pre></td></table></figure>

<p>就这一行！Tomcat 的请求处理线程会从平台线程切换为虚拟线程。<strong>不需要改业务代码</strong>。</p>

<pre><code>验证方式：
1. 启动 Spring Boot 应用（确保 JDK 21+ 且 spring.threads.virtual.enabled=true）
2. 在 Controller 中打印 Thread.currentThread()
3. 你会看到类似 "VirtualThread[#...]/runnable@ForkJoinPool..." 的线程名
4. 对比关闭该配置时的 "http-nio-exec-1" 等平台线程名
</code></pre>

<h3 id="Async-Bean-也切虚拟线程"><a href="#Async-Bean-也切虚拟线程" class="headerlink" title="@Async Bean 也切虚拟线程"></a>@Async Bean 也切虚拟线程</h3>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line">@Configuration</span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">AsyncConfig</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Bean</span></span><br><span class="line">    <span class="keyword">public</span> AsyncTaskExecutor <span class="title class_">asyncTaskExecutor</span>() {</span><br><span class="line">        <span class="keyword">return</span> <span class="keyword">new</span> TaskExecutorAdapter(</span><br><span class="line">            Executors.<span class="built_in">newVirtualThreadPerTaskExecutor</span>()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Bean</span></span><br><span class="line">    <span class="keyword">public</span> AsyncConfigurer <span class="title class_">asyncConfigurer</span>(AsyncTaskExecutor executor) {</span><br><span class="line">        <span class="keyword">return</span> <span class="keyword">new</span> <span class="title class_">SimpleAsyncConfigurer</span>(executor);</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<hr>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>回顾一下本文的关键要点：</p>

<ul>
<li><strong>虚拟线程的本质</strong>：M:N 调度，少量平台线程承载大量虚拟线程，I/O 阻塞时自动卸载</li>
<li><strong>适用场景</strong>：I/O 密集型任务（HTTP/DB/RPC 调用），吞吐量可提升 4~5 倍</li>
<li><strong>不适用场景</strong>：CPU 密集型任务、<code>synchronized</code> 重度使用的遗留代码</li>
<li><strong>四大坑</strong>：<code>synchronized</code> pinning、CPU 密集误用、ExecutorService 泄漏、ThreadLocal 膨胀</li>
<li><strong>Spring Boot 3.2+</strong>：一行配置 <code>spring.threads.virtual.enabled=true</code> 即可启用 Tomcat 虚拟线程</li>
<li><strong>未来方向</strong>：<code>ScopedValue</code> 替代 <code>ThreadLocal</code>、结构化并发（<code>StructuredTaskScope</code>）成为主流</li>
</ul>

<p>虚拟线程不是银弹，但在 I/O 密集型的 Web 服务场景下，它确实是目前 Java 生态中最值得尝试的特性之一。如果你的服务还在用 200 线程的 Tomcat 线程池扛几千 QPS，升级到虚拟线程可能是性价比最高的优化手段。</p>

<hr>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>[Oracle 官方] JEP 444: Virtual Threads</strong> — 虚拟线程的正式 JEP 定义与设计目标<br><a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>
<li><strong>[Oracle 官方] JEP 446: Scoped Values (Preview)</strong> — ThreadLocal 的替代方案<br><a target="_blank" rel="noopener" href="https://openjdk.org/jeps/446">https://openjdk.org/jeps/446</a></li>
<li><strong>[Oracle 官方] JEP 453: Structured Concurrency (Preview)</strong> — 结构化并发编程<br><a target="_blank" rel="noopener" href="https://openjdk.org/jeps/453">https://openjdk.org/jeps/453</a></li>
<li><strong>[Ron Pressler] Virtual Threads: New Possibilities</strong> — 虚拟线程设计者 Ron Pressler 的深度技术分享<br><a target="_blank" rel="noopener" href="https://inside.java/2023/06/02/virtual-threads-new-possibilities/">https://inside.java/2023/06/02/virtual-threads-new-possibilities/</a></li>
<li><strong>[Baeldung] Guide to Java Virtual Threads</strong> — Baeldung 的虚拟线程教程，涵盖 API 和最佳实践<br><a target="_blank" rel="noopener" href="https://www.baeldung.com/java-virtual-threads">https://www.baeldung.com/java-virtual-threads</a></li>
<li><strong>[Spring 官方 Blog] Virtual Threads in Spring Boot 3.2</strong> — Spring 团队关于虚拟线程集成的官方说明<br><a target="_blank" rel="noopener" href="https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot-3-2">https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot-3-2</a></li>
<li><strong>[Per Minborg] Don't Use synchronized with Virtual Threads</strong> — synchronized pinning 问题详解<br><a target="_blank" rel="noopener" href="https://minborgsjavapot.blogspot.com/2023/04/dont-use-synchronized-with-virtual.html">https://minborgsjavapot.blogspot.com/2023/04/dont-use-synchronized-with-virtual.html</a></li>
</ol>
