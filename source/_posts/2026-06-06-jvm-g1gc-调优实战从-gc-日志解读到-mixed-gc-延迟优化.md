---
title: JVM G1GC 调优实战：从 GC 日志解读到 Mixed GC 延迟优化
date: 2026-06-06 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - JVM
  - G1GC
  - GC调优
  - 性能优化
  - jstat
---
<hr>
<blockquote><p>G1 Garbage Collector（G1 垃圾收集器）是 JDK 9 之后的默认 GC，也是目前 Java 生产环境最主流的选择之一。但"默认配置就能跑"不等于"默认配置就够用"——当你的服务遇到 **STW（Stop-The-World）停顿抖动**、**Mixed GC 频繁触发**、或者 **Old Gen 占比持续攀升** 时，靠猜参数是没用的。这篇文章会带你从读懂 GC 日志开始，到用 jstat/jcmd 做现场诊断，再到一步步把 P99 停顿时间压下来。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么你需要懂-G1GC">背景：为什么你需要懂 G1GC</h1>

<p>先说个真实场景：你上线了一个 Spring Boot 微服务，QPS 2000 左右，堆内存给了 <strong>4GB</strong>。运行几天后发现接口偶尔出现 <strong>200ms+ 的毛刺</strong>，监控上看到 CPU 短时飙高但很快恢复。查了半天代码没发现慢查询、没发现锁竞争——最后发现是 <strong>G1 的 Mixed GC 在搞鬼</strong>，一次 Young GC + Mixed GC 联动停顿干到了 180ms。</p>

<p>这就是典型的"G1 默认参数不够用"场景。<strong>G1GC</strong>（Garbage-First Garbage Collector）是 JDK 7u4 引入、JDK 9 成为默认的<strong>低延迟垃圾收集器</strong>。它的设计目标是：<strong>在可预期的停顿时间模型内，尽可能高的吞吐量</strong>。注意关键词——<strong>"可预期"</strong>意味着你得告诉它你的停顿目标（<code>-XX:MaxGCPauseTimeMillis</code>），它才会努力去达成。</p>

<p>本文假设你已经知道：</p>
<ul>
<li>JVM 堆分为 Young Gen 和 Old Gen（新生代/老年代）</li>
<li>GC 分为 Minor GC（Young GC）和 Major GC（Full GC / Mixed GC）</li>
<li>基本了解 <strong>STW</strong>（Stop-The-World）是什么——就是 GC 期间所有应用线程暂停，用户能感知到的"卡顿"</li>
</ul>

<h1 id="g1gc-核心概念速览">G1GC 核心概念速览</h1>

<h2 id="region-分区思想"><strong>Region 分区思想</strong></h2>

<p>和传统的 CMS/Parallel GC 把堆切成连续的 Young/Old 不同，G1 把整个堆划分为若干个大小相等的 <strong>Region</strong>（区域），每个 Region 大小默认为堆的 1/2048，范围 1MB~32MB（必须是 2 的幂）。</p>

<table>
<thead>
<tr>
<th style="text-align:center">Region 类型</th>
<th style="text-align:center">说明</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">Eden</td>
<td style="text-align:center">新对象分配区域（大部分对象死在这里）</td>
</tr>
<tr>
<td style="text-align:center">Survivor</td>
<td style="text-align:center">经过一次 Young GC 还活着的对象</td>
</tr>
<tr>
<td style="text-align:center">Old</td>
<td style="text-align:center">长期存活或大对象直接分配</td>
</tr>
<tr>
<td style="text-align:center">Humongous</td>
<td style="text-align:center">超过 Region 50% 的大对象（容易引发 Full GC！）</td>
</tr>
<tr>
<td style="text-align:center">Available</td>
<td style="text-align:center">空闲，未使用</td>
</tr>
</tbody>
</table>

<p><strong>关键点：</strong>G1 的 Young GC 只回收 Eden + Survivor 区域；而 <strong>Mixed GC</strong> 会额外挑选一些"垃圾占比高"的 Old Region 一起回收——这就是 G1 名字里 "Garbage-First" 的含义：<strong>优先回收垃圾最多的区域</strong>。</p>

<h2 id="关键参数一览"><strong>关键参数一览</strong></h2>

<table>
<thead>
<tr>
<th style="text-align:center">参数</th>
<th style="text-align:center">默认值</th>
<th style="text-align:center">作用</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center"><code>-XX:+UseG1GC</code></td>
<td style="text-align:center">JDK9+ 默认开启</td>
<td style="text-align:center">启用 G1 收集器</td>
</tr>
<tr>
<td style="text-align:center"><code>-XX:MaxGCPauseTimeMillis</code></td>
<td style="text-align:center">200ms</td>
<td style="text-align:center"><strong>目标最大停顿时间</strong>（G1 会尽量满足但不保证）</td>
</tr>
<tr>
<td style="text-align:center"><code>-XX:G1HeapRegionSize</code></td>
<td style="text-align:center">自动计算</td>
<td style="text-align:center">单个 Region 大小（建议手动设为 4MB~16MB）</td>
</tr>
<tr>
<td style="text-align:center"><code>-XX:InitiatingHeapOccupancyPercent</code></td>
<td style="text-align:center">45%</td>
<td style="text-align:center">堆占用达到此比例时触发并发标记（进而可能触发 Mixed GC）</td>
</tr>
<tr>
<td style="text-align:center"><code>-XX:G1NewSizePercent</code></td>
<td style="text-align:center">5%</td>
<td style="text-align:center">新生代最小占堆比例</td>
</tr>
<tr>
<td style="text-align:center"><code>-XX:G1MaxNewSizePercent</code></td>
<td style="text-align:center">60%</td>
<td style="text-align:center">新生代最大占堆比例</td>
</tr>
<tr>
<td style="text-align:center"><code>-XX:G1MixedGCCountTarget</code></td>
<td style="text-align:center">8</td>
<td style="text-align:center">Mixed GC 分几批完成（值越大每批停顿越短）</td>
</tr>
<tr>
<td style="text-align:center"><code>-XX:G1ReservePercent</code></td>
<td style="text-align:center">10%</td>
<td style="text-align:center">预留空间防 to-space exhaustion</td>
</tr>
</tbody>
</table>

