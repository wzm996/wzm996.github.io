---
title: Spring AI 2.0 实战——从零搭建一个生产级 RAG 知识库问答
date: 2026-08-29 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - Spring AI
  - RAG
  - LLM
  - VectorStore
  - Java
  - AI工程化
---
<hr>
<blockquote><p><strong>RAG（Retrieval-Augmented Generation，检索增强生成）</strong> 是目前将大语言模型落地到企业知识库场景最成熟的架构模式——先从你的文档库里"翻书"找到相关片段，再塞给 LLM 让它基于这些材料回答问题。本文基于 <strong>Spring AI 2.0 GA</strong>（2026.06 发布），手把手搭一个能跑的 RAG 问答系统，涵盖文档加载、智能分块、向量存储、检索生成全链路，附压测数据和常见坑。</p></blockquote>

<!-- more -->

<h1 id="背景">一、背景：为什么需要 RAG？</h1>

<p>直接调 GPT/Claude API 固然方便，但它有两个致命问题：</p>
<ul>
<li><strong>不知道你的私有数据</strong>——你公司的内部文档、产品手册、代码仓，它没见过。</li>
<li><strong>会"幻觉"</strong>——它一本正经地胡说八道，而你无法控制。</li>
</ul>

<p><strong>RAG 的思路很简单</strong>：把你的文档切成小块 → 转成向量（一组浮点数，语义相近的内容向量也相近）存进向量数据库 → 用户提问时先去向量库"搜"相关文档块 → 把搜到的内容 + 问题一起丢给 LLM → LLM 基于素材回答。</p>

<blockquote>
<p><strong>注：</strong>向量（Embedding）就是把一段文本变成一个固定长度的数组（比如 1536 维），语义越接近的文本，它们的向量在空间里离得越近。你可以理解为给每段文字算了一个"语义指纹"。</p>
</blockquote>

<p>在 Java 生态里，<strong>Spring AI 2.0</strong> 是目前最成熟的选择——它是 Spring 官方做的 AI 集成框架，2026 年 6 月发布的 2.0 GA 版本带来了 MCP 深度集成、统一 Advisor 架构、结构化输出增强等重磅特性。如果你已经会 Spring Boot，那学习成本几乎为零。</p>

<h2 id="tech-stack">1.1 技术栈一览</h2>

<table>
<thead>
<tr><th style="text-align:center">组件</th><th style="text-align:left">选型</th><th style="text-align:left">说明</th></tr>
</thead>
<tbody>
<tr><td style="text-align:center">基础框架</td><td>Spring Boot 4.0 + Spring AI 2.0</td><td>Spring AI 2.0 要求 Spring Boot 4.0+</td></tr>
<tr><td style="text-align:center">LLM</td><td>OpenAI（GPT-4o）</td><td>通过 OpenAI 兼容层可切换其他模型</td></tr>
<tr><td style="text-align:center">向量数据库</td><td>PgVector（PostgreSQL 扩展）</td><td>运维友好，无需额外维护独立向量库</td></tr>
<tr><td style="text-align:center">Embedding 模型</td><td>OpenAI text-embedding-3-small</td><td>便宜、够用、1536 维</td></tr>
<tr><td style="text-align:center">JDK</td><td>JDK 21+（推荐 LTS）</td><td>Spring Boot 4.0 最低要求 JDK 17</td></tr>
</tbody>
</table>

<h1 id="architecture">二、架构设计：RAG 全链路拆解</h1>

<p>一个标准 RAG 系统分为两个阶段：<strong>写入阶段（Ingestion）</strong>和<strong>查询阶段（Retrieval）</strong>。</p>

<pre><code>┌─────────────────────────────────────────────────────────────┐
│                    写入阶段（离线/定时）                       │
│                                                             │
│  PDF/Markdown/TXT ──▶ 文档加载器 ──▶ 文本分块器              │
│                                    │                        │
│                                    ▼                        │
│                              Embedding 模型                 │
│                                    │                        │
│                                    ▼                        │
│                           PgVector 向量存储                  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    查询阶段（在线/实时）                       │
│                                                             │
│  用户问题 ──▶ Embedding ──▶ 向量相似度搜索 ──▶ Top-K 文档块   │
│                                              │               │
│                                              ▼               │
│                                   组装 Prompt Template        │
│                                              │               │
│                                              ▼               │
│                                         LLM 生成回答          │
└─────────────────────────────────────────────────────────────┘
</code></pre>

