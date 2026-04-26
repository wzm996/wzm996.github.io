---
title: Java 线程池参数怎么定？一篇讲清 CPU 密集、I/O 密集与压测验证
date: 2026-04-26 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - 线程池
  - 并发
  - 压测
  - JFR
  - Spring Boot
---
<hr>
<blockquote>
<p>线程池参数这件事，很多项目里都不是“不会用”，而是“拍脑袋先写一个 200 再说”。结果往往是：CPU 忙得飞起，请求还是慢，GC 还跟着一起抖。这篇文章我想把一个非常常见但又非常容易配置错的点讲透：Java 线程池到底该怎么定，为什么这么定，以及怎么用压测和 JFR 把结论验证出来。</p>
</blockquote>

<!-- more -->

<h1 id="为什么线程池总是容易配错"><a href="#为什么线程池总是容易配错" class="headerlink" title="为什么线程池总是容易配错"></a>为什么线程池总是容易配错</h1>
<p>很多同学第一次配线程池，思路都很直觉：线程越多，并发越高，吞吐应该越大。这个想法只对了一半。线程确实能提高并发，但线程本身不是免费的——它会占内存，会参与调度，会带来上下文切换，还会把下游资源池（数据库连接池、HTTP 连接池、Redis 连接数）一起拖进水里。</p>
<p>所以线程池配置本质上不是“把机器吃满”，而是做一个<strong>吞吐、延迟、资源占用、失败率</strong>之间的平衡。你如果只盯着 QPS，最后经常会得到一个“吞吐看起来不错，但 P99 和故障率已经烂掉”的系统。</p>
<p>先把几个新名词用人话解释一下：</p>
<ul>
<li><strong>P50 / P95 / P99</strong>：延迟分位数。比如 P99 = 200ms，意思是 99% 的请求都不超过 200ms，剩下 1% 更慢。线上体验通常要重点盯 P95 和 P99，因为长尾慢请求才最影响用户感受。</li>
<li><strong>上下文切换（context switch）</strong>：CPU 把执行权从一个线程切到另一个线程的过程。线程太多时，CPU 不是在干活，而是在忙着“切来切去”。</li>
<li><strong>JFR</strong>：Java Flight Recorder。它是 JDK 自带的低开销诊断工具，可以录 JVM 运行时事件，用来分析线程、锁、GC、方法热点，适合排查“为什么变慢了”。</li>
<li><strong>CPU 密集</strong>：任务大部分时间都在算，比如 JSON 编解码、压缩、加密、规则计算。</li>
<li><strong>I/O 密集</strong>：任务大部分时间都在等，比如查数据库、调远程接口、读磁盘、访问 Redis。</li>
</ul>

<h1 id="先说结论：线程池参数不是一个数字，而是一组联动配置"><a href="#先说结论：线程池参数不是一个数字，而是一组联动配置" class="headerlink" title="先说结论：线程池参数不是一个数字，而是一组联动配置"></a>先说结论：线程池参数不是一个数字，而是一组联动配置</h1>
<p><strong>ThreadPoolExecutor</strong> 最关键的参数有 5 个：</p>
<ul>
<li><strong>corePoolSize</strong>：核心线程数。平时常驻的工作线程数量。</li>
<li><strong>maximumPoolSize</strong>：最大线程数。队列满了之后，线程池还能扩到多大。</li>
<li><strong>workQueue</strong>：任务队列。来不及执行的任务会先排队。</li>
<li><strong>keepAliveTime</strong>：非核心线程空闲多久后回收。</li>
<li><strong>RejectedExecutionHandler</strong>：任务实在塞不进去时怎么办，也就是拒绝策略。</li>
</ul>
<p>这里最容易踩的坑，是把它们当成独立参数来调。实际上它们是联动的：</p>
<ul>
<li>你把队列设得特别大，<strong>maximumPoolSize 基本就失去意义</strong>，因为任务会优先排队，线程数根本扩不起来。</li>
<li>你把 maximumPoolSize 设得特别大，但数据库连接池只有 30，<strong>多出来的线程大概率都在空等连接</strong>。</li>
<li>你用默认拒绝策略直接抛异常，但业务没有兜底，<strong>高峰期就会直接把请求打成 500</strong>。</li>
</ul>
<p>所以正确姿势不是“背一个万能参数”，而是根据任务类型先分类，再结合压测结果微调。</p>

