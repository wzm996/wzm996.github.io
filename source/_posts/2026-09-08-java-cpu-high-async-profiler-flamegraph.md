---
title: Java 服务 CPU 飙高排查实战：top、jstack 与 async-profiler 火焰图
date: 2026-09-08 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - JVM
  - async-profiler
  - 火焰图
  - jstack
  - 性能排查
  - ReDoS
---
<hr>
<blockquote>
<p><strong>CPU 飙高</strong> 是 Java 线上故障里最常见的告警之一，但很多人卡在「看到了 100%，却不知道是谁烧的」。<br>这篇文章把 <strong>top -Hp → jstack → async-profiler 火焰图</strong> 这条标准排查链路走一遍，并用一个可复现的正则回溯（ReDoS）案例串起全流程，每一步都给出命令、预期输出和验证方法。<br>看完你得到的不是一个结论，而是一套可以直接搬进值班手册的固定动作。</p>
</blockquote>

<!-- more -->

## 一、先说场景：半夜的 CPU 100% 告警

设想一个经典画面：凌晨两点，监控群炸了，某台 8 核机器上的 Java 服务 CPU 使用率冲到 380%（相对单核就是 47% 左右每核，核心全在忙），接口 P99 从 30ms 飙到 8s。

这时候你可能有两种反应：

1. **玄学派**：重启一下试试，好了就当没发生过。（结果下周同一时间再来一次）
2. **工程派**：花 10 分钟，按固定流程把「烧 CPU 的那行代码」找出来。

这篇文章讲的就是工程派的流程。整个链路只有三步：**先定位线程，再看线程在干什么，最后用采样 profiler 拿到全景**。工具全是免费的，生产环境也都能用。

注：CPU 飙高不一定是坏事，压测打满、批量任务跑着，CPU 高是应该的。要排查的是「**不该高的时候高**」：流量没涨、QPS 平稳，CPU 却上去了——这种一般是代码热点、正则回溯、序列化、锁自旋或者 GC 风暴。

## 二、第一步：从「进程」缩小到「线程」——top -Hp

CPU 是按进程汇总的，但真正烧 CPU 的是线程。所以第一件事是把嫌疑范围从进程缩小到线程。

**top -Hp** 是 top 命令加 `-H` 参数（show threads on，显示线程视角）加 `-p` 参数（指定进程号），作用是：把 Java 进程里的几百个线程当成独立行来展示，每一行都有自己单独的 CPU 占用。

```bash
# 1. 找到 Java 进程号
jps -l
#   12345 com.demo.OrderApplication

# 2. 线程视角查看该进程
top -Hp 12345
```

预期输出（节选）：

```text
  PID USER      PR  NI    VIRT    RES  %CPU  COMMAND
 12378 app       20   0 8943240 1.2g  387.5  java
 12346 app       20   0 8943240 1.2g    0.3  java
 12347 app       20   0 8943240 1.2g    0.0  java
```

重点看 **%CPU 列**：哪个线程的 CPU 最高（比如 387%，表示吃满了约 4 个核），记下它的 **PID 列数值**——在线程视角里这一列显示的是**线程号（TID）**，比如 `12378`。

顺手看一眼 top 里的 **us** 和 **sy** 两个字段：

- **us（user time）**：用户态 CPU，代码自己在干活（业务逻辑、正则、序列化都算）。
- **sy（system time）**：内核态 CPU，在替你干活（系统调用、锁、上下文切换、网络栈）。

us 高，优先怀疑业务代码热点；sy 高，优先怀疑锁竞争、频繁上下文切换或 IO 系统调用密集。这个区分能帮你少走一半弯路。

## 三、第二步：jstack 抓线程快照

**jstack** 是 JDK 自带的命令行工具，作用是：给目标 Java 进程的**所有线程拍一张瞬时快照**，每个线程打印出它此刻的调用栈和状态（RUNNABLE / BLOCKED / WAITING 等），相当于给正在运行的程序按下暂停键看一眼现场。

还有一个坑要先解决：jstack 输出里的线程标识 **nid** 是**16 进制**，而 top 里拿到的是**10 进制**线程号，要对上就得先转换：

```bash
# 把 10 进制线程号转成 16 进制（nid 用）
printf '%x\n' 12378
# 输出：304fa

# 抓快照并定位到这个线程
jstack 12345 > /tmp/jstack.log
grep -A 15 'nid=0x304fa' /tmp/jstack.log
```