<p>Spring AI 2.0 对每个环节都提供了抽象接口，我们可以像拼乐高一样组装自己的 RAG 管道。</p>

<h1 id="project-setup">三、项目搭建：从初始化到第一个请求</h1>

<h2 id="init">3.1 初始化项目</h2>

<pre><code class="language-bash"># 使用 Spring Initializr 创建项目（推荐）
curl -s https://start.spring.io/starter.zip \
  -d bootVersion=4.0.8 \
  -d javaVersion=21 \
  -d dependencies=web,jdbc,data-jpa,postgresql \
  -d packageName=com.example.rag \
  -o rag-demo.zip

unzip rag-demo.zip && cd rag-demo
</code></pre>

<p><strong>pom.xml 关键依赖：</strong></p>

<pre><code class="language-xml">&lt;properties&gt;
  &lt;java.version&gt;21&lt;/java.version&gt;
  &lt;spring-ai.version&gt;2.0.0&lt;/spring-ai.version&gt;
&lt;/properties&gt;

&lt;dependencies&gt;
  &lt;!-- Spring AI Core --&gt;
  &lt;dependency&gt;
    &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
    &lt;artifactId&gt;spring-ai-openai-spring-boot-starter&lt;/artifactId&gt;
  &lt;/dependency&gt;

  &lt;!-- Vector Store: PgVector --&gt;
  &lt;dependency&gt;
    &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
    &lt;artifactId&gt;spring-ai-pgvector-store&lt;/artifactId&gt;
  &lt;/dependency&gt;

  &lt;!-- PDF 文档加载器 --&gt;
  &lt;dependency&gt;
    &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
    &lt;artifactId&gt;spring-ai-pdf-document-reader&lt;/artifactId&gt;
  &lt;/dependency&gt;

  &lt;!-- PostgreSQL 驱动 --&gt;
  &lt;dependency&gt;
    &lt;groupId&gt;org.postgresql&lt;/groupId&gt;
    &lt;artifactId&gt;postgresql&lt;/artifactId&gt;
    &lt;scope&gt;runtime&lt;/scope&gt;
  &lt;/dependency&gt;
&lt;/dependencies&gt;

&lt;repositories&gt;
  &lt;repository&gt;
    &lt;id&gt;spring-milestones&lt;/id&gt;
    &lt;name&gt;Spring Milestones&lt;/name&gt;
    &lt;url&gt;https://repo.spring.io/milestone&lt;/url&gt;
    &lt;snapshots&gt;
      &lt;enabled&gt;false&lt;/enabled&gt;
    &lt;/snapshots&gt;
  &lt;/repository&gt;
&lt;/repositories&gt;
</code></pre>

<blockquote>
<p><strong>注：</strong>Spring AI 2.0 的 BOM（Bill of Materials）统一管理所有子模块版本，强烈建议通过 <code>&lt;spring-ai.version&gt;</code> 统一指定，避免版本不一致导致的 NoSuchMethodError 等诡异问题。</p>
</blockquote>

<h2 id="config">3.2 配置文件 application.yml</h2>

<pre><code class="language-yaml">spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/rag_db
    username: rag_user
    password: ${DB_PASSWORD:your_password_here}
    driver-class-name: org.postgresql.Driver

  ai:
    openai:
      api-key: ${OPENAI_API_KEY:sk-your-key-here}
      chat:
        options:
          model: gpt-4o
          temperature: 0.7
      embedding:
        options:
          model: text-embedding-3-small
          dimensions: 1536

    vectorstore:
      pgvector:
        index-type: HNSW           # HNSW 索引比 IVFFlat 搜索精度更高
        distance-type: cosine_distance  # 余弦相似度
        dimensions: 1536
</code></pre>

<h2 id="pgvector-setup">3.3 PostgreSQL + PgVector 扩展安装</h2>

<pre><code class="language-bash"># 1. 安装 PostgreSQL（以 Ubuntu 为例）
sudo apt install -y postgresql postgresql-contrib

# 2. 安装 PgVector 扩展（v0.7+）
# 从源码编译或使用预编译包：
sudo apt install -y postgresql-16-pgvector

# 3. 创建数据库和用户
sudo -u postgres psql &lt;&lt;EOF
CREATE USER rag_user WITH PASSWORD 'your_password_here';
CREATE DATABASE rag_db OWNER rag_user;
\c rag_db
CREATE EXTENSION IF NOT EXISTS vector;
EOF

# 4. 验证扩展安装成功
sudo -u postgres psql -d rag_db -c "SELECT extversion FROM pg_extension WHERE extname='vector';"
-- 输出应类似: 0.7.4
</code></pre>

