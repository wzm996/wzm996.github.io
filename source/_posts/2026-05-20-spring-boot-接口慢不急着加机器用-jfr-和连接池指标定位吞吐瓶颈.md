---
title: Spring Boot 接口慢，不急着加机器：用 JFR 和连接池指标定位吞吐瓶颈
date: 2026-05-20 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - JFR
  - HikariCP
  - 压测
  - 性能调优
---

<hr>
<blockquote>
<p><strong>接口变慢</strong> 不一定是机器不够，也不一定是 SQL 慢。很多线上问题卡在连接池、线程池、GC、锁等待这些“中间地带”。这篇用一个可复现的 Spring Boot 小实验，把压测、JFR 和连接池指标串起来，演示如何从现象定位到瓶颈，而不是凭感觉调参数。</p>
</blockquote>

<!-- more -->

<h1 id="背景-为什么慢接口不能只看平均耗时"><a href="#背景-为什么慢接口不能只看平均耗时" class="headerlink" title="背景：为什么慢接口不能只看平均耗时"></a>背景：为什么慢接口不能只看平均耗时</h1>

接口慢了，常见第一反应是：加机器、加线程、把连接池调大、把超时时间调长。问题是，这些动作有时能缓解，有时会把系统推得更差。

例如一个接口平均耗时只有 80ms，看起来还行，但 P99 已经到 2s，用户体感就是“偶尔卡死”。这里的 **P99** 是百分位延迟，意思是 99% 的请求都小于这个耗时，剩下 1% 更慢。它比平均值更适合观察尾部抖动。

这篇文章用一个小实验回答三个问题：

1. Spring Boot 接口吞吐上不去时，如何判断是 **应用线程**、**数据库连接池** 还是 **GC** 在拖后腿？
2. JFR 采集到的东西该怎么看，不只是“录一个文件”；
3. 调大连接池为什么不一定提升吞吐，甚至可能拉高 P99？

<h1 id="目标读者与先修"><a href="#目标读者与先修" class="headerlink" title="目标读者与先修"></a>目标读者与先修</h1>

适合已经写过 Spring Boot 接口、用过 MySQL 或 HikariCP，但对性能排查还停留在“看日志 + 猜参数”的后端同学。

需要提前知道几件事：

- **Spring Boot**：Java Web 应用开发框架，帮我们把 HTTP 服务、配置、依赖装配这些基础设施组织起来。
- **HikariCP**：Spring Boot 默认常用的数据库连接池，作用是复用数据库连接，避免每次请求都新建连接。
- **JFR（Java Flight Recorder）**：JDK 自带的运行时记录器，可以低开销采集线程、GC、锁、IO、方法采样等事件，常用于线上问题复盘。
- **压测**：用工具模拟并发请求，观察吞吐、延迟、错误率，目的是把问题稳定复现出来。

<h1 id="实验环境"><a href="#实验环境" class="headerlink" title="实验环境"></a>实验环境</h1>

下面实验可以在本机复现。版本不必完全一致，但建议使用 JDK 17+，因为 JFR 工具链更完整。

| 组件 | 示例版本 | 说明 |
| --- | --- | --- |
| JDK | 17 或 21 | 用于运行 Spring Boot 和 JFR |
| Spring Boot | 3.x | Web + JDBC + Actuator |
| MySQL | 8.x | 用 Docker 启动即可 |
| 压测工具 | wrk / hey / ab | 本文示例使用 wrk |
| 监控指标 | Actuator + Micrometer | 暴露 HikariCP 指标 |

> 注：<strong>Micrometer</strong> 是 Java 生态常用的指标门面，它把业务指标、JVM 指标、连接池指标统一成一套模型，再交给 Prometheus、日志或其他后端存储。

<h1 id="准备一个故意会卡的接口"><a href="#准备一个故意会卡的接口" class="headerlink" title="准备一个故意会卡的接口"></a>准备一个故意会卡的接口</h1>

我们写一个接口 `/orders/summary`，它会从数据库查一点数据，然后故意 `sleep` 一段时间，模拟慢 SQL 或下游慢调用。重点不是业务逻辑，而是制造“连接被占住”的场景。

<h2 id="1-docker-启动-mysql"><a href="#1-docker-启动-mysql" class="headerlink" title="1. Docker 启动 MySQL"></a>1. Docker 启动 MySQL</h2>

