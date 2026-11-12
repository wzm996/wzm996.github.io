---
title: 深入理解 ThreadLocal：线程池里忘了 remove，100 个线程怎么“偷”走 100MB 堆内存（附 jmap 实测复现）
date: 2026-11-12 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - ThreadLocal
  - JVM
  - 内存泄漏
  - jmap
  - 线程池
---

<hr>
<blockquote>
<p><strong>ThreadLocal</strong> 是 Java 里“每个线程一个小柜子”的隐形变量储物间，但在<strong>线程池</strong>里，线程不死、柜子不清，塞进去的 1MB 大对象就能一直赖在堆里不走。本文用 100 个线程实测复现：任务早跑完了、GC 也做了，不调 remove() 的堆在 Full GC 后还剩 201MB；加一行 <code>BUF.remove()</code>，只剩 1MB。附完整可复现代码、jmap/jcmd 取证命令与 GC 日志解读。</p>
</blockquote>

<!-- more -->

## 一、背景：任务早就跑完了，内存为什么不还？

先说一个特别常见的写法：为了少分配、提速，很多服务会把大缓冲区塞进 **ThreadLocal**。

> **ThreadLocal** 是什么：一个“按线程隔离”的变量容器。同一个变量，线程 A set 的值线程 B 看不到，各自访问各自那份。典型用途：给每个工作线程缓存一个 SimpleDateFormat、一个 1MB 的序列化缓冲区、一个数据库连接上下文，避免反复 new 和加锁。

单线程跑批、线程用完就销毁的场景下，这个写法没问题。但生产环境几乎都是**线程池**：

> **线程池** 是什么：提前创建一批工作线程反复复用，任务来了领一个线程执行，执行完线程回到池子里待命，而不是销毁。它解决的是“线程创建/销毁太贵”的问题。

于是问题来了：**任务结束了，但线程还活着**。任务期间塞进 ThreadLocal 的 1MB 缓冲区，引用还挂在活着的线程身上，GC 想收也收不走。100 个线程 × 1MB = 100MB，就这么“消失”在监控里——堆 water mark 下不来、Full GC 后 used 居高不下，严重时直接 OOM。

这篇文章就把这件事**当场复现**给你看：代码、命令、GC 日志、jmap 输出，全部真实跑过。

## 二、5 分钟原理：值到底挂在谁的引用链上

要看懂这个泄漏，只需要弄清一条引用链。`Thread` 对象内部有一个字段 `threadLocals`，指向一个 **ThreadLocalMap**：

> **ThreadLocalMap** 是什么：Thread 类内部专用的散列表，key 是 ThreadLocal 对象本身，value 是你 set 进去的值。每个线程一个，线程私有。

> **Entry** 是什么：ThreadLocalMap 里的键值对节点。它有个关键设计——**Entry 继承了 WeakReference（弱引用），key 是对 ThreadLocal 的弱引用，但 value 是普通强引用**。

> **弱引用（WeakReference）** 是什么：一种“不妨碍回收”的引用。只要对象除了弱引用没有别的强引用可达，下次 GC 就会把它回收，弱引用自动变 null。

引用链画出来是这样的（ASCII 版）：

```text
Thread（线程池里的工作线程，常年存活）
 └── Thread.threadLocals: ThreadLocalMap          ← 强引用
      └── table[i]: Entry                          ← 强引用
           ├── key  → ThreadLocal 对象（弱引用）
           └── value → byte[1MB] 缓冲区（强引用！）  ← 元凶在这
```

两个关键推论：

1. **value 是强引用**。只要线程活着、Entry 还在 table 里，GC 永远收不走这个 1MB。弱引用救的是 key，不是 value。
2. **线程不死，链不断**。线程池的核心线程生命周期 = 服务进程生命周期。任务“结束”只是回到池子待命，ThreadLocalMap 原封不动。

所以“内存泄漏”的准确说法是：**这些值会一直存活到线程死亡为止**。线程池恰恰让线程几乎永不死亡。

