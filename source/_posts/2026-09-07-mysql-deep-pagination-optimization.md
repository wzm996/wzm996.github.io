---
title: MySQL 深分页优化实战——LIMIT 1000000,20 为什么这么慢，怎么救？
date: 2026-09-07 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - 深分页
  - 索引
  - EXPLAIN
  - 游标分页
  - 性能优化
---

<hr>
<blockquote>
<p><strong>深分页</strong>（deep pagination）是列表类接口最经典的性能杀手：<code>LIMIT 1000000, 20</code> 这一条 SQL，在千万级数据的表上能跑到 2 秒开外。这篇文章把它的慢因掰开讲清楚（B+ 树顺序扫描 + 回表），并实测对比三种优化方案（延迟关联、覆盖索引、游标分页）的 P50/P95/P99 延迟——最优解能把 2.4 秒干到 1 毫秒以内。所有实验都能在 Docker 里一键复现。</p>
</blockquote>

<!-- more -->

## 一、背景：一个越翻越慢的列表接口

先说场景。你有一个「订单管理」页面，运营同学习惯性地点到第 5 万页看历史数据，接口开始转圈；再往后翻，直接超时。后端日志里抓到这么一条 SQL：

```sql
SELECT * FROM orders
ORDER BY id
LIMIT 1000000, 20;
```

表里就 1000 万行数据，`id` 还是主键，按理说走主键应该飞快——为什么翻到后面就这么慢？

这篇文章就解决三个问题：

1. `LIMIT offset, N` 到底慢在哪（原理层，用 **EXPLAIN** 拿证据）；
2. 有哪些可行的优化方案，各自适用什么场景；
3. 优化效果怎么量化验证（P50/P95/P99 压测对比，不是拍脑袋）。

> 先解释两个高频名词：
>
> - **P50 / P95 / P99**：把一批请求的耗时从小到大排队，取第 50%、95%、99% 位置的值。P99 高说明有长尾请求拖后腿，用户感受到的「偶尔卡一下」通常就是它。
> - **深分页（deep pagination）**：`OFFSET` 值很大的分页，比如 `LIMIT 1000000, 20`——跳过一百万行只取 20 行。

## 二、五分钟原理课：LIMIT offset,N 到底慢在哪

### 2.1 InnoDB 的 B+ 树与聚簇索引

**B+ 树**是 InnoDB 存储引擎的索引结构：一棵多叉平衡树，数据全在叶子节点上，叶子之间用链表串起来，所以有序遍历和范围扫描很高效。

InnoDB 的表本身就是一棵按主键组织的 B+ 树，叫**聚簇索引**（clustered index）——叶子节点存的是完整的行数据。你按 `id` 排序遍历，本质就是在按顺序走这棵树的叶子链表。

### 2.2 慢的本质：offset 是「数着跳过」，不是「直接跳到」

这是最容易误解的一点：**`LIMIT 1000000, 20` 不会跳过前 100 万行，而是一行一行读完前 100 万行、全部扔掉，再返回 20 行。**

MySQL 没有把 offset 换算成「从第 1000001 行开始读」的能力，存储引擎层面只有一个游标，只能顺序推进。所以 offset 越大，扫的行越多，耗时线性增长。

如果还是 `SELECT *`，情况更糟：每一行都带着全部列从磁盘/缓冲池里取出来——尽管其中 100 万行最后都被扔掉了。这个「拿着索引位置回表取整行」的动作，就是常说的**回表**。

### 2.3 用 EXPLAIN 拿证据

**EXPLAIN** 是 MySQL 自带的执行计划查看命令：不真正执行 SQL，只告诉你它打算怎么走（用哪个索引、预计扫多少行）。写 SQL 不看 EXPLAIN，相当于开车不看仪表盘。

```sql
EXPLAIN SELECT * FROM orders ORDER BY id LIMIT 1000000, 20;
```

关键输出（完整实验在第四节）：

| 字段 | 值 | 含义 |
|---|---|---|
| type | index | 按索引顺序做全索引扫描 |
| key | PRIMARY | 走主键 |
| rows | 1000020 | 预计要扫 100 万+ 行 |
| Extra | （空） | 没有任何优化可借力 |

`rows` 直接暴露了问题：为了 20 行数据，准备扫 100 万行。

MySQL 8.0.18+ 还有 **EXPLAIN ANALYZE**：把 SQL 真正执行一遍，输出每个步骤的**实际**耗时和行数，比 EXPLAIN 的「预估」更接近真相，后面验证会用到。

## 三、方案总览：四种优化思路怎么选

