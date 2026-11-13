---
title: 深入理解 CPU 伪共享：两个线程各写各的变量，吞吐为啥掉了 4.5 倍？JMH 实测复现 + 云主机上的“测不准”陷阱
date: 2026-11-13 10:00:00
categories:
  - 操作系统与 Linux
  - 性能分析
tags:
  - 伪共享
  - CPU缓存
  - 缓存行
  - JMH
  - LongAdder
  - 性能调优
---

<hr>
<blockquote>
<p><strong>伪共享（False Sharing）</strong>是 Java 并发性能里最隐蔽的一种“隐形税”：两个线程各写各的变量，代码逻辑上零共享，但两个变量恰好住在同一条 64 字节的<strong>缓存行</strong>里，CPU 缓存一致性协议（<strong>MESI</strong>）逼着两个物理核互相作废对方的数据。本文在 2 vCPU 云主机上用 JMH 实测复现：同对象相邻两个 volatile long，吞吐 4960 万 ops/s；手动缓存行填充后 2.2 亿 ops/s，<strong>相差 4.5 倍</strong>。同时踩到一个更值钱的坑：同机同代码第一次跑居然测出“没问题”（2.2 亿），复跑才崩——云主机上 vCPU 落哪个物理核你说了不算，单次压测不可信。附 JOL 布局实证、taskset 单核对照、@Contended 静默失效的实锤输出，以及手动 padding / @Contended / LongAdder 三种解法的取舍。</p>
</blockquote>

<!-- more -->

## 一、背景：没有共享变量的两个线程，为什么互相拖慢？

先看一个特别常见的写法：为了少加锁，把“每个线程各自写各自的字段”塞进同一个对象——比如监控埋点里的计数器数组、环形缓冲区的读写指针。

> **RingBuffer（环形缓冲区）** 是什么：用定长数组实现的队列，读指针、写指针两个 long 各自持续自增推进，绕圈复用空间。Disruptor、Kafka 的核心数据结构都是它。这两个指针经常被定义成“相邻的两个字段”，恰恰是伪共享重灾区。

每个线程只碰自己的 long，逻辑上没有任何共享，看起来应该完美并行。但在生产压测里，这种结构经常莫名比“分两个对象装”慢好几倍，而且每次压测数字还不一样——这就是**伪共享**。

> **伪共享（False Sharing）** 是什么：两个线程各写各的数据，代码层面零共享；但两份数据住在同一条 64 字节缓存行里，硬件层面被迫“共享”，缓存一致性协议来回作废对方手里的行。共享是假的，性能税是真的。

这篇文章做三件事：**当场复现**（代码、命令、JMH 数据全部真实跑过）；**把“为什么云主机上时疼时不疼”讲透**（这是我这次实测踩到的最有价值的坑）；给出**三种解法的取舍**。

## 二、5 分钟原理：缓存行与 MESI“一致性税”

要看懂伪共享，只需要两个硬件事实。

**事实一：CPU 搬数据的最小单位不是变量，是缓存行。**

> **缓存行（Cache Line）** 是什么：CPU 和内存之间搬运数据的最小单位，x86 服务器 CPU 上固定 64 字节。你只读 1 个 long（8 字节），它同一条行里的其他 56 字节会“搭车”一起进缓存。本机实测缓存行大小是 64（`getconf LEVEL1_DCACHE_LINESIZE` 返回 64）。

所以两个相邻的 long 变量，硬件眼里就是“同一条行上的两个乘客”——一荣俱荣，一损俱损。

**事实二：多核之间靠 MESI 协议维持“你手里的数据是最新的”。**

> **MESI** 是什么：多核 CPU 维护缓存一致性的协议，每个缓存行只有 Modified（本核独占且改脏）、Exclusive（本核独占且干净）、Shared（多核各有一份干净副本）、Invalid（作废）四种状态。一个核想把某行改成 M（独占改写），其他核里这份行会立即变 I（作废），下次访问得跨核重新拉取。

把两个事实拼起来，伪共享的完整链条就是：

```text
核 A 写 x1（x1、x2 同属缓存行 L）
  → A 必须把 L 置为 Modified，核 B 里的 L 被作废（Invalid）
核 B 写 x2
  → B 必须重新拉取 L（跨核），再置为 Modified，A 里的 L 又被作废
  → 循环往复，缓存行在两个核之间“乒乓”（cache line ping-pong）
```

两个线程写的明明是不同字节，MESI 却以整条行为单位来回夺权——写频率有多高，税就有多重。

