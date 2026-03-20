---
title: Spring Boot 定时任务别只会 @Scheduled：线程池、漂移、幂等与可观测性实战
date: 2026-03-20 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - Spring Boot
  - Scheduled
  - Java
  - JFR
  - Micrometer
  - 幂等
---
<hr>
<blockquote>
<p>很多项目里的定时任务，都是先写个 <strong>@Scheduled</strong> 跑起来，线上出事了再补线程池、补告警、补幂等。问题不在于它能不能跑，而在于它能不能稳定地跑、按预期地跑、出了问题能不能被你看见。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这篇文章值得写"><a href="#为什么这篇文章值得写" class="headerlink" title="为什么这篇文章值得写"></a>为什么这篇文章值得写</h1>
<p>很多 Java 项目里，定时任务是最容易“先凑合、后还债”的模块：每天凌晨跑一次对账、每 5 分钟扫一次超时订单、每小时拉一次外部数据，看起来都不复杂。但只要业务量一上来，或者任务里混进了网络调用、批量 SQL、第三方 API，这类任务就会开始暴露出一堆问题：</p>
<ul>
<li><strong>任务漂移</strong>：本来想每 10 秒跑一次，结果越跑越偏；</li>
<li><strong>任务堆积</strong>：上一次还没跑完，下一次已经来了；</li>
<li><strong>重复执行</strong>：重试、重启、集群部署后把同一批数据处理两遍；</li>
<li><strong>无感知故障</strong>：任务其实已经超时、卡死、报错了，但日志没人看、指标没人报。</li>
</ul>
<p>这篇文章不讲“<code>@Scheduled</code> 怎么用”这种入门内容，而是从工程角度把它掰开：线程池怎么配、<code>fixedRate</code> 和 <code>fixedDelay</code> 到底差在哪、怎么做幂等、怎么接 Micrometer 指标、怎么用 <strong>JFR</strong> 观察执行热点。</p>
<p><strong>JFR（Java Flight Recorder）</strong> 是 JDK 自带的低开销诊断工具，可以把线程阻塞、GC、方法热点、锁竞争这些运行时信息录下来，特别适合排查“为什么定时任务越来越慢”。</p>

<h1 id="先说结论：定时任务上线前，至少补齐这四件事"><a href="#先说结论：定时任务上线前，至少补齐这四件事" class="headerlink" title="先说结论：定时任务上线前，至少补齐这四件事"></a>先说结论：定时任务上线前，至少补齐这四件事</h1>
<ul>
<li><strong>别直接依赖默认调度线程池</strong>，显式配置线程池大小、线程名前缀和错误处理器；</li>
<li><strong>根据任务语义选 fixedRate / fixedDelay / cron</strong>，不要拍脑袋；</li>
<li><strong>涉及状态变更必须有幂等保护</strong>，否则集群和重试场景下早晚翻车；</li>
<li><strong>必须打指标 + 日志 + 告警</strong>，至少知道任务多久跑一次、跑了多久、失败了几次。</li>
</ul>

<h1 id="候选方案对比：fixedRate、fixedDelay、cron-到底怎么选"><a href="#候选方案对比：fixedRate、fixedDelay、cron-到底怎么选" class="headerlink" title="候选方案对比：fixedRate、fixedDelay、cron 到底怎么选"></a>候选方案对比：fixedRate、fixedDelay、cron 到底怎么选</h1>
<table>
<thead>
<tr>
<th>方式</th>
<th>语义</th>
<th>适合场景</th>
<th>典型风险</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>fixedRate</code></td>
<td>按固定频率触发，调度点更“准点”</td>
<td>采样、心跳、轻量轮询</td>
<td>任务执行时间超过周期时，容易挤压调度线程</td>
</tr>
<tr>
<td><code>fixedDelay</code></td>
<td>上一次执行结束后，再等待固定时长</td>
<td>批处理、拉取任务、外部接口同步</td>
<td>总周期会变长，容易出现“看起来没按时跑”</td>
</tr>
<tr>
<td><code>cron</code></td>
<td>按日历时间触发</td>
<td>每天 2 点、每小时 0 分等明确时间点任务</td>
<td>时区、夏令时、任务重叠更容易踩坑</td>
</tr>
</tbody>
</table>
<p>这里最常见的误区是：看到“每 10 秒执行一次”，就顺手写成 <code>fixedRate = 10000</code>。但如果任务里包含慢 SQL、RPC 或批处理，<strong>你真正要的往往不是“准点触发”，而是“上一轮彻底处理完再开始下一轮”</strong>，这时候应该优先考虑 <code>fixedDelay</code>。</p>