预期输出（这是正则回溯案例的典型现场，下一节会讲到怎么造出来）：

```text
"main" #1 prio=5 os_prio=0 tid=0x00007f8a8c009800 nid=0x304fa runnable [0x00007f8a95ffd000]
   java.lang.Thread.State: RUNNABLE
        at java.util.regex.Pattern$GroupCurly.match0(Pattern.java:4434)
        at java.util.regex.Pattern$GroupCurly.match(Pattern.java:4394)
        at java.util.regex.Pattern$Curly.match0(Pattern.java:4260)
        at java.util.regex.Pattern$Curly.match(Pattern.java:4237)
        at java.util.regex.Pattern$Branch.match(Pattern.java:4604)
        ...
        at com.demo.OrderApplication.lambda$validate$0(OrderApplication.java:88)
```

看到 `java.util.regex.Pattern$Curly` / `$GroupCurly` 这两个内部类反复出现，基本就可以直接去搜代码里的正则了——这是回溯现场的指纹。

### 三个必须知道的陷阱

**1. RUNNABLE ≠ 真凶。** RUNNABLE 的意思是「正在运行，或者具备运行条件在排队」，不代表它此刻真在烧 CPU。反过来，WAITING / BLOCKED 的线程是绝对不耗 CPU 的（它们在睡觉）。所以看到一堆 RUNNABLE 别慌，要结合 top -Hp 的 CPU 数据交叉确认。

**2. 一次快照经常扑空。** jstack 是瞬时快照，热点可能在两次抓取之间切换。正确姿势是**连抓 3~5 次，每次间隔 200ms 左右**，看哪个栈反复出现在同一个位置：

```bash
for i in 1 2 3 4 5; do jstack 12345 > /tmp/js_$i.log; sleep 0.2; done
```

**3. 快照不完全等于现场。** jstack 抓取时 JVM 会尽量让线程跑到**安全点（safepoint）**——可以理解为「所有线程都先把手里的事放到一个约定的停靠站」，这会带来轻微失真；而且它只给瞬时值不给统计值。「这个线程到底 30 秒里都在跑什么」，得靠下一节的采样工具。

注：线上不想装额外工具的话，**Arthas**（阿里开源的 Java 诊断工具）的 `thread -n 3` 命令等价于「top -Hp + jstack」二合一，还自带高亮，值得放进工具箱。

## 四、实战案例：一条正则把 CPU 打满（ReDoS）

光讲流程容易忘，我们亲手把这场事故复现一遍。凶手是一条看起来人畜无害的正则。

### 4.1 事故代码

需求：校验输入是否为「一串数字」。写的人用了带分组的写法（可能是因为原来还要提取分组），输入里混进了一个字母：

```java
public class ReDoSDemo {
    public static void main(String[] args) {
        // 26 个 '1' + 1 个 'y'：本意是纯数字校验，尾部混进了字母
        String evil = "11111111111111111111111111y";
        long t0 = System.nanoTime();
        boolean ok = evil.matches("(\\d+)*");   // 灾难性回溯现场
        long t1 = System.nanoTime();
        System.out.printf("matches=%b, cost=%.1f ms%n", ok, (t1 - t0) / 1e6);
    }
}
```

`javac ReDoSDemo.java && java ReDoSDemo` 跑一下——你会发现它**卡住好几秒甚至更久**，最后输出 `matches=false`。26 个字符而已，为什么？

### 4.2 原理：回溯（backtracking）

Java 的 `java.util.regex` 是**回溯型引擎**：正则里的 `\d+`（贪婪，尽量多吃）配合外层 `(...)*`（分组可以重复 0 到多次），引擎会尝试**把 26 个数字按所有可能的方式切分给分组**，每一种切分都要试一遍，切完了发现尾部还有个 `y` 对不上，就退回去换一种切分再试。

n 个字符的切分方式是**指数级**的（约 2^n 种），所以这种失败场景的耗时随输入长度指数增长。**ReDoS**（Regular expression Denial of Service，正则拒绝服务）说的就是这件事：攻击者只要发一个精心构造的字符串，就能用极小的请求成本把你的一个线程烧到 100%，多来几个请求线程池就耗尽了。

我在演示机上用同一模式做了量级验证（Python 的 re 也是回溯引擎，形状一致，可作参考；Java 引擎常数不同，但**每加 4 个字符耗时 ×16 的规律一样**）：

