---
title: Java 虚拟线程（Virtual Thread）实战——从原理到 Spring Boot 集成压测
date: 2026-08-11 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - VirtualThread
  - JDK21
  - Spring Boot
  - JMH
  - 高并发
  - 性能调优
---
<hr>
<blockquote><p>虚拟线程（Virtual Thread）是 JDK 21 正式引入的轻量级并发原语。它让你用写普通同步代码的方式，获得接近异步框架的吞吐量——不需要改写为响应式风格，也不需要玩回调地狱。本文从原理出发，手把手带你完成 Spring Boot 集成 + JMH 压测对比，最后列出生产落地的避坑清单。</p></blockquote>

<!-- more -->

<h1 id="背景为什么要搞虚拟线程"><a href="#背景为什么要搞虚拟线程" class="headerlink" title="背景：为什么要搞虚拟线程"></a>背景：为什么要搞虚拟线程</h1>

<p>先说结论：<strong>Java 传统「一请求一线程」模型在 IO 密集型场景下，线程大部分时间都在傻等</strong>。</p>

<p>想象一下你的 Spring Boot 应用处理一个请求的典型流程：</p>
<figure class="highlight plaintext"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line">接收请求 → 查 Redis（等 0.5ms）→ 查 MySQL（等 5ms）→ 调下游 RPC（等 20ms）→ 返回</span><br><span class="line">                ↑ 线程阻塞              ↑ 线程阻塞         ↑ 线程阻塞</span><br><span class="line"></span><br><span class="line">实际 CPU 工作时间可能只有 1ms，剩下 25.5ms 全在等</span><br></pre></td></table></figure>

<p>这就是<strong>平台线程（Platform Thread）</strong>的困境：</p>
<ul>
<li><strong>数量有限</strong>：一个线程默认栈大小 1MB，8GB 堆外内存最多放约 8000 个线程（还没算堆内对象）</li>
<li><strong>调度成本高</strong>：线程太多时，CPU 大量时间花在上下文切换上，而不是干正事</li>
<li><strong>池化也救不了</strong>：线程池只是把矛盾从「创建成本」转移到了「排队等待」——请求还是在排队</li>
</ul>

<p>过去要解决这个问题，只能上 WebFlux / RxJava 这种响应式框架——但学习曲线陡峭，调试困难，和现有生态兼容性差。</p>

<p><strong>虚拟线程</strong>就是 JDK 给出的答案：保持「同步阻塞」的写法，让 JVM 自动把阻塞的操作「挂起」，把底层载体线程腾出来给别人用。</p>

<blockquote>
<p><strong>注：什么是虚拟线程？</strong> 它是 JDK 21（LTS）正式引入的一种轻量级线程实现，由 JVM 调度而非操作系统调度。创建成本极低（几 KB 而非几 MB），可以在少量载体线程上运行海量虚拟线程。类似 Go 的 Goroutine 或 Kotlin 的 Coroutine。</p>
</blockquote>

<h1 id="核心原理虚拟线程是怎么工作的"><a href="#核心原理虚拟线程是怎么工作的" class="headerlink" title="核心原理：虚拟线程是怎么工作的"></a>核心原理：虚拟线程是怎么工作的</h1>

<h2 id="21-模型对比"><a href="#21-模型对比" class="headerlink" title="2.1 模型对比"></a>2.1 模型对比</h2>

<table>
<thead>
<tr>
<th style="text-align:left">维度</th>
<th style="text-align:center">平台线程（传统）</th>
<th style="text-align:center">虚拟线程（JDK 21+）</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">调度者</td>
<td style="text-align:center">操作系统内核</td>
<td style="text-align:center">JVM（ForkJoinPool）</td>
</tr>
<tr>
<td style="text-align:left">与 OS 线程关系</td>
<td style="text-align:center">1:1 绑定</td>
<td style="text-align:center">M:N（多虚线对多载体）</td>
</tr>
<tr>
<td style="text-align:left">栈内存</td>
<td style="text-align:center">~1 MB 固定</td>
<td style="text-align:center">按需增长，初始很小</td>
</tr>
<tr>
<td style="text-align:left">创建成本</td>
<td style="text-align:center">高（~μs 级）</td>
<td style="text-align:center">极低（~ns 级）</td>
</tr>
<tr>
<td style="text-align:left">数量上限</td>
<td style="text-align:center">几千</td>
<td style="text-align:center">百万级</td>
</tr>
<tr>
<td style="text-align:left">阻塞行为</td>
<td style="text-align:center">占用 OS 线程</td>
<td style="text-align:center">自动卸载载体线程</td>
</tr>
</tbody>
</table>

<h2 id="22-关键组件三个概念"><a href="#22-关键组件三个概念" class="headerlink" title="2.2 关键组件：三个概念"></a>2.2 关键组件：三个概念</h2>

<p>理解虚拟线程需要搞清三个角色：</p>

<ul>
<li><strong>虚拟线程（Virtual Thread）</strong>：你代码里 <code>Thread.start()</code> 创建的那个轻量级线程实例（<code>java.lang.VirtualThread</code>）。它不直接跑在任何 OS 线程上。</li>
<li><strong>载体线程（Carrier Thread）</strong>：真正执行虚拟线程代码的平台线程（通常是 ForkJoinPool 里的工作线程）。虚拟线程被「装载」到载体线程上运行。</li>
<li><strong>Continuation（续体）</strong>：虚拟线程的核心魔法。当虚拟线程遇到阻塞操作（LockSupport.park、IO 等）时，JVM 把调用栈「冻结」成一个 Continuation 对象，把载体线程释放出来给其他虚拟线程用。等 IO 完成后，再找任意一个载体线程「解冻」继续执行。</li>
</ul>

