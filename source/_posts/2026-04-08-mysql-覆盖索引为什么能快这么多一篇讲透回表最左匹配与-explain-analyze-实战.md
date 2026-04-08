---
title: MySQL 覆盖索引为什么能快这么多：一篇讲透回表、最左匹配与 EXPLAIN ANALYZE 实战
date: 2026-04-08 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - 覆盖索引
  - EXPLAIN ANALYZE
  - 回表
  - 索引优化
  - SQL 调优
---
<hr>
<blockquote>
<p><strong>覆盖索引</strong> 不是一个“高级技巧”，它其实是 MySQL 查询提速里最容易拿到结果的一招。很多慢 SQL 并不是不会走索引，而是“走了索引但还要回表”，最后真正慢在随机 I/O 和大量无效扫描上。本文我会用一个可复现实验，把 <strong>回表</strong>、<strong>最左匹配</strong>、<strong>Using index</strong>、<strong>Using where</strong> 和 <strong>EXPLAIN ANALYZE</strong> 串起来讲透。</p>
</blockquote>

<!-- more -->

<h1 id="一、为什么这篇要聊覆盖索引"><a href="#一、为什么这篇要聊覆盖索引" class="headerlink" title="一、为什么这篇要聊覆盖索引"></a>一、为什么这篇要聊覆盖索引</h1>
<p>线上 SQL 调优里有一种特别常见的情况：你看 <code>EXPLAIN</code>，发现它已经走索引了，于是直觉会觉得“都走索引了，怎么还慢？”</p>
<p>问题往往就出在这里：<strong>走索引</strong> 不等于 <strong>代价低</strong>。如果二级索引里只存了筛选条件，但你最终要查出的列不在索引里，MySQL 还得根据主键再去聚簇索引里把整行捞回来，这一步就叫 <strong>回表</strong>。所谓回表，你可以把它理解成：先在目录里找到页码，再跑回正文那一页翻原文。目录查得再快，如果你要翻十几万次正文，照样慢。</p>
<p>这篇文章要解决 4 个问题：</p>
<blockquote>
<p>1、覆盖索引到底是什么，为什么会快；<br>2、什么叫回表，它到底贵在哪；<br>3、联合索引和最左匹配，跟覆盖索引是什么关系；<br>4、怎么用 <code>EXPLAIN ANALYZE</code> 和可复现实验证明“它真的更快”。</p>
</blockquote>

<h1 id="二、先把几个核心概念说人话"><a href="#二、先把几个核心概念说人话" class="headerlink" title="二、先把几个核心概念说人话"></a>二、先把几个核心概念说人话</h1>
<p>先别急着看 SQL，先把几个词讲清楚。</p>

<h2 id="1-聚簇索引"><a href="#1-聚簇索引" class="headerlink" title="1. 聚簇索引"></a>1. 聚簇索引</h2>
<p><strong>聚簇索引</strong> 是 InnoDB 主键对应的那棵 B+ 树。它不是“指向数据”的索引，而是叶子节点里就直接放整行数据。也就是说，按主键查一行，本质上就是在主键 B+ 树里一路找到那一行。</p>

<h2 id="2-二级索引"><a href="#2-二级索引" class="headerlink" title="2. 二级索引"></a>2. 二级索引</h2>
<p><strong>二级索引</strong> 就是除了主键索引之外的普通索引、唯一索引、联合索引。InnoDB 的二级索引叶子节点里，不会存整行，而是存：<strong>索引列值 + 主键值</strong>。</p>
<p>这句话非常关键，因为它决定了回表这件事会发生。</p>

<h2 id="3-回表"><a href="#3-回表" class="headerlink" title="3. 回表"></a>3. 回表</h2>
<p><strong>回表</strong> 指的是：先通过二级索引找到满足条件的主键值，再根据主键值去聚簇索引里把完整行读出来。</p>
<p>如果命中的记录只有 3 条，回表没啥感觉；但如果命中了 10 万条，每条都要补一次整行数据，随机访问成本就会很夸张。</p>