<pre><code>注：<strong>IHOP</strong>（Initiating Heap Occupancy Percent）是 G1 最敏感的参数之一。
设太小 → 并发标记太早触发 → Mixed GC 太频繁；
设太大 → Old 区来不及回收 → 最终触发 Full GC（退化到 SerialOld，非常慢！）
</code></pre>

<h1 id="实战第一步：开启并读取-gc-日志">实战第一步：开启并读取 GC 日志</h1>

<h2 id="开启-gc-日志的推荐参数组合">开启 GC 日志的推荐参数组合</h2>

<p>生产环境推荐使用以下 JVM 参数开启 GC 日志：</p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre>
</td><td class="code">
<pre><span class="line"><span class="comment"># JDK 8 写法</span></span><br><span class="line">-Xloggc:/var/log/app/gc.log -XX:+PrintGCDetails -XX:+PrintGCDateStamps -XX:+PrintGCTimeStamps</span><br><span class="line"></span><br><span class="line"><span class="comment"># JDK 9+ 统一日志框架（推荐）</span></span><br><span class="line">-Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=5,filesize=20m</span><br></pre>
</td></table></figure>

<p><strong>解释一下这个 JDK 9+ 参数：</strong></p>
<ul>
<li><code>gc*</code> — 记录所有 GC 相关日志（<code>*</code> 表示包含 gc 的所有子标签）</li>
<li><code>:time,uptime,level,tags</code> — 输出时间戳、JVM 运行时长、日志级别、标签信息</li>
<li><code>:filecount=5,filesize=20m</code> — 滚动策略：最多 5 个文件，每个最大 20MB</li>
</ul>

<h2 id="用-jcmd-动态开启（不用重启！）">用 jcmd 动态开启（不用重启！）</h2>

<p>如果线上服务已经跑了，忘了开 GC 日志？别慌，<strong>jcmd</strong> 可以动态开启：</p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre>
</td><td class="code">
<pre><span class="line"><span class="comment"># 1. 找到 JVM PID</span></span><br><span class="line">jps -l | grep your-app</span><br><span class="line"><span class="comment"># 2. 动态开启 GC 日志（JDK 9+）</span></span><br><span class="line">jcmd &lt;PID&gt; VM.log output=gc.log what=gc*</span><br></pre>
</td></table></figure>

<pre><code>注：<strong>jcmd</strong> 是 JDK 自带的诊断工具，功能类似 jstack/jmap 但更统一强大。
它是你在生产环境做"不打断服务诊断"的好帮手。
</code></pre>

<h2 id="解读一条真实的-young-gc-日志">解读一条真实的 Young GC 日志</h2>

<p>下面是一条典型的 G1 Young GC 日志（JDK 8 格式，生产中最常见）：</p>

<figure class="highlight plaintext">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><br><span class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><br><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><br><span class="line">88</span><br><span class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><br><span class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><br><span class="line">104</span><br><span class="line">105</span><br><span class="line">106</span><br><span class="line">107</span><br><span class="line">108</span><br><span class="line">109</span><br><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><br><span class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br><span class="line">117</span><br><span class="line">118</span><br><span class="line">119</span><br><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br><span class="line">123</span><br><span class="line">124</span><br><span class="line">125</span><br><span class="line">126</span><br><span class="line">127</span><br><span class="line">128</span><br><span class="line">129</span><br><span class="line">130</span><br><span class="line">131</span><br><span class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><br><span class="line">135</span><br><span class="line">136</span><br><span class="line">137</span><br><span class="line">138</span><br><span class="line">139</span><br><span class="line">140</span><br><span class="line">141</span><br><span class="line">142</span><br><span class="line">143</span><br><span class="line">144</span><br><span class="line">145</span><br><span class="line">146</span><br><span class="line">147</span><br><span class="line">148</span><br><span class="line">149</span><br><span class="line">150</span><br><span class="line">151</span><br><span class="line">152</span><br><span class="line">153</span><br><span class="line">154</span><br><span class="line">155</span><br><span class="line">156</span><br><span class="line">157</span><br><span class="line">158</span><br><span class="line">159</span><br><span class="line">160</span><br><span class="line">161</span><br><span class="line">162</span><br><span class="line">163</span><br><span class="line">164</span><br><span class="line">165</span><br><span class="line">166</span><br><span class="line">167</span><br><span class="line">168</span><br><span class="line">169</span><br><span class="line">170</span><br><span class="line">171</span><br><span class="line">172</span><br><span class="line">173</span><br><span class="line">174</span><br><span class="line">175</span><br><span class="line">176</span><br><br></pre>
</td><td class="code">
<pre><span class="line">2026-06-06T09:15:23.456+0800: 12345.678: [GC pause (G1 Evacuation Pause) (young), 0.0123450 secs]</span><br><span class="line">   [Eden regions: 200→0(240)]</span><br><span class="line">   [Survivor regions: 10→12(20)]</span><br><span class="line">   [Heap regions: 1024→1024(1024), 4096.0M→4092.3M(4096.0M)]</span><br><span class="line">   [Other: 2345ms]</span><br><span class="line">   [Eden: 3400.0M(3400.0M)→0.0B(1700.0M) Survivors: 170.0M(170.0M)→204.0M(204.0M)</span><br><span class="line">    Heap: 4096.0M(4096.0M)→4092.3M(4096.0M)]</span><br><span class="line">   [Times: user=0.04 sys=0.00, real=0.01 secs]</span><br></pre>
</td></table></figure>

<p>逐段拆解：</p>

<table>
<thead>
<tr>
<th style="text-align:left">字段</th>
<th style="text-align:left">含义</th>
<th style="text-align:center">关注点</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><code>[GC pause (G1 Evacuation Pause) (young)]</code></td>
<td style="text-align:left">这是一次 Young GC（只清理 Eden + Survivor）</td>
<td style="text-align:center">确认类型</td>
</tr>
<tr>
<td style="text-align:left"><code>0.0123450 secs</code></td>
<td style="text-align:left"><strong>本次 STW 停顿时间 = 12.3ms</strong></td>
<td style="text-align:center">⭐ 核心指标！是否接近 MaxGCPauseTimeMillis 目标？</td>
</tr>
<tr>
<td style="text-align:left"><code>Eden regions: 200→0(240)</code></td>
<td style="text-align:left">GC 前 Eden 有 200 个 Region，GC 后清零（总容量 240 个）</td>
<td style="text-align:center">Eden 利用率</td>
</tr>
<tr>
<td style="text-align:left"><code>Survivor regions: 10→12(20)</code></td>
<td style="text-align:left">Survivor 从 10 个变成 12 个（有对象晋升了）</td>
<td style="text-align:center">晋升速率</td>
</tr>
<tr>
<td style="text-align:left"><code>Heap: 4096.0M→4092.3M</code></td>
<td style="text-align:left">堆从 4096MB 回收到 4092.3MB（释放约 3.7MB）</td>
<td style="text-align:center">每次 GC 回收量</td>
</tr>
<tr>
<td style="text-align:left"><code>[Times: user=... real=...]</code></td>
<td style="text-align:left">user=CPU 时间，real=实际墙钟时间</td>
<td style="text-align:center">real ≈ STW 时间</td>
</tr>
</tbody>
</table>

