---
title: 用 Java 做 RAG：LangChain4j + 向量检索最小可运行实战
date: 2026-09-23 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - LangChain4j
  - RAG
  - 向量检索
  - Embedding
  - Java
  - AI
---

<hr>
<blockquote>
<p>大模型不知道你公司年假几天、不知道你们系统怎么部署，直接问它就开始编。<strong>RAG</strong>（检索增强生成）的思路很朴素：先把你自己的文档检索出来塞给它，再让它照着答。这篇用 <strong>LangChain4j</strong> 搭一个 Java 版最小可运行 RAG：代码能跑、结论能验证、成本能算清，最后附上一串我整理的常见的坑。</p>
</blockquote>

<!-- more -->

## 一、RAG 到底解决什么问题

先解释几个新名词，全用大白话：

- **RAG（Retrieval-Augmented Generation，检索增强生成）**：就是"先查资料，再回答"。用户提问 → 系统先从你的私有文档里捞出最相关的几段 → 把这几段和问题一起塞给大模型 → 模型照着资料作答。它同时解决两个问题：模型不知道你的私有知识，以及模型爱一本正经地瞎编（幻觉）。
- **Embedding（向量化）**：把一段文字变成一串浮点数（比如 1024 个），这串数字保留了文字的"语义"。意思相近的两段话，向量在空间里就挨得近。
- **向量检索**：拿问题的向量去和库里所有文档块的向量比距离，找出最近的 K 个。相当于"按意思搜"而不是"按关键词搜"——你搜"年假"，它能召回写着"带薪休假"的段落。
- **chunk（分块）**：长文档不能整篇塞进 prompt，要先切成小块。切多大切法直接影响检索质量，后文细说。
- **余弦相似度（score）**：衡量两个向量方向有多接近的指标，越接近 1 越相关。检索结果里的 score 基本就是它。

那为什么不用微调（fine-tuning）？算笔账就明白了：公司制度三天两头改，微调一次几千块外加几天排期，改一次重训一次谁受得了；RAG 只要更新文档、重新向量化一遍，分钟级、几毛钱。所以"知识经常变"的场景，RAG 几乎是唯一合理的选择。

## 二、LangChain4j 是啥，为什么选它

**LangChain4j** 是 Java 生态里对标 Python LangChain 的大模型应用开发框架，2025 年 5 月起 1.0 正式 GA。它解决三件事：

1. **统一模型接入**：OpenAI、通义千问、DeepSeek……各家 SDK 长得都不一样，LangChain4j 给了一层统一抽象，还支持 **OpenAI 兼容模式**——国内厂商基本都提供与 OpenAI 完全一致的 HTTP 接口，改个 base-url 就能切换模型供应商。
2. **内置 RAG 全家桶**：文档切分、向量化、向量库接口、检索器全是现成组件，拼起来就能用。
3. **AiServices 声明式编程**：写一个接口加一行注解，动态代理帮你把检索、拼 prompt 的脏活全干了。

向量库这次用 **InMemoryEmbeddingStore**（内存版向量库，重启就没，只适合 demo）。生产环境换 Milvus、Elasticsearch、PGVector 这类**向量数据库**——专门存向量、做相似度检索的存储系统，接口大同小异，代码基本不用动。

## 三、最小可运行示例

环境要求：

- JDK 17+（LangChain4j 1.x 的硬要求）
- Maven 3.8+
- 一个大模型 API Key：本文用**阿里云百炼**（qwen-plus 做生成、text-embedding-v3 做向量化），任何 OpenAI 兼容服务同理
- Key 放环境变量，**千万别写死在代码里提交进 git**：

```bash
export DASHSCOPE_API_KEY=sk-xxxx   # 在百炼控制台创建
```

pom.xml 关键依赖：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.langchain4j</groupId>
      <artifactId>langchain4j-bom</artifactId>
      <version>1.2.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>org.langchain4j</groupId>
    <artifactId>langchain4j</artifactId>
  </dependency>
  <dependency>
    <groupId>org.langchain4j</groupId>
    <artifactId>langchain4j-open-ai</artifactId>
  </dependency>
</dependencies>
```

注意 groupId 是 `org.langchain4j`——1.0 之后从 `dev.langchain4j` 迁过来的，但 Java 包名仍然是 `dev.langchain4j.*`（对，就是这么拧巴，坑列表里细说）。

完整代码 `RagDemo.java`：

```java
import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.EmbeddingStoreContentRetriever;
import dev.langchain4j.store.embedding.EmbeddingStoreIngestor;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;

import java.util.List;

public class RagDemo {

    // 声明式接口：LangChain4j 用动态代理帮你实现它
    interface Assistant {
        @SystemMessage("你是公司制度助手。仅根据提供的资料回答；"
                + "资料里没有的，直接说不知道，不要编。")
        String chat(String userMessage);
    }

