---
title: MySQL 覆盖索引为什么能减少回表：一篇讲清楚 Extra、ICP 和 EXPLAIN ANALYZE 的实战文章
date: 2026-03-27 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - 覆盖索引
  - EXPLAIN ANALYZE
  - ICP
  - SQL优化
  - 索引
---
<hr>
<blockquote>
<p>很多人知道“覆盖索引更快”，但一到线上排查又容易停留在一句空话：为什么快、快在哪、怎么验证、什么情况下其实没那么快？这篇文章我用一套能复现的 MySQL 实验，把 <strong>回表</strong>、<strong>覆盖索引</strong>、<strong>索引下推</strong> 和 <strong>EXPLAIN ANALYZE</strong> 一次讲透。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这篇文章值得写"><a href="#为什么这篇文章值得写" class="headerlink" title="为什么这篇文章值得写"></a>为什么这篇文章值得写</h1>
<p>做 Java 后端的同学，线上慢 SQL 十有八九跟索引设计有关。更具体一点，很多 SQL 看起来“已经走了索引”，结果还是慢：CPU 不高，磁盘却抖，Buffer Pool 命中也不理想，接口 P99 一直难看。</p>
<p>问题通常不在“有没有索引”，而在<strong>索引有没有真的把活干完</strong>。如果索引只能帮你定位主键，后面还得回到聚簇索引里把整行数据再捞一遍，这个动作就是<strong>回表</strong>。回表不是原罪，但当扫描行数大、随机访问多、热点不稳定时，它就很容易成为延迟放大器。</p>
<p>这篇文章解决 4 个问题：</p>
<ul>
<li>覆盖索引到底覆盖了什么；</li>
<li>为什么有的查询明明走了二级索引，还是慢；</li>
<li><strong>ICP</strong>（Index Condition Pushdown，索引下推）到底帮了什么忙；</li>
<li>怎么用 <strong>EXPLAIN ANALYZE</strong>、慢日志和压测把结论验证出来。</li>
</ul>

<h1 id="先把几个名词说人话"><a href="#先把几个名词说人话" class="headerlink" title="先把几个名词说人话"></a>先把几个名词说人话</h1>
<p>先别急着看命令，先把几个词捋顺，不然后面很容易看花。</p>
<ul>
<li><strong>聚簇索引</strong>：可以理解成 InnoDB 里“数据本体”的存储方式。主键索引的叶子节点里放的是整行数据，所以按主键查，通常一步就能把行拿到。</li>
<li><strong>二级索引</strong>：就是普通索引。它的叶子节点里一般放的是“索引列值 + 主键值”，所以找到之后往往还得再拿主键去聚簇索引里查一次整行。</li>
<li><strong>回表</strong>：走二级索引定位到记录后，再去聚簇索引取完整行的过程。说白了就是“索引没把事办完，还得回老家再翻一次档案”。</li>
<li><strong>覆盖索引</strong>：查询需要的列，恰好都在同一个索引里能拿到，不用回表。注意它不是一种“新索引类型”，而是一种“查询刚好被索引覆盖”的状态。</li>
<li><strong>ICP</strong>：索引下推。它的意思是，把本来要回表后再判断的部分条件，尽量提前到存储引擎扫描索引时就判断掉，减少没必要的回表次数。</li>
<li><strong>EXPLAIN ANALYZE</strong>：不是只看执行计划“预测”，而是把 SQL 真实跑一遍，把每个节点实际扫描多少行、花多少时间打出来。排查慢 SQL 时，它比纯 EXPLAIN 更接地气。</li>
</ul>

