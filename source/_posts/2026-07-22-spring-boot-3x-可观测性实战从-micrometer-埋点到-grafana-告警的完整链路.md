---
title: Spring Boot 3.x 可观测性实战——从 Micrometer 埋点到 Grafana 告警的完整链路
date: 2026-07-22 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - Micrometer
  - Prometheus
  - Grafana
  - Spring Boot
  - 监控告警
  - Actuator
---

<hr>

<blockquote><p>你的线上服务跑得好好的，老板突然问："昨天晚上 8 点那个接口慢了多少？"你愣住了——因为你只有日志，没有数字。这篇文章带你从零搭一套 **Micrometer → Prometheus → Grafana** 的可观测性体系，让"服务怎么样"这个问题变成一张能说话的 Dashboard。</p></blockquote>

<!-- more -->

## 一、为什么你需要可观测性（而不只是日志）

先说个真事：某电商系统在大促期间订单接口 P99 飙到 3 秒，运维在群里 @后端负责人，对方翻了半小时日志才定位到是数据库连接池打满。如果当时有一张 Grafana 图表展示 `HikariCP Pending Threads` 趋势，问题 30 秒就能发现。

**可观测性**（Observability）不是什么新概念。它说的是：**你不需要为了排查一个问题而重新部署一套采集方案**——因为指标、链路、日志这三样东西本来就该一直在那儿。

业界通常说可观测性有三大支柱：

| 支柱 | 解决什么问题 | 典型工具 |
|------|-------------|---------|
| **Metrics（指标）** | 系统整体健康度如何？趋势怎样？ | Prometheus + Grafana |
| **Tracing（链路）** | 一个请求经过了哪些服务？哪步慢了？ | Jaeger / Zipkin / SkyWalking |
| **Logging（日志）** | 具体发生了什么错误？上下文是什么？ | ELK / Loki |

本文聚焦第一根支柱：** Metrics**，而且是 Java/Spring Boot 生态里最主流的方案：

```
Spring Boot 应用 ──暴露──> Micrometer 指标 ──抓取──> Prometheus ──查询/展示──> Grafana
```

### 目标读者与先修知识

- 写过至少一个 Spring Boot 项目，知道 `application.yml` 怎么配
- 听说过 Docker（不用精通，后面会给 docker-compose）
- 不需要提前了解 Prometheus 或 Grafana

## 二、Micrometer 指标体系：四种原语要分清

**Micrometer** 是 Java 的度量门面（类似于 SLF4J 之于日志），Spring Boot 2.x 之后 Actuator 底层就是用它来暴露指标的。它定义了四种核心指标类型，搞混了后面配监控会一脸懵：

### 2.1 Counter（计数器）

只能递增的值。典型场景：HTTP 请求数、订单数、错误次数。

```java
// 构造器注入 MeterRegistry
private final Counter orderCounter;

public OrderService(MeterRegistry registry) {
    this.orderCounter = Counter.builder("orders.created")
        .description("创建订单总数")
        .register(registry);
}

public void createOrder(Order order) {
    // 业务逻辑...
    orderCounter.increment();
}
```

**验证方式：** 启动后访问 `/actuator/prometheus`，能看到 `orders_created_total 5.0` 这样的输出。

> **注：** Micrometer 会自动给 Counter 指标加 `_total` 后缀，这是 Prometheus 的约定。

### 2.2 Gauge（仪表盘）

可以上下波动的值，反映当前状态。典型场景：当前在线人数、连接池活跃连接数、队列长度。

```java
// 方式一：基于对象的某个属性自动采样
List<String> pendingTasks = new CopyOnWriteWriteArrayList<>();
Gauge.builder("tasks.pending.size", pendingTasks, List::size)
    .description("待处理任务队列长度")
    .register(registry);

// 方式二：手动设置值
AtomicDouble cpuUsage = new AtomicDouble(0);
Gauge.builder("system.cpu.usage", cpuUsage, AtomicDouble::get)
    .register(registry);
```

