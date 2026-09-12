---
title: MySQL 事务隔离级别别再背表了：两个终端复现脏读、不可重复读和幻读，顺带把 MVCC 讲透
date: 2026-09-12 10:00:00
categories:
  - 数据库与存储
  - 事务与一致性
tags:
  - MySQL
  - InnoDB
  - MVCC
  - 事务
  - 隔离级别
  - 实战复现
---
<hr>
<blockquote>
<p><strong>一句话结论</strong>：隔离级别那张「四象限背诵表」不亲手做一遍实验，背了也会忘。<br>本文用 <strong>两个终端 + MySQL 8.0（Docker 一行命令起）</strong>，把<strong>脏读、不可重复读、幻读</strong>在 READ UNCOMMITTED / READ COMMITTED / REPEATABLE READ 下一一复现，再顺手拆开 <strong>MVCC（多版本并发控制）</strong>的引擎盖：版本链、ReadView、快照读与当前读，最后用 <strong>performance_schema.data_locks</strong> 亲眼看一次<strong>间隙锁</strong>把别的会话堵在门外，并给出 RC vs RR 的 sysbench 压测复现步骤。每一步都给了预期输出，跑一遍就再也忘不掉。</p>
</blockquote>

<!-- more -->

## 一、背景：为什么「背表」解决不了线上问题

面试时人人会背：READ UNCOMMITTED 有脏读，READ COMMITTED 防脏读，REPEATABLE READ 防不可重复读……但一到线上就露怯：

- 「测试说同一个页面刷新两次，金额变了」——这是 bug 吗？可能只是 RR 下两个连接读的时机不同；
- 「我把隔离级别从 RR 改成 RC，为什么 DBA 拦着我要求确认 binlog 格式？」；
- 「一个 UPDATE 卡了 50 秒报了 lock wait timeout，谁锁的我？」。

这些问题，靠背表答不出来，靠亲手复现一遍就全明白了。这篇就带你把三种读异常和 InnoDB 的 MVCC 机制<strong>用实验钉进脑子里</strong>。

先统一口径，三个「读异常」用大白话定义（假设有两个事务 A、B 在并发）：

- **脏读**：A 读到了 B<strong>还没提交</strong>的数据，结果 B 回滚了，A 拿着一张空头支票往下跑。
- **不可重复读**：A 在同一个事务里读了两次同一行，中间 B 把这行<strong>改了并提交</strong>，A 两次读到的值不一样。针对的是 <strong>UPDATE/DELETE</strong>。
- **幻读**：A 同一个事务里按同一条件查了两次，中间 B <strong>INSERT 了一行新数据并提交</strong>，A 第二次多出了一行「幻影」。针对的是 <strong>INSERT</strong>。

而**隔离级别（Isolation Level）**就是事务之间「互不打扰」程度的刻度：刻度越低，并发性能越好，但能看到的「别人家的数据」越多。SQL 标准划了四档：READ UNCOMMITTED（读未提交）、READ COMMITTED（读已提交，下称 RC）、REPEATABLE READ（可重复读，下称 RR）、SERIALIZABLE（串行化）。

> 注：MySQL InnoDB 的默认隔离级别是 **RR**。很多从 Oracle/PostgreSQL 转过来的同学默认按 RC 思维写代码，这是两个生态的一个经典思维差异。

## 二、原理：InnoDB 靠什么同时做到「不互相堵」和「看得对」

InnoDB 在 RC/RR 下主要不靠「加锁挡读」，而是靠 **MVCC（Multi-Version Concurrency Control，多版本并发控制）**。用一句口语化的话说：**给每一行数据保留历史版本，读的人看自己该看的那张「照片」，写的人改最新版，读和写互不阻塞。**

拆开说，它由三样东西组成：

### 2.1 版本链：每行数据都是「一条历史记录串」

InnoDB 每行数据背后藏着两个看不见的列：

- `DB_TRX_ID`：最后修改（插入/更新）这行的事务 ID；
- `DB_ROLL_PTR`：回滚指针，指向这行的上一个版本。

而上一个版本存在哪？答案是 **undo log**——它你可以理解成 InnoDB 的「草稿纸 + 回收站」：事务回滚时用它还原数据，MVCC 靠它串出整条版本链。你每次 UPDATE，老版本就被挪到 undo log 里，新版本通过回滚指针「牵着」老版本，形成一条链。

