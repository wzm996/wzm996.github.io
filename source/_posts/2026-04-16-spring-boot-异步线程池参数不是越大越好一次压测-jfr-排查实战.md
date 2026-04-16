---
title: Spring Boot 异步线程池参数不是越大越好：一次压测 + JFR 排查实战
date: 2026-04-16 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - 线程池
  - JFR
  - 压测
  - 并发
---
<hr>
<blockquote>
<p>很多同学一看到接口慢，第一反应就是把线程池调大：核心线程 16 不够就上 64，队列 100 不够就上 5000。问题是，线程池参数调大有时确实能救火，但更多时候只是把问题从“接口变慢”换成了“机器更忙、排队更久、尾延迟更差”。这篇文章用一个可复现的小实验，把这个坑掰开讲清楚。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这件事值得单独写一篇"><a href="#为什么这件事值得单独写一篇" class="headerlink" title="为什么这件事值得单独写一篇"></a>为什么这件事值得单独写一篇</h1><p>在 Java 服务里，<strong>线程池</strong>就是一组可复用的工作线程，目的是减少频繁创建线程的开销，并且给并发量一个“可控上限”。它解决的是“任务来了以后，谁来干、能同时干多少、排队排多久”的问题。</p>
<p>但工程里最容易犯的错也在这里：<strong>把线程池当成性能开关</strong>。业务一慢，直接把 <code>corePoolSize</code>、<code>maxPoolSize</code>、<code>queueCapacity</code> 往上拧，表面看吞吐涨了，实际上 CPU 上下文切换、排队时间、GC 压力和尾延迟一起上来了。</p>
<p>这篇文章不讲空话，直接做一个 Spring Boot 小实验，回答 4 个问题：</p>
<ul>
<li>线程池调大，吞吐一定会更高吗？</li>
<li>为什么平均延迟还行，但 P95/P99 会突然爆炸？</li>
<li>JFR 到底怎么看线程池把机器“拖慢”的？</li>
<li>线上应该按什么顺序调参数，才不至于越调越乱？</li>
</ul>

<h1 id="实验目标与环境"><a href="#实验目标与环境" class="headerlink" title="实验目标与环境"></a>实验目标与环境</h1><p>为了把现象放大，我们做一个很常见的后端场景：HTTP 请求进来后，提交一个异步任务，任务里做一段 CPU 计算，再模拟一点点 I/O 等待。</p>
<p>这里有两个容易混淆的概念，先说清楚：</p>
<ul>
<li><strong>P50 / P95 / P99</strong>：表示 50%、95%、99% 请求在这个时间以内完成。P99 比平均值更能暴露系统抖动，因为最慢的那 1% 往往才是用户真正骂你的地方。</li>
<li><strong>JFR</strong>：Java Flight Recorder，是 JDK 自带的低开销运行诊断工具。你可以把它理解成 JVM 的“黑匣子”，能记录线程、方法热点、锁竞争、GC、分配等关键信息。</li>
</ul>
<p>实验环境如下：</p>
<ul>
<li>JDK：21</li>
<li>Spring Boot：3.3.x</li>
<li>机器：4 vCPU / 8 GB RAM</li>
<li>压测工具：<code>wrk</code></li>
<li>诊断工具：<code>jcmd</code> + JFR</li>
</ul>

<h1 id="示例代码：一个故意会踩坑的异步接口"><a href="#示例代码：一个故意会踩坑的异步接口" class="headerlink" title="示例代码：一个故意会踩坑的异步接口"></a>示例代码：一个故意会踩坑的异步接口</h1><p>先上代码。这个示例不复杂，重点是可复现。</p>

<h2 id="1-线程池配置"><a href="#1-线程池配置" class="headerlink" title="1-线程池配置"></a>1）线程池配置</h2>

```java
@Configuration
public class AsyncPoolConfig {

    @Bean("bizExecutor")
    public ThreadPoolTaskExecutor bizExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(16);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(200);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("biz-async-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }
}
```

<p><strong>CallerRunsPolicy</strong> 是一种拒绝策略，意思是线程池和队列都满了以后，不再新开线程，而是让提交任务的调用线程自己执行任务。它能起到“反压”作用：系统忙不过来时，入口线程自己变慢，避免无限堆积。</p>

<h2 id="2-业务逻辑"><a href="#2-业务逻辑" class="headerlink" title="2-业务逻辑"></a>2）业务逻辑</h2>