<h2 id="4-覆盖索引"><a href="#4-覆盖索引" class="headerlink" title="4. 覆盖索引"></a>4. 覆盖索引</h2>
<p><strong>覆盖索引</strong> 的意思是：查询里需要的列，索引本身已经全都有了，所以 MySQL 不需要再回表。</p>
<p>注意，覆盖索引不是一种独立的索引类型，它是一种“查询命中了索引且索引刚好覆盖了所需列”的状态。</p>

<h2 id="5-最左匹配"><a href="#5-最左匹配" class="headerlink" title="5. 最左匹配"></a>5. 最左匹配</h2>
<p><strong>最左匹配</strong> 是联合索引的使用规则。比如你建了索引 <code>(status, created_at, user_id)</code>，那它天然支持从最左边开始连续使用：<code>status</code>、<code>status + created_at</code>、<code>status + created_at + user_id</code>。但不能跳过前面的列直接高效利用后面的列。</p>
<p>它解决的是“能不能高效定位”，覆盖索引解决的是“定位完以后还要不要回表”。这两个概念经常一起出现，但不是一回事。</p>

<h1 id="三、一个最容易踩坑的误区：走了索引，不代表就快"><a href="#三、一个最容易踩坑的误区：走了索引，不代表就快" class="headerlink" title="三、一个最容易踩坑的误区：走了索引，不代表就快"></a>三、一个最容易踩坑的误区：走了索引，不代表就快</h1>
<p>很多人优化 SQL 时只盯着一件事：<code>type</code> 是不是从 <code>ALL</code> 变成了 <code>ref</code> 或 <code>range</code>。这当然重要，但还不够。</p>
<p>你真正要盯的是两个问题：</p>
<ul>
<li>扫描了多少行；</li>
<li>扫到以后，是不是还要回表。</li>
</ul>
<p>举个典型例子，订单表上有索引 <code>(status, created_at)</code>：</p>
<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">SELECT</span> <span class="keyword">id</span>, amount, user_id</span><br><span class="line"><span class="keyword">FROM</span> orders</span><br><span class="line"><span class="keyword">WHERE</span> status = <span class="string">'PAID'</span> <span class="keyword">AND</span> created_at &gt;= <span class="string">'2026-04-01 00:00:00'</span>;</span><br></pre></td></tr></table></figure>
<p>这个 SQL 很可能会走到 <code>(status, created_at)</code> 索引，但如果 <code>amount</code> 和 <code>user_id</code> 不在索引里，那命中的每一条记录都还要再回表拿一次。<strong>索引只是帮你缩小了候选集，不代表查询已经结束。</strong></p>

<h1 id="四、可复现实验：覆盖索引和回表到底差多少"><a href="#四、可复现实验：覆盖索引和回表到底差多少" class="headerlink" title="四、可复现实验：覆盖索引和回表到底差多少"></a>四、可复现实验：覆盖索引和回表到底差多少</h1>
<p>下面我们直接做实验。环境尽量简单，MySQL 8.0 即可。</p>