| 方案 | 核心思路 | 实测效果 | 适用场景 | 代价 |
|---|---|---|---|---|
| 延迟关联 | 先只查 id，再回表 | ~7×（2.4s → 330ms） | 必须支持跳页 | 改 SQL，仍随 offset 线性变慢 |
| 覆盖索引 | 查询列全在索引里 | 省回表，省不了扫描 | 只取少数几列 | 索引占空间，写放大 |
| 游标分页 | WHERE id > 上一页末尾 | ~2600×（2.4s → 0.9ms） | 连续翻页/无限下拉 | 不能跳页 |
| 业务限制 | 限最大页数 / 接入 ES | 视产品形态 | 搜索类场景 | 交互方式变化 |

下面逐个拆，然后进实战统一压测。

### 3.1 延迟关联（deferred join）

**延迟关联**的思路：把「扫 100 万行」和「取 20 行完整数据」拆开。先用**覆盖索引**把 20 个 `id` 挑出来，再用这 20 个 id 回表取完整数据。

先解释**覆盖索引**（covering index）：查询需要的所有列都在某个索引里，不用回表取行数据，在索引上就完成了——索引比整行数据窄得多，扫描成本低一个量级。

```sql
SELECT o.*
FROM orders o
JOIN (SELECT id FROM orders ORDER BY id LIMIT 1000000, 20) t
  ON o.id = t.id;
```

子查询只查 `id`，主键索引本身就是 `id`，所以子查询是纯索引扫描、零回表：扫的行数没变，但每行的处理成本大幅下降。

### 3.2 覆盖索引直查

如果列表页只显示三五列，干脆别 `SELECT *`：

```sql
SELECT id, status, amount, created_at
FROM orders
ORDER BY id
LIMIT 1000000, 20;
```

配合 `(status, id)` 这类复合索引，带条件的业务查询（`WHERE status = 'PAID' ORDER BY id`）也能吃到覆盖索引。这里有个 InnoDB 的小知识：**二级索引**（非主键索引）的叶子节点会自动存一份主键值，所以索引 `(status)` 实际等价于 `(status, id)`——主键是二级索引的「隐式包含列」。

注意：这个方案消灭的是回表，消灭不了「扫 offset 行」，offset 深到一定程度照样慢。

### 3.3 游标分页（keyset pagination）：真正的大杀器

**游标分页**（也叫 keyset pagination，键集分页）换了个思路：不数「跳过多少行」，而是记住「上一页最后一条是 id = 1000000」，下一页从这个位置继续找：

```sql
SELECT * FROM orders
WHERE id > 1000000
ORDER BY id
LIMIT 20;
```

`WHERE id > ? ORDER BY id LIMIT 20` 在 B+ 树上是标准的**范围定位**：从 1000000 这个位置出发往右走 20 个叶子就结束，跟数据总量无关。这是唯一把深分页从 O(offset) 降到 O(log n) + 常数的方案。

代价：只能「下一页/上一页」连续翻，不能直接跳到第 5 万页。朋友圈、信息流这类无限下拉的场景，全是这个方案。

## 四、动手实战：把方案都跑一遍

### 4.1 环境

- Docker + MySQL 8.0（本文用 8.0.36）
- 测试机：4C8G，本地 SSD
- 数据量：1000 万行

```bash
docker run -d --name mysql8-deep \
  -e MYSQL_ROOT_PASSWORD=pass123 \
  -e MYSQL_DATABASE=demo \
  -p 3307:3306 \
  mysql:8.0
```

> 注：映射到宿主机 3307 端口，避免撞上本机已有的 MySQL；测试容器别暴露公网。

### 4.2 建表与造数：1000 万行，可复现

建表：

```sql
-- schema.sql
CREATE DATABASE IF NOT EXISTS demo DEFAULT CHARSET utf8mb4;
USE demo;

CREATE TABLE orders (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED    NOT NULL,
  amount     DECIMAL(10,2)   NOT NULL,
  status     VARCHAR(16)     NOT NULL,
  created_at DATETIME        NOT NULL,
  remark     VARCHAR(200)    NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY idx_status (status),
  KEY idx_user  (user_id)
) ENGINE=InnoDB;
```

造数用**递归 CTE**（CTE = Common Table Expression，`WITH` 开头的临时结果集；递归版可以自己引用自己，生成连续序列最方便）。每批 100 万行，跑 10 批：

```sql
-- seed.sql：单批 100 万行
USE demo;
SET SESSION cte_max_recursion_depth = 1000000;

INSERT INTO orders (user_id, amount, status, created_at, remark)
WITH RECURSIVE seq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000000
)
SELECT
  FLOOR(1 + RAND(42) * 100000),
  ROUND(RAND(43) * 1000, 2),
  ELT(1 + FLOOR(RAND(44) * 4), 'CREATED', 'PAID', 'SHIPPED', 'CANCELLED'),
  NOW() - INTERVAL FLOOR(RAND(45) * 31536000) SECOND,
  CONCAT('order-remark-', LPAD(FLOOR(RAND(46) * 1000000), 7, '0'))
FROM seq;
```

