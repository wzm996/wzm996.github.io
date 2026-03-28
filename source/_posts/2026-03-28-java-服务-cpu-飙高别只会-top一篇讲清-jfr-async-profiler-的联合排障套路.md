---
title: Java 服务 CPU 飙高别只会 top：一篇讲清 JFR + async-profiler 的联合排障套路
date: 2026-03-28 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - Java
  - JFR
  - async-profiler
  - 火焰图
  - 性能优化
  - CPU排障
---
<hr>
<blockquote>
<p>线上 Java 服务一旦出现 CPU 飙高，很多同学第一反应就是 <code>top</code>、<code>jstack</code>、然后开始对着线程栈“猜”。这套办法不是不能用，但很容易陷入一个尴尬局面：你知道它很慢，却不知道到底慢在哪一层。这篇文章我想讲一套更稳的办法：先用 <strong>JFR</strong> 看全局，再用 <strong>async-profiler</strong> 打细节，把“CPU 高”这件事从玄学排查，变成一套能复现、能验证、能沉淀的工程方法。</p>
</blockquote>

<!-- more -->

# 一、为什么我要把 JFR 和 async-profiler 放在一起讲？

线上性能问题最烦的地方，不是“看不见”，而是“只看见一部分”。

比如你用 `top -H -p <pid>` 能看到哪个线程吃 CPU；
你用 `jstack` 能看到线程栈；
你再经验丰富一点，能根据线程名猜是不是 GC、是不是业务线程、是不是某个线程池打满了。

但问题在于：

- `jstack` 更像一张“静态照片”，不擅长回答“这 30 秒里，热点到底主要花在哪”；
- 单看线程栈，容易撞上 **Safepoint Bias（安全点偏差）**——你看到的是“刚好能被 JVM 安全地采样到的栈”，不一定是最真实的热点；
- 你只能看到 Java 栈，不一定能看清 JNI、内核态、锁竞争、GC 线程这些细节。

所以更稳的做法是：

1. **先用 JFR 看全局时间线**：谁在抖、GC 暂停长不长、分配速率高不高、热点方法大概在哪；
2. **再用 async-profiler 打火焰图**：把 CPU 热点、分配热点、锁竞争热点一层层展开；
3. **最后回到代码和配置做验证**：不是“看着像”，而是“改完后 P95/P99 真降了”。

这里顺手解释两个新名词：

- **JFR（Java Flight Recorder）**：JDK 自带的低开销诊断工具，你可以把它理解成 JVM 的“黑匣子”，会持续记录 GC、线程、分配、锁、方法采样等关键事件。
- **async-profiler**：一个对线上影响比较小的采样分析器，你可以把它理解成“专门拿来画火焰图的性能显微镜”，它能同时看到 Java 栈、Native 栈，甚至内核态信息。

一句话总结：**JFR 负责“先缩小范围”，async-profiler 负责“最后钉死证据”。**

# 二、先说结论：排障时到底怎么选工具？

很多文章喜欢把工具一股脑堆出来：`top`、`pidstat`、`jstack`、`arthas`、`jcmd`、`perf`、`async-profiler`……

但真到线上，排障要的是“路径短”，不是“工具多”。

我自己的建议是这样的：

| 场景 | 先用什么 | 再用什么 | 目标 |
| --- | --- | --- | --- |
| CPU 突然飙高，不知道是不是 Java 自身问题 | `top` / `pidstat` | JFR | 先判断是不是 JVM 内部、GC、业务线程、锁竞争 |
| 确定是 Java 进程吃 CPU，但热点函数不清楚 | JFR | async-profiler | 先定位大方向，再看火焰图 |
| 怀疑是对象创建过多导致 GC 压力 | JFR Allocation / GC 事件 | async-profiler alloc 模式 | 找高分配速率方法 |
| 怀疑锁竞争 | JFR Lock / Thread 事件 | async-profiler lock 模式 | 看是哪些锁、哪些线程在等 |
| 要做优化前后对比 | 压测 + JFR | 压测 + 火焰图对比 | 看吞吐、P95/P99、GC 暂停、热点栈变化 |

如果你非要我再压缩成一句话：

> **JFR 是低成本常备体检，async-profiler 是确认病灶时开的 CT。**

# 三、一个能复现的实验：故意制造 CPU 热点和高分配

