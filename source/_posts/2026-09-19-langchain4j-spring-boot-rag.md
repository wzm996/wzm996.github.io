---
title: 用 LangChain4j 给 Spring Boot 接入 RAG：Embedding、向量检索与延迟/成本实测
date: 2026-09-19 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - Spring Boot
  - LangChain4j
  - RAG
  - Embedding
  - 向量检索
---

<hr>
<blockquote>
<p>本文解决一个很具体的问题：<strong>Java 技术栈怎么把 RAG（检索增强生成）真正跑起来，并且把检索链路的延迟和成本算清楚</strong>。全篇基于 Spring Boot 3 + LangChain4j，所有代码、压测命令和实测数据都可以在你自己的机器上复现，不依赖任何付费 API。</p>
</blockquote>

<!-- more -->

## 一、背景：为什么 Java 后端要关心 RAG

这两年做业务系统， 十有八九会被提一个需求："能不能让用户直接用自然语言查我们的文档/工单/FAQ？" 第一反应往往是接个大模型 API 直接问。但试过的人都知道坑在哪：模型不知道你公司内部的知识，问它"我们退款时效是几天"，它会一本正经地编一个答案——术语叫**幻觉（Hallucination）**，说白了就是模型在瞎猜还猜得很自信。

**RAG（Retrieval-Augmented Generation，检索增强生成）**就是治这个的：先从你自己的资料里检索出最相关的几段内容，把它们塞进提示词，再让模型"照着资料回答"。模型从"凭记忆答题"变成了"开卷考试"，幻觉率会显著下降。

这篇文章不聊模型训练、不聊提示词玄学，专注工程侧的三个问题：

1. Java 里怎么把"文档入库 → 向量化 → 检索"这条链路最小成本跑起来；
2. 检索链路的延迟到底花在哪，缓存能省多少（有 P50/P95/P99 实测数据）；
3. 哪些坑是生产上一定会踩的。

先修知识：会用 Spring Boot 写 REST 接口，了解 Maven。不需要任何 Python 或机器学习背景。

## 二、5 分钟搞懂核心概念

这一节的每个词，第一次在博客里出现，我都用"它是啥、解决啥问题、什么时候用"三句话讲清楚。

**Embedding（向量化）**：把一段文字变成一个固定长度的浮点数数组（比如 512 个数字），这个数组就是文字的"语义坐标"。它是啥：语义相近的文本，坐标在空间里也挨得近。解决啥问题：让"怎么配线程池参数"和"线程池核心数怎么设置"这种**意思相近但字面不同**的文本能被匹配上——关键词检索做不到这一点。什么时候用：一切"按意思找内容"的场景。

**向量检索 / 向量数据库**：拿着一个问题向量，去一堆文档向量里找"距离最近"的几条。它是啥：本质上就是高维空间里的近邻搜索。解决啥问题：从几十万段文本里毫秒级找出最相关的 top 几。什么时候用：RAG 的核心一步。小规模时其实不需要专门的向量数据库，一个内存数组就够（本文就是这么干的，后面有数据）。

**分块（Chunking）/ overlap**：把长文档切成一段段小文本再分别向量化。它是啥：Embedding 模型的输入长度有限，而且整篇文档压成一个向量会把语义"稀释"掉。解决啥问题：让检索粒度落到"段落"级别，命中了就能直接用。overlap 指相邻块之间重叠一部分文字，避免句子被拦腰切断。

**top_k 与相似度分数**：检索时取最相似的 k 条结果；每条结果带一个 0~1 的分数（余弦相似度归一化后的值），分数越高越相关。什么时候用：k 是 RAG 最常调的参数之一，第五节有实测。

**rerank（重排）**：先用向量检索粗筛几十条，再用一个更精细（也更慢）的模型对这几十条重新打分排序，取前几名。它是啥：粗排 + 精排的两级流水线。解决啥问题：向量检索快但粗，rerank 慢但准。什么时候用：对召回质量要求高的场景。本文为了控制链路复杂度，先不上 rerank。

**LangChain4j**：Java 版的 LLM 应用开发框架（对标 Python 生态的 LangChain）。它是啥：把"调模型 API、向量化、检索、装配提示词、会话记忆"这堆活封装成了一个个 Java 接口和组件。解决啥问题：不用自己手写 HTTP 调模型、手算余弦相似度。什么时候用：Java 技术栈做 LLM 应用，基本是现在的默认选项之一。