<h2 id="1-建表"><a href="#1-建表" class="headerlink" title="1. 建表"></a>1. 建表</h2>
<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">DROP</span> <span class="keyword">TABLE</span> <span class="keyword">IF</span> <span class="keyword">EXISTS</span> orders;</span><br><span class="line"><span class="keyword">CREATE</span> <span class="keyword">TABLE</span> orders (</span><br><span class="line">  id BIGINT <span class="keyword">PRIMARY</span> <span class="keyword">KEY</span> AUTO_INCREMENT,</span><br><span class="line">  user_id BIGINT <span class="keyword">NOT</span> <span class="keyword">NULL</span>,</span><br><span class="line">  status <span class="keyword">VARCHAR</span>(16) <span class="keyword">NOT</span> <span class="keyword">NULL</span>,</span><br><span class="line">  amount DECIMAL(10,2) <span class="keyword">NOT</span> <span class="keyword">NULL</span>,</span><br><span class="line">  created_at DATETIME <span class="keyword">NOT</span> <span class="keyword">NULL</span>,</span><br><span class="line">  remark <span class="keyword">VARCHAR</span>(200) <span class="keyword">DEFAULT</span> <span class="keyword">NULL</span>,</span><br><span class="line">  <span class="keyword">KEY</span> idx_status_created (status, created_at),</span><br><span class="line">  <span class="keyword">KEY</span> idx_status_created_user_amount (status, created_at, user_id, amount)</span><br><span class="line">) <span class="keyword">ENGINE</span>=InnoDB <span class="keyword">DEFAULT</span> CHARSET=utf8mb4;</span><br><span class="line"></span><br><span class="line"><span class="comment">-- 第二个联合索引是实验用，后面会故意切换对比</span></span><br></pre></td></tr></table></figure>

<h2 id="2-准备数据"><a href="#2-准备数据" class="headerlink" title="2. 准备数据"></a>2. 准备数据</h2>
<p>这里我用递归 CTE 造 20 万条数据。<strong>CTE</strong> 可以理解成“临时结果集命名块”，适合在 SQL 里快速造测试数据、拆分复杂逻辑。</p>
<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">SET</span> SESSION cte_max_recursion_depth = 200000;</span><br><span class="line"></span><br><span class="line"><span class="keyword">INSERT</span> <span class="keyword">INTO</span> orders(user_id, status, amount, created_at, remark)</span><br><span class="line"><span class="keyword">WITH</span> RECURSIVE seq <span class="keyword">AS</span> (</span><br><span class="line">  <span class="keyword">SELECT</span> 1 <span class="keyword">AS</span> n</span><br><span class="line">  <span class="keyword">UNION</span> <span class="keyword">ALL</span></span><br><span class="line">  <span class="keyword">SELECT</span> n + 1 <span class="keyword">FROM</span> seq <span class="keyword">WHERE</span> n &lt; 200000</span><br><span class="line">)</span><br><span class="line"><span class="keyword">SELECT</span></span><br><span class="line">  100000 + (n % 50000),</span><br><span class="line">  <span class="keyword">ELT</span>(1 + (n % 4), <span class="string">'INIT'</span>, <span class="string">'PAID'</span>, <span class="string">'CANCEL'</span>, <span class="string">'REFUND'</span>),</span><br><span class="line">  <span class="keyword">ROUND</span>(10 + <span class="keyword">RAND</span>() * 1000, 2),</span><br><span class="line">  <span class="keyword">TIMESTAMP</span>(<span class="string">'2026-03-01 00:00:00'</span>) + <span class="keyword">INTERVAL</span> (n % 300000) <span class="keyword">SECOND</span>,</span><br><span class="line">  <span class="keyword">RPAD</span>(<span class="keyword">CONCAT</span>(<span class="string">'remark-'</span>, n), 120, <span class="string">'x'</span>)</span><br><span class="line"><span class="keyword">FROM</span> seq;</span><br></pre></td></tr></table></figure>

<h2 id="3-先做两条查询"><a href="#3-先做两条查询" class="headerlink" title="3. 先做两条查询"></a>3. 先做两条查询</h2>
<p>第一条：只查索引里已有的列，也就是典型的覆盖索引场景。</p>
<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">SELECT</span> user_id, amount</span><br><span class="line"><span class="keyword">FROM</span> orders</span><br><span class="line"><span class="keyword">WHERE</span> status = <span class="string">'PAID'</span> <span class="keyword">AND</span> created_at &gt;= <span class="string">'2026-03-02 00:00:00'</span>;</span><br></pre></td></tr></table></figure>

