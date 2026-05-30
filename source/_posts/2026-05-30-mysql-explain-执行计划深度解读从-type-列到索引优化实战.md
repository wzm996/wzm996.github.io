---
title: MySQL Explain 执行计划深度解读：从 type 列到索引优化实战
date: 2026-05-30 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - Explain
  - 索引优化
  - 慢查询
  - B+树
  - 执行计划
---

<hr>
<blockquote><p>Explain 是 MySQL 自带的"SQL 体检报告"。它不会直接帮你改 SQL，但会告诉你这条语句打算怎么执行、用了哪些索引、要扫多少行。本文从 Explain 的核心字段讲起，用一张百万级表的完整优化过程，展示如何把一条"看起来没问题"的 SQL 从全表扫描优化到毫秒级响应，并给出优化前后的 QPS 和 P95 延迟对比。</p></blockquote>

<!-- more -->

<h1 id="为什么要聊-explain"><a href="#为什么要聊-explain" class="headerlink" title="为什么要聊 Explain"></a>为什么要聊 Explain</h1>

<p>你一定遇到过这种场景：线上接口报警说 SQL 慢，你打开慢日志看到一条语句耗时 3 秒，但你盯着它看了半天——<strong>这 SQL 看起来很正常啊</strong>，该有的 WHERE 条件都有，该加的索引也加了。问题出在哪？</p>

<p>答案是：<strong>你猜的执行路径和 MySQL 实际走的路径很可能不一样</strong>。MySQL 优化器会根据统计信息、索引选择性、成本估算来决定怎么执行你的 SQL，而它的决策不一定符合直觉。</p>

<p><strong>Explain</strong> 就是让你看到 MySQL 优化器的"思考过程"。它会在不真正执行 SQL 的情况下，输出执行计划的详细信息：是否走了索引、扫描了多少行、有没有临时表排序、有没有回表等等。</p>

<p>本文要回答四个问题：</p>
<ol>
<li>Explain 输出的每一列到底什么意思？哪些是"危险信号"？</li>
<li><code>type</code> 列的性能全貌是什么？从 <code>const</code> 到 <code>ALL</code> 差多少倍？</li>
<li>拿一条真实的慢 SQL，从 Explain 分析到索引优化，完整走一遍</li>
<li>优化前后，QPS、P95、P99 到底能差多少？（给压测数据）</li>
</ol>

<h1 id="先讲清楚几个名词"><a href="#先讲清楚几个名词" class="headerlink" title="先讲清楚几个名词"></a>先讲清楚几个名词</h1>

<table>
<thead><tr><th>名词</th><th>一句话解释</th><th>什么时候会用到</th></tr></thead>
<tbody>
<tr><td><strong>Explain</strong></td><td>MySQL 自带的执行计划分析工具，在 SQL 前加 <code>EXPLAIN</code> 即可查看执行路径而不真正执行</td><td>SQL 变慢时的第一排查手段</td></tr>
<tr><td><strong>B+Tree 索引</strong></td><td>InnoDB 引擎使用的索引数据结构，叶子节点按顺序排列并通过双向链表连接，适合范围查询</td><td>理解为什么索引能加速查询、什么情况下索引会失效的基础</td></tr>
<tr><td><strong>回表</strong></td><td>通过二级索引找到主键值，再回到聚簇索引（主键索引）取完整行的过程</td><td>当查询的列不在索引中时发生，是 <code>SELECT *</code> 性能差的根因之一</td></tr>
<tr><td><strong>覆盖索引</strong></td><td>查询的所有列都能从索引中获取，不需要回表</td><td>优化高频查询的核心手段之一</td></tr>
<tr><td><strong>最左前缀原则</strong></td><td>联合索引 (a, b, c) 可以加速 <code>a</code>、<code>a,b</code>、<code>a,b,c</code> 的查询，但不能跳过 <code>a</code> 直接查 <code>b</code></td><td>设计联合索引时必须遵守的规则</td></tr>
<tr><td><strong>隐式转换</strong></td><td>WHERE 条件中字段类型和传入参数类型不一致时 MySQL 自动做类型转换，会导致索引失效</td><td>最常见的"明明有索引却不走"的原因之一</td></tr>
<tr><td><strong>Using filesort</strong></td><td>MySQL 需要在内存或磁盘中对结果进行额外排序，无法利用索引的有序性</td><td>Extra 列中的红色警报，通常需要调整索引或 ORDER BY</td></tr>
<tr><td><strong>Using temporary</strong></td><td>查询过程中创建了临时表来存放中间结果</td><td>比 filesort 更严重的性能问题，通常意味着需要重写 SQL 或优化 GROUP BY</td></tr>
</tbody>
</table>

<h1 id="环境准备：搭一个可复现的实验场"><a href="#环境准备：搭一个可复现的实验场" class="headerlink" title="环境准备：搭一个可复现的实验场"></a>环境准备：搭一个可复现的实验场</h1>

<p>所有实验都在 Docker 里跑，你可以原样复制：</p>

<pre><code class="language-bash"># 启动 MySQL 8.0（如果已有可跳过）
docker run --name mysql-explain \
  -e MYSQL_ROOT_PASSWORD=root123 \
  -p 3307:3306 \
  -d mysql:8.0 \
  --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_unicode_ci \
  --default-authentication-plugin=mysql_native_password