**关键推论：伪共享疼不疼，取决于两个“写者”是否落在不同物理核上。**

> **SMT / 超线程** 是什么：让一个物理核同时跑两个线程的技术，两个“逻辑 CPU”共用同一套执行单元和 L1 缓存。如果两个写者只是同一物理核上的 SMT 兄弟线程，它们共享 L1，没有跨核夺权，伪共享几乎不疼。

这条推论是本文“测不准”故事的伏笔，后面实测会反复用到。

顺带说明示例代码里的 **volatile**：

> **volatile** 是什么：Java 的轻量同步手段，保证变量的可见性与有序性。写一个 volatile 字段会产生真实的主存级写动作，读它会强制读最新值——正因为它逼出了“真写”，伪共享效应才能被稳定测出来。

## 三、实验设计：先用 JOL 把“确实同行 / 确实隔离”钉死

实验环境（全部真实）：某云厂商 2 vCPU 通用型实例（CPU 型号 "General Purpose Processor"，L1d 48K / L2 1.25M / L3 42M）、OpenJDK 11.0.13、JMH 1.37、JOL 0.16。

> **JMH** 是什么：OpenJDK 官方的微基准测试框架，负责预热、fork 出独立 JVM、防死代码消除，测出来的纳秒/吞吐级数字才可信。
> **JOL（Java Object Layout）** 是什么：OpenJDK 的对象内存布局分析工具，能打印对象里每个字段的真实字节偏移量。优化对象布局之前，先用它验证，别靠脑补。

基准代码只有两个状态类和三个场景：`Unpadded`（对照组，两个 volatile long 紧挨着）、`Padded`（实验组，x1、x2 各自前后填满 7 个 long 独占一条行）、`solo`（单线程基线）。

```java
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
@Warmup(iterations = 3, time = 1)
@Measurement(iterations = 5, time = 1)
@Fork(1)
public class FalseSharingBench {

    /** 对照组：x1、x2 两个 volatile long 紧挨着，几乎必然落进同一条 64B 缓存行 */
    @State(Scope.Group)
    public static class Unpadded {
        volatile long x1;
        volatile long x2;
    }

    /** 实验组：x1、x2 各自前后填满 56 字节，独占一条缓存行 */
    @State(Scope.Group)
    public static class Padded {
        long p0, p1, p2, p3, p4, p5, p6;
        volatile long x1;
        long q0, q1, q2, q3, q4, q5, q6;
        volatile long x2;
        long r0, r1, r2, r3, r4, r5, r6;
    }

    /** 基线专用状态：单线程独写，无任何竞争 */
    @State(Scope.Benchmark)
    public static class Solo {
        volatile long x;
    }

    @Benchmark
    public long solo(Solo s) { return s.x++; }

    /** 两个线程各写各的 volatile long（伪共享组） */
    @Benchmark @Group("noPadding") @GroupThreads(1)
    public long w1(Unpadded u) { return u.x1++; }

    @Benchmark @Group("noPadding") @GroupThreads(1)
    public long w2(Unpadded u) { return u.x2++; }

    /** 两个线程各写各的 volatile long，但缓存行已隔离（填充组） */
    @Benchmark @Group("padded") @GroupThreads(1)
    public long p1(Padded p) { return p.x1++; }

    @Benchmark @Group("padded") @GroupThreads(1)
    public long p2(Padded p) { return p.x2++; }
}
```

编译运行（JMH 的 jar 从 Maven Central 手动下载即可，无需 Maven 项目）：

```bash
javac -cp "lib/*" -d classes src/bench/*.java
java -cp "lib/*:classes" org.openjdk.jmh.Main "bench.FalseSharingBench" -f 3 -wi 3 -i 4 -w 1s -r 1s
```

**验证第一步：JOL 证明布局假设成立。**

```bash
java -cp "lib/*:classes" bench.Layout   # ClassLayout.parseInstance 打印
```

真实输出（节选）：

```text
bench.FalseSharingBench$Unpadded object internals:
 OFFSET  SIZE      TYPE DESCRIPTION               VALUE
  0   8         (object header: mark)      ...
  8   4         (object header: class)     ...
 12   4         (alignment/padding gap)
 16   8   long Unpadded.x1                 1
 24   8   long Unpadded.x2                 2
Instance size: 32 bytes
```

`Unpadded` 实例总共 32 字节，x1 在偏移 16、x2 在偏移 24——**两个变量同在 0~63 这一条缓存行里**，对照组假设成立。

