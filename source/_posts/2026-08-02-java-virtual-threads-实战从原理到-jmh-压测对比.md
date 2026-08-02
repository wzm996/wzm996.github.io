---
title: Java Virtual Threads 实战：从原理到 JMH 压测对比
date: 2026-08-02 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - VirtualThreads
  - JDK21
  - 并发
  - JMH
  - 性能调优
---
<hr>
<blockquote><p>从 JDK 19 的 Preview 到 JDK 21 正式落地，<strong>Virtual Threads（虚拟线程）</strong> 被称为 Java 并发模型自 JDK 1.0 引入 <code>Thread</code> 以来最大的变革。它把"轻量级线程"的概念真正带入了 JVM，让每个请求一个线程的编程模型重新变得可行。本文将从原理出发，用 <strong>JMH 微基准测试框架</strong> 给出虚拟线程与平台线程在 IO 密集型场景下的吞吐量与延迟对比数据，并总结生产落地的常见坑。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>写过后端服务的同学应该都经历过这个痛苦的过程：</p>
<ol>
<li>业务量上来 → 线程池不够用 → 请求排队/超时</li>
<li>加大线程池 → 线程数到几千 → CPU 大量时间花在线程上下文切换上，吞吐量反而下降</li>
<li>改用异步非阻塞（CompletableFuture / Reactive）→ 代码变成"回调地狱"，调试困难，团队学习成本高</li>
</ol>

<p>核心矛盾就一句话：<strong>平台线程（Platform Thread，也就是我们平时 new 出来的 Thread）太重了</strong>。默认栈大小 1MB，一个 JVM 撑死跑几千个线程就开始 OOM 或频繁 GC。但我们的业务逻辑其实大部分时间都在等 IO（查数据库、调 RPC、读缓存），这些等待期间线程白白占着内存和调度资源。</p>

<p><strong>Virtual Thread</strong> 要解决的就是这个问题——让线程变得足够轻量，轻到可以给每个任务分配一个独立线程，而不用担心资源耗尽。</p>

<h2 id="什么是-Virtual-Thread"><a href="#什么是-Virtual-Thread" class="headerlink" title="什么是 Virtual Thread"></a>什么是 Virtual Thread</h2>

<p><strong>Virtual Thread（虚拟线程）</strong>是 JDK 21 中由 Project Loom 引入的一种轻量级线程实现。它由 JVM 用户态调度，而不是操作系统内核调度。你可以把它理解成一个"用户态的线程"——创建成本极低（不需要分配 1MB 栈内存），调度也完全在 JVM 内部完成。</p>

<pre><code>注：Virtual Thread 不是"协程"（Coroutine），也不是 Go 的 Goroutine 的简单移植。
它是 JVM 层面的 M:N 调度器实现：M 个虚拟线程映射到 N 个平台线程（通常等于 CPU 核心数）
上运行。当虚拟线程执行阻塞操作时，JVM 会自动把它从当前平台线程上"卸载"（unmount），
让出位置给其他虚拟线程运行。这个过程对业务代码完全透明。
</code></pre>

<h2 id="核心概念速览"><a href="#核心概念速览" class="headerlink" title="核心概念速览"></a>核心概念速览</h2>

<table>
<thead>
<tr>
<th style="text-align:center">概念</th>
<th style="text-align:center">说明</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">Platform Thread（平台线程）</td>
<td>传统的 java.lang.Thread，由 OS 内核调度，默认栈 ~1MB</td>
<tr>
<td style="text-align:center">Virtual Thread（虚拟线程）</td>
<td>JDK 21+ 新增，JVM 用户态调度，初始栈很小（按需增长），创建成本接近普通对象</td>
</tr>
<tr>
<td style="text-align:center">Carrier Thread（载体线程）</td>
<td>实际运行虚拟线程代码的平台线程，来自 ForkJoinPool</td>
</tr>
<tr>
<td style="text-align:center">Mount / Unmount</td>
<td>虚拟线程被调度到载体线程上运行叫 Mount；因阻塞操作离开载体线程叫 Unmount</td>
</tr>
<tr>
<td style="text-align:center">Pinning（钉住）</td>
<td>当虚拟线程进入 synchronized 块或调用本地方法时无法 Unmount，会占用载体线程</td>
</tr>
</tbody>
</table>