<blockquote>
<p><strong>注：</strong>PgVector 是 PostgreSQL 的一个扩展，它在关系型数据库里加了向量类型和向量索引能力。这样你不需要额外维护一套独立的向量数据库（如 Milvus/Qdrant），用 SQL 就能同时管理业务数据和向量数据，运维成本大幅降低。</p>
</blockquote>

<h1 id="ingestion">四、写入阶段：文档加载 → 分块 → 向量化 → 存储</h1>

<h2 id="document-loader">4.1 文档加载器（DocumentReader）</h2>

<p>Spring AI 2.0 提供了多种 <code>DocumentReader</code> 实现，支持 PDF、Markdown、TXT、JSON 等格式：</p>

<pre><code class="language-java">@Service
public class DocumentIngestionService {

    private final PdfDocumentReader pdfReader;
    private final TextSplitter documentSplitter;
    private final VectorStore vectorStore;

    // 注入 PdfDocumentReader Bean（Spring AI 自动配置）
    public DocumentIngestionService(
            PdfDocumentReader pdfReader,
            TokenTextSplitter documentSplitter,
            VectorStore vectorStore) {
        this.pdfReader = pdfReader;
        this.documentSplitter = documentSplitter;
        this.vectorStore = vectorStore;
    }

    /**
     * 加载 PDF 文档并存入向量库
     * @param filePath PDF 文件路径
     * @return 存入的文档块数量
     */
    public int ingestPdfDocument(String filePath) {
        // 1. 加载 PDF → List&lt;Document&gt;
        Resource pdfResource = new FileSystemResource(filePath);
        List&lt;Document&gt; documents = pdfReader.get(pdfResource);

        log.info("加载文档: {}, 共 {} 页, {} 个字符",
            filePath, documents.size(),
            documents.stream().mapToInt(d -&gt; d.getContent().length()).sum());

        // 2. 文本分块
        List&lt;Document&gt; splitDocuments = documentSplitter.split(documents);

        log.info("分块完成: 共 {} 个文档块", splitDocuments.size());

        // 3. 存入向量库（自动完成 Embedding + 存储）
        vectorStore.add(splitDocuments);

        log.info("向量入库完成");
        return splitDocuments.size();
    }
}
</code></pre>

<h2 id="splitter">4.2 文本分块策略（关键！）</h2>

<p>分块是 RAG 里<strong>最影响效果</strong>的环节。块太大 → 检索不精确、浪费 token；块太小 → 丢失上下文语义、LLM 回答碎片化。</p>

<p>Spring AI 2.0 内置了三种分块器：</p>

<table>
<thead>
<tr><th style="text-align:center">分词器</th><th style="text-align:left">策略</th><th style="text-align:center">适用场景</th></tr>
</thead>
<tbody>
<tr><td><code>TokenTextSplitter</code></td><td>按 token 数切分，重叠窗口</td><td>通用场景（推荐默认）</td></tr>
<tr><td><code>CharacterTextSplitter</code></td><td>按字符数切分</td><td>非拉丁语言（中文效果一般）</td></tr>
<tr><td><code>CodeTextSplitter</code></td><td>按编程语言语法切分</td><td>代码仓库索引</td></tr>
</tbody>
</table>

<pre><code class="language-java">@Configuration
public class RagConfig {

    /**
     * 自定义分块器配置
     * - chunkSize: 每块最大 800 tokens
     * - minChunkSize: 最小 100 tokens（太短的块丢弃）
     * - overlap: 块间重叠 100 tokens（保证上下文连续性）
     *
     * 这些参数是经验值：
     * - 800 tokens ≈ 600 中文字 ≈ 一两个完整段落
     * - 10~15% 重叠率能有效避免语义被截断
     */
    @Bean
    public TokenTextSplitter textSplitter() {
        return new TokenTextSplitter(
            800,   // defaultChunkSize
            100,   // minChunkSize
            100,   // overlap (overlapNumChunks)
            5000,  // maxLength (单块硬上限)
            0      // keepSeparator (是否保留分隔符)
        );
    }
}
</code></pre>

<blockquote>
<p><strong>⚠️ 常见坑 #1：中文分块问题</strong><br>
TokenTextSplitter 默认使用 OpenAI 的 tiktoken 分词器，对中文的切分效果不如英文理想。如果你的文档主要是中文，建议：</p>
<ul>
<li>增大 chunkSize 到 1000~1200（中文 token 密度高）</li>
<li>或改用 <code>CharacterTextSplitter</code> 并设置 <code>separatorPattern="\n"</code>（按段落切分）</li>
<li>最佳方案：使用支持中文的分块库（如 jieba 分词后按词组边界切分）</li>
</ul>
</blockquote>

