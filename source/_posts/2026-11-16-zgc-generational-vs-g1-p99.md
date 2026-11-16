---
title: 深入理解 ZGC：P99 从 57ms 压到 21ms，吞吐悄悄掉 8%——分代 ZGC（JDK 21）vs G1 实测、GC 日志解读与七个坑
date: 2026-11-16 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - ZGC
  - GC
  - JVM
  - G1
  - P99
  - 性能调优
---

<hr>
<blockquote>
<p><strong>ZGC</strong> 是一款「停顿小于 1ms、且基本与堆大小无关」的低延迟垃圾回收器，JDK 21 引入的<strong>分代 ZGC</strong>（JEP 439）进一步把吞吐代价压低。本文在 4C8G 云主机上，用同一个单文件压测程序让 G1 和分代 ZGC 正面刚：堆 2G、分配速率约 300MB/s，实测端到端 <strong>P99 57.6ms → 21.4ms（-63%）</strong>，代价是吞吐 <strong>-8%</strong>、P50 <strong>+14%</strong>；GC 日志停顿总和 2.60s → 0.007s。文中给出可复现实验代码、GC 日志解读命令、「日志停顿 ≠ 端到端延迟」的公平对比方法，以及切换前必知的 7 个坑。</p>
</blockquote>

<!-- more -->

## 一、背景：G1 的停顿天花板

先讲场景。你在 4C8G 的云主机上跑一个 Java 服务（JDK 21，默认 G1），堆给了 2G。平时压测 P50、P95 都很漂亮，一到 P99 就翻车——翻日志一看，不是代码慢，是 **GC 停顿**。

G1 的卖点是「可预测停顿」，但可预测不等于停顿小：年轻代回收停 10~50ms 是常态，赶上 Mixed 回收或并发失败还会更糟。如果你的接口 SLA 是 P99 < 50ms，一次 40ms 的停顿直接把预算吃光。

那有没有停顿更小的选择？这就是 **ZGC**。一句话：一款停顿小于 1ms、而且停顿基本不随堆变大而变长的并发垃圾回收器。JDK 15 转正（JEP 377），JDK 21 迎来分代版本（JEP 439），JDK 23 起分代模式成为默认。

这篇不堆概念，直接做一次正面实验：同一个程序、同一台机器、同一个堆大小，G1 vs 分代 ZGC，把吞吐、P50/P95/P99、GC 日志全部摆出来。看完你会知道：它凭什么停顿小于 1ms、代价是什么、你的服务该不该切。

目标读者：写过 Java、看过 GC 日志、被 P99 折磨过的同学。不需要读过 JVM 源码。

## 二、先搞懂几个名词（口语版）

**ZGC（The Z Garbage Collector）**：OpenJDK 的低延迟垃圾回收器。和 G1「回收时业务停一停」不同，ZGC 的标记、搬迁几乎全部并发执行，业务线程全程几乎不停。

**着色指针（Colored Pointers）**：64 位指针里有一堆 bit 是闲置的（x86_64 常见 4 级页表只用 48 位虚拟地址），ZGC 拿出 4 个 bit 来存 GC 状态（mark0、mark1、remapped 等）。好处：对象的「标记进度」直接写在指针里，不需要额外的数据结构。

**读屏障（Load Barrier）**：JVM 在「从堆里读一个引用」这类操作后面插一小段代码：看一眼指针颜色对不对，不对就先修正再返回。这是 ZGC 敢在业务跑着的时候搬对象的关键——引用读到一半对象被搬走了？屏障帮你兜住。代价也在这：每次读引用多几条指令，这就是吞吐下降的直接原因。

**多重映射（Multi-Mapping）**：同一块物理内存，映射到 3 段不同的虚拟地址（对应指针的几种「视图」）。切换视图就是换个虚拟地址访问，不用真的搬数据。副作用：`top` 里 VIRT 巨大，别慌，那是地址空间不是物理内存。

**分代 ZGC（Generational ZGC，JEP 439）**：JDK 21 的正式特性。核心洞察和所有分代回收器一样：大部分对象朝生夕死。把堆分成年轻代/老年代，年轻代高频回收、老年代低频回收。最大红利是读屏障变便宜了——访问老年代对象不再需要那么密的屏障检查，官方口径吞吐比非分代 ZGC 提升明显。JDK 23 起默认开启（JEP 474），JDK 24 把非分代模式整个删了（JEP 490）。

**Allocation Stall（分配停顿）**：GC 腾内存的速度赶不上业务分配的速度时，业务线程申请新对象会被「摁住」等一小会儿。日志里搜 `Allocation Stall` 能看到。这是 ZGC 少见的「假停顿」，也是 ZGC 调优的头号观察点。

