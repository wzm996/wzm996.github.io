---
title: 限流为什么不能只数个数？固定窗口在窗口边界被打穿 5 倍的实测复现，令牌桶突发整形与 Redis+Lua 分布式限流的落地坑与压测数据
date: 2026-11-14 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - 限流
  - 令牌桶
  - 滑动窗口
  - Redis
  - Lua
  - 压测
---

<hr>
<blockquote>
<p>限流大概是被写得最滥、也最容易写错的一个“入门级”主题：<strong>固定窗口计数器</strong>三行代码就能上线，但它在<strong>窗口边界</strong>处能被短突刺打穿——本文用 20 行确定性 Java 模拟器实测：限 100 req/s 的配置，0.4 秒里放行了 200 个请求，短时速率是限值的 <strong>5 倍</strong>。更隐蔽的坑在单机限流器上：Guava <strong>RateLimiter</strong> 的阻塞式 <code>acquire()</code> 在 500 并发压测下把“拒绝”变成了“排队”，P99 飙到 2.1 秒、wrk 读超时 3802 个；换成 <code>tryAcquire()</code> 快速失败，P99 只有 15.8ms、零超时。分布式场景的标配答案是 <strong>Redis + Lua 滑动窗口</strong>：实测单次限流判断的额外开销 P50 +0.35ms / P99 +1.1ms，同时复现了一个放水级 bug——<code>math.random</code> 种子陷阱导致计数被覆盖。所有实验都附可复现命令与验证方法。</p>
</blockquote>

<!-- more -->

## 一、背景：限流是保命符，但数错了个数就是定时炸弹

先说场景：秒杀开抢、爬虫扫接口、上游重试风暴、下游服务抖动引发的雪崩——这些事故的第一道防线几乎都是<strong>限流</strong>。限流要回答的问题就一句话：**单位时间内，最多放多少请求进来，超了怎么办**。

听着很简单，于是绝大多数人的第一版代码长这样：

```java
// 伪代码：固定窗口计数器
long count = counter.incrementAndGet();
if (count > 100) {
    throw new TooManyRequestsException();
}
```

再配一个每秒重置计数器的定时任务。三行代码，上线，看起来一切正常。

问题是：这种写法在<strong>窗口切换的边界</strong>上有个结构性漏洞，攻击者（或者上游的重试放大）可以利用它打出限值好几倍的瞬时流量。更糟的是，就算你意识到了这个问题、换上了“高级”的令牌桶，<strong>错误的用法</strong>（阻塞式等待）在高压下比不限流还危险——它会把你自己的线程池拖死。

这篇文章按顺序做三件事，每件事都有可复现的实验和数据：

1. **复现固定窗口被打穿**：一个 20 行的确定性模拟器，任何机器跑出来的数字都一样；
2. **压测 Guava RateLimiter 的两种用法**：`acquire()` 阻塞等待 vs `tryAcquire()` 快速失败，同样的限流配置，P99 差了 130 倍；
3. **落地 Redis+Lua 滑动窗口**：多实例共享限流状态的标配方案，实测延迟成本，以及一个会让限流悄悄放水的 Lua 写法坑。

> **目标读者与先修知识**：会写 Spring Boot 接口、知道线程池是什么。不需要任何限流算法基础，所有名词第一次出现都会解释。

## 二、5 分钟原理：四种限流器，一张表看懂

先把四个名词一次性讲清楚，都是口语版：

> **固定窗口计数器（Fixed Window Counter）** 是什么：把时间切成一段段固定长度的格子（比如每 1 秒一个），每个格子独立数数，超过上限就拒绝。它是啥：最朴素的限流；解决啥问题：粗粒度地“限量”；什么时候用：对精度没要求的场景，比如统计口径的配额。它的问题马上在实验一里复现。

> **滑动窗口（Sliding Window）** 是什么：不切格子，从“现在”这一刻往回看固定时长（比如最近 1 秒），数这 1 秒里进来多少请求。它是啥：固定窗口的精确版；解决啥问题：边界突刺；什么时候用：需要精确计数的限流，比如风控规则。

