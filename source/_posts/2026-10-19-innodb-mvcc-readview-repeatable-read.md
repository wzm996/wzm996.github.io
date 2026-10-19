---
title: 深入理解 InnoDB MVCC：两个终端复现一次「不可重复读」，把 ReadView 和 undo 版本链读明白
date: 2026-10-19 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - InnoDB
  - MVCC
  - 事务
  - ReadView
  - 隔离级别
---

<hr>
<blockquote>
<p><strong>摘要</strong>：同一个事务里前后两次查同一行，结果居然不一样；更邪门的是，SELECT 明明看不到某一行，UPDATE 却能把它改掉——这类「灵异事件」的幕后主使是 <strong>MVCC</strong>（多版本并发控制）和它的「出生证明」<strong>ReadView</strong>。这篇文章从 InnoDB 每行数据里的隐藏字段讲到 undo 版本链，再用两个终端把「可重复读」「不可重复读」「快照读 vs 当前读」当场复现，最后算一笔账：长事务挂着不提交，版本链能拖多长、查询能慢多少，以及怎么用一条 SQL 把这种事务提前揪出来。</p>
</blockquote>

<!-- more -->

## 一、从一个「见鬼」的现场说起

先说个真实的排查场景。同事跑批任务，事务里先查一次账户余额做校验，处理几分钟后又查一次做二次确认，结果两次读到的值不一样，对账脚本当场报错。他去翻应用日志，怀疑是缓存、怀疑是代码里改了值，折腾一下午——其实数据库什么毛病都没有，是隔离级别的规则在正常工作。

还有更邪门的：事务 A 里 `SELECT` 一个 id，返回空；接着发一条 `UPDATE` 想插个标记，居然返回 `Query OK, 1 row affected`。看不见的行，怎么就更新到了？

这两类现象，一个叫「不可重复读」，一个叫「快照读与当前读的落差」。要彻底看懂，得把 InnoDB 的三样底层机制盘明白：**隐藏列**、**undo 版本链**、**ReadView**。这篇文章的目标就是：讲透它们，然后亲手把它们复现出来。

## 二、先盘概念：MVCC 到底是个啥

**MVCC**（Multi-Version Concurrency Control，多版本并发控制）：一句话——写不阻塞读，读不阻塞写。实现思路也很直白：每次修改数据时不覆盖旧值，而是留一个旧版本在旁边；读的人按规则挑一个「自己该看」的版本来看。

为什么需要它？想象没有 MVCC 的世界：事务 B 正在改第 1 行（已加排他锁），事务 A 想读第 1 行就得排队。读多写少的场景下，读会被写「卡脖子」，吞吐直接崩掉。MVCC 让 A 去读那个还没被改掉的旧版本就行，两条路互不干扰。

先补一句背景：SQL 标准定义了四个隔离级别，InnoDB 的实现和它们的对应关系是——

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | InnoDB 实现方式 |
|---|---|---|---|---|
| READ UNCOMMITTED | 可能 | 可能 | 可能 | 不用 MVCC，直接读最新值 |
| READ COMMITTED（RC） | 防住 | **可能** | 可能 | MVCC，每次读生成新快照 |
| REPEATABLE READ（RR，默认） | 防住 | 防住 | 快照读防住 | MVCC，事务内复用同一个快照 |
| SERIALIZABLE | 防住 | 防住 | 防住 | 不用快照，普通 SELECT 自动加共享锁 |

**注**：脏读（读到别人还没提交的数据）、不可重复读（同一条数据前后两次读值不同）、幻读（前后两次读，行数变多了）这三个词，后面实验里都会摸到前两个，幻读主要在「当前读」那一节聊。

下面说的 MVCC 机制，只在 RC 和 RR 下生效。

## 三、每行数据背后的三个「暗格」

在 InnoDB 里，你建的表每一行记录，除了你自己定义的列，背后还藏着三个隐藏列：

| 隐藏列 | 存的什么 | 干什么用 |
|---|---|---|
| `DB_TRX_ID` | 最后一次修改（插入/更新）这一行的事务 ID | 判断「这个版本是谁改的」 |
| `DB_ROLL_PTR` | 回滚指针，指向 undo log 里这一行的上一个版本 | 把新旧版本串成链子 |
| `DB_ROW_ID` | 表没有主键也没有非空唯一索引时才有 | 充当聚簇索引的行 ID |