```text
bench.FalseSharingBench$Padded object internals:
 16   8   long Padded.p0                   0
 ...
 72   8   long Padded.x1                   1
 ...
136   8   long Padded.x2                   2
Instance size: 200 bytes
```

`Padded` 里 x1 在偏移 72（缓存行 64~127），x2 在偏移 136（缓存行 128~191）——**两条行彻底隔离**，实验组假设也成立。布局不验证就开测，是性能实验翻车的第一大来源。

## 四、JMH 实测：4.5 倍差距，以及更重要的“第一次居然没复现”

真实压测数据（每场景多 fork 复跑，`-f 3 -wi 3 -i 4`）：

| 场景 | 配置 | 总吞吐（ops/s） | 单线程吞吐 | 相对填充组 |
| --- | --- | --- | --- | --- |
| solo | 单线程独写 | — | 119.4M ± 0.3M | — |
| noPadding | 2 线程写相邻 volatile long | **49.6M ± 5.7M** | 23.8M / 25.8M | 22%（**掉 4.5 倍**） |
| padded | 2 线程写，缓存行已隔离 | 220.9M ± 17.8M | 105.6M / 115.2M | 100% |
| taskset 对照 | 两个线程钉在同一个 vCPU 上 | 113.7M ± 25.4M | 56.8M / 56.9M | 51% |

```text
Benchmark                     Mode  Cnt     Score      Error  Units
FalseSharingBench.noPadding   thrpt  12  49610270 ± 5716093  ops/s
FalseSharingBench.padded      thrpt  12 220850085 ±17808493  ops/s
FalseSharingBench.solo        thrpt   8 119431185 ±  309629  ops/s
```

> **taskset** 是什么：Linux 自带命令，把进程钉在指定 CPU 上跑（如 `taskset -c 0 java ...`），做“绑核对照实验”的神器。

三个结论，一个比一个有意思：

**结论一：伪共享真实存在，代价 4.5 倍。** 同样是两个线程各写各的 long，相邻就掉到 4960 万 ops/s，填充后 2.2 亿。单线程基线 1.2 亿——**两个线程加起来反而比一个线程还慢 2.4 倍**，这就是“加机器反而变慢”的经典现场。

**结论二：塌的不是“CPU 不够用”，是缓存行乒乓。** 看 taskset 对照行：两个线程被钉在**同一个 vCPU** 上排队串行，总吞吐 1.14 亿，反而是跨核伪共享（4960 万）的 **2.3 倍**。两个核打架比一个核排队更贵——这是坐实伪共享的关键证据（推理见下一节）。

**结论三：第一次跑居然没复现——这是本文最值钱的教训。** 同一台机器、同一份代码，我第一次压 noPadding 得到的是 **222.6M ± 34.6M，和填充组（228.8M）几乎持平**；复跑直接崩到 49.2M，之后多 fork 复跑稳定在 49~50M。唯一说得通的解释：云主机的 vCPU 本质是宿主机上的普通线程，落不落到不同物理核、会不会被迁移，**宿主机调度器说了算，用户完全不可见**。第一次跑那几分钟，两个 vCPU 恰好落在（或被调度到）同一物理核上，伪共享没机会表演。

## 五、取证：怎么坐实“就是伪共享在作祟”

性能问题定罪要讲证据链。这次实测的取证三步法，可以直接抄走：

**第一步：布局证据（JOL）。** 上文已给：对照组两个变量确实同一条行、填充组确实隔离。排除“变量根本不在一行”的可能。

**第二步：行为证据（对照实验）。** 三组对照互相锁死结论：

- `noPadding`（49.6M）vs `padded`（220.9M）：唯一变量是“变量是否同一缓存行”，其余完全一致 → 慢 4.5 倍的原因只能是行内竞争；
- `taskset -c 0`（113.7M）vs `noPadding` 跨 vCPU（49.6M）：**排除了“CPU 太少”这个替代解释**——真排队都比假并行快，说明塌的是跨核一致性流量，不是算力；
- `solo`（119.4M）：单线程基线正常 → JVM、JIT、代码本身没有问题。

**第三步：硬件计数器证据（perf，标准姿势）。**

> **perf** 是什么：Linux 内核自带的性能分析工具，直接读 CPU 硬件性能计数寄存器（缓存未命中、指令数、周期数），不用改一行代码。
> **HITM（Hit Modified）** 是什么：perf 记录的一类内存加载事件——命中的数据躺在“另一个核心刚改脏、还没写回”的缓存行里。**跨核伪共享的直接铁证**，没有之一。