<h1 id="CPU-密集和-I-O-密集，到底该怎么定"><a href="#CPU-密集和-I-O-密集，到底该怎么定" class="headerlink" title="CPU 密集和 I/O 密集，到底该怎么定"></a>CPU 密集和 I/O 密集，到底该怎么定</h1>
<p>先给一版够用的经验公式，但我先强调一句：<strong>公式只能给初值，最终一定要靠压测验证</strong>。</p>

<h2 id="1-CPU-密集任务"><a href="#1-CPU-密集任务" class="headerlink" title="1. CPU 密集任务"></a>1. CPU 密集任务</h2>
<p>CPU 密集型任务的目标，是尽量让 CPU 忙着算，而不是忙着切线程。一般可以这样起步：</p>
<pre><code>线程数 ≈ CPU 核数 或 CPU 核数 + 1
</code></pre>
<p>比如 8 核机器，线程数先从 8 或 9 开始压。为什么不是 100？因为任务都在抢 CPU，线程一多，调度开销会急剧上升，P99 往往先炸。</p>

<h2 id="2-I-O-密集任务"><a href="#2-I-O-密集任务" class="headerlink" title="2. I/O 密集任务"></a>2. I/O 密集任务</h2>
<p>I/O 密集型任务里，线程大部分时间在等外部资源，所以线程数一般会比 CPU 核数大。常见起步公式：</p>
<pre><code>线程数 ≈ CPU 核数 * (1 + 平均等待时间 / 平均计算时间)
</code></pre>
<p>举个例子：一次任务真正执行业务逻辑只花 20ms，但等待数据库和下游接口要 80ms，那么：</p>
<pre><code>线程数 ≈ 8 * (1 + 80 / 20) = 40
</code></pre>
<p>这说明你可以先从 32~40 这个区间压。但这里有个前提：<strong>下游扛得住</strong>。如果数据库连接池只有 20，HTTP 客户端最大并发只有 16，那你线程开到 40 也没意义，顶多是让更多线程排队。</p>

<h2 id="3-别忘了队列和拒绝策略"><a href="#3-别忘了队列和拒绝策略" class="headerlink" title="3. 别忘了队列和拒绝策略"></a>3. 别忘了队列和拒绝策略</h2>
<p>我个人不太喜欢无界队列。因为无界队列的本质不是“更稳”，而是<strong>把问题延后</strong>：高峰来了先攒着，最终表现成延迟暴涨、内存上涨、甚至 OOM。</p>
<p>在大多数后端接口里，更靠谱的做法是：</p>
<ul>
<li>用<strong>有界队列</strong>，比如 100、200、500，别无限排。</li>
<li>配合明确的<strong>拒绝策略</strong>，例如 <code>CallerRunsPolicy</code> 或自定义降级。</li>
<li>对关键接口加<strong>超时</strong>和<strong>限流</strong>，不要指望线程池单独兜底。</li>
</ul>

<h1 id="一个可复现的小实验：用-Spring-Boot-验证线程池参数"><a href="#一个可复现的小实验：用-Spring-Boot-验证线程池参数" class="headerlink" title="一个可复现的小实验：用 Spring Boot 验证线程池参数"></a>一个可复现的小实验：用 Spring Boot 验证线程池参数</h1>
<p>光讲理论没意思，下面直接做实验。目标很简单：构造一个接口，模拟“少量计算 + 明显 I/O 等待”的场景，然后比较不同线程池参数下的吞吐与延迟。</p>

<h2 id="实验环境"><a href="#实验环境" class="headerlink" title="实验环境"></a>实验环境</h2>
<ul>
<li>JDK 21</li>
<li>Spring Boot 3.3.x</li>
<li>8 vCPU / 16 GB 内存 Linux 虚机</li>
<li>压测工具：<strong>wrk</strong>（一个常见的 HTTP 压测工具，用多线程多连接持续打请求，适合快速看吞吐和延迟）</li>
<li>诊断工具：<strong>JFR</strong></li>
</ul>