> 注：`cte_max_recursion_depth` 默认只有 1000，不调大直接报错 ` recursion depth exceeded`，这是用递归 CTE 造数最常见的坑。

批量执行（密码走环境变量，别写在命令行里——会被 shell history 记住）：

```bash
export MYSQL_PWD=pass123
for i in $(seq 1 10); do
  mysql -h 127.0.0.1 -P 3307 -u root < seed.sql
done
mysql -h 127.0.0.1 -P 3307 -u root -e "SELECT COUNT(*) FROM demo.orders;"
-- 预期输出：10000000
```

4C8G 的机器上全程大约 3~5 分钟。所有 `RAND(x)` 都带固定种子，保证每次造出来的数据一模一样——这是压测可复现的前提。

### 4.3 压测脚本：拿到 P50/P95/P99

60 行 Python（唯一依赖 `pymysql`），模拟 8 个并发用户持续翻页 30 秒：

```python
#!/usr/bin/env python3
# loadgen.py —— pip install pymysql 后直接跑
import argparse, threading, time
import pymysql

p = argparse.ArgumentParser()
p.add_argument('--sql', required=True, help='用 %s 做 offset/游标占位')
p.add_argument('--arg', type=int, default=0, help='offset 或游标起始 id')
p.add_argument('--threads', type=int, default=8)
p.add_argument('--seconds', type=int, default=30)
args = p.parse_args()

def pct(sorted_xs, q):
    k = max(0, min(len(sorted_xs) - 1, round(q / 100 * (len(sorted_xs) - 1))))
    return sorted_xs[k]

lat, lock = [], threading.Lock()
deadline = time.time() + args.seconds

def worker():
    conn = pymysql.connect(host='127.0.0.1', port=3307, user='root',
                           password='pass123', database='demo', autocommit=True)
    while time.time() < deadline:
        t0 = time.perf_counter()
        with conn.cursor() as cur:
            cur.execute(args.sql, (args.arg,))
            cur.fetchall()
        with lock:
            lat.append((time.perf_counter() - t0) * 1000)
    conn.close()

ts = [threading.Thread(target=worker) for _ in range(args.threads)]
[t.start() for t in ts]; [t.join() for t in ts]

lat.sort()
n = len(lat)
print(f'requests={n}  P50={pct(lat,50):.1f}ms  P95={pct(lat,95):.1f}ms  '
      f'P99={pct(lat,99):.1f}ms  mean={sum(lat)/n:.1f}ms  '
      f'throughput={n/args.seconds:.1f}qps')
```

### 4.4 基线：优化前有多慢

```bash
python3 loadgen.py \
  --sql "SELECT * FROM orders ORDER BY id LIMIT %s, 20" \
  --arg 1000000 --threads 8 --seconds 30
```

实测结果（4C8G + Docker，多次取稳定趋势）：

| 指标 | 数值 |
|---|---|
| P50 | 2380 ms |
| P95 | 2960 ms |
| P99 | 3310 ms |
| 吞吐 | ~3.2 qps |

8 个并发就能把接口打到 3 qps、单请求 2 秒往上——生产环境这种 SQL 顶多再深几页就雪崩。

### 4.5 优化一：延迟关联

```bash
python3 loadgen.py \
  --sql "SELECT o.* FROM orders o JOIN (SELECT id FROM orders ORDER BY id LIMIT %s, 20) t ON o.id = t.id" \
  --arg 1000000 --threads 8 --seconds 30
```

| 指标 | 基线 | 延迟关联 | 提升 |
|---|---|---|---|
| P50 | 2380 ms | 331 ms | 7.2× |
| P95 | 2960 ms | 412 ms | 7.2× |
| P99 | 3310 ms | 468 ms | 7.1× |
| 吞吐 | 3.2 qps | 23.1 qps | 7.2× |

验证子查询确实走了覆盖索引：

```sql
EXPLAIN SELECT id FROM orders ORDER BY id LIMIT 1000000, 20;
-- Extra 列应出现：Using index
```

注意：P50 仍随 offset 线性增长——把 `--arg` 换成 5000000 再跑，延迟会涨回秒级。**延迟关联是「减刑」，不是「无罪释放」。**

### 4.6 优化二：游标分页

```bash
python3 loadgen.py \
  --sql "SELECT * FROM orders WHERE id > %s ORDER BY id LIMIT 20" \
  --arg 1000000 --threads 8 --seconds 30
```

| 指标 | 基线 | 延迟关联 | 游标分页 |
|---|---|---|---|
| P50 | 2380 ms | 331 ms | **0.9 ms** |
| P95 | 2960 ms | 412 ms | **1.6 ms** |
| P99 | 3310 ms | 468 ms | **2.4 ms** |
| 吞吐 | 3.2 qps | 23.1 qps | **8000+ qps** |

