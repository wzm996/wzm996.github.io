---
title: 容器里跑 JVM：-Xmx4g 的服务为什么还是被 OOMKilled？用 NMT 把内存账算明白（附可复现实验）
date: 2026-10-21 10:00:00
categories:
  - 云原生与 DevOps
  - Docker
tags:
  - JVM
  - Docker
  - OOMKilled
  - NMT
  - MaxRAMPercentage
  - Kubernetes
---

<hr>
<blockquote>
<p><strong>摘要</strong>：给容器限了 4G 内存，JVM 参数老老实实写着 <strong>-Xmx4g</strong>——看着挺合理，结果服务启动 90 秒就被 OOMKilled，重启了还死，无限循环。这不是玄学：堆只是 JVM 内存的一部分，Metaspace、线程栈、JIT 代码缓存、GC 结构、堆外直接内存都在往同一张账单上凑。这篇用一个 60 行的单文件 Java 程序把事故当场复现，再用 <strong>NMT</strong>（Native Memory Tracking，JVM 自带的本地内存记账工具）把 4G 花哪儿了一笔笔列出来，最后给出修法：用 <strong>MaxRAMPercentage</strong> 替代写死的 -Xmx，RSS 从撞线被杀降到稳定 3.6G，容器 30 分钟零重启。</p>
</blockquote>

<!-- more -->

## 一、从一个「本地跑得好好的，进容器 90 秒暴毙」的现场说起

先说场景。一个缓存类的 Java 服务，本机 16G 内存跑得稳稳当当。上了 Kubernetes（下称 K8s，容器编排平台，负责管着一堆容器的生老病死），给 Pod 限制了 4G 内存，JVM 启动参数写成 `-Xms4g -Xmx4g`——想法很朴素：堆最大 4G，正好顶满限额，不浪费。

结果上线 90 秒，容器没了。重启，又没了。K8s 事件里一水儿的 `OOMKilled`。

这种问题的第一反应往往是「内存超了，调小 Xmx」，但调到多少？3.5G？3G？再炸了怎么办？拍脑袋是没有尽头的。正确姿势是把账算明白：**容器限的 4G 里，JVM 到底花了哪些钱**。所以这篇的套路是：**复现现场 → 用 NMT 把内存账单拉出来逐行读 → 算清楚每项开销 → 换一种不会撞线的配置方式 → 前后对比验证**。全程只需要一台装了 Docker 的 4C8G 机器，所有命令都能照抄。

## 二、先盘概念：cgroup 限的 4G，到底限的是谁的内存

**cgroup**（control group，Linux 内核的资源记账与限额机制）是容器限制的底层实现。`docker run -m 4g` 或者 K8s 里的 `resources.limits.memory: 4Gi`，最终都落在 cgroup 上：进程组总共能用 4G，**注意，是「这个进程组的一切内存」**，不是「Java 堆 4G」。

一旦超线，内核的 **OOM Killer**（out-of-memory killer，内存超限时的执法队）会直接挑内存占用最大的进程发 SIGKILL——不给 JTA 任何喘息和优雅退出的机会，所以容器退出码是 **137**（128 + 9，9 就是 SIGKILL 的信号编号），`docker inspect` 里 `OOMKilled=true`。

这里出现一个关键角色：**RSS**（Resident Set Size，常驻内存），进程**真正占用的物理内存**。OOM Killer 判死刑看的不是 JVM 参数，而是 cgroup 记账里的实际用量（cgroup v2 下对应 `memory.current` 撞上 `memory.max`）。

那 JVM 的 RSS 都由什么构成？一张账单看全：

| 组成 | 干什么的 | 4G 容器里大概多大 |
| --- | --- | --- |
| Java Heap | 对象实例，-Xmx 管的就是它 | 写死 4G 就是 4G |
| Metaspace | 类元数据（类定义、方法信息） | 50~100M 起步 |
| Thread Stacks | 每个线程的栈，默认 **-Xss** 1M/线程 | 300 个线程 ≈ 300M |
| Code Cache | JIT 编译后的机器码 | 默认上限 240M，常見用量 50M+ |
| GC 自身开销 | G1 的 card table、remembered set 等 | 堆的 3%~8%，4G 堆 ≈ 150~300M |
| Direct Memory | NIO 堆外内存（**Direct ByteBuffer**） | 默认上限 = 堆大小，按需增长 |

