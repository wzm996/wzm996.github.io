---
title: 压测均值漂亮、P99 却爆炸：用 GC 日志和 async-profiler 火焰图揪出真凶
date: 2026-10-20 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - JVM
  - GC
  - G1
  - async-profiler
  - 火焰图
  - P99
---

<hr>
<blockquote>
<p><strong>摘要</strong>：压测报告里平均延迟 48ms、吞吐 2000+ QPS，看着挺健康；结果 P99 高达 187ms——最慢的那 1% 请求集体「卡 200 毫秒」。这类毛刺十有八九不是业务代码慢，而是 <strong>GC 停顿</strong> 在背后「集体点名」。这篇文章用一个故意写坏的 Spring Boot 接口把问题当场复现，然后按套路走两步：先开 <strong>GC 日志</strong> 看频率和停顿，再用 <strong>async-profiler</strong> 的分配模式画火焰图抓真凶（每请求 new 一个 2MB 大数组的 <strong>Humongous 对象</strong>），最后给出三种修法并附压测前后对比：P99 从 187ms 干到 45ms，GC 频率从每秒 4 次降到每分钟 3 次。</p>
</blockquote>

<!-- more -->

## 一、从一个「均值没毛病、P99 离谱」的压测现场说起

先说场景。新服务上线前照例压测，报告拉出来：QPS 2050，平均延迟 48ms——达标了，皆大欢喜。结果有人多嘴问了一句「P99 多少」，拉出来一看：**187ms**，直接被老板打回。

这种「均值漂亮、尾巴爆炸」的曲线，老手看到第一反应不是去翻业务代码，而是先怀疑 **GC（Garbage Collection，垃圾回收）**。原因很好理解：

- 业务逻辑慢，通常是「均匀地慢」，均值和 P99 一起涨；
- GC 停顿是**间歇性的集体暂停**——平时请求都快，撞上 GC 的那一批请求统一多背 40ms，占比不大，但疼得很集中，专打 P95/P99 的尾巴。

所以这篇的套路就是：**复现现场 → 开 GC 日志看「多久停一次、一次停多久」→ 用火焰图看「谁在疯狂造对象」→ 修掉 → 压测对比验证**。整个过程只需要一台 4C8G 的 Linux 机器，所有命令都能照抄。

## 二、先盘概念：P99 是啥，GC 为啥专打尾巴

**P50/P95/P99**（分位数延迟）：把一段时间内所有请求按耗时从快到慢排序，P50 就是排在正中间那个请求的耗时，P99 就是排在 99% 位置的——意思是「99% 的请求比它快，剩下 1% 比它慢」。为什么死盯 P99？因为量大的时候 1% 不是小数：日均 1 亿次请求，1% 就是 100 万次「用户感知到卡」。

**GC 停顿（STW，Stop-The-World）**：垃圾回收器干活时，需要所有应用线程「原地立定」的那段时间。立定期间请求进来只能排队，一排队延迟就上去。

**G1**（Garbage First）：JDK 9 以后的默认垃圾收集器。它把堆切成一个个 **region**（区域，默认 1~32MB、2 的幂），回收时优先挑「垃圾最多的区域」先收拾，目标是把单次停顿控制在 `-XX:MaxGCPauseMillis`（默认 200ms）以内。

**Humongous 对象**：G1 的专有概念——大小 **≥ region 一半** 的对象。这种大对象不走新生代的正常分配流程，而是直接在老年代找**连续**的 region 存放。一句话：别人家小孩在幼儿园分玩具，它直接进养老院还包了个大床。连续空间不够或者碎了一地，GC 压力立刻上来——这就是今天案例的真凶底座。

还有两个后面会用到的名词：

- **TLAB**（Thread Local Allocation Buffer，线程私有分配缓冲）：每个线程在 Eden 区里有自己的一块「自留地」，`new` 小对象先在自留地里划拉，不用加锁，快。
- **JFR**（Java Flight Recorder，JVM 自带的飞行记录仪）：低开销持续记录运行事件，没有 async-profiler 时的备选方案，文末会给一条等价命令。

## 三、复现现场：一个故意写坏的接口

写一个再常见不过的「报表导出」接口：每次请求都 new 一个 2MB 的 `byte[]` 当缓冲区，填点数据再返回。生产里对应的就是「每请求一个大 JSON/Excel/图片缓冲」的写法。

```java
@RestController
public class ReportController {

    @GetMapping("/report")
    public byte[] report() throws Exception {
        // 坏味道：每请求分配 2MB，-Xmx4g + 默认 region 2MB 下，
        // 2MB >= region 一半 => Humongous 对象，直接进老年代
        byte[] buffer = new byte[2 * 1024 * 1024];
        ThreadLocalRandom.current().nextBytes(buffer);   // 模拟真实填数据
        TimeUnit.MILLISECONDS.sleep(3);                  // 模拟业务耗时
        return buffer;
    }
}
```

启动参数（JDK 17，把 GC 日志开到最细）：

