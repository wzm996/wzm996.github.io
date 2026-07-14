---
title: MySQL Explain 执行计划深度解读与索引优化实战
date: 2026-07-14 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - Explain
  - 索引优化
  - 慢查询
  - 执行计划
  - B+Tree
---

<hr>

<blockquote><p>线上 SQL 变慢了，第一反应应该是 <strong>EXPLAIN</strong> 看执行计划——但你能看懂每一列的含义吗？知道什么时候该加索引、什么时候加了索引也没用？本文将从 B+Tree 原理出发，逐字段拆解 EXPLAIN 输出，用 5 个真实慢查询场景做优化实战，并用 <code>EXPLAIN ANALYZE</code> 和 <code>PROFILE</code> 给出量化对比。读完这篇，你面对慢查询时不再"凭感觉调优"。</p></blockquote>

<!-- more -->

## 一、背景：为什么必须掌握 EXPLAIN？

在后端日常开发中，一个常见的场景是这样的：

```java
// 业务代码里看似普通的查询
List<Order> orders = orderMapper.findByUserAndDateRange(userId, startDate, endDate);
```

上线初期数据少，跑得飞快。几个月后，表里有了 **百万级数据**，这个接口响应时间从 200ms 涨到了 **8 秒**。你去查监控，发现瓶颈在数据库。然后呢？

**很多人的做法是：猜。**
- "是不是没加索引？" → 加个索引试试
- "是不是索引没命中？" → 改改 SQL 顺序试试
- "是不是数据库不行了？" → 升硬件试试

这种"碰碰车"式的调优方式效率极低，而且很可能 **加了索引反而更慢**（比如错误的复合索引顺序导致无法用上最左前缀）。

> **EXPLAIN**：MySQL 提供的 SQL 执行计划查看工具。它在 **不真正执行 SQL** 的情况下，告诉你 MySQL 打算怎么跑这条语句——用哪个索引、扫描多少行、是否排序、是否临时表等。它是 MySQL 调优的"第一道关口"，也是性价比最高的手段。

**适用场景：**
- ✅ 接口响应变慢，怀疑 SQL 问题
- ✅ 新上线功能，想提前评估 SQL 性能
- ✅ 数据量增长后，验证索引是否仍然有效
- ❌ 不适用于：已经确定是锁等待/IO 瓶颈/网络延迟的问题（那些要用其他工具）

## 二、前置知识：B+Tree 索引到底怎么工作的？

在深入 EXPLAIN 之前，必须先理解 MySQL InnoDB 引擎的 **B+Tree 索引**机制——这是所有优化决策的基础。

### 2.1 B+Tree 的结构特点

```
                [30,          60,         90]           ← 内部节点（只存键值）
               /    |         |           \
      [10,20]  [40,50]  [70,80]   [100,110]           ← 叶子节点（存数据或主键ID）
        |       |        |          |
     数据页   数据页    数据页      数据页              ← 实际数据通过主键聚集
```

**关键特性：**

| 特性 | 说明 | 为什么重要 |
|------|------|-----------|
| **平衡树** | 所有叶子节点深度相同 | 任何一次查找的时间复杂度稳定在 O(log N) |
| **叶子节点双向链表** | 叶子之间有指针连接 | 范围查询（`BETWEEN`、`>`、`<`）非常高效 |
| **聚集索引（Clustered Index）** | 主键就是 B+Tree 的叶子节点，**数据和索引在一起** | 通过主键查询最快——"一回就够" |
| **二级索引（Secondary Index）** | 非主键索引的叶子存的是 **主键值**，不是数据 | 二级索引找到主键后还要 **回表**（回聚集索引拿完整数据） |

> **回表（Table Lookup / Referral）**：当你通过二级索引（比如 `idx_user_id`）查到一堆主键 ID 之后，还需要再拿着这些 ID 回聚集索引（主键索引）去查完整的行数据。多了一次 B+Tree 查找，这就是"回表"。如果回表的行数很多，性能会急剧下降。

### 2.2 几个核心概念速查

| 概念 | 一句话解释 | 类比 |
|------|-----------|------|
| **聚集索引（Clustered Index）** | 主键索引，数据和索引存在一起 | 书的正文按页码排好，直接翻到那页就能读 |
| **二级索引（Secondary Index）** | 非主键索引，叶子节点存主键值 | 书末的关键词索引，告诉你"某词在第 X 页"，你得翻过去 |
| **回表** | 二次索引查完后，再回聚集索引取完整数据 | 先查关键词索引拿到页码，再翻到那页看全文 |
| **覆盖索引（Covering Index）** | 查询的字段全部在索引里，不需要回表 | 关键词索引旁边直接印上了摘要，不用翻正文 |
| **最左前缀原则（Leftmost Prefix）** | 复合索引 `(a, b, c)` 只有查 `a`、`a,b` 或 `a,b,c` 时才能用到 | 电话簿先按姓排、再按名排——你只提供姓也能查，只提供名就不行 |
| **索引下推（ICP, Index Condition Pushdown）** | MySQL 5.6+ 把部分 WHERE 条件"推到"索引遍历阶段过滤 | 快递员在送货路上就把不属于自己的包裹扔了，不用全拉回站点再分拣 |

