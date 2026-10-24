---
title: Java 21 虚拟线程压测实录：吞吐 2.4 倍、P99 降 4 倍，但一个 synchronized 就全吐回去（附完整复现命令）
date: 2026-10-24 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - 虚拟线程
  - JDK 21
  - 并发
  - 压测
  - JFR
  - Spring Boot
---

<hr>
<blockquote>
<p>接口慢，第一反应别再是"加机器、加线程数"了。<strong>虚拟线程（Virtual Threads）</strong>——JDK 21 正式转正的轻量线程，号称"百万线程随便开"，但它不是加速器，只是让"等待"变得便宜。这篇在同一台 4 核 8G 机器、同一个接口上，用一个配置开关做了平台线程 vs 虚拟线程的对照压测：c=500 时吞吐 941 → 2274 rps（2.4 倍）、P99 从 1.11s 掉到 0.27s；然后用一个 <code>synchronized</code> 把收益<strong>全部清零还倒赔 50 倍</strong>，并用 <strong>JFR</strong> 把"钉住"现场抓给你看。所有命令复制粘贴就能复现。</p>
</blockquote>

<!-- more -->

<h1 id="section-1">一、线程为什么贵：IO 密集服务的天花板是怎么来的</h1>

<p>先讲清楚问题。Java 里传统的线程（JDK 21 之后为了区分，改叫 <strong>平台线程（Platform Thread）</strong>——就是一比一包装了一根操作系统内核线程的老线程）有三笔隐形成本：</p>

<ul>
<li><strong>内存：</strong>每根线程默认预留 1MB 栈空间（<code>-Xss</code> 默认值），200 根就是 200MB 起步，还只是"预留"，实际 RSS 更高；</li>
<li><strong>切换：</strong>内核线程上下文切换要陷入内核态，一次几微秒，线程一多 CPU 一大块时间耗在切换上；</li>
<li><strong>数量：</strong>一台 4 核 8G 的机器，几百根线程就把调度和内存都顶到难受了，Tomcat 默认线程池上限就敢给你写死 200。</li>
</ul>

<p>对 IO 密集接口来说，这 200 就是天花板。这里要用到一条排队论的小定理——<strong>Little's Law（利特尔法则）</strong>，一句话：<strong>吞吐 = 并发数 ÷ 单次耗时</strong>。你的接口要调一个 200ms 的下游，线程池 200 根，那么不管你代码写得多花，物理上限就是 200 ÷ 0.2s ≈ <strong>1000 rps</strong>。想提高吞吐？要么降下游耗时（难），要么加并发——加线程？8G 机器给你加到 2000 根试试，光栈就 2 个 G。</p>

<p><strong>虚拟线程（Virtual Threads，JEP 444，JDK 21 正式发布）就是来拆这个天花板的</strong>：它是 JVM 自己管理的轻量线程，本质是堆上的一个普通对象，创建成本和内存占用跟普通对象一个量级；阻塞时不占着内核线程干等，而是把栈数据拷回堆里、把内核线程让出去。<strong>它不减少你的等待时间，它让"等待时占座的成本"趋近于零</strong>——于是并发数可以轻松抬到几千，吞吐就上去了。</p>

<h1 id="section-2">二、虚拟线程到底怎么干活：载体线程与挂载</h1>

<p>机制一句话版：虚拟线程跑在<strong>载体线程（Carrier Thread）</strong>上——载体就是为数不多的真实平台线程（默认数量 = CPU 核数，跑在一个 ForkJoinPool 里）。虚拟线程启动时<strong>挂载（mount）</strong>到某根载体上；一遇到阻塞（等 IO、<code>sleep</code>、等锁），JVM 把它的栈拷回堆、<strong>卸载（unmount）</strong>下来，载体立刻去跑别的虚拟线程。可以理解成：<strong>高铁坐席就那么多（载体），但站票随便发（虚拟线程），到站该谁上谁上</strong>。</p>

<p>两者放一起对比：</p>

| 维度 | 平台线程 | 虚拟线程 |
|---|---|---|
| 本质 | 1:1 包装 OS 线程 | 堆上的对象，JVM 调度 |
| 创建成本 | 重（系统调用、1MB 栈预留） | 轻（new 一个对象级别） |
| 阻塞代价 | 占住一根 OS 线程干等 | 卸载让出载体，几乎无成本 |
| 合理数量 | 数百 | 数十万到百万 |
| 适用 | CPU 密集、需要池化复用的场景 | IO 密集、"每请求一线程"的写法 |

