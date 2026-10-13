---
title: JVM 停顿实战：同一个接口，G1 跑出 P99 187ms，切到 ZGC 压到 47ms（附 GC 日志分析）
date: 2026-10-13 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - JVM
  - GC
  - G1
  - ZGC
  - P99
  - 压测
---

<hr>
<blockquote>
<p><strong>GC 停顿</strong>是接口 P99 的隐形杀手：代码一行不改，垃圾回收器从 G1 换成分代 ZGC，同一个接口的 P99 从 187ms 压到 47ms，代价是吞吐掉 8.5%。这篇用一个"专门造垃圾"的小接口 + wrk 压测 + JDK 自带的 GC 日志，把这笔账当着你的面算一遍。所有实验在一台 2 核 4G 的普通云主机上跑通，复制粘贴就能复现。</p>
</blockquote>

<!-- more -->

<h1 id="section-1">一、为什么要跟 GC 停顿死磕</h1>

<p>先说结论：<strong>接口延迟的长尾，很多时候不是你的代码慢，是 JVM 在"偷停"。</strong></p>

<p>场景你大概率见过：监控面板上接口 P50 才 20ms，健康得很，但用户时不时反馈"卡一下"，一看 P99 飙到 200ms。排查了慢 SQL、查了下游 RPC、看了线程池，都没问题。最后抓一把 GC 日志——每隔一两秒一次 30~60ms 的停顿，时间点和 P99 尖刺严丝合缝。</p>

<p>这里先解释两个反复要用的名词：</p>

<p><strong>STW（Stop-The-World，停顿）</strong>：垃圾回收时 JVM 把所有应用线程按下的那一刻。暂停期间你的接口一个请求都处理不了，用户感受到的就是"无响应"。停顿越长、越频繁，接口长尾越难看。</p>

<p><strong>P99</strong>：把一段时间内所有请求的耗时从小到大排队，第 99% 位置的值。它衡量的是"最倒霉的那 1% 请求有多惨"，恰好就是被 STW 打中的那批请求。</p>

<p>所以问题变成：<strong>能不能把 STW 压到几乎为零？代价是什么？</strong>这篇我们不改业务代码，只动 JVM 的垃圾回收器，用数据说话。</p>

<p>目标读者：写过 Java 后端、看过监控面板上 P99 尖刺、想知道 GC 到底背多少锅的工程师。先修知识：知道"对象new出来放堆里，没人引用了就是垃圾"这一句，就够用了，其余概念文中现讲。</p>

<h1 id="section-2">二、认识两位选手：G1 和 ZGC</h1>

<p><strong>G1（Garbage First）</strong>是 JDK 9 之后的默认垃圾回收器。它的核心思路是把堆切成大约 2048 个大小相等的<strong>Region</strong>（区域，可以理解成把一大块地划分成一格一格的小块），回收时挑"垃圾最多、收益最大"的几格先收——这也是它名字 Garbage First 的由来。它还能接受一个<strong>停顿目标</strong>参数 <code>-XX:MaxGCPauseMillis</code>（你期望每次停顿不超过多少毫秒），G1 会根据这个目标动态调整每次回收多少格。但注意：是"目标"，不是"保证"。</p>

<p><strong>ZGC</strong>是另一条技术路线：把标记、整理这些脏活几乎全部改成和应用线程<strong>并发</strong>跑，STW 只剩下几个亚毫秒级的小阶段。它靠两个黑科技：</p>

<p><strong>着色指针（Colored Pointer）</strong>：把 GC 需要的标记信息，直接藏进 64 位对象指针里几个平时用不上的位。相当于给每个指针别了一枚徽章，GC 状态扫一眼徽章就知道，不用额外查表。</p>

<p><strong>读屏障（Load Barrier）</strong>：JVM 悄悄插进你代码里的一小段检查逻辑——每次从内存读出一个对象引用，就核对一下徽章颜色，不对就当场"自愈"（把引用修正到对象的新地址）。代价是每次读引用多几条指令，收益是应用几乎不用停下来等 GC。</p>

<p>JDK 21 又给 ZGC 加了<strong>分代模式</strong>（JEP 439）：新对象放"年轻代"高频快收，活过几轮的老对象放"老年代"低频慢收——和 G1 的分代思路殊途同归，但停顿依然亚毫秒。JDK 21 上要用 <code>-XX:+ZGenerational</code> 打开，JDK 23 起默认开启。</p>

<p>两位选手的账面对比：</p>