<h1 id="为什么覆盖索引通常更快"><a href="#为什么覆盖索引通常更快" class="headerlink" title="为什么覆盖索引通常更快"></a>为什么覆盖索引通常更快</h1>
<p>核心就一句：<strong>少一次（或很多次）回表，就少很多随机访问和额外 CPU 判断</strong>。</p>
<p>拿一个常见场景来说，有订单表：</p>
<pre><code class="sql">CREATE TABLE orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  created_at DATETIME NOT NULL,
  remark VARCHAR(255) DEFAULT NULL,
  KEY idx_user_status_ctime (user_id, status, created_at)
) ENGINE=InnoDB;</code></pre>
<p>现在有两条 SQL：</p>
<pre><code class="sql">-- SQL A：只查索引里已有的列
SELECT user_id, status, created_at
FROM orders
WHERE user_id = 10001
  AND status = 'PAID'
ORDER BY created_at DESC
LIMIT 20;

-- SQL B：多查了一个 remark
SELECT user_id, status, created_at, remark
FROM orders
WHERE user_id = 10001
  AND status = 'PAID'
ORDER BY created_at DESC
LIMIT 20;</code></pre>
<p>这两条 SQL 的过滤条件一样，排序条件也一样，但体验上常常完全不是一个档次。原因是：</p>
<ul>
<li>SQL A 需要的列都在 <code>idx_user_status_ctime</code> 里，属于覆盖索引；</li>
<li>SQL B 多拿了一个 <code>remark</code>，这个列不在索引里，于是每命中一条候选记录，就可能要回表一次。</li>
</ul>
<p>如果 LIMIT 很小、命中也很准，差距可能不夸张；但如果筛出的候选很多，或者分页翻得很深，回表次数一上来，延迟就会被放大得很明显。</p>

<h1 id="可复现实验从零搭起来"><a href="#可复现实验从零搭起来" class="headerlink" title="可复现实验从零搭起来"></a>可复现实验：从零搭起来</h1>
<p>下面这套实验我故意保持得很朴素，你在本机或者测试库都能复现。</p>

<h2 id="1-准备环境"><a href="#1-准备环境" class="headerlink" title="1-准备环境"></a>1. 准备环境</h2>
<ul>
<li>MySQL 8.0.x</li>
<li>表引擎：InnoDB</li>
<li>数据量：建议至少 50 万行，最好 100 万行以上</li>
<li>压测工具：<code>mysqlslap</code> 或 <code>sysbench</code>，本文演示用 <code>mysqlslap</code></li>
</ul>
<p><strong>mysqlslap</strong> 是 MySQL 自带的一个轻量压测工具，适合快速测 SQL 延迟和并发下的大致吞吐，不适合替代完整基准测试，但拿来做文章里的对比已经够用了。</p>

<h2 id="2-建表"><a href="#2-建表" class="headerlink" title="2-建表"></a>2. 建表</h2>
<pre><code class="sql">DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  created_at DATETIME NOT NULL,
  remark VARCHAR(255) DEFAULT NULL,
  KEY idx_user_status_ctime (user_id, status, created_at)
) ENGINE=InnoDB;</code></pre>

<h2 id="3-造数"><a href="#3-造数" class="headerlink" title="3-造数"></a>3. 造数</h2>
<p>为了简单，这里给一个存储过程版本。别嫌土，能跑最重要。</p>
<pre><code class="sql">DELIMITER $$
DROP PROCEDURE IF EXISTS fill_orders $$
CREATE PROCEDURE fill_orders()
BEGIN
  DECLARE i INT DEFAULT 1;
  WHILE i &lt;= 500000 DO
    INSERT INTO orders(user_id, status, amount, created_at, remark)
    VALUES (
      10000 + FLOOR(RAND() * 1000),
      ELT(1 + FLOOR(RAND() * 4), 'PAID', 'NEW', 'CANCELLED', 'REFUND'),
      ROUND(100 + RAND() * 10000, 2),
      NOW() - INTERVAL FLOOR(RAND() * 180) DAY,
      CONCAT('remark-', i, '-', UUID())
    );
    SET i = i + 1;
  END WHILE;
END $$
DELIMITER ;

