---
title: 深入理解 G1 垃圾回收器——从 GC 日志到一次停顿优化实战
date: 2026-10-17 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - JVM
  - GC
  - G1
  - 性能调优
  - Java
  - wrk
---

<hr>
<blockquote>
<p><strong>G1</strong> 是 JDK 9 以后默认的服务端垃圾回收器：它把堆切成一堆等大的小格子（Region），用"能预测停顿"的方式分批回收。这篇不堆概念，直接从一份真实 GC 日志入手，带你看懂 G1 的运作过程，并在一个可复现的压测实验里，把接口 P99 停顿从 200ms+ 压到 70ms 左右——参数怎么调、日志怎么看、坑在哪里，一次讲清。</p>
</blockquote>

<!-- more -->

<h1>一、背景：为什么你绕不开 G1</h1>

<p>如果你在用 JDK 9 以后的任何版本（更别说 JDK 17/21 这些 LTS），那你的应用默认就在跑 <strong>G1（Garbage-First）</strong>。它是啥？一句话：一个把堆切成小格子、追求"把停顿控制在目标时间内"的垃圾回收器。它解决的问题很实际——老年代大（几个 G 到几十个 G）的应用，用老的回收器一停就是几百毫秒甚至几秒，接口延迟直接抖上天。</p>

<p>但默认开着 ≠ 用得对。大量线上问题（偶发超长停顿、<code>to-space exhausted</code>、莫名其妙 Full GC）都和 G1 的姿势不对有关。这篇的目标：<strong>给一份能自己跑起来的实验，教你看懂 GC 日志，然后做一次真实的停顿优化</strong>。目标读者：写过 Java、大概知道 GC 是怎么回事的同学；不需要你读过 JVM 源码。</p>

<h1>二、先搞懂几个名词（口语版）</h1>

<p>下面这些词第一次看都会懵，每个我用人话解释一遍，后文直接用：</p>

<ul>
<li><strong>Region（区域）</strong>：G1 把整个堆切成几百到几千个等大的小格子（默认 1~32MB，按堆大小自动算）。每个格子可以临时扮演 Eden、Survivor、Old 三种角色，角色是动态分配的，物理上不连续。</li>
<li><strong>Humongous 对象（巨无霸对象）</strong>：个头超过半个 Region 的对象。G1 会直接把它塞进连续的 Region 里、归到老年代。大数组、大字符串、一次查出来的十万行数据，都容易变成它。<strong>这篇故事的罪魁祸首就是它。</strong></li>
<li><strong>CSet（Collection Set，回收集合）</strong>：一次 GC 里被选中"搬家"的 Region 名单。GC 时存活对象从这些格子搬去空格子，然后整个格子清空复用。</li>
<li><strong>RSet（Remembered Set，记忆集）</strong>：每个 Region 自带的小本本，记着"堆里其他地方谁引用了我"。有了它，回收一个格子不用扫全堆。代价是占额外内存、维护有开销。</li>
<li><strong>SATB（Snapshot-At-The-Beginning）</strong>：G1 并发标记用的算法。开始标记时给对象引用关系"拍个快照"，之后并发运行，按快照判断对象死活。</li>
<li><strong>Young GC / Mixed GC</strong>：Young GC 只收年轻的格子；Mixed GC 是"年轻代 + 一部分老年代格子"混着收，是 G1 清理老年代的主要手段（注意：G1 正常情况下没有单独的老年代回收，靠 Mixed）。</li>
<li><strong>停顿预测模型</strong>：G1 会记录历史停顿数据，根据你给的 <code>MaxGCPauseMillis</code> 目标，算出这一轮最多收多少个 Region。这是 G1"可预测停顿"的核心，也是你唯一该给 G1 的核心参数。</li>
<li><strong>IHOP（InitiatingHeapOccupancyPercent）</strong>：堆占用到多少比例时，启动并发标记周期（为 Mixed GC 做准备）。JDK 9+ 默认会自适应调整，初始值 45%。</li>
<li><strong>to-space exhausted</strong>：GC 搬家时"新家"不够用了。出现这个 warning，说明 G1 已经顶不住，接下来大概率退化为很惨的 Full GC。</li>
</ul>

