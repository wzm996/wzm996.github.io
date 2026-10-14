---
title: 不写一行 Python：Spring AI + Ollama，100 行 Java 搭出本地 RAG 问答接口（附可复现实验）
date: 2026-10-14 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - RAG
  - Spring AI
  - Ollama
  - Embedding
  - 向量检索
---

<hr>
<blockquote>
<p><strong>RAG（检索增强生成）</strong>不是玄学：把你的文档切块、算成向量、按相似度捞回最相关的几段，再塞给大模型"开卷考试"。这篇用 Spring AI 1.0 + Ollama 在一台 2 核 4G 的普通云主机上，用不到 100 行 Java 搭出一个<strong>全本地、零 API Key、零 Python 依赖</strong>的 RAG 问答接口，并把"检索 P95 39ms、生成才是瓶颈"这笔账当面算一遍。所有命令复制粘贴就能复现。</p>
</blockquote>

<!-- more -->

<h1 id="section-1">一、为什么要用纯 Java 搞 RAG</h1>

<p>先说结论：<strong>对大多数 Java 后端来说，RAG 的门槛不在模型，而在于<strong>没人想为了一个检索功能，再养一套 Python 旁挂服务</strong>。</strong></p>

<p>场景你大概率遇到过：公司有一堆内部文档（wiki、FAQ、接口文档、历史工单），用户想要"直接提问、直接给答案"。直接把文档塞给大模型？上下文窗口装不下，塞得下也贵、也慢。这时候的标准答案是 RAG：</p>

<p><strong>RAG（Retrieval-Augmented Generation，检索增强生成）</strong>：先从文档库里"检索"出和问题最相关的几段原文，再把这些原文连同问题一起交给大模型"生成"回答。相当于让模型<strong>开卷考试</strong>——卷子（文档）是你的，答题（措辞）是模型的。它解决两个问题：模型不知道你的私有数据（知识新鲜度），以及模型一本正经地胡说（幻觉，给了原文引用后收敛很多）。</p>

<p>市面上的 RAG 教程十有八九是 Python 的：LangChain、LlamaIndex……但对一个 Spring Boot 团队来说，引入 Python 技术栈意味着新的部署单元、新的依赖管理、新的监控告警、两套人马。这篇我们证明一件事：<strong>这套东西用 Java 写，代码量不到 100 行，且全程不依赖任何云 API Key</strong>——你公司内网也能跑。</p>

<p>目标读者：写过 Spring Boot、听说过"大模型能接 API"、想知道 RAG 到底是不是纸老虎的 Java 工程师。先修知识：知道 HTTP 接口怎么写、知道 JSON 长什么样，就够了，其余概念文中现讲。</p>

<h1 id="section-2">二、10 分钟看懂 RAG 三板斧：切块、向量化、召回</h1>

<p>整个 RAG 的检索侧，说白了就三个动作：</p>

<pre><code>文档库 ──切块──▶ chunks ──向量化──▶ 向量数组 ──入库──▶ 向量库
                                                      │
用户提问 ──向量化──▶ 问题向量 ──────相似度比对──────────┘
                                    │
                                    ▼
                              Top-K 相关片段 ──▶ 拼进 Prompt ──▶ 大模型生成回答</code></pre>

<p>三个反复要用的名词，先用一句人话解释：</p>

<p><strong>Embedding（向量化）</strong>：把一段文字变成一串固定长度的浮点数（比如 768 个数），这串数就是文字的"语义坐标"。意思越接近的两段话，坐标在空间里离得越近。"怎么退款"和"退货把钱退回来"字面没重合，但坐标很近——这是关键词搜索做不到的。产出向量的模型叫 <strong>Embedding 模型</strong>，它很小（几百 MB），不需要 GPU。</p>

<p><strong>Chunking（切块）</strong>：把长文档切成一段段固定大小的片段。为什么要切？因为 Embedding 模型有输入长度上限，而且"一整篇 5000 字文档"的向量会把十几个主题搅成一锅粥，检索精度反而差。切多大有讲究，后面坑里细说。</p>

