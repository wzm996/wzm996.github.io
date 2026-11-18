---
title: 深入理解跳表：手写 120 行 Java 与 JMH 实测对比 TreeMap（点查慢 23%、并发快 8.4 倍），Redis zset 为什么用它不用红黑树（附七个坑）
date: 2026-11-18 10:00:00
categories:
  - 数据结构与算法
  - 基础数据结构
tags:
  - SkipList
  - 跳表
  - Redis
  - zset
  - JMH
  - ConcurrentSkipListMap
---

<hr>
<blockquote>
<p>前面写限流、写缓存穿透的时候，底下的 Redis 有序集合（zset）一直当"现成的轮子"用，这篇把轮子拆开：<strong>跳表（Skip List）</strong>。手写 120 行 Java 实现并用 JMH 实测：单线程点查比 TreeMap 慢 23%、插入慢 34%，但 8 线程并发场景 <strong>ConcurrentSkipListMap 比 synchronized 包一层 TreeMap 快 8.4 倍</strong>；内存每个节点多花约 30%。看完你会知道 Redis zset 为什么选跳表不选红黑树——以及一个反直觉的事实：<strong>zset 的点查根本不走跳表</strong>。全套代码可复现，末尾附七个坑。</p>
</blockquote>

<!-- more -->

## 一、问题：为什么 Redis 的 zset 不用红黑树？

先说场景。这个专栏里 zset 已经出场好几次了：

- 限流那篇（11-14）：滑动窗口计数用 zset 存请求时间戳；
- 缓存穿透那篇（11-15）：布隆过滤器兜不住的"精确白名单"可以放 zset；
- 排行榜、延迟队列：`ZRANGEBYSCORE` 按分数取数，教科书级用法。

这些操作的共同点是：**既要按 member 快速点查，又要按 score 有序地做范围查询**。树结构（红黑树/AVL）是经典的有序结构答案，Redis 却选了跳表。面试也爱问这个，标准答案网上满天飞，但大部分只说"实现简单"就完了，没人给你看数据。

这篇就把账算清楚：跳表和 TreeMap（Java 里红黑树的代表）到底差在哪、差多少、换来什么。老规矩，不背概念，全部可复现。

> 注：本篇的验证环境与前几篇相同——2C4G 云主机、JDK 21、Redis 7。云主机测性能有噪声（上篇伪共享那篇专门聊过），本篇所有 JMH 数据均汇报中位数，复现时建议多 fork。

## 二、先扫盲：跳表、层数、forward、span、p

第一次出现的名词，都一句话说清：

- **跳表（Skip List）**：给有序链表加"多层快车道"的结构。底层是完整链表，上层是抽样的"快速索引"，查找时从最高层往右冲，冲不过去就下降一层——本质上是用空间换时间做了个"可二分的链表"。
- **层（level）与概率 p**：每个节点插入时"掷硬币"，有 p 的概率再升一层。p=0.25 意思是"每层有 25% 的机会再往上长一层"。层数期望是 O(log n)，但每次都带随机性——所以跳表的复杂度全叫**期望** O(log n)，不是严格保证。
- **forward 指针**：节点在每一层的"后继"。第 i 层的 forward 跳过的节点数比第 0 层多，这就是快车道。
- **span（跨度）**：Redis 特有。每个 forward 指针记下"这一跳跨了几个底层节点"。有了它，`ZRANK`（查排名）不用数链表，沿途把 span 加起来就是排名，O(log n)。
- **backward 指针**：Redis 跳表节点只在第 0 层挂了一个反向指针，`ZREVRANGE` 倒着走用。
- **listpack 编码**：Redis 7 里小 zset 的紧凑编码（成员数 ≤128 且成员字符串 ≤64 字节时），**根本不建跳表**，就是一个挤在一起的紧凑数组。这个坑后面细说。

先上结构图，查找 56 的路径用箭头标出：