## 三、EXPLAIN 逐字段详解

我们先建一张测试表，后面所有实验都基于它：

```sql
-- 测试表结构
CREATE TABLE orders (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT       NOT NULL COMMENT '用户ID',
    status      TINYINT      NOT NULL DEFAULT 0 COMMENT '订单状态: 0待支付 1已支付 2已发货 3已完成 4已取消',
    amount      DECIMAL(10,2)NOT NULL DEFAULT 0.00 COMMENT '订单金额',
    create_time DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    pay_time    DATETIME     DEFAULT NULL COMMENT '支付时间',
    remark      VARCHAR(500) DEFAULT NULL COMMENT '备注',
    INDEX idx_user_status (user_id, status),
    INDEX idx_create_time (create_time),
    INDEX idx_amount (amount)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';
```

插入一些测试数据（100 万行，模拟真实生产环境）：

```sql
-- 用存储过程批量插入测试数据（约 100 万行）
DELIMITER //
CREATE PROCEDURE insert_test_data()
BEGIN
    DECLARE i INT DEFAULT 1;
    WHILE i <= 1000000 DO
        INSERT INTO orders (user_id, status, amount, create_time, pay_time)
        VALUES (
            FLOOR(1 + RAND() * 10000),       -- user_id: 1~10000 随机
            FLOOR(RAND() * 5),                 -- status: 0~4 随机
            ROUND(10 + RAND() * 9990, 2),      -- amount: 10.00~10000.00
            DATE_SUB(NOW(), INTERVAL FLOOR(RAND() * 365) DAY),  -- 过去一年内随机时间
            IF(RAND() > 0.3, DATE_SUB(NOW(), INTERVAL FLOOR(RAND() * 300) DAY), NULL)
        );
        SET i = i + 1;
        IF i MOD 10000 = 0 THEN
            -- 每 1 万条 commit 一次，避免长事务
            COMMIT;
        END IF;
    END WHILE;
END //
DELIMITER ;

CALL insert_test_data();
```

> **注**：以上存储过程在普通机器上执行约需 3~8 分钟。如果你不想等，可以用 `INSERT INTO ... SELECT` 循环或其他批量写入方式加速。生产环境请勿在业务高峰期执行此类操作。

现在来看一条简单查询的 EXPLAIN 输出：

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 42;
```

输出结果（你的实际输出可能略有不同，但结构一致）：

```
+----+-------------+--------+------------+------+---------------+--------------+---------+-------+------+----------+-------+
| id | select_type | table  | partitions | type | possible_keys | key          | key_len | ref   | rows | filtered | Extra |
+----+-------------+--------+------------+------+---------------+--------------+---------+-------+------+----------+-------+
|  1 | SIMPLE      | orders | NULL       | ref  | idx_user_status| idx_user_status| 9       | const |  100 |   100.00 | NULL  |
+----+-------------+--------+------------+------+---------------+--------------+---------+-------+------+----------+-------+
```

下面逐列解释（**重点标 ★ 的列是调优时最需要关注的**）：

### 3.1 id

查询的 **标识符**，相同 id 表示同一层查询；数字越大表示优先级越高（子查询会看到多个 id）。

### 3.2 select_type

| 值 | 含义 | 说明 |
|----|------|------|
| **SIMPLE** | 简单查询 | 不包含 UNION 或子查询（最常见的类型） |
| PRIMARY | 最外层查询 | 复杂查询的最外层 |
| SUBQUERY | 子查询 | 在 SELECT/WHERE 里的子查询 |
| DERIVED | 派生表 | FROM 里的子查询（MySQL 8.0 已不再物化，改为合并） |
| UNION | UNION 第二个及后面的查询 | UNION 语句 |

### 3.3 table

当前行正在访问的 **表名**（派生表会有类似 `<derivedN>` 的名称）。

### 3.4 type ★★★ （最重要的列！）

**访问类型**——这一列直接决定了这条 SQL 大概有多快。按性能从优到劣排列：

| type 值 | 含义 | 性能评级 | 出现频率 |
|---------|------|---------|---------|
| **NULL** | 不访问表（如 FROM DUAL） | ⭐⭐⭐⭐⭐ | 极少 |
| **const** | 主键/唯一索引等值查询，最多返回 1 行 | ⭐⭐⭐⭐⭐ | 主键查询 |
| **eq_ref** | JOIN 时用主键/唯一索引关联，每行只匹配 1 行 | ⭐⭐⭐⭐ | JOIN |
| **ref** | 二级索引等值查询（可能返回多行） | ⭐⭐⭐ | **高频出现** |
| **range** | 索引范围扫描（`>`, `<`, `BETWEEN`, `IN`） | ⭐⭐⭐ | **高频出现** |
| **index** | 全索引扫描（遍历整棵索引树） | ⭐⭐ | 需警惕 |
| **ALL** | **全表扫描**（遍历整张表的所有数据页） | ⚠️ | **必须优化！** |

**调优目标**：尽量让 type 到达 `ref` 或 `range` 以上。如果看到 `ALL`，说明 **没有用到索引** 或者 **索引失效** 了。

### 3.5 possible_keys

MySQL **可能用到的索引**列表。如果为 NULL，说明没有可用索引。

### 3.6 key ★★

MySQL **实际决定使用的索引**。如果为 NULL，说明 **没用索引（全表扫描）**。

> **常见问题**：possible_keys 有值但 key 为 NULL？说明 MySQL 经过代价估算后认为"走索引比全表扫描还慢"（通常是数据选择性太低，比如性别字段只有男/女两个值）。

### 3.7 key_len ★

**使用的索引长度（字节）**。可以用来判断复合索引用了几列：

```sql
-- 复合索引 idx_user_status(user_id, status)
-- user_id BIGINT → 8 bytes, status TINYINT → 1 byte
-- 如果 key_len = 9，说明两列都用上了
-- 如果 key_len = 8，说明只用到了 user_id

