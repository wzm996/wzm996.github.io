---
title: 线上排查（一）——CPU 飙高的定位思路与 async-profiler 火焰图实战
date: 2026-10-01 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - async-profiler
  - 火焰图
  - JVM
  - 线上排查
  - 性能分析
---

<hr>
<blockquote>
<p>线上 CPU 飙高告警时，最怕两件事：一是只知道在服务器上手忙脚乱地敲 top，二是连打十几次 jstack 都撞不中高点。这篇把「从告警到具体代码行」的完整定位链路走一遍：先用经典三板斧快速兜底，再用 <strong>async-profiler</strong> 火焰图一次抓准，并用一个真实感十足的正则回溯案例，从复现、定位到修复验证全程落地。</p>
</blockquote>

<!-- more -->

## 一、背景：这篇要解决什么问题

半夜收到告警：「生产环境某服务 CPU 使用率 95%，持续 5 分钟」。这时候你的第一反应是什么？

很多人的动作是：登机器 → 敲 `top` → 看到是个 Java 进程 → 然后就卡住了。因为 `top` 只能告诉你「哪个进程」在烧 CPU，不能告诉你「哪行代码」在烧。而 CPU 高的原因五花八门：死循环、正则回溯、频繁 Full GC、序列化大对象、日志狂刷、甚至 C 层的 JIT 编译抖动……每个的处理方式完全不同。

这篇的目标是把定位过程工程化：

1. **先有思路（漏斗）**：从「机器」收敛到「进程」再到「线程」最后到「调用栈」，每一步用什么工具、看什么指标；
2. **后有手段**：经典三板斧（`top` + `top -Hp` + `jstack`）快速兜底，采样式分析器一次抓准；
3. **全程可复现**：所有命令都能在自己机器上跑通，结论都有明确的「验证方法」。

> 先解释几个本文会反复出现的名词：
>
> - **async-profiler**：一个开源的 Java 采样式性能分析器（GitHub 上搜 `async-profiler/async-profiler`）。它通过 Linux 内核的 **perf_events** 采样 + JVM 内部接口，拿到每个线程在任意时刻的真实调用栈，开销极低（通常 <1%），用来回答「CPU 时间到底花在哪个方法上」这个问题。
> - **perf_events**：Linux 内核自带的性能事件子系统，可以按固定频率触发中断、记录当时正在执行的代码，是火焰图数据的底层来源。
> - **火焰图（Flame Graph）**：把成千上万份调用栈样品叠加起来的可视化图。横轴代表占比（越宽越耗 CPU），纵轴是调用栈深度（越往下越底层）。图里「凸出来的平顶」基本就是热点。
> - **JFR（Java Flight Recorder）**：JVM 自带的「黑匣子」，持续低开销地记录 GC、锁、线程等事件，适合长期开着、事后回放，和 async-profiler 是互补关系。

## 二、定位思路：先有漏斗，再谈工具

CPU 排查的本质是一个不断收敛的漏斗，不要跳步：

```
机器（top） → 进程（top 找 PID） → 线程（top -Hp 找 TID） → 调用栈（jstack / async-profiler） → 代码行
```

每一步的「工具选型」可以参考这张表：

| 工具 | 一句话定位 | 开销 | 适合场景 |
| --- | --- | --- | --- |
| `top` / `top -Hp` | 看进程、线程级 CPU 占用 | 几乎为零 | 确认「谁」在烧 CPU |
| `jstack` | 一次性线程栈快照 | 极低 | 抓死锁、长期 RUNNABLE 的线程；抓瞬时热点靠缘分 |
| **async-profiler** | 采样式火焰图（CPU/内存/锁） | 低（<1%） | 定位热点代码的**首选**，抓得住瞬时毛刺 |
| JFR | JVM 内置持续记录 | 极低 | 长期监控 + 事后取证 |
| Arthas | 交互式在线诊断（阿里开源） | 中等 | 深挖单个方法的耗时、反编译验证、热更新 |

> 注：Arthas 是阿里开源的 Java 在线诊断工具，相当于给运行中的 JVM 接了个「示波器」，`watch`、`trace`、`profiler` 命令都很好用，建议装一份备用。

选择顺序上我的习惯：**先 `top -Hp` 确认线程 → 顺手 jstack 看一眼 → 抓不到就用 async-profiler 采样 30 秒**。下面用一个造出来的事故现场，把整条链路完整走一遍。

## 三、实战准备：先造一个 CPU 飙高的现场

排查能力必须练过才敢上生产。我们先在本地造一个「CPU 打满一个核」的现场，这个案例不是随便写的死循环，而是真实生产事故里出现频率极高的一类：**正则的灾难性回溯**。