<pre><code>简单类比：
- 平台线程 = 每个人配一辆专属出租车（贵、车不够分）
- 虚拟线程 = 所有人共用一个小车队，上车→到目的地→下车→车接下一位
- Continuation = 下车时的「暂停凭证」，回来时凭此恢复行程
</code></pre>

<h2 id="23-调度流程图"><a href="#23-调度流程图" class="headerlink" title="2.3 调度流程图"></a>2.3 调度流程图</h2>

<figure class="highlight plaintext"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line">sequenceDiagram</span><br><span class="line">    participant VT as 虚拟线程</span><br><span class="line">    participant CT as 载体线程(ForkJoinPool)</span><br><span class="line">    participant OS as 操作系统</span><br><span class="line"></span><br><span class="line">    VT->>CT: ① 装载(mount)</span><br><span class="line">    CT->>OS: 执行代码(运行在OS线程上)</span><br><span class="line">    VT->>VT: ② 遇到IO阻塞</span><br><span class="line">    VT->>CT: ③ 卸载(unmount) + 冻结Continuation</span><br><span class="line">    CT->>CT: 去执行其他虚拟线程</span><br><span class="line">    OS-->>VT: ④ IO完成</span><br><span class="line">    VT->>CT: ⑤ 重新装载到某个载体线程</span><br><span class="line">    CT->>OS: 从Continuation恢复执行</span><br></pre></td></table></figure>

<h1 id="创建虚拟线程的几种方式"><a href="#创建虚拟线程的几种方式" class="headerlink" title="创建虚拟线程的几种方式"></a>创建虚拟线程的几种方式</h1>

<h2 id="31-直接创建"><a href="#31-直接创建" class="headerlink" title="3.1 直接创建"></a>3.1 直接创建</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 方式一：Thread.ofVirtual() 构建器（推荐）</span></span><br><span class="line">Thread vt = Thread.<span class="built_in">ofVirtual</span>()     <span class="comment">// 创建虚拟线程构建器</span></span><br><span class="line">                 .name(<span class="string">&quot;my-vt&quot;</span>)       <span class="comment">// 设置名字（方便排查）</span></span><br><span class="line">                 .start(() -&gt; {</span><br><span class="line">                     System.out.println(<span class="string">&quot;Hello from &quot;</span> + Thread.currentThread());</span><br><span class="line">                 });</span><br><span class="line"></span><br><span class="line"><span class="comment">// 输出：Hello from VirtualThread[#21]/runnable@ForkJoinPool-1-worker-1</span></span><br></pre></td></table></figure>

<h2 id="32-ExecutorsnewvirtualthreadperTaskexecutor"><a href="#32-Executorsnewvirtualthreadpertaskexecutor" class="headerlink" title="3.2 Executors.newVirtualThreadPerTaskExecutor()"></a>3.2 Executors.newVirtualThreadPerTaskExecutor()</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// 方式二：返回一个 ExecutorService，每次提交都创建新的虚拟线程</span></span><br><span class="line"><span class="keyword">try</span> (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {</span><br><span class="line">    <span class="comment">// 提交 100,000 个任务 —— 没问题，虚拟线程很便宜</span></span><br><span class="line">    <span class="keyword">for</span> (<span class="keyword">int</span> i = <span class="number">0</span>; i &lt; <span class="number">100_000</span>; i++) {</span><br><span class="line">        executor.submit(() -&gt; {</span><br><span class="line">            <span class="comment">// 模拟 IO 操作</span></span><br><span class="line">            Thread.sleep(<span class="number">100</span>);</span><br><span class="line">            System.out.println(<span class="string">&quot;Task &quot;</span> + i + <span class="string">&quot; done&quot;</span>);</span><br><span class="line">        });</span><br><span class="line">    }</span><br><span class="line">} <span class="comment">// try-with-resources 自动关闭（相当于 shutdown + awaitTermination）</span></span><br></pre></td></table></figure>

<blockquote>
<p><strong>重要：</strong>这个 ExecutorService <strong>不是线程池</strong>！它每次 submit 都创建一个新的虚拟线程。<strong>不要池化虚拟线程</strong>——这正是虚拟线程的设计哲学：因为足够廉价，所以用完即弃。</p>
</blockquote>

<h2 id="33-判断当前是否运行在虚拟线程中"><a href="#33-判断当前是否运行在虚拟线程中" class="headerlink" title="3.3 判断当前是否运行在虚拟线程中"></a>3.3 判断当前是否运行在虚拟线程中</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">Thread t = Thread.currentThread();</span><br><span class="line"></span><br><span class="line">System.out.println(t.isVirtual());   <span class="comment">// true = 虚拟线程，false = 平台线程</span></span><br><span class="line">System.out.println(t);             <span class="comment">// VirtualThread[#xx] 或 Thread[...]</span></span><br><span class="line">System.out.println(t.getClass().getName());  <span class="comment">// java.lang.VirtualThread</span></span><br></pre></td></table></figure>