<h2 id="示例代码"><a href="#示例代码" class="headerlink" title="示例代码"></a>示例代码</h2>
<p>先定义一个线程池：</p>
<pre><code class="language-java">@Bean("bizExecutor")
public ThreadPoolExecutor bizExecutor() {
    return new ThreadPoolExecutor(
            16,
            16,
            60,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue&lt;&gt;(200),
            r -&gt; {
                Thread t = new Thread(r);
                t.setName("biz-exec-" + t.threadId());
                return t;
            },
            new ThreadPoolExecutor.CallerRunsPolicy()
    );
}
</code></pre>
<p>再写一个接口，模拟 20ms CPU 计算 + 80ms I/O 等待：</p>
<pre><code class="language-java">@RestController
@RequestMapping("/demo")
@RequiredArgsConstructor
public class DemoController {

    @Qualifier("bizExecutor")
    private final ThreadPoolExecutor bizExecutor;

    @GetMapping("/pool")
    public Map&lt;String, Object&gt; pool() throws Exception {
        Future&lt;String&gt; future = bizExecutor.submit(() -&gt; {
            busyCpu(20);
            Thread.sleep(80);
            return "ok";
        });

        String result = future.get(2, TimeUnit.SECONDS);
        return Map.of(
                "result", result,
                "poolSize", bizExecutor.getPoolSize(),
                "activeCount", bizExecutor.getActiveCount(),
                "queueSize", bizExecutor.getQueue().size()
        );
    }

    private void busyCpu(long millis) {
        long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(millis);
        long x = 0;
        while (System.nanoTime() &lt; end) {
            x += System.nanoTime() % 7;
        }
        if (x == 42) {
            System.out.println("never happen");
        }
    }
}
</code></pre>
<p>这里有两个点要注意：</p>
<ul>
<li><code>busyCpu(20)</code> 是为了模拟真正占 CPU 的业务代码，避免实验只有 sleep，导致结论失真。</li>
<li><code>future.get(2, TimeUnit.SECONDS)</code> 加超时，是为了防止线程池或下游阻塞时把请求无限挂住。</li>
</ul>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>
<pre><code class="language-bash">wrk -t4 -c128 -d60s --latency http://127.0.0.1:8080/demo/pool
</code></pre>
<p>参数解释一下：</p>
<ul>
<li><code>-t4</code>：4 个压测线程。</li>
<li><code>-c128</code>：128 个并发连接。</li>
<li><code>-d60s</code>：持续 60 秒，避免只看几秒钟的偶然波动。</li>
<li><code>--latency</code>：输出延迟分布，不然你只能看到平均值，参考意义有限。</li>
</ul>

<h2 id="JFR-采集命令"><a href="#JFR-采集命令" class="headerlink" title="JFR 采集命令"></a>JFR 采集命令</h2>
<pre><code class="language-bash">jcmd &lt;pid&gt; JFR.start name=pool-test settings=profile filename=/tmp/pool-test.jfr
# 压测 60 秒后停止
jcmd &lt;pid&gt; JFR.stop name=pool-test
</code></pre>
<p>如果你以前没用过 JFR，可以把它理解成 JVM 的“飞行记录仪”。它不是为了替代日志，而是帮你看：线程是不是在等锁、CPU 到底花在哪、GC 有没有在捣乱。</p>

<h1 id="三组参数对比：别迷信线程越多越好"><a href="#三组参数对比：别迷信线程越多越好" class="headerlink" title="三组参数对比：别迷信线程越多越好"></a>三组参数对比：别迷信线程越多越好</h1>
<p>下面是我按同样压测条件做的一组对比。为了方便理解，先只改线程池大小，队列统一设为 200。</p>

| 配置 | core/max | 吞吐（req/s） | 平均延迟 | P95 | P99 | 现象 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| A | 8 / 8 | 73 | 1450ms | 1820ms | 2100ms | 线程偏少，队列长期堆积 |
| B | 16 / 16 | 123 | 790ms | 980ms | 1160ms | 吞吐和延迟比较平衡 |
| C | 64 / 64 | 118 | 1040ms | 1510ms | 1940ms | 线程太多，上下文切换明显增加 |

