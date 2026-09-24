---
title: 深入理解 G1 垃圾回收器：gc.log 逐行解读、停顿压测与调优实战
date: 2026-09-24 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - JVM
  - G1
  - GC日志
  - 性能调优
  - Java
---

<hr>
<blockquote>
<p>接口平时挺快，一到整点活动 P99 就飙到几百毫秒，监控上还看不到代码哪里慢——十有八九是 GC 在背后搞事。这篇拿 <strong>G1</strong>（JDK 9 之后的默认垃圾回收器）开刀：先把 <strong>gc.log</strong> 打开，逐行看懂它在说什么；再用一组单机就能复现的实验，对比调参前后的停顿差异；最后给出我踩完坑总结的调优清单。</p>
</blockquote>

<!-- more -->

## 一、为什么 GC 值得单独写一篇

先说清楚问题：Java 服务最典型的性能长尾，就是"平时 P50 个位数毫秒，偶发 P99 飙到几百毫秒"。代码没改、流量没涨，延迟就是毛刺。这种时候最大嫌疑人就是 **GC（Garbage Collection，垃圾回收）**——JVM 定期停下来，把没人用的对象清掉、内存整理好，这段时间业务线程是暂停的，术语叫 **STW（Stop-The-World，全局暂停）**。

而 JDK 9 之后，默认垃圾回收器就是 **G1（Garbage-First）**。麻烦在于：G1 的日志默认不打，打出来又一堆天书；网上调优文章动不动十几页参数，看完还是不知道自己该动哪个。所以这篇的目标很具体，就三步：

1. 把 GC 日志打出来（一段参数的事）；
2. 逐行看懂日志（认识十来个词就够）；
3. 用实验验证"哪个参数真的有用"（不背口诀，看数据）。

**目标读者**：写过 Spring Boot、见过线上服务的 Java 开发者。**先修知识**：知道"堆内存""对象"是啥就行，不需要背过 JVM 内存模型。

## 二、5 分钟搞懂 G1 的工作方式

老规矩，先解释新名词，全用大白话：

- **分代回收**：经验假设——绝大多数对象都是"朝生夕死"的（一个请求里 new 出来的临时对象，用完就成垃圾）。所以把堆分成"新对象区"和"老对象区"，新对象区高频清理，老对象区低频整理。
- **Region（分区）**：G1 的核心设计。它不按物理连续把堆切成一整块 Eden、一整块老年代，而是把堆切成几百上千个大小相同的小格子（默认 1~32MB，2 的幂），每个格子动态充当 Eden、Survivor、Old（老年代）或空闲。好处：回收不再"一锅端"，而是挑垃圾最多的格子先收——这也是名字"Garbage-First"的由来。
- **Humongous（巨型对象）**：一个对象大于等于 Region 一半大小，就直接塞进连续的 Region 里，标记为 Humongous。这是 G1 里最容易出事的角落，后面反复出现。
- **Young GC**：年轻代（Eden + Survivor）满了就触发，频率高、单次短。
- **Mixed GC**：G1 的招牌动作。并发标记发现哪些老年代分区垃圾多之后，一次 GC 里"顺手"带上几个老年代分区一起回收——所以叫"混合"（年轻代 + 部分老年代）。
- **Full GC**：兜底动作。前面都来不及或者失败（典型：Humongous 塞不下）时触发，老年代整体压缩，**单次停顿能到几百毫秒甚至几秒**。G1 里出现 Full GC，基本等于事故现场。
- **SATB（Snapshot-At-The-Beginning，初始快照）**：并发标记时业务线程还在改引用，G1 用"标记开始时拍快照"的算法保证不漏标，代价是记录"被改掉的旧引用"（写屏障），这块细节先记住名字就行。

和前辈们对比一下，感受下 G1 的定位：

| 收集器 | 思路 | 停顿 | 适合场景 | 现状 |
| --- | --- | --- | --- | --- |
| Serial | 单线程，一停全停 | 很长 | 几百 MB 小堆/客户端 | 基本退役 |
| Parallel | 多线程，追求吞吐 | 长 | 后台跑批、不在意延迟 | 默认备选之一 |
| CMS | 并发标记，降低停顿 | 中 | 老一代低延迟服务 | JDK 14 移除 |
| G1 | 分区 + 按收益回收，可设停顿目标 | 短且可控 | 大堆（4G+）在线服务 | JDK 9+ 默认 |
| ZGC/Shenandoah | 染色指针/转发指针，停顿亚毫秒 | 极短 | 超大堆超低延迟 | 新一代，门槛更高 |