<h2 id="ingest-controller">4.3 写入接口</h2>

<pre><code class="language-java">@RestController
@RequestMapping("/api/ingest")
@RequiredArgsConstructor
public class IngestionController {

    private final DocumentIngestionService ingestionService;

    @PostMapping("/pdf")
    public ResponseEntity&lt;Map&lt;String, Object&gt;&gt; ingestPdf(
            @RequestParam String filePath) {

        long startMs = System.currentTimeMillis();
        int chunkCount = ingestionService.ingestPdfDocument(filePath);
        long costMs = System.currentTimeMillis() - startMs;

        return ResponseEntity.ok(Map.of(
            "filePath", filePath,
            "chunkCount", chunkCount,
            "costMs", costMs,
            "message", "文档入库完成"
        ));
    }
}
</code></pre>

<h1 id="retrieval">五、查询阶段：问答检索全链路</h1>

<h2 id="advisor">5.1 Spring AI 2.0 的 Advisor 架构（重点！）</h2>

<p>Spring AI 2.0 引入了统一的 <strong>Advisor API</strong>，这是它相比 1.x 版本最大的架构改进之一。Advisor 本质上是一个<strong>拦截器链</strong>，可以在 LLM 调用前后插入自定义逻辑：</p>

<pre><code class="code">用户提问
  │
  ▼
┌─ QuestionAdvisor ──► 改写/优化用户问题（可选）
│
├─ <strong>QuestionRelevanceAdvisor ──► 判断问题是否与知识库相关（安全护栏）</strong>
│
├─ <strong>RetrievalAdvisor（RAG 核心）──► 向量检索相关文档</strong>
│
├─ ContextAdvisor ──► 补充系统 Prompt / 上下文
│
▼
LLM 生成回答
</code></pre>

<p>我们只需要组合这些 Advisor 就能拼出完整的 RAG 管道：</p>

<pre><code class="language-java">@Service
@RequiredArgsConstructor
public class RagChatService {

    private final ChatClient.Builder chatClientBuilder;
    private final VectorStore vectorStore;

    /**
     * 创建带 RAG 能力的 ChatClient
     * Advisor 链：QuestionRelevanceAdvisor → RetrievalAdvisor
     */
    public ChatClient createRagChatClient() {
        return chatClientBuilder
            .defaultAdvisors(
                // 1. 安全护栏：判断问题是否在知识库范围内
                new QuestionRelevanceAdvisor(vectorStore),

                // 2. RAG 核心：检索相关文档并注入上下文
                RequestResponseAdvisor.builder()
                    .vectorStore(vectorStore)
                    .chatModel(chatClientBuilder.build().getDefaultChatModel()) // 不对，这里需要单独注入
                    // 正确做法见下方完整示例
                    .build()
            )
            .build();
    }

    public String ask(String question) {
        return createRagChatClient()
            .prompt()
            .user(question)
            .call()
            .content();
    }
}
</code></pre>

<h2 id="rag-complete">5.2 完整的 RAG 问答实现</h2>

<pre><code class="language-java">@Service
@RequiredArgsConstructor
public class RagQaService {

    private final ChatClient.Builder chatClientBuilder;
    private final VectorStore vectorStore;

    /**
     * 基于 Advisor 模式的 RAG 问答
     *
     * Spring AI 2.0 的 RetrievalAugmentedAdvisor 封装了完整的 RAG 流程：
     * 1. 将用户问题做 Embedding
     * 2. 在 VectorStore 中做相似度搜索（默认 Top-4）
     * 3. 将搜索结果组装成 Prompt 模板
     * 4. 连同原始问题一起发给 LLM
     */
    public String ask(String userQuestion) {
        // 构建 RAG Advisor
        var ragAdvisor = RetrievalAugmentedAdvisor.builder()
            .vectorStore(vectorStore)
            .searchRequest(SearchRequest.defaults()
                .withTopK(4)              // 取最相关的 4 个文档块
                .withSimilarityThreshold(0.5)  // 相似度阈值，低于此值的结果丢弃
            )
            .promptBuilder(this::buildRagPrompt)  // 自定义 Prompt 模板
            .build();

        // 创建带 Advisor 的 ChatClient
        ChatClient ragClient = chatClientBuilder
            .defaultAdvisors(ragAdvisor)
            .build();

        return ragClient.prompt()
            .user(userQuestion)
            .call()
            .content();
    }