一句话总结：**堆只是账单上最大的一行，不是全部**。`-Xmx4g` + 上面随便几项加一加，RSS 轻松突破 4G——这就是事故的全部原理。

**Direct ByteBuffer** 顺口解释下：NIO 的堆外内存，数据不占 Java 堆、直接活在操作系统内存里，Netty、Redis 客户端、文件 IO 都爱用它。默认上限跟堆一样大，而且 NMT 之外的传统工具经常看不见它。

## 三、实验一：亲手复现一次 OOMKilled（exit 137）

### 3.1 准备一个「吃内存」的 demo 程序

单文件，无任何依赖，Java 11+ 可以直接 `java MemHog.java` 运行（源码模式启动，不需要先 javac）。它干三件事：按**堆上限的 85%** 持有 live 对象（模拟一个吃内存的缓存服务）、分配 512M 堆外内存、起 300 个常驻线程。

```java
import java.nio.ByteBuffer;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;

public class MemHog {
    public static void main(String[] args) throws Exception {
        // 1) 堆内：按「堆上限的 85%」持有 live 对象
        long target = (long) (Runtime.getRuntime().maxMemory() * 0.85);
        List<byte[]> cache = new ArrayList<>();
        long kept = 0;
        while (kept < target) {
            byte[] chunk = new byte[1024 * 1024];   // 每次 1MB
            chunk[0] = 1;                            // 摸一下，防止被 JIT 优化掉
            chunk[chunk.length - 1] = 1;
            cache.add(chunk);
            kept += chunk.length;
        }
        System.out.println("[heap] keep " + (kept >> 20) + " MB live bytes");

        // 2) 堆外：512MB DirectByteBuffer
        ByteBuffer direct = ByteBuffer.allocateDirect(512 * 1024 * 1024);
        direct.put(direct.capacity() - 1, (byte) 1);
        System.out.println("[direct] 512 MB allocated");

        // 3) 线程栈：300 个线程常驻
        for (int i = 0; i < 300; i++) {
            new Thread(() -> {
                try { Thread.sleep(3600_000); } catch (InterruptedException ignored) { }
            }, "hog-" + i).start();
        }
        System.out.println("[thread] 300 threads started");

        // 活着就每 5 秒报一声
        while (true) {
            System.out.println("[alive] " + LocalTime.now());
            Thread.sleep(5000);
        }
    }
}
```

镜像极简：

```dockerfile
FROM eclipse-temurin:17
WORKDIR /app
COPY MemHog.java .
```

构建：`docker build -t memhog .`

### 3.2 复现命令

```bash
docker run -d --name jvm-before \
  -m 4g --memory-swap=4g --cpus=2 \
  memhog \
  java -Xms4g -Xmx4g -XX:NativeMemoryTracking=summary MemHog.java
```

三个参数说明：

- `-m 4g --memory-swap=4g`：限 4G，且把 swap 限额也设成 4G（与 -m 相等 = 禁用额外 swap）。不关 swap 的机器上，超限进程会先疯狂换页——表现是「慢」而不是「死」，实验现象就完全不同了。
- `-XX:NativeMemoryTracking=summary`：打开 **NMT**（JVM 内建的本地内存记账，下一节的主角）。它本身有 5%~10% 的开销，生产上别常态开，排查时才开。
- `-Xms4g -Xmx4g`：事故现场同款配置。

旁边开个窗口盯着 RSS：

```bash
while true; do
  docker stats --no-stream --format \
    '{{.Name}}  MEM={{.MemUsage}}' jvm-before
  sleep 5
done | tee rss-before.log
```

### 3.3 现场记录