> **灾难性回溯（catastrophic backtracking）**：正则引擎遇到「嵌套量词」（比如 `(a+)+`）时，会穷举字符串的所有拆分方式去尝试匹配。一旦匹配失败，回溯步数随输入长度**指数级增长**——字符串多加一个字符，耗时直接翻倍。

保存为 `CpuBurnDemo.java`：

```java
import java.util.regex.Pattern;

public class CpuBurnDemo {

    // 问题写法：嵌套量词 (a+)+，输入失败时会触发灾难性回溯
    static final Pattern BAD = Pattern.compile("^(a+)+$");

    public static void main(String[] args) throws Exception {
        // 线程 1：模拟"正常业务"，基本不耗 CPU
        new Thread(() -> {
            while (true) {
                try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
            }
        }, "biz-worker").start();

        // 线程 2：模拟"有问题的校验逻辑"，会长期占满一个核
        String input = "a".repeat(23);
        new Thread(() -> {
            while (true) {
                BAD.matcher(input).matches();
            }
        }, "cpu-burn").start();
    }
}
```

复现步骤：

```bash
javac CpuBurnDemo.java
java CpuBurnDemo &
top    # 找到 java 进程，会看到一个核被吃满
```

**验证**：在 `top` 里应该能看到 java 进程 CPU 接近 `100%`（单核口径，多核机器上是总核数的 `1/N`）。这个「100%」的口径问题后面第四节会展开。

顺带说一句，这个 demo 在生产中的对应物非常常见：接口入口处用一条正则校验用户名/订单号，某天用户输入了一段恶意构造的长字符串，一个核就没了。攻击者甚至不需要并发，一条请求就能打挂你一个核。

## 四、经典三板斧：top -Hp + jstack

### 4.1 三步走

```bash
# 1. 找到最耗 CPU 的线程 TID（线程视图）
top -Hp $(pgrep -f CpuBurnDemo)

# 2. 把线程号转成 16 进制（jstack 里的 nid 是 16 进制）
printf '%x\n' 27104

# 3. dump 线程栈，按 nid 过滤
jstack $(pgrep -f CpuBurnDemo) | grep -A 15 'nid=0x69e0'
```

> `top -Hp` 里的 `-H` 是显示线程（把进程里的每个线程当作一行），`-p` 指定进程号。这一步是把漏斗从「进程」收敛到「线程」的关键。

第 3 步的输出大致长这样（有删减）：

```
"cpu-burn" #13 prio=5 os_prio=0 cpu=8421.32ms elapsed=9.11s tid=0x00007f3a2c000f00 nid=0x69e0 runnable
   java.lang.Thread.State: RUNNABLE
        at java.util.regex.Pattern$Curly.match0(java.base@17.0.8/Pattern.java:4284)
        at java.util.regex.Pattern$Curly.match(...)
        at java.util.regex.Pattern$GroupCurly.match0(Pattern.java:4379)
        at java.util.regex.Pattern$GroupCurly.match(...)
        at java.util.regex.Pattern$Loop.match(Pattern.java:4785)
        ...
        at java.util.regex.Pattern.matcher(Pattern.java:1130)
        at CpuBurnDemo.lambda$main$1(CpuBurnDemo.java:16)
        at java.lang.Thread.run(java.base@17.0.8/Thread.java:833)
```

**怎么解读**：线程状态是 `RUNNABLE`，栈顶全部落在 `java.util.regex.Pattern$Curly / GroupCurly` 这些正则引擎内部类上——基本可以断定是正则在疯狂回溯，而不是业务代码本身在算东西。顺着栈往下看，`CpuBurnDemo.lambda$main$1(CpuBurnDemo.java:16)` 就是罪魁祸首的入口。

三板斧到这里其实已经定位了，**但它有明显局限**：

- `jstack` 是瞬时快照。如果 CPU 是毛刺型（每几秒尖一次），你抓的时机不对，栈里可能全是「刚好不忙」的代码；
- 只能告诉你「这一瞬间」在跑什么，没有占比概念——你说不清这个问题代码到底贡献了 30% 还是 90% 的 CPU；
- 对于 JVM 内部（GC 线程、JIT 编译线程）和 native 调用的分析能力有限。

所以要引入采样式分析器。

## 五、async-profiler：一次抓准火焰图

### 5.1 安装与采集

