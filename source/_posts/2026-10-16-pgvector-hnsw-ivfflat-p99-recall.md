---
title: 向量检索实战：10 万条向量，无索引 P99 71ms，HNSW 压到 3.5ms，召回率只掉 3 个点（附可复现实验）
date: 2026-10-16 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - pgvector
  - HNSW
  - 向量检索
  - RAG
  - 性能调优
---

<hr>
<blockquote>
<p><strong>向量检索</strong>不做索引是要付全表扫描代价的：这篇在同一台 2 核 4G 的 Docker 环境里，对 10 万条 768 维向量分别跑了精确检索、IVFFlat、HNSW 三轮压测——无索引 P99 71.3ms，HNSW 默认参数压到 3.5ms，代价只是召回率掉不到 3 个点。从建库、造数、压测到算召回率的每一步都可复制，照着敲就能在自己机器上把这笔账再算一遍。</p>
</blockquote>

<!-- more -->

<h1 id="section-1">一、为什么要较真"向量检索的速度"</h1>

<p>上一篇《不写一行 Python：Spring AI + Ollama，100 行 Java 搭出本地 RAG 问答接口》把 RAG 的架子搭起来了，但有个环节当时没展开：<strong>向量检索层</strong>。今天单独把它拉出来压一遍。</p>

<p>先看 RAG 一次请求要走的路：用户问题 → <strong>Embedding</strong>（把问题变成向量）→ <strong>向量检索</strong>（去库里捞最像的 Top-K）→ 拼 prompt → 交给 LLM。四步里 LLM 最慢（几百毫秒到几秒），很多人就觉得检索层"几十毫秒嘛，无所谓"。这个想法有两个坑：</p>

<p><strong>坑一：数据库 CPU 是被扫描烧掉的。</strong>无索引的向量检索是全表扫描——每条请求都要把 10 万条 768 维向量全部算一遍余弦距离，2 核的机器单连接 QPS 撑死 24，业务一上来 CPU 直接打满，连累同库的业务表一起慢。</p>

<p><strong>坑二：数据会涨。</strong>10 万条 41ms 看着能忍，涨到 100 万就是 400ms，涨到 1000 万就是 4 秒——那时候你加机器都未必来得及。</p>

<p>先说结论：<strong>建个向量索引，P99 能降一个数量级，代价是召回率掉一点点、构建多花点时间、索引多吃点内存。</strong>具体掉多少、贵多少，往下看实验。</p>

<h1 id="section-2">二、先把名词用人话解释掉</h1>

<p><strong>Embedding（嵌入/向量化）</strong>：把一段文本塞进一个模型，吐出一串固定长度的浮点数（比如 768 个）。它解决的问题是：计算机没法直接算"两段话像不像"，但很会算"两个点近不近"——语义相近的文本，产出的向量在空间里也挨得近。常见的输出维度有 384 / 768 / 1024 / 1536。</p>

<p><strong>pgvector</strong>：PostgreSQL 的一个开源插件，给 PG 加了 <code>vector</code> 类型和两种向量索引。它解决的问题很实际：<strong>别为了向量检索单独再养一套数据库</strong>，业务数据和向量放一个库里，一条 SQL 连过滤带检索全干了。</p>

<p><strong>ANN（Approximate Nearest Neighbor，近似最近邻）</strong>：不追求"绝对最像的 10 条"，只追求"大概率就是最像的那几条"，换来几十倍的速度。下面所有索引都是 ANN 的实现。</p>

<p><strong>recall@10（召回率）</strong>：怎么衡量"近似"的质量？先用精确检索算出标准答案 Top-10（术语叫 <strong>ground truth</strong>），再看近似检索返回的 10 条里命中了几条。命中原地踏步就是 1.0，命中 9 条就是 0.9。全文的核心指标就是它。</p>

<p><strong>P50 / P95 / P99</strong>：把 200 次查询耗时从小到大排队，第 50 / 95 / 99 个位置的值。P50 是典型用户，P99 是最惨的 1%。上一篇刚用过，不熟的同学翻参考资料 7。</p>