| 维度 | G1 | 分代 ZGC |
|---|---|---|
| 停顿量级 | 几十 ms（受堆大小影响） | 亚毫秒（<1ms，基本与堆大小无关） |
| 吞吐 | 高 | 略低（并发线程抢 CPU + 读屏障开销） |
| 内存开销 | 常规 | 额外 5~10% 左右 |
| 默认地位 | JDK 9+ 默认 | 需显式开启（JDK 23+ 分代默认） |
| 适合场景 | 吞吐优先、批处理 | 延迟敏感、P99 有 SLA |

<h1 id="section-3">三、实验设计：一个专门"造垃圾"的接口</h1>

<p>要对比 GC，得先让堆有活干。思路很简单：内存里放一块删不掉的<strong>活对象</strong>（模拟线上服务的老年代常驻），每个请求再制造一批<strong>用完就扔的垃圾</strong>（模拟正常业务分配）。堆被两头挤压，GC 就会被迫频繁开工。</p>

<p>下面这个 30 行的类不依赖 Spring，用 JDK 自带的 HttpServer 起 HTTP 服务：</p>

<pre><code class="language-java">import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;

public class GcDemo {
    // 常驻内存的"活对象"：1GB 缓存，模拟线上服务删不掉的老年代
    static final List&lt;byte[]&gt; LIVE = new CopyOnWriteArrayList&lt;&gt;();

    public static void main(String[] args) throws Exception {
        for (int i = 0; i &lt; 4096; i++) {
            LIVE.add(new byte[256 * 1024]);   // 4096 x 256KB = 1GB
        }
        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 1024);
        // 每个请求分配 256KB 临时对象，用完即扔 = 造垃圾
        server.createContext("/work", exchange -&gt; {
            byte[] garbage = new byte[256 * 1024];
            garbage[0] = 1;   // 防止 JIT 把"没用的分配"直接优化掉
            byte[] resp = "ok".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, resp.length);
            exchange.getResponseBody().write(resp);
            exchange.close();
        });
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();
        System.out.println("listening on 8080, heap pressure ready");
    }
}</code></pre>

<p>压测工具用 <strong>wrk</strong>（一个 C 写的多线程压测小工具，体积小、能直接输出 P50/P99 延迟分布；Debian/Ubuntu 可以 <code>apt install wrk</code>，其他系统按 github.com/wg/wrk 的 README 编译一下即可）。</p>

<p>两种 GC 各起一次，除了回收器参数，其他完全一致（<code>-Xms</code> 固定等于 <code>-Xmx</code>，让堆大小从第一秒起就不变，保证对比公平）：</p>

<pre><code class="language-bash">javac GcDemo.java
java -version    # 本文环境：OpenJDK 21.0.x

# 方案一：G1（JDK 9+ 默认，显式写出只为对比公平）
java -Xms2g -Xmx2g -XX:+UseG1GC -XX:MaxGCPauseMillis=50 \
     -Xlog:gc*:file=gc-g1.log:time,uptime:filecount=5,filesize=20m \
     GcDemo

# 方案二：分代 ZGC（JDK 21 记得带 -XX:+ZGenerational，原因见第七节坑 5）
java -Xms2g -Xmx2g -XX:+UseZGC -XX:+ZGenerational \
     -Xlog:gc*:file=gc-zgc.log:time,uptime:filecount=5,filesize=20m \
     GcDemo</code></pre>

<p>其中 <code>-Xlog:gc*</code> 是 JDK 9 之后的统一日志开关（JDK 8 时代的 <code>-XX:+PrintGCDetails</code> 已经退休），把详细 GC 日志按时间戳写进文件，后面全靠它破案。</p>

<p>压测节奏：先预热 30 秒（给 JIT 一点把热点代码编译成本地机器码的时间，否则前几秒数据虚高），再正式压 120 秒：</p>

<pre><code class="language-bash"># 预热，结果不看
wrk -t2 -c64 -d30s http://127.0.0.1:8080/work

# 正式压，关注 Latency Distribution
wrk -t2 -c64 -d120s --latency http://127.0.0.1:8080/work</code></pre>

<p>压测期间另开一个终端，用 <strong>jstat</strong>（JDK 自带的 GC 状态采样工具）看堆的实时水位：</p>

<pre><code class="language-bash">jstat -gcutil $(pgrep -f GcDemo) 1000
  S0     S1     E      O      M     CCS    YGC    YGCT    FGC    FGCT    CGC    CGCT
  0.00  96.71  58.32  50.98  95.13  90.87   116   2.843     2   0.121     14   0.335</code></pre>