把 `--arg` 换成 9990000（快翻到底）再跑，延迟几乎不变——这就是「与数据总量无关」的含义。

用 EXPLAIN ANALYZE 看真实执行过程：

```sql
EXPLAIN ANALYZE SELECT * FROM orders WHERE id > 1000000 ORDER BY id LIMIT 20\G
```

输出关键行（节选）：

```text
-> Limit: 20 row(s)  (actual time=0.571..0.94 rows=20)
    -> Filter: (orders.id > 1000000)  (actual rows=20)
        -> Index range scan on orders using PRIMARY  (actual rows=20)
```

`Index range scan` + `actual rows=20`：B+ 树直接定位，一步到位，没有浪费。

## 五、怎么验证「真的优化了」：四步验证法

光看耗时容易被缓存、预热等因素骗到，按这个清单来：

1. **EXPLAIN 看计划**：`type` 从 `index`（全索引扫描）变成 `range`（范围定位），或子查询出现 `Using index`；
2. **EXPLAIN ANALYZE 看实际行数**：确认 `actual rows` 从 100 万级降到 20 行，而不是「预估很美、实际照旧」；
3. **固定数据复跑压测**：造数用固定种子、压测前后 `SELECT COUNT(*)` 一致，保证对比公平；
4. **慢查询日志交叉验证**：`SET GLOBAL slow_query_log = ON; SET GLOBAL long_query_time = 0.5;`，确认基线 SQL 大量进慢日志、优化后消失。

## 六、常见坑与边界条件

1. **排序键不唯一，翻页会重复/丢行。** `ORDER BY created_at` 这种非唯一列，同一秒内多行的顺序在不同页之间不稳定，翻页时可能看到重复或漏数据。修法：`ORDER BY created_at, id`；游标分页用复合游标 `WHERE (created_at, id) > (:last_time, :last_id)`（MySQL 8.0.7+ 支持对这种元组比较做索引范围优化）。
2. **offset 分页期间有写入，页间会漂移。** 翻到第 2 页前插入了新数据，第 2 页会重复展示上页最后一行。游标分页对「游标之前」的插入天然免疫。
3. **游标分页不能跳页。** 产品坚持要「跳到第 N 页」，就用延迟关联 + 明确接受成本，或把大列表挪到 ES 这类搜索引擎，别硬扛在 MySQL 上。
4. **延迟关联没走覆盖索引 = 白改。** 必须 `EXPLAIN` 确认子查询 `Extra: Using index`。子查询里只要多带一列不在索引里的字段，覆盖索引立刻失效。
5. **`count(*)` 是隐藏的另一座山。** 分页接口经常还带 `SELECT COUNT(*)`，深数据量下它自己就要几百毫秒。能不数总数就不数（改「下一页」式交互），或缓存/近似统计。
6. **排序列上套函数，索引直接失效。** `ORDER BY DATE(created_at)` 会让排序退化成 filesort（内存/磁盘排序）。要按天排就单独存一列日期。
7. **压测造数不用固定种子，结果不可复现。** 本文所有 `RAND(x)` 都带种子，这是对比数据可信的前提。

## 七、总结

- `LIMIT offset, N` 的慢因是**扫过并丢弃 offset 行**，offset 越大越慢，`SELECT *` 的回表让问题加倍；
- **延迟关联**：拆「找 id」和「取数据」，实测约 7× 提速，支持跳页，但仍随 offset 线性变慢；
- **覆盖索引**：省回表，配合少数列查询有效，省不了扫描行数；
- **游标分页**：`WHERE id > ? ORDER BY id LIMIT n`，与数据总量无关，唯一根治方案，代价是不能跳页；
- 验证三板斧：EXPLAIN 计划 → EXPLAIN ANALYZE 实际行数 → 固定数据复跑压测，外加慢日志交叉验证；
- 上生产前先问产品一句：「这个列表真的需要跳页吗？」——答案决定用哪个方案。

## 参考资料

1. MySQL 8.0 Reference Manual — LIMIT Query Optimization：<https://dev.mysql.com/doc/refman/8.0/en/limit-optimization.html>
2. MySQL 8.0 Reference Manual — EXPLAIN Output Format（含 EXPLAIN ANALYZE）：<https://dev.mysql.com/doc/refman/8.0/en/explain-output.html>
3. 美团技术团队 — 《MySQL 索引原理及慢查询优化》：<https://tech.meituan.com/2014/06/30/mysql-index.html>
4. 数据库内核（阿里云等数据库内核团队知乎专栏）：<https://zhuanlan.zhihu.com/databasekernel>
5. Use The Index, Luke — We Need "No Offset"（keyset pagination 经典论述）：<https://use-the-index-luke.com/no-offset>
6. 《高性能 MySQL（第 3 版）》第 5 章「创建高性能的索引」，O'Reilly / 电子工业出版社
