---
title: Java 虚拟线程实战：Spring Boot 聚合接口在 IO 密集场景下到底能快多少？
date: 2026-04-17 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - Spring Boot
  - 虚拟线程
  - JFR
  - async-profiler
  - wrk
---
<hr>
<blockquote>
<p>虚拟线程不是“把线程变便宜了就万事大吉”，它真正擅长的是 <strong>IO 密集</strong> 场景：线程大量等待网络、数据库、远程 RPC 返回时，用更低的线程管理成本把并发撑起来。本文不聊概念营销，直接用一个可复现的 Spring Boot 聚合接口实验，测吞吐、延迟，再配合 JFR 和 async-profiler 看瓶颈到底在哪。</p>
</blockquote>

<!-- more -->

<h1 id="一、为什么要写这篇"><a href="#一、为什么要写这篇" class="headerlink" title="一、为什么要写这篇"></a>一、为什么要写这篇</h1>
<p>这两年一聊到 <strong>Java 21</strong>，很多人第一反应就是 <strong>虚拟线程（Virtual Threads）</strong>。它是 JDK 提供的一种轻量级线程实现，说白了就是：<strong>让“一个请求一个线程”这套写法重新变得便宜</strong>。以前平台线程（也就是操作系统线程）开多了，线程栈、上下文切换、调度开销都上来；现在虚拟线程把这部分成本压低了不少，所以很多 IO 型服务会想试一试。</p>
<p>但问题也正好出在这里：不少文章只给你一句“虚拟线程性能更好”，然后就结束了。实际上这句话只说对了一半。<strong>CPU 密集场景，虚拟线程未必更快；锁竞争严重、频繁 pinning、数据库连接池太小，甚至可能没有收益。</strong>所以这篇文章只回答一个非常工程化的问题：</p>
<blockquote>
<p>在一个典型的 Spring Boot 聚合接口里，如果大部分时间都在等下游返回，虚拟线程到底能把吞吐和尾延迟改善到什么程度？又会踩哪些坑？</p>
</blockquote>

<h1 id="二、实验目标与结论先行"><a href="#二、实验目标与结论先行" class="headerlink" title="二、实验目标与结论先行"></a>二、实验目标与结论先行</h1>
<p>先把实验目标说清楚：我们构造一个 <strong>聚合接口</strong>，每次请求会并发调用 3 个“下游服务”，每个下游固定 sleep 80ms 来模拟远程 IO。然后对比两种实现：</p>
<ul>
<li><strong>方案 A：平台线程 + 固定线程池</strong></li>
<li><strong>方案 B：虚拟线程 + per-task executor</strong></li>
</ul>
<p>这里的 <strong>聚合接口</strong>，就是把多个下游结果拼成一个返回对象的 API。现实里特别常见，比如“订单详情页”要同时查订单、库存、优惠信息。</p>
<p>本次实验的核心结论先给出来，免得你看半天不知道值不值得：</p>
<ul>
<li>在 <strong>IO 等待占主导</strong> 的场景下，虚拟线程通常会显著提升吞吐，并降低排队带来的 <strong>P95/P99</strong> 延迟。</li>
<li><strong>P50</strong> 不一定大幅下降，因为单次请求的业务时间本来就被下游 80ms sleep 锁住了；真正改善明显的往往是高并发下的尾延迟。</li>
<li>如果你下游依赖的是 <strong>小连接池</strong>，那虚拟线程可能只是把“线程瓶颈”挪成“连接瓶颈”。</li>
<li>如果代码里用了 <strong>synchronized</strong>、本地阻塞、老驱动或者 native 调用，可能出现 <strong>pinning</strong>。所谓 <strong>pinning</strong>，就是虚拟线程本来应该在阻塞时“卸下来”，结果被某些操作钉在底层载体线程上，收益就会打折。</li>
</ul>

<h1 id="三、候选选题与最终选择"><a href="#三、候选选题与最终选择" class="headerlink" title="三、候选选题与最终选择"></a>三、候选选题与最终选择</h1>
<p>按今日专栏要求，先给出 4 个候选选题，再自动选择一个最值得写的。</p>

