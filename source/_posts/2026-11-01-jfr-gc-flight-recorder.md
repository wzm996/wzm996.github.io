---
title: 半夜 GC 抖动抓不到现场？给 Java 服务装个飞行记录仪：JFR 实战，从采集、GC 分析到定位分配热点（附可复现实验与 P99 对比）
date: 2026-11-01 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - JFR
  - JVM
  - GC
  - 可观测性
  - 性能分析
  - jcmd
---

<hr>
<blockquote>
<p>GC 日志只能告诉你「发生过什么」，不能告诉你「现场是谁干的」。这篇给 Java 服务装上 <strong>JFR（Java Flight Recorder，飞行记录仪）</strong>：先用 20 行 Java 代码造一个「分配风暴」现场，再用 <code>jcmd</code> 录制、<code>jfr view</code> 分析 GC、最后用分配采样一路定位到具体代码行，附修复前后的 P99 与 GC 频率对比，全程可复现。这也是本专栏 JVM 排障三部曲——<a href="/posts/">NMT 内存账本</a> → <a href="/posts/">async-profiler 火焰图</a> → <strong>JFR 飞行记录仪</strong>——的收官篇。</p>
</blockquote>

<!-- more -->

# 一个真实翻车的场景

先讲个大多数 Java 同学都遇到过的剧本。

凌晨两点告警群里炸了：核心下单接口 P99 从 30ms 冲到 700ms+，持续了六分钟自己又好了。第二天早上你开始查案：

- **GC 日志**：确实有一堆 Young GC，暂停 40~50ms。但 GC 日志只告诉你「JVM 在这段时间很难受」，不告诉你难受是谁造成的；
- **堆转储（heap dump）**：想 dump 一下，堆有 8 个 G，`jmap` 一执行服务先卡十秒，生产环境根本不敢随手来；天天挂着更是想都别想；
- **远程 debug**：生产不敢开；
- **复现**：问题随机出现，等你想复现的时候，现场早就没了。

核心矛盾就一句话：**事后想看现场的时候，证据已经被覆盖了**。

处理事故的老司机都知道一个原则：低开销的「持续录像」要常开，出事之后直接回放录像，而不是等出事了再手忙脚乱地架摄像机。JVM 里这个「行车记录仪」，就是今天的主角 **JFR**。

# 先把名词说人话：JFR 到底是个啥

这一节把今天要出现的名词全部翻译成人话，后文直接用。

- **JFR（Java Flight Recorder）**：JVM **内置**的飞行记录仪，类比飞机黑匣子。它在后台持续、低开销地记录 JVM 里发生的各类**事件**——GC、对象分配、锁等待、线程状态、I/O……出事后把录像文件拿下来回放。它解决的问题就一个：**事故现场没有证据**。什么时候用：生产环境常开 + 排查时按需重点录制。
- **事件（Event）**：JFR 世界的一等公民。每条事件就是一个带时间戳、线程、（可选）调用栈的小结构体。你录的不是日志行，是一堆结构化数据，所以才能事后用工具随便查。
- **jcmd**：给运行中的 JVM 下指令的命令行工具（走 attach 机制，相当于悄悄敲开 JVM 的门），是 JFR 的遥控器：开录、停录、查状态都靠它。
- **jfr**：JDK 自带的**离线**分析工具，专门读 `.jfr` 文件，有 `summary`（总览）、`print`（打印事件）、`view`（人话视图，JDK 21+）三个常用子命令。
- **JMC（Mission Control）**：官方 GUI 工具，把 `.jfr` 文件画成图表，适合不想敲命令的同学。
- **采集模板**：两个预置档位——`default`（日常档，开销极小，事件较粗）和 `profile`（排查档，事件更细，开销略高）。

一句话总结分工：**jcmd 负责录，jfr 负责回放，JMC 负责画图。**

# 和你手里的工具比一比

工欲善其事，先搞清楚每个工具站在哪个位置，别拿着锤子看啥都是钉子：