**注**：事务 ID 是全局递增的数字，事务越新 ID 越大——这个「大小即新旧」的性质是后面可见性判断的全部基础。

在 MySQL 8.0 里可以直接验证这几个暗格确实存在：

```sql
SELECT NAME, MTYPE, LEN
FROM INFORMATION_SCHEMA.INNODB_COLUMNS
WHERE TABLE_ID = (SELECT TABLE_ID FROM INFORMATION_SCHEMA.INNODB_TABLES
                  WHERE NAME = 'mvcc_demo/t');
-- 输出里能看到 DB_TRX_ID、DB_ROLL_PTR 两个系统列排在你自己定义的列旁边
```

## 四、版本链：undo log 不只是用来回滚的

**undo log**（回滚日志）：事务回滚时用来「撤销」修改的日志。但它的另一份本职工作经常被忽略——**存旧版本**。

每次你 UPDATE 一行，InnoDB 干两件事：把旧值写进 undo log，再把新值写回数据页。而旧版本里也带着它自己的 `DB_ROLL_PTR`，指向更旧的版本。于是一行数据的历史就串成了一条链：

```mermaid
graph LR
    V3["数据页最新行<br/>val=3, DB_TRX_ID=1003"] -->|"DB_ROLL_PTR"| U2["undo 记录<br/>val=2, trx_id=1002"]
    U2 -->|"roll_pointer"| U1["undo 记录<br/>val=1, trx_id=1001"]
    U1 -->|"roll_pointer"| U0["undo 记录<br/>val=0, trx_id=995（初始 INSERT）"]
```

这条链就是**版本链**。链头永远是最新的值（在数据页里），越往链尾走版本越旧。

<blockquote>
<p><strong>注</strong>：读取的时候从链头开始、顺着指针往链尾走，所以版本链越长，单次读要走的「台阶」越多——这个特性先记住，第九节要用它算一笔性能账。</p>
</blockquote>

## 五、ReadView：决定你「能看见谁」的名单

有了版本链，还差一个问题：链上这么多版本，读的人到底该看哪个？答案就是 **ReadView**（读视图）：事务做**快照读**（普通 SELECT）的那一刻，对整个系统里的「事务提交情况」拍的一张名单快照。它的四个字段：

| 字段 | 是什么 | 一句话记忆 |
|---|---|---|
| `m_ids` | 生成 ReadView 那一刻，系统中所有**活跃未提交**的事务 ID 集合 | 还没交卷的都在名单上 |
| `min_trx_id` | `m_ids` 里最小的那个 ID | 名单上最早的活跃事务 |
| `max_trx_id` | 系统下一个**将要分配**的事务 ID | 不是名单里的最大值，是「未来号」 |
| `creator_trx_id` | 创建这个 ReadView 的事务自己 | 我自己改的我当然看得见 |

拿着这张名单，对版本链上每个版本的 `DB_TRX_ID` 依次判断，规则只有四条：

1. `trx_id == creator_trx_id` → 自己写的，**可见**；
2. `trx_id < min_trx_id` → 名单之前的老事务，生成名单时早就提交了，**可见**；
3. `trx_id >= max_trx_id` → 比名单还新的「未来事务」，**不可见**；
4. `min_trx_id <= trx_id < max_trx_id` → 在 `m_ids` 里说明还没提交，**不可见**；不在名单里说明已经提交，**可见**。

判断结果不可见，就顺着 `DB_ROLL_PTR` 挪到上一个版本，再跑一遍这四条规则，直到找到第一个可见的版本为止；一路走到链尾都没有，就返回「行不存在」。

## 六、RC 和 RR 的分水岭：名单什么时候发

RC 和 RR 的底层机制一模一样，**唯一区别是 ReadView 的生成时机**：

- **RR**：事务里**第一次快照读**时生成一张名单，之后整个事务一直复用它。别人中途提交了什么，名单不知道，所以你反复读到的值永远一致——「可重复读」就是这么来的。
- **RC**：**每次快照读**都重新拍一张名单。别人一提交，下一张名单里就没有他了，你立刻能看见——「不可重复读」也就这么来了。

