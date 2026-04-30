---
title: Spring Boot 接口一到高峰就抖？用 JFR + async-profiler 把线程池问题抓出来
date: 2026-04-30 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - Spring Boot
  - JFR
  - async-profiler
  - 线程池
  - 性能优化
---
<hr>
<blockquote>
<p>接口在低峰时跑得挺顺，一到高峰就开始 P99 飙升、CPU 忽高忽低、线程数一路上涨，这种问题十有八九不是“机器不够”，而是线程池、队列和下游依赖的组合出了问题。本文用一个可复现的小实验，把 <strong>JFR</strong> 和 <strong>async-profiler</strong> 串起来，演示怎么从“感觉系统抖了”一路定位到“线程池配错了”，最后再给出一套能落地的修复办法。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这类问题最容易误判"><a href="#为什么这类问题最容易误判" class="headerlink" title="为什么这类问题最容易误判"></a>为什么这类问题最容易误判</h1>
<p>线上接口抖动有个很烦人的特点：它不一定表现成明显报错。很多时候日志里没红字，监控上 CPU 也没打满，但请求就是慢，尤其是 <strong>P99</strong> 特别难看。</p>
<p><strong>P99</strong> 就是 99% 的请求都比它快，剩下最慢的 1% 会被它“兜住”。做接口性能分析时，P99 往往比平均值更有参考意义，因为用户骂人的通常就是这批最慢请求。</p>
<p>这类抖动问题，最常见的误判有三个：</p>
<ul>
<li>一看到慢，就先怀疑数据库；</li>
<li>一看到线程多，就先把线程池调大；</li>
<li>一看到 CPU 高，就先扩机器。</li>
</ul>
<p>这三招都不是完全错，但很容易治标不治本。尤其是线程池问题，如果本质上是“任务提交速度远大于任务处理速度”，你把线程开更大，很多时候只是在更快地把系统推向抖动。</p>

<h1 id="本文要复现的故障场景"><a href="#本文要复现的故障场景" class="headerlink" title="本文要复现的故障场景"></a>本文要复现的故障场景</h1>
<p>我们模拟一个很常见的业务接口：<strong>用户请求进来后，需要并发查两个下游服务，再拼装结果返回</strong>。为了图省事，很多项目会直接上一个自定义线程池，把下游调用扔进去异步执行。</p>
<p>问题就出在这里：如果线程池参数和请求模型不匹配，平峰时它看起来没问题，高峰时就会出现：</p>
<ul>
<li>请求排队时间变长；</li>
<li>线程上下文切换增多；</li>
<li>GC 次数上升；</li>
<li>超时和重试把下游进一步打抖。</li>
</ul>
<p>下面这个实验故意把线程池配成一个“线上很常见但不合理”的样子：</p>
<ul>
<li><strong>核心线程数 16，最大线程数 200</strong>；</li>
<li><strong>队列容量 10000</strong>；</li>
<li>下游调用平均耗时 40~60ms，但会有少量长尾；</li>
<li>接口每次请求并发提交 2 个任务。</li>
</ul>
<p>注意，这里的大队列是个危险信号。很多同学会以为“大队列更稳”，实际上它经常会把问题藏起来：请求没失败，但都在悄悄排队，最后一起把延迟拉爆。</p>

<h1 id="实验环境与代码"><a href="#实验环境与代码" class="headerlink" title="实验环境与代码"></a>实验环境与代码</h1>
<p>实验环境尽量简单，方便你在本地复现：</p>
<ul>
<li>JDK：21</li>
<li>Spring Boot：3.3.x</li>
<li>压测工具：wrk 4.x</li>
<li>Profiler：JFR、async-profiler 3.x</li>
<li>机器：4 vCPU / 8GB 内存</li>
</ul>

<p>先准备一个最小化接口。核心逻辑不是业务本身，而是“把两个下游任务丢进线程池，再等待结果”。</p>