注：如果 key（ThreadLocal 本身）已经没有任何强引用了，GC 后 key 变 null，这种 Entry 叫**陈旧条目（stale entry）**。ThreadLocalMap 在后续 set/get/remove 时会顺手做**探测式清理（expungeStaleEntry）**，把 key 为 null 的 Entry 连同 value 一起清掉——但这是“机会主义”的：如果这个线程再也不碰 ThreadLocal，清理永远不会发生，value 照样卡死。

## 三、实测复现：100 个线程怎么“偷”走 100MB

### 3.1 实验设计

- 100 个核心线程的池子，用 `CyclicBarrier` 强制 100 个线程**全部起齐**（保证每个线程都摸过一遍 BUF）；
- 每个线程 `BUF.get()` 拿一个 `byte[1MB]` 并真实写入一个字节（防止数组被优化掉）；
- **不调 `pool.shutdown()`**，模拟生产常态：任务跑完，线程池继续活着；
- 泄漏组（leak）：任务里不 remove；对照组（clean）：任务里 `BUF.remove()`；
- 之后手动 `System.gc()` 两次，看 Full GC 之后还剩多少。

> **CyclicBarrier** 是什么：一组线程互相等栅栏，全部到齐了一起放行。这里用它保证 100 个任务分摊在 100 个不同线程上，而不是挤在少数几个线程里。

环境：OpenJDK 11.0.13，G1（默认收集器），`-Xms256m -Xmx256m`，4 核 2GB 内存云主机。

### 3.2 完整代码（可直接复制运行）

```java
import java.util.*;
import java.util.concurrent.*;
import java.lang.reflect.*;

public class LeakDemo {
    static final int MB = 1024 * 1024;
    // 模拟业务：每个池化线程用 ThreadLocal 缓存 1MB 工作缓冲区
    private static final ThreadLocal<byte[]> BUF =
            ThreadLocal.withInitial(() -> new byte[MB]);
    static final List<Thread> POOL_THREADS = new CopyOnWriteArrayList<>();

    // 自检工具：反射遍历每个存活线程的 ThreadLocalMap，统计 byte[] value
    static long[] retained() throws Exception {
        long total = 0; int entries = 0;
        Field f = Thread.class.getDeclaredField("threadLocals");
        f.setAccessible(true);
        for (Thread t : POOL_THREADS) {
            Object map = f.get(t);
            if (map == null) continue;
            Field tableF = map.getClass().getDeclaredField("table");
            tableF.setAccessible(true);
            Object[] table = (Object[]) tableF.get(map);
            for (Object e : table) {
                if (e == null) continue;
                Field valueF = e.getClass().getDeclaredField("value");
                valueF.setAccessible(true);
                Object v = valueF.get(e);
                if (v instanceof byte[]) {
                    total += ((byte[]) v).length;
                    entries++;
                }
            }
        }
        return new long[]{entries, total / MB};
    }

    public static void main(String[] args) throws Exception {
        boolean clean = args.length > 0 && args[0].equals("clean");
        int n = 100;
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CyclicBarrier barrier = new CyclicBarrier(n);
        CountDownLatch done = new CountDownLatch(n);
        for (int i = 0; i < n; i++) {
            pool.execute(() -> {
                POOL_THREADS.add(Thread.currentThread());
                try {
                    barrier.await();          // 强制 100 个线程全部起齐
                    byte[] buf = BUF.get();   // 每个线程领一个 1MB 缓冲区
                    buf[0] = 1;               // 真实写入，确保数组确实分配
                    if (clean) BUF.remove();  // 对照组：用完就删
                } catch (Throwable ignored) {
                } finally {
                    done.countDown();
                }
            });
        }
        done.await();
        // 注意：这里故意不调 pool.shutdown()，线程池保持存活（生产上的常态）
        Runtime rt = Runtime.getRuntime();
        long[] r1 = retained();
        System.out.println("mode=" + (clean ? "clean(remove-after-use)" : "leak(no-remove)"));
        System.out.println("alivePoolThreads=" + POOL_THREADS.size()
                + " entriesWithByteArray=" + r1[0]
                + " threadLocalRetainedBytes=" + r1[1] + "MB");
        System.gc(); Thread.sleep(1500);
        System.gc(); Thread.sleep(1500);
        System.out.println("usedHeapAfterFullGC=" + (rt.totalMemory() - rt.freeMemory()) / MB + "MB");
        long[] r2 = retained();
        System.out.println("afterGC entriesWithByteArray=" + r2[0]
                + " threadLocalRetainedBytes=" + r2[1] + "MB");
        if (args.length > 1 && args[1].equals("hold")) Thread.sleep(30000);
        pool.shutdown();
    }
}
```