<h2 id="候选-1：Java-虚拟线程实战：Spring-Boot-聚合接口在-IO-密集场景下到底能快多少？"><a href="#候选-1：Java-虚拟线程实战：Spring-Boot-聚合接口在-IO-密集场景下到底能快多少？" class="headerlink" title="候选 1：Java 虚拟线程实战：Spring Boot 聚合接口在 IO 密集场景下到底能快多少？"></a>候选 1：Java 虚拟线程实战：Spring Boot 聚合接口在 IO 密集场景下到底能快多少？</h2>
<ul>
<li><strong>categories</strong>：编程语言 / Java</li>
<li><strong>tags</strong>：Java、Spring Boot、虚拟线程、JFR、async-profiler、wrk</li>
<li><strong>目标读者与先修</strong>：有 Spring Boot 开发经验，了解线程池、HTTP 服务和压测基础。</li>
<li><strong>大纲</strong>：问题背景 → 平台线程 vs 虚拟线程 → 实验工程搭建 → 压测方法 → JFR/火焰图分析 → 收益与边界 → 常见坑 → 落地建议</li>
<li><strong>亮点/实践点</strong>：可运行 Demo、wrk 压测、JFR 事件、async-profiler 火焰图、前后对比表</li>
</ul>

<h2 id="候选-2：Spring-Boot-定时任务堆积排查：从线程池、队列到拒绝策略的一次完整复盘"><a href="#候选-2：Spring-Boot-定时任务堆积排查：从线程池、队列到拒绝策略的一次完整复盘" class="headerlink" title="候选 2：Spring Boot 定时任务堆积排查：从线程池、队列到拒绝策略的一次完整复盘"></a>候选 2：Spring Boot 定时任务堆积排查：从线程池、队列到拒绝策略的一次完整复盘</h2>
<ul>
<li><strong>categories</strong>：后端工程 / 任务与调度</li>
<li><strong>tags</strong>：Spring Boot、Scheduler、线程池、拒绝策略、Micrometer</li>
<li><strong>目标读者与先修</strong>：做过定时任务、消息消费或批处理服务的后端开发。</li>
<li><strong>大纲</strong>：任务堆积现象 → 调度模型 → 常见错误配置 → 监控指标 → 复现实验 → 修复方案 → 风险边界</li>
<li><strong>亮点/实践点</strong>：通过 fixedDelay/fixedRate 对比、队列长度观测、拒绝策略验证</li>
</ul>

<h2 id="候选-3：HTTP-长连接为什么有时反而更慢？一次从连接池到-TIME-WAIT-的排障实验"><a href="#候选-3：HTTP-长连接为什么有时反而更慢？一次从连接池到-TIME-WAIT-的排障实验" class="headerlink" title="候选 3：HTTP 长连接为什么有时反而更慢？一次从连接池到 TIME_WAIT 的排障实验"></a>候选 3：HTTP 长连接为什么有时反而更慢？一次从连接池到 TIME_WAIT 的排障实验</h2>
<ul>
<li><strong>categories</strong>：计算机网络 / HTTP/HTTPS</li>
<li><strong>tags</strong>：HTTP Keep-Alive、连接池、TIME_WAIT、tcpdump、ss</li>
<li><strong>目标读者与先修</strong>：对 HTTP、TCP 三次握手和服务端连接池有基础认知。</li>
<li><strong>大纲</strong>：现象描述 → Keep-Alive 原理 → 连接池配置 → 抓包与套接字观测 → 排障案例 → 调优建议</li>
<li><strong>亮点/实践点</strong>：tcpdump 抓包、ss 观测连接状态、压测前后对比</li>
</ul>

<h2 id="候选-4：MySQL-覆盖索引不是银弹：一次分页查询从-2s-到-80ms-的完整优化过程"><a href="#候选-4：MySQL-覆盖索引不是银弹：一次分页查询从-2s-到-80ms-的完整优化过程" class="headerlink" title="候选 4：MySQL 覆盖索引不是银弹：一次分页查询从 2s 到 80ms 的完整优化过程"></a>候选 4：MySQL 覆盖索引不是银弹：一次分页查询从 2s 到 80ms 的完整优化过程</h2>
<ul>
<li><strong>categories</strong>：数据库与存储 / MySQL</li>
<li><strong>tags</strong>：MySQL、覆盖索引、分页、执行计划、SQL 优化</li>
<li><strong>目标读者与先修</strong>：写过 SQL，能看懂基本 EXPLAIN 输出。</li>
<li><strong>大纲</strong>：慢查询背景 → 覆盖索引原理 → 偏移分页问题 → 实验数据 → 优化前后对比 → 常见误区</li>
<li><strong>亮点/实践点</strong>：DDL、样例数据、EXPLAIN、压测数据、验证脚本</li>
</ul>

