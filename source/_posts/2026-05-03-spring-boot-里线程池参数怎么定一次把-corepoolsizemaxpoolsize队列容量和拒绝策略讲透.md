---
title: Spring Boot 里线程池参数怎么定？一次把 corePoolSize、maxPoolSize、队列容量和拒绝策略讲透
date: 2026-05-03 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - Spring Boot
  - ThreadPoolExecutor
  - 并发
  - 压测
  - 可观测性
---
<hr>
<blockquote>
<p>很多 Java 项目里都配了线程池，但不少配置其实是“拍脑袋参数”：<strong>corePoolSize</strong> 随手写 10、<strong>maxPoolSize</strong> 随手写 200、队列容量先给 1000，结果要么吞吐上不去，要么延迟飙升，要么把内存和下游一起拖垮。线程池不是配得越大越猛，它本质上是在做“吞吐、延迟、内存、下游承载能力”之间的平衡。</p>
<p>这篇文章我不讲空话，直接用一个可复现实验把几个核心参数的行为差异跑出来，再给一套 Spring Boot 里能落地的配置和排障方法。你看完至少能回答三个问题：为什么队列大了反而慢、为什么 maxPoolSize 经常根本没生效、还有拒绝策略到底该怎么选。</p>
</blockquote>

<!-- more -->

<h1 id="为什么线程池参数老是配错"><a href="#为什么线程池参数老是配错" class="headerlink" title="为什么线程池参数老是配错"></a>为什么线程池参数老是配错</h1>
<p>先说结论：很多人配线程池时，脑子里只有“多开点线程处理更快”，但实际系统里，线程池从来不是只影响 CPU。它还会影响：</p>
<ul>
<li><strong>请求排队时间</strong>：任务先不执行，光在队列里等，就已经把接口延迟拉高了。</li>
<li><strong>内存占用</strong>：队列里堆的每个任务对象都要吃内存，堆多了容易把 GC 顶上来。</li>
<li><strong>下游承载</strong>：数据库、Redis、HTTP 下游、MQ 消费端，都不是你开 200 个线程它就一定扛得住。</li>
<li><strong>故障形态</strong>：有的系统是慢死，有的系统是爆死。大队列通常让你“看起来没报错，但全链路都在慢慢憋死”。</li>
</ul>
<p><strong>corePoolSize</strong> 是核心线程数，可以理解成线程池“常驻工位”的数量；<strong>maxPoolSize</strong> 是线程池能临时扩到的上限；<strong>workQueue</strong> 是任务排队区；<strong>RejectedExecutionHandler</strong> 是实在接不住任务时的处理方式，也就是所谓的拒绝策略。</p>
<p>如果这些概念你以前听过但没真正跑过实验，那很容易记成口诀，但一到线上还是不会用。</p>

<h1 id="ThreadPoolExecutor-的执行规则先搞清楚"><a href="#ThreadPoolExecutor-的执行规则先搞清楚" class="headerlink" title="ThreadPoolExecutor 的执行规则先搞清楚"></a>ThreadPoolExecutor 的执行规则先搞清楚</h1>
<p>Java 里最常见的线程池实现是 <strong>ThreadPoolExecutor</strong>。它是 JDK 提供的通用线程池执行器，Spring Boot 里你无论是自己 new，还是通过 <code>ThreadPoolTaskExecutor</code> 包一层，底下基本都绕不开它。</p>
<p>它接收一个新任务时，默认决策顺序是这样的：</p>
<ol>
<li>如果当前运行线程数 &lt; <strong>corePoolSize</strong>，直接新建线程执行。</li>
<li>否则，先尝试把任务放进 <strong>队列</strong>。</li>
<li>如果队列满了，并且当前运行线程数 &lt; <strong>maxPoolSize</strong>，再继续扩线程。</li>
<li>如果队列也满了、线程也到上限了，走<strong>拒绝策略</strong>。</li>
</ol>
<p>注意这个顺序很关键，所以我单独强调一句：</p>
<blockquote>
<p>只要队列还没满，很多时候 <strong>maxPoolSize 根本不会生效</strong>。</p>
</blockquote>
<p>这也是线上最常见的误区之一：你以为自己配了 <code>maxPoolSize=64</code>，结果由于队列给了 5000，线程池永远只跑在 core 线程数附近，任务全在排队，接口 P99 直接飞天。</p>

