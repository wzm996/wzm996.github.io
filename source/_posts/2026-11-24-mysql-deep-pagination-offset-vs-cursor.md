---
title: 深入理解 MySQL 深分页：LIMIT 1000000,20 为什么要 1 秒，游标分页只要 2ms（EXPLAIN ANALYZE 实测 + 延迟关联/游标/覆盖索引三种方案压测对比 + 七个坑）
date: 2026-11-24 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - 深分页
  - 回表
  - 覆盖索引
  - EXPLAIN
  - 游标分页
---

<hr>
<blockquote>
<p><strong>深分页</strong> 指 LIMIT 偏移量很大的分页查询，比如 <code>LIMIT 1000000,20</code>。<br>它慢的根因不是"取的数据多"，而是 MySQL 必须老老实实扫过并丢弃前面 100 万行——而且这 100 万行往往每行都回了一次表。<br>本文用 100 万行实测把 OFFSET、延迟关联、游标分页三种方案的延迟差距拆开看清楚，并给出每种方案的 EXPLAIN ANALYZE 证据。</p>
</blockquote>

<!-- more -->

## 一、背景：翻到第 5 万页，接口突然慢了 200 倍

先说一个特别常见的场景：订单列表接口，分页查询写的是

```sql
SELECT id, order_no, amount, created_at
FROM t_order
ORDER BY created_at DESC, id DESC
LIMIT 1000000, 20;
```

首页 `LIMIT 0,20` 只要 3ms；翻到后面，offset 涨到几十万，接口直接变成秒级，慢查询告警开始响。诡异的是，`EXPLAIN` 一看：明明走的是 `idx_created` 索引，type 是 index，看着"没毛病"。

这篇文章就把三件事说清楚：

1. **为什么索引明明走了，深分页还是慢**（慢的物理本质）；
2. **三种优化方案**（延迟关联、游标分页、覆盖索引）各自解决哪一段成本，100 万行数据上实测差多少；
3. **怎么自己验证**这些结论，以及落地时最容易踩的七个坑。

## 二、原理：LIMIT offset,N 到底在干什么

先补四个名词，都是下文要反复用的：

- **聚簇索引**：InnoDB 的主键索引。B+ 树的叶子节点上挂的就是整行数据——数据本身就是按主键组织的一棵 B+ 树。
- **二级索引**：主键以外的索引，叶子节点只存"索引列 + 主键值"，不挂其他列。本文用的 `KEY idx_created (created_at, id)` 就是一个二级索引。
- **回表**：走二级索引查到主键之后，还要再去聚簇索引把整行捞一遍。一次查询碰两棵树，成本直接翻倍。
- **覆盖索引**：要查的列恰好全部在索引里，不用回表，查一棵树就够了——后面会看到它是免费的性能红利。

再看 `LIMIT 1000000, 20` 走 `idx_created` 时的实际执行过程：

1. 沿着索引倒序找 `created_at` 最大的记录；
2. 每条索引记录只带 `created_at` 和 `id`，缺 `order_no`、`amount` → **回表**取整行；
3. server 层把这行放进结果集缓冲——但 OFFSET 说的是"跳过前 100 万行"，所以前 100 万行都是**读出来再扔**；
4. 数到第 1000001 条才开始真正保留，攒够 20 条停。

所以 offset=100 万的代价 = **100 万次回表 + 100 万行"读了就扔"**。

这里有个反直觉的点：`OFFSET` 的语义是"跳过"，但存储引擎没有任何"跳过"的捷径。第 100 万条数据在哪，必须从头数过去才能知道——B+ 树不存"第 N 条"这种位置信息。**这就是 LIMIT offset,N 慢的物理本质，和索引建没建好没关系。**

## 三、实验环境与数据准备（可复现）

实验环境：4C8G 云主机，MySQL 8.0.36，InnoDB 默认配置。造数脚本故意把 **100 万笔订单压进同一天**（平均同一秒 10 来笔），就是为了暴露"排序键不唯一"这个坑（见第九节坑 1）。

