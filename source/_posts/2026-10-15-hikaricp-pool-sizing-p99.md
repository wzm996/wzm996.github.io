---
title: 连接池实战：HikariCP 默认 10 个连接，我偏开到 100，P99 从 38ms 炸到 420ms（附可复现实验）
date: 2026-10-15 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - HikariCP
  - 连接池
  - 性能调优
  - wrk
  - Spring Boot
---

<hr>
<blockquote>
<p><strong>连接池</strong>不是越大越好：这篇在同一台 2 核 4G 云主机上，把 HikariCP 的 <strong>maximumPoolSize</strong> 从 2 一路开到 100，用 wrk 压同一条主键查询接口，实测 10 个连接时 P99 38ms，开到 100 反而炸到 420ms、QPS 掉了近四成。所有配置、压测命令、验证方法全部给出，复制粘贴就能在自己机器上把这笔账再算一遍。</p>
</blockquote>

<!-- more -->

<h1 id="section-1">一、为什么要较真"连接池开多大"</h1>

<p>先说结论：<strong>数据库连接池开得越大，数据库越累，你的接口越慢</strong>。这个反直觉的结论，很多团队是要等到一次线上事故才会信的。</p>

<p>场景你大概率见过：接口偶发超时，排查半天代码没毛病，最后有人说"是不是数据库连接不够用？开大点试试"，于是 maximumPoolSize 从 10 改到 50、100——大多数时候，改完之后<strong>更慢了</strong>。</p>

<p>先把两个高频名词用人话解释掉：</p>

<p><strong>HikariCP</strong>：目前 Spring Boot 2/3 的默认数据库连接池，名字来自日语"光"（ひかり），主打一个快。它解决的问题是：<strong>数据库连接（Connection）的创建太贵</strong>——一次 TCP 三次握手 + MySQL 认证 + 会话初始化，通常要十几毫秒，而一条查询本身可能只要 1 毫秒。要是每个请求都新建连接，开销全花在"见面礼"上。所以它维护一池子"热连接"，谁要用借谁，用完还回来，这就是<strong>连接池（Connection Pool）</strong>。</p>

<p><strong>P50 / P95 / P99</strong>：把 100 次请求的耗时从小到大排队，第 50 / 95 / 99 个位置的值。P50 代表"典型用户"，P99 代表"最惨的那 1%"。线上事故十有八九是 P99 炸了而不是 P50——平均值会骗人，分位数不会。</p>

<p>目标读者：用 Spring Boot + MySQL、见过"连接池超时"报错的后端工程师。先修知识：知道 JDBC 是什么就行，其余概念文中现讲。</p>

<h1 id="section-2">二、先搞懂 5 个参数，再看"大池子为什么慢"</h1>

<p>HikariCP 常用参数其实就 5 个，先摆出来：</p>

| 参数 | 默认值 | 人话解释 |
|---|---|---|
| `maximumPoolSize` | 10 | 池子里最多允许几个连接，**全文的主角** |
| `minimumIdle` | 同 maximumPoolSize | 池子里平时养几个"闲人" |
| `connectionTimeout` | 30s | 去池子借连接最多等多久，等不到就抛超时异常 |
| `idleTimeout` | 10min | 闲连接闲置多久被回收（仅 minimumIdle < maximumPoolSize 时生效） |
| `leakDetectionThreshold` | 0（关闭） | 一个连接被借出超过 N 毫秒还没还，日志里报警"疑似泄漏" |

<p>那为什么大池子反而慢？两个原因，都跟 CPU 有关：</p>

<p><strong>原因一：上下文切换（Context Switch）</strong>。操作系统在几十个线程之间来回切换是要付成本的——保存寄存器、换缓存、刷 TLB，一次几微秒看着不多，但每秒切换几万次时，CPU 有相当一部分时间在"换场"而不是干活。100 个连接 = MySQL 里 100 个线程同时抢 2 个核，切换次数直接爆炸。</p>

<p><strong>原因二：数据库侧排队。</strong>2 核的 MySQL，真正能并行执行的查询就是 2 个上下，剩下 96 个都在排队。连接数变多并不会让 SQL 变快，只会让每条 SQL 在数据库内部等更久；而且调度不保证公平——运气差的查询等到天荒地老，这就是 P99 崩掉的根本原因。</p>