```bash
docker run --name perf-mysql \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=perf_lab \
  -p 3306:3306 \
  -d mysql:8.4
```

初始化表：

```sql
CREATE TABLE orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_id (user_id)
);

INSERT INTO orders(user_id, amount)
SELECT FLOOR(RAND() * 10000), ROUND(RAND() * 1000, 2)
FROM information_schema.columns c1
LIMIT 10000;
```

<h2 id="2-Spring-Boot-配置"><a href="#2-Spring-Boot-配置" class="headerlink" title="2. Spring Boot 配置"></a>2. Spring Boot 配置</h2>

`application.yml` 示例：

```yaml
server:
  port: 8080
  tomcat:
    threads:
      max: 200

spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/perf_lab?useSSL=false&serverTimezone=Asia/Shanghai
    username: root
    password: root
    hikari:
      maximum-pool-size: 8
      minimum-idle: 8
      connection-timeout: 1000

management:
  endpoints:
    web:
      exposure:
        include: health,metrics
```

几个参数先解释一下：

- **maximum-pool-size**：连接池最多保留多少个数据库连接。请求想访问数据库时，需要先拿到一个连接。
- **connection-timeout**：拿连接最多等多久。超过这个时间还拿不到连接，请求会失败。
- **Tomcat max threads**：Web 容器最多使用多少工作线程处理请求。线程多不代表吞吐一定高，如果都在等连接，只会堆更多请求。

<h2 id="3-接口代码"><a href="#3-接口代码" class="headerlink" title="3. 接口代码"></a>3. 接口代码</h2>

```java
@RestController
@RequestMapping("/orders")
public class OrderController {

    private final JdbcTemplate jdbcTemplate;

    public OrderController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/summary")
    public Map<String, Object> summary(@RequestParam(defaultValue = "50") long sleepMs) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from orders where user_id >= ?",
                Long.class,
                1000
        );

        // 模拟慢 SQL、慢 RPC 或下游服务抖动。真实项目里不要这么写。
        try {
            Thread.sleep(sleepMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        return Map.of("count", count, "sleepMs", sleepMs);
    }
}
```

> 注：这个例子里 `Thread.sleep` 放在查询之后，严格说没有一直占着数据库连接；如果你的事务边界覆盖了整个方法，或者 ORM Session/连接释放时机更晚，就可能把连接持有时间拉长。为了更稳定地复现连接池等待，可以把查询和 sleep 放进一个事务里。

事务版本：

```java
@Transactional(readOnly = true)
@GetMapping("/summary-in-tx")
public Map<String, Object> summaryInTx(@RequestParam(defaultValue = "50") long sleepMs) {
    Long count = jdbcTemplate.queryForObject(
            "select count(*) from orders where user_id >= ?",
            Long.class,
            1000
    );
    LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(sleepMs));
    return Map.of("count", count, "sleepMs", sleepMs);
}
```

这里的 **事务边界** 是指一次数据库操作的提交/回滚范围。范围越大，连接可能被持有得越久，并发下越容易出现连接池等待。

<h1 id="第一轮压测-先看现象"><a href="#第一轮压测-先看现象" class="headerlink" title="第一轮压测：先看现象"></a>第一轮压测：先看现象</h1>

启动应用：

```bash
java -jar target/perf-demo.jar
```

执行压测：

```bash
wrk -t4 -c64 -d60s --latency 'http://127.0.0.1:8080/orders/summary-in-tx?sleepMs=50'
```

参数含义：

- `-t4`：4 个压测线程。
- `-c64`：64 个并发连接。
- `-d60s`：持续 60 秒。
- `--latency`：输出延迟分布。

一次典型结果可能类似这样：

| 场景 | Hikari 最大连接数 | 并发 | 吞吐 Requests/sec | P50 | P95 | P99 | 错误 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 8 | 64 | 155 req/s | 392ms | 510ms | 690ms | 0 |
| B | 16 | 64 | 300 req/s | 198ms | 265ms | 360ms | 0 |
| C | 64 | 64 | 430 req/s | 110ms | 780ms | 1.8s | 少量超时 |

这个表故意展示一个容易踩坑的结论：连接池从 8 调到 16，吞吐明显上升；但继续调到 64，吞吐提升有限，P99 反而恶化。

为什么？因为数据库不是无限并发的。连接池变大后，更多请求同时打到 MySQL，可能把数据库 CPU、IO 或锁竞争推高，尾部延迟就开始抖。

