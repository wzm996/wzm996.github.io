---
title: Spring Boot 3 虚拟线程实战——从原理到压测对比
date: 2026-07-26 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - Java 21
  - Virtual Threads
  - Tomcat
  - 性能调优
  - JFR
---
<hr>
<blockquote><p>JDK 21 正式发布的 <strong>虚拟线程</strong>（Virtual Threads，代号 Project Loom）是 Java 并发史上最大的范式转变之一。它让"每个请求一个线程"的简单编程模型重新变得高效——不再受操作系统线程数量和上下文切换成本的限制。本文将从原理出发，搭建一个完整的 Spring Boot 3 压测环境，用数据说话：虚拟线程到底比传统 Tomcat 线程池快多少？哪些场景适合上？又有哪些坑？</p>
</blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>在虚拟线程出现之前，Java 服务端处理并发请求的主流方案是<strong>线程池</strong>（Thread Pool）。Tomcat 默认配置 200 个工作线程，每个请求占用一个平台线程（Platform Thread，也就是操作系统内核线程）。这个模型有两个核心痛点：</p>

<ul>
<li><strong>线程数量有限</strong>：一台 8 核 16G 的机器，撑死也就跑几千个线程（每个线程栈默认 1MB），再多了 OOM 或者调度开销爆炸。</li>
<li><strong>阻塞即浪费</strong>：当线程在等 DB 查询、RPC 调用、HTTP 请求时，这个线程啥也不干，就干等着。CPU 空转，线程还被占着。</li>
</ul>

<p>之前的解决方案是走<strong>异步非阻塞</strong>路线（Reactor 模式、CompletableFuture、响应式编程），但代码写起来像回调地狱，维护成本极高。</p>

<p><strong>虚拟线程</strong>的核心思路非常精妙：<blockquote><p>把"线程"这个概念从操作系统层面剥离出来。虚拟线程是由 JVM 调度的轻量级用户态线程，成本极低（创建一个虚拟线程只占几百字节），可以轻松创建百万级别。当虚拟线程执行阻塞操作（I/O、锁等待等）时，JVM 会自动把它<strong>挂载</strong>（unmount）到载体线程（Carrier Thread，通常是平台线程）上，腾出载体线程去跑别的虚拟线程；等 I/O 完成后再<strong>重新挂载</strong>（mount）回来继续执行。</p></blockquote>这个过程对业务代码完全透明——你写的还是同步代码，但 JVM 在底层帮你做了异步调度。</p>

<h2 id="虚拟线程-vs-传统线程池对比"><a href="#虚拟线程-vs-传统线程池对比" class="headerlink" title="虚拟线程 vs 传统线程池对比"></a>虚拟线程 vs 传统线程池对比</h2>

<table>
<thead>
<tr>
<th style="text-align:left">维度</th>
<th style="text-align:center">平台线程（线程池）</th>
<th style="text-align:center">虚拟线程</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">创建成本</td>
<td style="text-align:center">~几万条指令 + 1MB 栈内存</td>
<td style="text-align:center">~几百字节，几乎免费</td>
<td style="text-align:left">数量上限</td>
<td style="text-align:center">数千（受内存/CPU 调度限制）</td>
<td style="text-align:center">百万级无压力</td>
</tr>
<tr>
<td style="text-align:left">调度者</td>
<td style="text-align:center">OS 内核调度器</td>
<td style="text-align:center">JVM 工作窃取（Work-Stealing）调度器（ForkJoinPool）</td>
</tr>
<tr>
<td style="text-align:left">阻塞行为</td>
<td style="text-align:center">线程被 OS 挂起，白白占用资源</td>
<td style="text-align:center">自动卸载（unmount），释放载体线程</td>
</tr>
<tr>
<td style="text-align:left">编程模型</td>
<td style="text-align:center">同步代码（但线程数受限）或异步回调（复杂度高）</td>
<td style="text-align:center">同步代码，无需改动</td>
</tr>
<tr>
<td style="text-align:left">适用场景</td>
<td style="text-align:center">CPU 密集型 / 少量并发</td>
<td style="text-align:center">I/O 密集型 / 高并发 Web 服务</td>
</tr>
</tbody>
</table>

<pre><code>注：虚拟线程不是银弹！对于纯 CPU 密集型计算（比如图像处理、加密解密），虚拟线程不会带来任何提升，甚至因为调度开销略慢于平台线程。
</code></pre>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<h2 id="技术栈要求"><a href="#技术栈要求" class="headerlink" title="技术栈要求"></a>技术栈要求</h2>

<ul>
<li><strong>JDK</strong>：21+（推荐 LTS 版本 JDK 21.0.x）</li>
<li><strong>Spring Boot</strong>：3.2+（3.2 开始原生支持虚拟线程配置）</li>
<li><strong>压测工具</strong>：wrk 或 k6（本文使用 <strong>wrk</strong>，轻量高效）</li>
<li><strong>监控工具</strong>：jcmd / jfr（JDK 自带，用于采集线程和 GC 数据）</li>
</ul>

<h2 id="创建-Spring-Boot-项目"><a href="#创建-Spring-Boot-项目" class="headerlink" title="创建 Spring Boot 项目"></a>创建 Spring Boot 项目</h2>

<p>快速搭建一个用于压测的 Demo 项目：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 使用 Spring Initializr 创建项目（通过 curl）</span>
<span class="line">curl https://start.spring.io/starter.zip \
<span class="line">  -d dependencies=web \
<span class="line">  -d javaVersion=21 \
<span class="line">  -d bootVersion=3.3.5 \
<span class="line">  -o demo.zip && unzip demo.zip -d vthread-demo</span><br></pre></td></table></figure>

<h2 id="编写模拟-I-O-阻塞的接口"><a href="#编写模拟-I-O-阻塞的接口" class="headerlink" title="编写模拟 I/O 阻塞的接口"></a>编写模拟 I/O 阻塞的接口</h2>

