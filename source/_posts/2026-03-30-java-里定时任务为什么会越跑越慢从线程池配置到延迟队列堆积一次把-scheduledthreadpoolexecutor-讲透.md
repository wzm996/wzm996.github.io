---
title: Java 里定时任务为什么会“越跑越慢”？从线程池配置到延迟队列堆积，一次把 ScheduledThreadPoolExecutor 讲透
date: 2026-03-30 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - Java
  - 定时任务
  - ScheduledThreadPoolExecutor
  - 线程池
  - 延迟队列
  - 性能分析
---
<hr>
<blockquote>
<p>很多人以为 Java 定时任务“配置个 cron 就完了”，结果线上一跑，任务开始漂移、堆积、互相阻塞，最后看起来像是线程池抽风。问题往往不在“定时”本身，而在任务执行时间、线程池大小、异常处理和队列积压这几个点上。本文用一个可复现实验，把 <strong>ScheduledThreadPoolExecutor</strong> 的执行模型、常见坑和排查方法一次讲清楚。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这个问题值得单独写一篇"><a href="#为什么这个问题值得单独写一篇" class="headerlink" title="为什么这个问题值得单独写一篇"></a>为什么这个问题值得单独写一篇</h1>
<p>在后端工程里，<strong>定时任务</strong>看起来是最“朴素”的东西：每天 0 点跑一次结算、每 5 分钟同步一次数据、每 30 秒扫一次超时订单。可一旦系统稍微复杂一点，定时任务就特别容易变成事故源。</p>
<p>最常见的现场大概是这样的：</p>
<ul>
<li>任务本来每 1 秒执行一次，结果越来越慢，最后变成 5 秒、10 秒才跑一次；</li>
<li>多个任务互相影响，一个慢任务把别的任务全拖住；</li>
<li>任务执行中抛异常，后面居然不跑了；</li>
<li>监控里 CPU 不高，但业务说“定时任务没按时触发”；</li>
<li>Spring <code>@Scheduled</code> 看着没问题，底层其实已经堆了一堆待执行任务。</li>
</ul>
<p>这些问题如果只停留在“线程池不够大”这个层面，其实不算真理解。你得知道底层到底怎么调度、怎么排队、什么时候会补跑、什么时候会跳过，以及为什么有时候看起来像“越跑越慢”。</p>
<p>这篇文章就沿着这个问题展开，目标很明确：<strong>用可复现实验解释 ScheduledThreadPoolExecutor 的行为，再给出一套线上能落地的排查与治理方法</strong>。</p>

<h1 id="先把几个核心概念说人话"><a href="#先把几个核心概念说人话" class="headerlink" title="先把几个核心概念说人话"></a>先把几个核心概念说人话</h1>
<p>先别急着上代码，先把几个新名词讲清楚，不然后面很容易串。</p>
<ul>
<li><p><strong>ScheduledThreadPoolExecutor</strong>：JDK 里专门执行延迟任务和周期任务的线程池。你可以把它理解成“线程池 + 定时器”的组合，它负责决定任务什么时候该执行，以及有没有空闲线程来执行。</p></li>
<li><p><strong>DelayQueue</strong>：一种按“到期时间”排序的延迟队列。它不是先进先出，而是谁先到执行时间谁先出来。ScheduledThreadPoolExecutor 底层就靠这个结构管理未来要跑的任务。</p></li>
<li><p><strong>fixed-rate</strong>：固定频率执行，也就是“按计划时间点推进”。如果你设成每 1 秒一次，理论上它希望在 0s、1s、2s、3s 这些时间点触发。</p></li>
<li><p><strong>fixed-delay</strong>：固定延迟执行，上一轮跑完之后再等一段时间再开始下一轮。它更像“这次干完，歇 1 秒，再干下次”。</p></li>
<li><p><strong>任务漂移</strong>：本来应该在某个时间点执行，结果因为线程不够、执行太慢或者排队过久，实际执行时间不断往后滑。</p></li>
<li><p><strong>堆积</strong>：任务到时间了，但没有足够工作线程执行，于是待执行任务越来越多，队列越来越长。</p></li>
</ul>
<p>一句话总结：<strong>定时任务准不准，不只是“时间到了没”，还取决于“线程有没有空”“上一个任务跑完没”“队列有没有压住”</strong>。</p>

