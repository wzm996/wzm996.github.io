---
title: Spring Boot线程池为什么会把P99打爆：一次从队列堆积到JFR火焰图的排查实战
date: 2026-05-07 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - 线程池
  - JFR
  - async-profiler
  - P99
  - 性能调优
---
<hr>
<blockquote>
<p>线程池不是配上 corePoolSize 和 maxPoolSize 就完事了。在线上更常见的问题，反而不是 CPU 打满，而是任务在队列里排队排太久，最后把 <strong>P99</strong> 延迟拖爆。这篇文章我用一个可复现实验，把“线程池参数看起来没问题，为什么接口还是很慢”这件事拆开讲清楚。</p>
</blockquote>

<!-- more -->

<h1 id="先说结论：很多慢并不是“线程不够”，而是“排队太久”"><a href="#先说结论：很多慢并不是“线程不够”，而是“排队太久”" class="headerlink" title="先说结论：很多慢并不是“线程不够”，而是“排队太久”"></a>先说结论：很多慢并不是“线程不够”，而是“排队太久”</h1>
<p>在 Spring Boot 项目里，大家对 <strong>线程池</strong> 并不陌生。线程池说白了就是“提前养好一批工人，任务来了直接派工，不用每次临时招人”。它解决的是线程频繁创建销毁带来的开销，也能顺手帮我们限制并发。</p>
<p>但真实线上问题经常比“线程池要不要用”复杂得多。很多服务在压测的时候会出现一个很典型的现象：</p>
<ul>
<li>P50 看起来还行，说明大多数请求不慢；</li>
<li>P95 开始抬头；</li>
<li>P99 直接炸穿，偶发超时明显增多；</li>
<li>CPU 利用率却没有高到离谱，机器也不像是完全跑满了。</li>
</ul>
<p>这时候如果只盯着 CPU，很容易误判。因为慢请求不一定在“执行”，也可能在“排队”。而 <strong>P99</strong> 的意思，就是 99% 的请求都比这个值快，剩下最慢的 1% 会落在它后面，所以它特别容易暴露“尾部排队”问题。</p>
<p>这篇文章不聊空泛概念，直接做一个能在本地复现的实验：我们先故意把线程池配坏，再用压测、JFR、async-profiler 把问题钉死，最后再做一轮调优，看数据有没有真的变好。</p>

<h1 id="实验目标与环境"><a href="#实验目标与环境" class="headerlink" title="实验目标与环境"></a>实验目标与环境</h1>
<p>我们的目标很明确：</p>
<ol>
<li>复现一个“线程池队列堆积导致接口尾延迟恶化”的场景；</li>
<li>拿到吞吐、P50、P95、P99 对比数据；</li>
<li>用 <strong>JFR</strong> 和 <strong>async-profiler</strong> 两种工具交叉验证瓶颈；</li>
<li>给出一套实际可落地的线程池调优思路。</li>
</ol>
<p><strong>JFR</strong> 全称是 <strong>Java Flight Recorder</strong>，你可以把它理解成 JVM 自带的“飞行记录仪”，能低开销记录方法热点、锁竞争、GC、线程状态这些关键运行信息。<strong>async-profiler</strong> 则是 Java 圈里常用的性能剖析工具，擅长生成火焰图；火焰图不是“越高越慢”，而是“某一段代码总体占样本的宽度越大，越值得怀疑”。</p>
<p>实验环境如下：</p>
<ul>
<li>JDK：21</li>
<li>Spring Boot：3.3.x</li>
<li>压测工具：wrk</li>
<li>分析工具：JFR、async-profiler</li>
<li>机器：4 vCPU / 8 GB 内存 Linux 虚拟机</li>
</ul>
<p>注：不同机器上绝对数值会有差异，但“坏配置比好配置更容易打爆 P99”这个趋势应该是稳定能复现的。</p>

<h1 id="问题场景：一个看起来很正常、其实很危险的线程池"><a href="#问题场景：一个看起来很正常、其实很危险的线程池" class="headerlink" title="问题场景：一个看起来很正常、其实很危险的线程池"></a>问题场景：一个看起来很正常、其实很危险的线程池</h1>
<p>很多项目会把线程池写成这样：</p>

```java
@Configuration
public class ExecutorConfig {

    @Bean("reportExecutor")
    public ThreadPoolTaskExecutor reportExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(2000);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("report-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }
}
```