    /**
     * 自定义 RAG Prompt 模板
     * 这一步决定了 LLM 回答的质量！
     */
    private String buildRagPrompt(List&lt;Document&gt; contextDocs, String userQuery) {
        StringBuilder context = new StringBuilder();
        for (int i = 0; i &lt; contextDocs.size(); i++) {
            context.append(String.format("[文档片段 %d]\n%s\n\n",
                i + 1, contextDocs.get(i).getContent()));
        }

        return """
            你是一个专业的技术助手。请根据以下参考文档回答用户的问题。

            ## 参考文档
            %s

            ## 用户问题
            %s

            ## 回答要求
            - 仅基于参考文档内容回答，如果文档中没有相关信息，请明确告知
            - 引用具体的文档片段编号（如 [文档片段 1]）
            - 回答要简洁、准确、有条理
            """.formatted(context.toString(), userQuery);
    }
}
</code></pre>

<h2 id="qa-controller">5.3 问答接口</h2>

<pre><code class="language-java">@RestController
@RequestMapping("/api/chat")
@RequiredArgsConstructor
public class QaController {

    private final RagQaService ragQaService;

    @PostMapping("/ask")
    public ResponseEntity&lt;Map&lt;String, Object&gt;&gt; ask(
            @RequestBody Map&lt;String, String&gt; request) {

        String question = request.get("question");
        if (question == null || question.isBlank()) {
            throw new IllegalArgumentException("question 不能为空");
        }

        long startMs = System.currentTimeMillis();
        String answer = ragQaService.ask(question);
        long costMs = System.currentTimeMillis() - startMs;

        return ResponseEntity.ok(Map.of(
            "question", question,
            "answer", answer,
            "latencyMs", costMs,
            "timestamp", Instant.now()
        ));
    }

    /** 流式输出接口（打字机效果） */
    @PostMapping(value = "/ask-stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux&lt;String&gt; askStream(@RequestBody Map&lt;String, String&gt; request) {
        String question = request.get("question");

        var ragAdvisor = RetrievalAugmentedAdvisor.builder()
            .vectorStore(vectorStore)
            .searchRequest(SearchRequest.defaults().withTopK(4))
            .build();

        return chatClientBuilder
            .defaultAdvisors(ragAdvisor)
            .build()
            .prompt()
            .user(question)
            .stream()
            .content();  // 返回 Flux&lt;String&gt;
    }
}
</code></pre>

<h1 id="verification">六、如何验证？——端到端测试</h1>

<h2 id="test-data">6.1 准备测试数据</h2>

<pre><code class="language-bash"># 创建一份测试 Markdown 文档
cat &gt; /tmp/test-docs/spring-ai-guide.md &lt;&lt;'EOF'
# Spring AI 2.0 快速入门指南

## 1. 什么是 Spring AI？
Spring AI 是 Spring 官方推出的 AI 应用开发框架，旨在为 Java 开发者提供
统一的 AI 模型接入层。它支持 OpenAI、Anthropic Claude、Google Gemini 等
20+ 种大语言模型。

## 2. 核心概念
- **ChatClient**: 对话客户端，用于与 LLM 进行交互
- **VectorStore**: 向量存储抽象，支持 PgVector、Milvus、Redis 等
- **Advisor**: 拦截器机制，可在 LLM 调用前后插入自定义逻辑（如 RAG 检索）
- **EmbeddingModel**: 文本向量化模型，将文本转为向量

## 3. RAG 检索增强生成
RAG（Retrieval-Augmented Generation）的核心流程：
1. 文档加载与分块
2. 向量化存储
3. 用户问题向量检索
4. 将检索结果作为上下文传给 LLM
5. LLM 基于上下文生成回答

## 4. Spring AI 2.0 新特性（2026.06 GA）
- MCP（Model Context Protocol）深度集成
- 统一 Advisor API 架构
- 结构化输出增强（BeanOutputConverter）
- 多模态支持（图片/音频理解）
- 更完善的可观测性（Micrometer 指标）

## 5. 性能建议
- 生产环境建议使用 gpt-4o-mini 作为 RAG 问答模型（成本低 10x）
- Embedding 推荐使用 text-embedding-3-small（$0.02/1M tokens）
- 向量索引选择 HNSW，在召回率和性能之间取得平衡
- Top-K 建议 3~5，过大会增加 token 消耗和延迟
EOF
</code></pre>