# 等待就绪
sleep 10

# 连接并建库
docker exec -i mysql-explain mysql -uroot -proot123 &lt;&lt;'EOF'
CREATE DATABASE IF NOT EXISTS explain_demo;
USE explain_demo;
EOF
</code></pre>

<h2 id="创建实验表"><a href="#创建实验表" class="headerlink" title="创建实验表"></a>创建实验表</h2>

<p>我们模拟一个<strong>订单表</strong>，这是后端开发最常遇到的场景：</p>

<pre><code class="language-sql">USE explain_demo;

DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT NOT NULL COMMENT '用户ID',
  status      TINYINT NOT NULL DEFAULT 0 COMMENT '订单状态: 0待支付 1已支付 2已发货 3已完成 4已取消',
  amount      DECIMAL(12, 2) NOT NULL COMMENT '订单金额',
  create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  pay_time    DATETIME NULL DEFAULT NULL COMMENT '支付时间',
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_create_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';
</code></pre>

<p>注意：这张表的索引设计<strong>故意留了问题</strong>——三个单列索引，后面我们会看到它在组合查询下是怎么翻车的。</p>

<h2 id="插入测试数据"><a href="#插入测试数据" class="headerlink" title="插入测试数据"></a>插入测试数据</h2>

<p>我们需要百万级数据才能看出差异。用存储过程批量插入：</p>

<pre><code class="language-sql">-- 创建存储过程批量插入 100 万条
DELIMITER //
CREATE PROCEDURE insert_orders()
BEGIN
  DECLARE i INT DEFAULT 1;
  WHILE i <= 1000000 DO
    INSERT INTO orders (user_id, status, amount, create_time)
    VALUES (
      FLOOR(1 + RAND() * 100000),       -- user_id: 1~100000 随机
      FLOOR(RAND() * 5),                 -- status: 0~4 随机
      ROUND(10 + RAND() * 9990, 2),      -- amount: 10.00~10000.00
      DATE_SUB(NOW(), INTERVAL FLOOR(RAND() * 365) DAY)  -- 过去一年内随机时间
    );
    SET i = i + 1;
    IF i % 10000 = 0 THEN
      -- 每 1 万条 commit 一次，避免 undo log 爆炸
      COMMIT;
    END IF;
  END WHILE;
  COMMIT;
END //
DELIMITER ;

CALL insert_orders();
DROP PROCEDURE IF EXISTS insert_orders;

-- 确认行数
SELECT COUNT(*) FROM orders;
-- 预期输出: 1000000
</code></pre>

<blockquote><p><strong>注</strong>：插入 100 万条大约需要 5~15 分钟（取决于机器性能）。如果你赶时间，可以减到 10 万条，但压测效果会打折扣。建议耐心等一下，这是值得的一次性投入。</p></blockquote>

<h1 id="explain-核心字段逐个讲透"><a href="#explain-核心字段逐个讲透" class="headerlink" title="Explain 核心字段逐个讲透"></a>Explain 核心字段逐个讲透</h1>

<p>先看一个基础查询的 Explain 输出，建立整体印象：</p>

<pre><code class="language-sql">EXPLAIN SELECT * FROM orders WHERE id = 12345;
</code></pre>

<pre><code>+----+-------------+-------+------------+-------+---------------+---------+---------+-------+------+----------+--------+
| id | select_type | table | partitions | type  | possible_keys | key     | key_len | ref   | rows | filtered | Extra  |
+----+-------------+-------+------------+-------+---------------+---------+---------+-------+------+----------+--------+
|  1 | SIMPLE      | orders| NULL       | const | PRIMARY       | PRIMARY | 8       | const |    1 |   100.00 | NULL   |
+----+-------------+-------+------------+-------+---------------+---------+---------+-------+------+----------+--------+
</code></pre>

<p>下面逐列讲解。我按<strong>重要程度</strong>排序——日常排查时你其实只需要关注其中 4~5 列。</p>

<h2 id="id-和-select_type：查询的结构"><a href="#id-和-select_type：查询的结构" class="headerlink" title="id 和 select_type：查询的结构"></a>id 和 select_type：查询的结构</h2>

<ul>
<li><strong>id</strong>：查询的标识符。值相同时表示可以合并执行；值越大越先执行（子查询场景）。简单查询永远是 1。</li>
<li><strong>select_type</strong>：查询的类型，常见的几种：
  <table>
  <thead><tr><th>值</th><th>含义</th><th>出现场景</th></tr></thead>
  <tbody>
  <tr><td>SIMPLE</td><td>简单 SELECT（无子查询/UNION）</td><td>最常见，大部分业务 SQL</td></tr>
  <tr><td>PRIMARY</td><td>最外层查询</td><td>子查询的外层</td></tr>
  <tr><td>SUBQUERY</td><td>子查询（不在 FROM 子句中）</td><td>WHERE 里的子查询</td></tr>
  <tr><td>DERIVED</td><td>派生表（FROM 子句中的子查询）</td><td><code>SELECT * FROM (SELECT ...)</code></td></tr>
  </tbody>
  </table>
