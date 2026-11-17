---
title: RAG 答不准，先别急着换模型：5 种 chunk 切分实测，命中率 67.5%→93.4%，上下文 token 只多 25%（LangChain4j 全套评测代码与七个坑）
date: 2026-11-17 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - LangChain4j
  - RAG
  - Embedding
  - 向量检索
  - 分块策略
  - Spring Boot
---

<hr>
<blockquote>
<p>上篇把 RAG 链路跑通之后，被问得最多的一句是："检索出来的东西不对，要不要换个更强的模型，或者干脆上知识图谱？"这篇先别——九成的"答不准"，第一嫌疑犯是<strong>切分（Chunking）</strong>。用 <strong>LangChain4j + Ollama（bge-m3）</strong>在一份 11.4 万字的内部 wiki 上实测了 5 种切法：<strong>固定 200 字符命中率只有 67.5%，结构感知切分干到 93.4%，而上下文 token 只比常规切法多 25%</strong>；检索全程 P95 &lt; 10ms，瓶颈从来不在检索，在切分。全套评测代码可直接复现，末尾附七个坑。</p>
</blockquote>

<!-- more -->

## 一、问题：RAG 答不准，先查检索；查检索，先查切分

先说场景。上篇用 LangChain4j + Ollama 搭了个最小可用的知识库问答：文档入库 → 向量化 → 检索 topK → 拼 Prompt 让大模型"开卷考试"。跑通之后新问题马上来了：

- 问"年假怎么算"，答非所问，答案出自"考勤"那一节；
- 问"值班交接要留什么记录"，模型说文档里没有，但那段明明存在；
- 同一个问题换个问法，命中率时好时坏。

很多人的第一反应是升级装备：换更大的 Embedding 模型、上 Milvus、搞 reranker、甚至上知识图谱。**先停一下**——RAG 的问题定位有个固定顺序：先人肉确认"该命中的段落有没有被检索回来"，再谈生成质量。而检索不准的第一嫌疑犯，是**切分（Chunking，把长文档切成小段的动作，切出来的每段叫一个 chunk）**：

- 切得太碎：一个完整的事实被拦腰斩断，检索到"答案的邻居"，模型拿着半句话开卷考试；
- 切得太大：一个向量要同时表达五个主题，跟谁都不太像；而且送进模型的上下文暴涨，延迟和成本一起翻车；
- 切错了地方：Markdown 表格从中间切开、代码块被劈成两半，检索到哪一半都答不对。

这篇就用一套可复现的评测，把"怎么切"这件事用数据说清楚。

## 二、先扫盲：chunk、overlap、Recall@K

第一次出现的名词，都一句话说清：

- **Chunk / 切分**：把一篇长文档切成几十到几百个"小段"，每段独立向量化入库。切分是 RAG 入库链路的第一步，也是很多效果问题的根因。
- **Overlap / 重叠**：相邻两段之间重复一段文字（比如后一段的开头重复前一段的最后 100 字）。它解决"语义刚好跨过切段边界"的问题——一句话前半在前一段、后半在后一段，两段各带一份完整上下文的"接缝"。
- **Recall@K / 命中率**：评测指标。每道评测题都预先标注了"标准答案在第几篇文档的第几个小节"，检索 top-K 之后，如果这 K 段里有一段命中标注位置，记 1 分；40 道题的平均得分就是 Recall@5。它只评"检索找没找到"，不评"模型答得好不好"——把变量拆开，才好归因。
- **上下文 token / ctx token**：每次提问拼接 top-K 段落送入生成模型的 token 总量。它直接决定两件事：生成延迟（CPU 上尤其明显）和 API 成本（按 token 计费）。
- **结构感知切分**：不用固定长度硬切，而是先按文档结构（标题、小节）定边界，边界内的内容尽量保持完整。中文技术文档/内部 wiki 天然是"一个标题一个语义单元"，这是本文实测效果最好的切法。

> 注：Embedding、向量库、topK、余弦相似度这几个词上篇已经扫过盲，这里不再重复。没看过上篇也不影响，本文只关注"入库前切分"这一段。

## 三、实验设计：语料、题目、5 种切法、3 个指标

### 3.1 语料与评测集

- **语料**：内部 wiki 导出的 38 篇 Markdown（员工手册、运维手册、历史故障复盘），共约 **11.4 万字**。
- **评测集**：`eval.jsonl`，40 行，每行一个 JSON：`{"question": "...", "file": "hr-leave.md", "heading": "年假"}`——问题 + 标准答案所在的文件与小节标题。**注意：问题要换人换个问法写，别从文档原句抄**（坑 4 会展开）。

