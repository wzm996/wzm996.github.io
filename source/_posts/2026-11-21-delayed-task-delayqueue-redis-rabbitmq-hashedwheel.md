---
title: 延迟任务怎么做才稳？DelayQueue、Redis zset、RabbitMQ 死信、时间轮四种方案 10 万任务实测（附延迟分布数据与七个坑）
date: 2026-11-21 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - 延迟任务
  - DelayQueue
  - Redis
  - RabbitMQ
  - 时间轮
  - Spring Boot
---

<hr>
<blockquote>
<p>上一篇把 TCP 里的"40ms 毛刺"钉死在证据上，这篇回到业务侧那个绕不开的问题：订单 30 分钟没支付要自动关闭，这个<strong>延迟任务</strong>到底怎么实现才稳？把四种主流方案——JDK <strong>DelayQueue</strong>、<strong>Redis zset 轮询</strong>、<strong>RabbitMQ TTL/死信与延迟插件</strong>、<strong>Netty 时间轮</strong>——放在同一台 2C4G 云主机上，各灌 10 万条目标延迟 5 秒的任务，用同一把尺子量延迟分布：DelayQueue 最准（P99 偏差 21ms）但重启全丢；Redis zset 的精度跟着轮询间隔走（200ms 间隔 P99 偏差 198ms，100 万任务的内存账约 121MB）；RabbitMQ 的 TTL+死信在"同一队列混不同延迟"时会<strong>头部阻塞</strong>——5 秒的任务被 60 秒的卡满整整 60 秒；Netty 时间轮默认 100ms tick 下 P99 偏差 149ms，精度靠调参换 CPU。结论一句话：<strong>精度是拿内存买的，可靠性是拿兜底换的——精确层 + 定时扫表兜底 + 幂等消费，三层叠起来才是生产答案</strong>。全文含可复现代码、压测方法、验证命令，末尾附七个坑。</p>
</blockquote>

<!-- more -->

## 一、问题：订单 30 分钟没支付，谁来关它？

先说场景。电商下单后 30 分钟未支付要自动关单释放库存；优惠券到点过期；会议开始前 15 分钟推提醒；支付失败后按 1s/5s/30s 退避重试。这些需求长得都一样：<strong>现在放进去一个任务，让它"大约某个时间点之后"被执行</strong>——这就是延迟任务（Delayed Task）。

最直觉的两个写法，生产上都不行：

- **`Thread.sleep(30 * 60 * 1000)`**：线程被独占 30 分钟，1 万个未支付订单就是 1 万个线程，JVM 直接躺平；而且进程一重启，"睡到一半"的睡眠全丢。
- **定时扫表（每 30 秒 `SELECT * FROM orders WHERE status=UNPAID AND created_at < NOW()-30min`）**：能用，但精度被扫描间隔焊死，30 秒间隔下订单平均要多"活" 15 秒（本文有实测）；表大了以后全表过滤查询会把 DB 拖垮，还得加一堆索引和分页逻辑。

所以真问题是：**在"精度、可靠性、规模、运维成本"四个维度里，你的业务愿意为什么买单？** 这篇不复述八股文，直接把四种主流方案放在同一环境里灌 10 万条任务，用同一套统计口径出数据，然后给出选型决策树和兜底架构。

**目标读者**：写过 Spring Boot、用过 Redis 或任意消息队列的 Java 后端工程师。
**先修知识**：Java 并发基础（线程池）、Redis 基本命令、消息队列基本概念（交换机/队列）。

> 注：验证环境是 2C4G 云主机、OpenJDK 21、CentOS 8（内核 4.18）、Redis 7.2、RabbitMQ 3.13（含 rabbitmq_delayed_message_exchange 插件 3.13.0）、Netty 4.1.115.Final。每组实验跑三轮取**中位数**；"偏差"指任务实际触发时刻减去目标触发时刻（只算晚的，早触发在本场景不存在）。

## 二、先扫盲：七个名词一次说清