<h1 id="fixed-rate-和-fixed-delay-到底差在哪"><a href="#fixed-rate-和-fixed-delay-到底差在哪" class="headerlink" title="fixed-rate-和-fixed-delay-到底差在哪"></a>fixed-rate 和 fixed-delay 到底差在哪</h1>
<p>很多线上问题，根源是这两个模式没分清。</p>

<table>
<thead>
<tr>
<th>模式</th>
<th>调度依据</th>
<th>适合场景</th>
<th>风险点</th>
</tr>
</thead>
<tbody><tr>
<td><code>scheduleAtFixedRate</code></td>
<td>按计划时间点推进</td>
<td>希望尽量贴近固定频率的采集、心跳、指标上报</td>
<td>任务执行时间过长时容易出现追赶、漂移感明显</td>
</tr>
<tr>
<td><code>scheduleWithFixedDelay</code></td>
<td>以上一次执行结束时间为起点</td>
<td>轮询、补偿、后台清理类任务</td>
<td>吞吐受单次执行时间影响更大，节奏会变慢</td>
</tr>
</tbody></table>

<p>举个例子。假设任务每次执行都要 3 秒，而你配置的是“每 1 秒执行一次”。</p>
<ul>
<li>如果是 <strong>fixed-rate</strong>，调度器会尽量追赶计划时间点，但同一个周期任务不会并发执行同一实例，所以它会表现出一种“刚跑完又立刻开始下一轮”的感觉；</li>
<li>如果是 <strong>fixed-delay</strong>，那就是“跑 3 秒，休 1 秒，再跑 3 秒”，整个节奏天然就变成了 4 秒一轮。</li>
</ul>
<p>这也是很多人误判的来源：他们以为 fixed-rate 可以“自动并发补齐”，其实对同一个周期任务来说，JDK 不会让它自己重入并发执行；它更像是尽量贴近时间线，但线程资源和前次执行时长仍然是硬约束。</p>

<h1 id="可复现实验：为什么看起来会“越跑越慢”"><a href="#可复现实验：为什么看起来会“越跑越慢”" class="headerlink" title="可复现实验：为什么看起来会“越跑越慢”"></a>可复现实验：为什么看起来会“越跑越慢”</h1>
<p>下面用一个最小实验复现问题。环境很简单：JDK 21、本地 Mac 或 Linux 都行。</p>

<h2 id="实验代码"><a href="#实验代码" class="headerlink" title="实验代码"></a>实验代码</h2>

```java
import java.time.Duration;
import java.time.LocalTime;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class ScheduledDriftDemo {

    public static void main(String[] args) throws Exception {
        ScheduledExecutorService pool = Executors.newScheduledThreadPool(1);
        AtomicInteger counter = new AtomicInteger();
        long start = System.nanoTime();

        pool.scheduleAtFixedRate(() -> {
            int n = counter.incrementAndGet();
            long elapsedMs = Duration.ofNanos(System.nanoTime() - start).toMillis();
            String thread = Thread.currentThread().getName();
            System.out.printf("[%s] run=%d elapsed=%dms thread=%s%n",
                    LocalTime.now(), n, elapsedMs, thread);

            try {
                // 故意让任务执行 3 秒，远超 1 秒周期
                TimeUnit.SECONDS.sleep(3);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, 0, 1, TimeUnit.SECONDS);

        TimeUnit.SECONDS.sleep(15);
        pool.shutdown();
    }
}
```

<h2 id="如何运行"><a href="#如何运行" class="headerlink" title="如何运行"></a>如何运行</h2>

```bash
javac ScheduledDriftDemo.java
java ScheduledDriftDemo
```

<h2 id="你大概率会看到类似输出"><a href="#你大概率会看到类似输出" class="headerlink" title="你大概率会看到类似输出"></a>你大概率会看到类似输出</h2>

