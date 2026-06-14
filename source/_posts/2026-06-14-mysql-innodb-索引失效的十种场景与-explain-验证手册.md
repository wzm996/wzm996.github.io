---
title: MySQL InnoDB 索引失效的十种场景与 EXPLAIN 验证手册
date: 2026-06-14 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - InnoDB
  - 索引
  - EXPLAIN
  - B+树
  - SQL优化
---
<hr>
<blockquote><p>索引是数据库查询加速的基石，但建了索引不代表一定能命中。本文系统梳理 InnoDB 引擎中导致索引失效的十种典型场景，每种都给出可复现的 SQL 示例与 EXPLAIN 输出解读，帮你从"感觉加了索引会快"进化到"能看懂执行计划、说清为什么慢"。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么索引会“失效”？"><a href="#背景：为什么索引会“失效”？" class="headerlink" title="背景：为什么索引会“失效”？"></a>背景：为什么索引会"失效"？</h1>

<p>先说清楚一个概念：<strong>索引失效</strong>并不是索引被删除或损坏了，而是指 <strong>MySQL 优化器（Optimizer）在执行某条 SQL 时，选择了全表扫描（Full Table Scan）而不是走索引树查找</strong>。</p>

<p>为什么优化器会"放弃"索引？核心原因就一句话：<strong>优化器认为走索引的成本比全表扫描还高</strong>。成本估算基于统计信息（每个页的记录数、索引基数 cardinality 等），当以下情况出现时，优化器倾向于选全表扫：</p>
<ul>
<li>需要回表的行数太多（通常超过表中数据的 20%~30%）</li>
<li>对索引列做了函数运算 / 类型转换 / 模糊匹配前缀通配符等操作，无法利用索引树的有序性</li>
<li>联合索引不满足最左前缀原则</li>
<li>使用了 != / NOT IN / IS NULL 等让优化器"觉得选择性差"的条件</li>
</ul>

<p>下面我们逐一拆解，每种场景都用实际 SQL + EXPLAIN 来验证。</p>

<blockquote><p><strong>注：</strong>本文实验环境为 MySQL 8.0.36，InnoDB 引擎，字符集 utf8mb4。所有示例基于同一张表结构，你可以直接在自己的 MySQL 里复现。</p></blockquote>

<h1 id="准备实验环境"><a href="#准备实验环境" class="headerlink" title="准备实验环境"></a>准备实验环境</h1>

<h2 id="建表与初始化数据"><a href="#建表与初始化数据" class="headerlink" title="建表与初始化数据"></a>建表与初始化数据</h2>

<p>我们先创建一张用户表，插入适量数据用于后续实验：</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">DROP</span> <span class="keyword">TABLE</span> <span class="keyword">IF</span> <span class="keyword">EXISTS</span> t_user;</span><br><span class="line"><span class="keyword">CREATE</span> <span class="keyword">TABLE</span> t_user (</span><br><span class="line">    id        <span class="built_in">BIGINT</span> <span class="keyword">PRIMARY</span> KEY AUTO_INCREMENT,</span><br><span class="line">    name      <span class="built_in">VARCHAR</span>(<span class="number">50</span>)  <span class="keyword">NOT</span> <span class="keyword">NULL</span> <span class="keyword">COMMENT</span> <span class="string">'姓名'</span>,</span><br><span class="line">    age       <span class="built_in">INT</span>         <span class="keyword">NOT</span> <span class="keyword">NULL</span> <span class="keyword">DEFAULT</span> <span class="number">0</span>  <span class="keyword">COMMENT</span> <span class="string">'年龄'</span>,</span><br><span class="line">    phone     <span class="built_in">VARCHAR</span>(<span class="number">20</span>)          <span class="keyword">COMMENT</span> <span class="string">'手机号'</span>,</span><br><span class="line">    email     <span class="built_in">VARCHAR</span>(<span class="number">100</span>)         <span class="keyword">COMMENT</span> <span class="string">'邮箱'</span>,</span><br><span class="line">    created_at DATETIME     <span class="keyword">NOT</span> <span class="keyword">NULL</span> <span class="keyword">DEFAULT</span> <span class="keyword">CURRENT_TIMESTAMP</span></span><br><span class="line">) ENGINE<span class="operator">=</span>InnoDB <span class="keyword">DEFAULT</span> CHARSET<span class="operator">=</span>utf8mb4 <span class="keyword">COMMENT</span><span class="operator">=</span><span class="string">'索引实验表'</span>;</span><br><span class="line"></span><br><span class="line"><span class="comment">-- 创建索引</span></span><br><span class="line"><span class="keyword">CREATE</span> INDEX idx_name <span class="keyword">ON</span> t_user(name);</span><br><span class="line"><span class="keyword">CREATE</span> INDEX idx_age <span class="keyword">ON</span> t_user(age);</span><br><span class="line"><span class="keyword">CREATE</span> INDEX idx_phone <span class="keyword">ON</span> t_user(phone);</span><br><span class="line"><span class="keyword">CREATE</span> INDEX idx_name_age <span class="keyword">ON</span> t_user(name, age);</span><br></pre></td></table></figure>