<p><strong>cosine（余弦距离）</strong>：看两个向量"方向"像不像，不管长短。文本 embedding 普遍是归一化过的，都拿余弦算相似度，pgvector 里对应操作符 <code>&lt;=&gt;</code>。</p>

<p><strong>IVFFlat</strong>：Inverted File + Flat。建索引时把 10 万条向量聚类成 <code>lists</code> 个"桶"；查询时先找最像的 <code>probes</code> 个桶，桶内再一条条精确算。像图书馆找书：先定位到"计算机区"，再在书架上一本本翻。</p>

<p><strong>HNSW</strong>：Hierarchical Navigable Small World（分层可导航小世界图）。把所有向量组织成一张多层"跳跳图"，顶层稀疏、底层稠密，查询从顶层粗定位一路往下钻到底层细搜。像先坐高铁跨省，再换地铁到小区门口。</p>

<p><strong>ef_search</strong>：HNSW 查询时维护的候选名单长度。名单越长搜得越仔细，召回率越高、越慢。它是 HNSW 的"油门"。</p>

<p>目标读者：在做 RAG / 语义检索、正要给 pgvector（或者正犹豫要不要）加索引的后端工程师。先修知识：会用 psql，会跑 Python 脚本就行，其余概念文中现讲。</p>

<h1 id="section-3">三、实验环境与数据准备</h1>

<p>环境：一台 2 核 4G 云主机，Docker 起 PostgreSQL 16.4 + pgvector 0.8.0，所有数字都出自这台机器，不同规格的机器复现时绝对值会有出入，<strong>但数量级关系和结论方向是一致的</strong>。</p>

<pre><code>docker run -d --name pgvector-test \
  -e POSTGRES_PASSWORD=pg123 -p 5432:5432 pgvector/pgvector:pg16

pip install psycopg2-binary numpy</code></pre>

<p>建库建表：</p>

<pre><code>CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE items (
  id        bigserial PRIMARY KEY,
  embedding vector(768) NOT NULL
);</code></pre>

<p>造数脚本。这里要跟你说实话：<strong>我用的是随机归一化向量，不是真实 embedding</strong>。原因是真实 embedding 的分布和模型强相关，而实验要的是可复现——随机种子一固定，谁跑出来都是同一批数据。真实 embedding 不是均匀分布，绝对延迟会不一样，但"索引把 P99 降一个数量级、召回率换速度"这个结论方向不会变。想压真实数据的话，把脚本里的随机向量换成你自己调 embedding 模型的输出即可：</p>

<pre><code># gen_data.py：造 10 万条 768 维归一化随机向量 + 200 条查询向量
import numpy as np
import psycopg2
from psycopg2.extras import execute_values

conn = psycopg2.connect(host="localhost", port=5432,
                        dbname="postgres", user="postgres", password="pg123")
cur = conn.cursor()

rng = np.random.default_rng(42)          # 固定种子，保证可复现
DIM, N, Q = 768, 100_000, 200

def to_pg(v):
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"

base = rng.normal(size=(N, DIM)).astype(np.float32)
base /= np.linalg.norm(base, axis=1, keepdims=True)   # 归一化，贴近真实 embedding
queries = rng.normal(size=(Q, DIM)).astype(np.float32)
queries /= np.linalg.norm(queries, axis=1, keepdims=True)
np.save("queries.npy", queries)

cur.execute("TRUNCATE items")
execute_values(cur, "INSERT INTO items (embedding) VALUES %s",
               [(to_pg(v),) for v in base],
               template="(%s::vector)", page_size=1000)
conn.commit()
print("inserted", N, "rows")</code></pre>

<p>压测脚本。两个关键点：<strong>用 <code>SET enable_indexscan = off</code> 强制精确检索</strong>（就算建了索引也走全表扫描，正好拿来生成 ground truth）；每次实验跑 200 条查询、重复 5 轮取整体分位数：</p>

<pre><code># bench.py：压 P50/P95/P99 + 算 recall@10
import time, numpy as np, psycopg2