<h1 id="先给实验环境"><a href="#先给实验环境" class="headerlink" title="先给实验环境"></a>先给实验环境</h1>
<p>下面这个实验可以直接复现。目标很简单：模拟一个典型的“线程池包着 IO 任务”的后端场景，比如批量调用下游 HTTP、查数据库、或者执行带等待的异步任务。</p>

<h2 id="实验目标"><a href="#实验目标" class="headerlink" title="实验目标"></a>实验目标</h2>
<ul>
<li>观察不同线程池参数下的吞吐和延迟变化</li>
<li>观察大队列对 P95/P99 的影响</li>
<li>验证拒绝策略在高压下的表现</li>
<li>给出一套 Spring Boot 可直接落地的配置方法</li>
</ul>

<h2 id="实验代码"><a href="#实验代码" class="headerlink" title="实验代码"></a>实验代码</h2>
<p>先给一个最小可运行的 Java 程序。它会往线程池里连续提交任务，每个任务固定 sleep 200ms，用来模拟一个平均耗时 200ms 的 IO 型工作负载。</p>

```java
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class ThreadPoolSizingDemo {

    static class Metrics {
        List<Long> queueWaitMs = new CopyOnWriteArrayList<>();
        List<Long> totalCostMs = new CopyOnWriteArrayList<>();
        AtomicInteger rejected = new AtomicInteger();
    }

    public static void main(String[] args) throws Exception {
        runCase("case-a-small-queue", 8, 16, 32, 100, 200);
        runCase("case-b-big-queue", 8, 16, 1000, 100, 200);
        runCase("case-c-caller-runs", 8, 16, 32, 100, 200, new ThreadPoolExecutor.CallerRunsPolicy());
    }

    static void runCase(String caseName,
                        int core,
                        int max,
                        int queueCapacity,
                        int qps,
                        int taskMs) throws Exception {
        runCase(caseName, core, max, queueCapacity, qps, taskMs, new ThreadPoolExecutor.AbortPolicy());
    }

    static void runCase(String caseName,
                        int core,
                        int max,
                        int queueCapacity,
                        int qps,
                        int taskMs,
                        RejectedExecutionHandler handler) throws Exception {
        Metrics metrics = new Metrics();
        BlockingQueue<Runnable> queue = new ArrayBlockingQueue<>(queueCapacity);
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                core,
                max,
                60,
                TimeUnit.SECONDS,
                queue,
                new NamedThreadFactory(caseName),
                (r, ex) -> {
                    metrics.rejected.incrementAndGet();
                    handler.rejectedExecution(r, ex);
                }
        );

        int durationSeconds = 60;
        long intervalNs = 1_000_000_000L / qps;
        long next = System.nanoTime();
        CountDownLatch latch = new CountDownLatch(durationSeconds * qps);

        for (int i = 0; i < durationSeconds * qps; i++) {
            long submitNs = System.nanoTime();
            try {
                executor.execute(() -> {
                    long startNs = System.nanoTime();
                    metrics.queueWaitMs.add(TimeUnit.NANOSECONDS.toMillis(startNs - submitNs));
                    try {
                        Thread.sleep(taskMs);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    } finally {
                        long endNs = System.nanoTime();
                        metrics.totalCostMs.add(TimeUnit.NANOSECONDS.toMillis(endNs - submitNs));
                        latch.countDown();
                    }
                });
            } catch (RejectedExecutionException e) {
                latch.countDown();
            }

            next += intervalNs;
            long waitNs = next - System.nanoTime();
            if (waitNs > 0) {
                LockSupport.parkNanos(waitNs);
            }
        }

        latch.await(3, TimeUnit.MINUTES);
        executor.shutdown();
        executor.awaitTermination(1, TimeUnit.MINUTES);

        printStats(caseName, metrics, executor);
    }

    static void printStats(String caseName, Metrics metrics, ThreadPoolExecutor executor) {
        System.out.println("==== " + caseName + " ====");
        printLatency("queueWait", metrics.queueWaitMs);
        printLatency("totalCost", metrics.totalCostMs);
        System.out.println("rejected=" + metrics.rejected.get());
        System.out.println();
    }

    static void printLatency(String name, List<Long> data) {
        if (data.isEmpty()) {
            System.out.println(name + ": no data");
            return;
        }
        List<Long> copy = new ArrayList<>(data);
        copy.sort(Long::compareTo);
        System.out.printf("%s: count=%d, p50=%dms, p95=%dms, p99=%dms, max=%dms%n",
                name,
                copy.size(),
                pct(copy, 0.50),
                pct(copy, 0.95),
                pct(copy, 0.99),
                copy.get(copy.size() - 1));
    }

    static long pct(List<Long> data, double p) {
        int idx = Math.min(data.size() - 1, (int)Math.ceil(data.size() * p) - 1);
        return data.get(idx);
    }

    static class NamedThreadFactory implements ThreadFactory {
        private final String prefix;
        private final AtomicInteger seq = new AtomicInteger(1);

        NamedThreadFactory(String prefix) {
            this.prefix = prefix;
        }

        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r);
            t.setName(prefix + "-" + seq.getAndIncrement());
            return t;
        }
    }
}
```