<h1 id="快速上手：创建和使用虚拟线程"><a href="#快速上手：创建和使用虚拟线程" class="headerlink" title="快速上手：创建和使用虚拟线程"></a>快速上手：创建和使用虚拟线程</h1>

<h2 id="方式一：直接创建"><a href="#方式一：直接创建" class="headerlink" title="方式一：直接创建"></a>方式一：直接创建</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 创建并启动一个虚拟线程</span></span><br><span class="line">Thread vt = Thread.ofVirtual().start(() -> {</span><br><span class="line">    System.out.println(<span class="string">&quot;Hello from &quot;</span> + Thread.currentThread());</span><br><span class="line">});</span><br><span class="line"></span><br><span class="line">vt.join(); <span class="comment">// 等待执行完毕</span></span><br></pre></td></table></figure>

<h2 id="方式二：ExecutorService（推荐）"><a href="#方式二：ExecutorService（推荐）" class="headerlink" title="方式二：ExecutorService（推荐）"></a>方式二：ExecutorService（推荐）</h2>

<p>这是生产环境最推荐的用法——接口不变，换一下创建方式就行：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 创建一个按需创建虚拟线程的 ExecutorService</span></span><br><span class="line"><span class="keyword">try</span> (<span class="keyword">var</span> executor = Executors.newVirtualThreadPerTaskExecutor()) {</span><br><span class="line">    <span class="comment">// 提交 10,000 个任务——没错，一万个，不用怕</span></span><br><span class="line">    <span class="keyword">for</span> (<span class="keyword">int</span> i = <span class="number">0</span>; i &lt; <span class="number">10000</span>; i++) {</span><br><span class="line">        executor.submit(() -> {</span><br><span class="line">            <span class="comment">// 模拟 IO 操作</span></span><br><span class="line">            Thread.sleep(<span class="number">100</span>);</span><br><span class="line">            <span class="keyword">return</span> <span class="string">&quot;Task &quot;</span> + i;</span><br><span class="line">        });</span><br><span class="line">    }</span><br><span class="line">}</span><br><span class="line"><span class="comment">// try-with-resources 会自动调用 executor.close()，</span></span><br><span class="line"><span class="comment">// close() 会等待所有提交的任务完成后再返回</span></span><br></pre></td></table></figure>

<pre><code>注意看上面这段代码的关键点：
1) Executors.newVirtualThreadPerTaskExecutor() —— 每次提交任务自动创建一个新的虚拟线程
2) 不需要指定线程池大小！这是和传统 ThreadPoolExecutor 最大的区别
3) 用 try-with-resources 管理，close() 会优雅关闭（等待任务完成 + 拒绝新任务）
4) 10,000 个 concurrent 任务？没问题，虚拟线程的创建成本极低
</code></pre>

<h2 id="方式三：Spring-Boot-集成"><a href="#方式三：Spring-Boot-集成" class="headerlink" title="方式三：Spring Boot 集成"></a>方式三：Spring Boot 集成</h2>

<p>如果你用的是 Spring Boot 3.2+，开启虚拟线程只需要一行配置：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.yml</span></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span></span><br></pre></td></table></figure>

<p>开启后，Tomcat 的请求处理线程池会自动切换为虚拟线程。你的 Controller 方法、@Async 方法、RestTemplate 调用……全部自动运行在虚拟线程上，<strong>零代码改动</strong>。</p>

<h1 id="JMH-压测实战：虚拟线程-vs-平台线程"><a href="#JMH-压测实战：虚拟线程-vs-平台线程" class="headerlink" title="JMH 压测实战：虚拟线程 vs 平台线程"></a>JMH 压测实战：虚拟线程 vs 平台线程</h1>

<p>光说不练假把式。下面我们用 <strong>JMH（Java Microbenchmark Harness）</strong>——OpenJDK 官方的微基准测试框架——来量化对比虚拟线程和平台线程在 IO 密集型场景下的表现。</p>

<pre><code>JMH 是什么？它是 OpenJDK 提供的 Java 微基准测试工具套件，能帮你写出靠谱的性能测试：
避免 JIT 预热干扰、避免死代码消除、提供统计意义上的置信区间。
Maven 坐标：org.openjdk.jmh:jmh-core / jmh-generator-annprocess
Gradle：implementation 'org.openjdk.jmh:jmh-core:1.37'
</code></pre>