注：反射部分在 JDK 11 会打 `illegal reflective access` 警告，可忽略；JDK 16+ 需要加 `--add-opens java.base/java.lang=ALL-UNNAMED` 才能跑通自检（不加的话把反射那段删掉，不影响主实验）。

### 3.3 运行命令

```bash
javac LeakDemo.java

# 对照组：任务里 remove
java -Xms256m -Xmx256m -Xlog:gc:gc-clean.log LeakDemo clean

# 泄漏组：任务里不 remove，hold 30 秒供 jmap 取证
java -Xms256m -Xmx256m -Xlog:gc:gc-leak.log LeakDemo leak hold &
# 另开终端（或 sleep 10 秒后）：
jcmd <pid> GC.heap_info
jmap -histo:live <pid> | grep -iE '\[B|threadlocal'
```

### 3.4 实测结果（真实数据）

对照组（clean）：

```text
mode=clean(remove-after-use)
alivePoolThreads=100 entriesWithByteArray=0 threadLocalRetainedBytes=0MB
usedHeapAfterFullGC=1MB
afterGC entriesWithByteArray=0 threadLocalRetainedBytes=0MB
```

泄漏组（leak）：

```text
mode=leak(no-remove)
alivePoolThreads=100 entriesWithByteArray=100 threadLocalRetainedBytes=100MB
usedHeapAfterFullGC=201MB
afterGC entriesWithByteArray=100 threadLocalRetainedBytes=100MB
```

两次 Full GC 之后，差距是 **201MB vs 1MB**。那 100MB 死死钉在堆上——GC 日志也证实了这一点（来自 gc-leak.log）：

```text
[0.253s][info][gc] GC(1) Pause Full (System.gc()) 226M->201M(256M) 4.036ms
[1.756s][info][gc] GC(2) Pause Full (System.gc()) 201M->201M(256M) 2.571ms
```

两次 Full GC，第二次完全压不动：`201M->201M`。这 100MB 是**强可达**的，不是碎片、不是浮动垃圾。

## 四、取证：用 jmap/jcmd 把“凶手”点名

### 4.1 jcmd GC.heap_info：看整堆水位

在泄漏组 hold 的 30 秒里执行 `jcmd <pid> GC.heap_info`：

```text
 garbage-first heap   total 262144K, used 206089K [0x...]
  region size 1024K, 1 young (1024K), 0 survivors (0K)
 Metaspace       used 928K, capacity 4755K, committed 4864K, reserved 1056768K
```

> **jcmd / jmap** 是什么：JDK 自带的诊断命令行工具。jcmd 能打印堆概况、触发 GC、做线程 dump；jmap 能输出类直方图和堆转储。排查线上内存问题必会，不用装任何东西。

256MB 的堆，Full GC 后 used 还有 206MB（约 80%）——Young 区只剩 1 个 region，说明老年代塞满了“收不走”的东西。

### 4.2 jmap -histo:live：看是谁占的

`jmap -histo:live <pid>` 会先触发一次 **Heap Inspection Initiated GC**（强制 Full GC），然后只统计活对象：

```text
 num     #instances         #bytes  class name
   1:          7684      105200200  [B          ← byte[]，约 100MB，第一名
   2:          7451         178824  java.lang.String
   3:          1405         172568  java.lang.Class
  ...
  24:           101           8080  [Ljava.lang.ThreadLocal$ThreadLocalMap$Entry;
  43:           102           3264  java.lang.ThreadLocal$ThreadLocalMap$Entry
  48:           101           2424  java.lang.ThreadLocal$ThreadLocalMap
```

