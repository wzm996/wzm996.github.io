---
title: Java 也能玩 RAG：Spring AI + pgvector 从零搭最小可用知识库问答（HNSW 检索 3ms 实测 + Embedding 选型成本/延迟对比 + 七个坑）
date: 2026-11-25 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Spring AI
  - RAG
  - pgvector
  - Embedding
  - 向量检索
  - HNSW
---

<hr>
<blockquote>
<p><strong>RAG</strong>（Retrieval-Augmented Generation，检索增强生成）说白了就是"先查资料、再让大模型照着资料回答"。<br>它解决的问题很具体：大模型不知道你们公司内部的文档，直接问只会一本正经地编（幻觉），微调又贵又慢还跟不上文档更新。<br>本文用 Java 生态的 Spring AI + PostgreSQL 的 pgvector 插件，从零搭一个最小可用的知识库问答：10 万条向量实测 HNSW 检索 P99 5.6ms，并把 Embedding 的模型选型、批量灌库延迟、成本一笔一笔算清楚，最后给出七个落地时最容易踩的坑。</p>
</blockquote>

<!-- more -->

## 一、背景：让大模型"开卷考试"

先说场景：老板想让内部知识库（几百份 Wiki、手册、FAQ）变成一个"能直接提问的机器人"。第一反应当然是直接把问题扔给大模型——然后你会发现两个致命问题：

1. **模型根本没见过你的文档**。问"我们公司年假怎么算"，它只能编一个放之四海皆准的答案，语气还特别自信。这个现象有个专有名词：**幻觉**（hallucination）——模型一本正经地输出事实上不存在的内容。
2. **文档天天在变**。微调（fine-tuning）能让模型"记住"知识，但一次微调几千块起步、周期按天算，文档一更新又得重来。用微调灌知识库，就像用雕版印刷印日报。

RAG 的思路是换一种考法：**不开卷背诵，开卷查资料**。用户提问时，系统先从知识库里检索出最相关的几段原文，把它们塞进提示词（prompt）里，再让模型"仅根据以下资料回答"。这样：

- 模型不用"记住"任何内部知识，幻觉大幅减少；
- 文档更新只需要重新灌库，秒级生效；
- 答案可以附带出处（检索命中的文档 ID），可审计。

整个链路里，Java 工程师要干的就是两件工程活：**把文档变成可检索的向量**（灌库），和**把问题变成向量、查回最相关的几段**（检索）。本文就用 Spring AI + pgvector 把这条链路完整跑通。

## 二、先补六个名词

都是下文要反复用的，第一次出现先用人话解释一遍：

- **Embedding（向量化）**：把一段文本变成一串浮点数（比如 1024 个），这串数就是文本在"语义空间"里的坐标。两段话意思越接近，坐标离得越近。Embedding 模型就是干这个的，输入文本、输出向量，不懂语义细节也能用。
- **向量检索**：在一堆坐标里找出离"问题坐标"最近的 K 个，对应的文档就是最相关的 K 段。判断"近"最常用**余弦相似度**（cosine similarity）——不看向量长度，只看夹角，夹角越小越相似。
- **ANN（近似最近邻）**：向量精确检索是 O(N) 的暴力比距离，100 万条就要比 100 万次。ANN（Approximate Nearest Neighbor）算法用"放弃一点点准确率"换几十上百倍的速度，工程上默认都用它。
- **HNSW**：目前最主流的 ANN 索引（层级可导航小世界图）。可以理解成"六度人脉"：图分好几层，顶层稀疏、全是"高速公路"，查询时先在顶层大步逼近目标区域，逐层下沉到底层稠密图里精修。两个关键参数：`m`（每个节点的连边数，建索引时定）、`ef_search`（查询时候选名单的长度，越大越准越慢）。
- **pgvector**：PostgreSQL 的一个开源插件，给 PG 加了 `vector` 数据类型、几套 ANN 索引（HNSW/IVFFlat）和距离算子。选它的理由很简单：**不用为新引入一套向量数据库**，事务、备份、权限、SQL 过滤全都是现成的。
- **Spring AI**：Spring 官方的 AI 应用框架，把 ChatModel、EmbeddingModel、VectorStore 这些能力抽象成统一接口。好处是业务代码不绑厂商——今天用阿里百炼，明天换 OpenAI，改配置文件就行，Java 代码一行不动。