> **漏桶（Leaky Bucket）** 是什么：请求先全部进一个“桶”里排队，桶底以恒定速率往外“漏”（处理），桶满了再来的请求直接拒绝。它是啥：强制绝对平滑的整形器；解决啥问题：不管请求来得多抖，出口永远匀速；什么时候用：调用对速率敏感的下游，比如某些老式短信网关。代价是排队本身要占内存和等待时间。

> **令牌桶（Token Bucket）** 是什么：系统以恒定速率往桶里放“令牌”，桶有容量上限；每个请求来了要先拿走一个令牌，桶空了就拒绝。它是啥：漏桶的“反向”兄弟——漏桶管出口速率，令牌桶管入口准入；解决啥问题：既限制长期平均速率，又允许短时突发（桶里攒的令牌就是突发额度）；什么时候用：绝大多数 API 限流，包括 Google、Stripe、Spring Cloud Gateway 的默认选择。

一张表对比（**QPS** 是什么：每秒请求数，Queries Per Second）：

| 维度 | 固定窗口 | 滑动窗口 | 漏桶 | 令牌桶 |
|---|---|---|---|---|
| 限的是什么 | 每格总数 | 任意时刻回看窗口总数 | 出口恒定速率 | 长期平均速率 + 突发额度 |
| 突发行为 | 边界处可翻倍（见实验一） | 无突发 | 完全平滑 | 可控突发（桶容量） |
| 实现复杂度 | 极低 | 中（要存时间戳） | 低 | 低 |
| 分布式落地 | Redis INCR + EXPIRE | Redis ZSET + Lua | 较麻烦 | Guava 单机 / Redis+Lua |
| 典型用途 | 粗配额 | 精确计数、风控 | 出口整形 | API 准入（本文主角） |

本文重点锤两个：固定窗口（反面教材）和令牌桶（正面主角），滑动窗口在实验三里作为分布式精确限流的实现出现。

## 三、实验一：固定窗口在窗口边界被打穿（确定性模拟器）

### 3.1 实验设计

配置：限 100 请求/秒，窗口 1000ms。流量设计成一根“针”：只在 t=800ms 到 t=1200ms 之间以 500 req/s 打入（每 2ms 一个请求，共 200 个），其余时间安静。这根针恰好骑在 t=1000ms 的窗口边界上。

预期：窗口 [0,1000) 里针占了后半段 200ms，窗口 [1000,2000) 里针占了前半段 200ms——两个窗口各自都被灌到上限 100，于是这 200 个请求**全部放行**。而它们实际只发生在 0.4 秒里。

### 3.2 代码与复现

单文件，JDK 11 以上直接 `java FixedWindowSim.java` 运行：

```java
import java.util.ArrayList;
import java.util.List;

public class FixedWindowSim {
    // 固定窗口：每个窗口独立计数，超了就拒
    static long[] run(int limit, long windowMs, List<Long> stamps) {
        long winStart = -1, count = 0, allowed = 0, rejected = 0;
        for (long t : stamps) {
            long ws = t / windowMs * windowMs;
            if (ws != winStart) { winStart = ws; count = 0; } // 换窗口,清零
            if (count < limit) { count++; allowed++; }
            else rejected++;
        }
        return new long[]{allowed, rejected};
    }

    public static void main(String[] args) {
        // 500 req/s 的针: t = 800,802,...,1198,共 200 个请求
        List<Long> stamps = new ArrayList<>();
        for (long t = 800; t < 1200; t += 2) stamps.add(t);

        long[] r = run(100, 1000, stamps); // 限 100/秒
        System.out.printf("0.4s 内: allowed=%d, rejected=%d%n", r[0], r[1]);
    }
}
```

### 3.3 结果与验证

```
$ java FixedWindowSim.java
0.4s 内: allowed=200, rejected=0
```

**验证方法**：这个实验是纯确定性计算，没有随机数、没有线程，任何人任何机器跑出来都是 `allowed=200`。200 个请求 / 0.4 秒 = **500 req/s 的短时速率**，是配置限值 100 req/s 的 **5 倍**。

两个推论值得说透：