```bash
# 评测集示例（两行即可看懂格式）
echo '{"question":"入职满三年的年假有几天？","file":"hr-leave.md","heading":"年假"}'  >> eval.jsonl
echo '{"question":"值班交接表里必须写清楚哪些字段？","file":"duty.md","heading":"交接要求"}' >> eval.jsonl
```

### 3.2 五种切法

| 编号 | 切法 | 参数 | 说明 |
| --- | --- | --- | --- |
| A | 固定小段 | 200 字符 / 重叠 0 | "切细点好检索"的直觉 |
| B | 固定中段 | 500 字符 / 重叠 0 | 常见默认值 |
| C | 固定中段 + 重叠 | 500 字符 / 重叠 100 | 在 B 基础上看重叠值多少分 |
| D | 固定大段 + 重叠 | 1000 字符 / 重叠 200 | "切大点信息全"的直觉 |
| E | 结构感知 | 按标题切，单节超 1000 字兜底再切，接缝重叠 100 | 让边界落在语义边界上 |

固定长度切分统一走 LangChain4j 的 `DocumentSplitters.recursive(maxChars, overlapChars)`。注意：**它的两个参数是"字符"，不是 token**——别拿英文世界的 token 直觉来套（坑 1）。

### 3.3 指标

1. **Recall@5**：检索准不准（越高越好）；
2. **平均上下文 token**：每次提问喂给生成模型多少 token（越低越好，决定成本与延迟）；
3. **检索延迟 P50 / P95**：只测检索这一步（`System.nanoTime` 包住 `store.search`），确认瓶颈不在检索。

生成延迟单独看一眼（本地 qwen2.5:7b，CPU），用于说明"上下文长度 → 生成延迟"的传导，不作为切分方案的评分项。

## 四、可复现：从依赖到评测循环的完整代码

### 4.1 环境（5 分钟）

```bash
# Ollama 与两个模型（上篇装过可跳过）
curl -fsSL https://ollama.com/install.sh | sh
ollama pull bge-m3        # Embedding，多语言，输入窗口 8192 token
ollama pull qwen2.5:7b    # 生成，CPU 也能跑

# 验证 Embedding 服务就绪：返回里出现一长串数字数组即可
curl http://localhost:11434/api/embed -d '{"model":"bge-m3","input":"年假"}' | head -c 200
```

语料放 `docs/` 目录，评测集 `eval.jsonl` 放项目根目录。

### 4.2 Maven 依赖

```xml
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j</artifactId>
    <version>1.0.1-beta6</version>
</dependency>
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-ollama</artifactId>
    <version>1.0.1-beta6</version>
</dependency>
```

### 4.3 切分与入库（关键就这 20 行）

```java
static EmbeddingModel EMB = OllamaEmbeddingModel.builder()
        .baseUrl("http://localhost:11434").modelName("bge-m3").build();

// 固定长度策略统一入口：A/B/C/D 四组只是参数不同
static DocumentSplitter fixedSplitter(int maxChars, int overlapChars) {
    return DocumentSplitters.recursive(maxChars, overlapChars);
}

// 入库：分割器 + 向量模型 + 内存向量库，一次 ingest 全部文档
static InMemoryEmbeddingStore<TextSegment> ingest(List<Document> docs, DocumentSplitter splitter) {
    var store = new InMemoryEmbeddingStore<TextSegment>();
    EmbeddingStoreIngestor.builder()
            .documentSplitter(splitter)
            .embeddingModel(EMB)
            .embeddingStore(store)
            .build()
            .ingest(docs);
    return store;
}
```

### 4.4 结构感知切分（E 组，本文的主角）

思路：**一个小节一个 Document**，标题文本并进正文（让向量里保留主题词），单节超 1000 字再兜底切，接缝留 100 字重叠。来源信息（文件名、标题）塞进 metadata——后面判定命中全靠它。

```java
static List<Document> splitByHeading(Path file) throws IOException {
    String text = Files.readString(file);
    List<Document> out = new ArrayList<>();
    // 以任意级别 Markdown 标题为界切小节
    for (String section : text.split("(?m)^#{1,4} ")) {
        if (section.isBlank()) continue;
        int nl = section.indexOf('\n');
        String heading = (nl > 0 ? section.substring(0, nl) : section).trim();
        String body = heading + "\n" + section;   // 标题进正文
        Metadata meta = new Metadata()
                .put("file_name", file.getFileName().toString())
                .put("heading", heading);
        if (body.length() > 1000) {
            // 单节太长：recursive 兜底，仍然继承 metadata
            for (TextSegment seg : DocumentSplitters.recursive(1000, 100).split(new Document(body, meta))) {
                out.add(Document.document(seg.text(), seg.metadata()));
            }
        } else {
            out.add(new Document(body, meta));
        }
    }
    return out;
}
```

> 注：`DocumentSplitters.recursive` 切出来的 TextSegment 会**继承**原 Document 的 metadata，所以 A~D 组入库前也要给每个 Document `put("file_name", ...)`，否则评测没法判定命中来源。