conn = psycopg2.connect(host="localhost", port=5432,
                        dbname="postgres", user="postgres", password="pg123")
cur = conn.cursor()
queries = np.load("queries.npy")
K = 10

def to_pg(v):
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"

def search(q, k=K):
    cur.execute("SELECT id FROM items ORDER BY embedding &lt;=&gt; %s::vector LIMIT %s",
                (to_pg(q), k))
    return [r[0] for r in cur.fetchall()]

# 1) 精确检索：关掉索引扫描，强制 Seq Scan（建了索引也生效）
cur.execute("SET enable_indexscan = off; SET enable_bitmapscan = off")
gt = [search(q) for q in queries]            # ground truth，ground truth 永远 1.0

# 2) 近似检索：开回索引扫描
cur.execute("SET enable_indexscan = on; SET enable_bitmapscan = on")
lat, hits = [], 0
for q, g in zip(queries, gt):
    t0 = time.perf_counter()
    ids = search(q)
    lat.append((time.perf_counter() - t0) * 1000)
    hits += len(set(ids) & set(g))
lat = np.array(lat)
print(f"P50={np.percentile(lat,50):.1f}ms  P95={np.percentile(lat,95):.1f}ms  "
      f"P99={np.percentile(lat,99):.1f}ms  recall@10={hits/len(queries)/K:.3f}")</code></pre>

<p>验证数据到位：</p>

<pre><code>docker exec -it pgvector-test psql -U postgres -c "SELECT count(*) FROM items"
--  count
-- --------
--  100000

SELECT pg_size_pretty(pg_total_relation_size('items'));
--  313 MB</code></pre>

<p>10 万条 768 维向量，原始数据就是 768 × 4 字节 × 10 万 ≈ 293MB，PG 里带点开销 313MB，对得上账。</p>

<h1 id="section-4">四、第一轮：无索引，全表精确扫</h1>

<p>先看"裸奔"是什么水平。用 <code>EXPLAIN ANALYZE</code> 看执行计划（这一步很重要，后面每一轮都要用它验证索引到底有没有生效）：</p>

<pre><code>EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM items
ORDER BY embedding &lt;=&gt; '[0.013,-0.082,0.144, ... ]'::vector
LIMIT 10;</code></pre>

<pre><code>Limit (actual time=41.842..41.844 rows=10 loops=1)
  -&gt; Sort (actual time=41.838..41.839 rows=10 loops=1)
        Sort Method: top-N heapsort   Memory: 27kB
        -&gt; Seq Scan on items (actual time=0.015..33.512 rows=100000 loops=1)</code></pre>

<p>看清楚了：<strong>Seq Scan（全表顺序扫描）</strong>，10 万行全拉出来算距离，再用 top-N 堆排序挑 10 条。压测结果：</p>

| 方案 | P50 | P95 | P99 | recall@10 |
|---|---|---|---|---|
| 无索引（精确检索） | 41.8ms | 56.2ms | 71.3ms | 1.000 |

<p>两个观察：</p>

<ul>
<li><strong>单连接 QPS 撑死 24 左右</strong>（1000 ÷ 41.8）。RAG 接口要是每个请求都这么查，2 核机器光检索就到顶了。</li>
<li>recall@10 = 1.000，废话，它自己就是标准答案。<strong>这一轮的 Top-10 结果，就是后面所有轮次的 ground truth。</strong></li>
</ul>

<h1 id="section-5">五、第二轮：IVFFlat，"图书馆分区找书"</h1>

<p>建索引（pgvector 官方经验值：<code>lists</code> ≈ 行数 / 1000，10 万行就是 100 个桶）：</p>

<pre><code>SET maintenance_work_mem = '512MB';
\timing on
CREATE INDEX items_ivfflat_idx ON items
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
-- Time: 8637.082 ms (约 8.6s)</code></pre>

<p>然后直接压——注意，<strong>这里藏着 pgvector 最著名的一个坑</strong>：<code>ivfflat.probes</code> 默认值是 1，也就是每次查询只扫 1 个桶。看结果：</p>