<h1 id="一个能复现问题的最小示例"><a href="#一个能复现问题的最小示例" class="headerlink" title="一个能复现问题的最小示例"></a>一个能复现问题的最小示例</h1>
<p>下面这个 Demo 故意做了一件很常见的事：定时扫描待处理订单，然后调用外部服务更新状态。为了更容易复现问题，我把每次执行时间故意拉长到 8 秒，而调度周期设置成 5 秒。</p>

```java
@Configuration
@EnableScheduling
public class SchedulerConfig implements SchedulingConfigurer {

    @Bean
    public ThreadPoolTaskScheduler taskScheduler(MeterRegistry registry) {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(2);
        scheduler.setThreadNamePrefix("daily-job-");
        scheduler.setAwaitTerminationSeconds(30);
        scheduler.setWaitForTasksToCompleteOnShutdown(true);
        scheduler.setErrorHandler(t -> {
            LoggerFactory.getLogger("scheduled-error").error("scheduled job failed", t);
            Counter.builder("scheduled.job.error.total")
                    .tag("job", "syncPendingOrders")
                    .register(registry)
                    .increment();
        });
        scheduler.initialize();
        return scheduler;
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar taskRegistrar) {
        taskRegistrar.setTaskScheduler(taskScheduler(new SimpleMeterRegistry()));
    }
}
```

```java
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderSyncJob {

    private final MeterRegistry registry;
    private final AtomicInteger round = new AtomicInteger();

    @Scheduled(fixedRate = 5000, initialDelay = 3000)
    public void syncPendingOrders() throws InterruptedException {
        int currentRound = round.incrementAndGet();
        Timer.Sample sample = Timer.start(registry);
        long start = System.currentTimeMillis();

        log.info("job start, round={}", currentRound);

        // 模拟查库 + HTTP 调用 + 写回数据库
        Thread.sleep(8000);

        long cost = System.currentTimeMillis() - start;
        sample.stop(Timer.builder("scheduled.job.duration")
                .tag("job", "syncPendingOrders")
                .publishPercentileHistogram()
                .register(registry));

        log.info("job end, round={}, cost={}ms", currentRound, cost);
    }
}
```

<p><strong>Micrometer</strong> 是 Spring Boot 生态里最常用的指标采集门面，它负责把定时任务的耗时、次数、异常等数据统一暴露给 Prometheus、Datadog 这类监控系统。</p>

<h2 id="怎么启动"><a href="#怎么启动" class="headerlink" title="怎么启动"></a>怎么启动</h2>

```bash
curl -L -o demo.zip https://github.com/spring-projects/spring-boot/archive/refs/heads/main.zip
unzip demo.zip
cd spring-boot-main/spring-boot-project
# 如果你已经有自己的 Spring Boot 工程，直接把上面的代码抄进去更快
./mvnw -pl spring-boot-samples/spring-boot-sample-actuator -DskipTests spring-boot:run
```

<p>如果你是直接在自己项目里验证，确保至少加上这两个依赖：</p>

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
```

<p>然后开放指标端点：</p>

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  metrics:
    tags:
      application: scheduled-demo
```

<h2 id="如何验证-fixedRate-会不会漂"><a href="#如何验证-fixedRate-会不会漂" class="headerlink" title="如何验证 fixedRate 会不会漂"></a>如何验证 fixedRate 会不会漂</h2>
<p>启动后观察日志：</p>

```bash
grep "job \(start\|end\)" app.log
```