一句话：**中小堆随便用 G1 默认参数就挺好；大堆在线服务，G1 值得认真调一调。**

## 三、第一步：把 GC 日志打出来

JDK 9 开始日志系统统一成了 **Unified Logging（统一日志）**，一套参数控制所有 JVM 日志，GC 只是其中一个 tag。参数格式是 `-Xlog:gc[:输出位置][:标签][:滚动策略]`。

JDK 8 的 `-XX:+PrintGCDetails` 那套就别再用了，两套格式完全不兼容（这也是一个高频坑，后文细说）。

本地调试，最简单：

```bash
java -Xlog:gc* -jar app.jar
# gc* 表示把 gc 相关所有子标签都打出来，信息最全，量也大
```

生产推荐（滚动 + 带时间戳，防止日志把磁盘写爆）：

```bash
java -Xms4g -Xmx4g \
  -Xlog:gc*,gc+heap=debug:file=/var/log/myapp/gc.log:time,uptime,level,tags:filecount=5,filesize=50m \
  -jar app.jar
```

拆开念一遍：

- `gc*,gc+heap=debug`：gc 全量 + 堆变化的 debug 级明细；
- `file=...`：写到文件，别混进标准输出；
- `time,uptime`：每行带"墙上时间"和"进程启动后秒数"，前者用来关联业务监控，后者用来算 GC 间隔；
- `filecount=5,filesize=50m`：滚动，最多 5 个文件每个 50MB，封顶 250MB。

顺手再记一个**实时观察**的命令，不用重启不用日志，线上排查先看这个：

```bash
jstat -gcutil <pid> 1000
# 每秒打印一行：各代占用百分比、GC 次数、GC 累计耗时
```

## 四、实战：造一段"能看懂"的 GC 日志

光讲理论记不住，我们写 30 行代码，人为制造 Young GC、Humongous 分配和 Full GC，然后看日志怎么反应。

```java
// GcDemo.java
import java.util.ArrayList;
import java.util.List;

public class GcDemo {
    public static void main(String[] args) throws Exception {
        boolean withHumongous = args.length > 0 && "humongous".equals(args[0]);
        List<byte[]> hold = new ArrayList<>();
        long i = 0;
        while (true) {
            byte[] data = new byte[64 * 1024];        // 64KB 普通小对象
            hold.add(data);
            if (hold.size() > 3000) hold.clear();     // 集体变垃圾，模拟请求高峰
            if (withHumongous && i % 50 == 0) {
                hold.add(new byte[4 * 1024 * 1024]);  // 4MB 大对象，后面有大用
            }
            i++;
            Thread.sleep(1);
        }
    }
}
```

跑两组：

```bash
javac GcDemo.java

# 组 A：默认堆配置 + 大对象（制造问题）
java -Xms1g -Xmx2g -Xlog:gc:file=gc-a.log:time,uptime GcDemo humongous

# 组 B：调优后的参数（后面第六节解释为什么这么改）
java -Xms2g -Xmx2g -XX:MaxGCPauseMillis=50 -Xlog:gc:file=gc-b.log:time,uptime GcDemo humongous
```

每组跑 5~10 分钟，`Ctrl+C` 停掉就行。接下来就是重头戏：读日志。

## 五、gc.log 逐行解读

组 A 跑出来的日志，挑四种最有代表性的行：

```text
[info][gc] GC(24) Pause Young (Normal) (G1 Evacuation Pause) 614M->89M(2048M) 21.883ms
[info][gc] GC(25) Pause Young (Concurrent Start) (G1 Humongous Allocation) 1024M->120M(2048M) 28.412ms
[info][gc] GC(26) Pause Mixed (Normal) (G1 Compaction Pause) 900M->150M(2048M) 35.677ms
[info][gc] GC(31) Pause Full (G1 Compaction Pause) 1800M->300M(2048M) 612.441ms
```

逐段拆解（以第一行为例）：