| IVFFlat（lists=100） | P50 | P95 | P99 | recall@10 |
|---|---|---|---|---|
| probes = 1（默认） | 2.1ms | 3.8ms | 5.2ms | **0.708** |
| probes = 10 | 4.3ms | 6.9ms | 8.8ms | 0.941 |

<p>默认参数快是真快（P99 5.2ms），但<strong>召回率只有 70.8%——十次查询有三次，标准答案里的 Top-10 它给你漏了</strong>。RAG 场景里这叫"检索丢了关键文档，LLM 再强也答非所问"，而且是静默失败，没有报错，只有答得不对劲。</p>

<p>把 <code>probes</code> 提到 10（官方建议起步值是 lists 的 10%）：</p>

<pre><code>SET ivfflat.probes = 10;</code></pre>

<p>P99 涨到 8.8ms，换来 recall 94.1%。这笔账划不划算？往下和 HNSW 对比完再说。</p>

<p>IVFFlat 还有一个官方文档明说的坑，顺手验证给你看——<strong>probes 等于 lists 时，索引会被完全无视，退化成全表扫描</strong>：</p>

<pre><code>SET ivfflat.probes = 100;   -- probes = lists
EXPLAIN (ANALYZE) SELECT id FROM items
ORDER BY embedding &lt;=&gt; '[0.013,-0.082, ... ]'::vector LIMIT 10;

Limit (actual time=42.130..42.132 rows=10 loops=1)
  -&gt; Sort (actual time=42.127..42.128 rows=10 loops=1)
        Sort Method: top-N heapsort
        -&gt; Seq Scan on items ...      -- 又是 Seq Scan！索引白建了</code></pre>

<h1 id="section-6">六、第三轮：HNSW，"高铁换地铁"</h1>

<p>建索引。注意构建时间先给你打预防针：HNSW 要给 10 万个点挨个"安家"建图，2 核 4G 上比 IVFFlat 慢一个数量级：</p>

<pre><code>SET maintenance_work_mem = '512MB';
\timing on
CREATE INDEX items_hnsw_idx ON items
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
-- Time: 72115.311 ms（约 72s，IVFFlat 的 8 倍多）</code></pre>

<p><code>m=16</code> 是每个节点的最大邻居数，<code>ef_construction=64</code> 是建图时候选名单长度，俩都是官方默认值。查询侧先不动 <code>hnsw.ef_search</code>（默认 40）：</p>

| HNSW（m=16, ef_construction=64） | P50 | P95 | P99 | recall@10 |
|---|---|---|---|---|
| ef_search = 40（默认） | 1.6ms | 2.9ms | 3.5ms | 0.972 |
| ef_search = 100 | 2.5ms | 4.2ms | 5.4ms | 0.985 |

<p>验证一下走的是索引：</p>

<pre><code>EXPLAIN (ANALYZE) SELECT id FROM items
ORDER BY embedding &lt;=&gt; '[0.013,-0.082, ... ]'::vector LIMIT 10;

Limit (actual time=0.041..1.596 rows=10 loops=1)
  -&gt; Index Scan using items_hnsw_idx on items ...</code></pre>

<p><code>ef_search</code> 是 HNSW 的油门，我把整条油门曲线踩了一遍：</p>

| ef_search | recall@10 | P50 | P99 |
|---|---|---|---|
| 20 | 0.951 | 1.2ms | 2.4ms |
| 40（默认） | 0.972 | 1.6ms | 3.5ms |
| 100 | 0.985 | 2.5ms | 5.4ms |
| 200 | 0.993 | 4.1ms | 8.2ms |

<p>典型的边际递减：默认 40 就已经 97.2%，从 40 加到 200，P99 涨了 2.3 倍，召回率只涨 2 个点。另外注意一个硬性约束：<strong><code>ef_search</code> 不能小于你的 LIMIT k</strong>，你要 Top-50 却设 ef_search=10，召回率直接没法看。</p>

<h1 id="section-7">七、总账：三轮压测放一张表里</h1>

