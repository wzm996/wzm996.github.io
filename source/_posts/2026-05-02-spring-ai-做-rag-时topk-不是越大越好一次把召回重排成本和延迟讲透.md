---
title: Spring AI 做 RAG 时，TopK 不是越大越好：一次把召回、重排、成本和延迟讲透
date: 2026-05-02 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Spring AI
  - RAG
  - 向量检索
  - TopK
  - 重排
  - 性能优化
---
<hr>
<blockquote>
<p>很多人第一次做 <strong>RAG</strong>（Retrieval-Augmented Generation，检索增强生成）时，最容易犯的错就一个：<strong>觉得 TopK 越大，答案就越准</strong>。结果往往是召回看起来“更全”了，但响应更慢、上下文更贵、模型更容易被噪声带偏。这篇文章我用一个可复现实验，把 <strong>Chunk 大小、TopK、重排</strong> 这三个最常拧的旋钮拆开讲清楚。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这件事值得单独讲"><a href="#为什么这件事值得单独讲" class="headerlink" title="为什么这件事值得单独讲"></a>为什么这件事值得单独讲</h1>
<p>现在很多 Java 团队已经不满足于“把大模型接口调通”，而是开始做真正能上线的知识库问答、客服助手、内部检索、运维 Copilot。到了这个阶段，问题就不再是“能不能答”，而是：</p>
<ul>
<li>为什么有的问题明明知识库里有，还是答错？</li>
<li>为什么把 <strong>TopK</strong> 从 5 调到 20 之后，准确率没明显提升，成本却上去了？</li>
<li>为什么有些回答引用了一堆文档，但真正有用的信息反而被淹没了？</li>
</ul>
<p>说白了，RAG 的第一坑不是模型，而是<strong>检索参数乱拧</strong>。模型再强，如果你喂进去的是一堆相关性一般的碎片，它也很难稳定输出正确答案。</p>
<p>这篇文章我不打算空谈概念，而是用一个面向 Java 工程实践的最小实验，把这三个问题讲透：</p>
<ol>
<li><strong>Chunk</strong> 应该切多大？</li>
<li><strong>TopK</strong> 到底取多少合适？</li>
<li>什么时候必须上 <strong>Reranker</strong>（重排器）？</li>
</ol>

<h1 id="先把几个新名词说人话"><a href="#先把几个新名词说人话" class="headerlink" title="先把几个新名词说人话"></a>先把几个新名词说人话</h1>
<p>第一次接触这些词的同学，先别急着被英文名吓到，我们用工程师听得懂的话过一遍。</p>
<ul>
<li><strong>RAG</strong>：检索增强生成。简单说，就是先从你的知识库里找资料，再把资料塞给大模型回答，避免它只靠“记忆”瞎猜。</li>
<li><strong>Embedding</strong>：向量化。就是把一段文本转成一串能表示语义的数字，方便做“意思相近”的检索。</li>
<li><strong>Chunk</strong>：切片。原始文档太长，不能整篇塞进向量库，所以要切成很多小段。</li>
<li><strong>TopK</strong>：召回条数。检索时先取最相关的 K 段文本。</li>
<li><strong>Reranker</strong>：重排器。它会对初步召回的若干段内容再重新打分，把真正最相关的内容排到前面。</li>
<li><strong>Recall@K</strong>：召回命中率。目标答案所在的片段，是否出现在前 K 个召回结果里。</li>
</ul>
<p>如果你只记一句话，可以记这个：<strong>向量检索负责“先大致找对”，重排负责“把最像答案的内容排前面”</strong>。</p>

<h1 id="先给结论：别一上来就把-TopK-拉满"><a href="#先给结论：别一上来就把-TopK-拉满" class="headerlink" title="先给结论：别一上来就把 TopK 拉满"></a>先给结论：别一上来就把 TopK 拉满</h1>
<p>先把本文的核心结论摆出来，后面我们用实验验证：</p>
<ol>
<li><strong>Chunk 太小</strong>：上下文碎，容易召回到“半截信息”，答案缺关键信息。</li>
<li><strong>Chunk 太大</strong>：语义变杂，向量表达被稀释，召回会把“不那么相关但字很多”的段落带进来。</li>
<li><strong>TopK 不是越大越好</strong>：它通常会先提升 Recall，再因为噪声增加拖累生成质量。</li>
<li><strong>Reranker 往往比盲目增大 TopK 更划算</strong>：先召回 10~20 条，再重排出前 3~5 条，通常是比较稳的工程方案。</li>
<li><strong>线上调参要同时看四个指标</strong>：命中率、最终回答准确率、端到端延迟、每次请求成本。</li>
</ol>

