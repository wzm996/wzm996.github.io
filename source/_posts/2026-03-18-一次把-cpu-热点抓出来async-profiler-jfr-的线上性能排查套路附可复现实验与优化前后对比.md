---
title: 一次把 CPU 热点抓出来：async-profiler + JFR 的线上性能排查套路（附可复现实验与优化前后对比）
date: 2026-03-18 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - Java
  - async-profiler
  - JFR
  - FlameGraph
  - 性能分析
---

<hr>
<blockquote>
<p>线上 CPU 突然飙高时，最怕的不是“慢”，而是“你不知道慢在哪”。这篇我用一套<strong>可复制</strong>的流程：先用 <strong>async-profiler</strong> 5 分钟出火焰图抓热点，再用 <strong>JFR（Java Flight Recorder）</strong> 交叉验证线程/锁/GC 等维度，最后给出一个小优化并用压测数据证明收益。</p>
</blockquote>

<!-- more -->

## 0. 先说清楚：本文适合谁？需要什么基础？

- 适合读者：Java 后端同学、做过线上排障/性能优化但对 profiler 不熟的人。
- 先修：会用 `jps/jcmd/jstack` 这些基础命令；知道“采样”大概啥意思；能在 Linux 上装工具。

> 口语化解释两个新名词：
>
> - **Profiler（性能剖析器）**：就是一个“探针”，在程序跑着的时候，定期看看 CPU 时间/调用栈都花在哪，然后汇总给你。
> - **火焰图（FlameGraph）**：把调用栈聚合成一张图，越“宽”的函数表示越耗时，基本一眼就能看到热点。

## 1. 事故现场：CPU 100% 到底在忙啥？

典型告警长这样：

- 某服务 CPU 从 30% 拉到 90%+，QPS 没涨，延迟 P99 飙了。
- 你 `top` 看到了 Java 进程很忙，但你不知道它忙在：
  - 业务逻辑？
  - GC？
  - 锁竞争？
  - 日志/序列化？
  - 还是某个三方库在搞事？

这时候最有效的一句话是：**先把证据抓出来（火焰图 / JFR），再讨论优化。**

## 2. 选型：为什么我建议 async-profiler + JFR 组合拳

### 2.1 async-profiler：快、准、侵入性小（适合先手）

- async-profiler 属于“低开销采样”类 profiler，适合线上先抓 30~60 秒。
- 输出物一般是 HTML 火焰图，沟通成本很低：贴图给同事大家都看得懂。

### 2.2 JFR：信息更全（适合复核 + 深挖）

- **JFR（Java Flight Recorder）**：JDK 自带的“黑盒录制器”，能录 CPU/线程/锁/GC/类加载等事件。
- 你可以把它理解成“Java 进程的行车记录仪”。

> 实战经验：
> - **先 async-profiler 定位方向**（热点函数/热点栈）。
> - **再 JFR 验证全局**（是不是锁/GC/线程调度导致的假象）。

## 3. 可复现实验：造一个“CPU 高 + 延迟高”的小服务

为了让你能在自己机器上复现，我们用 JDK 自带的 `com.sun.net.httpserver.HttpServer` 起一个 HTTP 服务，故意写一个“很慢的”路径：每次请求都做一坨正则替换 + 频繁创建对象。

### 3.1 代码（单文件可跑）

保存为 `DemoServer.java`：

```java
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Random;
import java.util.regex.Pattern;

public class DemoServer {
    // 故意写得“很重”：每次都做 regex + new String
    private static final Pattern P = Pattern.compile("[a-zA-Z0-9]{3,10}");
    private static final Random R = new Random(1);

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getProperty("port", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        server.createContext("/hot", exchange -> {
            String s = payload();
            // 模拟：每次请求都做一遍正则替换（CPU 热点候选）
            String out = P.matcher(s).replaceAll("X");

            byte[] resp = out.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/plain; charset=utf-8");
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });

        server.start();
        System.out.println("listening on :" + port);
    }

    private static String payload() {
        // 故意制造一些随机字符串
        StringBuilder sb = new StringBuilder(1024);
        for (int i = 0; i < 80; i++) {
            sb.append(Integer.toHexString(R.nextInt()));
            sb.append('-');
        }
        return sb.toString();
    }
}
```