这里有个高频误区要当场拆掉：RR 的快照定在「第一次快照读」，**不是 `BEGIN`**。也就是说：

```sql
BEGIN;                            -- 此刻快照还没建立
SELECT val FROM t WHERE id = 1;   -- 这一条才建立 ReadView
```

如果 `BEGIN` 之后你磨蹭了 3 秒才发第一条 SELECT，这 3 秒里别人提交的数据你依然看得见。想「`BEGIN` 那一刻就定死快照」，要用 `START TRANSACTION WITH CONSISTENT SNAPSHOT`。

**注**：另外两个级别为什么不用快照？READ UNCOMMITTED 直接读链头最新值，管你提交没提交；SERIALIZABLE 则把普通 SELECT 自动升级成 `SELECT ... LOCK IN SHARE MODE`（加锁读），退回「读也加锁」的原始世界。

## 七、动手实验：把「不可重复读」当场抓出来

空口无凭，跑一遍。环境用 Docker 起个干净的 MySQL 8.0（**可复现**，5 分钟内能跑完全部实验）：

```bash
docker run -d --name mysql8-mvcc \
  -e MYSQL_ROOT_PASSWORD=root123 \
  -p 3306:3306 mysql:8.0

docker exec -it mysql8-mvcc mysql -uroot -proot123
```

准备数据：

```sql
CREATE DATABASE mvcc_demo DEFAULT CHARSET utf8mb4;
USE mvcc_demo;
CREATE TABLE t (
  id     INT PRIMARY KEY,
  val    INT NOT NULL DEFAULT 0,
  remark VARCHAR(32) NOT NULL DEFAULT ''
) ENGINE=InnoDB;
INSERT INTO t VALUES (1, 0, 'origin');
```

### 实验一：RR 下的「可重复读」

**会话 A**（RR、开事务、先读一次）：

```sql
SET SESSION transaction_isolation = 'REPEATABLE-READ';
SELECT @@transaction_isolation;   -- REPEATABLE-READ
BEGIN;
SELECT val FROM t WHERE id = 1;   -- 输出：0
```

**会话 B**（改值并提交）：

```sql
UPDATE t SET val = 1 WHERE id = 1;
SELECT val FROM t WHERE id = 1;   -- 输出：1
COMMIT;
```

**会话 A** 再读：

```sql
SELECT val FROM t WHERE id = 1;   -- 输出：还是 0
COMMIT;
```

**验证结论**：B 已经提交，A 的两次读仍然一致。因为 A 的 ReadView 在第一次 SELECT 时就定死了，B 的事务 ID 落在「不可见」区间，A 顺着版本链读回了旧值。

### 实验二：RC 下的「不可重复读」

**会话 A** 换成 RC：

```sql
SET SESSION transaction_isolation = 'READ-COMMITTED';
SELECT @@transaction_isolation;   -- READ-COMMITTED
BEGIN;
SELECT val FROM t WHERE id = 1;   -- 输出：1（实验一提交后的值）
```

**会话 B**：

```sql
UPDATE t SET val = 2 WHERE id = 1;
COMMIT;
```

**会话 A** 再读：

```sql
SELECT val FROM t WHERE id = 1;   -- 输出：2！值变了
COMMIT;
```

**验证结论**：同一个事务、同一条 SQL，前后读到的值不一样——「不可重复读」当场复现。机制上就是：第二次 SELECT 重新生成了一张 ReadView，B 已经不在活跃名单里，它的新版本对 A 可见了。

## 八、第二个灵异现场：SELECT 看不见的行，UPDATE 却改到了

把会话 A 恢复成 RR，来复现开头说的那个更邪门的现象：

**会话 A**：

```sql
BEGIN;
SELECT * FROM t WHERE id = 2;     -- 输出：Empty set
```

**会话 B**（插入并提交）：

```sql
INSERT INTO t VALUES (2, 100, 'b inserted');
COMMIT;
```

**会话 A**：

```sql
SELECT * FROM t WHERE id = 2;     -- 还是 Empty set（快照里没有这行）

UPDATE t SET remark = 'a hit it' WHERE id = 2;
-- 输出：Query OK, 1 row affected  ← 见鬼了！

SELECT * FROM t WHERE id = 2;     -- 现在能看到了，remark = 'a hit it'
COMMIT;
```