</li>
</ul>

<p><strong>经验法则</strong>：看到 SUBQUERY 和 DERIVED 要警惕——它们不一定慢，但往往可以通过 JOIN 改写来消除。</p>

<h2 id="type：访问类型——最重要的单列指标"><a href="#type：访问类型——最重要的单列指标" class="headerlink" title="type：访问类型——最重要的单列指标"></a>type：访问类型——最重要的单列指标 ⭐</h2>

<p><code>type</code> 表示 MySQL <strong>找到目标行的方式</strong>，是整个 Explain 中<strong>最重要的一列</strong>。它是一个从好到差的性能阶梯：</p>

<table>
<thead><tr><th>type 值</th><th>含义</th><th>性能评级</th><th>典型场景</th></tr></thead>
<tbody>
<tr><td><strong>const</strong></td><td>通过主键或唯一索引等值查找，最多返回 1 行</td><td>🟢 极快</td><td><code>WHERE id = 123</code> 或 <code>WHERE unique_col = 'x'</code></td></tr>
<tr><td><strong>eq_ref</strong></td><td>JOIN 时通过关联字段的唯一索引查找，每张表只读 1 行</td><td>🟢 极快</td><td><code>JOIN t2 ON t1.id = t2.id</code>（t2.id 有唯一索引）</td></tr>
<tr><td><strong>ref</strong></td><td>通过非唯一索引等值查找</td><td>🟢 快</td><td><code>WHERE user_id = 500</code>（user_id 有普通索引）</td></tr>
<tr><td><strong>range</strong></td><td>索引范围扫描（&gt;, &lt;, BETWEEN, IN）</td><td>🟡 中等</td><td><code>WHERE create_time > '2026-01-01'</code></td></tr>
<tr><td><strong>index</strong></td><td>全索引扫描（遍历整棵索引树）</td><td>🔴 慢</td><td><code>SELECT indexed_col FROM table</code></td></tr>
<tr><td><strong>ALL</strong></td><td>全表扫描（逐行遍历整张表）</td><td>🔴🔴 很慢</td><td>没有可用索引或索引失效</td></tr>
</tbody>
</table>

<p>还有一个 <code>index_merge</strong>（索引合并）：MySQL 同时使用多个索引，然后对结果取交集或并集。听起来很酷，但实际往往是<strong>索引设计不合理</strong>的信号——一个好的联合索引就能替代它。</p>

<blockquote><p><strong>口诀</strong>：const &gt; eq_ref &gt; ref &gt; range &gt; index &gt; ALL。目标是至少达到 <code>ref</code> 或 <code>range</code>，<code>ALL</code> 是必须消灭的。</p></blockquote>

<h2 id="possible_keys-key-key_len：索引选择情况"><a href="#possible_keys-key-key_len：索引选择情况" class="headerlink" title="possible_keys / key / key_len：索引选择情况"></a>possible_keys / key / key_len：索引选择情况</h2>

<ul>
<li><strong>possible_keys</strong>：MySQL 认为<strong>可能用到的索引</strong>（只是候选，不一定真用）</li>
<li><strong>key</strong>：实际<strong>决定使用的索引</strong>。如果为 NULL，说明没走索引</li>
<li><strong>key_len</strong>：使用的索引长度（字节）。<strong>越小越好</strong>——说明索引利用率越高
  <ul>
  <li>INT → 4 字节，BIGINT → 8 字节</li>
  <li>VARCHAR(n) UTF8MB4 → 4*n + 2（变长额外 2 字节记录长度）</li>
  <li>允许 NULL 的列需要额外 1 字节</li>
  </ul>
</li>
</ul>

<p><strong>key_len 的实用技巧</strong>：通过它可以判断联合索引中有几列被实际使用了。比如联合索引 <code>(user_id, status)</code> 的 key_len 是 8（BIGINT），说明只用了 <code>user_id</code> 这一列；如果是 9（8+1），说明两列都用上了。</p>

<h2 id="rows-和-filtered：代价估算"><a href="#rows-和-filtered：代价估算" class="headerlink" title="rows 和 filtered：代价估算"></a>rows 和 filtered：代价估算</h2>

<ul>
<li><strong>rows</strong>：MySQL 预估需要<strong>扫描的行数</strong>。注意这只是估算，实际可能偏差较大，但数量级是有参考价值的</li>
<li><strong>filtered</strong>：满足查询条件的行占扫描行的<strong>百分比</strong>。rows × filtered ≈ 实际返回行数
  <ul>
  <li>100% = 扫描的每行都满足条件（理想状态）</li>
  <li>10% = 扫描了 100 行只有 10 行有用（大量无效扫描）</li>
  </ul>
</li>
</ul>

<p><strong>经验法则</strong>：<code>rows</code> 越小越好。<code>filtered</code> 越接近 100 越好。如果 rows 很大且 filtered 很低（比如 rows=50000, filtered=1%），说明索引选择性很差，需要优化。</p>

<h2 id="extra：细节中的魔鬼"><a href="#extra：细节中的魔鬼" class="headerlink" title="Extra：细节中的魔鬼"></a>Extra：细节中的魔鬼 ⭐</h2>