| 片段 | 含义 |
| --- | --- |
| `GC(24)` | 第 25 次 GC（从 0 编号），用来在日志里串联同一轮 GC 的多条记录 |
| `Pause Young` | 这是一次 STW 的年轻代回收 |
| `(Normal)` | 触发原因：Eden 满了，常规操作 |
| `(Concurrent Start)` | 这轮 Young GC 结束后要启动并发标记（Mixed GC 的前奏） |
| `(G1 Humongous Allocation)` | 触发原因是大对象分配——看到这行频繁出现，就该查代码里的大对象了 |
| `Pause Mixed` | 混合回收：年轻代 + 一批垃圾最多的老年代分区 |
| `Pause Full` | 全堆压缩，**看到它先报警再排查** |
| `614M->89M(2048M)` | 堆占用：回收前 614M → 回收后 89M，总容量 2048M |
| `21.883ms` | 本次 STW 停顿时长——我们最关心的数字 |

两个重点提醒：

1. **触发原因括号里的词是排查入口**。`G1 Evacuation Pause` 是正常满触发；`G1 Humongous Allocation` 说明大对象在挤内存；如果日志里出现 `To-space exhausted`（晋升时找不到落脚点），说明老年代碎片化严重，离 Full GC 不远了。
2. `-Xlog:gc*` 下每行停顿结尾还会有 `user/sys/real` 三个时间，`real` 才是应用实际暂停的墙钟时间，别被 user 时间（多线程累加值）吓到。

## 六、压测对比：调参前后到底差多少

光看懂日志还不够，得有数据说话。实验设计：

- 机器：4C8G 云主机，JDK 17.0.10；
- 每组跑同样的 `GcDemo humongous` 10 分钟；
- 用下面的命令从日志里提取所有停顿耗时，算分位数（**这条命令建议直接抄走，日常就能用**）：

```bash
grep -E 'Pause (Young|Mixed|Full)' gc-a.log \
  | awk '{gsub("ms","",$NF); print $NF}' \
  | sort -n \
  | awk '{a[NR]=$1} END{printf "count=%d P50=%.1f P95=%.1f P99=%.1f max=%.1f (ms)\n", NR, a[int(NR*0.5)], a[int(NR*0.95)], a[int(NR*0.99)], a[NR]}'
```

> 分位数（P50/P95/P99）：把所有样本从小到大排序，P99 就是"99% 的样本都比它小"。GC 停顿是典型的长尾分布，平均值没意义，**调优看的永远是 P99 和 max**。

我本机的一组示例结果（绝对值和机器强相关，请以自己环境实测为准，重点看趋势）：

| 组 | 关键参数 | Young/Mixed 次数 | Full GC | P50 | P95 | P99 | 最大 | STW 总占比 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | `Xms1g Xmx2g` 默认其余 | 138 / 6 | **1** | 21ms | 57ms | 96ms | 612ms | 4.1% |
| B1 | `Xms2g Xmx2g` | 117 / 5 | 1 | 18ms | 43ms | 71ms | 601ms | 3.0% |
| B2 | B1 + `MaxGCPauseMillis=50` | 152 / 9 | 0 | 12ms | 27ms | 44ms | 52ms | 2.6% |
| B3 | B2 + `G1HeapRegionSize=16m` | 118 / 4 | 0 | 13ms | 29ms | 41ms | 48ms | 2.2% |

**怎么验证结论**（每一步都可复现）：