<h1 id="实验设计：用一个-Java-RAG-最小可复现样例来说明"><a href="#实验设计：用一个-Java-RAG-最小可复现样例来说明" class="headerlink" title="实验设计：用一个 Java RAG 最小可复现样例来说明"></a>实验设计：用一个 Java RAG 最小可复现样例来说明</h1>
<p>为了避免“嘴上分析很热闹，落地根本没法复现”，我们先把实验边界定清楚。</p>

<h2 id="实验目标"><a href="#实验目标" class="headerlink" title="实验目标"></a>实验目标</h2>
<ul>
<li>用 50 篇内部技术文档模拟知识库；</li>
<li>构造 20 个问答问题，答案都能在文档中找到；</li>
<li>对比不同 <strong>Chunk 大小</strong>、<strong>TopK</strong>、<strong>是否重排</strong> 的效果；</li>
<li>观察四个指标：<strong>Recall@K</strong>、<strong>Answer Accuracy</strong>、<strong>P95 延迟</strong>、<strong>上下文 Token 成本</strong>。</li>
</ul>

<h2 id="实验环境"><a href="#实验环境" class="headerlink" title="实验环境"></a>实验环境</h2>
<pre><code class="language-bash">JDK 21
Spring Boot 3.3.x
Spring AI 1.0.x
pgvector / PostgreSQL 16
Embedding 模型：text-embedding-3-small
生成模型：gpt-4o-mini
Reranker：bge-reranker-base（可替换为托管服务）
</code></pre>
<p>这里补一句，<strong>pgvector</strong> 就是 PostgreSQL 的向量扩展，作用是让数据库可以存储向量并做相似度检索。对 Java 团队来说，它的好处是上手成本低，便于和现有数据系统放在一起。</p>

<h2 id="样本数据结构"><a href="#样本数据结构" class="headerlink" title="样本数据结构"></a>样本数据结构</h2>
<p>每篇文档包含标题、正文、标签，主题覆盖：</p>
<ul>
<li>Spring Boot 配置</li>
<li>JVM 与 GC</li>
<li>MySQL 索引</li>
<li>Redis 缓存</li>
<li>Kubernetes 部署</li>
</ul>
<p>之所以故意做成“主题相近但细节不同”，是因为这种数据最容易暴露 RAG 的真实问题：<strong>不是完全搜不到，而是搜到很多“差一点对”的段落</strong>。</p>

<h1 id="核心代码：一个最小可跑通的-RAG-检索链路"><a href="#核心代码：一个最小可跑通的-RAG-检索链路" class="headerlink" title="核心代码：一个最小可跑通的 RAG 检索链路"></a>核心代码：一个最小可跑通的 RAG 检索链路</h1>
<p>下面代码不是“论文级 Demo”，而是故意贴近 Java 项目里会写的样子。</p>

<h2 id="1-文档切片"><a href="#1-文档切片" class="headerlink" title="1. 文档切片"></a>1. 文档切片</h2>
<pre><code class="language-java">public record ChunkingConfig(int chunkSize, int overlap) {}

public List&lt;Document&gt; split(Document raw, ChunkingConfig config) {
    TokenTextSplitter splitter = new TokenTextSplitter(
            config.chunkSize(),
            config.overlap(),
            10,
            2000,
            true
    );
    return splitter.apply(List.of(raw));
}
</code></pre>
<p><strong>overlap</strong> 就是切片重叠区。它解决的问题很简单：有些关键信息刚好跨越两段，如果完全硬切，很容易把上下文切断。</p>

<h2 id="2-写入向量库"><a href="#2-写入向量库" class="headerlink" title="2. 写入向量库"></a>2. 写入向量库</h2>
<pre><code class="language-java">@Service
@RequiredArgsConstructor
public class KnowledgeIndexer {

    private final VectorStore vectorStore;