<p><strong>向量检索 / 召回（Retrieval）</strong>：拿问题向量去向量库里算距离（常用<strong>余弦相似度</strong>——两个向量夹角的余弦，越接近 1 越像），捞回最像的 K 条，业内叫 Top-K 召回。数据量在百万级以下时，直接暴力扫全库都够快；上亿了才需要专门的索引结构（HNSW 之类，本文用不到）。</p>

<p>一句话总结分工：<strong>Embedding 负责"听得懂"，向量库负责"找得快"，大模型负责"说人话"。</strong></p>

<h1 id="section-3">三、选型：全本地、零 Key 的最小可用栈</h1>

<p>这篇的选型原则只有一条：<strong>在 2 核 4G 的破机器上，不花钱、不申请 Key、不装 Python，复制粘贴就能跑通。</strong></p>

| 组件 | 选择 | 为什么是它 |
|---|---|---|
| 应用框架 | Spring AI 1.0.x | 把 Embedding/向量库/ChatModel 抽象成统一接口，换供应商只改配置 |
| Embedding 模型 | Ollama 跑 <code>nomic-embed-text</code>（768 维） | 本地 CPU 推理，单条约 11ms，够用 |
| 向量库 | Spring AI <code>SimpleVectorStore</code> | 内存数组 + 暴力余弦，无外部依赖，千级 chunk 毫无压力 |
| 生成模型 | Ollama 跑 <code>qwen2.5:1.5b</code> | 2C4G 上还能接受的 CPU 生成速度 |

<p>这里解释两个新面孔：</p>

<p><strong>Ollama</strong>：一个本地跑大模型的工具，一条命令拉模型、一条命令起服务，对外暴露统一的本地 API（默认 <code>localhost:11434</code>）。它是"本地版模型网关"，让你像装软件一样装模型。</p>

<p><strong>SimpleVectorStore</strong>：Spring AI 自带的玩具级向量库，本质就是一个内存数组，检索时暴力算余弦相似度，还能 <code>save()</code>/<code>load()</code> 成 JSON 文件。生产别用它，但做实验、做 Demo、做单元测试，它是零成本起步的最优解。量级上来了再换下表的正式方案：</p>

| 方案 | 定位 | 什么时候换过去 |
|---|---|---|
| SimpleVectorStore | 内存暴力扫，千级向量 | Demo / 单测 |
| pgvector（PG 插件） | SQL 一把梭，百万级 | 团队已有 PostgreSQL，不想新增组件 |
| Milvus / Elasticsearch | 专门向量引擎 / ES 8.x 自带向量检索 | 千万级以上、要多副本高可用 |

<h1 id="section-4">四、环境准备：三条命令</h1>

<p>实验环境：2 核 4G 普通云主机，Ubuntu 22.04，JDK 17。前修操作只有装 Ollama 和拉模型：</p>

<pre><code># 1. 安装 Ollama
curl -fsSL https://ollama.com/install.sh | sh

# 2. 拉 Embedding 模型（约 274MB）
ollama pull nomic-embed-text

# 3. 拉生成模型（约 986MB，q4 量化）
ollama pull qwen2.5:1.5b

# 验证：能看到两个模型就绪
ollama list</code></pre>

<p><strong>怎么验证环境是好的：</strong></p>

<pre><code>curl http://localhost:11434/api/embeddings -d '{
  "model": "nomic-embed-text",
  "prompt": "退款政策是什么"
}' | head -c 200</code></pre>

<p>输出一串 768 个左右的浮点数（形如 <code>{"embedding":[0.013,-0.045,...]}</code>）就说明 Embedding 服务通了。这一步通了，后面所有事都是纯 Java。</p>

<h1 id="section-5">五、核心代码：不到 100 行</h1>

<h2 id="section-5-1">5.1 依赖与配置</h2>

<p><code>pom.xml</code> 关键部分（用 Spring AI 的 BOM 管版本）：</p>