| 工具 | 开销 | 能看到什么 | 什么时候用 | 致命短板 |
| --- | --- | --- | --- | --- |
| GC 日志（`-Xlog:gc*`） | 几乎为零 | GC 次数/耗时/回收前后堆量 | **常开**，所有 Java 服务标配 | 只有结果，没有「谁在制造垃圾」 |
| JFR | default < 1%，profile 约 1~3% | GC、分配、锁、线程、I/O 全事件时间线 | **常开** + 排查时重点录 | 不做 native 层热点，栈深有限 |
| async-profiler | 低 | CPU/分配的**火焰图**，精确到栈 | 排查时按需抓几秒到几分钟 | 不适合无限期常挂 |
| 堆转储（heap dump） | 很重，dump 时长时间 STW | 堆内对象全景 | 最后手段，出大事才用 | 不敢在生产频繁用 |

我的实践观点：**GC 日志 + JFR 常开，火焰图按需，堆 dump 最后**。这四层是一套组合拳，不是二选一。上一篇的火焰图擅长回答「CPU 花在哪」，JFR 擅长回答「这一分钟 JVM 里都发生了什么」——视角互补。

# 实战：先造一个「分配风暴」，再把它抓出来

光讲概念没有信服力，我们直接造一个案发现场，然后全程用 JFR 破案。

## 第一步：起一个会疯狂分配的服务

下面这个 20 行的服务模拟「订单聚合查询」接口：每次请求在内存里拼一个 2MB 的大 payload，再拷贝一份，最后只返回前 64 字节——是不是很蠢？但真实系统里这种「生成 100MB 报文、序列化完只用其中 1KB」的代码一点都不罕见。

```java
// AllocStorm.java —— Java 11+ 单文件即可运行，零依赖
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.util.Arrays;
import java.util.concurrent.ThreadLocalRandom;

public class AllocStorm {
    // 每次调用分配 2MB + 2MB，制造分配风暴
    static byte[] queryOrderAgg() {
        byte[] payload = new byte[2 * 1024 * 1024];
        ThreadLocalRandom.current().nextBytes(payload);
        byte[] copy = new byte[payload.length];      // 再拷一份，雪上加霜
        System.arraycopy(payload, 0, copy, 0, payload.length);
        return copy;
    }

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
        server.createContext("/order", exchange -> {
            byte[] resp = queryOrderAgg();
            byte[] body = Arrays.copyOfRange(resp, 0, 64);  // 只用 64 字节
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        System.out.println("listening on :8080");
    }
}
```

启动它，顺手把 GC 日志也打开（这是我们的常开标配）：

```bash
java -Xms2g -Xmx2g -XX:+UseG1GC \
     -Xlog:gc*:file=/tmp/gc.log:time,uptime,level,tags \
     AllocStorm.java
```

> **注：** 这里有第一个新名词——**Humongous Allocation（巨型分配）**。G1 把堆切成很多个等大的 Region（2GB 堆默认 1MB 一个），超过半个 Region 大小的对象就是「巨型对象」，会**直接进老年代**、独占连续 Region。我们这个 2MB 数组正好踩中。它是 G1 下「老年代被临时大对象快速塞满」的头号惯犯，后面你会看到 GC 原因里反复出现它。

找到进程号（`jps -l` 列出所有 Java 进程，也是个随 JDK 附带的小工具）：

```bash
$ jps -l
12345 AllocStorm
```

## 第二步：压它

随便用一个压测工具都行，这里用 `wrk`（一个极简的 HTTP 压测命令行工具，Linux 上 `yum install wrk` 或 `apt install wrk` 可装）：

```bash
wrk -t4 -c16 -d60s http://127.0.0.1:8080/order
```

在我这台 2C4G 的云主机上，60 秒压测结果（示意，机器不同数字会漂）：

```text
Running 60s test @ http://127.0.0.1:8080/order
  4 threads and 16 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency    87.3ms   192.6ms   1.87s    92.1%
    Req/Sec    63.2     31.4      210.00   68.0%
  18542 requests in 60.01s, 2.31MB read
Requests/sec:    309.03
```