<p>插入测试数据（10 万条，保证有足够样本让优化器做成本决策）：</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">DELIMITER</span> //</span><br><span class="line"><span class="keyword">CREATE</span> PROCEDURE init_data()</span><br><span class="line"><span class="keyword">BEGIN</span></span><br><span class="line">    <span class="keyword">DECLARE</span> i <span class="built_in">INT</span> <span class="keyword">DEFAULT</span> <span class="number">1</span>;</span><br><span class="line">    <span class="keyword">WHILE</span> i <span class="operator">&lt;=</span> <span class="number">100000</span> <span class="keyword">DO</span></span><br><span class="line">        <span class="keyword">INSERT</span> <span class="keyword">INTO</span> t_user(name, age, phone, email) </span><br><span class="line">        <span class="keyword">VALUES</span> (</span><br><span class="line">            CONCAT(<span class="string">'user_'</span>, i),</span><br><span class="line">            FLOOR(<span class="number">18</span> <span class="operator">+</span> RAND() <span class="operator">*</span> <span class="number">45</span>),           <span class="comment">-- 年龄 18~62 随机分布</span></span><br><span class="line">            CONCAT(<span class="string">'138'</span>, LPAD(FLOOR(RAND()<span class="operator">*</span><span class="number">100000000</span>), <span class="number">8</span>, <span class="string">'0'</span>)),</span><br><span class="line">            CONCAT(<span class="string">'user'</span>, i, <span class="string">'@test.com'</span>)</span><br><span class="line">        );</span><br><span class="line">        <span class="keyword">SET</span> i <span class="operator">=</span> i <span class="operator">+</span> <span class="number">1</span>;</span><br><span class="line">    <span class="keyword">END</span> <span class="keyword">WHILE</span>;</span><br><span class="line"><span class="keyword">END</span> //</span><br><span class="line"><span class="keyword">DELIMITER</span> ;</span><br><span class="line"></span><br><span class="line"><span class="keyword">CALL</span> init_data();</span><br></pre></td></table></figure>

<blockquote><p><strong>注：</strong>如果觉得存储过程插入太慢，可以用批量 INSERT 或写个脚本分批插入。关键是数据量要够大（建议 ≥ 5 万条），否则优化器可能因为表太小直接走全表扫——这本身也是一种正确的选择。</p></blockquote>

<h2 id="验证索引生效的基线"><a href="#验证索引生效的基线" class="headerlink" title="验证索引生效的基线"></a>验证索引生效的基线</h2>

<p>先用一个正常走索引的查询建立基线感受：</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">EXPLAIN SELECT * FROM t_user WHERE name = 'user_12345';</span><br></pre></td></table></figure>

<p>预期输出关键字段：</p>

<table>
<thead>
<tr>
<th style="text-align:left">字段</th>
<th style="text-align:left">预期值</th>
<th style="text-align:left">含义</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><strong>type</strong></td>
<td style="text-align:left">ref</td>
<td style="text-align:left">等值匹配索引列，走索引查找</td>
</tr>
<tr>
<td style="text-align:left"><strong>key</strong></td>
<td style="text-align:left">idx_name</td>
<td style="text-align:left">实际使用的索引名</td>
</tr>
<tr>
<td style="text-align:left"><strong>rows</strong></td>
<td style="text-align:left">1</td>
<td style="text-align:left">预估扫描行数（≈1 说明精确定位）</td>
</tr>
<tr>
<td style="text-align:left"><strong>Extra</strong></td>
<td style="text-align:left">NULL</td>
<td style="text-align:left">无额外信息（干净地走索引）</td>
</tr>
</tbody>
</table>

<p>记住这个"满分"状态，后面每种失效场景都会偏离它。</p>

<blockquote><p><strong>关于 EXPLAIN 关键字速查：</strong><br>
<strong>type</strong> 字段从优到劣排序：system &gt; const &gt; eq_ref &gt; ref &gt; range &gt; index &gt; ALL。<br>
看到 <strong>ALL</strong> 就意味着全表扫描——通常是我们要避免的。<br>
<strong>key</strong> 显示 NULL 表示没有使用任何索引。<br>
<strong>Extra</strong> 列出现 <code>Using filesort</code> 或 <code>Using temporary</code> 是性能危险信号。</p></blockquote>

<h1 id="场景一：对索引列使用函数运算"><a href="#场景一：对索引列使用函数运算" class="headerlink" title="场景一：对索引列使用函数运算"></a>场景一：对索引列使用函数运算</h1>

<h2 id="现象"><a href="#现象" class="headerlink" title="现象"></a>现象</h2>

<p>在 <strong>WHERE 条件中对索引列使用函数</strong>，MySQL 无法直接利用 B+ 树的有序性进行查找。</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- ❌ 失效：对索引列用了 UPPER() 函数</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE UPPER(name) = 'USER_12345';</span><br><span class="line"></span><br><span class="line"><span class="comment">-- ✅ 生效：等价改写，去掉函数</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE name = 'user_12345';</span><br></pre></td></table></figure>

<p>第一条 SQL 的 EXPLAIN 结果：</p>
<ul>
<li><strong>type</strong>: ALL（全表扫描）</li>
<li><strong>key</strong>: NULL（没走索引）</li>
<li><strong>rows</strong>: ~100000（扫了全表）</li>
<li><strong>Extra</strong>: Using where</li>
</ul>

<h2 id="原因分析"><a href="#原因分析" class="headerlink" title="原因分析"></a>原因分析</h2>

<p>B+ 树索引存储的是原始列值的有序排列。当你对列套上 <code>UPPER()</code>、<code>SUBSTRING()</code>、<code>DATE()</code> 等函数后，MySQL 必须先取出每一行的原始值、计算函数结果、再和条件比对——<strong>索引的有序性被破坏了</strong>，优化器只能放弃索引。</p>