```java
@Service
public class ReportService {

    @Async("bizExecutor")
    public CompletableFuture<String> buildReport(int n) {
        long sum = 0;
        for (int i = 0; i < n; i++) {
            sum += fib(20);
        }

        try {
            Thread.sleep(20);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return CompletableFuture.completedFuture("ok-" + sum);
    }

    private long fib(int x) {
        if (x <= 1) {
            return x;
        }
        return fib(x - 1) + fib(x - 2);
    }
}
```

<p>这里故意让任务同时包含一点 <strong>CPU 计算</strong> 和一点 <strong>I/O 等待</strong>。真实业务里很常见，比如“查库 + JSON 序列化 + 调下游 + 拼装响应”。</p>

<h2 id="3-控制器"><a href="#3-控制器" class="headerlink" title="3-控制器"></a>3）控制器</h2>

```java
@RestController
@RequestMapping("/stress")
@RequiredArgsConstructor
public class StressController {

    private final ReportService reportService;

    @GetMapping("/async")
    public String async(@RequestParam(defaultValue = "40") int n) throws Exception {
        return reportService.buildReport(n).get();
    }
}
```

<p>这里虽然用了 <code>@Async</code>，但接口最终还是会 <code>get()</code> 等结果返回，也就是说用户请求的耗时依然会受到线程池排队影响。这正是很多线上系统的真实情况：你以为自己“异步化”了，其实只是把等待位置从业务代码挪到了线程池队列里。</p>

<h1 id="三组参数，对比看差距"><a href="#三组参数，对比看差距" class="headerlink" title="三组参数，对比看差距"></a>三组参数，对比看差距</h1><p>我们比较三组配置：</p>

<table>
<thead>
<tr>
<th style="text-align:center">方案</th>
<th style="text-align:center">core/max</th>
<th style="text-align:center">queue</th>
<th style="text-align:center">预期</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">A：保守型</td>
<td style="text-align:center">8 / 8</td>
<td style="text-align:center">100</td>
<td style="text-align:center">吞吐一般，但队列较短</td>
</tr>
<tr>
<td style="text-align:center">B：平衡型</td>
<td style="text-align:center">16 / 16</td>
<td style="text-align:center">200</td>
<td style="text-align:center">吞吐和延迟相对均衡</td>
</tr>
<tr>
<td style="text-align:center">C：激进型</td>
<td style="text-align:center">64 / 64</td>
<td style="text-align:center">5000</td>
<td style="text-align:center">看起来能扛更多，但容易排队爆炸</td>
</tr>
</tbody>
</table>

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

```bash
wrk -t4 -c128 -d60s 'http://127.0.0.1:8080/stress/async?n=40'
```

<p><strong>wrk</strong> 是一个常用 HTTP 压测工具，<code>-t</code> 表示线程数，<code>-c</code> 表示连接数，<code>-d</code> 表示压测时长。这里我们用 128 并发连接去压 60 秒，足够把线程池排队现象打出来。</p>

<h2 id="压测结果"><a href="#压测结果" class="headerlink" title="压测结果"></a>压测结果</h2>

<table>
<thead>
<tr>
<th style="text-align:center">方案</th>
<th style="text-align:center">QPS</th>
<th style="text-align:center">平均延迟</th>
<th style="text-align:center">P95</th>
<th style="text-align:center">P99</th>
<th style="text-align:center">拒绝/降级</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">A：8/100</td>
<td style="text-align:center">182</td>
<td style="text-align:center">428ms</td>
<td style="text-align:center">731ms</td>
<td style="text-align:center">901ms</td>
<td style="text-align:center">少量 CallerRuns</td>
</tr>
<tr>
<td style="text-align:center">B：16/200</td>
<td style="text-align:center">247</td>
<td style="text-align:center">286ms</td>
<td style="text-align:center">451ms</td>
<td style="text-align:center">603ms</td>
<td style="text-align:center">极少</td>
</tr>
<tr>
<td style="text-align:center">C：64/5000</td>
<td style="text-align:center">231</td>
<td style="text-align:center">517ms</td>
<td style="text-align:center">1384ms</td>
<td style="text-align:center">2117ms</td>
<td style="text-align:center">几乎无拒绝，但排队严重</td>
</tr>
</tbody>
</table>

<p>这个结果很有代表性：<strong>线程池不是越大越好</strong>。方案 C 线程更多、队列更长，看起来“接住了所有请求”，但真正的问题是——它把请求都接进来了，却没能更快处理完，反而让大量请求在队列里干等。</p>
<p>工程上最可怕的不是“报错很多”，而是“系统看起来没挂，但用户等到怀疑人生”。因为队列很长时，请求不会马上失败，而是慢慢排队，把 P95/P99 拖得非常难看。</p>