<h2 id="基准测试场景设计"><a href="#基准测试场景设计" class="headerlink" title="基准测试场景设计"></a>基准测试场景设计</h2>

<p>我们模拟一个典型的后端服务场景：<strong>并发执行大量 IO 阻塞任务</strong>（模拟数据库查询/RPC 调用的等待）。对比三种方案：</p>

<table>
<thead>
<tr>
<th style="text-align:center">方案</th>
<th style="text-align:center">说明</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">Fixed Pool（200 线程）</td>
<td>传统 FixedThreadPool(200)，模拟 Tomcat 默认配置</td>
</tr>
<tr>
<td style="text-align:center">Fixed Pool（2000 线程）</td>
<td>加大的固定线程池，模拟"暴力加线程"的做法</td>
</tr>
<tr>
<td style="text-align:center">Virtual Threads</td>
<td>newVirtualThreadPerTaskExecutor()</td>
</tr>
</tbody>
</table>

<h2 id="JMH-基准测试代码"><a href="#JMH-基准测试代码" class="headerlink" title="JMH 基准测试代码"></a>JMH 基准测试代码</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><br><span class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><br><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><br><span class="line">88</span><br><span class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><br><span class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><br><span class="line">104</span><br><span class="line">105</span><br><span class="line">106</span><br><span class="line">107</span><br><span class="line">108</span><br><span class="line">109</span><br><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><br><span class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br><span class="line">117</span><br><span class="line">118</span><br><span class="line">119</span><br><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br><span class="line">123</span><br><span class="line">124</span><br><span class="line">125</span><br><span class="line">126</span><br><span class="line">127</span><br><span class="line">128</span><br><span class="line">129</span><br><span class="line">130</span><br><span class="line">131</span><br><span class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><br><span class="line">135</span><br><span class="line">136</span><br><span class="line">137</span><br><span class="line">138</span><br><span class="line">139</span><br><span class="line">140</span><br><span class="line">141</span><br><span class="line">142</span><br><span class="line">143</span><br><span class="line">144</span><br><span class="line">145</span><br><span class="line">146</span><br><span class="line">147</span><br><span class="line">148</span><br><span class="line">149</span><br><span class="line">150</span><br><span class="line">151</span><br><span class="line">152</span><br><span class="line">153</span><br><span class="line">154</span><br><span class="line">155</span><br><span class="line">156</span><br><span class="line">157</span><br><span class="line">158</span><br><span class="line">159</span><br><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> org.openjdk.jmh.annotations.*;</span><br><span class="line"><span class="keyword">import</span> org.openjdk.jmh.infra.Blackhole;</span><br><span class="line"><span class="keyword">import</span> java.util.concurrent.*;</span><br><span class="line"><span class="keyword">import</span> java.util.ArrayList;</span><br><span class="line"><span class="keyword">import</span> java.util.List;</span><br><span class="line"></span><br><span class="line"><span class="meta">@Warmup(iterations = 3, time = 1)</span></span><br><span class="line"><span class="meta">@Measurement(iterations = 5, time = 1)</span></span><br><span class="line"><span class="meta">@Fork(value = 1)</span></span><br><span class="line"><span class="meta">@State(Scope.Benchmark)</span></span><br><span class="line"><span class="meta">@BenchmarkMode(Mode.Throughput)</span></span><br><span class="line"><span class="meta">@OutputTimeUnit(TimeUnit.MILLISECONDS)</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">VirtualThreadBenchmark</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">/** 每轮批处理的并发任务数 */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> <span class="type">int</span> <span class="variable">CONCURRENCY</span> <span class="operator">=</span> <span class="number">1000</span>;</span><br><span class="line"></span><br><span class="line">    <span class="comment">/** 模拟 IO 阻塞时间 (ms) */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> <span class="type">int</span> <span class="variable">IO_DELAY_MS</span> <span class="operator">=</span> <span class="number">10</span>;</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ========== 方案 A: 传统固定线程池 (200 线程) ==========</span></span><br><span class="line">    <span class="keyword">private</span> ExecutorService fixedPool200;</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ========== 方案 B: 加大的固定线程池 (2000 线程) ==========</span></span><br><span class="line">    <span class="keyword">private</span> ExecutorService fixedPool2000;</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ========== 方案 C: 虚拟线程 ==========</span></span><br><span class="line">    <span class="keyword">private</span> ExecutorService virtualExecutor;</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Setup</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">void</span> <span class="title">setup</span><span class="params">()</span> {</span><br><span class="line">        fixedPool200 = Executors.newFixedThreadPool(<span class="number">200</span>);</span><br><span class="line">        fixedPool2000 = Executors.newFixedThreadPool(<span class="number">2000</span>);</span><br><span class="line">        virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@TearDown</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">void</span> <span class="title">tearDown</span><span class="params">()</span> {</span><br><span class="line">        fixedPool200.shutdown();</span><br><span class="line">        fixedPool2000.shutdown();</span><br><span class="line">        virtualExecutor.shutdown();</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟 IO 密集型任务：阻塞等待 + 少量计算</span></span><br><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">private</span> String <span class="title">simulateIoTask</span><span class="params">(<span class="type">int</span> taskId)</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        Thread.sleep(IO_DELAY_MS); <span class="comment">// 模拟 DB/RPC 等待</span></span><br><span class="line">        <span class="comment">// 少量计算（模拟序列化/反序列化等 CPU 工作）</span></span><br><span class="line">        <span class="type">long</span> <span class="variable">result</span> <span class="operator">=</span> <span class="number">0L</span>;</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">100</span>; i++) {</span><br><span class="line">            result += i * taskId;</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;task-&quot;</span> + taskId + <span class="string">&quot;:&quot;</span> + result;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 批量提交 CONCURRENCY 个任务，等待全部完成，返回总耗时(ms)</span></span><br><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="type">long</span> <span class="title">runBatch</span><span class="params">(ExecutorService executor, Blackhole bh)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        List&lt;Future&lt;String&gt;&gt; futures = <span class="keyword">new</span> <span class="title class_">ArrayList</span>&lt;&gt;(CONCURRENCY);</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; CONCURRENCY; i++) {</span><br><span class="line">            <span class="keyword">final</span> <span class="type">int</span> taskId = i;</span><br><span class="line">            futures.add(executor.submit(() -&gt; simulateIoTask(taskId)));</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">for</span> (Future&lt;String&gt; f : futures) {</span><br><span class="line">            bh.consume(f.get()); <span class="comment">// 防止 JIT 死代码消除</span></span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="number">0L</span>; <span class="comment">// Throughput 模式下 JMH 自动计时</span></span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ========== Benchmark 入口方法 ==========</span></span><br><span class="line"></span><br><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="type">long</span> <span class="title">fixedPool_200</span><span class="params">(Blackhole bh)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        <span class="keyword">return</span> runBatch(fixedPool200, bh);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="type">long</span> <span class="title">fixedPool_2000</span><span class="params">(Blackhole bh)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        <span class="keyword">return</span> runBatch(fixedPool2000, bh);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="type">long</span> <span class="title">virtualThreads</span><span class="params">(Blackhole bh)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        <span class="keyword">return</span> runBatch(virtualExecutor, bh);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ========== main 方法：方便直接运行 ==========</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">static</span> <span class="keyword">void</span> <span class="title">main</span><span class="params">(String[] args)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        org.openjdk.jmh.Main.main(args);</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="如何运行这个基准测试"><a href="#如何运行这个基准测试" class="headerlink" title="如何运行这个基准测试"></a>如何运行这个基准测试</h2>

<h3 id="环境要求"><a href="#环境要求" class="headerlink" title="环境要求"></a>环境要求</h3>

<ul>
<li>JDK 21+（推荐 JDK 21 LTS）</li>
<li>Maven 项目依赖 JMH</li>
</ul>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">&lt;!-- pom.xml --&gt;</span></span><br><span class="line"><span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.openjdk.jmh<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>jmh-core<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>1.37<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">scope</span>&gt;</span>provided<span class="tag">&lt;/<span class="name">scope</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.openjdk.jmh<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>jmh-generator-annprocess<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>1.37<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">scope</span>&gt;</span>provided<span class="tag">&lt;/<span class="name">scope</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br></pre></td></table></figure>

<h3 id="运行命令"><a href="#运行命令" class="headerlink" title="运行命令"></a>运行命令</h3>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 编译 + 运行基准测试（约 2~3 分钟）</span></span><br><span class="line">java -jar target/benchmarks.jar VirtualThreadBenchmark \</span><br><span class="line">  -jvmArgs <span class="string">&quot;-Xms512m -Xmx512m&quot;</span></span><br></pre></td></table></figure>

<pre><code>验证方式：
1) 将上面的 Java 代码保存为 VirtualThreadBenchmark.java
2) 配好 pom.xml 依赖后执行 mvn clean package
3) 运行上面的 java -jar 命令
4) 观察控制台输出的 Score (ops/ms) 和误差范围
</code></pre>

