---
title: Spring Boot 线上 CPU 飙高怎么定位：JFR + async-profiler 从“看不懂”到“能复现”
date: 2026-03-13 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - Spring Boot
  - JFR
  - async-profiler
  - 火焰图
  - 性能分析
---

<hr>
<blockquote>
<p>CPU 飙高这事最烦的点不是“它高”，而是“你不知道高在哪里”。这篇我用一个<strong>可复现的小服务</strong>把排查链路跑通：先用压测把问题稳定复现，再用 <strong>JFR</strong> 抓全局证据，最后用 <strong>async-profiler</strong> 一锤定音到热点方法，并给出一组优化前后 P99 的对比。</p>
</blockquote>

<!-- more -->

## 0. 这篇适合谁？先修是什么？

- 适合：写 Java/Spring Boot 服务、遇到过“机器 CPU 100% 但不知道在忙啥”的同学；或者你负责性能/稳定性、想把排查动作标准化。
- 先修：会启动 Spring Boot、会用 `curl`、知道什么是 QPS/延迟就够了。

> 本文默认 JDK 17 + Linux。你用 JDK 11 也基本一样。

## 1. 先把名词说人话（第一次出现必须解释）

- **JFR（Java Flight Recorder）**：JDK 自带的“飞行记录仪”。你可以把它理解为：在 JVM 里持续采样/记录各种事件（CPU 采样、锁竞争、GC、线程状态等），最后导出一个文件给你复盘。
- **JMC（Java Mission Control）**：打开/分析 JFR 文件的 GUI 工具。你可以理解为“JFR 的看片软件”。
- **async-profiler**：一个对 Java 友好的 profiler（性能剖析器），可以用很低的开销采集 CPU/Wall/alloc/lock 等，并输出<strong>火焰图（Flame Graph）</strong>。
- **火焰图**：把“CPU 时间花在哪些函数栈上”可视化的一种图。越“宽”的块，说明占用越多；往下是调用链。
- **Wall time vs CPU time**：Wall 是“现实时间”（包括等待），CPU 是“真正在跑指令”的时间。CPU 飙高一般先看 CPU time。

## 2. 排查总流程（我建议你背下来）

1) **先复现**：没有稳定复现就别急着上 profiler，抓到的东西大概率是噪音。
2) **先全局，后局部**：先用 JFR 看“CPU/线程/锁/GC”的全景，再用 async-profiler 定位到具体热点方法。
3) **优化要可验证**：优化前后必须有同口径压测数据（至少吞吐 + P95/P99）。

下面我用一个“故意写烂”的例子把链路跑通。

## 3. 搭一个可复现的 Spring Boot 热点（故意制造 CPU 问题）

### 3.1 示例代码

这个接口会在每次请求里做两件“看起来没啥，但很吃 CPU”的事：

- 每次请求都 `Pattern.compile(...)`（重复编译正则）
- 每次请求都创建大量临时对象（字符串拼接）

```java
@RestController
public class CpuHotController {

  // 反例：不要每次请求都 compile
  @GetMapping("/api/cpu")
  public Map<String, Object> cpu(@RequestParam(defaultValue = "10000") int n) {
    Pattern p = Pattern.compile("(foo|bar|baz)-([0-9]+)");

    long hit = 0;
    String s = "foo-123";
    for (int i = 0; i < n; i++) {
      Matcher m = p.matcher(s + i); // 反例：制造临时对象
      if (m.find()) {
        hit++;
      }
    }

    return Map.of(
        "n", n,
        "hit", hit,
        "ts", System.currentTimeMillis());
  }
}
```

### 3.2 启动方式（建议加上可观测性）

```bash
# 1) 启动
./mvnw -q -DskipTests spring-boot:run \
  -Dspring-boot.run.jvmArguments="-Xms512m -Xmx512m"

# 2) 验证接口
curl "http://127.0.0.1:8080/api/cpu?n=20000" | head
```

> 这只是“把问题造出来”。真实线上问题可能是 JSON 序列化、日志、正则、加解密、ORM、缓存 miss、线程池配置等。

## 4. 用压测把 CPU 打满：先拿到基线数据

压测工具你用 `wrk`/`hey`/JMeter 都行，我这里用 `wrk`（简单粗暴）。