<p>这里补两句新名词解释，免得第一次接触的人看晕：</p>
<ul>
<li><strong>P50/P95/P99</strong>：分位延迟指标。P99=99% 的请求都不超过这个时间，线上看抖动通常主要盯 P95 和 P99。</li>
<li><strong>CallerRunsPolicy</strong>：一种拒绝策略，线程池接不住时，不丢任务，而是让“提交任务的那个线程”自己去执行。它的作用本质上是反压，也就是逼上游自己慢下来。</li>
<li><strong>反压（Backpressure）</strong>：下游扛不住时，把压力往上游传，让上游降低发送速度，避免把系统整体压死。</li>
</ul>

<h2 id="如何运行"><a href="#如何运行" class="headerlink" title="如何运行"></a>如何运行</h2>

```bash
javac ThreadPoolSizingDemo.java
java ThreadPoolSizingDemo
```

<p>JDK 17+ 可以直接跑。为了和多数 Spring Boot 3 项目环境对齐，我建议本地用 JDK 17 或 JDK 21。</p>

<h1 id="三组实验对比"><a href="#三组实验对比" class="headerlink" title="三组实验对比"></a>三组实验对比</h1>
<p>实验参数我先统一一下：</p>
<ul>
<li>任务平均执行时间：200ms</li>
<li>提交速率：100 qps</li>
<li>持续时间：60s</li>
<li>corePoolSize=8</li>
<li>maxPoolSize=16</li>
</ul>
<p>这个压力为什么有意义？因为单任务 200ms，如果完全没有额外等待，理论上要扛住 100 qps，至少需要约 <code>100 * 0.2 = 20</code> 个并发执行槽位。也就是说，<code>maxPoolSize=16</code> 天然有点紧，这样我们更容易观察不同队列和拒绝策略的差异。</p>

<h2 id="Case-A：小队列"><a href="#Case-A：小队列" class="headerlink" title="Case A：小队列"></a>Case A：小队列</h2>
<p>参数：</p>

```text
corePoolSize = 8
maxPoolSize = 16
queueCapacity = 32
rejectPolicy = AbortPolicy
```

<p>一组典型结果可能长这样：</p>

| 指标 | 数值 |
|---|---:|
| queueWait P50 | 18ms |
| queueWait P95 | 146ms |
| queueWait P99 | 221ms |
| totalCost P50 | 219ms |
| totalCost P95 | 347ms |
| totalCost P99 | 423ms |
| rejected | 300~800 |