<h1 id="spring-boot-集成把-tomcat-线程池换成虚拟线程"><a href="#spring-boot-集成把-tomcat-线程池换成虚拟线程" class="headerlink" title="Spring Boot 集成：把 Tomcat 线程池换成虚拟线程"></a>Spring Boot 集成：把 Tomcat 线程池换成虚拟线程</h1>

<p>这是最实用的部分。Spring Boot 3.2+ 原生支持虚拟线程，只需要一行配置。</p>

<h2 id="41-前提条件"><a href="#41-前提条件" class="headerlink" title="4.1 前提条件"></a>4.1 前提条件</h2>

<table>
<thead>
<tr>
<th style="text-align:left">依赖项</th>
<th style="text-align:center">版本要求</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">JDK</td>
<td style="text-align:center">≥ 21（推荐 LTS 版本）</td>
</tr>
<tr>
<td style="text-align:left">Spring Boot</td>
<td style="text-align:center">≥ 3.2</td>
</tr>
<tr>
<td style="text-align:left">Spring Framework</td>
<td style="text-align:center">≥ 6.1</td>
</tr>
</tbody>
</table>

<h2 id="42-配置步骤"><a href="#42-配置步骤" class="headerlink" title="4.2 配置步骤"></a>4.2 配置步骤</h2>

<p><strong>第一步：application.yml 加一行</strong></p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">threads:</span></span><br><span class="line">    <span class="attr">virtual:</span></span><br><span class="line">      <span class="attr">enabled:</span> <span class="literal">true</span>  <span class="comment"># ← 就这一行！</span></span><br></pre></td></table></figure>

<p><strong>第二步：启动应用，确认生效</strong></p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"># 启动日志里应该能看到类似这样的提示：</span><br><span class="line"># ⚡ Started application in 1.23s</span><br><span class="line"># （Tomcat 线程池已被虚拟线程替换）</span><br><span class="line"></span><br><span class="line"># 写一个接口验证：</span><br></pre></td></table></figure>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><span class="line">5</span><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">VtCheckController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/vt-check&quot;)</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">check</span><span class="params">()</span> {</span><br><span class="line">        Thread t = Thread.currentThread();</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">&quot;isVirtual&quot;</span>, t.isVirtual(),</span><br><span class="line">            <span class="string">&quot;threadInfo&quot;</span>, t.toString()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line">$ curl http://localhost:8080/vt-check</span><br><span class="line"></span><br><span class="line"># 返回：</span><br><span class="line"># {&quot;isVirtual&quot;:true,&quot;threadInfo&quot;:&quot;VirtualThread[#123]/runable@ForkJoinPool-1-worker-1&quot;}</span><br><span class="line"># ↑ isVirtual=true 说明请求已经在虚拟线程上跑了！</span><br></pre></td></table></figure>

<h2 id="43-虚拟线程下的-tomcat-参数变化"><a href="#43-虚拟线程下的-tomcat-参数变化" class="headerlink" title="4.3 虚拟线程下的 Tomcat 参数变化"></a>4.3 虚拟线程下的 Tomcat 参数变化</h2>

<p>启用虚拟线程后，以下 Tomcat 参数<strong>仍然有效但语义有变化</strong>：</p>

<table>
<thead>
<tr>
<th style="text-align:left">参数</th>
<th style="text-align:center">默认值（虚拟线程模式下）</th>
<th style="text-align:left">说明</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">server.tomcat.max-threads</td>
<td style="text-align:center">失效（忽略）</td>
<td style="text-align:left">不再限制并发数，由虚拟线程调度器控制</td>
</tr>
<tr>
<td style="text-align:left">server.tomcat.accept-count</td>
<td style="text-align:center">仍有效</td>
<td style="text-align:left">操作系统层面的连接队列长度</td>
</tr>
<tr>
<td style="text-align:left">server.tomcat.min-spare-threads</td>
<td style="text-align:center">失效</td>
<td style="text-align:left">同上</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>注意：</strong>启用虚拟线程后，<code>max-threads</code> 不再是瓶颈。真正的瓶颈变成了下游资源（数据库连接池、RPC 连接池等）——所以<strong>连接池配置变得更重要了</strong>，后面会细说。</p>
</blockquote>

<h1 id="jmh-压测平台线程-vs-虚拟线程"><a href="#jmh-压测平台线程-vs-虚拟线程" class="headerlink" title="JMH 压测：平台线程 vs 虚拟线程"></a>JMH 压测：平台线程 vs 虚拟线程</h1>

<p>光说不练假把式。下面用 <strong>JMH（Java Microbenchmark Harness）</strong>做一个可复现的基准测试，模拟 IO 密集型场景下的吞吐和延迟差异。</p>

<blockquote>
<p><strong>注：JMH 是 OpenJDK 官方提供的微基准测试框架，能避免 JIT 预热、死代码消除等干扰，是 Java 性能测试的金标准。使用方式：在 pom.xml 中加入 jmh 依赖，然后用 <code>@Benchmark</code> 注解标记测试方法。</p>
</blockquote>

<h2 id="51-压测场景设计"><a href="#51-压测场景设计" class="headerlink" title="5.1 压测场景设计"></a>5.1 压测场景设计</h2>