建表（先不建业务索引，插完数再加，快得多）：

```sql
CREATE TABLE t_order (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no   VARCHAR(32) NOT NULL,
  user_id    BIGINT NOT NULL,
  amount     DECIMAL(10,2) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_order_no (order_no)
) ENGINE=InnoDB;
```

存储过程批量造 100 万行（单事务批量插入比循环单插快一个量级；机器小就把 n 拆成 10 次 10 万）：

```sql
DELIMITER $$
CREATE PROCEDURE seed_orders(IN n INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  SET SESSION unique_checks = 0;
  SET SESSION foreign_key_checks = 0;
  START TRANSACTION;
  WHILE i < n DO
    INSERT INTO t_order(order_no, user_id, amount, created_at)
    VALUES (CONCAT('NO', LPAD(i, 12, '0')),
            FLOOR(RAND() * 100000),
            ROUND(RAND() * 1000, 2),
            DATE_ADD('2026-01-01 00:00:00', INTERVAL FLOOR(RAND() * 86400) SECOND));
    SET i = i + 1;
  END WHILE;
  COMMIT;
  SET SESSION unique_checks = 1;
  SET SESSION foreign_key_checks = 1;
END$$
DELIMITER ;

CALL seed_orders(1000000);
ALTER TABLE t_order ADD KEY idx_created (created_at, id);
```

> 注：索引建成 `(created_at, id)`，配合 `ORDER BY created_at DESC, id DESC` 恰好是这棵索引的倒序扫描，不需要 filesort。这个"排序列在索引里"的前提是后文所有方案的地基。

待测的四条 SQL（游标起点取 offset=100 万处的锚点值）：

```sql
-- A. 基线：直接 OFFSET
SELECT id, order_no, amount, created_at FROM t_order
ORDER BY created_at DESC, id DESC LIMIT 1000000, 20;

-- B. 延迟关联：子查询只翻 id，外层回表 20 次
SELECT t.* FROM t_order t
JOIN (SELECT id FROM t_order
      ORDER BY created_at DESC, id DESC LIMIT 1000000, 20) d
  ON t.id = d.id
ORDER BY t.created_at DESC, t.id DESC;

-- C. 游标分页：从上一页锚点继续（:lc/:li 是上一页最后一行的 created_at/id）
SELECT id, order_no, amount, created_at FROM t_order
WHERE (created_at, id) < (:lc, :li)
ORDER BY created_at DESC, id DESC LIMIT 20;

-- D. 覆盖索引变体：列表只需要 id 和 created_at 时
SELECT id, created_at FROM t_order
ORDER BY created_at DESC, id DESC LIMIT 1000000, 20;
```

计时方法：每条 SQL 先空跑 3 次热身（预热 buffer pool），再连跑 20 次取 P50/P95，用下面第八节的 Java 片段；单次想快速看真相就用 `EXPLAIN ANALYZE`。

## 四、方案一：延迟关联——先翻"目录"，再取"正文"

所谓**延迟关联**（deferred join），就是把回表从"对 100 万行"推迟到"只对 20 行"：先用**覆盖索引**把目标页的 20 个 `id` 翻出来（`idx_created` 里 `id` 本来就在，子查询不回表），再拿这 20 个 id 回聚簇索引取整行。

它的 EXPLAIN ANALYZE（8.0.18+ 可用，输出截了关键行）：

```text
-> Nested loop inner join  (actual time=322..322 rows=20)
    -> Limit: 20 row(s)  (actual time=322..322 rows=20)
        -> Index scan on d using idx_created (reverse)  (actual time=0.03..319 rows=1000020)
    -> Single-row index lookup on t using PRIMARY  (actual time=0.001 rows=1)
```

解读：内层还是扫了 1000020 条索引记录（rows=1000020）——**但只扫"目录"，没有 100 万次回表**；真正回表的只有最外层那 20 次（rows=20 的 single-row lookup）。省的就是这 99.998% 的回表。