<h2 id="常见变体"><a href="#常见变体" class="headerlink" title="常见变体"></a>常见变体</h2>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- 日期函数导致失效</span></span><br><span class="line">SELECT * FROM order_tbl WHERE DATE(created_at) = '2026-06-14';   <span class="comment">-- ❌</span></span><br><span class="line">SELECT * FROM order_tbl WHERE created_at >= '2026-06-14 00:00:00'  <span class="comment">-- ✅ 范围查询替代</span></span><br><span class="line">                          AND created_at &lt;  '2026-06-15 00:00:00';</span><br><span class="line"></span><br><span class="line"><span class="comment">-- 计算表达式导致失效</span></span><br><span class="line">SELECT * FROM t_user WHERE age + 1 = 25;  <span class="comment">-- ❌</span></span><br><span class="line">SELECT * FROM t_user WHERE age = 24;        <span class="comment">-- ✅ 把计算移到右边</span></span><br></pre></td></table></figure>

<blockquote><p><strong>口诀：</strong>索引列放在等号左边时，保持"裸列"状态——别套函数、别做运算。把计算挪到等号右边常量那边去。</p></blockquote>

<h1 id="场景二：隐式类型转换"><a href="#场景二：隐式类型转换" class="headerlink" title="场景二：隐式类型转换"></a>场景二：隐式类型转换</h1>

<h2 id="现象-1"><a href="#现象-1" class="headerlink" title="现象"></a>现象</h2>

<p>当 <strong>WHERE 条件中的常量类型与列定义类型不一致</strong> 时，MySQL 会做隐式类型转换——而这个转换本质上等同于对索引列使用了函数。</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- phone 是 VARCHAR 类型，但用数字去比较 → 隐式转 CAST(phone AS DOUBLE)</span></span><br><span class="line"><span class="comment">-- ❌ 失效</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE phone = 13800138000;</span><br><span class="line"><span class="comment">-- type=ALL, key=NULL</span></span><br></pre></td></table></figure>

<p>对比正确写法：</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- ✅ 加引号，字符串匹配字符串</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE phone = '13800138000';</span><br><span class="line"><span class="comment">-- type=ref, key=idx_phone</span></span><br></pre></td></table></figure>

<h2 id="原因分析-1"><a href="#原因分析-1" class="headerlink" title="原因分析"></a>原因分析</h2>

<p>MySQL 的<strong>类型转换规则</strong>是"向高精度/高优先级类型转换"。当 <code>VARCHAR</code> 列遇到数字常量时，会把列转为数字——即 <code>CAST(phone AS DOUBLE)</code>，这就退化成了场景一的"函数作用于索引列"。</p>

<p>你可以用 <code>SHOW WARNINGS;</code> 看到 MySQL 重写后的真正执行语句：</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line">EXPLAIN SELECT * FROM t_user WHERE phone = 13800138000;</span><br><span class="line">SHOW WARNINGS;</span><br><span class="line"><span class="comment">-- 会看到：cast(`test`.`t_user`.`phone` as double) = 13800138000</span></span><br></pre></td></table></figure>

<blockquote><p><strong>注：</strong>这个坑在 MyBatis/XML 映射中特别容易踩——<code>#{phone}</code> 如果传入的是 Long/Integer 类型而数据库字段是 VARCHAR，就会触发隐式转换。Java 代码里记得做类型校验或显式 toString()。</p></blockquote>

<h1 id="场景三：LIKE-以通配符开头"><a href="#场景三：LIKE-以通配符开头" class="headerlink" title="场景三：LIKE 以 % 开头"></a>场景三：LIKE 以 % 开头</h1>

<h2 id="现象-2"><a href="#现象-2" class="headerlink" title="现象"></a>现象</h2>

<p><code>LIKE '%xxx'</code> 或 <code>LIKE '%xxx%'</code> 这种<strong>左侧通配</strong>的模糊查询无法利用 B+ 树索引的有序性。</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- ❌ % 开头，索引失效</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE name LIKE '%12345';</span><br><span class="line"><span class="comment">-- type=ALL, key=NULL</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ✅ % 在右边（前缀匹配），可以走索引</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE name LIKE 'user_12345%';</span><br><span class="comment">-- type=range, key=idx_name</span></span><br></pre></td></table></figure>

<h2 id="原因分析-2"><a href="#原因分析-2" class="headerlink" title="原因分析"></a>原因分析</h2>

<p>B+ 树索引是按列值<strong>从左到右</strong>排序的。<code>LIKE 'abc%'</code> 可以利用索引定位到 <code>abc</code> 开头的区间然后顺序扫描；但 <code>'%abc'</code> 意味着"以 abc 结尾"，这在排序后的 B+ 树里是<strong>分散在各处</strong>的，无法利用有序性缩小范围。</p>

<h2 id="工程替代方案"><a href="#工程替代方案" class="headerlink" title="工程替代方案"></a>工程替代方案</h2>

<p>生产环境中如果确实需要"包含"搜索，考虑以下方案：</p>

<table>
<thead>
<tr>
<th style="text-align:left">方案</th>
<th style="text-align:left">适用场景</th>
<th style="text-align:left">代价</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">Elasticsearch</td>
<td style="text-align:left">全文检索、复杂搜索需求</td>
<td style="text-align:left">引入新组件，维护成本增加</td>
</tr>
<tr>
<td style="text-align:left">MySQL 全文索引（FULLTEXT）</td>
<td style="text-align:left">中等规模文本搜索</td>
<td style="text-align:left">仅支持 InnoDB 的 CHAR/VARCHAR/TEXT</td>
</tr>
<tr>
<td style="text-align:left">倒排索引表（自行维护）</td>
<td style="text-align:left">关键词精确匹配</td>
<td style="text-align:left">写入时需同步维护</td>
</tr>
<tr>
<td style="text-align:left">限制用户必须输入前缀</td>
<td style="text-align:left">搜索框自动补全场景</td>
<td style="text-align:left">产品交互层面的约束</td>
</tr>
</tbody>
</table>

<h1 id="场景四：联合索引违反最左前缀原则"><a href="#场景四：联合索引违反最左前缀原则" class="headerlink" title="场景四：联合索引违反最左前缀原则"></a>场景四：联合索引违反最左前缀原则</h1>