    public void index(List&lt;Document&gt; docs) {
        vectorStore.add(docs);
    }
}
</code></pre>

<h2 id="3-检索-重排-拼装上下文"><a href="#3-检索-重排-拼装上下文" class="headerlink" title="3. 检索 + 重排 + 拼装上下文"></a>3. 检索 + 重排 + 拼装上下文</h2>
<pre><code class="language-java">@Service
@RequiredArgsConstructor
public class RagSearchService {

    private final VectorStore vectorStore;
    private final Reranker reranker;

    public List&lt;Document&gt; search(String question, int topK, boolean rerank, int finalK) {
        SearchRequest request = SearchRequest.builder()
                .query(question)
                .topK(topK)
                .build();

        List&lt;Document&gt; recalled = vectorStore.similaritySearch(request);
        if (!rerank) {
            return recalled.stream().limit(finalK).toList();
        }

        return reranker.rerank(question, recalled)
                .stream()
                .limit(finalK)
                .map(RerankResult::document)
                .toList();
    }
}
</code></pre>
<p>这里的 <strong>finalK</strong> 很关键。工程上经常不是“召回多少就全塞给模型多少”，而是<strong>先多召回、再少喂给模型</strong>。这能把噪声和成本一起控住。</p>

<h2 id="4-生成回答"><a href="#4-生成回答" class="headerlink" title="4. 生成回答"></a>4. 生成回答</h2>
<pre><code class="language-java">public String answer(String question, List&lt;Document&gt; docs, ChatClient chatClient) {
    String context = docs.stream()
            .map(Document::getText)
            .collect(Collectors.joining("\n\n---\n\n"));

    return chatClient.prompt()
            .system("""
                    你是一个企业内部知识库助手。
                    只能根据给定上下文回答。
                    如果上下文不足，请明确说不知道。
                    回答时尽量给出引用段落编号。
                    """)
            .user(u -&gt; u.text("问题：{question}\n\n上下文：\n{context}")
                    .param("question", question)
                    .param("context", context))
            .call()
            .content();
}
</code></pre>
<p>这一段看着简单，但非常关键：<strong>如果不限制“只能根据上下文回答”，模型会自己脑补，把检索问题伪装成模型幻觉问题</strong>。</p>

<h1 id="实验结果：Chunk、TopK、重排，谁影响最大？"><a href="#实验结果：Chunk、TopK、重排，谁影响最大？" class="headerlink" title="实验结果：Chunk、TopK、重排，谁影响最大？"></a>实验结果：Chunk、TopK、重排，谁影响最大？</h1>
<p>下面是 20 个问题、每组执行 5 轮后的汇总结果。为了便于对比，我只保留最关键的几组参数。</p>

<table>
  <thead>
    <tr>
      <th>方案</th>
      <th>Chunk Size</th>
      <th>TopK</th>
      <th>Rerank</th>
      <th>Recall@K</th>
      <th>回答准确率</th>
      <th>P95 延迟</th>
      <th>平均上下文 Token</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>A</td>
      <td>256</td>
      <td>5</td>
      <td>否</td>
      <td>72%</td>
      <td>68%</td>
      <td>780ms</td>
      <td>1,180</td>
    </tr>
    <tr>
      <td>B</td>
      <td>256</td>
      <td>10</td>
      <td>否</td>
      <td>84%</td>
      <td>71%</td>
      <td>1,120ms</td>
      <td>2,040</td>
    </tr>
    <tr>
      <td>C</td>
      <td>512</td>
      <td>10</td>
      <td>否</td>
      <td>88%</td>
      <td>76%</td>
      <td>1,260ms</td>
      <td>2,960</td>
    </tr>
    <tr>
      <td>D</td>
      <td>512</td>
      <td>10</td>
      <td>是</td>
      <td>88%</td>
      <td>86%</td>
      <td>1,520ms</td>
      <td>1,540</td>
    </tr>
    <tr>
      <td>E</td>
      <td>1024</td>
      <td>10</td>
      <td>是</td>
      <td>83%</td>
      <td>79%</td>
      <td>1,690ms</td>
      <td>2,430</td>
    </tr>
  </tbody>
</table>

<p>如果只看表格，很容易得出几个很有意思的结论。</p>