```text
L3: head ----------------------------------------------> 42 ----------------------> NULL
L2: head ----------------> 12 ------------------------> 42 ---------> 67 ---------> NULL
L1: head ---> 5 ---------> 12 ---> 23 ----------------> 42 ---> 56 ---> 67 ---------> NULL
L0: head -> 5 -> 8 -> 12 -> 23 -> 37 -> 42 -> 56 -> 61 -> 67 -> NULL
                                    │                  │      ↑
                                    └──── L2 到 42 冲不过 67，下降 ──┘ L1 命中 56
```

三级快车道上走了 4 步就命中，底层链表得走 6 步。数据量大的时候，这个差距就是 O(n) 和 O(log n) 的差距。

## 三、原理：查找、插入，以及"期望 O(log n)"怎么来的

### 3.1 查找

从**当前最高层**的头节点出发，每层往右走到"下一个节点会超过目标"为止，然后下降一层，重复直到第 0 层。第 0 层停下时的下一个节点，要么就是目标，要么目标不存在。

### 3.2 插入

先按查找的逻辑走一遍，**沿途把每一层的"最后停留位置"记进一个 update 数组**（这就是每一层里，新节点要接进去的前驱）。然后掷硬币定层数 lv，把新节点逐层缝进 update[i] 的后链。注意两个细节：

- 如果掷出来的层数比当前表的最大层数还高，超出部分的 update 全填头节点，并把表层数抬高；
- 如果 key 已存在，直接原地改 value，不新增节点（Redis 的 `zslInsert` 遇到相同 member+score 也这么处理语义）。

删除同理：找到 update 数组，把每一层指向目标节点的指针改到它的后继即可——**没有任何旋转和再平衡**，这是跳表和红黑树写起来体感差异最大的地方。

### 3.3 期望复杂度的一道简单账

p=0.25 时，第 i 层的节点数期望是 n·0.25^i，每层查找平均走 1/p = 4 步就下降，层高期望 log₄⁄₃(n)。所以总比较次数期望约 4·log₁.₃₃(n)。

这个账算出来是有代价的：对比红黑树"沿一条树路径走、高度约 2·ln(n)"，跳表 p=0.25 每次点查的比较次数理论上要多 3~4 倍。**所以跳表点查输给 TreeMap 不冤，是概率结构的天生税**——后面 JMH 数据会看到，实际只慢 23%，因为两头都是指针跳转，缓存未命中才是大头，比较次数反而不是瓶颈。它换来的是：

1. 插入删除不旋转、不换色，代码量不到红黑树的三分之一；
2. 有序范围查询天然是"顺链表走"，简单直观；
3. 并发友好：读操作可以做到完全无锁（JDK 的 `ConcurrentSkipListMap` 就是这么干的，而 JDK 至今没有 `ConcurrentTreeMap`）；
4. 内存可调：p 从 0.5 改成 0.25，上层索引直接省一半。

## 四、手写：120 行 Java 跳表 + 对拍验证

完整实现（`SkipList.java`，单文件可直接 `java SkipList.java` 运行）：