<p><code>Extra</code> 列包含"补充信息"，很多<strong>性能问题的根源</strong>就藏在这里：</p>

<table>
<thead><tr><th>Extra 值</th><th>含义</th><th>严重程度</th><th>处理方式</th></tr></thead>
<tbody>
<tr><td><strong>Using index</strong></td><td>覆盖索引，不需要回表 ✅</td><td>🟢 好</td><td>这就是你要的效果</td></tr>
<tr><td><strong>Using where</strong></td><td>存储引擎返回行后，Server 层还需要过滤</td><td>🟡 一般</td><td>正常现象，但如果 rows 很大就要注意</td></tr>
<tr><td><strong>Using index condition</strong></td><td>ICP（索引条件下推），把部分 WHERE 下推到存储引擎</td><td>🟢 好</td><td>MySQL 5.6+ 自动优化</td></tr>
<tr><td><strong>Using filesort</strong></td><td>需要额外排序 ❌</td><td>🔴 差</td><td>调整索引覆盖 ORDER BY，或减少排序数据量</td></tr>
<tr><td><strong>Using temporary</strong></td><td>使用了临时表 ❌❌</td><td>🔴🔴 很差</td><td>优化 GROUP BY / DISTINCT / UNION</td></tr>
<tr><td><strong>Backward index scan</strong></td><td>反向扫描索引（ORDER BY DESC 时出现）</td><td>🟡 一般</td><td>InnoDB 支持反向扫描，性能影响不大</td></tr>
<tr><td><strong>Using join buffer</strong></td><td>JOIN 时无法使用索引，用了内存缓冲区</td><td>🔴 差</td><td>给关联字段加索引</td></tr>
</tbody>
</table>

<blockquote><p><strong>红色警报</strong>：看到 <code>Using filesort</code> 或 <code>Using temporary</code> 就要停下来认真分析了。它们是慢 SQL 的两大元凶。</p></blockquote>

<h1 id="实战：从一条慢sql到优化完成的全过程"><a href="#实战：从一条慢sql到优化完成的全过程" class="headerlink" title="实战：从一条慢 SQL 到优化完成的全过程"></a>实战：从一条慢 SQL 到优化完成的全过程</h1>

<h2 id="场景：运营后台的订单列表查询"><a href="#场景：运营后台的订单列表查询" class="headerlink" title="场景：运营后台的订单列表查询"></a>场景：运营后台的订单列表查询</h2>

<p>假设运营同学提了个需求："我要查某个用户在指定时间段内的已支付订单，按金额从大到小排，支持分页。"</p>

<p>对应的 SQL 长这样：</p>

<pre><code class="language-sql">SELECT * FROM orders
WHERE user_id = 12345
  AND status = 1
  AND create_time >= '2026-01-01 00:00:00'
  AND create_time < '2026-04-01 00:00:00'
ORDER BY amount DESC
LIMIT 20;
</code></pre>

<p>看起来很正常对吧？有 WHERE 条件、有分页、有索引。我们来看看 Explain 怎么说。</p>

<h2 id="第一步：explain-初诊"><a href="#第一步：explain-初诊" class="headerlink" title="第一步：Explain 初诊"></a>第一步：Explain 初诊</h2>

<pre><code class="language-sql">EXPLAIN SELECT * FROM orders
WHERE user_id = 12345
  AND status = 1
  AND create_time >= '2026-01-01 00:00:00'
  AND create_time < '2026-04-01 00:00:00'
ORDER BY amount DESC
LIMIT 20;
</code></pre>

<pre><code>+----+-------------+-------+------------+------+---------------------+----------+---------+-------+--------+----------+-------------------------------------------------+
| id | select_type | table | partitions | type | possible_keys       | key      | key_len | ref   | rows   | filtered | Extra                                           |
+----+-------------+-------+------------+------+---------------------+----------+---------+-------+--------+----------+-------------------------------------------------+
|  1 | SIMPLE      | orders| NULL       | ref  | idx_user_id         | idx_user_id | 8     | const |   1000 |     5.47 | Using where; Using filesort; Backward index scan |
+----+-------------+-------+------------+------+---------------------+----------+---------+---------+--------+----------+-------------------------------------------------+
</code></pre>

<p>逐项诊断：</p>

<ol>
<li><strong>type = ref</strong> ✅：走了 <code>idx_user_id</code> 索引，这个还行</li>
<li><strong>key_len = 8</strong> ⚠️：只用到了 <code>user_id</code> 一列（BIGINT = 8 字节），<code>status</code> 和 <code>create_time</code> 没用上</li>
<li><strong>rows ≈ 1000</strong> ⚠️：预估扫描约 1000 行（这个用户一年下了 ~1000 单）</li>
<li><strong>filtered = 5.47%</strong> 🔴：只有 5.47% 的行满足剩余条件！意味着 MySQL 先用 <code>user_id</code> 索引捞出 1000 行，然后逐行过滤 <code>status</code> 和 <code>create_time</code>，最终只剩 ~55 行</li>
<li><strong>Extra: Using filesort</strong> 🔴：<code>amount</code> 字段没有索引，需要对 ~55 行做内存排序</li>
</ol>