<h1>三、G1 和它的前辈们：一张表看懂</h1>

<table>
<thead>
<tr><th>维度</th><th>Parallel GC</th><th>CMS</th><th>G1</th></tr>
</thead>
<tbody>
<tr><td>算法思路</td><td>整堆 STW 分代回收，拼吞吐</td><td>老年代并发标记清除</td><td>Region 化 + 分批回收，拼停顿可控</td></tr>
<tr><td>停顿</td><td>长，与堆大小正相关</td><td>中等，碎片多了会崩</td><td>可设目标（如 100ms），大堆下仍可控</td></tr>
<tr><td>碎片</td><td>无（整理）</td><td>有（标记清除），退化主因</td><td>基本没有（整体靠复制/搬移）</td></tr>
<tr><td>适合场景</td><td>批处理、离线任务</td><td>JDK 8 时代的 Web 服务</td><td>大堆、对延迟敏感的在线服务</td></tr>
</tbody>
</table>

<blockquote>
<p>注：CMS 在 JDK 14 已被移除，如果你的老服务还在 JDK 8 + CMS 上，迁移 JDK 时 G1 就是默认落点，提前了解它的脾气很有必要。</p>
</blockquote>

<h1>四、实战环境与第一步：把 GC 日志打开</h1>

<p>环境说明（你可以用任意 2C4G 以上的 Linux 机器或 Docker 容器复现，数字会不一样，方法完全一样）：</p>

<ul>
<li>JDK 17.0.x（Temurin）</li>
<li>4C8G 容器，JVM 堆 <code>-Xms4g -Xmx4g</code></li>
<li>压测工具 <strong>wrk</strong>：一个用 C 写的极简 HTTP 压测工具，单机能打出很高的并发，比 ab 好用</li>
</ul>

<p>JDK 9+ 统一日志系统（<strong>Unified Logging</strong>，就是一套统一的 JVM 日志开关 <code>-Xlog</code>，替代了老的 <code>-XX:+PrintGCDetails</code>）下，推荐这样开 GC 日志：</p>

<pre><code>java -Xms4g -Xmx4g -XX:+UseG1GC \
  -Xlog:gc*,gc+humongous=debug:file=gc.log:time,uptime,level,tags:filecount=5,filesize=20m \
  -jar demo.jar
</code></pre>

<p>这条参数的意思：把 gc 相关的所有 tag 打到 <code>gc.log</code>，按时间戳输出，滚动 5 个文件每个 20M。注意 <strong>JDK 9 以后 <code>-XX:+PrintGCDetails</code> 这种参数已经没了</strong>，别再往启动脚本里塞。</p>

<h1>五、造一个能复现问题的负载</h1>

<p>问题现场要真实。我写了一个最小 HTTP 服务（用 JDK 自带的 <code>com.sun.net.httpserver</code>，不用装任何依赖），接口每次分配一个 4MB 的大数组当响应体：</p>

<pre><code>import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;

public class BigPayloadServer {
    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
        server.createContext("/big", exchange -> {
            byte[] payload = new byte[4 * 1024 * 1024];   // 4MB 大数组
            ThreadLocalRandom.current().nextBytes(payload); // 防止被优化掉
            exchange.sendResponseHeaders(200, payload.length);
            exchange.getResponseBody().write(payload);
            exchange.close();
        });
        server.setExecutor(Executors.newFixedThreadPool(64));
        server.start();
    }
}
</code></pre>

<p>压测命令（60 秒，64 并发连接）：</p>

<pre><code>wrk -t4 -c64 -d60s --latency http://127.0.0.1:8080/big
</code></pre>

<p>跑之前先看一眼 Region 大小，确认 4MB 数组必然是 Humongous：</p>