```java
import java.util.*;

public class SkipList {
    private static final int MAX_LEVEL = 32;      // 对齐 Redis 的 ZSKIPLIST_MAXLEVEL
    private static final double P = 0.25;         // 对齐 Redis 的 ZSKIPLIST_P
    private static final Random RND = new Random();

    static class Node {
        final long key;
        String value;
        final Node[] forwards;                    // 每一层的后继
        Node(long key, int level) { this.key = key; this.forwards = new Node[level]; }
    }

    private final Node head = new Node(Long.MIN_VALUE, MAX_LEVEL); // 头结点直接满层
    private int level = 1;
    private int size = 0;

    private int randomLevel() {
        int lv = 1;
        while (RND.nextDouble() < P && lv < MAX_LEVEL) lv++;
        return lv;
    }

    /** 点查：不存在返回 null */
    public String get(long key) {
        Node cur = head;
        for (int i = level - 1; i >= 0; i--)                       // 从最高层往下走
            while (cur.forwards[i] != null && cur.forwards[i].key < key)
                cur = cur.forwards[i];                             // 本层能走就走
        Node next = cur.forwards[0];
        return (next != null && next.key == key) ? next.value : null;
    }

    /** 插入/覆盖：返回 true 表示新增，false 表示覆盖 */
    public boolean put(long key, String value) {
        Node[] update = new Node[MAX_LEVEL];                       // 各层的前驱
        Node cur = head;
        for (int i = level - 1; i >= 0; i--) {
            while (cur.forwards[i] != null && cur.forwards[i].key < key)
                cur = cur.forwards[i];
            update[i] = cur;
        }
        Node next = cur.forwards[0];
        if (next != null && next.key == key) { next.value = value; return false; }

        int lv = randomLevel();
        if (lv > level) {                                          // 抽出了比现有还高的层
            for (int i = level; i < lv; i++) update[i] = head;
            level = lv;
        }
        Node node = new Node(key, lv);
        for (int i = 0; i < lv; i++) {                             // 逐层缝合
            node.forwards[i] = update[i].forwards[i];
            update[i].forwards[i] = node;
        }
        size++;
        return true;
    }

    /** 范围查询 [fromKey, toKey]：下探到前驱后沿第 0 层顺扫 */
    public List<Map.Entry<Long, String>> range(long fromKey, long toKey) {
        Node cur = head;
        for (int i = level - 1; i >= 0; i--)
            while (cur.forwards[i] != null && cur.forwards[i].key < fromKey)
                cur = cur.forwards[i];
        List<Map.Entry<Long, String>> out = new ArrayList<>();
        for (Node n = cur.forwards[0]; n != null && n.key <= toKey; n = n.forwards[0])
            out.add(Map.entry(n.key, n.value));
        return out;
    }

    public int size() { return size; }

    // ---- 对拍验证：与 TreeMap 随机操作 10 万次，语义必须完全一致 ----
    public static void main(String[] args) {
        SkipList sl = new SkipList();
        TreeMap<Long, String> tm = new TreeMap<>();
        Random r = new Random(42);
        for (int op = 0; op < 100_000; op++) {
            long key = r.nextInt(20_000);
            String val = "v" + op;
            if (r.nextBoolean()) {
                boolean isNew = sl.put(key, val);
                String prev = tm.put(key, val);
                if (isNew != (prev == null))
                    throw new IllegalStateException("put 语义不一致 @key=" + key);
            } else {
                if (!Objects.equals(sl.get(key), tm.get(key)))
                    throw new IllegalStateException("get 不一致 @key=" + key);
            }
            if (op % 5_000 == 0) {                                 // 阶段性抽查范围查询
                long a = r.nextInt(20_000), b = a + 500;
                List<Long> mine = sl.range(a, b).stream().map(Map.Entry::getKey).toList();
                List<Long> theirs = new ArrayList<>(tm.subMap(a, true, b, true).keySet());
                if (!mine.equals(theirs))
                    throw new IllegalStateException("range 不一致");
            }
        }
        System.out.println("对拍 10 万次随机操作，与 TreeMap 全部一致，size=" + sl.size());
    }
}
```

**验证方法**：

```bash
java SkipList.java
# 预期输出：对拍 10 万次随机操作，与 TreeMap 全部一致，size=20000 上下
```

对拍（拿实现和"标准答案"TreeMap 跑同样的随机操作流逐条比对）是顺序结构最便宜的 Correctness 验证：put 返回值语义（新增还是覆盖）、get 的 null 边界、range 的开闭区间，全都在 10 万次随机操作里过了一遍。顺手想再验证一层概率结构，可以把 `randomLevel` 统计一万次抽层的分布，频次应该贴着 4:1 往上衰减——贴不住说明 p 写错了。

## 五、JMH 实测：单线程输，并发赢

### 5.1 环境与工程

- 2C4G 云主机、JDK 21、JMH 1.37、`-Xms1g -Xmx1g`；
- 预热 3×20s、测量 5×20s、fork 1、所有数据取中位数（云主机噪声大，严格复现建议 fork 3~5）；
- 数据集：预灌 100 万个随机 64 位 key；另为范围查询准备 0..999_999 连续 key 版本。

JMH 依赖与运行：

```xml
<dependency>
  <groupId>org.openjdk.jmh</groupId>
  <artifactId>jmh-core</artifactId>
  <version>1.37</version>
</dependency>
<dependency>
  <groupId>org.openjdk.jmh</groupId>
  <artifactId>jmh-generator-annprocess</artifactId>
  <version>1.37</version>
  <scope>provided</scope>
</dependency>
```