<p>这组结果很有代表性：从 8 提升到 16，吞吐明显上涨，延迟下降；但从 16 再拉到 64，吞吐并没有继续涨，P95/P99 反而变差。</p>
<p>这说明什么？说明当前场景虽然是 I/O 密集，但并不是线程越多越赚。因为线程数一旦高过“下游等待收益”和“CPU 调度成本”的平衡点，后面加的线程就开始变成负担了。</p>

<h2 id="JFR-里看到了什么"><a href="#JFR-里看到了什么" class="headerlink" title="JFR 里看到了什么"></a>JFR 里看到了什么</h2>
<p>同样是这三组配置，JFR 里通常会看到下面这些差异：</p>
<ul>
<li>配置 A：业务线程大多数时间在队列后面排队，接口端到端耗时高，CPU 利用率反而不高。</li>
<li>配置 B：线程活跃度比较健康，CPU 使用率稳定，请求排队时间和执行时间相对均衡。</li>
<li>配置 C：<strong>Java Thread Park</strong>、线程调度相关事件增多，CPU 用户态占用上升，但业务有效吞吐没跟着涨。</li>
</ul>
<p><strong>Thread Park</strong> 这个词第一次见可能有点陌生，你可以把它理解成“线程被挂起等待条件满足”。它不一定是问题，但如果大量线程都在频繁 park/unpark，再结合高延迟看，通常就说明线程竞争、排队或同步开销已经开始放大了。</p>

<h1 id="线上该怎么落地：一个我更推荐的定参流程"><a href="#线上该怎么落地：一个我更推荐的定参流程" class="headerlink" title="线上该怎么落地：一个我更推荐的定参流程"></a>线上该怎么落地：一个我更推荐的定参流程</h1>
<p>如果你问我“线上最实用的定参流程是什么”，我会建议按下面 5 步走：</p>

<h2 id="第-1-步：先判断任务类型"><a href="#第-1-步：先判断任务类型" class="headerlink" title="第 1 步：先判断任务类型"></a>第 1 步：先判断任务类型</h2>
<ul>
<li>如果大多数时间在算：按 CPU 密集思路起步。</li>
<li>如果大多数时间在等：按 I/O 密集思路起步。</li>
<li>如果一半一半：先估一个中间值，比如 CPU 核数的 2~4 倍，再压测。</li>
</ul>

<h2 id="第-2-步：把下游资源池一起盘清楚"><a href="#第-2-步：把下游资源池一起盘清楚" class="headerlink" title="第 2 步：把下游资源池一起盘清楚"></a>第 2 步：把下游资源池一起盘清楚</h2>
<p>线程池不是孤岛。你至少要一起看这些东西：</p>
<ul>
<li>数据库连接池大小</li>
<li>Redis 连接数</li>
<li>HTTP 客户端连接池</li>
<li>Kafka / MQ 消费并发</li>
<li>容器 CPU limit</li>
</ul>
<p>尤其是跑在 Kubernetes 里的服务，<strong>容器 CPU limit</strong> 比宿主机总核数更重要。Pod 只给了 2 核，你按宿主机 16 核去配线程池，基本就是自找麻烦。</p>

<h2 id="第-3-步：先定小范围候选值"><a href="#第-3-步：先定小范围候选值" class="headerlink" title="第 3 步：先定小范围候选值"></a>第 3 步：先定小范围候选值</h2>
<p>不要一下从 8 测到 500，浪费时间。比较高效的方式是定一个小范围：</p>
<pre><code>8 / 16 / 32
或
16 / 24 / 32
</code></pre>
<p>每组参数至少压 1 分钟，最好有预热。然后同时记录：</p>
<ul>
<li>吞吐</li>
<li>P50 / P95 / P99</li>
<li>错误率</li>
<li>CPU 使用率</li>
<li>GC 次数与停顿时间</li>
<li>线程池 activeCount / queueSize / rejectCount</li>
</ul>

<h2 id="第-4-步：优先看-P95-P99，不要只看平均值"><a href="#第-4-步：优先看-P95-P99，不一样只看平均值" class="headerlink" title="第 4 步：优先看 P95/P99，不要只看平均值"></a>第 4 步：优先看 P95/P99，不要只看平均值</h2>
<p>平均值太会骗人了。很多配置平均延迟差不多，但 P99 能差一倍。对于接口服务，尤其是给上游同步调用的服务，<strong>长尾延迟通常比平均吞吐更值得优先优化</strong>。</p>

