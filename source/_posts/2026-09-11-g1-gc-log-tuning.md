---
title: 读懂 G1 GC 日志：一次 Full GC 频发的排查与调优实战，附压测前后对比
date: 2026-09-11 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - JVM
  - G1
  - GC 日志
  - Full GC
  - 性能调优
  - 压测
---
<hr>
<blockquote>
<p><strong>一句话结论</strong>：G1 上「Full GC 频发」多数时候不是参数没调好，而是 <strong>Humongous 大对象 + 堆弹性伸缩</strong>把老年代架起来烤的。<br>本文从一个典型症状入手（高峰期接口 P99 从 90ms 抽风到 700ms+），带你把 <strong>GC 日志当成案发现场的监控录像</strong>逐帧看懂：Young/Mixed/Full GC 各自长什么样、To-space exhausted 意味着什么、怎么从日志倒推出元凶接口，最后给出「代码改造 + JVM 参数」的组合拳，以及<strong>压测前后对比（P99 720ms → 118ms，Full GC 12 次/小时 → 0）</strong>，每一步都可复现。</p>
</blockquote>

<!-- more -->

## 一、背景：P99 的「抽风」不是网络抖动

先说场景。我们有一个聚合查询服务：接两个下游 RPC + 一层 Redis 缓存，容器 4C8G，JDK 17，堆上限 8G。平时岁月静好，P99 稳定在 90ms 上下。

但从某个版本上线开始，高峰期监控变成了这样：

- 接口 **P99 时不时抽到 700ms+**，P95 偶尔跟着抖；
- JMX 里 `G1 Old Generation` 的收集次数一路上涨（注意：JMX 里的名字叫 Old Generation，但在 G1 上这可能对应的是 Mixed GC 或 Full GC，下面会讲怎么区分）；
- 日志里能明确看到 `Pause Full (Allocation Failure)`，**每小时 10 次以上，单次停顿 600~800ms**。

一次 Full GC 意味着什么？简单说：**所有业务线程全部停住，等 GC 干完活才放行**（即 **STW**，Stop-The-World，全员罚站）。单次 700ms 的停顿，足以把依赖它的接口 P99 直接顶穿。

如果你只看监控大盘，很容易误判成「下游慢」「网络抖动」。这类问题的标准破案工具只有一个：**GC 日志**。它就像案发现场的监控录像，JVM 每一次回收的动机、过程、结果，全在里面。

> 注：本文的日志示例基于 JDK 17 的统一日志（-Xlog）格式。JDK 8 的格式长得不太一样，但字段含义相通，第八节给了采集命令。

## 二、先补课：G1 的几个关键词，看日志前必须认识

不认识名词看日志，跟不看说明书拆保险丝盒一样。这里用最短的话把 G1 的核心概念过一遍，**每个词第一次出现都会解释**，后文直接使用。

**G1**（Garbage First，JDK 9 起的默认收集器）：名字来自它的核心思路——把堆切成一堆大小相等的 **Region**（区域），回收时优先挑「垃圾占比最高」的那几个 Region 收，所以叫「垃圾优先」。

堆被切分后，每个 Region 会动态扮演一个角色：

- **Eden**：新对象出生地，绝大多数对象死在这里；
- **Survivor**：从 Eden 活下来的对象先搬到这里「观察期」住着；
- **Old**：熬过观察期的对象入住老年代，养老；
- **Humongous**：**体积 ≥ Region 一半的大对象**专用区，可能占连续多个 Region。

其他高频词：

- **RSet**（Remembered Set，引用登记簿）：记录「有哪些外部 Region 的对象引用了我」。有了它，G1 才能做到**只回收一部分 Region**，而不是动整个堆。
- **SATB**（Snapshot-At-The-Beginning，起始快照）：G1 并发标记用的算法。标记开始那一刻给存活对象拍张「快照」，之后并发阶段按快照判定生死，让标记能和业务线程同时跑。
- **IHOP**（Initiating Heap Occupancy Percent，并发标记触发线）：老年代占堆的比例达到这个值（默认 45%），G1 就启动一轮并发标记，标记完进入 Mixed GC 阶段。

## 三、G1 的 GC 到底分几种？先分清再看日志

很多「G1 出问题了」的结论，其实是把几种完全不同性质的回收混为一谈。对比如下：

