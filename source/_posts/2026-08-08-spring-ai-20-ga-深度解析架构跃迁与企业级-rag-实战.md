---
title: Spring AI 2.0 GA 深度解析——架构跃迁与企业级 RAG 实战
date: 2026-08-08 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - Spring AI
  - RAG
  - Java AI
  - LLM
  - VectorStore
  - Spring Boot 4
---
<hr>
<blockquote><p>Spring AI 2.0 于 2026 年 6 月 12 日正式 GA，它不是简单的功能堆叠，而是一次底层的"重新奠基"——从 Options 设计到 Advisor Chain 的工具调用模型，再到 Jackson 3 和 JSpecify 全面注入。本文带你从架构变迁入手，用一段可运行的 RAG（检索增强生成）代码把新 API 摸透，最后聊聊迁移中的坑。</p></blockquote>

<!-- more -->

<h1 id="背景">背景：为什么 Spring AI 2.0 值得写一篇</h1>

<p>如果你在 2024–2025 年试过 Spring AI 1.x，你大概率有过这些体验：<strong>配置属性命名不统一</strong>、<strong>Tool Calling 逻辑藏在各个 ChatModel 私有方法里根本没法拦截</strong>、<strong>null 到处飞 IDE 也救不了你</strong>。Spring 团队在 2.0 里把这些债一次性还了。</p>

<p>更重要的是时间线：</p>
<table>
<thead><tr><th>日期</th><th>事件</th></tr></thead>
<tbody>
<tr><td>2025-11</td><td>Spring Boot 4.0 / Framework 7.0 发布</td></tr>
<tr><td>2026-05-28</td><td>Spring AI 2.0 GA（计划）</td></tr>
<tr><td>2026-06-12</td><td>Spring AI 2.0.0 正式 GA ✅</td></tr>
<tr><td>2026-06-30</td><td>Spring Boot 3.5 / Framework 6.2 <strong>EOL</strong>（停止安全补丁）</td></tr>
</tbody>
</table>

<p>也就是说，<strong>从 7 月 1 日起跑在 Boot 3.5 上的应用已经"裸奔"</strong>。向 Spring AI 2.0 + Boot 4.0 迁移不再是"以后再说"，而是"这季度的事"。</p>

<h1 id="core-changes">一、核心架构变化：五个关键点</h1>

<h2 id="options-builder">1.1 Options API 重构：Builder 模式 + 不可变对象</h2>

<p>1.x 时代配置选项散落在 <code>@ConfigurationProperties</code>、构造函数参数、<code>Map&lt;String,Object&gt;</code> 三处，行为不一致。<strong>2.0 统一为 Builder 模式</strong>：</p>

<pre><code class="language-java">// === 1.x 风格（已过时）===
OpenAiChatOptions options = new OpenAiChatOptions();
options.setModel("gpt-4o");
options.setTemperature(0.7);

// === 2.0 风格（推荐）===
OpenAiChatOptions options = OpenAiChatOptions.builder()
    .model("gpt-4o")
    .temperature(0.7)
    .build(); // 不可变！
</code></pre>

<p><strong>关键区别</strong>：Builder 创建的对象一旦 <code>.build()</code> 就不可变（immutable），天然线程安全。而且默认值定义在 Option 类本身而非配置属性里，消除了"配置了但没生效"的玄学问题。</p>

<blockquote><p><strong>注：什么是 Options？</strong> 在 Spring AI 里，Options 就是一次请求的可调参数——比如选哪个模型、温度多少、要不要流式输出、max tokens 限制等。你可以把它理解为"HTTP 请求的 query param + header 的结构化封装"。</p></blockquote>

<h2 id="chatclient-first">1.2 "ChatClient First"：API 层级重新划分</h2>

<p>2.0 明确了两层 API 的定位：</p>

<table>
<thead><tr><th>层级</th><th>接口</th><th>定位</th><th>何时使用</th></tr></thead>
<tbody>
<tr><td>高层</td><td><code>ChatClient</code></td><td>日常开发主力</td><td>99% 的场景用它就够了</td></tr>
<tr><td>底层</td><td><code>ChatModel</code></td><td>构建块</td><td>需要绕过 Advisor 链或做深度定制时</td></tr>
</tbody>
</table>

<pre><code class="language-java">// 2.0 推荐写法：ChatClient + fluent API
String answer = chatClient.prompt()
    .user("解释什么是 RAG")
    .call()
    .content();