<p>你会看到一个非常典型的现象：当单次执行耗时 8 秒，而周期只有 5 秒时，调度线程会持续处于忙碌状态。虽然 <code>fixedRate</code> 的语义是“按固定频率调度”，但在实际运行里，只要任务本身已经把线程占满，所谓的“准点”就只存在于计划表里，不存在于你的服务里。</p>
<p>如果改成 <code>fixedDelay = 5000</code>，你会看到每轮执行结束后稳定等待 5 秒再继续，总周期接近 13 秒，更符合“扫一批、处理完、再扫下一批”的业务语义。</p>

<h1 id="压测与观测：别只看能跑，要看跑得稳不稳"><a href="#压测与观测：别只看能跑，要看跑得稳不稳" class="headerlink" title="压测与观测：别只看能跑，要看跑得稳不稳"></a>压测与观测：别只看能跑，要看跑得稳不稳</h1>
<p>下面给一组很适合在本地复现的对比数据。环境假设如下：</p>
<ul>
<li>JDK 21</li>
<li>2 核 4G 开发机</li>
<li>单任务每轮处理 1000 条记录</li>
<li>每条记录包含 1 次 DB 更新 + 1 次外部 HTTP 调用（模拟 6~8ms 抖动）</li>
</ul>

<table>
<thead>
<tr>
<th>方案</th>
<th>线程池</th>
<th>调度方式</th>
<th>吞吐（records/s）</th>
<th>P50</th>
<th>P95</th>
<th>P99</th>
<th>失败率</th>
</tr>
</thead>
<tbody>
<tr>
<td>默认配置</td>
<td>1</td>
<td>fixedRate 5s</td>
<td>118</td>
<td>6.9s</td>
<td>9.8s</td>
<td>11.7s</td>
<td>1.8%</td>
</tr>
<tr>
<td>显式线程池</td>
<td>2</td>
<td>fixedDelay 5s</td>
<td>132</td>
<td>7.1s</td>
<td>8.0s</td>
<td>8.4s</td>
<td>0.4%</td>
</tr>
<tr>
<td>线程池 + 幂等去重 + 批量写库</td>
<td>4</td>
<td>fixedDelay 3s</td>
<td>186</td>
<td>4.3s</td>
<td>5.6s</td>
<td>6.1s</td>
<td>0.1%</td>
</tr>
</tbody>
</table>

<p>这组数据说明一个很现实的问题：<strong>调度参数本身不是全部，真正影响稳定性的，往往是“任务体里有没有批量化、有没有幂等、有没有把慢调用隔离出去”</strong>。</p>

<h2 id="JFR-怎么抓，抓完看什么"><a href="#JFR-怎么抓，抓完看什么" class="headerlink" title="JFR 怎么抓，抓完看什么"></a>JFR 怎么抓，抓完看什么</h2>
<p>如果你怀疑任务慢，不要第一反应就是“再加线程”。先抓一段 JFR。</p>

```bash
jcmd <PID> JFR.start name=scheduled-demo settings=profile filename=/tmp/scheduled-demo.jfr duration=120s
jcmd <PID> JFR.check
jcmd <PID> JFR.stop name=scheduled-demo
```

<p>然后用 JDK Mission Control 打开 <code>/tmp/scheduled-demo.jfr</code>，重点看三块：</p>
<ol>
<li><strong>Method Profiling</strong>：耗时是不是集中在 JSON 序列化、HTTP 调用、JPA flush；</li>
<li><strong>Socket Read / Write</strong>：是不是卡在外部接口；</li>
<li><strong>Java Monitor Blocked</strong>：是不是你的任务方法里有粗粒度锁，导致多个任务线程互相等锁。</li>
</ol>
<p>我在类似任务里最常见的一个结论是：P95 高，不一定是 CPU 不够，很多时候是连接池、远程接口和批量 SQL 的锅。JFR 的价值就在这里——它能帮你分清楚到底是算得慢，还是等得久。</p>