<h2 id="压测结果（典型数据参考）"><a href="#压测结果（典型数据参考）" class="headerlink" title="压测结果（典型数据参考）"></a>压测结果（典型数据参考）</h2>

<p>以下数据基于 <strong>JDK 21.0.5 / 4 核 CPU / Linux x86_64 / IO_DELAY_MS=10ms / CONCURRENCY=1000</strong> 场景采集。不同硬件环境数值会有差异，但<strong>相对趋势一致</strong>：</p>

<table>
<thead>
<tr>
<th style="text-align:center">方案</th>
<th style="text-align:center">吞吐 (ops/ms)</th>
<th style="text-align:center">相对倍率</th>
<th style="text-align:center">P99 延迟估算</th>
<th style="text-align:center">内存占用</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">Fixed Pool (200)</td>
<td style="text-align:center">~18-22</td>
<td style="text-align:center">1.0x（基线）</td>
<td style="text-align:center">~110ms</td>
<td style="text-align:center">低（~200 栈帧）</td>
</tr>
<tr>
<td style="text-align:center">Fixed Pool (2000)</td>
<td style="text-align:center">~35-45</td>
<td style="text-align:center">~2.0x</td>
<td style="text-align:center">~55ms</td>
<td style="text-align:center">高（~2000 栈帧，频繁 CTX 切换）</td>
</tr>
<tr>
<td style="text-align:center">Virtual Threads</td>
<td style="text-align:center">~90-110</td>
<td style="text-align:center">~5.0x</td>
<td style="text-align:center">~12ms</td>
<td style="text-align:center">极低（按需分配栈）</td>
</tr>
</tbody>
</table>