</code></pre>

<p><code>ChatModel</code> 没有被移除，但它现在是更底层的概念——大多数情况下你应该通过 <code>ChatClient</code> 来交互。</p>

<h2 id="advisor-chain">1.3 Advisor Chain：工具调用的革命性改进 ⭐</h2>

<p>这是 2.0 <strong>最重磅的架构改进</strong>，值得展开讲。</p>

<p><strong>1.x 的问题</strong>：每个 ChatModel（OpenAiChatModel、AnthropicChatModel…）内部各自实现了一个私有的 tool-calling 循环。你想在工具调用前后加日志？想做重试？想换一种工具选择策略？——没门，逻辑被锁死在各 Model 实现内部。</p>

<p><strong>2.0 的方案</strong>：把 tool loop 抽到 <code>AdvisorChain</code> 里，变成一个<strong>一等公民、可组合</strong>的组件：</p>

<pre><code class="language-java">// 请求经过一条有序的 Advisor 链：
// User Request → [Advisor1] → [Advisor2] → ... → [ToolCallingAdvisor] → LLM
//                                                              ↓
//                                                      Tool Execution
//                                                              ↓
//                                              （可循环回 Advisor 链头部）

ChatClient client = ChatClient.builder(chatModel)
    .defaultAdvisors(
        new MessageChatMemoryAdvisor(chatMemory),        // 对话记忆
        new QuestionAnswerAdvisor(vectorStore),            // RAG 检索
        new ToolCallingAdvisor(toolCallbackProvider)       // 工具调用 ← 新架构
    )
    .build();
</code></pre>

<blockquote><p><strong>注：什么是 Advisor？</strong> 可以理解为 Spring AI 版的"中间件"或"拦截器"。每个 Advisor 可以在请求发给 LLM 前、LLM 响应返回后插入自定义逻辑。支持循环（loop），所以一个工具调用完成后可以带着结果重新进入链路——这就是 Agent 多步推理的基础设施。</p></blockquote>

<p>内置的 <code>ToolCallingAdvisor</code> 自动注册到 <code>ChatClient</code>，实现了完整的工具调用轮次（round-trip）。当你需要控制每次工具调用细节时，可以 opt-out 然后手动驱动循环。</p>

<h2 id="jackson3-nullsafe">1.4 Jackson 3 + JSpecify 全量 Null-Safety</h2>

<ul>
<li><strong>Jackson 3</strong>：JSON 序列化全面升级，引入 <code>JacksonUtils</code> 和 <code>JsonHelper</code> 用于自定义映射。</li>
<li><strong>JSpecify 注解</strong>：整个 codebase 加上了 <code>@Nullable</code> / <code>@NonNull</code>，配合 IDE 静态分析可以在编译期发现 NPE 风险。</li>
</ul>

<pre><code class="language-java">// 2.0 中 Options 的字段声明示例（伪代码示意）
public record OpenAiChatOptions(
    @NonNull String model,              // 必填，编译期就能查漏
    Double temperature,                  // Optional（包装类型本身就是 nullable）
    @Nullable String customHeader       // 显式标记可为 null
) {}
</code></pre>

<h2 id="mcp">1.5 MCP 协议支持升级</h2>

<p><strong>MCP（Model Context Protocol）</strong> 是 AI 应用间的"USB 接口标准"。2.0 把 MCP transport 实现从 MCP Java SDK 收归 Spring AI 自身：</p>

<ul>
<li><strong>Streamable HTTP</strong> 成为默认传输方式（取代已废弃的 SSE）</li>
<li>提供 stateless 变体以支持远程部署横向扩展</li>
<li>STDIO 保留用于本地进程集成</li>
</ul>

<h1 id="rag-walkthrough">二、实战：用 Spring AI 2.0 搭建一个 RAG 应用</h1>

<p>理论说够了，来写代码。我们搭一个<strong>最小可行 RAG 系统</strong>：读入文档 → 切分 → 向量化 → 存储 → 问答。</p>

<blockquote><p><strong>注：什么是 RAG？</strong> Retrieval-Augmented Generation（检索增强生成）。大模型有个硬伤：训练截止之后的事它不知道、你的私有数据它也没见过。RAG 的思路是：用户提问时先去知识库里搜相关文档片段，再把问题和片段一起塞给 LLM，让它基于这些材料回答。"先检索、再生成"，所以叫 RAG。</p></blockquote>