<h2 id="现象-3"><a href="#现象-3" class="headerlink" title="现象"></a>现象</h2>

<p>我们创建了联合索引 <code>idx_name_age(name, age)</code>。这个索引的 B+ 树先按 <code>name</code> 排序，<code>name</code> 相同再按 <code>age</code> 排序。</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- ✅ 使用了最左列 name → 命中联合索引</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE name = 'user_100';</span><br><span class="line"><span class="comment">-- key=idx_name_age, type=ref</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ✅ 使用了 name + age → 完美命中联合索引</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE name = 'user_100' AND age = 25;</span><br><span class="line"><span class="comment">-- key=idx_name_age, type=ref</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ❌ 只用 age（跳过了最左列 name）→ 联合索引失效！</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE age = 25;</span><br><span class="line"><span class="comment">-- key=idx_age（走了单独的 idx_age 索引），但没走 idx_name_age</span></span><br><span class="line"><span class="comment">-- 如果删掉 idx_age 单独索引，则 key=NULL, type=ALL</span></span><br></pre></td></table></figure>

<h2 id="图解最左前缀"><a href="#图解最左前缀" class="headerlink" title="图解最左前缀"></a>图解最左前缀</h2>

<p>联合索引 <code>(name, age)</code> 的 B+ 树大致长这样：</p>

<pre><code>        [alice, 20]  ← 叶子节点按 (name, age) 排序
        [alice, 22]
        [bob, 30]
        [bob, 35]
        [carol, 25]
        ...
</pre></pre>

<p>如果你只查 <code>WHERE age = 25</code>，B+ 树里 age=25 的记录分散在各处（carol 可能在很后面），<strong>无法利用索引的有序性进行二分查找</strong>。但你查 <code>WHERE name = 'bob'</code>，可以直接定位到 bob 开头的区间。</p>

<h2 id="“跳过中间列”也失效"><a href="#“跳过中间列”也失效" class="headerlink" title="“跳过中间列”也失效"></a>"跳过中间列"也失效</h2>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- 假设有索引(a, b, c)</span></span><br><span class="line">WHERE a = 1 AND c = 3;    <span class="comment">-- 只能用上 a 列，c 跳过了 b → c 部分不走索引</span></span><br><span class="line">WHERE b = 2 AND c = 3;    <span class="comment">-- 完全没用上联合索引（a 缺失）</span></span><br><span class="line">WHERE a = 1 AND b > 2 AND c = 3;  <span class="text">-- a 和 b 能用（范围匹配），c 不能用</span></span><br></pre></td></table></figure>

<blockquote><p><strong>关键点：</strong>遇到 <code>&gt;</code>、<code>&lt;</code>、<code>BETWEEN</code>、<code>LIKE 'xx%'</code> 这类<strong>范围条件</strong>后，联合索引后面的列就全部失效了。因为范围匹配后的部分不再是有序区间扫描。</p></blockquote>

<h1 id="场景五：OR-连接的列有无索引不均"><a href="#场景五：OR-连接的列有无索引不均" class="headerlink" title="场景五：OR 连接的列有无索引不均"></a>场景五：OR 连接的列有无索引不均</h1>

<h2 id="现象-4"><a href="#现象-4" class="headerlink" title="现象"></a>现象</h2>

<p><code>OR</code> 连接的两个条件中，如果<strong>其中一列没有索引</strong>，整个查询往往退化为全表扫描。</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- email 列没有索引！</span></span><br><span class="line"><span class="comment">-- ❌ OR 两边有一边没索引 → 整体走全表扫</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user</span><br><span class="line">WHERE name = 'user_100' OR email = 'user99999@test.com';</span><br><span class="line"><span class="comment">-- type=ALL, key=NULL</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ✅ 改成 UNION ALL（两边各自走自己的索引）</span></span><br><span class="line">(SELECT * FROM t_user WHERE name = 'user_100')</span><br><span class="line">UNION ALL</span><br><span class="line">(SELECT * FROM t_user WHERE email = 'user99999@test.com');</span><br></pre></td></table></figure>

<h2 id="原因分析-3"><a href="#原因分析-3" class="headerlink" title="原因分析"></a>原因分析</h2>

<p><code>OR</code> 的语义是取并集。MySQL 在处理 <code>A OR B</code> 时，如果要走索引，需要对两个索引的结果做 <code>union</code> 合并。但当 B 列没有索引时，MySQL 无法通过索引获取 B 的结果集，<strong>干脆整体回退到全表扫描</strong>——反正都要遍历整张表来满足 OR 的另一半。</p>

<p>即使两列都有索引，MySQL 也未必会选择 <code>index_merge</code>（索引合并）策略，取决于优化器的成本估算。</p>

<blockquote><p><strong>实战建议：</strong>生产代码里遇到 <code>OR</code>，优先考虑改写成 <code>UNION ALL</code>，让每个子查询独立优化。注意 <code>UNION ALL</code> 不去重，如果业务需要去重用 <code>UNION</code>（代价稍高）。</p></blockquote>

<h1 id="场景六：NOT-IN-/-NOT-EXISTS-/-!="><a href="#场景六：NOT-IN-/-NOT-EXISTS-/-" class="headerlink" title="场景六：NOT IN / NOT EXISTS / !="></a>场景六：NOT IN / NOT EXISTS / !=</h1>

<h2 id="现象-5"><a href="#现象-5" class="headerlink" title="现象"></a>现象</h2>