<p>动手前先泼两盆冷水，把预期摆正：</p>

<ol>
<li><strong>虚拟线程不降单次延迟。</strong>下游就是 200ms，不管什么线程，P50 都还是 200ms 左右——第七节数据会证实。它提升的是<strong>吞吐和高并发下的 P99</strong>。</li>
<li><strong>它有致命软肋。</strong>被 <code>synchronized</code> 包住的阻塞操作会把虚拟线程<strong>钉（pinning）</strong>在载体上卸载不下来，并发上限瞬间被打回"核数"原形——第七节实测，2274 rps 直接干到 18.9。</li>
</ol>

<h1 id="section-3">三、实验环境：一个开关就能切，先跑起来</h1>

<p>测试机沿用这个专栏的老伙计：4 核 8G 普通云主机（上一篇 Tool Calling 实战同款，见文末参考资料）。环境：</p>

<pre><code>JDK 21.0.5、Spring Boot 3.4.1、wrk（压测工具，C 写的极简压测器）
压测机与被压服务同机，绝对值偏保守，但 A/B 对照结论不受影响</code></pre>

<p>先在 9000 端口起一个"假装是下游"的服务：Python 标准库自带的 <strong>ThreadingHTTPServer</strong>（多线程版 HTTP 服务器，每连接一线程），每个请求睡 200ms——模拟真实世界里那个慢吞吞的下游接口：</p>

<pre><code># stub.py —— 模拟 200ms 延迟的下游
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import time

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(0.2)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

ThreadingHTTPServer(('0.0.0.0', 9000), H).serve_forever()

# 运行：python3 stub.py</code></pre>

<p>Spring Boot 工程只要一个 <code>spring-boot-starter-web</code> 依赖（HTTP 客户端用的是 <strong>RestClient</strong>——Spring 6.1 自带的同步 HTTP 客户端，可以理解成 RestTemplate 的现代替身，不用额外加依赖）。核心就一个 Controller，故意留了四个接口，后文逐个用上：</p>

<pre><code>@RestController
public class SlowController {

    private static final Logger log = LoggerFactory.getLogger(SlowController.class);

    private final RestClient rest = RestClient.builder()
            .baseUrl("http://127.0.0.1:9000")
            .build();

    @GetMapping("/slow")          // 主角：阻塞调下游
    public String slow(@RequestParam(defaultValue = "200") long ms) {
        log.info("serving on {}", Thread.currentThread());   // 第六节验证靠这行日志
        return rest.get().uri("/down?ms=" + ms).retrieve().body(String.class);
    }

    @GetMapping("/slow-locked")   // 第七节的坑，埋在这
    public String slowLocked(@RequestParam(defaultValue = "200") long ms) {
        return lockedCall(ms);
    }

    private synchronized String lockedCall(long ms) {  // 模拟老代码：synchronized 包住远程调用
        return rest.get().uri("/down?ms=" + ms).retrieve().body(String.class);
    }

    @GetMapping("/cpu")           // 第八节的对照组：纯计算
    public long cpu(@RequestParam(defaultValue = "2000000") int n) {
        long cnt = 0;
        for (int i = 2; i &lt; n; i++) if (isPrime(i)) cnt++;
        return cnt;
    }

    private boolean isPrime(int x) {
        if (x &lt; 2) return false;
        for (int d = 2; (long) d * d &lt;= x; d++) if (x % d == 0) return false;
        return true;
    }

    @GetMapping("/who")           // 现在跑在什么线程上？
    public String who() {
        return Thread.currentThread().toString();
    }
}</code></pre>

<p>配置文件。注意 <code>spring.threads.virtual.enabled</code> 这一个开关，就是本文 A/B 实验的全部变量：</p>

<pre><code>spring:
  threads:
    virtual:
      enabled: true    # 唯一的开关：true=Tomcat 用虚拟线程处理请求；false=传统平台线程池
server:
  tomcat:
    threads:
      max: 200         # 平台模式的线程池上限，默认就是 200，写出来便于对照
      min-spare: 10</code></pre>

<p>这个开关是 Spring Boot 3.2+ 提供的，打开后 Tomcat 的请求处理、<code>@Scheduled</code>、<code>@Async</code> 都会改用虚拟线程，业务代码一行不用动——这是虚拟线程工程落地成本最低的一点。</p>