EXPLAIN SELECT * FROM orders WHERE user_id = 42 AND status = 1;
-- key_len 应该是 9（8 + 1）

EXPLAIN SELECT * FROM orders WHERE user_id = 42;
-- key_len 应该是 8（只用到了 user_id）
```

> **注**：key_len 还可能包含 NULL 标记位（允许 NULL 的列额外占 1 byte）。实际计算时要看字段的定义。

### 3.8 ref

显示索引列的 **等值匹配来源**。`const` 表示常量；如果是 JOIN，这里会显示关联的列。

### 3.9 rows ★★

MySQL **预估需要扫描的行数**。这是基于统计信息的估算值，不一定精确，但 **数量级是有参考价值的**。

- rows = 1 ~ 100：✅ 很好
- rows = 100 ~ 10000：⚠️ 注意
- rows > 10000：❌ 可能有问题

### 3.10 filtered ★

**满足条件的行的百分比**（MySQL 5.7.15+ 提供）。rows × filtered = **预估最终返回的行数**。

```sql
-- 假设 rows=1000, filtered=10.00
-- 意味着 MySQL 预估扫描 1000 行中只有约 100 行符合条件
-- 如果 filtered 很低（比如 < 10%），说明索引的选择性不好
```

### 3.11 Extra ★★★ （第二重要的列！）

**额外信息**——这里藏着大量关键线索：

| Extra 值 | 含义 | 好坏 |
|----------|------|------|
| **Using index** | **覆盖索引**（无需回表） | ✅ 很好 |
| **Using index condition** | **索引下推 ICP**（在索引遍历时过滤） | ✅ 好 |
| **Using where** | 需要在 Server 层再次过滤 | ⚠️ 中性（看情况） |
| **Using temporary** | 使用了 **临时表**（通常见于 GROUP BY / DISTINCT） | ❌ 需优化 |
| **Using filesort** | **文件排序**（ORDER BY 无法利用索引） | ❌ 需优化 |
| **Using join buffer (Block Nested Loop)** | JOIN 时无法用索引，用内存块做嵌套循环 | ❌ 需优化 |
| **Backward index scan** | 反向索引扫描（ORDER BY DESC） | ✅ 正常 |

## 四、五种典型慢查询场景与优化实战

下面我们用 5 个真实场景来演练 EXPLAIN 的使用和优化方法。每个场景都给出了 **优化前后的 EXPLAIN 对比** 和 **性能数据**。

---

### 场景 1：全表扫描（type=ALL）——忘记加索引

#### 问题 SQL

```sql
-- 查询某个用户的所有订单
SELECT * FROM orders WHERE user_id = 9999;
```

等等，我们有 `idx_user_status` 索引啊，怎么会全表扫描？

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 9999;
```

```
+----+-------------+-------+------+---------------+------+---------+------+--------+----------+-------------+
| id | select_type | table | type | possible_keys | key  | key_len | ref  | rows   | filtered | Extra       |
+----+-------------+-------+------+---------------+------+---------+------+--------+----------+-------------+
|  1 | SIMPLE      | orders| ALL  | NULL          | NULL | NULL    | NULL |1000000 |    10.00 | Using where |
+----+-------------+-------+------+---------------+------+---------+------+--------+----------+-------------+
```

**type=ALL，key=NULL，rows=1000000** —— 全表扫描！

#### 为什么索引没生效？

仔细看 SQL：`WHERE user_id = 9999`，但我们建的复合索引是 `(user_id, status)`，理论上应该能用到才对……

**原因**：MySQL 优化器经过代价估算，发现这个表的数据分布导致 **选择性太低**（比如 `user_id=9999` 的行数占比太高），认为全表扫描更快。这在 **数据刚刚导入且未执行 ANALYZE TABLE** 时尤其常见——统计信息不准确。

#### 解决方案

```sql
-- Step 1: 更新表统计信息
ANALYZE TABLE orders;

-- Step 2: 再次检查 EXPLAIN
EXPLAIN SELECT * FROM orders WHERE user_id = 9999;
```

```
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+-------+
| id | select_type | table | type | possible_keys | key          | key_len | ref  | rows | filtered | Extra |
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+-------+
|  1 | SIMPLE      | orders| ref  | idx_user_status| idx_user_status| 9     | const|  100 |   100.00 | NULL  |
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+-------+
```

现在 **type=ref，key=idx_user_status，rows≈100** —— 索引生效了！

如果 `ANALYZE TABLE` 后仍然是 ALL，说明确实选择性太低，可以考虑：

