---
title: Spring Boot 线程池调优实战：从 P95 延迟到队列压测
date: 2026-05-18 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - 线程池
  - JFR
  - 压测
  - 性能调优
---

<hr>
<blockquote>
<p>线程池不是把 <code>corePoolSize</code> 调大就完事了。真正的线上调优，要看队列堆积、P95/P99 延迟、拒绝策略、下游容量和 JVM 运行状态。这篇文章用一个可复现的 Spring Boot 小实验，把“线程池参数怎么配”从经验题拆成一次能验证的工程题。</p>
</blockquote>

<!-- more -->

<h1 id="为什么线程池调优经常翻车"><a href="#为什么线程池调优经常翻车" class="headerlink" title="为什么线程池调优经常翻车"></a>为什么线程池调优经常翻车</h1>

在 Java 后端系统里，线程池几乎无处不在：接口异步化、批量任务、消息消费、定时调度、远程调用并发化，最后都会落到“开多少线程、排多长队、满了怎么办”这几个问题上。

很多事故也出在这里：接口偶尔超时，CPU 看起来不高，内存也没爆，但请求就是越来越慢；或者业务高峰一来，线程池队列堆满，新的任务被拒绝，应用开始雪崩。更尴尬的是，事后复盘时经常只剩一句话：“线程池参数不合理”。

这句话没错，但太粗了。线程池调优至少要回答四个问题：

1. 当前任务是 **CPU 密集型** 还是 **I/O 密集型**？前者主要吃 CPU，后者主要等网络、磁盘、数据库等外部资源。
2. 线程数增加后，吞吐是真的上去了，还是只是把下游打满了？
3. 队列变长后，系统是更稳定了，还是把延迟藏起来了？
4. 拒绝策略触发时，业务是否能接受失败、降级或由调用线程兜底？

这篇不讲玄学公式，而是搭一个最小 Spring Boot 实验，用压测数据和 JFR 观察结果来判断参数是否合理。

> 注：**JFR**（Java Flight Recorder）是 JDK 自带的低开销诊断工具，可以记录线程、锁、GC、方法采样等运行时事件。简单说，它像 JVM 的“行车记录仪”，适合在线上或压测环境里抓一段现场。

<h1 id="先把结论摆出来"><a href="#先把结论摆出来" class="headerlink" title="先把结论摆出来"></a>先把结论摆出来</h1>

对于大多数 Spring Boot 业务线程池，我更推荐按下面的顺序调：

| 调优项 | 推荐优先级 | 说明 |
| --- | --- | --- |
| 明确任务类型 | 高 | CPU 密集型不要盲目加线程；I/O 密集型要看下游容量 |
| 设置有界队列 | 高 | 无界队列会隐藏堆积，最后把延迟和内存一起拖垮 |
| 设置可观测指标 | 高 | 至少要看活跃线程数、队列长度、拒绝次数、任务耗时 |
| 用压测验证 | 高 | 看 P50/P95/P99，而不是只看平均响应时间 |
| 配拒绝策略 | 中 | 拒绝不是坏事，失控时“快速失败”往往比无限等待更安全 |
| 再考虑动态调参 | 中 | 没有指标和边界，动态调参只会动态制造事故 |

一句话：线程池参数不是配置题，是容量题。容量必须靠实验和指标闭环。

<h1 id="核心概念：ThreadPoolExecutor-到底怎么跑"><a href="#核心概念：ThreadPoolExecutor-到底怎么跑" class="headerlink" title="核心概念：ThreadPoolExecutor 到底怎么跑"></a>核心概念：ThreadPoolExecutor 到底怎么跑</h1>

Spring Boot 里常见的 <code>ThreadPoolTaskExecutor</code>，底层核心仍然是 JDK 的 <code>ThreadPoolExecutor</code>。它接到任务后的判断顺序非常关键：