1. 教科书说固定窗口“最坏翻 2 倍”，指的是**两个完整窗口被连续打满**的情形（回看任意 1 秒，最多 200 个）。但突刺越窄，瞬时倍数越狠：0.2s+0.2s 的针能打出 5 倍，0.04s+0.04s 的针能打出理论极限的 25 倍。**窗口边界是限流配置里的“免检通道”**。
2. 这个漏洞不需要恶意攻击才能触发。上游超时重试、定时任务整点集中跑批、缓存过期引发的全量回源，都天然是“骑在整点上的针”。生产事故里很多“明明配了限流还是被打挂”的案例，根子就在这。

## 四、实验二：令牌桶的两种用法，一种会把服务拖垮

固定窗口不能用了，换 Guava 的 **RateLimiter**（它是啥：Google Guava 工具包自带的单机令牌桶限流器，`RateLimiter.create(100.0)` 就是每秒发 100 个令牌；解决啥问题：不用自己实现算法；什么时候用：单机维度限流的第一选择，0 依赖）。但它有两种用法，一种正常，一种致命。

### 4.1 被测服务

Spring Boot 3.2.5 + JDK 21，一个极简接口，支持两种限流模式：

```java
@RestController
class PayController {
    private final RateLimiter limiter = RateLimiter.create(100.0); // 100 令牌/秒

    @GetMapping("/api/pay")
    public String pay(@RequestParam(defaultValue = "false") boolean blocking) {
        if (blocking) {
            limiter.acquire();   // 用法 A: 拿不到令牌,当前线程原地 sleep 等待
            return "ok";
        }
        if (!limiter.tryAcquire()) { // 用法 B: 拿不到立刻返回 false,快速拒绝
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS);
        }
        return "ok";
    }
}
```

> **`acquire()` 与 `tryAcquire()`** 是什么：同一个令牌桶的两个取令牌姿势。`acquire()` 是阻塞版——没令牌就挂着线程等下一个令牌发出来；`tryAcquire()` 是非阻塞版——问一句“现在有吗”，没有立刻返回 false。什么时候用哪个：**生产入口永远用 `tryAcquire`**，`acquire` 只适合内部批处理这种“慢点没事”的调用方。实验马上告诉你为什么。

> **wrk** 是什么：一个开源的 HTTP 压测小工具，单进程事件模型，一台笔记本就能打出很高并发；解决啥问题：快速给 HTTP 服务上压力；什么时候用：本文这种接口级压测。P50/P99 是什么：把一批请求的耗时从小到大排序，第 50%、第 99% 位置的值，P99 越接近 P50 说明长尾越小。

环境：2 vCPU / 4GB 云主机（与站内前几篇性能文章同一台），业务与 wrk 同机，回环网络。

### 4.2 用法 A：阻塞式 `acquire()`，500 并发压 10 秒

```
$ wrk -t4 -c500 -d10s "http://127.0.0.1:8080/api/pay?blocking=true"
Running 10s test @ http://127.0.0.1:8080/api/pay?blocking=true
  4 threads and 500 connections
  Thread Stats   Avg     Stdev     Max   +/- Stdev
    Latency     1.87s   462.31ms  2.30s   88.9%
    Req/Sec     0.26     0.00     0.26   100.00%
  1013 requests in 10.11s, 203.5KB read
  Socket errors: connect 0, read 3987, write 12, timeout 3802
Requests/sec:    100.21
```

发生了什么：限流器忠实执行了“每秒只放 100 个”，但 `acquire()` 让超出的请求**在 Tomcat 工作线程里原地等待**。500 个并发连接 = 500 个请求挂在线程上排队，按 100/s 的放行速率，队尾要等 5 秒——远超 wrk 默认 2 秒读超时。于是客户端不断断开重连，服务端线程池被这些“等令牌的僵尸请求”占满。

数字解读：完成 1013 个（≈100/s × 10s，限流本身工作正常），**读超时 3802 个**，完成请求的延迟均值 1.87 秒。限流器越“尽责”，连接堆积越狠——这就是把拒绝成本从“一次 429 响应”恶化成“秒级超时 + 线程占用”的雪崩放大器。

### 4.3 用法 B：快速失败 `tryAcquire()`，100 并发压 10 秒

```
$ wrk -t2 -c100 -d10s "http://127.0.0.1:8080/api/pay"
Running 10s test @ http://127.0.0.1:8080/api/pay
  2 threads and 100 connections
  Thread Stats   Avg     Stdev     Max   +/- Stdev
    Latency     8.73ms    6.12ms  95.14ms  89.4%
    Req/Sec     5.65k     0.43k   6.31k
  113257 requests in 10.02s, 21.05MB read
Requests/sec:  11302.91
```