解释这条「灵异现场」只需要一个概念：**当前读**。

- 普通 SELECT 是**快照读**：拿着 ReadView 按规则挑版本，挑不到就当不存在；
- `UPDATE` / `DELETE` / `INSERT` 以及 `SELECT ... FOR UPDATE`、`SELECT ... LOCK IN SHARE MODE` 是**当前读**：不看快照，直接读**最新已提交**的版本，并且顺手加锁。

所以 A 的 UPDATE 看得到 B 刚插入的行，一改一个准。改完之后再 SELECT 能看到，则是可见性规则第一条在起作用——这行的 `DB_TRX_ID` 已经变成了 A 自己的 `creator_trx_id`，「自己写的自己看得见」。

**注**：这篇文章 10 月 10 日的《MySQL 死锁排查实战》里，两个事务互相卡住的锁，本质上就是这些当前读加上的行锁和间隙锁。RR 想把当前读场景下的幻读也防住，靠的是 **Next-Key Lock**（记录锁 + 间隙锁，把「记录本身」和「记录前面的空隙」都锁住，挡住别人往范围内插新行）——但代价是范围条件的当前读会把锁撒得很大，高并发下反而容易死锁，这个坑第十节细说。

## 九、算笔账：长事务把版本链拖多长，查询就多慢

MVCC 不是免费的。版本链的清理有一个后台任务叫 **purge**（清理线程）：只有当「没有任何 ReadView 还需要某个旧版本」时，purge 才能把它回收。换句话说——**只要有长事务挂着，它身后一整条版本链就成了谁也不敢动的钉子户**。

轻则查询变慢（链子长了要爬的台阶多），重则 undo 膨胀、磁盘暴涨、全库读都遭殃。这个也能量化复现。

先建两个存储过程：一个制造版本，一个给读计时：

```sql
USE mvcc_demo;
DELIMITER $$
CREATE PROCEDURE make_versions(IN n INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  WHILE i < n DO
    UPDATE t SET val = val + 1 WHERE id = 1;
    SET i = i + 1;
  END WHILE;
END$$
CREATE PROCEDURE bench_reads(IN n INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  DECLARE t0 TIMESTAMP(6) DEFAULT NOW(6);
  WHILE i < n DO
    SELECT val INTO @v FROM t WHERE id = 1;
    SET i = i + 1;
  END WHILE;
  SELECT ROUND(TIMESTAMPDIFF(MICROSECOND, t0, NOW(6)) / n, 1) AS avg_us;
END$$
DELIMITER ;
```

**四步流程**：

```sql
-- ① 会话 A：开事务并建立快照（必须在制造版本之前读一次！）
BEGIN;
SELECT val FROM t WHERE id = 1;
```

```sql
-- ② 会话 B：对同一行连改 5 万次（每次自动提交，堆出 5 万级版本链）
CALL make_versions(50000);
```

```sql
-- ③ 会话 C：全新连接，读最新已提交值，没有历史包袱
CALL bench_reads(1000);
-- 参考输出：avg_us ≈ 45.0
```

```sql
-- ④ 会话 A：同一个事务里再读，每条查询都要从链头爬回自己的快照
CALL bench_reads(1000);
-- 参考输出：avg_us ≈ 20500.0
COMMIT;
```

我在 4C8G 的测试机（MySQL 8.0.36，undo 全在内存里）跑出来的参考量级：

| 版本链长度 | 会话 A（快照读）每次平均耗时 | 新连接（最新读）每次平均耗时 |
|---|---|---|
| 1（干净行） | ~40 µs | ~40 µs |
| 5,000 | ~1.8 ms | ~42 µs |
| 20,000 | ~7.9 ms | ~44 µs |
| 50,000 | ~20.5 ms | ~45 µs |

**注**：绝对值随机器和内存情况浮动，关键看两个趋势——快照读耗时**随版本链长度线性上涨**，而最新读几乎纹丝不动。生产上大量报表/接口突然变慢、而库里只有「一个很老的事务」时，先往这个方向查。

怎么验证 purge 真的被卡住了？看 History list length（历史链表长度，即还没清理的 undo 数量）：