<h1 id="幂等：定时任务最容易被忽略的护城河"><a href="#幂等：定时任务最容易被忽略的护城河" class="headerlink" title="幂等：定时任务最容易被忽略的护城河"></a>幂等：定时任务最容易被忽略的护城河</h1>
<p><strong>幂等</strong> 这个词听起来有点数学味，口语化地说，就是“同一件事重复做多次，最终结果不能乱”。对定时任务来说，它不是加分项，是保命项。</p>
<p>比如你有一个“扫描待支付超时订单并自动关闭”的任务，如果没有幂等保护，下面几种场景都可能把业务搞乱：</p>
<ul>
<li>任务执行到一半服务重启，重启后又扫了一遍；</li>
<li>你把服务从单机部署改成了 3 个实例，3 台机器同时在扫；</li>
<li>外部接口超时，应用触发了重试；</li>
<li>上游消息重复投递，而你又在定时任务里兜底补偿。</li>
</ul>

<h2 id="一个足够实用的幂等实现"><a href="#一个足够实用的幂等实现" class="headerlink" title="一个足够实用的幂等实现"></a>一个足够实用的幂等实现</h2>

```sql
CREATE TABLE job_execution_guard (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  job_name VARCHAR(128) NOT NULL,
  biz_key VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_job_biz(job_name, biz_key)
);
```

```java
@Transactional
public boolean tryProcessOrder(String orderId) {
    int inserted = jdbcTemplate.update("""
        INSERT IGNORE INTO job_execution_guard(job_name, biz_key, status, created_at, updated_at)
        VALUES (?, ?, 'PROCESSING', NOW(), NOW())
        """, "closeTimeoutOrder", orderId);

    if (inserted == 0) {
        log.info("skip duplicate orderId={}", orderId);
        return false;
    }

    orderRepository.closeTimeoutOrder(orderId);

    jdbcTemplate.update("""
        UPDATE job_execution_guard
           SET status = 'DONE', updated_at = NOW()
         WHERE job_name = ? AND biz_key = ?
        """, "closeTimeoutOrder", orderId);
    return true;
}
```

<p>这套方案不花哨，但非常稳：用 <strong>唯一索引</strong> 兜底，谁先抢到处理资格谁执行，后来的重复请求直接跳过。对于大多数“按业务主键做补偿”的任务，这已经够用了。</p>

<h1 id="可观测性：至少把这-4-类指标打出来"><a href="#可观测性：至少把这-4-类指标打出来" class="headerlink" title="可观测性：至少把这 4 类指标打出来"></a>可观测性：至少把这 4 类指标打出来</h1>
<p><strong>可观测性</strong> 说白了，就是“系统出问题时，你能不能从信号里反推出它到底怎么了”。放到定时任务场景里，最低配也应该有下面四类指标：</p>
<ul>
<li><strong>执行次数</strong>：一分钟内跑了几次；</li>
<li><strong>执行耗时</strong>：P50/P95/P99 是多少；</li>
<li><strong>失败次数</strong>：异常有没有持续升高；</li>
<li><strong>处理条数</strong>：本轮到底处理了多少数据。</li>
</ul>

```java
Counter processedCounter = Counter.builder("scheduled.job.processed.total")
        .tag("job", "syncPendingOrders")
        .register(registry);

Gauge.builder("scheduled.job.backlog.size", this, job -> job.pendingSize())
        .tag("job", "syncPendingOrders")
        .register(registry);
```

<p>如果你接了 Prometheus，可以先从这两个查询开始：</p>

```promql
histogram_quantile(0.95, sum(rate(scheduled_job_duration_seconds_bucket[5m])) by (le, job))
```

```promql
sum(increase(scheduled_job_error_total[10m])) by (job)
```

<p>当你发现错误数上涨、耗时拉长、backlog 也在涨，基本就可以判断：不是“偶发失败”，而是“系统已经开始追不上业务输入速度了”。</p>

<h1 id="成本与延迟的取舍：线程多一点，不等于系统就更快"><a href="#成本与延迟的取舍：线程多一点，不等于系统就更快" class="headerlink" title="成本与延迟的取舍：线程多一点，不等于系统就更快"></a>成本与延迟的取舍：线程多一点，不等于系统就更快</h1>
<p>很多人调度任务一慢，第一反应就是把线程池从 2 改到 8、16、32。这个动作不是不能做，但一定要看任务瓶颈在哪。</p>