**常见坑：** Gauge 的值不是"历史累计"，而是"当前快照"。如果你想在 Grafana 里看过去 1 小时的 Gauge 变化曲线，Prometheus 会用 `irate()` 或 `avg_over_time()` 帮你插值——但前提是你抓取频率够高（建议 15s）。

### 2.3 Timer（计时器）

同时记录**耗时**和**计数**，相当于 Histogram + Counter 的组合。这是你用得最多的类型。

```java
private final Timer httpTimer;

public OrderController(MeterRegistry registry) {
    this.httpTimer = Timer.builder("http.server.requests")
        .description("HTTP 请求耗时")
        .publishPercentiles(0.5, 0.95, 0.99)   // 输出 P50/P95/P99
        .sla(java.time.Duration.ofMillis(100),   // SLA 分桶边界
             java.time.Duration.ofMillis(200),
             java.time.Duration.ofMillis(500))
        .register(registry);
}

@GetMapping("/api/orders")
public ResponseEntity<?> listOrders() {
    return httpTimer.record(() -> {
        // 实际业务逻辑
        return ResponseEntity.ok(orderService.findAll());
    });
}
```

Timer 会自动产生以下指标（以 `http_server_requests` 为例）：

| 指标名 | 含义 |
|--------|------|
| `http_server_requests_seconds_count` | 总请求数（按 method/uri/status 分标签） |
| `http_server_requests_seconds_sum` | 总耗时（秒） |
| `http_server_requests_seconds_max` | 最大耗时 |
| `http_server_requests_seconds_bucket` | 直方图分桶（le=0.1, 0.2, 0.5...） |

**验证方式：** 用 wrk 或 ab 压测几秒，然后查 PromQL：

```promql
# P99 耗时（最近 5 分钟）
histogram_quantile(0.99, rate(http_server_requests_seconds_bucket[5m]))

# QPS（每秒请求数）
rate(http_server_requests_seconds_count[5m])
```

### 2.4 Distribution Summary（分布摘要）

Timer 只能记录时间（单位是秒）。如果你想记录**非时间类的分布数据**（比如消息体大小、订单金额），就用 DistributionSummary：

```java
private final DistributionSummary orderAmountSummary;

public OrderService(MeterRegistry registry) {
    this.orderAmountSummary = DistributionSummary.builder("order.amount")
        .description("订单金额分布")
        .publishPercentiles(0.5, 0.9, 0.99)
        .baseUnit("CNY")                     // 单位
        .register(registry);
}

public void createOrder(Order order) {
    orderAmountSummary.record(order.getAmount());
}
```

## 三、Spring Boot Actuator + Micrometer 集成配置

### 3.1 依赖引入

```xml
<!-- pom.xml -->
<dependencies>
    <!-- Spring Boot Actuator（指标暴露端点） -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>

    <!-- Micrometer Prometheus 注册中心（把指标导出为 Prometheus 格式） -->
    <dependency>
        <groupId>io.micrometer</groupId>
        <artifactId>micrometer-registry-prometheus</artifactId>
    </dependency>
</dependencies>
```

Gradle 对应：

```groovy
implementation 'org.springframework.boot:spring-boot-starter-actuator'
implementation 'io.micrometer:micrometer-registry-prometheus'
```

### 3.2 application.yml 配置

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus   # 只暴露这三个端点，别全开
  endpoint:
    health:
      show-details: when_authorized       # 生产环境不要泄露详情
  metrics:
    tags:
      application: ${spring.application.name}  # 全局标签：应用名
    distribution:
      percentiles-histogram:
        http.server.requests: true          # 开启 P50/P95/P99 直方图
      sla:
        http.server.requests: 100ms,200ms,500ms,1s,2s,5s  # SLA 分桶
  server:
    port: 8080