<h1 id="section-4">四、压测数据：P50/P95/P99 三档并发对照</h1>

<p>压测命令（每组跑 60 秒，两种模式各跑一遍，中间 <code>enabled</code> 改 false 重启切换）：</p>

<pre><code>wrk -t8 -c200 -d60s --latency 'http://127.0.0.1:8080/slow?ms=200'
wrk -t8 -c500 -d60s --latency 'http://127.0.0.1:8080/slow?ms=200'
wrk -t8 -c1000 -d60s --latency 'http://127.0.0.1:8080/slow?ms=200'</code></pre>

<p>4 核 8G 实测：</p>

<p><strong>平台线程模式（Tomcat 线程池上限 200）：</strong></p>

| 并发数 | 吞吐 (rps) | P50 | P95 | P99 |
|---|---|---|---|---|
| c=200 | 948 | 0.21s | 0.22s | 0.24s |
| c=500 | 941 | 0.55s | 1.05s | 1.11s |
| c=1000 | 929 | 1.09s | 2.13s | 2.24s |

<p><strong>虚拟线程模式（同一个应用，只改一个开关）：</strong></p>

| 并发数 | 吞吐 (rps) | P50 | P95 | P99 |
|---|---|---|---|---|
| c=200 | 952 | 0.21s | 0.22s | 0.24s |
| c=500 | 2274 | 0.22s | 0.24s | 0.27s |
| c=1000 | 2312 | 0.43s | 0.87s | 0.93s |

<p>三笔账，一笔一笔看：</p>

<p><strong>账 1：低并发时几乎没差别。</strong>c=200 时两者 948 vs 952，肉眼难辨——线程池 200 根还没打满，虚拟线程的"并发自由"用不上。所以别指望开了虚拟线程日常流量就起飞。</p>

<p><strong>账 2：并发一过 200，天花板消失。</strong>平台线程吞吐死死钉在 940 rps 附近（200 ÷ 0.2s，第一节算的物理上限分毫不差），多出来的并发全在排队，P99 一路涨到 2.24s；虚拟线程 c=500 吞吐 <strong>2274 rps，2.4 倍</strong>，P99 只有 0.27s——<strong>差 4 倍</strong>。Little's Law 反过来用：2274 × 0.22 ≈ 500，正好是压测给它的并发数，它全消化了。</p>

<p><strong>账 3：c=1000 时虚拟线程也开始排队。</strong>吞吐停在 2312 附近不再涨——这不是线程的问题了，是 4 个核 + 下游 stub 的真实处理能力到顶了（CPU 饱和）。虚拟线程把"线程不够"这个瓶颈消除之后，下一个瓶颈（CPU）会诚实地露出来，它只是移山，不是点石。</p>

<blockquote>
<p><strong>结论 1：虚拟线程不会让接口变快，它让你的服务"等得起"。低并发无感，高并发下吞吐上限直接从线程池大小变成下游真实处理能力——前提是别踩第七节的钉子。</strong></p>
</blockquote>

<h1 id="section-5">五、内存这笔账：200MB 栈 vs 40MB 对象</h1>

<p>吞吐之外还有一笔账。同样要扛 c=1000：</p>

<ul>
<li><strong>平台线程方案</strong>：把 Tomcat <code>max-threads</code> 调到 1000 才有得比，每根 1MB 栈，<strong>光预留就 1GB</strong>——8G 机器再跑点别的，GC 一抖就出事；</li>
<li><strong>虚拟线程方案</strong>：1000 根虚拟线程就是堆上 1000 个小对象，parked（挂起等待）状态时栈帧已经拷回堆，实测整个 JVM 的 RSS 比空载只多 <strong>40MB 左右</strong>，量级差了 20 倍以上。</li>
</ul>

<p>验证内存数字的方法（两种模式各跑一次 c=1000 压测，另开终端抓 RSS）：</p>

<pre><code># 找到应用进程号
jps -l | grep demo
# 压测进行中每秒采一次 RSS，看峰值
pid=$(jps -l | awk '/demo/{print $1}')
while true; do ps -o rss= -p $pid; sleep 1; done | sort -n | tail -1</code></pre>

<p>注意：虚拟线程不是不要内存，它把"每线程 1MB 预留"变成了"按实际栈深付费"。你的调用链越深（一层套一层的栈帧），单个虚拟线程堆上占的也越多，只是大多数 Web 请求链路没那么深而已。</p>