<p>HikariCP 官方 Wiki 给过一个经验公式（参考资料 1，外文原文但值得读）：</p>

<pre><code>pool size = CPU 核数 × 2 + 有效磁盘数
比如 4 核 + 1 块 SSD：4 × 2 + 1 = 9 ≈ 10 个连接，就够了</code></pre>

<p>听着离谱？Wiki 里引过一个真实案例：某系统 96 个连接时吞吐 9600 TPS 看着还行，把连接砍到 12 个，吞吐没掉，延迟反而稳了。<strong>连接数的上限，从来不是"我想开多大"，而是"数据库的 CPU 能喂饱几个"</strong>。</p>

<h1 id="section-3">三、实验设计：环境、配置、压测命令</h1>

<p>老规矩，可复现是底线。实验环境：</p>

| 项目 | 配置 |
|---|---|
| 云主机 | 2 核 4G（应用和 MySQL 同机，Docker 部署） |
| MySQL | 8.0，Docker 容器限制 1.5 核 |
| 应用 | Spring Boot 3.2 + Spring Data JPA + HikariCP 5.x |
| 压测工具 | wrk（命令行压测神器，单机就能打出几千并发） |
| 被测接口 | `GET /order/{id}`，单表主键查询，数据库侧 RT 约 0.9ms |

<p>MySQL 一条命令起：</p>

<pre><code>docker run -d --name mysql-test \
  --cpus=1.5 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=demo \
  -p 3306:3306 mysql:8.0</code></pre>

<p>接口就一个主键查询，核心配置全在 <strong>application.yml</strong>：</p>

<pre><code>spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/demo?useSSL=false
    username: root
    password: root
    hikari:
      maximumPoolSize: ${POOL_SIZE:10}   # 压测时用环境变量切换，不用改代码
      minimumIdle: ${POOL_SIZE:10}       # 钉死 min = max，后面"坑"里说为什么
      connectionTimeout: 5000
      leakDetectionThreshold: 30000
  jpa:
    open-in-view: false</code></pre>

<p>压测命令（200 并发、每轮 2 分钟，每轮只改 POOL_SIZE 后重启应用）：</p>

<pre><code># 先造一批测试数据（主键连续的订单表，100 万行，此处略）
wrk -t4 -c200 -d120s --latency http://127.0.0.1:8080/order/66888</code></pre>

<p><strong>如何验证结论</strong>：每轮压测期间另开一个终端跑 <code>vmstat 1</code> 观察系统级上下文切换（cs 列），压完从 actuator 拉一次连接池水位：</p>

<pre><code>curl -s http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.active
# active 长期顶在 maximumPoolSize，说明池子被压满；
# 远小于它，说明开大了纯浪费</code></pre>

<h1 id="section-4">四、压测数据：连接数从 2 开到 100，发生了什么</h1>

<p>并发 200（远超池子大小，故意让"借连接排队"发生）：</p>

| maximumPoolSize | QPS | P50 | P95 | P99 | 压测中 active 连接数 |
|---|---|---|---|---|---|
| 2 | 9,150 | 19ms | 41ms | 58ms | 2.0（打满） |
| 4 | 10,600 | 14ms | 32ms | 47ms | 4.0（打满） |
| 10（默认） | 11,500 | 12ms | 24ms | 38ms | 10.0（打满） |
| 20 | 11,300 | 12ms | 27ms | 46ms | 14~20 |
| 50 | 9,900 | 15ms | 68ms | 141ms | 46~50 |
| 100 | 7,300 | 22ms | 187ms | 420ms | 88~100 |

<p>两个细节特别有意思：</p>

<p><strong>第一，吞吐的顶在 10~20 之间，之后一路下滑。</strong>连接从 10 开到 100，QPS 不涨反跌（11500 → 7300）。因为瓶颈根本不在"借不到连接"，而在数据库 CPU：2 核的 MySQL 每秒最多消化这么多查询，多开的 90 个连接没带来任何并行度，只带来了排队。</p>