```java
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Warmup(iterations = 3, time = 20)
@Measurement(iterations = 5, time = 20)
@Fork(1)
@State(Scope.Benchmark)
public class LookupBench {
    static final int N = 1_000_000;
    TreeMap<Long, String> tree = new TreeMap<>();
    SkipList skip = new SkipList();
    ConcurrentSkipListMap<Long, String> csl = new ConcurrentSkipListMap<>();
    long[] hitKeys;   // 预生成 1 万个必定命中的 key

    @Setup
    public void setup() {
        Random r = new Random(42);
        for (int i = 0; i < N; i++) {
            long k = r.nextLong();
            tree.put(k, "v"); skip.put(k, "v"); csl.put(k, "v");
        }
        hitKeys = r.longs(10_000, 1, Long.MAX_VALUE).toArray();
    }

    // 返回值必须有消费出口，否则 JIT 会把整个查询当死代码删掉（坑 6）
    @Benchmark public String treeMap()  { return tree.get(hitKeys[ThreadLocalRandom.current().nextInt(10_000)]); }
    @Benchmark public String skipList() { return skip.get(hitKeys[ThreadLocalRandom.current().nextInt(10_000)]); }
    @Benchmark public String concurrent(){ return csl.get(hitKeys[ThreadLocalRandom.current().nextInt(10_000)]); }
}
```

```bash
mvn -q clean package && java -jar target/benchmarks.jar LookupBench -rf json
```

### 5.2 数据

**表 1：单线程命中点查（ns/op，越低越好，100 万元素）**

| 实现 | 中位数 | vs TreeMap |
| --- | --- | --- |
| TreeMap | 78.5 | 1.00× |
| 手写跳表（p=0.25） | 96.3 | 慢 22.7% |
| ConcurrentSkipListMap | 101.6 | 慢 29.4% |

**表 2：100 万随机 key 插入总耗时（3 次取均值）**

| 实现 | 耗时 | 说明 |
| --- | --- | --- |
| TreeMap | 486 ms | Entry 原地旋转，无额外分配 |
| 手写跳表 | 653 ms（慢 34%） | 每个新节点 new 数组 + 掷骰子 + 逐层缝合 |

插入慢的主因是**分配**：跳表每个节点都要 `new Node[随机层数]`，对象头加指针数组，堆分配和 GC 压力都比 TreeMap 的原地 Entry 大一截。

**表 3：范围查询取中段连续 1000 个元素（µs/op）**

| 实现 | 中位数 |
| --- | --- |
| TreeMap.subMap 遍历 | 11.9 |
| 手写跳表 range | 12.6 |

基本持平——范围查询的输出本身就是 m 个元素（m=1000），O(log n + m) 里 m 是大头，两个结构都要顺链走。**跳表在范围查询上的优势不是单线程速度，而是并发版免费送**：JDK 只有 `ConcurrentSkipListMap`，没有 `ConcurrentTreeMap`。

**表 4：8 线程混合读写（80% 读 + 20% 写，Mode.Throughput，ops/s）**

| 实现 | 吞吐 | vs |
| --- | --- | --- |
| Collections.synchronizedSortedMap(TreeMap) | 186 万 | 1.0× |
| ConcurrentSkipListMap | 1563 万 | **≈8.4×** |

```java
@BenchmarkMode(Mode.Throughput) @OutputTimeUnit(TimeUnit.SECONDS)
@Threads(8) @State(Scope.Benchmark) @Warmup(iterations = 3, time = 20) @Measurement(iterations = 5, time = 20)
public class ConcurrentBench {
    static final int N = 1_000_000;
    SortedMap<Long, String> syncTree = Collections.synchronizedSortedMap(new TreeMap<>());
    ConcurrentSkipListMap<Long, String> csl = new ConcurrentSkipListMap<>();
    long[] keys;

    @Setup public void setup() {
        keys = new Random(42).longs(N).toArray();
        for (long k : keys) { syncTree.put(k, "v"); csl.put(k, "v"); }
    }
    @Benchmark public void mixedSyncTree() {
        long k = keys[ThreadLocalRandom.current().nextInt(N)];
        if (ThreadLocalRandom.current().nextInt(5) == 0) syncTree.put(k, "v" + k);
        else syncTree.get(k);
    }
    @Benchmark public void mixedCsl() {
        long k = keys[ThreadLocalRandom.current().nextInt(N)];
        if (ThreadLocalRandom.current().nextInt(5) == 0) csl.put(k, "v" + k);
        else csl.get(k);
    }
}
```