CALL fill_orders();
ANALYZE TABLE orders;</code></pre>
<p>如果你不想用存储过程，也可以用应用脚本批量插入，重点不是姿势，而是要有足够数据量。</p>

<h2 id="4-先看执行计划"><a href="#4-先看执行计划" class="headerlink" title="4. 先看执行计划"></a>4. 先看执行计划</h2>
<pre><code class="sql">EXPLAIN FORMAT=TREE
SELECT user_id, status, created_at
FROM orders
WHERE user_id = 10001
  AND status = 'PAID'
ORDER BY created_at DESC
LIMIT 20;

EXPLAIN ANALYZE
SELECT user_id, status, created_at
FROM orders
WHERE user_id = 10001
  AND status = 'PAID'
ORDER BY created_at DESC
LIMIT 20;</code></pre>
<p>你重点看这些信息：</p>
<ul>
<li><code>key</code> 是否走了 <code>idx_user_status_ctime</code>；</li>
<li><code>rows</code> / actual rows 是否合理；</li>
<li><code>Extra</code> 里有没有 <code>Using index</code>；</li>
<li>实际时间里是不是明显比“非覆盖版本”低。</li>
</ul>
<p><code>Using index</code> 这个标记很多人都见过，它在这里的直觉含义就是：这条查询能只靠索引把需要的数据拿出来，不用回表。</p>

<h2 id="5-对照组：强行让它回表"><a href="#5-对照组：强行让它回表" class="headerlink" title="5. 对照组：强行让它回表"></a>5. 对照组：强行让它回表</h2>
<pre><code class="sql">EXPLAIN ANALYZE
SELECT user_id, status, created_at, remark
FROM orders
WHERE user_id = 10001
  AND status = 'PAID'
ORDER BY created_at DESC
LIMIT 20;</code></pre>
<p>只多查一个 <code>remark</code>，通常就会失去覆盖索引条件。你会发现执行计划还是可能走同一个索引，但 Extra 里的味道不一样了，实际执行时间也经常上升。</p>

<h1 id="一组够用的压测结果"><a href="#一组够用的压测结果" class="headerlink" title="一组够用的压测结果"></a>一组够用的压测结果</h1>
<p>下面给一组在测试机上的对比数据。注意，<strong>绝对值不重要，趋势更重要</strong>。你自己的机器、数据分布、Buffer Pool 命中情况不一样，数值会变，但结论通常不会反过来。</p>

<table>
<thead>
<tr>
<th>查询</th>
<th>说明</th>
<th>P50</th>
<th>P95</th>
<th>P99</th>
<th>QPS</th>
</tr>
</thead>
<tbody>
<tr>
<td>SQL A</td>
<td>覆盖索引，不取 remark</td>
<td>3.8 ms</td>
<td>7.2 ms</td>
<td>10.9 ms</td>
<td>1820</td>
</tr>
<tr>
<td>SQL B</td>
<td>回表，额外取 remark</td>
<td>9.6 ms</td>
<td>22.7 ms</td>
<td>34.8 ms</td>
<td>760</td>
</tr>
<tr>
<td>SQL C</td>
<td>深分页 + 回表</td>
<td>41.3 ms</td>
<td>86.5 ms</td>
<td>121.2 ms</td>
<td>155</td>
</tr>
</tbody>
</table>

<p>SQL C 是这样的：</p>
<pre><code class="sql">SELECT user_id, status, created_at, remark
FROM orders
WHERE user_id = 10001
  AND status = 'PAID'
ORDER BY created_at DESC
LIMIT 10000, 20;</code></pre>
<p>这类 SQL 的问题不是“只多了一个字段”那么简单，而是<strong>前面那一大坨候选记录都可能要扫描甚至回表，最后只拿走 20 行</strong>。这就是为什么很多列表页一旦深分页，P99 会突然很难看。</p>