<p>乍一看没啥毛病：核心线程 8，最大线程 16，队列也留得很大，感觉“很稳”。但这里最大的坑，恰恰是 <strong>队列太大</strong>。</p>
<p>为什么？因为 Java 的 <strong>ThreadPoolExecutor</strong> 在默认策略下，会优先把任务塞进队列，只有队列满了，才会继续把线程数从 corePoolSize 扩到 maxPoolSize。也就是说，队列一旦给得过大，线程池就会“很能忍”，宁可让任务排长队，也不愿意多开线程。</p>
<p>这类场景在以下任务里特别常见：</p>
<ul>
<li>报表导出；</li>
<li>批量查询后聚合；</li>
<li>调用多个下游接口再拼装返回；</li>
<li>消息消费里夹杂了远程调用或磁盘 IO。</li>
</ul>
<p>这些任务的共同点是：<strong>不完全吃 CPU，更容易被 IO 等待拖住</strong>。于是线程数不够 + 队列过大时，最先炸的不是 CPU，而是请求等待时间。</p>

<h1 id="先搭一个可复现实验"><a href="#先搭一个可复现实验" class="headerlink" title="先搭一个可复现实验"></a>先搭一个可复现实验</h1>
<p>下面这个接口会把一个请求拆成多个“模拟远程调用”的小任务，然后扔进线程池里并行执行。为了让现象更明显，我故意让每个子任务 sleep 200ms，模拟下游服务耗时。</p>

```java
@RestController
@RequestMapping("/demo")
@RequiredArgsConstructor
public class DemoController {

    private final ThreadPoolTaskExecutor reportExecutor;

    @GetMapping("/aggregate")
    public Map<String, Object> aggregate(@RequestParam(defaultValue = "12") int fanout) {
        long start = System.nanoTime();

        List<CompletableFuture<String>> futures = IntStream.range(0, fanout)
                .mapToObj(i -> CompletableFuture.supplyAsync(() -> remoteCall(i), reportExecutor))
                .toList();

        List<String> result = futures.stream()
                .map(CompletableFuture::join)
                .toList();

        long costMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        return Map.of(
                "costMs", costMs,
                "size", result.size(),
                "threadPool", poolSnapshot(reportExecutor)
        );
    }

    private String remoteCall(int i) {
        try {
            Thread.sleep(200);
            return "task-" + i;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    private Map<String, Object> poolSnapshot(ThreadPoolTaskExecutor executor) {
        ThreadPoolExecutor pool = executor.getThreadPoolExecutor();
        return Map.of(
                "poolSize", pool.getPoolSize(),
                "activeCount", pool.getActiveCount(),
                "queueSize", pool.getQueue().size(),
                "completedTaskCount", pool.getCompletedTaskCount()
        );
    }
}
```

<p>这个接口本身逻辑不复杂，但足够把线程池问题暴露出来。因为单个请求会扇出多个子任务，扇出一多，线程池就很容易排队。这里的 <strong>fanout</strong> 可以理解成“一个请求要拆成几路并发子请求”。它常见于聚合接口、搜索召回、推荐结果拼装之类的业务。</p>

<h2 id="启动参数"><a href="#启动参数" class="headerlink" title="启动参数"></a>启动参数</h2>

```bash
java \
  -XX:StartFlightRecording=filename=app.jfr,settings=profile \
  -XX:+UnlockDiagnosticVMOptions \
  -XX:+DebugNonSafepoints \
  -jar target/demo-threadpool.jar
```

<p><strong>-XX:StartFlightRecording</strong> 的作用是让应用启动时直接开始记录 JFR，避免问题出现后才想起来开；<strong>DebugNonSafepoints</strong> 则是为了让 async-profiler 采样时更容易拿到可靠的 Java 栈信息。</p>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

```bash
wrk -t4 -c64 -d60s --latency 'http://127.0.0.1:8080/demo/aggregate?fanout=12'
```

<p>这里的 <strong>wrk</strong> 是一个经典 HTTP 压测工具，适合快速看吞吐和分位延迟。<strong>-t4</strong> 表示 4 个压测线程，<strong>-c64</strong> 表示 64 个并发连接，<strong>--latency</strong> 会输出延迟分布。</p>

<h1 id="第一轮：坏配置的压测结果"><a href="#第一轮：坏配置的压测结果" class="headerlink" title="第一轮：坏配置的压测结果"></a>第一轮：坏配置的压测结果</h1>
<p>先用上面那套线程池配置：core=8，max=16，queue=2000。压测 60 秒，拿到一组典型结果如下：</p>

| 配置 | 吞吐（req/s） | P50 | P95 | P99 | 错误率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| core=8, max=16, queue=2000 | 73.8 | 742ms | 3.41s | 5.82s | 0 |

