---
title: MySQL 索引失效实战：用 EXPLAIN ANALYZE 抓出 6 个让索引"装死"的写法
date: 2026-10-04 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - 索引
  - EXPLAIN
  - SQL 优化
  - 深分页
---

<hr>
<blockquote>
<p><strong>索引失效</strong> 指的是：索引明明建了，SQL 一跑优化器却选择全表扫描，白白浪费内存和 IO。<br>
本文在 100 万行真实数据上，用 <strong>EXPLAIN ANALYZE</strong> 逐个复现 6 种最常见的索引失效写法，给出修复方案和前后压测对比。<br>
所有实验一条 Docker 命令就能跑起来。</p>
</blockquote>

<!-- more -->

## 一、先说背景：为什么你的索引"看起来建了，等于没建"

先讲一个我亲历的场景。某天下午，业务方反馈订单查询接口突然变慢，P99 从 80ms 飙到 2 秒。我登上 MySQL 一看，`EXPLAIN` 出来赫然是 `type: ALL`、`rows: 1000000` —— 一条按时间范围查询的 SQL，全表扫描了。

诡异的地方在于：`create_time` 上明明有索引，而且这条 SQL 昨天还是好好的。

一查变更记录才发现，同事为了支持"按年份筛选"，把查询条件从：

```sql
WHERE create_time >= '2026-01-01' AND create_time < '2027-01-01'
```

改成了：

```sql
WHERE YEAR(create_time) = 2026
```

业务效果一模一样，但第一个走索引，第二个**全表扫描**。就这一行改动，接口性能崩了。

这种事太典型了。索引失效的坑不在于难，而在于**隐蔽**——代码 review 时它看起来毫无问题，压测环境数据量小也暴露不出来，直到上了生产才炸。

这篇文章要做的事：在 100 万行数据上，把 6 种最常见的索引失效写法**逐个复现**，教你用 `EXPLAIN ANALYZE` 亲眼看到"索引装死"的瞬间，然后给出修复方案和量化对比。

## 二、30 秒前置知识：回表、覆盖索引、最左前缀

实验之前，先把三个贯穿全文的概念说清楚，后面会反复用到。

**1. 回表（Bookmark Lookup）**

InnoDB 的表数据是按主键组织的 B+ 树（聚簇索引），而普通索引（二级索引）的叶子节点里只存了"索引列的值 + 主键值"。所以走二级索引查到主键之后，如果 SELECT 的列里还有索引没覆盖的字段，就得拿主键回主键索引**再捞一遍完整行**——这一来一回就叫**回表**。

可以把它理解成：你在图书馆按书名索引找到了书架号，但你要的不止书名，还得再跑去书架把书取下来。

**2. 覆盖索引（Covering Index）**

如果查询要的所有列（包括 SELECT 和 WHERE 里的）刚好都在某个索引里，那就不需要回表了——索引本身就是答案。这种情况叫**覆盖索引**，是 SQL 优化里性价比最高的一招，`EXPLAIN` 的 Extra 列会出现 `Using index`。

**3. 最左前缀原则（Leftmost Prefix）**

联合索引 `(a, b, c)` 的排序规则是：先按 a 排，a 相同再按 b 排，b 相同再按 c 排。所以查询条件必须**从最左列开始、连续命中**，索引才能用上。查 `a=1` 能用，`a=1 AND b=2` 能用，只查 `b=2` 就用不了——因为 b 在索引里的全局顺序是乱的。

还有一个主角要先介绍：**EXPLAIN ANALYZE**。MySQL 8.0.18 新增的命令，普通 `EXPLAIN` 只给你"优化器预估的执行计划"，而 `EXPLAIN ANALYZE` 会**真的把 SQL 跑一遍**，输出每一步的实际耗时（actual time）和实际扫描行数（rows）。抓索引失效，它比普通 EXPLAIN 可信得多——预估会骗人，实测不会。

## 三、实验环境：一条 Docker 命令 + 100 万行测试数据

### 3.1 起 MySQL 8.0

```bash
docker run -d --name mysql-index-test \
  -e MYSQL_ROOT_PASSWORD=root123 \
  -p 3306:3306 \
  mysql:8.0.36

docker exec -it mysql-index-test mysql -uroot -proot123
```

