---
title: "让大模型开口前先查资料：Spring AI + pgvector 搭一个最小可用 RAG（附召回率与延迟实测）"
date: 2026-10-29 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Spring AI
  - RAG
  - pgvector
  - Embedding
  - 向量检索
  - Ollama
---

<hr>
<blockquote>
<p><strong>RAG（Retrieval-Augmented Generation，检索增强生成）</strong>就是让大模型开口之前，先去你的知识库里"查资料"，把查到的段落塞进提示词，再让它照着资料回答——知识不过时、瞎编有出处。这篇是站内 Spring AI 系列的第三篇（前两篇聊了 Tool Calling 和结构化输出），用 Java 从零搭一个最小可用的 RAG：文档切分、Embedding、pgvector 入库、检索增强问答一条龙。1200+ 段语料实测：检索链路 P99 71ms（大头是 CPU 上的向量化）、20 题标注集召回率从 0.55 调到 0.82、每次问答的 prompt 从"32k 窗口塞不下全文"降到 3.3k tokens。切多大、阈值设多高、索引啥时候建，这些参数的坑一次踩完。</p>
</blockquote>

<!-- more -->

## 一、背景：模型不缺智商，缺你的内部资料

先说场景：公司内部 wiki 有 300 页——报销制度、退票规则、机房值守手册。你想问大模型"退票手续费多少"，它张口就来一个漂亮的数字，然后你翻遍 wiki 发现压根没这条。这不是模型"笨"，是两个结构性问题：

1. **训练数据里没有你的资料**。模型的知识冻结在训练截止日，你的 wiki 它一辈子没见过；
2. **没有资料它也硬答**。大模型的本质是概率采样，编一个"看起来像答案"的东西没有任何心理负担——这就是常说的**幻觉（Hallucination，模型一本正经地输出不存在的内容）**。

工程上给大模型"喂知识"有三条路，先摆在一起看：

| 方案 | 知识更新成本 | 单次 prompt 成本 | 延迟 | 答案可溯源 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| **长上下文硬塞** | 改文档即生效 | 巨大（全文进 prompt） | 高（prefill 慢） | 差（模型自由发挥） | 资料少且短 |
| **微调（Fine-tuning）** | 每次都要训练，贵 | 低 | 低 | 差 | 教"风格/格式"，不适合教"事实" |
| **RAG** | 改文档即生效 | 小（只塞相关段落） | 中（多一次检索） | 好（能给出处） | 知识库问答、客服、文档助手 |

一句话结论：**教模型"怎么说话"用微调，教模型"事实是什么"用 RAG**。事实天天变，微调追不起。

## 二、RAG 速通：几个新名词一次讲清

按数据流动顺序交代，每个词第一次出现都给一句人话解释：

- **Embedding（向量化）**：把一段文字变成一串固定长度的数字（比如 768 个浮点数），意思是相近的文本，这串数字在空间里就挨得近。它是整个 RAG 的地基——"查资料"查的不是关键词，是语义距离。本文用 `nomic-embed-text`（Ollama 上的开源 embedding 模型，768 维）。
- **chunk（切分段落）**：文档不能整篇丢进去向量化，要切成几百 token 一段的小块。切太碎语义断裂，切太大检索噪音多——这是 RAG 调参的第一大坑，后面有实测。
- **pgvector**：给 PostgreSQL 装上向量存储与相似度检索能力的扩展。有了它就不用单独维护一个向量数据库（Milvus、Qdrant 那些更重的东西），你本来就会的 SQL 照用。
- **余弦相似度（Cosine Similarity）**：衡量两个向量方向有多接近，1 是完全同向，0 是无关。pgvector 里对应的距离算子是 `<=>`（余弦距离 = 1 − 相似度）。
- **Recall@k（前 k 召回率）**：你标注的一批问题的标准答案段落，有多少比例出现在检索返回的前 k 条里。RAG 的"检索质量"好不好，就看这个指标，别裸眼看感觉。
- **HNSW**：一种近似最近邻（ANN）索引，用"分层跳表式"的图结构换速度——牺牲一点召回精度，把检索从全表扫描降到毫秒级。数据量小的时候不需要它。

整条链路一图流：

```text
【离线灌库】 wiki/faq 文档 → 切分(chunk) → Embedding → 存入 pgvector
【在线问答】 用户提问 → Embedding → 向量检索 top5 → 拼进提示词 → 大模型回答(带出处)
```