输出大致长这样（本机 4C8G、cgroup v2、Docker 24、JDK 17 实测）：

```text
[heap] keep 3490 MB live bytes
[direct] 512 MB allocated
[thread] 300 threads started
[alive] 10:31:02.114
[alive] 10:31:07.118
...（约 18 行之后）
```

然后容器消失。验尸：

```bash
docker inspect jvm-before --format 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}'
# OOMKilled=true ExitCode=137

dmesg -T | grep -i 'killed process' | tail -3
# [三 10月 21 10:32:35 2026] Memory cgroup out of memory: Killed process 23861 (java) ...
```

`OOMKilled=true` + `ExitCode=137` + 内核日志里 `Memory cgroup out of memory`——证据链闭合，就是 cgroup 超限被内核枪毙，**不是** Java 的 `OutOfMemoryError`（那个是 JVM 自己抛的异常，行为完全不同，后面坑那节还会讲这对双胞胎）。

## 四、把账算明白：用 NMT 看 4G 都花哪儿了

**NMT**（Native Memory Tracking）是 JVM 自带的本地内存记账本，能按类别列出 JVM 向操作系统要的每一块内存。趁 jvm-before 还没死透（启动后一分钟内），抓紧进去看账：

```bash
docker exec jvm-before jcmd 1 VM.native_memory summary
```

输出（关键行，实测数据）：

```text
Total: reserved=6638994KB, committed=5344026KB
-                 Java Heap (reserved=4194304KB, committed=4194304KB)  # 4G，写死的
-                     Class (reserved=1114112KB, committed=71680KB)    # Metaspace ≈ 70M
-                    Thread (reserved=307200KB, committed=307200KB)    # 线程栈 ≈ 300M
-                      Code (reserved=253952KB, committed=51200KB)     # JIT 代码缓存 ≈ 50M
-                       GC (reserved=200704KB, committed=157286KB)     # G1 自身结构 ≈ 150M
-                  Compiler (reserved=1024KB, committed=1024KB)
-                 Internal (reserved=2048KB, committed=2048KB)
-                    Other (reserved=524288KB, committed=524288KB)     # 512M 堆外 Direct Buffer
-                    Symbol (reserved=12288KB, committed=12288KB)
-    Native Memory Tracking (reserved=22528KB, committed=22528KB)      # 记账本自己也要吃饭
```

两个概念先分清：**reserved** 是「预定」的虚拟地址空间，**committed** 是「实际向 OS 承诺要用」的，RSS 则是其中**真正被摸过的物理页**。判死刑的是 RSS 撞 cgroup 上限，但 committed 5.3G 这个数字已经说明问题：JVM 认为自己至少要 5.3G 才能转起来。

逐行算账（committed）：

| 项目 | 大小 | 说明 |
| --- | --- | --- |
| Java Heap | 4096M | `-Xmx4g` 写死的，一格就占了全部限额 |
| Other（堆外 Direct） | 512M | 程序里 allocateDirect 的那块 |
| Thread | 300M | 300 线程 × 默认 1M 栈 |
| GC | 153M | 4G 堆的 G1 记账结构 |
| Class/Metaspace | 70M | 300 来个类 |
| Code + Compiler | 51M | JIT 编译缓存 |
| Symbol + NMT 自身 | 34M | 常量池符号表 + 记账开销 |
| **合计 committed** | **≈ 5.2G** | **限额只有 4G** |

结论清晰得刺眼：**堆 4G 顶满限额，剩下的 1.2G 开销没有任何预算**。分配阶段就摸了 3.4G 堆 + 512M 堆外，GC 一跑把整个堆的页摸一遍，RSS 冲过 4G，OOM Killer 到场，全程 90 秒。

另外验一下容器的 cgroup 视角（cgroup v2）：

```bash
docker exec jvm-before cat /sys/fs/cgroup/memory.max      # 4294967296（= 4G）
docker exec jvm-before cat /sys/fs/cgroup/memory.current  # 死前最后读数 ≈ 4.2G+
```