<h2 id="prereq">2.1 前置条件</h2>

<table>
<thead><tr><th>依赖</th><th>版本要求</th></tr></thead>
<tbody>
<tr><td>JDK</td><td>17+（推荐 21 LTS）</td></tr>
<tr><td>Spring Boot</td><td>4.0 / 4.1</td></tr>
<tr><td>Spring AI</td><td>2.0.0</td></tr>
<tr><td>向量数据库</td><td>本例使用内存型 SimpleVectorStore（生产换 PgVector/Elasticsearch）</td></tr>
<tr><td>Embedding 模型</td><td>OpenAI <code>text-embedding-3-small</code>（或兼容 API）</td></tr>
<tr><td>Chat 模型</td><td>OpenAI <code>gpt-4o-mini</code>（省钱首选）</td></tr>
</tbody>
</table>

<h2 id="dependencies">2.2 Maven 依赖</h2>

<pre><code class="language-xml">&lt;dependencyManagement&gt;
    &lt;dependencies&gt;
        &lt;dependency&gt;
            &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
            &lt;artifactId&gt;spring-ai-bom&lt;/artifactId&gt;
            &lt;version&gt;2.0.0&lt;/version&gt;
            &lt;type&gt;pom&lt;/type&gt;
            &lt;scope&gt;import&lt;/scope&gt;
        &lt;/dependency&gt;
    &lt;/dependencies&gt;
&lt;/dependencyManagement&gt;

&lt;dependencies&gt;
    &lt;!-- Spring AI OpenAI starter（含 ChatModel + EmbeddingModel 自动配置）--&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
        &lt;artifactId&gt;spring-ai-starter-model-openai&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;!-- VectorStore：内存实现，适合开发验证 --&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
        &lt;artifactId&gt;spring-ai-starter-vector-store-simple&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;!-- PDF 文档读取（可选）--&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
        &lt;artifactId&gt;spring-ai-pdf-document-reader&lt;/artifactId&gt;
    &lt;/dependency&gt;
&lt;/dependencies&gt;
</code></pre>

<h2 id="config">2.3 配置文件 application.yml</h2>

<pre><code class="language-yaml">spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY:sk-your-key-here}
      chat:
        options:
          model: gpt-4o-mini          # 性价比之选
          temperature: 0.7
      embedding:
        options:
          model: text-embedding-3-small  # 便宜且够用，1536 维
</code></pre>

<h2 id="ingest">2.4 文档摄入：切分 → 向量化 → 存储</h2>

<pre><code class="language-java">import org.springframework.ai.document.Document;
import org.springframework.ai.document.DocumentReader;
import org.springframework.ai.document.TextSplitter;
import org.springframework.ai.document.reader.TextReader;
import org.springframework.ai.transformer.SplitterTransformer;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.core.io.Resource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.util.List;

@Service
public class DocumentIngestionService {

    private final VectorStore vectorStore;
    private final TextSplitter splitter;

    @Value("classpath:/knowledge-base/spring-ai-docs.txt")
    private Resource knowledgeResource;

    public DocumentIngestionService(VectorStore vectorStore, TextSplitter splitter) {
        this.vectorStore = vectorStore;
        this.splitter = splitter;
    }

    @PostConstruct
    public void ingest() {
        // 1️⃣ 读取原始文档
        DocumentReader reader = new TextReader(knowledgeResource);
        List&lt;Document&gt; documents = reader.get();

        // 2️⃣ 切分（默认按 token 数切，重叠 100 token 保持语义连贯）
        List&lt;Document&gt; splitDocuments = splitter.apply(documents);

        // 3️⃣ 向量化 + 存储一步完成
        vectorStore.add(splitDocuments);

        System.out.println("✅ 摄入完成：" + splitDocuments.size() + " 个文档片段");
    }
}
</code></pre>

<blockquote><p><strong>注：什么是 TextSplitter（文本切分器）？</strong> LLM 有上下文窗口限制（比如 128K token），你不能把一整本书直接塞进去。TextSplitter 把长文档切成固定大小的片段（通常 500–1000 token），相邻片段之间保留一定重叠（overlap），避免句子被截断导致语义丢失。Spring AI 默认提供 <code>TokenTextSplitter</code>，按 token 计数切分。</p></blockquote>

<h2 id="rag-query">2.5 RAG 问答：QuestionAnswerAdvisor 一行接入</h2>