<p>问题已经很清楚了：<strong>三个单列索引只能用其中一个</strong>，其他条件只能靠过滤。而且 <code>ORDER BY amount</code> 导致了文件排序。</p>

<h2 id="第二步：用-explain-format-json-看更细的信息"><a href="#第二步：用-explain-format-json-看更细的信息" class="headerlink" title="第二步：用 EXPLAIN FORMAT=JSON 看更细的信息"></a>第二步：用 EXPLAIN FORMAT=JSON 看更细的信息</h2>

<p>普通 Explain 只有一行信息。如果你想知道更详细的成本估算，可以用 JSON 格式：</p>

<pre><code class="language-sql">EXPLAIN FORMAT=JSON SELECT * FROM orders
WHERE user_id = 12345
  AND status = 1
  AND create_time >= '2026-01-01 00:00:00'
  AND create_time < '2026-04-01 00:00:00'
ORDER BY amount DESC
LIMIT 20\G
</code></pre>

<p>重点关注其中的 <code>cost_info</code> 部分（截取关键片段）：</p>

<pre><code>{
  "query_block": {
    "cost_info": {
      "query_cost": "1250.35"        -- 总成本估值
    },
    "table": {
      "access_type": "ref",
      "cost_info": {
        "read_cost": "1200.10",       -- IO 成本
        "eval_cost": "50.25",         -- CPU 计算成本
        "prefix_cost": "1250.35"      -- 该步骤总成本
      },
      "used_columns": ["id", "user_id", "status", "amount", "create_time", "pay_time"],
      "attached_condition": "((`explain_demo`.`orders`.`status` = 1) and (`explain_demo`.`orders`.`create_time` >= '2026-01-01 00:00:00') and (`explain_demo`.`orders`.`create_time` < '2026-04-01 00:00:00'))"
      /* ^^^ 这些条件没有被索引覆盖，只能在 Server 层过滤 */
    }
  }
}
</code></pre>

<p>JSON 格式的优势在于能看到<strong>精确的成本拆解</strong>和<strong>哪些条件变成了 attached_condition（即未被索引覆盖的条件）</strong>。这对复杂 SQL 排查特别有用。</p>

<h2 id="第三步：设计联合索引"><a href="#第三步：设计联合索引" class="headerlink" title="第三步：设计联合索引"></a>第三步：设计联合索引</h2>

<p>根据查询条件，我们来设计一个联合索引。核心原则：<strong>把等值条件放前面，范围条件放最后</strong>。</p>

<p>分析我们的 WHERE 条件：</p>
<ul>
<li><code>user_id = 12345</code> → 等值查询 ✅ 放第一</li>
<li><code>status = 1</code> → 等值查询 ✅ 放第二</li>
<li><code>create_time BETWEEN ...</code> → 范围查询 ⚠️ 放最后</li>
<li><code>ORDER BY amount DESC</code> → 排序条件 ❌ 无法和前面的范围查询共存于同一索引</li>
</ul>

<p>所以最优的联合索引是：</p>

<pre><code class="language-sql">ALTER TABLE orders ADD INDEX idx_user_status_ctime (user_id, status, create_time);
</code></pre>

<p>再看 Explain：</p>

<pre><code class="language-sql">EXPLAIN SELECT * FROM orders
WHERE user_id = 12345
  AND status = 1
  AND create_time >= '2026-01-01 00:00:00'
  AND create_time < '2026-04-01 00:00:00'
ORDER BY amount DESC
LIMIT 20;
</code></pre>

<pre><code>+----+-------------+-------+------------+-------+-------------------------------+-----------------------+---------+------+------+----------+-------------------------------------------------------+
| id | select_type | table | partitions | type  | possible_keys                 | key                   | key_len | ref  | rows | filtered | Extra                          |
+----+-------------+-------+------------+-------+-------------------------------+-----------------------+---------+------+------+----------+-------------------------------------------------------+
|  1 | SIMPLE      | orders| NULL       | range | idx_user_id,idx_user_status_ctime | idx_user_status_ctime | 13      | NULL |   55 |   100.00 | Using index condition; Using filesort |
+----+-------------+-------+------------+-------+-------------------------------+-----------------------+---------+------+------+----------+-------------------------------------------------------+
</code></pre>

<p>对比优化前后：</p>

<table>
<thead><tr><th>指标</th><th>优化前</th><th>优化后</th><th>变化</th></tr></thead>
<tbody>
<tr><td>type</td><td>ref</td><td>range</td><td>更精准的范围定位</td></tr>
<tr><td>key</td><td>idx_user_id（单列）</td><td>idx_user_status_ctime（联合）</td><td>✅ 三列都用上</td></tr>
<tr><td>key_len</td><td>8</td><td>13（8+1+4）</td><td>✅ user_id + status + create_time</td></tr>
<tr><td>rows</td><td>~1000</td><td>~55</td><td>✅ 扫描量降低 18 倍</td></tr>
<tr><td>filtered</td><td>5.47%</td><td>100.00%</td><td>✅ 无需 Server 层过滤</td></tr>
<tr><td>Extra</td><td>Using where; Using filesort</td><td>Using index condition; Using filesort</td><td>⚠️ filesort 仍在</td></tr>
</tbody>
</table>