从 [GitHub Releases](https://github.com/async-profiler/async-profiler/releases) 下载对应平台的包解压即可（注意与 glibc 版本匹配，CentOS/Ubuntu 都有现成包）。**老版本（2.x）的入口是 `profiler.sh`，新版本（3.x）是 `bin/asprof`**，本文按新版写。

最常用的「采集 30 秒并出图」：

```bash
./bin/asprof -d 30 -f /tmp/cpu.html <PID>
```

更好的姿势是用 `start` / `stop` 把「复现动作」包起来，专抓毛刺：

```bash
./bin/asprof start <PID>
# —— 这里去复现一次请求 / 等告警再次出现 ——
./bin/asprof stop -f /tmp/cpu.html <PID>
```

命令执行完会生成 `/tmp/cpu.html`，浏览器打开就是火焰图。因为是给运行中的 JVM 注入 agent，**不需要重启应用**，这一点对生产环境至关重要。

### 5.2 火焰图怎么看

打开 `/tmp/cpu.html`，我们的 demo 会呈现成这样（示意）：

```
┌────────────────────────────────────────────┐
│           Pattern$Curly.match0             │  ← 又宽又平的"平顶"
├────────────────────────────────────────────┤
│        Pattern$GroupCurly.match0           │
├────────────────────────────────────────────┤
│             Pattern$Loop.match             │
├────────────────────────────────────────────┤
│              Pattern$Node.study            │
├────────────────────────────────────────────┤
│          Pattern.matcher / matches         │
├────────────────────────────────────────────┤
│      CpuBurnDemo.lambda$main$1             │
├──────────────────┬─────────────────────────┤
│    cpu-burn      │       biz-worker        │
└──────────────────┴─────────────────────────┘
```

读图要点（按这个顺序读，不会迷路）：

1. **看宽度**：横轴是采样占比。`cpu-burn` 那个线程的栈占了整图约「一个核」的宽度，`biz-worker` 几乎为零——和 `top -Hp` 的观察互相印证；
2. **找平顶**：最宽的那块「平顶」在 `Pattern$Curly.match0`，说明大量 CPU 时间耗在正则回溯上；
3. **找业务入口**：从平顶往下走，找到第一个**业务包名**的帧（这里是 `CpuBurnDemo.lambda$main$1`），修复就从这里下手；
4. **配色含义**：默认配色大致是「绿色≈Java 栈、黄色≈JVM（C++）内部、红色≈内核态」，不同版本略有差异，以图内图例为准。如果红色（内核态）很宽，问题可能出在系统调用、IO 或锁上，而不是业务代码。

**验证结论**：火焰图平顶出现在 `java.util.regex` 内部、且能沿栈追溯到我们的校验代码，即可下结论「正则回溯导致 CPU 飙高」。修复后再采一张图对比，平顶消失、宽度回到正常水位，闭环完成。

> 再解释一个进阶名词：**safepoint（安全点）偏差**。JVM 的一些全局操作需要让所有线程跑到约定的「安全点」才能执行，早期一些采样器只在安全点采样，导致统计结果系统性偏向「刚好停在安全点的线程」，结论会失真。async-profiler 通过 `perf_events` + 栈展开基本规避了这个问题，这也是它比很多老式采样器可信的原因。

## 六、修复与效果验证

### 6.1 修复方案

对这类回溯问题，最直接的修法是把贪婪量词换成**独占量词（possessive quantifier）**：

```java
// 修复前：嵌套贪婪量词，失败时指数级回溯
static final Pattern BAD = Pattern.compile("^(a+)+$");

// 修复后：独占量词 a++，匹配后不"交还"字符、绝不回溯
static final Pattern OK = Pattern.compile("^(a++)+$");
```

> **独占量词（possessive quantifier）**：`a++` 这种写法，子表达式匹配到多少字符就「独占」多少，失败就整体失败，不会回头把字符让出去重试。因为没有回溯，耗时会从指数级降到线性。

同时补上两条工程上的保底措施：

```java
// 1) 长度上限前置校验：超长输入直接拒绝，别让正则出手
if (input == null || input.length() > 64) { throw new IllegalArgumentException("长度非法"); }

// 2) Pattern 预编译为 static final 常量（本例已做）。
//    千万别在循环/请求里 Pattern.compile()——编译本身就不便宜，还可能引发新的 CPU 热点。
```

### 6.2 修复前后对比

用最简单的方式测单次匹配耗时（长度示意数据，JDK 17 / 4C8G 环境的量级参考，请以你自己机器的实测为准）：

| 输入长度（a 的个数） | 修复前 `^(a+)+$` | 修复后 `^(a++)+$` |
| --- | --- | --- |
| 20 | ≈ 1 s | < 10 µs |
| 22 | ≈ 4 s | < 10 µs |
| 24 | ≈ 16 s | < 10 µs |
| 26 | ≈ 1 min+ | < 10 µs |
| 28 | ≈ 5 min+ | < 10 µs |

验证脚本（直接跑就行）：

```java
long t0 = System.nanoTime();
OK.matcher(input).matches();
long t1 = System.nanoTime();
System.out.println("elapsed: " + (t1 - t0) / 1000 + " µs");
```

规律非常清楚：**修复前输入每加 2 个字符、耗时大约乘 4（指数爆炸）；修复后与长度无关**。换算到接口视角：如果这是登录接口的参数校验，修复前一次 22 字符的恶意输入就能把该接口 P99 从毫秒级拖到 4 秒以上，且持续占满一个核拖垮整机吞吐；修复后 P99 回到毫秒内。

**如何验证修复结论**（三步，缺一不可）：

1. 跑上面的计时脚本，确认修复后耗时与输入长度无关；
2. 重新采集火焰图：`./bin/asprof -d 30 -f /tmp/cpu-after.html <PID>`，确认 `Pattern$Curly` 平顶消失；
3. 回归匹配语义：用正常/异常两组用例跑一遍正则，确认业务判定结果不变（见下节坑 6）。

## 七、常见坑与误区

1. **`jstack` 抓空、时机错过**。毛刺型 CPU 飙高靠快照靠缘分。对策：连打 3~5 次对比（`jstack <pid> > /tmp/stack-1.txt` ...），或者直接用 async-profiler 的 `start` / `stop` 把复现窗口包起来。
2. **搞不清 `%CPU` 的口径**。`top` 里单核是 100%，8 核机器打满是 800%。告警系统、容器编排、`top` 三者的口径不一致时，会出现「告警说 90%、top 看 20%」的灵异事件。先对齐口径再排查。
3. **容器里的 CPU 视角失真**。Docker/K8s 用 cpu quota/cpuset 限流后，容器内 `top` 看到的核数和占用比例与宿主机不一致；`jstack`/`asprof` 要进到容器里用**同版本 JDK** 执行。限流导致的「应用卡但 CPU 看着不高」是另一类问题，别和本篇的「真打满」混为一谈。
4. **perf 权限不足**。容器或安全加固的机器上，`kernel.perf_event_paranoid`（`cat /proc/sys/kernel/perf_event_paranoid` 查看）或 seccomp 会挡住 `perf_events`，`asprof` 会直接报错。对策：让运维放开权限；或退而求其次用 itimer 模式（`./bin/asprof -e itimer -d 30 ...`），基于定时器采样、不需要 perf 权限，代价是拿不到内核态栈。
5. **把火焰图当时间轴看**。火焰图横轴是按字母序排列的采样占比，**不是时间顺序**；根在底部、调用越深越靠上。看图只回答「谁占比大」，时间维度的分析要靠 JFR 或 tracing。
6. **修复正则时只看快不快、不回归语义**。独占量词「不回溯」的同时匹配语义会更严格（如 `^(a++)+$` 对带尾缀的字符串会快速失败，而贪婪版可能换一种拆分方式成功）。替换正则后必须用正常/异常测试用例做等价性回归，别让性能修复变成业务 bug。

## 八、小结

- CPU 排查的骨架是**漏斗**：机器 → 进程 → 线程 → 调用栈 → 代码行，别跳步；
- `top -Hp` + `jstack` 三板斧适合快速兜底，但对毛刺型热点和占比分析无能为力；
- **async-profiler** 开销低、免重启、能拿真实调用栈，是线上热点定位的首选；读火焰图的口诀：先看宽度、再找平顶、往下找业务入口；
- 正则回溯是 CPU 事故的高发区：嵌套量词要警惕，修复优先考虑独占量词 + 长度前置校验，改完必须回归匹配语义；
- 所有结论都要有「验证方法」：计时脚本 + 修复后火焰图 + 用例回归，三件套闭环。

下一篇「线上排查（二）」计划写内存泄漏与堆外内存的定位（MAT + NMT + async-profiler 的 alloc 模式），欢迎追更。

## 参考资料

1. async-profiler 官方仓库（安装、asprof 命令、各采集模式说明）：https://github.com/async-profiler/async-profiler
2. Brendan Gregg — Flame Graphs（火焰图概念的出处，读图方法论讲得最透）：https://www.brendangregg.com/flamegraphs.html
3. Arthas 在线文档（阿里开源 Java 在线诊断工具，`profiler` 命令即内置了 async-profiler）：https://arthas.aliyun.com/doc/
4. 美团技术团队博客（tech.meituan.com，可搜索「CPU 100%」「性能分析」相关实践文章，多篇生产级排查案例值得精读）