在多核物理机上坐实伪共享的标准命令：

```bash
# 采样内存加载事件，HITM（跨核命中“别核改脏未写回”的行）是伪共享的直接证据
perf mem record -a -- sleep 5 && perf mem report
# 更直接的专用视图：按缓存行聚合跨核共享，热点行一目了然
perf c2c record -a -- sleep 5 && perf c2c report
# 对照：padding 前后各采一次，HITM 应从热点榜消失
```

注：本机是 2 vCPU 云主机，没装 perf 且 `perf_event_paranoid=2` 不放行，所以第三步在本机没跑成——但第一、二步的对照组已经排除了其他解释，工程上足以定罪。**取证手段被环境限制时，用对照实验补证据链，而不是硬编数据。**

另外提醒一个反直觉的坑：`lscpu -e` 显示本机两个 vCPU 同属 socket 0、core 0（SMT 兄弟）。按第二节推论，SMT 兄弟共享 L1，伪共享不该疼——但它疼了（4.5 倍）。结论：**客户机看到的拓扑是云厂商给的“虚拟拓扑”，宿主机实际的 vCPU→物理核映射不可见也会变。测行为，别只信拓扑。** 想在自己多核物理机上稳定复现：用 `lscpu -e` 找出不同物理核的两个 CPU（CORE 列不同），`taskset -c 0,2` 绑核跑对照组；再用 `taskset -c 0,1`（SMT 兄弟）跑一遍做反差。

## 六、解法：三种武器与取舍

**武器一：手动缓存行填充（padding）。** 就像实验组的 `Padded` 类，在热点字段前后各塞 7 个 long。零依赖、零参数，效果实测 4.5 倍。代价是内存：一个 32 字节的对象被撑到 200 字节，数组场景要乘以元素数。**改完必须用 JOL 复核布局**——JVM 有字段重排，你以为的顺序未必是真实顺序（本例的 7 long 前置恰好生效，但别赌）。

**武器二：@Contended，让 JVM 替你填。**

> **@Contended** 是什么：JDK 8 引入（JEP 142）的注解，让 JVM 自动在注解目标周围塞满填充字节，把它隔离到独占缓存行。默认被 `-XX:+RestrictContended` 限制，需要加 `-XX:-RestrictContended` 才生效。

这里有个我当场踩到的坑——**注解静默失效**。同一个类，加不加参数的 JOL 输出对比（真实数据）：

```text
# 默认（限制开启）：@Contended 被忽略，x1@16、x2@24 还是挤在一条行里
Instance size: 32 bytes
Space losses: 4 bytes internal

# 加 -XX:-RestrictContended：JVM 自动插入 132 字节填充
 12 132   (alignment/padding gap)
144   8   long C.x1
152   8   long C.x2
Instance size: 160 bytes
Space losses: 132 bytes internal
```

忘加参数不报错、不警告，性能该塌还塌——这种“静默无效”比崩溃可怕得多。另外注意粒度：**类级 `@Contended` 只把自己和“别的对象”隔开**（上面的输出里 x1、x2 依然相邻，只是整块被推离了对象堆的邻居）；**想让一个类的两个字段互不干扰，要逐字段标注**（`@Contended` 标在字段上，或用分组值 `@Contended("group")`）。

**武器三：换数据结构，把热点写摊开。** 标准范例是 **LongAdder**：

> **LongAdder** 是什么：JDK 8 的高并发计数器，把一个 long 拆成 base + Cell[] 多段累加，写时分摊到不同 Cell，读时求和。它每个 Cell 都标了 @Contended——分段 + 隔离，就是为了把热点写摊到不同缓存行。

高并发计数场景直接用 LongAdder，别自己拿 AtomicLong 硬顶；自研环形缓冲区就学 Disruptor，给读写指针加 padding。Disruptor 的白皮书里这是开篇第一课。

| 方案 | 改动成本 | 内存代价 | 生效前提 | 适用场景 |
| --- | --- | --- | --- | --- |
| 手动 padding | 低（改字段） | 高（~6 倍对象体积） | 无（建议 JOL 验证） | 自研数据结构、字段少的热点类 |
| @Contended | 极低（加注解） | 中高 | `-XX:-RestrictContended` | 类整体隔离；记得类级≠字段级 |
| LongAdder / 分段 | 中（换 API） | 中 | 无 | 高并发计数、统计累加 |

## 七、常见坑