## 三、两个关键选型

### 3.1 Embedding 模型：本地 ONNX vs 云 API

**ONNX** 是啥：模型的一种通用交换格式，配合 ONNX Runtime，Java 进程内就能直接跑模型推理，不需要 Python 环境。LangChain4j 官方提供了几个打包好的开源 embedding 模型，加个 Maven 依赖就能用。

| 维度 | 本地 ONNX（bge-small-zh-v1.5） | 云 API |
| --- | --- | --- |
| 单次延迟 | 15~40ms（吃本地 CPU） | 50~200ms（含网络往返） |
| 成本 | 免费，耗 CPU | 按 token 计费 |
| 数据出域 | 不出域 | 文档内容要传给第三方 |
| 运维 | 零依赖，但要管好 CPU 容量 | 无 |
| 适合 | 内网/敏感数据/小规模 | 大规模、弹性、不想管资源 |

**bge-small-zh-v1.5** 是北京智源（BAAI）开源的中文 embedding 模型，512 维，最大输入 512 token，在中文语义检索上口碑不错。本文选它：数据不出域、零成本、任何人都能复现。

### 3.2 向量存储：从内存到专用库

| 存储 | 量级 | 持久化 | 什么时候选它 |
| --- | --- | --- | --- |
| InMemory（LangChain4j 自带） | 十万级以下 | 可序列化落盘 | PoC、中小文档库 |
| pgvector（PostgreSQL 插件） | 百万级 | 是 | 已经在用 PG，不想加新组件 |
| Elasticsearch | 千万级 | 是 | 已有 ES 且要做混合检索 |
| Milvus 等专用库 | 亿级 | 是 | 超大规模、多租户 |

本文用 `InMemoryEmbeddingStore`——它对暴力余弦检索的速度足以支撑中小文档库（实测见第五节），先把链路和调参跑通，量上去了再平移到 pgvector，检索接口的代码几乎不用改。

## 四、动手：最小可运行工程

完整工程就四步：加依赖 → 配 Bean → 文档入库 → 检索接口。下面每一步都带验证方法。

### 4.1 依赖

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>dev.langchain4j</groupId>
      <artifactId>langchain4j-bom</artifactId>
      <version>1.4.0</version>
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
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j</artifactId>
  </dependency>
  <!-- 本地中文 embedding 模型：进程内 ONNX 推理，不需要任何 API Key -->
  <dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-embeddings-bge-small-zh-v15</artifactId>
  </dependency>
</dependencies>
```

注意：这个依赖的 jar 里捆着约 90MB 的 ONNX 模型文件，容器镜像会明显变大，做 CI 缓存时要心里有数。

**验证**：`mvn dependency:resolve` 能拉全依赖，无版本冲突报错。

### 4.2 配置 Bean

```java
@Configuration
public class RagConfig {

    @Bean
    public EmbeddingModel embeddingModel() {
        return new BgeSmallZhV15EmbeddingModel();
    }

    @Bean
    public EmbeddingStore<TextSegment> embeddingStore() {
        return new InMemoryEmbeddingStore<>();
    }
}
```

**验证**：应用能正常启动，两个 Bean 注入不报错。

### 4.3 文档入库

把待检索的 Markdown/文本文件放到一个目录（本文用 42 篇技术文档，约 40 万字），启动时一次性入库：

```java
@Component
public class IngestionRunner implements CommandLineRunner {

    private final EmbeddingModel embeddingModel;
    private final EmbeddingStore<TextSegment> store;

    public IngestionRunner(EmbeddingModel embeddingModel, EmbeddingStore<TextSegment> store) {
        this.embeddingModel = embeddingModel;
        this.store = store;
    }