<pre><code>&lt;dependencyManagement&gt;
  &lt;dependencies&gt;
    &lt;dependency&gt;
      &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
      &lt;artifactId&gt;spring-ai-bom&lt;/artifactId&gt;
      &lt;version&gt;1.0.1&lt;/version&gt;
      &lt;type&gt;pom&lt;/type&gt;
      &lt;scope&gt;import&lt;/scope&gt;
    &lt;/dependency&gt;
  &lt;/dependencies&gt;
&lt;/dependencyManagement&gt;

&lt;dependencies&gt;
  &lt;!-- Ollama：同一个 starter 同时提供 EmbeddingModel 和 ChatModel --&gt;
  &lt;dependency&gt;
    &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
    &lt;artifactId&gt;spring-ai-starter-model-ollama&lt;/artifactId&gt;
  &lt;/dependency&gt;
  &lt;!-- SimpleVectorStore --&gt;
  &lt;dependency&gt;
    &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
    &lt;artifactId&gt;spring-ai-starter-vector-store-simple&lt;/artifactId&gt;
  &lt;/dependency&gt;
&lt;/dependencies&gt;</code></pre>

<p><code>application.yml</code>：</p>

<pre><code>spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      embedding:
        model: nomic-embed-text
      chat:
        model: qwen2.5:1.5b
        options:
          temperature: 0.1   # RAG 要"照着原文说"，温度调低抑制发挥</code></pre>

<h2 id="section-5-2">5.2 全部业务代码（RagService + Controller）</h2>

<pre><code>@Service
public class RagService {

    private final VectorStore vectorStore;
    private final ChatModel chatModel;
    private static final TokenTextSplitter SPLITTER = new TokenTextSplitter();

    public RagService(VectorStore vectorStore, ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.chatModel = chatModel;
    }

    /** 入库：一段长文本 → 切块 → 向量化 → 存入向量库 */
    public int ingest(String title, String content) {
        Document doc = new Document(content, Map.of("title", title));
        List&lt;Document&gt; chunks = SPLITTER.apply(List.of(doc));
        vectorStore.add(chunks);          // 内部自动调 EmbeddingModel
        return chunks.size();
    }

    /** 检索：问题 → 向量 → Top-K 相关片段 */
    public List&lt;Document&gt; search(String question, int topK) {
        return vectorStore.similaritySearch(
                SearchQuery.builder().query(question).topK(topK).build());
    }

    /** 问答：检索结果拼 Prompt，交给大模型 */
    public String ask(String question) {
        List&lt;Document&gt; hits = search(question, 3);
        if (hits.isEmpty()) {
            return "知识库里没有找到相关内容。";
        }
        String context = hits.stream()
                .map(Document::getText)
                .collect(Collectors.joining("\n---\n"));
        String prompt = """
                仅根据下面的参考资料回答问题，找不到答案就说不知道，不要编造。

                参考资料：
                %s

                问题：%s
                """.formatted(context, question);
        return chatModel.call(prompt);
    }
}

@RestController
@RequestMapping("/api/rag")
public class RagController {

    private final RagService ragService;

    public RagController(RagService ragService) {
        this.ragService = ragService;
    }

    @PostMapping("/ingest")
    public Map&lt;String, Object&gt; ingest(@RequestBody Map&lt;String, String&gt; body) {
        int chunks = ragService.ingest(body.get("title"), body.get("content"));
        return Map.of("chunks", chunks);
    }

    @GetMapping("/ask")
    public Map&lt;String, String&gt; ask(@RequestParam String q) {
        return Map.of("answer", ragService.ask(q));
    }
}</code></pre>

<p>数一下：两个类加起来 <strong>不到 100 行 Java</strong>。切块用的 <strong>TokenTextSplitter</strong> 是 Spring AI 自带的分块器（按 token 数切，默认约 800 token 一块，块间有少量重叠），向量化和入库被 <code>vectorStore.add()</code> 一行代劳——它内部会自动调用配置好的 EmbeddingModel 把每块文本变成 768 维向量。</p>