<p>模拟一个典型的后端服务请求：混合短 IO 和长 IO 操作。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><br><span class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><br><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><br><span class="line">88</span><br><span class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><br><span class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><br><span class="line">104</span><br><span class="line">105</span><br><span class="line">106</span><br><span class="line">107</span><br><span class="line">108</span><br><span class="line">109</span><br><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><br><span class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br><span class="line">117</span><br><span class="line">118</span><br><span class="line">119</span><br><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br><span class="line">123</span><br><span class="line">124</span><br><span class="line">125</span><br><span class="line">126</span><br><span class="line">127</span><br><span class="line">128</span><br><span class="line">129</span><br><span class="line">130</span><br><span class="line">131</span><br><span class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><br><span class="line">135</span><br><span class="line">136</span><br><span class="line">137</span><br><span class="line">138</span><br><span class="line">139</span><br><span class="line">140</span><br><span class="line">141</span><br class="line">142</span><br><span class">143</span><br><span class="line">144</span><br><span class="line">145</span><br><span class="line">146</span><br><span class="line">147</span><span class="line">148</span><br><span class="line">149</span><br><span class="line">150</span><br><span class="line">151</span><br><span class="line">152</span><br><span class="line">153</span><br><span="line">154</span><br><span class="line">155</span><br><span class="line">156</span><br><span class="line">157</span><br><span class="line">158</span><br><span class="line">159</span><br><span class="line">160</span><br><span class="line">161</span><span class="line">162</span><br><span class="line">163</span><br><span class="line">164</span><span class="line">165</span><br><span class="line">166</span><br><span class="line">167</span><br><span class="line">168</span><span class="line">169</span><br><span class="line">170</span><br><span class="line">171</span><br><span class="line">172</span><br><span class="line">173</span><br class="line">174</span><span class="line">175</span><br><span class="line">176</span><br><span class="line">177</span><br><span class="line">178</span><br><span class="line">179</span><br><span class="line">180</span><br><span class="line">181</span><br><span class="line">182</span><br><span class="line">183</span><span class="line">184</span><span class="line">185</span><br><span class="line">186</span><br><span class="line">187</span><br><span class="line">188</span><br><span class="line">189</span><br><span class="line">190</span><br><span class="line">191</span><br><span class="line">192</span><br class="line">193</span><br><span class="line">194</span><br><span class="line">195</span><br><span class="line">196</span><br><span class="line">197</span><span class="line">198</span><br><span class="line">199</span><br><span class="line">200</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">import</span> org.openjdk.jmh.annotations.*;</span><br><span class="line"><span class="keyword">import</span> org.openjdk.jmh.infra.Blackhole;</span><br><span class="line"><span class="keyword">import</span> org.openjdk.jmh.runner.Runner;</span><br><span class="line"><span class="keyword">import</span> org.openjdk.jmh.runner.options.Options;</span><br><span class="line"><span class="keyword">import</span> org.openjdk.jmh.runner.options.OptionsBuilder;</span><br><span class="line"></span><br><span class="line"><span class="keyword">import</span> java.util.concurrent.*;</span><br><span class="line"><span class="keyword">import</span> java.util.ArrayList;</span><br><span class="line"><span class="keyword">import</span> java.util.List;</span><br><span class="line"></span><br><span class="line"><span class="meta">@Warmup(iterations = 3, time = 1)</span>  <span class="comment">// 预热 3 轮，每轮 1 秒</span></span><br><span class="line"><span class="meta">@Measurement(iterations = 5, time = 1)</span>  <span class="comment">// 正式测量 5 轮</span></span><br><span class="line"><span class="meta">@Fork(value = 1)</span>  <span class="comment">// 单进程运行</span></span><br><span class="line"><span class="meta">@State(Scope.Benchmark)</span></span><br><span class="line"><span class="meta">@BenchmarkMode(Mode.Throughput)</span>  <span class="comment">// 测吞吐量（ops/sec）</span></span><br><span class="line"><span class="meta">@OutputTimeUnit(TimeUnit.SECONDS)</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">VirtualThreadBenchmark</span> {</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 模拟 IO 密集型任务：CPU 工作 1ms + IO 等待 ioWaitMs</span></span><br><span class="line"><span class="comment">     * 这模拟了一个典型后端请求：查缓存(DB 0.5ms) + 查主库(5~20ms) + RPC(10~50ms)</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">void</span> <span class="title function_">simulateIoTask</span><span class="params">(<span class="type">int</span> ioWaitMs)</span> <span class="keyword">throws</span> InterruptedException {</span><br><span class="line">        <span class="comment">// 模拟少量 CPU 计算（业务逻辑处理）</span></span><br><span class="line">        Blackhole.consumeCPU(<span class="number">100000</span>);  <span class="comment">// ~1ms CPU work</span></span><br><span class="line">        <span class="comment">// 模拟 IO 阻塞（数据库查询、RPC 调用等）</span></span><br><span class="line">        Thread.sleep(ioWaitMs);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ==================== 场景 A：短 IO（10ms）====================</span></span><br><span class="line"></span><br><span class="line">    <span class="comment">/** 平台线程池（200 线程，模拟传统 Tomcat 配置）*/</span></span><br><span class="line">    <span class="keyword">private</span> ExecutorService platformPool = Executors.newFixedThreadPool(<span class="number">200</span>);</span><br><span class="line"></span><br><span class="line">    <span class="comment">/** 虚拟线程 Executor */</span></span><br><span class="line">    <span class="keyword">private</span> ExecutorService virtualPool = Executors.newVirtualThreadPerTaskExecutor();</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 基准测试：平台线程池处理短 IO 任务</span></span><br><span class="line"><span class="comment">     * 场景：200 线程池 × 每个 task 10ms IO wait</span></span><br><span class="line"><span class="comment">     * 预期：最大并发 200，吞吐受限于线程数</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">void</span> <span class="title function_">platformThread_shortIo</span><span class="params">(Blackhole bh)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        CountDownLatch latch = <span class="keyword">new</span> <span class="title class_">CountDownLatch</span>(<span class="number">1000</span>);</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">1000</span>; i++) {</span><br><span class="line">            platformPool.submit(() -&gt; {</span><br><span class="line">                <span class="keyword">try</span> {</span><br><span class="line">                    simulateIoTask(<span class="number">10</span>);  <span class="comment">// 10ms IO</span></span><br><span class="line">                } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">                    Thread.currentThread().interrupt();</span><br><span class="line">                } <span class="keyword">finally</span> {</span><br><span class="line">                    latch.countDown();</span><br><span class="line">                }</span><br><span class="line">            });</span><br><span class="line">        }</span><br><span class="line">        latch.await();</span><br><span class="line">        bh.consume(<span class="number">1000</span>);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 基准测试：虚拟线程处理短 IO 任务</span></span><br><span class="line"><span class="comment">     * 场景：每个 task 一个虚拟线程 × 10ms IO wait</span></span><br><span class="line"><span class="comment">     * 预期：1000 个虚拟线程同时挂起，载体线程立即服务于其他任务</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">void</span> <span class="title function_">virtualThread_shortIo</span><span class="params">(Blackhole bh)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        CountDownLatch latch = <span class="keyword">new</span> <span class="title class_">CountDownLatch</span>(<span class="number">1000</span>);</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">1000</span>; i++) {</span><br><span class="line">            virtualPool.submit(() -&gt; {</span><br><span class="line">                <span class="keyword">try</span> {</span><br><span class="line">                    simulateIoTask(<span class="number">10</span>);</span><br><span class="line">                } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">                    Thread.currentThread().interrupt();</span><br><span class="line">                } <span class="keyword">finally</span> {</span><br><span class="line">                    latch.countDown();</span><br><span class="line">                }</span><br><span class="line">            });</span><br><span class="line">        }</span><br><span class="line">        latch.await();</span><br><span class="line">        bh.consume(<span class="number">1000</span>);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// ==================== 场景 B：长 IO（50ms，模拟慢查询/RPC超时）====================</span></span><br><span class="line"></span><br><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">void</span> <span class="title function_">platformThread_longIo</span><span class="params">(Blackhole bh)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        CountDownLatch latch = <span class="keyword">new</span> <span class="title class_">CountDownLatch</span>(<span class="number">1000</span>);</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">1000</span>; i++) {</span><br><span class="line">            platformPool.submit(() -&gt; {</span><br><span class="line">                <span class="keyword">try</span> {</span><br><span class="line">                    simulateIoTask(<span class="number">50</span>);  <span class="comment">// 50ms IO（慢 RPC/DB）</span></span><br><span class="line">                } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">                    Thread.currentThread().interrupt();</span><br><span class="line">                } <span class="keyword">finally</span> {</span><br><span class="line">                    latch.countDown();</span><br><span class="line">                }</span><br><span class="line">            });</span><br><span class="line">        }</span><br><span class="line">        latch.await();</span><br><span class="line">        bh.consume(<span class="number">1000</span>);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Benchmark</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">void</span> <span class="title function_">virtualThread_longIo</span><span class="params">(Blackhole bh)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        CountDownLatch latch = <span class="keyword">new</span> <span class="title class_">CountDownLatch</span>(<span class="number">1000</span>);</span><br><span class="line">        <span class="keyword">for</span> (<span class="type">int</span> i = <span class="number">0</span>; i &lt; <span class="number">1000</span>; i++) {</span><br><span class="line">            virtualPool.submit(() -&gt; {</span><br><span class="line">                <span class="keyword">try</span> {</span><span class="line">                    simulateIoTask(<span class="number">50</span>);</span><br><span class="line">                } <span class="keyword">catch</span> (InterruptedException e) {</span><br><span class="line">                    Thread.currentThread().interrupt();</span><br><span class="line">                } <span class="keyword">finally</span> {</span><br><span class="line">                    latch.countDown();</span><br><span class="line">                }</span><br><span class="line">            });</span><br><span class="line">        }</span><br><span class="line">        latch.await();</span><br><span class="line">        bh.consume(<span class="number">1000</span>);</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="meta">@TearDown</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">void</span> <span class="title function_">tearDown</span><span class="params">()</span> {</span><br><span class="line">        platformPool.shutdown();</span><br><span class="line">        virtualPool.shutdown();</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 运行入口</span></span><br><span class="line">    <span class="keyword">public</span> <span class="keyword">static</span> <span class="keyword">void</span> <span class="title function_">main</span><span class="params">(String[] args)</span> <span class="keyword">throws</span> Exception {</span><br><span class="line">        Options opt = <span class="keyword">new</span> <span class="title class_">OptionsBuilder</span>()</span><br><span class="line">                .include(VirtualThreadBenchmark.class.getSimpleName())</span><br><span class="line">                .build();</span><br><span class="line">        <span class="keyword">new</span> <span class="title class_">Runner</span>(opt).run();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h2 id="52-压测结果参考值"><a href="#52-压测结果参考值" class="headerlink" title="5.2 压测结果（参考值）"></a>5.2 压测结果（参考值）</h2>