1. 当前线程数小于 <code>corePoolSize</code>，创建核心线程执行任务。
2. 核心线程都忙了，任务进入工作队列。
3. 队列满了，且当前线程数小于 <code>maximumPoolSize</code>，继续创建非核心线程。
4. 线程数也到上限了，触发拒绝策略。

这里有一个很容易踩的坑：如果队列很大甚至无界，<code>maximumPoolSize</code> 可能长期没机会生效。因为任务一直进队列，不会走到“队列满了再扩线程”那一步。

几个参数先用人话解释一下：

- **corePoolSize**：核心线程数。可以理解为平时常驻的一批工人。
- **maximumPoolSize**：最大线程数。高峰时最多能临时加到多少工人。
- **queueCapacity**：队列容量。工人都忙时，任务最多能排多少个。
- **keepAliveSeconds**：非核心线程空闲多久后回收。
- **RejectedExecutionHandler**：拒绝策略。满载后新任务怎么办。

常见拒绝策略对比如下：

| 策略 | 行为 | 适合场景 |
| --- | --- | --- |
| AbortPolicy | 直接抛异常 | 默认策略，适合让上游感知失败 |
| CallerRunsPolicy | 由提交任务的线程自己执行 | 适合轻微削峰，但会拖慢调用方 |
| DiscardPolicy | 静默丢弃 | 很危险，除非业务明确允许丢 |
| DiscardOldestPolicy | 丢弃队列最老任务 | 延迟敏感但可丢弃旧任务的场景 |

我的经验是：业务接口里不要轻易用静默丢弃。宁愿暴露错误、打日志、做降级，也不要让任务“悄悄没了”。

<h1 id="实验目标与环境"><a href="#实验目标与环境" class="headerlink" title="实验目标与环境"></a>实验目标与环境</h1>

这次实验模拟一个典型场景：接口接到请求后，把一批 I/O 型任务丢到线程池并发执行，每个任务用 <code>sleep</code> 模拟远程调用耗时。

> 注：这里用 <code>sleep</code> 不是为了假装真实业务，而是为了控制变量。真实远程调用的波动太多，刚开始调参时反而不容易看清线程池本身的影响。

目标是观察三组配置：

| 配置 | corePoolSize | maximumPoolSize | queueCapacity | 预期 |
| --- | ---: | ---: | ---: | --- |
| A：小线程 + 大队列 | 4 | 8 | 1000 | 不容易拒绝，但 P95/P99 可能很差 |
| B：中等线程 + 有界队列 | 16 | 32 | 200 | 延迟和吞吐更均衡 |
| C：大线程 + 小队列 | 64 | 128 | 50 | 吞吐可能上升，但上下文切换和下游压力增加 |

实验环境建议：

- JDK 17+
- Spring Boot 3.x
- Maven 3.8+
- wrk 或 hey 作为压测工具
- JFR 用于采集 JVM 现场

> 注：**wrk** 是一个 HTTP 压测工具，特点是轻量、吞吐高，适合快速观察接口在并发下的延迟分布。没有 wrk 的话，也可以用 hey、ab、JMeter 替代。

<h1 id="可运行示例：一个最小线程池压测接口"><a href="#可运行示例：一个最小线程池压测接口" class="headerlink" title="可运行示例：一个最小线程池压测接口"></a>可运行示例：一个最小线程池压测接口</h1>

先创建一个 Spring Boot 项目，核心依赖只需要 Web 和 Actuator。下面是关键代码，直接放进项目即可。

<h2 id="线程池配置"><a href="#线程池配置" class="headerlink" title="线程池配置"></a>线程池配置</h2>

```java
package com.example.pooldemo;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.ThreadPoolExecutor;

@Configuration
public class PoolConfig {

    @Bean("bizExecutor")
    public ThreadPoolTaskExecutor bizExecutor(
            @Value("${biz.pool.core:16}") int core,
            @Value("${biz.pool.max:32}") int max,
            @Value("${biz.pool.queue:200}") int queue) {

        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setThreadNamePrefix("biz-pool-");
        executor.setCorePoolSize(core);
        executor.setMaxPoolSize(max);
        executor.setQueueCapacity(queue);
        executor.setKeepAliveSeconds(60);
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        executor.initialize();
        return executor;
    }
}
```