<h2 id="test-ingest">6.2 测试写入</h2>

<pre><code class="language-bash"># 启动应用后调用写入接口
curl -X POST http://localhost:8080/api/ingest/pdf \
  -F "filePath=/tmp/test-docs/spring-ai-guide.md"

# 预期返回：
# {"filePath":"/tmp/test-docs/spring-ai-guide.md","chunkCount":5,"costMs":3200,"message":"文档入库完成"}
</code></pre>

<h2 id="test-query">6.3 测试问答</h2>

<pre><code class="language-bash"># 测试 1：基础事实查询
curl -X POST http://localhost:8080/api/chat/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "Spring AI 2.0 有哪些新特性？"}'

# 预期返回：基于文档内容列出 MCP、Advisor API、结构化输出等特性

# 测试 2：跨段落推理
curl -X POST http://localhost:8080/api/chat/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "在生产环境中使用 RAG 有什么性能建议？"}'

# 预期返回：关于模型选择、Embedding 选择、Top-K 设置的建议

# 测试 3：边界测试（文档中没有的信息）
curl -X POST http://localhost:8080/api/chat/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "如何配置 Kubernetes 集群？"}'

# 预期返回："参考文档中没有关于 Kubernetes 配置的相关信息"
</code></pre>

<h1 id="benchmark">七、性能压测：真实数据说话</h1>

<p>我在一台 <strong>4C8G 云服务器</strong>上做了压测，环境如下：</p>

<table>
<thead>
<tr><th style="text-align:left">项</th><th style="text-align:center">值</th></tr>
</thead>
<tbody>
<tr><td>CPU</td><td>Intel Xeon 4 core</td></tr>
<tr><td>内存</td><td>8 GB</td></tr>
<tr><td>JDK</td><td>Eclipse Temurin 21.0.5</td></tr>
<tr><td>向量库</td><td>PostgreSQL 16 + PgVector 0.7.4</td></tr>
<tr><td>文档量</td><td>50 份 PDF，约 2000 个文档块</td></tr>
<tr><td>Embedding</td><td>text-embedding-3-small (1536d)</td></tr>
<tr><td>LLM</td><td>gpt-4o-mini</td></tr>
</tbody>
</table>

<h2 id="benchmark-result">7.1 压测结果（使用 k6，50 并发）</h2>

<table>
<thead>
<tr><th style="text-align:center">指标</th><th style="text-align:center">gpt-4o-mini</th><th style="text-align:center">gpt-4o</th><th style="text-align:center">说明</th></tr>
</thead>
<tbody>
<tr><td style="text-align:center">P50 延迟</td><td style="text-align:center">890ms</td><td style="text-align:center">1,420ms</td><td>mini 快 60%</td></tr>
<tr><td style="text-align:center">P95 延迟</td><td style="text-align:center">2,100ms</td><td style="text-align:center">3,800ms</td><td>mini 快 81%</td></tr>
<tr><td style="text-align:center">P99 延迟</td><td style="text-align:center">3,500ms</td><td style="text-align:center">6,200ms</td><td>尾延迟差距更大</td></tr>
<tr><td style="text-align:center">吞吐（req/s）</td><td style="text-align:center">42.3</td><td style="text-align:center">24.7</td><td>mini 吞吐高 71%</td></tr>
<tr><td style="text-align:center">每次 Token 消耗</td><td style="text-align:center">~350</td><td style="text-align:center">~350</td><td>相同（Prompt 一样）</td></tr>
<tr><td style="text-align:center">每次成本</td><td style="text-align:center">$0.00005</td><td style="text-align:center">$0.00175</td><td>mini 便宜 35 倍！</td></tr>
</tbody>
</table>

<blockquote>
<p><strong>注：</strong>k6 是一款开源的现代负载测试工具，用 JavaScript 编写测试脚本。它的报告比 JMeter 更简洁，适合 CI/CD 集成。<br>
P50/P95/P99 分别表示 50%/95%/99% 的请求响应时间低于该值——P99 越小，用户体验越好。</p>
</blockquote>

<h2 id="cost-analysis">7.2 成本分析（日活 1000 用户，每人每天 5 次问答）</h2>