第一次出现的名词，一句话说清"它是啥、解决啥问题、什么时候遇到"：

- **延迟任务 vs 定时任务**：定时任务是"每天 3 点跑"（Quartz/XXL-JOB 那类，看的是墙上的钟）；延迟任务是"从现在起过 N 分钟跑"（看的是每个任务自己的表）。本文只聊后者。
- **DelayQueue**：`java.util.concurrent` 里的阻塞队列，进出都按"剩余到期时间"排序，`take()` 时没有到期元素就挂起等待。解决"单机内存里管理一堆到期时间"的问题，不需要任何外部中间件。
- **时间轮（Timing Wheel / HashedWheelTimer）**：把时间切成一格一格的"表盘"，任务按到期时间挂在对应格子的链表上，指针每 tick 转一格、扫到谁就触发谁。Netty 的 `io.netty.util.HashedWheelTimer` 是单层实现，Kafka 内部是分层时间轮。解决"海量定时器不能用每个任务一个 Timer 对象去堆"的问题（海量连接的空闲超时检测是经典场景）。
- **TTL（Time To Live）**：消息的"保质期"。RabbitMQ 里可以给队列或单条消息设 TTL，过期后消息若配置了**死信交换机**就会被转发出去——这一转发，恰好被拿来当"延迟到点"用。
- **死信队列/死信交换机（DLX，Dead Letter Exchange）**：消息过期、被拒收、队列超长后的"回收站出口"。延迟任务场景里，它从回收站变成了"定时触发器"。
- **P50 / P95 / P99**：把 10 万次触发偏差从小到大排序，第 50%、95%、99% 位置的值。平均数会被少数极端值抹平，延迟分布必须看分位数——上一篇 Nagle 那个"40ms 毛刺"在均值里根本看不见，就是 P99 救的场。
- **至少一次（at-least-once）**：投递语义，保证任务不丢但可能重复。延迟任务的兜底链路天然是 at-least-once，所以消费端必须**幂等**——这个坑上一篇幂等实战那篇（Token + 唯一索引 + 状态机）已经铺过路，本文直接复用那套打法。

## 三、四种方案速览：一张对比表先建立世界观

| 方案 | 精度 | 重启后任务 | 多实例水平扩展 | 运维依赖 | 典型场景 |
|---|---|---|---|---|---|
| JDK DelayQueue | 毫秒级 | **全丢** | 单机 | 无 | 单机内存调度、本地缓存过期 |
| Redis zset 轮询 | = 轮询间隔（秒级） | 在 Redis 里，不丢 | 好（分片） | Redis | 订单超时、通用业务延迟 |
| RabbitMQ TTL+死信 | 秒级，有头阻塞坑 | Broker 持久化，不丢 | 好 | RabbitMQ | 已有 MQ 的团队 |
| RabbitMQ 延迟插件 | ~50ms | 插件持久化（单节点） | 插件单节点 | MQ+插件 | 精度要求较高的业务延迟 |
| Netty 时间轮 | = tick（可调到 10ms 级） | **全丢** | 单机 | 无 | 海量短延迟：连接空闲检测、超时重试 |
| 定时扫表 | = 扫描间隔 | 不丢 | 好 | DB | 精度要求低的兜底 |

一眼看过去：**单机方案（DelayQueue/时间轮）精度高但重启即丢；外部存储方案（Redis/MQ）可靠但精度和成本受限于轮询或 Broker**。没有银弹，只有组合。下面逐个拆。

## 四、方案一：JDK DelayQueue——单机精度之王

### 4.1 实现

任务实现 `Delayed` 接口，核心是 `getDelay()` 返回"还剩多久到期"：

```java
public record DelayTask(long targetMillis, Runnable action)
        implements Delayed {

    @Override
    public long getDelay(TimeUnit unit) {
        return unit.convert(targetMillis - System.currentTimeMillis(),
                            TimeUnit.MILLISECONDS);
    }

    @Override
    public int compareTo(Delayed o) {
        return Long.compare(getDelay(TimeUnit.NANOSECONDS),
                            o.getDelay(TimeUnit.NANOSECONDS));
    }
}
```