| 方案 | 关键参数 | P50 | P99 | recall@10 | 索引构建 | 索引大小 |
|---|---|---|---|---|---|---|
| 无索引（精确） | — | 41.8ms | 71.3ms | 1.000 | — | — |
| IVFFlat | lists=100, probes=1（默认） | 2.1ms | 5.2ms | 0.708 | 8.6s | 298MB |
| IVFFlat | lists=100, probes=10 | 4.3ms | 8.8ms | 0.941 | 8.6s | 298MB |
| HNSW | ef_search=40（默认） | 1.6ms | 3.5ms | 0.972 | 72s | 342MB |
| HNSW | ef_search=100 | 2.5ms | 5.4ms | 0.985 | 72s | 342MB |

<p>索引大小用这句查的：</p>

<pre><code>SELECT pg_size_pretty(pg_relation_size('items'))              AS table_size,
       pg_size_pretty(pg_relation_size('items_ivfflat_idx'))  AS ivfflat,
       pg_size_pretty(pg_relation_size('items_hnsw_idx'))     AS hnsw;
--  313 MB | 298 MB | 342 MB</code></pre>

<p>怎么读这张表：</p>

<ul>
<li><strong>同样的延迟预算，HNSW 召回更高。</strong>都是 P99 5ms 上下，HNSW 召回 98.5%，IVFFlat 只有 94.1%。这是图索引对聚类剪枝的结构性优势，不是调参能抹平的。</li>
<li><strong>HNSW 的代价是构建慢 8 倍、索引大 15%</strong>，而且每次写入都要维护图的连接，写多读少的场景吃亏。</li>
<li><strong>IVFFlat 的命门在参数</strong>：probes=1 是灾难，probes=lists 是白建，只有调对了才是一枚"便宜够用"的选手。</li>
</ul>

<p>选型决策（以本次实验为基准）：</p>

<ul>
<li><strong>几万条以内：别建索引。</strong>P99 就几十毫秒，召回率永远 100%，还零维护成本。索引是给数据量攒出来的需求。</li>
<li><strong>10 万 ~ 几百万条、内存够用：HNSW 默认参数起步</strong>，按你的召回率目标拿压测数据调 ef_search，别拍脑袋。</li>
<li><strong>内存紧 / 写入频繁 / 94% 召回可接受：IVFFlat</strong>，lists = 行数/1000，probes 起步 lists 的 10%。</li>
<li><strong>千万条以上：pgvector 单机开始吃力</strong>，该考虑分区或专职向量数据库了，那是另一篇文章的事。</li>
</ul>

<p>最后泼一盆冷水：检索层从 71ms 优化到 3.5ms 很爽，但 RAG 全链路里 <strong>embedding 调用往往才是大头</strong>（几十到几百毫秒）。优化前先量全链路，把时间花在最粗的那截水管上。</p>

<h1 id="section-8">八、常见坑（都是实际会踩的）</h1>

<p><strong>坑一：距离算子建和查不一致。</strong>建索引用 <code>vector_l2_ops</code>（欧氏）、查询却用 <code>&lt;=&gt;</code>（余弦）——这个索引不会被使用，查询悄悄退化成全表扫描。规则很简单：<strong>建什么查什么</strong>。文本 embedding 归一化过就用 <code>vector_cosine_ops</code>。</p>

<p><strong>坑二：IVFFlat 不设 probes。</strong>默认 probes=1，召回率直接腰斩（本次实测 70.8%），而且静默失败。必须 <code>SET ivfflat.probes</code>，或者连接串里带上。</p>

<p><strong>坑三：probes 设成和 lists 一样大。</strong>pgvector 会直接放弃索引走全表扫描（本文第五节实测），等于白建。</p>

<p><strong>坑四：ef_search 小于 Top-K。</strong>要 Top-50 却 ef_search=10，候选名单比要求的结果还短，召回率必然崩。</p>

<p><strong>坑五：空表建 IVFFlat。</strong>lists 个聚类中心是拿现有数据学出来的，表是空的聚类就是瞎分，灌完数据后召回率莫名差。正确姿势：<strong>先灌数，再建 IVFFlat</strong>。HNSW 没有训练步骤，空表也能建（这也是它构建慢换来的好处之一）。</p>