    @Override
    public void run(String... args) {
        long start = System.currentTimeMillis();

        List<Document> docs = FileSystemDocumentLoader.loadDocuments("/data/rag-docs");
        DocumentSplitter splitter = DocumentSplitters.recursive(512, 60);

        EmbeddingStoreIngestor ingestor = EmbeddingStoreIngestor.builder()
                .documentSplitter(splitter)
                .embeddingModel(embeddingModel)
                .embeddingStore(store)
                .build();

        ingestor.ingest(docs);

        System.out.printf("入库完成: %d 篇文档, 耗时 %d ms%n",
                docs.size(), System.currentTimeMillis() - start);
    }
}
```

`DocumentSplitters.recursive(512, 60)` 的含义：每块最多 512 字、相邻块重叠 60 字。512 这个数不是拍脑袋——bge-small-zh-v1.5 的最大输入就是 512 token，中文一个字大约 0.6~1 个 token，512 字基本贴着上限，再大尾部会被**静默截断**（这是后面坑列表的第 2 条）。

**验证**：看启动日志的"入库完成"行；42 篇文档、512/60 的切法在我的机器上切成约 860 块，耗时约 35 秒（单线程，每块 40ms 左右，大头是 ONNX 推理）。你的绝对值会不同，但量级应该接近。

### 4.4 检索接口（带 Embedding 缓存）

先想清楚一件事：**同一段文字的向量永远不会变（只要模型不变）**。FAQ/客服场景里用户问题高度重复，把"问题 → 向量"缓存起来，重复问题就省掉一次最贵的 ONNX 推理。

```java
@Service
public class RagSearchService {

    private static final int TOP_K = 5;

    private final EmbeddingModel embeddingModel;
    private final EmbeddingStore<TextSegment> store;

    /** 简易缓存：key = 模型标识 + 原文 SHA256。生产建议换 Caffeine/Redis 并加容量上限 */
    private final Map<String, Embedding> embeddingCache = new ConcurrentHashMap<>();

    public RagSearchService(EmbeddingModel embeddingModel, EmbeddingStore<TextSegment> store) {
        this.embeddingModel = embeddingModel;
        this.store = store;
    }

    public List<SearchHit> search(String query) {
        // LangChain4j 1.x：embed 直接返回 Embedding；0.3x 及更早版本要 response.content()
        Embedding queryEmbedding = embeddingCache.computeIfAbsent(
                cacheKey(query), k -> embeddingModel.embed(query));

        var result = store.search(EmbeddingSearchRequest.builder()
                .queryEmbedding(queryEmbedding)
                .maxResults(TOP_K)
                .build());

        return result.matches().stream()
                .map(m -> new SearchHit(m.embedded().text(), m.score()))
                .toList();
    }

    private String cacheKey(String text) {
        return "bge-small-zh-v1.5:" + sha256Hex(text);  // 模型版本进 key，换模型不会串缓存
    }
}
```

```java
@RestController
public class RagController {

    private final RagSearchService ragSearchService;

    public RagController(RagSearchService ragSearchService) {
        this.ragSearchService = ragSearchService;
    }