spring:
  application:
    name: demo-monitor
```

**关键配置解释：**

- `endpoints.web.exposure.include`：**生产环境千万别写 `*`！** `prometheus` 是必须的，`health` 用于存活探针，`info` 用于版本信息。其他端点（`env`、`beans`、`configprops`）包含敏感信息，不应暴露。
- `metrics.tags.application`：给所有指标自动加上 `application="demo-monitor"` 标签，多实例部署时靠它区分。
- `distribution.percentiles-histogram`：设为 `true` 后 Micrometer 会计算客户端分位数（推荐），否则只能依赖 Prometheus 服务端的近似计算。

### 3.3 验证 Actuator 是否工作

启动应用后 curl 一下：

```bash
# 健康检查
curl -s http://localhost:8080/actuator/health | python3 -m json.tool

# Prometheus 格式指标（这一行最重要）
curl -s http://localhost:8080/actuator/prometheus | head -30
```

预期输出类似：

```
# HELP jvm_memory_used_bytes The amount of used memory
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes{application="demo-monitor",area="heap",id="PS Eden Space",} 1.548992E7
# HELP http_server_requests_seconds HTTP 请求耗时
# TYPE http_server_requests_seconds_summary
http_server_requests_seconds_count{application="demo-monitor",exception="None",method="GET",status="200",uri="/actuator/prometheus",} 1.0
http_server_requests_seconds_sum{application="demo-monitor",exception="None",method="GET",status="200",uri="/actuator/prometheus",} 0.003891234
```

如果你能看到这些文本行，恭喜——Micrometer 已经在工作了。

## 四、Prometheus 采集与 PromQL 实战

### 4.1 用 Docker Compose 跑起来

新建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:v2.51.0
    container_name: prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=15d'   # 数据保留 15 天
      - '--web.enable-lifecycle'               # 允许热重载配置

  grafana:
    image: grafana/grafana:10.4.0
    container_name: grafana
    ports:
      - "3000:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin123     # ⚠️ 生产环境务必改密码
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on:
      - prometheus

volumes:
  grafana-data:
```

同目录下新建 `prometheus.yml`：

```yaml
global:
  scrape_interval: 15s            # 每 15 秒抓取一次指标
  evaluation_interval: 15s
  external_labels:
    monitor: 'codelab-monitor'

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'spring-boot-app'
    metrics_path: '/actuator/prometheus'    # 关键：指向 Actuator 的 Prometheus 端点
    scrape_interval: 10s                    # 应用指标抓更频繁一点
    static_configs:
      - targets: ['host.docker.internal:8080']  # Docker Desktop/Mac/Windows 用这个
        # Linux 上换成你宿主机的实际 IP：
        # targets: ['172.17.0.1:8080']
    relabel_configs:                        # 给这个 job 的指标加上 instance 标签
      - target_label: instance
        replacement: 'demo-monitor-01'
```

启动：

```bash
docker compose up -d
```

然后打开浏览器：
- Prometheus UI：http://localhost:9090
- Grafana：http://localhost:3000 （账号 admin / 密码 admin123）

### 4.2 PromQL 从入门到能用

Prometheus 自带的查询语言叫 **PromQL**。别被名字唬住——本质就是 SQL 的"时序版"。下面给你整理一份"抄就能用"的速查表：

#### 查瞬时值

```promql
# 当前 JVM 堆内存使用量（字节）
jvm_memory_used_bytes{application="demo-monitor",area="heap"}

# 当前活跃线程数
jvm_threads_live_threads{application="demo-monitor"}
```

#### 查速率（最常用）

```promql
# 最近 5 分钟平均 QPS（每秒请求数）
rate(http_server_requests_seconds_count[5m])

# 最近 5 分钟平均错误率（非 2xx 的请求占比）
sum(rate(http_server_requests_seconds_count[5m])) by (status)
  / on() sum(rate(http_server_requests_seconds_count[5m]))
```