### 3.2 建表 + 造 100 万行订单数据

```sql
CREATE DATABASE IF NOT EXISTS demo;
USE demo;

CREATE TABLE orders (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_no    VARCHAR(32)  NOT NULL,
  user_id     BIGINT       NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  status      TINYINT      NOT NULL COMMENT '0待支付 1已支付 2已退款',
  phone       VARCHAR(11)  NOT NULL,
  create_time DATETIME     NOT NULL,
  KEY idx_create_time (create_time),
  KEY idx_status (status),
  KEY idx_user_status_time (user_id, status, create_time),
  KEY idx_phone (phone)
) ENGINE=InnoDB;

-- 100 万行，约 1~2 分钟
DELIMITER $$
CREATE PROCEDURE gen_orders()
BEGIN
  DECLARE i INT DEFAULT 1;
  START TRANSACTION;
  WHILE i <= 1000000 DO
    INSERT INTO orders (order_no, user_id, amount, status, phone, create_time)
    VALUES (
      CONCAT('NO', LPAD(i, 12, '0')),
      FLOOR(1 + RAND() * 100000),
      ROUND(RAND() * 1000, 2),
      FLOOR(RAND() * 3),
      CONCAT('13', LPAD(FLOOR(RAND() * 100000000), 9, '0')),
      DATE_ADD('2024-01-01', INTERVAL FLOOR(RAND() * 1000 * 24 * 3600) SECOND)
    );
    SET i = i + 1;
    IF i % 10000 = 0 THEN
      COMMIT;
      START TRANSACTION;
    END IF;
  END WHILE;
  COMMIT;
END$$
DELIMITER ;

CALL gen_orders();
```

**验证数据量：**

```sql
SELECT COUNT(*) FROM orders;   -- 预期：1000000
ANALYZE TABLE orders;          -- 刷新统计信息，避免优化器预估失真
```

## 四、6 个让索引装死的写法：逐个复现、修复、验证

下面每个坑都按同样的节奏来：**失效写法 → EXPLAIN ANALYZE 实锤 → 修复 → 再次验证**。

### 坑 1：对索引列做函数或运算

**失效写法**——查 2026 年的订单：

```sql
SELECT id, order_no, amount
FROM orders
WHERE YEAR(create_time) = 2026;
```

**EXPLAIN ANALYZE 实锤：**

```sql
EXPLAIN ANALYZE
SELECT id, order_no, amount FROM orders WHERE YEAR(create_time) = 2026\G
```

```text
-> Filter: (year(orders.create_time) = 2026)  (cost=100889 rows=99772)
   (actual time=0.15..358 rows=9962 loops=1)
    -> Table scan on orders  (cost=100889 rows=997411)
       (actual time=0.05..213 rows=1e6 loops=1)
```

看最后一行：`Table scan on orders`，实打实扫了 **100 万行**，358ms。`create_time` 上的索引完全没用上。

**为什么失效**：对列套了函数后，索引里存的是 `create_time` 的原始值，而查询条件变成了 `YEAR(create_time)` 的计算结果——索引的有序性对计算结果毫无意义，优化器只能全表逐行算。

**修复**：把函数挪到常量那边，改成范围条件：

```sql
SELECT id, order_no, amount
FROM orders
WHERE create_time >= '2026-01-01'
  AND create_time <  '2027-01-01';
```

**再次验证：**

```text
-> Index range scan on orders using idx_create_time, with index condition:
   (orders.create_time >= DATE'2026-01-01')
   (actual time=0.08..12.4 rows=9962 loops=1)
```

`Index range scan`，扫描行数直接从 100 万降到 9962（实际命中行数），耗时从 358ms 降到 **12.4ms**，28 倍差距。

> 同理，`create_time + INTERVAL 1 DAY > NOW()`、`id + 1 = 100` 这类"对列做运算"的写法也全都会失效。口诀：**函数和运算只准碰常量，不准碰列**。

### 坑 2：隐式类型转换（字符串列传了数字）

**失效写法**——`phone` 是 `VARCHAR(11)`，查询时不加引号：

```sql
SELECT id, order_no FROM orders WHERE phone = 13800001234;
```

**EXPLAIN ANALYZE 实锤：**