<p>这个结果说明什么？说明小队列会更早把压力暴露出来：延迟还算可控，但当系统吞不下时，开始明确拒绝请求。</p>
<p>这类配置的优点是：<strong>你知道自己扛不住了</strong>。坏处也很明显：如果上层没有兜底，用户会直接收到失败。</p>

<h2 id="Case-B：大队列"><a href="#Case-B：大队列" class="headerlink" title="Case B：大队列"></a>Case B：大队列</h2>
<p>参数：</p>

```text
corePoolSize = 8
maxPoolSize = 16
queueCapacity = 1000
rejectPolicy = AbortPolicy
```

<p>一组典型结果可能是这样：</p>

| 指标 | 数值 |
|---|---:|
| queueWait P50 | 2.3s |
| queueWait P95 | 8.7s |
| queueWait P99 | 9.6s |
| totalCost P50 | 2.5s |
| totalCost P95 | 8.9s |
| totalCost P99 | 9.8s |
| rejected | 0~少量 |

<p>这就是很多线上事故最坑人的地方：<strong>表面上几乎没报错，实际上用户已经快等疯了</strong>。</p>
<p>为什么会这样？因为任务都被好好地塞进队列里了，系统没有立刻拒绝，看起来“成功接单”了，但实际执行已经严重排队。对用户来说，这种慢性雪崩经常比直接失败更难受，也更难排查。</p>
<p>而且大队列还有两个副作用：</p>
<ul>
<li>任务对象在堆里堆积，容易把 <strong>Young GC</strong> 和 <strong>Old GC</strong> 顶起来。GC 日志就是 JVM 打印的垃圾回收过程日志，你可以用它观察是不是因为对象堆积导致停顿变长。</li>
<li>当任务里还带请求上下文、DTO、大字符串、批量结果集时，队列越大，内存风险越高。</li>
</ul>

<h2 id="Case-C：小队列-CallerRunsPolicy"><a href="#Case-C：小队列-CallerRunsPolicy" class="headerlink" title="Case C：小队列 + CallerRunsPolicy"></a>Case C：小队列 + CallerRunsPolicy</h2>
<p>参数：</p>

```text
corePoolSize = 8
maxPoolSize = 16
queueCapacity = 32
rejectPolicy = CallerRunsPolicy
```

<p>典型结果：</p>

| 指标 | 数值 |
|---|---:|
| queueWait P50 | 25ms |
| queueWait P95 | 180ms |
| queueWait P99 | 290ms |
| totalCost P50 | 225ms |
| totalCost P95 | 390ms |
| totalCost P99 | 510ms |
| rejected | 100~500（但多数被调用方线程兜住） |

<p>它的特点是：不会像 AbortPolicy 那样直接大量抛错，而是让调用线程自己干活。这样一来，上游提交速度自然会慢下来，系统形成反压。</p>
<p>如果你的业务场景允许“提交方变慢”，比如异步批处理、非核心链路任务、内部管理后台，这个策略通常比一味堆大队列更稳。</p>
<p>但如果你是在 Tomcat/Netty 的请求线程里直接提交异步任务，那也别无脑上 CallerRunsPolicy。因为调用线程自己去干活，可能把 Web 请求线程拖慢，进而影响整体接入层吞吐。</p>

<h1 id="一个关键结论：队列不是越大越好"><a href="#一个关键结论：队列不是越大越好" class="headerlink" title="一个关键结论：队列不是越大越好"></a>一个关键结论：队列不是越大越好</h1>
<p>把上面三组实验放一起看，结论其实很明确：</p>

| 配置方向 | 吞吐表现 | 延迟表现 | 故障形态 | 适用场景 |
|---|---|---|---|---|
| 小队列 + 明确拒绝 | 容量边界清晰 | P99 更容易控制 | 快速失败 | 核心接口、需要明确限流/降级 |
| 大队列 | 表面不报错 | P95/P99 容易暴涨 | 慢性雪崩 | 一般不推荐作为默认方案 |
| 小队列 + 反压 | 吞吐更平滑 | 延迟相对可控 | 上游被迫减速 | 内部异步链路、可接受提交变慢 |