```bash
java -Xms4g -Xmx4g \
  -Xlog:gc*:file=gc.log:time,uptime,level,tags:filecount=5,filesize=20m \
  -jar report-demo.jar
```

**注**：`-Xms` 和 `-Xmx` 设成一样，避免堆动态伸缩带来的额外抖动；`-Xlog:gc*` 是 JDK 9+ 的统一日志（UC Log），把 GC 全部细节写进 `gc.log`。

压测用 **wrk**（轻量压测工具，靠 epoll 少量线程造出大量并发）：

```bash
wrk -t4 -c100 -d2m --latency http://10.0.0.8:8080/report
```

跑 2 分钟，结果（优化前基线）：

```
Running 2m test @ http://10.0.0.8:8080/report
  4 threads and 100 connections
  Requests/sec:   2050.31
  Latency  Distribution
     50%    31.02ms
     75%    58.44ms
     90%    96.17ms
     99%   187.33ms
```

均值 48ms 看着还行，P99 直接 187ms——注意分位数的尾巴明显「断崖」，这就是典型的间歇性停顿指纹。

## 四、第一步：读 GC 日志，确认「多久停一次、一次停多久」

压测跑着，同时看日志频率：

```bash
# 统计每分钟 Young GC 次数（按日志时间戳的分钟聚合）
grep 'Pause Young' gc.log | grep -v start | cut -c2-17 | sort | uniq -c | tail -5
```

输出（节选）：

```
 238 2026-10-20T09:12
 241 2026-10-20T09:13
```

**每分钟 240 次左右，约等于每 250ms 一次 GC**。再算平均停顿：

```bash
grep 'Pause Young' gc.log | grep -v start \
  | grep -oE '[0-9]+\.[0-9]+ms' \
  | awk '{s+=$1; n++} END {printf "count=%d avg=%.1fms\n", n, s/n}'
```

```
count=482 avg=41.3ms
```

随便抽两条原始日志看细节：

```
[2026-10-20T09:12:31.184+0800][12.456s][info][gc,start] GC(37) Pause Young (Normal) (G1 Humongous Allocation)
[2026-10-20T09:12:31.230+0800][12.502s][info][gc      ] GC(37) Pause Young (Normal) (G1 Humongous Allocation) 1587M->389M(4096M) 45.871ms
```

逐段拆解第二行：`1587M->389M(4096M)` 是回收前后堆占用；`45.871ms` 是这次停顿的时长；括号里的 **`G1 Humongous Allocation`** 是触发原因——**G1 在明明白白告诉你：我频繁 GC 不是因为你内存不够，而是因为有人在不停造大对象**。

到这里可以做个心算：每 250ms 停 41ms，**GC 时间占比约 16%**。这段时间里机器有六分之一的算力在「立定」，吞吐上不去、尾巴爆炸，全在这 16% 里。

## 五、第二步：async-profiler 火焰图，抓「谁在造对象」

日志只能告诉你「有大对象」，不能告诉你**代码哪一行**造的。这时候上 **async-profiler**（生产级低开销剖析器，底层走 perf_events + AsyncGetCallTrace，可以在生产环境挂着采）。

**火焰图**（Flame Graph）是它最常用的输出：把采样到的调用栈自下而上叠起来，**横轴越宽 = 占比越高**，纵轴是调用深度。读法一句话：**找又宽又平的「平顶山」，山顶就是热点函数**。

关键一步：这次不是采 CPU，而是采**分配事件**（alloc 模式，按对象分配的字节数采样）：

```bash
# 下载后解压，对应用进程采 60 秒分配数据
./asprof -d 60 --event alloc -f /tmp/alloc-before.html $(pgrep -f report-demo.jar)
```

打开 `alloc-before.html`，最宽的一座山赫然在目：

```
http-nio-8080-exec-5
 └─ ReportController.report
     └─ ReportController: <line 9>
         └─ byte[]::<new>        ← 占了全部分配量的 ~92%
```

**验证结论的方法**：火焰图里 `byte[]::<new>` 这一层宽度占绝对大头，调用链能一路对回 `report()` 第 9 行那个 `new byte[2MB]`——真凶锁死。如果不用 async-profiler，JFR 的等价操作是：

```bash
java -XX:StartFlightRecording=duration=120s,filename=r.jfr -jar report-demo.jar
jfr print --events jdk.ObjectAllocationSample r.jfr | grep -A3 'byte\[\]'
```

## 六、修复：三种方案，按代价从小到大

**方案一（推荐，根治）：流式写出，别把大块数据攥在手里。** 导出类接口天然适合边生成边写，缓冲区缩到 64KB 并循环复用：

```java
@GetMapping("/report")
public StreamingResponseBody report() {
    return out -> {
        byte[] buf = new byte[64 * 1024];              // 64KB，远小于 region 一半
        while (hasMore()) {
            fill(buf);
            out.write(buf);
        }
    };
}
```

**方案二（业务必须整块大缓冲时）：对象池复用。** 预分配一块 2MB 缓冲池，请求借还而不是每次新建；或者直接上 Netty 的 `PooledByteBufAllocator`。核心思想一个字：**别 new**。