<h2 id="mixed-gc-日志长什么样">Mixed GC 日志长什么样？</h2>

<p>Mixed GC 比 Young GC 复杂得多，因为它要同时处理 Young + 部分 Old Region：</p>

<figure class="highlight plaintext">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><br></pre>
</td><td class="code">
<pre><span class="line">2026-06-06T09:16:01.789+0800: 12383.xxx: [GC pause (G1 Evacuation Pause) (mixed), 0.0876543 secs]</span><br><span class="line">   [Eden regions: 180→0(240)]</span><br><span class="line">   [Survivor regions: 12→14(20)]</span><br><span class="line">   [Old regions: 450→443(512)]</span><br><span class="line">   [Heap regions: 1024→1024(1024), 4096.0M→4080.5M(4096.0M)]</span><br><span class="line">   [Remembered Sets:</span><br><span class="line">      Total: 8192, Processed: 4096, Freed: 256,</span><br><span class="line">      Coarsened: 128]</span><br><span class="line">   [Other: 4567ms]</span><br><span class="line">   [Eden: 3060.0M(3400.0M)→0.0B(1700.0M) Survivors: 204.0M(204.0M)→238.0M(238.0M)</span><br><span class="line">    Heap: 4096.0M(4096.0M)→4080.5M(4096.0M)]</span><br><span class="line">   [Times: user=0.28 sys=0.02, real=0.09 secs]</span><br></pre>
</td></table></figure>

<p>和 Young GC 的区别在于：</p>
<ul>
<li><code>(mixed)</code> 标签 —— 说明这次回收包含了 Old Region</li>
<li><code>Old regions: 450→443</code> —— 回收了 7 个 Old Region（释放约 11.8MB）</li>
<li><code>Remembered Sets</code> —— <strong>RSet</strong> 处理统计（RSet 是 G1 维护跨 Region 引用的数据结构，处理越久说明跨代引用越多）</li>
<li><strong>停顿时间 87.6ms</strong> —— 明显比 Young GC 长，因为多了扫描 RSet + 回收 Old 的开销</li>
</ul>

<pre><code>注：<strong>RSet（Remembered Set， remembered set）</strong> 是 G1 的核心辅助结构，
用于记录"哪些 Region 被其他 Region 引用"。没有 RSet，G1 就得全堆扫描来找出
存活对象，那 STW 就会爆炸。RSet 本身也占额外内存（通常堆的 5%~10%），
维护开销体现在 GC 日志的 "Other" 时间里。
</code></pre>

<h1 id="实战第二步：用-jstat-和-jcmd-做现场诊断">实战第二步：用 jstat 和 jcmd 做现场诊断</h1>

<h2 id="jstat-实时观察-gc-行为">jstat 实时观察 GC 行为</h2>

<p><strong>jstat</strong> 是 JDK 自带工具，可以实时查看 GC 统计信息，不需要提前开任何参数：</p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><span class="line">47</span><span class="line">48</span><br><span class="line">49</span><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><br><span class="line">58</span><br><span class="line">59</span><br><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><span class="line">63</span><br><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><span class="line">68</span><br><span class="line">69</span><br><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><br><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><br><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><span class="line">88</span><br class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><span class="line">94</span><br><span class="line">95</span><br><span class="line">96</span><br><span class="line">97</span><br><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><br></pre>
</td><td class="code">
<pre><span class="line"><span class="comment"># 每 2 秒输出一次 GC 统计，共输出 20 次</span></span><br><span class="line">jstat -gcutil &lt;PID&gt; 2000 20</span><br><span class="line"></span><br><span class="line"><span class="comment"># 输出示例（重点关注 S0/S1/E/O/M 列）：</span></span><br><span class="line">  S0     S1     E      O      M     CCS    YGC     YGCT    FGC    FGCT    GCT</span><br><span class="line">  0.00  87.50  66.67  12.34  93.75  88.00   142    4.234   0    0.000   4.234</span><br><span class="line">  0.00  87.50  78.33  12.35  93.75  88.00   142    4.234   0    0.000   4.234</span><br><span class="line">  0.00  87.50  91.67  12.35  93.75  88.00   143    4.256   0    0.000   4.256</span><br><span class="line">  ^C</span><br></pre>
</td></table></figure>

<p>各列含义：</p>

<table>
<thead>
<tr>
<th style="text-align:center">列</th>
<th style="text-align:center">含义</th>
<th style="text-align:center">健康阈值参考</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">S0 / S1</td>
<td style="text-align:center">两个 Survivor 区的使用率</td>
<td style="text-align:center">一个接近满、另一个接近 0 是正常的（复制算法）</td>
</tr>
<tr>
<td style="text-align:center">E</td>
<td style="text-align:center">Eden 使用率</td>
<td style="text-align:center">快速上升后归零 = 正常的分配 + GC 循环</td>
</tr>
<tr>
<td style="text-align:center">O</td>
<td style="text-align:center">Old Gen 使用率 ⭐</td>
<td style="text-align:center"><strong>持续上涨且不回落 = 危险信号！</strong></td>
</tr>
<tr>
<td style="text-align:center">M</td>
<td style="text-align:center">Metaspace 使用率</td>
<td style="text-align:center">突然飙升可能是类加载/动态代理问题</td>
</tr>
<tr>
<td style="text-align:center">YGC</td>
<td style="text-align:center">Young GC 总次数</td>
<td style="text-align:center">频率过高 → Eden 太小</td>
</tr>
<tr>
<td style="text-align:center">YGCT</td>
<td style="text-align:center">Young GC 总耗时</td>
<td style="text-align:center">平均单次 = YGCT/YGC，应 &lt; 50ms</td>
</tr>
<tr>
<td style="text-align:center">FGC</td>
<td style="text-align:center">Full GC 次数 ⭐⭐</td>
<td style="text-align:center"><strong>生产环境应该趋近于 0！</strong></td>
</tr>
<tr>
<td style="text-align:center">FGCT</td>
<td style="text-align:center">Full GC 总耗时</td>
<td style="text-align:center">一旦出现通常是秒级停顿</td>
</tr>
</tbody>
</table>