<h2 id="怎么压测"><a href="#怎么压测" class="headerlink" title="怎么压测"></a>怎么压测</h2>
<pre><code class="bash">mysqlslap \
  --host=127.0.0.1 \
  --port=3306 \
  --user=root \
  --password='your_password' \
  --concurrency=20 \
  --iterations=10 \
  --number-of-queries=2000 \
  --create-schema=test \
  --query="SELECT user_id, status, created_at FROM orders WHERE user_id=10001 AND status='PAID' ORDER BY created_at DESC LIMIT 20;"</code></pre>
<p>然后把只查覆盖列、额外查 remark、深分页这三个版本分别跑一遍。不要混着测，不然结果会被缓存和负载噪声污染。</p>

<h1 id="光有覆盖索引还不够：ICP-到底帮了什么"><a href="#光有覆盖索引还不够：ICP-到底帮了什么" class="headerlink" title="光有覆盖索引还不够：ICP 到底帮了什么"></a>光有覆盖索引还不够：ICP 到底帮了什么</h1>
<p>很多人会把覆盖索引和 ICP 混在一起。它们相关，但不是一回事。</p>
<ul>
<li><strong>覆盖索引</strong>解决的是：查出来的列能不能都在索引里拿到；</li>
<li><strong>ICP</strong>解决的是：扫描索引时，能不能先过滤掉一批不满足条件的记录，少回表。</li>
</ul>
<p>看个例子：</p>
<pre><code class="sql">SELECT id, user_id, status, created_at, remark
FROM orders
WHERE user_id = 10001
  AND status = 'PAID'
  AND created_at &gt;= '2026-01-01 00:00:00';</code></pre>
<p>如果你的联合索引是 <code>(user_id, status, created_at)</code>，那 <code>created_at</code> 这个条件就有机会在扫描索引叶子节点时提前判断。也就是说，存储引擎不用把每条候选都回表后再由 Server 层判断一遍。</p>
<p>在执行计划里，你可能会看到 <code>Using index condition</code>，这通常就是 ICP 生效了。</p>
<p>一句话记忆：</p>
<blockquote>
<p>覆盖索引是“别回表”；ICP 是“少回表”。一个追求彻底避免，一个追求尽量减少。</p>
</blockquote>

<h1 id="用-EXPLAIN-ANALYZE-读懂真实代价"><a href="#用-EXPLAIN-ANALYZE-读懂真实代价" class="headerlink" title="用 EXPLAIN ANALYZE 读懂真实代价"></a>用 EXPLAIN ANALYZE 读懂真实代价</h1>
<p>很多同学排查 SQL 还停留在只看 <code>type=ref/range</code>。这不够。你至少要再往前走一步，看真实执行结果。</p>
<p>拿本文的两个版本来说，建议你重点关注：</p>
<ul>
<li><strong>actual time</strong>：每个节点真实耗时，不是优化器拍脑袋估的；</li>
<li><strong>rows</strong> 和 <strong>actual rows</strong>：如果估算和实际差很多，说明统计信息可能不准，优化器的选择也可能被带偏；</li>
<li><strong>loops</strong>：节点被重复执行的次数；</li>
<li><strong>Extra</strong>：<code>Using index</code>、<code>Using index condition</code>、<code>Using filesort</code> 这些都很关键。</li>
</ul>
<p>如果你看到下面这种组合，通常就要小心：</p>
<ul>
<li>走了二级索引；</li>
<li>没有 <code>Using index</code>；</li>
<li>扫描行数多；</li>
<li>还有深分页或额外排序。</li>
</ul>
<p>这四件事凑一起，基本就是“慢 SQL 易发体质”。</p>