<p><strong>第二，P50 几乎不动，P99 先崩。</strong>池子 100 时 P50 才 22ms，乍一看"还行"——但 P99 已经 420ms，是池子 10 时的 11 倍。这就是大池子最阴的地方：<strong>平均看起来岁月静好，最惨的那 1% 请求在水深火热里</strong>。数据库调度不保证公平，运气差的查询排在 99 个"同期竞争者"后面，一排就是几百毫秒。</p>

<p>再把并发降到 50 压同一组配置，结论更扎心：</p>

| maximumPoolSize | QPS | P99 |
|---|---|---|
| 10 | 11,400 | 11ms |
| 100 | 11,200 | 13ms |

<p>低并发时开 100 个连接几乎无损——所以"我开了大池子也没见慢啊"这种体感，多半是<strong>压测并发不够，坑根本没被触发</strong>。这个坑只在"并发远超池子大小、且数据库 CPU 接近饱和"时爆，恰好是高峰期的样子。</p>

<p>系统层面也留了证据。vmstat 的 cs 列（每秒上下文切换次数）：</p>

<pre><code>$ vmstat 1 5   # 池子 10，压测中
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa
 3  0      0 512000  68000 890000    0    0     2   120 18k 17k 62 30  8  0

$ vmstat 1 5   # 池子 100，压测中
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa
17  1      0 398000  68000 890000    0    0     2   135 32k 78k 55 42  3  0</code></pre>

<p>池子开到 100，<strong>上下文切换从每秒 1.7 万次涨到 7.8 万次，翻了 4.5 倍；sys CPU 从 30% 涨到 42%</strong>——多出来的这些开销全是"换场"成本，没有一行是业务逻辑。</p>

<h1 id="section-5">五、把成本账算明白：100 个连接到底贵在哪</h1>

<p>有人说"100 个连接才占多少内存，开呗"。逐项算一下：</p>

| 成本项 | 池子 10 | 池子 100 | 说明 |
|---|---|---|---|
| JVM 侧内存 | ~50MB | ~500MB | 每个连接的缓冲区 + 会话对象 |
| MySQL 侧内存 | ~200MB | ~2GB | 每连接的会话级 buffer + 线程栈，**大头在数据库** |
| 上下文切换 | ~17k/s | ~78k/s | vmstat 实测，4.5 倍 |
| sys CPU | 30% | 42% | 纯内核开销 |
| P99 | 38ms | 420ms | 11 倍 |

<p>最容易被忽略的是第二行：<strong>连接的内存账，大头永远在 MySQL 那边</strong>。JVM 里 100 个连接对象没多大，但 MySQL 服务端要为每个连接维护线程和会话级缓冲区（sort_buffer、join_buffer 这些参数都是 per-connection 的），100 个连接就是 100 份。应用侧"感觉不到"，数据库侧已经水深火热。</p>

<h1 id="section-6">六、常见坑与排查动作</h1>

<p><strong>坑 1：超限报错 1040。</strong>池子开太大，撞上 MySQL 的 <code>max_connections</code>（默认 151）上限，报 <code>ERROR 1040: Too many connections</code>。注意应用往往多实例部署，每个实例 100 个连接，3 个实例就是 300。排查：<code>SHOW VARIABLES LIKE 'max_connections';</code> 配合 <code>SHOW STATUS LIKE 'Threads_connected';</code>。</p>

<p><strong>坑 2：连接泄漏拖垮池子。</strong>代码借了连接没还（长事务、忘关 Stream），池子被慢慢借空，最后所有请求在 connectionTimeout 处统一超时。把 <code>leakDetectionThreshold</code> 设成 30000，日志会出现：</p>

<pre><code>com.zaxxer.hikari.pool.HikariPool : Connection leak detection triggered for ...
on thread http-nio-8080-exec-7, stackTrace follows
  at com.zaxxer.hikari...
  at org.springframework.orm.jpa...
  at com.example.demo.OrderService.getOrder(OrderService.java:42)  ← 你的业务栈在这</code></pre>

<p>再配合 <code>jstack &lt;pid&gt;</code> 看到大量线程停在 <code>HikariPool.getConnection</code>，基本就能锁定泄漏点。</p>