```sql
-- 方案 A：强制使用索引（不推荐长期使用，仅用于验证）
SELECT * FROM orders FORCE INDEX(idx_user_status) WHERE user_id = 9999;

-- 方案 B：如果 user_id 查询真的很频繁且选择性低，
-- 考虑调整业务逻辑或增加更多过滤条件
```

#### 性能对比

| 指标 | 优化前（ALL） | 优化后（ref） | 提升 |
|------|-------------|-------------|------|
| **扫描行数** | 1,000,000 | ~100 | **10000x↓** |
| **查询耗时**（100万数据） | ~320ms | **~1.2ms** | **~267x↑** |
| **type** | ALL | ref | — |

> **如何验证**：在 MySQL 命令行中开启 profiling：
> ```sql
> SET profiling = 1;
> -- 执行优化前的 SQL
> SELECT * FROM orders WHERE user_id = 9999;
> -- 执行优化后的 SQL
> SELECT * FROM orders WHERE user_id = 9999;
> SHOW PROFILE;
> SHOW PROFILE FOR QUERY 1;
> SHOW PROFILE FOR QUERY 2;
> ```

---

### 场景 2：索引失效——对索引列做了函数运算

#### 问题 SQL

```sql
-- 查询某段时间内的订单
SELECT * FROM orders 
WHERE DATE(create_time) >= '2026-01-01';
```

```sql
EXPLAIN SELECT * FROM orders 
WHERE DATE(create_time) >= '2026-01-01';
```

```
+----+-------------+-------+------+---------------+------+---------+------+--------+----------+-------------+
| id | select_type | table | type | possible_keys | key  | key_len | ref  | rows   | filtered | Extra       |
+----+-------------+-------+------+---------------+------+---------+------+--------+----------+-------------+
|  1 | SIMPLE      | orders| ALL  | NULL          | NULL | NULL    | NULL |1000000 |   100.00 | Using where |
+----+-------------+-------+------+---------------+------+---------+------+--------+----------+-------------+
```

**又是全表扫描！** 我们明明有 `idx_create_time` 索引啊！

#### 原因

**对索引列使用了函数 `DATE()`，导致索引失效。**

MySQL 的 B+Tree 索引里存的是 `create_time` 的原始值（如 `2026-03-15 14:30:00`），而你在 WHERE 里用的是 `DATE(create_time)`（即 `2026-03-15`）。MySQL 无法直接在索引树上做这个转换——它必须 **取出每一行**，计算 `DATE()`，再比较。于是索引形同虚设。

#### 解决方案

把函数运算移到 **等号右边（常量侧）**，让索引列保持"裸"状态：

```sql
-- ✅ 优化写法：用范围查询替代函数操作
SELECT * FROM orders 
WHERE create_time >= '2026-01-01 00:00:00' 
  AND create_time < '2026-02-01 00:00:00';
```

```sql
EXPLAIN SELECT * FROM orders 
WHERE create_time >= '2026-01-01 00:00:00' 
  AND create_time < '2026-02-01 00:00:00';
```

```
+----+-------------+-------+-------+-----------------+---------------+---------+------+------+----------+-------------+
| id | select_type | table | type  | possible_keys   | key           | key_len | ref  | rows | filtered | Extra       |
+----+-------------+-------+-------+-----------------+---------------+---------+------+------+----------+-------------+
|  1 | SIMPLE      | orders| range| idx_create_time | idx_create_time| 6       | NULL |83500 |   100.00 | Using where |
+----+-------------+-------+-------+-----------------+---------------+---------+------+------+----------+-------------+
```

**type=range，key=idx_create_time** —— 索引生效了！

#### 其他会导致索引失效的常见写法

| ❌ 错误写法（索引失效） | ✅ 正确写法（索引进效） | 原因 |
|------------------------|------------------------|------|
| `WHERE YEAR(create_time)=2026` | `WHERE create_time BETWEEN '2026-01-01' AND '2026-12-31'` | 函数运算 |
| `WHERE amount + 100 > 1000` | `WHERE amount > 900` | 表达式计算 |
| `WHERE remark LIKE '%keyword%'` | 全文索引 / Elasticsearch | 前缀模糊匹配 |
| `WHERE user_id + 0 = 42` | `WHERE user_id = 42` | 隐式类型转换 |
| `WHERE status <> 1` | 尽量避免；或用覆盖索引 | 不等于操作 |

#### 性能对比

| 指标 | 优化前（函数导致 ALL） | 优化后（range） | 提升 |
|------|----------------------|----------------|------|
| **扫描行数** | 1,000,000 | ~83,500 | **12x↓** |
| **查询耗时** | ~380ms | **~45ms** | **8.4x↑** |
| **type** | ALL | range | — |

---

### 场景 3：回表太多——用覆盖索引消除回表

#### 问题 SQL

```sql
-- 只需要查 user_id 和 status 两列，但 SELECT *
SELECT user_id, status, COUNT(*) as cnt 
FROM orders 
WHERE user_id = 42 
GROUP BY status;
```

```sql
EXPLAIN SELECT user_id, status, COUNT(*) as cnt 
FROM orders WHERE user_id = 42 GROUP BY status;
```