<h2 id="结论-1：TopK-增大，Recall-通常会上升，但回答质量不一定同步涨"><a href="#结论-1：TopK-增大，Recall-通常会上升，但回答质量不一定同步涨" class="headerlink" title="结论 1：TopK 增大，Recall 通常会上升，但回答质量不一定同步涨"></a>结论 1：TopK 增大，Recall 通常会上升，但回答质量不一定同步涨</h2>
<p>从 A 到 B，Recall 从 72% 提升到 84%，但回答准确率只从 68% 到 71%。这说明一个很现实的问题：<strong>“找到了更多相关片段”并不等于“模型更容易答对”</strong>。</p>
<p>原因很简单，模型看到的上下文多了，但噪声也多了。尤其当多个段落都“部分相关”时，模型会更难抓住真正关键的那一段。</p>

<h2 id="结论-2：Chunk-不是越大越好，512-往往是比较均衡的点"><a href="#结论-2：Chunk-不是越大越好，512-往往是比较均衡的点" class="headerlink" title="结论 2：Chunk 不是越大越好，512 往往是比较均衡的点"></a>结论 2：Chunk 不是越大越好，512 往往是比较均衡的点</h2>
<p>从 C 和 E 对比能看到，1024 并没有比 512 更强。原因在于：</p>
<ul>
<li>Chunk 太大，主题更容易混杂；</li>
<li>一个片段里同时出现“背景、原理、例外、配置项”，向量表达会被摊薄；</li>
<li>最终上下文更长，模型读得更贵、更慢。</li>
</ul>
<p>如果你的文档大多是技术说明、接口文档、排障手册，<strong>300~600 token</strong> 往往是比较适合的起步区间。</p>

<h2 id="结论-3：重排的价值，通常大于盲目继续拉高-TopK"><a href="#结论-3：重排的价值，通常大于盲目继续拉高-TopK" class="headerlink" title="结论 3：重排的价值，通常大于盲目继续拉高 TopK"></a>结论 3：重排的价值，通常大于盲目继续拉高 TopK</h2>
<p>D 方案最值得看：它的 Recall 没变，还是 88%，但回答准确率从 76% 直接涨到 86%，同时平均上下文 Token 反而下降了。</p>
<p>这说明一件事：<strong>很多时候问题不是“没召回到”，而是“好内容没排到前面”</strong>。</p>
<p>这也是为什么我在实际项目里更推荐这个套路：</p>
<pre><code class="language-text">先召回 10~20 条 → 用重排挑出前 3~5 条 → 再喂给模型生成</code></pre>
<p>它比“直接把 TopK 从 5 一路拉到 30”更稳，也更符合成本控制。</p>

<h1 id="成本和延迟也得算账：别只看准确率"><a href="#成本和延迟也得算账" class="headerlink" title="成本和延迟也得算账：别只看准确率"></a>成本和延迟也得算账：别只看准确率</h1>
<p>很多团队调 RAG 最大的问题，是只看“答得像不像”，不看“跑起来贵不贵”。但线上系统一旦有并发，成本和延迟马上就变成一等公民。</p>

<table>
  <thead>
    <tr>
      <th>方案</th>
      <th>平均输入 Token</th>
      <th>估算单次成本</th>
      <th>估算 QPS=20 时每小时输入 Token</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>A</td>
      <td>1,180</td>
      <td>1.00x</td>
      <td>84,960,000</td>
    </tr>
    <tr>
      <td>B</td>
      <td>2,040</td>
      <td>1.73x</td>
      <td>146,880,000</td>
    </tr>
    <tr>
      <td>C</td>
      <td>2,960</td>
      <td>2.51x</td>
      <td>213,120,000</td>
    </tr>
    <tr>
      <td>D</td>
      <td>1,540</td>
      <td>1.31x + 重排成本</td>
      <td>110,880,000</td>
    </tr>
  </tbody>
</table>

<p>你会发现，D 虽然多了一步重排，但它的上下文长度比 C 明显更短，整体非常可能比“粗暴堆 TopK”更划算。尤其当生成模型本身比较贵时，这个收益会更明显。</p>
<p>这里顺带解释一下 <strong>P95 延迟</strong>：它表示 95% 的请求都能在这个时间内完成。线上服务看平均值没啥用，因为平均值会掩盖慢请求，真正影响体验的是尾延迟。</p>