    public static void main(String[] args) {
        String apiKey = System.getenv("DASHSCOPE_API_KEY");
        String baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

        // 1. 生成模型 + 向量模型（同一个兼容端点）
        ChatModel chatModel = OpenAiChatModel.builder()
                .baseUrl(baseUrl)
                .apiKey(apiKey)
                .modelName("qwen-plus")
                .temperature(0.2)          // 知识库问答要稳，温度调低
                .build();

        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .baseUrl(baseUrl)
                .apiKey(apiKey)
                .modelName("text-embedding-v3")
                .build();

        // 2. 造两段"模型肯定不知道"的私有知识
        Document annualLeave = Document.from("""
                公司年假制度（2026 版）：入职满 1 年不满 5 年，每年 5 天年假；
                满 5 年不满 10 年，每年 10 天；满 10 年，每年 15 天。
                年假需提前 3 个工作日在 OA 系统提交申请，由直属主管审批。
                未休年假可在次年 3 月底前补休，逾期作废。""");

        Document reimbursement = Document.from("""
                公司报销流程：发票开具后 90 天内在 OA 提交报销单，
                经部门负责人与财务两级审批后打款，每月 25 日统一付款。
                单笔超过 5000 元需额外由总经理审批。""");

        // 3. 切块 -> 向量化 -> 入库，三件事一步做完
        EmbeddingStore<TextSegment> store = new InMemoryEmbeddingStore<>();
        EmbeddingStoreIngestor ingestor = EmbeddingStoreIngestor.builder()
                .documentSplitter(DocumentSplitters.recursive(300, 30)) // 单位是字符！
                .embeddingModel(embeddingModel)
                .embeddingStore(store)
                .build();
        ingestor.ingest(List.of(annualLeave, reimbursement));

        // 4. 组装 RAG：每次提问前自动检索 top3 相关片段，拼进 prompt
        Assistant assistant = AiServices.builder(Assistant.class)
                .chatModel(chatModel)
                .contentRetriever(EmbeddingStoreContentRetriever.builder()
                        .embeddingStore(store)
                        .embeddingModel(embeddingModel)
                        .maxResults(3)
                        .minScore(0.5)     // 相似度低于 0.5 的片段不要
                        .build())
                .build();

        // 5. 提问：答案只存在于文档里，模型训练时没见过
        System.out.println(assistant.chat("入职两年，年假有几天？怎么申请？"));
    }
}
```

运行与预期输出：

```bash
mvn -q compile exec:java -Dexec.mainClass=RagDemo
# 预期输出（大意）：
# 入职满 1 年不满 5 年每年 5 天。你入职两年，应有 5 天年假。
# 申请方式：提前 3 个工作日在 OA 系统提交，由直属主管审批。
```

"提前 3 个工作日 OA 申请"这个细节只写在文档里——模型答出来了，说明检索真的生效了。

## 四、怎么验证它真的在"检索"，而不是瞎猜

只看答案你可能会嘀咕：这是检索出来的，还是模型蒙的？三个对照实验加一个命中打印，五分钟做完：

**实验 1：知识库外的问题。** 问一句文档里完全没有的："出差补贴一天多少钱？" 正确表现是拒答或明说资料里没有。如果它开始报数字，说明"没有就说不知道"的约束没生效，检查 `@SystemMessage`。

**实验 2：删库对照。** 把 `annualLeave` 这条 Document 注释掉重启，再问同一个问题，回答必须变成"不知道"。前后两次回答不一样，就证明答案确实来自检索。

**实验 3：打印命中片段。** 单独写几行检索代码，看看 topK 到底捞回了什么：

```java
// 需要的 import：
// dev.langchain4j.data.embedding.Embedding
// dev.langchain4j.store.embedding.EmbeddingSearchRequest
Embedding query = embeddingModel.embed("入职两年年假几天").content();
EmbeddingSearchRequest req = EmbeddingSearchRequest.builder()
        .queryEmbedding(query)
        .maxResults(3)
        .build();
store.search(req).matches().forEach(m ->
        System.out.printf("score=%.3f | %s%n", m.score(), m.embedded().text()));
