---
title: Spring Boot 异步任务线程池为什么越调越慢？从线程打满到可观测调优的完整实战
date: 2026-03-23 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - 线程池
  - JFR
  - async-profiler
  - 性能调优
  - Java
---
<hr>
<blockquote>
<p>很多 Spring Boot 项目一上异步任务，第一反应就是“把线程池调大一点”。结果线程数上去了，吞吐没涨多少，P99 还更差，CPU 也开始飙。线程池不是越大越快，它更像一个流量闸门：开太小会堵，开太大也会乱。本文用一个可复现实验，把线程池打满、排队、拒绝、上下文切换这些问题一次看清楚，再给出一套能落地的调优方法。</p>
</blockquote>

<!-- more -->

<h1 id="一、为什么这个问题值得单独写一篇"><a href="#一、为什么这个问题值得单独写一篇" class="headerlink" title="一、为什么这个问题值得单独写一篇"></a>一、为什么这个问题值得单独写一篇</h1>
<p>在 Java 后端里，<strong>异步任务</strong>基本是高频配置：发短信、发邮件、刷缓存、写审计日志、并发调用下游、批量导出、延迟补偿，几乎都能看到它。Spring Boot 里加一个 <code>@Async</code> 很方便，但方便也意味着容易“先跑起来再说”。</p>
<p>问题是，线程池这种东西，平时没流量的时候看起来一切正常，一旦请求量上来，问题会同时爆出来：</p>
<ul>
<li>接口 RT 抖得厉害，尤其是 <strong>P99</strong>；这里的 P99 指 99% 请求都不会超过的响应时间，适合看长尾延迟。</li>
<li>任务堆积，队列越排越长，业务方看到的现象就是“异步跟没异步一样慢”。</li>
<li>线程数很多，但 CPU 不一定高效，反而在忙着做 <strong>上下文切换</strong>；它说白了就是 CPU 一直在不同线程之间来回切人，真正干活的时间被挤掉了。</li>
<li>数据库连接池、HTTP 连接池、下游限流阈值被线程池一把冲穿。</li>
</ul>
<p>所以这篇文章不聊空泛原则，直接做一个实验：先故意把线程池配坏，再一步步把它调回来，并用 <strong>JFR</strong> 和 <strong>async-profiler</strong> 看证据。<strong>JFR</strong>（Java Flight Recorder）可以理解成 JVM 自带的低开销飞行记录仪，适合在线采集性能事件；<strong>async-profiler</strong> 是 Java 圈很常用的性能剖析工具，能看 CPU、锁竞争、分配热点，最后一般会产出大家熟悉的火焰图。</p>

<h1 id="二、实验目标与环境"><a href="#二、实验目标与环境" class="headerlink" title="二、实验目标与环境"></a>二、实验目标与环境</h1>
<p>我们要验证三个结论：</p>
<ol>
<li>线程池不是越大越快，特别是混合了 CPU 任务和 I/O 等待的场景。</li>
<li>只看平均响应时间会误判，必须同时看吞吐、P95/P99、拒绝数、队列长度。</li>
<li>线程池调优必须和数据库/HTTP 连接池、下游限流、机器核数一起看，单点放大只会把瓶颈往后推。</li>
</ol>
<p>实验环境如下：</p>
<ul>
<li>JDK 21</li>
<li>Spring Boot 3.3.x</li>
<li>4 vCPU / 8 GB 内存</li>
<li>wrk 作为压测工具；它是一个很轻量的 HTTP 压测工具，常用来测吞吐和延迟分位值</li>
<li>JFR + async-profiler 作为观测工具</li>
</ul>

<h1 id="三、先构造一个会出问题的场景"><a href="#三、先构造一个会出问题的场景" class="headerlink" title="三、先构造一个会出问题的场景"></a>三、先构造一个会出问题的场景</h1>
<p>假设我们有一个“订单提交后异步补充处理”的接口。它会做三件事：</p>
<ol>
<li>查数据库拿订单扩展信息（I/O）</li>
<li>调用一个外部风控服务（I/O）</li>
<li>做一段 JSON 序列化和规则计算（CPU）</li>
</ol>
<p>这类场景很真实：既不是纯 CPU，也不是纯 I/O，最容易被“线程池调大就行”坑到。</p>

<h2 id="1-示例代码"><a href="#1-示例代码" class="headerlink" title="1. 示例代码"></a>1. 示例代码</h2>