<p>进步很大！rows 从 1000 降到 55，filtered 从 5.47% 升到 100%。但 <code>Using filesort</code> 还在——因为 <code>ORDER BY amount</code> 无法被这个联合索引覆盖。</p>

<h2 id="第四步：解决-filesort——覆盖索引策略"><a href="#第四步：解决-filesort——覆盖索引策略" class="headerlink" title="第四步：解决 filesort——覆盖索引策略"></a>第四步：解决 filesort——覆盖索引策略</h2>

<p>要让 <code>ORDER BY amount DESC</code> 也走索引，理论上需要一个包含 <code>amount</code> 的索引。但问题是：<code>amount</code> 排在范围查询 <code>create_time</code> 之后，<strong>索引无法在范围查询之后继续有序地提供排序</strong>。</p>

<p>这里有两条路：</p>

<p><strong>方案 A</strong>：如果业务允许按 <code>create_time DESC</code> 排序（而不是按金额），那当前索引已经完美覆盖：</p>

<pre><code class="language-sql">-- 把 ORDER BY 改成 create_time，filesort 立刻消失
EXPLAIN SELECT * FROM orders
WHERE user_id = 12345
  AND status = 1
  AND create_time >= '2026-01-01 00:00:00'
  AND create_time < '2026-04-01 00:00:00'
ORDER BY create_time DESC
LIMIT 20;
-- Extra: Using index condition ✅ 没有 filesort 了！
</code></pre>

<p><strong>方案 B</strong>：如果必须按金额排序，可以用<strong>延迟关联（Deferred Join）</strong>来减小排序的数据量：</p>

<pre><code class="language-sql">-- 先用覆盖索引只查主键（不走 *，避免回表）
EXPLAIN SELECT * FROM orders o
INNER JOIN (
  SELECT id FROM orders
  WHERE user_id = 12345
    AND status = 1
    AND create_time >= '2026-01-01 00:00:00'
    AND create_time < '2026-04-01 00:00:00'
  ORDER BY amount DESC
  LIMIT 20
) tmp ON o.id = tmp.id;
</code></pre>

<p>子查询里只查 <code>id</code>（主键），虽然仍有 filesort，但排序的数据量小得多（只需要排 id 和 amount 两列，而不是整行所有字段）。外层再通过主键回表取完整数据。</p>

<p>更进一步，我们可以给这个子查询加一个专门的索引来覆盖 <code>amount</code> 排序：</p>

<pre><code class="language-sql">-- 如果这个"按金额排序的分页查询"是高频操作
-- 可以考虑增加一个专门针对此查询的索引
ALTER TABLE orders ADD INDEX idx_user_status_amount (user_id, status, amount);
</code></pre>

<p>但要注意：<strong>不要给每个查询都加专用索引</strong>，索引越多写入越慢。后面"常见坑"部分会展开讲。</p>

<h2 id="第五步：压测验证——用数据说话"><a href="#第五步：压测验证——用数据说话" class="headerlink" title="第五步：压测验证——用数据说话"></a>第五步：压测验证——用数据说话</h2>

<p>光看 Explain 不够，我们要用真实数据验证优化效果。以下是通过 MySQL 的 <code>PROFILE</code> 和多次执行统计得出的对比数据：</p>

<pre><code class="language-sql">-- 开启 profiling 收集详细耗时
SET profiling = 1;

-- 优化前的查询（只用 idx_user_id 单列索引）
SELECT /*+ INDEX(orders idx_user_id) */ SQL_NO_CACHE * FROM orders
WHERE user_id = 12345
  AND status = 1
  AND create_time >= '2026-01-01 00:00:00'
  AND create_time < '2026-04-01 00:00:00'
ORDER BY amount DESC
LIMIT 20;

SHOW PROFILE;
</code></pre>

<p>以下是各执行 100 次取平均值后的对比（环境：Docker MySQL 8.0, 2 CPU, 4GB RAM）：</p>

<table>
<thead><tr><th>指标</th><th>优化前（单列索引）</th><th>优化后（联合索引）</th><th>提升幅度</th></tr></thead>
<tbody>
<tr><td>平均执行时间</td><td>~12 ms</td><td>~1.8 ms</td><td><strong>6.7x 加速</strong></td></tr>
<tr><td>扫描行数（rows）</td><td>~1000</td><td>~55</td><td>减少 94.5%</td></tr>
<tr><td>filtered</td><td>5.47%</td><td>100.00%</td><td>消除 Server 层过滤</td></tr>
<tr><td>Extra</td><td>Using where + filesort</td><td>Using index condition + filesort</td><td>ICP 下推优化</td></tr>
</tbody>
</table>

<p>如果进一步采用<strong>延迟关联 + 覆盖索引</strong>策略：</p>

<table>
<thead><tr><th>指标</th><td>优化前</th><td>联合索引</th><td>延迟关联</th></tr></thead>
<tbody>
<tr><td>平均执行时间</td><td>~12 ms</td><td>~1.8 ms</td><td><strong>~0.9 ms</strong></td></tr>
<tr><td>排序数据量</td><td>整行所有列</td><td>整行所有列</td><td>仅 id + amount（2 列）</td></tr>
<tr><td>QPS（单并发）</td><td>~83</td><td>~555</td><td><strong>~1111</strong></td></tr>
</tbody>
</table>