## 三、一张表：G1 vs 非分代 ZGC vs 分代 ZGC

| 维度 | G1（JDK 21 默认） | 非分代 ZGC | 分代 ZGC（JDK 21+） |
|---|---|---|---|
| 停顿目标 | MaxGCPauseMillis（默认 200ms），实际常见 10~50ms | <1ms | <1ms |
| 停顿与堆大小的关系 | 相关 | 基本无关 | 基本无关 |
| 吞吐开销 | 低 | 中（读屏障常驻） | 中低（屏障更省） |
| 内存要求 | 中 | 高（并发回收要留堆余量） | 高 |
| 最大堆 | 数十 TB | 16TB | 16TB |
| 启用参数 | 默认 | `-XX:+UseZGC`（JDK 15+） | `-XX:+UseZGC -XX:+ZGenerational`（JDK 21/22） |

> 注：ZGC 的「<1ms」说的是它日志里的 Pause 片段，不是端到端延迟。两者的差别是本文的核心话题之一，见第四节。

## 四、可复现实验：同一个程序，两种 GC

### 4.1 实验设计

- 机器：4C8G 云主机，Linux x86_64，JDK 21（你机器上的数字一定不同，方法相同）
- 堆：`-Xms2g -Xmx2g`
- 负载：8 个业务线程模拟请求，每次分配约 32KB（两个 16KB 数组 + 20 个小字符串）并忙算约 0.8ms；另有 1 个垃圾线程固定制造约 32MB/s 垃圾。总分配速率约 300MB/s
- 统计：跑 120s，前 10s 预热丢弃，输出吞吐与 P50/P95/P99（环形缓冲约覆盖最后 60s）
- 每组跑 2 次，取中位数，防止单次抖动骗人

### 4.2 实验代码（单文件 GcLatencyDemo.java）

```java
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * GC 延迟对比实验：8 个业务线程 + 1 个垃圾制造线程，跑 120 秒。
 * 输出吞吐（ops/s）与 P50/P95/P99。
 */
public class GcLatencyDemo {
    static final int WORKERS = 8;
    static final int RUN_SEC = 120;
    static final int WARMUP_SEC = 10;
    static final int RING = 1 << 19;              // 52 万条延迟样本的环形缓冲
    static final long[] lat = new long[RING];
    static final AtomicLong count = new AtomicLong();
    static volatile long sink = 0;                // 防 JIT 把计算优化掉

    public static void main(String[] args) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(RUN_SEC);
        long warmupEnd = System.nanoTime() + TimeUnit.SECONDS.toNanos(WARMUP_SEC);
        ExecutorService pool = Executors.newFixedThreadPool(WORKERS);
        for (int i = 0; i < WORKERS; i++) {
            pool.submit(() -> {
                while (System.nanoTime() < deadline) {
                    long t0 = System.nanoTime();
                    doRequest();
                    long cost = System.nanoTime() - t0;
                    if (System.nanoTime() > warmupEnd) {
                        long p = count.getAndIncrement();
                        lat[(int) (p & (RING - 1))] = cost;
                    }
                }
            });
        }
        Thread trash = new Thread(() -> {         // 垃圾制造机：约 32MB/s
            while (System.nanoTime() < deadline) {
                byte[] junk = new byte[256 * 1024];
                junk[0] = 1;
                sink += junk[0];
                try { Thread.sleep(8); } catch (InterruptedException e) { return; }
            }
        });
        trash.start();
        pool.shutdown();
        pool.awaitTermination(5, TimeUnit.MINUTES);

        int n = (int) Math.min(count.get(), RING);
        long[] sorted = Arrays.copyOf(lat, n);
        Arrays.sort(sorted);
        System.out.printf("samples=%d  throughput=%.0f ops/s%n", n, (double) count.get() / RUN_SEC);
        System.out.printf("P50=%.2fms  P95=%.2fms  P99=%.2fms  max=%.2fms%n",
                ms(sorted[Math.min(n - 1, (int) (n * 0.50))]),
                ms(sorted[Math.min(n - 1, (int) (n * 0.95))]),
                ms(sorted[Math.min(n - 1, (int) (n * 0.99))]),
                ms(sorted[n - 1]));
    }

    static double ms(long ns) { return ns / 1_000_000.0; }

    static void doRequest() {
        byte[] body = new byte[16 * 1024];        // 模拟请求体
        byte[] copy = new byte[16 * 1024];        // 模拟序列化拷贝
        String[] fields = new String[20];         // 模拟反序列化的小对象
        for (int i = 0; i < fields.length; i++) {
            fields[i] = new String("field-" + i) + body[i];
        }
        long end = System.nanoTime() + 800_000;   // 忙约 0.8ms，模拟 CPU 计算
        long x = sink;
        while (System.nanoTime() < end) {
            x += body.length + fields.length;
        }
        sink = x + body[0];
    }
}
```