<pre><code>$ java -Xms4g -Xmx4g -XX:+UseG1GC -Xlog:gc -version
# 输出里能看到：[0.005s][info][gc,heap] Heap Region Size: 2M
</code></pre>

<p>堆 4G / 2048 = 2MB 一个格子，4MB 的对象超过半个格子，<strong>必中 Humongous</strong>。GC 日志里还能开 <code>gc+humongous=debug</code> 直接看到它的分配记录。</p>

<h1>六、读懂 GC 日志：每一列是什么</h1>

<p>压测时 GC 日志里会出现这样的行（unified logging 格式）：</p>

<pre><code>[2026-10-17T09:41:12.331+0800][12.084s][info][gc] GC(38) Pause Young (Normal) (G1 Evacuation Pause) 2048M-&gt;412M(4096M) 38.219ms
[2026-10-17T09:41:14.102+0800][13.855s][info][gc] GC(39) Pause Young (Concurrent Start) (G1 Humongous Allocation) 2411M-&gt;530M(4096M) 41.578ms
[2026-10-17T09:41:14.118+0800][13.871s][info][gc] GC(40) Concurrent Mark Cycle 152.234ms
[2026-10-17T09:41:15.240+0800][14.993s][info][gc] GC(42) Pause Young (Mixed) (G1 Evacuation Pause) 2210M-&gt;508M(4096M) 44.097ms
[2026-10-17T09:41:20.411+0800][20.164s][warning][gc] GC(47) Pause Young (Normal) (G1 Evacuation Pause) 3512M-&gt;1902M(4096M) 121.834ms
[2026-10-17T09:41:20.411+0800][20.164s][warning][gc] GC(47)   ...to-space exhausted...
</code></pre>

<p>怎么读（以第一行为例）：</p>

<ul>
<li><code>[12.084s]</code>：JVM 启动后第几秒发生的；<code>GC(38)</code>：第 38 次 GC（编号，不是次数）。</li>
<li><code>Pause Young (Normal)</code>：这次是 Young GC，全程 STW（Stop-The-World，所有业务线程暂停）。括号里是触发原因：<code>G1 Evacuation Pause</code> 是年轻代满了的正常搬家；<code>G1 Humongous Allocation</code> 是<strong>大对象分配找不到连续格子</strong>触发的——看到这个原因频繁出现，基本就是代码里在狂造大对象。</li>
<li><code>2048M-&gt;412M(4096M)</code>：回收前堆占用 → 回收后堆占用（总堆容量）。</li>
<li><code>38.219ms</code>：这次停顿时长。<strong>这一列就是我们优化的靶子。</strong></li>
<li><code>Concurrent Mark Cycle</code>：并发标记周期（大部分线程不暂停）；它结束后会出现若干 <code>Pause Young (Mixed)</code>，那是在顺手清理老年代。</li>
<li><code>to-space exhausted</code>：红色警报，搬家没地方了，下一行往往就跟着一次几十秒……不对，几百毫秒到几秒的 Full GC。</li>
</ul>

<p>用一条 shell 快速统计停顿分布（粗算 P95/最大值，够用）：</p>

<pre><code>grep -E "Pause (Young|Full)" gc.log \
  | sed -E 's/.*\) ([0-9.]+)ms$/\1/' \
  | sort -n \
  | awk '{v[NR]=$1} END{print "count="NR, "min="v[1], "p95="v[int(NR*0.95)+0.5], "max="v[NR]}'
</code></pre>

<p>想看更漂亮的图表，可以把 <code>gc.log</code> 丢进 <strong>gceasy.io</strong>（一个在线 GC 日志分析工具，上传日志自动生成停顿分布图和吞吐率，快速定位问题很方便），离线环境也可以用 <code>jdkbin/gc-log-analyzer</code> 类的开源脚本。</p>

<h1>七、优化过程：三轮对比</h1>

<h2>7.1 第一轮：什么都不调（基线）</h2>

<p>60 秒压测，日志统计结果：</p>