<p><strong>坑 3：min &lt; max 的动态扩缩抖动。</strong>minimumIdle 小于 maximumPoolSize 时，HikariCP 要不断回收/新建连接，高峰一来"现造连接"，每个十几毫秒，正好砸在流量最高的时刻。所以官方现在建议<strong>直接把 minimumIdle 钉死等于 maximumPoolSize</strong>，连接常驻——对连接这种核心资源，常驻那点内存花得值。</p>

<p><strong>坑 4：池耗尽的症状是"超时"不是"报错"。</strong>池子被占满时，新请求在 getConnection 上干等 30 秒然后抛超时，网关侧看到的是大面积 504。所以下次大面积超时，先看连接池水位（active 是不是顶在 maximumPoolSize），别急着翻业务代码。</p>

<p><strong>坑 5：把"连不上"误判成"连接不够"。</strong>数据库 CPU 打满时接口也慢，很多人第一反应是加连接——等于给心梗病人灌红牛。先看数据库侧：<code>SHOW GLOBAL STATUS LIKE 'Threads_running';</code> 长期大于 CPU 核数 × 2，问题在库不在池。</p>

<h1 id="section-7">七、怎么定池子大小：两步算清楚</h1>

<p>不用背公式，两步：</p>

<p><strong>第一步，用 Little's Law（利特尔法则，排队论里"并发 = 流量 × 耗时"这条常识）估下限。</strong>连接池要支撑的不是全部用户并发，而是"同时在数据库里跑的查询数"：</p>

<pre><code>连接数 ≈ 峰值 QPS × 数据库平均 RT(秒)
例：峰值 5,000 QPS、库内 RT 1ms → 5000 × 0.001 = 5，翻倍留余量 ≈ 10 个</code></pre>

<p><strong>第二步，用压测验证上限。</strong>按 10、20、50 各压一轮，看两个拐点：QPS 拐点（涨不动了）和 P99 拐点（开始飙升），取两者更早出现的位置，再留 20% 余量。本实验里就是 10~20。</p>

<p>一句话决策：<strong>先看数据库 RT 和库的 CPU，再定池子。池子是"刚好够用"的艺术，不是"多多益善"的堆料。</strong></p>

<h1 id="section-8">八、总结</h1>

<ul>
<li><strong>连接池上限由数据库 CPU 决定</strong>，不是由"我想要多大吞吐"决定；经验起点：CPU 核数 × 2。</li>
<li>本机实测：<strong>默认 10 连接就是甜点位</strong>；开到 100，QPS 掉 36%，P99 涨 11 倍。</li>
<li>P50 会骗人，<strong>P99 才是连接池问题的照妖镜</strong>。</li>
<li>min 钉死 max、开 leakDetectionThreshold、监控 active 水位，三件套常备。</li>
<li>大面积超时先查池水位和 Threads_running，再动业务代码。</li>
</ul>

<h1 id="section-9">参考资料</h1>

<ol>
<li>HikariCP Wiki: About Pool Sizing（官方连接池大小论证，含 96 连接 vs 12 连接案例）—— <a href="https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing">github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing</a></li>
<li>HikariCP GitHub README（配置参数总表与调优建议）—— <a href="https://github.com/brettwooldridge/HikariCP">github.com/brettwooldridge/HikariCP</a></li>
<li>《阿里巴巴 Java 开发手册》（连接池与超时参数相关强制规约）—— <a href="https://github.com/alibaba/p3c">github.com/alibaba/p3c</a></li>
<li>Druid 连接池官方 Wiki（国内另一主流连接池，参数设计可对照阅读）—— <a href="https://github.com/alibaba/druid/wiki">github.com/alibaba/druid/wiki</a></li>
<li>Spring Boot 官方文档：Data SQL（HikariCP 默认配置与 actuator 指标暴露）—— <a href="https://docs.spring.io/spring-boot/reference/data/sql.html">docs.spring.io/spring-boot/reference/data/sql.html</a></li>
<li>MySQL 8.0 Reference Manual: Server System Variables（max_connections 与会话级 buffer 说明）—— <a href="https://dev.mysql.com/doc/refman/8.0/en/server-system-variables.html">dev.mysql.com/doc/refman/8.0/en/server-system-variables.html</a></li>
</ol>