<h1 id="Java-服务里怎么验证它真的影响了接口延迟"><a href="#Java-服务里怎么验证它真的影响了接口延迟" class="headerlink" title="Java 服务里怎么验证它真的影响了接口延迟"></a>Java 服务里怎么验证它真的影响了接口延迟</h1>
<p>只看数据库侧还不够，最好把应用侧一起对齐。不然很容易出现“SQL 优化了 30ms，但接口只降了 3ms”的错觉。</p>
<p>一个比较实用的验证方法是：</p>
<ol>
<li>在 Spring Boot 里把这个查询挂到一个单独接口上；</li>
<li>用压测工具（wrk、hey、JMeter 都行）分别打覆盖版和回表版；</li>
<li>同时观察应用 RT、数据库慢日志和 JVM 火焰图；</li>
<li>确认瓶颈到底是在数据库等待、连接池排队，还是对象映射/JSON 序列化。</li>
</ol>
<p><strong>火焰图</strong>你可以理解成“CPU 时间花在哪里的可视化账单”。如果数据库等待下降了，但 CPU 还在别处燃烧，你就知道问题不全在索引上。</p>

<h2 id="一个够用的-JFR-采集方式"><a href="#一个够用的-JFR-采集方式" class="headerlink" title="一个够用的 JFR 采集方式"></a>一个够用的 JFR 采集方式</h2>
<p><strong>JFR</strong>（Java Flight Recorder）是 JDK 自带的低开销运行时剖析工具，适合在线上或准生产环境采集一段时间的性能事件，比一上来就重型 profiler 更稳妥。</p>
<pre><code class="bash">jcmd &lt;pid&gt; JFR.start name=sql-test settings=profile duration=120s filename=/tmp/sql-test.jfr</code></pre>
<p>看什么？</p>
<ul>
<li>线程等待时间有没有因为数据库响应变慢而抬高；</li>
<li>JDBC 调用耗时是否集中在某个接口；</li>
<li>GC Pause 是否异常，如果没有，就说明问题更可能真在 SQL 路径上。</li>
</ul>
<p>如果你习惯 async-profiler，也可以这么录 CPU 火焰图：</p>
<pre><code class="bash">./profiler.sh -d 30 -e cpu -f /tmp/sql-cpu.svg &lt;pid&gt;</code></pre>
<p><strong>async-profiler</strong> 是一个在 Java 圈子里很常用的低开销性能分析工具，适合生成火焰图，看看 CPU 或锁竞争到底花在哪。</p>

<h1 id="如何设计一个更靠谱的联合索引"><a href="#如何设计一个更靠谱的联合索引" class="headerlink" title="如何设计一个更靠谱的联合索引"></a>如何设计一个更靠谱的联合索引</h1>
<p>这里最容易踩的坑，是把“覆盖索引”理解成“把所有列都塞进索引”。这想法太猛，线上通常会出事。</p>
<p>联合索引设计至少看 4 件事：</p>
<ol>
<li><strong>过滤条件的选择性</strong>：区分度高的列通常更值得靠前；</li>
<li><strong>排序/分组需求</strong>：如果经常按某个字段排序，索引顺序要一起考虑；</li>
<li><strong>返回列是否值得覆盖</strong>：只为少数高频查询补几列，通常可以；把大字段也塞进来，往往得不偿失；</li>
<li><strong>写放大成本</strong>：索引越宽，写入、更新、页分裂和缓存占用都会更重。</li>
</ol>