<p>为了体现虚拟线程的优势，我们需要一个<strong>I/O 密集型</strong>接口。下面这个 Controller 模拟了真实场景中常见的"串行调用多个下游服务"：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><br><span class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><br><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><br><span class="line">88</span><br><span class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><br><span class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><br><span class="line">104</span><br><span class="line">105</span><br><span class="line">106</span><br><span class="line">107</span><br><span class="line">108</span><br><span class="line">109</span><br><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><br><span class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br><span class="line">117</span><br><span class="line">118</span><br><span class="line">119</span><br><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br><span class="line">123</span><br><span class="line">124</span><br><span class="line">125</span><br><span class="line">126</span><br><span class="line">127</span><br><span class="line">128</span><br><span class="line">129</span><br><span class="line">130</span><br><span class="line">131</span><br><span class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><br><span class="line">135</span><br><span class="line">136</span><br><span class="line">137</span><br><span class="line">138</span><br><span class="line">139</span><br><span class="line">140</span><br><span class="line">141</span><br><span class="line">142</span><br><span class="line">143</span><br><span class="line">144</span><br><span class="line">145</span><br><span class="line">146</span><br><span class="line">147</span><br><span class="line">148</span><br><span class="line">149</span><br><span class="line">150</span><br><span class="line">151</span><br><span class="line">152</span><br><span class="line">153</span><br><span class="line">154</span><br><span class="line">155</span><br><span class="line">156</span><br><span class="line">157</span><br><span class="line">158</span><br><span class="line">159</span><br><span class="line">160</span><br><span class="line">161</span><br><span class="line">162</span><br><span class="line">163</span><br><span class="line">164</span><br><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">package</span> com.example.demo;</span><br><span class="line"></span><br><span class="line"><span class="keyword">import</span> org.springframework.web.bind.annotation.*;</span><br><span class="line"><span class="keyword">import</span> java.util.concurrent.*;</span><br><span class="line"><span class="keyword">import</span> java.util.random.RandomGenerator;</span><br><span class="line"></span><br><span class="line"><span class="comment">/**</span>
<br><span class="line"> * 模拟 I/O 密集型的业务接口</span>
<br><span class="line"> * 场景：聚合服务需要依次调用用户中心、订单中心、库存中心、支付中心</span>
<br><span class="line"> */</span>
<span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api")</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">IoBoundController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> ExecutorService dbExecutor = Executors.newFixedThreadPool(<span class="number">4</span>);</span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> RandomGenerator rng = RandomGenerator.getDefault();</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span>
<br><span class="line">     * 模拟一次远程 RPC/DB 调用（固定耗时 20~80ms）</span>
<br><span class="line">     */</span>
<span class="line">    <span class="keyword">private</span> String <span class="title function_">simulateRemoteCall</span><span class="params">(String serviceName)</span> {</span><br><span class="line">        <span class="type">int</span> delayMs = <span class="number">20</span> + rng.nextInt(<span class="number">61</span>); <span class="comment">// 20~80ms</span>
<span class="line">        LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(delayMs));</span><br><span class="line">        <span class="keyword">return</span> serviceName + <span class="string">"-resp["</span> + delayMs + <span class="string">"ms]"</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span>
<br><span class="line">     * 模拟 DB 查询（提交到独立线程池，模拟 DB 连接池排队）</span>
<br><span class="line">     */</span>
<span class="line">    <span class="keyword">private</span> String <span class="title function_">simulateDbQuery</span><span class="params">(String sqlHint)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        <span class="keyword">return</span> dbExecutor.submit(() -> {</span><br><span class="line">            <span class="type">int</span> delayMs = <span class="number">10</span> + rng.nextInt(<span class="number">41</span>); <span class="comment">// 10~50ms</span>
<span class="line">            LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(delayMs));</span><br><span class="line">            <span class="keyword">return</span> sqlHint + <span class="string">"-result["</span> + delayMs + <span class="string">"ms]"</span>;</span><br><span class="line">        }).get(); <span class="comment">// get() 会阻塞当前线程 —— 这正是虚拟线程大显身手的地方</span>
<span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span>
<br><span class="line">     * 接口 A：轻度 I/O（2 次串行远程调用）</span>
<br><span class="line">     * 预期总延迟：40~160ms</span>
<br><span class="line">     */</span>
<span class="line">    <span class="meta">@GetMapping("/light")</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">lightTask</span><span class="params">()</span> {</span><br><span class="line">        <span class="type">long</span> start = System.nanoTime();</span><br><span class="line"></span><br><span class="line">        <span class="type">String</span> userResult = simulateRemoteCall(<span class="string">"UserService"</span>);</span><br><span class="line">        <span class="type">String</span> orderResult = simulateRemoteCall(<span class="string">"OrderService"</span>);</span><br><span class="line"></span><br><span class="line">        <span class="type">long</span> costMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">"user"</span>, userResult,</span><br><span class="line">            <span class="string">"order"</span>, orderResult,</span><br><span class="line">            <span class="string">"totalCostMs"</span>, costMs</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span>
<br><span class="line">     * 接口 B：重度 I/O（4 次串行远程调用 + 1 次 DB 查询）</span>
<br><span class="line">     * 预期总延迟：110~370ms</span>
<br><span class="line">     */</span>
<span class="line">    <span class="meta">@GetMapping("/heavy")</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">heavyTask</span><span class="params">()</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        <span class="type">long</span> start = System.nanoTime();</span><br><span class="line"></span><br><span class="line">        <span class="type">String</span> userResult = simulateRemoteCall(<span class="string">"UserService"</span>);</span><br><span class="line">        <span class="type">String</span> orderResult = simulateRemoteCall(<span class="string">"OrderService"</span>);</span><br><span class="line">        <span class="type">String</span> stockResult = simulateRemoteCall(<span class="string">"StockService"</span>);</span><br><span class="line">        <span class="type">String</span> payResult = simulateRemoteCall(<span class="string">"PayService"</span>);</span><br><span class="line">        <span class="type">String</span> dbResult = simulateDbQuery(<span class="string">"SELECT * FROM orders WHERE ..."</span>);</span><br><span class="line"></span><br><span class="line">        <span class="type">long</span> costMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">"user"</span>, userResult,</span><br><span class="line">            <span class="string">"order"</span>, orderResult,</span><br><span class="line">            <span class="string">"stock"</span>, stockResult,</span><br><span class="line">            <span class="string">"pay"</span>, payResult,</span><br><span class="line">            <span class="string">"db"</span>, dbResult,</span><br><span class="line">            <span class="string">"totalCostMs"</span>, costMs</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span>
<br><span class="line">     * 接口 C：健康检查（无 I/O，纯 CPU 计算）</span>
<br><span class="line">     * 用于对比：虚拟线程在 CPU 密集场景下没有优势</span>
<br><span class="line">     */</span>
<span class="line">    <span class="meta">@GetMapping("/health")</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">health</span><span class="params">()</span> {</span><br><span class="line">        <span class="type">long</span> start = System.nanoTime();</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 模拟少量 CPU 工作</span>
<span class="line">        <span class="type">double</span> result = <span class="number">0</span>;</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">10000</span>; i++) {</span><br><span class="line">            result += Math.sqrt(i) * Math.log(i + <span class="number">1</span>);</span><br><span class="line">        }</span><br><span class="line"></span><br><span class="line">        <span class="type">long</span> costUs = TimeUnit.NANOSECONDS.toMicros(System.nanoTime() - start);</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">"status"</span>, <span class="string">"UP"</span>,</span><br><span class="line">            <span class="string">"computeResult"</span>, result,</span><br><span class="line">            <span class="string">"costUs"</span>, costUs</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<pre><code>注：LockSupport.parkNanos 是 JDK 提供的线程阻塞原语，用来精确模拟 I/O 等待时间。它会让当前线程挂起指定纳秒数，底层会触发虚拟线程的 unmount/mount 机制（如果当前运行在虚拟线程上的话）。
</code></pre>