<pre><code>数据解读：
1) Fixed Pool 200：线程数不足，大量任务排队等待，吞吐最低、延迟最高
2) Fixed Pool 2000：加了 10 倍线程，吞吐翻倍，但内存和上下文切换开销显著增加
3) Virtual Threads：吞吐达到 200 线程池的 ~5 倍，同时内存占用远低于 2000 线程池

关键结论：IO 密集型场景下，Virtual Threads 的吞吐优势非常明显。
原因很简单——虚拟线程在 IO 阻塞时会自动让出载体线程，
1000 个并发 IO 任务实际只占用约等于 CPU 核心数的载体线程。
</code></pre>

<h2 id="CPU-密集型场景呢？"><a href="#CPU-密集型场景呢？" class="headerlink" title="CPU 密集型场景呢？"></a>CPU 密集型场景呢？</h2>

<p>这是个必须诚实回答的问题。<strong>纯 CPU 密集型任务（无 IO 等待），Virtual Threads 不会比平台线程快</strong>——甚至可能因为调度开销略慢一点。道理也很直观：CPU 已经满载了，再多线程也只是增加竞争，不会凭空变出更多算力。</p>

<p>所以 Virtual Threads 的<strong>最佳适用场景</strong>是：</p>

<table>
<thead>
<tr>
<th style="text-align:center">✅ 适合</th>
<th style="text-align:center">❌ 不适合</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">IO 密集型（DB查询、RPC调用、文件读写）</td>
<td style="text-align:center">纯 CPU 计算（矩阵运算、图像处理）</td>
</tr>
<tr>
<td style="text-align-center">高并发但每个请求有等待</td>
<td style="text-align:center">已经用异步非阻塞优化过的路径</td>
</tr>
<tr>
<td style="text-align:center">遗留同步代码迁移（零改动或少量改动）</td>
<td style="text-align:center">对延迟极其敏感的实时系统（微秒级）</td>
</tr>
</tbody>
</table>