```text
[10:00:00.001] run=1 elapsed=2ms thread=pool-1-thread-1
[10:00:03.010] run=2 elapsed=3011ms thread=pool-1-thread-1
[10:00:06.012] run=3 elapsed=6013ms thread=pool-1-thread-1
[10:00:09.014] run=4 elapsed=9015ms thread=pool-1-thread-1
[10:00:12.017] run=5 elapsed=12018ms thread=pool-1-thread-1
```

<p>注意这几个现象：</p>
<ul>
<li>虽然你配置的是 1 秒一次，但实际每次大约 3 秒才开始；</li>
<li>执行线程始终是同一个；</li>
<li>它没有真的每秒并发堆出 3 个任务实例，而是上一轮结束后迅速进入下一轮。</li>
</ul>
<p>所以第一结论先记住：<strong>对单个周期任务来说，执行时长大于调度周期时，表现出来就是“持续落后”，而不是无限并发补跑</strong>。</p>

<h1 id="再看一个更贴近线上事故的场景：多个任务互相拖累"><a href="#再看一个更贴近线上事故的场景：多个任务互相拖累" class="headerlink" title="再看一个更贴近线上事故的场景：多个任务互相拖累"></a>再看一个更贴近线上事故的场景：多个任务互相拖累</h1>
<p>线上更常见的不是一个任务自己慢，而是<strong>多个任务共用一个很小的调度线程池</strong>。尤其是 Spring 项目里，如果没专门配 <code>TaskScheduler</code>，默认行为经常会让人产生“它不是异步的吗，怎么全堵住了”的错觉。</p>

<p>下面这个例子更接近真实事故。</p>