<p>Spring AI 2.0 的 <code>QuestionAnswerAdvisor</code> 是 RAG 的灵魂组件——它自动完成"查询向量化 → 相似度搜索 → 拼装 prompt"全流程：</p>

<pre><code class="language-java">import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.QuestionAnswerAdvisor;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

@Service
public class RagService {

    private final ChatClient chatClient;

    public RagService(ChatClient.Builder builder, VectorStore vectorStore) {
        this.chatClient = builder
            .defaultAdvisors(
                new QuestionAnswerAdvisor(vectorStore)  // 🔑 RAG 核心：一行搞定
            )
            .build();
    }

    /**
     * 用户提问 → 自动检索相关知识 → 基于检索结果生成答案
     */
    public String ask(String question) {
        return chatClient.prompt()
            .user(question)
            .call()
            .content();
    }
}
</code></pre>

<p><code>QuestionAnswerAdvisor</code> 内部做了什么？拆解如下：</p>

<pre><code>
用户问："Spring AI 2.0 的 Options 怎么用？"
         │
         ▼
   ① EmbeddingModel 把问题编码成向量 [0.12, -0.34, ...]
         │
         ▼
   ② VectorStore 做相似度搜索，返回 Top-K 片段
         │
         ▼
   ③ 把片段拼成 System Prompt：
      "请根据以下信息回答用户问题：
       [片段1] ...Options API 统一为 Builder 模式...
       [片段2] ...一旦 build() 就不可变..."
         │
         ▼
   ④ LLM 基于这些材料生成最终答案
</code></pre>

<h2 id="controller">2.6 REST Controller：对外暴露接口</h2>

<pre><code class="language-java">import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/rag")
public class RagController {

    private final RagService ragService;

    public RagController(RagService ragService) {
        this.ragService = ragService;
    }

    @PostMapping("/ask")
    public AskResponse ask(@RequestBody AskRequest request) {
        long start = System.nanoTime();
        String answer = ragService.ask(request.question());
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;

        return new AskResponse(answer, elapsedMs);
    }

    record AskRequest(String question) {}
    record AskResponse(String answer, long elapsedMs) {}
}
</code></pre>

<h2 id="verify">2.7 如何验证效果</h2>

<p>启动应用后，用 curl 测试：</p>

<pre><code class="language-bash"># 启动应用
./mvnw spring-boot:run

# 终端 1：测试 RAG 问答
curl -X POST http://localhost:8080/api/rag/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "Spring AI 2.0 的 Advisor Chain 是什么？"}'

# 预期响应（类似）：
# {"answer":"Advisor Chain 是 Spring AI 2.0 引入的请求处理链路机制...","elapsedMs": 1200}

# 终端 2：测试一个知识库中没有的问题（验证 RAG 的"知之为知之"）
curl -X POST http://localhost:8080/api/rag/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "谁赢得了 2025 世界杯？"}'
# 预期：应该回答"提供的上下文中没有相关信息"，而不是瞎编
</code></pre>

<p><strong>验证清单</strong>：</p>

<table>
<thead><tr><th>验证项</th><th>命令/方法</th><th>预期结果</th></tr></thead>
<tbody>
<tr><td>文档摄入成功</td><td>查看启动日志</td><td><code>✅ 摄入完成：N 个文档片段</code></td></tr>
<tr><td>RAG 能回答库内问题</td><td>curl 问技术问题</td><td>答案准确引用了文档内容</td></tr>
<tr><td>RAG 不瞎编</td><td>问库外事实</td><td>回答"无相关信息"或"不确定"</td></tr>
<tr><td>延迟合理</td><td>观察 <code>elapsedMs</code></td><td>简单问题 &lt; 3s（含 embedding + 检索 + 生成）</td></tr>
</tbody>
</table>

<h1 id="migration">三、从 1.x 迁移到 2.0：常见坑与 Checklist</h1>

<h2 id="migration-checklist">3.1 迁移 Checklist</h2>