#### 查延迟分位数（核心）

```promql
# P99 延迟（秒）
histogram_quantile(0.99,
  sum(rate(http_server_requests_seconds_bucket[5m])) by (le)
)

# P95 延迟
histogram_quantile(0.95,
  sum(rate(http_server_requests_seconds_bucket[5m])) by (le)
)

# 按 URI 分组的 P99 延迟（排障利器）
histogram_quantile(0.99,
  sum(rate(http_server_requests_seconds_bucket[5m])) by (uri, le)
)
```

> **注：** `histogram_quantile` 是 Prometheus 根据 bucket 插值计算的分位数，不是精确值但足够用。如果你需要精确分位数，可以在 Micrometer 端开启 `publishPercentiles(0.5, 0.95, 0.99)`，它会直接计算客户端分位数并作为独立指标输出。

#### 查增长率

```promql
# JVM GC 次数（每分钟增长多少次）
increase(jvm_gc_pause_seconds_count[1m])

# Full GC 次数（只看 G1 Old Gen）
increase(jvm_gc_pause_seconds_count{action="Old GC"}[1m])
```

**验证方式：** 在 Prometheus UI 的 Graph 页面粘贴上面任意一条 PromQL，选好时间范围（Last 15 minutes），应该能看到折线图或表格数据。如果显示 `No data`，检查：
1. Spring Boot 应用是否在运行且 `/actuator/prometheus` 可访问
2. Prometheus Targets 页面（http://localhost:9090/targets）中 `spring-boot-app` 是否为 UP
3. 时间范围是否太长而数据还没攒够

## 五、Grafana Dashboard 搭建

### 5.1 添加 Prometheus 数据源

1. 打开 http://localhost:3000 → 菜单 **Connections** → **Add new connection**
2. 选 **Prometheus**
3. URL 填 `http://prometheus:9090`（注意是容器名，不是 localhost）
4. 点 **Save & test**，看到绿色 `Data source is working` 就对了

### 5.2 导入 JVM Dashboard（5 分钟出图）

不想从零建面板？直接导入现成的：

1. 菜单 **Dashboards** → **Import**
2. 输入 Dashboard ID：**4701**（JVM (Micrometer)）
3. 数据源选 Prometheus
4. 点 Import

你会立刻得到一张包含以下面板的 Dashboard：

| 面板 | 内容 |
|------|------|
| JVM Memory | 堆/非堆内存使用量（面积图） |
| GC Pause | GC 停顿时间和次数 |
| Threads | 线程数（daemon/live/peak） |
| CPU Usage | 进程 CPU 使用率 |
| Classloader | 加载的类数量 |

### 5.3 手动搭建业务 Dashboard（关键技能）

光看 JVM 不够，我们建一个**业务级 Dashboard** 来监控 HTTP 接口。步骤如下：

#### Panel 1：QPS 趋势

```promql
sum(rate(http_server_requests_seconds_count[2m])) by (uri)
```

- 图表类型：Time series
- Legend：`{{uri}}`
- 单位：req/s（Unit → Custom → `req/s`）

#### Panel 2：P99 延迟热力图

```promql
# 热力图模式能直观看出延迟分布
sum(rate(http_server_requests_seconds_bucket[5m])) by (le, uri)
```

- 图表类型：Heatmap
- 这是 Grafana 的杀手功能：颜色越深表示落在该区间的请求越多

#### Panel 3：错误率

```promql
(
  sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
  /
  sum(rate(http_server_requests_seconds_count[5m]))
) * 100
```

- 图表类型：Stat（大数字展示）
- 单位：percent (0-100)
- 阈值设置：< 1% 绿色，1-5% 黄色，> 5% 红色

#### Panel 4：Top 5 慢接口排行

```promql
topk(5,
  histogram_quantile(0.99,
    sum(rate(http_server_requests_seconds_bucket[5m])) by (uri, le)
  )
)
```

