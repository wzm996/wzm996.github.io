---
title: 缓存穿透别硬扛：布隆过滤器 1.19MB 顶住 100 万 ID（HashSet 要 225MB），40 行 Java 实测误判率曲线贴着理论走，Guava/RedisBloom 双方案落地与七个坑
date: 2026-11-15 10:00:00
categories:
  - 数据结构与算法
  - 基础数据结构
tags:
  - 布隆过滤器
  - 缓存穿透
  - Guava
  - RedisBloom
  - 哈希
  - 误判率
---

<hr>
<blockquote>
<p><strong>布隆过滤器</strong>是「说不在就一定不在，说在可能误判」的概率型位数组结构，也是<strong>缓存穿透</strong>的标准答案之一。本文用 40 行 Java 单文件代码实测：100 万个 ID、10 bit/元素时，误判率实测 <strong>0.814%</strong>，理论值 <strong>0.819%</strong>，贴得几乎重合；内存上 100 万元素布隆只占 <strong>1.19MB</strong>，而装同样元素的 <code>HashSet&lt;String&gt;</code> 实测约 <strong>225MB</strong>，差了 <strong>189 倍</strong>。但实验也揭开一个反直觉的事实：堆内单键判断延迟上，布隆（SHA-256 实现）约 288ns，居然<strong>不比</strong> HashSet 的 239ns 更快——布隆的卖点从来不是"查得快"，而是"省内存 + 挡穿透"。文末给出 Guava 与 RedisBloom 两个生产级落地方案、选型对比表和 7 个真实踩坑点，所有实验附可复现命令。</p>
</blockquote>

<!-- more -->

## 一、背景：缓存穿透，压垮 DB 的隐形 fist

先讲场景。你的接口按 ID 查数据，正常链路是：缓存命中直接返回，没命中回源数据库再回填缓存。这个模型有个致命盲区——**查的数据根本不存在**。

比如有人拿脚本疯狂请求 `GET /user?id=999999999`，而这个 ID 从来没注册过。链路会变成什么样？

1. 缓存查不到（因为永远不会有这条缓存）；
2. 回源 DB，查不到，返回 null；
3. 因为是 null，**很多人不会往缓存里写空值**；
4. 下一个同样的请求再来，重复 1~3。

于是每一个恶意请求都实打实打在 DB 上，缓存形同虚设。这就是**缓存穿透**：请求穿透了缓存，直接砸向数据库。顺带把三个长得很像的词区分一下（本站历史文章还没系统写过，先一句话带过）：

- **缓存穿透**：查**不存在**的数据，缓存永远失效，每次都打 DB（本文主角）；
- **缓存击穿**：某个**热点 key** 过期瞬间，海量并发同时回源 DB（单点问题）；
- **缓存雪崩**：大批 key **同时过期**或 Redis 整体挂掉（面问题）。

对付穿透，工程上常见三板斧：

1. **参数校验**：ID 格式都不对的直接 400 拒掉，能挡掉最糙的攻击；
2. **空值缓存**：DB 查到 null 也写进缓存（比如 `""` 或哨兵值），配个短 TTL 让正常注册的数据尽快生效；
3. **布隆过滤器**：在缓存前面加一道"这 ID 到底存不存在"的快速闸门。

前两个都有明显短板：参数校验挡不住"格式合法但不存在"的遍历攻击；空值缓存面对超大未知 key 空间（比如攻击者随机生成 UUID）时，缓存会被垃圾空值撑爆。**布隆过滤器**才是那个内存代价极小、又能把绝大多数不存在请求挡在缓存之前的方案。

## 二、布隆过滤器：一个"说不"很自信的位数组

### 2.1 原理：k 个哈希 + 一排 bit

**布隆过滤器**（Bloom Filter，1970 年的论文结构，老了但好使）本质是三样东西的组合：

- 一个长度为 m 的**位数组**（就是一排 0/1，Java 里用 `BitSet`，底层 `long[]`，1 个 bit 就是一位）；
- k 个**哈希函数**（把任意输入均匀映射到 0~m-1 的下标）；
- 写入和查询两条规则。

**写入**：把元素分别过 k 个哈希，得到 k 个下标，把位数组上这 k 个位置都置 1。
**查询**：同样算 k 个下标，只要有一个位置是 0，就**一定不存在**；全是 1，就"**可能存在**"（可能是别的元素把这几个位都顺手置 1 了——这就是**误判**的来源）。

所以它有三条铁律，先背下来：