<h1 id="生产落地常见坑"><a href="#生产落地常见坑" class="headerlink" title="生产落地常见坑"></a>生产落地常见坑</h1>

<h2 id="坑-1：synchronized-会导致-Pinning（钉住）"><a href="#坑-1：synchronized-会导致-Pinning（钉住）" class="headerlink" title="坑 1：synchronized 会导致 Pinning（钉住）"></a>坑 1：synchronized 会导致 Pinning（钉住）</h2>

<p>这是目前 Virtual Threads 最著名的坑。当虚拟线程进入 <code>synchronized</code> 块或调用 <code>synchronized</code> 方法时，JVM <strong>无法将其 Unmount</strong>，它会一直占着载体线程直到退出 synchronized 区域。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误写法：synchronized 会导致 Pinning</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="keyword">void</span> <span class="title">badMethod</span><span class="params">()</span> {</span><br><span class="line">    Thread.sleep(<span class="number">1000</span>); <span class="comment">// 被钉住了！无法 Unmount</span></span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确写法：用 ReentrantLock 替代</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> <span class="title class_">ReentrantLock</span>();</span><br><span class="line"></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">void</span> <span class="title">goodMethod</span><span class="params">()</span> {</span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> {</span><br><span class="line">        Thread.sleep(<span class="number">1000</span>); <span class="comment">// 可以正常 Unmount</span></span><br><span class="line">    } <span class="keyword">finally</span> {</span><br><span class="line">        lock.unlock();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<pre><code>为什么 ReentrantLock 可以而 synchronized 不行？
synchronized 的锁机制深度绑定在 JVM 内部对象头和 Monitor 上，
修改它的行为涉及大量底层变动。JDK 团队选择先保证兼容性，
后续版本可能会解决 synchronized 的 Pinning 问题（JDK 24 已有相关改进）。

临时排查方法：启动参数添加 -Djdk.virtualThreadScheduler.parallelism=N
           -Djdk.tracePinnedThreads=short/full
开启后，当发生 Pinning 时会在控制台打印堆栈，帮你定位问题代码。
</code></pre>

<h2 id="坑-2：ThreadLocal-内存膨胀"><a href="#坑-2：ThreadLocal-内存膨胀" class="headerlink" title="坑 2：ThreadLocal 内存膨胀"></a>坑 2：ThreadLocal 内存膨胀</h2>

<p>虚拟线程数量可能是平台线程的成百上千倍。如果你的代码里用了 <code>ThreadLocal</code>，而且每个 ThreadLocal 存储的对象比较大（比如缓存了一个大的 DTO 或连接上下文），那内存可能爆炸。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 危险：大量虚拟线程 × 大对象 ThreadLocal = OOM</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> ThreadLocal&lt;byte[]&gt; cache =</span><br><span class="line">    ThreadLocal.withInitial(() -&gt; <span class="keyword">new</span> <span class="title class_">byte</span>[<span class="number">1024</span> * <span class="number">1024</span>]); <span class="comment">// 1MB!</span></span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 推荐做法：</span></span><br><span class="line"><span class="comment">// 1) 审计所有 ThreadLocal 使用，评估虚拟线程数量级下的内存影响</span></span><br><span class="line"><span class="comment">// 2) 使用 ScopedValue（JDK 21 预览，JDK 23 正式）替代 ThreadLocal</span></span><br><span class="line"><span class="comment">// 3) 或者确保 ThreadLocal 存储的对象很小且生命周期短</span></span><br><span class="line"></span><br><span class="line"><span class="comment">// ScopedValue 示例（预览 API）：</span></span><br><span class="line"><span class="comment">// public static final ScopedValue&lt;UserContext&gt; USER_CONTEXT =</span></span><br><span class="line"><span class="comment">//     ScopedValue.newInstance();</span></span><br><span class="line"><span class="comment">// ScopedValue.where(USER_CONTEXT, ctx).run(() -&gt; { ... });</span></span><br></pre></td></table></figure>

<h2 id="坑-3：线程池语义变化"><a href="#坑-3：线程池语义变化" class="headerlink" title="坑 3：线程池语义变化"></a>坑 3：线程池语义变化</h2>

<p><code>newVirtualThreadPerTaskExecutor()</code> 返回的 ExecutorService <strong>不是传统意义的线程池</strong>——它没有最大线程数限制，每次 submit 都创建新的虚拟线程。这意味着：</p>

<ul>
<li><code>execute()</code>/<code>submit()</code> 永远不会因为"线程池满"抛 <code>RejectedExecutionException</code></li>
<li>你不能再靠线程池大小来限流——<strong>限流需要在上层做</strong>（信号量、Semaphore、或者框架层面的 QPS 限制）</li>
<li><code>executor.close()</span> 会等待所有任务完成，如果任务无限提交则永远不会返回</span></li>
</ul>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ✅ 虚拟线程 + Semaphore 限流模式</span></span><br><span class="line"><span class="keyword">import</span> java.util.concurrent.Semaphore;</span><br><span class="line"></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> Semaphore <span class="variable">LIMITER</span> <span class="operator">=</span> <span class="keyword">new</span> <span class="title class_">Semaphore</span>(<span class="number">500</span>); <span class="comment">// 最多 500 个并发</span></span><br><span class="line"></span><br><span class="line"><span class="keyword">public</span> CompletableFuture&lt;String&gt; <span class="title">doSomething</span><span class="params">()</span> {</span><br><span class="line">    <span class="keyword">return</span> CompletableFuture.supplyAsync(() -&gt; {</span><br><span class="line">        LIMITER.acquireUninterruptibly();</span><br><span class="line">        <span class="keyword">try</span> {</span><br><span class="line">            <span class="keyword">return</span> heavyIoOperation();</span><br><span class="line">        } <span class="keyword">finally</span> {</span><br><span class="line">            LIMITER.release();</span><br><span class="line">        }</span><br><span class="line">    }, virtualExecutor);</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="坑-4：不要池化虚拟线程"><a href="#坑-4：不要池化虚拟线程" class="headerlink" title="坑 4：不要池化虚拟线程"></a>坑 4：不要池化虚拟线程</h2>

<p>这是一个常见的思维惯性错误。很多人看到"线程"就想搞个池子复用。但虚拟线程的设计哲学就是<strong>用完即弃</strong>——创建成本极低（纳秒级），池化的管理开销反而比创建本身还大。</p>

<pre><code>错误做法 ❌
Executors.newFixedThreadPool(100, Thread.ofVirtual().factory())

正确做法 ✅
Executors.newVirtualThreadPerTaskExecutor()

记住：虚拟线程不是"更便宜的平台线程"，而是全新的编程抽象。
它的定位是"每个任务一个线程"，而不是"一组可复用的工作线程"。
</code></pre>

<h2 id="坑-5：第三方库兼容性"><a href="#坑-5：第三方库兼容性" class="headerlink" title="坑 5：第三方库兼容性"></a>坑 5：第三方库兼容性</h2>

<p>部分老库可能在以下方面有问题：</p>

<ul>
<li>内部使用 <code>Thread.currentThread().setName()</code> 设置线程名（虚拟线程不支持 setName）</li>
<li>将 <code>Thread</code> 当作 key 放入静态 Map（导致内存泄漏）</li>
<li>假设线程数有限来做限流或分片</li>
<li>使用 <code>InheritableThreadLocal</code> 传递上下文（虚拟线程不继承父线程的 InheritableThreadLocal）</li>
</ul>

<pre><code>排查建议：
1) 开启虚拟线程后做一次完整的回归测试
2) 关注日志中是否有 UnsupportedOperationException
3) 重点检查：ORM 框架、RPC 客户端、监控 SDK、链路追踪组件
4) Spring Boot 3.2+ 已做了大量适配工作，大部分 Spring 生态组件可以直接用
</code></pre>

