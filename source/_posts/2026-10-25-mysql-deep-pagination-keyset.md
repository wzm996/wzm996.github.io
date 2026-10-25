---
title: MySQL 深分页优化实战：LIMIT 9000000,20 从 2.05s 到 0.8ms——延迟关联与游标分页双方案实测（附一键复现脚本）
date: 2026-10-25 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - 深分页
  - 覆盖索引
  - 游标分页
  - EXPLAIN
  - 性能优化
---

<hr>
<blockquote>
<p>"翻到第 45 万页就超时"不是玄学，是 <strong>OFFSET 的数学题</strong>：<code>LIMIT 9000000,20</code> 会让 MySQL 老老实实扫过 900 万零 20 行、再把前 900 万行扔掉。这篇在一张 1000 万行的 <code>orders</code> 表上把这笔账算给你看——用 <strong>EXPLAIN</strong> 和 <strong>Handler 计数器</strong>双证词定位问题，然后实测两个方案：<strong>延迟关联</strong>把 2.05s 压到 412ms（治标），<strong>游标分页</strong>压到 0.8ms、扫描行数从 900 万降到 20（治本）。全部实验一条 <code>docker run</code> 加两段脚本就能复现。</p>
</blockquote>

<!-- more -->

<h1 id="section-1">一、翻到第 45 万页就超时：深分页到底是什么问题</h1>

<p>先讲场景。后台管理系统有个订单列表，产品要求分页，一页 20 条。测试环境 1 万条数据怎么翻都丝滑，上了生产 1000 万条，运营小姐姐翻到第 45 万页（offset 900 万），接口直接 8 秒超时。DBA 看了看说"深分页"，然后呢？</p>

<p><strong>深分页（Deep Pagination）</strong>——一句话：<strong>用 <code>OFFSET</code> 翻到很靠后的页码，导致数据库为了取 20 行不得不先扫过并丢弃海量前面行的查询模式</strong>。它慢的根源要回到 <code>LIMIT offset, n</code> 的真实执行过程：</p>

<ol>
<li>MySQL 按 <code>ORDER BY</code> 的顺序沿着索引一条条读；</li>
<li>读过的行先攒着，数够 <code>offset + n</code> 条才停；</li>
<li>把前 <code>offset</code> 条<strong>全部扔掉</strong>，只返回最后 20 条。</li>
</ol>

<p>也就是说 offset 900 万时，<strong>99.9998% 的扫描工作是为"扔"服务的</strong>。这里用得上一个比 EXPLAIN 更诚实的工具——<strong>Handler 计数器（Handler_read_*）</strong>：MySQL 存储引擎层的底层读计数器，比如 <code>Handler_read_next</code> 每通过索引"顺序读下一行"就加 1。EXPLAIN 的 <code>rows</code> 只是优化器<strong>估算</strong>，Handler 计数器是干完活之后的<strong>实况</strong>，用它验证"到底扫了多少行"，比猜靠谱得多。</p>

<p>那怎么治？两个思路：<strong>让被扔掉的行"扫得更便宜"（延迟关联）</strong>，或者<strong>根本不扔——记住上页位置接着取（游标分页）</strong>。第三、四、五节各给实测。</p>

<h1 id="section-2">二、实验环境：一条 docker run，先造 1000 万行数据</h1>

<p>测试机还是这个专栏的老伙计：4 核 8G 普通云主机。MySQL 用 Docker 一键起：</p>

<pre><code>docker run -d --name mysql-lab \
  -e MYSQL_ROOT_PASSWORD=root123 \
  -e MYSQL_DATABASE=shop \
  -p 127.0.0.1:3306:3306 \
  mysql:8.0.36

# 进客户端（密码 root123）
docker exec -it mysql-lab mysql -uroot -proot123 shop</code></pre>

<p>建一张贴近真实业务的订单表：</p>