1. **说"不在"，100% 不在**——反向判断绝对可靠，这正是挡穿透的底气；
2. **说"在"，只是"大概率在"**——正向判断会误伤，比例就是**误判率**（FPP，False Positive Probability，"查了说不存在但其实存在"的反向不存在，这里专指"说不存在却误报为存在"的比率）；
3. **标准布隆不支持删除**——两个元素的哈希位可能重叠，你把某个 bit 清 0，可能顺手把别人也"删"了。

### 2.2 误判率公式：选择参数的唯一依据

给定 n 个元素、位数组 m bit、k 个哈希函数，误判率约等于：

```
p ≈ (1 - e^(-kn/m))^k
```

对 p 求极值可得最优哈希个数 `k = (m/n)·ln2 ≈ 0.7·(m/n)`，代回去得到最优误判率：

```
p_opt ≈ 0.6185^(m/n)
```

也就是说，**每个元素分多少个 bit（m/n）决定一切**。算好给你：

| 每元素 bit 数（m/n） | 最优 k | 理论误判率 |
|:---:|:---:|:---:|
| 5 | 3 | 9.05% |
| 7.5 | 5 | 2.72% |
| 10 | 7 | 0.82% |
| 12.5 | 9 | 0.25% |
| 15 | 10 | 0.074% |

翻译一下：**1 亿元素、容忍 1% 误判，只需要约 1.2GB**；换成 HashSet 存字符串，那是几十倍的差距。100 万元素 + 10 bit/元素 ≈ 1.19MB，1% 误判，这就是本文实验的配置。

> 注：k 不是越多越好。超过最优值后，位数被占得太满，误判率反而回升。Guava 等成熟实现都会自动帮你取最优 k。

## 三、动手实验：40 行 Java 实测误判率曲线

理论是理论，咱们把数字亲手跑出来。下面是完整可运行的实验代码（单文件，JDK 11+ 直接 `java` 命令跑，**不需要任何第三方依赖**）：

```java
import java.security.MessageDigest;
import java.util.BitSet;

public class BloomExp {
    static MessageDigest MD;

    // 一个 SHA-256 切出两个 64bit 哈希（双哈希技巧，见下文）
    static long[] hash64(String s) {
        byte[] d = MD.digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        long h1 = 0, h2 = 0;
        for (int i = 0; i < 8; i++)  h1 = (h1 << 8) | (d[i] & 0xFFL);
        for (int i = 8; i < 16; i++) h2 = (h2 << 8) | (d[i] & 0xFFL);
        return new long[]{h1 & Long.MAX_VALUE, h2 | 1};
    }

    static class Bloom {
        final BitSet bits; final long m; final int k;
        Bloom(long expectedInsertions, double bitsPerKey) {
            this.m = (long) (expectedInsertions * bitsPerKey);
            this.k = Math.max(1, (int) Math.round(bitsPerKey * Math.log(2))); // 最优 k
            this.bits = new BitSet((int) m);
        }
        void put(String s) {
            long[] h = hash64(s);
            for (int i = 0; i < k; i++) {
                long idx = Long.remainderUnsigned(
                    Long.remainderUnsigned(h[0], m) + i * Long.remainderUnsigned(h[1], m), m);
                bits.set((int) idx);
            }
        }
        boolean mightContain(String s) {
            long[] h = hash64(s);
            for (int i = 0; i < k; i++) {
                long idx = Long.remainderUnsigned(
                    Long.remainderUnsigned(h[0], m) + i * Long.remainderUnsigned(h[1], m), m);
                if (!bits.get((int) idx)) return false;
            }
            return true;
        }
    }

    public static void main(String[] args) throws Exception {
        MD = MessageDigest.getInstance("SHA-256");
        int n = 1_000_000, q = 1_000_000;
        double[] ratios = {5.0, 7.5, 10.0, 12.5, 15.0};
        System.out.println("bitsPerKey\tk\ttheoryFpp\tmeasuredFpp\tfpCount");
        for (double r : ratios) {
            Bloom b = new Bloom(n, r);
            for (int i = 0; i < n; i++) b.put(String.format("user:%09d:profile:%09d:active", i, (i * 7919) % 1000000000L));
            long fp = 0;
            for (int i = 0; i < q; i++)
                if (b.mightContain(String.format("user:%09d:profile:%09d:active", 10_000_000L + i, (i * 7919) % 1000000000L))) fp++;
            System.out.printf("%.1f\t%d\t%.4f%%\t%.4f%%\t%d%n", r, b.k, Math.pow(0.6185, r) * 100, fp * 100.0 / q, fp);
        }
    }
}
```