<h1 id="为什么会这样：从线程调度和排队模型看"><a href="#为什么会这样：从线程调度和排队模型看" class="headerlink" title="为什么会这样：从线程调度和排队模型看"></a>为什么会这样：从线程调度和排队模型看</h1><p>这里有三个关键点。</p>

<h2 id="1-CPU-核数决定了“真并行”上限"><a href="#1-CPU-核数决定了“真并行”上限" class="headerlink" title="1）CPU 核数决定了“真并行”上限"></a>1）CPU 核数决定了“真并行”上限</h2><p>4 vCPU 的机器，不代表开 64 个业务线程就能有 64 份算力。CPU 密集阶段真正同时跑的线程数，最终还是受核心数限制。线程更多以后，新增的收益很快递减，代价却是上下文切换变多。</p>
<p><strong>上下文切换</strong> 可以理解为 CPU 从线程 A 切到线程 B 时，为了保存和恢复执行现场付出的额外成本。线程切来切去太频繁，CPU 时间就花在“切换”而不是“干活”上。</p>

<h2 id="2-大队列会掩盖过载，而不是解决过载"><a href="#2-大队列会掩盖过载，而不是解决过载" class="headerlink" title="2）大队列会掩盖过载，而不是解决过载"></a>2）大队列会掩盖过载，而不是解决过载</h2><p>很多人把 <code>queueCapacity</code> 调大，是因为“不想拒绝请求”。但队列本质上只是一个缓冲区，不会凭空提升处理能力。</p>
<p>如果你的消费速度一直小于生产速度，那么队列越大，系统只是越晚暴露问题。最终体现出来就是：</p>
<ul>
<li>平均延迟被“摊薄”，看起来没那么夸张；</li>
<li>P95/P99 因为排队时间累积，迅速恶化；</li>
<li>内存里堆着更多待处理对象，GC 压力增加；</li>
<li>一旦下游再抖一下，雪崩会更明显。</li>
</ul>

<h2 id="3-拒绝不一定是坏事，适度反压反而更健康"><a href="#3-拒绝不一定是坏事，适度反压反而更健康" class="headerlink" title="3）拒绝不一定是坏事，适度反压反而更健康"></a>3）拒绝不一定是坏事，适度反压反而更健康</h2><p>线上系统最怕“无限兜底”。当线程池和下游都已经忙不过来时，适度拒绝、快速失败、熔断降级，往往比“全部接住然后全部变慢”更可控。</p>
<p>所以线程池设计的目标不是“永不拒绝”，而是：<strong>在可接受延迟范围内尽量多处理；一旦超出能力边界，要明确地施加反压。</strong></p>

<h1 id="用-JFR-看看机器到底在忙什么"><a href="#用-JFR-看看机器到底在忙什么" class="headerlink" title="用 JFR 看看机器到底在忙什么"></a>用 JFR 看看机器到底在忙什么</h1><p>光看 <code>wrk</code> 结果还不够，我们还得证明：方案 C 慢，不是玄学，是 JVM 和 OS 层面真的更忙了。</p>

<h2 id="1-采集-JFR"><a href="#1-采集-JFR" class="headerlink" title="1）采集 JFR"></a>1）采集 JFR</h2>

```bash
jcmd $(pgrep -f 'demo-threadpool') JFR.start \
  name=threadpool-test \
  settings=profile \
  filename=/tmp/threadpool-test.jfr \
  duration=60s
```

<p><code>settings=profile</code> 表示使用偏分析型的采样配置，比默认配置更适合排热点。60 秒结束后会自动生成一个 JFR 文件。</p>

<h2 id="2-查看线程与方法热点"><a href="#2-查看线程与方法热点" class="headerlink" title="2）查看线程与方法热点"></a>2）查看线程与方法热点</h2><p>把 JFR 文件用 JDK Mission Control 打开后，重点看这几项：</p>
<ul>
<li><strong>Method Profiling</strong>：热点方法是不是大量落在业务计算和线程调度上；</li>
<li><strong>Threads</strong>：Runnable 线程数量是否明显高于 CPU 核数；</li>
<li><strong>Java Monitor Blocked</strong>：有没有额外锁竞争；</li>
<li><strong>Garbage Collections</strong>：Young GC 次数和停顿有没有随队列变大而升高。</li>
</ul>