### 2.2 ReadView：决定「你能看到哪个版本」的取景框

读事务开始拍照时，InnoDB 会拍一张 **ReadView**，里面记着拍照那一刻「还有哪些事务活着」（没提交）。核心就四个字段：

| 字段 | 含义（大白话） |
| --- | --- |
| `m_ids` | 拍照那一刻所有**活跃（未提交）**事务的 ID 集合 |
| `min_trx_id` | 活跃事务里最小的 ID（低水位） |
| `max_trx_id` | 系统将要分配给**下一个**事务的 ID（高水位） |
| `creator_trx_id` | 创建这个 ReadView 的事务自己 |

拿一个数据版本的 `trx_id` 对着 ReadView 判断可见性：

1. `trx_id == creator_trx_id`：自己改的，可见；
2. `trx_id < min_trx_id`：改它的事务在拍照前就提交了，可见；
3. `trx_id >= max_trx_id`：改它的事务在拍照后才开始，不可见；
4. 在中间：查 `m_ids`，还在活跃名单里→不可见；不在→已提交，可见。

不可见怎么办？顺着 `DB_ROLL_PTR` 沿版本链往回找，直到找到一个可见的版本。

**关键差异来了，也是本文最重要的一句话**：

- **RC**：每执行一条 SELECT，就重新拍一张 ReadView → 别人一提交，你下一条查询立刻能看见 → 所以会「不可重复读」；
- **RR**：整个事务只在**第一次快照读**时拍一张 ReadView，之后都用这张旧照片 → 所以能「可重复读」。

就这一个差异，撑起了两个隔离级别的全部行为差异。

### 2.3 快照读 vs 当前读：你的 SQL 到底在读哪个版本？

- **快照读（Snapshot Read）**：普通的 `SELECT ...`，走 MVCC 看照片，不加锁；
- **当前读（Current Read / Locking Read）**：`SELECT ... FOR UPDATE`、`SELECT ... FOR SHARE`，以及所有 `UPDATE / DELETE / INSERT`——它们必须读**最新已提交版本**（写之前总得知道现在长什么样），并顺手加锁。

RR 能防住幻读，一半功劳是 ReadView（快照读看不到新插入的行），另一半是**间隙锁（Gap Lock）**和 **Next-Key Lock**（记录锁 + 间隙锁的组合）：当前读时把记录之间的「空隙」也锁住，不让别人往里插队。这个我们第四节实验里亲眼验证。

| 隔离级别 | 脏读 | 不可重复读 | 幻读（快照读） | 幻读（当前读） | 实现手段 |
| --- | --- | --- | --- | --- | --- |
| READ UNCOMMITTED | 可能 | 可能 | 可能 | 可能 | 读最新版本，无 MVCC |
| READ COMMITTED | 防住 | 可能 | 可能 | 基本防住（无间隙锁） | MVCC（语句级 ReadView） |
| REPEATABLE READ（InnoDB） | 防住 | 防住 | 防住 | 防住（Next-Key Lock） | MVCC（事务级 ReadView）+ 间隙锁 |
| SERIALIZABLE | 防住 | 防住 | 防住 | 防住 | 快照读退化为加锁读 |

> 注：标准 SQL 里 RR 挡不住幻读，但 InnoDB 的 RR 通过 MVCC + Next-Key Lock 基本挡住了（我们下面会演示一个「例外」），这是 MySQL 面试的经典考点。

## 三、动手实验：两个终端复现全部异常

### 3.0 环境：一行命令起 MySQL 8

```bash
docker run -d --name mysql8 -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8.0
docker exec -it mysql8 mysql -uroot -proot
```

准备数据（终端 A 执行一次即可）：

```sql
CREATE DATABASE demo;
USE demo;
CREATE TABLE account (
  id INT PRIMARY KEY,
  name VARCHAR(32) NOT NULL,
  balance INT NOT NULL
);
INSERT INTO account VALUES (1, 'alice', 100), (2, 'bob', 200);
```

实验全程开两个终端，都连进 demo 库：

```bash
docker exec -it mysql8 mysql -uroot -proot demo
```

**怎么验证每一步**：每个实验我都标了「预期输出」，跑完和你屏幕上的结果对一下即可。另外每一步都可以用 `SELECT @@transaction_isolation;` 确认当前会话隔离级别，防止设错了白忙活。

### 3.1 实验一：READ UNCOMMITTED 下，亲眼看见脏读