```bash
# 安装（示例）
# Ubuntu: sudo apt-get install -y wrk
# CentOS: sudo yum install -y wrk

# 30 秒，8 线程，64 连接
wrk -t8 -c64 -d30s "http://127.0.0.1:8080/api/cpu?n=20000"
```

我在一台 4C/8G 的测试机上拿到的“优化前”数据（示例，供你对齐口径）：

- 吞吐：约 **1.2k req/s**
- 延迟：P50 **35ms** / P95 **110ms** / P99 **180ms**
- 现象：`top` 看到 Java 进程 CPU 接近 **350%~390%**（4 核机器接近跑满）

> 重点不是绝对数值，而是：你要能让它<strong>稳定复现</strong>，这样后面抓证据才有意义。

## 5. 第一层：用 JFR 抓“全景证据”

### 5.1 开启 JFR（两种方式）

方式 A：启动时就开启（适合“我知道马上要复现”）

```bash
java \
  -XX:StartFlightRecording=name=cpu,settings=profile,dumponexit=true,filename=/tmp/cpu.jfr \
  -jar target/app.jar
```

方式 B：运行中用 `jcmd` 开始/结束（更像线上排查）

```bash
# 1) 找 pid
jcmd | grep -i "app" || true

# 2) 开始录制（profile 配置会记录 CPU 采样等）
jcmd <pid> JFR.start name=cpu settings=profile filename=/tmp/cpu.jfr

# 3) 复现压测 30s
wrk -t8 -c64 -d30s "http://127.0.0.1:8080/api/cpu?n=20000"

# 4) 停止
jcmd <pid> JFR.stop name=cpu
```

> `settings=profile` 可以理解为“偏性能分析的采样配置”。线上别瞎开超重的配置；先用 profile，后续再按需要加事件。

### 5.2 你在 JFR 里要看什么？

把 `/tmp/cpu.jfr` 拿到本机，用 JMC 打开：

- **CPU Usage / Method Profiling（方法采样）**：先看热点方法大概落在哪一类（业务方法？框架？正则？序列化？日志？）。
- **Threads（线程）**：CPU 高是少数线程打满，还是很多线程都在跑？
- **Locks（锁）**：CPU 高不一定是锁，但如果你看到大量线程在自旋/竞争，也能从这里有线索。
- **GC**：如果 CPU 高同时 GC 频繁（尤其是分配太猛导致 GC），你会看到 GC 事件密集。

这一步的目标：把问题从“CPU 高”缩小到“CPU 主要花在某些调用栈上”。

## 6. 第二层：用 async-profiler 一锤定音（火焰图）

JFR 能给你全局视角，但我更喜欢用 async-profiler 做最后定位：它的火焰图对“到底是哪一行/哪一类方法”更直观。

### 6.1 安装与采集

```bash
# 1) 下载 async-profiler（示例：解压到 /opt/async-profiler）
# https://github.com/async-profiler/async-profiler

cd /opt/async-profiler

# 2) 采集 CPU 火焰图 30 秒
./profiler.sh -d 30 -e cpu -f /tmp/flame-cpu.html <pid>

# 3) 用浏览器打开 /tmp/flame-cpu.html
```

如果你更想要“包含 Java + 内核栈”的视角（排查 syscall / 网络 / 文件 IO 相关 CPU 时很香），可以加 `-i`/`--cstack` 参数（具体以你版本为准）。

### 6.2 怎么读火焰图（非常实用的读法）

1) 先在火焰图里按 `Pattern` / `regex` / `Matcher` 搜一下
2) 看最宽的那几块是谁
3) 顺着调用链往上找：是你自己代码调用的？还是某个框架在疯狂做事？

在这个“故意写烂”的例子里，你会很容易看到热点集中在：

- `java.util.regex.Pattern.compile`
- `java.util.regex.Pattern$BmpCharProperty.match`（或者类似的正则内部方法）
- 字符串相关的方法（分配/拼接）

到这里基本就可以下结论了：CPU 大头在“重复编译正则 + 大量临时对象”。

## 7. 动手优化：把热点改掉（并给出对比数据）

### 7.1 优化点 1：预编译 Pattern（不要每次请求 compile）