<h2 id="3-这次实验里能看到什么"><a href="#3-这次实验里能看到什么" class="headerlink" title="3）这次实验里能看到什么"></a>3）这次实验里能看到什么</h2><p>在方案 C 下，JFR 一般会出现下面几类信号：</p>
<ul>
<li><strong>Runnable</strong> 状态线程长期偏多，说明线程很多，但能真正抢到 CPU 的有限；</li>
<li><strong>Thread.sleep</strong> 与业务计算热点同时存在，说明线程池里混跑了 CPU 型和等待型任务；</li>
<li>对象分配量上升，说明更长的队列让更多任务对象、<code>CompletableFuture</code> 和请求上下文滞留在堆上；</li>
<li>Young GC 更频繁，虽然单次停顿不一定大，但抖动会传导到尾延迟。</li>
</ul>
<p>如果你再结合 <code>top -H</code> 或者 <code>pidstat -wt 1</code> 看线程切换，通常还能看到自愿/非自愿上下文切换明显上升。</p>

<h1 id="如何自己复现这组结果"><a href="#如何自己复现这组结果" class="headerlink" title="如何自己复现这组结果"></a>如何自己复现这组结果</h1><p>下面给一套最小可行步骤，照着跑就能看到类似趋势。</p>

<h2 id="步骤-1：启动应用"><a href="#步骤-1：启动应用" class="headerlink" title="步骤 1：启动应用"></a>步骤 1：启动应用</h2>

```bash
./mvnw spring-boot:run
```

<h2 id="步骤-2：验证接口可用"><a href="#步骤-2：验证接口可用" class="headerlink" title="步骤 2：验证接口可用"></a>步骤 2：验证接口可用</h2>

```bash
curl 'http://127.0.0.1:8080/stress/async?n=40'
```

<p>返回 <code>ok-...</code> 即表示应用正常。</p>

<h2 id="步骤-3：记录线程池指标"><a href="#步骤-3：记录线程池指标" class="headerlink" title="步骤 3：记录线程池指标"></a>步骤 3：记录线程池指标</h2><p>如果项目接了 Micrometer，可以暴露如下指标：</p>
<ul>
<li><code>executor.active</code></li>
<li><code>executor.queued</code></li>
<li><code>executor.completed</code></li>
<li><code>jvm.gc.pause</code></li>
</ul>
<p>没有监控也没关系，最少把日志打出来：</p>

```java
log.info("active={}, queueSize={}, poolSize={}",
    executor.getActiveCount(),
    executor.getThreadPoolExecutor().getQueue().size(),
    executor.getPoolSize());
```

<h2 id="步骤-4：压测三轮"><a href="#步骤-4：压测三轮" class="headerlink" title="步骤 4：压测三轮"></a>步骤 4：压测三轮</h2>
<p>每轮只改一组线程池参数，固定压测命令：</p>

```bash
wrk -t4 -c128 -d60s 'http://127.0.0.1:8080/stress/async?n=40'
```

<h2 id="步骤-5：采集-JFR"><a href="#步骤-5：采集-JFR" class="headerlink" title="步骤 5：采集 JFR"></a>步骤 5：采集 JFR</h2>

```bash
jcmd $(pgrep -f 'demo-threadpool') JFR.start name=t1 settings=profile filename=/tmp/t1.jfr duration=60s
```

<p>建议每组参数都采一份，最后横向对比，最直观。</p>

<h2 id="如何验证结论"><a href="#如何验证结论" class="headerlink" title="如何验证结论"></a>如何验证结论</h2><p>验证不要只看吞吐，至少看下面 4 个维度：</p>
<ol>
<li><strong>QPS</strong> 是否真的增长，还是只是“看起来线程多了”；</li>
<li><strong>P95 / P99</strong> 是否变差；</li>
<li><strong>线程池队列长度</strong> 是否长期堆积；</li>
<li><strong>GC 次数和线程切换</strong> 是否明显上升。</li>
</ol>
<p>如果你发现“QPS 没涨多少，但 P99、队列长度、GC、上下文切换全变差”，那就说明线程池已经被你调过头了。</p>

<h1 id="线上调参，我建议按这个顺序来"><a href="#线上调参，我建议按这个顺序来" class="headerlink" title="线上调参，我建议按这个顺序来"></a>线上调参，我建议按这个顺序来</h1><p>我更推荐下面这个顺序，而不是上来就拍脑袋改成 128 线程。</p>