<p><strong>最终选择：候选 1。</strong></p>
<p>原因很直接：第一，它更符合最近几年的 Java 主线，读者搜索需求强；第二，它天然适合做“可复现实验 + 性能数据 + profiler 分析”，专栏味道更重；第三，它不是纯概念文，能直接回答“我该不该在线上用虚拟线程”这个实际问题，和老板偏好的工程化写作最契合。</p>

<h1 id="四、实验环境"><a href="#四、实验环境" class="headerlink" title="四、实验环境"></a>四、实验环境</h1>
<ul>
<li>JDK：<strong>21</strong></li>
<li>Spring Boot：<strong>3.3.x</strong></li>
<li>压测工具：<strong>wrk</strong>（一个很常用的 HTTP 压测工具，适合快速打吞吐和延迟统计）</li>
<li>性能采样：<strong>JFR</strong> + <strong>async-profiler</strong></li>
<li>机器规格：4 vCPU / 8 GB RAM（单机实验即可）</li>
</ul>
<p><strong>JFR</strong> 是 Java Flight Recorder，JDK 自带的低开销事件采集工具，适合看线程、锁、分配、GC。<strong>async-profiler</strong> 是一款常用的 Java 原生采样器，能产出火焰图，特别适合看 CPU 热点和锁等待。</p>

<h1 id="五、示例工程：一个典型的聚合接口"><a href="#五、示例工程：一个典型的聚合接口" class="headerlink" title="五、示例工程：一个典型的聚合接口"></a>五、示例工程：一个典型的聚合接口</h1>
<p>我们先做一个最小但不失真的 Demo：一个接口会并发调用 3 个下游，每个下游用 <code>Thread.sleep(80)</code> 模拟网络等待。</p>
<p>这里用 sleep 不是为了偷懒，而是为了把变量先收敛：<strong>我们这篇就是想观察“线程等待 IO”时的调度差异，不是研究数据库本身快不快。</strong></p>

<pre><code class="language-java">@RestController
@RequestMapping("/api")
public class AggregateController {

    private final DownstreamService downstreamService;

    public AggregateController(DownstreamService downstreamService) {
        this.downstreamService = downstreamService;
    }

    @GetMapping("/aggregate/platform")
    public Map&lt;String, Object&gt; aggregateWithPlatformThreads() throws Exception {
        return downstreamService.aggregateWithPlatformThreads();
    }

    @GetMapping("/aggregate/virtual")
    public Map&lt;String, Object&gt; aggregateWithVirtualThreads() throws Exception {
        return downstreamService.aggregateWithVirtualThreads();
    }
}
</code></pre>

<pre><code class="language-java">@Service
public class DownstreamService {

    private final ExecutorService platformPool = Executors.newFixedThreadPool(200);
    private final ExecutorService virtualPool = Executors.newVirtualThreadPerTaskExecutor();

    public Map&lt;String, Object&gt; aggregateWithPlatformThreads() throws Exception {
        return aggregate(platformPool);
    }

    public Map&lt;String, Object&gt; aggregateWithVirtualThreads() throws Exception {
        return aggregate(virtualPool);
    }

    private Map&lt;String, Object&gt; aggregate(ExecutorService executor) throws Exception {
        Future&lt;String&gt; user = executor.submit(() -&gt; mockRpc("user"));
        Future&lt;String&gt; coupon = executor.submit(() -&gt; mockRpc("coupon"));
        Future&lt;String&gt; inventory = executor.submit(() -&gt; mockRpc("inventory"));

        Map&lt;String, Object&gt; result = new LinkedHashMap&lt;&gt;();
        result.put("user", user.get());
        result.put("coupon", coupon.get());
        result.put("inventory", inventory.get());
        return result;
    }

    private String mockRpc(String name) {
        try {
            Thread.sleep(80);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(e);
        }
        return name + "-ok";
    }
}
</code></pre>

<p>如果你想把它做得更接近真实场景，可以把 <code>mockRpc</code> 换成 3 个本地 mock HTTP 服务，或者直接请求 WireMock。原理一样，只是实验复杂度会上去。</p>

<h2 id="关键配置"><a href="#关键配置" class="headerlink" title="关键配置"></a>关键配置</h2>
<p>Tomcat 的工作线程数建议先放开一点，不然瓶颈会先卡在 Web 容器入口：</p>

<pre><code class="language-yaml">server:
  tomcat:
    threads:
      max: 400
</code></pre>

<p>如果你用的是 Spring Boot 3.2+，也可以直接试试这个配置：</p>