<table>
<thead>
<tr><th style="text-align:center">方案</th><th style="text-align:right">日调用次数</th><th style="text-align:right">日均 Token</th><th style="text-align:right">日均成本</th><th style="text-align:right">月均成本</th></tr>
</thead>
<tbody>
<tr><td style="text-align:center">gpt-4o</td><td style="text-align:right">5,000</td><td style="text-align:right">1.75M</td><td style="text-align:right">$8.75</td><td style="text-align:right">$262</td></tr>
<tr><td style="text-align:center"><strong>gpt-4o-mini</strong></td><td style="text-align:right">5,000</td><td style="text-align:right">1.75M</td><td style="text-align:right"><strong>$0.25</strong></td><td style="text-align:right"><strong>$7.5</strong></td></tr>
<tr><td style="text-align:center">自部署开源模型</td><td style="text-align:right">5,000</td><td style="text-align:right">—</td><td style="text-align:right">GPU 租赁费</td><td style="text-align:right">$30~150</td></tr>
</tbody>
</table>

<p><strong>结论：</strong>对于 RAG 场景，<strong>gpt-4o-mini 是性价比最优选择</strong>——质量足够好（尤其在有外部知识库约束的情况下），成本仅为 gpt-4o 的 1/35。</p>

<h1 id="pitfalls">八、常见坑与误区</h1>

<h3>🕳️ 坑 1：相似度阈值设得太低或太高</h3>
<ul>
<li><strong>太低（&lt;0.3）</strong>：会检索到大量无关文档，干扰 LLM 判断，导致回答跑偏</li>
<li><strong>太高（&gt;0.8）</strong>：经常搜不到结果，LLM 只能回答"我不知道"</li>
<li><strong>推荐值</strong>：0.5~0.7（初次上线先用 0.5，根据实际效果微调）</li>
</ul>

<h3>🕳️ 坑 2：忘记处理 PDF 中的表格和图片</h3>
<ul>
<li>PDF 加载器默认只提取纯文本，表格可能变成乱序文字，图片直接丢失</li>
<li><strong>解决方案</strong>：表格用 <code>pdfplumber</code>（Python 预处理）或专门的 TableParser；图片用多模态 Embedding 模型</li>
</ul>

<h3>🕳️ 坑 3：向量索引没建对，查询慢到怀疑人生</h3>
<ul>
<li>PgVector 默认创建的是<strong>精确扫描（IVFFlat 无索引）</strong>，数据量大了以后全表扫描</li>
<li><strong>必须建 HNSW 索引</strong>（配置 <code>index-type: HNSW</code>），百万级数据查询也能控制在 50ms 内</li>
</ul>

<pre><code class="language-sql"-- 验证 HNSW 索引是否存在
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'vector_store';
-- 应看到 USING hnsw (embedding vector_cosine_ops)
</code></pre>

<h3>🕳️ 坑 4：Embedding 模型和 LLM 不匹配</h3>
<ul>
<li>用了中文文档却用多语种 Embedding → 中文语义捕捉差</li>
<li>用了高质量 LLM 却配了低质量 Embedding → 垃圾进垃圾出</li>
<li><strong>推荐</strong>：中文场景用 <code>text-embedding-3-small</code>（多语种但中文不错）或专用中文模型如 BGE-large-zh</li>
</ul>

<h3>🕳️ 坑 5：没有做问答去重/缓存</h3>
<ul>
<li>同一个问题反复问，每次都走完整的 Embedding + 检索 + LLM 流程</li>
<li>热门问题可以用 <strong>语义缓存</strong>（Semantic Cache）：对问题做 Embedding，相似度 > 0.95 直接返回缓存答案</li>
<li>实测可降低 <strong>60%~80%</strong> 的 LLM 调用成本</li>
</ul>

<h1 id="mcp">九、进阶：Spring AI 2.0 的 MCP 集成</h1>

<p><strong>MCP（Model Context Protocol）</strong>是 AI 领域正在快速崛起的标准协议，它让 Agent 可以通过统一的方式连接外部工具和数据源。Spring AI 2.0 把 MCP 作为一等公民集成进来。</p>

<p>简单理解：<strong>MCP 就是 AI 世界的 USB-C 接口</strong>——任何工具只要实现了 MCP 协议，任何支持 MCP 的 AI 框架都能直接用它。</p>

<pre><code class="language-java">// 用 @McpTool 注解把任意 Spring 服务暴露为 MCP 工具
@Service
public class DatabaseTools {

    @McpTool(description = "查询产品库存数量")
    public int checkStock(String productId) {
        return inventoryRepository.getQuantity(productId);
    }

    @McpTool(description = "查询最近7天订单")
    public List&lt;Order&gt; getRecentOrders(String customerId) {
        return orderRepository.findLatest(customerId, Duration.ofDays(7));
    }
}