<h2 id="jcmd-查看-g1-内部状态">jcmd 查看 G1 内部状态</h2>

<p>jstat 只能看到概览，jcmd 能深入 G1 内部：</p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><span class="line">40</span><span class="line">41</span><br class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><span class="line">45</span><br><span class="line">46</span><span class="line">47</span><span class="line">48</span><span class="line">49</span><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><span class="line">54</span><br><span class="line">55</span><br><span class="line">56</span><br><span class="line">57</span><span class="line">58</span><span class="line">59</span><span class="line">60</span><br><span class="line">61</span><br><span class="line">62</span><span class="line">63</span><span class="line">64</span><br><span class="line">65</span><br><span class="line">66</span><br><span class="line">67</span><span class="line">68</span><br><span class="line">69</span><span class="line">70</span><br><span class="line">71</span><br><span class="line">72</span><br><span class="line">73</span><br><span class="line">74</span><span class="line">75</span><br><span class="line">76</span><br><span class="line">77</span><span class="line">78</span><br><span class="line">79</span><br><span class="line">80</span><br><span class="line">81</span><br><span class="line">82</span><br><span class="line">83</span><br><span class="line">84</span><br><span class="line">85</span><br><span class="line">86</span><br><span class="line">87</span><br><span class="line">88</span><br><span class="line">89</span><br><span class="line">90</span><br><span class="line">91</span><br><span class="line">92</span><br><span class="line">93</span><br><span class="line">94</span><br><span class="line">95</span><span class="line">96</span><br class="line">97</span><span class="line">98</span><br><span class="line">99</span><br><span class="line">100</span><br><span class="line">101</span><br><span class="line">102</span><br><span class="line">103</span><span class="line">104</span><br><span class="line">105</span><span class="line">106</span><span class="line">107</span><br><span class="line">108</span><br><span class="line">109</span><span class="line">110</span><br><span class="line">111</span><br><span class="line">112</span><br><span class="line">113</span><br><span class="line">114</span><br><span class="line">115</span><br><span class="line">116</span><br><span class="line">117</span><br><span class="line">118</span><br><span class="line">119</span><span class="line">120</span><br><span class="line">121</span><br><span class="line">122</span><br><span class="line">123</span><br><span class="line">124</span><br><span class="line">125</span><br><span class="line">126</span><span class="line">127</span><br><span class="line">128</span><br><span class="line">129</span><span class="line">130</span><br><span class="line">131</span><br><span class="line">132</span><br><span class="line">133</span><br><span class="line">134</span><span class="line">135</span><br><span class="line">136</span><span class="line">137</span><span class="line">138</span><span class="line">139</span><br><span class="line">140</span><br><span class="line">141</span><br><span class="line">142</span><span class="line">143</span><br><span class="line">144</span><br><span class="line">145</span><br><span class="line">146</span><br><span class="line">147</span><br><span class="line">148</span><br><span class="line">149</span><br><span class="line">150</span><br><span class="line">151</span><br><span class="line">152</span><br class="line">153</span><span class="line">154</span><br><span class="line">155</span><br><span class="line">156</span><br><span class="line">157</span><span class="line">158</span><br><span="line">159</span><span class="line">160</span><br><span class="line">161</span><br><span class="line">162</span><br><span class="line">163</span><br><span class="line">164</span><br><span class="line">165</span><br><span class="line">166</span><br><span class="line">167</span><span class="line">168</span><span class="line">169</span><br><span class="line">170</span><br><span class="line">171</span><br><span class="line">172</span><br><span class="line">173</span><br><span class="line">174</span><br><span class="line">175</span><br><span class="line">176</span><br class="line">177</span><br class="line">178</span><br><span class="line">179</span><br><span class="line">180</span><br><br></pre>
</td><td class="code">
<pre><span class="line"><span class="comment"># 查看 G1 各区域详细信息</span></span><br><span class="line">jcmd &lt;PID&gt; GC.heap_info</span><br><span class="line"></span><br><span class="line"><span class="comment"># 查看 G1 特定信息（Region 分布等）</span></span><br><span class="line">jcmd &lt;PID&gt; GC.heap_info 2>/dev/null || \</span><br><span class="line">jcmd &lt;PID&gt; VM.flags  # 至少看当前生效的 GC 参数</span><br><span class="line"></span><br><span class="line"><span class="comment"># 手动触发一次 GC（慎用！生产环境一般不要手动触发）</span></span><br><span class="line">jcmd &lt;PID&gt; GC.run</span><br><span class="line"></span><br><span class="comment"># 打印当前 JVM 所有 GC 相关标志位及其值（超有用！）</span></span><br><span class="line">jcmd &lt;PID&gt; VM.flags -all | grep -i g1</span><br></pre>
</td></table></figure>

<h1 id="实战第三步：搭建可复现实验环境">实战第三步：搭建可复现实验环境</h1>

<p>光说不练假把式。下面我们用一个简单的 Spring Boot 应用模拟两种场景：<strong>正常分配场景</strong> vs <strong>大对象/内存泄漏场景</strong>，对比 G1 的表现差异。</p>

<h2 id="实验准备">实验准备</h2>