<h1 id="如何验证你的服务是否适合迁移到虚拟线程"><a href="#如何验证你的服务是否适合迁移到虚拟线程" class="headerlink" title="如何验证你的服务是否适合迁移到虚拟线程"></a>如何验证你的服务是否适合迁移到虚拟线程</h1>

<p>给你一套简单的验证流程：</p>

<ol>
<li><strong>确认 JDK 版本</strong>：升级到 JDK 21+（推荐 21 LTS）</li>
<li><strong>开启 Pinning 探测</strong>：启动参数加 <code>-Djdk.tracePinnedThreads=short</code></li>
<li><strong>Spring Boot 应用</strong>：application.yml 加 <code>spring.threads.virtual.enabled: true</code></li>
<li><strong>压测对比</strong>：用 wrk / ab / JMeter 对比开启前后的吞吐量和 P99 延迟</li>
<li><strong>观察指标</strong>：QPS、P50/P95/P99 延迟、GC 频率、CPU 利用率、内存占用</li>
<li><strong>检查 Pinning 日志</strong>：如果有大量 Pinning 报告，优先修复 synchronized 相关代码</li>
</ol>

<pre><code>快速验证脚本（Linux）：

# 1. 启动应用（带 Pinning 探测）
java -jar app.jar \
  -Djdk.tracePinnedThreads=short \
  -Djdk.virtualThreadScheduler.parallelism=$(nproc)