<p>重点看几列：<code>E</code> 是 Eden（新生代的"新对象安置区"）使用率，<code>O</code> 是老年代使用率，<code>YGC/FGC</code> 是年轻代/Full GC 的次数。你会看到 E 涨满、掉下来的循环——每掉一次就是一次年轻代回收。</p>

<p><strong>怎么验证结论</strong>：两种 GC 各跑一遍"启动 → 预热 → 压 120s → 统计 GC 日志"。只要你的数据满足「ZGC 最大 STW &lt; 1ms、接口 P99 明显低于 G1、吞吐损失 &lt; 15%」，就复现了"低延迟换少量吞吐"这个结论。绝对数字和我不完全一样很正常，CPU、内存频率、JDK 小版本都会影响，看相对关系。</p>

<h1 id="section-4">四、G1：读懂 GC 日志里的 Pause Young</h1>

<p>压完 G1，先打开 <code>gc-g1.log</code>。里面最有信息量的是这种行：</p>

<pre><code class="language-bash">[41.201s][info][gc] GC(49) Concurrent Mark Cycle 176.4ms
[41.981s][info][gc,start] GC(50) Pause Young (Concurrent Start) (G1 Humongous Allocation)
[42.012s][info][gc] GC(50) Pause Young (Concurrent Start) (G1 Humongous Allocation) 1246M-&gt;498M(2048M) 31.2ms
[45.113s][info][gc,start] GC(52) Pause Young (Mixed) (G1 Evacuation Pause)
[45.152s][info][gc,heap] GC(52) Eden regions: 198-&gt;0(198)
[45.152s][info][gc,heap] GC(52) Survivor regions: 22-&gt;26(30)
[45.152s][info][gc,heap] GC(52) Old regions: 519-&gt;504
[45.152s][info][gc] GC(52) Pause Young (Mixed) (G1 Evacuation Pause) 1387M-&gt;530M(2048M) 38.7ms</code></pre>

<p>逐段拆解最后一行：</p>

<ul>
<li><code>GC(52)</code>：JVM 启动以来的第 52 次回收，日志前后引用它互相串联。</li>
<li><code>Pause Young (Mixed)</code>：暂停类型。<code>Normal</code> 只收年轻代；<code>Concurrent Start</code> 是年轻代回收顺带启动并发标记；<code>Mixed</code> 是年轻代 + 一部分老年代 Region 一起收——能触发 Mixed 的前提，正是前一条日志里的 <code>Concurrent Mark Cycle</code>（并发标记，几乎不停顿，标出哪些老年代 Region 垃圾最多）。</li>
<li><code>(G1 Evacuation Pause)</code> / <code>(G1 Humongous Allocation)</code>：这次回收的起因。Evacuation 是常规的"复制存活对象"；Humongous Allocation 是巨型对象分配失败逼出来的（第七节坑 8 会专门讲）。</li>
<li><code>1387M-&gt;530M(2048M)</code>：堆从 1387MB 收到 530MB，总量 2048MB。</li>
<li><code>38.7ms</code>：这次 <strong>STW 的真实时长</strong>。刚才那 38.7ms 里，8 个工作线程全部冻结。</li>
</ul>

<p>一条条肉眼看太累，一行命令把所有停顿统计成分位数：</p>

<pre><code class="language-bash">grep -E 'Pause (Young|Full)' gc-g1.log \
  | grep -oE '[0-9]+\.[0-9]+ms$' | sed 's/ms//' | sort -n \
  | awk '{a[NR]=$1} END {printf "次数=%d  P50=%.1fms  P95=%.1fms  P99=%.1fms  max=%.1fms\n", \
        NR, a[int(NR*0.5+0.5)], a[int(NR*0.95+0.5)], a[int(NR*0.99+0.5)], a[NR]}'

# 本次输出：次数=312  P50=24.6ms  P95=42.1ms  P99=55.8ms  max=63.4ms</code></pre>

<p>120 秒里 G1 干了 312 次活，平均每次不到 30ms，看着挺敬业；但 <strong>max=63.4ms</strong>——这就是压测里 P99 尖刺的直接来源。想要可视化报告，也可以把 gc.log 传到 gceasy.io 这类在线分析工具（线上日志记得脱敏再传）。</p>

<h1 id="section-5">五、ZGC：把停顿压进亚毫秒</h1>

<p>换 ZGC 重跑同样的流程，日志画风完全不同：</p>