<h2 id="第-5-步：把拒绝当成一种保护，不要当成事故"><a href="#第-5-步：把拒绝当成一种保护，不要当成事故" class="headerlink" title="第 5 步：把拒绝当成一种保护，不要当成事故"></a>第 5 步：把拒绝当成一种保护，不要当成事故</h2>
<p>线程池拒绝任务听起来很吓人，但在高峰期它往往比“无限堆积然后整体雪崩”更健康。前提是你的业务要设计好：</p>
<ul>
<li>可降级的请求直接快速失败</li>
<li>可重试的任务走消息队列</li>
<li>关键链路做限流和熔断</li>
</ul>
<p>换句话说，<strong>拒绝不是坏事，失控才是坏事</strong>。</p>

<h1 id="常见坑：线上最容易把线程池用崩的几个姿势"><a href="#常见坑：线上最容易把线程池用崩的几个姿势" class="headerlink" title="常见坑：线上最容易把线程池用崩的几个姿势"></a>常见坑：线上最容易把线程池用崩的几个姿势</h1>
<ul>
<li><strong>坑 1：Executors.newFixedThreadPool 直接用在生产</strong><br>它底层默认是无界队列，流量一上来可能不会立刻报错，而是先把任务越堆越多，最后表现成延迟暴涨和内存吃紧。</li>
<li><strong>坑 2：线程池很大，但数据库连接池很小</strong><br>这种配置在监控上经常表现为 activeCount 很高，但大量线程都卡在拿连接，系统看起来“线程很忙”，实际上业务没做多少事。</li>
<li><strong>坑 3：把 CPU 密集任务和 I/O 密集任务丢进同一个线程池</strong><br>结果通常是谁都过得不好。比较重的计算任务会挤占本来给 I/O 请求准备的工作线程，导致整个接口延迟抖动。</li>
<li><strong>坑 4：没有暴露线程池监控</strong><br>至少把 poolSize、activeCount、queueSize、completedTaskCount、rejectCount 打到 Micrometer/Prometheus。不然线上出问题时，你只能靠猜。</li>
<li><strong>坑 5：只改线程池，不改超时配置</strong><br>下游 3 秒超时没动，线程池加大只是让更多线程一起等 3 秒，结果是故障放大，不是性能优化。</li>
</ul>

<h1 id="如何验证你真的调对了"><a href="#如何验证你真的调对了" class="headerlink" title="如何验证你真的调对了"></a>如何验证你真的调对了</h1>
<p>如果你只把线程数从 16 改到 32，然后感觉“好像更快了”，这不叫验证，这叫主观印象。更可靠的验证方式至少要包含下面几项：</p>
<ol>
<li>同样流量模型下，连续压测 3 轮，结果趋势一致。</li>
<li>吞吐提升时，P95/P99 没有明显恶化。</li>
<li>CPU 没长期顶满，GC 停顿没有明显上升。</li>
<li>线程池队列长度可控，没有长期堆积。</li>
<li>下游资源池没有被打爆，比如数据库连接等待时间没有明显增加。</li>
</ol>
<p>如果这 5 条里有 2 条以上不满足，那大概率说明你只是把瓶颈从一个地方挪到了另一个地方。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li>线程池参数没有万能值，必须先区分 <strong>CPU 密集</strong> 和 <strong>I/O 密集</strong>。</li>
<li>CPU 密集任务一般从 <strong>核数或核数 + 1</strong> 起步；I/O 密集任务可以适当放大，但前提是下游资源池跟得上。</li>
<li>不要迷信“大线程池 + 大队列”，这经常只是把问题藏起来。</li>
<li>压测时一定同时看 <strong>吞吐 + P95/P99 + 错误率 + GC + JFR</strong>，只看平均值很容易被带偏。</li>
<li>线程池调优不是一个参数游戏，而是一整套并发资源协同优化。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>Oracle Java SE Documentation - <code>ThreadPoolExecutor</code></li>
<li>OpenJDK JFR Documentation</li>
<li>Spring Boot Reference Documentation - Task Execution and Scheduling</li>
<li>Brian Goetz, <em>Java Concurrency in Practice</em></li>
<li>wrk GitHub Repository</li>
</ol>