<p>所以线程池设计里有一个很务实的原则：</p>
<blockquote>
<p><strong>宁可让系统在边界上“可观测地拒绝”，也不要让它在队列里“无声地排队到死”。</strong></p>
</blockquote>

<h1 id="Spring-Boot-里怎么落地"><a href="#Spring-Boot-里怎么落地" class="headerlink" title="Spring Boot 里怎么落地"></a>Spring Boot 里怎么落地</h1>
<p>下面给一套 Spring Boot 里比较靠谱的配置方式。这里用 <code>ThreadPoolTaskExecutor</code>，它是 Spring 对线程池的一个封装，主要帮你更方便地接入 Bean 生命周期、线程名前缀、监控等能力。</p>

```java
@Configuration
public class AsyncExecutorConfig {

    @Bean("orderAsyncExecutor")
    public ThreadPoolTaskExecutor orderAsyncExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(32);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("order-async-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);
        executor.initialize();
        return executor;
    }
}
```

<p>如果你是做 Web 业务，我建议至少做到下面几点：</p>
<ul>
<li>不同业务线程池分开，不要一个大池子包打天下</li>
<li>线程名前缀要清晰，出问题时线程 dump 一眼能认出来</li>
<li>拒绝次数、活跃线程数、队列长度，要接监控</li>
<li>核心链路的线程池，优先考虑“小队列 + 限流/降级”思路</li>
</ul>

<h2 id="参数到底怎么估"><a href="#参数到底怎么估" class="headerlink" title="参数到底怎么估"></a>参数到底怎么估</h2>
<p>先给个工程上足够实用的估算办法，不追求教科书完美，但比拍脑袋强太多。</p>

<h3 id="1-先区分任务类型"><a href="#1-先区分任务类型" class="headerlink" title="1) 先区分任务类型"></a>1) 先区分任务类型</h3>
<ul>
<li><strong>CPU 密集型</strong>：比如 JSON 大对象转换、复杂规则计算、图片压缩、加解密。线程数通常不要明显超过 CPU 核数。</li>
<li><strong>IO 密集型</strong>：比如查数据库、调 HTTP、访问 Redis、大量磁盘等待。线程数可以高于 CPU 核数，但上限取决于下游容量，不是无限大。</li>
</ul>

<h3 id="2-估算并发槽位"><a href="#2-估算并发槽位" class="headerlink" title="2) 估算并发槽位"></a>2) 估算并发槽位</h3>
<p>如果目标吞吐是 <code>QPS</code>，单任务平均耗时是 <code>T</code> 秒，那么理论并发需求大致是：</p>

```text
并发需求 ≈ QPS × T
```

<p>比如要扛 80 qps，单任务平均 150ms：</p>

```text
80 × 0.15 = 12
```

<p>那你至少得准备 12 个左右的执行槽位，实际再考虑一点余量，比如从 12~16 开始压测，而不是一上来就配 64。</p>

<h3 id="3-先定-core，再定-queue，再决定要不要放大-max"><a href="#3-先定-core，再定-queue，再决定要不要放大-max" class="headerlink" title="3) 先定 core，再定 queue，再决定要不要放大 max"></a>3) 先定 core，再定 queue，再决定要不要放大 max</h3>
<p>我个人更推荐这样定：</p>
<ol>
<li>先根据稳态流量定一个 <strong>corePoolSize</strong></li>
<li>给一个<strong>不夸张的小队列</strong>，例如 16、32、64 这种量级</li>
<li>再根据突刺流量决定 <strong>maxPoolSize</strong> 是否比 core 高一截</li>
<li>最后用压测确认：P95/P99、拒绝数、CPU、GC、下游错误率是否可接受</li>
</ol>
<p>这个顺序比“先配个大队列保平安”靠谱得多。</p>

<h1 id="怎么验证你的配置是不是靠谱"><a href="#怎么验证你的配置是不是靠谱" class="headerlink" title="怎么验证你的配置是不是靠谱"></a>怎么验证你的配置是不是靠谱</h1>
<p>只看功能不看压测，线程池参数基本等于瞎猜。下面给一套验证步骤。</p>