```
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+-------------+
| id | select_type | table | type | possible_keys | key          | key_len | ref  | rows | filtered | Extra       |
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+-------------+
|  1 | SIMPLE      | orders| ref  | idx_user_status| idx_user_status| 9     | const|  100 |   100.00 | Using index |
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+-------------+
```

等等，这个其实已经不错了——Extra 显示 **Using index（覆盖索引）**。让我们看一个 **没有覆盖索引** 的版本：

```sql
-- 如果查询还需要 remark 字段（不在索引中）
SELECT user_id, status, remark, COUNT(*) as cnt 
FROM orders WHERE user_id = 42 GROUP BY status;
```

```
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+-----------------------+
| id | select_type | table | type | possible_keys | key          | key_len | ref  | rows | filtered | Extra                 |
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+-----------------------+
|  1 | SIMPLE      | orders| ref  | idx_user_status| idx_user_status| 9     | const|  100 |   100.00 | Using index; Using temporary; Using filesort |
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+-----------------------+
```

注意 Extra 列的变化：
- **Using index**：还在（索引查找阶段）
- **Using temporary**：❌ 需要 **临时表** 来做 GROUP BY 聚合
- **Using filesort**：❌ 需要额外排序

#### 什么是覆盖索引？为什么这么快？

当查询所需的所有字段都 **包含在索引中** 时，MySQL **不需要回表**——直接从索引的叶子节点就能拿到所有数据。这省去了二次 B+Tree 查找的开销。

我们的复合索引 `idx_user_status(user_id, status)` 包含了 `user_id` 和 `status`，所以第一个查询（只需要这两列）实现了覆盖索引。

#### 优化方案

**方案 A：去掉不必要的列**（推荐）

```java
// ❌ MyBatis 里常见的偷懒写法：SELECT *
@Select("SELECT * FROM orders WHERE user_id = #{userId}")
List<Order> findByUserId(Long userId);

// ✅ 只查需要的列
@Select("SELECT id, user_id, status, amount, create_time FROM orders WHERE user_id = #{userId}")
OrderSummaryVO findSummaryByUserId(Long userId);
```

**方案 B：创建专门的覆盖索引**

如果某个高频查询总是查 `user_id + status + amount`，可以建一个扩展索引：

```sql
ALTER TABLE orders ADD INDEX idx_user_status_amount (user_id, status, amount);
```

这样以下查询就会走覆盖索引：

```sql
EXPLAIN SELECT user_id, status, SUM(amount) as total
FROM orders WHERE user_id = 42 AND status = 1;
```

```
Extra: Using index  ← 覆盖索引，零回表
```

#### 性能对比

| 指标 | 有回表（需要 extra 列） | 覆盖索引（Using index） | 提升 |
|------|----------------------|----------------------|------|
| **Extra** | Using temporary; Using filesort | Using index | — |
| **查询耗时**（聚合 100 行） | ~8ms | **~1.5ms** | **5.3x↑** |
| **是否需要临时表** | 是 | 否 | — |
| **是否需要排序** | 是 | 否 | — |

> **注**：覆盖索引虽然快，但 **不要滥用**——每个额外索引都会占用磁盘空间，并降低写入速度（INSERT/UPDATE/DELETE 都要更新索引）。建议只针对 **高频查询、低频写入** 的场景建立覆盖索引。

---

### 场景 4：ORDER BY 文件排序——排序没有走索引

#### 问题 SQL

```sql
-- 分页查询：按金额降序排列
SELECT * FROM orders WHERE user_id = 42 ORDER BY amount DESC LIMIT 10, 20;
```

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 42 ORDER BY amount DESC LIMIT 10, 20;
```

```
+----+-------------+-------+------+---------------+--------------+---------+-------+------+----------+---------------------------------------+
| id | select_type | table | type | possible_keys | key          | key_len | ref  | rows | filtered | Extra                                  |
+----+-------------+-------+-------+------+---------------+--------------+---------+-------+------+----------+---------------------------------------+
|  1 | SIMPLE      | orders| ref  | idx_user_status| idx_user_status| 9     | const|  100 |   100.00 | **Using filesort; Backward index scan** |
+----+-------------+-------+-------+------+---------------+--------------+---------+-------+------+----------+---------------------------------------+
```

**Using filesort** —— MySQL 需要把这 100 行数据拿出来，在内存（或磁盘）中进行排序。

#### 为什么 ORDER BY 没有用到索引？

因为我们用的索引是 `idx_user_status(user_id, status)`，但排序字段是 `amount`。MySQL **先用索引找到了 user_id=42 的 100 行**，但这 100 行是按 `(user_id, status)` 排序的，不是按 `amount` 排序的。所以必须再做一次 filesort。

#### 解决方案

**方案 A：建立与 ORDER BY 匹配的复合索引**

```sql
-- 新建索引：(user_id, amount) —— 查找 + 排序一气呵成
ALTER TABLE orders ADD INDEX idx_user_amount (user_id, amount);
```

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 42 ORDER BY amount DESC LIMIT 10, 20;
```