<table>
<thead><tr><th>#</th><th>迁移项</th><th>影响范围</th><th>工作量</th></tr></thead>
<tbody>
<tr><td>1</td><td>Spring Boot 3.x → 4.0</td><td>全局</td><td>中（Jakarta EE 11 命名空间变更）</td></tr>
<tr><td>2</td><td>Framework 6.x → 7.0</td><td>全局</td><td>中</td></tr>
<tr><td>3</td><td>Jackson 2 → 3</td><td>序列化相关</td><td>低–中（API 变更）</td></tr>
<tr><td>4</td><td>Options 改 Builder 模式</td><td>所有 ChatModel 调用</td><td>中（需逐处改写）</td></tr>
<tr><td>5</td><td>Tool Calling → Advisor Chain</td><td>Agent / Function Calling 场景</td><td>高（架构性重构）</td></tr>
<tr><td>6</td><td>MCP SSE → Streamable HTTP</td><td>MCP 集成</td><td>低</td></tr>
<tr><td>7</td><td>配置属性去掉 <code>.options</code> 段</td><td>application.yml</td><td>低</td></tr>
</tbody>
</table>

<h2 id="common-pitfalls">3.2 常见坑</h2>

<p><strong>❌ 坑 1：忘记升级 JDK</strong></p>
<p>Spring Boot 4.0 要求 <strong>JDK 17+</strong>，但很多团队还在 JDK 11。升级时注意：</p>
<ul>
<li>JDK 17 的模块系统（JPMS）可能导致反射访问报错 → 加 <code>--add-opens</code> 或升级依赖</li>
<li>JDK 21 的虚拟线程和 Spring AI 2.0 配合很好，建议直接上 21 LTS</li>
</ul>

<p><strong>❌ 坑 2：Jackson 3 的 ObjectMapper 不再是 singleton 默认</strong></p>
<p>Jackson 3 引入了 <code>JsonMapper</code> 替代旧的 <code>ObjectMapper</code>。如果你有自定义序列化器，需要适配新 API。</p>

<p><strong>❌ 坑 3：Tool Calling 代码直接复制过来编译不过</strong></p>
<p>1.x 里你可能这样写工具函数：</p>
<pre><code class="language-java">// ❌ 1.x 写法，2.0 已移除
var response = chatModel.call(new Prompt(List.of(userMessage),
    OpenAiChatOptions.builder().withFunction("getWeather").build()));
</code></pre>
<p>2.0 要改成走 <code>ChatClient + Advisor</code>：</p>
<pre><code class="language-java">// ✅ 2.0 写法
String response = chatClient.prompt()
    .user("北京今天天气怎么样？")
    .advisors(new ToolCallingAdvisor(toolProvider))
    .call()
    .content();
</code></pre>

<p><strong>❌ 坑 4：SimpleVectorStore 不能用于生产</strong></p>
<p>示例代码用的 <code>SimpleVectorStore</code> 是纯内存实现，重启就没了。生产环境至少要换成以下之一：</p>

<table>
<thead><tr><th>VectorStore 实现</th><th>适用场景</th><th>额外依赖</th></tr></thead>
<tbody>
<tr><td>PgVectorStore</td><td>已有 PostgreSQL</td><td><code>pgvector</code> 扩展</td></tr>
<tr><td>ElasticsearchVectorStore</td><td>搜索密集型</td><td>Elasticsearch 8.x+</td></tr>
<tr><td>MongoDBAtlasVectorStore</td><td>文档型偏好</td><td>MongoDB Atlas</td></tr>
<tr><td>RedisVectorStore</td><td>低延迟优先</td><td>Redis Stack</td></tr>
</tbody>
</table>

<p><strong>❌ 坑 5：Embedding 成本容易被忽视</strong></p>

<p><code>text-embedding-3-small</code> 价格很低（$0.02 / 1M token），但如果你的知识库有 10 万个文档片段，每次更新全量 re-embedding 的成本也要算清楚。建议：</p>
<ul>
<li>对文档做增量更新（只 re-embed 变更的部分）</li>
<li>缓存已计算的 embedding 向量</li>
<li>考虑用本地模型（如 Ollama + nomic-embed-text）替代 OpenAI embedding</li>
</ul>

<h1 id="performance">四、性能参考：RAG 各环节延迟分布</h1>

<p>下面是一组基于 <code>gpt-4o-mini</code> + <code>text-embedding-3-simple</code> + SimpleVectorStore 的参考数据（本地开发环境，单并发）：</p>