> **`[B`** 是什么：JVM 里基本类型数组的内部类名，`[B` 就是 `byte[]`，`[C` 是 char[]，`[Ljava.lang.String;` 是 String 数组。看类直方图时先认这几个符号。

证据链完整：

- `Entry` 实例 102 个 ≈ 100 个池化线程各 1 个 + 主线程等杂项；
- `byte[]` 占 105,200,200 字节 ≈ 100.3MB = 100 × 1MB（外加少量杂项数组）；
- 每个线程的 map 里只有这 1 个 Entry，value 正是那 1MB 缓冲区。

**谁占的、挂在哪、为什么收不走，三问全有答案。** 排查线上问题时，`jmap -histo:live` 里 `[B`/`[C` 高居榜首、且 Entry/ThreadLocalMap 数量与线程数同量级，基本就是这类问题。

## 五、结论与数据对比

| 指标（100 线程 × 1MB，Full GC 后） | 不 remove（泄漏组） | remove（对照组） |
|---|---|---|
| 存活池化线程 | 100 | 100 |
| 带 byte[] 的 ThreadLocalMap.Entry | 100 | 0 |
| ThreadLocal 持有的字节 | 100MB | 0MB |
| Full GC 后堆 used（-Xmx256m） | 201MB（约 80%） | 1MB（约 0.4%） |
| GC 能否回收这 100MB | 否（两次 Full GC 201M->201M） | 是 |

换算成生产语言：**泄漏组白白吃掉 39% 的最大堆**。在 8GB 堆的服务上按比例放大就是 3GB+ 的“幽灵占用”，直接后果是 Full GC 更频繁、老年代水位虚高，最终 OOM 时 heap dump 里一堆 `ThreadLocalMap$Entry`。

## 六、一个反直觉的彩蛋：线程一死，泄漏消失

这个实验还有个插曲：我第一版代码在任务结束后先调了 `pool.shutdown()` 再测——结果泄漏组 Full GC 后只剩 **1MB**，100MB 无影无踪。

原因：`newFixedThreadPool` 的池子一旦 `shutdown()` 且队列为空，**空闲的工作线程会陆续退出**（不是常驻）。线程一死，`Thread.exit()` 会把 `threadLocals` 字段置 null，整张 map 连同 100 个 1MB 一起变垃圾，一次 GC 全收走。

这个“翻车”恰好把机制讲透了：

- **ThreadLocal 泄漏的本质是“值跟着线程活”**。线程活多久，value 就活多久；
- 所以同一个代码，在“线程用完即弃”的场景不泄漏，挪到线程池就泄漏。**问题从来不在 ThreadLocal，在线程的生命周期**；
- 反过来，排查时也可以利用这点：怀疑 ThreadLocal 泄漏，先看嫌疑线程是不是池化长命线程。

## 七、常见坑 / 误区

**坑 1：以为“key 是弱引用，所以不会泄漏”。**
弱引用保护的只是 key。key 被 GC 变 null 后，value 还被 Entry 强引用着；而且探测式清理只在同一个线程后续再碰 ThreadLocal 时顺手触发。线程再也不碰 → value 永远在。别拿弱引用当免死金牌。

**坑 2：以为“任务结束了，对象就没引用了”。**
任务结束只是代码走完了。value 挂在活着的线程身上，跟任务没关系。判断泄漏别看任务生命周期，要看**引用链的根（GC Roots 可达路径）**：Thread → map → Entry → value。

**坑 3：在线程池里用 ThreadLocal 传“请求上下文”，忘了 remove。**
这除了泄漏，还有更危险的**脏读**：上个请求 set 的用户身份，被下个请求读走。正确姿势是 `try { ... } finally { TL.remove(); }`；跨线程传递上下文用 **TransmittableThreadLocal（TTL）**——阿里巴巴开源的库，解决“线程池复用线程导致上下文丢失/串用”的问题，配合 `TtlExecutors` 包装线程池使用。