<h1 id="第二轮采集-用指标确认连接池是否在排队"><a href="#第二轮采集-用指标确认连接池是否在排队" class="headerlink" title="第二轮采集：用指标确认连接池是否在排队"></a>第二轮采集：用指标确认连接池是否在排队</h1>

Actuator 会暴露 HikariCP 指标。可以直接 curl：

```bash
curl 'http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.active'
curl 'http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.pending'
curl 'http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.timeout'
```

几个指标这样看：

| 指标 | 含义 | 判断方式 |
| --- | --- | --- |
| `hikaricp.connections.active` | 正在被使用的连接数 | 长时间贴近 `maximum-pool-size`，说明池子满了 |
| `hikaricp.connections.pending` | 正在等待连接的线程数 | 持续大于 0，说明应用线程在排队等连接 |
| `hikaricp.connections.timeout` | 获取连接超时次数 | 增长说明已经有请求拿不到连接 |
| `hikaricp.connections.idle` | 空闲连接数 | 长期很多空闲，通常不是连接池瓶颈 |

验证方法很直接：压测期间每秒采样一次。

```bash
while true; do
  date '+%H:%M:%S'
  curl -s 'http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.active' | jq '.measurements'
  curl -s 'http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.pending' | jq '.measurements'
  sleep 1
done
```

如果看到 active 长时间等于 8，pending 持续大于 0，就可以基本确认：接口慢的直接原因不是 Tomcat 线程不够，而是大量请求在等数据库连接。

<h1 id="第三轮采集-JFR-看线程到底卡在哪里"><a href="#第三轮采集-JFR-看线程到底卡在哪里" class="headerlink" title="第三轮采集：JFR 看线程到底卡在哪里"></a>第三轮采集：JFR 看线程到底卡在哪里</h1>

指标告诉我们“有排队”，JFR 可以告诉我们“线程在哪里等”。

<h2 id="1-启动时开启-JFR"><a href="#1-启动时开启-JFR" class="headerlink" title="1. 启动时开启 JFR"></a>1. 启动时开启 JFR</h2>

```bash
java \
  -XX:StartFlightRecording=filename=/tmp/perf-demo.jfr,duration=70s,settings=profile \
  -jar target/perf-demo.jar
```

`settings=profile` 表示采集更偏性能分析的事件，开销比默认配置高一点，但更适合短时间压测定位。

<h2 id="2-运行中对进程采集"><a href="#2-运行中对进程采集" class="headerlink" title="2. 运行中对进程采集"></a>2. 运行中对进程采集</h2>

如果应用已经启动，可以用 `jcmd`：

```bash
jcmd | grep perf-demo
jcmd <pid> JFR.start name=load-test settings=profile duration=70s filename=/tmp/perf-demo.jfr
```

**jcmd** 是 JDK 自带的诊断命令，可以给正在运行的 JVM 发诊断指令，比如触发 JFR、打印线程栈、查看 VM 参数。

<h2 id="3-查看-JFR"><a href="#3-查看-JFR" class="headerlink" title="3. 查看 JFR"></a>3. 查看 JFR</h2>

图形界面可以用 JDK Mission Control 打开 `/tmp/perf-demo.jfr`。如果机器没图形界面，也可以先用命令行看概要：

```bash
jfr summary /tmp/perf-demo.jfr
jfr view hot-methods /tmp/perf-demo.jfr
jfr view latencies /tmp/perf-demo.jfr
```

重点看这些区域：

| JFR 视角 | 看什么 | 可能结论 |
| --- | --- | --- |
| Threads | Tomcat 工作线程状态 | 大量 WAITING/TIMED_WAITING，不一定是 CPU 忙 |
| Socket I/O | 数据库网络读写耗时 | DB 或网络慢会在这里暴露 |
| Monitor Blocked | synchronized 锁竞争 | 说明线程卡在 Java 锁 |
| Allocation / GC | 分配速率和 GC 暂停 | 大对象或频繁分配导致抖动 |
| Method Profiling | 热方法采样 | CPU 真正花在哪里 |

在连接池等待场景里，通常会看到很多 Web 线程栈停在类似路径：

```text
com.zaxxer.hikari.pool.HikariPool.getConnection
com.zaxxer.hikari.HikariDataSource.getConnection
org.springframework.jdbc.datasource.DataSourceUtils.fetchConnection
...
```

这比“感觉连接池小了”要可靠得多：指标显示 pending，JFR 栈显示线程在 `getConnection` 等，两条证据能互相印证。