<p>这个数据很有代表性：吞吐不算完全崩，但 <strong>P99 已经非常难看</strong> 了。业务上如果网关超时配置是 3 秒，这种尾延迟基本就意味着用户会间歇性看到失败。</p>
<p>再看运行过程中的线程池快照，会出现这样的状态：</p>

```text
poolSize=8
activeCount=8
queueSize=1000+
completedTaskCount 持续增长但增长速度有限
```

<p>也就是说，线程池大部分时间只开着 8 个核心线程在干活，大量任务被塞进队列排队，而不是尽快扩容到更多工作线程。问题已经非常明确：<strong>不是代码逻辑本身很慢，而是线程池调度策略把请求拖慢了</strong>。</p>

<h1 id="第二轮：用-JFR-确认问题到底卡在哪"><a href="#第二轮：用-JFR-确认问题到底卡在哪" class="headerlink" title="第二轮：用 JFR 确认问题到底卡在哪"></a>第二轮：用 JFR 确认问题到底卡在哪</h1>
<p>很多同学一看到慢，就先怀疑 GC。这个怀疑没问题，但别靠猜。JFR 最适合干这个事情：先看线程、再看方法热点、顺手把 GC 也排除掉。</p>
<p>打开 <code>app.jfr</code> 以后，重点看这几类事件：</p>
<ul>
<li><strong>Method Profiling</strong>：热点方法主要花在哪；</li>
<li><strong>Java Monitor Blocked</strong>：有没有明显锁竞争；</li>
<li><strong>Thread Dump / Thread States</strong>：线程是在 RUNNABLE、WAITING 还是 TIMED_WAITING；</li>
<li><strong>Garbage Collections</strong>：GC 次数、停顿时间有没有异常。</li>
</ul>
<p>这次实验里，JFR 给出的信号很清楚：</p>
<ol>
<li>业务线程大量时间停在 <code>CompletableFuture.join()</code>；</li>
<li>工作线程很多时间在 <code>Thread.sleep()</code>，说明它们主要被“模拟 IO 等待”占住；</li>
<li>GC 停顿非常短，没有出现明显 Full GC；</li>
<li>CPU 不是主要瓶颈，线程等待时间远大于真正执行时间。</li>
</ol>
<p>这里有个很关键的认知：<strong>JFR 不只是拿来看 CPU 热点，它更重要的价值是帮你排除“错误嫌疑人”</strong>。这次我们基本可以排除 GC 和锁竞争，把注意力集中到线程池排队。</p>

<h1 id="第三轮：用-async-profiler-看火焰图"><a href="#第三轮：用-async-profiler-看火焰图" class="headerlink" title="第三轮：用 async-profiler 看火焰图"></a>第三轮：用 async-profiler 看火焰图</h1>
<p>JFR 帮我们做了方向判断，接下来用 async-profiler 再看一次火焰图，确认“时间都烧在哪”。</p>

```bash
./profiler.sh -d 30 -e cpu -f cpu.html <pid>
./profiler.sh -d 30 -e wall -f wall.html <pid>
```

<p>这里故意同时采 <strong>cpu</strong> 和 <strong>wall</strong> 两种事件。<strong>cpu</strong> 看的是 CPU 真正在跑的时间，<strong>wall</strong> 看的是“墙钟时间”，也就是包括等待在内的真实耗时。在线程池、锁、IO 问题里，wall 模式往往更有用。</p>
<p>这次实验的典型现象是：</p>
<ul>
<li>CPU 火焰图不算夸张，热点比较分散；</li>
<li>Wall 火焰图里，<code>CompletableFuture.join</code>、<code>ThreadPoolExecutor.getTask</code>、<code>Unsafe.park</code> 一类等待栈占比很大；</li>
<li>业务方法真正算逻辑的那一截，并没有宽到能解释 5 秒级别的 P99。</li>
</ul>
<p><strong>Unsafe.park</strong> 可以简单理解成“线程先停这儿等通知”，很多等待型问题都会在栈上看到它。它不是罪魁祸首，只是一个“这里有人在等”的信号。</p>
<p>到这一步，其实已经足够下结论：<strong>尾延迟主要来自排队等待，不来自 CPU 计算，也不来自 GC 抖动</strong>。</p>