| 输入长度 n | 回溯切分数量级 | 失败匹配实测耗时 |
|---|---|---|
| 18 | 2^18 ≈ 26 万 | ~12 ms |
| 22 | 2^22 ≈ 400 万 | ~179 ms |
| 26 | 2^26 ≈ 6700 万 | ~2895 ms |

规律很清楚：**每加 4 个字符，耗时 ×16**。到 n=34 就是分钟级，n=40 就是天文数字——一条正则打满一个核，不需要任何高并发。

### 4.3 怎么修

三个方案，按推荐程度排序：

**方案一（根治）：让业务语义回到线性正则。** 如果需求就是「纯数字校验」，单层 `\d+` 本来就是线性的，加 `(...)*` 分组纯属画蛇添足：

```java
boolean ok = evil.matches("\\d+");   // 线性引擎路径，微秒级返回 false
```

**方案二（救急）：占有量词切断回退。** **占有量词**（possessive quantifier，`*+`、`++`）是贪婪量词的「吃了不吐」版本：匹配进去的字符绝不交还，直接掐死回溯的可能性：

```java
boolean ok = evil.matches("(\\d++)*");   // 立刻失败，微秒级
```

**方案三（兜底）：入口限制 + 独立防线。** Java 正则**没有内建超时参数**（Pattern 一旦开跑就只能等它跑完），所以入口处必须限制输入长度（比如手机号校验前先 `length() == 11`）；对用户可控的正则场景，考虑换 RE2J 这类线性时间引擎。

### 4.4 验证修复效果

| 写法 | 输入 26 位失败场景 | 语义 |
|---|---|---|
| `(\d+)*` | ~秒级（指数回溯） | 有灾难回溯风险 |
| `(\d++)*` | < 1 ms | 占有量词切断回溯 |
| `\d+` | < 1 ms | 线性匹配，最贴合业务 |

把 4.1 的代码换成三种写法各跑一遍即可验证（对比例子里的量级差异，把 n 加到 30+ 更明显）。**注意一个语义细节**：`(\d++)*` 和 `(\d+)*` 在「成功匹配」的场景下结果一致，差异只体现在失败路径——这正是回溯事故的隐蔽之处：**测试环境怎么测都正常，线上吃到恶意输入才爆炸**。

## 五、第三步：上 async-profiler 火焰图

jstack 解决「这个线程这一瞬间在干什么」，但排查 CPU 问题经常需要「过去 30 秒里 CPU 都花在哪了」。这时候该 **async-profiler** 出场了。

**async-profiler** 是一个低开销的采样式 JVM 性能分析器。它牛在哪：普通的采样 profiler 靠安全点拿栈，存在系统性偏差（只有跑到安全点的线程才被看到，恰好是热点线程容易被漏掉）；而它走 JVM 内部的 **AsyncGetCallTrace** 接口直接抓栈，配合内核的 **perf_events**（Linux 自带的性能采样框架，按固定频率产生中断来采样 CPU 上正在执行的代码）拿到的样本，偏差小得多，而且开销通常低于 1%，**可以开着上生产**。

火焰图（**flame graph**）是它最常用的输出形式——把成千上万个调用栈样本横向堆叠起来的可视化图：

- **横轴**：不是时间，是**占比**。一个格子是一个函数，格子越宽，说明它出现在采样里的比例越高（≈ CPU 占比越高）。
- **纵轴**：调用栈深度，上面的格子是下面格子的调用方（栈顶朝上）。
- **颜色**：默认按样本归属着色的暖色系，本身不代表严重程度，别被「红」吓到。
- **找热点就看「平顶山」**：又宽又平的顶部说明这个函数占了大量采样，顺着它往下读就是调用链。

### 采集步骤

```bash
# 1. 下载（版本以官方 Releases 页为准，旧版工具名是 profiler.sh）
curl -L -o asprof.tar.gz \
  https://github.com/async-profiler/async-profiler/releases/download/v4.1/async-profiler-4.1-linux-x64.tar.gz
tar xzf asprof.tar.gz

# 2. CPU 模式采集 30 秒，输出交互式 HTML
./bin/asprof -d 30 -f /tmp/flame.html 12345

# 3. 容器里常见 perf 权限受限（perf_event_paranoid），换 itimer 模式：
#    用时间片中断代替 perf 中断采样，不需要内核 perf 权限
./bin/asprof -e itimer -d 30 -f /tmp/flame.html 12345
```