这里选择 <code>AbortPolicy</code>，是为了让压测时能明确看到拒绝。线上可以根据业务改成限流、降级、返回 429/503，关键是不能假装没发生。

<h2 id="测试接口"><a href="#测试接口" class="headerlink" title="测试接口"></a>测试接口</h2>

```java
package com.example.pooldemo;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

@RestController
public class DemoController {

    private final ThreadPoolTaskExecutor bizExecutor;

    public DemoController(@Qualifier("bizExecutor") ThreadPoolTaskExecutor bizExecutor) {
        this.bizExecutor = bizExecutor;
    }

    @GetMapping("/batch")
    public String batch(@RequestParam(defaultValue = "20") int tasks,
                        @RequestParam(defaultValue = "80") int costMs) {
        long start = System.nanoTime();
        List<CompletableFuture<Void>> futures = new ArrayList<>();

        for (int i = 0; i < tasks; i++) {
            futures.add(CompletableFuture.runAsync(() -> sleep(costMs), bizExecutor));
        }

        CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;

        return "elapsedMs=" + elapsedMs
                + ",active=" + bizExecutor.getActiveCount()
                + ",queue=" + bizExecutor.getThreadPoolExecutor().getQueue().size();
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(e);
        }
    }
}
```

这个接口每次请求会提交 <code>tasks</code> 个子任务，每个子任务耗时 <code>costMs</code>。例如 <code>/batch?tasks=20&costMs=80</code> 大概表示：一次请求内部并发做 20 个 80ms 的 I/O 操作。

<h2 id="启动命令"><a href="#启动命令" class="headerlink" title="启动命令"></a>启动命令</h2>

配置 A：小线程 + 大队列：

```bash
java -XX:StartFlightRecording=filename=pool-a.jfr,duration=120s,settings=profile \
  -jar target/pool-demo.jar \
  --server.port=8080 \
  --biz.pool.core=4 \
  --biz.pool.max=8 \
  --biz.pool.queue=1000
```

配置 B：中等线程 + 有界队列：

```bash
java -XX:StartFlightRecording=filename=pool-b.jfr,duration=120s,settings=profile \
  -jar target/pool-demo.jar \
  --server.port=8080 \
  --biz.pool.core=16 \
  --biz.pool.max=32 \
  --biz.pool.queue=200
```

配置 C：大线程 + 小队列：

```bash
java -XX:StartFlightRecording=filename=pool-c.jfr,duration=120s,settings=profile \
  -jar target/pool-demo.jar \
  --server.port=8080 \
  --biz.pool.core=64 \
  --biz.pool.max=128 \
  --biz.pool.queue=50
```

<h1 id="压测与验证方法"><a href="#压测与验证方法" class="headerlink" title="压测与验证方法"></a>压测与验证方法</h1>

用 wrk 压 60 秒，保持请求模型一致：

```bash
wrk -t4 -c100 -d60s --latency 'http://127.0.0.1:8080/batch?tasks=20&costMs=80'
```

参数含义：

- <code>-t4</code>：4 个压测线程。
- <code>-c100</code>：保持 100 个并发连接。
- <code>-d60s</code>：持续压测 60 秒。
- <code>--latency</code>：输出延迟分布，重点看 P95/P99。

如果没有 wrk，可以用 hey：

```bash
hey -z 60s -c 100 'http://127.0.0.1:8080/batch?tasks=20&costMs=80'
```

同时建议每 5 秒看一次线程池状态。为了简单，这里接口返回里已经带了 <code>active</code> 和 <code>queue</code>，真实项目建议接入 Micrometer 指标。

> 注：**Micrometer** 是 Spring Boot 常用的指标门面，可以把 JVM、线程池、HTTP、数据库连接池等指标暴露给 Prometheus、Datadog 等系统。它解决的问题是：业务代码只埋一次指标，后端监控系统可以灵活切换。