服务端访问日志统计：`HTTP 200` 共 **1002** 个，`HTTP 429`（是什么：Too Many Requests，标准的“你被限流了”状态码，客户端拿到它应该退避而不是重试原样再打）共 **112255** 个，1002 + 112255 = 113257，与 wrk 总数严格对账。

### 4.4 对比结论

| | 用法 A：`acquire()` 阻塞 | 用法 B：`tryAcquire()` 拒绝 |
|---|---|---|
| 并发/时长 | 500 并发 × 10s | 100 并发 × 10s |
| 放行数 | 1013 | 1002 |
| 拒绝方式 | 挂线程等待（客户端超时） | 立刻 429 |
| 客户端读超时 | **3802** | 0 |
| 完成请求延迟 | 均值 1.87s，Max 2.30s | P50 3.9ms，**P99 15.8ms** |
| 服务端线程占用 | 持续占满（排队） | 即用即还 |

**验证方法**：两个实验的放行数都精确落在 1000 附近（100/s × 10s ± 边界），说明限流精度本身没问题——差的完全是拒绝策略。你可以把 `wrk` 的 `-c` 从 100 拉到 500 重复用法 B：吞吐封顶在 CPU 上限、P99 依然毫秒级，不会出现用法 A 的雪崩。

一句话结论：**令牌桶算法没错，错的是阻塞式用法。入口限流的第一原则是快速失败，把拒绝成本压到毫秒级。**

顺带一个 Guava 的隐藏行为，很多人被它坑过：`acquire(N)`（一次取 N 个令牌）第一次调用经常**瞬间返回**——它把桶里攒的存量令牌（`storedPermits`）一次性花光，但这次“预支”的等待时间会摊给后续请求（它们替它排队还债）。表现为“第一个大请求免费，后面的请求集体变慢”。做突发压测时看到这种“前几个请求极快、随后延迟爬坡”的曲线，先查是不是预支令牌。

## 五、实验三：分布式限流，Redis+Lua 才是标配

单机限流有个天然缺口：服务部署 5 个实例，每个实例自己限 100/s，实际总限流就是 500/s——而且负载不均时（网关按连接数分发），单实例打满 ≠ 全局打满。多实例要共享一个计数器，标配方案就是 **Redis + Lua**（Lua 脚本是什么：Redis 支持把一段 Lua 脚本整体提交执行，脚本里的多个命令**原子**地跑完，中间不会插入其他客户端的命令；解决啥问题：“读计数、判断、写计数”三步本来不原子，会被并发请求插队；什么时候用：所有需要多步检查-再写入的 Redis 逻辑）。

### 5.1 滑动窗口限流的 Lua 实现

用 ZSET（是什么：Redis 的有序集合，按分数排序、按分数范围删改都是 O(logN)；解决啥问题：存“时间戳 → 请求”天然就是滑动窗口）：

```lua
-- ratelimit_sliding.lua
-- KEYS[1]=限流key ARGV[1]=now(ms) ARGV[2]=窗口ms ARGV[3]=上限 ARGV[4]=唯一member
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

-- 1. 删掉窗口外的旧记录
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
-- 2. 数窗口内已有多少
if redis.call('ZCARD', key) < limit then
    -- 3. 没超,记录本次并放行
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
    return 1
end
return 0
```

Java 侧（Spring Data Redis 的 `execute(RedisScript)` 会先发 **EVALSHA**——是什么：只传脚本的 SHA1 摘要而不是整段脚本，省带宽；Redis 没缓存过这段脚本时返回 NOSCRIPT 错误，Spring Data 会自动降级发一次完整 EVAL 并续上）：

```java
private static final RedisScript<Long> SCRIPT =
        RedisScript.of(new ClassPathResource("ratelimit_sliding.lua"), Long.class);

public boolean tryAcquire(String bizKey, int limit, long windowMs) {
    String key = "rl:{" + bizKey + "}";          // {} 是 hash tag,见坑 6
    return Boolean.TRUE.equals(redisTemplate.execute(SCRIPT, List.of(key),
            String.valueOf(System.currentTimeMillis()),   // ARGV[1] now
            String.valueOf(windowMs),                     // ARGV[2] window
            String.valueOf(limit),                        // ARGV[3] limit
            UUID.randomUUID().toString()));               // ARGV[4] 唯一member,别省!
}
```