- 图表类型：Table（表格排序）
- 列：URI、P99(s)

#### Panel 5：HikariCP 连接池状态

如果你的项目用了数据库，加上这几个查询：

```promql
# 活跃连接数
hikaricp_connections_active{application="demo-monitor"}

# 等待连接的线程数（>0 就要注意了）
hikaricp_connections_pending{application="demo-monitor"}

# 连接池最大值
hikaricp_connections_max{application="demo-monitor"}
```

### 5.4 Dashboard 效果预览

搭完之后你应该能看到这样的布局（文字描述）：

```
┌──────────────────────────────────────────────┐
│  QPS 趋势（按 URI 折线叠放）                   │
├──────────────┬───────────────────────────────┤
│  错误率(%)   │  P99 延迟热力图                 │
│  [大数字]    │  [颜色深浅表示请求密度]           │
├──────────────┼───────────────────────────────┤
│  Top 5 慢接口 │  HikariCP 连接池状态            │
│  [表格]      │  [活跃/等待/最大]                │
└──────────────┴───────────────────────────────┘
```

## 六、告警规则设计：什么时候该叫醒你？

光有图表不够——你得让系统在出问题时主动通知你。Prometheus 内置了 **Alertmanager** 来做这件事。

### 6.1 编写告警规则文件

新建 `alerts.yml`：

```yaml
groups:
  - name: spring-boot-alerts
    rules:
      # 规则 1：P99 延迟超过 1 秒持续 2 分钟
      - alert: HighLatencyP99
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_server_requests_seconds_bucket[5m])) by (le)
          ) > 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "P99 延迟超过 1 秒"
          description: "当前 P99 = {{ $value }}s，持续超过 2 分钟"

      # 规则 2：错误率超过 5% 持续 1 分钟
      - alert: HighErrorRate
        expr: |
          (
            sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
            /
            sum(rate(http_server_requests_seconds_count[5m]))
          ) * 0 > 5
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "HTTP 5xx 错误率超过 5%"
          description: "当前错误率 = {{ $value }}%，请立即排查"

      # 规则 3：JVM 堆使用率超过 85%
      - alert: HighHeapUsage
        expr: |
          jvm_memory_used_bytes{area="heap"}
          / jvm_memory_max_bytes{area="heap"} * 100 > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "JVM 堆内存使用率超过 85%"
          description: "当前使用率 = {{ $value }}%，可能存在内存泄漏"

      # 规则 4：GC 停顿频繁（Old GC 每分钟 > 3 次）
      - alert: FrequentFullGC
        expr: |
          increase(jvm_gc_pause_seconds_count{action="Old GC"}[2m]) > 6
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Full GC 频繁"
          description: "最近 2 分钟 Old GC 发生 {{ $value }} 次，堆空间可能不足"

      # 规则 5：HikarCP 有线程在等连接
      - alert: HikariCPPendingThreads
        expr: hikaricp_connections_pending > 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "数据库连接池有等待线程"
          description: "{{ $value }} 个线程在等待数据库连接"
```

然后在 `prometheus.yml` 中引用：

```yaml
rule_files:
  - 'alerts.yml'
```

重启 Prometheus 让规则生效：

```bash
docker compose restart prometheus
```

验证规则已加载：打开 http://localhost:9090/rules，应该能看到 5 条规则状态为 `HEALTHY`。

### 6.2 Alertmanager 配置（通知到钉钉/邮件）

Alertmanager 可以把告警推送到钉钉、邮件、Slack 等。这里以钉钉机器人为例：

新建 `alertmanager.yml`：

```yaml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'severity']
  group_wait: 10s       # 同组告警等 10s 一起发（避免轰炸）
  group_interval: 5m    # 同组告警至少间隔 5min
  repeat_interval: 3h   # 未恢复的告警每 3h 重复一次
  receiver: 'default-receiver'

receivers:
  - name: 'default-receiver'
    webhook_configs:
      - url: 'https://oapi.dingtalk.com/robot/send?access_token=YOUR_TOKEN'
        send_resolved: true   # 告警恢复也通知
```