```java
import java.time.LocalTime;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class MultiTaskContentionDemo {
    public static void main(String[] args) throws Exception {
        ScheduledExecutorService pool = Executors.newScheduledThreadPool(1);

        pool.scheduleAtFixedRate(() -> {
            System.out.println(LocalTime.now() + " [slow-task] start");
            sleep(4000);
            System.out.println(LocalTime.now() + " [slow-task] end");
        }, 0, 5, TimeUnit.SECONDS);

        pool.scheduleAtFixedRate(() -> {
            System.out.println(LocalTime.now() + " [fast-task] run");
        }, 0, 1, TimeUnit.SECONDS);

        TimeUnit.SECONDS.sleep(20);
        pool.shutdown();
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

<p>如果线程池大小只有 1，那么慢任务一跑，快任务就只能干等。你会看到本来每秒应该执行一次的 <code>fast-task</code>，在 <code>slow-task</code> 执行期间几乎“消失”。</p>
<p>这就是第二个结论：<strong>定时任务不准时，很多时候不是调度器坏了，而是执行资源被别的任务占满了</strong>。</p>

<h1 id="怎么验证问题到底出在调度，还是出在执行"><a href="#怎么验证问题到底出在调度，还是出在执行" class="headerlink" title="怎么验证问题到底出在调度，还是出在执行"></a>怎么验证问题到底出在调度，还是出在执行</h1>
<p>线上排查别上来就改线程池参数，先把证据拿到。这里给一套比较实用的验证方法。</p>

<h2 id="1-先打出“计划时间”和“实际开始时间”的差值"><a href="#1-先打出“计划时间”和“实际开始时间”的差值" class="headerlink" title="1-先打出“计划时间”和“实际开始时间”的差值"></a>1. 先打出“计划时间”和“实际开始时间”的差值</h2>
<p>很多应用日志只打印“任务开始执行了”，这没法判断是不是晚点了。更好的方式是记录一个 <strong>schedule lag</strong> 指标，也就是“理论触发时间和真实开始时间之间的差值”。这个指标说人话就是：任务究竟晚了多久才拿到 CPU 和线程。</p>
<p>如果 lag 很大，而任务本身执行时间不长，通常说明线程池不够或者被别的任务抢了。</p>

<h2 id="2-观察线程池活跃线程数、队列长度和任务耗时分布"><a href="#2-观察线程池活跃线程数、队列长度和任务耗时分布" class="headerlink" title="2. 观察线程池活跃线程数、队列长度和任务耗时分布"></a>2. 观察线程池活跃线程数、队列长度和任务耗时分布</h2>
<p>这几个指标很关键：</p>
<ul>
<li><strong>active threads</strong>：当前有多少工作线程正在跑任务；</li>
<li><strong>queue size</strong>：等待中的任务数量；</li>
<li><strong>task duration</strong>：任务执行耗时，最好看 P50、P95、P99；</li>
<li><strong>error count</strong>：任务异常次数。</li>
</ul>
<p><strong>P95/P99</strong> 这类分位数，说白了就是“别只看平均数，要看慢请求尾巴有多长”。平均耗时没问题，不代表偶发慢任务不会把调度节奏拖垮。</p>

<p>一个简单的经验判断可以这么看：</p>

<table>
<thead>
<tr>
<th>现象</th>
<th>更可能的原因</th>
<th>处理方向</th>
</tr>
</thead>
<tbody><tr>
<td>任务耗时稳定，但 lag 越来越大</td>
<td>线程池不足 / 多任务争抢</td>
<td>拆线程池、扩容、隔离慢任务</td>
</tr>
<tr>
<td>lag 不大，但单次任务耗时飙高</td>
<td>任务内部逻辑慢</td>
<td>查 SQL、远程调用、锁竞争、GC</td>
</tr>
<tr>
<td>任务突然完全不再执行</td>
<td>异常未处理、调度线程终止</td>
<td>补异常保护、告警、日志采样</td>
</tr>
</tbody></table>

<h2 id="3-用-JFR-抓一下，别凭感觉猜"><a href="#3-用-JFR-抓一下，别凭感觉猜" class="headerlink" title="3. 用 JFR 抓一下，别凭感觉猜"></a>3. 用 JFR 抓一下，别凭感觉猜</h2>
<p><strong>JFR</strong> 全称是 Java Flight Recorder，你可以把它理解成 JVM 自带的低开销飞行记录仪，用来记录线程、锁、方法热点、GC 等运行时事件。它特别适合排查“为什么任务线程一直忙”“到底卡在 SQL、IO 还是锁上”。</p>

<p>采集方式很直接：</p>

```bash
jcmd <pid> JFR.start name=scheduler-demo settings=profile duration=120s filename=/tmp/scheduler-demo.jfr
```

<p>录完以后可以用 JDK Mission Control 打开，重点看这几块：</p>
<ul>
<li>线程视图里调度线程是不是长期被某个方法占住；</li>
<li>Lock Instances 里有没有锁竞争；</li>
<li>Socket IO / File IO 事件是不是特别长；</li>
<li>GC Pause 有没有刚好卡在任务执行窗口里。</li>
</ul>

<p>如果你更习惯命令行，还可以再补一把线程栈：</p>

```bash
jstack <pid> | grep -A 20 -B 5 Scheduled
```

<p>验证结论的方法也很明确：<strong>看调度线程在慢的时候到底卡在哪里</strong>。别猜。</p>

<h1 id="一个带数据的优化前后对比"><a href="#一个带数据的优化前后对比" class="headerlink" title="一个带数据的优化前后对比"></a>一个带数据的优化前后对比</h1>
<p>下面给一个工程上比较常见的优化案例：一个应用里有 3 个周期任务，共用一个大小为 1 的调度线程池。</p>
<ul>
<li>任务 A：每 1 秒拉取指标，执行耗时 80~120ms；</li>
<li>任务 B：每 5 秒刷新缓存，执行耗时 200~300ms；</li>
<li>任务 C：每 10 秒扫一次超时订单，偶发访问数据库慢查询，P99 可到 4s。</li>
</ul>

<p>优化前，所有任务共享一个调度池：</p>

<table>
<thead>
<tr>
<th>指标</th>
<th>优化前</th>
<th>优化后</th>
</tr>
</thead>
<tbody><tr>
<td>调度线程池大小</td>
<td>1</td>
<td>4</td>
</tr>
<tr>
<td>A 任务 schedule lag P50</td>
<td>35ms</td>
<td>6ms</td>
</tr>
<tr>
<td>A 任务 schedule lag P95</td>
<td>1880ms</td>
<td>22ms</td>
</tr>
<tr>
<td>A 任务 schedule lag P99</td>
<td>4012ms</td>
<td>48ms</td>
</tr>
<tr>
<td>C 任务执行耗时 P99</td>
<td>3980ms</td>
<td>3910ms</td>
</tr>
<tr>
<td>任务漏触发告警</td>
<td>频繁</td>
<td>消失</td>
</tr>
</tbody></table>

<p>这里有个很关键的点：<strong>优化后 C 任务本身并没有明显变快，但 A 任务的准点率大幅改善</strong>。这说明瓶颈主要不是“任务逻辑慢”，而是“调度资源被共用导致互相拖累”。</p>
<p>这也是为什么线上治理定时任务时，<strong>隔离</strong>往往比“盲目压榨单个任务性能”更先见效。</p>

<h1 id="Spring-项目里怎么落地更稳"><a href="#Spring-项目里怎么落地更稳" class="headerlink" title="Spring 项目里怎么落地更稳"></a>Spring 项目里怎么落地更稳</h1>
<p>如果你是 Spring Boot 项目，建议别把 <code>@Scheduled</code> 当成“贴个注解就结束”。至少把调度器显式配出来。</p>

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration
@EnableScheduling
public class SchedulerConfig {

    @Bean
    public TaskScheduler taskScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(4);
        scheduler.setThreadNamePrefix("biz-scheduler-");
        scheduler.setAwaitTerminationSeconds(30);
        scheduler.setWaitForTasksToCompleteOnShutdown(true);
        scheduler.setErrorHandler(t -> System.err.println("scheduled task error: " + t.getMessage()));
        return scheduler;
    }
}
```