<h1 id="优化前后对比-不要只调一个参数"><a href="#优化前后对比-不要只调一个参数" class="headerlink" title="优化前后对比：不要只调一个参数"></a>优化前后对比：不要只调一个参数</h1>

如果确认瓶颈是连接持有时间太长，优先考虑缩短持有时间，而不是无脑加连接。

<h2 id="方案一-缩小事务边界"><a href="#方案一-缩小事务边界" class="headerlink" title="方案一：缩小事务边界"></a>方案一：缩小事务边界</h2>

错误示例：

```java
@Transactional
public OrderView loadOrderView(Long id) {
    Order order = orderRepository.findById(id).orElseThrow();
    RemotePrice price = priceClient.query(order.getSkuId()); // 远程调用也在事务里
    return toView(order, price);
}
```

更稳妥的写法：

```java
public OrderView loadOrderView(Long id) {
    Order order = transactionTemplate.execute(status ->
            orderRepository.findById(id).orElseThrow()
    );
    RemotePrice price = priceClient.query(order.getSkuId());
    return toView(order, price);
}
```

这里的 **TransactionTemplate** 是 Spring 提供的编程式事务工具，适合把事务范围精确包在几行数据库代码上。

<h2 id="方案二-给慢下游加超时和隔离"><a href="#方案二-给慢下游加超时和隔离" class="headerlink" title="方案二：给慢下游加超时和隔离"></a>方案二：给慢下游加超时和隔离</h2>

如果慢的是远程调用，不要让它一直占着业务线程。至少要设置连接超时、读取超时，并考虑线程池或信号量隔离。

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          default:
            connectTimeout: 300
            readTimeout: 800
```

**隔离** 的意思是把不同下游或不同业务的重要性拆开，避免一个慢服务把整个应用的线程都拖住。

<h2 id="方案三-连接池按数据库承载能力定，不按应用线程数定"><a href="#方案三-连接池按数据库承载能力定，不按应用线程数定" class="headerlink" title="方案三：连接池按数据库承载能力定，不按应用线程数定"></a>方案三：连接池按数据库承载能力定，不按应用线程数定</h2>

连接池不是越大越好。一个比较朴素的估算方式是：

```text
建议连接数 ≈ 目标吞吐 × 单请求持有连接时间
```

例如目标 300 req/s，单请求真正持有连接 30ms：

```text
300 × 0.03 = 9
```

再留一点余量，设置 12 或 16 可能比较合理。这个公式不是银弹，但能提醒我们：关键变量是“连接持有时间”，不是“接口总耗时”。

<h2 id="优化后验证"><a href="#优化后验证" class="headerlink" title="优化后验证"></a>优化后验证</h2>

把事务边界缩短后，再做同样压测：

```bash
wrk -t4 -c64 -d60s --latency 'http://127.0.0.1:8080/orders/summary?sleepMs=50'
```

示例对比：

| 版本 | 连接池 | 并发 | 吞吐 | P50 | P95 | P99 | pending |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 优化前：慢调用在事务内 | 8 | 64 | 155 req/s | 392ms | 510ms | 690ms | 持续 > 0 |
| 优化后：缩小事务边界 | 8 | 64 | 830 req/s | 63ms | 88ms | 140ms | 接近 0 |

验证结论时不要只看 wrk 输出，还要同时确认：

1. `hikaricp.connections.pending` 是否下降；
2. JFR 里 `HikariPool.getConnection` 等待栈是否明显减少；
3. MySQL CPU、慢查询、连接数是否在安全范围；
4. 应用错误率是否为 0，不能用失败请求换吞吐。

<h1 id="GC-也要排除-否则容易误判"><a href="#GC-也要排除-否则容易误判" class="headerlink" title="GC 也要排除，否则容易误判"></a>GC 也要排除，否则容易误判</h1>

有些接口 P99 抖动不是连接池，而是 GC。**GC（Garbage Collection）** 是 JVM 自动回收无用对象的机制，回收期间可能暂停或影响应用线程。

启动时加上 GC 日志：

```bash
java \
  -Xlog:gc*,safepoint:file=/tmp/gc.log:time,uptime,level,tags \
  -jar target/perf-demo.jar