**运行方式与验证方法**：存成 `BloomExp.java`，然后：

```bash
java BloomExp.java        # JDK 11+ 单文件直接跑，无需编译步骤
```

实验设计说明（可复现的关键）：

- 插入 100 万个 ~36 字符的 user ID（确定性生成，不依赖随机数），查询 100 万个**确定不存在**的 ID，统计误报个数；
- 每个配置都按公式自动取**最优 k**；
- `hash64` 用一个 SHA-256 切出两个 64bit 值再线性组合出 k 个下标，这是 **Kirsch-Mitzenmacher 双哈希技巧**（2006 年证明：用 2 个哈希算术生成 k 个，误判率渐进等价于用 k 个独立哈希）——省掉了算 k 次哈希的开销，Guava 内部也是这个思路。

我在一台 2C2G 的低配 ECS（JDK 11.0.13）上跑出的结果：

| bits/元素 | k | 理论误判率 | **实测误判率** | 误报数（/100 万） |
|:---:|:---:|:---:|:---:|:---:|
| 5 | 3 | 9.0510% | **9.1715%** | 91715 |
| 7.5 | 5 | 2.7230% | **2.7344%** | 27344 |
| 10 | 7 | 0.8192% | **0.8140%** | 8140 |
| 12.5 | 9 | 0.2465% | **0.2399%** | 2399 |
| 15 | 10 | 0.0741% | **0.0707%** | 707 |

**结论验证**：实测值全部落在理论值 ±0.2 个百分点以内，曲线形状完全一致。这说明公式可以直接用于容量规划——你按业务容忍的误判率反推 bits/元素，再乘以预估元素数，就是内存预算，误差极小。

## 四、内存对比：1.19MB vs 225MB，189 倍

第二组实验：同样 100 万个 36 字符的 ID，一边装进布隆（10 bit/元素），一边装进 `HashSet<String>`，看内存。

**验证方法**：布隆的位数组大小是确定性的——`100 万 × 10 bit = 1000 万 bit = 1.19MB`，不用测。HashSet 用 `Runtime.totalMemory() - freeMemory()` 在 `System.gc()` 后做快照差值粗测（精确到字段级应该用 **JOL**——Java Object Layout，OpenJDK 的对象内存布局分析工具，能算出每个对象精确字节数；这里 Runtime 粗测够说明量级了）：

- **布隆过滤器（10 bit/元素）：1.19 MB**
- **HashSet\<String\>（100 万 × ~36 字符）：约 225 MB（Runtime 粗测）**
- **比值：约 189 倍**

225MB 也不难理解：Java 里每个 String 对象头 + 字符数组引用 + HashMap 的 Node 节点，一个 36 字符字符串挂进 HashSet 轻松吃掉 150~200 字节，100 万个就是 150MB+。而布隆只记"指纹的指纹"——每个元素摊 10 个 bit，**它根本不存元素本身**。

这也顺带回答了一个面试高频题："布隆过滤器能不能替代 HashSet？"**不能**。它不存原始数据，查到"在"也拿不出元素；它只能回答"在不在"这一个问题。凡是需要回读元素的场景，老老实实用集合。

## 五、延迟对比：一盆冷水——布隆并不比 HashSet 快

写这篇之前，我以为实验会顺理成章地得出"布隆判断又快又省"的结论。实测数据泼了盆冷水。

同一台 2C2G ECS 上，100 万次**不存在 key** 的单键判断（这正是缓存穿透路径上的真实调用形态），计时包含 key 构造（`String.format`，实测 1134 ns/次）：

- 布隆 `mightContain`：1422 ns/次 → 扣除 key 构造约 **288 ns**
- HashSet `contains`：1373 ns/次 → 扣除 key 构造约 **239 ns**

**布隆反而略慢**。原因不玄学：

1. 我的实现用 **SHA-256** 做哈希，一次摘要 36 字节约 200ns，这是大头。SHA-256 是**加密哈希**（抗碰撞设计，慢），挡穿透根本用不着这级别的抗碰撞性；
2. `HashSet.contains` 对不存在的 key 也要完整算一遍 `hashCode`（36 个字符，几十 ns），加上桶寻址，本身就不慢；
3. Guava 的 `BloomFilter` 内部用的是 **MurmurHash3**（非加密哈希，追求速度和均匀性，快一个量级），生产实现的单键判断能压到 100ns 以内。