```java
@Configuration
@EnableAsync
public class AsyncPoolConfig {

    @Bean("orderExecutor")
    public ThreadPoolTaskExecutor orderExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(64);
        executor.setMaxPoolSize(128);
        executor.setQueueCapacity(5000);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("order-async-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        executor.initialize();
        return executor;
    }
}
```

<p>这份配置很像线上常见“先顶上去”的版本：核心线程 64，最大线程 128，队列 5000。看起来很猛，实际上问题很大。4 核机器上先放这么多线程，本身就埋下了上下文切换的雷；再加一个超大队列，任务不会及时失败，只会慢慢堆成大雪球。</p>

```java
@Service
@Slf4j
public class OrderAsyncService {

    @Async("orderExecutor")
    public CompletableFuture<String> enrichOrder(String orderId) {
        simulateDbQuery();
        simulateRemoteCall();
        simulateCpuWork();
        return CompletableFuture.completedFuture("ok-" + orderId);
    }

    private void simulateDbQuery() {
        LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(20));
    }

    private void simulateRemoteCall() {
        LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(40));
    }

    private void simulateCpuWork() {
        long sum = 0;
        for (int i = 0; i < 200_000; i++) {
            sum += (long) i * i;
        }
        if (sum == 0) {
            throw new IllegalStateException("impossible");
        }
    }
}
```

```java
@RestController
@RequiredArgsConstructor
public class OrderController {

    private final OrderAsyncService orderAsyncService;

    @GetMapping("/api/orders/submit")
    public String submit(@RequestParam String orderId) {
        orderAsyncService.enrichOrder(orderId);
        return "accepted";
    }
}
```

<p>注意，这个接口返回得很快，但这不代表系统真的健康。很多团队只测接口返回时间，却没测异步任务的排队时间、处理完成时间、失败率，这就是典型的“前台快、后台堵”。</p>

<h2 id="2-补上最基本的可观测性"><a href="#2-补上最基本的可观测性" class="headerlink" title="2. 补上最基本的可观测性"></a>2. 补上最基本的可观测性</h2>
<p>线程池不做指标暴露，后面几乎没法调。至少把下面这些指标打出来：</p>
<ul>
<li><code>activeCount</code>：当前活跃线程数</li>
<li><code>poolSize</code>：线程池里已有线程数</li>
<li><code>queueSize</code>：队列积压数</li>
<li><code>completedTaskCount</code>：累计完成任务数</li>
<li><code>rejectCount</code>：拒绝任务数</li>
</ul>

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class ThreadPoolMetricsLogger {

    private final ThreadPoolTaskExecutor orderExecutor;
    private final AtomicLong rejectCount = new AtomicLong();

    @PostConstruct
    public void init() {
        orderExecutor.setRejectedExecutionHandler((r, executor) -> {
            rejectCount.incrementAndGet();
            throw new RejectedExecutionException("orderExecutor rejected");
        });
    }

    @Scheduled(fixedDelay = 5000)
    public void print() {
        ThreadPoolExecutor executor = orderExecutor.getThreadPoolExecutor();
        log.info("poolSize={}, active={}, queue={}, completed={}, rejected={}",
                executor.getPoolSize(),
                executor.getActiveCount(),
                executor.getQueue().size(),
                executor.getCompletedTaskCount(),
                rejectCount.get());
    }
}
```

<p>如果你线上已经接了 Micrometer + Prometheus，那更简单，直接把这些指标做成监控面板。<strong>Micrometer</strong> 可以理解成 Spring Boot 里统一打指标的那层抽象，常用来接 Prometheus、Datadog 之类的监控系统。</p>

<h1 id="四、如何复现实验"><a href="#四、如何复现实验" class="headerlink" title="四、如何复现实验"></a>四、如何复现实验</h1>

<h2 id="1-启动应用"><a href="#1-启动应用" class="headerlink" title="1. 启动应用"></a>1. 启动应用</h2>

```bash
./mvnw spring-boot:run
```

<h2 id="2-用-wrk-做压测"><a href="#2-用-wrk-做压测" class="headerlink" title="2. 用 wrk 做压测"></a>2. 用 wrk 做压测</h2>

```bash
wrk -t4 -c200 -d60s --latency 'http://127.0.0.1:8080/api/orders/submit?orderId=1001'
```

<p>这里的参数顺手解释一下：</p>
<ul>
<li><code>-t4</code>：4 个压测线程</li>
<li><code>-c200</code>：200 个并发连接</li>
<li><code>-d60s</code>：持续 60 秒</li>
<li><code>--latency</code>：输出延迟分位值</li>
</ul>

<h2 id="3-同时采集-JFR"><a href="#3-同时采集-JFR" class="headerlink" title="3. 同时采集 JFR"></a>3. 同时采集 JFR</h2>

```bash
jcmd $(jps | awk '/OrderApplication/ {print $1}') JFR.start \
  name=order-pool \
  settings=profile \
  filename=order-pool.jfr \
  duration=60s