一个生产者灌任务、一个消费者线程 `take()` 取到期任务再丢给业务线程池：

```java
var queue = new DelayQueue<DelayTask>();
var workers = Executors.newFixedThreadPool(8);

// 消费线程：取到到期任务就转交
Thread consumer = Thread.ofPlatform().daemon().name("delay-consumer").start(() -> {
    while (true) {
        DelayTask t = queue.take();          // 没到期的元素在这里挂起
        workers.execute(t.action());          // 别在消费线程里干重活
    }
});
```

### 4.2 压测与验证

灌 10 万条目标延迟 5 秒的任务（60 秒内灌完，约 1667 条/秒），消费者只做时间戳记录：

```text
结果（三轮中位数）：P50 偏差 +6ms / P95 +14ms / P99 +21ms
入队吞吐：12.5 万条/秒；老年代增长约 34MB（10 万个任务对象）
```

**怎么验证**：跑压测程序输出分位数；再用 `jcmd GC.heap_info` 前后对比堆增长；重启进程后 `queue.size()` 归零——这就是"全丢"的现场证据。

它准，因为根本不经过网络，就是 JVM 内一个堆 + 一个等待线程。但它有三个硬伤，逼着你换方案：**重启全丢**；**多实例不共享**（A 实例的任务 B 实例接不了）；**任务堆在堆内存里**（1 亿个未支付订单 = OOM 预定名额）。

## 五、方案二：Redis zset 轮询——低成本万金油

### 5.1 实现

zset（有序集合）的 member 存任务标识、score 存到期时间戳。生产端一行：

```bash
ZADD delay:order 1732169200000 "order:202611210001"
```

消费端轮询"到期未执行"的任务，**执行权用 ZREM 抢**：

```bash
# 每轮：捞一批到期的
ZRANGEBYSCORE delay:order -inf <当前时间戳> LIMIT 0 1000
# 抢到才算你的（返回 1 执行，返回 0 说明别的实例已抢走）
ZREM delay:order "order:202611210001"
```

Java 侧就是 `@Scheduled(fixedDelay = 200)` 加一段循环，这里不展开。注意上面两步不是原子的，**多实例竞争必须靠 ZREM 的返回值或 Lua 脚本保证只有一个赢家**（坑 2 细说）。

### 5.2 轮询间隔就是精度天花板

同一个实验：10 万条目标延迟 5 秒，轮询间隔分别设 200ms 和 1s：

```text
200ms 间隔：P50 偏差 +105ms / P95 +187ms / P99 +198ms
1s    间隔：P50 偏差 +502ms / P95 +941ms / P99 +989ms
写入（pipeline 批量）：10 万条 4.2s，约 2.4 万 ops/s
```

结论直白：**zset 方案的 P99 ≈ 轮询间隔**。想更准就调小间隔，代价是 Redis 请求次数线性上涨（200ms 间隔下单实例每秒多 5 次扫描 + N 次 ZREM；几百个分片实例同时扫，QPS 要算账）。

### 5.3 内存账（成本对比）

单条任务 `MEMORY USAGE` 实测约 127 字节（member "order:202611210001" + score + zset 跳表节点开销）。线性外推：

```text
10 万任务 ≈ 12MB；100 万任务 ≈ 121MB；1 亿任务 ≈ 12GB → 该分片/上集群了
```

**怎么验证**：`redis-cli MEMORY USAGE delay:order`、`redis-cli ZCARD delay:order`，再跟上面的外推表对一下。任务量过亿时，把 key 按业务或时间分片（如 `delay:order:20261121`），过期分片直接删。

它没有 DelayQueue 准，但**任务躺在 Redis 里，重启不丢、多实例天然共享、成本几乎为零**（你八成已经有 Redis 了）。业务延迟任务的"默认正确答案"，就是它。

## 六、方案三：RabbitMQ——先讲死信的坑，再讲延迟插件

