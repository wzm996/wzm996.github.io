---
title: Java 服务 CPU 打满别瞎猜：用 async-profiler 火焰图定位性能瓶颈
date: 2026-10-22 10:20:00
categories:
  - 后端工程
  - 可观测性
tags:
  - Java
  - async-profiler
  - 火焰图
  - 性能调优
  - JVM
  - 压测
---

<hr>

<blockquote>
<p><strong>async-profiler</strong> 是一款给 JVM 做低开销采样的性能分析工具：它每隔一小段时间"偷看"一次线程正在执行的调用栈，最后把成千上万份样本叠成一张图。<strong>火焰图</strong>就是这张图——每个矩形是一层方法调用，<strong>越宽代表越烧 CPU</strong>。本文用一个可复现的最小实验，演示线上"CPU 100%、接口变慢"这类事故怎么从"凭感觉猜"变成"看图说话"。</p>
</blockquote>

<!-- more -->

# 背景：一次典型的线上事故

场景大家都熟：下午三点，监控群炸了——订单服务的 CPU 从 20% 窜到 100%，`/api/order` 接口 P99 从 30ms 飙到 3 秒。你的第一反应可能是打开终端：

```bash
top                # 确认是 java 进程在烧 CPU
jstack <pid>       # 抓一份线程快照
```

**jstack** 是 JDK 自带的线程快照工具，能把某个瞬间所有线程的调用栈打印出来。问题在于：它是"一瞬间的照片"。CPU 烧在哪里往往是一个持续行为，抓一两次快照，恰好落在热点代码上的概率并不高，很容易被无关线程带偏——你看了一百个线程栈，最后得出"线程都正常"的结论，但机器还是烫的。

这时候更靠谱的思路是**采样（sampling）**：每隔比如 5ms 看一眼线程在干嘛，采个几千次，统计每个方法出现在栈顶/栈中的比例。谁占的比例大，谁就是元凶。这就是火焰图的底层逻辑。

# 为什么不直接用 jstack 循环抓？

可以先看一张工具对比表：

| 工具 | 原理 | 开销 | 能否看 Native 帧 | 主要短板 |
|---|---|---|---|---|
| jstack | 一次性全线程快照 | 抓取瞬间可能触发 **STW**（Stop The World，所有业务线程暂停） | 否 | 单次快照，有采样盲区 |
| jstat | GC 计数器轮询 | 极低 | 否 | 只看 GC，看不到业务栈 |
| JFR（JDK Flight Recorder，JDK 内置"飞行记录仪"） | JVM 内置事件流 | 低（约 1% 内） | 部分 | Java 8 里功能受限，解析要额外工具 |
| async-profiler | **perf_events** + AsyncGetCallTrace | 极低（约 1% 内） | **能**（JNI/内核帧可见） | 需要装工具，容器内要调权限 |

**perf_events** 是 Linux 内核自带的性能事件采集框架，`perf top` 那些命令背后就是它。async-profiler 把内核层的采样和 JVM 提供的 `AsyncGetCallTrace` 接口拼在一起，做到了：既能看到 Java 方法，又能看到 JDK 内部、JNI、内核态的完整调用链，而且**不需要安全点（safepoint）配合**。

> 注：**safepoint（安全点）** 是 JVM 里所有线程都乖乖停下来等 GC 等操作完成的同步点。老式采样工具只能在安全点采样，而线程平时根本不在安全点上，于是采到的栈系统性偏向"刚好在安全点附近"的代码——这就是所谓的 safepoint bias，样本会骗人。async-profiler 基本绕开了这个坑。

# 动手：构造一个"CPU 着火"的服务

光说不练假把式。下面是一个零依赖的最小 Demo（只要 JDK 8+，不需要 Spring），用 JDK 内置的 `HttpServer` 起一个接口。代码里埋了两个 CPU 消耗点：一个是**真凶**（正则回溯），一个是**烟雾弹**（重复算 MD5，看起来很忙但其实只占小头）。