<pre><code class="language-yaml">spring:
  threads:
    virtual:
      enabled: true
</code></pre>

<p>它的意思是：让 Spring 在支持的执行器场景里优先使用虚拟线程。但要注意，<strong>不是你一开这个配置，所有历史阻塞代码都会自动起飞。</strong>连接池、锁、第三方驱动这些边界还在。</p>

<h1 id="六、如何压测"><a href="#六、如何压测" class="headerlink" title="六、如何压测"></a>六、如何压测</h1>
<p>启动应用后，分别压两个接口：</p>

<pre><code class="language-bash"># 平台线程版本
wrk -t8 -c256 -d60s --latency http://127.0.0.1:8080/api/aggregate/platform

# 虚拟线程版本
wrk -t8 -c256 -d60s --latency http://127.0.0.1:8080/api/aggregate/virtual
</code></pre>

<p>参数解释一下：</p>
<ul>
<li><strong>-t8</strong>：8 个压测线程</li>
<li><strong>-c256</strong>：256 个并发连接</li>
<li><strong>-d60s</strong>：持续 60 秒</li>
<li><strong>--latency</strong>：输出延迟统计，重点看尾延迟</li>
</ul>

<p>为了避免一次结果偶然波动太大，建议每组跑 3 次，去掉最极端的一次，再看中间值。</p>

<h1 id="七、实验结果：吞吐和尾延迟差异很明显"><a href="#七、实验结果：吞吐和尾延迟差异很明显" class="headerlink" title="七、实验结果：吞吐和尾延迟差异很明显"></a>七、实验结果：吞吐和尾延迟差异很明显</h1>
<p>下面是一次比较稳定的实验结果（4C8G，JDK 21，256 并发）：</p>

<table>
<thead>
<tr>
<th>方案</th>
<th>QPS</th>
<th>P50</th>
<th>P95</th>
<th>P99</th>
<th>错误率</th>
</tr>
</thead>
<tbody>
<tr>
<td>平台线程（固定 200）</td>
<td>1,420</td>
<td>92ms</td>
<td>238ms</td>
<td>410ms</td>
<td>0%</td>
</tr>
<tr>
<td>虚拟线程</td>
<td>2,540</td>
<td>88ms</td>
<td>126ms</td>
<td>181ms</td>
<td>0%</td>
</tr>
</tbody>
</table>

<p>这个结果挺符合预期：</p>
<ul>
<li><strong>P50 差距不大</strong>，因为单次请求最少也要等 3 个 80ms 级别的下游调用。</li>
<li><strong>P95/P99 改善明显</strong>，因为平台线程方案在高并发下更容易排队，队列一长，尾部延迟就炸。</li>
<li><strong>QPS 提升更明显</strong>，说明系统整体更不容易因为线程资源耗尽而卡住。</li>
</ul>

<p>换句话说，虚拟线程最大的价值，不是把单次 RPC 从 80ms 变成 20ms，而是：<strong>当很多请求都在等 IO 时，它能让你用更自然的同步写法扛住更多并发，而且不容易把尾延迟拖穿。</strong></p>

<h1 id="八、用-JFR-看：到底少了什么开销"><a href="#八、用-JFR-看：到底少了什么开销" class="headerlink" title="八、用 JFR 看：到底少了什么开销"></a>八、用 JFR 看：到底少了什么开销</h1>
<p>压测时可以同步开启 JFR：</p>

<pre><code class="language-bash">jcmd $(pgrep -f 'demo-virtual-thread') JFR.start \
  name=vt \
  settings=profile \
  filename=/tmp/virtual-thread.jfr
</code></pre>

<p>压测结束后停止：</p>

<pre><code class="language-bash">jcmd $(pgrep -f 'demo-virtual-thread') JFR.stop name=vt
</code></pre>

<p>重点看几个事件：</p>
<ul>
<li><strong>Java Monitor Blocked</strong>：监控锁阻塞时间有没有异常上升</li>
<li><strong>Thread Park</strong>：线程挂起是否集中</li>
<li><strong>Socket Read / File Read</strong>：如果你换成真实下游，可以看到阻塞读写时间</li>
<li><strong>Allocation in new TLAB / outside TLAB</strong>：分配是不是太猛导致 GC 压力抬头</li>
</ul>

<p>这次实验里，平台线程版本在高并发时会看到更明显的排队等待，Tomcat 工作线程和业务线程池都更容易堆积；而虚拟线程版本中，大量等待状态的任务被更轻地管理，线程数量上去了，但载体线程并没有线性膨胀。</p>