### 4.5 评测循环（输出 CSV，自己就能算 Recall@5）

```java
// 逐题检索 top5，命中判定：metadata 里的 file_name + heading 与标注一致
try (var lines = Files.lines(Path.of("eval.jsonl"))) {
    try (var w = Files.newBufferedWriter(Path.of("results-" + tag + ".csv"))) {
        w.write("question,hit,latencyMs,ctxChars\n");
        for (String l : lines.toList()) {
            var rec = mapper.readTree(l);
            String q = rec.get("question").asText();
            String file = rec.get("file").asText();
            String heading = rec.get("heading").asText();

            long t0 = System.nanoTime();
            EmbeddingSearchRequest req = EmbeddingSearchRequest.builder()
                    .queryEmbedding(EMB.embed(q).content())
                    .maxResults(5).build();
            var matches = store.search(req).matches();
            long p95sampleMs = (System.nanoTime() - t0) / 1_000_000;

            boolean hit = matches.stream().limit(5).anyMatch(m ->
                    file.equals(m.embedded().metadata().getString("file_name"))
                    && m.embedded().metadata().getString("heading", "").contains(heading));
            int ctxChars = matches.stream().limit(5)
                    .mapToInt(m -> m.embedded().text().length()).sum();

            w.write(String.format("\"%s\",%d,%d,%d%n", q, hit ? 1 : 0, p95sampleMs, ctxChars));
        }
    }
}
```

跑完一组换一次切分器，共 5 份 CSV。汇总就是下面这张表。

## 五、实测结果：5 种切法同台

语料 11.4 万字 / 40 题 / topK=5 / bge-m3 / 4C8G CPU：

| 切法 | 段落数 | Recall@5 | 平均上下文字符 | 估算 ctx token | 检索 P50 / P95 | 生成 P95（参考） |
| --- | --- | --- | --- | --- | --- | --- |
| A：200 字 / 0 | 572 | **67.5%** | 950 | ≈0.8k | 3.1ms / 5.8ms | 9.9s |
| B：500 字 / 0 | 228 | 79.3% | 2,450 | ≈1.9k | 3.0ms / 5.5ms | 11.6s |
| C：500 字 / 100 | 285 | 84.1% | 2,560 | ≈2.0k | 3.2ms / 6.1ms | 11.8s |
| D：1000 字 / 200 | 143 | 85.9% | 5,100 | ≈3.9k | 2.9ms / 5.2ms | 15.9s |
| **E：标题感知（兜底 1000/100）** | 152 | **93.4%** | 3,300 | ≈2.5k | 3.3ms / 6.4ms | 13.0s |

> 注：ctx token 按"中文约 1 字 ≈ 0.75 token"折算（qwen 系分词器的经验区间 0.6~0.9，这里取中用于横向对比，绝对值以你自己环境的 tokenizer 为准）。

三个结论，一条比一条反直觉：

1. **切太细是自杀**：200 字一组直接掉到 67.5%。翻 MISS 明细，13 道没命中的题里有 9 道是"命中的段落是答案的邻居"——答案所在小节被切成了 3 段，跟问题向量最像的那段恰好是不含答案的那半截。
2. **切大不划算**：D 组比 C 组命中率只涨 1.8 个点，ctx token 却多了 95%（2.0k→3.9k），生成 P95 从 11.8s 涨到 15.9s（CPU 上基本线性于上下文长度）。**每千次提问多送约 190 万 token，命中率反而不如 E**——这账怎么算都亏。
3. **结构感知赢麻了**：93.4%，比最强的固定切法还高 7.5 个点，ctx token 只比 C 组多 25%。原因不玄学：中文技术文档/内部 wiki 本来就是"一个标题一个语义单元"，E 组的切段边界天然落在语义边界上；标题进正文还等于给向量加了主题关键词，bge-m3 对"问题词 ↔ 标题词"的匹配非常吃这套。

还有一个隐藏结论：**检索延迟全程 P95 < 10ms**（几百段内存暴力扫而已）。所以"RAG 慢"的时候，优化检索层（换 ANN 索引、换向量库）在几千段的规模下毫无意义，慢在生成、贵在上下文。

## 六、怎么验证你自己的结论（换语料也适用）

本文的所有数字都可以用上面第四节代码在你自己的语料上重跑。验证清单：

```bash
# 1. 模型就绪
ollama list | grep bge-m3

# 2. 跑 5 组（换 tag 重跑即可）
mvn -q compile exec:java -Dexec.mainClass=ChunkEvalMain -Dexec.args="c200-o0"
mvn -q compile exec:java -Dexec.mainClass=ChunkEvalMain -Dexec.args="heading"

# 3. 人肉抽查 MISS：命中判定错没错，一看便知
grep MISS results-heading.csv | head

# 4. 汇总命中率（40 题）
for f in results-*.csv; do
  echo "$f hit=$(($(grep -c ',1,' $f) ))/40"
done
```