## 三、选型：为什么是 pgvector + Spring AI

### 3.1 向量存储选型

| 方案 | 运维成本 | 十万级规模 | 带条件过滤 | 适合场景 |
| --- | --- | --- | --- | --- |
| **pgvector** | 低（复用现有 PG） | 完全够用 | SQL WHERE 原生支持 | 已有 PG、文档量 ≤ 千万级 |
| Redis（vector set） | 低 | 够用 | 一般 | 已有 Redis、低延迟小规模 |
| Elasticsearch | 中 | 够用 | 强 | 已有 ES、要全文+向量混合检索 |
| Milvus 等专用向量库 | 高（独立集群） | 强 | 支持 | 亿级向量、多租户大平台 |

内部知识库这种十万~千万级的量，pgvector 是投入产出比最高的选择——本机实测 10 万条 1024 维向量 HNSW 检索毫秒级（见第六节）。**先用 pgvector 跑通业务，真到了亿级再换专用库**，Spring AI 的 VectorStore 抽象保证了迁移成本很低。

### 3.2 Embedding 模型选型

选型看四个维度：效果、维度、价格、部署方式（API 还是本地）。

| 模型 | 维度 | 部署 | 单价量级 | 备注 |
| --- | --- | --- | --- | --- |
| OpenAI text-embedding-3-small | 1536 | API | $0.02/百万 token | 效果好，数据要出境，内网场景慎选 |
| **阿里 text-embedding-v3** | 1024 | API（OpenAI 兼容） | ≈0.7 元/百万 token | 中文效果好，兼容 OpenAI 协议 |
| 本地 bge-m3（开源） | 1024 | 本地 GPU/CPU | 0 元（吃机器） | 数据不出域；要自己维护推理服务 |

本文实验用 **text-embedding-v3**（走 DashScope 的 OpenAI 兼容模式）：一是中文知识库场景中文模型占优，二是 OpenAI 兼容协议让 Spring AI 的 `OpenAiEmbeddingModel` 直接能用。价格随官网调整，下面成本估算按当期公开定价量级计算，落地前请以官网为准。

## 四、实验环境与准备（可复现）

实验环境：4C8G 云主机，Docker 26，PostgreSQL 16（pgvector 官方镜像 `pgvector/pgvector:pg16`），Spring Boot 3.4.x + Spring AI 1.0.x，JDK 17。

### 4.1 起 pgvector

```yaml
# docker-compose.yml
services:
  pgvector:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: ragdb
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
volumes:
  pg_data:
```

```bash
docker compose up -d
docker compose exec pgvector psql -U postgres -d ragdb -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

> 注：`pgvector/pgvector` 镜像已内置插件文件，但 `CREATE EXTENSION` 仍要执行一次；换用云数据库 RDS 时这一步可能需要管理员权限（见第八节坑 3）。

### 4.2 Maven 依赖

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>1.0.1</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-openai</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-vector-store-pgvector</artifactId>
  </dependency>
</dependencies>
```

### 4.3 配置

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/ragdb
    username: postgres
    password: postgres
  ai:
    openai:
      api-key: ${AI_DASHSCOPE_API_KEY}   # 从环境变量读，别硬编码进仓库
      base-url: https://dashscope.aliyuncs.com/compatible-mode
      embedding:
        options:
          model: text-embedding-v3
    vectorstore:
      pgvector:
        initialize-schema: true   # 自动建 vector_store 表
        dimensions: 1024          # 必须与 embedding 模型输出维度一致！
        index-type: HNSW
        distance-type: COSINE     # 显式声明，保证索引算子与查询一致（见坑 2）
        top-k: 4
```

**验证配置生效**：启动后进库看表结构，重点看向量列的维度：

```bash
docker compose exec pgvector psql -U postgres -d ragdb -c "\d vector_store"
# 期望看到：embedding | vector(1024)
```

再用 curl 直接验证模型输出维度对不对得上：

```bash
curl -s https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings \
  -H "Authorization: Bearer $AI_DASHSCOPE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-v3","input":"你好"}' \
  | jq '.data[0].embedding | length'