编译运行（JDK 11+）：

```bash
javac DemoServer.java
java -Dport=8080 DemoServer
```

### 3.2 压测与验证：先把“慢”跑出来

用 `wrk`（或 `hey`）压 `GET /hot`：

```bash
# 30s 压测，带 latency 分布
wrk -t2 -c50 -d30s --latency http://127.0.0.1:8080/hot
```

你应该能看到：

- CPU 使用率明显升高（`top` / `pidstat -u 1 -p <pid>`）。
- `wrk` 的 `Latency Distribution` 里 P95/P99 比较难看。

> **如何验证结论**：后面我们做优化后，重复压测，比较 P50/P95/P99 + QPS 是否改善。

## 4. 第一步：用 async-profiler 30 秒出“证据图”（火焰图）

### 4.1 安装与注意事项

1）下载 async-profiler（建议直接用 release 包）：

- 入口：<https://github.com/async-profiler/async-profiler>

2）常见坑提前说：

- **权限问题**：某些机器上 `perf_event_paranoid` 太高会导致采样失败。
- **容器里看不到宿主 perf 事件**：需要额外权限（例如 `--privileged` 或指定 capability）。

可以先检查：

```bash
cat /proc/sys/kernel/perf_event_paranoid
```

值越大越严格。线上遇到权限问题，不要硬改系统参数，先走你们的变更流程。

### 4.2 采集 CPU 火焰图

假设 Java 进程 pid 是 `12345`：

```bash
# 采集 30 秒 CPU 火焰图，输出成 html
./profiler.sh -d 30 -e cpu -f /tmp/cpu.html 12345

# 如果你怀疑“卡顿/阻塞”更多来自等待（锁、IO、调度），可以采 wall-clock
./profiler.sh -d 30 -e wall -f /tmp/wall.html 12345
```

打开 `/tmp/cpu.html`，你大概率会在顶部看到类似：

- `java.util.regex.Pattern` / `Matcher` 相关的方法很宽
- 或者某些 `String`/`StringBuilder` 相关栈很宽

> 口语化解释：
> - **cpu 模式**看的是“CPU 时间花在哪”。
> - **wall 模式**看的是“真实时间花在哪”（包括等待）。线上排障一般两张都抓一下，避免误判。

## 5. 第二步：用 JFR 录一段，确认不是 GC/锁/线程调度在背锅

### 5.1 用 jcmd 开始录制（低风险、可控）

先用 `jcmd` 看下进程：

```bash
jcmd
```

开始录制 60 秒（profile 配置）：

```bash
jcmd 12345 JFR.start name=hot settings=profile filename=/tmp/hot.jfr duration=60s
```

录制结束后你会得到 `/tmp/hot.jfr`。

### 5.2 用 JDK Mission Control（JMC）看什么

打开 JMC（或你们内部的 JFR 查看工具），重点看：

- **CPU**：线程 CPU 时间、热点方法（和 async-profiler 是否一致）
- **Threads**：是否线程数不够/线程调度异常
- **Locks**：是否大量阻塞在某个 monitor/lock
- **GC**：是否频繁 Minor GC 或者 STW 拉长

> 经验：如果 JFR 显示锁竞争非常重，那火焰图里的“业务热点”可能只是表象——线程真正卡在锁等待上。

## 6. 做一个小优化：把“正则替换”改成更便宜的逻辑（并验证收益）

这里我故意选一个很常见的场景：正则在热点路径里非常耗 CPU。

### 6.1 优化思路