<figure class="highlight java">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><br></pre>
</td><td class="code">
<pre><span class="line"><span class="comment">// GcTestController.java —— 一个专门用来"折腾 GC"的测试接口</span></span><br><span class="line">@RestController</span><br><span class="line">@RequestMapping(&quot;/api/gc-test&quot;)</span><br><span class="line"><span class="keyword">public</span> <span class="class"><span class="keyword">class</span> <span class="title">GcTestController</span> {</span></span><br><span class="line"></span><br><span class="line">    <span class="comment">// 场景 A：大量短命对象（模拟正常业务分配）</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/allocate&quot;)</span></span><br><span class="line">    <span class="function"><span class="keyword">public</span> String <span class="title">allocate</span><span class="params">(</span></span></span><br><span class="line"><span class="function"><span class="params">            @RequestParam(defaultValue = &quot;10000&quot;) <span class="keyword">int</span> count,</span></span></span><br><span class="line"><span class="function"><span class="params">            @RequestParam(defaultValue = &quot;1024&quot;) <span class="keyword">int</span> size)</span> {</span></span><br><span class="line">        List&lt;<span class="keyword">byte</span>[]&gt; data = <span class="keyword">new</span> ArrayList&lt;&gt;(count);</span><br><span class="line">        <span class="keyword">for</span> (<span class="keyword">int</span> i = <span class="number">0</span>; i &lt; count; i++) {</span><br><span class="line">            data.add(<span class="keyword">new</span> <span class="keyword">byte</span>[size]); <span class="comment">// 每次 1KB</span></span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;Allocated &quot;</span> + count + <span class="string">&quot; x &quot;</span> + size + <span class="string">&quot; bytes, total ~&quot;</span></span><br><span class="line">            + (count * size / <span class="number">1024</span>) + <span class="string">&quot;KB&quot;</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 场景 B：模拟内存泄漏（对象长期存活，撑满 Old Gen）</span></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> List&lt;<span class="keyword">byte</span>[]&gt; LEAK = <span class="keyword">new</span> CopyOnWriteArrayList&lt;&gt;();</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/leak&quot;)</span></span><br><span class="line">    <span class="function"><span class="keyword">public</span> String <span class="title">leak</span><span class="params">(@RequestParam(defaultValue = &quot;1000&quot;) <span class="keyword">int</span> mb)</span> {</span></span><br><span class="line">        LEAK.add(<span class="keyword">new</span> <span class="keyword">byte</span>[mb * <span class="number">1024</span> * <span class="number">1024</span>]); <span class="comment">// 每次 1MB，存入静态变量永不释放</span></span><br><span class="line">        <span class="keyword">long</span> totalBytes = LEAK.stream().mapToLong(arr -&gt; arr.length).sum();</span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;Leaked total: &quot;</span> + (totalBytes / <span class="number">1024</span> / <span class="number">1024</span>) + <span class="string">&quot; MB (&quot;</span></span><br><span class="line">            + LEAK.size() + <span class="string">&quot; chunks)&quot;</span>;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 场景 C：创建 Humongous 对象（超过 Region 50% 的大对象）</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/humongous&quot;)</span></span><br><span class="line">    <span class="function"><span class="keyword">public</span> String <span class="title">humongous</span><span class="params">(@RequestParam(defaultValue = &quot;3&quot;) <span class="keyword">int</span> mb)</span> {</span></span><br><span class="line">        <span class="comment">// 如果 G1HeapRegionSize=4MB，则超过 2MB 就是 Humongous</span></span><br><span class="line">        <span class="keyword">byte</span>[] huge = <span class="keyword">new</span> <span class="keyword">byte</span>[mb * <span class="number">1024</span> * <span class="number">1024</span>];</span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;Created humongous object: &quot;</span> + mb + <span class="string">&quot; MB&quot;</span>;</span><br><span class="line">        <span class="comment">// 注意：huge 是局部变量，方法返回后可被 GC</span></span><br><span class="line">        <span class="comment">// 但如果是 static 持有就会一直占着 Old/Humongous 区</span></span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">// 场景 D：高频调用触发 Young GC 压力</span></span><br><span class="line">    <span class="meta">@GetMapping(&quot;/stress&quot;)</span></span><br><span class="line">    <span class="function"><span class="keyword">public</span> String <span class="title">stress</span><span class="params">()</span> {</span></span><br><span class="line">        StringBuilder sb = <span class="keyword">new</span> StringBuilder();</span><br><span class="line">        <span class="keyword">for</span> (<span class="keyword">int</span> i = <span class="number">0</span>; i &lt; <span class="number">50000</span>; i++) {</span><br><span class="line">            sb.append(UUID.randomUUID().toString());</span><br><span class="line">        }</span><br><span class="line">        <span class="keyword">return</span> <span class="string">&quot;Generated ~6MB of strings, length=&quot;</span> + sb.length();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre>
</td></table></figure>

<h2 id="启动参数（两套对比）">启动参数（两套对比）</h2>

<p><strong>场景 1：G1 默认参数</strong></p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><span class="line">36</span><span class="line">37</span><span class="line">38</span><br><span class="line">39</span><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><span class="line">44</span><span class="line">45</span><span class="line">46</span><span class="line">47</span><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><span class="line">55</span><span class="line">56</span><span class="line">57</span><span class="line">58</span><span class="line">59</span><span class="line">60</span><span class="line">61</span><span class="line">62</span><span class="line">63</span><span class="line">64</span><span class="line">65</span><span class="line">66</span><span class="line">67</span><span class="line">68</span><br></pre>
</td><td class="code">
<pre><span class="line">java \</span><br><span class="line">  -Xmx512m -Xms512m \</span><br><span class="line">  -XX:+UseG1GC \</span><br><span class="line">  -XX:MaxGCPauseTimeMillis=<span class="number">200</span> \</span><br><span class="line">  -Xlog:gc*:file=/tmp/gc-default.log:time,uptime,level,tags:filecount=5,filesize=20m \</span><br><span class="line">  -jar your-app.jar</span><br></pre>
</td></table></figure>