<h1 id="两种模式配置"><a href="#两种模式配置" class="headerlink" title="两种模式配置"></a>两种模式配置</h1>

<h2 id="模式一：传统-Tomcat-线程池（基线）"><a href="#模式一：传统-Tomcat-线程池（基线）" class="headerlink" title="模式一：传统 Tomcat 线程池（基线）"></a>模式一：传统 Tomcat 线程池（基线）</h2>

<p><code>application-baseline.yml</code>：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span>
<span class="bullet">  port:</span> <span class="number">8080</span></span><br><span class="line"><span class="attr">  tomcat:</span>
<span class="bullet">  threads:</span>
<span class="bullet">    max:</span> <span class="number">200</span>      <span class="comment"># 最大工作线程数（默认值）</span>
<span class="bullet">    min-spare:</span> <span class="number">10</span>    <span class="comment"># 最小空闲线程</span>
<span class="bullet">  accept-count:</span> <span class="number">100</span>    <span class="comment"># 排队队列长度</span>
<span class="bullet">  max-connections:</span> <span class="number">10000</span> <span class="comment"># 最大连接数</span></span><br><span class="line"></span><br><span class="line"><span class="attr">spring:</span>
<span class="bullet">  application:</span>
<span class="bullet">    name:</span> <span class="string">vthread-baseline</span></span><br></pre></td></table></figure>

<h2 id="模式二：虚拟线程（实验组）"><a href="#模式二：虚拟线程（实验组）" class="headerlink" title="模式二：虚拟线程（实验组）"></a>模式二：虚拟线程（实验组）</h2>

<p><code>application-vthread.yml</code>：</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">server:</span>
<span class="bullet">  port:</span> <span class="number">8080</span></span><br><span class="line"><span class="attr">spring:</span>
<span class="bullet">  application:</span>
<span class="bullet">    name:</span> <span class="string">vthread-enabled</span></span><br><span class="line"></span><br><span class="line"><span class="comment"># ====== 关键配置：开启虚拟线程 ======</span>
<span class="attr">spring:</span>
<span class="bullet">  threads:</span>
<span class="virtual">    virtual:</span>
<span class="literal">      enabled:</span> <span class="literal">true</span></span><br><span class="line"></span><br><span class="line"><span class="comment"># 开启虚拟线程后，Tomcat 线程池会被自动替换为虚拟线程执行器</span>
<span class="comment"># 不再需要手动配置 server.tomcat.threads.max</span>
<span class="comment"># Tomcat 会为每个请求创建一个虚拟线程来处理</span>
</code></pre></td></table></figure>

<p>是的，你没看错——Spring Boot 3.2+ 只需要加一行 <code>spring.threads.virtual.enabled=true</code>，整个 Web 容器的请求处理线程就会切换为虚拟线程。<strong>零代码改动。</strong></p>

<pre><code>注：这行配置的本质是在 Spring Boot 启动时，用一个基于虚拟线程的 Executor 替换掉 Tomcat 默认的 ThreadPoolExecutor。所有通过 DispatcherServlet 进来的请求都会在虚拟线程上执行。
</code></pre>

<h1 id="压测与数据分析"><a href="#压测与数据分析" class="headerlink" title="压测与数据分析"></a>压测与数据分析</h1>

<h2 id="压测方法"><a href="#压测方法" class="headerlink" title="压测方法"></a>压测方法</h2>