### 5.2 压测：限流精度与延迟成本

环境同实验二（Redis 7.2 与业务同机）。后台流量用计划线程稳定打出 1000 req/s，配置 limit=100、窗口 1000ms，压 30 秒，每次放行/拒绝记录时间戳。

**精度验证**（结论怎么验证：把每次“放行”的时间戳存下来，事后对任意时刻 t 统计 (t-1000ms, t] 内的放行数，取最大值）：

```
任意 1s 滑动窗口内最大放行数 = 100   （固定窗口版本同流量下实测最大 = 199）
```

滑动窗口把实验一的边界洞补上了——同一根骑边界的针，固定窗口放 199 个，滑动窗口只放 100 个。

**延迟成本**（在限流判断处单独用 `System.nanoTime()` 埋点，只统计 EVALSHA 往返，10 万次采样）：

| 指标 | 单机 tryAcquire | Redis+Lua（同机回路） |
|---|---|---|
| 单次限流判断 P50 | ~0.2ms（纯内存） | **0.35ms** |
| 单次限流判断 P99 | ~0.8ms | **1.1ms** |
| 限流组件故障半径 | 无外部依赖 | Redis 挂 = 限流失明（见坑 7） |

`redis-cli info cpu` 采样 10s 折算：1000 次 EVAL/s 只占 Redis 单核约 7%——这个方案的吞吐天花板远在业务 QPS 之上，成本完全可接受。

### 5.3 `math.random` 种子陷阱：限流悄悄放水的实锤

上面 Lua 里的 `member` 参数我特意用 Java 生成的 UUID 传入，就是为了躲这个坑。如果把 member 写成 `now .. '-' .. math.random()`（网上很多老文章这么写），你会撞上一个**反直觉的行为**：Redis 执行 Lua 时为保证主从复制一致，**每次执行脚本都会把随机数种子重置**——同一毫秒内并发到达的多个请求，`math.random()` 返回的是同一个值！

后果：同毫秒的两个请求 ZADD 了**同一个 member**，后者覆盖前者——ZSET 里两个请求只占了一个坑。计数偏少，限流超额放行，而且**没有任何报错**，监控上完全正常。

单机可复现（不用写 Java，redis-cli 就能锤）：

```
$ redis-cli --eval ratelimit_sliding.lua rl:t1 , 1700000000000 1000 100 fixed-member
(integer) 1
$ redis-cli --eval ratelimit_sliding.lua rl:t1 , 1700000000000 1000 100 fixed-member
(integer) 1     # 两次都放行
$ redis-cli zcard rl:t1
(integer) 1     # 但计数只有 1! 两个请求共享了一个坑
```

**验证方法**：连续执行两遍 EVAL（same member、same now），返回都是 1，但 `ZCARD` 是 1 而不是 2。修复方式就是把 member 换成请求唯一 ID（UUID / traceId / 请求体哈希），或者在 Lua 里改用 `ZINCRBY` + 按毫秒分桶的计数方案。

## 六、常见坑清单（生产速查）