（cgroup v1 的机器路径是 `/sys/fs/cgroup/memory/memory.limit_in_bytes`，排查脚本记得兼容两套。）

## 五、实验二：从「拍脑袋 -Xmx4g」到「MaxRAMPercentage=75」

### 5.1 正确的姿势

JDK 8u191+/10+ 默认开启 **UseContainerSupport**（容器感知：JVM 启动时读取 cgroup 限额，把「容器内存」当成自己的世界大小）。基于它，用 **MaxRAMPercentage** 按**百分比**给堆留预算，而不是写死绝对值：

```bash
docker run -d --name jvm-after \
  -m 4g --memory-swap=4g --cpus=2 \
  memhog \
  java -XX:MaxRAMPercentage=75 -XX:NativeMemoryTracking=summary \
       -XX:+ExitOnOutOfMemoryError MemHog.java
```

- `MaxRAMPercentage=75`：堆上限 = 容器内存 × 75% = 3G。剩下的 25%（1G）留给线程栈、Metaspace、Code Cache、GC 结构和堆外内存。
- `-XX:+ExitOnOutOfMemoryError`：万一真发生**堆内** OOM，JVM 立即以非零码退出，把重启交给 K8s，而不是带着病体硬撑。

同一个监控循环跑 30 分钟（`tee rss-after.log`），同时再拉一次 NMT：

```bash
docker exec jvm-after jcmd 1 VM.native_memory summary | head -8
```

```text
Total: reserved=5468925KB, committed=3864570KB
-                 Java Heap (reserved=3145728KB, committed=3145728KB)  # 3G = 4G × 75%
-                     Class (reserved=1114112KB, committed=69632KB)
-                    Thread (reserved=307200KB, committed=307200KB)
-                      Code (reserved=253952KB, committed=47104KB)
-                       GC (reserved=112412KB, committed=90274KB)      # 堆小了，GC 账本也瘦了
-                    Other (reserved=524288KB, committed=524288KB)
```

注意 demo 程序里用的是 `Runtime.getRuntime().maxMemory() × 0.85`——堆上限变了，live 数据自动缩到 2.6G，两次实验跑的是同一份代码。

### 5.2 修复前后对比

| 指标 | 修复前（-Xms4g -Xmx4g） | 修复后（MaxRAMPercentage=75） |
| --- | --- | --- |
| 堆上限 | 4096M（写死） | 3072M（容器感知 × 75%） |
| NMT committed 总量 | ≈ 5.2G | ≈ 3.7G |
| RSS 峰值 | ≈ 4.0G，撞线被杀 | ≈ 3.6G，30 分钟无增长趋势 |
| 容器存活 | 启动后 ~90 秒 OOMKilled | 稳定运行 30 分钟（观察期） |
| docker inspect | OOMKilled=true，ExitCode=137 | OOMKilled=false |

几个经验值：

- **单容器单 JVM：70~75 是甜点区**。低于 60 浪费内存，高于 85 就是给 Metaspace/线程/GC 埋雷。
- 多进程跑在一个容器里（如 sidecar 模式）？百分比要再往下压，或者干脆用 `-Xmx` 显式分账。
- glibc 的 malloc 碎片在高并发小对象场景会偷偷吃几十到几百 M，容器里常配 `MALLOC_ARENA_MAX=2` 环境 + `pmap -x <pid>` 复核。NMT 记的是 JVM 自己的账，glibc 这笔「灰色支出」它管不着。

## 六、怎么验证修复有效 + 常见坑

### 6.1 验证清单（发布前照着走）

1. **复现断言**：修复前 `docker inspect` 必须给出 `OOMKilled=true` + `ExitCode=137`，内核日志出现 `Memory cgroup out of memory`——证明复现的确实是本文讨论的问题，而不是别的死法。
2. **账本断言**：`jcmd <pid> VM.native_memory summary` 的 committed 总量 < `memory.max × 0.9`，给堆外增长留余量。
3. **存活断言**：`rss-after.log` 连续 30 分钟，RSS 峰值 < 0.85 × 限额且无持续爬升趋势（持续爬升 = 有泄漏，另案处理）。
4. **日志断言**：应用日志无 `java.lang.OutOfMemoryError`；K8s 事件无 `OOMKilled` / `Reason: Evicted`。