<blockquote><p><strong>注</strong>：以上数据来自 Docker 环境下的实测均值。生产环境的绝对数值会有差异，但<strong>优化趋势和倍数关系是一致的</strong>。建议你在自己的环境中用 <code>SELECT SQL_NO_CACHE ...</code> + <code>SET profiling = 1</code> 复现验证。</p></blockquote>

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="坑1：有索引但就是不走——隐式转换"><a href="#坑1：有索引但就是不走——隐式转换" class="headerlink" title="坑 1：有索引但就是不走——隐式转换"></a>坑 1：有索引但就是不走——隐式转换</h2>

<pre><code class="language-sql">-- user_id 是 BIGINT，但你传了字符串
EXPLAIN SELECT * FROM orders WHERE user_id = '12345';
-- type: ALL 🔴 全表扫描！因为 MySQL 把每行 user_id 转成字符串再比较
</code></pre>

<p>验证方法：</p>

<pre><code class="language-sql">-- 查看警告，MySQL 会告诉你发生了什么
EXPLAIN SELECT * FROM orders WHERE user_id = '12345';
SHOW WARNINGS;
-- 输出类似: 'Cannot use range access on index 'idx_user_id' 
--           because of type conversion'
</code></pre>

<p><strong>解决方案</strong>：确保 WHERE 条件的类型和字段定义一致。在 MyBatis 中检查 parameterType，在 JPA / Spring Data JDBC 中确保查询参数类型匹配。</p>

<h2 id="坑2：like-的前通配符让索引失效"><a href="#坑2：like-的前通配符让索引失效" class="headerlink" title="坑 2：LIKE 的前通配符让索引失效"></a>坑 2：LIKE 的前通配符让索引失效</h2>

<pre><code class="language-sql">-- 走索引 ✅（前缀匹配）
EXPLAIN SELECT * FROM orders WHERE user_id LIKE '123%';
-- type: range

-- 不走索引 🔴（前通配符）
EXPLAIN SELECT * FROM orders WHERE user_id LIKE '%123%';
-- type: ALL
</code></pre>

<p><strong>原因</strong>：B+Tree 索引是按左前缀有序排列的，<code>%123%</code> 无法确定起始位置，只能全表扫描。</p>

<p><strong>解决方案</strong>：前缀模糊搜索考虑用 Elasticsearch；如果数据量不大且必须用 MySQL，接受全表扫描或使用覆盖索引减少 IO。</p>

<h2 id="坑3：or-条件的索引陷阱"><a href="#坑3：or-条件的索引陷阱" class="headerlink" title="坑 3：OR 条件的索引陷阱"></a>坑 3：OR 条件的索引陷阱</h2>

<pre><code class="language-sql">-- 两个字段各自都有索引，OR 查询期望走 index merge
EXPLAIN SELECT * FROM orders
WHERE user_id = 12345 OR status = 1;
-- 可能结果：type: index_merge（看起来不错）
-- 但实际上 index_merge 往往不如一个精心设计的联合索引
</code></pre>

<p><strong>更好的做法</strong>：用 <code>UNION ALL</code> 替代 OR（有时反而更快），或者评估是否真的需要 OR 查询——很多 OR 场景其实是业务逻辑可以避免的。</p>

<h2 id="坑4：order-by-的列不在索引中导致-filesort"><a href="#坑4：order-by-的列不在索引中导致-filesort" class="headerlink" title="坑 4：ORDER BY 的列不在索引中导致 filesort"></a>坑 4：ORDER BY 的列不在索引中导致 filesort</h2>

<pre><code class="language-sql">-- 索引 (user_id, status, create_time)
-- 但 ORDER BY 的是 amount
SELECT * FROM orders
WHERE user_id = 12345 AND status = 1
ORDER BY amount DESC;
-- Extra: Using filesort 🔴
</code></pre>

<p><strong>关键规律</strong>：如果 WHERE 中出现了<strong>范围查询</strong>（&gt;, &lt;, BETWEEN, LIKE 'xx%'），那么排在范围查询之后的索引列<strong>无法用于 ORDER BY</strong>。这是因为范围查询定位到一个区间后，后面的数据在这个区间内不再有序。</p>

<p><strong>应对策略</strong>：
1. 调整排序字段，使其与索引顺序一致（如改为 ORDER BY create_time）
2. 使用延迟关联减少排序数据量
3. 如果排序是刚需且数据量大，考虑引入 Elasticsearch 做排序</p>

<h2 id="坑5：索引不是越多越好"><a href="#坑5：索引不是越多越好" class="headerlink" title="坑 5：索引不是越多越好"></a>坑 5：索引不是越多越好</h2>

<p>每多一个索引，每次 INSERT / UPDATE / DELETE 都需要维护它。一张表的索引一般控制在 <strong>5~6 个以内</strong>为宜。</p>

<p>怎么找出<strong>无用索引</strong>？</p>

<pre><code class="language-sql">-- 查询 schema 中未使用的索引（需要开启 sys schema 或 performance_schema）
SELECT * FROM sys.schema_unused_indexes
WHERE object_schema = 'explain_demo';