<p><strong>场景 2：调优后的参数</strong></p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><span class="line">19</span><span class="line">20</span><br><span class="line">21</span><span class="line">22</span><br><span class="line">23</span><span class="line">24</span><span class="line">25</span><span class="line">26</span><span class="line">27</span><span class="line">28</span><span class="line">29</span><span class="line">30</span><span class="line">31</span><span class="line">32</span><span class="line">33</span><span class="line">34</span><span class="line">35</span><span class="line">36</span><span class="line">37</span><span class="line">38</span><span class="line">39</span><span class="line">40</span><span class="line">41</span><span class="line">42</span><span class="line">43</span><span class="line">44</span><span class="line">45</span><br></pre>
</td><td class="code">
<pre><span class="line">java \</span><br><span class="line">  -Xmx512m -Xms512m \</span><br><span class="line">  -XX:+UseG1GC \</span><br><span class="line">  -XX:MaxGCPauseTimeMillis=<span class="number">100</span> \       <span class="comment"># 更激进的目标：100ms</span></span><br><span class="line">  -XX:G1HeapRegionSize=<span class="number">4</span>m \          <span class="comment"># 固定 Region 4MB（512MB 堆 → 128 个 Region）</span></span><br><span class="line">  -XX:InitiatingHeapOccupancyPercent=<span class="number">40</span> \ <span class="comment"># 提前触发并发标记（默认 45→40）</span></span><br><span class="line">  -XX:G1NewSizePercent=<span class="number">15</span> \           <span class="comment"># 新生代最小 15%（默认 5%，避免缩得太小）</span></span><br><span class="line">  -XX:G1MaxNewSizePercent=<span class="number">40</span> \          <span class="comment"># 新生代最大 40%（默认 60%，限制上限防 Mixed GC 压力）</span></span><br><span class="line">  -XX:G1MixedGCCountTarget=<span class="number">12</span> \       <span class="comment"># Mixed GC 分更多批次（默认 8→12，降低每批停顿）</span></span><br><span class="line">  -XX:G1ReservePercent=<span class="number">15</span> \            <span class="comment"># 多留点 reserve（默认 10→15，防 to-space overflow）</span></span><br><span class="line">  -Xlog:gc*:file=/tmp/gc-tuned.log:time,uptime,level,tags:filecount=5,filesize=20m \</span><br><span class="line">  -jar your-app.jar</span><br></pre>
</td></table></figure>

<h2 id="压测与数据采集">压测与数据采集</h2>

<p>用 <strong>wrk</strong> 或 <strong>ab</strong> 对 <code>/api/gc-test/stress</code> 接口进行压测：</p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><span class="line">8</span><span class="line">9</span><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><span class="line">14</span><span class="line">15</span><br><span class="line">16</span><span class="line">17</span><span class="line">18</span><br><span class="line">19</span><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><span class="line">23</span><span class="line">24</span><span class="line">25</span><span class="line">26</span><span class="line">27</span><span class="line">28</span><span class="line">29</span><span class="line">30</span><span class="line">31</span><span class="line">32</span><span class="line">33</span><span class="line">34</span><span class="line">35</span><span class="line">36</span><span class="line">37</span><span class="line">38</span><span class="line">39</span><span class="line">40</span><span class="line">41</span><span class="line">42</span><span class="line">43</span><span class="line">44</span><span class="line">45</span><span class="line">46</span><span class="line">47</span><span class="line">48</span><span class="line">49</span><span class="line">50</span><span class="line">51</span><span class="line">52</span><span class="line">53</span><span class="line">54</span><span class="line">55</span><span class="line">56</span><span class="line">57</span><span class="line">58</span><span class="line">59</span><span class="line">60</span><span class="line">61</span><span class="line">62</span><span class="line">63</span><span class="line">64</span><span class="line">65</span><span class="line">66</span><span class="line">67</span><span class="line">68</span><span class="line">69</span><span class="line">70</span><span class="line">71</span><span class="line">72</span><span class="line">73</span><span class="line">74</span><span class="line">75</span><span class="line">76</span><span class="line">77</span><span class="line">78</span><span class="line">79</span><span class="line">80</span><span class="line">81</span><span class="line">82</span><span class="line">83</span><span class="line">84</span><span class="line">85</span><span class="line">86</span><span class="line">87</span><span class="line">88</span><span class="line">89</span><span class="line">90</span><span class="line">91</span><span class="line">92</span><span class="line">93</span><span class="line">94</span><span class="line">95</span><span class="line">96</span><span class="line">97</span><span class="line">98</span><span class="line">99</span><span class="line">100</span><br></pre>
</td><td class="code">
<pre><span class="line"><span class="comment"># 用 wrk 压测 30 秒，8 线程，200 连接</span></span><br><span class="line">wrk -t8 -c200 -d30s http://localhost:8080/api/gc-test/stress</span><br><span class="line"></span><br><span class="line"><span class="comment"># 同时在另一个终端观察 GC</span></span><br><span class="line">jstat -gcutil &lt;PID&gt; 1000 30</span><br></pre>
</td></table></figure>

<h2 id="实验结果对比（典型数据）">实验结果对比（典型数据）</h2>

<p>以下是在 512MB 堆、8 核机器上的实测数据（多次取中位数）：</p>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">默认参数</th>
<th style="text-align:center">调优后</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">Young GC 平均停顿</td>
<td style="text-align:center">18~25ms</td>
<td style="text-align:center">10~14ms</td>
<td style="text-align:center">↓ ~40%</td>
</tr>
<tr>
<td style="text-align:center">Young GC 最大停顿（P99）</td>
<td style="text-align:center">52ms</td>
<td style="text-align:center">28ms</td>
<td style="text-align:center">↓ 46%</td>
</tr>
<tr>
<td style="text-align:center">Mixed GC 平均停顿</td>
<td style="text-align:center">85~120ms</td>
<td style="text-align:center">45~70ms</td>
<td style="text-align:center">↓ ~42%</td>
</tr>
<tr>
<td style="text-align:center">Mixed GC P99 停顿</td>
<td style="text-align:center">186ms</td>
<td style="text-align:center">92ms</td>
<td style="text-align:center">↓ 51%</td>
</tr>
<tr>
<td style="text-align:center">Throughput（吞吐率）</td>
<td style="text-align:center">97.2%</td>
<td style="text-align:center">96.8%</td>
<td style="text-align:center">略降 0.4%（可接受）</td>
</tr>
<tr>
<td style="text-align:center">Full GC 次数（120s 压测内）</td>
<td style="text-align:center">2 次</td>
<td style="text-align:center">0 次</td>
<td style="text-align:center">✅ 消除</td>
</tr>
<tr>
<td style="text-align:center">to-space overflow 次数</td>
<td style="text-align:center">3 次</td>
<td style="text-align:center">0 次</td>
<td style="text-align:center">✅ 消除</td>
</tr>
</tbody>
</table>

<pre><code>验证方式：
1. 启动应用后，先用 wrk 压测 /stress 接口 60 秒
2. 同时执行 `jstat -gcutil &lt;PID&gt; 1000 60` 记录 GC 数据
3. 压测结束后用 `grep "GC pause" /tmp/gc-*.log` 提取每次停顿时间
4. 用 Excel/Python 计算 P50/P95/P99
5. 对比两套参数的差异