<p><strong>否定式条件</strong>会让优化器认为选择性太差（可能返回大部分行），从而放弃索引。</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- ❌ != 导致索引失效（大部分情况下）</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE age != 25;</span><br><span class="line"><span class="comment">-- type=ALL（数据量大时）</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ❌ NOT IN 导致索引失效</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user</span><br><span class="line">WHERE name NOT IN ('user_1', 'user_2', 'user_3');</span><br><span class="line"><span class="comment">-- type=ALL</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ✅ 改写为范围查询</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE age &lt; 25 OR age &gt; 25;</span><br><span class="comment">-- 可能走 range（取决于数据分布）</span></span><br></pre></td></table></figure>

<h2 id="什么时候-!=-其实也能走索引？"><a href="#什么时候-!=-其实也能走索引？" class="headerlink" title="什么时候 != 其实也能走索引？"></a>什么时候 != 其实也能走索引？</h2>

<p>这不是绝对的。如果该列<strong>选择性非常高</strong>（比如某个状态字段，!= 1 只排除极少数行），优化器可能仍然选择走索引。但大多数业务场景下，!= 意味着"取绝大部分数据"，全表扫反而更快。</p>

<p>验证方式永远只有一个：<strong>EXPLAIN 说话</strong>。不要凭直觉。</p>

<h1 id="场景七：IS-NULL-/-IS-NOT-NULL"><a href="#场景七：IS-NULL-/-IS-NOT-NULL" class="headerlink" title="场景七：IS NULL / IS NOT NULL"></a>场景七：IS NULL / IS NOT NULL</h1>

<h2 id="现象-6"><a href="#现象-6" class="headerlink" title="现象"></a>现象</h2>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- IS NULL 在某些情况下可以走索引（InnoDB 对 NULL 有特殊处理）</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE phone IS NULL;</span><br><span class="line"><span class="comment">-- 可能走 ref（如果 phone 有索引且 NULL 值较少）</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- IS NOT NULL 通常导致索引失效</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE phone IS NOT NULL;</span><br><span class="line"><span class="comment">-- type=ALL（因为 NOT NULL 占了绝大多数行）</span></span><br></pre></td></table></figure>

<h2 id="InnoDB-对-NULL-的处理"><a href="#InnoDB-对-NULL-的处理" class="headerlink" title="InnoDB 对 NULL 的处理"></a>InnoDB 对 NULL 的处理</h2>

<p>InnoDB 的索引<strong>会存储 NULL 值</strong>（和 MyISAM 不同）。所以 <code>IS NULL</code> 是可以利用索引的——前提是 NULL 值占比足够小。</p>

<p>但 <code>IS NOT NULL</code> 通常意味着"取表中绝大部分行"，优化器自然倾向全表扫。</p>

<blockquote><p><strong>设计建议：</strong>如果业务上某列不允许为空，定义时加 <code>NOT NULL</code> 约束。这不仅避免了 <code>IS NULL / IS NOT NULL</code> 的歧义，还能节省存储空间（InnoDB 不需要额外存 NULL 标记位）。</p></blockquote>

<h1 id="场景八：优化器判断全表扫更快（数据倾斜）"><a href="#场景八：优化器判断全表扫更快（数据倾斜）" class="headerlink" title="场景八：优化器判断全表扫更快（数据倾斜）"></a>场景八：优化器判断全表扫更快（数据倾斜）</h1>

<h2 id="现象-7"><a href="#现象-7" class="headerlink" title="现象"></a>现象</h2>

<p>这是最容易让人困惑的场景：<strong>语法完全正确、没有函数、没有类型转换，但就是不走索引</strong>。</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- 插入大量相同 age 值的数据（模拟数据倾斜）</span></span><br><span class="line"><span class="keyword">UPDATE</span> t_user <span class="keyword">SET</span> age <span class="operator">=</span> <span class="number">25</span> <span class="keyword">WHERE</span> id <span class="operator">&lt;=</span> <span class="number">80000</span>;  <span class="comment">-- 80% 的数据 age=25</span></span><br><span class="line"><span class="keyword">ANALYZE</span> <span class="keyword">TABLE</span> t_user;  <span class="comment">-- 更新统计信息</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ❌ 虽然 age 有索引，但 80% 数据都是 25 → 优化器选全表扫</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE age = 25;</span><br><span class="line"><span class="comment">-- type=ALL, key=NULL</span></span><br><span class="line"><span class="comment">-- 因为回表成本太高：命中 80000 行，每行都要回表查其他列</span></span><br></pre></td></table></figure>

<h2 id="原因分析-4"><a href="#原因分析-4" class="headerlink" title="原因分析"></a>原因分析</h2>

<p>这就是 MySQL 优化器的<strong>基于成本的优化（CBO）</strong>在工作。它会估算：</p>
<ul>
<li>走索引：找到 80000 个主键 ID → 再做 80000 次<strong>回表</strong>（随机 I/O）</li>
<li>全表扫：顺序扫描聚簇索引（顺序 I/O）→ 一次搞定</li>
</ul>

<p>当匹配比例超过某个阈值（通常 20%~30%，受 <code>optimizer_search_depth</code>、<code>eq_range_index_dive_limit</code> 等参数影响），顺序读比大量随机读更划算。</p>

<h2 id="如何强制走索引（以及为什么不推荐）"><a href="#如何强制走索引（以及为什么不推荐）" class="headerlink" title="如何强制走索引（以及为什么不推荐）"></a>如何强制走索引（以及为什么不推荐）</h2>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- 强制提示（Force Index Hint）</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user <strong>FORCE INDEX</strong>(idx_age) WHERE age = 25;</span><br><span class="line"><span class="comment">-- 此时 type=ref, key=idx_age</span></span><br><span class="line"><span class="comment">-- 但实际执行不一定比全表扫快！</span></span><br></pre></td></table></figure>