```

score 高的应该是年假制度片段；如果捞回来全是报销流程，说明 embedding 或切分有问题，先别急着怪模型。

**实验 4：连通性自检。** 向量相关环节报错时，先用 curl 确认 API 链路通不通：

```bash
curl -s https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-v3","input":"年假有几天"}' | head -c 300
```

能返回一串浮点数数组，说明链路没问题，问题在你的应用代码里。

## 五、成本与延迟：RAG 到底贵不贵

RAG 比"直接问"多两笔开销：入库时的一次性向量化，以及每次提问的检索向量化 + 塞进 prompt 的片段 token。先看一张量级参考表（按百炼官方定价估算：text-embedding-v3 ¥0.5/百万输入 token，qwen-plus 按约 ¥0.8/百万输入、¥2/百万输出；输出按约 250 token/次计。你的模型、文档长度、网络都和示例不同，数字一定会不一样，请按第四节的方法自测）：

| 方案 | 每次输入 token（约） | P50 延迟（约） | P95 延迟（约） | 千次问答总成本（约） |
| --- | --- | --- | --- | --- |
| 直接问（无 RAG） | 200 | 1.2 s | 2.6 s | ¥0.7 |
| RAG topK=3 | 900 | 1.5 s | 3.0 s | ¥1.2 |
| RAG topK=8 | 2400 | 2.0 s | 3.8 s | ¥2.5 |

三个结论：

1. **延迟大头在 LLM 生成**。检索本身（一次 embedding 约 100~300ms + 内存检索 <1ms）只占零头。想压延迟，优先考虑流式输出和更小的生成模型，而不是砍检索。
2. **topK 越大成本线性涨，准确率却不一定升**。第 6、7、8 名的片段经常是纯噪声。3~5 起步，配合 minScore 过滤，通常够用。
3. **一次性向量化几乎不要钱**：10 万条、每条 300 字的知识库约 3000 万 token，按 ¥0.5/百万算也就 15 块钱。真正持续花钱的是每次问答的 prompt token。

压测方法（把 Demo 包成一个 HTTP 接口后，用 wrk 压）：

```lua
-- bench.lua
wrk.method = "POST"
wrk.headers["Content-Type"] = "application/json"
wrk.body   = '{"question":"年假有几天"}'
```

```bash
wrk -t2 -c10 -d60s --timeout=30s --latency -s bench.lua http://localhost:8080/ask
```

注：大模型 API 有限流策略，压测前先确认自己 Key 的限额，别把配额打爆。更推荐的做法是离线批量跑 50~100 个真实问题、统计 P50/P95 和答对率，比纯压测更贴近真实收益。

## 六、常见坑（都是容易一脚踩进去的）

1. **groupId 与包名不一致**：1.0 起 Maven 坐标从 `dev.langchain4j` 迁到 `org.langchain4j`，但包名还是 `dev.langchain4j.*`。照老教程复制依赖，很容易"类找不到/方法不存在"。另外老版本（0.3x）里 `ChatModel` 叫 `ChatLanguageModel`，AiServices 的 builder 方法叫 `chatLanguageModel()`——看到这两个名字就知道教程过时了。
2. **入库和查询用了不同的 embedding 模型**：不同模型的向量空间完全不通用，混用等于拿厘米尺去量公斤。换了模型必须全量重建向量。
3. **`DocumentSplitters.recursive` 的单位是字符不是 token**：`recursive(300, 30)` 是 300 字符、30 字符重叠。中文 1 个字大致对应 1 个 token，英文则差好几倍，别按 token 直觉填参数。
4. **chunk 切太大或太小**：太大 → 单个片段塞了多个话题，检索不准还费 token；太小 → 语义被切碎，答案缺上下文。经验值 200~500 字符、重叠 10%~20%，中文文档最好按标题/段落边界自己切。
5. **topK 无脑调大**：成本线性涨，噪声片段反而拉低回答质量。先用实验 3 看看第 4 名之后的片段还有没有用，没有就砍。
6. **不设 minScore 也不设"答不了就说不知道"**：检索召回的片段可能完全不相关，模型会硬着头皮照着不相关资料编。两道保险都要上。
7. **拿 RAG 当精确查询用**："去年 3 月订单总额是多少"这类精确统计问题，向量检索帮不了你，该走 SQL 就走 SQL。RAG 擅长"按意思找段落"，不擅长"精确算数字"。
8. **API Key 硬编码提交进 git**：模型 API Key 等同于钱包，泄漏就是替别人烧钱。走环境变量或密钥管理；历史提交里出现过的 Key 立刻吊销重发。
9. **把 InMemoryEmbeddingStore 用到生产**：重启全没、不支持持久化和水平扩展。Demo 验证完就换 PGVector（PostgreSQL 插件，最省事）或 Elasticsearch 8.x（自带向量检索）。
10. **忘记调低 temperature**：知识库问答要的是"照着资料说"，默认温度会让模型自由发挥。0~0.3 比较稳。

## 七、总结

- RAG = 先检索后生成，用"分钟级、几毛钱"的文档更新替代"天级、几千块"的微调，专治私有知识缺失和幻觉。
- LangChain4j 把切块、向量化、检索、prompt 拼装全部组件化，20 来行主干代码就能跑通最小闭环。
- 成本结构：一次性向量化几乎免费，持续成本在每次问答的 prompt token；topK 和 chunk 大小是成本与质量的核心旋钮。
- 一切结论都要验证：知识库外拒答、删库对照、打印命中片段，三个实验五分钟，避免"看起来在工作"。
- 下一步可玩：接真实文档（Markdown/PDF 解析）、换持久化向量库、加重排序（rerank）提升精度。

## 参考资料

1. LangChain4j 官方文档 · RAG 教程：<https://docs.langchain4j.dev/tutorials/rag/>
2. 阿里云百炼 · 使用 OpenAI 兼容模式调用 Embedding：<https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai>
3. 阿里云百炼 · text-embedding-v3 模型文档（能力/定价）：<https://help.aliyun.com/zh/model-studio/text-embedding-v3>
4. 53AI · RAG 系统实践与调优（索引/检索/生成三阶段调优实践）：<https://www.53ai.com/news/RAG/2025010794831.html>
5. Datawhale · All-in-RAG 开源教程（中文体系化学习路径）：<https://github.com/datawhalechina/all-in-rag>