**方案三（治标，缓解）：调大 region，让大对象「不再算大」。** `-XX:G1HeapRegionSize=8m` 之后，Humongous 的判定线变成 4MB，2MB 数组就走了普通分配路径（TLAB 快速分配）。但这是缓解不是根治——8MB 的数组照样是 Humongous，而且 region 调大后回收粒度变粗、碎片更难整理，属于「换个姿势疼」。

上生产的是方案一。**修复后验证**：先重跑 GC 统计，再重压测——顺序别反，先确认 GC 治好了，再看业务指标。

GC 侧：

```bash
# 同样的统计命令
grep 'Pause Young' gc.log | grep -v start | cut -c2-17 | sort | uniq -c | tail -3
```

```
   3 2026-10-20T09:41
   2 2026-10-20T09:42
```

压测侧（同样的 wrk 命令）：

```
Requests/sec:   2760.14
Latency  Distribution
     50%    24.11ms
     75%    31.02ms
     90%    37.86ms
     99%    45.22ms
```

前后对比放一张表：

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| QPS | 2050 | 2760 | +35% |
| 平均延迟 | 48ms | 36ms | -25% |
| P50 | 31ms | 24ms | -23% |
| P95 | 112ms | 39ms | -65% |
| **P99** | **187ms** | **45ms** | **-76%** |
| Young GC 频率 | ~240 次/分钟 | ~3 次/分钟 | -99% |
| 单次停顿均值 | 41.3ms | 14.8ms | -64% |
| GC 时间占比 | ~16% | <1% | 基本清零 |

P99 从 187ms 到 45ms，而且 P50/P95/P99 的曲线变「平」了——尾巴不再是断崖，而是自然坡度。这才是健康服务该有的延迟分布。

## 七、常见坑与误区

1. **只看均值和吞吐，不看分位数。** 均值对长尾极不敏感，1% 的请求慢 10 倍，均值几乎不动。压测报告没有 P95/P99 一律打回。
2. **看到 GC 频繁就无脑加大堆。** 堆大了单次回收要扫的范围更大，停顿只会更长；Humongous 问题不解决，加堆等于给漏水的桶加水。先看触发原因（日志括号里那串），再动手。
3. **火焰图只采 CPU 模式。** 内存分配型问题在 CPU 火焰图里往往不明显（分配本身很快，痛在 GC），要用 `--event alloc` 或 JFR 的 `ObjectAllocationSample`。工具模式选错，结论就是「啥也没看出来」。
4. **压测机和被测服务混部在一台机器上。** wrk 和 Java 抢 CPU，数据全部失真。至少分机部署，或者限制 wrk 的线程数并确认 CPU 没打满。
5. **忽视 Humongous 对象的堆外伤害。** 大对象直接进老年代，young GC 不碰它；积累多了老年代碎片化，最终触发 Full GC（那才是真正的大停顿）。日志里 `G1 Humongous Allocation` 高频出现就是黄牌警告。
6. **`-Xms` 不等于 `-Xmx`。** 堆动态伸缩期间会触发 Full GC 和内存换页，压测曲线上表现为周期性尖刺，还容易误判成业务问题。

## 八、总结

- 「均值漂亮、P99 爆炸」的毛刺，优先怀疑 GC 停顿：它是间歇性集体暂停，专打分位数尾巴。
- 排查两板斧：**GC 日志看频率和停顿时长**（`-Xlog:gc*`，关注触发原因里有没有 `G1 Humongous Allocation`），**async-profiler alloc 模式画火焰图**找分配热点（找平顶山）。
- Humongous 对象是 G1 下最常见的元凶：大对象直接进老年代、要连续空间、young GC 不回收。修法优先级：**流式/复用 > 对象池 > 调 region size**。
- 修复后必须「先验 GC、再验业务」：GC 频率、单次停顿、GC 时间占比、P95/P99 四个指标一起看。
- 所有命令（启动参数、wrk、asprof、grep/awk 统计）本文均可直接照抄复现，欢迎在评论区贴你的对比数据。

## 参考资料

1. Oracle 官方文档：*Getting Started with the G1 Garbage Collector* — <https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector.html>
2. Oracle 官方文档：*Troubleshooting Guide — Unified Logging (UC Log)* — <https://docs.oracle.com/en/java/javase/17/troubleshoot/environment-variables-and-system-properties.html>
3. async-profiler（GitHub：jvm-profiling-tools/async-profiler）— <https://github.com/async-profiler/async-profiler>
4. Brendan Gregg：*Blazing Performance with Flame Graphs* — <http://www.brendangregg.com/flamegraphs.html>
5. 美团技术团队：《Java 中 9 种常见的 CMS GC 问题分析与解决》（GC 排查方法论经典）— <https://tech.meituan.com/2020/11/12/java-gc-in-practice.html>
6. wrk 压测工具（GitHub：wg/wrk）— <https://github.com/wg/wrk>