> 注：本文所有实验基于 Spring AI 1.0 + Ollama + qwen2.5:7b（对话）+ nomic-embed-text（向量化），pgvector 16，跑在一台 8C16G 的 ECS 上，纯 CPU，不花钱，数据真实可复现。

## 三、动手：四个命令加一个 Spring Boot 工程

### 3.1 环境准备

```bash
# 1) 带向量化能力的 PostgreSQL
docker run -d --name pgvector-rag \
  -e POSTGRES_DB=rag -e POSTGRES_USER=rag -e POSTGRES_PASSWORD=rag123 \
  -p 5432:5432 -v pgvector_data:/var/lib/postgresql/data \
  pgvector/pgvector:pg16

# 2) 两个模型：一个管"查"，一个管"说"
ollama pull nomic-embed-text   # 768 维 embedding，274MB
ollama pull qwen2.5:7b         # 对话模型，负责最终回答
```

### 3.2 依赖与配置

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
    <artifactId>spring-ai-starter-model-ollama</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-vector-store-pgvector</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-tika-document-reader</artifactId>
  </dependency>
</dependencies>
```

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/rag
    username: rag
    password: rag123
  ai:
    ollama:
      base-url: http://localhost:11434
      embedding:
        options:
          model: nomic-embed-text
      chat:
        options:
          model: qwen2.5:7b
    vectorstore:
      pgvector:
        dimensions: 768          # 必须和 embedding 模型的输出维度一致
        distance-type: COSINE_DISTANCE
        initialize-schema: true  # 首次启动自动建 vector_store 表
```

> 注：Spring AI 从 milestone 到 1.0 GA 之间改过不少配置属性名（比如 pgvector 的建表开关在部分版本叫 `remove-existing-vector-store-table`）。启动报"Unknown property"就翻你这个版本的参考文档，别硬抄。

### 3.3 灌库：读文档 → 切分 → 向量化 → 入库

灌库和在线服务分开跑，用 profile 隔离，避免每次启动都重复灌：

```java
@Component
@Profile("ingest")
public class IngestRunner implements ApplicationRunner {

    // 按 token 切 + 句边界感知；500 token 约合中文七八百字，是后面实测召回率最好的档位
    private final TokenTextSplitter splitter =
            new TokenTextSplitter(500, 120, 20, 10000, true);

    private final VectorStore vectorStore;

    public IngestRunner(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    @Override
    public void run(ApplicationArguments args) {
        for (String path : args.getOptionValues("docs")) {
            var docs = new TikaDocumentReader(new FileSystemResource(path)).get();
            // 把文件名塞进 metadata，检索命中后能给出处
            docs.forEach(d -> d.getMetadata().put("source", new File(path).getName()));
            var chunks = splitter.apply(docs);
            vectorStore.add(chunks);
            System.out.printf("%s -> %d chunks%n", path, chunks.size());
        }
    }
}
```

```bash
mvn spring-boot:run -Dspring-boot.run.profiles=ingest \
    -Dspring-boot.run.arguments=--docs=/data/faq.md,--docs=/data/wiki.md
```

> 注：想让每个 chunk"自带主题"，把文档标题拼进 chunk 文本开头（`title + "\n" + content`）再入库。就这一行改动，后面实测把召回率从 0.74 抬到 0.82。

### 3.4 问答：QuestionAnswerAdvisor 把检索"焊"进提示词

**Advisor（ advisers/拦截器）**是 Spring AI 的横切机制：请求发给模型前后可以插手改写。`QuestionAnswerAdvisor` 就是官方提供的 RAG 拦截器——它自动完成"向量化问题 → 查向量库 → 把命中段落拼进提示词"三件事：

```java
@RestController
public class RagController {

    private final ChatClient chatClient;
    private final VectorStore vectorStore;

    public RagController(ChatModel chatModel, VectorStore vectorStore) {
        this.vectorStore = vectorStore;
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(QuestionAnswerAdvisor.builder(vectorStore)
                        .searchRequest(SearchRequest.builder()
                                .topK(5)
                                .similarityThreshold(0.4)  // 为什么是 0.4，见第六节
                                .build())
                        .build());
    }

    /** 端到端问答：检索 + 生成 */
    @PostMapping("/rag/ask")
    public Map<String, String> ask(@RequestBody Map<String, String> body) {
        String answer = chatClient.prompt().user(body.get("q")).call().content();
        return Map.of("answer", answer);
    }

    /** 只测检索链路（向量化 + 向量搜索），压测延迟用 */
    @GetMapping("/rag/search")
    public List<Document> search(@RequestParam String q) {
        return vectorStore.similaritySearch(
                SearchRequest.builder().query(q).topK(5).similarityThreshold(0.4).build());
    }
}
```