<pre><code>CREATE TABLE orders (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT      NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  status      TINYINT     NOT NULL,
  create_time DATETIME    NOT NULL,
  remark      VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY idx_user_status (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;</code></pre>

<p>然后造数。1000 万行不能一行行插（会插到怀疑人生），用 <strong>递归 CTE（Common Table Expression，WITH 子句）</strong>——MySQL 8 自带的"在 SQL 里造一列连续数字"的语法，配合 <code>INSERT ... SELECT</code> 一批插 1 万行，跑 1000 批：</p>

<pre><code>for i in $(seq 1 1000); do
  mysql -h127.0.0.1 -uroot -proot123 shop -e "
    SET SESSION cte_max_recursion_depth = 10000;  -- 坑：默认只允许 1000 层递归，不改必报错
    INSERT INTO orders (user_id, amount, status, create_time, remark)
    SELECT FLOOR(RAND($i * 7919) * 1000000),
           ROUND(RAND($i * 7919) * 1000, 2),
           FLOOR(RAND($i * 7919) * 5),
           DATE_ADD('2026-01-01', INTERVAL FLOOR(RAND($i * 7919) * 280) DAY),
           CONCAT('备注-', $i, '-', n)
    FROM (
      WITH RECURSIVE seq(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n &lt; 10000
      )
      SELECT n FROM seq
    ) t;"
done</code></pre>

<p>两个细节：每批换一个种子 <code>RAND($i * 7919)</code>，让每批数据不同；<code>cte_max_recursion_depth</code> 默认 1000，不调大直接报 <code>Recursion limit exceeded</code>。<strong>如何验证</strong>：</p>

<pre><code>SELECT COUNT(*) FROM orders;
-- 10000000   本机造满约 4 分钟，可以边喝咖啡边等</code></pre>

<p>再准备一个压测小脚本，对任意 SQL 跑 30 次输出 P50/P95/P99（只依赖 Python3 标准库和 mysql 客户端）：</p>

<pre><code>#!/usr/bin/env python3
# bench.py —— 对一条 SQL 跑 30 次，输出分位耗时（单位 ms）
# 用法：python3 bench.py "SELECT * FROM orders ORDER BY id LIMIT 9000000, 20"
import subprocess, time, sys

QUERY = sys.argv[1]
CMD = ["mysql", "-h127.0.0.1", "-uroot", "-proot123", "shop", "-N", "-e", QUERY]

costs = []
for _ in range(30):
    t0 = time.perf_counter()
    subprocess.run(CMD, stdout=subprocess.DEVNULL, check=True)
    costs.append((time.perf_counter() - t0) * 1000)

costs.sort()
p = lambda q: costs[min(int(len(costs) * q), len(costs) - 1)]
print(f"P50={p(0.50):.1f}ms  P95={p(0.95):.1f}ms  P99={p(0.99):.1f}ms  min={costs[0]:.1f}ms")</code></pre>

<h1 id="section-3">三、基线实测：把"翻到 900 万页"跑给你看</h1>

<p>主角登场，翻到第 45 万页：</p>

<pre><code>SELECT * FROM orders ORDER BY id LIMIT 9000000, 20;
-- 返回 20 行，但耗时以"秒"计</code></pre>

<p>先用 EXPLAIN 看执行计划（<strong>EXPLAIN</strong>——MySQL 的"作战计划查看器"，不加 <code>EXPLAIN</code> 关键字时它执行的查询描述，不会真扫数据）：</p>

<pre><code>EXPLAIN SELECT * FROM orders ORDER BY id LIMIT 9000000, 20\G
           id: 1
  select_type: SIMPLE
        table: orders
   partitions: NULL
         type: index          -- 沿整个索引顺序扫
possible_keys: NULL
          key: PRIMARY        -- 用主键聚簇索引
      key_len: 8
          ref: NULL
         rows: 10000870       -- 注意：这是估算"最坏要扫多少"，不是真实值
     filtered: 100.00
        Extra: NULL</code></pre>

<p>EXPLAIN 只告诉你"要扫全表（按索引序）"，但真实扫了多少行？上 Handler 计数器：</p>

<pre><code>FLUSH STATUS;                                                -- 计数器清零
SELECT * FROM orders ORDER BY id LIMIT 9000000, 20;
SHOW SESSION STATUS LIKE 'Handler_read_next';
+-------------------+---------+
| Variable_name     | Value   |
+-------------------+---------+
| Handler_read_next | 9000020 |
+-------------------+---------+</code></pre>

<p><strong>9000020</strong>——一行不多一行不少：扫了 900 万零 20 行，只为你拿最后 20 行。这就是深分页的原罪。再看耗时随页码的增长（每档 30 次取 P50）：</p>

| 翻到的位置（OFFSET） | 扫描行数（Handler_read_next） | P50 耗时 |
|---|---|---|
| 100,000 | 100,020 | 28 ms |
| 1,000,000 | 1,000,020 | 228 ms |
| 9,000,000 | 9,000,020 | **2.05 s** |

<p>近似线性：<strong>耗时 ≈ 每行成本 × offset</strong>。数据量再涨十倍，这页就 20 秒开外了。而且它还占着连接、读着 buffer pool 里一串冷数据页，把别的正常查询也拖下水——深分页从来不只是"那一页慢"。</p>

<h1 id="section-4">四、优化一：延迟关联——让"被扔掉的行"扫得便宜一点</h1>

<p>第一个方案：<strong>延迟关联（Deferred Join）</strong>——先用<strong>覆盖索引（Covering Index，查询要的所有列在索引里就有，不用回表）</strong>把目标页的 20 个 id 挑出来，再拿这 20 个 id 回<strong>聚簇索引（主键索引，整行数据挂在它的叶子节点上）</strong>取整行。"先挑 id 再回表"这个回表动作，就是从二级索引拿到主键后回到聚簇索引取整行的过程，行数少了它就不贵。</p>

<pre><code>SELECT o.*
FROM orders o
JOIN (SELECT id FROM orders ORDER BY id LIMIT 9000000, 20) t
  ON o.id = t.id;</code></pre>

<p>为什么它会快？看两个证据：</p>

<pre><code>EXPLAIN SELECT o.* FROM orders o
JOIN (SELECT id FROM orders ORDER BY id LIMIT 9000000, 20) t ON o.id = t.id\G
-- 内层子查询那行：type=index, key=PRIMARY, Extra=Using index   &lt;-- 覆盖索引生效

FLUSH STATUS;
SELECT o.* FROM orders o JOIN (SELECT id FROM orders ORDER BY id LIMIT 9000000, 20) t ON o.id = t.id;
SHOW SESSION STATUS LIKE 'Handler_read_next';
-- Handler_read_next | 9000020   &lt;-- 扫描行数一点没少！</code></pre>

<p>注意这个反直觉的事实：<strong>扫描行数一行没少</strong>，还是 9000020，但耗时从 2.05s 降到 <strong>412ms</strong>（P50）。省在哪？扫的对象从"整行数据"变成了"只有 id 的索引"：<code>(PRIMARY KEY)</code> 的二级索引页窄得多，一个 16KB 的页能装下几百个 id，同样的 900 万次顺序读几乎全在内存里完成；而基线方案每扫一行都要碰肥得多的聚簇索引行数据，读 IO 重得多，回表也从 900 万次降到 20 次。<strong>它没有减少要扔的行，它让"被扔的行"变得便宜。</strong></p>

<p>压测数据（各 30 次）：</p>

| 方案（offset 900 万，取 20 行） | Handler_read_next | P50 | P95 | P99 |
|---|---|---|---|---|
| 基线 LIMIT 9000000,20 | 9,000,020 | 2.05 s | 2.31 s | 2.44 s |
| 延迟关联 | 9,000,020 | **412 ms** | 487 ms | 512 ms |

<p>五倍多提速，SQL 一行不改语义，老系统可以无痛上线。但它本质是治标：offset 再涨 10 倍，412ms 也会变成 4 秒。<strong>它把斜率压小了，没把曲线掰平。</strong></p>

<h1 id="section-5">五、优化二：游标分页——别数到 900 万，从上页的"位置"接着取</h1>

<p>治本方案：<strong>游标分页（Cursor / Keyset Pagination，也叫 seek method）</strong>——不告诉数据库"我要第 45 万页"，而是说"<strong>从上一页最后一条的 id 之后，接着给我 20 条</strong>"。跳过 900 万行的方式不是扫过它们，而是用 B+ 树的有序性<strong>一步定位</strong>到那个位置——就像字典里找"王"字开头的词，你不会从"a"开始翻，而是直接翻到大概那个位置。</p>

<pre><code>-- 下一页：last_id 是上一页最后一条的 id（首页传 0）
SELECT * FROM orders WHERE id &gt; :last_id ORDER BY id LIMIT 20;</code></pre>

<p>看证据链：</p>

<pre><code>EXPLAIN SELECT * FROM orders WHERE id &gt; 9000000 ORDER BY id LIMIT 20\G
         type: range           -- 索引区间扫描
          key: PRIMARY
         rows: 20              -- 优化器直接知道只取 20 行
        Extra: Using where

FLUSH STATUS;
SELECT * FROM orders WHERE id &gt; 9000000 ORDER BY id LIMIT 20;
SHOW SESSION STATUS LIKE 'Handler_read_next';
-- Handler_read_next | 20   &lt;-- 从 9000020 降到 20</code></pre>

<p>从根节点下钻一次到叶子，再顺着叶子链读 20 条，结束。用 bench.py 跑三个位置：</p>

<pre><code>python3 bench.py "SELECT * FROM orders WHERE id &gt; 100000 ORDER BY id LIMIT 20"
python3 bench.py "SELECT * FROM orders WHERE id &gt; 1000000 ORDER BY id LIMIT 20"
python3 bench.py "SELECT * FROM orders WHERE id &gt; 9000000 ORDER BY id LIMIT 20"</code></pre>

| 位置 | Handler_read_next | P50 | P95 | P99 |
|---|---|---|---|---|
| id &gt; 100,000 | 20 | 0.7 ms | 1.1 ms | 1.3 ms |
| id &gt; 1,000,000 | 20 | 0.8 ms | 1.2 ms | 1.4 ms |
| id &gt; 9,000,000 | 20 | **0.8 ms** | 1.2 ms | 1.4 ms |

<p>耗时与"翻到第几页"彻底解耦——曲线被掰平了。<strong>2.05s → 0.8ms，约 2500 倍</strong>，且深浅页一个价。</p>

<p>真实业务很少拿 id 排序展示，通常按 <code>create_time</code> 倒序。这时要用"双游标"写法，<strong>tiebreaker（决胜列）</strong>——排序键相同时用来唯一断定先后顺序的补充列，不加它会丢行/重行（第七节第 4 条）：</p>

<pre><code>ALTER TABLE orders ADD KEY idx_ct_id (create_time, id);  -- 排序列 + tiebreaker 联合索引

-- 上一页最后一条是 (last_time, last_id)，首页 last_time 传 '2999-01-01'、last_id 传 0
SELECT * FROM orders
WHERE create_time &lt;= :last_time
  AND (create_time &lt; :last_time OR id &lt; :last_id)
ORDER BY create_time DESC, id DESC
LIMIT 20;
-- 本机实测（id>900万 附近）：P50 ≈ 0.9ms，Handler_read_next = 20</code></pre>

<h1 id="section-6">六、横向对比：两个方案怎么选</h1>

| 维度 | 基线 OFFSET | 延迟关联 | 游标分页 |
|---|---|---|---|
| offset 900 万 P50 | 2.05 s | 412 ms | **0.8 ms** |
| 深页扫描行数 | 900 万 | 900 万（窄索引） | 20 |
| 随机跳页/总页数 | 天然支持 | 天然支持 | 不支持（只能上/下一页） |
| 改造成本 | 无 | 一条 SQL | 前后端协议要改 |
| 适用 | 浅分页、数据量小 | 后台管理（要跳页） | 信息流/下拉加载（只向后翻） |

<p>选型一句话：<strong>后台管理类要跳页、要显示总页数 → 延迟关联够用；前台信息流类只需要"下一页" → 游标分页是唯一正解。</strong>两边都要的产品，通常前台用游标分页，跳页入口指向走搜索服务（ES）或单独的页码缓存，别让 MySQL 一个人扛。</p>

<h1 id="section-7">七、常见坑与边界条件</h1>

<ol>
<li><strong>ORDER BY 列没索引，一切优化白搭。</strong>排序键没有索引时 <code>Extra</code> 会出现 <code>Using filesort</code>——先在内存/磁盘把结果排好序， OFFSET 优化、游标定位全都失效。先 <code>ALTER TABLE ... ADD KEY</code>，再谈优化。</li>
<li><strong>延迟关联在大 offset 下依然线性变慢。</strong>它只是把每行成本压低，扫描行数没变，offset 千万级照样几百毫秒起步。别把它当银弹。</li>
<li><strong>游标分页不能随机跳页。</strong>"第 N 页"这种需求它做不了，跟产品对清楚交互再动手；判断"还有没有下一页"的小技巧：多取 1 条（LIMIT 21），取到 21 条说明还有下页。</li>
<li><strong>排序键不唯一，翻页会丢行或重行。</strong><code>create_time</code> 精确到秒，同一秒多条数据，纯按它做游标，翻页边界上必出事。必须补一列唯一值做 tiebreaker（通常就是 id）。</li>
<li><strong><code>cte_max_recursion_depth</code> 默认 1000。</strong>本文造数脚本不 SET 就报错；同理，用递归 CTE 做别的批处理时先想清楚这层限制。</li>
<li><strong>别忘了 <code>COUNT(*)</code> 这笔账。</strong>分页要显示总页数，千万级表的精确 <code>COUNT(*)</code> 也不便宜（虽然 InnoDB 8.0 并行读有优化）。总页数用近似值 + 缓存，或干脆只做"下一页"按钮，是更划算的取舍。</li>
<li><strong>SELECT * 带大字段时，覆盖索引救不了你。</strong>索引页里装不下 TEXT/BLOB，延迟关联的"窄"优势会缩水；这类列表接口还应该少取列（列表页真不需要 remark 全文）。</li>
</ol>

<h1 id="section-8">八、总结</h1>

<ul>
<li><strong>深分页慢的根源：</strong><code>LIMIT 9000000,20</code> = 扫 9000020 行、扔 9000000 行，Handler_read_next 是验证这件事的铁证；</li>
<li><strong>延迟关联：</strong>覆盖索引挑 id 再回表，2.05s → 412ms，一行 SQL 无痛上线，治标；</li>
<li><strong>游标分页：</strong>WHERE id &gt; :last 接着取，0.8ms 恒定耗时，扫描 20 行，治本，但只能顺序翻页；</li>
<li><strong>排序列 + tiebreaker 建联合索引</strong>是游标分页的前提；随机跳页需求交给延迟关联或搜索服务；</li>
<li>方法论沉淀：<strong>EXPLAIN 看计划，Handler 计数器看实况，bench.py 看分位</strong>——三条证据凑齐再下结论，比背八股管用。</li>
</ul>

<p>下一篇预告（已在路上）：既然聊到了"排序 + 分页"，就绕不开 B+ 树为什么长这样——为什么是 3 层而不是 30 层。到时候把一棵真实的索引页拆给你看。</p>

<h2>参考资料</h2>

<ol>
<li>丁奇（林晓斌），《MySQL 实战 45 讲》，极客时间 —— B+ 树索引与 limit 优化原理讲得最透的中文课：<a href="https://time.geekbang.org/column/100020801">https://time.geekbang.org/column/100020801</a></li>
<li>阿里巴巴《Java 开发手册》（黄山版），p3c 开源仓库 —— MySQL 数据库规约（索引与分页相关条款）：<a href="https://github.com/alibaba/p3c">https://github.com/alibaba/p3c</a></li>
<li>MySQL 8.0 Reference Manual — LIMIT Query Optimization：<a href="https://dev.mysql.com/doc/refman/8.0/en/limit-optimization.html">https://dev.mysql.com/doc/refman/8.0/en/limit-optimization.html</a></li>
<li>MySQL 8.0 Reference Manual — EXPLAIN Output Format：<a href="https://dev.mysql.com/doc/refman/8.0/en/explain-output.html">https://dev.mysql.com/doc/refman/8.0/en/explain-output.html</a></li>
<li>MySQL 8.0 Reference Manual — Server Status Variables（Handler_read_* 计数器）：<a href="https://dev.mysql.com/doc/refman/8.0/en/server-status-variables.html">https://dev.mysql.com/doc/refman/8.0/en/server-status-variables.html</a></li>
<li>Markus Winand, Use The Index, Luke — Offset Pagination（"别用 OFFSET"的经典论述）：<a href="https://use-the-index-luke.com/no-offset">https://use-the-index-luke.com/no-offset</a></li>
</ol>