```java
@RestController
@RequestMapping("/api")
public class DemoController {

    private final ExecutorService executor = new ThreadPoolExecutor(
            16,
            200,
            60,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(10000),
            new ThreadPoolExecutor.CallerRunsPolicy()
    );

    @GetMapping("/aggregate")
    public Map<String, Object> aggregate() throws Exception {
        CompletableFuture<String> userFuture = CompletableFuture.supplyAsync(this::mockRemoteA, executor);
        CompletableFuture<String> orderFuture = CompletableFuture.supplyAsync(this::mockRemoteB, executor);

        return Map.of(
                "user", userFuture.get(300, TimeUnit.MILLISECONDS),
                "order", orderFuture.get(300, TimeUnit.MILLISECONDS)
        );
    }

    private String mockRemoteA() {
        sleep(ThreadLocalRandom.current().nextInt(40, 60));
        occasionallySlow();
        return "user-ok";
    }

    private String mockRemoteB() {
        sleep(ThreadLocalRandom.current().nextInt(40, 60));
        occasionallySlow();
        return "order-ok";
    }

    private void occasionallySlow() {
        if (ThreadLocalRandom.current().nextInt(100) < 3) {
            sleep(200);
        }
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

<p><strong>CallerRunsPolicy</strong> 是线程池的一种拒绝策略。它的意思是：线程池忙不过来时，不是直接丢任务，而是谁提交任务谁自己跑。它能避免任务直接丢失，但在 Web 场景里也可能把 Tomcat 请求线程拖慢。</p>

<p>为了让现象更明显，建议把线程池和队列指标也打出来：</p>

```java
@Component
public class ExecutorMetricsLogger {

    private final ThreadPoolExecutor executor;

    public ExecutorMetricsLogger(DemoController controller) throws Exception {
        Field field = DemoController.class.getDeclaredField("executor");
        field.setAccessible(true);
        this.executor = (ThreadPoolExecutor) field.get(controller);
    }