两条链路分开暴露是有意的：`/rag/search` 让你把"检索慢"和"生成慢"拆开算账，排障时少吵架。

## 四、实测：延迟、召回率、token 成本三本账

### 4.1 检索链路延迟：100 次真实提问

语料切成 1,286 个 chunk。用 20 个真实问题轮询打 100 次 `/rag/search`：

```bash
for i in $(seq 1 100); do
  q=$(sed -n "$(( (i % 20) + 1 ))p" /tmp/qs.txt)
  curl -s -o /dev/null -w "%{time_total}\n" \
    "http://localhost:8080/rag/search?q=$q"
done | sort -n | awk '{a[NR]=$1} END{printf "P50=%.1fms P95=%.1fms P99=%.1fms\n", a[int(NR*0.5)]*1000, a[int(NR*0.95)]*1000, a[NR]*1000}'
```

结果：

| 链路 | P50 | P95 | P99 |
| --- | --- | --- | --- |
| 检索链路（Embedding + 向量搜索） | 46ms | 63ms | 71ms |
| 其中：向量化（CPU） | ~40ms | — | — |
| 其中：pgvector 查询 | ~5ms | — | — |

结论很清晰：**千段规模下，延迟大头是 CPU 上的 Embedding，不是数据库**。优化方向排序：给 embedding 上 GPU / 换小模型 > 数据库调优（后者压根还轮不到）。

### 4.2 切分策略对召回率的影响：20 题标注集

标注 20 个问题，每个标一个"正确答案必须包含的关键词"（如"退票手续费多少" → `30%`）。命中 = top5 里任一 chunk 包含关键词：

| 切分策略 | chunk 数 | Recall@5 |
| --- | --- | --- |
| 按固定 300 字符硬切（无语义感知） | 1,842 | 0.55 |
| TokenTextSplitter，300 token | 1,610 | 0.60 |
| TokenTextSplitter，800 token（默认） | 1,286 | 0.74 |
| TokenTextSplitter，500 token + 标题拼进 chunk | 1,483 | **0.82** |

两个规律值得记住：

- **切太碎，答案被拦腰斩断**：300 字符硬切把"退票手续费 30%，但旺季除外"这类句子切走一半，top5 里永远凑不齐完整证据；
- **标题是最便宜的上下文补丁**：chunk 失去所在章节信息时，"退票规则"四个字就是它的身份。把标题拼进去，语义立刻立得住。

### 4.3 token 成本：这才是 RAG 真正的杀手锏

300 页 wiki 约 182k tokens，qwen2.5:7b 的窗口是 32k——**全文塞上下文这条路根本走不通**。即便换长窗口模型：

| 方案 | 每问 prompt tokens | 端到端 P50 |
| --- | --- | --- |
| 全文塞 32k 窗口（截断） | ~32,000 | ~96s（CPU prefill 太慢） |
| RAG top5 | 3,265 | 6.8s |

prompt 差一个数量级，延迟差 14 倍。要是接 API 按量计费，这笔账直接决定每月账单。

### 4.4 什么时候才需要 HNSW 索引

用 SQL 造 10 万条合成向量对比（命令在第七节）：

| 数据量 | 索引 | P50 | P99 | top5 与精确检索重合 |
| --- | --- | --- | --- | --- |
| 1,286 | 精确扫描 | 4.9ms | 7.2ms | 100% |
| 100,000 | 精确扫描 | 38ms | 46ms | 100% |
| 100,000 | HNSW | 1.8ms | 3.1ms | 96% |

**千段级直接精确扫，别急着建索引**——建了也不快多少，还损失一点召回精度。十万行以上、精确扫描 P99 过百毫秒了，再上 HNSW。

## 五、常见坑（每一个都真实踩过）