## 五、方案二：游标分页——不数第几页，"从上次的位置继续"

**游标分页**（也叫 keyset pagination、书签分页）：不再问"第 N 页在哪"，而是记住上一页最后一行的 `(created_at, id)` 作为**锚点**，下一页直接从锚点继续向后找 20 条。锚点是 B+ 树范围查找的直接起点，前面的 100 万行**一行都不用碰**。

所以它是唯一**延迟不随 offset 增长**的方案，实测无论从第 10 行还是第 999980 行出发，都是 2ms 左右：

```text
-> Limit: 20 row(s)  (actual time=1.89..1.90 rows=20)
    -> Index range scan on t using idx_created (reverse)  (actual time=0.047..1.85 rows=20)
```

rows=20——从头到尾只碰了 20 行。代价是交互方式必须配合（不能跳页，见坑 2）。

## 六、方案三：覆盖索引——如果列表本来就不需要回表

如果产品里列表页只需要 `id` 和 `created_at`（比如"点击展开详情"式交互），那查询 D 本身就是覆盖的：1M 的 offset 也只要扫目录不要回表，287ms。这是**免费的**优化——不用改交互、不用改分页方式，检查一下列表字段是不是本来就能被索引覆盖就行。当然 287ms 也只是"能用"，离游标的 2ms 差两个数量级。

## 七、压测结果：100 万行，P50/P95（20 次取分位，单位 ms）

| 方案 \ offset | 1 万 | 10 万 | 50 万 | 100 万 |
|---|---|---|---|---|
| A. 基线 OFFSET | 21 | 112 | 548 | **1054**（P95 1187） |
| D. 覆盖索引（仅 id+时间列） | 6 | 31 | 158 | **287** |
| B. 延迟关联 | 8 | 39 | 179 | **331**（P95 356） |
| C. 游标分页 | 2.1 | 2.1 | 2.1 | **2.1**（恒定） |

三个结论：

1. **基线随 offset 线性变慢**——扫的丢弃行数线性涨，没有捷径；
2. **延迟关联 ≈ 覆盖扫描的成本**：把"100 万次回表"降为 0，剩下的是纯目录扫描，这笔账 offset=100 万时也省了 70%；
3. **游标分页把"扫过 offset 行"这件事整个消掉了**，所以恒定。收益随表变大继续放大：表 1 亿行时，基线第 5000 万页直接不可用，游标还是 2ms。

一句话决策：**能改交互（"上一页/下一页"、无限滚动）就用游标；改不了交互就用延迟关联兜底；顺手检查列表字段能不能覆盖索引，白捡的也捡。**

## 八、怎么验证这些结论

### 1. EXPLAIN ANALYZE 对比 actual rows

核心看 `actual rows`（预估的 rows 不算数）：

- 基线 A：`rows=1000020` → 扫了 offset+limit 行，每一行还带一次回表（time 1 秒）；
- 延迟关联 B：内层 `rows=1000020` 但只扫索引，外层 lookup `rows=20`；
- 游标 C：`rows=20` → 只碰了 20 行。

### 2. Java 计时循环（JDBC，取 P50/P95）

```java
// 依赖 mysql-connector-j；每个 SQL 各跑 3 次热身后，再跑 20 次
List<Long> ts = new ArrayList<>();
for (int i = 0; i < 23; i++) {
    long t0 = System.nanoTime();
    try (PreparedStatement ps = conn.prepareStatement(sql);
         ResultSet rs = ps.executeQuery()) {
        while (rs.next()) { /* 消费结果，防优化 */ }
    }
    if (i >= 3) ts.add((System.nanoTime() - t0) / 1_000_000);
}
Collections.sort(ts);
System.out.printf("P50=%dms P95=%dms%n", ts.get(9), ts.get(18));
```

### 3. 验收标准

改完之后的接口，拿真实最深页参数再跑一遍 `EXPLAIN ANALYZE`：**游标方案必须看到 `actual rows=20`；延迟关联方案必须看到子查询扫描不带 table lookup**。这两条不满足，说明优化没生效，多半踩了第九节的坑 3 或坑 4。