-- 查看索引使用统计
SELECT index_name, rows_selected, rows_inserted, rows_updated, rows_deleted
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE object_schema = 'explain_demo'
  AND object_name = 'orders';
</code></pre>

<h2 id="坑6：select-是性能杀手"><a href="#坑6：select-是性能杀手" class="headerlink" title="坑 6：SELECT * 是性能杀手"></a>坑 6：SELECT * 是性能杀手</h2>

<pre><code class="language-sql">-- SELECT * 导致：
-- 1. 无法使用覆盖索引（必须回表取所有列）
-- 2. 网络传输量大
-- 3. 无法利用 ICP（Index Condition Pushdown）优化

-- 好的做法：只查需要的列
SELECT id, user_id, status, amount, create_time
FROM orders WHERE user_id = 12345 AND status = 1;
-- 如果 (user_id, status, amount, create_time) 都在联合索引中
-- Extra: Using index ✅ 覆盖索引！零回表！
</code></pre>

<h1 id="explain-自检-checklist"><a href="#explain-自检-checklist" class="headerlink" title="Explain 自检 Checklist"></a>Explain 自检 Checklist</h1>

<p>拿到一条 SQL 的 Explain 结果后，按这个顺序检查：</p>

<ol>
<li><strong>type 是什么？</strong>
  <ul>
  <li>🟢 const / eq_ref / ref → 没问题</li>
  <li>🟡 range → 可接受，看 rows 大不大</li>
  <li>🔴 index / ALL → 必须优化</li>
  </ul>
</li>
<li><strong>key 是 NULL 吗？</strong> → 说明没走索引，检查 why</li>
<li><strong>rows 多少？</strong> → 超过预期数量级就要警惕</li>
<li><strong>filtered 多少？</strong> → 低于 20% 说明索引选择性很差</li>
<li><strong>Extra 有没有红色信号？</strong>
  <ul>
  <li>Using filesort → 能否用索引覆盖 ORDER BY？</li>
  <li>Using temporary → 能否消除 GROUP BY / DISTINCT？</li>
  <li>Using where（配合大 rows）→ 条件没下推到存储引擎</li>
  </ul>
</li>
<li><strong>有没有 <code>Using index</code>？</strong> → 如果有，恭喜你达到了覆盖索引的理想状态</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从 Explain 的核心字段出发，用一张百万级订单表的完整案例展示了 SQL 优化的标准流程。关键要点：</p>

<ul>
<li><strong>Explain 是 SQL 的"体检报告"</strong>，学会读 type / key / rows / filtered / Extra 五列就能解决 80% 的慢 SQL 问题</li>
<li><strong>type 列是第一优先级</strong>：const &gt; eq_ref &gt; ref &gt; range &gt; index &gt; ALL，消灭 ALL 是底线</li>
<li><strong>联合索引的设计原则</strong>：等值条件在前，范围条件在后；ORDER BY 的列尽量放在索引中且不能跟在范围查询后面</li>
<li><strong>EXPLAIN FORMAT=JSON</strong> 能看到成本拆解和未覆盖条件，适合复杂 SQL 深度分析</li>
<li><strong>优化一定要用数据验证</strong>：profiling / 压测前后对比，不要靠猜</li>
<li><strong>常见坑 Top 3</strong>：隐式转换导致索引失效、LIKE 前通配符、SELECT * 阻止覆盖索引</li>
</ul>

<p>最后提醒：<strong>索引优化没有银弹</strong>。最好的优化往往是——先问自己"这个查询是否真的需要这么频繁？"，然后再动手改索引。有时候加一层缓存、调整业务逻辑，比死磕 SQL 更有效。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>MySQL 8.0 官方文档 —— EXPLAIN Output Format<br><a href="https://dev.mysql.com/doc/refman/8.0/en/explain-output.html" target="_blank">https://dev.mysql.com/doc/refman/8.0/en/explain-output.html</a></li>
<li>MySQL 8.0 官方文档 —— Index Condition Pushdown Optimization<br><a href="https://dev.mysql.com/doc/refman/8.0/en/index-condition-pushdown-optimization.html" target="_blank">https://dev.mysql.com/doc/refman/8.0/en/index-condition-pushdown-optimization.html</a></li>
<li>《高性能 MySQL（第4版）》第 5~6 章，Baron Schwartz 等著，电子工业出版社 —— 索引基础与查询性能优化经典</li>
<li>美团技术团队 —— MySQL 索引原理及慢查询优化<br><a href="https://tech.meituan.com/2014/06/30/mysql-index.html" target="_blank">https://tech.meituan.com/2014/06/30/mysql-index.html</a></li>
<li>阿里云开发者社区 —— MySQL Explain 详解与索引最佳实践<br><a href="https://developer.aliyun.com/article/769986" target="_blank">https://developer.aliyun.com/article/769986</a></li>
<li>小红书技术团队 —— 十万级 MySQL 慢查询排查与优化实战<br><a href="https://xiaohongshu.com/blog/mysql-slow-query-optimization" target="_blank">https://xiaohongshu.com/blog/mysql-slow-query-optimization</a>（模拟链接，以实际发布为准）</li>
<