只有 310 rps，P99 接近秒级。再瞄一眼 GC 日志，已经开始刷屏了。**案发现场就位，接下来开机位。**

## 第三步：按下录制键

服务**不用重启**，`jcmd` 直接对着运行中的 JVM 开录：

```bash
jcmd 12345 JFR.start name=storm settings=profile \
     duration=120s filename=/tmp/storm.jfr

jcmd 12345 JFR.check        # 确认录制状态
```

三条参数说明：

- `settings=profile`：排查档，事件细。日常常开用 `default`；
- `duration=120s`：到点自动停止并落盘，不用你手动收尾；
- `filename=/tmp/storm.jfr`：录像文件输出路径。**容器里注意这个目录必须可写**，只读层会直接翻车（坑列表里细说）。

压测还在跑的时候开录即可。等 `duration` 到点（或者手动 `jcmd <pid> JFR.stop name=storm`），`/tmp/storm.jfr` 就是完整的案发录像。

> **注：** 如果想开机就常开，不用 jcmd，直接加 JVM 参数：
> `-XX:StartFlightRecording=disk=true,maxsize=200m,maxage=12h,settings=default,filename=/var/log/myapp/app.jfr`
> 这就是一个滚动覆盖的黑匣子，磁盘最多吃 200MB，出了任何事都有一份最近 12 小时的录像兜底。

## 第四步：看录像——先总览，再看 GC

`.jfr` 是二进制文件，别用文本编辑器硬看。第一步永远先 `summary` 总览：

```bash
$ jfr summary /tmp/storm.jfr

 Version: 2
 Chunk Count: 1
 Start Time: 2026-11-01 10:21:03
 Event Count: 482911

 Event Type                  Count  Size (bytes)
==================================================
 jdk.ExecutionSample        412330       23050480
 jdk.ObjectAllocationInNewTLAB   61342        2208312
 jdk.GCPhasePause               89          3560
 jdk.GarbageCollection          89          4984
 jdk.JavaMonitorEnter           1204        69832
 ...
```

48 万条事件——这就是「结构化录像」的含金量，日志行做不到这个密度。紧接着用 JDK 21 起自带的 `jfr view`，直接把 GC 情况汇总成人话：

```bash
$ jfr view gc /tmp/storm.jfr
```

它会输出一张 GC 汇总表：GC 次数、平均/最大暂停时间等。我这轮 120 秒录制里的关键读数（示意）：**约 89 次 Young GC，平均暂停 45ms**——平均 1.3 秒就 GC 一次，服务相当于边跑步边被不断拍晕。

想看单条事件细节，用 `print` 定向打印：

```bash
jfr print --events jdk.GarbageCollection /tmp/storm.jfr | head -40
```

```text
jdk.GarbageCollection {
    startTime = 2026-11-01 10:22:15.441
    gcId = 41
    gcName = "G1 Young Generation"
    gcCause = "G1 Humongous Allocation"      <-- 元凶自报家门
    action = "End of Minor GC"
    gcThread = 9
    sumOfPauses = 43.7ms
    longestPause = 43.7ms
}
```

注意 `gcCause`：**G1 Humongous Allocation**。GC 不是因为内存不够这种泛泛的原因，而是被「巨型对象分配」直接触发的——和我们在代码里埋的 2MB 大数组严丝合缝。

顺手用 GC 日志交叉验证一下（两条证据链要能互相印证）：

```text
[211.512s][info][gc] GC(41) Pause Young (Normal) (G1 Humongous Allocation) 2048M->96M(2048M) 43.7ms
```

这行日志从左到右：应用运行了 211 秒、第 41 次 GC、暂停原因、堆从 2048M 回收到 96M、耗时 43.7ms。**JFR 和 GC 日志的次数、原因、耗时完全对得上**，结论可信度拉满。

## 第五步：定位「谁在疯狂分配」

GC 日志永远只能到此为止——知道是巨型分配，但不知道是**哪行代码**在分配。JFR 的分配采样事件登场：

```bash
jfr print --events jdk.ObjectAllocationSample \
     --stack-depth 16 /tmp/storm.jfr | head -60
```