纸上谈兵没意思，我们直接造一个小 demo。这个 demo 干两件事：

1. 用一个低效的字符串处理逻辑制造明显的 CPU 热点；
2. 顺手制造大量短命对象，让 GC 和分配压力也抬起来。

## 3.1 示例代码

新建 `HotCpuDemo.java`：

```java
import java.util.ArrayList;
import java.util.List;
import java.util.Random;

public class HotCpuDemo {

    private static final Random RANDOM = new Random();

    public static void main(String[] args) {
        for (int i = 0; i < Runtime.getRuntime().availableProcessors(); i++) {
            Thread t = new Thread(HotCpuDemo::work, "hot-worker-" + i);
            t.start();
        }
    }

    private static void work() {
        while (true) {
            List<String> list = new ArrayList<>();
            for (int i = 0; i < 20_000; i++) {
                String s = buildHeavyString(i);
                if ((s.hashCode() & 7) == 0) {
                    list.add(s);
                }
            }
            if (list.size() > 10_000) {
                System.out.println(list.get(RANDOM.nextInt(list.size())));
            }
        }
    }

    private static String buildHeavyString(int seed) {
        String result = "prefix";
        for (int i = 0; i < 200; i++) {
            result = result + '-' + seed + '-' + i;
        }
        return result.toLowerCase().trim();
    }
}
```

编译并运行：

```bash
javac HotCpuDemo.java
java -Xms512m -Xmx512m HotCpuDemo
```

这段代码写得很“坏”，坏就坏在：

- 循环里反复用 `+` 拼接字符串；
- 每次都创建大量临时对象；
- 多线程一直跑，不给 CPU 喘气。

这很像真实项目里某些“看着没啥，压上去就开始冒烟”的逻辑：

- 日志格式化太重；
- JSON/字符串拼装太频繁；
- 规则计算里做了大量对象创建；
- 某段代码放在热路径上却没人注意。

## 3.2 先用最土的办法确认问题存在

拿到 PID：

```bash
jps -l
```

看线程 CPU：

```bash
top -H -p <PID>
```

或者：

```bash
pidstat -p <PID> -t 1
```

你大概率会看到：

- 这个 Java 进程 CPU 很高；
- 多个 `hot-worker-*` 线程持续吃满核；
- 服务 RT 开始抖，P95/P99 明显拉长。

如果你有接口压测场景，可以用 `wrk` 或 `hey` 做一个更贴近服务端的验证。比如优化前的数据可以像这样记录：

| 版本 | 吞吐（req/s） | P50 | P95 | P99 | CPU 使用率 | GC Pause Sum/5min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 优化前 | 1480 | 18ms | 220ms | 410ms | 340% | 2.8s |
| 优化后 | 2260 | 11ms | 78ms | 133ms | 215% | 0.9s |

注意，这组数字是“示例模板”，你在线上或测试环境复现时，应该替换成自己的真实压测结果。文章里给表格，不是为了凑数，而是为了防止大家最后只停留在“感觉好像快了”。

# 四、第一步：用 JFR 先看全局，不要一上来就怼火焰图

## 4.1 为什么先上 JFR？

因为它的成本低，而且信息维度全。

JFR 最适合回答这些问题：

- 是 CPU 真高，还是只是偶发尖刺？
- GC 暂停时间有没有明显拉长？
- 对象分配速率是不是异常高？
- 线程活动是否异常？
- 热点方法集中在哪一类调用路径？

很多人一提性能分析，就想直接上火焰图。这个思路不算错，但容易“开大炮打麻雀”：

- 你可能会抓到一堆热点，却不知道哪个是真正影响 RT 的；
- 你可能看到了业务方法占比高，却没注意其实 GC Pause 才是主要损耗；
- 你可能聚焦 CPU，结果真实瓶颈是锁竞争或者高分配。

## 4.2 采集 JFR 的命令

JDK 11+ 一般都可以直接用 `jcmd`：

```bash
jcmd <PID> JFR.start \
  name=cpu-hotspot \
  settings=profile \
  filename=/tmp/cpu-hotspot.jfr \
  duration=5m
```

这里顺手解释一下参数：

