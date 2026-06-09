---
title: MySQL 索引失效场景与 EXPLAIN 实战分析——从原理到逐条验证
date: 2026-06-09 10:00:00
categories:
  - 数据库与存储
  - MySQL
tags:
  - MySQL
  - 索引优化
  - EXPLAIN
  - SQL 调优
  - B+Tree
---
<hr>
<blockquote><p>索引失效是 MySQL 慢查询的头号元凶。你以为加了索引就万事大吉？——函数运算、隐式转换、LIKE 前缀通配、OR 条件……每一个都能让你的 B+Tree 索引形同虚设。本文将搭建一个可复现的实验环境，用 <strong>EXPLAIN</strong> 逐条验证 8 大经典索引失效场景，给出每种场景的「走索引 vs 全表扫描」对比数据，并附上排查思路和规避方案，帮你从"盲猜"升级到"有据可依"。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么索引会“失效”？"><a href="#背景：为什么索引会“失效”？" class="headerlink" title="背景：为什么索引会"失效"？"></a>背景：为什么索引会"失效"？</h1>

<p>先说结论：<strong>索引失效的本质是 MySQL 优化器判断"走索引的成本比全表扫描还高"，于是主动放弃了索引</strong>。</p>

<p>你大概遇到过这种事：明明给字段加了索引，<code>EXPLAIN</code> 一看 <code>type=ALL</code>（全表扫描），查询还是慢得离谱。这时候很多人就开始玄学了："是不是没命中缓存？""要不要 ANALYZE TABLE？"——别猜，用数据说话。</p>

<p><strong>B+Tree 索引</strong>（B-Plus Tree Index）：MySQL InnoDB 引擎最常用的索引结构，叶子节点按顺序链表连接，每个叶子节点存的是完整行数据（聚簇索引）或主键值（二级索引）。它的查找复杂度是 O(log N)，但前提是你的查询条件能"顺着树往下走"。一旦你在条件里对索引列做了函数运算、类型转换、或者用了让优化器无法确定范围的写法，它就没法利用有序性了。</p>

<p><code><strong>EXPLAIN</strong></code>：MySQL 自带的执行计划分析工具，在 SELECT 语句前加 <code>EXPLAIN</code> 关键字就能看到优化器打算怎么跑这条 SQL——用什么索引、扫描多少行、是否回表、有没有临时表/排序等。这是我们分析索引是否生效的核心武器。</p>

<p>本文所有实验基于以下环境：</p>
<pre><code class="language-text">MySQL 8.0.x（5.7 也适用大部分场景）
引擎：InnoDB
字符集：utf8mb4
</code></pre>

<h1 id="实验环境准备"><a href="#实验环境准备" class="headerlink" title="实验环境准备"></a>实验环境准备</h1>

<h2 id="建表与初始化数据"><a href="#建表与初始化数据" class="headerlink" title="建表与初始化数据"></a>建表与初始化数据</h2>