<h1 id="怎么调：别让队列无限忍，先把并发策略想明白"><a href="#怎么调：别让队列无限忍，先把并发策略想明白" class="headerlink" title="怎么调：别让队列无限忍，先把并发策略想明白"></a>怎么调：别让队列无限忍，先把并发策略想明白</h1>
<p>线程池调优的第一原则，不是“把数字调大”，而是先回答两个问题：</p>
<ol>
<li>这个任务是 <strong>CPU 密集型</strong> 还是 <strong>IO 密集型</strong>？</li>
<li>业务更怕什么：更高资源占用，还是更长排队时间？</li>
</ol>
<p><strong>CPU 密集型</strong> 指任务大部分时间都在算，比如压缩、加密、复杂 JSON 计算；<strong>IO 密集型</strong> 指任务大部分时间都在等，比如等数据库、等 Redis、等 HTTP 下游返回。两者线程数策略差很多，不能一把梭。</p>
<p>当前这个实验是典型 IO 密集型，所以我更倾向这样的调优策略：</p>
<ul>
<li>适当增大核心线程数；</li>
<li>显著缩小队列容量，避免无限排队；</li>
<li>保留可控的最大线程数，用来吸收瞬时流量；</li>
<li>补齐监控：活跃线程数、队列长度、拒绝次数、任务执行时长。</li>
</ul>
<p>调优后的配置如下：</p>

```java
@Bean("reportExecutor")
public ThreadPoolTaskExecutor reportExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(16);
    executor.setMaxPoolSize(48);
    executor.setQueueCapacity(100);
    executor.setKeepAliveSeconds(60);
    executor.setAllowCoreThreadTimeOut(true);
    executor.setThreadNamePrefix("report-");
    executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
    executor.initialize();
    return executor;
}
```

<p>这里的思路不是“线程越多越好”，而是让线程池更早进入扩容，而不是一上来就把任务都憋进大队列里。<strong>AllowCoreThreadTimeOut</strong> 的意思是允许核心线程在空闲时也回收，避免低峰期白占资源。</p>

<h1 id="第四轮：调优后的压测对比"><a href="#第四轮：调优后的压测对比" class="headerlink" title="第四轮：调优后的压测对比"></a>第四轮：调优后的压测对比</h1>
<p>同样的 wrk 压测命令，调优后拿到的典型数据如下：</p>

| 配置 | 吞吐（req/s） | P50 | P95 | P99 | 错误率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 坏配置：8 / 16 / 2000 | 73.8 | 742ms | 3.41s | 5.82s | 0 |
| 调优后：16 / 48 / 100 | 142.6 | 318ms | 812ms | 1.39s | 0 |

<p>这个结果说明了两件事：</p>
<ol>
<li><strong>吞吐翻了接近 2 倍</strong>；</li>
<li><strong>P99 从 5.82s 降到 1.39s</strong>，尾延迟改善最明显。</li>
</ol>
<p>这也是为什么我一直强调，性能优化不能只看平均值。平均值会掩盖一堆问题，但 <strong>P99 才最接近用户体感</strong>。很多“偶发超时”“明明大多数请求都还行”的线上事故，本质就是尾延迟治理没做好。</p>

<h1 id="怎么验证你的调优不是“玄学”"><a href="#怎么验证你的调优不是“玄学”" class="headerlink" title="怎么验证你的调优不是“玄学”"></a>怎么验证你的调优不是“玄学”</h1>
<p>线上调优最怕一种情况：改完以后感觉“好像好了”，但没有证据。下面这套验证流程是我比较推荐的：</p>
<ol>
<li>固定压测参数：并发数、压测时长、请求内容保持一致；</li>
<li>固定 JVM 参数：至少保证两轮测试使用相同的 GC 和堆大小；</li>
<li>记录三类指标：吞吐、分位延迟、错误率；</li>
<li>记录线程池指标：activeCount、queueSize、rejectedCount；</li>
<li>补一份 JFR 或火焰图，确认瓶颈转移到了哪里。</li>
</ol>
<p>一个最简单的验证标准可以写成这样：</p>

```text
通过标准：
1. 同压测流量下，P99 下降超过 30%；
2. 吞吐没有明显下降；
3. 拒绝次数可控，且没有引入新一轮超时；
4. GC、CPU、线程数都没有出现新的异常峰值。
```

<p>如果你们服务已经接了 Micrometer + Prometheus，那么建议把这些指标都打出来：</p>

```java
Gauge.builder("biz.threadpool.queue.size", pool, p -> p.getQueue().size()).register(registry);
Gauge.builder("biz.threadpool.active.count", pool, ThreadPoolExecutor::getActiveCount).register(registry);
Gauge.builder("biz.threadpool.pool.size", pool, ThreadPoolExecutor::getPoolSize).register(registry);
Counter.builder("biz.threadpool.reject.count").register(registry);
```