```

<p>这条命令的意思很简单：对目标 Java 进程录 60 秒 JFR，结束后输出成文件。<code>settings=profile</code> 表示用偏性能分析的采样配置。</p>

<h2 id="4-再补一份-async-profiler-火焰图"><a href="#4-再补一份-async-profiler-火焰图" class="headerlink" title="4. 再补一份 async-profiler 火焰图"></a>4. 再补一份 async-profiler 火焰图</h2>

```bash
./profiler.sh -d 30 -e cpu -f cpu.html $(jps | awk '/OrderApplication/ {print $1}')
```

<p>如果你第一次用 async-profiler，可以把它理解成“看 CPU 时间到底花在哪”的放大镜。输出的 <code>cpu.html</code> 打开后会看到火焰图，越宽代表占用越高。</p>

<h1 id="五、第一次压测结果：线程很多，但系统更慢了"><a href="#五、第一次压测结果：线程很多，但系统更慢了" class="headerlink" title="五、第一次压测结果：线程很多，但系统更慢了"></a>五、第一次压测结果：线程很多，但系统更慢了</h1>
<p>下面是一组典型结果（同一台 4 核机器，多次压测取中位）：</p>

| 配置方案 | core/max | queue | 吞吐（req/s） | P50 | P95 | P99 | 拒绝数 | 备注 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 方案 A：盲目调大 | 64/128 | 5000 | 1850 | 18ms | 420ms | 1300ms | 0 | 队列长，长尾明显 |
| 方案 B：收敛线程数 | 16/32 | 500 | 2380 | 12ms | 120ms | 280ms | 14 | 少量快速失败 |
| 方案 C：按下游能力限流 | 16/24 | 200 | 2280 | 11ms | 80ms | 160ms | 39 | 总体更稳 |

<p>这张表很关键，能看出两个经常被忽略的事实：</p>
<ol>
<li><strong>吞吐最高的，不一定是线程最多的。</strong> 方案 A 线程更多，但吞吐反而最低。</li>
<li><strong>少量拒绝不一定是坏事。</strong> 方案 B、C 有拒绝，但 P99 明显更好，因为系统没有被无限排队拖死。</li>
</ol>
<p>这里的“拒绝”不是说系统挂了，而是明确告诉上游：我现在忙不过来，请降级、稍后重试、走补偿。很多时候，<strong>可控失败比不可控变慢更健康</strong>。</p>

<h2 id="JFR-里看到了什么"><a href="#JFR-里看到了什么" class="headerlink" title="JFR 里看到了什么"></a>JFR 里看到了什么</h2>
<p>在方案 A 里，JFR 往往会看到下面这些现象：</p>
<ul>
<li><strong>Java Thread Statistics</strong> 显示线程数量明显偏高</li>
<li><strong>Socket Read</strong>、<strong>Thread Park</strong> 事件很多，说明大量线程在等 I/O</li>
<li><strong>CPU Load</strong> 没有线性上升，说明不是“线程多 = CPU 利用率更高”</li>
<li>上下文切换和调度开销增加，真正的业务执行时间占比下降</li>
</ul>

<h2 id="火焰图里看到了什么"><a href="#火焰图里看到了什么" class="headerlink" title="火焰图里看到了什么"></a>火焰图里看到了什么</h2>
<p>async-profiler 的火焰图一般会出现两类热点：</p>
<ol>
<li>业务 CPU 逻辑本身，比如 JSON 序列化、规则计算</li>
<li>线程调度、锁竞争、线程池相关方法调用</li>
</ol>
<p>如果你看到火焰图上线程调度相关栈越来越宽，而业务逻辑没有同比变宽，那就说明线程数量已经不是收益，而是成本了。</p>

<h1 id="六、为什么会这样：线程池调优的底层逻辑"><a href="#六、为什么会这样：线程池调优的底层逻辑" class="headerlink" title="六、为什么会这样：线程池调优的底层逻辑"></a>六、为什么会这样：线程池调优的底层逻辑</h1>
<p>线程池调优别背口诀，先记住一个更实用的判断：<strong>你在用线程池控制并发，不是在用线程池制造并发。</strong></p>

<h2 id="1-CPU-密集型任务"><a href="#1-CPU-密集型任务" class="headerlink" title="1. CPU 密集型任务"></a>1. CPU 密集型任务</h2>
<p>纯 CPU 任务，线程数通常接近 CPU 核数就差不多了。再往上加，收益很快递减，因为 CPU 本来就只有那么多核心。</p>

<h2 id="2-I-O-密集型任务"><a href="#2-I-O-密集型任务" class="headerlink" title="2. I/O 密集型任务"></a>2. I/O 密集型任务</h2>
<p>纯 I/O 任务可以适当放大线程数，因为很多线程是在等网络、等数据库、等磁盘，不会持续吃满 CPU。但这里有个大前提：下游也必须扛得住。比如数据库连接池只有 20，你线程池开到 100，本质上只是让 80 个线程多等一会儿。</p>

<h2 id="3-混合型任务"><a href="#3-混合型任务" class="headerlink" title="3. 混合型任务"></a>3. 混合型任务</h2>
<p>真实业务多数是混合型任务，所以更推荐先从保守值起步，再结合观测数据收敛。一个很实用的起点是：</p>

```text
核心线程数 ≈ CPU 核数 * 2 ~ 4
队列长度 ≈ 峰值每秒任务数 * 可容忍排队秒数
最大线程数 ≈ 核心线程数 * 1.5 ~ 2
```

<p>这不是金科玉律，但比“先来 128 个线程再说”靠谱得多。</p>

<h1 id="七、把配置调回来：一套更稳的落地方案"><a href="#七、把配置调回来：一套更稳的落地方案" class="headerlink" title="七、把配置调回来：一套更稳的落地方案"></a>七、把配置调回来：一套更稳的落地方案</h1>

```java
@Configuration
@EnableAsync
public class AsyncPoolConfig {