**坑 4：每个请求 new 一个 ThreadLocal。**
ThreadLocal 本身该是 `static final` 单例。每次请求 new 一个，key 会随请求对象一起变垃圾——听起来“自然解决”？实际是：这些 Entry 变成 stale entry 后 value 依然被强引用，要等那个线程恰好再碰 ThreadLocal 才可能被清理。高并发下就是一堆悬空 value + map 无限膨胀。

**坑 5：InheritableThreadLocal + 线程池 = 上下文错乱。**
> **InheritableThreadLocal** 是什么：子线程创建时会复制父线程的 ThreadLocal 值的变体，用于“父子线程传值”。

线程池的线程是提前建好的，继承的是**池子初始化时**那个线程的值，不是提交任务线程的值——复制时机完全错位。要传上下文还是用 TTL。

**坑 6：JDK 21 虚拟线程 + ThreadLocal，成本会被放大。**
虚拟线程是“任务级”的，一百万个任务就可能有一百万份 ThreadLocal 副本和 map 结构，单份不贵、总量惊人。虚拟线程的官方建议就是少用 ThreadLocal 装重对象（JDK 21 里 preview 的 **ScopedValue**——作用域受限、不可变、自动随作用域消失——就是给这个场景准备的替代品）。历史上 Netty 的 **FastThreadLocal** 也是同一个思路的工程化优化：用数组下标代替 hash 探测，快且规整。

**坑 7（正确姿势清单）：**
- ThreadLocal 一律 `private static final` 修饰，全进程一份；
- `set` 之后必须有对应的 `remove`，和锁的 lock/unlock 一样成对出现，写在 `finally` 里；
- 禁止用 ThreadLocal 在池化线程间隐式传上下文，跨线程用 TTL；
- 监控上盯两个信号：`jmap -histo:live` 里 `[B` 异常大、`ThreadLocalMap$Entry` 数量与线程数同量级且 value 不明。

## 八、总结

- ThreadLocalMap 的 **value 是强引用**：线程不死，值不亡；弱引用只救 key，不救 value；
- 线程池让线程生命周期 ≈ 进程生命周期，任务级 set 不 remove 就等于永久泄漏；
- 实测：100 线程 × 1MB，不 remove 时 Full GC 后堆 201MB（收不动，`201M->201M`），remove 后只剩 1MB；
- 取证三板斧：`jcmd GC.heap_info` 看水位 → `jmap -histo:live` 点名元凶 → GC 日志确认“Full GC 压不动”；
- 记住那个彩蛋：`shutdown()` 后泄漏消失不是 bug 修好了，是线程死了——**泄漏范围 = 线程生命周期**；
- 用法口诀：**static final 修饰、set/remove 成对、跨线程用 TTL、虚拟线程少装重物。**

## 参考资料

1. OpenJDK 官方文档：ThreadLocal（Java SE 11）—— <https://docs.oracle.com/en/java/javase/11/docs/api/java.base/java/lang/ThreadLocal.html>
2. OpenJDK 源码：ThreadLocal.java / ThreadLocalMap 实现（含 expungeStaleEntry 清理逻辑）—— <https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/lang/ThreadLocal.java>
3. 阿里巴巴《Java 开发手册》（嵩山版）：强制规定 ThreadLocal 必须在线程池场景 remove（P3C 仓库内附手册）—— <https://github.com/alibaba/p3c>
4. 阿里巴巴 TransmittableThreadLocal（TTL）：线程池上下文传递方案 —— <https://github.com/alibaba/transmittable-thread-local>
5. 周志明《深入理解 Java 虚拟机（第 3 版）》第 2、3 章：GC Roots、四种引用与内存泄漏判定
6. Baeldung：Guide to ThreadLocal in Java（结构参考）—— <https://www.baeldung.com/java-threadlocal>
7. Netty FastThreadLocal Javadoc：以数组下标替代哈希探测的工程化实现 —— <https://netty.io/4.1/api/io/netty/util/concurrent/FastThreadLocal.html>