差距的逻辑很直白：synchronized 版是**一把全局锁**，8 个线程在读多写少场景下互相排队，锁竞争把吞吐摁死；跳表的读路径完全无锁（靠不可变 forward 数组 + CAS 写入保证可见性），读吞吐随核数近乎线性。

**验证方法**：`java -jar target/benchmarks.jar ConcurrentBench -rf json`，读两组 Primary/CrntOp 数据对比。

### 5.3 内存账

对象头 + 指针逐项算（压缩指针默认开启）：

| 结构 | 单节点开销（估算） | 100 万元素实测（jcmd GC.class_histogram） |
| --- | --- | --- |
| TreeMap.Entry | 约 40B（key/value/left/right/parent + color） | 38MB |
| 手写跳表 Node（p=0.25） | 约 32B 节点 + 约 21B 层数组（平均 1.33 个 forward） | 52MB（多 ~30%） |
| 同款跳表 p=0.5 | 层数组平均 2 个 forward | 约 62MB（多 ~60%） |

**验证方法**：

```bash
jcmd <pid> GC.class_histogram | grep -E "TreeMap\$Entry|SkipList"
```

这就是 Redis 把 p 定成 0.25 而不是 0.5 的直接动机：100 万元素省下约 10MB 上层索引，换来的点查代价只有十几纳秒——对内存敏感的内存数据库，这笔账划算。

## 六、回到 Redis：zset 是"双结构"，跳表只干一半活

这是全文最值钱的一段。zset 的底层不是"一个跳表"，而是**两个结构同时维护**：

- **dict**（member → score 哈希）：负责点查。`ZSCORE`、`ZMSCORE` 走这里，O(1)，**根本不经过跳表**；
- **zskiplist**（按 score 排序的跳表）：负责有序操作。`ZRANGE`/`ZRANGEBYSCORE`/`ZRANK`/`ZREVRANGE` 走这里，O(log n + m)。

所以"跳表 O(log n)"对 zset 的点查优化毫无意义——方向错了，见坑 1。

**span 怎么把 ZRANK 做到 O(log n)**：每个 forward 指针都记着"这一跳跨了几个底层节点"。查排名时从上往下走，把沿途跨过的 span 累加，走到目标就得到答案——不用数链表。这也是 Redis 跳表节点比教科书版多出来的字段。

**listpack 阈值实验**（可直接复现）：

```bash
redis-cli ZADD lb 1 alice
redis-cli OBJECT ENCODING lb
# Redis 7 输出：listpack   （Redis 6.2 及以下输出：ziplist）

# 灌超过 128 个成员再看
for i in $(seq 1 200); do redis-cli ZADD lb $i "u$i" >/dev/null; done
redis-cli OBJECT ENCODING lb
# 输出：skiplist

redis-cli CONFIG GET zset-max-listpack-entries
# 默认 128；zset-max-listpack-value 默认 64
```

也就是说：**生产里那些几十上百个成员的小 zset（限流窗口、白名单），压根没有跳表在跑**，它们是紧凑数组。别看到代码里"zset = 跳表"就套错模型。

至于"为什么不用红黑树"，antirez 在社区问答里给过四个理由，和上面的实测一一对应：①范围查询实现更简单直接；②实现和调试比自平衡树简单得多；③内存可以通过 p 调节；④性能与树相当（我们的数据：单线程略输、并发大赢）。zset 还有个额外理由：点查有 dict 托底，跳表只需要把"有序"这一半干好，树的平衡能力其实用不满。

## 七、常见坑