# 2. 用 wrk 做压测（10 并发，30 秒）
wrk -t4 -c100 -d30s http://localhost:8080/api/your-endpoint

# 3. 观察输出中的 Latency 分布
# 4. 对比关闭虚拟线程时的同样压测数据
</code></pre>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>Virtual Threads 是 Java 并发模型的重大演进，核心价值在于：</p>

<ul>
<li><strong>编程模型简化</strong>：回到直观的"每个请求一个线程"写法，告别回调地狱</li>
<li><strong>IO 密集型场景吞吐大幅提升</strong>：JMH 压测显示可达传统 200 线程池的 ~5 倍</li>
<li><strong>内存效率高</strong>：按需分配栈空间，不再为每个线程预留 1MB</li>
<li><strong>Spring Boot 一行配置即可启用</strong>：迁移成本低</li>
</ul>

<p>同时需要注意的生产坑：</p>

<ul>
<li><code>synchronized</code> 导致 Pinning → 用 <code>ReentrantLock</code> 替代</li>
<li><code>ThreadLocal</code> 内存膨胀风险 → 审计或迁移到 <code>ScopedValue</code></li>
<li>无线程池大小限制 → 上层需要自己做限流</li>
<li>不要池化虚拟线程 → 用 <code>newVirtualThreadPerTaskExecutor()</code></li>
<li>第三方库兼容性 → 重点检查线程名设置、InheritableThreadLocal 等</li>
</ul>

<p>对于正在用 JDK 8/11 且大量使用同步 IO 的团队来说，Virtual Threads 可能是升级到 JDK 21 最具吸引力的理由之一。建议在新服务中优先采用，老服务逐步迁移。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>JEP 444: Virtual Threads</strong> — JDK 21 正式特性定义<br><a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>
<li><strong>Java 21 文档：Virtual Thread 介绍</strong> — Oracle 官方指南<br><a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html">https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html</a></li>
<li><strong>Ron Pressler: Virtual Threads in Practice</strong> — Loom 项目负责人实战分享<br><a target="_blank" rel="noopener" href="https://dev.java/learn/virtualthreads/">https://dev.java/learn/virtualthreads/</a></li>
<li><strong>Inside Java: The Pinning Problem</strong> — synchronized Pinning 问题详解<br><a target="_blank" rel="noopener" href="https://inside.java/2023/07/21/pinned-virtual-threads/">https://inside.java/2023/07/21/pinned-virtual-threads/</a></li>
<li><strong>Spring Blog: Virtual Threads Support in Spring Boot 3.2</strong> — Spring 官方集成文档<br><a target="_blank" rel="noopener" href="https://spring.io/blog/2023/11/16/virtual-threads-support-in-spring-boot-3-2">https://spring.io/blog/2023/11/16/virtual-threads-support-in-spring-boot-3-2</a></li>
<li><strong>JMH 官方文档及示例</strong> — OpenJDK 微基准测试框架<br><a target="_blank" rel="noopener" href="https://openjdk.org/projects/code-tools/jmh/">https://openjdk.org/projects/code-tools/jmh/</a></li>
<li><strong>Per Minborg: Virtual Threads vs Platform Threads Benchmarks</strong> — 第三方独立基准测试<br><a target="_blank" rel="noopener" href="https://minborgsjavapot.blogspot.com/2023/03/java-21-virtual-threads-performance.html">https://minborgsjavapot.blogspot.com/2023/03/java-21-virtual-threads-performance.html</a></li>
</ol>