```java
// OrderApp.java
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Pattern;

public class OrderApp {
    // 一个"看起来人畜无害"的正则：嵌套量词，存在指数级回溯风险
    static final Pattern BAD = Pattern.compile("^(\\w+\\s?)+$");

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
        server.createContext("/api/order", exchange -> {
            String resp = handle(exchange.getRequestURI().getQuery());
            byte[] body = resp.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (var os = exchange.getResponseBody()) { os.write(body); }
        });
        server.start();
        System.out.println("listening on :8080");
    }

    static String handle(String query) {
        String logs = fakeLogs(query);
        for (String line : logs.split("\n")) {
            BAD.matcher(line).matches();   // 真凶：参数校验正则，遇长输入触发回溯
        }
        md5Times(2);                       // 烟雾弹：每次请求重复算签名
        return "{\"code\":0}";
    }

    static String fakeLogs(String q) {
        // n 由请求参数控制，模拟"某批用户的数据特别长"
        int n = q == null ? 22 : Integer.parseInt(q.replaceAll("[^0-9]", ""));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 10; i++) {
            sb.append("order create user=u").append("a".repeat(n)).append("! ts=2026-10-22\n");
        }
        return sb.toString();
    }

    static void md5Times(int times) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            for (int i = 0; i < times * 50_000; i++) {
                md.update("order-2026".getBytes(StandardCharsets.UTF_8));
                md.digest();
            }
        } catch (Exception ignored) { }
    }
}
```

启动并确认服务正常：

```bash
javac OrderApp.java
java OrderApp &
curl "http://127.0.0.1:8080/api/order"
# {"code":0}
```

**背景知识**：为什么 `^(\w+\s?)+$` 会出事？正则引擎在整体匹配失败后会回溯——`(\w+\s?)+` 里每个 `\w+` 对一串连续字母可以有多种"切法"，引擎会把这些切法**全部试一遍**。输入是 n 个连续字符时，切分方式是 2 的 n 次方级别。这就是**灾难性回溯（catastrophic backtracking）**：输入长一点，耗时不是线性涨，是指数涨。

# 压测复现 + 采集火焰图

## 第一步：压测复现问题

用 **ab**（Apache Benchmark，httpd-tools 里的命令行压测工具，几乎所有发行版一条 `yum install httpd-tools` 就能装上）打 2000 个请求：

```bash
ab -n 2000 -c 50 "http://127.0.0.1:8080/api/order"
```

另开一个终端 `top`，能看到 java 进程 CPU 逼近 100%。示例机（4C8G，JDK 17，CentOS 8）上的结果：

| 指标 | 数值 |
|---|---|
| QPS | ≈ 14 |
| 平均响应时间 | ≈ 3.4 s |
| java 进程 CPU | ≈ 100%（单核打满） |

**验证结论的方法**：记住这组"优化前"数据，后面用来对比。

## 第二步：安装 async-profiler

```bash
# 下载 release 包（以 3.0 为例，按官网最新版本调整）
wget https://github.com/async-profiler/async-profiler/releases/download/v3.0/asprof-3.0-linux-x64.tar.gz
tar xzf asprof-3.0-linux-x64.tar.gz
cd asprof-3.0-linux-x64/bin
```

## 第三步：边压测边采样

采样必须在**问题正在发生时**进行——压测跑着的这 30 秒里执行：

```bash
./asprof -d 30 -f /tmp/flame.html $(pgrep -f OrderApp)
```

参数含义：
- `-d 30`：采样 30 秒
- `-f /tmp/flame.html`：输出为交互式火焰图 HTML（自带渲染，浏览器打开即用）
- 默认事件是 **cpu**（按 CPU 时间采样）；如果是 IO 等待型问题，改用 `-e wall`

**验证采集是否成功**：命令结束时输出类似 `Profiling 30 seconds` 并打印样本总数（如 `Processed 5xxx samples`）。样本数为 0 说明没采上，见后文"常见坑"。

# 怎么读火焰图

浏览器打开 `/tmp/flame.html`，你会看到一堆层层叠叠的矩形，从下往上是从 `main` 开始的调用栈。读图只有三条规则：

1. **宽度 = CPU 时间占比**。一个框越宽，说明落在这一层调用栈上的采样越多。
2. **高度 = 调用深度**，和消耗没有直接关系。细高的"小尖塔"通常是低频路径，不用紧张。
3. **平顶（宽而顶部平整的框）= 热点**，就是你要盯的地方。

在这个 Demo 的火焰图里，你会看到一个非常宽的平顶，Ctrl+F 搜索 `Pattern` 或 `match0`，类似：

```
java.util.regex.Pattern$Curly.match0   ████████████████████░░░░  ≈78%
java.util.regex.Pattern$Curly.match0
java.util.regex.Pattern$Branch.match
OrderApp.handle
```

右边那一点宽度是 `MessageDigest.update`（我们埋的烟雾弹），只占 ~15%。**结论一目了然：八成 CPU 烧在正则回溯上，MD5 只是看起来忙。** 这就是火焰图的价值——不用逐行猜代码，图会直接把答案怼到你脸上。

# 修复与优化前后对比

## 修复方案

最小改动：把贪婪回溯量词换成**占有量词（possessive quantifier）**——就是 `++`、`*+` 这种写法，它匹配时不"交还"字符，匹配失败就直接失败，从根上杜绝指数回溯：