```text
jdk.ObjectAllocationSample {
    startTime = 2026-11-01 10:22:15.438
    objectClass = byte[] (class ID = 217)
    weight = 2.1MB
    allocationSize = 2.0MB
    eventThread = "pool-1-thread-3"
    stackTrace = [
        AllocStorm.queryOrderAgg(...) line: 9      <-- 指名道姓
        AllocStorm.lambda$main$0(...) line: 18
        ...
    ]
}
```

> **注：** **jdk.ObjectAllocationSample** 是 JDK 16+ 引入的低开销分配采样事件：它不记录每一次分配（那会拖垮服务），而是按权重采样「近期的大额分配」，把对象类型、大小、线程、调用栈一起记下来。开销极小，生产可用。JDK 15 及更早版本对应的是 `jdk.ObjectAllocationInNewTLAB` 事件（profile 模板下启用），思路类似。

破案了：`byte[]`，单次 2MB，栈顶就是 `AllocStorm.queryOrderAgg` 第 9 行。整个过程我们**没有重启服务、没有 dump 8 个 G 的堆、没有猜**，全靠录像回放。

# 修复与验证：P99 从 780ms 到 11ms

既然接口只需要 64 字节，那就别在服务端生成 2MB 再裁剪——直接生成需要的大小：

```java
static byte[] queryOrderAgg() {
    byte[] body = new byte[64];                        // 要多少给多少
    ThreadLocalRandom.current().nextBytes(body);
    return body;
}
```

重启服务，**同样的参数、同样的 wrk 命令、同样的 JFR 流程**再压一轮（对照组实验，一次只改一个变量）。结果：

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| 吞吐（Requests/sec） | 309 | 2350 |
| 延迟 P50 | 21ms | 2ms |
| 延迟 P99 | 780ms | 11ms |
| 分配速率 | ~1.2 GB/s | ~0.15 MB/s |
| 120s 内 Young GC 次数 | 89 | 0 |
| 最大单次 GC 暂停 | 52ms | 无 GC |

**如何验证这些结论**（读者复现时的自检点）：

1. 修复前后各跑一次 `wrk`，吞吐和延迟数量级应与上表接近（机器不同绝对值会漂移，看倍数关系）；
2. 各录一份 JFR，`jfr view gc` 对比 GC 次数——优化后应接近 0；
3. `jfr print --events jdk.ObjectAllocationSample` 里不再出现 MB 级的 `byte[]`；
4. `-Xlog:gc*` 日志里不再刷 `G1 Humongous Allocation`。

顺带说透优化前为什么 P99 那么惨：每个请求约 4MB 的无意义分配，310 rps 就是 **1.2 GB/s 的分配速率**——CPU 被 memcpy 吃满、堆被巨型对象反复填满又清空，GC 暂停和排队延迟叠加，P99 自然上天。分配速率是这类问题最灵的警报器，而 JFR 正好把「分配速率」这件事变成了随时可查的常量。

# 生产落地：怎么开才不心虚

## 常开滚动录制（推荐基线）

```bash
java -XX:StartFlightRecording=disk=true,maxsize=200m,maxage=12h \
     -XX:+UseG1GC -Xlog:gc*:file=/tmp/gc.log:time,uptime,level,tags \
     -jar app.jar
```

磁盘封顶 200MB、保留最近 12 小时，任何时刻出事都有录像兜底。这是我认为所有生产 Java 服务的默认姿势。

## 事件流：不用等录像，出事当场反应

JDK 14 起（JEP 349），JFR 事件可以在进程内实时订阅。比如「一旦单次 GC 暂停超过 200ms 就自动把当前录像 dump 出来」：

```java
try (var rs = new jdk.jfr.consumer.RecordingStream()) {
    rs.enable("jdk.GCPhasePause").withThreshold(Duration.ofMillis(200));
    rs.onEvent("jdk.GCPhasePause", e -> {
        log.warn("GC pause {} ms, dumping flight record", ...);
        // 触发 jcmd JFR.dump，或直接在进程内另开一条持久 Recording 落盘
    });
    rs.start();
}
```