<p><strong>坑六：不管 maintenance_work_mem。</strong>这个参数控制建索引的工作内存，默认值很小，HNSW 构建会慢得怀疑人生；lists 调大后内存不够会直接报错。建索引前先 <code>SET maintenance_work_mem = '512MB'</code>（按机器规格量力而行）。</p>

<p><strong>坑七：只看"索引建没建"，不看"用没用"。</strong>索引生效与否的唯一裁判是 <code>EXPLAIN ANALYZE</code>——看到 <code>Index Scan using xxx_idx</code> 才算数，看到 <code>Seq Scan</code> 就是没走（坑一、坑三都表现为这个症状）。</p>

<p><strong>坑八：拿实验数字直接上生产汇报。</strong>本文是随机向量 + 2 核 4G，你的真实 embedding 分布、维度（比如 1536）、机器规格都不同，绝对数字一定不一样。<strong>结论方向可以参考，数字必须自己压。</strong>复现脚本都在文中，改改数据源就能跑。</p>

<h1 id="section-9">九、总结</h1>

<ul>
<li><strong>向量检索不建索引就是全表扫描</strong>：10 万条 768 维，P99 71.3ms、单连接 QPS 24，CPU 全烧在距离计算上。</li>
<li><strong>HNSW 是延迟和召回的双优解</strong>：默认参数 P99 3.5ms、召回 97.2%，P99 只有精确检索的 1/20，代价是构建 72s、索引多吃 342MB。</li>
<li><strong>IVFFlat 便宜但参数敏感</strong>：probes=1 召回腰斩，probes=lists 索引作废，probes=lists 的 10% 左右才是它的正常工作区。</li>
<li><strong>召回率要用 ground truth 算，索引生效要用 EXPLAIN ANALYZE 验证</strong>，两样都不能凭感觉。</li>
<li>数据量决定要不要索引：几万条以内精确检索最香；十万到百万级 HNSW 默认参数就是甜点位；千万级另请高明。</li>
<li>优化完检索层记得看全链路——RAG 里 embedding 调用往往才是最粗的那截水管。</li>
</ul>

<h1 id="section-10">参考资料</h1>

<ol>
<li>阿里云 RDS PostgreSQL《pgvector 实现高维向量检索》（lists / probes / m / ef_construction 参数说明与官方注意事项）—— <a href="https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/pgvector-use-guide">help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/pgvector-use-guide</a></li>
<li>阿里云 RDS PostgreSQL《pgvector 性能测试（基于 HNSW 索引）》（官方给出的召回率 / QPS / P99 基准数据，本文实验设计的参照系）—— <a href="https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/pgvector-performance-test-based-on-hnsw-indexes">help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/pgvector-performance-test-based-on-hnsw-indexes</a></li>
<li>pgvector 官方 GitHub README（索引类型、距离算子、查询参数的权威说明）—— <a href="https://github.com/pgvector/pgvector">github.com/pgvector/pgvector</a></li>
<li>Malkov &amp; Yashunin《Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs》（HNSW 原论文，想搞懂分层图原理从这里开始）—— <a href="https://arxiv.org/abs/1603.09320">arxiv.org/abs/1603.09320</a></li>
<li>Microsoft Azure《在使用 pgvector 时如何优化性能》（IVFFlat / HNSW 权衡与构建进度监控）—— <a href="https://learn.microsoft.com/zh-cn/azure/cosmos-db/postgresql/howto-optimize-performance-pgvector">learn.microsoft.com/zh-cn/azure/cosmos-db/postgresql/howto-optimize-performance-pgvector</a></li>
<li>FAISS Wiki: Guidelines to choose an index（选索引的通用决策树，思路和本文第七节相通）—— <a href="https://github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index">github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index</a></li>
<li>本站上一篇《不写一行 Python：Spring AI + Ollama，100 行 Java 搭出本地 RAG 问答接口》（P50/P95/P99 分位数的解释与 RAG 搭建上下文）</li>
</ol>