<blockquote><p><strong>FORCE INDEX 是最后的手段</strong>。更合理的做法是：重新审视查询是否真的需要 <code>SELECT *</code>（改成覆盖索引就可以避免回表）、或者把这种低选择性条件和其他高选择性条件组合使用。</p></blockquote>

<h1 id="场景九：字符集不一致导致的隐式转换"><a href="#场景九：字符集不一致导致的隐式转换" class="headerlink" title="场景九：字符集不一致导致的隐式转换"></a>场景九：字符集不一致导致的隐式转换</h1>

<h2 id="现象-8"><a href="#现象-8" class="headerlink" title="现象"></a>现象</h2>

<p>这是一个比场景二更隐蔽的坑：<strong>两张表 JOIN 时字符集不同</strong>，也会触发隐式转换导致索引失效。</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- 表 A: utf8mb4</span></span><br><span class="line"><span class="keyword">CREATE</span> <span class="keyword">TABLE</span> t_order_utf8 (</span><br><span class="line">    id <span class="built_in">BIGINT</span> <span class="keyword">PRIMARY</span> KEY,</span><br><span class="line">    user_name <span class="built_in">VARCHAR</span>(<span class="number">50</span>) <span class="keyword">NOT</span> <span class="keyword">NULL</span>,</span><br><span class="line">    INDEX idx_uname(user_name)</span><br><span class="line">) CHARSET<span class="operator">=</span>utf8mb4;</span><br><span class="line"></span><br><span class="line"><span class="comment">-- 表 B: utf8（注意不是 utf8mb4！）</span></span><br><span class="line"><span class="keyword">CREATE</span> <span class="keyword">TABLE</span> t_user_utf8 (</span><br><span class="line">    id <span class="built_in">BIGINT</span> <span class="keyword">PRIMARY</span> KEY,</span><br><span class="line">    name <span class="built_in">VARCHAR</span>(<span class="number">50</span>) <span class="keyword">NOT</span> <span class="keyword">NULL</span>,</span><br><span class="line">    INDEX idx_name(name)</span><br><span class="line">) CHARSET<span class="operator">=</span>utf8;  <span class="comment">-- ⚠️ 不同字符集！</span></span><br></pre></td></table></figure>

<p>当这两张表 JOIN 时：</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line">EXPLAIN SELECT * FROM t_order_utf8 o</span><br><span class="line"><span class="keyword">JOIN</span> t_user_utf8 u <span class="keyword">ON</span> o.user_name <span class="operator">=</span> u.name;</span><br><span class="line"><span class="comment">-- Extra 列可能出现 "Using join buffer (Block Nested Loop)"</span></span><br><span class="line"><span class="comment">-- 索引被忽略，因为需要做字符集转换</span></span><br></pre></td></table></figure>

<h2 id="原因分析-5"><a href="#原因分析-5" class="headerlink" title="原因分析"></a>原因分析</h2>

<p><code>utf8</code>（ aka <code>utf8mb3</code>）最多 3 字节/字符，<code>utf8mb4</code> 最多 4 字节/字符。MySQL 在比较不同字符集的列时，需要进行<strong>字符集转换</strong>——同样等效于对索引列施加了函数。</p>

<blockquote><p><strong>排查命令：</strong>如果怀疑 JOIN 变慢是因为字符集问题，用以下 SQL 检查：<br>
<code>SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_SET_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE();</code><br>
确保同一库内所有关联字段的字符集和 collation 一致。</p></blockquote>

<h1 id="场景十：ORDER-BY-无法利用索引排序"><a href="#场景十：ORDER-BY-无法利用索引排序" class="headerlink" title="场景十：ORDER BY 无法利用索引排序"></a>场景十：ORDER BY 无法利用索引排序</h1>

<h2 id="现象-9"><a href="#现象-9" class="headerlink" title="现象"></a>现象</h2>

<p>严格来说这不算是"索引失效"（查询本身可能还是走索引的），但 <code>ORDER BY</code> 触发的 <strong>Using filesort</strong> 是性能杀手，值得归为一类讨论。</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- ✅ ORDER BY 完美匹配联合索引 (name, age)</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE name = 'user_100' ORDER BY age;</span><br><span class="line"><span class="comment">-- Extra: NULL（无 filesort，利用索引有序性）</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ❌ ORDER BY 与索引顺序不一致</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE name = 'user_100' ORDER BY age, name;</span><br><span class="line"><span class="comment">-- Extra: Using filesort; Backward index scan</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ❌ ORDER BY 用了不在索引中的列</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE name = 'user_100' ORDER BY email;</span><br><span class="line"><span class="comment">-- Extra: Using filesort</span></span><br><span class="line"></span><br><span class="line"><span class="comment">-- ❌ ASC / DESC 混用（MySQL 8.0+ 已支持降序索引，但需显式创建）</span></span><br><span class="line">EXPLAIN SELECT * FROM t_user WHERE name = 'user_100' ORDER BY age ASC, name DESC;</span><br><span class="line"><span class="comment">-- Extra: Using filesort（除非创建 (name DESC, age ASC) 这样的混合索引）</span></span><br></pre></td></table></figure>

<h2 id="什么是-Filesort？"><a href="#什么是-Filesort？" class="headerlink" title="什么是 Filesort？"></a>什么是 Filesort？</h2>

<p><strong>Filesort 并不是说"用了磁盘文件来排序"</strong>（名字有误导性）。它是指 MySQL 在内存中（不够时用临时文件）对结果集做一次快速排序。这个过程额外的 CPU 和内存开销在大结果集下非常可观。</p>

<p>你可以通过以下方式观察 filesort 的开销：</p>