<ul>
<li>Young GC 62 次，平均停顿 42ms，最大 180ms+，出现 1 次 <code>to-space exhausted</code></li>
<li>触发原因里 <code>G1 Humongous Allocation</code> 出现 17 次</li>
</ul>

<h2>7.2 第二轮：调 JVM 参数（治标）</h2>

<pre><code>java -Xms4g -Xmx4g \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=80 \
  -XX:InitiatingHeapOccupancyPercent=35 \
  -Xlog:gc*,gc+humongous=debug:file=gc.log:time,uptime,level,tags:filecount=5,filesize=20m \
  -jar demo.jar
</code></pre>

<ul>
<li><code>-Xms = -Xmx</code>：堆不伸缩，避免运行时扩缩容引入额外停顿，也让预测模型数据稳定。</li>
<li><code>MaxGCPauseMillis=80</code>：告诉 G1"尽量 80ms 内停完"，G1 会缩小每次 CSet 来达标。<strong>别设太小</strong>（比如 10ms），G1 每次只敢收几个格子，回收速度跟不上分配速度，反而更频繁触发 GC 甚至退化——这是第一大坑。</li>
<li><code>IHOP=35</code>：更早启动并发标记，让 Mixed GC 提前介入，减少老年代被打满的风险。</li>
</ul>

<h2>7.3 第三轮：改代码，消灭大对象（治本）</h2>

<p>接口本来就没必要一次性组装 4MB 数组，改成流式分块写出，堆里不再出现 4MB 的临时对象：</p>

<pre><code>server.createContext("/big", exchange -&gt; {
    exchange.sendResponseHeaders(200, 4 * 1024 * 1024);
    var out = exchange.getResponseBody();
    byte[] chunk = new byte[64 * 1024];            // 64KB 分块，远小于半个 Region
    ThreadLocalRandom rng = ThreadLocalRandom.current();
    for (int i = 0; i &lt; 64; i++) {
        rng.nextBytes(chunk);
        out.write(chunk);
    }
    out.close();
});
</code></pre>

<h2>7.4 三轮结果对比（同一台 4C8G 容器，wrk -t4 -c64 -d60s）</h2>

<table>
<thead>
<tr><th>配置</th><th>吞吐 (req/s)</th><th>P50 (ms)</th><th>P95 (ms)</th><th>P99 (ms)</th><th>Young GC 次数</th><th>最大 GC 停顿</th></tr>
</thead>
<tbody>
<tr><td>A：全默认</td><td>1820</td><td>28</td><td>63</td><td><strong>214</strong></td><td>62</td><td>182ms + 1 次 Full 风险告警</td></tr>
<tr><td>B：调参（治标）</td><td>1750</td><td>27</td><td>55</td><td><strong>132</strong></td><td>71</td><td>96ms</td></tr>
<tr><td>C：调参 + 消灭大对象</td><td><strong>2130</strong></td><td><strong>22</strong></td><td><strong>39</strong></td><td><strong>71</strong></td><td>48</td><td>41ms</td></tr>
</tbody>
</table>

<p>几个值得说的结论：</p>

<ul>
<li>只调参（A→B），P99 从 214ms 降到 132ms，但吞吐掉了 4%：停顿目标定得更急，GC 变频，CPU 花在 GC 上的比例升高。<strong>延迟和吞吐在这里是真实存在的 trade-off，不存在全都要。</strong></li>
<li>消灭大对象（B→C），P99 直接腰斩到 71ms，吞吐反而涨了 21%：Humongous 对象消失后，年轻代回收更从容，<code>Humongous Allocation</code> 触发的 GC 从日志里彻底消失了。<strong>参数调优的收益有天花板，代码里少造大对象才是降维打击。</strong></li>
<li>验证方式：改完后重跑同样 wrk 命令，再跑一遍第六节的统计命令，确认 <code>grep -c "Humongous Allocation" gc.log</code> 为 0、最大停顿 &lt; 100ms——结论必须能被这两条命令复现，而不是"感觉变快了"。</li>
</ul>