<h1 id="section-6">六、验证：怎么证明它真的在干活</h1>

<p>灌几条测试知识（就拿本博客的历史文章当语料）：</p>

<pre><code>curl -X POST localhost:8080/api/rag/ingest -H 'Content-Type: application/json' -d '{
  "title": "G1 vs ZGC",
  "content": "G1 是 JDK9 之后的默认垃圾回收器，把堆切成 Region 分批回收，停顿几十毫秒。分代 ZGC 把标记整理改成并发执行，停顿亚毫秒级，代价是吞吐下降约 8.5%、内存多开销 5~10%。延迟敏感选 ZGC，吞吐优先选 G1。"
}'
# 返回 {"chunks":1}</code></pre>

<p><strong>验证一：检索是否命中正确的块。</strong>问一个与原文措辞不同的问题，看召回的 chunk 是不是那一条（关键测试：字面不重合、语义重合）：</p>

<pre><code># 在 RagService 里临时打印 hits，或直接观察回答
curl 'localhost:8080/api/rag/ask?q=接口偶尔卡一下和垃圾回收器有关系吗'
# 期望回答提到 G1/ZGC 停顿差异，而不是"不知道"——说明"卡顿"命中了"停顿"的语义</code></pre>

<p><strong>验证二：负例。</strong>问一个知识库里根本没有的问题（比如"公司年假几天"），期望回答"没有找到相关内容"——RAG <em>没有</em>编造，这才是可控的。</p>

<p><strong>验证三：延迟账单。</strong>用 wrk 压 <code>/api/rag</code> 的纯检索路径（1000 个 chunk 的库），各取 5000 请求：</p>

| 环节 | P50 | P95 | 备注 |
|---|---|---|---|
| 本地 Embedding（单条短文本） | 11ms | 18ms | nomic-embed-text，CPU |
| 向量检索（1000 chunk 暴力扫） | 14ms | 39ms | SimpleVectorStore，纯内存 |
| 检索 + 生成（约 120 token 回答） | 9.4s | 15.8s | qwen2.5:1.5b，CPU 是瓶颈 |

<p>结论一目了然：<strong>检索侧毫秒级，便宜得像不要钱；贵和慢全在生成侧</strong>。这直接决定优化方向——生成侧做流式输出（SSE）掩盖首字延迟，检索侧根本不用优化，除非库到百万级。</p>

<h1 id="section-7">七、把账算全：本地模型 vs 云 API</h1>

<p>全本地不是银弹，两种路线的取舍（价格为 2026-10 写稿时公开定价，以官网为准）：</p>

| 维度 | 本地（Ollama + nomic/bge） | 云 API（如 OpenAI text-embedding-3-small、阿里云百炼 text-embedding-v3） |
|---|---|---|
| 单价 | 0，吃自己机器 | Embedding 约 $0.02/百万 token 上下；Chat 更贵一个量级 |
| 延迟 | 单条 10~20ms，稳定 | 20~200ms，受网络波动 |
| 中文/多语质量 | nomic 一般，换 <code>bge-m3</code> 明显更好 | 主流商用模型质量普遍更好 |
| 数据合规 | 出不了内网，天然合规 | 数据要出边界，金融/政务场景一票否决 |
| 运维成本 | 要管模型进程和内存 | 要管 Key、限流、账单 |

<p>实操建议：内网合规敏感用本地 + <code>bge-m3</code>（Ollama 直接 <code>ollama pull bge-m3</code>，1024 维）；对效果要求高、数据不敏感、量又大，用云 API，Spring AI 下换模型只改 <code>application.yml</code> 两行——这就是当初选统一抽象的回报。</p>

<h1 id="section-8">八、常见坑（每个都真踩过）</h1>

<p><strong>坑一：切块大小拍脑袋。</strong>块切太小（一两百字），上下文支离破碎，召回回来的片段"看得懂每个字，连不成一句话"；切太大（两三千字），一个向量塞了五个主题，语义被稀释，检索精度暴跌。经验起点：300~500 中文字、块间重叠 10%~20%，再按召回效果微调。<strong>验证方法</strong>：固定 20 条测试问题，对比不同块大小下的 Top-3 命中率，别凭感觉。</p>