终端 A：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
BEGIN;
UPDATE account SET balance = 999 WHERE id = 1;
-- 故意不提交！
```

终端 B：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SELECT balance FROM account WHERE id = 1;
-- 预期输出：999   ← 这就是脏读：读到了未提交的数据
```

终端 A 回滚：

```sql
ROLLBACK;
```

终端 B 再查：

```sql
SELECT balance FROM account WHERE id = 1;
-- 预期输出：100   ← 刚才的 999 从来没存在过
```

**验证结论**：如果 B 在 A 提交前读到了 999，且 A 回滚后变回 100，说明 RU 下确实存在脏读——999 是一张空头支票，如果业务拿它做了扣款，就是事故。

### 3.2 实验二：READ COMMITTED 下，复现不可重复读

终端 A：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
BEGIN;
SELECT balance FROM account WHERE id = 1;
-- 预期输出：100
```

终端 B（注意 B 用默认隔离级别即可，它只是改数据的一方）：

```sql
UPDATE account SET balance = 150 WHERE id = 1;
COMMIT;
```

终端 A 再读：

```sql
SELECT balance FROM account WHERE id = 1;
-- 预期输出：150   ← 同一个事务里，两次读不一样 = 不可重复读
```

顺手把幻读也复现了（A 事务继续不提交）：

```sql
-- 终端 B：
INSERT INTO account VALUES (3, 'carol', 300);
COMMIT;

-- 终端 A：
SELECT COUNT(*) FROM account;
-- 预期输出：3   ← 上一次若查是 2，凭空多了一行 = 幻读
```

**验证结论**：RC 下每次 SELECT 都新拍一张 ReadView，别人一提交就能被看见，所以不可重复读和幻读都拦不住。

### 3.3 实验三：REPEATABLE READ 下，快照读真的可重复

终端 A：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
BEGIN;
SELECT balance FROM account WHERE id = 1;
-- 预期输出：150（承接上一实验的数据状态）
```

终端 B：

```sql
UPDATE account SET balance = 180 WHERE id = 1;
COMMIT;
```

终端 A 再读：

```sql
SELECT balance FROM account WHERE id = 1;
-- 预期输出：150   ← 别人已提交了 180，我读到的还是 150：可重复读达成
COMMIT;   -- 提交后新开事务再读，就是 180 了（ReadView 换新）
```

**验证结论**：RR 的快照读用「第一次拍的那张照片」贯穿整个事务，B 提交了也看不见。这不是 bug，是特性——但线上经常有人把它当 bug，这个坑我们在第五节说。

### 3.4 实验四：RR 下的「幻影觉醒」——当前读会打破快照

这是最有意思的一个实验。终端 A（RR）：

```sql
BEGIN;
SELECT * FROM account WHERE id > 2;
-- 预期输出：Empty set   ← 快照读，看不见 B 插的 carol
```

终端 B：

```sql
INSERT INTO account VALUES (4, 'dave', 400);
COMMIT;
```

终端 A 先用快照读确认「看不见」，再用 **UPDATE（当前读）**碰一下这行：

```sql
SELECT * FROM account WHERE id > 2;
-- 预期输出：Empty set   ← 依然看不见
UPDATE account SET balance = balance + 1 WHERE id = 4;
-- 预期输出：Query OK, 1 row affected   ← 当前读：影响了 B 刚插的行！
SELECT * FROM account WHERE id > 2;
-- 预期输出：能看到 (4, dave, 401)   ← 幻影被自己「唤醒」了
ROLLBACK;
```

**验证结论**：UPDATE 是当前读，必须基于最新已提交版本动手。A 一旦改了那行，新版本的 `trx_id` 是 A 自己，可见性规则第 1 条生效，幻影就从照片里走了出来。所以严格说：**InnoDB 的 RR 挡住了快照读的幻读，但「快照读 + 当前读混用」时仍会出现这种类幻读现象**。

### 3.5 实验五：亲眼看见间隙锁把人堵在门外

终端 A（RR）：

```sql
SET SESSION innodb_lock_wait_timeout = 5;   -- 缩短等待，别傻等 50 秒
BEGIN;
SELECT * FROM account WHERE id > 2 FOR UPDATE;
-- 预期输出：Empty set，但此刻已对 (2, +∞) 这个区间加了 Next-Key Lock
```

终端 B 尝试插队：