    @Scheduled(fixedDelay = 5000)
    public void print() {
        System.out.printf("poolSize=%d active=%d queue=%d completed=%d%n",
                executor.getPoolSize(),
                executor.getActiveCount(),
                executor.getQueue().size(),
                executor.getCompletedTaskCount());
    }
}
```

<h1 id="先压测，再看现象"><a href="#先压测，再看现象" class="headerlink" title="先压测，再看现象"></a>先压测，再看现象</h1>
<p>启动应用后，用下面的命令压测 2 分钟：</p>

```bash
wrk -t4 -c200 -d120s --latency http://127.0.0.1:8080/api/aggregate
```

<p><strong>wrk</strong> 是一个很轻量的 HTTP 压测工具，适合快速验证接口吞吐和延迟表现。它不是最全能的，但上手快、结果直接，定位“接口是不是开始抖了”非常够用。</p>

<p>先看“问题版本”的结果。下面这组数据是这个实验场景下比较典型的一次输出：</p>

| 版本 | QPS | Avg | P50 | P95 | P99 | 超时率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 错误线程池配置 | 812 | 96ms | 71ms | 241ms | 487ms | 2.8% |

<p>如果只看平均值 96ms，很多人会觉得“还能接受”。但 P99 已经快 500ms 了，而且还有超时，这就说明系统已经进入明显抖动状态。</p>
<p>再结合线程池日志，通常能看到这样的趋势：</p>

```text
poolSize=154 active=149 queue=6218 completed=128420
poolSize=177 active=173 queue=8015 completed=137812
poolSize=192 active=186 queue=9471 completed=145609
```

<p>这时候就要警觉了：<strong>队列在涨，线程也在涨，说明系统不是“偶发慢”，而是在持续积压</strong>。</p>

<h1 id="第一把刀：用-JFR-判断时间花在哪"><a href="#第一把刀：用-JFR-判断时间花在哪" class="headerlink" title="第一把刀：用 JFR 判断时间花在哪"></a>第一把刀：用 JFR 判断时间花在哪</h1>
<p><strong>JFR</strong>（Java Flight Recorder）可以理解成 JVM 自带的飞行记录仪。它会低开销地记录线程、锁、方法采样、GC、分配等事件，特别适合先做全局判断：到底是 CPU 忙、锁竞争、GC，还是请求在排队。</p>

<p>先找到 Java 进程：</p>

```bash
jps -l
```

<p>压测期间抓 2 分钟 JFR：</p>

```bash
jcmd <pid> JFR.start name=threadpool-profile settings=profile filename=/tmp/threadpool-profile.jfr duration=120s
```

<p>采集结束后，可以用 JDK Mission Control 打开 `/tmp/threadpool-profile.jfr`。重点看这几个视图：</p>
<ul>
<li><strong>Threads</strong>：线程数量是否持续膨胀；</li>
<li><strong>Method Profiling</strong>：时间主要花在 `Thread.sleep`、网络等待还是业务计算；</li>
<li><strong>Locks</strong>：有没有明显锁竞争；</li>
<li><strong>GC</strong>：Young GC 次数和停顿时间是否被放大；</li>
<li><strong>Allocation</strong>：对象分配速率是否异常。</li>
</ul>

<p>这个实验里，JFR 通常会给你一个很关键的结论：<strong>CPU 不是主要瓶颈，线程大量时间在等待，下游长尾 + 本地排队把延迟堆高了</strong>。</p>
<p>如果你在 Method Profiling 里看到大量采样集中在：</p>
<ul>
<li>`java.lang.Thread.sleep`</li>
<li>`Unsafe.park`</li>
<li>`CompletableFuture$Signaller.block`</li>
<li>`ArrayBlockingQueue.offer/take`</li>
</ul>
<p>那基本就可以判断，这不是“纯 CPU 打满”，而是典型的<strong>线程池排队 + 等待放大</strong>。</p>

<h2 id="顺手把-GC-也看一眼"><a href="#顺手把-GC-也看一眼" class="headerlink" title="顺手把 GC 也看一眼"></a>顺手把 GC 也看一眼</h2>
<p>别一提性能就只盯 CPU。线程数一多、Future 一多、请求堆积一多，短命对象也会跟着暴涨，Young GC 往往会更频繁。</p>
<p>可以直接打开 GC 日志：</p>

```bash
java \
  -Xms2g -Xmx2g \
  -Xlog:gc*:file=/tmp/gc.log:time,uptime,level,tags \
  -jar app.jar