- 正则是把一堆通用能力（回溯、分组、字符类）打包在一起，**方便但不便宜**。
- 如果你的需求只是“过滤/替换某些字符”，通常可以用手写循环或更简单的判断替代。

把 `/hot` 的逻辑改成：只保留十六进制字符和 `-`，其他都替换成 `X`（示例目的：把热点从 regex 挪走）。

替换代码（示意）：

```java
private static String cheapReplace(String s) {
    char[] a = s.toCharArray();
    for (int i = 0; i < a.length; i++) {
        char c = a[i];
        boolean ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || c == '-';
        if (!ok) a[i] = 'X';
    }
    return new String(a);
}
```

### 6.2 优化前后对比：用同一套压测 + 同一套 profiling

1）重复压测：

```bash
wrk -t2 -c50 -d30s --latency http://127.0.0.1:8080/hot
```

2）重复采集 async-profiler CPU 火焰图：

```bash
./profiler.sh -d 30 -e cpu -f /tmp/cpu_after.html 12345
```

3）对比指标（示例表格，按你的机器实际填数据）：

| 指标 | 优化前 | 优化后 | 结论 |
|---|---:|---:|---|
| QPS | 例如 12,000 | 例如 18,000 | 吞吐提升 |
| Latency P50 | 例如 4ms | 例如 3ms | 中位数改善 |
| Latency P95 | 例如 18ms | 例如 9ms | 尾延迟明显改善 |
| Latency P99 | 例如 60ms | 例如 25ms | 卡顿减少 |

> **如何验证结论**：
> - 火焰图里 `java.util.regex` 相关栈应该明显变窄。
> - `wrk --latency` 的 P95/P99 应该下降（至少趋势上更好）。

## 7. 线上落地时的“坑”与我踩过的雷

1）**只看 CPU 火焰图就下结论**

- CPU 图只能告诉你“CPU 在忙什么”，不能告诉你“为什么延迟高”。
- 一定要补一张 `wall` 火焰图，或者用 JFR 看锁/GC。

2）**采样窗口太短/太长**

- 太短：可能抓不到问题（尤其是抖动型热点）。
- 太长：对线上更不友好、文件更大、分析更费时。
- 我一般建议：先 30 秒抓方向，必要时再延长到 2~5 分钟。

3）**容器环境权限导致“啥也采不到”**

- 生产环境要提前跟 SRE 对齐：哪些节点允许采样、开哪些能力、走什么流程。

4）**误把“安全点（safepoint）”当成业务热点**

- 有些 profiler 在某些情况下会让你看到大量 safepoint 相关栈。
- 如果看到奇怪的 JVM 内部栈，建议用 JFR 交叉验证。

## 8. 总结（给你一套可以直接照抄的排查 SOP）

- 第 1 步：用 `wrk/hey` 或线上指标确认“确实慢”（P95/P99）。
- 第 2 步：async-profiler 抓 `cpu` 火焰图（30~60s）定位热点函数。
- 第 3 步：async-profiler 再抓 `wall` 火焰图，避免把“等待”误判成“计算”。
- 第 4 步：JFR 录一段（60s），从锁/线程/GC 维度复核。
- 第 5 步：做一个小改动，**用同一套压测与 profiling** 做优化前后对比。

## 参考资料

- async-profiler 项目主页：<https://github.com/async-profiler/async-profiler>
- Brendan Gregg：FlameGraphs 介绍与阅读方法：<http://www.brendangregg.com/flamegraphs.html>
- Brendan Gregg：perf 使用与示例（系统性能分析入门非常实用）：<http://www.brendangregg.com/perf.html>
- OpenJDK JEP 328：Flight Recorder（JFR 进入 OpenJDK 的背景）：<https://openjdk.org/jeps/328>
- Oracle Docs：jcmd（JDK 自带诊断命令，含 JFR 相关用法）：<https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html>
- Oracle Docs：Java Flight Recorder（概览，含启动/配置思路）：<https://docs.oracle.com/en/java/javase/21/jfapi/>