```sql
SET SESSION innodb_lock_wait_timeout = 5;
INSERT INTO account VALUES (5, 'eve', 500);
-- 预期输出：卡住 5 秒后报错：
-- ERROR 1205 (HY000): Lock wait timeout exceeded
```

趁 A 还没提交，从第三个终端（或 A 提交前另开一个）看看锁的真身：

```sql
SELECT ENGINE_TRANSACTION_ID, INDEX_NAME, LOCK_TYPE, LOCK_MODE, LOCK_DATA
FROM performance_schema.data_locks;
-- 预期输出：能看到 LOCK_TYPE=RECORD、LOCK_MODE 带 GAP 的行，
-- LOCK_DATA 里还有 'supremum pseudo-record'（正无穷哨兵记录）
```

终端 A 提交，锁释放，B 的插入重试即可成功：

```sql
-- 终端 A：
COMMIT;
-- 终端 B：
INSERT INTO account VALUES (5, 'eve', 500);
-- 预期输出：Query OK
```

最后做一组 **RC 对照**：把两个会话都 `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`，重复实验五——B 的 INSERT 会**立刻成功**。**验证结论**：RC 基本不用间隙锁，所以同范围当前读挡不住插入，这也解释了为什么 RC 更适合高并发写场景、但要接受幻读。

### 3.6 加餐：查锁、查事务的两把刷子

排查线上锁问题，这两条命令要形成肌肉记忆：

```sql
-- 谁在跑事务、跑了多久（排查长事务第一现场）
SELECT trx_id, trx_state, trx_started, trx_mysql_thread_id
FROM information_schema.innodb_trx;

-- 谁在等谁的锁（配合 data_lock_waits 看等待关系）
SELECT * FROM performance_schema.data_lock_waits;
SHOW ENGINE INNODB STATUS\G   -- 重点看 LATEST DETECTED DEADLOCK 段落
```

## 四、RC vs RR：性能账到底差多少？

RR 多了间隙锁和更长的 ReadView，理论上锁冲突和 undo 压力更大，但**差距有多大必须压了才知道**。用 **sysbench**（数据库压测的标准「跑步机」，首次出现，它就是一款通用的数据库基准测试工具）复现一遍：

```bash
# 准备（Ubuntu/Debian 示例：apt install sysbench）
sysbench /usr/share/sysbench/oltp_read_write.lua \
  --mysql-host=127.0.0.1 --mysql-user=root --mysql-password=root \
  --mysql-db=sbtest --tables=4 --table-size=100000 prepare

# RR（默认）压一轮
sysbench /usr/share/sysbench/oltp_read_write.lua \
  --mysql-host=127.0.0.1 --mysql-user=root --mysql-password=root \
  --mysql-db=sbtest --tables=4 --table-size=100000 \
  --threads=32 --time=60 run

# 切到 RC，再压一轮
mysql -uroot -proot -e "SET GLOBAL transaction_isolation='READ-COMMITTED';"
sysbench /usr/share/sysbench/oltp_read_write.lua ... --threads=32 --time=60 run
# 压完记得改回：SET GLOBAL transaction_isolation='REPEATABLE-READ';
```

对比口径：记录每轮的 **tps（吞吐）** 和 **latency 的 P95/P99**。参考量级（4C8G 容器 + 本地盘 + 32 并发，**示例环境的常见区间，请以你自己的压测为准**）：

| 场景 | RR vs RC 的差异（量级参考） | 说明 |
| --- | --- | --- |
| 随机读写、冲突少 | tps 差异通常 < 5%，P99 接近 | 没有锁竞争时，间隙锁几乎不出场 |
| 热点范围写 / 索引范围更新 | RC 的 tps 高 10%~30%，P99 明显更稳 | RR 的间隙锁把并发插入挡成了串行 |
| 存在长事务 | RR 下 undo 膨胀风险更高 | 长事务的 ReadView 拖着版本链不放 |

**如何验证这个结论**：重点跑「热点范围写」场景（比如把 oltp 脚本换成带范围 UPDATE 的自定义脚本），观察 RC 与 RR 的 tps 差距是否拉大。**结论不是「RC 一定更快」，而是「RC 把一部分一致性换成了吞吐」——选型时要拿业务能接受的异常模型来换。**

## 五、常见坑：实验里埋着的那些「事后炸弹」