<p><strong>坑二：中文语料配了英文向量化模型。</strong>nomic-embed-text 以英文为主，中文效果平平，表现为"召回的块总是不太对但说不上哪里错"。换 <code>bge-m3</code> 或云上中文模型即可，注意<strong>换了 Embedding 模型必须全库重灌</strong>——新旧向量不在同一个语义空间里，混着用等于把北京坐标和上海坐标画在同一张地图上。</p>

<p><strong>坑三：忘做持久化，重启全丢。</strong>SimpleVectorStore 在内存里，进程一重启，知识库清零。启动时 <code>load(file)</code>、入库后 <code>save(file)</code> 落成 JSON 文件；或者干脆上 pgvector。</p>

<p><strong>坑四：生成模型自由发挥。</strong>默认温度下小模型爱"脑补"。Prompt 里写死"仅根据参考资料回答，找不到就说不知道"，temperature 压到 0.1~0.3。验证方法：用坑二那种"库里没有的问题"做负例回归。</p>

<p><strong>坑五：Top-K 和上下文长度打架。</strong>Top-K 拉满 10 条，相关不相关的全塞给模型，一来小模型上下文有限直接截断，二来噪音拉低回答质量。从 K=3 起步，按命中率调，别上来就梭哈。</p>

<p><strong>坑六：2C4G 上生成模型把机器吃满，检索超时。</strong>CPU 被生成占满时，同进程的向量检索 P95 从 39ms 飙到 300ms+。缓解：生成换更小的模型、限制并发、或者干脆把生成拆到别的机器——检索和应用留在一起。</p>

<h1 id="section-9">九、总结</h1>

<ul>
<li>RAG 三板斧：<strong>切块 → 向量化 → 召回</strong>，检索侧是"听得懂 + 找得快"，生成侧才是成本和延迟的大头。</li>
<li>Spring AI + Ollama 可以<strong>零 Key、零 Python</strong> 地搭出生产级雏形，核心代码不到 100 行，内网可跑。</li>
<li>SimpleVectorStore 适合验证思路；百万级换 pgvector，再往上换 Milvus/ES。换了 Embedding 模型，全库必须重灌。</li>
<li>优化优先级：先用负例回归把幻觉摁住，再做流式输出掩盖生成延迟，最后才考虑动检索。</li>
</ul>

<p>下一篇计划把这篇的 Demo 换成 pgvector + 真实 PDF 语料（PDF 解析在 Java 里也是一坑），顺便聊聊表格类内容的切块策略。</p>

<h1 id="section-10">参考资料</h1>

<ol>
<li>Spring AI 官方文档（Embeddings / Vector Stores / Ollama 章节）：<a href="https://docs.spring.io/spring-ai/reference/" target="_blank">https://docs.spring.io/spring-ai/reference/</a></li>
<li>Ollama 官方仓库（安装与模型库）：<a href="https://github.com/ollama/ollama" target="_blank">https://github.com/ollama/ollama</a></li>
<li>Milvus 中文官方文档（向量检索与相似度度量）：<a href="https://milvus.io/docs" target="_blank">https://milvus.io/docs</a></li>
<li>阿里云百炼·文本向量（国内商用 Embedding 模型与定价）：<a href="https://help.aliyun.com/zh/model-studio/" target="_blank">https://help.aliyun.com/zh/model-studio/</a></li>
<li>pgvector（PostgreSQL 向量插件）：<a href="https://github.com/pgvector/pgvector" target="_blank">https://github.com/pgvector/pgvector</a></li>
<li>LangChain4j 官方 RAG 教程（Java 侧另一条路线，结构可对照）：<a href="https://docs.langchain4j.dev/tutorials/rag" target="_blank">https://docs.langchain4j.dev/tutorials/rag</a></li>
</ol>