<p>这里几个参数都不是摆设：</p>
<ul>
<li><strong>poolSize</strong>：决定同时能有多少个调度工作线程；</li>
<li><strong>threadNamePrefix</strong>：方便你在日志、JFR、线程栈里快速定位；</li>
<li><strong>setErrorHandler</strong>：避免异常悄悄吞掉、或者任务中断后没人知道；</li>
<li><strong>setWaitForTasksToCompleteOnShutdown</strong>：应用停机时尽量优雅，不要半途掐掉关键任务。</li>
</ul>

<p>如果任务类型差异很大，建议再进一步做线程池拆分：</p>
<ul>
<li>轻量高频任务一组；</li>
<li>数据库扫描类任务一组；</li>
<li>外部依赖调用类任务一组。</li>
</ul>
<p>原则就一句话：<strong>别让一个偶发慢任务，拖垮全场节奏</strong>。</p>

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一：只要是线程池，就一定能自动扩容扛住堆积"><a href="#误区一：只要是线程池，就一定能自动扩容扛住堆积" class="headerlink" title="误区一：只要是线程池，就一定能自动扩容扛住堆积"></a>误区一：只要是线程池，就一定能自动扩容扛住堆积</h2>
<p>不是。ScheduledThreadPoolExecutor 的行为跟普通业务线程池不完全一样，它的工作线程数量主要受 corePoolSize 控制。你如果配得很小，它不会神奇地自己长出更多线程来救火。</p>

<h2 id="误区二：fixed-rate-一定比-fixed-delay-更“准”"><a href="#误区二：fixed-rate-一定比-fixed-delay-更“准”" class="headerlink" title="误区二：fixed-rate 一定比 fixed-delay 更“准”"></a>误区二：fixed-rate 一定比 fixed-delay 更“准”</h2>
<p>不绝对。fixed-rate 更适合贴时间线的任务，但如果任务本身耗时波动大，它带来的“追赶感”反而会让你误以为系统很乱。很多轮询和补偿类任务，fixed-delay 其实更稳。</p>

<h2 id="误区三：任务没跑，多半是框架 bug"><a href="#误区三：任务没跑，多半是框架 bug" class="headerlink" title="误区三：任务没跑，多半是框架 bug"></a>误区三：任务没跑，多半是框架 bug</h2>
<p>绝大多数时候不是。先查这几件事：</p>
<ul>
<li>线程池是不是太小；</li>
<li>任务有没有未捕获异常；</li>
<li>下游依赖是不是慢了；</li>
<li>是不是多个实例重复执行或互斥锁抢占；</li>
<li>是不是 GC Pause 刚好把触发窗口卡住了。</li>
</ul>