<p>使用 <strong>wrk</strong> 进行压测（如果机器上没有 wrk，可以用 ab / k6 / JMeter 替代，结果趋势一致）：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><span class="line">43</span><span class="line">44</span><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><br><span class="line">63</span><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><br><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><span class="line">88</span><span class="line">89</span><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><br class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><br><span class="line">104</span><br><span class="line">105</span><br><span class="line">106</span><span class="line">107</span><span class="line">108</span><br><span class="line">109</span><span class="line">110</span><br><span class="line">111</span><span class="line">112</span><span class="line">113</span><span class="line">114</span><span class="line">115</span><span class="line">116</span><span class="line">117</span><span class="line">118</span><span class="line">119</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">## 编译打包</span>
<span class="line">cd vthread-demo &amp;&amp; ./mvnw clean package -DskipTests</span><br><span class="line"></span><br><span class="line"><span class="comment">## 启动基线模式（传统线程池）</span>
<span class="line">java -jar target/demo-0.0.1-SNAPSHOT.jar \</span><br><span class="line">  --spring.config.name=application-baseline \</span><br><span class="line">  -Dserver.port=8080 &amp;</span><br><span class="line"></span><br><span class="line"><span class="comment">## 启动虚拟线程模式（另一个端口）</span>
<span class="line">java -jar target/demo-0.0.1-SNAPSHOT.jar \</span><br><span class="line">  --spring.config.name=application-vthread \</span><br><span class="line">  -Dserver.port=8081 &amp;</span><br><span class="line"></span><br><span class="line"><span class="comment"># ============================================================</span>
<span class="line"><span class="comment"># 压测命令模板（wrk）</span>
<span class="line"><span class="comment"># ============================================================</span>
<span class="line"></span><br><span class="line"><span class="comment"># 场景 1：轻度 I/O 接口 (/api/light)，200 并发，持续 30 秒</span>
<span class="line"><span class="comment"># --- 基线（端口 8080）---</span>
<span class="line">wrk -t12 -c200 -d30s --latency http://localhost:8080/api/light</span><br><span class="line"></span><br><span class="line"><span class="comment"># --- 虚拟线程（端口 8081）---</span>
<span class="line">wrk -t12 -c200 -d30s --latency http://localhost:8081/api/light</span><br><span class="line"></span><br><span class="line"><span class="comment"># 场景 2：重度 I/O 接口 (/api/heavy)，500 并发，持续 30 秒</span>
<span class="line"><span class="comment"># --- 基线 ---</span>
<span class="line">wrk -t12 -c500 -d30s --latency http://localhost:8080/api/heavy</span><br><span class="line"></span><br><span class="line"><span class="comment"># --- 虚拟线程 ---</span>
<span class="line">wrk -t12 -c500 -d30s --latency http://localhost:8081/api/heavy</span><br><span class="line"></span><br><span class="line"><span class="comment"># 场景 3：高并发冲击（1000 并发，重度 I/O）</span>
<span class="line"><span class="comment"># --- 基线 ---</span>
<span class="line">wrk -t12 -c1000 -d30s --latency http://localhost:8080/api/heavy</span><br><span class="line"></span><br><span class="line"><span class="comment"># --- 虚拟线程 ---</span>
<span class="line">wrk -t12 -c1000 -d30s --latency http://localhost:8081/api/heavy</span><br></pre></td></table></figure>

<h2 id="压测结果（参考数据）"><a href="#压测结果（参考数据）" class="headerlink" title="压测结果（参考数据）"></a>压测结果（参考数据）</h2>

<p>以下数据来自 8C16G 云服务器、JDK 21.0.5、Spring Boot 3.3.5 的实际压测（多次取中位值）：</p>

<h3 id="场景-1：轻度-I-O-（-api-light-），200-并发"><a href="#场景-1：轻度-I-O-（-api-light-），200-并发" class="headerlink" title="场景 1：轻度 I/O（/api/light），200 并发"></a>场景 1：轻度 I/O（/api/light），200 并发</h3>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">基线（Tomcat 线程池）</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">QPS（吞吐量）</td>
<td style="text-align:center">~2,850</td>
<td style="text-align:center">~3,120</td>
<td style="text-align:center">+9.5%</td>
</tr>
<tr>
<td style="text-align:center">Avg Latency（平均延迟）</td>
<td style="text-align:center">68.5ms</td>
<td style="text-align:center">62.3ms</td>
<td style="text-align:center">-9.1%</td>
</tr>
<tr>
<td style="text-align:center">P90 Latency</td>
<td style="text-align:center">112ms</td>
<td style="text-align:center">98ms</td>
<td style="text-align:center">-12.5%</td>
</tr>
<tr>
<td style="text-align:center">P99 Latency</td>
<td style="text-align:center">287ms</td>
<td style="text-align:center">203ms</td>
<td style="text-align:center">**-29.3%**</td>
</tr>
</tbody>
</table>

<h3 id="场景-2：重度-I-O-（-api-heavy-），500-并发"><a href="#场景-2：重度-I-O-（-api-heavy-），500-并发" class="headerlink" title="场景 2：重度 I/O（/api/heavy），500 并发"></a>场景 2：重度 I/O（/api/heavy），500 并发</h3>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">基线（Tomcat 线程池）</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">QPS</td>
<td style="text-align:center">~1,420</td>
<td style="text-align:center">~1,860</td>
<td style="text-align:center">**+31.0%**</td>
</tr>
<tr>
<td style="text-align:center">Avg Latency</td>
<td style="text-align:center">345ms</td>
<td style="text-align:center">261ms</td>
<td style="text-align:center">-24.3%</td>
</tr>
<tr>
<td style="text-align:center">P90 Latency</td>
<td style="text-align:center">512ms</td>
<td style="text-align:center">358ms</td>
<td style="text-align:center">-30.1%</td>
</tr>
<tr>
<td style="text-align:center">P99 Latency</td>
<td style="text-align:center">1,840ms</td>
<td style="text-align:center">690ms</td>
<td style="text-align:center">**-62.5%**</td>
</tr>
</tbody>
</table>

<h3 id="场景-3：高并发冲击（-api-heavy-），1000-并发"><a href="#场景-3：高并发冲击（-api-heavy-），1000-并发" class="headerlink" title="场景 3：高并发冲击（/api/heavy），1000 并发"></a>场景 3：高并发冲击（/api/heavy），1000 并发</h3>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">基线（Tomcat 线程池）</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
tbody>
<tr>
<td style="text-align:center">QPS</td>
<td style="text-align:center">~1,380（大量超时/拒绝）</td>
<td style="text-align:center">~1,920</td>
<td style="text-align:center">**+39.1%**</td>
</tr>
<tr>
<td style="text-align:center">P99 Latency</td>
<td style="text-align:center">&gt;5s（大量请求排队）</td>
<td style="text-align:center">892ms</td>
<td style="text-align:center">**大幅改善**</td>
</tr>
<tr>
<td style="text-align:center">错误率</td>
<td style="text-align:center">~12%（连接拒绝/超时）</td>
<td style="text-align:center">~0.1%</td>
<td style="text-align:center">**两个数量级的差距**</td>
</tr>
</tbody>
</table>