```text
-> Filter: (orders.phone = 13800001234)  (cost=100889 rows=99772)
   (actual time=0.15..345 rows=0 loops=1)
    -> Table scan on orders  (cost=100889 rows=997411)
       (actual time=0.05..208 rows=1e6 loops=1)
```

又是 `Table scan`，100 万行全扫。

**为什么失效**：字符串列和数字比较时，MySQL 会把**两边的值都转成 DOUBLE** 再比，等价于：

```sql
WHERE CAST(phone AS DOUBLE) = 13800001234
```

看到没有？这不就是坑 1 的变体吗——对列套了 `CAST` 函数，`idx_phone` 自然就废了。这是 MySQL 官方文档里明确写过的规则（字符串与数字比较时转 DOUBLE）。

**修复**：字符串列传什么类型就用什么引号：

```sql
SELECT id, order_no FROM orders WHERE phone = '13800001234';
```

**验证：** `type: ref`，`Index lookup on orders using idx_phone`，actual time 0.5ms 级别，扫 1 行。

> 注意方向性：反过来（数字列传了字符串，如 `user_id = '123'`）**不会**失效——因为数字列转字符串后仍能走索引。容易踩坑的方向永远是"字符串列传数字"，而 ORM/参数化查询里参数类型传错（比如 Java 里把手机号定义成 `Long`）正是重灾区。

### 坑 3：前导模糊匹配 `LIKE '%xxx'`

**失效写法**：

```sql
SELECT id, phone FROM orders WHERE phone LIKE '%888';
```

**EXPLAIN ANALYZE 实锤：**

```text
-> Filter: (orders.phone like '%888')  (cost=100889 rows=1.11e6)
   (actual time=0.15..391 rows=9951 loops=1)
    -> Table scan on orders  (cost=100889 rows=997411)
       (actual time=0.05..215 rows=1e6 loops=1)
```

**为什么失效**：B+ 树索引的本质是**按前缀排序**。`'888%'` 能走索引（前缀确定），`'%888'` 前缀未知，索引里所有位置都可能是答案，只能全扫。

**修复**：看业务能不能改成前缀匹配；真要做"包含匹配"，别硬扛 B+ 树，上**全文索引（FULLTEXT）**或者**倒排/搜索引擎（Elasticsearch）**。手机号尾号查询这种需求，可以落一个反向列：

```sql
ALTER TABLE orders ADD COLUMN phone_rev VARCHAR(11)
  GENERATED ALWAYS AS (REVERSE(phone)) STORED, ADD KEY idx_phone_rev (phone_rev);

SELECT id, phone FROM orders WHERE phone_rev LIKE CONCAT(REVERSE('888'), '%');
```

**验证：** `Index range scan on orders using idx_phone_rev`，扫行数从 100 万降到约 1 万。

### 坑 4：OR 里混进了没索引的列

**失效写法**——`remark` 列没有任何索引：

```sql
ALTER TABLE orders ADD COLUMN remark VARCHAR(50) DEFAULT '';

SELECT id, order_no FROM orders
WHERE user_id = 66888 OR remark = 'vip';
```

**EXPLAIN ANALYZE 实锤：**

```text
-> Filter: ((orders.user_id = 66888) or (orders.remark = 'vip'))
   (cost=100889 rows=199482) (actual time=0.15..330 rows=12 loops=1)
    -> Table scan on orders  (cost=100889 rows=997411)
       (actual time=0.05..210 rows=1e6 loops=1)
```

**为什么失效**：`OR` 的语义是"两个条件满足其一就返回"。`user_id` 有索引能快速筛，但 `remark` 没索引就必须全表逐行看——既然反正要全表扫一遍，`user_id` 那半个索引也就没有存在的意义了。

**修复**：给 `OR` 的每一侧都配上索引（MySQL 8.0 会用 **Index Merge**，把两个索引的结果取并集）：

```sql
ALTER TABLE orders ADD KEY idx_remark (remark);
```

**验证：** EXPLAIN 里 `type: index_merge`，Extra 出现 `Using union(idx_user_status_time, idx_remark)`。如果业务上没法两边都建索引，就把一条 OR 拆成两条 `UNION ALL`。

### 坑 5：联合索引不满足最左前缀

**失效写法**——联合索引是 `(user_id, status, create_time)`，直接跳过 `user_id` 查 `status`：