- `settings=profile`：表示启用偏“性能分析”的事件模板，比默认配置更适合查性能问题；
- `duration=5m`：录 5 分钟，别只录 10 秒，太短很容易误判；
- `filename=...`：把结果写到文件，后面可以用 JMC 打开慢慢看。

如果你不想等自动结束，也可以手动 stop：

```bash
jcmd <PID> JFR.stop name=cpu-hotspot
```

## 4.3 打开 JFR 后应该重点看什么？

推荐按这个顺序看：

### 1）GC 页面

看两个核心指标：

- **Pause Time / Sum of Pauses**：应用真正停下来的时间总量；
- **GC Frequency**：GC 发生得是不是过于频繁。

这里有个很容易踩的误区：

> 很多人看到 GC 次数多，就立刻说“JVM 参数不行”。

这话经常只说对一半。

如果你的对象创建速率本来就很夸张，那调 JVM 参数只能缓解，不能治本。真正该改的，往往是业务代码里的对象生命周期和分配模式。

### 2）Method Profiling / Execution Samples

看热点方法是不是集中在某个工具类、序列化逻辑、字符串处理逻辑、模板渲染逻辑上。

如果你发现最热的方法不是“业务核心”，而是：

- `StringBuilder.append`
- `StringLatin1.toLowerCase`
- JSON encode/decode
- 正则匹配
- `HashMap.resize`

那大概率就不是“算法本身复杂”，而是“热路径上做了太多小动作”。

### 3）TLAB / Allocation

**TLAB（Thread Local Allocation Buffer）**，你可以把它理解成“线程私有的一小块对象分配缓存区”，线程创建小对象时，先往这里分，快得多。

如果这个页面显示分配速率异常高，说明问题可能不是“CPU 算不动”，而是“对象建太多，GC 忙不过来”。

### 4）Threads / Lock Instances

如果 CPU 高但火焰图没看出特别重的业务方法，也要看看是不是锁竞争、线程切换、线程池队列堆积导致的假象。

## 4.4 JFR 阶段的结论长什么样？

一个比较理想的 JFR 阶段结论，应该像这样：

- 过去 5 分钟内，CPU 高位稳定，不是偶发毛刺；
- 热点主要集中在字符串拼接和大小写转换；
- 对象分配速率高，年轻代 GC 频繁；
- 没有明显的锁竞争和 Full GC；
- 下一步应该用 async-profiler 进一步确认 CPU 热点和分配热点。

注意，这一步不是为了“一步到位定位代码行号”，而是为了**缩小搜索范围**。

# 五、第二步：用 async-profiler 把热点栈钉死

## 5.1 为什么 async-profiler 更适合做“最后一锤”？

因为它的采样方式更适合看真实热点，而且能避开很多传统 profiler 的坑。

根据 async-profiler 官方说明，它是一个 **low overhead sampling profiler**，支持 CPU、堆分配、锁、硬件计数器等多种模式，还能看到 Java / Native / Kernel frame。直白讲，它不像很多传统工具那样“自己先把应用压慢了再告诉你哪里慢”。

## 5.2 采集 CPU 火焰图

如果你已经装好了 async-profiler，最常用的命令就是：

```bash
asprof -d 30 -e cpu -f /tmp/cpu.html <PID>
```

解释一下：

- `-d 30`：采样 30 秒；
- `-e cpu`：采 CPU 事件；
- `-f /tmp/cpu.html`：输出成可交互的 HTML 火焰图。

如果你想顺手导出 JFR 格式结果，也可以：

```bash
asprof -d 30 -e cpu -f /tmp/cpu.jfr <PID>
```

这个很实用，因为你可以把 async-profiler 的采样结果也放进支持 JFR 的工具里统一看。

## 5.3 采集分配火焰图

既然前面 JFR 已经提示分配压力大，那就顺手把 alloc 模式也抓一下：

```bash
asprof -d 30 -e alloc -f /tmp/alloc.html <PID>
```

如果 alloc 火焰图里，某几个字符串处理、对象组装、JSON 序列化方法占比特别夸张，你基本就能确认：

> 这不是“单纯 CPU 算力不足”，而是“高分配 + 高频执行”一起把系统拖慢了。

## 5.4 怎么看火焰图？

第一次看火焰图的同学很容易误会：

- 以为“火苗越高越严重”；
- 以为“颜色越红越严重”；
- 以为“最上面那层就是根因”。