<figure class="highlight sql"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">-- 开启 Slow Query Log 记录排序操作</span></span><br><span class="keyword">SET</span> <span class="variable">global</span> log_slow_rate_limit <span class="operator">=</span> <span class="number">1</span>;</span><br><span class="keyword">SET</span> <span class="variable">global</span> log_queries_not_using_indexes <span class="operator">=</span> <span class="keyword">ON</span>;</span><br><span class="line"><span class="comment">-- 然后查看 STATUS 中的 Sort_rows / Sort_merge_passes / Sort_scan_count</span></span><br><span class="line"><span class="keyword">SHOW</span> SESSION STATUS <span class="keyword">LIKE</span> <span class="string">'Sort%'</span>;</span><br></pre></td></table></figure>

<h1 id="EXPLAIN-实战排障流程"><a href="#EXPLAIN-实战排障流程" class="headerlink" title="EXPLAIN 实战排障流程"></a>EXPLAIN 实战排障流程</h1>

<p>拿到一条慢 SQL 后，按以下步骤系统性排查：</p>

<figure class="highlight plaintext"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line">① EXPLAIN 看 type：
   - ALL          → 全表扫描，重点排查
   - index        → 遍历索引树（比 ALL 稍好但仍需优化）
   - range        → 范围扫描，一般可接受
   - ref / eq_ref → 等值查找，理想状态

② EXPLAIN 看 key：
   - NULL         → 没用到任何索引
   - 有值但不对  → 用错了索引（考虑 USE INDEX 提示）

③ EXPLAIN 看 rows：
   - 数字越大越危险（预估扫描行数）

④ EXPLAIN 看 Extra：
   - Using filesort     → 排序无法利用索引
   - Using temporary    → 用了临时表（GROUP BY 常见）
   - Using where        → 存储引擎返回后还需 Server 层过滤
   - Using index condition → 索引条件下推（ICP，好现象）
   - Using index; Using where → 覆盖索引（最佳状态）

⑤ SHOW WARNINGS;
   - 查看 SQL 重写后的真实形态（发现隐式转换）

⑥ SHOW PROFILE / OPTIMIZER_TRACE；
   - 深入看优化器决策过程（高级排障）
</span></pre></td></table></figure>

<h1 id="十种场景速查表"><a href="#十种场景速查表" class="headerlink" title="十种场景速查表"></a>十种场景速查表</h1>

<table>
<thead>
<tr>
<th style="text-align:center">#</th>
<th style="text-align:left">场景</th>
<th style="text-align:left">典型 SQL 写法</th>
<th style="text-align:center">type 退化</th>
<th style="text-align:left">修复方法</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">1</td>
<td style="text-align:left">索引列用函数</td>
<td style="text-align:left"><code>WHERE UPPER(col) = ?</code></td>
<td style="text-align:center">ALL</td>
<td style="text-align:left">去掉函数 / 用生成列+函数索引</td>
</tr>
<tr>
<td style="text-align:center">2</td>
<td style="text-align:left">隐式类型转换</td>
<td style="text-align:left"><code>WHERE varchar_col = 123</code></td>
<td style="text-align:center">ALL</td>
<td style="text-align:left">常量加引号匹配类型</td>
</tr>
<tr>
<td style="text-align:center">3</td>
<td style="text-align:left">LIKE %开头</td>
<td style="text-align:left"><code>WHERE col LIKE '%xx'</code></td>
<td style="text-align:center">ALL</td>
<td style="text-align:left">改用 ES / 全文索引 / 前缀匹配</td>
</tr>
<tr>
<td style="text-align:center">4</td>
<td style="text-align:left">违反最左前缀</td>
<td style="text-align:left"><code>WHERE (b,c) on index(a,b,c)</code></td>
<td style="text-align:center">ALL/ref(部分)</td>
<td style="text-align:left">调整索引列顺序 / 调整 SQL 条件顺序</td>
</tr>
<tr>
<td style="text-align:center">5</td>
<td style="text-align:left">OR 含无索引列</td>
<td style="text-align:left"><code>WHERE a=? OR no_idx_col=?</code></td>
<td style="text-align:center">ALL</td>
<td style="text-align:left">改 UNION ALL / 补索引</td>
</tr>
<tr>
<td style="text-align:center">6</td>
<td style="text-align:left">NOT IN / !=</td>
<td style="text-align:left"><code>WHERE col != ?</code></td>
<td style="text-align:center">ALL</td>
<td style="text-align:left">改写为范围查询</td>
</tr>
<tr>
<td style="text-align:center">7</td>
<td style="text-align:left">IS NOT NULL</td>
<td style="text-align:left"><code>WHERE col IS NOT NULL</code></td>
<td style="text-align:center">ALL</td>
<td style="text-align:left">设计时用 NOT NULL 约束</td>
</tr>
<tr>
<td style="text-align:center">8</td>
<td style="text-align:left">数据倾斜（低选择性）</td>
<td style="text-align:left"><code>WHERE low_cardinality_col = ?</code></td>
<td style="text-align:center">ALL</td>
<td style="text-align:left">覆盖索引 / FORCE INDEX / 组合条件</td>
</tr>
<tr>
<td style="text-align:center">9</td>
<td style="text-align:left">字符集不一致</td>
<td style="text-align:left"><code>JOIN utf8 ON utf8mb4.col</code></td>
<td style="text-align:center">ALL</td>
<td style="text-align:left">统一库/表/列字符集为 utf8mb4</td>
</tr>
<tr>
<td style="text-align:center">10</td>
<td style="text-align:left">ORDER BY 不匹配索引</td>
<td style="text-align:left"><code>ORDER BY non_index_col</code></td>
<td style="text-align:center">-</td>
<td style="text-align:left">调整索引 / 调整 ORDER BY / 减少返回列</td>
</tr>
</tbody>
</table>