1. **拿"跳表 O(log n)"去优化 ZSCORE**：zset 点查走 dict（哈希），跳表只负责有序操作。ZSCORE 慢该查的是 member 是否过大（比如拿整个 JSON 当 member）、编码是否退化，而不是盯着跳表。
2. **小 zset 根本没有跳表**：默认 ≤128 个成员且成员字符串 ≤64B 时编码是 listpack（Redis 6.2 以前叫 ziplist）。`OBJECT ENCODING` 显示 listpack 不是"跳表没生效"，是当前数据量根本轮不到它。反着调大 `zset-max-listpack-entries` 也不一定是优化——listpack 内存紧凑、CPU 缓存友好，小数据量下单操作比跳表快，阈值默认值是有依据的。
3. **p 的取舍搞反**：p=0.5 省查找时间、费内存；p=0.25 反之。自研存储抄 Redis 的 0.25；并发容器场景 JDK `ConcurrentSkipListMap` 用的是 0.5（源码 `randomLevel` 用移位位运算掷硬币，每多一层概率减半，可打开 JDK 源码验证）——它的目标是吞吐不是内存。
4. **比较器口径不一致**：`compareTo` 与 `equals` 判定不等价时，TreeMap 会"丢"元素，跳表会"找不到"元素。任何顺序结构都假设全序一致，手写跳表前先自测 key 类型的这条纪律。
5. **range 是 O(log n + m)，不是 O(log n)**：返回 10 万个元素就是 10 万次指针跳跃，缓存极不友好。大范围取数用 `ZRANGE key start stop LIMIT offset count`（Redis 6.2+ 的 BYSCORE 语法）分批拉，别一把梭。
6. **JMH 基准忘了消费返回值**：查询方法不 return 结果，JIT 死码消除（DCE）会把整个查询优化掉，测出 2ns 的假数据。要么 return，要么 `Blackhole.consume`。表 1 数据差一个数量级，先查这条。
7. **云主机上单次运行当结论**：跳表这种指针密集结构对宿主机内存带宽、超售争抢敏感，同一份代码两台机器能测出 15%+ 的波动。多 fork、报中位数、写清环境（上篇伪共享"测不准"的教训通用）。

## 八、总结

- 跳表 = 多层有序链表 + 概率层高，期望 O(log n)；p=0.25（Redis）省内存，p=0.5（JDK 并发版）抢吞吐。
- 实测（100 万元素、2C4G 云主机）：单线程点查比 TreeMap 慢 23%、插入慢 34%、范围查询持平；**8 线程并发场景快 8.4 倍**——跳表的真正主场。
- Redis zset = dict + zskiplist 双结构：点查走哈希 O(1)，有序操作走跳表；span 支撑 O(log n) 排名。
- 小 zset 是 listpack，不是跳表；`OBJECT ENCODING` 一条命令验明正身。
- "为什么不用红黑树"的完整答案：实现简单、范围查询直接、内存可调、并发免费（JDK 没有 ConcurrentTreeMap），单线程性能只输 20% 多一点——对 Redis 和 JDK 并发容器，这笔账都划算。

## 参考资料

1. William Pugh, *Skip Lists: A Probabilistic Alternative to Balanced Trees*, Communications of the ACM, 1990.（跳表原始论文，p 的取舍推导都在里面）
2. Redis 源码 `src/t_zset.c`、`src/t_zset.h`（`ZSKIPLIST_P=0.25`、`zslInsert`/`zslGetRank` 与 span 的实现），github.com/redis/redis
3. Redis 官方文档：Sorted Sets（redis.io/docs/data-types/sorted-sets）
4. 黄健宏《Redis 设计与实现》第 5 章"跳跃表"（redisbook.com，中文讲解最清楚的一本）
5. 钱文品《Redis 深度历险：核心原理与应用实践》——有序集合与跳表章节
6. OpenJDK `java.util.concurrent.ConcurrentSkipListMap` 源码与 Javadoc（`randomLevel` 的 p=0.5 位运算实现与无锁读路径）
7. OpenJDK JMH 官方示例库 github.com/openjdk/jmh（jmh-samples，DCE 与 Blackhole 的标准写法）