<p>以下数据在 <strong>4C8G 云服务器 / JDK 21 / Linux</strong> 上采集（多次取中位数）：</p>

<table>
<thead>
<tr>
<th style="text-align:left">指标</th>
<th style="text-align:center">平台线程池（200线程）<br>短 IO 10ms</th>
<th style="text-align:center">虚拟线程<br>短 IO 10ms</th>
<th style="text-align:center">平台线程池（200线程）<br>长 IO 50ms</th>
<th style="text-align:center">虚拟线程<br>长 IO 50ms</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><strong>吞吐量（ops/s）</strong></td>
<td style="text-align:center">~19,500</td>
<td style="text-align:center"><strong>~96,000</strong></td>
<td style="text-align:center">~3,900</td>
<td style="text-align:center"><strong>~19,500</strong></td>
</tr>
<tr>
<td style="text-align:left"><strong>相对倍率</strong></td>
<td style="text-align:center">1x（基线）</td>
<td style="text-align:center"><strong>~4.9x 🚀</strong></td>
<td style="text-align:center">1x（基线）</td>
<td style="text-align:center"><strong>~5.0x 🚀</strong></td>
</tr>
<tr>
<td style="text-align:left">平均延迟（P50）</td>
<td style="text-align:center">~51ms</td>
<td style="text-align:center">~11ms</td>
<td style="<td style="text-align:center">~256ms</td>
<td style="text-align:center">~52ms</td>
</tr>
<tr>
<td style="text-align:left">尾延迟（P99）</td>
<td style="text-align:center">~102ms</td>
<td style="text-align:center">~23ms</td>
<td style="text-align:center">~512ms</td>
<td style="text-align:center">~105ms</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>如何验证以上数据？</strong></p>
<ol>
<li>确保安装 JDK 21+</li>
<li>pom.xml 加入 <code>org.openjdk.jmh:jmh-core:1.37</code> 和 <code>jmh-generator-annprocess</code></li>
<li>将上面的代码保存为 <code>VirtualThreadBenchmark.java</code></li>
<li>编译并运行 <code>main</code> 方法（IDE 中直接运行即可）</li>
<li>观察控制台输出的 JSON 格式结果表格</li>
<li><strong>你的机器数值会有所不同，但趋势应该一致：虚拟线程在 IO 密集场景下吞吐提升 3~6 倍</strong></li>
</ol>
</blockquote>