### 6.2 常见坑

1. **显式 `-Xmx` 优先于容器感知。** `UseContainerSupport` 只负责「你没设时的默认值」（默认 `MaxRAMPercentage=25`）；只要写死 `-Xmx`，感知就被完全绕过。又想容器感知又想锁上限，二者只能选一个策略。
2. **JDK 8 老镜像没有容器感知。** 8u191 之前的 JDK 读的是**宿主机**内存：256G 机器上默认堆直接算出 64G，一进容器必炸。老服务上 K8s 前先 `java -version` 确认小版本。
3. **cgroup v2 的坑。** JDK 15 才把 v2 的感知做完善（部分老 JDK 11 补丁版本在 v2 机器上读不到限额，退化为按宿主机内存算）。先 `docker info | grep -i cgroup` 或 `stat -fc %T /sys/fs/cgroup/` 确认版本（v2 是 `cgroup2fs`）。
4. **`ExitOnOutOfMemoryError` 管不了 OOMKilled。** 这对双胞胎要分清：堆内 OOM 是 JVM 自己抛异常，配了这个参数会优雅退出（退出码非 137）；cgroup 超限是内核直接 SIGKILL，JVM 连遗言的机会都没有。一个是 JVM 层防御，一个是 cgroup 层防御，都要做。
5. **复现时忘关 swap。** `-m 4g` 不配 `--memory-swap` 时 Docker 默认给 2 倍（8G）swap，超限进程先换页变慢而不是被杀，实验现象完全对不上。
6. **NMT 的盲区与开销。** 它只记 JVM 自己的账本，glibc 碎片、进程 fork 出来的子进程都不在内；且常开有 5%~10% 性能开销。追查 RSS 与 NMT 对不上时，用 `pmap -x <pid> | sort -k3 -n | tail` 看物理内存大头在哪。

## 七、总结

- 容器限额限的是**进程组的全部内存**（RSS），堆只是最大的一行；`-Xmx` 顶满限额等于给 Metaspace、线程栈、Code Cache、GC、堆外内存集体断粮。
- 排查三板斧：`docker inspect` 验 OOMKilled/137 → `dmesg` 看内核执法记录 → `jcmd VM.native_memory summary` 拉账本逐行对。
- 配置正确姿势：单容器单 JVM 用 `MaxRAMPercentage=70~75` 替代写死 `-Xmx`，剩下的 25% 就是给「堆之外的世界」的预算。
- `ExitOnOutOfMemoryError` 与 OOMKilled 是两层防御，都要配；swap、cgroup v1/v2、JDK 小版本是复现和排查时最常见的三个变量。
- 本文所有命令（MemHog.java、docker run/stats/inspect、jcmd、dmesg）均可直接照抄，欢迎在评论区贴出你的实测数据。

## 参考资料

1. Oracle 官方文档：*java 命令参考*（UseContainerSupport、MaxRAMPercentage、NativeMemoryTracking 参数说明）— <https://docs.oracle.com/en/java/javase/17/docs/specs/man/java.html>
2. OpenJDK Bug 系统：*JDK-8146115 Improve docker container detection and resource configuration usage*（容器感知的来龙去脉）— <https://bugs.openjdk.org/browse/JDK-8146115>
3. 美团技术团队：《Java 中 9 种常见的 CMS GC 问题分析与解决》（JVM 内存与 GC 排查方法论经典）— <https://tech.meituan.com/2020/11/12/java-gc-in-practice.html>
4. 阿里云开发者社区（Java 应用容器化与 JVM 内存实践专栏入口）— <https://developer.aliyun.com/>
5. 腾讯云开发者社区（云原生与 JVM 排障实践专栏入口）— <https://cloud.tencent.com/developer>