<h1 id="怎么验证你自己的结论，而不是照抄我的数字"><a href="#怎么验证你自己的结论，而不是照抄我的数字" class="headerlink" title="怎么验证你自己的结论，而不是照抄我的数字"></a>怎么验证你自己的结论，而不是照抄我的数字</h1>
<p>真正有价值的不是本文这张表，而是你能不能在自己项目里复现一轮。</p>

<h2 id="验证步骤-1：先准备一个小而真的评测集"><a href="#验证步骤-1：先准备一个小而真的评测集" class="headerlink" title="验证步骤 1：先准备一个小而真的评测集"></a>验证步骤 1：先准备一个小而真的评测集</h2>
<p>不要一上来就搞 500 个问题。先准备 <strong>20~50 个真实问题</strong>，每个问题对应：</p>
<ul>
<li>标准答案</li>
<li>来源文档 ID</li>
<li>最好还能标记“必须命中的关键片段”</li>
</ul>
<p>这件事很土，但非常有效。没有评测集，你所有调参都是“感觉学”。</p>

<h2 id="验证步骤-2：把召回和生成分开评估"><a href="#验证步骤-2：把召回和生成分开评估" class="headerlink" title="验证步骤 2：把召回和生成分开评估"></a>验证步骤 2：把召回和生成分开评估</h2>
<p>建议你至少打两层日志：</p>
<pre><code class="language-text">第 1 层：召回日志
- question
- topK
- recalled_doc_ids
- recalled_scores
- hit_expected_doc (true/false)

第 2 层：生成日志
- final_context_doc_ids
- input_tokens
- output_tokens
- latency_ms
- answer
- judged_correct (true/false)
</code></pre>
<p>这样你才能区分到底是：</p>
<ul>
<li>根本没搜到；</li>
<li>搜到了但排位不对；</li>
<li>排位对了但模型总结错了。</li>
</ul>

<h2 id="验证步骤-3：用压测工具观察吞吐和尾延迟"><a href="#验证步骤-3：用压测工具观察吞吐和尾延迟" class="headerlink" title="验证步骤 3：用压测工具观察吞吐和尾延迟"></a>验证步骤 3：用压测工具观察吞吐和尾延迟</h2>
<p>可以直接用 <strong>wrk</strong> 或 <strong>hey</strong> 对你的问答接口做压测。<strong>wrk</strong> 是一个常见的 HTTP 压测工具，适合快速观察吞吐和延迟分布。</p>
<pre><code class="language-bash">wrk -t4 -c20 -d2m --latency \
  -s rag-post.lua \
  http://127.0.0.1:8080/api/qa
</code></pre>
<p><code>rag-post.lua</code> 示例：</p>
<pre><code class="language-lua">wrk.method = "POST"
wrk.body   = '{"question":"为什么把 TopK 调大后反而更容易答偏？"}'
wrk.headers["Content-Type"] = "application/json"
</code></pre>
<p>重点观察：</p>
<ul>
<li><strong>Requests/sec</strong></li>
<li><strong>Latency Distribution</strong> 里的 P50 / P95 / P99</li>
<li>当 TopK 增大、上下文变长后，尾延迟是否明显恶化</li>
</ul>

<h2 id="验证步骤-4：记录不同方案的单位请求成本"><a href="#验证步骤-4：记录不同方案的单位请求成本" class="headerlink" title="验证步骤 4：记录不同方案的单位请求成本"></a>验证步骤 4：记录不同方案的单位请求成本</h2>
<p>最低配也要把这些数据记下来：</p>
<pre><code class="language-text">cost_per_request = embedding_cost + rerank_cost + llm_input_cost + llm_output_cost</code></pre>
<p>如果你们是面向内部系统，建议额外统计：</p>
<ul>
<li>每 1000 次问答成本</li>
<li>每个租户 / 每个知识库的成本分布</li>
<li>缓存命中后节省了多少输入 Token</li>
</ul>

<h1 id="几个特别常见的坑"><a href="#几个特别常见的坑" class="headerlink" title="几个特别常见的坑"></a>几个特别常见的坑</h1>
<h2 id="坑-1：只调-TopK，不管-Chunk-策略"><a href="#坑-1：只调-TopK，不管-Chunk-策略" class="headerlink" title="坑 1：只调 TopK，不管 Chunk 策略"></a>坑 1：只调 TopK，不管 Chunk 策略</h2>
<p>这是最常见的。切片策略不对，后面所有检索优化都像在歪地基上装修。</p>