其实都不对。

火焰图最重要的是 **宽度**，不是高度也不是颜色。

你可以这么理解：

- **每个框的宽度**：表示这个调用栈占了多少采样时间；
- **越宽**：说明越热；
- **越往上**：表示调用链更深；
- **一整片很宽的“平台”**：通常说明某条调用路径长期占 CPU。

比如这个 demo 里，你大概率会看到类似这种调用链：

```text
HotCpuDemo.work
  -> HotCpuDemo.buildHeavyString
    -> java.lang.StringConcatHelper...
    -> java.lang.String.toLowerCase
    -> java.lang.String.trim
```

这时候根因其实已经非常明显了：

- 热路径里做了大量字符串拼接；
- 每次拼完还要转小写、trim；
- 这些操作叠加起来导致 CPU 热点；
- 大量中间字符串对象又抬高了分配和 GC 压力。

# 六、优化不难，难的是别优化错方向

## 6.1 一个足够典型的修复方式

我们把问题方法改一下：

```java
private static String buildHeavyString(int seed) {
    StringBuilder sb = new StringBuilder(4096);
    sb.append("prefix");
    for (int i = 0; i < 200; i++) {
        sb.append('-').append(seed).append('-').append(i);
    }
    return sb.toString();
}
```

如果业务上不要求 `toLowerCase()` 和 `trim()`，那就别放在热路径里；
如果必须做，也尽量前置、缓存，或者减少重复执行。

很多时候，性能优化不是“祭出高深参数”，而是把热路径里的低效写法清掉。

## 6.2 优化后怎么验证，不要只看 CPU 降没降

真正有意义的验证，至少要同时看四类指标：

### 1）吞吐和延迟

压测前后记录：

- 吞吐（QPS / req/s）
- P50
- P95
- P99

### 2）JFR 的 GC 和 Allocation 指标

重点看：

- `GC Pause Sum` 是否下降；
- 分配速率是否下降；
- 热点方法分布是否变化。

### 3）async-profiler 火焰图

看优化前那条最宽的栈，是不是明显变窄了。

### 4）容器 / 主机 CPU 使用率

如果你跑在容器里，最好也看看：

- Pod CPU usage
- throttling 情况
- 容器限额是否触顶

否则你可能会误把“被限流”当成“代码变慢”。

## 6.3 一个更像工程汇报的对比表

下面这个表是推荐你在团队里沉淀的格式：

| 指标 | 优化前 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| 吞吐（req/s） | 1480 | 2260 | +52.7% |
| P50 | 18ms | 11ms | -38.9% |
| P95 | 220ms | 78ms | -64.5% |
| P99 | 410ms | 133ms | -67.6% |
| 进程 CPU | 340% | 215% | -36.8% |
| GC Pause Sum / 5min | 2.8s | 0.9s | -67.9% |
| Top allocation hotspot 占比 | 31% | 9% | 明显下降 |

这类表很关键，因为它把“性能优化”从一句口头禅，变成了一个能复盘、能复现、能说服团队的结果物。

# 七、联合排障的标准套路，我建议你直接收藏

如果你线上真碰到 Java 服务 CPU 飙高，我建议按这个顺序走：

## 第 1 步：确认是不是 Java 进程的问题

```bash
top -c
pidstat -p <PID> 1
```

看是单个 Java 进程高，还是机器整体资源都在抖。

## 第 2 步：快速看线程级别热点

```bash
top -H -p <PID>
```

如果需要，把线程 ID 转成十六进制，再配合 `jstack` 看具体线程：

```bash
printf '%x
' <TID>
jstack <PID> | less
```

这一步的作用不是“精确定位”，而是建立第一层直觉：到底是 GC 线程、业务线程、ForkJoinPool，还是某个自定义线程池。

## 第 3 步：录一段 JFR

```bash
jcmd <PID> JFR.start name=incident settings=profile filename=/tmp/incident.jfr duration=5m
```

重点看 GC、Allocation、Threads、Method Profiling。

## 第 4 步：抓 async-profiler

```bash
asprof -d 30 -e cpu -f /tmp/cpu.html <PID>
asprof -d 30 -e alloc -f /tmp/alloc.html <PID>
```

必要时再补锁：