更新 `docker-compose.yml` 加上 Alertmanager 服务：

```yaml
  alertmanager:
    image: prom/alertmanager:v0.27.0
    container_name: alertmanager
    ports:
      - "9093:9093"
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
```

同时在 `prometheus.yml` 中加上 Alertmanager 引用：

```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']
```

> **注：** 钉钉机器人需要你在钉钉群里创建一个"自定义机器人"拿到 Webhook URL。记得把 URL 中的 `access_token` 替换成你自己的。

## 七、压测验证：指标准确吗？

搭完监控不压测等于没搭。我们需要验证两件事：
1. **指标确实在记录**（不是零）
2. **指标反映的是真实情况**（不是偏的）

### 7.1 压测工具准备

用 **wrk**（轻量级 HTTP 压测工具，比 ab 更好用）：

```bash
# Ubuntu/Debian
sudo apt-get install wrk

# 或者用 Docker
docker run --rm skandyla/wrk -t4 -c100 -d30s http://host.docker.internal:8080/api/orders
```

### 7.2 压测脚本

```bash
#!/bin/bash
# bench.sh — 对 Spring Boot 应用进行阶梯式压测

BASE_URL="http://localhost:8080"

echo "=== 阶段 1：低并发 (10 并发, 20 秒) ==="
wrk -t2 -c10 -d20s "$BASE_URL/api/orders"

echo ""
echo "=== 阶段 2：中并发 (50 并发, 20 秒) ==="
wrk -t4 -c50 -d20s "$BASE_URL/api/orders"

echo ""
echo "=== 阶段 3：高并发 (200 并发, 30 秒) ==="
wrk -t8 -c200 -d30s "$BASE_URL/api/orders"

echo ""
echo "=== 压测完成，请在 Grafana 查看 P99/QPS 趋势 ==="
echo "Grafana: http://localhost:3000"
```

### 7.3 预期结果对照表

压测过程中，你在 Grafana 应该观察到类似下面的数据（具体数值取决于你的机器配置）：

| 阶段 | 并发数 | 预期 QPS | 预期 P99 | 预期现象 |
|------|--------|----------|----------|----------|
| 低负载 | 10 | ~800-1500 req/s | < 50ms | 曲线平稳 |
| 中负载 | 50 | ~1500-3000 req/s | < 200ms | 开始出现波动 |
| 高负载 | 200 | 可能下降（排队） | > 500ms | 错误率上升 |

**验证 checklist：**

- [ ] Prometheus Targets 页面 `spring-boot-app` 状态始终为 UP（没有因为高负载导致抓取超时）
- [ ] QPS 折线图在压测开始时有明显抬升，停止后回落
- [ ] P99 延迟随并发增加而上升（符合直觉）
- [ ] 如果用了 HikariCP，`connections_pending` 在高并发时可能 > 0
- [ ] JVM Heap 使用率在高负载时上升，压测结束后回落（如果没有回落，怀疑内存泄漏）

### 7.4 一个完整的 Demo 项目结构

为了让你能真正复现，下面给出最小可运行的 Demo 项目结构：

```
demo-monitor/
├── pom.xml
├── src/main/java/com/example/demo/
│   ├── DemoApplication.java
│   ├── controller/
│   │   └── OrderController.java         # 暴露 REST 接口
│   ├── service/
│   │   ├── OrderService.java             # 包含自定义埋点
│   │   └── SlowService.java              # 故意模拟慢接口
│   └── config/
│       └── MetricsConfig.java            # 自定义 MeterRegistryCustomizer
├── src/main/resources/
│   └── application.yml
├── docker-compose.yml                     # Prometheus + Grafana
├── prometheus.yml                         # 采集配置
└── alerts.yml                             # 告警规则
```