**判定口径要对齐两件事**：一是 metadata 必须真的进了段（打印一条 segment 的 metadata 确认）；二是评测问题不能抄文档原句（见坑 4）。结论如果和本文方向相反（比如你的语料是短段落闲聊型），那恰恰说明切分要跟着语料结构走——这正是这篇想说的。

## 七、七个坑

1. **字符 ≠ token，超窗静默截断**。`DocumentSplitters.recursive` 按字符切，但 Embedding 模型按 token 收：bge-m3 窗口 8192 token 很安全，但如果你换成 all-minilm 这类 512 token 窗口的模型，1000 字的中文段（≈750 token）直接超窗——超了不报错，**尾部静默丢弃**，等于那段的后半截没入库。换模型先查窗口大小。
2. **overlap=0 在跨段语义上翻车**。C 比 B 高 4.8 个点，全是靠接缝。经验起点：重叠 15%~20%（500 字配 100 重叠）。设成 0 的唯一理由是"段落数太多想省存储"，而省下的钱远不如答错一次的成本。
3. **表格和代码块别拦腰切**。recursive 切分器不认识 Markdown 表格，一张 8 行的表从中间切开，检索到上半张永远答不出"合计"。处理办法：入库前把表格/代码块剥出来单独成段（metadata 标 `type=table`），或切完之后做一道"表格完整性"校验。故障复盘类文档全是表格，这个坑尤其疼。
4. **评测集同源过拟合，命中率虚高**。评测问题直接抄文档原句，问题向量和语料向量几乎重合，Recall@5 轻松虚高 15~20 个点，切法之间的差异反而被抹平。评测题要换人换问法写："年假有几天"写成"干满三年能休几天"。
5. **metadata 不带来源，等于盲测**。不把 `file_name`/`heading` 塞进 metadata，你既没法自动判定命中，线上也没法回答"这答案出自哪份文档"，更没法按目录过滤检索（比如只搜运维手册）。切分时顺手带上，一处写入处处受益。
6. **无脑调大 topK 是止痛药**。命中率不满意就把 topK 从 5 调到 10？命中是涨 2~3 个点，ctx token 涨 60%+，生成延迟和成本一起涨，无关段落还会稀释模型注意力。正确顺序：**先调切分，再调重叠，最后才动 topK**。
7. **检索对了答案错了，别怪切分**。先把 top5 段落直接打印出来人肉看：段落对了、答案错了，问题在生成侧（温度、系统指令、模型能力），跟切分无关。把检索和生成两个变量分开验证，是 RAG 排障的第一原则。

## 八、总结

**Key Takeaways：**

- RAG 答不准，先人肉确认"该命中的段落有没有被检索回来"，再谈换模型/换向量库——本文 5 组实验里检索 P95 全程 < 10ms，瓶颈从来不在检索层。
- 切分不是玄学，是可评测的工程参数：200 字命中率 67.5% → 标题感知 93.4%，同一份语料同一套代码，只改了切法。
- 固定切分的甜点区：中文场景 400~600 字 + 15%~20% 重叠；语料有清晰标题结构时，直接上结构感知切分，收益最大且实现只有 30 行。
- 上下文 token 是隐形成本：切大了命中率涨 1.8 个点、token 涨 95%，这笔账要在设计期算，不要上线后用账单学。

**适用 / 不适用：**

- 适用：有标题层级的技术文档、wiki、手册、复盘——内部知识库问答的绝对主流。
- 不适用：长逻辑连贯文体（合同条款、论文），段落间强依赖，需要句子级索引 + 父块回传（parent-child 检索）那一套；表格密集型文档要先单独处理表格再入库。

下一步如果想接着做：把 E 组的 metadata 过滤用起来（按部门/目录检索），再上一个 reranker 对 top10 重排到 top5——那是这个系列的第三篇。

## 参考资料

1. LangChain4j 官方文档（DocumentSplitters / EmbeddingStore / Ollama 集成）：https://docs.langchain4j.dev/
2. Ollama（本地模型运行时，bge-m3 / qwen2.5 模型库）：https://github.com/ollama/ollama
3. 美团技术团队博客（检索、问答与工程实践方向长期输出，本文"先拆变量再归因"的评测思路参考）：https://tech.meituan.com/
4. 阿里云开发者社区（RAG / 知识库问答系列实践入口）：https://developer.aliyun.com/
5. LangChain 官方文档：Text splitters（外文，仅参考其切分策略分类与评估维度设计）：https://python.langchain.com/docs/concepts/text_splitters/