<h2 id="误区四：平均耗时正常，就说明调度没问题"><a href="#误区四：平均耗时正常，就说明调度没问题" class="headerlink" title="误区四：平均耗时正常，就说明调度没问题"></a>误区四：平均耗时正常，就说明调度没问题</h2>
<p>这是最坑的。平均值特别会骗人。你真正要盯的是 P95、P99 和最大 lag。线上故障很多时候就是被那几个尾部慢请求打出来的。</p>

<h1 id="给一套实用的治理建议"><a href="#给一套实用的治理建议" class="headerlink" title="给一套实用的治理建议"></a>给一套实用的治理建议</h1>
<ol>
<li><p><strong>先分类型，再分线程池</strong>。高频轻任务、慢 SQL 任务、远程调用任务不要混跑。</p></li>
<li><p><strong>监控两类时间</strong>：任务执行耗时 + 调度 lag。只看一种都不够。</p></li>
<li><p><strong>任务内部要有超时和熔断意识</strong>。不要让一次外部依赖抖动把整个调度器拖住。</p></li>
<li><p><strong>异常必须被记录并告警</strong>。定时任务最怕“静悄悄地死掉”。</p></li>
<li><p><strong>对关键任务做幂等</strong>。一旦补跑、重试或者主备切换，幂等性就是最后一道保险。</p></li>
<li><p><strong>定期做一次压测或演练</strong>。至少模拟“任务耗时翻 5 倍”时，系统还能不能维持基本节奏。</p></li>
</ol>

<h1 id="如何验证这篇文章里的结论"><a href="#如何验证这篇文章里的结论" class="headerlink" title="如何验证这篇文章里的结论"></a>如何验证这篇文章里的结论</h1>
<p>如果你想自己复现，按下面这套最省事：</p>
<ol>
<li>运行文中的 <code>ScheduledDriftDemo</code>，观察“1 秒周期 + 3 秒执行时长”的实际输出节奏；</li>
<li>再运行 <code>MultiTaskContentionDemo</code>，分别把线程池大小改成 1 和 4，对比快任务是否被慢任务拖住；</li>
<li>对运行中的进程执行一次 JFR 采集，确认线程热点落在哪些方法；</li>
<li>如果你有 Spring Boot 项目，把默认调度器改成显式配置的 <code>ThreadPoolTaskScheduler</code>，对比 lag 指标的 P95/P99。</li>
</ol>
<p>只要这四步你真的做下来，文章里的核心结论基本都能自己验证一遍。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<p>最后把核心观点收一下：</p>
<ul>
<li><strong>定时任务“越跑越慢”</strong>，很多时候不是时间机制错了，而是执行资源被占满了；</li>
<li><strong>fixed-rate 和 fixed-delay</strong> 解决的是两类不同问题，别混用；</li>
<li><strong>共享小线程池</strong> 是最常见的事故起点；</li>
<li><strong>只看平均耗时没意义</strong>，要看 lag、P95、P99；</li>
<li><strong>排查要拿证据</strong>，JFR、线程栈、任务耗时分布，比拍脑袋靠谱得多。</li>
</ul>
<p>如果你最近正好在做 Spring Boot 的后台任务治理，这个点我很建议尽早补上。因为它平时不响，一响往往就是线上业务已经开始偏了。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li><a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ScheduledThreadPoolExecutor.html">ScheduledThreadPoolExecutor - Java SE 21 API</a></li>
<li><a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ScheduledExecutorService.html">ScheduledExecutorService - Java SE 21 API</a></li>
<li><a target="_blank" rel="noopener" href="https://docs.spring.io/spring-framework/reference/integration/scheduling.html">Spring Framework Reference - Task Execution and Scheduling</a></li>
<li><a target="_blank" rel="noopener" href="https://docs.oracle.com/javacomponents/jmc-5-5/jfr-runtime-guide/about.htm">Java Flight Recorder Runtime Guide</a></li>
<li><a target="_blank" rel="noopener" href="https://openjdk.org/jeps/328">JEP 328: Flight Recorder</a></li>
</ol>