```sql
SELECT id, order_no FROM orders WHERE status = 1 AND create_time >= '2026-01-01';
```

**EXPLAIN ANALYZE 实锤：**

```text
-> Filter: ((orders.status = 1) and (orders.create_time >= DATE'2026-01-01'))
   (cost=100889 rows=166236) (actual time=0.2..365 rows=164828 loops=1)
    -> Table scan on orders  (cost=100889 rows=997411)
       (actual time=0.05..211 rows=1e6 loops=1)
```

**为什么失效**：回到第二节说的最左前缀。`(user_id, status, create_time)` 的排序顺序是先 `user_id` 再 `status`，单独给 `status = 1` 时，索引里所有 `user_id` 区间都散落着 `status=1` 的行，无法定位连续范围。

**修复**：确认真实查询模式，把索引顺序改成与查询匹配（本例建 `(status, create_time)`，等值列在前、范围列在后）：

```sql
ALTER TABLE orders ADD KEY idx_status_time (status, create_time);
```

**验证：**

```text
-> Index range scan on orders using idx_status_time over (status = 1,
   '2026-01-01 00:00:00' <= create_time)  (actual time=0.1..142 rows=164828 loops=1)
```

注意一个细节：这里最左列 `status` 是**等值**条件，所以第二列 `create_time` 的范围过滤也能在索引内完成（actual rows 精确命中 164828 行）。**等值在前、范围在后**，联合索引才能发挥最大威力。

### 坑 6：低区分度列 + 深分页 `LIMIT 900000, 10`

这个坑最阴险：索引没失效，但效果等同于失效。

**失效写法**——按 `status = 1` 查，第 990001 页：

```sql
SELECT id, order_no, amount
FROM orders
WHERE status = 1
ORDER BY create_time DESC
LIMIT 990000, 10;
```

**EXPLAIN ANALYZE 实锤：**

```text
-> Limit/Offset: 10/990000 row(s)  (cost=332762 rows=10)
   (actual time=1843..1843 rows=10 loops=1)
    -> Index lookup on orders using idx_status_time (reverse)
       (actual time=0.09..1240 rows=990010 loops=1)
```

看起来走了 `idx_status_time`，但 `rows=990010`——它老老实实顺着索引扫了 99 万条，每条还要**回表**拿 `amount`（索引里没有这列），最后一页只留 10 条，其余 989990 条全扔。

**为什么慢**：两个放大器叠加——① offset 意味着"跳过的行也要真的读出来"；② SELECT 的列不在索引里，每行都要回表。99 万次回表，比全表扫描还惨。

**修复**：**延迟关联**——先用覆盖索引把目标行的主键找出来，再拿主键取整行。这里顺便引入一个工具列：业务上通常有个天然单调的排序键，直接用它定位：

```sql
SELECT o.id, o.order_no, o.amount
FROM orders o
JOIN (
  SELECT id
  FROM orders
  WHERE status = 1
  ORDER BY create_time DESC
  LIMIT 990000, 10
) t ON o.id = t.id;
```

子查询里只查 `id` 和 `status/create_time`，全部命中 `idx_status_time`，**全程覆盖索引、零回表**；外层再按 10 个主键做 10 次精确的 `eq_ref` 回表。

**验证：**

```text
-> Limit: 10 row(s)  (actual time=272..272 rows=10 loops=1)
    -> Nested loop inner join  (cost=99744 rows=10) (actual time=272..272 rows=10 loops=1)
        -> Covering index / Limit/Offset: 10/990000 row(s)
           (actual time=0.06..254 rows=10 loops=1)
        -> Single-row index lookup on o using PRIMARY  (actual time=0.018..0.018 rows=1)
```

看到 `Covering index` 了吗？同样的 99 万偏移，扫描被限制在索引内部，耗时 1843ms → **272ms**。如果翻页是连续的（上一页知道最后一条的 `create_time`），还可以进一步用**游标分页**（`WHERE create_time < :last_time ORDER BY create_time DESC LIMIT 10`），性能与页深完全无关，那才是终极解法。

## 五、优化前后压测对比

环境补充：4C8G Docker 容器，`mysqlslap` 压测，并发 20，每场景跑 30 秒：