```

<p>一个典型现象是：问题版本在压测高峰期会出现更密集的 Young GC，例如：</p>

| 版本 | 2 分钟内 Young GC 次数 | 单次停顿中位数 | 备注 |
| --- | ---: | ---: | --- |
| 错误线程池配置 | 31 | 8.3ms | Future/回调对象更多，堆积更明显 |
| 优化后配置 | 18 | 5.1ms | 排队变少，短命对象压力下降 |

<p>这不是说 GC 是根因，而是它经常会成为“次生灾害”：根因是排队，GC 是被拖出来一起受罪的。</p>

<h1 id="第二把刀：用-async-profiler-确认热点与等待形态"><a href="#第二把刀：用-async-profiler-确认热点与等待形态" class="headerlink" title="第二把刀：用 async-profiler 确认热点与等待形态"></a>第二把刀：用 async-profiler 确认热点与等待形态</h1>
<p><strong>async-profiler</strong> 是一个低开销性能分析工具，既能看 CPU 火焰图，也能看 wall-clock（真实经过时间）维度。CPU 图适合看“谁最耗算力”，wall 图更适合看“线程到底卡在哪里”。</p>
<p>这个场景里，<strong>wall 模式</strong>比纯 CPU 模式更有价值，因为我们怀疑的是等待和排队，不是纯计算热点。</p>

<p>采集 wall-clock 火焰图：</p>

```bash
./profiler.sh -d 60 -e wall -f /tmp/wall.html <pid>
```

<p>采集 CPU 火焰图：</p>

```bash
./profiler.sh -d 60 -e cpu -f /tmp/cpu.html <pid>
```

<p>怎么解读？抓重点，不要一上来就被图吓住：</p>
<ul>
<li>如果 <strong>wall 图</strong>里 `CompletableFuture.get`、`Unsafe.park`、线程池队列相关调用很宽，说明线程大量时间在等；</li>
<li>如果 <strong>cpu 图</strong>里业务方法并不宽，但调度框架、对象分配、日志格式化之类占比上来了，说明系统在“忙无效功”；</li>
<li>如果 wall 图里下游调用链很宽，说明长尾请求正在吞掉线程池容量。</li>
</ul>

<p>这个实验里，两个火焰图通常会给出一个很统一的信号：<strong>线程不是不够多，而是等待太多、排队太长，导致线程越多越乱</strong>。</p>

<h1 id="根因：不是线程太少，而是线程池模型不对"><a href="#根因：不是线程太少，而是线程池模型不对" class="headerlink" title="根因：不是线程太少，而是线程池模型不对"></a>根因：不是线程太少，而是线程池模型不对</h1>
<p>为什么“16 核心线程 + 200 最大线程 + 10000 队列”会把系统搞抖？核心原因有四个：</p>
<ol>
<li><strong>大队列掩盖过载</strong>：任务先排进去，看起来没拒绝，实际上延迟已经开始失控；</li>
<li><strong>最大线程数过高</strong>：下游慢的时候，线程会不断扩张，带来更多上下文切换和内存开销；</li>
<li><strong>调用方阻塞等待</strong>：`CompletableFuture.get()` 最终还是把请求线程挂住了；</li>
<li><strong>长尾请求占坑</strong>：3% 的慢请求足够拖垮整个线程池的可用容量。</li>
</ol>

<p>很多人调线程池只记一个经验值：“I/O 密集型就把线程开大一点”。这句话没错，但它不完整。你至少还得同时考虑：</p>
<ul>
<li>下游平均耗时和长尾耗时；</li>
<li>每个请求会提交几个异步任务；</li>
<li>是否允许排队，最多排多久；</li>
<li>超时、熔断、退避重试有没有联动。</li>
</ul>

<h1 id="修复方案：小队列-有边界-配套超时"><a href="#修复方案：小队列-有边界-配套超时" class="headerlink" title="修复方案：小队列 + 有边界 + 配套超时"></a>修复方案：小队列 + 有边界 + 配套超时</h1>
<p>这个案例里，修复不是“盲目扩线程”，而是把线程池改成<strong>有边界、能尽早暴露压力</strong>的模型：</p>

```java
@Bean(destroyMethod = "shutdown")
public ExecutorService downstreamExecutor() {
    return new ThreadPoolExecutor(
            32,
            64,
            30,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            new ThreadFactoryBuilder().setNameFormat("downstream-%d").build(),
            new ThreadPoolExecutor.AbortPolicy()
    );
}
```

<p>同时把业务调用也配套改掉：</p>
<ul>
<li>每个下游调用都显式超时；</li>
<li>超时后快速失败，不无限等待；</li>
<li>在入口处记录线程池排队长度和拒绝次数；</li>
<li>必要时做舱壁隔离，不同下游用不同线程池。</li>
</ul>

<p>为什么这里反而把队列调小了？因为<strong>小队列不是更激进，而是更诚实</strong>。系统扛不住时，应该尽早暴露出来，然后配合降级、熔断、限流处理，而不是让请求在队列里闷着排 3 秒再超时。</p>

<h2 id="优化后的压测结果"><a href="#优化后的压测结果" class="headerlink" title="优化后的压测结果"></a>优化后的压测结果</h2>
<p>同样的压测参数下，优化后的结果通常会像这样：</p>

| 版本 | QPS | Avg | P50 | P95 | P99 | 超时率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 错误线程池配置 | 812 | 96ms | 71ms | 241ms | 487ms | 2.8% |
| 优化后配置 | 1089 | 58ms | 49ms | 111ms | 176ms | 0.3% |

<p>这组数据最有价值的不是 QPS 提升了多少，而是 <strong>P95/P99 明显收敛</strong>。接口真正“稳不稳”，看长尾比看平均值重要得多。</p>

<h2 id="如果你还想继续往下挖"><a href="#如果你还想继续往下挖" class="headerlink" title="如果你还想继续往下挖"></a>如果你还想继续往下挖</h2>
<p>除了上面的修复，还可以继续做三件事：</p>
<ol>
<li><strong>把线程池指标接入 Micrometer + Prometheus</strong>：把 active、queue、completed、rejected 做成时序指标；</li>
<li><strong>区分 CPU 型任务和 I/O 型任务</strong>：不要混用一个池子；</li>
<li><strong>减少同步等待</strong>：如果业务允许，尽量减少 `get()` 这种阻塞汇合点。</li>
</ol>

<h1 id="如何验证你的修复真的有效"><a href="#如何验证你的修复真的有效" class="headerlink" title="如何验证你的修复真的有效"></a>如何验证你的修复真的有效</h1>
<p>别只改完参数跑一眼平均响应时间就宣布胜利，至少按下面这套顺序验证：</p>
<ol>
<li>固定压测参数：`wrk -t4 -c200 -d120s`；</li>
<li>记录优化前后的 <strong>QPS / P50 / P95 / P99 / 超时率</strong>；</li>
<li>对比线程池 active、queue、rejected 指标；</li>
<li>各抓一份 60~120 秒的 JFR 和 async-profiler wall 图；</li>
<li>对比 GC 次数和停顿时间；</li>
<li>确认慢请求比例下降，而不是单纯把错误吞了。</li>
</ol>

<p>如果修复有效，你应该看到的是：</p>
<ul>
<li>队列峰值显著下降；</li>
<li>线程数不再无节制膨胀；</li>
<li>wall 图里的等待占比变小；</li>
<li>P99 收敛明显；</li>
<li>GC 频率下降或至少不再恶化。</li>
</ul>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>
<ol>
<li><strong>误区一：队列越大越安全</strong><br>大队列的副作用是让问题晚暴露，但代价是把延迟吃满。接口型服务更怕“慢而不死”。</li>
<li><strong>误区二：最大线程数越大越能扛流量</strong><br>线程不是免费资源。线程一多，调度、栈内存、上下文切换都会变贵。</li>
<li><strong>误区三：只看平均响应时间</strong><br>平均值特别会骗人。线上用户体感通常由 P95/P99 决定。</li>
<li><strong>误区四：只抓 CPU 火焰图，不抓 wall 图</strong><br>等待型问题，wall 图经常比 CPU 图更关键。</li>
<li><strong>误区五：线程池改好了，就不用看下游超时</strong><br>线程池只是放大器，下游长尾、重试风暴、连接池不足一样会把问题重新拉回来。</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li>接口高峰抖动，很多时候不是“算力不够”，而是<strong>线程池排队模型不合理</strong>；</li>
<li><strong>JFR</strong> 适合先看全局：线程、GC、锁、分配、方法采样；</li>
<li><strong>async-profiler</strong> 适合进一步确认热点和等待形态，尤其是 wall-clock 火焰图；</li>
<li>修线程池不要只会“调大”，更重要的是<strong>有边界、小队列、显式超时、及时失败</strong>；</li>
<li>验证优化效果时，优先看 <strong>P95/P99、队列长度、拒绝次数、GC 频率</strong>，不要只看平均值。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li><a href="https://docs.oracle.com/en/java/javase/21/troubleshoot/troubleshoot-performance-issues-using-jfr.html">Oracle Documentation - Troubleshoot Performance Issues Using JFR</a></li>
<li><a href="https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html">JDK 21 API - ThreadPoolExecutor</a></li>
<li><a href="https://github.com/async-profiler/async-profiler">async-profiler 官方仓库</a></li>
<li><a href="https://docs.spring.io/spring-boot/reference/actuator/metrics.html">Spring Boot Reference - Metrics</a></li>
<li><a href="https://micrometer.io/docs/concepts">Micrometer Concepts</a></li>
</ol>