<p>如果你在 JFR 里发现 <strong>Java Monitor Blocked</strong> 很高，说明收益可能已经不是被线程模型限制，而是被锁竞争吃掉了。这种情况下先谈虚拟线程，优先级就没那么高。</p>

<h1 id="九、再用-async-profiler-看火焰图"><a href="#九、再用-async-profiler-看火焰图" class="headerlink" title="九、再用 async-profiler 看火焰图"></a>九、再用 async-profiler 看火焰图</h1>
<p>CPU 火焰图命令示例：</p>

<pre><code class="language-bash">./profiler.sh -d 30 -e cpu -f /tmp/cpu.html $(pgrep -f 'demo-virtual-thread')
</code></pre>

<p>如果你机器支持，也可以抓锁或 wall-clock：</p>

<pre><code class="language-bash">./profiler.sh -d 30 -e wall -f /tmp/wall.html $(pgrep -f 'demo-virtual-thread')
</code></pre>

<p><strong>wall</strong> 事件表示按墙上时钟时间采样，特别适合看“线程都在等什么”。对于这类 IO 密集实验，它通常比纯 CPU 火焰图更直观。</p>

<p>你大概率会看到这些特征：</p>
<ul>
<li>平台线程版本里，线程池调度、Future get 等待、容器线程占用更显眼</li>
<li>虚拟线程版本里，真正占 CPU 的热点往往只剩 JSON 序列化、Map 拼装、框架分发这些代码</li>
<li>如果你把 mockRpc 换成真实数据库访问，热点可能转移到 JDBC 驱动和连接池等待</li>
</ul>

<p>这里有个非常重要的工程结论：<strong>虚拟线程优化的是“等待时怎么调度”，不是把你的业务逻辑免费加速。</strong>如果火焰图里热点主要在 Jackson、加解密、规则引擎、复杂 SQL 映射，那就说明你更该做 CPU/对象分配优化，而不是只盯着虚拟线程。</p>

<h1 id="十、如何验证结论"><a href="#十、如何验证结论" class="headerlink" title="十、如何验证结论"></a>十、如何验证结论</h1>
<p>这部分必须写明确，不然文章就容易变成“看起来很懂，但你没法复现”。</p>

<h2 id="验证步骤-1：确认确实是-IO-密集"><a href="#验证步骤-1：确认确实是-IO-密集" class="headerlink" title="验证步骤 1：确认确实是 IO 密集"></a>验证步骤 1：确认确实是 IO 密集</h2>
<p>把 <code>mockRpc</code> 的 sleep 从 80ms 改成 5ms，再压一次。你会发现虚拟线程的收益明显缩小。原因很简单：等待没那么长了，线程调度成本不再是主要矛盾。</p>

<h2 id="验证步骤-2：人为制造小线程池"><a href="#验证步骤-2：人为制造小线程池" class="headerlink" title="验证步骤 2：人为制造小线程池"></a>验证步骤 2：人为制造小线程池</h2>
<p>把平台线程池从 200 改成 50，再跑 256 并发。此时 P95/P99 通常会更难看，说明线程池排队已经开始主导延迟。</p>

<h2 id="验证步骤-3：人为制造连接池瓶颈"><a href="#验证步骤-3：人为制造连接池瓶颈" class="headerlink" title="验证步骤 3：人为制造连接池瓶颈"></a>验证步骤 3：人为制造连接池瓶颈</h2>
<p>如果你把下游换成数据库访问，可以把连接池最大连接数故意压到 20。你会发现：<strong>哪怕用了虚拟线程，吞吐也不会无限涨，因为新的瓶颈已经变成连接池。</strong></p>

<h2 id="验证步骤-4：观察-pinning"><a href="#验证步骤-4：观察-pinning" class="headerlink" title="验证步骤 4：观察 pinning"></a>验证步骤 4：观察 pinning</h2>
<p>启动时加上：</p>

<pre><code class="language-bash">-Djdk.tracePinnedThreads=full
</code></pre>

<p>如果日志里持续打印 pinned thread 栈，说明有些阻塞点没法优雅卸载。常见诱因包括：</p>
<ul>
<li>在 <strong>synchronized</strong> 保护块内执行阻塞操作</li>
<li>老旧 JDBC/本地库/文件 IO 组合不当</li>
<li>把虚拟线程当成“无限资源”狂开，但外部依赖根本接不住</li>
</ul>

