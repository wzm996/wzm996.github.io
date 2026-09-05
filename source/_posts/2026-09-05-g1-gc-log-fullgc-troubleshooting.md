---
title: 深入理解 G1 GC 日志：一次 Full GC 频繁问题的排查实战
date: 2026-09-05 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - JVM
  - GC
  - G1
  - 性能调优
  - Full GC
---
<hr>
<blockquote>
<p><strong>G1</strong>（Garbage First）是 JDK 9 以后 JVM 的默认垃圾收集器，但不少同学对它的认识还停留在"听说过"。这篇用一个<strong>可复现</strong>的「Full GC 频繁」案例，把 G1 日志的采集、逐行解读、根因定位、调参验证完整走一遍——照着做，你在自己机器上也能复现同一个问题，并且亲手把它治好。</p>
</blockquote>

<!-- more -->

<h1>一、背景：凌晨的告警群</h1>

<p>先交代下场景：某天凌晨告警群炸了，订单查询接口 P99 延迟从 80ms 飙到 1.2s，机器没挂、CPU 不高、网络正常，就是"卡"。登上机器跑 <code>jstat</code> 一看，<strong>FGC（Full GC 次数）在肉眼可见地往上跳</strong>。</p>

<p>这篇文章要解决的就是这类问题：<strong>不靠玄学猜，用 GC 日志把根因钉死，再用压测数据验证修复效果</strong>。目标读者是有一定 Java 基础（知道新生代/老年代概念）的后端同学，不需要预先了解 G1 的实现细节。</p>

<h1>二、5 分钟补课：G1 到底是怎么干活的</h1>

<p><strong>G1</strong>：JDK 9 起的默认垃圾收集器。它把堆切成一堆大小相等的 <strong>Region</strong>（"地块"，每块 1~32MB、2 的幂），Eden、Survivor、Old 不再要求物理连续。回收时优先挑"垃圾最多、收益最大"的 Region 先收——这就是名字 Garbage First 的由来。它解决的问题：大堆（几 GB 到几十 GB）下，老式收集器要么停顿太长、要么吞吐崩掉；G1 允许你设一个停顿目标（<code>-XX:MaxGCPauseMillis</code>，默认 200ms），它尽量满足。</p>

<p>几个高频新名词，每个用一句话说清：</p>

<ul>
<li><strong>Humongous 对象</strong>：大小超过 Region 一半的对象，会直接占用连续 Region。一句话：巨型对象，容易把堆"扎成筛子"，是很多 Full GC 的元凶。</li>
<li><strong>Young GC</strong>：年轻代 Region 满了触发的停顿收集，存活对象被搬到 Survivor 或晋升 Old。</li>
<li><strong>Mixed GC</strong>：G1 的主力回收方式，"年轻代 + 挑一部分老年代 Region"一起收，分多轮（<code>G1MixedGCCountTarget</code>，默认 8）逐步清老年代。</li>
<li><strong>Full GC</strong>：兜底的全堆压缩回收（JDK 10+ 改为并行）。一旦出现，说明前两道防线都失守了，停顿随堆大小线性增长，秒级很常见。</li>
<li><strong>IHOS</strong>（Initiating Heap Occupancy Percent，默认 45%）：老年代占用超过这个比例就启动并发标记周期，为 Mixed GC 做准备。一句话：老年代"该打扫了"的水位线。</li>
</ul>

<h1>三、第一步：把日志打开（可复现）</h1>

<p>排查 GC 问题的前提是<strong>有日志</strong>。JDK 9+ 用统一日志（<strong>UL</strong>，Unified Logging——以前的 <code>-XX:+PrintGCDetails</code> 那套开关在 9 里废弃了，UL 是它的替代品，语法统一、可按模块过滤）：</p>

<pre><code class="language-bash">java -Xms2g -Xmx2g \
  -Xlog:gc*,gc+humongous=debug:file=/tmp/gc-%t.log:time,uptime,level,tags:filecount=5,filesize=50m \
  -jar order-service.jar
</code></pre>

<p>逐个解释：</p>

<ul>
<li><code>-Xlog:gc*</code>：打开全部 GC 相关日志；</li>
<li><code>gc+humongous=debug</code>：额外打印巨型对象分配明细（排 Humongous 问题必备）；</li>
<li><code>filecount=5,filesize=50m</code>：日志滚动，防止把磁盘写爆；</li>
<li><code>time,uptime,level,tags</code>：每行日志带时间戳、JVM 启动后秒数、级别和标签，方便和业务监控对时间线。</li>
</ul>

<p>再配一个快速观测命令：</p>

<pre><code class="language-bash">jstat -gcutil &lt;pid&gt; 1000
</code></pre>

<p>输出里重点看三列：<strong>O</strong>（老年代占用 %）、<strong>FGC</strong>（Full GC 次数）、<strong>FGCT</strong>（Full GC 累计耗时）。如果 FGC 每分钟都在涨，基本可以确诊"Full GC 频繁"。</p>