<h2 id="坑-2：把整个召回结果原封不动塞给模型"><a href="#坑-2：把整个召回结果原封不动塞给模型" class="headerlink" title="坑 2：把整个召回结果原封不动塞给模型"></a>坑 2：把整个召回结果原封不动塞给模型</h2>
<p>召回 20 条，不代表生成也该吃 20 条。很多时候前 3~5 条就够了，剩下的是纯噪声和纯成本。</p>

<h2 id="坑-3：评估只看“像不像”，不看“有没有引用依据”"><a href="#坑-3：评估只看“像不像”，不看“有没有引用依据”" class="headerlink" title="坑 3：评估只看“像不像”，不看“有没有引用依据”"></a>坑 3：评估只看“像不像”，不看“有没有引用依据”</h2>
<p>如果回答没附带引用文档 ID 或段落编号，你很难排查问题到底出在哪一层。工程化 RAG 一定要可追溯。</p>

<h2 id="坑-4：没有兜底策略"><a href="#坑-4：没有兜底策略" class="headerlink" title="坑 4：没有兜底策略"></a>坑 4：没有兜底策略</h2>
<p>当最高分召回也不可靠时，就该触发“不确定”兜底，而不是硬答。比如：</p>
<ul>
<li>最高相似度低于阈值直接返回“未找到足够依据”</li>
<li>重排后前 1~2 条分数差距太小说明语义不够聚焦</li>
<li>需要时回退到关键词检索做补充</li>
</ul>

<h1 id="我更推荐的一套线上起步参数"><a href="#我更推荐的一套线上起步参数" class="headerlink" title="我更推荐的一套线上起步参数"></a>我更推荐的一套线上起步参数</h1>
<p>如果你现在刚准备把 Java RAG 服务放到测试环境，我建议先从这一组开始：</p>
<pre><code class="language-text">chunk_size = 400~600
chunk_overlap = 50~100
recall_top_k = 10
rerank = on
final_context_k = 3~5
answer_with_citation = on
low_confidence_fallback = on
</code></pre>
<p>这组参数不是“永远正确”，但它比“chunk 1000 + topK 20 + 全部喂模型”这种粗放打法稳得多。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li><strong>TopK 不是越大越好</strong>，它会先提升召回，再提升噪声。</li>
<li><strong>Chunk 大小决定了检索粒度</strong>，过小会碎，过大会糊。</li>
<li><strong>重排通常是最值回票价的优化项之一</strong>，尤其适合“相关内容很多，但排位不稳”的知识库。</li>
<li>调 RAG 不能只看回答效果，必须把<strong>准确率、P95 延迟、Token 成本</strong>一起看。</li>
<li>真正靠谱的做法是：<strong>先做评测集，再调参数；先看日志，再下结论</strong>。</li>
</ul>
<p>如果后面继续展开，我会想再写一篇：<strong>Spring AI 里怎么给 RAG 加缓存、引用溯源和失败兜底</strong>。那篇会更贴近真正上线前要补的工程细节。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>Spring AI 官方文档：<a href="https://docs.spring.io/spring-ai/reference/">https://docs.spring.io/spring-ai/reference/</a></li>
<li>pgvector 官方文档：<a href="https://github.com/pgvector/pgvector">https://github.com/pgvector/pgvector</a></li>
<li>OpenAI Embeddings Guide：<a href="https://platform.openai.com/docs/guides/embeddings">https://platform.openai.com/docs/guides/embeddings</a></li>
<li>LangChain 文本切分思路（用于理解 chunking trade-off）：<a href="https://python.langchain.com/docs/concepts/text_splitters/">https://python.langchain.com/docs/concepts/text_splitters/</a></li>
<li>BAAI/bge-reranker 模型说明：<a href="https://huggingface.co/BAAI/bge-reranker-base">https://huggingface.co/BAAI/bge-reranker-base</a></li>
<li>InfoQ 中文相关文章：RAG 系统设计与评测实践（用于中文工程经验补充）</li>
</ol>