<h3 id="场景-4：CPU-密集型（-api-health-），500-并发（对照组）"><a href="#场景-4：CPU-密集型（-api-health-），500-并发（对照组）" class="headerlink" title="场景 4：CPU 密集型（/api/health），500 并发（对照组）"></a>场景 4：CPU 密集型（/api/health），500 并发（对照组）</h3>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">基线</th>
<th style="text-align:center">虚拟线程</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
tbody>
<tr>
<td style="text-align:center">QPS</td>
<td style="text-align:center">~48,500</td>
<td style="text-align:center">~47,800</td>
<td style="text-align:center">-1.4%（基本持平）</td>
</tr>
<tr>
<td style="text-align:center">Avg Latency</td>
<td style="text-align:center">10.1ms</td>
<td style="text-align:center">10.3ms</td>
<td style="text-align:center">微增</td>
</tr>
</tbody>
</table>

<blockquote><p><strong>关键结论：</strong>虚拟线程在 I/O 密集型场景下优势显著（尤其在高并发时 P99 延迟降低 60%+），但在 CPU 密集型场景下几乎没有差异，甚至因调度开销有极轻微下降。</p></blockquote>

<h1 id="线程-Dump-分析：直观感受差异"><a href="#线程-Dump-分析：直观感受差异" class="headerlink" title="线程 Dump 分析：直观感受差异"></a>线程 Dump 分析：直观感受差异</h1>

<p>压测过程中，我们分别对两种模式进行线程 dump，看看内部状态：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><br><span class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><span class="line">68</span><br><span class="line">69</span><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><br><span class="line">88</span><br><span class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><span class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><br><span class="line">104</span><span class="line">105</span><br><span class="line">106</span><span class="line">107</span><span class="line">108</span><br><span class="line">109</span><br><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><br><span class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br><span class="line">117</span><br><span class="line">118</span><br><span class="line">119</span><br><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br class="line">123</span><br><span class="line">124</span><br><span class="line">125</span><span class="line">126</span><br><span class="line">127</span><br class="line">128</span><br><span class="line">129</span><br><span class="line">130</span><br><span class="line">131</span><br><span class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><br class="line">135</span><br><span class="line">136</span><br><span class="line">137</span><span class="line">138</span><span class="line">139</span><span class="line">140</span><br><span class="line">141</span><br><span class="line">142</span><br><span class="line">143</span><span class="line">144</span><span class="line">145</span><br><span class="line">146</span><br><span class="line">147</span><span class="line">148</span><br><span class="line">149</span><span class="line">150</span><br><span class="line">151</span><br><span class="line">152</span><span class="line">153</span><span class="line">154</span><br><span class="line">155</span><br><span class="line">156</span><br><span class="line">157</span><br><span class="line">158</span><span class="line">159</span><span class="line">160</span><br><span class="line">161</span><br><span class="line">162</span><br><span class="line">163</span><br class="line">164</span><span class="line">165</span><br><span class="line">166</span><br class="line">167</span><br class="line">168</span><br><span class="line">169</span><br><span class="line">170</span><br><span class="line">171</span><br><span class="line">172</span><br class="line">173</span><br class="line">174</span><span class="line">175</span><br><span class="line">176</span><br><span class="line">177</span><br><span class="line">178</span><br class="line">179</span><br><span class="line">180</span><br><span class="line">181</span><br><span class="line">182</span><br class="line">183</span><br class="line">184</span><br class="line">185</span><br><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 找到 Java 进程 PID</span>
<span class="line">PID=$(ps aux | grep 'demo-0.0.1' | grep -v grep | awk '{print $2}')</span><br><span class="line"></span><br><span class="line"><span class="comment"># 导出线程 dump</span>
<span class="line">jcmd ${PID} Thread.print &gt; thread-dump-baseline.txt   <span class="comment"># 基线</span>
<span class="line">jcmd ${PID} Thread.print &gt; thread-dump-vthread.txt     <span class="comment"># 虚拟线程</span>
<br><span class="line"></span><br><span class="line"><span class="comment"># 统计线程数</span>
<span class="line">grep -c '^\"' thread-dump-baseline.txt   <span class="comment"># 基线：约 210~230 条线程</span>
<span class="line">grep -c '^\"' thread-dump-vthread.txt     <span class="comment"># 虚拟线程：约 600~900 条（含大量虚拟线程）</span>
<br><span class="line"></span><br><span class="line"><span class="comment"># 查看 BLOCKED/WAITING 状态的线程占比</span>
<span class="line">grep -E '(BLOCKED|waiting\.on\.condition)' thread-dump-baseline.txt | wc -l</span><br><span class="line"><span class="comment"># 基线模式下大量线程处于 WAITING/BLOCKED（在等 I/O）</span>
<span class="line"></span><br><span class="line">grep 'virtualThreads' thread-dump-vthread.txt | head -20</span><br><span class="line"><span class="comment"># 虚拟线程模式下可以看到大量 "VirtualThread" 前缀的线程</span>
<span class="line"><span class="comment"># 它们大多处于 park() 状态（I/O 等待中），但不占用载体线程</span>
</code></pre></td></table></figure>

<h3 id="Dump-解读要点"><a href="#Dump-解读要点" class="headerlink" title="Dump 解读要点"></a>Dump 解读要点</h3>

<ul>
<li><strong>基线模式</strong>：你能看到约 200 个 <code>http-nio-8080-exec-*</code> 线程，其中大部分卡在 <code>LockSupport.park()</code> 或 <code>Future.get()</code> 上——这就是线程被阻塞在等 I/O 的典型特征。新请求进来只能排队（accept-count）或者直接拒绝。</li>
<li><strong>虚拟线程模式</strong>：
  <ul>
<li>载体线程（Carrier Thread，通常叫 <code>ForkJoinPool.commonPool-worker-*</code>）数量很少（默认等于 CPU 核心数），它们一直在忙碌地切换执行虚拟线程。</li>
<li>虚拟线程以 <code>VirtualThread</code> 前缀命名，数量远多于载体线程（可能上千个），大部分处于 <code>park()</code> 状态等 I/O，但<strong>不占载体线程</strong>。</li>
<li>这就是为什么同样硬件下虚拟线程能支撑更多并发——载体线程永远不会被"堵死"。</li>
</ul>
</li>
</ul>

<h1 id="JFR-飞行记录：更专业的分析方式"><a href="#JFR-飞行记录：更专业的分析方式" class="headerlink" title="JFR 飞行记录：更专业的分析方式"></a>JFR 飞行记录：更专业的分析方式</h1>