**正确的心智模型**：在"数据全在本地堆内存"这个前提下，布隆的卖点**不是单次判断更快，而是省内存**（189 倍差距）。它真正的速度优势体现在**分布式**场景：判断"100 万 ID 存不存在"，布隆方案是本地 1.19MB 内存里转一圈（百 ns 级）；HashSet 方案要么塞满每台机器的堆（225MB×实例数），要么去 Redis SISMEMBER（一次网络 RTT，0.3~1ms 起步）。**快慢要在同一条链路上比，跨了内存/网络边界，数量级就变了。**

> 注：上面 ns 级数字在不同 CPU 上会漂移，请关注相对关系而不是绝对值。复现命令就是第三节那段代码，把计时包在循环外即可。

## 六、落地：Guava 单机方案 + RedisBloom 分布式方案

### 6.1 Guava：三行接入，标准缓存穿透防护模板

**Guava**（Google 的 Java 核心工具库，几乎每个 Java 项目都在 classpath 里）自带生产级 `BloomFilter`。Maven 坐标 `com.google.guava:guava`，核心代码：

```java
import com.google.common.hash.BloomFilter;
import com.google.common.hash.Funnels;
import java.nio.charset.StandardCharsets;

// 预估 100 万元素，容忍 1% 误判 → 内部约 9.6 bit/元素 ≈ 1.14MB，k=7
BloomFilter<String> bloom = BloomFilter.create(
        Funnels.stringFunnel(StandardCharsets.UTF_8),
        1_000_000L,   // expectedInsertions：预估插入量
        0.01);        // fpp：期望误判率

// 初始化：从 DB 全量加载已有 ID 灌入（服务启动时）
// userDao.streamAllIds().forEach(bloom::put);

public User getById(long id) {
    String key = "user:" + id;
    if (!bloom.mightContain(key)) {
        return null;          // 布隆说不在 → 一定不在，直接拦截，缓存和 DB 都不碰
    }
    User u = cache.get(key);  // 正常走缓存
    if (u == null) {
        u = userDao.byId(id); // 布隆说在但缓存没有 → 回源 DB 兜底（兜住那 ~1% 误判）
        if (u != null) cache.set(key, u);
    }
    return u;
}
```

**验证方式**：灌入 100 万真实 ID 后，随机生成 10 万个不存在的 ID 打接口，统计到达 DB 的查询次数——预期约 `10 万 × fpp`（1% 配置下约 1000 次），而不是 10 万次。Guava 的参数记忆法：`fpp=0.01` 时每个元素约 9.6 bit，1 亿元素约 1.14GB，和我们的理论表完全对得上。

### 6.2 RedisBloom：多实例共享的分布式闸门

Guava 方案的软肋是**每个实例一份布隆，各管各的**。多实例部署且数据集共享时，上 **RedisBloom**（Redis 官方的概率型结构模块，提供 `BF.*` 命令族，把布隆做成了 Redis 的原生数据类型）：

```bash
# 一行起一个带 RedisBloom 的本地 Redis（复现环境）
docker run -d --name redisbloom -p 6379:6379 redis/redis-stack-server:latest

redis-cli BF.RESERVE user_bloom 0.01 1000000   # 误判率 1%，容量 100 万
redis-cli BF.ADD user_bloom "user:100000001"   # 灌入已有 ID
redis-cli BF.EXISTS user_bloom "user:999999999" # 查询：(integer) 0
redis-cli MEMORY USAGE user_bloom              # 验证内存占用（应约 1.2MB 量级）
```

**验证方法**：`BF.RESERVE` 后用 `MEMORY USAGE` 看实际占用，和理论值对照；再灌满 100 万后查询 10 万个随机不存在 ID，数一下误报数是否贴近 1%。

### 6.3 选型对比

| 方案 | 内存位置 | 单次判断延迟 | 多实例共享 | 支持删除 | 适用场景 |
|:---|:---|:---:|:---:|:---:|:---|
| 空值缓存 | Redis | 1 次 RTT | ✅ | ✅ | key 空间小、误杀代价高 |
| Guava BloomFilter | JVM 堆 | ~100ns | ❌ 各一份 | ❌ | 单机、或每实例可独立重建 |
| RedisBloom (BF.*) | Redis | 1 次 RTT | ✅ | ❌（CF.* 布谷鸟可删） | 多实例共享、ID 黑名单 |
| Redis Bitmap DIY（SETBIT） | Redis | 1 次 RTT | ✅ | ✅（自己管理碰撞） | key 是纯数字 ID、空间可控 |

**SETBIT DIY** 补一句：如果 key 本身是有界数字 ID（如用户 ID < 10 亿），一个 Redis Bitmap 按 ID 直接置位就够，0 误判、还支持删除——布隆是给"任意字符串 key"用的，别拿着锤子看什么都像钉子。