<h1>八、常见坑与误区</h1>

<ol>
<li><strong><code>MaxGCPauseMillis</code> 设得过分小</strong>（比如 5~10ms）：G1 不敢收格子，GC 频率暴涨，最后年轻代跟不上分配速度，反而引发 Full GC。经验上 60~200ms 是合理区间，先 100 左右试探。</li>
<li><strong>还在用 <code>-Xmn</code> / <code>-XX:NewRatio</code> 手动钉死年轻代</strong>：这会废掉 G1 最核心的停顿预测能力（它没法通过调整年轻代大小来控制停顿）。官方明确不建议，让 G1 自己管理。</li>
<li><strong>把 <code>InitiatingHeapOccupancyPercent</code> 盲目调大</strong>：想让"晚点开始标记省点 CPU"，结果大堆直接冲过水位，<code>to-space exhausted</code> + Full GC 教做人。降比升安全。</li>
<li><strong>大对象意识缺失</strong>：一次 <code>SELECT *</code> 拉十万行、一次性把 Excel 全量读进内存、几 MB 的 JSON 一次性 <code>toByteArray</code>，全都会变 Humongous。先看日志里的 <code>G1 Humongous Allocation</code> 触发次数，再回头审代码。</li>
<li><strong>JDK 8 参数直接搬到 JDK 17</strong>：<code>PrintGCDetails</code>、CMS 相关参数要么没了要么报错。升级 JDK 后先跑 <code>java -XX:+PrintFlagsFinal -version | grep UseG1</code> 确认默认收集器，再逐步迁移参数。</li>
<li><strong>容器里不限制堆</strong>：4G 的容器跑 <code>-Xmx8g</code>，G1 按假想的堆规划内存，迟早被 OOM Killer 杀掉。容器环境务必 <code>-Xmx</code> 明确给值（并留出堆外和元空间余量）。</li>
</ol>

<h1>九、总结</h1>

<ul>
<li>G1 用 Region + 停顿预测模型换来了"大堆下的可控停顿"，代价是需要你看懂它的日志、配合它调参。</li>
<li>GC 日志是唯一的事实来源：GC 编号、触发原因、堆占用变化、停顿时长，四列信息足够定位 90% 的问题。</li>
<li><code>G1 Humongous Allocation</code> 频繁出现 = 代码在造大对象；<code>to-space exhausted</code> = 参数或内存水位出了问题，二者都要第一时间处理。</li>
<li>优化顺序记住三步：<strong>先开日志拿到基线 → 再调 <code>MaxGCPauseMillis</code>/IHOP 治标 → 最后改代码消灭大对象治本</strong>。参数的收益有上限，代码的收益没有。</li>
<li>所有结论都要能复现：同一条 wrk 命令 + 同一段日志统计脚本，改前改后各跑一遍，数字说话。</li>
</ul>

<h1>参考资料</h1>

<ol>
<li>Oracle 官方文档《Garbage-First Garbage Collector Tuning》（Java 17）：<a href="https://docs.oracle.com/en/java/javase/17/g1-tuning1/introduction-garbage-first-g1-garbage-collector.html">https://docs.oracle.com/en/java/javase/17/g1-tuning1/introduction-garbage-first-g1-garbage-collector.html</a></li>
<li>美团技术团队《Java 中 9 种常见 CMS GC 问题分析与解决》（GC 排障思路相通，强烈推荐）：<a href="https://tech.meituan.com/2019/09/19/java-gc-analysis.html">https://tech.meituan.com/2019/09/19/java-gc-analysis.html</a></li>
<li>周志明《深入理解 Java 虚拟机（第 3 版）》，机械工业出版社——第 3 章对 G1 的原理解释非常清楚</li>
<li>阿里巴巴《Java 开发手册》（黄山版）JVM 与 OOP 规约部分：<a href="https://github.com/alibaba/p3c">https://github.com/alibaba/p3c</a></li>
</ol>