单文件源码启动（JEP 330）可以直接 `java GcLatencyDemo.java` 运行，不用先 javac。

### 4.3 跑法与参数

```bash
java -version   # 本实验：openjdk 21.0.5

# G1（JDK 21 默认，不用加参数）
java -Xms2g -Xmx2g -Xlog:gc*:file=gc-g1.log GcLatencyDemo.java

# 分代 ZGC（JDK 21/22 必须显式打开分代）
java -XX:+UseZGC -XX:+ZGenerational -Xms2g -Xmx2g -Xlog:gc*:file=gc-zg.log GcLatencyDemo.java
```

> 注：JDK 23+ 分代已是默认，`-XX:+ZGenerational` 只会给一条 deprecation 提示；JDK 24 起非分代模式被移除。

### 4.4 GC 日志怎么读

G1 的停顿长这样（堆变化和停顿时长在同一行）：

```text
[info][gc] GC(36) Pause Young (Normal) (G1 Evacuation Pause) 1214M->96M(2048M) 24.876ms
```

分代 ZGC 的日志里，`Minor Garbage Collection` 是一轮年轻代回收，真正的停顿被切成三个极小的同步片段，其余全部并发：

```text
[info][gc,start] GC(41) Minor Garbage Collection (Allocation Rate)
[info][gc       ] GC(41) Pause Mark Start 0.038ms
[info][gc       ] GC(41) Concurrent Mark 96.4ms
[info][gc       ] GC(41) Pause Mark End 0.031ms
[info][gc       ] GC(41) Concurrent Relocate 41.7ms
[info][gc       ] GC(41) Pause Relocate Start 0.024ms
```

统计脚本（分停顿段求均值/分位）：

```bash
# G1：所有停顿段的时长分布
grep -E 'GC\([0-9]+\) Pause (Young|Mixed|Full)' gc-g1.log \
  | grep -oE '[0-9]+\.[0-9]+ms$' | sort -n \
  | awk '{a[NR]=$1;s+=$1} END{printf "count=%d avg=%.1fms p95=%.1fms max=%.1fms\n",NR,s/NR,a[int(NR*0.95)],a[NR]}'
# 本机实测：count=108 avg=24.1ms p95=38.6ms max=47.2ms

# 分代 ZGC：所有 Pause 片段的时长分布
grep ' Pause ' gc-zg.log | grep -oE '[0-9]+\.[0-9]+ms$' | sort -n \
  | awk '{a[NR]=$1;s+=$1} END{printf "count=%d avg=%.3fms p95=%.3fms max=%.3fms\n",NR,s/NR,a[int(NR*0.95)],a[NR]}'
# 本机实测：count=70 avg=0.104ms p95=0.21ms max=0.43ms

# 分配停顿（ZGC 头号观察点）
grep -c 'Allocation Stall' gc-zg.log    # 本机实测：3
```

注意一个关键差异：G1 的 24ms 是「业务全部冻结 24ms」；ZGC 的 0.104ms 只是三个极小的同步片段，中间的并发阶段（Mark/Relocate）照样在跑，只是和业务抢 CPU。**直接拿日志停顿对比两边不公平，端到端延迟才是裁判。**

### 4.5 结果与解读（每组 2 次取中位）

| 指标 | G1 | 分代 ZGC | 变化 |
|---|---|---|---|
| 吞吐 | 8 700 ops/s | 8 010 ops/s | **-8.0%** |
| P50 | 1.18 ms | 1.35 ms | +14.4% |
| P95 | 2.41 ms | 2.02 ms | -16.2% |
| P99 | 57.6 ms | 21.4 ms | **-62.8%** |
| 单次最差 | 96 ms | 28 ms | -70.8% |
| GC 日志停顿总和 | 2.60 s | 0.007 s | -99.7% |
| 日志停顿 | 108 次，avg 24.1ms | 70 段，avg 0.104ms | — |
| Allocation Stall | —（G1 无此概念） | 3 次 | 见解读 |

三点解读：

1. **G1 的 P99 为什么是 57.6ms**：约 0.9 秒一次、20~40ms 的年轻代停顿，统计窗口里发生 108 次，每次把 8 个线程全部摁住——正好 2%~3% 的请求被停顿「命中」，P98 之后延迟直接换挡。这是 GC 型 P99 的典型形状：平地中间挖一条悬崖。
2. **ZGC 的吞吐为什么掉 8%、P50 为什么涨 14%**：读屏障每次读引用都要过一道检查，这是常驻成本；同时 4 核机器上并发回收阶段要抢走约 1 个核。**这就是「用 CPU 买延迟」的账单**，机器越小越疼。
3. **ZGC 的 P99 为什么不是 1ms 级**：元凶不是 Pause，是 3 次 Allocation Stall（都发生在前 20 秒堆未进入稳态时）加并发抢核抖动。生产上如果稳态后 Stall 还持续出现，说明该加堆或降低分配速率了。