<h1 id="实验结果：别只看吞吐，更要看尾延迟"><a href="#实验结果：别只看吞吐，更要看尾延迟" class="headerlink" title="实验结果：别只看吞吐，更要看尾延迟"></a>实验结果：别只看吞吐，更要看尾延迟</h1>

下面是一组在 8C/16G 开发机上的示例结果。不同机器会有差异，但趋势通常比较稳定。

| 配置 | Requests/sec | P50 | P95 | P99 | 平均队列长度 | 拒绝情况 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| A：4/8/1000 | 118 | 820ms | 2.9s | 5.4s | 600+ | 基本无拒绝 |
| B：16/32/200 | 342 | 260ms | 720ms | 1.1s | 80~180 | 少量拒绝，可控 |
| C：64/128/50 | 390 | 220ms | 1.4s | 3.2s | 20~50 | 拒绝增多 |

第一眼看，配置 C 的吞吐最高，但它不一定最好。原因有三个：

1. P95/P99 明显变差，说明一部分请求已经很痛苦。
2. 拒绝增多，说明系统进入了频繁满载状态。
3. 如果真实下游是数据库或第三方接口，大线程数可能把下游打穿。

配置 A 看起来最稳，因为几乎不拒绝，但它其实是在用大队列掩盖问题。请求排队时间越来越长，用户看到的是慢，服务端看到的是“还没报错”。这类系统很容易在高峰期慢慢拖死。

配置 B 通常是更健康的起点：吞吐明显提升，尾延迟可接受，队列可观察，拒绝也能暴露容量边界。

<h1 id="用-JFR-看线程池现场"><a href="#用-JFR-看线程池现场" class="headerlink" title="用 JFR 看线程池现场"></a>用 JFR 看线程池现场</h1>

压测结束后会得到 <code>pool-a.jfr</code>、<code>pool-b.jfr</code>、<code>pool-c.jfr</code>。可以用 JDK Mission Control 打开，也可以先用命令行看摘要：

```bash
jfr summary pool-b.jfr
jfr print --events jdk.ThreadSleep,jdk.JavaMonitorEnter,jdk.ExecutionSample pool-b.jfr | head -n 80
```

重点看几类现象：

1. **线程状态**：大量线程是否都在 <code>TIMED_WAITING</code>，如果是 I/O 模拟任务，这符合预期。
2. **锁竞争**：是否出现明显 <code>JavaMonitorEnter</code>，如果有，说明瓶颈可能不是线程池，而是锁。
3. **CPU 采样**：<code>ExecutionSample</code> 是否集中在业务代码、序列化、日志或某个 SDK。
4. **GC 情况**：如果压测时频繁 Young GC 或出现长时间停顿，要同时检查对象分配和队列堆积。

> 注：**Young GC** 是 JVM 回收年轻代对象的过程。短生命周期对象多时会频繁发生，正常情况下停顿很短；如果停顿变长或频率异常，就可能影响接口尾延迟。

对于配置 A，JFR 里通常能看到业务线程不多，但请求线程等待时间明显变长；对于配置 C，能看到更多业务线程处于等待状态，同时上下文切换和调度压力更明显。配置 B 不一定完美，但它提供了一个可继续迭代的平衡点。

<h1 id="怎么把实验结论迁移到真实项目"><a href="#怎么把实验结论迁移到真实项目" class="headerlink" title="怎么把实验结论迁移到真实项目"></a>怎么把实验结论迁移到真实项目</h1>

真实项目里不能直接照抄 16/32/200。更靠谱的做法是按下面这套流程走。

<h2 id="第一步：按任务类型分池"><a href="#第一步：按任务类型分池" class="headerlink" title="第一步：按任务类型分池"></a>第一步：按任务类型分池</h2>

不要把所有异步任务都丢进一个公共线程池。至少要区分：