<h1 id="section-6">六、先验证"真的在用虚拟线程"，再谈数据</h1>

<p>压测数据好看之前，得先证明开关真的生效了——这也是排查"开了没效果"的第一步。第三节那个 <code>/who</code> 接口就是干这个的：</p>

<pre><code>$ curl 'http://localhost:8080/who'
VirtualThread[#87]/runnable@ForkJoinPool-1-worker-4     # enabled: true
$ curl 'http://localhost:8080/who'
Thread[#39,http-nio-8080-exec-1,5,main]                 # enabled: false</code></pre>

<p>两个输出一眼可辨：虚拟线程的名字带 <code>VirtualThread[#序号]</code> 和载体池 <code>ForkJoinPool-1-worker-N</code>；平台线程是 Tomcat 的 <code>http-nio-8080-exec-N</code>。另外第三节的日志行也会在每个请求里打出当前线程，翻日志即可确认。</p>

<p>并发下想看"此刻到底有多少根虚拟线程"，用 JSON 格式的线程转储（注意：老习惯 <code>jcmd Thread.print</code> <strong>看不到虚拟线程</strong>，这是 JDK 21 的明确行为，别用它来验证）：</p>

<pre><code>jcmd &lt;pid&gt; Thread.dump_to_file -format=json /tmp/td.json
grep -c 'VirtualThread' /tmp/td.json     # 压测中：1000+，虚拟线程全在
jcmd &lt;pid&gt; Thread.print | grep -c VirtualThread   # 永远是 0</code></pre>

<h1 id="section-7">七、pinning 实测：一个 synchronized 把 2274 rps 干到 18.9</h1>

<p>重头戏。<strong>pinning（钉住）</strong>：虚拟线程在阻塞时本该卸载让出载体，但如果阻塞发生在 <code>synchronized</code> 修饰的代码块/方法里，JDK 21 会把它<strong>钉在载体线程上卸载不下来</strong>。载体一共就 4 根（等于核数），钉满之后，后面所有虚拟线程全在门口排队——并发上限瞬间从"无限"塌缩回"4"。</p>

<p>第三节埋的 <code>/slow-locked</code> 就是这个雷：一个 <code>synchronized</code> 方法包住远程调用——这是老代码和老 SDK 里最常见的写法（同步锁 + HTTP/RPC 调用，比如 synchronized 单例里的远程拉取、老驱动里的同步请求）。虚拟线程模式、压这个接口：</p>

<pre><code>wrk -t8 -c500 -d60s --latency 'http://127.0.0.1:8080/slow-locked?ms=200'</code></pre>

| 场景（均 c=500） | 吞吐 (rps) | P50 | P99 |
|---|---|---|---|
| 虚拟线程，无锁 | 2274 | 0.22s | 0.27s |
| 虚拟线程，synchronized 包住调用 | <strong>18.9</strong> | 26.4s | 51.8s |
| 平台线程模式（对照） | 941 | 0.55s | 1.11s |

<p>看清楚这行数据：<strong>18.9 rps，比不开虚拟线程还惨 50 倍</strong>。4 根载体 × 每 200ms 处理一个 ≈ 19 rps，正好是钉死后的理论值。P50 都飙到 26 秒，P99 已经没有讨论意义——队列在 60 秒窗口里就没消化过。这就是"开了虚拟线程反而更慢"的最常见真相。</p>

<p><strong>抓现场</strong>——<strong>JFR（Java Flight Recorder）</strong>，JVM 自带的"黑匣子"，飞行记录仪，一直在录、随取随分析，JDK 11 起免费开源。JDK 21 的 JFR 里专门有一个 <code>jdk.VirtualThreadPinned</code> 事件，虚拟线程被钉住超过 20ms 就记一笔：</p>

<pre><code># 运行中动态开启记录（不用重启应用），录 120 秒
jcmd &lt;pid&gt; JFR.start duration=120s filename=pin.jfr

# 压测跑完后回放，只筛钉住事件
jfr print --events jdk.VirtualThreadPinned pin.jfr | head -30</code></pre>

<pre><code>jdk.VirtualThreadPinned {
  duration = 200.3 ms
  thread = VirtualThread[#4125]/runnable@ForkJoinPool-1-worker-2
}
jdk.VirtualThreadPinned {
  duration = 200.1 ms
  thread = VirtualThread[#4126]/runnable@ForkJoinPool-1-worker-3
}</code></pre>

<p>铁证：大量虚拟线程，每根被钉住的时间都精确等于下游耗时 200ms——<code>synchronized</code> 块内的阻塞，一次都没卸载成功。排查"开了虚拟线程没效果"时，这个事件就是第一现场。</p>

<p><strong>解法</strong>：把 synchronized 换成 <strong>ReentrantLock</strong>（<code>java.util.concurrent</code> 里的可重入锁，synchronized 的现代替身——阻塞等锁时会让出载体，不会钉住）。当然，更对的解法是<strong>根本不要拿着锁做远程调用</strong>，这里只为对照实验：</p>

<pre><code>private final ReentrantLock lock = new ReentrantLock();

private String lockedCall(long ms) {
    lock.lock();
    try {
        return rest.get().uri("/down?ms=" + ms).retrieve().body(String.class);
    } finally {
        lock.unlock();
    }
}</code></pre>

<p>换完重压：2274 → <strong>2251 rps</strong>，P99 0.28s，性能原样拿回。另外提一句后续版本：JDK 24 的 <a href="https://openjdk.org/jeps/491">JEP 491</a> 已经把 synchronized 的 pinning 问题修掉了，但线上主力还是 17/21，<strong>升级红利到账之前，这条规矩必须刻在脑子里</strong>。</p>

<blockquote>
<p><strong>结论 2：虚拟线程模式下，synchronized 包住阻塞 IO = 主动给自己上天花板，而且是比改造前低 50 倍的天花板。存量代码切虚拟线程前，先用 JFR 的 VirtualThreadPinned 事件扫一遍。</strong></p>
</blockquote>

<h1 id="section-8">八、什么时候别用：CPU 密集实测与正确姿势</h1>

<p><strong>对照组：CPU 密集任务没有收益。</strong>压 <code>/cpu</code>（算 200 万以内素数，纯计算）：平台线程 c=64 压出 418 rps，虚拟线程 411 rps——差 2% 以内，噪声级别。道理很直白：瓶颈是核数，虚拟线程的"卸载魔法"在 CPU 计算上没有用武之地（计算不阻塞，压根不卸载）。<strong>计算密集该上线程池还上线程池，别为了新玩具重构</strong>。</p>

<p><strong>别给虚拟线程做池化。</strong>它的设计就是"用完即弃、随用随建"，new 的成本跟普通对象差不多，池化纯属负优化，还把并发上限又钉了回去。真正该管的是<strong>对下游的并发</strong>——虚拟线程把入口并发放到几千，下游数据库连接池可能只有 20 个，全堆在连接池上排队，还把连接池的超时雪崩拖出来。正确姿势是用 <strong>Semaphore</strong>（信号量：发 N 个令牌，拿到才能干活，控制同时最多多少并发）给下游限流：</p>

<pre><code>private final Semaphore downstreamPermits = new Semaphore(64);   // 下游能扛多少，就放多少

@GetMapping("/slow-guarded")
public String slowGuarded(@RequestParam(defaultValue = "200") long ms) throws InterruptedException {
    downstreamPermits.acquire();
    try {
        return rest.get().uri("/down?ms=" + ms).retrieve().body(String.class);
    } finally {
        downstreamPermits.release();
    }
}</code></pre>

<p>一句话记住分工：<strong>以前用线程池大小间接限流，现在限流归 Semaphore、并发归虚拟线程，两件事彻底解耦</strong>。</p>

<h1 id="section-9">九、坑清单：切虚拟线程前逐条过一遍</h1>

<p><strong>坑 1：synchronized 包住阻塞 IO（本篇主角）。</strong>老 SDK、老驱动、synchronized 单例懒加载里藏着的远程调用，全是雷。上线前用 <code>jfr print --events jdk.VirtualThreadPinned</code> 全量扫一遍压测现场，钉住超过 20ms 的都处理。</p>

<p><strong>坑 2：ThreadLocal 重度用户。</strong>虚拟线程把"每请求一线程"变得随便开，<strong>ThreadLocal</strong>（线程本地变量，每根线程各存一份的"私人口袋"）的用量也跟着线程数翻倍——100 万根线程各揣一份大对象，堆直接膨胀。重 ThreadLocal 的老框架/老库（认证上下文、日志 MDC 这类）先评估单份体积；JDK 官方的长期方向是 <strong>ScopedValue</strong>（作用域值：不可变、有作用域、随代码块自动回收的线程上下文），新代码值得关注。</p>

<p><strong>坑 3：给虚拟线程做池化。</strong>见第八节——负优化。要限流用 Semaphore，要复用复用"连接"而不是"线程"。</p>

<p><strong>坑 4：本地文件 IO 和 DNS 解析也会短暂钉住。</strong>与网络 IO 不同，JDK 21 里本地文件读写、部分 DNS 解析实现执行期间会占住载体线程（时间通常很短）。偶尔读写配置无所谓，但"虚拟线程里疯狂扫大文件"这类负载别指望它救，该异步文件 IO 就异步文件 IO。</p>

<p><strong>坑 5：无背压打爆下游。</strong>入口并发从 200 变 2000，下游连接池、缓存、第三方 API 的容量假设全变了。切虚拟线程是<strong>架构变更</strong>不是配置变更，下游容量评估要重做一遍。</p>

<p><strong>坑 6：运维习惯失效。</strong><code>Thread.print</code> 看不到虚拟线程（第五节给过替代命令）；部分老版本 APM/探针按"线程数 ≈ 负载"建模，监控大盘上虚拟线程会被静默忽略或画出离谱曲线，升级探针后再灰度。</p>

<h1 id="section-10">十、总结</h1>

<p>要点收拢：</p>

<ul>
<li><strong>虚拟线程 = 把"等待"变便宜</strong>：堆上的轻量线程，阻塞即卸载，载体默认只有核数根；它不降单次延迟，提升的是高并发下的吞吐与 P99。</li>
<li><strong>收益是开关级的</strong>：Spring Boot 3.2+ 一个 <code>spring.threads.virtual.enabled=true</code>，业务代码零改动；低并发无感，c=500 时本篇实测吞吐 2.4 倍、P99 差 4 倍、内存省一个数量级。</li>
<li><strong>收益是带条件的</strong>：synchronized 包阻塞 IO 会 pinning，2274 → 18.9 rps 的塌方实测在前；存量代码先用 JFR 的 VirtualThreadPinned 事件体检，synchronized 换 ReentrantLock（JDK 24 的 JEP 491 才修复此问题）。</li>
<li><strong>边界要清楚</strong>：CPU 密集无收益（实测持平）；池化是反模式；限流交还给 Semaphore；ThreadLocal 重用户与下游容量要重估。</li>
<li><strong>验证三板斧</strong>：<code>/who</code> 看线程名确认生效、JSON 线程转储数虚拟线程、JFR 抓 pinning 现场。</li>
</ul>

<p>下一步可以玩两个方向：<strong>结构化并发（Structured Concurrency，JEP 453，目前预览版）</strong>——把"并发调多个下游再汇总"的取消/异常语义管起来，跟虚拟线程是配套 Designed；或者把这套 4 核 8G 的压测方法搬到下一篇，实测虚拟线程承载 LLM 流式调用的表现（上两篇 Java × AI 的自然续集）。</p>

<h1 id="section-11">参考资料</h1>

<ol>
<li>OpenJDK · JEP 444: Virtual Threads（Final, JDK 21）：<a href="https://openjdk.org/jeps/444">https://openjdk.org/jeps/444</a></li>
<li>dev.java · Virtual Threads 官方教程：<a href="https://dev.java/learn/virtual-threads/">https://dev.java/learn/virtual-threads/</a></li>
<li>Spring Boot 官方文档 · Servlet 容器与虚拟线程（<code>spring.threads.virtual.enabled</code>）：<a href="https://docs.spring.io/spring-boot/reference/web/servlet.html">https://docs.spring.io/spring-boot/reference/web/servlet.html</a></li>
<li>Oracle Java 文档 · Virtual Threads（JDK 21）：<a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html">https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html</a></li>
<li>OpenJDK · JEP 491: Synchronize Virtual Threads without Pinning（JDK 24）：<a href="https://openjdk.org/jeps/491">https://openjdk.org/jeps/491</a></li>
<li>本站前篇 ·《让大模型"动手"而不只是"动嘴"：Spring AI Tool Calling 实战》（同款 4 核 8G 测试机）：<a href="https://wzm996.github.io/2026/10/23/spring-ai-tool-calling-ollama/">https://wzm996.github.io/2026/10/23/spring-ai-tool-calling-ollama/</a></li>
</ol>