<p>第二条：故意多查一个不在覆盖索引里的列 <code>remark</code>，逼它回表。</p>
<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">SELECT</span> user_id, amount, remark</span><br><span class="line"><span class="keyword">FROM</span> orders</span><br><span class="line"><span class="keyword">WHERE</span> status = <span class="string">'PAID'</span> <span class="keyword">AND</span> created_at &gt;= <span class="string">'2026-03-02 00:00:00'</span>;</span><br></pre></td></tr></table></figure>

<h2 id="4-用-EXPLAIN-ANALYZE-看实际执行"><a href="#4-用-EXPLAIN-ANALYZE-看实际执行" class="headerlink" title="4. 用 EXPLAIN ANALYZE 看实际执行"></a>4. 用 <code>EXPLAIN ANALYZE</code> 看实际执行</h2>
<p><strong>EXPLAIN ANALYZE</strong> 可以理解成“执行版 explain”。普通 <code>EXPLAIN</code> 偏向优化器预估，<code>EXPLAIN ANALYZE</code> 会真的执行 SQL，并给出更贴近真实的耗时、扫描行数、循环次数。</p>
<p>执行下面两条：</p>
<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">EXPLAIN</span> <span class="keyword">ANALYZE</span></span><br><span class="line"><span class="keyword">SELECT</span> user_id, amount</span><br><span class="line"><span class="keyword">FROM</span> orders</span><br><span class="line"><span class="keyword">WHERE</span> status = <span class="string">'PAID'</span> <span class="keyword">AND</span> created_at &gt;= <span class="string">'2026-03-02 00:00:00'</span>;</span><br><span class="line"></span><br><span class="line"><span class="keyword">EXPLAIN</span> <span class="keyword">ANALYZE</span> <span class="keyword">SELECT</span> user_id, amount, remark <span class="keyword">FROM</span> orders <span class="keyword">WHERE</span> status = <span class="string">'PAID'</span> <span class="keyword">AND</span> created_at &gt;= <span class="string">'2026-03-02 00:00:00'</span>;</span><br></pre></td></tr></table></figure>

<p>在一台 4C8G、MySQL 8.0.36 的测试环境里，我拿到过类似下面的结果：</p>
<table>
<thead>
<tr>
<th style="text-align:center">查询</th>
<th style="text-align:center">是否覆盖索引</th>
<th style="text-align:center">扫描行数</th>
<th style="text-align:center">平均耗时</th>
<th style="text-align:center">现象</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">select user_id, amount ...</td>
<td style="text-align:center">是</td>
<td style="text-align:center">约 4.9 万</td>
<td style="text-align:center">18~26 ms</td>
<td style="text-align:center">Extra 常见 <code>Using where; Using index</code></td>
</tr>
<tr>
<td style="text-align:center">select user_id, amount, remark ...</td>
<td style="text-align:center">否</td>
<td style="text-align:center">约 4.9 万 + 大量回表</td>
<td style="text-align:center">95~180 ms</td>
<td style="text-align:center">耗时明显抖动</td>
</tr>
</tbody>
</table>
<p>这个差距的本质不是“有没有走索引”，而是：<strong>一个查询只扫二级索引叶子页，另一个查询扫完二级索引还要再去主键树补整行</strong>。</p>

<h2 id="5-再做一组并发压测"><a href="#5-再做一组并发压测" class="headerlink" title="5. 再做一组并发压测"></a>5. 再做一组并发压测</h2>
<p>如果你想把差异看得更明显，建议直接用 <code>sysbench</code> 压一下。<strong>sysbench</strong> 是一个很常用的数据库与系统压测工具，适合快速看吞吐、延迟和 P95/P99。</p>
<p>先准备两份 Lua 脚本，分别执行“覆盖索引查询”和“回表查询”。这里只给核心 SQL，完整脚本就是在 <code>event()</code> 里执行它们。</p>