```bash
asprof -d 30 -e lock -f /tmp/lock.html <PID>
```

## 第 5 步：改代码/调配置后重新压测

别省这一步。很多所谓“优化”，最后只是让某个指标好看了一点，整体延迟反而更差。

# 八、常见坑，我见过太多人在这里翻车

## 8.1 只看一次 `jstack` 就下结论

这个问题非常常见。

单次线程栈只能告诉你“某一瞬间线程在干嘛”，不能代表过去 30 秒最热的调用路径。尤其在高并发下，线程行为切得很快，靠一两次快照很容易误判。

## 8.2 看到 GC 多，就只会调堆大小

GC 多有两种典型可能：

1. 堆太小；
2. 对象分配太猛。

如果根因是第二种，你把堆调大，只是“延后发作”，并没有治本。

## 8.3 只抓 CPU 火焰图，不抓 alloc 火焰图

有些问题表面是 CPU 高，实际根因是对象 churn（对象剧烈抖动）。

**对象 churn** 这个词第一次出现，我口语化解释一下：它就是“对象创建得又快又多，而且很快就死掉”，JVM 会忙着分配、回收、再分配，CPU 就被拖进去了。

这类问题如果只抓 CPU，有时你只能看到一些表面热点；抓 alloc 才能把“谁在疯狂造对象”这件事看清楚。

## 8.4 火焰图抓太短

采 5 秒、10 秒有时候也能看出问题，但对波动型业务非常不稳。

经验上：

- CPU 明显持续飙高：先抓 30 秒；
- 问题偶发：考虑更长一点，或者结合 JFR 长录制；
- 要做优化前后对比：采样窗口要尽量一致。

## 8.5 在容器环境里忽略权限和挂载限制

如果你在 Kubernetes 里跑，可能会遇到这些情况：

- 容器里没有 `jcmd`；
- 没有足够权限使用 `perf_event`；
- 镜像太精简，诊断工具都没带；
- PID namespace 隔离导致你找不到目标进程。

所以生产环境最好提前准备一套“诊断侧车镜像”或统一的排障 SOP，不要等出事了才临时装工具。

# 九、一个简单但很值钱的团队规范

如果你的服务是 Java 为主，我真心建议团队把下面几件事固定下来：

1. **线上保留 JFR 能力**：至少确保 JDK 工具链可用；
2. **预备 async-profiler 使用手册**：写成内部 wiki，别每次都现搜；
3. **性能问题统一留证据**：JFR 文件、火焰图、压测报告、前后对比表都归档；
4. **把热点修复沉淀成规则**：比如禁止热路径里重复 JSON 序列化、禁止无脑字符串拼接、禁止在高频链路上做正则重匹配；
5. **把性能分析纳入回归流程**：尤其是核心接口和批处理任务。

这件事的本质，不是“学会一个工具”，而是把“排障靠感觉”升级成“排障靠证据”。

# 十、总结

把这篇文章的重点压缩一下，其实就三句话：

- **JFR 适合先看全局**：低开销、信息全，适合先判断是 CPU、GC、分配还是锁的问题；
- **async-profiler 适合最后钉死热点**：用火焰图和 alloc 图把真正的热路径、对象分配热点找出来；
- **优化一定要回到指标验证**：吞吐、P50/P95/P99、CPU、GC Pause、热点栈变化，一个都别少。

如果你以前排 CPU 问题还是“top + jstack + 猜”，那从今天开始，真的可以把套路升级一下。

别再靠玄学。上证据。

# 参考资料

1. Oracle, *Troubleshoot Performance Issues Using Flight Recorder*：<https://docs.oracle.com/en/java/javase/17/troubleshoot/troubleshoot-performance-issues-using-jfr.html>
2. async-profiler 官方仓库：<https://github.com/async-profiler/async-profiler>
3. 阿里云开发者社区，《可观测可回溯 | Continuous Profiling 实践解析》：<https://developer.aliyun.com/article/1061644>
4. 阿里云开发者社区，《使用 async-profiler 生成火焰图分析 Java CPU 与内存性能》：<https://developer.aliyun.com/article/885242>
5. OpenJDK / JDK 官方文档，`jcmd` 与 JFR 相关说明：<https://docs.oracle.com/en/java/javase/17/docs/specs/man/jcmd.html>