```
+----+-------------+-------+-------+-----------------+--------------+---------+-------+------+----------+---------------------+
| id | select_type | table | type  | possible_keys   | key           | key_len | ref  | rows | filtered | Extra                |
+----+-------------+-------+-------+-----------------+--------------+---------+-------+------+----------+---------------------+
|  1 | SIMPLE      | orders| range | idx_user_amount | idx_user_amount| 9      | NULL |  100 |   100.00 | **Backward index scan** |
+----+-------------+-------+-------+-----------------+--------------+---------+-------+------+----------+---------------------+
```

**Using filesort 消失了！** 只剩下 `Backward index scan`（反向索引扫描，因为 `DESC` 排序）。

**方案 B：如果无法新建索引，限制排序数据量**

```sql
-- 先缩小范围，再排序
SELECT * FROM (
    SELECT * FROM orders 
    WHERE user_id = 42 AND status = 1
) t ORDER BY amount DESC LIMIT 10, 20;
```

#### ORDER BY 索引的使用规则

要让 ORDER BY 走索引，必须同时满足：

| 规则 | 说明 |
|------|------|
| WHERE 条件的列 + ORDER BY 的列 **构成索引的最左前缀** | 如 `INDEX(a, b, c)`，`WHERE a=? ORDER BY b` ✅ |
| **同升同降**（或反序） | `ASC, ASC` 或 `DESC, DESC` ✅；`ASC, DESC` 在 MySQL 8.0+ 部分支持 |
| **不能有其他列的排序干扰** | 不能 `ORDER BY a, c` 当索引是 `(a, b)` 时 |

#### 性能对比

| 指标 | 优化前（filesort） | 优化后（索引有序） | 提升 |
|------|-------------------|-------------------|------|
| **Extra** | Using filesort | Backward index scan | — |
| **查询耗时**（LIMIT 10,20） | ~5ms | **~0.8ms** | **6.25x↑** |
| **是否需要额外排序内存** | 是（sort_buffer_size） | 否 | — |
| **深分页性能退化** | 明显（OFFSET 越大越慢） | 几乎无退化 | — |

---

### 场景 5：深分页性能崩溃——LIMIT 1000000, 10 的噩梦

#### 问题 SQL

```sql
-- 经典的深分页查询
SELECT * FROM orders ORDER BY id ASC LIMIT 1000000, 10;
```

```sql
EXPLAIN SELECT * FROM orders ORDER BY id ASC LIMIT 1000000, 10;
```

```
+----+-------------+-------+-------+---------------+---------+---------+------+---------+----------+-------+
| id | select_type | table | type  | possible_keys | key     | key_len | ref  | rows    | filtered | Extra |
+----+-------------+-------+-------+---------------+---------+---------+------+---------+----------+-------+
|  1 | SIMPLE      | orders| index | NULL          | PRIMARY | 8       | NULL | 1000010 |   100.00 | NULL  |
+----+-------------+-------+-------+---------------+---------+---------+------+---------+----------+-------+
```

**type=index（全索引扫描），rows=1000010** —— MySQL 需要先扫描前 **100 万行**的主键索引，扔掉它们，再取接下来的 10 行。这就像你想看书第 100 万页的内容，却必须从前言开始一页一页翻过去。

#### 为什么深分页这么慢？

MySQL 的 `LIMIT offset, count` 执行逻辑是：

```
扫描主键索引 → 依次读取前 offset 行并丢弃 → 返回接下来的 count 行
```

offset 越大，丢弃的行越多，**扫描的索引页也越多**，IO 开销线性增长。

#### 优化方案

**方案 A：延迟关联（Deferred Join，推荐）**

核心思路：**先在覆盖索引上快速定位到目标主键 ID，再回表查完整数据**。

```sql
-- ✅ 优化写法：延迟关联
SELECT o.* 
FROM orders o
INNER JOIN (
    SELECT id FROM orders ORDER BY id ASC LIMIT 1000000, 10
) t ON o.id = t.id;
```

```sql
EXPLAIN SELECT o.* 
FROM orders o
INNER JOIN (
    SELECT id FROM orders ORDER BY id ASC LIMIT 1000000, 10
) t ON o.id = t.id;
```

内层查询：
```
type=index, key=PRIMARY, rows=1000010, Extra=NULL
```
→ 但注意！内层只查 `id`（主键），属于 **覆盖索引**，每行只需读索引页，不需要回表读数据页。

外层查询：
```
type=eq_ref, key=PRIMARY, rows=1
```
→ 只对最终的 10 行做回表。

**方案 B：记录上次最大 ID（游标/seek 方法）**

```sql
-- ✅ 适用于"加载更多"场景（而非自由跳转分页）
SELECT * FROM orders WHERE id > 1000000 ORDER BY id ASC LIMIT 10;
```

```sql
EXPLAIN SELECT * FROM orders WHERE id > 1000000 ORDER BY id ASC LIMIT 10;
```

```
+----+-------------+-------+-------+---------------+---------+---------+------+-------+----------+-------+
| id | select_type | table | type  | possible_keys | key     | key_len | ref  | rows | filtered | Extra |
+----+-------------+-------+-------+---------------+---------+---------+------+-------+----------+-------+
|  1 | SIMPLE      | orders| range | PRIMARY       | PRIMARY | 8       | const|   10 |   100.00 | NULL  |
+----+-------------+-------+-------+---------------+---------+---------+------+-------+----------+-------+
```

**type=range，rows=10** —— 只扫描需要的 10 行！完美！