核心代码片段——`OrderController.java`：

```java
package com.example.demo.controller;

import com.example.demo.service.OrderService;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;
    private final Counter listCounter;

    public OrderController(OrderService orderService, MeterRegistry registry) {
        this.orderService = orderService;
        this.listCounter = Counter.builder("orders.api.list")
            .description("订单列表查询次数")
            .tag("endpoint", "/api/orders")
            .register(registry);
    }

    @GetMapping
    public Object list() {
        listCounter.increment();
        return orderService.findAll();
    }

    @PostMapping
    public Object create(@RequestBody String body) {
        return orderService.create(body);
    }
}
```

`SlowService.java`（用于触发告警测试）：

```java
package com.example.demo.service;

import org.springframework.stereotype.Service;
import java.util.concurrent.ThreadLocalRandom;

@Service
public class SlowService {

    /**
     * 模拟偶尔变慢的接口（10% 概率 sleep 1~2 秒）
     * 用于触发 P99 延迟告警
     */
    public String slowOperation() {
        if (ThreadLocalRandom.current().nextDouble() < 0.1) {
            try {
                Thread.sleep(ThreadLocalRandom.current().nextInt(1000, 2000));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        return "ok";
    }
}
```

## 八、常见坑与误区（血泪总结）

### 坑 1：标签基数爆炸（Cardinality Explosion）

**症状：** Prometheus 内存暴涨，查询越来越慢，甚至 OOM。

**原因：** 你给指标加了太多高基数的标签。最典型的例子是把 `userId` 或 `requestId` 当成标签：

```java
// ❌ 绝对不要这样！每个用户都会生成一个新的时间序列
Counter.builder("requests").tag("userId", userId).register(registry);

// ✅ 用 histogram 分桶代替
DistributionSummary.builder("request.by.user")
    .publishPercentiles(0.5, 0.95, 0.99)
    .register(registry);
```

**怎么查：** Prometheus UI 执行 `topk(10, count by (__name__)())` 看哪些指标序列数最多。单个指标的 cardinality 最好不超过 10000。

**经验法则：** 标签的取值种类应该是有界的、有限的。`method`（GET/POST/PUT/DELETE）、`status`（200/400/404/500）、`uri`（固定接口路径）都是好标签；`userId`、`ip`、`message` 都是坏标签。

### 坑 2：`histogram_quantile` 结果不准确

**症状：** Grafana 显示 P99 = 120ms，但你用日志统计的实际 P99 只有 80ms。

**原因：** Prometheus 的 `histogram_quantile` 是根据 bucket **线性插值**得到的近似值。如果你的 bucket 边界不够密（比如只有 le=0.1, 0.5, 1, 5），插值误差会很大。

**解法：** 在 Micrometer 端配置更细的 SLA 分桶：

```yaml
management:
  metrics:
    distribution:
      sla:
        http.server.requests: 50ms,100ms,200ms,300ms,500ms,700ms,1s,2s,3s,5s
```

或者直接开启 Micrometer 客户端分位数（精确计算）：

```java
Timer.builder("http.server.requests")
    .publishPercentiles(0.5, 0.9, 0.95, 0.99)  // 客户端精确计算
    .register(registry);
```

**代价：** 客户端分位数会增加指标数量（每个 percentile 都是一个新时间序列）。建议只在关键指标上开启。

### 坑 3： scrape_interval 太长导致数据稀疏

**症状：** Grafana 图表看起来"断断续续"，或者 `rate()` 计算出来全是 NaN。

**原因：** 默认 `scrape_interval: 15s` 对大多数场景够了，但如果你的指标生命周期很短（比如批处理任务只跑了 10 秒），15 秒可能一次都没抓到。

**解法：** 对短生命周期任务单独配置更高的抓取频率：