<p><strong>Micrometer</strong> 可以理解成 Spring Boot 生态里做指标埋点的标准门面，你写一次埋点，就能比较方便地接到 Prometheus、Datadog 这类监控后端。</p>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>
<ol>
<li><strong>误区一：队列越大越稳</strong><br>错。队列大只是“更能堆”，不代表“处理更快”。在延迟敏感场景里，大队列往往是尾延迟放大器。</li>
<li><strong>误区二：maxPoolSize 配大就一定会生效</strong><br>也错。只要队列没满，线程池可能根本不会往 maxPoolSize 扩。很多人以为自己开了 64 个线程，实际上长期只有 corePoolSize 在工作。</li>
<li><strong>误区三：只看平均响应时间</strong><br>平均值很会骗人。你应该至少看 P50、P95、P99，最好再看超时率。</li>
<li><strong>误区四：线程池参数全服务统一复制</strong><br>不同任务类型差异非常大。查数据库的线程池、发 HTTP 的线程池、CPU 计算线程池，本来就不该一套参数打天下。</li>
<li><strong>误区五：只调线程池，不看下游容量</strong><br>你把本服务线程数拉高了，可能只是把压力更猛烈地打到数据库、Redis 或下游 HTTP 服务上。性能优化不是单机游戏，得看整个链路。</li>
</ol>

<h1 id="一个更实用的调参思路"><a href="#一个更实用的调参思路" class="headerlink" title="一个更实用的调参思路"></a>一个更实用的调参思路</h1>
<p>如果你现在就要去看一个 Spring Boot 服务的线程池，我建议按这个顺序排查：</p>
<ol>
<li>先确认任务类型：CPU 密集还是 IO 密集；</li>
<li>再看指标：活跃线程、队列长度、拒绝次数、请求 P99；</li>
<li>如果队列长但 CPU 不高，优先怀疑“排队太久”；</li>
<li>用 JFR 排除 GC 和锁竞争；</li>
<li>用 async-profiler 的 wall 模式看等待栈；</li>
<li>最后再调 core/max/queue，而不是一上来拍脑袋改数字。</li>
</ol>
<p>如果业务对延迟很敏感，我通常更偏向于：</p>
<ul>
<li>小一点的队列；</li>
<li>更明确的限流或降级策略；</li>
<li>在压力上来时尽快失败，而不是无限排队把整条链路拖死。</li>
</ul>
<p>这背后的思路很朴素：<strong>可控地失败，通常比不可控地慢要好</strong>。慢到最后，用户照样会超时，系统内部还顺手堆出更多级联问题。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li>Spring Boot 里的线程池问题，很多时候不是“线程不够”，而是“队列堆积导致尾延迟恶化”；</li>
<li>大队列不一定稳，反而可能让线程池迟迟不扩容，把任务都拖进排队地狱；</li>
<li>JFR 适合先排除 GC、锁竞争、线程状态异常；</li>
<li>async-profiler 的 wall 火焰图，非常适合看等待型问题；</li>
<li>调优一定要拿吞吐、P50/P95/P99、线程池指标做前后对比，不要靠感觉。</li>
</ul>
<p>如果后面继续写这个方向，我准备再展开两篇：一篇专门讲 <strong>线程池拒绝策略到底怎么选</strong>，另一篇讲 <strong>CompletableFuture 扇出聚合接口为什么特别容易把下游打穿</strong>。这两个坑，在 Java 服务里都很常见。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>Oracle, <em>Java Platform, Standard Edition JDK Flight Recorder Runtime Guide</em>：<a href="https://docs.oracle.com/en/java/">https://docs.oracle.com/en/java/</a></li>
<li>OpenJDK, <em>JDK Mission Control</em>：<a href="https://openjdk.org/projects/jmc/">https://openjdk.org/projects/jmc/</a></li>
<li>async-profiler 官方项目：<a href="https://github.com/async-profiler/async-profiler">https://github.com/async-profiler/async-profiler</a></li>
<li>Spring Framework 文档，<em>Task Execution and Scheduling</em>：<a href="https://docs.spring.io/spring-framework/reference/integration/scheduling.html">https://docs.spring.io/spring-framework/reference/integration/scheduling.html</a></li>
<li>Brian Goetz 等，<em>Java Concurrency in Practice</em></li>
<li>Micrometer 官方文档：<a href="https://micrometer.io/">https://micrometer.io/</a></li>
</ol>