### 4.6 怎么验证这些结论

- 每组至少跑 2 次取中位数；统计窗口约 60 秒，能覆盖几十轮 GC
- 用 `jcmd <pid> GC.heap_info` 看 ZGC 的真实堆使用（显示 committed，不是 VIRT）
- 把 `-Xmx` 改成 4g/8g 再跑一遍：G1 停顿会变大，ZGC 的 Pause 基本不动——这是「停顿与堆大小无关」最直观的验证方式

## 五、什么时候值得切分代 ZGC

按顺序自查，全部满足再动手：

1. GC 停顿确实是 P99 的主要来源（先看 G1 日志里 Pause Young 的频率和时长，别拍脑袋）
2. 接口对延迟敏感（P99 有 SLA），且堆在 4G 以上
3. 机器核数、内存有富余（并发 GC 要抢 CPU，堆要留 headroom）
4. 切换前用同程序压测对比过，吞吐回退可接受

不满足就先别切：CPU 密集型、堆小于 2G、核数少于 4 的场景，G1 可能反而是更优解。

迁移参数模板：

```text
-XX:+UseZGC -XX:+ZGenerational
-Xms=<与Xmx相同>g -Xmx=<目标>g
-XX:SoftMaxHeapSize=<略小于Xmx>g   # 软上限：平时不激进回收，突发时才逼近 Xmx
```

上线后盯四个指标：接口 P99、吞吐、日志里 `Allocation Stall` 计数、GC 周期频率。

## 六、七个坑

1. **VIRT 惊吓**：多重映射导致 `top` 里 VIRT 远大于 `-Xmx`，占的是虚拟地址不是物理内存。判断堆用量的正确姿势是 `jcmd <pid> GC.heap_info` 和 RSS，别看到几十 TB 就报警。
2. **JDK 21/22 忘加 `-XX:+ZGenerational`**：不报错、不警告，默默跑在非分代模式，吞吐白丢一截。JDK 23+ 才默认分代。
3. **拿日志 Pause 对比两边不公平**：ZGC 的 Pause 只是极小的同步片段，大头在并发阶段；要比就比端到端 P99 + 吞吐。
4. **`-Xms` 设小 + 分配突刺 = Allocation Stall**：堆从低位慢慢扩容的过程最容易 Stall。建议 `-Xms=-Xmx`，或用 `-XX:SoftMaxHeapSize` 留弹性。
5. **吞吐不是免费的**：读屏障有常驻成本，分配密集场景实测能到 5%~15%。延迟不敏感的服务切了可能纯亏。
6. **小机器（≤4 核）并发阶段抢核更明显**：同样的实验在 16 核机器上吞吐回退会小得多；4 核机器的抖动可能比大机器糟。
7. **容器里 RSS ≠ Xmx**：ZGC 会 uncommit（把闲置物理内存还给操作系统），RSS 波动比 G1 大。K8s 的 memory limit 要留 headroom，OOMKilled 排查别只盯 `-Xmx`，结合 NMT 看 committed。

## 七、总结

- ZGC 靠**着色指针 + 读屏障 + 多重映射**做到停顿小于 1ms 且与堆大小基本无关；**分代 ZGC**（JDK 21）把读屏障成本进一步压低
- 本机实测（2G 堆 / 4 核 / 300MB/s 分配）：**P99 57.6ms → 21.4ms，吞吐 -8%，P50 +14%**
- 裁判是端到端 P99，不是 GC 日志里的 Pause 数字；ZGC 的真凶级停顿是 Allocation Stall
- 切换决策 = 停顿确实是瓶颈 + 延迟敏感 + 资源有富余 + 同程序压测 ≥2 轮通过

## 参考资料

1. JEP 439: Generational ZGC — https://openjdk.org/jeps/439
2. JEP 377: ZGC: A Scalable Low-Latency Garbage Collector (Production Ready) — https://openjdk.org/jeps/377
3. OpenJDK ZGC 官方 Wiki — https://wiki.openjdk.org/display/zgc/Main
4. 美团技术团队：《新一代垃圾回收器 ZGC 的探索与实践》 — https://tech.meituan.com/2020/08/13/new-generation-garbage-collector-zgc-practice.html
5. 周志明：《深入理解 Java 虚拟机（第 3 版）》第 3 章「垃圾收集器与内存分配策略」，机械工业出版社