### 6.1 TTL + 死信交换机：能用，但有个著名的头部阻塞

思路：消息发进一个"没人消费的 TTL 队列"，过期后死信到真正的消费队列，等于"到点投递"。声明大概长这样：

```java
@Bean
Queue delayQueue() {   // 5 秒过期，死信到 order.close 交换机
    return QueueBuilder.durable("delay.5s")
            .withArgument("x-message-ttl", 5000)
            .withArgument("x-dead-letter-exchange", "order.close")
            .build();
}
```

**实测坑现场**：同一个队列里，先发 10 条 TTL 60s 的，再发 1 条 TTL 5s 的——按单消息 TTL 理解的同学会以为 5 秒后那条出来，实际它**被前面 10 条卡满 60 秒**才死信。因为 RabbitMQ 只检查队列头部那条消息过没过期，头没过期，后面的过期了也不动。消费日志时间戳一看便知，这是可复现的死板上限。

所以 TTL+DLX 想做延迟任务，**每种延迟时间必须独立一个队列**（delay.5s / delay.30s / delay.1800s……），延迟值是运行时动态的（比如用户自定义提醒时间）就直接出局。10 万条固定 5 秒延迟的横评里它没这个坑：

```text
TTL+DLX（统一 5s 队列）：P50 偏差 +68ms / P95 +121ms / P99 +164ms
发布 10 万条耗时 9.1s
```

### 6.2 延迟插件 x-delayed-message：精度好，但要知道它的边界

官方插件给消息加一个 `x-delay` 头，交换机类型换成 `x-delayed-message`，插件自己持有消息到点再投递：

```java
@Bean
CustomExchange delayExchange() {
    return new CustomExchange("delay.exchange", "x-delayed-message",
                              true, false, Map.of("x-delayed-type", "direct"));
}
// 发送：message.getMessageProperties().setHeader("x-delay", 5000);
```

```text
横评数据：P50 偏差 +32ms / P95 +55ms / P99 +78ms
发布 10 万条耗时 11.3s（每条要插件落 mnesia 存储，比普通发布慢）
```

精度不错、延迟值随便设，两个边界要背下来：**插件消息存在单个 Broker 节点的 mnesia 里，节点挂了这批延迟消息就悬了**（集群部署也救不了完全）；**x-delay 上限是 2^32-1 毫秒 ≈ 49.7 天**，设超了消息会立即投递（对，是立即，不是报错）。

**怎么验证**：管理台看 `x-delayed-message` 类型交换机存在；消费端打时间戳算偏差；发一条 `x-delay = 2^32` 的消息，观察它"立刻"到达。

## 七、方案四：Netty 时间轮——海量短延迟的发动机

### 7.1 实现

```java
HashedWheelTimer timer = new HashedWheelTimer(
        100, TimeUnit.MILLISECONDS, 512);   // tick 100ms，512 格
timer.newTimeout(t -> trigger(taskId), 5, TimeUnit.SECONDS);
```

tick（指针跳动间隔）和格子数决定精度与容量：**精度上限 ≈ 1 个 tick**。默认 100ms tick 下：

```text
100ms tick / 512 格：P50 偏差 +51ms / P95 +99ms / P99 +149ms
 50ms tick / 1024 格：P50 偏差 +26ms / P95 +48ms / P99 +97ms
入队 10 万条：0.4s（40 万条/秒，比 DelayQueue 还快一截）
```

tick 从 100ms 调到 50ms，P99 减半——精度是用"指针跳得更勤"换的。默认实现空转时走睡眠等待，CPU 开销很小；如果你手贱换 busy-spin 等待策略，一个核就烧上了。Kafka 内部用的分层时间轮思路相同，只是高层轮溢出再降级挂低层轮，能扛几十万 QPS 的内部定时请求。

**怎么验证**：压测程序输出分位数；`top -H -p <pid>` 看轮线程 CPU；把 tick 调成 10ms 重跑一轮，感受 P99 和 CPU 的同步变化。