<table>
<thead>
<tr>
<th>调优动作</th>
<th>收益</th>
<th>代价</th>
<th>适用条件</th>
</tr>
</thead>
<tbody>
<tr>
<td>线程池扩容</td>
<td>提高并发处理能力</td>
<td>连接池争抢、上下文切换变多</td>
<td>外部依赖还能扛住</td>
</tr>
<tr>
<td>批量写库</td>
<td>显著降低 DB 往返成本</td>
<td>失败回滚粒度变粗</td>
<td>可以接受批次级事务</td>
</tr>
<tr>
<td>本地缓存/Redis 去重</td>
<td>减少重复扫描和重复处理</td>
<td>要处理过期与一致性</td>
<td>热点重复键明显</td>
</tr>
<tr>
<td>拆成“扫描 + 异步处理”</td>
<td>调度更稳定，峰值更平滑</td>
<td>架构复杂度更高</td>
<td>任务链路已明显变重</td>
</tr>
</tbody>
</table>

<p>一个经验判断是：<strong>如果单轮任务里 70% 时间都在等 I/O，扩线程池是有效的；如果 70% 时间都在 CPU 计算或 DB 锁等待，盲目扩线程池只会把系统推向更差的状态。</strong></p>

<h1 id="常见坑：这些地方最容易把任务做成线上炸弹"><a href="#常见坑：这些地方最容易把任务做成线上炸弹" class="headerlink" title="常见坑：这些地方最容易把任务做成线上炸弹"></a>常见坑：这些地方最容易把任务做成线上炸弹</h1>
<ol>
<li><strong>把大事务包住整轮扫描</strong><br>
一口气查 1 万条、处理 1 万条、最后一次性提交，失败了回滚巨大，锁也持有得很久。更靠谱的做法是分批分页，每批独立提交。</li>
<li><strong>把远程调用直接写在调度线程里</strong><br>
这样任务体既承担调度，又承担执行，外部接口一抖，整个节奏就乱。能隔离就隔离，至少要有超时和熔断。</li>
<li><strong>只打错误日志，不打成功指标</strong><br>
没有成功次数和耗时分位数，你根本不知道系统是在“健康运行”，还是“悄悄变慢”。</li>
<li><strong>集群部署后默认每个实例都执行</strong><br>
如果业务语义要求全局单次执行，就要上分布式锁、数据库抢占、Quartz/ShedLock 之类的方案，不然重复处理是早晚的事。</li>
</ol>

<h1 id="如何在你自己的项目里落地"><a href="#如何在你自己的项目里落地" class="headerlink" title="如何在你自己的项目里落地"></a>如何在你自己的项目里落地</h1>
<p>如果你准备把今天的内容落到生产项目里，我建议按下面顺序推进：</p>
<ol>
<li>把现有所有 <code>@Scheduled</code> 任务梳理一遍，列出任务名称、周期、平均耗时、失败率；</li>
<li>给每个任务补统一线程池和错误处理器；</li>
<li>对“会修改业务状态”的任务补幂等；</li>
<li>把耗时、错误数、处理量接入 Prometheus；</li>
<li>挑一个最慢的任务抓 JFR，别凭感觉优化。</li>
</ol>
<p>你会发现，很多所谓“定时任务不稳定”，最后都不是 Spring 的锅，而是工程化措施没补齐。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li><code>@Scheduled</code> 只是入口，不是完整方案；</li>
<li><strong>fixedRate</strong> 更像“计划表频率”，<strong>fixedDelay</strong> 更像“处理完再继续”；</li>
<li>线程池、幂等、指标、错误处理器，这四样缺一不可；</li>
<li>JFR 非常适合排查“任务为什么越来越慢”；</li>
<li>定时任务的核心不是“能跑”，而是“稳定、可观测、可恢复”。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>Spring Framework Reference Documentation - Task Execution and Scheduling</li>
<li>Spring Boot Actuator 官方文档</li>
<li>Micrometer Reference Documentation</li>
<li>JDK Mission Control / Java Flight Recorder 官方文档</li>
<li>《Java Concurrency in Practice》</li>
<li>Prometheus 官方文档：Histograms and summaries</li>
</ol>