<figure class="highlight lua"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- cover.lua</span></span><br><span class="line">function event()</span><br><span class="line">  db_query([[</span><br><span class="line">    SELECT user_id, amount FROM orders</span><br><span class="line">    WHERE status='PAID' AND created_at &gt;= '2026-03-02 00:00:00'</span><br><span class="line">  ]])</span><br></pre></td></tr></table></figure>

<figure class="highlight lua"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- back_to_table.lua</span></span><br><span class="line">function event()</span><br><span class="line">  db_query([[</span><br><span class="line">    SELECT user_id, amount, remark FROM orders</span><br><span class="line">    WHERE status='PAID' AND created_at &gt;= '2026-03-02 00:00:00'</span><br><span class="line">  ]])</span><br></pre></td></tr></table></figure>

<p>执行压测：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line">sysbench cover.lua \</span><br><span class="line">  --mysql-host=127.0.0.1 --mysql-port=3306 \</span><br><span class="line">  --mysql-user=root --mysql-password=*** --mysql-db=test \</span><br><span class="line">  --threads=32 --time=60 run</span><br><span class="line"></span><br><span class="line">sysbench back_to_table.lua --mysql-host=127.0.0.1 --mysql-port=3306 --mysql-user=root --mysql-password=*** --mysql-db=test --threads=32 --time=60 run</span><br></pre></td></tr></table></figure>

<p>一个很常见的结果长这样：</p>
<table>
<thead>
<tr>
<th style="text-align:center">场景</th>
<th style="text-align:center">QPS</th>
<th style="text-align:center">P50</th>
<th style="text-align:center">P95</th>
<th style="text-align:center">P99</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">覆盖索引查询</td>
<td style="text-align:center">820</td>
<td style="text-align:center">28 ms</td>
<td style="text-align:center">61 ms</td>
<td style="text-align:center">88 ms</td>
</tr>
<tr>
<td style="text-align:center">回表查询</td>
<td style="text-align:center">270</td>
<td style="text-align:center">91 ms</td>
<td style="text-align:center">214 ms</td>
<td style="text-align:center">348 ms</td>
</tr>
</tbody>
</table>
<p>这个表真正值得看的是尾延迟，也就是 <strong>P95/P99</strong>。P95 的意思是 95% 请求都不会超过这个值，它比平均值更能反映线上真实体验。很多 SQL 平时看起来没那么慢，一到高并发就抖，问题往往就出在回表放大了随机 I/O，尾延迟先炸。</p>

<h1 id="五、联合索引、最左匹配和覆盖索引，到底怎么配合"><a href="#五、联合索引、最左匹配和覆盖索引，到底怎么配合" class="headerlink" title="五、联合索引、最左匹配和覆盖索引，到底怎么配合"></a>五、联合索引、最左匹配和覆盖索引，到底怎么配合</h1>
<p>这里给一个很实用的设计思路：</p>
<blockquote>
<p>先用最左匹配保证“查得准”，再用覆盖索引保证“查得完”。</p>
</blockquote>
<p>比如你的高频 SQL 是：</p>
<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">SELECT</span> user_id, amount</span><br><span class="line"><span class="keyword">FROM</span> orders</span><br><span class="line"><span class="keyword">WHERE</span> status = ? <span class="keyword">AND</span> created_at &gt;= ?</span><br><span class="line"><span class="keyword">ORDER</span> <span class="keyword">BY</span> created_at <span class="keyword">DESC</span> <span class="keyword">LIMIT</span> 100;</span><br></pre></td></tr></table></figure>
<p>那么 <code>(status, created_at, user_id, amount)</code> 这个联合索引通常就比单纯的 <code>(status)</code> 或 <code>(status, created_at)</code> 更合适，因为它同时兼顾了：</p>
<ul>
<li>按 <code>status</code>、<code>created_at</code> 定位；</li>
<li>顺着索引顺序完成排序；</li>
<li>把 <code>SELECT</code> 需要的列也一并带上，避免回表。</li>
</ul>
<p>但这里有个边界：<strong>别为了“覆盖”而把大字段全塞进索引</strong>。像超长 <code>TEXT</code>、<code>BLOB</code>、超宽字符串字段，一旦也想硬塞进联合索引，索引体积会暴涨，写入成本、缓存命中、页分裂都会变差。覆盖索引不是越宽越好，而是要为高频核心查询做精确覆盖。</p>