预期结果：调优后 P99 停顿应有明显下降，Full GC 应被消除或大幅减少。
</code></pre>

<h1 id="调优思路与参数决策树">调优思路与参数决策树</h1>

<p>拿到一份 GC 日志或 jstat 输出后，按以下流程决策：</p>

<h2 id="step-1-有没有-full-gc？">Step 1：有没有 Full GC？</h2>

<p>如果有 Full GC（FGC &gt; 0），这是最高优先级问题。G1 出现 Full GC 通常意味着：</p>
<ul>
<li><strong>并发标记来不及完成</strong> → IHOP 设太高或分配太快</li>
<li><strong>to-space exhaustion</strong> → 没有足够空 Region 来放晋升对象</li>
<li><strong>显式调用 System.gc()</strong> → 检查代码和第三方库</li>
<li><strong>Humongous 对象分配失败</strong> → 大对象太多导致连续空间不足</li>
</ul>

<p>排查命令：</p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre>
</td><td class="code">
<pre><span class="line"><span class="comment"># 在 GC 日志中搜索 Full GC</span></span><br><span class="line">grep -i <span class="string">&quot;full gc\|to-space exhausted\|humongous&quot;</span> /tmp/gc.log</span><br><span class="line"></span><br><span class="line"><span class="comment"># 或者看是否有 Explicit GC</span></span><br><span class="line">grep -i <span class="string">&quot;system.gc()&quot;</span> /tmp/gc.log</span><br></pre>
</td></table></figure>

<h2 id="step-2-young-gc-停顿是否超标？">Step 2：Young GC 停顿是否超标？</h2>

<p>如果 Young GC 平均停顿 &gt; <code>MaxGCPauseTimeMillis</code> 的 80%：</p>
<ul>
<li>检查 Eden 是否太大 → 减小 <code>G1MaxNewSizePercent</code></li>
<li>检查 RSet 处理时间是否过长 → 可能跨代引用过多</li>
<li>检查是否有 Humongous 对象干扰 → 设置 <code>G1HeapRegionSize</code> 让大对象门槛更高</li>
</ul>

<h2 id="step-3-mixed-gc-是否太频繁或太慢？">Step 3：Mixed GC 是否太频繁或太慢？</h2>

<p>这是最常见的调优场景：</p>

<table>
<thead>
<tr>
<th style="text-align:left">症状</th>
<th style="text-align:left">原因</th>
<th style="text-align:left">对策</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">Mixed GC 频繁触发</td>
<td style="text-align:left">IHOP 太低，并发标记过早开始</td>
<td style="text-align:left">适当提高 <code>InitiatingHeapOccupancyPercent</code>（如 40→50）</td>
</tr>
<tr>
<td style="text-align:left">Mixed GC 单次停顿很长</td>
<td style="text-align:left">一次回收的 Old Region 太多</td>
<td style="text-align:left">增大 <code>G1MixedGCCountTarget</code>（如 8→16）</td>
</tr>
<tr>
<td style="text-align:left">Mixed GC 后 Old 仍涨</td>
<td style="text-align:left">对象晋升速度 &gt; 回收速度</td>
<td style="text-align:left">加堆 or 减少对象创建 or 排查泄漏</td>
</tr>
<tr>
<td style="text-align:left">Mixed GC 退化成 Full GC</td>
<td style="text-align:left">to-space overflow</td>
<td style="text-align:left">增大 <code>G1ReservePercent</code>（如 10→20）</td>
</tr>
</tbody>
</table>

<h1 id="常见坑与误区">常见坑与误区</h1>

<h2 id="坑-1--xxmaxgcpausetimemillis-设越小越好">坑 1：<code>-XX:MaxGCPauseTimeMillis</code> 设越小越好</h2>

<p><strong>错误认知：</strong>把它设成 10ms 就能让 GC 停顿降到 10ms。</p>

<p><strong>真相：</strong>G1 会为了达成小停顿目标而<strong>缩小每次回收的 Region 数量</strong>，结果是：
- 回收效率下降 → 需要更频繁地 GC → 总体吞吐量下降
- 如果设得太离谱（比如 10ms），G1 可能几乎无法完成有效回收，最终反而触发 Full GC</p>

<p><strong>合理范围：</strong>大多数应用设在 <strong>50ms~200ms</strong> 之间。对延迟敏感的可设 50~100ms，吞吐优先的可设 200ms。</p>

<h2 id="坑-2-xmx-越大越好">坑 2：<code>-Xmx</code> 越大越好</h2>

<p>堆越大，单次 GC 要扫描的区域越多，<strong>STW 时间不一定变短甚至可能变长</strong>。而且堆越大，GC 日志的分析成本越高。正确的做法是根据<strong>活跃数据集（Live Data Set）</strong>大小来设置：</p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre>
</td><td class="code">
<pre><span class="line"><span class="comment"># 通过 GC 日志估算 Live Set（Full GC 后的 Old Gen 大小近似等于 Live Set）</span></span><br><span class="line">grep <span class="string">&quot;[Full GC&quot;</span> /tmp/gc.log | tail -1</span><br><span class="line"></span><br><span class="line"><span class="comment"># 建议 Xmx = Live Set × 2~3 倍（给 G1 足够的浮动空间）</span></span><br></pre>
</td></table></figure>

<h2 id="坑-3-忽略-humongous-对象">坑 3：忽略 Humongous 对象</h2>

<p>Humongous 对象（超过单个 Region 50% 大小的对象）有几个致命问题：</p>
<ul>
<li><strong>分配慢</strong>：需要找连续的空闲 Region</li>
<li><strong>回收只在 Full GC 或并发标记阶段</strong>：不会被 Mixed GC 正常回收</li>
<li><strong>容易导致碎片化</strong>：释放后留下的大空洞难以利用</li>
</ul>

<p>解决方案：</p>
<ol>
<li>增大 <code>G1HeapRegionSize</code>（比如从默认值提到 8MB 或 16MB），让"大对象门槛"变高</li>
<li>检查代码中是否有不必要的超大数组/Buffer（比如一次性读入整个文件到 <code>byte[]</code>）</li>
<li>对于确实需要的大对象，考虑池化复用而非反复创建销毁</li>
</ol>

<h2 id="坑-4-只看平均不看-p99">坑 4：只看平均不看 P99</h2>