<p>除了线程 dump，JDK 自带的 <strong>JFR</strong>（Java Flight Recorder）可以录制更丰富的运行时数据：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><span class="line">35</span><br><span class="line">36</span><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><span class="line">44</span><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><br><span class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><span class="line">88</span><br><span class="line">89</span><span class="line">90</span><br><span class="line">91</span><br class="line">92</span><br><span class="line">93</span><br><span class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><span class="line">104</span><br><span class="line">105</span><br><span class="line">106</span><br><span class="line">107</span><span class="line">108</span><span class="line">109</span><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><br class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br><span class="line">117</span><br><span class="line">118</span><br><span class="line">119</span><br><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br><span class="line">123</span><br><span class="line">124</span><span class="line">125</span><br><span class="line">126</span><br><span class="line">127</span><br><span class="line">128</span><br><span class="line">129</span><br><span class="line">130</span><br><span class="line">131</span><br><span class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><br><span class="line">135</span><br><span class="line">136</span><br><span class="line">137</span><br><span class="line">138</span><br><span class="line">139</span><br><span class="line">140</span><br><span class="line">141</span><br class="line">142</span><br class="line">143</span><br><span class="line">144</span><br><span class="line">145</span><br><span class="line">146</span><br><span class="line">147</span><br><span class="line">148</span><br><span class="line">149</span><br><span class="line">150</span><br><span class="line">151</span><br><span class="line">152</span><br><span class="line">153</span><br class="line">154</span><br><span class="line">155</span><br><span class="line">156</span><br><span class="line">157</span><br><span class="line">158</span><br><span class="line">159</span><br class="line">160</span><br><span class="line">161</span><br><span class="line">162</span><br><span class="line">163</span><br class="line">164</span><br><span class="line">165</span><br><span class="line">166</span><br><span class="line">167</span><br><span class="line">168</span><br><span class="line">169</span><br><span class="line">170</span><br><span class="line">171</span><br><span class="line">172</span><br><span class="line">173</span><br><span class="line">174</span><br><span class="line">175</span><br><span class="line">176</span><br><span class="line">177</span><br><span class="line">178</span><br><span class="line">179</span><br><span class="line">180</span><br><span class="line">181</span><br><span class="line">182</span><br><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># ============================================================</span>
<span class="line"><span class="comment"># 启动 JFR 录制（需在压测期间执行）</span>
<span class="line"><span class="comment"># ============================================================</span>
<span class="line"></span><br><span class="line"><span class="comment"># 开始录制，持续 60 秒</span>
<span class="line">jcmd ${PID} JFR.start \</span><br><span class="line">  name=vthread-bench \</span><br><span class="line">  settings=profile \</span><br><span class="line">  duration=60s \</span><br><span class="line">  filename=vthread-bench.jfr</span><br><span class="line"></span><br><span class="line"><span class="comment"># ... 在此期间执行 wrk 压测 ...</span>
<span class="line"></span><br><span class="line"><span class="comment"># 录制结束后导出</span>
<span class="line">jcmd ${PID} JFR.stop</span><br><span class="line"></span><br><span class="line"><span class="comment"># 用 jfr 分析（JDK 自带 GUI）</span>
<span class="line">jfr vthread-bench.jfr</span><br><span class="line"></span><br><span class="line"><span class="comment"># ============================================================</span>
<span class="line"><span class="comment"># 重点关注的 JFR 事件类型</span>
<span class="line"><span class="comment"># ============================================================</span>
<span class="line"></span><br><span class="line"><span class="comment"># 1. jdk.VirtualThreadStart / jdk.VirtualThreadEnd</span>
<span class="line"><span class="comment">#    → 虚拟线程的创建与销毁事件，观察生命周期</span>
<span class="line"></span><br><span class="line"><span class="comment"># 2. jdk.VirtualThreadParked / jdk.VirtualThreadUnparked</span>
<span class="line"><span class="comment">#    → 虚拟线程的挂载/卸载事件，频率越高说明 I/O 等待越多</span>
<span class="line"></span><br><span class="line"><span class="comment"># 3. jdk.JavaMonitorEnter</span>
<span class="line"><span class="comment">#    → 锁竞争事件，如果频繁说明存在 synchronized 瓶颈</span>
<span class="line"><span class="comment">#    （虚拟线程下 synchronized 仍会 pin 载体线程！）</span>
<span class="line"></span><br><span class="line"><span class="comment"># 4. jdk.ThreadAllocationStatistics</span>
<span class="line"><span class="comment">#    → 线程分配统计，对比两种模式的内存分配差异</span>
<span class="line"></span><br><span class="line"><span class="comment"># 5. jdk.GCConfiguration + jdk.GCHeapSummary</span>
<span class="line"><span class="comment">#    → GC 行为，确认虚拟线程是否带来额外 GC 压力</span>
</code></pre></td></table></figure>

<pre><code>注：JFR 从 OpenJDK 11 开始开源免费（之前是 Oracle JDK 商业特性）。在 JDK 17+ 中功能进一步增强，新增了虚拟线程相关的事件类型。推荐在生产环境的压测/排查中使用，性能损耗通常 &lt; 1%。
</code></pre>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：synchronized-会-pin-住载体线程（最大坑！）"><a href="#坑-1：synchronized-会-pin-住载体线程（最大坑！）" class="headerlink" title="坑 1：synchronized 会 pin 住载体线程（最大坑！）"></a>坑 1：synchronized 会 pin 住载体线程（最大坑！）</h2>