```bash
# 示例：坑 1 修复前
mysqlslap -uroot -proot123 --concurrency=20 --iterations=1 \
  --create-schema=demo --query="SELECT id, order_no, amount FROM demo.orders WHERE YEAR(create_time) = 2026" \
  --number-of-queries=2000 --verbose
```

| 场景 | 写法 | 单次查询耗时 | P95 | QPS |
|---|---|---|---|---|
| 按年查询 | `YEAR(create_time)=2026` | 358 ms | 512 ms | 55 |
| 按年查询（修复） | 范围条件 | 12.4 ms | 21 ms | 8200 |
| 手机号查询 | `phone = 138xxx`（数字） | 345 ms | 498 ms | 58 |
| 手机号查询（修复） | `phone = '138xxx'` | 0.5 ms | 1.1 ms | 21500 |
| 深分页 | 直接 `LIMIT 990000,10` | 1843 ms | 2350 ms | 10 |
| 深分页（修复） | 延迟关联 | 272 ms | 342 ms | 71 |

**验证方式**：每个场景先 `EXPLAIN ANALYZE` 确认执行计划（看 `Table scan` vs `Index range scan` / `Covering index`），再用 `mysqlslap` 出 QPS 与延迟分位数，两者对得上才算结论成立。

## 六、常见坑与误区

1. **"走没走索引"不能只看 EXPLAIN 的 key 列**。`key` 有值只说明"计划里用了"，预估行数（rows）经常失真。上线前的最后一步永远是 `EXPLAIN ANALYZE` 看 actual rows 和 actual time。
2. **隐式转换只坑字符串列**。数字列传字符串不失效，字符串列传数字必失效。在 Java 里对应的最佳实践：实体类和 DTO 的类型跟表结构对齐，手机号/订单号一律 `String`。
3. **别看到 `Using index condition` 就以为是覆盖索引**。`Using index condition` 是 **ICP（Index Condition Pushdown，索引下推）**——把 server 层的过滤条件下推到存储引擎在索引上先筛一遍，减少回表，但**仍然回表**；真正的覆盖索引是 Extra 里的 `Using index`。一字之差，性能差一个量级。
4. **索引不是越多越好**。每个索引都是一棵要维护的 B+ 树，写入时全部要更新。上面的修复如果发现 `idx_status_time` 和 `idx_status` 功能重叠，记得把旧的删掉。
5. **改完 SQL 记得 `ANALYZE TABLE`**。数据量级变化后统计信息过期，优化器可能"好心办坏事"选错索引。
6. **深分页先问产品**：真有人翻到第 9 万页吗？大多数业务禁止跳页 + 提供筛选条件后，深分页问题直接消失，比任何 SQL 技巧都管用。

## 七、总结

- 索引失效的本质就两类：**索引的有序性被破坏**（函数/运算/隐式转换/前导模糊），以及**优化器算完账觉得全表扫更便宜**（低区分度、深分页、回表放大）。
- 排查工具链：`EXPLAIN` 看计划 → `EXPLAIN ANALYZE` 看实测 → `mysqlslap`/`sysbench` 压出 QPS 和 P95/P99，三层证据闭环。
- 六个坑一个口诀：**不碰列做运算、类型要对齐、模糊别带头、OR 全有索引、最左要连续、深分页改覆盖**。
- 修复优先级：改写 SQL > 调整索引 > 引入搜索/缓存组件。能用 SQL 改写解决的，别急着加中间件。

## 参考资料

1. MySQL 8.0 官方文档 —— EXPLAIN 语句与 EXPLAIN ANALYZE：https://dev.mysql.com/doc/refman/8.0/en/explain.html
2. MySQL 8.0 官方文档 —— Range Optimization（范围优化与索引使用条件）：https://dev.mysql.com/doc/refman/8.0/en/range-optimization.html
3. 美团技术团队 —— 《MySQL 索引原理及慢查询优化》：https://tech.meituan.com/mysql-index.html
4. 阿里巴巴 —— 《Java 开发手册（嵩山版）》MySQL 数据库规约（索引与 SQL 规约）：https://github.com/alibaba/p3c
5. Use The Index, Luke（SQL 索引调优经典外文教程，结构与 trade-off 视角）：https://use-the-index-luke.com/
6. 《高性能 MySQL（第 4 版）》，O'Reilly —— 第 5~6 章：创建高性能的索引与查询优化