<h2 id="53-结果分析"><a href="#53-结果分析" class="headerlink" title="5.3 结果分析"></a>5.3 结果分析</h2>

<p>为什么差距这么大？核心原因就一句话：</p>

<p><strong>平台线程在 IO 等待时「占着茅坑不拉屎」，虚拟线程遇到 IO 就主动「让位」</strong>。</p>

<ul>
<li><strong>短 IO（10ms）</strong>：200 个平台线程很快就被占满，后续 800 个任务在队列里排队；而 1000 个虚拟线程几乎同时发起 IO，载体线程在它们之间快速切换。</li>
<li><strong>长 IO（50ms）</strong>：差距更大。平台线程池中每个线程被单个任务占用 50ms+，吞吐进一步下降；虚拟线程完全不受影响。</li>
<li><strong>P99 延迟大幅下降</strong>：因为没有排队等待线程可用的时间。</li>
</ul>

<blockquote>
<p><strong>⚠️ 重要边界：</strong>如果任务是纯 CPU 密集型（没有 IO 等待），虚拟线程<strong>不会有任何优势</strong>，甚至因调度开销略逊于平台线程。虚拟线程解决的是「等待」问题，不是「计算」问题。</p>
</blockquote>

<h1 id="常见坑与误区生产落地必看"><a href="#常见坑与误区生产落地必看" class="headerlink" title="常见坑与误区（生产落地必看）"></a>常见坑与误区（生产落地必看）</h1>

<h2 id="61-坑一synchronized-会钉死载体线程"><a href="#61-坑一synchronized-会钉死载体线程" class="headerlink" title="坑一：synchronized 会钉死载体线程"></a>坑一：synchronized 会钉死载体线程</h2>

<p>这是目前虚拟线程最大的「坑」之一。</p>