| 类型 | 名称长相（日志） | 回收范围 | 停顿 | 性质 |
| --- | --- | --- | --- | --- |
| Young GC | `Pause Young (Normal)` | 所有 Eden + Survivor | 短（几十 ms） | **正常**，定期发生的例行工作 |
| 并发标记 | `Concurrent Mark Cycle` 系列日志 | 只标记不停业务 | 业务不停顿 | 正常，为 Mixed 做准备 |
| Mixed GC | `Pause Young (Mixed)` | Young + **部分**老 Region | 中短 | 正常，G1 的主打回收 |
| **Full GC** | `Pause Full (Allocation Failure)` | **整个堆**，单线程/压缩 | **长（几百 ms 起）** | **兜底手段，出现即报警** |

一句话记住：**Young 和 Mixed 是呼吸，Full 是急救**。急救偶尔一次可以理解，频发一定说明前面某个环节出了问题——要么分配太快消化不良，要么大对象把老年代顶爆，要么并发标记追不上分配速度。

## 四、第一步：把 GC 日志打开（采集步骤）

排查的第一原则：**没有日志，一切推测都是玄学**。上线前就该配好，别等出事再重启。

**JDK 11 及以后（推荐，统一日志）：**

```bash
java -Xms8g -Xmx8g \
  -Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=5,filesize=20m \
  -jar app.jar
```

格式拆解：`gc*` 表示 GC 相关的所有 tag 全开（含 `gc+phases`、`gc+heap` 等细分）；`time,uptime` 给每行加上墙钟时间和进程运行时间（对监控告警和定位很有用）；`filecount=5,filesize=20m` 开轮转，防止日志把磁盘写爆。

**JDK 8（老式参数）：**

```bash
java -Xms8g -Xmx8g \
  -XX:+PrintGCDetails -XX:+PrintGCDateStamps \
  -Xloggc:/var/log/app/gc.log \
  -XX:+UseGCLogFileRotation -XX:NumberOfGCLogFiles=5 -XX:GCLogFileSize=20M \
  -jar app.jar
```

> 注：想专门盯大对象分配，可以在 JDK 11+ 上追加 `-Xlog:gc+humongous=debug`（用 `java -Xlog:help` 可查当前 JDK 支持的全部 tag）。本文为了通用性，示例只用 `gc*`。

**验证日志确实在写：**

```bash
tail -f /var/log/app/gc.log
# 随便触发几次请求，能看到 [gc] 开头的新行即为生效
```

## 五、实战：把案发现场的日志逐段读出来

下面是我们服务出事期间的日志（做了脱敏和精简，但结构一致）。按时间顺序，出现了四类关键线索。

**线索 1：正常的 Young GC 长这样**

```
[gc] GC(128) Pause Young (Normal) (G1 Evacuation Pause)
[gc] GC(128)   Eden regions: 340->0(336)
[gc] GC(128)   Survivor regions: 24->28(48)
[gc] GC(128)   Old regions: 512->514
[gc] GC(128)   Humongous regions: 37->37
[gc] GC(128) Pause Young (Normal) 6984M->1248M(8192M) 38.2ms
```

逐行解读：第 128 次回收；Eden 的 340 个 Region 全清空；Survivor 24→28（一部分对象熬过这轮晋升进去了）；老年代 **512→514，涨了 2 个 Region**——这是正常晋升。末行是核心：回收前堆占用 6984M，回收后 1248M，堆总量 8192M，停顿 38.2ms。健康。

**线索 2：Humongous 数量纹丝不动，很可疑**

```
[gc] GC(128) Humongous regions: 37->37
[gc] GC(131) Humongous regions: 41->41
[gc] GC(134) Humongous regions: 45->45
```

正常情况下，短命大对象（比如临时拼的大数组）应该在 Young GC 中被清掉，Humongous 计数会回落。**只涨不跌**说明：要么对象活得久（被引用着），要么分配速度快到标记都追不上。记住这个疑点。

**线索 3：To-space exhausted——并发标记被顶穿了**

```
[gc] GC(139) Pause Young (Concurrent Start) (G1 Humongous Allocation)
[gc,gc_task] GC(140) Concurrent Mark Cycle 1456.7ms
[gc] GC(142) Pause Young (Concurrent End) (G1 Humongous Allocation)
[gc] GC(142)   To-space exhausted
[gc] GC(142)   Old regions: 640->1021
```