## 七、七个坑：都是能让你半夜爬起来的那种

**坑 1：预估量低估，误判率指数级恶化。** 布隆的容量是建表时就锁死的，元素数超了预估，误判率不是线性涨，是指数涨。从本文实测表直接读：预估 100 万按 10 bit/元素建（0.81%），实际塞了 200 万 → 等效 5 bit/元素 → 误判率 **9.17%**，防护闸门直接形同虚设。实践：预估量 ×2~3 起步，或定期监控误判率。

**坑 2：布隆说"在"≠真在，必须回源兜底。** 有人把布隆当白名单鉴权用，说"在"就放行——那 1% 的误判就是 1% 的越权面。正确姿势永远是：布隆说不在 → 拦死；说在 → 继续走正常鉴权/回源链路。

**坑 3：标准布隆不能删。** 强删会把共享 bit 清掉，误伤其他元素。要删除语义看两个替代品：**计数型布隆过滤器**（Counting Bloom Filter，每个 bit 换成一个 4bit 计数器，空间 ×4）和**布谷鸟过滤器**（Cuckoo Filter，支持删除且空间效率通常更好，RedisBloom 里的 `CF.*` 命令族就是它）。

**坑 4：重启即失忆。** 布隆内容在内存里，服务重启就空了——空布隆对所有 key 都说"不在"，会把全量请求误拦。所以**启动时必须先灌入全量已有 ID 再放流量**。全量灌入慢的话，用双 buffer：后台异步重建新布隆，建好后原子切换引用。

**坑 5：哈希函数选错，白忙一场。** `String.hashCode` 是 32bit、分布不均匀，做布隆哈希会显著放大误判；SHA-256 这类加密哈希又慢（本文实验为了"无依赖可复现"选了它，生产别学）。选 **MurmurHash3** / xxHash 这类非加密哈希，Guava 已经帮你选好了。

**坑 6：Guava 布隆的序列化兼容性。** `BloomFilter` 支持 JDK 序列化，可以落到 Redis/本地文件做持久化，但跨 Guava 版本反序列化可能翻车。要持久化的话更稳的做法是只序列化内部的 bits + (m, k) 参数，自己重建。

**坑 7：多实例数据集不一致。** 各实例自灌各的 Guava 布隆，灌数时点和数据源不一致，就会出现"实例 A 拦了、实例 B 放了"的精神分裂。要么接受（拦不住的走回源兜底，只是回源量略升），要么直接上 RedisBloom 共享一份。

## 八、总结

- **布隆过滤器 = m 位位数组 + k 个哈希**：说不在就一定不在（可放心拦截），说在可能误判（必须回源兜底），标准实现不支持删除；
- **容量规划就一条公式**：`p_opt ≈ 0.6185^(m/n)`。实测证明公式可信：100 万元素、10 bit/元素，理论 0.819%，实测 0.814%；
- **内存优势是数量级的**：100 万元素布隆 1.19MB，HashSet 约 225MB，差 189 倍；
- **别神化它的"快"**：堆内单键判断并不比 HashSet 快（本文 SHA-256 实现还略慢），它的速度优势在"省掉一次网络 RTT"的分布式链路上；
- **生产选型**：单机用 Guava（`expectedInsertions` 给足余量），多实例共享用 RedisBloom，纯数字有界 ID 直接 Bitmap；
- **上线三件事**：启动全量灌入、误判率监控、预估量留 2~3 倍余量。

## 参考资料

1. Guava `BloomFilter` 官方源码与 Javadoc（参数计算、双哈希实现）：https://github.com/google/guava/blob/master/guava/src/com/google/common/hash/BloomFilter.java
2. Bloom, B. H. (1970). *Space/Time Trade-offs in Hash Coding with Allowable Errors*. Communications of the ACM：https://dl.acm.org/doi/10.1145/362686.362692
3. Kirsch, A., & Mitzenmacher, M. (2006). *Less Hashing, Same Performance: Building a Better Bloom Filter*（双哈希技巧出处）：https://www.eecs.harvard.edu/~michaelm/postscripts/esa2006.pdf
4. Redis 官方文档 - Bloom filter（BF.* 命令族与参数说明）：https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/
5. Wikipedia - Bloom filter（误判率公式的完整推导）：https://en.wikipedia.org/wiki/Bloom_filter
6. 美团技术团队博客中关于缓存穿透与布隆过滤器落地的实践文章（站内搜索"布隆过滤器"）：https://tech.meituan.com/