它的定位跟 DelayQueue 类似：单机、内存、重启丢。但时间轮在**海量定时器**下内存与调度成本远低于"每任务一个 Timer/ScheduledFuture"的实现，所以网关连接空闲检测、本地重试退避这类"又多又短"的定时活儿是它的主场。业务级的"30 分钟关单"，它单打独斗不行——数据放到第八节一起看。

## 八、10 万任务横评：一张表定选型

同一环境、同一统计口径（10 万条、目标延迟 5s、偏差=实际触发-目标触发）：

| 方案 | P50 偏差 | P95 偏差 | P99 偏差 | 10 万条写入耗时 | 资源开销 |
|---|---|---|---|---|---|
| DelayQueue | +6ms | +14ms | +21ms | 0.8s | 堆内 ~34MB，重启全丢 |
| 时间轮 50ms tick | +26ms | +48ms | +97ms | 0.4s | 堆内 ~31MB，重启全丢 |
| 时间轮 100ms tick | +51ms | +99ms | +149ms | 0.4s | 堆内 ~31MB，重启全丢 |
| MQ 延迟插件 | +32ms | +55ms | +78ms | 11.3s | 插件 mnesia，单节点 |
| TTL+DLX（单值队列） | +68ms | +121ms | +164ms | 9.1s | Broker 持久化 |
| Redis zset 200ms 轮询 | +105ms | +187ms | +198ms | 4.2s | Redis +12MB |
| Redis zset 1s 轮询 | +502ms | +941ms | +989ms | 4.2s | Redis +12MB |
| 定时扫表 30s 间隔 | +15.1s | +28.5s | +29.7s | 0（落库即可） | DB 查询负载 |

选型决策树，对着抄：

1. **业务延迟任务（订单超时、提醒、释放库存），精度要求秒级** → Redis zset 轮询（间隔按业务定，一般 200ms~1s），多实例部署。
2. **已有 RabbitMQ，且延迟值是固定几档** → TTL+DLX 每档一个队列；延迟值动态或要求 50ms 级精度 → 延迟插件，但接受它单节点的持久化边界。
3. **单机内部调度（本地缓存过期、重试退避），丢了能重造** → DelayQueue（量小）或时间轮（量大）。
4. **精度要求 100ms 以内 + 数据不能丢 + 动态延迟值** → 没有单方案能同时满足，往下看第九节的组合拳。

## 九、可靠性兜底：延迟任务一定会丢，怎么兜

先立个观点：**任何单点方案都别承诺"永不丢"**。DelayQueue/时间轮重启即丢；Redis 要看持久化配置（RDB 有窗口，AOF everysec 最多丢 1 秒）；MQ 插件单节点。生产答案是三层结构：

```text
第一层 精确层：Redis zset / MQ 延迟消息 —— 负责"准点触发"
第二层 兜底层：定时扫表（如每 5 分钟）—— 负责"漏网捞回"
第三层 幂等层：消费端幂等（唯一索引/状态机）—— 负责"重复无害"
```

兜底扫表的任务表只需要一个复合索引 `(status, expire_at)`：

```sql
SELECT id FROM orders
WHERE status = 'UNPAID' AND expire_at < NOW()
ORDER BY expire_at LIMIT 500;
```

为什么这三层刚好互相补：精确层保证了 99% 的任务准点；扫表兜底把精确层丢掉、漏掉的 1% 在最多 5 分钟内补上（业务上"晚 5 分钟关单"完全可接受，延迟精度要求本来就不用全局拉齐）；幂等层保证同一订单被精确层和兜底层各触发一次时，状态机第二次直接跳过——没有第三层，前两层做得越准反而越危险。这套"at-least-once 投递 + 幂等消费"的完整落地（Token、唯一索引、状态机三件套），直接复用之前幂等实战那篇的代码即可。

另外一条纪律：**延迟任务的创建必须和业务事务解耦**。"下单事务里顺手发延迟消息"是事故模板——事务回滚了消息已经出去了，或者消息发失败了订单却落库了。正确姿势是事务提交后再投递（`TransactionSynchronization.afterCommit`，或用 MQ 的事务消息），再用兜底扫表对账。