**To-space exhausted**：晋升时的「中转缓冲区」（一组预留的 Survivor/Old Region）用完了。它的含义很直接——**分配速度超过了 G1 的回收速度，老年代来不及腾地方**。紧接着触发 `Concurrent Mark Cycle`（并发标记周期），这是 G1 在拼命自救；标记结束后本应转入 Mixed GC 慢慢收老年代，但日志显示老年代还在疯涨（640→1021）。

**线索 4：急救发生——Full GC**

```
[gc] GC(147) Pause Full (Allocation Failure) 7800M->3120M(8192M) 736.5ms
```

`(Allocation Failure)`：又有线程要分配内存，但堆里实在挤不出来了，只能全堆压缩回收。**单次 736ms，就是 P99 抽风的真凶。**

到这里可以下结论了：**不是「GC 参数不行」，而是有一股持续的大流量在制造 Humongous 大对象，把老年代顶爆**。下一步是揪出它。

## 六、揪出元凶：从「大对象」反查到代码

光看 GC 日志只能知道「有大对象」，不知道是谁造的。两招定位：

**招式 1：分配热点火焰图（async-profiler）**

**async-profiler** 是一个低开销的 Java 性能剖析器，能把 CPU、内存分配等事件采样成「火焰图」（一层层堆叠的调用栈矩形，越宽代表占比越大）。

```bash
# 采集 60 秒的内存分配事件，输出火焰图
./asprof -d 60 -e alloc -f /tmp/alloc.html $(pgrep -f app.jar)
```

打开火焰图，按分配总量排序，一眼看到最宽的一块：

```text
AggregateServiceImpl.fetchAll
  └─ new byte[52_428_800]      # 一次分配 50MB！
```

**招式 2：humongous 分配日志（JDK 11+ 可选）**

```
[gc,alloc] GC(150) Humongous allocation: 52428800 bytes
```

顺着 50MB 这个数字查代码，定位到一个「导出」接口：为了让前端拿全量数据，直接把整表结果一次性装进一个大 `byte[]` 再序列化。高峰期它每秒触发几次，每次 50MB，全部走 Humongous 路径直进老年代——**这就是老年代只涨不跌的根源**。

## 七、调优：代码 + 参数的组合拳，附压测前后对比

参数治标，代码治本。这次一共动了三处：

**改造 1（根治）：消灭一次性大对象**

把「整表一次性加载」改成**分页拉取 + 流式写出**，单次分配从 50MB 降到 KB 级，彻底不再触发 Humongous 路径。

```java
// Before：一把梭，50MB 大对象直奔老年代
byte[] all = serialize(queryAll(table));

// After：分页 + 流式，边查边写
try (PagedCursor cursor = queryByPage(table, PAGE_SIZE)) {
    while (cursor.next()) {
        stream.write(cursor.currentRow());
    }
}
```

**改造 2：`-Xms` 与 `-Xmx` 拉平**

原来 `-Xms4g -Xmx8g`。堆是弹性的没错，但代价是：堆水位涨到触发扩容、再缩回去，会**频繁越过 IHOP 触发并发标记**，白烧 CPU 还制造额外的不确定性。常驻服务直接 `-Xms8g -Xmx8g`，把弹性抖动关掉。

**改造 3：给晋升留缓冲**

追加 `-XX:G1ReservePercent=20`（默认 10，预留更多「TO 空间」应对晋升洪峰）和 `-XX:G1HeapRegionSize=8m`（略调大 Region，减少 Humongous 误判概率），作为兜底保险。

**没有动** `MaxGCPauseMillis`（保持默认 200ms）和 IHOP（保持 45）——没搞清楚现状前乱拧这两个旋钮，很容易按下葫芦浮起瓢（坑见第九节）。

**压测验证（wrk，8 线程 / 300 连接 / 持续 10 分钟，改造前后各跑一轮）：**

| 指标 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| Full GC（次/小时） | 12 | **0** | 根治 |
| Young GC 平均停顿 | 41ms | 36ms | -12% |
| 接口 P50 | 85ms | 82ms | 基本持平 |
| 接口 P95 | 210ms | 130ms | **-38%** |
| 接口 P99 | 720ms | 118ms | **-84%** |
| 吞吐量 | 1850 req/s | 2300 req/s | **+24%** |

> 注：数据来自本地 KVM 环境（4C8G、JDK 17.0.10），绝对值只做方向参考，重点是**相对变化**：Full GC 归零后，长尾延迟和吞吐同步改善——因为业务线程不再动不动「全员罚站 700ms」。

## 八、怎么验证这套结论可复现