```

如果 P99 尖刺时间点刚好对应下面这种日志，就要小心：

```text
[2026-05-20T10:12:03.456+0800][info][gc] GC(42) Pause Young (Normal) 128M->32M(512M) 95.321ms
```

这表示一次年轻代 GC 暂停了约 95ms。偶发还好，如果频率很高，就需要看对象分配速率、缓存对象大小、JSON 序列化、日志拼接等问题。

用 JFR 辅助确认：

```bash
jfr view gc-pauses /tmp/perf-demo.jfr
jfr view allocation-by-class /tmp/perf-demo.jfr
```

如果 `byte[]`、`char[]`、某些 DTO 大量分配，可能是序列化或大响应体导致的。这个时候调连接池就完全跑偏了。

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="1-只看平均耗时"><a href="#1-只看平均耗时" class="headerlink" title="1. 只看平均耗时"></a>1. 只看平均耗时</h2>

平均耗时会把少量极慢请求“摊平”。生产排障至少看 P50、P95、P99，再结合错误率。

<h2 id="2-连接池和线程池一起调大"><a href="#2-连接池和线程池一起调大" class="headerlink" title="2. 连接池和线程池一起调大"></a>2. 连接池和线程池一起调大</h2>

这很容易把排队从应用侧转移到数据库侧。应用看起来不等连接了，但 MySQL 开始 CPU 飙升、锁等待增多，P99 可能更难看。

<h2 id="3-压测机和服务在同一台机器却不看资源"><a href="#3-压测机和服务在同一台机器却不看资源" class="headerlink" title="3. 压测机和服务在同一台机器却不看资源"></a>3. 压测机和服务在同一台机器却不看资源</h2>

本地实验可以这么做，正式压测不建议。压测工具也会消耗 CPU 和网络，可能把服务端结果污染掉。

<h2 id="4-JFR-录太久但没人看"><a href="#4-JFR-录太久但没人看" class="headerlink" title="4. JFR 录太久但没人看"></a>4. JFR 录太久但没人看</h2>

JFR 不是越久越好。排查具体问题时，建议围绕压测窗口录 1~5 分钟，保留问题发生前后即可。文件太大反而降低分析效率。

<h2 id="5-把示例数据当成标准答案"><a href="#5-把示例数据当成标准答案" class="headerlink" title="5. 把示例数据当成标准答案"></a>5. 把示例数据当成标准答案</h2>

本文里的吞吐和延迟只是示例。不同机器、数据库、JDK、SQL、索引都会改变结果。真正有价值的是采集路径：压测复现 → 指标确认 → JFR 定位 → 小步调整 → 再验证。

<h1 id="排查清单"><a href="#排查清单" class="headerlink" title="排查清单"></a>排查清单</h1>

遇到 Spring Boot 慢接口，可以按这个顺序走：

1. 先压测复现，记录吞吐、P50、P95、P99、错误率；
2. 看 Actuator 指标，确认 Hikari active、pending、timeout；
3. 开 JFR，检查线程栈、Socket I/O、锁、GC、热方法；
4. 如果连接池排队，优先缩短事务边界和连接持有时间；
5. 如果 GC 抖动，检查分配热点和大对象；
6. 每次只改一个关键变量，改完用同样脚本验证；
7. 优化目标不是单点吞吐最高，而是吞吐、P99、错误率、数据库负载都在可接受范围。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

这篇文章的核心观点很简单：慢接口排查不要靠猜，要把证据链补齐。

- 压测负责稳定复现问题；
- HikariCP 指标负责判断是否连接池排队；
- JFR 负责回答线程、GC、锁、IO 到底卡在哪里；
- 参数优化要围绕瓶颈做，尤其不要无脑把线程池和连接池调大；
- 每次优化后必须用同一套压测命令和指标口径验证。

真正成熟的性能优化，不是背几个参数，而是建立“现象—指标—栈—改动—验证”的闭环。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Spring Boot Actuator 官方文档：<https://docs.spring.io/spring-boot/reference/actuator/index.html>
2. HikariCP GitHub 文档：<https://github.com/brettwooldridge/HikariCP>
3. Oracle JDK Mission Control / JFR 文档：<https://docs.oracle.com/javacomponents/jmc-8-3/jfr-runtime-guide/>
4. OpenJDK JFR 工具文档：<https://docs.oracle.com/en/java/javase/17/docs/specs/man/jfr.html>
5. wrk 压测工具：<https://github.com/wg/wrk>
6. MySQL 8.4 Reference Manual：<https://dev.mysql.com/doc/refman/8.4/en/>