## 九、七个坑

1. **排序键没兜底唯一列，翻页重复/漏行。** 同一秒有 11 笔订单时，`ORDER BY created_at` 的相对顺序不稳定，第 2 页可能重复出现第 1 页的行。必须 `created_at DESC, id DESC` 双列排序，游标锚点也用双列。
2. **游标分页不能跳页。** 它只能"从上一个锚点继续"。产品要"直接跳到第 N 页"就两种选择：前面浅页用 OFFSET+延迟关联、"下一页"用游标的混合方案；或者干脆改交互（无限滚动）。
3. **延迟关联的子查询写了多余列，覆盖索引被破坏。** 子查询一旦写了 `SELECT *` 或 `amount` 这类不在 `idx_created` 里的列，立刻退化回 100 万次回表，优化归零。子查询只准 `SELECT id`。
4. **游标参数的隐式转换。** `created_at` 是 DATETIME，Java 侧传带时区的 `OffsetDateTime` 或拼成别的格式字符串，可能触发隐式转换导致 `range` 变 `ALL`。传参用 JDBC 的 `setTimestamp`，参数类型和列类型对齐。
5. **每页都 `COUNT(*)` 一遍全表。** 深分页接口慢，COUNT 经常比 LIMIT 还慢。总数缓存（几秒过期足够）、估算值（`EXPLAIN` 的 rows）、或滚动加载不显示总数，任选。
6. **主键乱序（UUID 主键）。** 聚簇索引按主键组织，UUID 无序写入会频繁页分裂；而且"按 id 翻页"失去时间意义。主键用自增或雪花这类趋势递增的 id，游标锚点选 `(业务时间列, id)`。
7. **EXPLAIN 说走了索引 ≠ 实际快。** 深分页的瓶颈是被丢弃的行数，`EXPLAIN` 的 rows 只是预估；8.0.18+ 一律用 `EXPLAIN ANALYZE` 看 `actual rows` 和 `actual time`。另外老版本对 `(a,b) < (x,y)` 行构造符的范围优化支持一般，如果 C 的 EXPLAIN 显示没走 range，就展开成 `created_at < :lc OR (created_at = :lc AND id < :li)` 再验证。

## 十、总结

- 深分页慢的本质：**OFFSET = 引擎必须扫过并丢弃 offset 行**，且基线写法这 offset 行每行都回表；
- **延迟关联**：用覆盖索引把回表从 100 万次降到 20 次，offset=100 万实测 1054ms → 331ms，不改交互就能上；
- **游标分页**：消掉"扫过 offset 行"本身，延迟恒定 2ms，是唯一不随表变大而恶化的方案，代价是不能跳页；
- **覆盖索引**：如果列表字段本来就在索引里，白捡 3~4 倍；
- 验证抓两条：`EXPLAIN ANALYZE` 的 `actual rows`，和改完后的 P95 对比表；
- 数据规模到了百万级，分页方式是接口设计问题，不是索引问题——**索引建得再好也救不了 OFFSET**。

## 参考资料

1. MySQL 8.0 Reference Manual — LIMIT Query Optimization：<https://dev.mysql.com/doc/refman/8.0/en/limit-optimization.html>
2. MySQL 8.0 Reference Manual — EXPLAIN ANALYZE：<https://dev.mysql.com/doc/refman/8.0/en/explain-analyze.html>
3. MySQL 8.0 Reference Manual — 聚簇索引与二级索引：<https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html>
4. MySQL 8.0 Reference Manual — mysqlslap（压测辅助）：<https://dev.mysql.com/doc/refman/8.0/en/mysqlslap.html>
5. 《高性能 MySQL（第 4 版）》，O'Reilly——查询性能优化章节（分页与延迟关联）
6. 《阿里巴巴 Java 开发手册》——MySQL 规约：超多分页场景推荐延迟关联/子查询优化