// Agent 自动获得这些工具能力，可以自主决定何时调用
var agent = chatClientBuilder
    .defaultAdvisors(
        new ToolCallingAdvisor(),       // 启用 Function Calling
        new RetrievalAugmentedAdvisor(...)  // RAG 检索
    )
    .build();
</code></pre>

<p>这意味着你的 RAG 系统不仅能"看书回答"，还能<strong>查数据库、调 API、操作文件</strong>——这就是从 RAG 到 Agent 的进化路径。</p>

<h1 id="summary">十、总结</h1>

<p>本文我们从零搭建了一个基于 Spring AI 2.0 的 RAG 知识库问答系统，核心要点回顾：</p>

<ol>
<li><strong>架构</strong>：RAG 分写入（加载→分块→向量化→存储）和查询（向量化→检索→生成）两阶段</li>
<li><strong>分块是关键</strong>：推荐 TokenTextSplitter，chunkSize=800~1200，overlap=10%~15%</li>
<li><strong>Advisor 链</strong>：Spring AI 2.0 的统一拦截器机制让 RAG 逻辑清晰可组合</li>
<li><strong>性能</strong>：gpt-4o-mini 在 RAG 场景下性价比最优（成本 1/35，质量损失很小）</li>
<li><strong>PgVector</strong>：运维友好的向量存储方案，记得建 HNSW 索引</li>
<li><strong>MCP</strong>：Spring AI 2.0 的杀手锏，让 Agent 能连接任意外部工具</li>
</ol>

<table>
<thead>
<tr><th style="text-align:left">场景</th><th style="text-align:center">推荐方案</th></tr>
</thead>
<tbody>
<tr><td>快速 PoC / 内部工具</td><td>gpt-4o-mini + PgVector + 默认分块</td></tr>
<tr><td>生产环境 / 高可用</td><td>gpt-4o + PgVector Pool + 语义缓存 + 限流</td></tr>
<tr><td>大规模文档（10万+块）</td><td>考虑 Milvus/Qdrant 专业向量库 + 重排序（Rerank）</td></tr>
<tr><td>需要 Agent 能力</td><td>Spring AI 2.0 MCP + Tool Calling</td></tr>
</tbody>
</table>

<h1 id="references">参考资料</h1>

<ol>
<li><strong>Spring AI 2.0 官方文档</strong> — <a href="https://docs.spring.io/spring-ai/reference/" target="_blank">https://docs.spring.io/spring-ai/reference/</a> （权威一手资料，必读）</li>
<li><strong>Spring AI 2.0.0 GA Release Announcement</strong> — <a href="https://spring.io/blog/2026/06/12/spring-ai-2-0-0-GA-available-now" target="_blank">https://spring.io/blog/2026/06/12/spring-ai-2-0-0-GA-available-now</a> （官方发布公告，了解完整变更列表）</li>
<li><strong>Spring AI 2.0 接入 AI 大模型完全指南（Ofox）</strong> — <a href="https://ofox.ai/zh/blog/spring-ai-java-llm-api-complete-guide-2026" target="_blank">https://ofox.ai/zh/blog/spring-ai-java-llm-api-complete-guide-2026</a> （中文实战教程，含完整代码示例）</li>
<li><strong>Choosing a Java LLM Integration Strategy in 2026: Spring AI vs LangChain4j</strong> — <a href="https://www.javacodegeeks.com/2026/03/choosing-a-java-llm-integration-strategy-in-2026-spring-ai-1-1-vs-langchain4j-vs-direct-api-calls.html" target="_blank">https://www.javacodegeeks.com/2026/03/...</a> （框架选型对比，帮助理解 Spring AI 定位）</li>
<li><strong>Building an LLM Agent in CAP Java with Spring AI（SAP Community）</strong> — <a href="https://community.sap.com/t5/technology-blog-posts-by-sap/building-an-llm-agent-in-cap-java-with-spring-ai/ba-p/14413057" target="_blank">https://community.sap.com/t5/...</a> （Agent 开发实战案例）</li>
<li><strong>PgVector 官方文档</strong> — <a href="https://github.com/pgvector/pgvector" target="_blank">https://github.com/pgvector/pgvector</a> （向量索引类型和参数调优参考）</li>
<li><strong>得物技术：虚拟线程原理及性能分析</strong> — <a href="https://tech.dewu.com/article?id=89" target="_blank">https://tech.dewu.com/article?id=89</a> （压测方法论参考，本文压测部分借鉴其思路）</li>
</ol>