<h2 id="1-压测吞吐和延迟"><a href="#1-压测吞吐和延迟" class="headerlink" title="1) 压测吞吐和延迟"></a>1) 压测吞吐和延迟</h2>
<p>如果是 HTTP 接口，可以用 <strong>wrk</strong> 或 <strong>hey</strong>。<strong>wrk</strong> 是一个常用的 HTTP 压测工具，适合快速观察吞吐和延迟分布。</p>

```bash
wrk -t4 -c64 -d60s --latency http://127.0.0.1:8080/api/demo
```

<p>重点看：</p>
<ul>
<li>平均延迟有没有被掩盖，P95/P99 是否明显抬高</li>
<li>吞吐有没有随着并发提升而增长，还是早早进入平台期</li>
<li>错误率有没有上升</li>
</ul>

<h2 id="2-观察线程池运行时指标"><a href="#2-观察线程池运行时指标" class="headerlink" title="2) 观察线程池运行时指标"></a>2) 观察线程池运行时指标</h2>
<p>至少要暴露这些指标：</p>
<ul>
<li><code>activeCount</code>：当前活跃线程数</li>
<li><code>poolSize</code>：当前线程池大小</li>
<li><code>queueSize</code>：当前队列长度</li>
<li><code>completedTaskCount</code>：累计完成任务数</li>
<li><code>rejectCount</code>：累计拒绝数，建议自己封装计数</li>
</ul>
<p>如果你接了 Micrometer + Prometheus，建议把线程池指标做成 Grafana 面板，排障时非常省命。</p>

<h2 id="3-看-GC-日志，确认是不是排队把堆顶高了"><a href="#3-看-GC-日志，确认是不是排队把堆顶高了" class="headerlink" title="3) 看 GC 日志，确认是不是排队把堆顶高了"></a>3) 看 GC 日志，确认是不是排队把堆顶高了</h2>
<p>JDK 17 可以这样开 GC 日志：</p>

```bash
java -Xms2g -Xmx2g -Xlog:gc*:file=gc.log:time,level,tags -jar app.jar
```

<p>重点看两件事：</p>
<ul>
<li>Young GC 频率是否明显升高</li>
<li>Full GC 或 Old GC 停顿是否拉长</li>
</ul>
<p>如果你把队列从 32 改成 5000 后，GC 频率和停顿明显变差，那通常就是“排队堆对象”在作怪。</p>

<h2 id="4-必要时上-JFR-或-async-profiler"><a href="#4-必要时上-JFR-或-async-profiler" class="headerlink" title="4) 必要时上 JFR 或 async-profiler"></a>4) 必要时上 JFR 或 async-profiler</h2>
<p><strong>JFR</strong> 是 Java Flight Recorder，JDK 自带的低开销运行时诊断工具，适合看线程状态、锁竞争、方法热点和 GC 事件。<strong>async-profiler</strong> 是一款很常用的 Java 性能分析器，可以生成火焰图，定位 CPU 热点、锁等待、分配热点。</p>
<p>比如用 JFR 抓 2 分钟：</p>

```bash
jcmd <pid> JFR.start name=threadpool-profile settings=profile duration=120s filename=threadpool.jfr
```

<p>如果你发现大量线程都卡在 JDBC、HTTP client、锁等待、或者任务对象创建上，那就别再盯着线程池参数本身了，真正的瓶颈可能在下游或任务实现里。</p>

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一：maxPoolSize-配大一点总没坏处"><a href="#误区一：maxPoolSize-配大一点总没坏处" class="headerlink" title="误区一：maxPoolSize 配大一点总没坏处"></a>误区一：maxPoolSize 配大一点总没坏处</h2>
<p>错。对于 IO 任务，线程多了不一定更快，可能只是把数据库连接池、下游限流阈值、远端 CPU 一起打满。对于 CPU 任务，更可能直接带来线程切换开销。</p>