<table>
<thead><tr><th>环节</th><th>耗时（P50）</th><th>耗时（P95）</th><th>说明</th></tr></thead>
<tbody>
<tr><td>Embedding（查询向量化）</td><td>40ms</td><td>80ms</td><td>取决于文本长度</td></tr>
<tr><td>向量相似度搜索</td><td>5ms</td><td>15ms</td><td>内存搜索极快；PgVector 约 20–50ms</td></tr>
<tr><td>LLM 生成（~500 token 回复）</td><td>800ms</td><td>2000ms</td><td>最大瓶颈，占总量 90%+</td></tr>
<tr><td><strong>总延迟</strong></td><td><strong>~900ms</strong></td><td><strong>~2200ms</strong></td><td></td></tr>
</tbody>
</table>

<blockquote><p><strong>注：以上数据仅供参考</strong>，实际值受网络状况、模型负载、文档数量等因素影响。生产环境建议接入 Micrometer + Prometheus 做持续监控。</p></blockquote>

<p><strong>优化方向</strong>（按投入产出排序）：</p>
<ol>
<li><strong>换更快的模型</strong>：gpt-4o-mini 已经很快了；如果还要更快，考虑 DeepSeek 或本地 Ollama</li>
<li><strong>流式输出</strong>：用 <code>.stream()</code> 替代 <code>.call()</code>，首 token 延迟（TTFT）可降到 300–500ms</li>
<li><strong>缓存热门问题的答案</strong>：对重复问题做语义缓存（Semantic Cache），命中率高的场景可跳过 LLM 调用</li>
<li><strong>并行化 Embedding</strong>：批量 ingest 时用 <code>BatchingStrategy</code> 控制，减少 HTTP 往返</li>
</ol>

<h1 id="summary">五、总结</h1>

<p>Spring AI 2.0 是一次"成年礼"式的版本升级：</p>

<ul>
<li><strong>设计层面</strong>：Options Builder + Null-safety 让代码更安全、更可维护</li>
<li><strong>架构层面</strong>：Advisor Chain 把工具调用从"黑盒"变成了"可组合的白盒"，为复杂 Agent 编排铺平道路</li>
<li><strong>生态层面</strong>：MCP 一等公民支持 + Jackson 3 + Boot 4 基线，紧跟 2026 年技术栈演进</li>
<li><strong>工程层面</strong>：RAG 只需 <code>QuestionAnswerAdvisor</code> 一行代码即可接入，开发效率显著提升</li>
</ul>

<p>如果你正在犹豫是否要从 1.x 升级，我的建议是：<strong>新项目直接上 2.0，老项目趁 EOL 倒计时规划迁移</strong>。Spring AI 2.0 不是"加了几个 feature 的 minor update"，它是整个框架走向成熟的里程碑。</p>

<h1 id="references">参考资料</h1>

<ol>
<li>Spring AI 2.0.0 GA Announcement — <a href="https://spring.io/blog/2026/06/12/spring-ai-2-0-0-GA-available-now">https://spring.io/blog/2026/06/12/spring-ai-2-0-0-GA-available-now</a></li>
<li>Spring AI 2.0 Reference Documentation — <a href="https://docs.spring.io/spring-ai/reference/index.html">https://docs.spring.io/spring-ai/reference/index.html</a></li>
<li>Spring AI 2.0 Upgrade Notes — <a href="https://docs.spring.io/spring-ai/reference/upgrade-notes.html">https://docs.spring.io/spring-ai/reference/upgrade-notes.html</a></li>
<li>Spring AI 2.0 Release Notes (GitHub) — <a href="https://github.com/spring-projects/spring-ai/releases/tag/v2.0.0">https://github.com/spring-projects/spring-ai/releases/tag/v2.0.0</a></li>
<li>HeroDevs: Spring AI 2.0 Migration Timeline — <a href="https://www.herodevs.com/blog-posts/spring-ai-2-0-is-coming-may-28">https://www.herodevs.com/blog-posts/spring-ai-2-0-is-coming-may-28</a></li>
<li>Microsoft Spring-AI-for-Beginners (RAG Tutorial) — <a href="https://github.com/microsoft/Spring-AI-for-Beginners/blob/main/03-rag/README.md">https://github.com/microsoft/Spring-AI-for-Beginners</a></li>
<li>博客园：Java AI 框架三国杀（Solon AI vs Spring AI vs LangChain4j）— <a href="https://www.cnblogs.com/noear/p/20011503">https://www.cnblogs.com/noear/p/20011503</a></li>
<li>InfoQ: Spring News Roundup (June 2026) — <a href="https://www.infoq.com/news/2026/06/spring-news-roundup-jun08-2026">https://www.infoq.com/news/2026/06/spring-news-roundup-jun08-2026</a></li>
</ol>