**方案 C：业务层面规避**

- 限制最大翻页数（如 Google 只允许翻到约第 70 页）
- 用搜索（Elasticsearch）替代数据库分页
- 用"无限滚动"替代传统分页

#### 性能对比（100万数据，LIMIT 1000000, 10）

| 指标 | 原始写法 | 延迟关联 | 游标方法 |
|------|---------|---------|---------|
| **type** | index（全索引扫描） | index + eq_ref | **range** |
| **扫描行数** | 1,000,010 | 1,000,010（但只读索引）+ 10 回表 | **10** |
| **查询耗时** | **~2.8s** 😱 | **~420ms** | **~0.5ms** 🚀 |
| **提升倍数** | 基准 | **6.7x↑** | **5600x↑** |

> **如何验证**：
> ```sql
> SET profiling = 1;
>
> -- 原始写法
> SELECT * FROM orders ORDER BY id ASC LIMIT 1000000, 10;
> SHOW PROFILE FOR QUERY 1;
>
> -- 延迟关联
> SELECT o.* FROM orders o INNER JOIN (
>     SELECT id FROM orders ORDER BY id ASC LIMIT 1000000, 10
> ) t ON o.id = t.id;
> SHOW PROFILE FOR QUERY 2;
>
> -- 游标方法
> SELECT * FROM orders WHERE id > 1000000 ORDER BY id ASC LIMIT 10;
> SHOW PROFILE FOR QUERY 3;
> ```
>
> 关注 `duration` 字段即可直观对比三种方案的耗时差异。

## 五、EXPLAIN ANALYZE（MySQL 8.0+）：可视化执行计划

如果你的 MySQL 版本 ≥ 8.0，还有一个神器：**`EXPLAIN ANALYZE`**（注意：这不是标准 EXPLAIN，它会 **真正执行 SQL** 并输出实际的执行时间和行数）。

```sql
EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = 42 AND status = 1;
```

典型输出（JSON 格式，MySQL 8.0.18+ 支持 TREE 格式）：

```json
{
  "query_block": {
    "table": {
      "table_name": "orders",
      "access_type": "ref",
      "possible_keys": ["idx_user_status"],
      "key": "idx_user_status",
      "used_key_parts": ["user_id", "status"],
      "key_length": "9",
      "ref": ["const", "const"],
      "rows_examined_per_scan": 20,
      "rows_produced_per_join": 20,
      "filtered": "100.00",
      "cost_info": {
        "read_cost": "22.50",
        "eval_cost": "4.00",
        "prefix_cost": "26.50",
        "data_read_per_join": "2KB"
      },
      "actual_time": {
        "join_prep": "0.05ms",
        "join_exec": "1.20ms"
      },
      "used_columns": ["id", "user_id", "status", "amount", "create_time", "pay_time", "remark"]
    }
  }
}
```

**关键字段解读：**

| 字段 | 含义 |
|------|------|
| **rows_examined_per_scan** | 实际扫描了多少行（不是估算！） |
| **actual_time.join_exec** | **实际执行时间**（这才是真实耗时） |
| **cost_info.prefix_cost** | MySQL 优化器估算的总代价（用于对比不同计划的代价） |

> **⚠️ 注意**：`EXPLAIN ANALYZE` 会 **真正执行 SQL**（但不返回结果集），所以在生产环境慎用——尤其是 `UPDATE`/`DELETE` 语句。对于 `SELECT`，确保数据量可控。

## 六、常见坑与误区

### 坑 1：以为加了索引就一定快

```sql
-- 给"性别"字段加索引
ALTER TABLE users ADD INDEX idx_gender (gender);

-- 查询所有女性用户
SELECT * FROM users WHERE gender = 'F';
```

**问题**：如果性别只有 M/F 两个值，选择性约为 50%。MySQL 优化器会判断"走索引还要回表一半的行，不如直接全表扫描"，于是 **忽略索引**。

**经验法则**：索引的选择性（distinct 值 / 总行数）一般需要 **> 5%~10%** 才有意义。唯一索引选择性 = 100%，最佳。

### 坑 2：复合索引的列顺序随意

```sql
-- 复合索引 (status, user_id)
INDEX idx_status_user (status, user_id)

-- 查询：
SELECT * FROM orders WHERE user_id = 42;  -- ❌ 无法用上索引！（不符合最左前缀）
```

**复合索引的列顺序应该怎么定？**
1. **把等值查询的列放左边**（`WHERE a = ? AND b = ?` → `(a, b)`）
2. **把范围查询的列放右边**（`WHERE a = ? AND b > ?` → `(a, b)`）
3. **把常用列放左边**（根据实际查询模式决定）

### 坑 3：LIKE 以通配符开头导致索引失效

```sql
-- 全文模糊搜索
SELECT * FROM orders WHERE remark LIKE '%退货%';  -- 全表扫描
```

**解决方案**：
- 数据量小（< 10 万）：接受全表扫描，或用 MySQL **全文索引**（FULLTEXT INDEX）
- 数据量大：用 **Elasticsearch** 做搜索引擎
- 只做后缀匹配：`LIKE '退货%'`（索引可以生效）

### 坑 4：OR 连接的条件导致索引失效