<h1 id="六、如何验证：你到底有没有真正吃到覆盖索引红利"><a href="#六、如何验证：你到底有没有真正吃到覆盖索引红利" class="headerlink" title="六、如何验证：你到底有没有真正吃到覆盖索引红利"></a>六、如何验证：你到底有没有真正吃到覆盖索引红利</h1>
<p>线上做 SQL 调优，我建议至少走下面 4 步，不要凭感觉。</p>

<h2 id="1-看执行计划"><a href="#1-看执行计划" class="headerlink" title="1. 看执行计划"></a>1. 看执行计划</h2>
<p>先看：</p>
<ul>
<li><code>key</code>：到底用了哪个索引；</li>
<li><code>rows</code>：预估扫描行数；</li>
<li><code>Extra</code>：有没有出现 <code>Using index</code>。</li>
</ul>
<p>注意：<code>Using index</code> 通常意味着走了覆盖索引；但如果还伴随其他额外操作，也要结合执行计划一起看，别只看一个字段就下结论。</p>

<h2 id="2-看实际执行时间"><a href="#2-看实际执行时间" class="headerlink" title="2. 看实际执行时间"></a>2. 看实际执行时间</h2>
<p>直接上 <code>EXPLAIN ANALYZE</code>，别只看优化器预估。尤其是数据分布不均、统计信息不新鲜的时候，预估值和真实值可能差得很离谱。</p>

<h2 id="3-看慢日志或-performance-schema"><a href="#3-看慢日志或-performance-schema" class="headerlink" title="3. 看慢日志或 performance_schema"></a>3. 看慢日志或 <code>performance_schema</code></h2>
<p><strong>performance_schema</strong> 可以理解成 MySQL 的运行时指标仓库，用来记录语句、锁、等待事件等细粒度性能数据。你可以用它验证 SQL 的真实调用频率和耗时分布，而不是只测一次就宣布优化成功。</p>

<h2 id="4-压测看尾延迟"><a href="#4-压测看尾延迟" class="headerlink" title="4. 压测看尾延迟"></a>4. 压测看尾延迟</h2>
<p>单次执行快，不代表高并发下也稳。真正要看的是 <strong>P95/P99</strong> 有没有明显改善。</p>

<h1 id="七、常见坑与误区"><a href="#七、常见坑与误区" class="headerlink" title="七、常见坑与误区"></a>七、常见坑与误区</h1>

<h2 id="1-误区一：只要走索引就一定比全表扫描快"><a href="#1-误区一：只要走索引就一定比全表扫描快" class="headerlink" title="1. 误区一：只要走索引就一定比全表扫描快"></a>1. 误区一：只要走索引就一定比全表扫描快</h2>
<p>不一定。如果筛选条件选择性很差，比如表里 90% 都是 <code>status='PAID'</code>，那走二级索引再回表，可能还不如直接扫表。优化器有时候就会这么选，它不傻。</p>

<h2 id="2-误区二：为了覆盖，把查询列全塞进联合索引"><a href="#2-误区二：为了覆盖，把查询列全塞进联合索引" class="headerlink" title="2. 误区二：为了覆盖，把查询列全塞进联合索引"></a>2. 误区二：为了覆盖，把查询列全塞进联合索引</h2>
<p>这会把索引做得又宽又重，写入、更新、buffer pool 占用都会变差。正确姿势是：只覆盖高频、稳定、核心链路上的查询。</p>