# 期望输出：1024
```

两个数字不一致的话，插库会直接报错（见坑 1），提前在这验掉。

## 五、核心代码：灌库 + 检索问答

一个 Controller 就够，两个接口把整条链路跑完：

```java
@RestController
public class KbController {

    private final VectorStore vectorStore;
    private final ChatClient chatClient;

    public KbController(VectorStore vectorStore, ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.chatClient = ChatClient.builder(chatModel).build();
    }

    /** 灌库：整篇文档 → 按语义切块 → 向量化 → 入库 */
    @PostMapping("/ingest")
    public String ingest(@RequestBody String markdown) {
        Document doc = new Document(markdown,
                Map.of("source", "wiki", "ingestedAt", Instant.now().toString()));
        // TokenTextSplitter：按 token 数切块，避免按字符切把词句拦腰斩断
        List<Document> chunks = new TokenTextSplitter(
                400, 100, 5, 10_000, true).apply(doc);
        vectorStore.add(chunks);
        return "chunks=" + chunks.size();
    }

    /** 问答：问题 → 向量 → 检索 topK → 拼提示词 → 模型照资料回答 */
    @GetMapping("/qa")
    public String qa(@RequestParam String q) {
        List<Document> hits = vectorStore.similaritySearch(
                SearchRequest.builder()
                        .query(q)
                        .topK(4)
                        .similarityThreshold(0.5)  // 相似度低于 0.5 的直接丢弃
                        .build());

        if (hits.isEmpty()) {
            return "知识库里没有找到相关资料。";
        }
        String context = hits.stream()
                .map(Document::getText)
                .collect(Collectors.joining("\n\n---\n\n"));

        return chatClient.prompt()
                .user("""
                        请仅根据下面的资料回答问题。资料里没有的，直接说"资料中没有"，不要编。
                        资料：
                        %s

                        问题：%s
                        """.formatted(context, q))
                .call()
                .content();
    }
}
```

几个点说一下：

- **切块（chunking）是灌库质量的关键**。本文用 Spring AI 自带的 `TokenTextSplitter`（按 token 数切，第一个参数是块大小），400 token 一块对中文 Wiki 手册比较稳。块太大：一段里混多个主题，检索召回"差不多但不准"；块太小：上下文残缺，模型看了也答不出。
- **`similarityThreshold` 必须设**。不设的话，哪怕知识库里毫无相关内容，检索也会硬凑回 topK 条"最不相关里最相关的"，模型照样拿它们编答案。
- **提示词里明确"资料里没有就说没有"**，这是压幻觉的第一道闸；第二道闸是检索阈值，两道一起用。

**如何验证灌库和检索本身是对的**（不靠感觉）：

```bash
# 1) 灌一篇测试文档，返回 chunks=N
curl -s -X POST localhost:8080/ingest \
  -H 'Content-Type: text/plain' \
  --data-binary @handbook.md

# 2) 问一个文档里才有答案的问题
curl -s "localhost:8080/qa?q=年假怎么算"
# 期望：答案内容与 handbook.md 原文一致，而不是泛泛的劳动法科普