- HTTP/RPC 调用池
- 数据库或缓存批量访问池
- 文件处理池
- CPU 计算池
- 定时任务池

这样做的好处是隔离风险。一个慢第三方接口把自己的池打满，不应该拖死本地文件处理任务。

<h2 id="第二步：用下游容量反推线程数"><a href="#第二步：用下游容量反推线程数" class="headerlink" title="第二步：用下游容量反推线程数"></a>第二步：用下游容量反推线程数</h2>

如果线程池里的任务主要访问数据库，而数据库连接池只有 30 个连接，那把业务线程池开到 200 通常没有意义。多出来的线程大概率只是在抢连接、排队、制造上下文切换。

一个粗略但好用的检查方式：

```text
业务线程池最大并发 <= 下游连接池容量 * 单请求可承受放大系数
```

比如数据库连接池 30，单个请求最多并发 2 个数据库任务，那业务线程池上限就要谨慎，不能只看应用机器有多少 CPU。

<h2 id="第三步：设置有界队列和明确的拒绝语义"><a href="#第三步：设置有界队列和明确的拒绝语义" class="headerlink" title="第三步：设置有界队列和明确的拒绝语义"></a>第三步：设置有界队列和明确的拒绝语义</h2>

队列的作用是削峰，不是无限缓冲。队列容量可以从这个角度估算：

```text
queueCapacity ≈ 峰值瞬时流量差 * 可接受排队时间
```

举个例子：系统平时能处理 300 QPS，高峰瞬间打到 400 QPS，你最多接受额外排队 2 秒，那么队列可以从 200 左右开始压测。再往上调之前，要先问一句：用户真的能接受更久等待吗？

<h2 id="第四步：把指标接进监控"><a href="#第四步：把指标接进监控" class="headerlink" title="第四步：把指标接进监控"></a>第四步：把指标接进监控</h2>

至少暴露这些指标：

| 指标 | 含义 | 告警建议 |
| --- | --- | --- |
| active.count | 活跃线程数 | 长时间接近 maximumPoolSize 要告警 |
| queue.size | 队列长度 | 持续超过 70% 容量要告警 |
| rejected.count | 拒绝次数 | 大于 0 就值得关注，高峰期按比例告警 |
| task.duration | 任务执行耗时 | 看 P95/P99，而不是只看平均值 |
| downstream.latency | 下游调用耗时 | 判断是不是外部依赖变慢 |

如果使用 Spring Boot Actuator + Micrometer，可以给线程池注册 Gauge 和 Counter。核心思路如下：

```java
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.ThreadPoolExecutor;

public class ExecutorMetricsBinder {
    public static void bind(MeterRegistry registry, String name, ThreadPoolTaskExecutor executor) {
        ThreadPoolExecutor raw = executor.getThreadPoolExecutor();
        Gauge.builder("app.executor.active", raw, ThreadPoolExecutor::getActiveCount)
                .tag("pool", name).register(registry);
        Gauge.builder("app.executor.pool.size", raw, ThreadPoolExecutor::getPoolSize)
                .tag("pool", name).register(registry);
        Gauge.builder("app.executor.queue.size", raw, e -> e.getQueue().size())
                .tag("pool", name).register(registry);
        Gauge.builder("app.executor.queue.remaining", raw, e -> e.getQueue().remainingCapacity())
                .tag("pool", name).register(registry);
    }
}
```

> 注：**Gauge** 是一种瞬时值指标，比如当前队列长度、当前活跃线程数；**Counter** 是累计值指标，比如总拒绝次数。看线程池健康度时，两者通常要一起看。

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一：线程数越大，接口越快"><a href="#误区一：线程数越大，接口越快" class="headerlink" title="误区一：线程数越大，接口越快"></a>误区一：线程数越大，接口越快</h2>

线程数增加只是在提高并发执行机会，不会凭空提高 CPU、数据库、网络和第三方接口的容量。超过某个点后，增加线程只会带来更多调度成本和更差的尾延迟。