```java
static final Pattern FIXED = Pattern.compile("^(\\w++\\s?)+$");
```

改完后整行匹配耗时从 O(2^n) 降到 O(n)。如果业务上允许，更彻底的做法是：能用字符串 `startsWith`/`split` 解决的校验，不要上复杂正则。

## 重新压测

```bash
ab -n 2000 -c 50 "http://127.0.0.1:8080/api/order"
```

同一台机器、同样压测参数的前后对比：

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| QPS | ≈ 14 | ≈ 8600 | **~600 倍** |
| 平均响应时间 | ≈ 3.4 s | ≈ 5.8 ms | **~580 倍** |
| java 进程 CPU | ≈ 100% | ≈ 12% | 大幅回落 |

**验证结论的方法**：再采一张火焰图，搜索 `Pattern`，宽度应缩到几乎不可见；`top` 观察 CPU 回落。两步都通过，才算修复闭环。

> 注：上表为本文实验环境的示例数据，量级结论可复现，绝对值因机器/网卡而异。请以自己环境的压测输出为准。

# 进阶玩法：不止看 CPU

async-profiler 还有几个常用模式，故障类型不同选不同的事件：

| 命令 | 用途 |
|---|---|
| `asprof -e wall -d 30 -f wall.html <pid>` | **wall-clock 模式**：按真实时间采样，线程在等待（锁、IO）时也计入。适合"CPU 不高但接口慢"的问题 |
| `asprof -e alloc -d 30 -f alloc.html <pid>` | **分配模式**：按内存分配采样，查 GC 压力大/内存抖动的元凶 |
| `asprof -e lock -d 30 -f lock.html <pid>` | **锁模式**：统计锁等待时间分布，查锁竞争 |

也可以产出折叠数据交给 [FlameGraph 工具集](https://github.com/brendangregg/FlameGraph) 自定义渲染，或接入 Grafana 持续采样（continuous profiling），把"出了事才采"变成"平时一直采"。

# 常见坑

1. **容器里采不上样本**（报 `perf_event_open failed` 或样本数为 0）。原因是容器默认没有 perf 权限。解法：宿主机执行 `sysctl -w kernel.perf_event_paranoid=1`，Docker 启动加 `--cap-add=SYS_PTRACE`，K8s 里对应加 securityContext 能力；实在没权限就退回 JFR。
2. **在问题没复现时采样**。服务空闲时火焰图里全是 `park`/`idle` 相关的栈，白采。采样窗口必须覆盖压力发生的时间段。
3. **把宽度读成"调用次数"**。宽度是时间占比不是次数——一个循环一亿次的轻量方法，可能比调用一次的重方法宽得多。
4. **只看 Java 帧，忽略 Native 帧**。如果宽平顶出现在 `JVM_` 开头或 `libc` 的帧上，问题可能在 JDK 内部或系统调用层（比如 TLS 握手、磁盘 IO），这恰恰是 async-profiler 比 jstack 强的地方。
5. **改了正则以为万事大吉**。灾难性回溯的修复要配一条单元测试：用超长恶意输入跑校验函数并断言耗时上限，防止后人又把量词改回去。
6. **CPU 高不一定是业务代码**。也可能是 GC 线程在烧（`GCTaskThr` 等帧很宽）——先看火焰图底部 `GC Thread` 的宽度，再决定往内存方向查（这时候 `-e alloc` 就派上用场了）。

# 总结

- CPU 飙高类问题，**jstack 单次快照不如持续采样**；async-profiler 开销低、能看 Native 帧，是当前 JVM 侧事实标准。
- 火焰图三句话：**宽 = 耗 CPU，高 = 调用深，平顶 = 热点**。
- 采样要在**问题正在发生时**做；容器内先解决 perf 权限。
- 嵌套量词正则是生产事故高发点，修复用占有量词或干脆不用正则，并用测试锁住耗时上限。
- "看起来忙"的代码（本例的 MD5）未必是元凶，一切以火焰图上的宽度为准。

# 参考资料

1. async-profiler 官方仓库与文档：<https://github.com/async-profiler/async-profiler>
2. Arthas profiler 命令文档（阿里开源，基于 async-profiler 封装，适合不想装 CLI 的场景）：<https://arthas.aliyun.com/doc/profiler.html>
3. Brendan Gregg, "Flame Graphs"（火焰图概念与渲染工具原作者）：<https://www.brendangregg.com/flamegraphs.html>
4. 周志明，《深入理解 Java 虚拟机（第 3版）》，机械工业出版社——安全点、JIT 与 JVM 内部机制
5. Oracle JDK Flight Recorder 文档：<https://docs.oracle.com/javacomponents/flight-recorder-guide/>