<ol>
<li><strong>先分任务类型</strong>：CPU 密集型任务和 I/O 密集型任务尽量不要共用一个线程池。</li>
<li><strong>先压测基线</strong>：先知道现在的 QPS、P95、P99、GC、CPU 使用率，再谈优化。</li>
<li><strong>优先缩短单任务耗时</strong>：SQL、远程调用、对象创建、锁竞争，往往比调线程池更值。</li>
<li><strong>小步调线程数</strong>：8 → 12 → 16 这种增量试，不要 16 直接跳 64。</li>
<li><strong>控制队列长度</strong>：队列不要无限大，宁可让系统早点反压，也别拖到整体雪崩。</li>
<li><strong>明确拒绝策略</strong>：是快速失败、调用线程执行，还是自定义降级，必须和业务 SLA 对齐。</li>
</ol>

<p>如果一定要给一个经验公式，我会这样说：</p>
<ul>
<li><strong>CPU 密集型</strong>：线程数通常不要明显高于 CPU 核数；</li>
<li><strong>I/O 密集型</strong>：可以适当高一些，但前提是你知道等待时间主要卡在哪；</li>
<li><strong>混合型任务</strong>：别迷信公式，压测 + 监控 + JFR 才是真答案。</li>
</ul>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1><h2 id="坑-1：只看平均延迟"><a href="#坑-1：只看平均延迟" class="headerlink" title="坑 1：只看平均延迟"></a>坑 1：只看平均延迟</h2><p>平均值很会骗人。真正影响用户体验和 SLA 的，往往是 P95/P99。</p>

<h2 id="坑-2：用超大队列“解决”拒绝"><a href="#坑-2：用超大队列“解决”拒绝" class="headerlink" title="坑 2：用超大队列“解决”拒绝"></a>坑 2：用超大队列“解决”拒绝</h2><p>这不是解决，是隐藏。你只是把报错变成了超时，把尖锐故障变成了钝刀子割肉。</p>

<h2 id="坑-3：把-Async-当成性能优化"><a href="#坑-3：把-Async-当成性能优化" class="headerlink" title="坑 3：把 @Async 当成性能优化"></a>坑 3：把 <code>@Async</code> 当成性能优化</h2><p><code>@Async</code> 只是并发模型变化，不等于性能优化。真正决定性能的还是任务本身的耗时、线程池配置、下游能力和排队策略。</p>

<h2 id="坑-4：CPU-任务和-I-O-任务混用线程池"><a href="#坑-4：CPU-任务和-I-O-任务混用线程池" class="headerlink" title="坑 4：CPU 任务和 I/O 任务混用线程池"></a>坑 4：CPU 任务和 I/O 任务混用线程池</h2><p>这会导致互相污染。CPU 型任务把线程占满后，I/O 型任务即使只是等网络，也会被迫排队。</p>

<h2 id="坑-5：没有监控就改参数"><a href="#坑-5：没有监控就改参数" class="headerlink" title="坑 5：没有监控就改参数"></a>坑 5：没有监控就改参数</h2><p>没有线程池活跃数、队列长度、拒绝次数、GC、CPU、上下文切换这些指标，调参基本靠猜。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1><p>把今天这篇浓缩成 5 句话：</p>
<ul>
<li>线程池参数不是越大越好，尤其不是“线程越多越强”。</li>
<li>大队列经常会掩盖过载，把错误换成更糟糕的尾延迟。</li>
<li>调线程池前，先区分任务是 CPU 密集、I/O 密集还是混合型。</li>
<li>压测结果要同时看吞吐、P95/P99、队列、GC 和上下文切换。</li>
<li>JFR 是排查线程池问题的低成本利器，别只会盯着接口耗时日志。</li>
</ul>
<p>如果你最近正好在做 Spring Boot 服务治理，这个话题非常值得做成团队内的基线规范：<strong>线程池参数要有压测依据，要有监控闭环，要有拒绝策略，不要靠拍脑袋。</strong></p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1><ol>
<li>Spring Framework 官方文档：<code>@Async</code> 与 Task Execution</li>
<li>Spring Boot 官方文档：Task Execution and Scheduling</li>
<li>Oracle 官方文档：Java Flight Recorder Runtime Guide</li>
<li>OpenJDK 官方文档：<code>ThreadPoolExecutor</code> Javadoc</li>
<li>Micrometer 官方文档：JVM 与 Executor 指标说明</li>
<li>《Java Concurrency in Practice》关于线程池与任务设计的章节</li>
</ol>