1. **RC 必须配 ROW 格式 binlog**。**binlog** 是主从复制和崩溃恢复用的「操作流水账」。RC + STATEMENT 格式会让主从执行顺序不一致、数据漂移，MySQL 8.0 默认 `binlog_format=ROW`，但改造老库前务必确认：`SHOW VARIABLES LIKE 'binlog_format';`。
2. **RR 下「读不到别人已提交的数据」不是 bug**。实验三里 A 读到的永远是旧值。业务上如果需要「看到最新」，要么当前读（`FOR UPDATE`），要么把读放到事务外，别在事务中间反复读然后怀疑人生。
3. **长事务是 undo log 的吸血鬼**。ReadView 只要还开着，版本链就不敢回收，历史版本越积越多、查询越来越慢、磁盘越来越涨。每天盯一下 `information_schema.innodb_trx` 的 `trx_started`，超过阈值就报警。
4. **无索引列上的当前读 = 锁全表**。`UPDATE account SET ... WHERE name = 'x'`（name 没索引）在 RR 下会把扫过的每条记录和间隙都锁上，等于全表锁。给 WHERE 条件建索引，是给锁「减肥」。
5. **间隙锁之间会互相死锁**。两个事务都持有一个区间的间隙锁（间隙锁彼此兼容），然后都往对方区间里插入——插入意向锁等对方释放，死锁达成。所以 RR 下死锁日志比 RC 多，出了死锁别急着加应用层重试，先看 `LATEST DETECTED DEADLOCK`。
6. **`innodb_lock_wait_timeout` 报错不是死锁**。死锁是 InnoDB 主动回滚一方；50 秒超时是「还在等」。两者排查路径完全不同，别混为一谈。
7. **Java 侧落地**：Spring 里用 `@Transactional(isolation = Isolation.READ_COMMITTED, timeout = 5)` 精确控制，验证事务是否生效可以开 `logging.level.org.springframework.jdbc=DEBUG` 看 "Initiating transaction / Committing" 日志；JDBC 层也可以 `conn.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED)` 后用 `SELECT @@transaction_isolation;` 验证。另外记住：连接池里的连接隔离级别会被复用，**用完记得改回来**，不然污染下一个借走这条连接的业务。

## 六、总结

- 三个读异常一句话：脏读 = 看到没提交的；不可重复读 = 两次读同一行值变了；幻读 = 两次按同条件查行数变了。
- InnoDB 的 RC/RR 靠 **MVCC**（版本链 + undo log + ReadView）做到「读写不互相堵」；RC 每条语句拍一张 ReadView，RR 整个事务只拍一张——这就是两个级别全部行为差异的根源。
- 普通 SELECT 是快照读看照片；`FOR UPDATE / UPDATE / DELETE / INSERT` 是当前读碰最新现场。RR 防幻读 = 快照读靠 ReadView + 当前读靠 Next-Key Lock。
- 性能账：冲突少时 RC/RR 差距很小；热点范围写场景 RC 凭「少一把间隙锁」能拉开 10%~30% 的吞吐，但要接受幻读 + 必须配 ROW binlog。
- 排查工具三件套：`information_schema.innodb_trx`（谁在跑长事务）、`performance_schema.data_locks / data_lock_waits`（谁堵着谁）、`SHOW ENGINE INNODB STATUS`（死锁现场）。

纸上得来终觉浅：把第三节的五个实验在本地跑一遍，比背十遍八股都管用。

## 参考资料

1. MySQL 8.0 Reference Manual — Consistent Nonlocking Reads：https://dev.mysql.com/doc/refman/8.0/en/innodb-consistent-read.html
2. MySQL 8.0 Reference Manual — Locking Reads：https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html
3. MySQL 8.0 Reference Manual — InnoDB Locking（记录锁/间隙锁/Next-Key Lock）：https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html
4. MySQL 8.0 Reference Manual — SET TRANSACTION Statement：https://dev.mysql.com/doc/refman/8.0/en/set-transaction.html
5. MySQL 8.0 Reference Manual — Binary Log Formats（RC 与 ROW 格式的关系）：https://dev.mysql.com/doc/refman/8.0/en/binary-log-formats.html
6. 丁奇《MySQL 实战 45 讲》—— 事务隔离级别与 MVCC 相关篇目（极客时间）
7. 《High Performance MySQL（第 3 版）》O'Reilly —— 事务与隔离级别章节
8. sysbench（数据库基准测试工具）：https://github.com/akopytov/sysbench