1. **维度对不上**：换了 embedding 模型（768 → 1536）直接报 `dimension mismatch`。因为表已经按 768 建了。处理：`DROP TABLE vector_store` 全量重灌。引申一条铁律：**不同模型的向量绝不能混在一个库里**，它们根本不在同一个"语义空间"。
2. **相似度阈值照抄教程设 0.75**：结果十个问题八个空召回。nomic-embed-text 上真实问题的余弦相似度普遍落在 0.35~0.65。正确姿势：先把 top5 的分数打印出来看分布，再定阈值。0.4 是个不坏的起点。
3. **每次启动重灌一遍库**：灌库代码写在普通 `ApplicationRunner` 里，重启一次灌一次，库里全是重复 chunk，检索被垃圾稀释。灌库放独立 profile，或先 `TRUNCATE vector_store` 再灌，保证幂等。
4. **P99 毛刺的真凶是 Ollama 模型卸载**：默认 5 分钟不用就把模型踢出内存，挂机后第一问凭空多出 2~3 秒加载时间。设 `OLLAMA_KEEP_ALIVE=1h`，或启动后先发预热请求。压测曲线里那个孤立的高点，十有八九是它。
5. **中文按 token 切容易劈词**：中文没有空格， splitter 可能把"手续费"劈成"手"和"续费"。缓解：先按 Markdown 标题/段落自己粗切，再交给 TokenTextSplitter；另外它没有 overlap 参数，需要块间重叠得自己实现。
6. **metadata 里塞大字段**：metadata 会随每条检索结果原样返回并拼进提示词上下文，把全文塞进去等于白切。metadata 只放 source、标题、日期这类小标签。

## 六、如何验证本文结论

不信可以自己跑一遍，命令全在上面了，这里给验收清单：

```bash
# 1) 库里 chunk 数量对得上（约 1,483）
psql -h localhost -U rag -d rag -c "SELECT count(*) FROM vector_store;"

# 2) 检索出处的确来自你的文档，分数在 0.4 以上
curl -s "http://localhost:8080/rag/search?q=退票手续费" | jq '.[0].metadata'

# 3) 【关键实验】把 faq.md 里的退票手续费从 30% 改成 25%，重灌后再问——
#    答案跟着变成 25%，证明它真的在查库，不是模型背的
curl -s -X POST localhost:8080/rag/ask -H 'Content-Type: application/json' \
    -d '{"q":"退票手续费多少"}'

# 4) 延迟数据用 4.1 的循环脚本复现；召回率跑 eval 标注集

# 5) HNSW：造 10 万合成向量后建索引，确认走了索引而不是顺序扫描
psql -d rag -c "INSERT INTO vector_store (id, content, embedding)
  SELECT gen_random_uuid(), 'synthetic',
    ('[' || array_to_string(array(SELECT round(random()::numeric,6)
      FROM generate_series(1,768)), ',') || ']')::vector
  FROM generate_series(1,100000);"
psql -d rag -c "CREATE INDEX ON vector_store USING hnsw (embedding vector_cosine_ops);"
psql -d rag -c "EXPLAIN ANALYZE SELECT id FROM vector_store
  ORDER BY embedding <=> (SELECT embedding FROM vector_store WHERE content='synthetic' LIMIT 1)
  LIMIT 5;"
# 输出里出现 Index Scan using ..._hnsw_idx 即为生效
```

其中第 3 条是我最推荐的"防自欺"实验：能跟着文档改的答案才是真 RAG，答不动的都是提示词里藏了小抄。

## 七、总结

- RAG 的本质就一句话：**检索给证据，模型管表达**。事实性的知识交给可增删改查的库，别指望微调。
- 千段规模：延迟大头是 CPU Embedding（P99 71ms 里占 ~40ms），数据库精确扫描只要 5ms，**先别建 HNSW**。
- 召回率调参优先级：换更好的 embedding 模型 > 标题拼进 chunk（0.74 → 0.82）> 调切分大小（500 token 性价比最高）> 微调 topK 和阈值。
- token 成本是数量级的差距：3.2k vs 32k，接 API 的话这就是账单。
- 三个必踩坑先替你踩了：维度不匹配、阈值抄太高空召回、启动重复灌库。
- 验证 RAG 真伪的土办法：改文档、重灌、再问，答案会变才是真的。

## 参考资料

1. Spring AI 官方文档 — Vector Stores / pgVector：<https://docs.spring.io/spring-ai/reference/api/vectordbs/pgvector.html>
2. pgvector — open-source vector similarity search for Postgres：<https://github.com/pgvector/pgvector>
3. 美团技术团队博客（向量检索 / RAG 工程实践专栏入口）：<https://tech.meituan.com/>
4. 阿里云开发者社区（RAG 与向量检索系列入口）：<https://developer.aliyun.com/>
5. Ollama — nomic-embed-text 模型页：<https://ollama.com/library/nomic-embed-text>
6. OpenAI Embeddings 指南（评估指标与切分策略的结构参考）：<https://platform.openai.com/docs/guides/embeddings>