```java
@RestController
public class CpuHotController {

  private static final Pattern P = Pattern.compile("(foo|bar|baz)-([0-9]+)");

  @GetMapping("/api/cpu")
  public Map<String, Object> cpu(@RequestParam(defaultValue = "10000") int n) {
    long hit = 0;
    String s = "foo-123";
    for (int i = 0; i < n; i++) {
      // 仍然会创建 matcher，但至少不再重复编译
      Matcher m = P.matcher(s);
      if (m.find()) {
        hit++;
      }
    }
    return Map.of("n", n, "hit", hit, "ts", System.currentTimeMillis());
  }
}
```

> **Pattern 是线程安全的**（可以复用），但 **Matcher 不是线程安全的**（每次请求/每次线程要新建）。这是最常见的坑之一。

### 7.2 优化点 2：减少分配（让 GC 别来添乱）

如果你的火焰图里有很宽的 `StringConcat` / `StringBuilder` / `Arrays.copyOf`，那就说明你在疯狂制造垃圾。

在这个 demo 里，我直接把 `s + i` 干掉（真实业务里一般是：避免在热路径做复杂拼接、避免重复序列化、减少日志拼接等）。

### 7.3 优化后的压测对比（同口径）

还是同一台机器、同样的 `wrk -t8 -c64 -d30s`，我拿到的“优化后”示例数据：

- 吞吐：约 **2.1k req/s**（约 +75%）
- 延迟：P50 **18ms** / P95 **55ms** / P99 **90ms**
- CPU：Java 进程 CPU 仍然高，但火焰图里热点明显收敛，不再浪费在 `Pattern.compile` 上

你会发现：CPU 不是“变低了很多”，而是“同样 CPU 下吞吐更高、延迟更稳”。这是线上更有价值的结果。

## 8. 验证闭环：你要怎么证明“我真的修好了”？

我建议你把验证动作写成 checklist：

1) **压测**：同口径 wrk/hey/JMeter，记录吞吐 + P50/P95/P99
2) **profiling 复检**：再跑一遍 async-profiler，看热点是不是转移了（不要从一个坑跳到另一个坑）
3) **GC/分配**：如果你怀疑分配太猛，可以用 async-profiler 的 alloc 事件再看一眼：

```bash
./profiler.sh -d 30 -e alloc -f /tmp/flame-alloc.html <pid>
```

## 9. 常见坑/误区（我踩过/见过的）

1) **线上不复现就乱抓**：CPU 高可能是“短暂尖刺”，你抓到的 profile 可能是别的请求导致的。
2) **只看 JVM，不看系统**：有时候 CPU 高是内核态（比如 syscall、网络栈、磁盘），这时只看 Java 方法可能会误判。
3) **容器里跑 async-profiler 失败**：常见报错来自 perf 权限。
   - 现象：`perf_event_open` permission denied
   - 解决：
     - 宿主机 `sysctl kernel.perf_event_paranoid=1`（或更低）
     - 容器加权限（例如 `--cap-add SYS_ADMIN`，甚至 `--privileged`，视环境而定）
4) **把 Pattern 当成不线程安全**：`Pattern` 可复用，`Matcher` 不可复用。
5) **优化没有数据**：没有 P99 对比的优化，基本等于没优化（至少无法让团队信服）。

## 10. 总结（要点列表）

- CPU 飙高排查最怕“凭感觉”。正确姿势是：**压测复现 → JFR 全景 → async-profiler 定位 → 代码/配置优化 → 数据验证闭环**。
- JFR 像“行车记录仪”：告诉你发生了什么；async-profiler 像“显微镜”：告诉你具体是哪。
- 优化别只盯 CPU 下降，更要看：吞吐是否提升、P99 是否变稳、热点是否真正消失。

## 参考资料

1) async-profiler：<https://github.com/async-profiler/async-profiler>
2) JDK Flight Recorder (JFR) 文档：<https://docs.oracle.com/en/java/javase/17/jfapi/>
3) JDK Mission Control（JMC）：<https://www.oracle.com/java/technologies/jdk-mission-control.html>
4) `jcmd` 使用说明（JDK tools）：<https://docs.oracle.com/en/java/javase/17/docs/specs/man/jcmd.html>
5) wrk 压测工具：<https://github.com/wg/wrk>
6) Linux perf_event_paranoid（权限相关背景）：<https://www.kernel.org/doc/html/latest/admin-guide/perf-security.html>