```yaml
scrape_configs:
  - job_name: 'short-lived-tasks'
    scrape_interval: 5s
    scrape_timeout: 4s
    static_configs:
      - targets: ['host.docker.internal:8080']
```

### 坑 4：Actuator 端点暴露到公网

**症状：** 安全扫描报告一堆高危漏洞。

**原因：** 你在生产环境的 `application.yml` 里写了：

```yaml
# ❌ 危险！这会把 /actuator/env（含所有环境变量/密码）暴露出去
management:
  endpoints:
    web:
      exposure:
        include: '*'
```

**解法：**

```yaml
# ✅ 最小权限原则
management:
  endpoints:
    web:
      exposure:
        include: health,prometheus
  endpoint:
    health:
      show-details: never    # 生产环境隐藏详情
```

并且在前面的反向代理（Nginx/Traefik）上加 IP 白名单：

```nginx
# Nginx 只允许内部网段访问 /actuator
location /actuator {
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://127.0.0.1:8080;
}
```

### 坑 5：Grafana 刷新间隔 vs 数据精度

**症状：** 你配了 10s 的 scrape_interval，但 Grafana 刷新间隔设成了 `30s`，导致你看的数据永远"慢半拍"。

**解法：** Grafana Dashboard 设置 → **Refresh intervals** → 把最小刷新间隔设为 `15s` 或 `10s`（与 scrape_interval 匹配或更小）。注意 Grafana 免费版的最低刷新是 5s（org setting 里改）。

## 九、总结

这篇文章我们从零搭了一套完整的可观测性链路，回顾一下关键决策点：

| 决策点 | 推荐 | 为什么 |
|--------|------|--------|
| 指标库 | Micrometer | Spring Boot 原生集成，切换后端零成本 |
| 指标格式 | Prometheus | 生态最成熟，Pull 模型简单可靠 |
| 抓取频率 | 10-15s | 平衡精度和存储开销 |
| 分位数计算 | Micrometer 客户端（关键指标）+ Prometheus 服务端（一般指标） | 精确性与性能的平衡 |
| Dashboard | 先导入 JVM (4701)，再自建业务面板 | 别重复造轮子 |
| 告警通道 | Alertmanager → 钉钉/邮件 | 国内团队钉钉响应最快 |
| Actuator 暴露 | 仅 health + prometheus | 安全第一 |

**下一步可以做的：**
1. 接入 **OpenTelemetry** 做 Tracing（链路追踪），补齐第二根支柱
2. 用 **Loki** 收集结构化日志，在 Grafana 里实现指标+日志联动
3. 给 Grafana 开启匿名访问 + SSO，方便团队查看

## 参考资料

1. [Micrometer 官方文档](https://micrometer.io/docs) —— 指标类型与 API 参考
2. [Spring Boot 3.x Actuator 生产就绪指南](https://docs.spring.io/spring-boot/docs/current/reference/html/actuator.html) —— 官方对生产配置的建议
3. [Prometheus 官方文档 — Best Practices](https://prometheus.io/docs/practices/) —— 命名规范、标签设计、告警原则
4. [Grafana 文档 — Build a dashboard](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/) —— 面板配置参考
5. [Robust Perception — Prometheus Querying 101](https://www.robustperception.io/prometheus-querying-101) —— PromQL 入门最佳教程之一
6. [阿里云可观测性团队 — Prometheus 标签设计最佳实践](https://help.aliyun.com/document_detail/353409.html) —— 中文视角的 cardinality 问题分析
7. [Prometheus: Monitoring & Alerting toolkit (v2.51.0)](https://github.com/prometheus/prometheus) —— GitHub 仓库，issue 区有很多实战讨论
8. [Spring Boot 3.x Micrometer 自动配置原理](https://docs.spring.io/spring-boot/docs/current/reference/html/actuator.html#actuator.metrics.export.prometheus) —— 自动配置了哪些指标、怎么定制