如果你想在自己的服务上走一遍完整流程：

1. **开日志**：按第四节命令重启服务，确认 `gc.log` 在增长；
2. **跑基线压测**：`wrk -t8 -c300 -d10m --latency http://<host>:<port>/<api>`，记录 P50/P95/P99 与吞吐；
3. **看日志找症状**：`grep -c "Pause Full" gc.log` 数 Full GC 次数；`grep "Humongous regions" gc.log` 看计数是否只涨不跌；搜 `To-space exhausted`；
4. **定位分配点**：`./asprof -d 60 -e alloc -f /tmp/alloc.html <pid>`，火焰图找最宽的大数组；
5. **改代码/参数**（参考第七节三处改造）；
6. **复测对比**：同样的 wrk 参数再跑一轮，对比表格；同时确认 `grep -c "Pause Full"` 归零；
7. **可选工具**：把 `gc.log` 丢进 **GCViewer**（开源桌面工具，可视化停顿/吞吐）或 **GCEasy**（在线分析，直接给出分配速率、停顿分布和建议），两条路交叉验证，避免肉眼看漏。

## 九、常见坑：这些旋钮别乱拧

1. **把 `MaxGCPauseMillis` 调到 20ms 这类激进值**。G1 为了凑够「20ms 内干完」，每轮 Young GC 只敢回收很少的 Region → 回收变频繁、Mixed 跟不上 → 老年代涨更快 → 更容易 Full GC。**目标是让 G1 不慌，不是把口号喊小。**
2. **只调参不改代码**。Humongous 是「分配行为」问题，参数只能缓解症状。本次案例里真正起决定作用的是分页改造——参数那两条只是保险。
3. **`-Xms` 不等于 `-Xmx` 当成「灵活」**。弹性堆在云环境里反复 commit/uncommit，等于反复在 IHOP 线附近横跳，并发标记周期异常频繁。常驻服务拉平。
4. **用 `-XX:+DisableExplicitGC` 硬压 `System.gc()`**。Full GC 不见了≠问题解决了：堆外内存（DirectByteBuffer）的回收依赖 `System.gc()` 触发，禁掉之后可能出现堆没事、**堆外内存 OOM** 的更诡异故障。要用也请配 `-XX:+ExplicitGCInvokesConcurrent`。
5. **「Full GC 频发 → 加大堆」的条件反射**。堆越大，Full GC 的压缩停顿越长——从 700ms 变 2s。先搞清楚为什么 Full，再谈加不加。
6. **只盯堆，忘了 Metaspace 和堆外**。类加载器泄漏、Direct Memory 涨，日志表象都可能「像」堆问题。排查时 `-Xlog:gc+metaspace`（JDK 11+）和 `Native Memory Tracking` 一起看。
7. **日志没加墙钟时间戳、没配轮转**。对不上监控告警时间点，或者磁盘被写爆引发二次事故，都是排查时的经典翻车。

## 十、总结

- **G1 的 Young/Mixed GC 是正常呼吸，Full GC 是急救**——急救频发必有隐情；
- 排查路径固定四步：**开日志 → 认症状（Humongous 不跌、To-space exhausted、Pause Full）→ 火焰图定位分配点 → 代码 + 参数组合拳**；
- **Humongous 大对象是 G1 时代最常见的 Full GC 元凶**：≥ Region 一半就算大对象，直进老年代路径；
- 参数层面最有性价比的两件事：`-Xms=-Xmx` 关掉弹性抖动、`G1ReservePercent` 给晋升留缓冲；`MaxGCPauseMillis` 和 IHOP 别盲调；
- 一切结论以**压测前后对比 + GC 日志复核**为准，没有数据的调优都是玄学。

## 参考资料

1. Oracle 官方文档：Getting Started with the G1 Garbage Collector —— https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector.html
2. 美团技术团队：《Java Hotspot G1 垃圾回收器介绍与调优》—— https://tech.meituan.com/2016/09/23/g1-introduction.html
3. 周志明：《深入理解 Java 虚拟机（第 3 版）》第 3 章「垃圾收集器与内存分配策略」，机械工业出版社
4. GCViewer（开源 GC 日志可视化分析工具）—— https://github.com/chewiebug/GCViewer
5. GCEasy（在线 GC 日志分析）—— https://gceasy.io/
6. async-profiler（CPU/分配火焰图采集）—— https://github.com/async-profiler/async-profiler