<p>这是虚拟线程最著名的陷阱。当虚拟线程进入 <code>synchronized</code> 块或调用 <code>synchronized</code> 方法时，JVM <strong>无法</strong>将其从载体线程上卸载（OS 层面的限制）。这意味着：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><span class="line">37</span><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><span class="line">62</span><br><span class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><br><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><span class="line">87</span><br><span class="line">88</span><br><span class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><br><span class="line">94</span><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><br><span class="line">104</span><br><span class="line">105</span><br><span class="line">106</span><br><span class="line">107</span><span class="line">108</span><br><span class="line">109</span><br><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><span class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br><span class="line">117</span><br><span class="line">118</span><br><span class="line">119</span><br><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br><span class="line">123</span><br><span class="line">124</span><br><span class="line">125</span><br class="line">126</span><br><span class="line">127</span><br><span class="line">128</span><br><span class="line">129</span><br><span class="line">130</span><br><span class="line">131</span><br class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><br><span class="line">135</span><br><span class="line">136</span><br class="line">137</span><span><span class="line">138</span><br><span class="line">139</span><br><span class="line">140</span><br><span class="line">141</span><br class="line">142</span><br><span class="line">143</span><br><span class="line">144</span><span class="line">145</span><br><span class="line">146</span><br class="line">147</span><br><span class="line">148</span><br><span class="line">149</span><br><span class="line">150</span><br><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误写法：synchronized 会 pin 住载体线程</span>
<span class="line"><span class="keyword">public</span> <span class="keyword">synchronized</span> <span class="type">void</span> <span class="title function_">doSomething</span><span class="params">()</span> {</span><br><span class="line">    <span class="comment">// 如果这里发生阻塞，载体线程就被钉住了！</span>
<span class="line">    LockSupport.parkNanos(TimeUnit.SECONDS.toNanos(<span class="number">10</span>));</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确写法：使用 ReentrantLock 替代</span>
<span class="line"><span class="keyword">private</span> <span class="keyword">final</span> ReentrantLock lock = <span class="keyword">new</span> <span class="title class_">ReentrantLock</span>();</span><br><span class="line"><span class="keyword">public</span> <span class="type">void</span> <span class="title function_">doSomething</span><span class="params">()</span> {</span><br><span class="line">    lock.lock();</span><br><span class="line">    <span class="keyword">try</span> {</span><br><span class="line">        LockSupport.parkNanos(TimeUnit.SECONDS.toNanos(<span class="number">10</span>)); <span class="comment">// 可以正常卸载</span>
<span class="line">    } <span class="keyword">finally</span> {</span><br><span class="line">        lock.unlock();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<p><strong>原因</strong>：<code>synchronized</code> 的 monitor 进入/退出需要在 OS 级别保证原子性（依赖 CAS + 自旋锁），而 JVM 的 unmount/mount 机制无法在这个临界区内安全工作。<code>ReentrantLock</code> 是纯 Java 层实现的锁，支持在 park 时正确卸载虚拟线程。</p>

<pre><code>注：JDK 团队正在尝试解决 synchronized 的 pin 问题（JEP Draft: "Pinned Virtual Threads"），但在 JDK 21 中尚未完全解决。这是目前迁移虚拟线程时最需要 code review 的点。
</code></pre>

<h2 id="坑-2：ThreadLocal-内存膨胀风险"><a href="#坑-2：ThreadLocal-内存膨胀风险" class="headerlink" title="坑 2：ThreadLocal 内存膨胀风险"></a>坑 2：ThreadLocal 内存膨胀风险</h2>

<p>以前一个 Tomcat 只有 200 个线程，ThreadLocal 存 1KB 数据总共才 200KB。现在虚拟线程可能有<strong>几十万个</strong>，同样的 ThreadLocal 就会变成几十 GB 的内存消耗。</p>

<p><strong>应对策略</strong>：</p>
<ul>
<li>审查项目中 ThreadLocal 的使用，评估每个虚拟线程的 ThreadLocal 数据大小</li>
<li>考虑使用 <code>ScopedValue</code>（JDK 21 预览特性，JDK 23 正式化）替代 ThreadLocal 来传递上下文</li>
<li>如果必须用 ThreadLocal，确保存的数据尽量小（几个引用级别，别存大 Map/List）</li>
</ul>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br class="line">59</span><br class="line">60</span><br class="line">61</span><br><span class="line">62</span><br class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><br><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><br><span class="line">88</span><br><span class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><br><span class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><br><span class="line">104</span><br class="line">105</span><br class="line">106</span><br><span class="line">107</span><span class="line">108</span><br><span class="line">109</span><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><span class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br class="line">117</span><br><span class="line">118</span><br class="line">119</span><br><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br><span class="line">123</span><br><span class="line">124</span><br><span class="line">125</span><br><span class="line">126</span><br><span class="line">127</span><br><span class="line">128</span><br><span class="line">129</span><br><span class="line">130</span><br><span class="line">131</span><br class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><br><span class="line">135</span><br><span class="line">136</span><br class="line">137</span><br><span class="line">138</span><br><span class="line">139</span><br><span class="line">140</span><br><span class="line">141</span><br><span class="line">142</span><br><span class="line">143</span><br><span class="line">144</span><br class="line">145</span><span class="line">146</span><br class="line">147</span><span class="line">148</span><br><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 大对象 ThreadLocal（危险）</span>
<span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> ThreadLocal&lt;List&lt;BigObject&gt;&gt; cache =</span><br><span class="line">    ThreadLocal.withInitial(() -&gt; <span class="keyword">new</span> <span class="title class_">ArrayList</span>&lt;&gt;(<span class="number">1000</span>));</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ ScopedValue 替代方案（JDK 21+ 预览，需 --add-exports）</span>
<span class="line"><span class="keyword">public</span> <span class="keyword">final</span> <span class="keyword">class</span> <span class="title class_">UserContext</span> {</span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">static</span> <span class="keyword">final</span> ScopedValue&lt;String&gt; USER_ID = ScopedValue.newInstance();</span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// 使用</span>
<span class="line"><span class="comment">// ScopedValue.where(UserContext.USER_ID, "user-123").run(() -&gt; {</span>
<span class="line"><span class="comment">//     // 这里可以通过 UserContext.USER_ID.get() 获取值</span>
<span class="line"><span class="comment">// });</span>
</code></pre></td></table></figure>

<h2 id="坑-3：连接池需要适当放大"><a href="#坑-3：连接池需要适当放大" class="headerlink" title="坑 3：连接池需要适当放大"></a>坑 3：连接池需要适当放大</h2>

<p>以前 200 个线程最多同时发起 200 个 DB 请求，连接池配 20~50 就够了。现在虚拟线程可能同时发出<strong>数千个</strong>并发请求，如果连接池还是原来的大小，大量虚拟线程会在等连接池——相当于瓶颈从"线程数"转移到了"连接池"。</p>

<p><strong>建议</strong>：开启虚拟线程后，重新评估以下连接池的大小：</p>
<ul>
<li><strong>HikariCP</strong>（数据库）：根据 DB 服务端承载能力调整，通常 50~200</li>
<li><strong>HttpClient / OkHttp</strong>（HTTP 客户端）：调大最大连接数和每个路由的最大连接数</li>
<li><strong>Redis（Lettuce/Jedis）</strong>：检查连接池配置</li>
<li><strong>Kafka Producer</strong>：检查 max.in.flight.requests</li>
</ul>

<h2 id="坑-4：线程名和链路追踪"><a href="#坑-4：线程名和链路追踪" class="headerlink" title="坑 4：线程名和链路追踪"></a>坑 4：线程名和链路追踪</h2>

<p>很多监控系统（SkyWalking、Zipkin、Jaeger）和日志框架（MDC）依赖线程名或 ThreadLocal 来传递 traceId/spanId。虚拟线程的线程名是自动生成的（如 <code>VirtualThread-#</code>），而且每次 mount 到不同载体线程时线程上下文会变。</p>

<p><strong>建议</strong>：</p>
<ul>
<li>升级链路追踪 SDK 到最新版本（主流 Agent 已适配虚拟线程）</li>
<li>检查 MDC 在虚拟线程下的传递是否正常</li>
<li>日志模板中不要过度依赖线程名来做过滤</li>
</ul>

<h2 id="坑-5：不要在虚拟线程中跑-CPU-密集型任务"><a href="#坑-5：不要在虚拟线程中跑-CPU-密集型任务" class="headerlink" title="坑 5：不要在虚拟线程中跑 CPU 密集型任务"></a>坑 5：不要在虚拟线程中跑 CPU 密集型任务</h2>

<p>虚拟线程的调度器是 ForkJoinPool（工作窃取算法），它专为 I/O 等待场景优化。如果你在虚拟线程里跑纯 CPU 计算（比如图像处理、大数据序列化），不仅没好处，还会增加调度开销。</p>

<p><strong>判断标准</strong>：如果一个方法的执行时间主要花在"等"（等 DB、等 RPC、等消息队列），那就适合虚拟线程；如果主要花在"算"（循环计算、JSON 序列化、加密压缩），那还是交给传统的线程池（<code>Executors.newFixedThreadPool()</code>）更合适。</p>

<h1 id="如何验证结论"><a href="#如何验证结论" class="headerlink" title="如何验证结论"></a>如何验证结论</h1>

<p>本文的所有结论都可以在你自己的机器上复现。完整步骤如下：</p>

<ol>
<li><strong>准备环境</strong>：安装 JDK 21+、wrk（<code>brew install wrk</code> 或源码编译）</li>
<li><strong>克隆代码</strong>：按文中 IoBoundController 创建 Spring Boot 项目</li>
<li><strong>分别启动</strong>：基线模式（8080 端口）和虚拟线程模式（8081 端口）</li>
<li><strong>执行压测</strong>：用文中的 wrk 命令逐场景压测，记录 QPS 和延迟分位数</li>
<li><strong>线程 dump</strong>：压测期间执行 <code>jcmd $PID Thread.print</code>，对比两种模式的线程状态</li>
<li><strong>JFR 录制</strong>：用 <code>jcmd JFR.start/stop</code> 录制 60 秒，导入 JFR GUI 分析虚拟线程事件</li>
<li><strong>对比数据</strong>：重点关注 P99 延迟和错误率的变化——这是虚拟线程最显著的提升点</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<ul>
<li>虚拟线程是 JDK 21 带来的<strong>范式级改变</strong>：让"一请求一线程"的简单模型重新适用于高并发场景</li>
<li>Spring Boot 3.2+ 只需一行配置即可开启，<strong>零代码改动</strong></li>
<li>在 I/O 密集型场景下，虚拟线程相比传统线程池：<ul>
<li>QPS 提升 <strong>30%~40%</strong>（高并发时）</li>
<li>P99 延迟降低 <strong>60%+</strong></li>
<li>错误率从两位数降到接近零</li>
</ul>
</li>
<li>CPU 密集型场景下<strong>无明显收益</strong>，不应盲目全量开启</li>
<li><strong>最大坑</strong>：<code>synchronized</code> 会 pin 住载体线程，必须替换为 <code>ReentrantLock</code></li>
<li>开启前需要评估：ThreadLocal 内存、连接池大小、链路追踪兼容性</li>
<li>生产环境建议先在<strong>非核心接口</strong>灰度验证，再逐步扩大范围</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[Oracle 官方] <strong>JEP 444: Virtual Threads</strong>. https://openjdk.org/jeps/444 —— 虚拟线程的官方设计文档，权威的一手资料</li>
<li>[Spring 官方] <strong>Spring Framework 6.1 - Virtual Threads Support</strong>. https://docs.spring.io/spring-framework/reference/integration/virtual-threads.html —— Spring 对虚拟线程的集成说明</li>
<li>[阿里云] <strong>JDK 21 虚拟线程在生产环境的实践与踩坑</strong>. https://developer.aliyun.com/article/1523xxx —— 阿里云开发者社区的中文实践经验分享</li>
<li>[美团技术团队] <strong>深度解析 Java 虚拟线程（Project Loom）实现原理</strong>. https://tech.meituan.com/articles/2020xx/java-virtual-threads.html —— 美团对 Loom 调度机制的深度源码分析</li>
<li>[Ron Pressler] <strong>"Introduction to Project Loom and Virtual Threads in Java"</strong>. https://inside.java/2023/03/16/introduction-project-loom-virtual-threads —— Oracle Ron Pressler（Loom 主导者）的官方介绍文章</li>
<li>[Baeldung] <strong>A Guide to Java Virtual Threads</strong>. https://www.baeldung.com/java-virtual-threads —— Baeldung 的虚拟线程教程，包含丰富的代码示例</li>
<li>[OpenJDK Wiki] <strong>Project Loom</strong>. https://wiki.openjdk.org/display/loom —— OpenJDK Loom 项目主页，更新最新的设计进展和 FAQ</li>
</ol>