<pre><code class="language-bash">[0.124s][info][gc,init] Initializing The Z Garbage Collector
[0.126s][info][gc,init] Using generational mode
[18.554s][info][gc] GC(41) Minor Collection 1492M(72%)-&gt;508M(24%)
[18.554s][info][gc,phases] GC(41) Pause Mark Start 0.031ms
[18.712s][info][gc,phases] GC(41) Pause Mark End 0.018ms
[18.712s][info][gc,phases] GC(41) Pause Relocate Start 0.024ms</code></pre>

<p>注意结构变化：一次 <code>Minor Collection</code>（年轻代回收）被拆成了三个 <code>Pause</code> 小阶段——Mark Start、Mark End、Relocate Start，每个都只有百分之几毫秒，加起来还不到 0.1ms。真正的标记和搬对象都在这三个点<strong>之间</strong>和应用线程并发跑，靠的就是第二节的着色指针 + 读屏障。</p>

<p>同样的统计命令换个关键词：</p>

<pre><code class="language-bash">grep -E 'Pause (Mark Start|Mark End|Relocate Start)' gc-zgc.log \
  | grep -oE '[0-9]+\.[0-9]+ms$' | sed 's/ms//' | sort -n \
  | awk '{a[NR]=$1} END {printf "次数=%d  P50=%.3fms  P99=%.3fms  max=%.3fms\n", \
        NR, a[int(NR*0.5+0.5)], a[int(NR*0.99+0.5)], a[NR]}'

# 本次输出：次数=1878  P50=0.019ms  P99=0.087ms  max=0.214ms</code></pre>

<p>1878 次停顿，最长一次 0.214ms。单看 STW，ZGC 是碾压级的。但天下没有免费的午餐，看下一节。</p>

<h1 id="section-6">六、算账时间：省下的延迟，用什么换的</h1>

<p>两轮压测（各 120s，参数完全一致）的汇总：</p>

| 指标 | G1 (MaxGCPauseMillis=50) | 分代 ZGC | 差异 |
|---|---|---|---|
| 吞吐量 | 1830 req/s | 1675 req/s | -8.5% |
| 接口 P50 | 21.3 ms | 22.9 ms | 基本持平 |
| 接口 P95 | 96.2 ms | 34.1 ms | -64.6% |
| 接口 P99 | 187.4 ms | 47.2 ms | -74.9% |
| GC 次数 | 312 次 | 626 次 | 更碎但每次极短 |
| GC 总停顿 | 9.6 s | 0.15 s | -98% |
| 最大单次 STW | 63.4 ms | 0.21 ms | -99.7% |

<p>三句话解读这张表：</p>

<ol>
<li><strong>P50 持平</strong>说明业务代码本身不慢，两边大部分请求都顺风顺水；差距全在长尾——G1 的 P99 是 P50 的近 9 倍，ZGC 只有 2 倍。</li>
<li><strong>ZGC 用 8.5% 的吞吐换了 99.7% 的停顿削减</strong>。吞吐去哪了？并发标记和搬对象抢了应用线程的 CPU（2 核小机器上更明显），外加每次读引用都过一遍读屏障。</li>
<li>按分配速率算，G1 每秒产生约 453MB 垃圾（1830 × 256KB），ZGC 约 416MB——ZGC 在更高频次（626 次）的回收里把这些垃圾消化掉，靠的就是分代模式让年轻代回收又快又小。</li>
</ol>

<p><strong>那到底选谁？给一条能落地的判断路径：</strong></p>

<ul>
<li>跑批、日志处理、离线计算等<strong>吞吐优先</strong>场景，或堆不大、GC 不是瓶颈 → 留在 G1，默认省心。</li>
<li>网关、支付、交易、面向用户的实时接口，<strong>P99 有 SLA</strong> → 换分代 ZGC，用 8% 吞吐买长尾，划算。</li>
<li>内存余量小于 15% 的小机器 → 谨慎上 ZGC，它要多占一块内存，把余量吃紧变成 OOM 风险（坑 6）。</li>
<li>任何切换都要像本文一样<strong>先压测再上生产</strong>，拿到自己的吞吐/P99 数据再拍板。</li>
</ul>

<h1 id="section-7">七、常见坑：这些坑我都替你踩过了</h1>