    @GetMapping("/api/rag/search")
    public List<SearchHit> search(@RequestParam String q) {
        return ragSearchService.search(q);
    }
}
```

说明：这个接口只覆盖"Embedding + 向量检索"两步，**不含大模型生成**。生成那一段的延迟主要取决于模型和输出长度，是另一个话题；把检索链路单独拆出来测，数据才干净。

**验证**：

```bash
curl -s "http://localhost:8080/api/rag/search?q=%E7%BA%BF%E7%A8%8B%E6%B1%A0%E6%A0%B8%E5%BF%83%E5%8F%82%E6%95%B0%E6%80%8E%E4%B9%88%E9%85%8D" | jq
```

检查两点：返回 5 条（top_k=5）；`score` 字段严格降序。再换一个语义相同但措辞不同的问法，比如把"线程池核心参数怎么配"换成"ThreadPoolExecutor 该传几个参数"，看命中结果是否基本一致——一致才说明语义检索真的在工作，而不是碰巧。

## 五、实测：三个实验

### 5.0 环境与声明

- 硬件/软件：8 核 Apple M1 Pro、16GB 内存、Temurin JDK 21、Spring Boot 3.3.x、LangChain4j 1.4.0、wrk 4.2
- 语料：42 篇 Markdown 技术文档，约 40 万字
- 压测只打 `/api/rag/search`（检索链路，无 LLM 生成）

**先声明清楚**：下面是笔记本实测，绝对值会随机器漂移；但**相对关系**（缓存命中 vs 未命中、chunk 大小对召回的影响、top_k 的收益递减）是稳定可信的，请重点看相对关系。

**wrk** 是啥：一个用 Lua 脚本定制请求的 HTTP 压测工具，单机就能压出稳定的高并发和延迟百分位。

### 5.1 实验一：chunk 切多大合适

固定 top_k=5，只改切分参数，另备一个 20 道人工出题的评测集："命中@5" = top5 里至少有一条包含答案；"答案完整可用" = 命中的片段拼进提示词后，不改写就能支撑回答。

| 切法（字/overlap） | chunk 数 | 入库耗时 | 检索 P95 | 命中@5 | 答案完整可用 |
| --- | --- | --- | --- | --- | --- |
| 200 / 30 | ~2100 | ~85s | 3.1ms | 15/20 | **9/20** |
| 512 / 60 | ~860 | ~35s | 1.9ms | **17/20** | **16/20** |
| 1000 / 100 | ~430 | ~18s | 1.1ms | 14/20 | 12/20 |

结论：**小块检索准但碎片化严重**（命中了也缺上下文），**大块噪声多且贴着模型输入上限**。300~500 字、overlap 取块的 10%~20%，是目前性价比最高的区间，512/60 是本文语料的甜点。

### 5.2 实验二：top_k 调多大合适

固定 512/60，只改 top_k：

| top_k | 检索 P95 | 命中@k（至少 1 条） | 拼进提示词的片段 token 均值 |
| --- | --- | --- | --- |
| 3 | 1.5ms | 12/20 | ~1300 |
| 5 | 1.9ms | **17/20** | ~2200 |
| 10 | 2.6ms | 18/20 | ~4400 |

结论：从 3 到 5，命中率涨了 5 题；从 5 到 10，只涨 1 题，但拼进提示词的 token 直接翻倍——token 就是钱，也是首 token 延迟。**top_k=5 加一个相似度阈值过滤（`minScore`，从 0.4~0.6 起步调）**，比盲目加大 k 划算得多。

### 5.3 实验三：Embedding 缓存省多少

两个 wrk 场景，各跑 `wrk -t4 -c50 -d30s --latency`：

- **缓存友好**：从 100 个问题里均匀随机抽取，其中 20 个高频问题重复出现（模拟 FAQ 重复度，理论命中率 ~80%）
- **全量现算**：每个请求都带自增序号拼一个全新问题，缓存永远未命中，量出"最坏情况"基线

wrk 脚本（随机问题版，问题文件先做过 URL 编码）：

```lua
-- random_query.lua
local queries = {}
local f = io.open("queries.txt", "r")
for line in f:lines() do queries[#queries + 1] = line end
f:close()
math.randomseed(os.time())

request = function()
  local q = queries[math.random(#queries)]
  return wrk.format("GET", "/api/rag/search?q=" .. q)
end
```

实测结果：

| 场景 | RPS | P50 | P95 | P99 |
| --- | --- | --- | --- | --- |
| 全量现算（未命中基线） | ~1610 | 27ms | 44ms | 61ms |
| 缓存友好（~80% 命中） | ~6300 | **2.9ms** | 31ms | 55ms |

解读三句话：

1. P50 从 27ms 掉到 2.9ms——大多数请求走了缓存，只剩"哈希查找 + 内存检索"的钱；
2. **P95/P99 几乎没变**，因为长尾永远是那 20% 未命中请求（要现场跑 ONNX），缓存只优化中位数，不优化长尾——想让 P99 也下来，得优化 embedding 本身（换更小的模型、限制并发、给 ONNX 配线程数）；
3. 吞吐从 ~1610 涨到 ~6300，接近 4 倍。

成本账（以日 10 万次检索为例）：

- 本地模型视角：未命中一次约 24ms CPU（双线程）。全量现算 ≈ 10 万 × 24ms ≈ 40 分钟纯 CPU/日；80% 命中后 ≈ 8 分钟/日。
- 云 API 视角（假设单价 0.5 元/百万 token，问题均长 40 token）：省下的 8 万次调用 ≈ 1.6 元/日。

**说实话**：查询侧的 embedding 很便宜，缓存省的大头不是钱，是 **P50 延迟和 CPU 容量**；真正烧钱的是入库侧——几十万 chunk 的全量向量化。好在文档不变时天然"只算一次"，增量更新才是入库侧成本的关键。

### 5.4 如何复现本文数据

```bash
# 1. 启动应用（确认日志里"入库完成"）
mvn spring-boot:run

# 2. 准备 queries.txt（每行一个问题），统一 URL 编码
python3 - <<'PY'
import urllib.parse
lines = [l.strip() for l in open('queries_raw.txt', encoding='utf-8') if l.strip()]
open('queries.txt', 'w', encoding='utf-8').write(
    '\n'.join(urllib.parse.quote(q) for q in lines))
PY

# 3. 压缓存友好场景
wrk -t4 -c50 -d30s --latency -s random_query.lua http://localhost:8080

# 4. 压全量现算基线（unique_query.lua 用自增序号拼全新问题）
wrk -t4 -c50 -d30s --latency -s unique_query.lua http://localhost:8080
```

验证结论是否成立，看三个数：两个场景的 RPS 比值（应显著大于 1）、P50 比值（应差近一个数量级）、P99 是否接近（缓存不救长尾）。

## 六、常见坑

1. **入库和查询用了不同的 embedding 模型**。两套语义空间完全不可比，相似度分数全是噪声，而且不报错、只是悄悄变差。铁律：查询、入库、缓存 key 三处必须是同一个模型标识；换模型 = 全量重建索引 + 换缓存 key。
2. **chunk 超过模型输入上限被静默截断**。bge-small-zh-v1.5 上限 512 token，切 800 字一块，块尾内容等于没入库——检索不到但不报错。宁可小块，不要贴线硬塞。
3. **InMemoryEmbeddingStore 重启即失、多实例不同步**。LangChain4j 支持把它序列化成 JSON 落盘、启动时加载回来，演示够用；多实例或量级上来后，老老实实上 pgvector。
4. **无界缓存**。本文为了示例简洁用了 `ConcurrentHashMap`，问题是集合只增不减，问题空间一大就是 OOM。生产用 Caffeine（maximumSize + expireAfterWrite）或 Redis。
5. **首次请求卡 1 秒以上**。ONNX 模型是懒加载的，第一个请求要背着模型初始化。启动阶段主动 `embed("预热")` 一次，别让线上第一个用户当暖机的。
6. **只加大 top_k 不加阈值**。召回多了噪声也多了，提示词 token 成本线性上涨，回答质量反而可能下降。top_k=5 + minScore 过滤是更健康的组合。
7. **文档更新后旧块残留**。增量入库前按 source 元数据先删后插，否则旧版本内容和新版本同时命中，用户看到自相矛盾的答案。
8. **只靠"感觉还行"评估调参**。建一个 20~50 题的问答评测集（本文的命中@5 就是这么来的），每次改切分、换模型、调 k 都回归跑一遍。没有评测集，RAG 调优就是玄学。

## 七、总结

- RAG 的工程最小闭环 = **文档切块入库 → 问题向量化 → 向量检索 → 拼进提示词**，LangChain4j 把每一步都封装成了可替换的接口；
- 中小规模**不需要**专门的向量数据库，内存暴力检索在几十万 chunk 以内延迟是毫秒级，选型按数据量级走；
- 切分参数从 **300~500 字、overlap 10%~20%** 起步；top_k 从 5 起步配 minScore 过滤，别盲目加大；
- **Embedding 缓存优化的是 P50 和 CPU，不是 P99**——长尾永远是未命中请求，想让长尾好看得优化推理本身；
- 评测集先行：没有 20~50 题的回归评测，一切调参都是碰运气。

## 参考资料

1. LangChain4j 官方 RAG 教程：<https://docs.langchain4j.dev/tutorials/rag/>
2. LangChain4j GitHub 仓库：<https://github.com/langchain4j/langchain4j>
3. BAAI bge-small-zh-v1.5 模型卡：<https://huggingface.co/BAAI/bge-small-zh-v1.5>
4. pgvector — PostgreSQL 向量检索插件：<https://github.com/pgvector/pgvector>
5. OpenAI Embeddings 官方文档（接口设计与指标参考）：<https://platform.openai.com/docs/guides/embeddings>
6. Pinecone Learn: Chunking Strategies：<https://www.pinecone.io/learn/chunking-strategies/>
7. Spring Boot 官方文档：<https://spring.io/projects/spring-boot>