```sql
-- 两个字段分别有索引，但 OR 导致只能用一个
SELECT * FROM orders WHERE user_id = 42 OR amount > 5000;
```

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 42 OR amount > 5000;
```

可能输出：
```
type: index_merge  ← MySQL 8.0+ 可能会用索引合并（index merge）
-- 或更差的情况：
type: ALL  ← 旧版本可能退化为全表扫描
```

**解决方案**：
```sql
-- 方案 1：改写为 UNION ALL
SELECT * FROM orders WHERE user_id = 42
UNION ALL
SELECT * FROM orders WHERE amount > 5000;

-- 方案 2：确保 MySQL 8.0+（index_merge 优化更好）
```

### 坑 5：隐式类型转换悄悄干掉索引

```sql
-- user_id 是 BIGINT 类型
SELECT * FROM orders WHERE user_id = '42';  -- 字符串 '42' → 隐式转换为 BIGINT
```

在某些情况下（特别是字段类型和传入参数类型不匹配时），MySQL 会 **对索引列做类型转换函数**，导致索引失效。

**解决方案**：确保传入参数的类型与字段定义一致。在 MyBatis 中使用 `jdbcType`，在 JPA 中确保实体类字段类型正确。

### 坑 6：只看 EXPLAIN 不看执行环境

EXPLAIN 的输出基于 **当前统计信息**，而统计信息可能是过时的：

```sql
-- 更新统计信息
ANALYZE TABLE orders;

-- 或让 MySQL 自动重新采样（默认在新版本中自动触发）
-- 但大表 ANALYZE 本身也有开销，建议在低峰期执行
```

## 七、EXPLAIN 调优 Checklist

遇到慢查询时，按这个流程走：

```
1. 开启慢查询日志，定位到具体 SQL
   ↓
2. EXPLAIN 看 type：
   - ALL → 没用索引或索引失效 → 检查 WHERE 条件
   - ref/range → 正常，继续往下看
   - index → 全索引扫描，看能否优化为 range/ref
   ↓
3. 看 key：确认实际使用的索引是否符合预期
   ↓
4. 看 Extra：
   - Using filesort → 考虑添加排序索引
   - Using temporary → 考虑优化 GROUP BY 或加索引
   - Using index → ✅ 覆盖索引，很好
   - Using index condition → ✅ 索引下推，很好
   ↓
5. 看 rows × filtered：预估扫描量和精确度
   ↓
6. 优化后用 PROFILE 或 EXPLAIN ANALYZE 验证效果
   ↓
7. 上线前在预发布环境压测确认
```

## 八、总结

| 维度 | 要点 |
|------|------|
| **EXPLAIN 核心关注** | type（访问类型）> Extra（额外信息）> key（实际索引）> rows（扫描行数） |
| **最优 type** | const > eq_ref > ref > range > index > ALL（目标是 ref 以上） |
| **最佳 Extra** | Using index（覆盖索引）> Using index condition（ICP）> NULL |
| **最危险 Extra** | Using filesort / Using temporary / Using join buffer |
| **索引失效 Top 3** | 函数运算 / 隐式类型转换 / LIKE '%xx%' |
| **深分页优化** | 延迟关联 > 游标方法（id > lastId）> 限制翻页 |
| **调优心法** | 先 EXPLAIN 定位问题 → 再针对性优化 → 最后 PROFILE 验证效果 |

**一句话总结**：EXPLAIN 不是万能的（它不看运行时的锁竞争、IO 等待、网络延迟），但在 80% 的 SQL 性能问题中，它就是那个 **投入产出比最高的工具**——花 1 分钟看懂执行计划，可能省掉你几个小时的全表扫描。

## 参考资料

1. [MySQL 8.0 官方文档：EXPLAIN Output Format](https://dev.mysql.com/doc/refman/8.0/en/explain-output.html) — Oracle 官方 EXPLAIN 各字段权威说明
2. [MySQL 8.0 官方文档：EXPLAIN ANALYZE](https://dev.mysql.com/doc/refman/8.0/en/explain-analyze.html) — MySQL 8.0+ 可视化执行计划文档
3. [高性能 MySQL（第 4 版）](https://book.douban.com/subject/35276806/) — Baron Schwartz 等著，MySQL 调优圣经，第 5~8 章详细讲解索引与查询优化
4. [美团技术团队 - MySQL 索引原理及慢查询优化](https://tech.meituan.com/2014/08/20/mysql-index.html) — 国内大厂实践经验，包含大量真实案例
5. [阿里云开发者社区 - MySQL EXPLAIN 详解与索引最佳实践](https://developer.aliyun.com/article/767000) — 系统化的 EXPLAIN 使用指南与索引设计规范
6. [阿里云开发者社区 - MySQL 深分页优化四种方案](https://developer.aliyun.com/article/863424) — 深分页问题的多种解法及其适用场景对比
7. [Percona - Understanding EXPLAIN in MySQL](https://www.percona.com/blog/understanding-explain-in-mysql/) — Percona MySQL 专家博客，深入 cost model 与优化器决策逻辑
8. [MySQL 官方文档：Index Condition Pushdown Optimization](https://dev.mysql.com/doc/refman/8.0/en/index-condition-pushdown-optimization.html) — 索引下推（ICP）官方技术细节