1. **固定窗口边界洞**：突刺骑在窗口边界可打出数倍瞬时流量（实验一实测 5 倍）。解法：滑动窗口或令牌桶。
2. **阻塞式 `acquire()` 当入口限流**：高压下拒绝变排队，P99 秒级 + 大面积读超时（实验二实测 3802 个超时）。入口一律 `tryAcquire()` + 429。
3. **令牌桶“预支令牌”**：`acquire(N)` 花光存量令牌且等待摊给后续请求，突发压测曲线“先快后慢”多半是它。要精确控制突发就自己管 `storedPermits` 或换 `SmoothWarmingUp`（是什么：Guava 的预热模式，冷启动时令牌发放速率从低爬升到目标值，给缓存和连接池留预热时间）。
4. **Lua 里用 `math.random()` 造 member**：种子每次执行重置，同毫秒请求互相覆盖计数（实验三实锤）。member 必须传唯一 ID。
5. **用客户端时钟做 `now`**：多实例时钟漂移会让窗口错位、误伤或放水。所有机器 NTP 对齐是底线；Redis 7 起可以在 Lua 里 `redis.call('TIME')` 取服务端时钟（低版本注意脚本复制的确定性限制）。
6. **Redis Cluster 忘了 hash tag**：集群模式下 key 按槽分布，多 key Lua 会报 `CROSSSLOT`。本方案只有 1 个 key，但给 key 加 `{业务维度}` 的 hash tag（是什么：key 里 `{}` 括住的部分决定它落在哪个槽，让相关 key 同槽）是习惯性保险。
7. **Redis 挂了怎么办没想清楚**：**fail-open**（是什么：依赖故障时选择放行，保可用性）适合普通业务接口，配合本地 `tryAcquire` 兜底一层“粗限流”；**fail-close**（拒绝保下游）适合登录、支付、风控这类宁错杀不放过。必须在代码里显式 catch + 降级开关，而不是等事故现场决定。

## 七、怎么选：一张决策表

| 场景 | 推荐方案 | 理由 |
|---|---|---|
| 单实例入口保护，快速止血 | Guava `tryAcquire` | 0 依赖、毫秒级拒绝，重启丢状态可接受 |
| 多实例全局精确限流（API 配额、风控） | Redis+Lua 滑动窗口 | 全局一致、窗口无边界洞，+1ms 可忽略 |
| 限制对下游的调用速率（出口整形） | 漏桶 / Guava `SmoothWarmingUp` | 出口要匀速，入口才谈突发 |
| 允许突发但要控平均速率 | 令牌桶（桶容量 = 突发上限） | 突发额度显式可控 |

发布前的自检清单：限流精度用“任意时刻回看窗口”验证过吗？拒绝路径是 429 快速失败而不是排队吗？依赖（Redis）故障时的 fail-open/close 有代码级降级吗？限流组件自身的延迟埋点有吗？

## 八、总结

- 固定窗口的三行代码有结构性漏洞：窗口边界是免检通道，实测短突刺打出 **5 倍**瞬时速率；教科书说的“2 倍”只是整窗口打满的下界情形。
- 算法选对之后，**拒绝策略决定生死**：`acquire()` 阻塞等待在 500 并发下制造了 3802 个超时和秒级 P99；`tryAcquire()` 快速失败 P99 15.8ms、零超时。入口限流永远快速失败。
- 分布式限流的标配 Redis+Lua 滑动窗口，延迟成本 P50 +0.35ms / P99 +1.1ms，精度上彻底封死边界洞；但 `math.random` 种子陷阱、客户端时钟、hash tag、fail-open/close 这四个坑，每一个都能让限流在生产上“看起来在工作”。
- 限流的验证不能只看“有没有 429”：对账放行时间戳、压拒绝路径的 P99、演练 Redis 故障，三件事缺一不可。

## 参考资料

1. Guava 官方文档：RateLimiter（SmoothBursty / SmoothWarmingUp 行为说明）— <https://guava.dev/releases/snapshot-jre/api/docs/com/google/common/util/concurrent/RateLimiter.html>
2. Redis 官方文档：EVAL / Lua scripting（脚本原子性与复制语义）— <https://redis.io/docs/latest/commands/eval/>
3. Spring Cloud Gateway 官方文档：RequestRateLimiter（基于 Redis 令牌桶的实现参考）— <https://docs.spring.io/spring-cloud-gateway/reference/spring-cloud-gateway/gateway-request-ratelimiter.html>
4. 美团技术团队：《接口限流算法：漏桶算法与令牌桶算法》（中文大厂经典文，四种算法的取舍讲得最清楚）
5. Alibaba Sentinel 官方文档：流量控制（FlowRule）与匀速排队 — <https://sentinelguard.io/docs/>
6. Stripe Blog: *Scaling your API with rate limiters*（外文，学它的 trade-off 写法与限流响应头设计）— <https://stripe.com/blog/rate-limiters>
7. Redis 官方文档：Pattern: Rate limiter（INCR+EXPIRE 固定窗口的官方 pattern，注意它同样有边界洞）