把 `flame.html` 拖进浏览器，先看整体，再从最宽的平顶往下点。

注：如果只想快速看一眼前几名热点、不想导出文件，`./bin/asprof -d 10 12345` 会直接在终端打印 top 视图。JDK 11+ 也可以直接用内置的 JFR（Java Flight Recorder，JVM 自带的飞行记录仪）`-XX:StartFlightRecording` 采集，再用 JMC 或 `jfr` 命令分析——和 async-profiler 是互补关系。

## 六、用火焰图复核第四节案例

回到 ReDoS 现场。在 `evil.matches("((\\d+))*")` 卡住的那几秒里采集：

```bash
./bin/asprof -d 5 -f /tmp/redos.html <pid>
```

你会在火焰图里看到一座标志性的平顶山：

- 最宽的顶是 `Pattern$GroupCurly.match0` 和 `Pattern$Curly.match0`，两者合计占掉绝大部分采样；
- 往下收窄到 `Pattern$Branch.match` → `Pattern$Matcher.match` → `Matcher.matches` → 一路到我们自己的 `lambda$validate$0`；
- 同一张图里 GC 线程、其他业务线程窄得几乎看不见。

这张图和第三节 jstack 抓到的栈完全对得上，两条独立证据链闭环，就可以放心去改代码了。这也是排查 CPU 问题的标准姿势：**快照给证据，火焰图给全貌，交叉验证再动手**。

## 七、常见坑与误区

1. **只抓一次 jstack 就下结论。** 瞬时快照扑空率很高，至少连抓 3~5 次找「反复出现」的栈。
2. **看到 RUNNABLE 就认定是真凶。** RUNNABLE 只说明「没睡」，要和 top -Hp 的 CPU 数据交叉确认。
3. **sy 高还去翻业务代码。** sy 高先查锁竞争和上下文切换（`vmstat 1`、`pidstat -w`），业务热点一般表现为 us 高。
4. **忽略 GC 线程和 VM Thread。** top -Hp 里 `GC task thread` 或 `VM Thread` 高，先 `jstat -gcutil <pid> 1000` 看是不是 GC 风暴，别急着改业务代码。
5. **容器里的 CPU 口径没对齐。** top 显示的百分比可能按宿主机核数算，容器内 `nproc` 与监控面板口径不一致时会误判「没打满」；另外容器内 perf 通常没权限，async-profiler 记得用 `-e itimer`。
6. **工具没权限就说环境有问题。** jstack / asprof 都要求与目标 JVM **同一用户**运行，root 跑的应用用 app 用户去 attach 必然失败。
7. **迷信小样本火焰图。** 采样时间太短（比如 2 秒）时百分比波动很大，先采够 30 秒再看。
8. **给正则加 try-catch 等超时。** Java 正则不支持中断和超时，超时保护在 Pattern 这一层是无效的；正确防御是入口限长、占有量词或线性引擎。

## 八、总结

- CPU 排查三步走：`top -Hp` 定位线程 → `jstack` 看瞬时现场 → `async-profiler` 火焰图看统计全貌，三者是**递进而非替代**关系。
- 10 进制线程号 `printf '%x'` 转 16 进制对 nid，是 jstack 的标准前置动作。
- 回溯型正则在失败路径上是指数级的，**测试环境测不出来，线上恶意输入才爆炸**；防御三板斧：业务语义回归线性正则、占有量词切断回退、入口限制长度。
- 火焰图找「平顶山」，横轴是占比不是时间；sy 高查锁和切换，GC 线程高先看 GC。
- 所有命令都在文中，拿测试环境跑一遍 ReDoSDemo，这套流程就真正变成你的了。

## 参考资料

1. async-profiler 官方仓库（安装、用法、itimer 模式）：https://github.com/async-profiler/async-profiler
2. Arthas 官方文档（阿里开源，thread / profiler 命令）：https://arthas.aliyun.com/doc/
3. Brendan Gregg — FlameGraphs（火焰图发明者的原理说明）：https://www.brendangregg.com/flamegraphs.html
4. OWASP — Regular expression Denial of Service (ReDoS)：https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS
5. Oracle JDK 17 — jstack 手册页：https://docs.oracle.com/en/java/javase/17/docs/specs/man/jstack.html
6. java.util.regex.Pattern 官方文档（贪婪 / 惰性 / 占有量词语义）：https://docs.oracle.com/javase/8/docs/api/java/util/regex/Pattern.html