    @Bean("orderExecutor")
    public ThreadPoolTaskExecutor orderExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(16);
        executor.setMaxPoolSize(24);
        executor.setQueueCapacity(200);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("order-async-");
        executor.setTaskDecorator(new MdcTaskDecorator());
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }
}
```

<p>这里有几个关键点：</p>
<ul>
<li><strong>core/max 收敛</strong>：让线程数回到机器和下游都能承受的范围</li>
<li><strong>queueCapacity 变小</strong>：避免问题长期藏在队列里</li>
<li><strong>CallerRunsPolicy</strong>：调用方线程自己执行任务，起到天然反压；所谓 <strong>反压</strong>，就是系统忙不过来的时候，把压力回传给上游，而不是自己默默憋着</li>
<li><strong>MDC 透传</strong>：异步线程里日志链路别断，不然出问题查不到请求上下文</li>
</ul>

<p>如果你的任务是明显的远程 I/O 型，还可以进一步做这几件事：</p>
<ol>
<li>给下游调用单独线程池，不和其他异步任务混用</li>
<li>配合 Resilience4j 做舱壁隔离和限流；<strong>舱壁隔离</strong>这个词听起来玄乎，说白了就是把不同类型的故障隔开，别一个下游慢了把整个服务都拖下水</li>
<li>为数据库连接池、HTTP 连接池设置明确上限，并让线程池和这些上限保持一致</li>
</ol>

<h1 id="八、怎么验证你的调优真的有效"><a href="#八、怎么验证你的调优真的有效" class="headerlink" title="八、怎么验证你的调优真的有效"></a>八、怎么验证你的调优真的有效</h1>
<p>不要只说“感觉好多了”，最少按下面这套做：</p>

<h2 id="1-压测前后对比"><a href="#1-压测前后对比" class="headerlink" title="1. 压测前后对比"></a>1. 压测前后对比</h2>
<ul>
<li>吞吐（req/s）</li>
<li>P50 / P95 / P99</li>
<li>线程池活跃线程数</li>
<li>队列长度峰值</li>
<li>拒绝任务数</li>
<li>下游错误率 / 超时率</li>
</ul>

<h2 id="2-JFR-验证"><a href="#2-JFR-验证" class="headerlink" title="2. JFR 验证"></a>2. JFR 验证</h2>
<p>观察调优前后以下事件是否改善：</p>
<ul>
<li>线程数是否下降到合理区间</li>
<li><code>Thread Park</code> 是否减少</li>
<li>锁竞争事件是否缓和</li>
<li>CPU 时间是否更多落在业务方法，而不是线程调度</li>
</ul>

<h2 id="3-业务验证"><a href="#3-业务验证" class="headerlink" title="3. 业务验证"></a>3. 业务验证</h2>
<p>业务层面至少确认两件事：</p>
<ol>
<li>高峰期没有大面积任务积压</li>
<li>下游服务没有因为你“调大线程池”而出现级联超时</li>
</ol>

<p>如果要更严格一点，可以在压测时同时观察数据库连接池、Redis 连接池、HTTP 客户端连接池。很多时候线程池指标看起来健康，真正炸的是下游连接数。</p>

<h1 id="九、常见坑与误区"><a href="#九、常见坑与误区" class="headerlink" title="九、常见坑与误区"></a>九、常见坑与误区</h1>

<h2 id="误区-1：队列越大越稳"><a href="#误区-1：队列越大越稳" class="headerlink" title="误区 1：队列越大越稳"></a>误区 1：队列越大越稳</h2>
<p>错。大队列经常只是把问题往后拖。看起来没有拒绝，实际上用户已经在用更长的等待时间替你买单。</p>

<h2 id="误区-2：最大线程数就是系统并发能力"><a href="#误区-2：最大线程数就是系统并发能力" class="headerlink" title="误区 2：最大线程数就是系统并发能力"></a>误区 2：最大线程数就是系统并发能力</h2>
<p>也错。真正的并发能力取决于 CPU、数据库连接、HTTP 连接池、下游 QPS 限额、磁盘、网络等多种资源。线程数只是表层旋钮。</p>

<h2 id="误区-3：异步了，就一定比同步快"><a href="#误区-3：异步了，就一定比同步快" class="headerlink" title="误区 3：异步了，就一定比同步快"></a>误区 3：异步了，就一定比同步快</h2>
<p>异步的核心收益是解耦主流程、提高资源利用率，不是白送性能。拆错地方，异步反而会增加线程切换、上下文传播、故障复杂度。</p>

<h2 id="误区-4：只盯平均值"><a href="#误区-4：只盯平均值" class="headerlink" title="误区 4：只盯平均值"></a>误区 4：只盯平均值</h2>
<p>平均值最会骗人。很多系统平均 30ms，看起来还行，P99 已经 2 秒了，真实用户体验其实很差。</p>

<h1 id="十、一个更实用的调优顺序"><a href="#十、一个更实用的调优顺序" class="headerlink" title="十、一个更实用的调优顺序"></a>十、一个更实用的调优顺序</h1>
<ol>
<li>先分清任务类型：CPU、I/O、混合</li>
<li>补齐线程池和下游资源指标</li>
<li>用保守线程数起步，而不是极端大值</li>
<li>压测看吞吐 + P95/P99 + 队列 + 拒绝数</li>
<li>用 JFR / async-profiler 找真实热点</li>
<li>再做第二轮调参，不要靠拍脑袋</li>
</ol>

<p>如果你所在团队过去的调优方式是“线上报警了，先把线程数翻倍”，我建议从今天开始改掉。线程池更像是一种容量治理工具，不是止痛药。</p>

<h1 id="十一、总结"><a href="#十一、总结" class="headerlink" title="十一、总结"></a>十一、总结</h1>
<ul>
<li>线程池调优不是越大越好，而是要和机器核数、任务类型、下游能力一起看</li>
<li>大队列经常会掩盖问题，让系统进入“表面不报错、实际越来越慢”的状态</li>
<li>压测不能只看平均响应时间，至少要看吞吐、P95/P99、队列、拒绝数</li>
<li>JFR 和 async-profiler 是定位线程池问题的高性价比工具，别只凭感觉调参</li>
<li>可控拒绝、明确反压，很多时候比无限排队更健康</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>Oracle, <a href="https://docs.oracle.com/en/java/javase/21/core/java-flight-recorder.html">Java Flight Recorder 官方文档</a></li>
<li>Spring Framework, <a href="https://docs.spring.io/spring-framework/reference/integration/scheduling.html">Task Execution and Scheduling</a></li>
<li>Micrometer, <a href="https://docs.micrometer.io/micrometer/reference/">Micrometer Reference Documentation</a></li>
<li>async-profiler, <a href="https://github.com/async-profiler/async-profiler">GitHub 官方仓库</a></li>
<li>Brendan Gregg, <a href="https://www.brendangregg.com/flamegraphs.html">Flame Graphs</a></li>
<li>《Java 并发编程实战》关于线程池与任务执行策略的相关章节</li>
</ol>