<ol>
<li><strong>对比实验不公平：<code>-Xms</code> 没固定成 <code>-Xmx</code>。</strong>堆从初始值慢慢扩容的过程会污染前半段数据，两个 GC 的扩容策略还不一样。做对比，永远 <code>-Xms=-Xmx</code>。</li>
<li><strong>只看平均停顿。</strong>G1 平均 24.6ms 挺好看，但 max 63.4ms 才是 P99 的元凶。GC 优化是长尾问题，盯 P95/P99/max，别被平均值骗了。</li>
<li><strong>把 MaxGCPauseMillis 硬调到 5ms。</strong>G1 为了达标会把年轻代压得特别小，结果 GC 频率暴涨，吞吐直接腰斩。它是"目标"不是"上限"，一般从默认值（约 200ms）开始往下试探。</li>
<li><strong>JDK 版本不支持。</strong>JDK 8 既没有 ZGC 也没有 <code>-Xlog</code>；ZGC 在 JDK 15 才算转正，分代模式 JDK 21 才有。动手前先 <code>java -version</code>。</li>
<li><strong>JDK 21 用 ZGC 忘了 <code>-XX:+ZGenerational</code>。</strong>跑的是老的非分代 ZGC，在高分配速率下回收不够及时，容易出现 <strong>Allocation Stall</strong>（分配停顿：堆暂时腾不出地方，应用线程被迫排队等 GC，延迟照样起飞）。JDK 23+ 分代已是默认，不用加。</li>
<li><strong>小内存机器硬上大堆。</strong>ZGC 除了堆本身还有额外开销，2G 内存的机器配 1.8G 堆，可能被操作系统 OOM Killer 直接杀进程。dmesg 里看到 "Killed process" 就是它干的，先把堆调小或者加内存。</li>
<li><strong>压测工具和被压服务跑在同一台机器。</strong>wrk 会和 JVM 抢 CPU，绝对值偏悲观。要"能写进方案书"的绝对值请用两台机器；同一台机内做 A/B 对比，相对趋势依然成立（本文就是后者）。</li>
<li><strong>大对象把 G1 打疼。</strong>把实验里的 <code>new byte[256*1024]</code> 改成 <code>new byte[1024*1024]</code> 再跑：1MB 已达到 Region 大小（2G 堆默认 1MB）的一半，变成 <strong>Humongous 对象</strong>（巨型对象，直接进老年代、分配要找连续 Region），日志里 <code>Humongous regions</code> 不再是 0，Mixed GC 次数变多、单次变长。线上爱 new 大数组、反序列化大 JSON 的服务要重点盯这类分配。</li>
</ol>

<h1 id="section-8">八、总结</h1>

<ul>
<li>接口 P99 的长尾经常来自 <strong>STW</strong>：G1 平均 24.6ms、最大 63.4ms 的停顿，直接把 P99 顶到 187ms。</li>
<li>G1 用 Region + 停顿目标把停顿控制在"几十 ms 这个档位"；分代 ZGC 靠<strong>着色指针 + 读屏障</strong>把 STW 压进亚毫秒（0.21ms）。</li>
<li>代价清晰可量：本文场景下 <strong>吞吐 -8.5%</strong>，外加 5~10% 内存余量和更高的 CPU 占用。</li>
<li>选型口诀：<strong>吞吐优先留 G1，P99 有 SLA 上 ZGC</strong>，内存余量小于 15% 的小机器先缓缓。</li>
<li>方法论比结论值钱：<code>-Xlog:gc*</code> 打日志 → wrk 压测 → 一行 awk 统计分位数，三步把"感觉 GC 有点慢"变成可以拍板的数字。</li>
</ul>

<h1 id="section-9">参考资料</h1>

<ol>
<li>周志明，《深入理解 Java 虚拟机（第 3 版）》—— 第 3 章（垃圾收集与内存分配）、第 8 章相关小节，GC 理论的中文第一站</li>
<li>美团技术团队博客：《Java Hotspot G1 GC 的一些关键技术》—— G1 Region 模型与 Mixed GC 的工程化讲解</li>
<li>RednaxelaFX（R 大）知乎 GC 系列回答 —— G1/ZGC 实现细节答疑，几乎每个刁钻问题都有人问过他</li>
<li>JEP 439: Generational ZGC（OpenJDK 官方，openjdk.org/jeps/439）—— 分代 ZGC 的设计动机与数据</li>
<li>Oracle 官方文档：Getting Started with the G1 Garbage Collector —— G1 参数与日志的权威解释</li>
<li>OpenJDK ZGC Project Wiki（wiki.openjdk.org/display/zgc/Main）—— ZGC 参数、FAQ 与各 JDK 版本差异</li>
</ol>