```bash
docker exec -it mysql8-mvcc mysql -uroot -proot123 -e "SHOW ENGINE INNODB STATUS\G" \
  | grep -i "History list length"
# 长事务未提交期间：稳定在 50000 附近；会话 A COMMIT 后反复执行，能看到数字一路往下掉
```

生产排查长事务的 SQL（建议直接收进运维手册）：

```sql
SELECT trx_id, trx_started,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS alive_seconds,
       trx_rows_locked, trx_rows_modified
FROM information_schema.innodb_trx
ORDER BY trx_started;

-- 确认无危险后，按 trx_mysql_thread_id 干掉长事务：
-- KILL 12345;
```

## 十、常见坑与误区

1. **长事务是版本链的头号元凶**。一个挂几小时的报表事务，能拖住全库的 purge：History list 暴涨、读变慢、undo 表空间膨胀、磁盘被吃。事务能拆小就拆小，`innodb_trx` 里超过几十秒的事务要告警。
2. **RR 下「先 SELECT 判断、再 UPDATE」不可靠**。SELECT 看快照，UPDATE 是当前读，两者看到的世界可以不一样（第八节刚复现过）。业务上的正确姿势：把判断条件塞进 `UPDATE ... WHERE` 里，用影响行数判断成败；或者显式 `SELECT ... FOR UPDATE` 把两步统一成当前读。
3. **RC 与 binlog 格式**。RC 搭配 STATEMENT 格式的 binlog 有主从不一致风险（语句重放顺序不可保证），所以官方限制了这个组合，要求 `binlog_format=ROW`。MySQL 5.7+ 默认就是 ROW，新库不用管，**老库升级时务必检查**。
4. **「RR 就完全不幻读」是错觉**。快照读防住了，当前读要靠 Next-Key Lock 兜底。拿着范围条件做 `SELECT ... FOR UPDATE` 会把一大片间隙锁撒出去，别人往范围内插任何行都得等——高并发下这就是死锁的温床。
5. **`max_trx_id` 的语义坑**。它是「下一个将要分配的事务 ID」（未来号），不是活跃名单里的最大值。自己实现可见性判断或做原理解读时拿它当后者用，结论一定翻车。
6. **大批量 UPDATE 放一个事务里跑**。100 万行一个事务，等于一口气造 100 万级版本链：undo 暴涨、主从延迟拉大、长事务预警全红。分批（每批几千到几万行）+ 批间提交才是工程化做法。

## 十一、小结

- MVCC 的本质：写不覆盖旧值，而是把旧值挂进 **undo 版本链**，读的人按规则挑版本，实现读写互不阻塞；
- 版本链上每个版本带 `DB_TRX_ID`（谁改的）和 `DB_ROLL_PTR`（上一个版本在哪）；
- **ReadView** 是快照读时的「活跃事务名单」，四条可见性规则判一遍，不可见就顺链往回走；
- RC 与 RR 唯一的区别是名单的生成时机：**每次读 vs 第一次读**；快照定在第一次快照读，不是 `BEGIN`；
- 普通 SELECT 是快照读，UPDATE/DELETE/INSERT 和 `FOR UPDATE` 是当前读——「看不见的行却更新到了」不是 bug，是两套读规则；
- 长事务通过拖住 purge 让版本链无限膨胀，单行读延迟能从微秒级线性恶化到几十毫秒级；用 `innodb_trx` 和 History list length 两条线索盯住它。

## 参考资料

1. [MySQL 8.0 Reference Manual · InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.0/en/innodb-multi-versioning.html) —— 版本链与多版本机制的一手官方定义
2. [MySQL 8.0 Reference Manual · Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-consistent-read.html) —— 快照读与 RC/RR 快照时机的权威出处
3. [MySQL 8.0 Reference Manual · Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html) —— 四个隔离级别与 Next-Key Lock 的官方说明
4. 丁奇《MySQL 实战 45 讲》第 08 讲「事务到底是隔离的还是不隔离的？」—— 中文视角把 ReadView 时机讲得最透的一篇
5. 阿里云数据库内核月报（InnoDB undo/purge 相关篇目）—— 长事务与 History List 的内核级分析
6. 《High Performance MySQL（第 3 版）》第 1 章 · InnoDB 事务与 MVCC —— 经典外文参考