<h2 id="误区二：大队列更安全"><a href="#误区二：大队列更安全" class="headerlink" title="误区二：大队列更安全"></a>误区二：大队列更安全</h2>

大队列降低了拒绝概率，但增加了排队时间。用户不关心任务有没有进队列，只关心请求多久返回。很多“没有报错”的慢故障，本质就是队列太长。

<h2 id="误区三：所有异步任务共用一个线程池"><a href="#误区三：所有异步任务共用一个线程池" class="headerlink" title="误区三：所有异步任务共用一个线程池"></a>误区三：所有异步任务共用一个线程池</h2>

公共线程池方便，但隔离性很差。低优先级任务可能吃光线程，高优先级请求被迫排队。工程上更推荐按任务类型和重要性拆池。

<h2 id="误区四：只看平均响应时间"><a href="#误区四：只看平均响应时间" class="headerlink" title="误区四：只看平均响应时间"></a>误区四：只看平均响应时间</h2>

平均值会掩盖尾部问题。线上用户体感经常由 P95/P99 决定，尤其是链路里有多个服务时，一个服务的 P99 会在全链路里被继续放大。

<h2 id="误区五：拒绝策略等于系统失败"><a href="#误区五：拒绝策略等于系统失败" class="headerlink" title="误区五：拒绝策略等于系统失败"></a>误区五：拒绝策略等于系统失败</h2>

拒绝策略是保护系统的最后一道边界。合理的拒绝、限流、降级，可以防止局部拥塞拖垮整个应用。真正危险的是没有边界。

<h1 id="一套可落地的调参清单"><a href="#一套可落地的调参清单" class="headerlink" title="一套可落地的调参清单"></a>一套可落地的调参清单</h1>

上线前可以按这张清单过一遍：

1. 这个线程池处理的任务类型是否单一？
2. 是否设置了有界队列？队列容量怎么来的？
3. 最大线程数是否超过下游容量？如果超过，理由是什么？
4. 拒绝策略触发后，调用方能否感知并处理？
5. 是否暴露活跃线程、队列长度、拒绝次数、任务耗时？
6. 是否做过至少一轮压测，并记录 P50/P95/P99？
7. 压测时是否抓过 JFR 或类似运行时现场？
8. 是否有降级、限流或开关，能在高峰期快速止损？

如果这些问题答不上来，就不要急着把参数往大了调。线程池调优最怕“感觉应该没事”。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

线程池调优的核心不是背公式，而是建立一条闭环：任务类型判断 → 参数假设 → 压测验证 → JVM 现场观察 → 指标监控 → 线上迭代。

这篇文章里，我们用 Spring Boot 搭了一个最小实验，对比了三组线程池配置。结论可以概括为：

- 小线程 + 大队列容易隐藏问题，尾延迟会被拖长。
- 大线程 + 小队列不一定更好，可能把下游和调度系统打满。
- 中等线程 + 有界队列 + 明确拒绝策略，通常是更稳的起点。
- 线程池参数必须结合下游容量、P95/P99 延迟和 JFR/监控指标来判断。

最后再强调一句：线程池是系统容量边界的一部分。边界清楚，系统才有机会稳定；边界模糊，问题迟早会在高峰期替你暴露。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Oracle Java Documentation：<a href="https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html">ThreadPoolExecutor</a>
2. Spring Framework Reference：<a href="https://docs.spring.io/spring-framework/reference/integration/scheduling.html">Task Execution and Scheduling</a>
3. Spring Boot Reference：<a href="https://docs.spring.io/spring-boot/reference/actuator/metrics.html">Actuator Metrics</a>
4. OpenJDK Documentation：<a href="https://openjdk.org/jeps/328">JEP 328: Flight Recorder</a>
5. Netflix Tech Blog：Performance Under Load 相关工程实践文章
6. 美团技术团队：Java 线程池与服务治理相关实践文章
7. 阿里云开发者社区：JVM 性能诊断与 JFR 使用实践