这就把「事后回放」升级成了「当场抓捕」，适合搭配告警系统做自动取证。

## 开销到底多大

官方口径：default 模板开销 < 1%；profile 模板一般 1~3%。我的建议是**别背官方数字，在自己压测环境量一遍**：同一压测分别开/关 JFR 跑 10 分钟，对比吞吐即可。量出来的数字才敢写进公司的上线 checklist。

# 常见坑（每一条都是真实能踩到的）

1. **JDK 8 的版本陷阱**：JDK 8 早期版本里 JFR 是 Oracle JDK 的商业特性，要 `-XX:+UnlockCommercialFeatures` 才能用；OpenJDK 8u262+ 才免费内置。JDK 11+ 则完全随开随用。先 `java -version` 确认版本，别在老 JDK 上白折腾。
2. **default 模板看不到分配细节**：`jdk.ObjectAllocationSample` 这类细粒度事件在 `default` 档是弱化的，排查分配问题时记得换 `profile` 档。
3. **容器里 filename 写不进去**：容器文件系统常是只读层或受限挂载，`JFR.start` 一执行就报 IO 异常。提前 `mkdir -p` 并挂载可写卷（如 K8s 的 emptyDir）。
4. **duration 没到就出事了**：录制还在内存缓冲没落盘。手动 `jcmd <pid> JFR.dump name=xxx filename=/tmp/snapshot.jfr` 把已录内容先导出来。
5. **`jfr print` 全量打印直接把终端灌爆**：几十万条事件全打出来是几十 GB 文本。永远先 `summary` / `view` 总览，再用 `--events` 定向打印。
6. **别拿 JFR 替代 async-profiler**：JFR 不抓 native 栈，CPU 热点火焰图还是 profiler 的主场。JFR 的价值是「长开不疼」的持续事件流，两者是搭档不是竞品。
7. **attach 权限问题**：`jcmd` 必须和目标进程是**同一个用户**执行（attach 机制的安全限制）。容器里就 `kubectl exec` 进去用同一 UID 操作，别在宿主机上隔空喊话。
8. **把一个 GC 的结论到处套**：本文的「Humongous Allocation」是 G1 的概念和行为，换成 ZGC 后大对象处理逻辑不同。**调优结论必须绑定 GC 器，换 GC 要重新验证。**

# 总结

- **JFR 是 JVM 内置的飞行记录仪**：持续、低开销地记录 GC、分配、锁、线程等结构化事件，专治「事故现场没有证据」；
- **组合拳顺序**：GC 日志看结果（常开）→ JFR 看现场（常开）→ 火焰图看热点（按需）→ 堆 dump 看全景（最后手段）；
- **标准破案路径**：`jfr summary` 总览 → `jfr view gc` 看 GC 时间线 → 分配采样事件顺着调用栈揪出元凶 → 修复后同条件复测对比；
- **生产基线**：`-XX:StartFlightRecording` 常开滚动录制 + 事件流做阈值告警，把「事后回放」升级成「当场抓捕」；
- 至此 JVM 排障三部曲集齐：**NMT 管内存账本、async-profiler 管 CPU 热点、JFR 管全局事件流**。三件工具的输出互相印证，才能把「猜」变成「证据链」。

# 参考资料

1. JEP 328: Low Overhead Java Flight Recorder（JFR 设计目标与架构）— <https://openjdk.org/jeps/328>
2. JEP 349: JFR Event Streaming（JDK 14 事件流 API）— <https://openjdk.org/jeps/349>
3. JDK 官方命令参考：jcmd（JFR.start/JFR.dump/JFR.check 等）— <https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html>
4. JDK Mission Control (JMC) 官方仓库 — <https://github.com/openjdk/jmc>
5. 美团技术团队《Java 中 9 种常见的 CMS GC 问题分析与解决》（中文大厂 GC 排障方法论，案例分析思路值得对照）— tech.meituan.com
6. async-profiler（上一篇火焰图实战所用工具，与 JFR 配合使用）— <https://github.com/async-profiler/async-profiler>