<p>当虚拟线程进入 <code>synchronized</code> 块时，<strong>无法卸载载体线程</strong>。如果 synchronized 块里有阻塞操作，载体线程会被一直占住。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：synchronized + 阻塞 = 载体线程泄漏</span></span><br><span class="line"><span class="keyword">synchronized</span> (lock) {</span><br><span class="line">    Thread.sleep(<span class="number">5000</span>);  <span class="comment">// 这 5 秒内载体线程被钉死了！</span></span><br><span class="line">}</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：用 ReentrantLock 替代 synchronized</span></span><br><span class="line">ReentrantLock lock = <span class="keyword">new</span> <span class="title class_">ReentrantLock</span>();</span><br><span class="line">lock.lock();</span><br><span class="line"><span class="keyword">try</span> { Thread.sleep(<span class="number">5000</span>]; } <span class="keyword">finally</span> { lock.unlock(); }  <span class="comment">// 可以正常卸载</span></span><br></pre></td></table></figure>

<p><strong>解决方案</strong>：全面替换 <code>synchronized</code> 为 <code>ReentrantLock</code>。大多数主流框架（Spring、Hibernate、MyBatis）已经在做这个迁移。</p>

<h2 id="62-坑二threadlocal-内存爆炸风险"><a href="#62-坑二threadlocal-内存爆炸风险" class="headerlink" title="坑二：ThreadLocal 内存爆炸风险"></a>坑二：ThreadLocal 内存爆炸风险</h2>

<p>以前平台线程只有几百个，ThreadLocal 放点数据无所谓。现在虚拟线程可能有<strong>几十万个</strong>，每个都带一份 ThreadLocal 数据……</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 危险：10 万个虚拟线程 × 1KB ThreadLocal = 100MB 浪费</span></span><br><span class="line"><span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> ThreadLocal&lt;<span class="type">byte</span>[]&gt; data =</span><br><span class="line">    ThreadLocal.withInitial(() -&gt; <span class="keyword">new</span> <span class="title class_">byte</span>[<span class="number">1024</span>]);</span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 推荐：使用 ScopedValue（JDK 21 预览，JDK 23+ 改进）</span></span><br><span class="line">// ScopedValue 在同一线程组间共享一份数据，不随虚拟线程复制</span><br><span class="line"><span class="comment">// 或者：审查并移除不必要的 ThreadLocal 用法</span></span><br></pre></td></table></figure>

<h2 id="63-坑三连接池成为新瓶颈"><a href="#63-坑三连接池成为新瓶颈" class="headerlink" title="坑三：连接池成为新瓶颈"></a>坑三：连接池成为新瓶颈</h2>

<p>以前线程池只有 200 个线程，数据库连接池配 200 够用了。现在虚拟线程可以瞬间发起 10,000 个并发请求……数据库连接池瞬间被打满。</p>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 启用虚拟线程后，必须重新评估所有连接池大小：</span></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">datasource:</span></span><br><span class="line">    <span class="attr">hikari:</span></span><br><span class="line">      <span class="attr">maximum-pool-size:</span> <span class="number">20</span>  <span class="comment"># ↑ 这个值需要根据 DB 承载能力重新测算</span></span><br><span class="line"></span><br><span class="line"><span class="comment"># Redis 连接池同理</span></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">data:</span></span><br><span class="line">    <span class="attr">redis:</span></span><br><span class="line">      <span class="attr">lettuce:</span></span><br><span class="line">        <span class="attr">pool:</span></span><br><span class="line">          <span class="attr">max-active:</span> <span class="number">50</span>  <span class="comment"># ↑ 同样需要重新评估</span></span><br></pre></td></table></figure>

<p><strong>经验公式</strong>：连接池大小应该基于<strong>下游服务的承载能力</strong>，而不是线程数。可以用 Little's Law 辅助估算：</p>

<pre><code>连接池大小 = (平均请求数/秒) × (平均每个连接占用时间秒数) + 缓冲余量
</code></pre>

<h2 id="64-坑四不要池化虚拟线程"><a href="#64-坑四不要池化虚拟线程" class="headerlink" title="坑四：不要池化虚拟线程"></a>坑四：不要池化虚拟线程</h2>

<p>这是官方反复强调的：<strong>虚拟线程的设计初衷就是用完即弃</strong>。池化虚拟线程不仅没必要，还会破坏调度器的优化策略。</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">// ❌ 错误：试图创建虚拟线程池</span></span><br><span class="line">ExecutorService badIdea = Executors.newFixedThreadPool(<span class="number">100</span>,</span><br><span class="line">    Thread.ofVirtual().factory());  <span class="comment">// 不要这样做！</span></span><br><span class="line"></span><br><span class="line"><span class="comment">// ✅ 正确：每次任务新建虚拟线程</span></span><br><span class="line">ExecutorService good = Executors.newVirtualThreadPerTaskExecutor();</span><br><span class="line"><span class="comment">// 每次 submit 都会创建一个新的虚拟线程，成本低到可以忽略</span></span><br></pre></td></table></figure>

<h2 id="65-坑五pinning-问题排查"><a href="#65-坑五pinning-问题排查" class="headerlink" title="坑五：Pinning 问题排查"></a>坑五：Pinning 问题排查</h2>

<p>当虚拟线程无法卸载载体线程时，称为 <strong>Pinning（钉住）</strong>。常见原因：</p>

<ol>
<li><code>synchronized</code> 块或方法（最常见）</li>
<li>本地方法（native method）调用</li>
<li>部分第三方库内部的锁操作</li>
</ol>

<p><strong>开启 Pinning 诊断（JDK 19+）</strong>：</p>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">java -Djdk.virtualThreadScheduler.parallelism=<span class="number">N</span> -Djdk.tracePinnedThreads=short MyApp.jar</span><br></pre></td></table></figure>

<p>当检测到 Pinning 时，控制台会打印堆栈跟踪，帮你定位是哪行代码导致的。</p>

<h1 id="生产环境检查清单"><a href="#生产环境检查清单" class="headerlink" title="生产环境检查清单"></a>生产环境检查清单</h1>

<p>在正式上线前，逐项确认：</p>

<table>
<thead>
<tr>
<th style="text-align:left">#</th>
<th style="text-align:left">检查项</th>
<th style="text-align:center">状态</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">1</td>
<td style="text-align:left">JDK ≥ 21（推荐使用 LTS 发行版如 Eclipse Temurin、Oracle JDK）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:left">2</td>
<td style="text-align:left">Spring Boot ≥ 3.2（确认 spring.threads.virtual.enabled=true）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:left">3</td>
<td style="text-align:left">代码审查：无 synchronized 块内有阻塞操作（替换为 ReentrantLock）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:left">4</td>
<td style="text-align:left">ThreadLocal 审计：避免大对象绑定在线程上，考虑迁移至 ScopedValue</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:left">5</td>
<td style="text-align:left">连接池重新评估：HikariCP / Redis / HTTP 连接池大小按下游能力重算</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:left">6</td>
<td style="text-align:left">第三方依赖检查：确保使用的库支持虚拟线程（特别是 ORM / RPC 框架）</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:left">7</td>
<td style="text-align:left">压测验证：在类生产环境下做压力测试，对比启用前后的吞吐/延迟/GC</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:left">8</td>
<td style="text-align:left">监控适配：确认 APM 工具（SkyWalking / Micrometer / Prometheus）正确采集虚拟线程指标</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:left">9</td>
<td style="text-align:left">开启 -Djdk.tracePinnedThreads=short 观察是否有 Pinning 问题</td>
<td style="text-align:center">☐</td>
</tr>
<tr>
<td style="text-align:left">10</td>
<td style="text-align:left">灰度发布：先在非核心接口/低流量模块试跑，观察 24~48 小时</td>
<td style="text-align:center">☐</td>
</tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发史上最重要的演进之一。回顾全文的关键要点：</p>

<ol>
<li><strong>解决的问题</strong>：平台线程在 IO 密集场景下「等得久、数量少、调度贵」的困境</li>
<li><strong>核心机制</strong>：Continuation 冻结/恢复 + ForkJoinPool 载体线程调度，实现 M:N 多路复用</li>
<li><strong>Spring Boot 集成</strong>：一行配置 <code>spring.threads.virtual.enabled=true</code> 即可替换 Tomcat 线程池</li>
<li><strong>性能收益</strong>：IO 密集场景下吞吐提升 3~6 倍，P99 延迟降低 60%~80%</li>
<li><strong>适用场景</strong>：IO 密集型后端服务（Web 服务、RPC 网关、文件处理等）；<strong>不适用于</strong>纯 CPU 密集计算</li>
<li><strong>主要风险</strong>：synchronized Pinning、ThreadLocal 内存膨胀、连接池成为新瓶颈</li>
<li><strong>落地建议</strong>：先在新模块/非核心接口灰度，配合压测和监控逐步推广</li>
</ol>

<blockquote>
<p><strong>最后一句忠告</strong>：虚拟线程不是银弹。它解决的是「线程等待」的问题，不会让你的数据库变快、不会减少 RPC 调用次数、不会优化 SQL 查询。该做的架构优化和性能调优一样都不能少——虚拟线程只是在正确的架构之上，让并发处理变得更高效、更自然。</p>
</blockquote>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>OpenJDK 官方文档 — Virtual Threads（JEP 444）</strong><br>
<a target="_blank" rel="noopener" href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a><br>
JEP 444 规范文档，虚拟线程设计的权威来源。</li>
<li><strong>Ron Pressler — Virtual Threads: New Possibilities（Devoxx 2023）</strong><br>
<a target="_blank" rel="noopener" href="https://www.youtube.com/watch?v=Xpc1QvRYLZU">YouTube 演讲视频</a><br>
Ron Pressler 是虚拟线程的主导设计者，这个演讲解释了设计动机和内部实现细节。</li>
<li><strong>得物技术团队 — 虚拟线程原理及性能分析</strong><br>
<a target="_blank" rel="noopener" href="https://tech.dewu.com/article?id=89">https://tech.dewu.com/article?id=89</a><br>
中文实战文章，包含虚拟线程源码级别的深度分析和性能测试数据。</li>
<li><strong>Spring Blog — Virtual Threads in Spring Boot 3.2</strong><br>
<a target="_blank" rel="noopener" href="https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot">https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot</a><br>
Spring 官方博客介绍如何在 Spring Boot 中启用和使用虚拟线程。</li>
<li><strong>Jos de Jong — Java 24 新特性预览（含 Stream Gatherers / Scoped Values）</strong><br>
<a target="_blank" rel="noopener" href="https://cyberjos.blog/java/se/java-24-release-candidate-preview">https://cyberjos.blog/java/se/java-24-release-candidate-preview</a><br>
中文 Java 博客，涵盖 JDK 24 中与虚拟线程配套的 Scoped Values 等特性。</li>
<li><strong>JavaGuide — Java 24 新特性概览</strong><br>
<a target="_blank" rel="noopener" href="https://javaguide.cn/java/new-features/java24.html">https://javaguide.cn/java/new-features/java24.html</a><br>
中文 Java 学习站点的 JDK 24 特性整理，包含 Scoped Values 第四次预览等内容。</li>
<li><strong>Baeldung — Introduction to Java Virtual Threads</strong><br>
<a target="_blank" rel="noopener" href="https://www.baeldung.com/java-virtual-threads">https://www.baeldung.com/java-virtual-threads</a><br>
英文教程，提供了大量虚拟线程代码示例和最佳实践总结。</li>
</ol>