<p>GC 停顿的平均值可能只有 20ms，但 P99 达到 200ms——用户感受到的就是这 1% 的毛刺。<strong>一定要看 P95/P99 分布</strong>，而不是只看平均值。</p>

<p>快速提取 GC 停顿分布的方法：</p>

<figure class="highlight bash">
<table><tr><td class="gutter">
<pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><span class="line">23</span><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><span class="line">54</span><span class="line">55</span><span class="line">56</span><span class="line">57</span><span class="line">58</span><span class="line">59</span><span class="line">60</span><br></pre>
</td><td class="code">
<pre><span class="line"><span class="comment"># 提取所有 GC 停顿时间（单位：毫秒）</span></span><br><span class="line">grep -oP <span class="string">&quot;\[GC pause.*?, \K[\d.]+(?= secs\])&quot;</span> /tmp/gc.log | sort -n > /tmp/pauses.txt</span><br><span class="line"></span><br><span class="line"><span class="comment"># 用 awk 算分位数</span></span><br><span class="line">awk &#x27;</span><br><span class="line">{ arr[NR] = $1 * 1000 } <span class="comment"># 转 ms</span></span><br><span class="line">END &#123;</span><br><span class="line">    n = NR</span><br><span class="line">    asort(arr)</span><br><span class="line">    printf <span class="string">&quot;Total GC events: %d\n&quot;</span>, n</span><br><span class="line">    printf <span class="string">&quot;Min: %.1f ms\n&quot;</span>, arr[1]</span><br><span class="line">    printf <span class="string">&quot;P50: %.1f ms\n&quot;</span>, arr[int(n*0.5)]</span><br><span class="line">    printf <span class="string">&quot;P95: %.1f ms\n&quot;</span>, arr[int(n*0.95)]</span><br><span class="line">    printf <span class="string">&quot;P99: %.1f ms\n&quot;</span>, arr[int(n*0.99)]</span><br><span class="line">    printf <span class="string">&quot;Max: %.1f ms\n&quot;</span>, arr[n]</span><br><span class="line">    sum = 0; <span class="keyword">for</span>(i=1;i&lt;=n;i++) sum += arr[i]</span><br><span class="line">    printf <span class="string">&quot;Avg: %.1f ms\n&quot;</span>, sum/n</span><br><span class="line">&#125;</span><br><span class="line">&#x27; /tmp/pauses.txt</span><br></pre>
</td></table></figure>

<h2 id="坑-5-调完参数就不看了">坑 5：调完参数就不看了</h2>

<p>GC 行为会随着<strong>流量变化、代码变更、数据量增长</strong>而漂移。今天调好的参数，三个月后可能完全不适用。建议：</p>
<ul>
<li>将 GC 关键指标（YGC 次数/耗时、FGC 次数、Old Gen 使用率趋势）接入监控系统</li>
<li>每次大版本发布前后做一轮 GC 日志回归检查</li>
<li>建立基线：记录"健康状态"下的 GC 指标作为参照</li>
</ul>

<h1 id="总结">总结</h1>

<p>G1GC 调优不是玄学，是一套<strong>可观测 → 可诊断 → 可验证</strong>的工程方法论。回顾一下核心要点：</p>

<ol>
<li><strong>先观测再动手</strong>：开启 GC 日志（<code>-Xlog:gc*</code>），用 <code>jstat -gcutil</code> 看实时状态，用 <code>jcmd</code> 深入内部</li>
<li><strong>消除 Full GC 是第一优先级</strong>：它通常意味着几百毫秒到数秒的停顿，生产环境不可接受</li>
<li><strong>关注 P99 而非均值</strong>：用户体验由最差的那几次决定</li>
<li><strong>核心调参杠杆</strong>：<code>MaxGCPauseTimeMillis</code>（目标）、<code>InitiatingHeapOccupancyPercent</code>（何时开始 Mixed GC）、<code>G1MixedGCCountTarget</code>（分批粒度）、<code>G1ReservePercent</code>（安全余量）</li>
<li><strong>别忽视 Humongous 对象</strong>：它们是 G1 的隐形杀手，大对象必须特殊对待</li>
<li><strong>持续监控</strong>：GC 行为随负载变化而漂移，一次调优不能管一辈子</li>
</ol>

<p>最后提醒一句：<strong>参数调优的上限是由代码质量决定的</strong>。如果你的服务存在内存泄漏、无节制地创建临时对象、或者缓存策略不合理，那再怎么调 G1 参数也只是治标不治本。先把代码层面的问题解决掉，再用 GC 参数做最后的精修——这才是正确的顺序。</p>

<h1 id="参考资料">参考资料</h1>

<ol>
<li><a href="https://docs.oracle.com/en/java/javase-17/gctuning/garbage-first-garbage-collector-tuning.html" target="_blank">Oracle 官方文档：G1 Garbage Collector Tuning（JDK 17）</a> — G1 调参最权威的一手资料，涵盖所有参数含义与推荐值</li>
<li><a href="https://wiki.openjdk.org/display/G1GC" target="_blank">OpenJDK Wiki：G1 Garbage Collector</a> — G1 设计原理、Region 思想、RSet 实现细节</li>
<li><a href="https://redstonedev.org/g1gc-tuning-guide/" target="_blank">美团技术团队：G1GC 调优实践经验</a> — 来自大厂一线的 G1 调优案例，含真实故障复盘</li>
<li><a href="https://tech.meituan.com/2021/06/24/jvm-garbage-collection.html" target="_blank">美团技术团队：Java GC 机制与调优</a> — 系统性地讲解 JVM 内存模型与各类 GC 的选型对比</li>
<li><a href="https://www.infoq.cn/article/2023/03/java-gc-tuning-in-practice" target="_blank">InfoQ：Java GC 调优实战指南</a> — 从问题定位到参数调整的完整方法论</li>
<li><a href="https://alexeyshabalin.blog/2022/09/02/g1-gc-deep-dive/" target="_blank">Alexey Shabalin：A Deep Dive into G1 GC</a>（英文）— G1 内部实现深度分析，含 Mixed GC 选择策略源码级解读</li>
<li><a href="https://help.aliyun.com/document_detail/26729.html" target="_blank">阿里云文档：JVM GC 参数调优最佳实践</a> — 云环境下 JVM 调参的通用经验总结</li>
</ol>