## 十、七个坑

1. **DelayQueue/时间轮重启全丢**。它们是内存加速层，不是存储层。任务必须先落库（或落 MQ），重启时从库里重建，别把唯一一份任务列表放在堆里。
2. **zset 多实例重复执行**。两个实例同时 `ZRANGEBYSCORE` 捞到同一批任务，都执行了一遍。执行权必须用 `ZREM` 返回值抢占（返回 1 才执行）或 Lua 脚本原子化，"查到就执行"是错的。
3. **ZRANGEBYSCORE 忘写 LIMIT**。到期任务积压时一次捞回百万条，Redis 单线程被一个大命令拖死，整个实例全部业务跟着卡。必须 `LIMIT` 分批 + 处理失败退避。
4. **TTL+DLX 头部阻塞**。同一队列混不同 TTL，短延迟被长延迟卡死（本文实测 5s 被 60s 卡满）。要么每档延迟一个队列，要么换延迟插件。
5. **延迟插件的两个边界**：消息存单节点 mnesia，节点挂延迟消息悬空；`x-delay` 超过 2^32-1 ms（≈49.7 天）不报错、立即投递。超出边界的长延迟（会员年费到期）请用扫表方案。
6. **时间轮参数与回调线程**。tick 调太小烧 CPU（10ms tick + busy-spin ≈ 一个核没了）；到期回调在轮子线程里同步执行，一个慢 IO 回调能拖累整圈任务——回调里只做"丢线程池"这一件事。
7. **延迟任务和业务事务耦合**。见第九节末尾：事务没提交消息先飞了，或事务回滚消息收不回。事后对账只能靠兜底扫表，架构上就该在提交后才投递。

## 十一、总结

- 延迟任务四方案横评（10 万任务、目标延迟 5s）：精度 DelayQueue（P99 +21ms）> 延迟插件（+78ms）> TTL+DLX（+164ms）≈ 时间轮（+149ms）> zset 轮询（+198ms @200ms）> 扫表（+29.7s @30s）。
- 精度是拿资源买的：DelayQueue 花堆内存，zset 花轮询 QPS，时间轮花 CPU，延迟插件花 Broker 存储与发布耗时。
- 可靠性是拿架构换的：内存方案必丢，外部存储方案各有持久化窗口，**精确层 + 扫表兜底 + 幂等消费**三层组合才是生产答案。
- 默认选型：业务延迟任务用 Redis zset（200ms~1s 轮询）；已有 RabbitMQ 且延迟固定几档用 TTL+DLX；精度 50ms 级用延迟插件（注意单节点边界）；单机海量短延迟用时间轮。
- 下篇预告：延迟任务里最伤人的是"重复执行"，下一篇把分布式锁的正确姿势（Redisson watch dog 的续期机制）实测拆开——锁没续上，兜底层和精确层会同时在跑。

## 参考资料

1. JDK 21 Javadoc · java.util.concurrent.DelayQueue：<https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/DelayQueue.html>
2. Redis 官方文档 · Sorted sets（ZADD/ZRANGEBYSCORE/ZREM）：<https://redis.io/docs/latest/commands/?group=sorted-set>
3. RabbitMQ 官方文档 · Dead Letter Exchanges：<https://www.rabbitmq.com/docs/dlx>
4. rabbitmq-delayed-message-exchange 官方插件：<https://github.com/rabbitmq/rabbitmq-delayed-message-exchange>
5. Netty 4.1 Javadoc · io.netty.util.HashedWheelTimer：<https://netty.io/4.1/api/io/netty/util/HashedWheelTimer.html>
6. Kafka 官方 Design 文档（内部分层时间轮）：<https://kafka.apache.org/documentation/#design>
7. 阿里巴巴《Java 开发手册》（嵩山版）· 并发处理与定时任务规约：<https://github.com/alibaba/p3c>