1. Full GC 从 1 次降到 0 次：`grep -c 'Pause Full' gc-*.log`；
2. P99 停顿从 96ms 降到 41ms，max 从 612ms 降到 48ms：上面那条 awk 命令对每个日志文件各跑一遍；
3. STW 总占比（吞吐损失 proxy）：`grep -E 'Pause' gc.log | awk '{gsub("ms","",$NF); s+=$NF} END{print s/600000}'`（600 秒样本换算成百分比）；
4. 懒人法：把 gc.log 上传到 [GCEasy](https://gceasy.io)，自动出分位报告和分配热点图，和手算结果交叉验证。

从表里读三个结论：

1. **max 那个 600ms+ 就是 Full GC 干的**，一次就毁掉整组指标——所以"消灭 Full GC"永远排第一位；
2. `MaxGCPauseMillis=50` 让 GC 变频繁（152 次 vs 117 次）但每次更短，总 STW 占比反而降了——G1 是拿吞吐换延迟，这个 trade-off 要心里有数；
3. Region 调大后 4MB 对象不再是 Humongous，Mixed 次数和 P99 进一步下降——**有时候最好的调参是改业务代码**。

真实服务的同款验证：用 wrk/JMeter 压接口，对比调参前后接口 P99，趋势应该和 GC 停顿一致；如果不一致，说明瓶颈根本不在 GC，别白调了。

## 七、调优三板斧

参数几百个，日常 90% 的问题这三板斧就够：

**第一板斧：`-Xms` 和 `-Xmx` 设成一样。** 堆动态伸缩意味着 GC 策略频繁切换、内存重新申请，容器里还容易把 RSS 顶到 limit 被 OOMKill。在线服务一律写死。

**第二板斧：`MaxGCPauseMillis` 按 SLA 倒推，别凭感觉。** 它是给 G1 的"目标停顿"，默认 200ms。接口要求 P99 < 100ms，就设 50；如果业务是跑批，把它调大（甚至几百 ms）反而吞吐更高。**千万别设成 10ms**——G1 会把年轻代压得很小，GC 频率翻几倍，吞吐崩给你看。

**第三板斧：盯死 Humongous。** 优先级永远是：业务侧拆对象（大 byte[]、大 JSON、一次查 10 万行的结果集）> 调 `G1HeapRegionSize`（显式指定，配合 `G1ReservePercent` 预留空间）。判断方法就一条：日志里高频出现 `G1 Humongous Allocation`，就是它在报警。

进阶两个：`InitiatingHeapOccupancyPercent`（默认 45，老年代占用到多少启动并发标记；调小 = 标记更勤、更不容易 Full GC，代价是 CPU 略涨）、容器里用 `-XX:MaxRAMPercentage=75` 替代写死的 `-Xmx`（让 JVM 自己按容器 limit 算堆大小）。

## 八、常见坑（我踩过的）

1. **JDK 8 参数用在 JDK 17 上没反应**。`-XX:+PrintGCDetails` 在 9+ 被映射成兼容模式，格式对不上；统一改用 `-Xlog:gc*`。
2. **只看平均停顿**。平均 20ms 的 GC 完全可以藏着一次 600ms 的 Full GC。看分位数，看 max，看 Full GC 次数。
3. **日志没开滚动**，几个月后磁盘告警。`filecount` + `filesize` 是生产标配。
4. **日志没带时间戳**，想和 APM 里的慢请求对时间线对不上。`time,uptime` 两个都带上。
5. **把 Full GC 当正常现象**。G1 的 Full GC 是兜底，JDK 10 之前甚至是单线程的。出现即事故：查 Humongous、查堆是否太小、查 `To-space exhausted`。
6. **盲目加堆**。堆越大单次 GC 越慢，G1 只是让停顿可控，不是免费午餐。先确认是不是大对象/缓存无界的问题，再谈加内存。
7. **容器里不设 `MaxRAMPercentage`**，JVM 按宿主机内存算堆，直接被 k8s OOMKill，而且杀之前连 OOM 异常的日志都没有。

## 九、总结

- GC 是 Java 服务 P99 长尾的头号嫌疑人，排查第一步永远是**打开 gc.log**：`-Xlog:gc*,...:file=gc.log:time,uptime,...`；
- 日志主要看四样：**触发原因、停顿时长、回收前后堆占用、有没有 Full GC**；
- 调优看数据不看口诀：awk 一行命令算 P50/P95/P99，GCEasy 交叉验证，消灭 Full GC 永远优先；
- 三板斧：`Xms=Xmx`、`MaxGCPauseMillis` 按 SLA 倒推、盯死 Humongous（能改代码就别调参数）；
- 调完必须同口径压测对比，接口 P99 和 GC 停顿趋势对不上，说明瓶颈不在这。

## 参考资料

1. Oracle 官方调优指南：Garbage-First Garbage Collector — <https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector.html>
2. JEP 248: G1 as the Default Garbage Collector — <https://openjdk.org/jeps/248>
3. Oracle 技术文章：The Garbage-First Garbage Collector — <https://www.oracle.com/technical-resources/articles/java/g1gc.html>
4. OpenJDK HotSpot Wiki：G1 — <https://wiki.openjdk.org/display/HotSpot/G1>
5. 周志明《深入理解 Java 虚拟机（第 3 版）》第 3 章：垃圾收集器与内存分配策略
6. GCEasy 在线 GC 日志分析工具 — <https://gceasy.io>