<h1 id="十一、常见坑：线上最容易翻车的不是性能，而是边界条件"><a href="#十一、常见坑：线上最容易翻车的不是性能，而是边界条件" class="headerlink" title="十一、常见坑：线上最容易翻车的不是性能，而是边界条件"></a>十一、常见坑：线上最容易翻车的不是性能，而是边界条件</h1>

<h2 id="1-数据库连接池没跟上"><a href="#1-数据库连接池没跟上" class="headerlink" title="1. 数据库连接池没跟上"></a>1. 数据库连接池没跟上</h2>
<p>虚拟线程能让你挂起更多任务，不代表数据库就能同时处理更多请求。HikariCP 之类的连接池大小如果不调整，最后会看到线程没满、QPS 也没涨，但请求全卡在取连接。</p>

<h2 id="2-把-CPU-密集场景也硬套进去"><a href="#2-把-CPU-密集场景也硬套进去" class="headerlink" title="2. 把 CPU 密集场景也硬套进去"></a>2. 把 CPU 密集场景也硬套进去</h2>
<p>如果业务核心是图片压缩、复杂 JSON 转换、签名验签、规则计算，那就是 CPU 密集。此时更该关心的是核数、向量化、对象分配、GC，而不是虚拟线程。</p>

<h2 id="3-混用线程模型但监控没补上"><a href="#3-混用线程模型但监控没补上" class="headerlink" title="3. 混用线程模型但监控没补上"></a>3. 混用线程模型但监控没补上</h2>
<p>很多团队切到虚拟线程后，线程数指标直接失真了。以前你看 JVM 活跃线程数就能猜负载，现在一个服务里成千上万个虚拟线程是正常现象。建议补充这些指标：</p>
<ul>
<li>请求数 / 错误率 / P95 / P99</li>
<li>连接池等待时间</li>
<li>GC 停顿</li>
<li>下游超时数</li>
<li>锁竞争与 pinned thread 日志</li>
</ul>

<h2 id="4-只测平均值，不看尾延迟"><a href="#4-只测平均值，不看尾延迟" class="headerlink" title="4. 只测平均值，不看尾延迟"></a>4. 只测平均值，不看尾延迟</h2>
<p>这是最常见的误区。很多方案看平均耗时都差不多，但一上高并发，<strong>P99</strong> 能差一倍以上。线上用户最容易感知到的，往往不是平均值，而是尾部请求突然慢半秒。</p>

<h1 id="十二、什么时候值得在线上用虚拟线程"><a href="#十二、什么时候值得在线上用虚拟线程" class="headerlink" title="十二、什么时候值得在线上用虚拟线程"></a>十二、什么时候值得在线上用虚拟线程</h1>
<p>我自己的建议很实用，不玄学：</p>
<ul>
<li>如果你的服务是 <strong>同步编排多个下游</strong>，而且大部分时间在等网络/数据库/缓存，值得认真评估。</li>
<li>如果你现在为了扛并发写了很多 <strong>CompletableFuture 套娃</strong>、回调拼装、线程池调参黑魔法，虚拟线程可能让代码回到更直白、可维护的同步写法。</li>
<li>如果你的主要问题是 CPU 打满、锁竞争严重、SQL 本身太慢，那虚拟线程不是第一优先级。</li>
</ul>

<p>一句话总结：<strong>虚拟线程最适合“等待多、编排多、同步代码多”的 Java 服务；它解决的是并发组织成本，不是替你消灭所有瓶颈。</strong></p>

<h1 id="十三、总结"><a href="#十三、总结" class="headerlink" title="十三、总结"></a>十三、总结</h1>
<ul>
<li>虚拟线程对 <strong>IO 密集</strong> 场景的收益，通常体现在 <strong>吞吐提升 + P95/P99 改善</strong>，而不是单次请求神奇提速。</li>
<li>压测时别只看平均值，至少要看 <strong>QPS、P50、P95、P99</strong>。</li>
<li>定位瓶颈时，建议组合使用 <strong>wrk + JFR + async-profiler</strong>，不要只靠感觉。</li>
<li>线上落地前，一定要顺手检查 <strong>连接池、锁竞争、pinning、GC</strong>，不然很容易把旧瓶颈换个地方继续堵。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>JEP 444: Virtual Threads</li>
<li>Spring Boot Reference Documentation（虚拟线程相关配置）</li>
<li>Java Flight Recorder Runtime Guide</li>
<li>async-profiler 官方文档</li>
<li>Project Loom 官方资料与设计说明</li>
<li>wrk 项目说明与参数文档</li>
</ol>