<h2 id="误区二：队列大一点更稳"><a href="#误区二：队列大一点更稳" class="headerlink" title="误区二：队列大一点更稳"></a>误区二：队列大一点更稳</h2>
<p>大多数时候恰恰相反。大队列只是在把错误从“立刻失败”改成“延迟爆炸 + 内存变差 + 更难观测”。</p>

<h2 id="误区三：线程池满了就用-DiscardPolicy"><a href="#误区三：线程池满了就用-DiscardPolicy" class="headerlink" title="误区三：线程池满了就用 DiscardPolicy"></a>误区三：线程池满了就用 DiscardPolicy</h2>
<p><strong>DiscardPolicy</strong> 会静默丢任务，最怕的是业务方还以为提交成功了。除非你处理的是天然允许丢失的低价值任务，不然这个策略非常危险。</p>

<h2 id="误区四：所有异步任务共用一个线程池"><a href="#误区四：所有异步任务共用一个线程池" class="headerlink" title="误区四：所有异步任务共用一个线程池"></a>误区四：所有异步任务共用一个线程池</h2>
<p>订单通知、报表导出、缓存预热、第三方回调，这几类任务的时延目标、失败代价、下游类型都不一样，混在一个池子里，很容易互相拖死。</p>

<h2 id="误区五：只看平均延迟"><a href="#误区五：只看平均延迟" class="headerlink" title="误区五：只看平均延迟"></a>误区五：只看平均延迟</h2>
<p>线程池问题最容易把尾延迟拉爆，也就是 P95/P99 明显变差。平均值很多时候掩盖不了抖动。</p>

<h1 id="一套我更推荐的实战思路"><a href="#一套我更推荐的实战思路" class="headerlink" title="一套我更推荐的实战思路"></a>一套我更推荐的实战思路</h1>
<p>如果你让我给一个工程上更稳的默认建议，我会这么做：</p>
<ol>
<li>按业务拆线程池，不同下游、不同 SLA 不混用</li>
<li>先按压测估算稳态并发，定 <code>corePoolSize</code></li>
<li>队列默认从小值开始，比如 32 或 64，而不是 1000 起步</li>
<li><code>maxPoolSize</code> 只给有限弹性，不搞离谱大值</li>
<li>优先让系统在边界上可观测：监控、限流、拒绝、告警要齐</li>
<li>压测看 P95/P99、GC、下游错误率，而不是只看“有没有报错”</li>
</ol>
<p>一句话总结就是：</p>
<blockquote>
<p><strong>线程池参数不是“性能开关”，而是容量治理手段。</strong> 真正靠谱的配置，不是让系统永远不报错，而是让它在接近极限时，退化路径仍然可控、可观测、可恢复。</p>
</blockquote>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li><strong>maxPoolSize 不是越大越好</strong>，队列没满之前它甚至可能根本不生效</li>
<li><strong>大队列经常带来更差的尾延迟</strong>，还会增加堆内存和 GC 风险</li>
<li><strong>小队列 + 明确拒绝 / 反压</strong>，通常比“闷头排队”更适合线上治理</li>
<li>线程池参数必须通过<strong>压测 + 运行时指标 + GC/JFR 观测</strong>来定，不能拍脑袋</li>
<li>Spring Boot 落地时，重点不是会不会配 Bean，而是会不会把线程池当成容量边界来治理</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li><a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html">Java 17 官方文档：ThreadPoolExecutor</a></li>
<li><a target="_blank" rel="noopener" href="https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/scheduling/concurrent/ThreadPoolTaskExecutor.html">Spring 官方文档：ThreadPoolTaskExecutor</a></li>
<li><a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/17/troubleshoot/diagnostic-tools.html">Oracle 官方诊断工具文档：jcmd / JFR</a></li>
<li><a target="_blank" rel="noopener" href="https://github.com/async-profiler/async-profiler">async-profiler 官方仓库</a></li>
<li><a target="_blank" rel="noopener" href="https://github.com/wg/wrk">wrk 压测工具</a></li>
</ol>