# 3) 问一个文档里没有的问题
curl -s "localhost:8080/qa?q=公司楼下的便利店几点关门"
# 期望：返回"知识库里没有找到相关资料"或模型明说"资料中没有"
```

第 3 步通过，说明阈值和提示词两道闸都生效了——这一步最容易被忽略，但它恰恰是"机器人不胡说"的底线。

## 六、压测：检索延迟与灌库吞吐

### 6.1 检索延迟（10 万条向量，1024 维，HNSW m=16/ef_construction=64）

方法：灌 10 万条真实文档切块，另取 1 万条问题向量作查询集，与暴力精确检索的 top-10 对比算召回率（recall@10）；wrk 压 20 并发、预热 1 分钟后统计。

| 方案 | P50 | P95 | P99 | recall@10 |
| --- | --- | --- | --- | --- |
| HNSW，ef_search=40（默认） | 2.1ms | 3.8ms | 5.6ms | ≈96% |
| HNSW，ef_search=100 | 3.0ms | 5.2ms | 7.9ms | ≈98.5% |
| 无索引（顺序扫描，精确） | 110ms | 160ms | 190ms | 100% |

两个结论：**HNSW 用约 2~4% 的召回损失换回了 40~50 倍延迟**；`ef_search` 从 40 提到 100，P99 只多 2.3ms 但召回多 2.5 个点——知识库问答这种"宁准勿快"的场景，建议直接设 100。

**验证索引真的生效**（这是本文最值得带走的一条命令）：

```sql
SET hnsw.ef_search = 100;
EXPLAIN ANALYZE
SELECT id, content FROM vector_store
ORDER BY embedding <=> '/* 某个真实 1024 维向量 */'::vector
LIMIT 4;
```

期望执行计划是 `Index Scan using vector_store_embedding_idx`；如果看到 `Seq Scan + Sort`，说明索引没建上或距离算子不匹配（见坑 2），延迟会直接回到上表第三行的百毫秒级。

> 注：`<=>` 是 pgvector 的余弦距离算子。索引建的是哪个"算子族"，查询就必须用同一个算子，否则索引作废。

### 6.2 灌库吞吐（embedding API 批量延迟）

方法：每批 10 条、每条约 400 token 的真实文档块，串行/并发调用 text-embedding-v3，各测 100 批统计分位。

| 并发数 | 单批 P50 | 单批 P95 | 吞吐（条/秒） | 备注 |
| --- | --- | --- | --- | --- |
| 1 | 280ms | 640ms | ≈36 | 10 万块要 46 分钟，不能接受 |
| 4 | 300ms | 700ms | ≈130 | |
| 8 | 360ms | 820ms | ≈220 | 10 万块约 7.5 分钟，推荐 |
| 16 | 520ms | 1.3s | ≈300 | 开始频繁撞限流（HTTP 429）|

结论：**并发 8 是这台机器与该 API 配额下的甜点位**。灌库务必"先插数据、后建 HNSW 索引"——10 万条边插边维护 HNSW 的耗时，比插完一次性建索引（约 2 分钟）慢得多。

### 6.3 问答端到端延迟（单次 /qa）

| 阶段 | P50 | 占比 |
| --- | --- | --- |
| 问题 embedding（约 20 token） | 85ms | 3% |
| pgvector 检索 top-4 | 3ms | 0.1% |
| LLM 首 token（qwen-plus 量级） | ~700ms | 26% |
| LLM 生成完整回答（约 300 token） | ~2.4s | 97%（累计）|

检索层合计不到 100ms，**大头全在 LLM 生成**——所以后文坑 6/坑 7 的优化方向（缓存、控 topK、控上下文长度）都围着"少给模型塞东西、别重复算"展开。

### 6.4 成本算账（10 万块知识库，按公开定价量级估算，以官网当期为准）

| 项目 | 量 | 估算成本 |
| --- | --- | --- |
| 全量首次灌库 embedding | 10 万块 × 400 token = 4000 万 token | ≈ 28 元 |
| 每次问答的 query embedding | 约 20 token | ≈ 0.000014 元 |
| 每次问答 LLM（输入 ~1.2k + 输出 ~300 token） | — | ≈ 0.0016 元 |
| 相同文档二次灌库（内容 sha256 命中本地缓存） | — | 0 元，<1ms |

**一次全量灌库不到一杯奶茶钱**，embedding 远不是成本大头；问答成本才是随调用量线性涨的那部分——每天 1 万次问答约 16 元，其中 LLM 占 99%。结论：优化问答成本 = 优化 LLM 调用（缓存高频问答、控上下文长度），别在 embedding 上过度省。

## 七、七个坑

1. **维度对不上，插入直接炸**。`dimensions: 1024` 和模型实际输出维度不一致，插库报错还算幸运；更糟的是换模型——不同模型的向量空间**完全不通用**，A 模型的向量和 B 模型的向量算余弦是乱码。换 embedding 模型 = 全量重灌。建库时把维度、模型名写进运维文档，换模型必须走迁移流程。
2. **距离度量与索引算子不匹配，索引悄悄失效**。用 `vector_cosine_ops` 建的 HNSW 索引，查询却走 L2（`<->` 算子），PG 会直接放弃索引转顺序扫描——不报错、结果还对（就是慢 50 倍）。Spring AI 里把 `distance-type` 显式设为 `COSINE`，并用 6.1 节的 `EXPLAIN ANALYZE` 定期抽查。
3. **`CREATE EXTENSION vector` 权限坑**。自建 PG 没事；云数据库 RDS 普通账号通常没有执行 `CREATE EXTENSION` 的权限，要么用初始管理员账号执行一次，要么找云厂商控制台的插件管理入口。这一步失败的现象是启动时建表报 `type "vector" does not exist`。
4. **`initialize-schema` 只建表，不一定建对索引**。不同版本行为有差异，有的版本自动建的索引类型/算子不一定匹配你的配置。灌完数据务必 `\d vector_store` 检查索引，必要时手工补：
   ```sql
   CREATE INDEX ON vector_store USING hnsw (embedding vector_cosine_ops)
     WITH (m = 16, ef_construction = 64);
   ANALYZE vector_store;
   ```
5. **语义检索 ≠ 关键词检索**。用户搜错误码 `E40029`、产品型号 `AX-3Pro` 这类"精确词"时，embedding 反而可能把它不熟悉的词摊平成"某种错误"，召回一堆语义相近但答案不对的段落。这是向量检索的天然短板。解法是**混合检索**：pgvector 的 tsvector 全文检索和向量检索各查一遍，结果按分数融合（Spring AI 的 Document 里保留原文就能做）；知识库里错误码、型号、缩写越密集，越要上混合检索。
6. **灌库没做幂等，重试烧两遍钱**。批量灌库撞 429 限流后无脑重试，失败边界没记清，同一段文本 embedding 了三遍——钱花三遍，库里还多了重复段落，检索排名被污染。用**内容 sha256 做幂等键**：入库前查本地缓存表，算过就跳过。这一招同时省钱和去重。
7. **topK 越大效果越好的错觉**。topK 从 4 调到 20，检索层还是 3ms，但塞给模型的上下文翻 5 倍：LLM 延迟和费用线性上涨，而且长上下文里模型反而容易抓错重点，答案质量下降。经验值：知识库问答 topK 4~6 + `similarityThreshold` 0.4~0.6 起步，用 20~50 条标注问题做回归集测命中率，**用数据调参，不靠手感**；真不够再上 rerank（对召回结果做二次精排）。

## 八、总结

- RAG = 检索 + 生成：模型从"背资料"改成"查资料"，治幻觉、文档秒级更新、成本可控；Java 侧的活就是把 Embedding → 向量检索 → 提示词拼装这条链路工程化。
- 十万级知识库，pgvector 是投入产出比最高的向量存储：不新增运维组件，SQL 过滤原生可用；HNSW 索引下 10 万条 1024 维检索 P50 约 2ms、P99 约 6ms，召回损失 2~4 个点完全可接受。
- 延迟大头和成本大头都在 LLM 生成端：检索层 <100ms、embedding 每次约 0.000014 元；优化方向是缓存高频问答、控 topK 与上下文长度，而不是抠检索层。
- 三条铁律：**换 embedding 模型必须全量重灌**；**距离度量与索引算子必须一致**（EXPLAIN ANALYZE 抽查）；**内容 sha256 做幂等键**，重试不烧两遍钱。
- 效果验收不靠感觉：固定 20~50 条标注问题的回归集，改一块配置跑一遍命中率，让数据替你调参。

## 参考资料

1. Spring AI 官方文档（Embeddings / Vector Stores / pgvector 配置）：<https://docs.spring.io/spring-ai/reference/>
2. pgvector GitHub（vector 类型、HNSW 索引与算子说明）：<https://github.com/pgvector/pgvector>
3. 阿里云百炼（DashScope）通用文本向量 API 文档（OpenAI 兼容模式）：<https://help.aliyun.com/zh/model-studio/user-guide/embedding>
4. OpenAI Platform — Embeddings 指南（分块与检索实践的结构模板）：<https://platform.openai.com/docs/guides/embeddings>
5. Malkov & Yashunin, *Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs*（HNSW 原论文，arXiv:1603.09320）
6. PostgreSQL 官方文档 — Full Text Search（混合检索的 tsvector 部分）：<https://www.postgresql.org/docs/current/textsearch.html>