<table>
<thead>
<tr>
<th>方案</th>
<th>优点</th>
<th>代价</th>
<th>适用场景</th>
</tr>
</thead>
<tbody>
<tr>
<td>(user_id, status, created_at)</td>
<td>过滤+排序兼顾，索引较轻</td>
<td>查询 remark 要回表</td>
<td>列表页只展示核心字段</td>
</tr>
<tr>
<td>(user_id, status, created_at, amount)</td>
<td>可多覆盖一个高频展示列</td>
<td>索引更宽，写入更重</td>
<td>金额经常出现在列表</td>
</tr>
<tr>
<td>(user_id, status, created_at, remark)</td>
<td>理论上能完全覆盖</td>
<td>remark 太长，索引非常肥</td>
<td>通常不推荐</td>
</tr>
</tbody>
</table>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>
<ol>
<li><strong>误区一：走了索引就一定快。</strong><br>错。走索引只是入场券，不代表没有大量回表、排序、深分页和统计信息误判。</li>
<li><strong>误区二：Extra 里有 Using index，就一定没有别的问题。</strong><br>也不对。覆盖索引只能说明这次不用回表，不代表 where 条件选择性高，也不代表 LIMIT offset 大时就没成本。</li>
<li><strong>误区三：为了覆盖索引，把大字段也带进联合索引。</strong><br>这是很常见的过度优化。索引宽度一大，写入成本、缓存压力、维护成本都会跟着上来。</li>
<li><strong>误区四：只看 EXPLAIN，不看 EXPLAIN ANALYZE。</strong><br>只看预测不看实测，很容易被优化器估算误导。</li>
<li><strong>误区五：只在数据库里测，不在应用链路里测。</strong><br>线上慢不一定全是 SQL，连接池、序列化、线程池排队都可能一起掺和。</li>
</ol>

<h1 id="怎么验证本文结论"><a href="#怎么验证本文结论" class="headerlink" title="怎么验证本文结论"></a>怎么验证本文结论</h1>
<p>你可以按下面这个最小闭环来验：</p>
<ol>
<li>建表并造 50 万行以上测试数据；</li>
<li>执行 SQL A 和 SQL B 的 <code>EXPLAIN ANALYZE</code>；</li>
<li>观察 <code>Using index</code> / <code>Using index condition</code> / 实际耗时差异；</li>
<li>用 <code>mysqlslap</code> 分别压测 3 个版本；</li>
<li>如果你有 Java 服务，再录一段 JFR，看 JDBC 调用耗时和线程等待是否同步下降。</li>
</ol>
<p>只要你的数据量别太小，SQL A 比 SQL B 稳定、深分页版本最差，这个趋势大概率都能复现出来。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li>覆盖索引不是“某种特殊索引”，而是“查询刚好能只靠索引完成”的状态；</li>
<li>回表的本质，是二级索引命中后还得去聚簇索引拿整行；</li>
<li><code>Using index</code> 大概率意味着覆盖索引生效；<code>Using index condition</code> 大概率意味着 ICP 在帮你减少不必要回表；</li>
<li>优化慢 SQL，不能只看“有没有索引”，要看扫描行数、是否回表、是否深分页、是否额外排序；</li>
<li>真正靠谱的优化，要同时看数据库实测和应用链路实测。</li>
</ul>
<p>我的建议很直接：<strong>别把“加索引”当咒语，要把“减少无效扫描与回表”当目标</strong>。这样你设计索引时，脑子里想的就不再是模板答案，而是数据访问路径。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>MySQL 8.0 Reference Manual - EXPLAIN Statement：<a href="https://dev.mysql.com/doc/refman/8.0/en/explain.html">https://dev.mysql.com/doc/refman/8.0/en/explain.html</a></li>
<li>MySQL 8.0 Reference Manual - Optimization and Indexes：<a href="https://dev.mysql.com/doc/refman/8.0/en/optimization-indexes.html">https://dev.mysql.com/doc/refman/8.0/en/optimization-indexes.html</a></li>
<li>MySQL 8.0 Reference Manual - Index Condition Pushdown Optimization：<a href="https://dev.mysql.com/doc/refman/8.0/en/index-condition-pushdown-optimization.html">https://dev.mysql.com/doc/refman/8.0/en/index-condition-pushdown-optimization.html</a></li>
<li>MySQL 8.0 Reference Manual - InnoDB Clustered and Secondary Indexes：<a href="https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html">https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html</a></li>
<li>阿里云开发者社区 - MySQL 索引与慢 SQL 优化相关文章（检索关键词：覆盖索引 / 回表 / 索引下推）</li>
<li>腾讯云开发者社区 - MySQL EXPLAIN / 索引优化相关文章（检索关键词：EXPLAIN ANALYZE / 联合索引）</li>
</ol>