<h1 id="常见误区与避坑指南"><a href="#常见误区与避坑指南" class="headerlink" title="常见误区与避坑指南"></a>常见误区与避坑指南</h1>

<h3 id="误区-1：“加了索引就一定快”"><a href="#误区-1：“加了索引就一定快”" class="headerlink" title="误区 1："加了索引就一定快""></a>误区 1："加了索引就一定快"</h3>
<p><strong>真相：</strong>索引本身有维护成本。每次 INSERT/UPDATE/DELETE 都要更新索引树；索引占用磁盘空间；优化器选错索引可能比全表扫更慢。合理的前提是：查询模式稳定、选择性足够高。</p>

<h3 id="误区-2：“索引越多越好”"><a href="#误区-2：“索引越多越好”" class="headerlink" title="误区 2："索引越多越好""></a>误区 2："索引越多越好"</h3>
<p><strong>真相：</strong>单表索引不宜超过 6 个（经验值）。索引过多会导致写入性能下降、优化器选择困难、磁盘空间浪费。定期用 <code>SELECT * FROM sys.schema_unused_indexes</sys> 查找未使用的索引。</p>

<h3 id="误区-3：“EXPLAIN-type-是-ref-就完美了”"><a href="#误区-3：“EXPLAIN-type-是-ref-就完美了”" class="headerlink" title="误区 3："EXPLAIN type 是 ref 就完美了""></a>误区 3："EXPLAIN type 是 ref 就完美了"</h3>
<p><strong>真相：</strong>还要看 <strong>rows</strong> 和 <strong>Extra</strong>。type=ref 但 rows=50000 且 Extra 含 Using temporary，依然可能是慢查询。综合判断。</p>

<h3 id="误区-4：“在-WHERE-里用了索引列就会走索引”"><a href="#误区-4：“在-WHERE-里用了索引列就会走索引”" class="headerlink" title="误区 4："在 WHERE 里用了索引列就会走索引""></a>误区 4："在 WHERE 里用了索引列就会走索引"</h3>
<p><strong>真相：</strong>本文十个反例全是"用了索引列但没走索引"的情况。是否走索引取决于<strong>怎么用</strong>，而非<strong>有没有用</strong>。</p>

<h3 id="误区-5：“force-index-是性能问题的银弹”"><a href="#误区-5：“force-index-是性能问题的银弹”" class="headerlink" title="误区 5："force index 是性能问题的银弹""></a>误区 5："force index 是性能问题的银弹"</h3>
<p><strong>真相：</strong>FROCE INDEX 只是绕过了优化器的决策，数据分布变化后可能导致更严重的性能回归。应该优先解决根本原因（调整索引设计、改写 SQL），只在极端情况下作为临时方案。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>MySQL 索引失效的本质原因可以归纳为三类：</p>
<ul>
<li><strong>索引列被"污染"</strong>：函数运算、隐式类型转换、字符集不一致——让优化器无法利用索引的原始有序性</li>
<li><strong>索引结构无法满足查询模式</strong>：最左前缀违反、LIKE 左通配、ORDER BY 不匹配——B+ 树的有序性帮不上忙</li>
<li><strong>优化器主动放弃</strong>：OR 半边无索引、NOT IN/!= 低选择性、数据倾斜——走索引成本高于全表扫描</li>
</ul>

<p>日常开发的最佳实践：</p>
<ul>
<li><strong>建表阶段</strong>：统一 utf8mb4、NOT NULL 约束、根据查询模式设计联合索引</li>
<li><strong>写 SQL 阶段</strong>：索引列保持裸列、常量类型匹配、OR 改 UNION ALL</li>
<li><strong>排查阶段</strong>：EXPLAIN + SHOW WARNINGS + optimizer_trace 三件套定位根因</li>
<li><strong>运维阶段</strong>：ANALYZE TABLE 定期更新统计信息、清理无用索引、监控 Slow Query Log</li>
</ul>

<p>记住：<strong>索引不是万能药，但它是最性价比高的数据库性能优化手段——前提是你得懂它在什么时候会"摆烂"</strong>。🎯</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><a href="https://dev.mysql.com/doc/refman/8.0/en/explain-output.html" target="_blank">MySQL 8.0 Reference Manual — EXPLAIN Output Format</a> — EXPLAIN 各字段官方权威解释</li>
<li><a href="https://dev.mysql.com/doc/refman/8.0/en/index-btree-use.html" target="_blank">MySQL 8.0 Reference Manual — How MySQL Uses Indexes</a> — MySQL 索引使用机制官方文档</li>
<li><a href="https://dev.mysql.com/doc/refman/8.0/en/optimizer-trace-table.html" target="_blank">MySQL 8.0 Reference Manual — Optimizer Trace</a> — 优化器追踪工具文档</li>
<li><a href="https://mysqlserverteam.com/mysql-8-0-invisible-indexes-and-index-upgrades/" target="_blank">MySQL Server Team — MySQL 8.0: Invisible Indexes and Index Upgrades</a> — 不可见索引特性介绍</li>
<li><a href="https://tech.meituan.com/2014/01/02/mysql-index.html" target="_blank">美团技术团队 — MySQL 索引原理及慢查询优化</a> — 国内经典的索引优化实践文章</li>
<li><a href="https://zhuanlan.zhihu.com/p/134055234" target="_blank">阿里云 RDS 团队 — MySQL 执行计划解读与优化</a> — EXPLAIN 实战案例丰富</li>
<li><a href="https://www.percona.com/blog/2023/04/understanding-mysql-query-execution-plan-with-explain/" target="_blank">Percona Blog — Understanding MySQL Query Execution Plan with EXPLAIN</a> — 英文深度解读 EXPLAIN</li>
</ol>