<p><strong>验证方式</strong>：<code>/tmp/gc-*.log</code> 文件开始滚动生成，且 <code>jstat</code> 每秒刷新一行。</p>

<h1>四、第二步：逐行读懂一份 G1 日志</h1>

<p>拿一条典型的 Young GC 日志（已简化排版）：</p>

<pre><code>[2026-09-05T02:14:31.512+0800][12.345s][info] GC(128) Pause Young (Normal) (G1 Evacuation Pause)
[2026-09-05T02:14:31.512+0800][12.345s][info] GC(128)   Eden regions: 1024-&gt;0(1024)
[2026-09-05T02:14:31.512+0800][12.345s][info] GC(128)   Survivor regions: 16-&gt;96(128)
[2026-09-05T02:14:31.512+0800][12.345s][info] GC(128)   Old regions: 512-&gt;518
[2026-09-05T02:14:31.512+0800][12.345s][info] GC(128)   Humongous regions: 37-&gt;37
[2026-09-05T02:14:31.515+0800][12.348s][info] GC(128) Pause Young (Normal) (G1 Evacuation Pause) 1200M-&gt;640M(2048M) 2.970ms
[2026-09-05T02:14:31.515+0800][12.348s][info] GC(128) User=0.02s Sys=0.00s Real=0.003s
</code></pre>

<p>重点字段：</p>

<ul>
<li><code>(G1 Evacuation Pause)</code>：触发原因是"搬迁存活对象"这种常规回收；如果这里写的是 <code>(G1 Humongous Allocation)</code>，就是巨型对象触发的，要警惕；</li>
<li><code>1200M-&gt;640M(2048M)</code>：回收前后的堆占用与总大小。<strong>收完还剩多少、能撑多久，是判断回收"有没有用"的关键</strong>；</li>
<li><code>Humongous regions: 37-&gt;37</code>：巨型对象一个都没回收掉——它们还活着，继续看；</li>
<li><code>Real=0.003s</code>：真实停顿时间（wall time），做 SLA 判断要用它，不是 user 时间。</li>
</ul>

<p>两个危险信号，见到就要警觉：</p>

<ul>
<li><code>To-space exhausted</code>：搬迁对象时目标空间不够了，G1 会被迫放弃增量回收、退化为更昂贵的路径，紧接着常常就是 Full GC；</li>
<li><code>Pause Full (G1 Compaction Pause)</code>：Full GC 本尊，出现即告警。</li>
</ul>

<p>几个常用的统计命令（可直接复制）：</p>

<pre><code class="language-bash"># 统计 Full GC 次数
grep -c 'Pause Full' /tmp/gc-*.log

# 找出停顿最长的 5 次回收
grep -oE 'Pause [A-Za-z ()]+ [0-9.]+ms' /tmp/gc-*.log | sort -t= -k2 -n | tail -5

# 看巨型对象分配记录
grep 'humongous' /tmp/gc-*.log | head -20
</code></pre>

<h1>五、第三步：定位根因（三条最常见的路）</h1>

<h2>路线 A：Humongous 风暴（本案例的元凶）</h2>

<p>日志里 <code>Humongous regions</code> 持续增长、触发原因频繁出现 <code>(G1 Humongous Allocation)</code>，就顺着大对象查。先用 <code>jmap -histo:live &lt;pid&gt; | head -30</code> 看存活对象直方图，很快就能发现某个 <code>ArrayList</code> / DTO 数组体积异常。</p>

<p>本案例根因：一个导出接口把 40 万行记录一次性塞进一个 <code>List</code>，单次分配 300MB+，远超 Region 一半，每次请求都制造一批巨型对象；并发一上来，老年代迅速打满，IHOS 被反复击穿，最后 Full GC。</p>

<h2>路线 B：并发标记跟不上 / To-space exhausted</h2>

<p>日志特征：大量 <code>To-space exhausted</code>、并发标记周期结束立刻进入 Full GC。方向：调低 IHOS 让标记提前启动、调大 <code>G1ReservePercent</code>（预留防手忙脚乱的空间）、或者干脆加大堆。</p>

<h2>路线 C：堆真的太小 / 元空间误会</h2>

<p>如果每轮回收后 <code>Heap</code> 占用长期 &gt;85%，说明不是回收策略问题，是堆就不够装；另外 Metaspace 持续增长（比如动态类生成失控）也会被误判成堆问题，<code>jstat -gcmetacapacity</code> 或日志里的 Metaspace 字段可以排除。</p>

<p>两个趁手的补充工具：**JFR**（Java Flight Recorder，JVM 自带的"飞行记录仪"，开销低于 1%，持续记录分配、GC、锁等事件）适合线上常开；**async-profiler**（低开销采样工具，能出 CPU/分配火焰图）适合本地复现时定位"谁在分配大对象"。</p>

<h1>六、第四步：改代码 + 调参 + 压测验证</h1>

<p>修复分两层。代码层是治本：导出接口改为分页流式写文件，单次在内存里维护的对象从 300MB 降到 5MB 以内，巨型对象直接消失。参数层是治标兜底，调整如下：</p>