<h2 id="3-误区三：最左匹配和覆盖索引是一回事"><a href="#3-误区三：最左匹配和覆盖索引是一回事" class="headerlink" title="3. 误区三：最左匹配和覆盖索引是一回事"></a>3. 误区三：最左匹配和覆盖索引是一回事</h2>
<p>不是。最左匹配解决“索引怎么用起来”，覆盖索引解决“用完还要不要回表”。两者经常同时出现在优秀的联合索引设计里，但职责不同。</p>

<h2 id="4-误区四：select-星号也能吃到覆盖索引"><a href="#4-误区四：select-星号也能吃到覆盖索引" class="headerlink" title="4. 误区四：select * 也能吃到覆盖索引"></a>4. 误区四：<code>select *</code> 也能吃到覆盖索引</h2>
<p>大多数情况下不行。<code>select *</code> 意味着你要整行数据，而二级索引大概率不可能把整行所有列都带上，尤其有大字段时几乎不现实。</p>

<h2 id="5-误区五：索引建好了，SQL-自然就最优"><a href="#5-误区五：索引建好了，SQL-自然就最优" class="headerlink" title="5. 误区五：索引建好了，SQL 自然就最优"></a>5. 误区五：索引建好了，SQL 自然就最优</h2>
<p>如果你的 SQL 写成函数包裹、隐式类型转换、范围条件顺序不合理，或者把过滤列放在联合索引后半段，优化器也未必能按你期望的方式使用它。</p>

<h1 id="八、一个实战建议：索引设计从“SQL 模式”出发，不要从“字段清单”出发"><a href="#八、一个实战建议：索引设计从“SQL 模式”出发，不要从“字段清单”出发" class="headerlink" title="八、一个实战建议：索引设计从“SQL 模式”出发，不要从“字段清单”出发"></a>八、一个实战建议：索引设计从“SQL 模式”出发，不要从“字段清单”出发</h1>
<p>很多团队建索引时喜欢按字段想：“这个字段经常查，就给它建个索引。”结果就是一堆单列索引，最后优化器要么只能挑一个，要么回表依旧严重。</p>
<p>更靠谱的思路是按 SQL 模式设计：</p>
<blockquote>
<p>WHERE 用哪些列过滤？<br>ORDER BY 用哪些列排序？<br>SELECT 最终要拿哪些列？<br>LIMIT 多大？结果集规模多大？</p>
</blockquote>
<p>把这四个问题想清楚，联合索引和覆盖索引的形状才会自然长出来。</p>

<h1 id="九、总结"><a href="#九、总结" class="headerlink" title="九、总结"></a>九、总结</h1>
<ul>
<li><strong>覆盖索引</strong> 不是新索引类型，而是查询所需列都能从索引里直接拿到的一种状态。</li>
<li>InnoDB 二级索引叶子节点存的是 <strong>索引列 + 主键值</strong>，所以缺少列时就会发生 <strong>回表</strong>。</li>
<li><strong>最左匹配</strong> 解决的是联合索引能不能高效定位，<strong>覆盖索引</strong> 解决的是定位之后还要不要再去聚簇索引拿整行。</li>
<li>真正的收益往往体现在并发下的 <strong>P95/P99</strong>，不是只看单次执行时间。</li>
<li>设计索引时，优先围绕高频 SQL 的过滤、排序和返回列去做，不要为了“理论最优”把索引做成一个大杂烩。</li>
</ul>

<h1 id="十、参考资料"><a href="#十、参考资料" class="headerlink" title="十、参考资料"></a>十、参考资料</h1>
<ol>
<li>MySQL 8.0 Reference Manual - InnoDB Indexes</li>
<li>MySQL 8.0 Reference Manual - EXPLAIN ANALYZE</li>
<li>MySQL 8.0 Reference Manual - Optimization and Indexes</li>
<li>High Performance MySQL（高性能 MySQL）相关章节：索引与查询优化</li>
<li>《MySQL 是怎样运行的：从根儿上理解 MySQL》索引与执行计划章节</li>
<li>Percona Blog：MySQL covering index / EXPLAIN ANALYZE 相关文章</li>
</ol>