<p>我们创建一张<strong>员工表</strong>，覆盖各种数据类型和业务场景：</p>
<pre><code class="language-sql">-- ============================
-- 实验表：员工信息表
-- ============================
CREATE TABLE `emp` (
  `id`          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  `name`        VARCHAR(50)  NOT NULL              COMMENT '姓名',
  `dept`        VARCHAR(30)  NOT NULL DEFAULT ''    COMMENT '部门',
  `phone`       VARCHAR(20)  NOT NULL DEFAULT ''    COMMENT '手机号（字符串存储！）',
  `email`       VARCHAR(100) NOT NULL DEFAULT ''    COMMENT '邮箱',
  `age`         INT          NOT NULL DEFAULT 0      COMMENT '年龄',
  `salary`      DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '薪资',
  `hire_date`   DATE         NOT NULL               COMMENT '入职日期',
  `status`      TINYINT      NOT NULL DEFAULT 1      COMMENT '状态 1=在职 0=离职',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- 创建联合索引（用于验证最左匹配原则）
  INDEX `idx_dept_status_salary` (`dept`, `status`, `salary`),
  -- 单列索引
  INDEX `idx_name` (`name`),
  INDEX `idx_phone` (`phone`),
  INDEX `idx_hire_date` (`hire_date`),
  INDEX `idx_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='员工表-索引失效实验';
</code></pre>

<p>插入测试数据（建议至少 10000+ 行，否则优化器可能在小数据量时选择全表扫描）：</p>
<pre><code class="language-sql">-- 插入批量测试数据（约 5 万行）
DELIMITER //
CREATE PROCEDURE insert_emp_data()
BEGIN
  DECLARE i INT DEFAULT 1;
  WHILE i <= 50000 DO
    INSERT INTO emp (name, dept, phone, email, age, salary, hire_date, status)
    VALUES (
      CONCAT('员工', i),
      ELT(1 + FLOOR(RAND() * 5), '研发部', '产品部', '市场部', '人事部', '财务部'),
      CONCAT('138', LPAD(FLOOR(RAND() * 100000000), 8, '0')),
      CONCAT('emp', i, '@example.com'),
      22 + FLOOR(RAND() * 35),
      8000 + FLOOR(RAND() * 42000),
      DATE_SUB(CURDATE(), INTERVAL FLOOR(RAND() * 3650) DAY),
      CASE WHEN RAND() > 0.1 THEN 1 ELSE 0 END
    );
    SET i = i + 1;
  END WHILE;
END //
DELIMITER ;

CALL insert_emp_data();
DROP PROCEDURE insert_emp_data;
</code></pre>

<p>插入完成后确认一下：</p>
<pre><code class="language-sql">SELECT COUNT(*) FROM emp;  -- 应该 ≈ 50000
SHOW INDEX FROM emp;        -- 确认索引已创建
</code></pre>

<blockquote>
<p><strong>注：</strong>如果只是本地学习不想插这么多数据，最少也要 1000 行以上。数据量太小时 MySQL 优化器可能直接选全表扫描（因为全表扫描成本也很低），这会干扰我们的实验结果。</p>
</blockquote>

<h2 id="EXPLAIN-核心字段速查表"><a href="#EXPLAIN-核心字段速查表" class="headerlink" title="EXPLAIN 核心字段速查表"></a>EXPLAIN 核心字段速查表</h2>

<p>在开始之前，先把我们要关注的 <code>EXPLAIN</code> 字段过一遍：</p>
<table>
<thead>
<tr>
<th>字段</th>
<th>含义</th>
<th>好/坏标志</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>type</strong></td>
<td>访问类型（扫描方式）</td>
<td><code>system &gt; const &gt; eq_ref &gt; ref &gt; range &gt; index &gt; ALL</code>，出现 <code>ALL</code> 要警惕</td>
</tr>
<tr>
<td><strong>key</strong></td>
<td>实际使用的索引名</td>
<td><code>NULL</code> = 没用上任何索引</td>
</tr>
<tr>
<td><strong>rows</strong></td>
<td>预估扫描行数</td>
<td>越接近实际返回行数越好</td>
</tr>
<tr>
<td><strong>Extra</strong></td>
<td>额外信息</td>
<td><code>Using index condition</code> / <code>Using where</code> 正常；<code>Using filesort</code> / <code>Using temporary</code> 需关注</td>
</tr>
<tr>
<td><strong>possible_keys</strong></td>
<td>可能用到的索引</td>
<td>如果有值但 <code>key=NULL</code>，说明优化器主动放弃了</td>
</tr>
</tbody>
</table>

<h1 id="八大索引失效场景逐条验证"><a href="#八大索引失效场景逐条验证" class="headerlink" title="八大索引失效场景逐条验证"></a>八大索引失效场景逐条验证</h1>

<h2 id="场景一：索引列上使用函数或表达式"><a href="#场景一：索引列上使用函数或表达式" class="headerlink" title="场景一：索引列上使用函数或表达式"></a>场景一：索引列上使用函数或表达式</h2>

<p><strong>典型写法：</strong></p>
<pre><code class="language-sql">-- ❌ 对索引列使用函数 → 索引失效
EXPLAIN SELECT * FROM emp WHERE SUBSTRING(phone, 1, 3) = '138';
</code></pre>

<p><strong>结果示例：</strong></p>
<table>
<thead>
<tr>
<th>字段</th>
<th>值</th>
<th>解读</th>
</tr>
</thead>
<tbody>
<tr>
<td>type</td>
<td><code>ALL</code></td>
<td>全表扫描！</td>
</tr>
<tr>
<td>key</td>
<td><code>NULL</code></td>
<td>没用上 idx_phone</td>
</tr>
<tr>
<td>rows</td>
<td><code>~50000</code></td>
<td>扫了全表</td>
</tr>
<tr>
<td>Extra</td>
<td><code>Using where</code></td>
<td>在 Server 层过滤</td>
</tr>
</tbody>
</table>

<p><strong>原因：</strong>B+Tree 索引里存的是 <code>phone</code> 的原始值（如 "13812345678"），不是 <code>SUBSTRING(phone, 1, 3)</code> 的结果。优化器没法在索引树上做函数计算，只能每行取出来算一遍再比较。</p>

<p><strong>✅ 正确改法：</strong>把函数运算转移到"常量端"，让索引列保持裸列形式：</p>
<pre><code class="language-sql">-- ✅ 改为范围查询，能走索引
EXPLAIN SELECT * FROM emp WHERE phone >= '13800000000' AND phone < '13900000000';

-- 或者用Generated Column（MySQL 5.7+）建立函数索引：
ALTER TABLE emp ADD COLUMN phone_prefix VARCHAR(3)
  GENERATED ALWAYS AS (SUBSTRING(phone, 1, 3)) STORED;
CREATE INDEX idx_phone_prefix ON emp (phone_prefix);
EXPLAIN SELECT * FROM emp WHERE phone_prefix = '138';  -- type=ref ✅
</code></pre>

<p><strong>常见踩坑函数清单：</strong></p>
<table>
<thead>
<tr>
<th>函数类别</th>
<th>示例</th>
<th>影响索引</th>
</tr>
</thead>
<tbody>
<tr>
<td>字符串截取</td>
<td><code>SUBSTRING()</code>, <code>LEFT()</code>, <code>RIGHT()</code></td>
<td>❌ 失效</td>
</tr>
<tr>
<td>数学运算</td>
<td><code>ABS(age)</code>, <code>salary + 1000</code></td>
<td>❌ 失效</td>
</tr>
<tr>
<td>日期计算</td>
<td><code>YEAR(hire_date)</code>, <code>DATE_FORMAT(hire_date, '%Y%m')</code></td>
<td>❌ 失效</td>
</tr>
<tr>
<td>类型转换</td>
<td><code>CAST(phone AS SIGNED)</code></td>
<td>❌ 失效</td>
</tr>
</tbody>
</table>

<h2 id="场景二：隐式类型转换"><a href="#场景二：隐式类型转换" class="headerlink" title="场景二：隐式类型转换"></a>场景二：隐式类型转换</h2>

<p>这是<strong>线上最容易中招的场景之一</strong>，没有之一。</p>

<p>回顾一下我们的建表：<code>phone</code> 是 <code>VARCHAR(20)</code>，但你查的时候传了数字：</p>
<pre><code class="language-sql">-- ❌ phone 是 VARCHAR，但传入数字 → 隐式转换 → 索引失效
EXPLAIN SELECT * FROM emp WHERE phone = 13812345678;
</code></pre>

<p><strong>结果：</strong><code>type=ALL</code>, <code>key=NULL</code> —— 又全表扫描了！</p>

<p><strong>原因：</strong>MySQL 的类型转换规则是"<strong>将字符串转为数字</strong>"进行比较。也就是说上面那条 SQL 等价于：</p>
<pre><code class="language-sql">SELECT * FROM emp WHERE CAST(phone AS SIGNED) = 13812345678;
</code></pre>

<p>看，又回到了"索引列上使用函数"的老问题。<code>CAST(phone AS SIGNED)</code> 让 idx_phone 彻底报废。</p>

<p><strong>✅ 正确改法：</strong>保证类型一致，加引号：</p>
<pre><code class="language-sql">-- ✅ 字符串用字符串比较 → 走索引
EXPLAIN SELECT * FROM emp WHERE phone = '13812345678';
-- type=ref, key=idx_phone, rows≈1 ✅
</code></pre>

<blockquote>
<p><strong>注：</strong>这个坑在 ORM 框架里更隐蔽。MyBatis 中 <code>#{phone}</code> 如果 Java 类型是 <code>Long</code> 但数据库字段是 <code>VARCHAR</code>，就会悄无声息地触发隐式转换。检查方式：<code>SHOW WARNINGS;</code> 在 <code>EXPLAIN</code> 之后立即执行，能看到优化器做的转换。</p>
</blockquote>

<h2 id="场景三：LIKE-以通配符开头"><a href="#场景三：LIKE-以通配符开头" class="headerlink" title="场景三：LIKE 以 % 开头"></a>场景三：LIKE 以 <code>%</code> 开头</h2>

<pre><code class="language-sql">-- ❌ % 在左边 → B+Tree 无法确定范围起点 → 索引失效
EXPLAIN SELECT * FROM emp WHERE name LIKE '%张三';

-- ❌ 两边都是 % → 同样失效
EXPLAIN SELECT * FROM emp WHERE name LIKE '%三%';
</code></pre>

<p><strong>结果：</strong><code>type=ALL</code>, <code>key=NULL</code>。</p>

<p><strong>原因：</strong>B+Tree 是有序的，要利用索引必须有一个明确的"左前缀"来定位范围。<code>'%张三'</code> 意味着"以'张三'结尾"，这在有序索引树上没法快速定位——你得遍历所有节点才能找到符合条件的。</p>

<p><strong>✅ 正确改法：</strong></p>
<pre><code class="language-sql">-- ✅ 右模糊（% 在右边）→ 可以走索引范围扫描
EXPLAIN SELECT * FROM emp WHERE name LIKE '张三%';
-- type=range, key=idx_name ✅

-- 如果必须左模糊，考虑：
-- 方案1：Elasticsearch / 全文索引（适合大量文本搜索）
-- 方案2：反转存储（特定场景）
-- 方案3：接受全表扫描，但限制结果集 + 分页
</code></pre>

<p>对比总结：</p>
<table>
<thead>
<tr>
<th>LIKE 写法</th>
<th>type</th>
<th>key</th>
<th>是否走索引</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>name LIKE '张三%'</code></td>
<td><code>range</code></td>
<td><code>idx_name</code></td>
<td>✅ 走索引范围扫描</td>
</tr>
<tr>
<td><code>name LIKE '%张三'</code></td>
<td><code>ALL</code></td>
<td><code>NULL</code></td>
<td>❌ 全表扫描</td>
</tr>
<tr>
<td><code>name LIKE '%张三%'</code></td>
<td><code>ALL</code></td>
<td><code>NULL</code></td>
<td>❌ 全表扫描</td>
</tr>
<tr>
<td><code>name LIKE '张三'</code></td>
<td><code>ref</code>（或 const）</td>
<td><code>idx_name</code></td>
<td>✅ 等价于等值查询</td>
</tr>
</tbody>
</table>

<h2 id="场景四：违反最左匹配原则（联合索引）"><a href="#场景四：违反最左匹配原则（联合索引）" class="headerlink" title="场景四：违反最左匹配原则（联合索引）"></a>场景四：违反最左匹配原则（联合索引）</h2>

<p>我们建的联合索引是 <code>idx_dept_status_salary (dept, status, salary)</code>。来看看哪些情况能用、哪些不能用：</p>
<pre><code class="language-sql">-- ✅ 场景A：使用最左列 dept → 能走索引
EXPLAIN SELECT * FROM emp WHERE dept = '研发部';
-- type=ref, key=idx_dept_status_salary ✅

-- ✅ 场景B：使用 (dept, status) → 能走索引
EXPLAIN SELECT * FROM emp WHERE dept = '研发部' AND status = 1;
-- type=ref, key=idx_dept_status_salary ✅

-- ✅ 场景C：使用 (dept, status, salary) → 能走索引
EXPLAIN SELECT * FROM emp WHERE dept = '研发部' AND status = 1 AND salary > 15000;
-- type=range, key=idx_dept_status_salary ✅

-- ⚠️ 场景D：跳过 dept，直接用 status → 索引失效！
EXPLAIN SELECT * FROM emp WHERE status = 1;
-- type=ALL, key=NULL ❌ （除非有单独的 status 索引）

-- ⚠️ 场景E：跳过 dept 和 status，直接用 salary → 索引失效！
EXPLAIN SELECT * FROM emp WHERE salary > 20000;
-- type=ALL, key=NULL ❌

-- ✅ 场景F：dept 范围查询后，status 能用吗？→ 部分有效
EXPLAIN SELECT * FROM emp WHERE dept > '研发部' AND status = 1;
-- type=range, key=idx_dept_status_salary
-- 但注意：只有 dept 列走了范围扫描，status 和 salary 可能无法继续定位
</code></pre>

<p><strong>最左匹配原则</strong>（Leftmost Prefix Principle）：对于联合索引 <code>(a, b, c)</code>，查询条件必须从 a 开始连续引用。用 <code>a</code>、<code>(a,b)</code>、<code>(a,b,c)</code> 都能走索引；单独用 <code>b</code>、<code>c</code> 或 <code>(a,c)</code> 则不行。</p>

<p><strong>为什么是这样？</strong>因为联合索引的 B+Tree 是按 <code>(dept, status, salary)</code> 三元组排序的。先按 <code>dept</code> 排序，<code>dept</code> 相同再按 <code>status</code> 排，<code>status</code> 相同再按 <code>salary</code> 排。如果你不指定 <code>dept</code>，优化器根本不知道该从树的哪个位置开始找。</p>

<p><strong>⚠️ 一个重要细节——范围查询后面的列会"断裂"：</strong></p>
<pre><code class="language-sql">-- dept 是等值查询 → status 还能接着用
WHERE dept = '研发部' AND status = 1 AND salary > 15000;
-- 用到了 (dept, status, salary) 三列 ✅

-- dept 是范围查询 → status 和 salary 基本废了
WHERE dept >= '研发部' AND dept <= '研发部' AND status = 1;
-- 只有 dept 走了索引，status/salary 在 Server 层过滤
</code></pre>

<blockquote>
<p><strong>注：</strong>MySQL 8.0.13+ 引入了 <code>Skip Scan</code>（索引跳跃扫描），在某些情况下可以绕过最左前缀限制。但这只适用于低基数的最左列（比如性别只有男/女两种值），且有一定开销。不要依赖它来拯救糟糕的索引设计。</p>
</blockquote>

<h2 id="场景五：OR-连接的条件列没有全部加索引"><a href="#场景五：OR-连接的条件列没有全部加索引" class="headerlink" title="场景五：OR 连接的条件列没有全部加索引"></a>场景五：OR 连接的条件列没有全部加索引</h2>

<pre><code class="language-sql">-- ❌ name 有索引，但 age 没有单独索引 → 整体退化到全表扫描
EXPLAIN SELECT * FROM emp WHERE name = '员工1' OR age = 30;
-- type=ALL, key=NULL ❌

-- ✅ 两个条件列都有索引 → 能走 index merge
EXPLAIN SELECT * FROM emp WHERE name = '员工1' OR email = 'emp2@example.com';
-- type=index_merge, key=idx_name,idx_email ✅
</code></pre>

<p><strong>原因：</strong><code>OR</code> 的语义是"取并集"。当两个条件分别指向不同索引时，MySQL 需要"各查一遍再合并"。但如果其中一列没有索引，优化器想："反正有一半要全表扫，不如一次性全表扫完算了"。</p>

<p><strong>✅ 解决方案：</strong></p>
<ul>
<li>给 <code>OR</code> 涉及的所有列都加上合适的索引（推荐）</li>
<li>把 <code>OR</code> 改写成 <code>UNION ALL</code>（有时效果更好）</li>
<li>用 <code>UNION</code> 替代 <code>OR</code>，让每个子查询独立走自己的索引：</li>
</ul>
<pre><code class="language-sql">-- ✅ UNION 改写，各自走各自的索引
SELECT * FROM emp WHERE name = '员工1'
UNION
SELECT * FROM emp WHERE age = 30;
-- 第一个走 idx_name，第二个虽然 age 无索引但数据量小
</code></pre>

<h2 id="场景六：NOT-IN-NOT-EXISTS-不等于操作"><a href="#场景六：NOT-IN-NOT-EXISTS-不等于操作" class="headerlink" title="场景六：NOT IN / NOT EXISTS / != 操作"></a>场景六：NOT IN / NOT EXISTS / != 操作</h2>

<pre><code class="language-sql">-- ❌ NOT IN → 通常导致索引失效（尤其是对非主键列）
EXPLAIN SELECT * FROM emp WHERE dept NOT IN ('实习部', '外包部');
-- type=ALL, key=NULL ❌

-- ❌ != （&lt;&gt;）→ 同样容易失效
EXPLAIN SELECT * FROM emp WHERE dept != '研发部';
-- type=ALL（或 range 但 rows 很大）

-- ❌ NOT EXISTS → 类似
EXPLAIN SELECT * FROM emp e WHERE NOT EXISTS (
  SELECT 1 FROM emp e2 WHERE e2.dept = e.dept AND e2.id &lt; e.id
);
</code></pre>

<p><strong>原因：</strong><code>NOT IN</code>、<code>!=</code> 这类操作的结果是一个"范围很大的集合"，优化器判断使用索引的收益很低（可能要回表绝大部分数据），不如直接全表扫描。</p>

<p><strong>✅ 规避方案：</strong></p>
<pre><code class="language-sql">-- 方案1：改为 IN 列表（正向匹配，能走索引）
EXPLAIN SELECT * FROM emp WHERE dept IN ('研发部', '产品部', '市场部', '人事部', '财务部');
-- type=range, key=idx_dept_status_salary ✅

-- 方案2：用 IS NULL / IS NOT NULL 替代部分 NOT IN 场景
-- 方案3：如果数据分布倾斜严重，考虑强制索引（慎用！）
EXPLAIN SELECT * FROM emp FORCE INDEX(idx_dept_status_salary) WHERE dept != '研发部';
</code></pre>

<blockquote>
<p><strong>注：</strong><code>FORCE INDEX</code> 是一把双刃剑。它能强制走索引，但如果优化器原本选择全表扫描是有道理的（比如返回 90% 的数据），强制索引反而会更慢。只在"你比优化器更了解数据分布"时才用。</p>
</blockquote>

<h2 id="场景七：IS-NULL-IS-NOT-NULL"><a href="#场景七：IS-NULL-IS-NOT-NULL" class="headerlink" title="场景七：IS NULL / IS NOT NULL"></a>场景七：IS NULL / IS NOT NULL</h2>

<p>这是一个<strong>版本相关且有争议</strong>的场景：</p>
<pre><code class="language-sql">-- MySQL 5.7 及以下：IS NULL / IS NOT NULL 通常不走索引
-- MySQL 8.0：优化器改进了对 IS NULL / IS NOT NULL 的处理
EXPLAIN SELECT * FROM emp WHERE name IS NULL;
EXPLAIN SELECT * FROM emp WHERE name IS NOT NULL;
</code></pre>

<p><strong>实际情况：</strong></p>
<ul>
<li>MySQL 8.0 中，<code>IS NULL</code> <strong>可以使用索引</strong>（ref 类型），因为 InnoDB 的索引不存储 NULL 值，所以 <code>IS NULL</code> 反而可以通过索引快速判定"这行不在索引里"</li>
<li><code>IS NOT NULL</code> 在 MySQL 8.0 中也能用索引做范围扫描</li>
<li>但在复合索引中，如果最左列是 <code>IS NULL</code> 查询，行为取决于具体版本和数据分布</li>
</ul>

<p><strong>最佳实践：</strong>不要在设计上依赖 <code>IS NULL</code> 走索引。如果某个字段经常需要 <code>IS NULL / IS NOT NULL</code> 查询，更好的做法是用显式的默认值替代 NULL：</p>
<pre><code class="language-sql">-- 不推荐
UPDATE emp SET phone = NULL WHERE id = 1;

-- 推荐：用空字符串代替 NULL
UPDATE emp SET phone = '' WHERE id = 1;
-- 这样就可以用 WHERE phone = '' 来查询，稳定走索引
</code></pre>

<h2 id="场景八：字符集不一致导致的隐式转换"><a href="#场景八：字符集不一致导致的隐式转换" class="headerlink" title="场景八：字符集不一致导致的隐式转换"></a>场景八：字符集不一致导致的隐式转换</h2>

<p>这个场景比"类型不一致"更隐蔽。假设你的表是 <code>utf8mb4</code>，但连接字符集是 <code>latin1</code>：</p>
<pre><code class="language-sql">-- 查看当前连接字符集
SHOW VARIABLES LIKE 'character_set_client';
SHOW VARIABLES LIKE 'character_set_connection';

-- 如果连接字符集 ≠ 表字符集，MySQL 可能需要做字符集转换
-- 这种转换可能导致索引失效（尤其在 JOIN 场景下）
</code></pre>

<p><strong>典型表现：</strong>两张表做 JOIN，关联字段都有索引，但 <code>EXPLAIN</code> 显示 <code>type=ALL</code>。检查后发现一张表是 <code>utf8</code>，另一张是 <code>utf8mb4</code>。</p>

<p><strong>✅ 解决方案：</strong></p>
<pre><code class="language-sql">-- 统一使用 utf8mb4
SET NAMES utf8mb4;
-- 或在 JDBC URL 中指定：?useUnicode=true&amp;characterEncoding=utf-8

-- 确保 DDL 一致
ALTER TABLE emp CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
</code></pre>

<h1 id="综合对比表：8-种场景一目了然"><a href="#综合对比表：8-种场景一目了然" class="headerlink" title="综合对比表：8 种场景一目了然"></a>综合对比表：8 种场景一目了然</h1>

<table>
<thead>
<tr>
<th>#</th>
<th>场景</th>
<th>失效原因</th>
<th>type 降级为</th>
<th>修复方案</th>
<th>难度</th>
</tr>
</thead>
<tbody>
<tr>
<td>1</td>
<td>索引列用函数/表达式</td>
<td>无法在索引树上做计算</td>
<td><code>ALL</code></td>
<td>改写条件 / Generated Column 函数索引</td>
<td>⭐⭐</td>
</tr>
<tr>
<td>2</td>
<td>隐式类型转换</td>
<td>等价于 CAST(列) 运算</td>
<td><code>ALL</code></td>
<td>保持类型一致（字符串加引号）</td>
<td>⭐</td>
</tr>
<tr>
<td>3</td>
<td><code>LIKE '%xxx'</code></td>
<td>B+Tree 无法定位左前缀</td>
<td><code>ALL</code></td>
<td>右模糊 / ES 全文索引</td>
<td>⭐⭐</td>
</tr>
<tr>
<td>4</td>
<td>违反最左匹配</td>
<td>跳过联合索引前导列</td>
<td><code>ALL</code></td>
<td>调整索引顺序 / 调整 SQL 条件顺序</td>
<td>⭐⭐⭐</td>
</tr>
<tr>
<td>5</td>
<td><code>OR</code> 部分列无索引</td>
<td>优化器放弃索引合并</td>
<td><code>ALL</code></td>
<td>补索引 / 改写 UNION</td>
<td>⭐⭐</td>
</tr>
<tr>
<td>6</td>
<td><code>NOT IN / !=</code></td>
<td>结果集太大，索引收益低</td>
<td><code>ALL</code></td>
<td>改 IN / FORCE INDEX（慎用）</td>
<td>⭐⭐</td>
</tr>
<tr>
<td>7</td>
<td><code>IS [NOT] NULL</code></td>
<td>版本相关，8.0 有改善</td>
<td>视版本而定</td>
<td>用默认值替代 NULL</td>
<td>⭐</td>
</tr>
<tr>
<td>8</td>
<td>字符集不一致</td>
<td>JOIN 时需转换</td>
<td><code>ALL</code></td>
<td>统一 utf8mb4</td>
<td>⭐⭐</td>
</tr>
</tbody>
</table>

<h1 id="实战排查流程：从慢查询到根因定位"><a href="#实战排查流程：从慢查询到根因定位" class="headerlink" title="实战排查流程：从慢查询到根因定位"></a>实战排查流程：从慢查询到根因定位</h1>

<p>给你一套线上排查的标准动作（SOP）：</p>

<h2 id="Step-1：开启慢查询日志"><a href="#Step-1：开启慢查询日志" class="headerlink" title="Step 1：开启慢查询日志"></a>Step 1：开启慢查询日志</h2>
<pre><code class="language-sql">-- 开启慢查询（记录超过 1 秒的 SQL）
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 1;
SET GLOBAL log_queries_not_using_indexes = 'ON';  -- 记录未使用索引的查询

-- 查看慢日志位置
SHOW VARIABLES LIKE 'slow_query_log_file';
</code></pre>

<h2 id="Step-2：用-EXPLAIN-分析执行计划"><a href="#Step-2：用-EXPLAIN-分析执行计划" class="headerlink" title="Step 2：用 EXPLAIN 分析执行计划"></a>Step 2：用 EXPLAIN 分析执行计划</h2>
<pre><code class="language-sql">EXPLAIN FORMAT=JSON SELECT * FROM emp WHERE SUBSTRING(phone, 1, 3) = '138';
</code></pre>

<p>用 <code>FORMAT=JSON</code> 输出能看到更详细的信息（包括优化器为什么要放弃索引的原因提示）。</p>

<h2 id="Step-3：用-SHOW-WARNINGS-看转换细节"><a href="#Step-3：用-SHOW-WARNINGS-看转换细节" class="headerlink" title="Step 3：用 SHOW WARNINGS 看转换细节"></a>Step 3：用 SHOW WARNINGS 看转换细节</h2>
<pre><code class="language-sql">EXPLAIN SELECT * FROM emp WHERE phone = 13812345678;
SHOW WARNINGS;
-- 输出中可能会看到类似 cast(emp.phone as signed) = 13812345678
-- 这就是隐式转换的铁证
</code></pre>

<h2 id="Step-4：用-ANALYZE-看真实执行代价"><a href="#Step-4：用-ANALYZE-看真实执行代价" class="headerlink" title="Step 4：用 ANALYZE 看真实执行代价"></a>Step 4：用 ANALYZE 看真实执行代价</h2>
<pre><code class="language-sql">-- MySQL 8.0+ 支持 ANALYZE（真正执行并统计）
ANALYZE SELECT * FROM emp WHERE phone = '13812345678';

-- 输出包含真实的扫描行数、发送行数、执行时间等
-- 比 EXPLAIN 更准确（EXPLAIN 只是估算）
</code></pre>

<h2 id="Step-5：Optimizer-Trace（终极武器）"><a href="#Step-5：Optimizer-Trace（终极武器）" class="headerlink" title="Step 5：Optimizer Trace（终极武器）"></a>Step 5：Optimizer Trace（终极武器）</h2>
<pre><code class="language-sql">-- 开启 Optimizer Trace
SET SESSION optimizer_trace = "enabled=on";

-- 执行你的 SQL
SELECT * FROM emp WHERE SUBSTRING(phone, 1, 3) = '138';

-- 查看 Trace 结果
SELECT TRACE FROM INFORMATION_SCHEMA.OPTIMIZER_TRACE\G

-- 关闭（生产环境不要一直开着）
SET SESSION optimizer_trace = "enabled=off";
</code></pre>

<p><strong>Optimizer Trace</strong>（优化器追踪）：MySQL 提供的一个内部诊断工具，能输出优化器在做决定时的完整思考过程——包括它考虑了哪些访问路径、每个路径的成本估算、最终为什么选择了某个计划。这是排查"优化器为什么不走索引"的最强工具。</p>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：“我加了索引，怎么还是慢？”"><a href="#坑-1："我加了索引，怎么还是慢？" class="headerlink" title="坑 1："我加了索引，怎么还是慢？""></a>坑 1："我加了索引，怎么还是慢？"</h2>
<ul>
<li><strong>可能原因：</strong>索引选择性太低（比如"性别"字段只有男/女两个值，索引几乎没用）</li>
<li><strong>验证：</strong><code>SELECT COUNT(DISTINCT col) / COUNT(*) FROM table;</code> — 越接近 1 选择性越好</li>
<li><strong>解决：</strong>不要给低选择性字段单独建索引，考虑组合索引或直接不加</li>
</ul>

<h2 id="坑-2：“EXPLAIN-显示走索引了，但还是慢”"><a href="#坑-2："EXPLAIN-显示走索引了，但还是慢" class="headerlink" title="坑 2："EXPLAIN 显示走索引了，但还是慢""></a>坑 2："EXPLAIN 显示走索引了，但还是慢"</h2>
<ul>
<li><strong>可能原因：</strong>回了太多表（二级索引找到主键后，再回聚簇索引取完整行数据）。如果需要回表 50% 以上的数据，优化器可能还不如直接全表扫描</li>
<li><strong>验证：</strong>看 <code>Extra</code> 列是否有 <code>Using index condition</code>（ICP 优化）或 <code>Using index</code>（覆盖索引）</li>
<li><strong>解决：</strong>把查询字段都包含进联合索引，做成<strong>覆盖索引</strong>（Covering Index），避免回表</li>
</ul>

<h2 id="坑-3：“索引是不是越多越好？”"><a href="#坑-3："索引是不是越多越好？" class="headerlink" title="坑 3："索引是不是越多越好？""></a>坑 3："索引是不是越多越好？"</h2>
<ul>
<li><strong>不是。</strong>每个额外索引都会增加写入成本（INSERT/UPDATE/DELETE 都要维护索引树）、占用磁盘空间、消耗内存</li>
<li><strong>经验法则：</strong>单表的索引数量建议不超过 6 个，联合索引的字段数不超过 5 个</li>
<li><strong>定期审查：</strong>用 <code>SELECT * FROM sys.schema_unused_index;</code>（MySQL 5.7+ sys schema）找出从未被使用的索引</li>
</ul>

<h2 id="坑-4：“EXPLAIN-rows-就是实际扫描行数吗？”"><a href="#坑-4："EXPLAIN-rows-就是实际扫描行数吗？" class="headerlink" title="坑 4："EXPLAIN rows 就是实际扫描行数吗？""></a>坑 4："EXPLAIN rows 就是实际扫描行数吗？"</h2>
<ul>
<li><strong>不是。</strong><code>rows</code> 是优化器的<strong>估算值</strong>，基于采样统计信息。实际行数可能偏差较大（尤其在没有 ANALYZE TABLE 的情况下）</li>
<li><strong>精确值：</strong>用 <code>ANALYZE</code>（MySQL 8.0+）或在 <code>Status</code> 里看 <code>Handler_read_next</code> 等计数器</li>
</ul>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文通过可复现的实验环境，逐一验证了 MySQL 索引失效的 8 大经典场景。核心要点：</p>
<ul>
<li><strong>索引失效的本质</strong>：优化器判断"走索引的成本 ≥ 全表扫描"，主动放弃索引</li>
<li><strong>最高频的三个坑</strong>：① 隐式类型转换（字符串 vs 数字）② 索引列上用函数 ③ 联合索引违反最左匹配</li>
<li><strong>排查利器</strong>：<code>EXPLAIN</code> → <code>SHOW WARNINGS</code> → <code>ANALYZE</code> → <code>OPTIMIZER_TRACE</code>，层层递进</li>
<li><strong>设计原则</strong>：索引不是越多越好，覆盖索引 &gt; 回表查询，选择性低的字段慎重建索引</li>
<li><strong>ORM 注意</strong>：MyBatis 参数类型要与数据库字段类型一致，否则隐式转换会让你防不胜防</li>
</ul>

<p>下次遇到慢查询，别急着加索引——先用 <code>EXPLAIN</code> 看看到底是没走索引，还是走了但回表太多。对症下药，才是正道。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>MySQL 8.0 官方文档 —— Optimization 分析</strong><br>
<a href="https://dev.mysql.com/doc/refman/8.0/en/optimization.html" target="_blank">https://dev.mysql.com/doc/refman/8.0/en/optimization.html</a><br>
MySQL 官方关于查询优化和索引使用的权威说明，涵盖 EXPLAIN 各字段含义和优化器行为。</li>

<li><strong>《高性能 MySQL（第 4 版）》第 5~8 章</strong> —— Baron Schwartz 等，O'Reilly<br>
索引基础原理、查询性能优化、Schema 数据类型优化的经典之作，几乎是后端工程师必读。</li>

<li><strong>MySQL 索引失效场景总结</strong> —— Hello-Brand 博客园<br>
<a href="https://www.cnblogs.com/wzh2010/p/18030898" target="_blank">https://www.cnblogs.com/wzh2010/p/18030898</a><br>
系统总结了各类索引失效场景，配有 EXPLAIN 截图对比，适合快速查阅。</li>

<li><strong>MySQL 优化流程：使用索引典型场景 AND 索引失效场景</strong> —— 知乎专栏<br>
<a href="https://zhuanlan.zhihu.com/p/495816974" target="_blank">https://zhuanlan.zhihu.com/p/495816974</br>
从 B+Tree 结构出发解释了为什么这些场景会导致索引失效，原理层面讲得比较清楚。</li>

<li><strong>MySQL 索引失效场景与优化策略深度解析</strong> —— 百度 Comate<br>
<a href="https://comate.baidu.com/zh/page/l3hrykldtwh" target="_blank">https://comate.baidu.com/zh/page/l3hrykldtwh</a><br>
涵盖了函数运算、类型转换、OR/NOT IN 等场景的详细分析和优化建议。</li>

<li><strong>MySQL 8.0 OPTIMIZER_TRACE 实践</strong> —— 美团技术团队<br>
<a href="https://tech.meituan.com/2021/05/13/mysql-optimizer-trace.html" target="_blank">https://tech.meituan.com/2021/05/13/mysql-optimizer-trace.html</a><br>
深入讲解如何用 Optimizer Trace 定位优化器决策过程，线上排障的高级技巧。</li>

<li><strong>MySQL EXPLAIN 详细解读</strong> —— 阿里云开发者社区<br>
<a href="https://developer.aliyun.com/article/769793" target="_blank">https://developer.aliyun.com/article/769793</a><br>
对 EXPLAIN 的 type/key/rows/Extra 等关键字段做了详细解读，含实例。</li>
</ol>