**坑 1：单次压测就下结论。** 本文的真实教训：同机同代码，第一次 222.6M，复跑 49.2M。任何性能结论至少复跑一次、最好多 fork（JMH `-f 3`），数字抖得像本文第一次那样时，先怀疑环境和放置，再怀疑代码。

**坑 2：只信客户机拓扑。** 云主机上 `lscpu` 说两个 vCPU 是同核 SMT 兄弟，实际照样跨核乒乓。拓扑只能当参考，行为测量（对照组 + perf）才是证据。

**坑 3：@Contended 静默无效。** 忘加 `-XX:-RestrictContended`，注解等于没写；类级注解也救不了同类两个互扰字段。用 JOL 输出说话，别用注解存在感说话。

**坑 4：手动 padding 被 JVM 字段重排吞掉。** 热点字段之间的填充字段可能被 JVM 重新排序挪位。写完 padding 用 JOL 打印偏移，确认热点字段的偏移差 ≥ 64 字节。

**坑 5：过度优化。** 伪共享只在“多线程、多物理核、高频写、同一行”四个条件同时满足时才疼。读多写少、单线程、低频写都不用治；为省 64 字节给全量数组上 padding，内存翻 6 倍换一个测不出来的收益，是负优化。**先量化（本文第四节的对照法），再定罪，再动手。**

**坑 6：JMH 不 fork、同 JVM 内互测。** 被测代码和基准跑在同一个 JVM 里，JIT、GC、类加载全在污染数据，数字全废。坚持 `-f` 独立 fork（本文所有数据 `-f ≥ 1`，方差组用了 `-f 3`）。

**正确姿势清单：**
- 高频写的相邻字段，先问一句“它们会在同一条缓存行里被多核同时写吗”；
- 判定有病 → JOL 验布局 → JMH 对照（padding 前后）→ 有条件上 perf c2c 看 HITM；
- 高并发计数直接 LongAdder；自研结构学 Disruptor 加 padding；
- 改动前后都留 JMH + JOL 证据，上线前 `-XX:-RestrictContended` 记得加回 JVM 参数。

## 八、总结

- **伪共享**：代码零共享、硬件真共享——两个高频写的变量挤在同一条 64 字节缓存行里，MESI 让两个物理核来回夺权，本文实测掉 4.5 倍（49.6M → 220.9M ops/s）；
- 单线程基线 1.2 亿 ops/s，两个“并行”线程合计反而只有 4960 万——**遇到“加线程反而慢”，伪共享要在嫌疑人名单前排**；
- taskset 单核对照（113.7M）比跨核伪共享（49.6M）还快 2.3 倍：塌的不是算力，是一致性流量——对照实验是坐实伪共享的核心手段；
- 云主机上 vCPU 落哪个物理核不可见、会漂移：同机同代码能测出“没病”，复跑才有病。**单次压测不可信，客户机拓扑不可全信，行为测量才可信**；
- 解法三件套：手动 padding（改完 JOL 验证）、@Contended（记得 `-XX:-RestrictContended`，类级≠字段级）、LongAdder/分段（高并发计数首选）；
- 取证链：JOL 布局证据 → 对照实验行为证据 → perf c2c 的 HITM 硬件证据，三环扣死再动手优化。

## 参考资料

1. Martin Thompson：False Sharing Java 7（伪共享与缓存行填充的经典出处）—— <https://mechanical-sympathy.blogspot.com/2011/07/false-sharing-java-7.html>
2. JEP 142: Reduce Cache-Based Contention（@Contended 的来龙去脉）—— <https://openjdk.org/jeps/142>
3. OpenJDK JMH 官方示例：JMHSample_22_Falsesharing —— <https://github.com/openjdk/jmh/blob/master/jmh-samples/src/main/java/org/openjdk/jmh/samples/JMHSample_22_Falsesharing.java>
4. OpenJDK JOL（Java Object Layout）项目主页 —— <https://openjdk.org/projects/code-tools/jol/>
5. OpenJDK 源码：LongAdder（Cell 上的 @Contended 分段设计）—— <https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/atomic/LongAdder.java>
6. LMAX Disruptor：High Performance Inter-Thread Messaging（读写指针 padding 的工程实践）—— <https://lmax-exchange.github.io/disruptor/>
7. Brendan Gregg：perf Examples 与 Linux 性能观测方法论 —— <https://www.brendangregg.com/linuxperf.html>
8. Intel 64 and IA-32 Architectures Optimization Reference Manual（缓存层次与行共享一节）—— <https://www.intel.com/content/www/us/en/content-details/821612/intel-64-and-ia-32-architectures-optimization-reference-manual-volume-1.html>