<table>
<thead><tr><th>参数</th><th>调整前</th><th>调整后</th><th>为什么</th></tr></thead>
<tbody>
<tr><td>-Xms / -Xmx</td><td>1g / 2g</td><td>2g / 2g</td><td>两者一致，避免动态扩缩容带来的额外停顿</td></tr>
<tr><td>MaxGCPauseMillis</td><td>200（默认）</td><td>100</td><td>压测后定的，不是拍脑袋；调太小会反噬吞吐</td></tr>
<tr><td>InitiatingHeapOccupancyPercent</td><td>45</td><td>35</td><td>并发标记提前启动，别等水位击穿</td></tr>
<tr><td>G1ReservePercent</td><td>10（默认）</td><td>20</td><td>防 To-space exhausted</td></tr>
<tr><td>G1HeapRegionSize</td><td>自动（2m）</td><td>4m</td><td>略大的 Region 减少"误判 Humongous"</td></tr>
</tbody>
</table>

<p>压测验证（4C8G 容器，500 并发持续 5 分钟，数据为本文复现环境的示意量级，你的绝对值一定不同，看相对变化）：</p>

<table>
<thead><tr><th>指标</th><th>调整前</th><th>调整后</th></tr></thead>
<tbody>
<tr><td>吞吐（req/s）</td><td>1 850</td><td>2 430</td></tr>
<tr><td>P50 延迟</td><td>62 ms</td><td>48 ms</td></tr>
<tr><td>P95 延迟</td><td>210 ms</td><td>96 ms</td></tr>
<tr><td>P99 延迟</td><td>1 240 ms</td><td>152 ms</td></tr>
<tr><td>Full GC 次数（整个压测）</td><td>14</td><td>0</td></tr>
<tr><td>Young GC 平均停顿</td><td>28 ms</td><td>22 ms</td></tr>
</tbody>
</table>

<p><strong>怎么验证结论</strong>：压测期间开两个终端，一个跑 <code>jstat -gcutil &lt;pid&gt; 1000</code> 盯 FGC，一个 <code>tail -f</code> GC 日志；压测结束后 <code>grep -c 'Pause Full'</code> 应为 0，P99 与吞吐对比压测报告。复现整个实验只需要：一份会"一次查全表"的示例接口 + 第三节的启动参数 + 任意压测工具（wrk/JMeter 都行）。</p>

<h1>七、常见坑</h1>

<ul>
<li><strong>Xms 与 Xmx 不一致</strong>：堆扩缩会引入额外停顿，生产上尽量拉平；</li>
<li><strong>MaxGCPauseMillis 拍脑袋调太小</strong>：G1 会压缩每次回收的目标 Region 数，结果回收变频繁、吞吐反降——参数要用压测定；</li>
<li><strong>只调参不改代码</strong>：大对象是代码问题，参数只是缓解，治标不治本；</li>
<li><strong>Metaspace 误判</strong>：类加载泄漏（大量动态代理/字节码生成）表现像堆问题，先排除；</li>
<li><strong>用 JDK 8 老版本的体验评价 G1</strong>：8u40 之前的 G1 bug 很多，JDK 11/17 的 G1 已经成熟得多；</li>
<li><strong>GC 日志没配滚动</strong>：<code>filecount</code>/<code>filesize</code> 加上，别让排障工具自己变成故障。</li>
</ul>

<h1>八、总结</h1>

<ul>
<li>G1 排查闭环：<strong>开日志 → 看"触发原因 + Heap 行" → 三条路线定根因（Humongous / 并发跟不上 / 堆太小）→ 改代码 + 调参 → 压测验证</strong>；</li>
<li>Full GC 是兜底机制，出现即说明前两道防线失守，别只盯着 Full GC 本身调参；</li>
<li><code>Humongous regions</code> 和 <code>To-space exhausted</code> 是日志里最有信息量的两个信号；</li>
<li>所有参数调整必须回到压测数据验证，P99 与 Full GC 次数是最诚实的两个指标。</li>
</ul>

<h1>参考资料</h1>

<ol>
<li>Oracle 官方文档：《Garbage-First Garbage Collector Tuning》（docs.oracle.com）</li>
<li>Oracle 官方文档：《Java Platform, Standard Edition Tools Reference》—— <code>-Xlog</code> 统一日志语法</li>
<li>JEP 248: Make G1 the Default Garbage Collector</li>
<li>JEP 307: Parallel Full GC for G1</li>
<li>周志明：《深入理解 Java 虚拟机（第 3 版）》第 3 章（垃圾收集器与内存分配策略）</li>
<li>美团技术团队博客：Java Hotspot G1 GC 相关技术文章（tech.meituan.com）</li>
<li>async-profiler：GitHub 开源仓库（github.com/async-profiler/async-profiler）</li>
<li>阿里巴巴：《Java 开发手册》—— 关于集合与大对象使用的强制规约</li>
</ol>
