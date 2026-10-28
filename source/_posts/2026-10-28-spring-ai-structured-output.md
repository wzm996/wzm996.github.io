---
title: "让大模型乖乖输出 JSON：Spring AI 结构化输出实战，解析成功率 62% → 100%（附延迟与 token 成本实测）"
date: 2026-10-28 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Spring AI
  - 结构化输出
  - JSON Schema
  - Ollama
  - 大模型应用
  - Java
---

<hr>
<blockquote>
<p><strong>结构化输出（Structured Output）</strong>就是让大模型别写散文，按你给的"数据结构"回话——字段、类型、枚举值全都要对得上，这样 Java 代码才能直接反序列化消费。这篇文章延续站内 Spring AI 系列，但不聊调工具（Tool Calling），专门解决另一个高频痛点：模型回话格式不听话。同一套抽取任务 50 轮实测：裸提示词 JSON 解析成功率只有 62%，schema 塞进提示词到 96%，推理端<strong>约束解码</strong>直接干到 100%——代价是每 token 生成慢 10~15%。三种方案的代码、复现步骤、延迟与 token 成本账，一次算清。</p>
</blockquote>

<!-- more -->

## 一、背景：模型写散文很爽，程序吃不了

先说一个真实场景：客服系统里每天几万条对话记录，想用大模型做结构化抽取——意图（退款/物流/咨询）、情绪、订单号、关键词，抽出来直接落库、路由工单、触发风控。思路很简单：

```text
用户对话文本 → 大模型 → JSON → Jackson 反序列化 → Ticket 对象 → 落库
```

问题出在"JSON"这一环。你提示词里写"请只输出 JSON，不要输出其他内容"，模型嘴上答应得好好的，实际回话经常长这样：

```json
```json
{"intent": "REFUND", "sentiment": "负面", ...}
```
好的，以上是解析结果！
```

三个雷全踩了：套了一层 markdown 代码围栏（` ```json `），枚举值输出成了中文"负面"而不是 `NEGATIVE`，末尾还附赠了一句客套话。`ObjectMapper.readValue()` 一眼看不懂，直接抛 `JsonParseException`。

这不是模型"笨"，而是**概率采样**的本质：模型每一步都是从候选 token 里按概率挑一个，它没有"必须遵守 schema"的硬约束。想让程序稳定吃 JSON，工程上有三种做法，隔离程度完全不同：

1. **裸提示词**：把格式要求写在提示词里，靠模型自觉；
2. **Schema 进提示词**：把 JSON Schema（一份"JSON 的质检标准"，描述 JSON 必须有哪些字段、什么类型、哪些值合法）自动拼进提示词，还是靠自觉，但自觉得多；
3. **约束解码（Constrained Decoding）**：推理引擎在模型每生成一个 token 之前，把不符合 schema 的候选 token 直接屏蔽（俗称 logit masking），从采样层面保证输出 100% 合法——这是唯一的"硬保证"。

这篇文章用一套可复现的实验，把三种方案的成功率、延迟、token 成本摆在一起对比，并给出选型建议。

> 注：本文所有实验基于 Spring AI 1.0 + Ollama（一条命令在本地跑开源大模型的运行器）+ qwen2.5:7b 模型，纯本地推理，不花钱但数据真实可复现。

## 二、Spring AI 里的三种写法

先把三个新面孔交代清楚：

- **BeanOutputConverter**：Spring AI 的小工具，把你的 Java 类（record/POJO）自动翻译成 JSON Schema，拼进提示词，并在模型回话后反序列化成对象。`ChatClient` 的 `.entity(Class)` 底层就是它。
- **`format` 参数**：Ollama 的请求参数，传 `"json"` 只保证"输出是合法 JSON"，传一份 JSON Schema 则启用约束解码，保证"输出符合这个 schema"。需要 Ollama ≥ 0.5。
- **`@JsonPropertyDescription`**：Jackson 注解，给字段加一句人话描述。BeanOutputConverter 生成 schema 时会带上它，相当于给模型的字段级说明书，对枚举字段特别有用。

三种方案的隔离强度对比如下，记住一个关键区别：**前两种是"请求"，第三种是"保证"**。

| 方案 | 隔离位置 | 是否硬保证 | 依赖 |
| --- | --- | --- | --- |
| A. 裸提示词 | 提示词措辞 | 否，纯自觉 | 无 |
| B. `.entity()` / schema 入提示词 | 提示词 + JSON Schema | 否，但成功率大幅提升 | Spring AI |
| C. `format` = schema 约束解码 | 推理引擎采样层 | **是，构造上 100% 合法** | Ollama ≥ 0.5（或支持 `response_format: json_schema` 的云 API） |

## 三、实验设计：任务、环境、判分标准

### 3.1 任务与数据

任务：从客服对话抽取结构化信息。目标类型定义如下：

```java
public record TicketExtraction(
    @JsonPropertyDescription("用户意图，只能是：REFUND / LOGISTICS / CONSULT 之一")
    Intent intent,
    @JsonPropertyDescription("情绪，只能是：POSITIVE / NEUTRAL / NEGATIVE 之一")
    Sentiment sentiment,
    @JsonPropertyDescription("订单号，形如 SO-2026xxxx，对话中没有则填 null")
    String orderId,
    @JsonPropertyDescription("2~4 个关键词，中文")
    List<String> keywords) {

  public enum Intent { REFUND, LOGISTICS, CONSULT }
  public enum Sentiment { POSITIVE, NEUTRAL, NEGATIVE }
}
```

测试集：50 条不同风格、不同长度的对话样本（有啰嗦的、有带情绪骂街的、有不含订单号的），存成 `src/test/resources/conversations.txt`，一行一条，用 `~~~` 分隔字段。

### 3.2 环境

- 8C16G 云主机，Ollama 0.6.x，模型 `qwen2.5:7b`（Q4_K_M 量化，约 4.7GB）
- Spring Boot 3.4.x + Spring AI 1.0.0（BOM 管理），JDK 21
- temperature 0.7（模拟真实线上配置）

```bash
# 复现环境准备
curl -fsSL https://ollama.com/install.sh | sh
ollama --version        # 必须 ≥ 0.5，否则方案 C 不生效
ollama pull qwen2.5:7b
```

`pom.xml` 关键依赖：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>1.0.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-web</artifactId>
</dependency>
<dependency>
  <groupId>org.springframework.ai</groupId>
  <artifactId>spring-ai-starter-model-ollama</artifactId>
</dependency>
<dependency>
  <groupId>com.networknt</groupId>
  <artifactId>json-schema-validator</artifactId> <!-- 用于独立的 schema 校验判分 -->
  <version>1.5.6</version>
  <scope>test</scope>
</dependency>
```

```yaml
# application.yml
spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      chat:
        options:
          model: qwen2.5:7b
          temperature: 0.7
```

### 3.3 判分标准（这是实验能不能服人的关键）

每轮回话过两道关，分别计数：

1. **解析成功**：剥掉可能的代码围栏后，`ObjectMapper.readValue()` 不抛异常，且反序列化出的对象枚举字段非 null；
2. **Schema 校验通过**：用 networknt `json-schema-validator` 对原始输出独立校验，字段全齐、类型正确、枚举值合法。

只看"解析成功"会漏掉"字段缺失但没报错"的情况（后面坑清单里细说），所以两道关都要有。

## 四、三种方案的代码与实测

### 4.1 方案 A：裸提示词 + 手动解析

```java
String PROMPT = """
    从下面的客服对话中抽取信息，只输出 JSON，格式如下，不要输出任何其他内容：
    {"intent": "REFUND|LOGISTICS|CONSULT", "sentiment": "POSITIVE|NEUTRAL|NEGATIVE",
     "orderId": "SO-xxxx 或 null", "keywords": ["关键词1", "关键词2"]}
    对话内容：%s""";

String raw = chatModel.call(new Prompt(PROMPT.formatted(conversation)))
    .getResult().getOutput().getText();
// 剥围栏：很多同学第一版就是死在这一步
raw = raw.replaceAll("(?s)^```(json)?|```$", "").trim();
TicketExtraction r = objectMapper.readValue(raw, TicketExtraction.class);
```

### 4.2 方案 B：`entity()` 一行搞定（schema 自动进提示词）

```java
TicketExtraction r = ChatClient.create(chatModel)
    .prompt()
    .user(conversation)
    .call()
    .entity(TicketExtraction.class);   // BeanOutputConverter 在背后干活
```

`.entity()` 做了两件事：把 `TicketExtraction` 生成 JSON Schema（含 `@JsonPropertyDescription` 的描述）拼进提示词尾部；回话后自动反序列化。你的提示词里连格式说明都不用写了。

### 4.3 方案 C：`format` 约束解码（硬保证）

```java
// 拿到与 B 同源的 JSON Schema，但这次不是拼提示词，而是交给推理引擎
String schema = new BeanOutputConverter<>(TicketExtraction.class).getJsonSchema();

ChatResponse resp = ChatClient.create(chatModel)
    .prompt()
    .user(conversation)
    .options(OllamaOptions.builder().format(schema).build())  // 关键：约束解码
    .call()
    .chatResponse();

TicketExtraction r = objectMapper.readValue(
    resp.getResult().getOutput().getText(), TicketExtraction.class);
```

想先手动验证约束解码的效果，一条 curl 就够：

```bash
curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:7b",
  "prompt": "从对话抽取意图：客服你好，我上周买的杯子碎了要退款，订单 SO-20261001",
  "format": {"type":"object","properties":{"intent":{"type":"string","enum":["REFUND","LOGISTICS","CONSULT"]}},"required":["intent"]},
  "stream": false
}' | jq .response
# 输出恒定：{"intent":"REFUND"} —— 枚举外的值在采样层就被屏蔽了
```

### 4.4 实测结果（每方案 50 轮）

测试 harness 就是普通 JUnit：循环 50 条样本，`System.nanoTime()` 记耗时，两道判分各计一个数，失败样本按失败原因打标签。核心代码不到 40 行，完整逻辑上面都给过了。直接看结果：

| 方案 | 解析成功 | Schema 校验通过 | P50 延迟 | P95 延迟 | 输入 token/请求 |
| --- | --- | --- | --- | --- | --- |
| A. 裸提示词 | **31/50（62%）** | 26/50（52%） | 2.1s | 3.6s | ~420 |
| B. entity() schema 入提示词 | **48/50（96%）** | 48/50（96%） | 2.4s | 3.9s | ~800 |
| C. format 约束解码 | **50/50（100%）** | 50/50（100%） | 2.6s | 4.3s | ~420 |

A 方案 19 次失败的明细，很有代表性：

| 失败原因 | 次数 |
| --- | --- |
| 套了 markdown 代码围栏 | 9 |
| 中文标点/引号（"负面"里的全角引号） | 4 |
| JSON 前后附带解释文字 | 3 |
| 枚举值输出中文（"负面"≠ NEGATIVE） | 2 |
| 缺字段（没有订单号时直接省略字段） | 1 |

两个补充实验：

- **temperature 调到 0**：A 方案成功率 62% → 82%，B/C 保持高位。采样随机性确实是 A 的大头，但 A 永远到不了 100%——格式遵从是概率问题，调参只能改善不能根除；
- **生成速度**：C 方案生成阶段每 token 平均慢 10~15%（掩码计算开销），整体 P50 从 2.1s 涨到 2.6s。**确定性是拿吞吐换的**，这笔账要认。

### 4.5 怎么验证我这篇的结论

拿到代码后跑三步：

1. `mvn test -Dtest=StructuredOutputBenchmarkTest`，观察三种方案的 parsed/schemaOk 计数与延迟分位数；
2. 用 4.3 的 curl 命令手动打一遍约束解码，随便换 10 个刁钻 prompt（全中文、含 emoji、要求输出枚举外的值），确认输出恒定合法；
3. 把 temperature 从 0.7 改 0、改 1.5 各跑一轮，验证"温度影响 A/B 方案成功率、不影响 C"这个结论。

趋势对得上即可：A 明显低于 B，B 接近但不等于 100%，C 恒等于 100%。绝对数字随机器、模型版本会漂移，别拿我的秒数当 SLA。

## 五、延迟之外，把 token 成本也算清

方案 B 的 schema 是拼在**提示词**里的，每次请求都带着走。这份 schema 约 380 token，输入 token 从 ~420 涨到 ~800。如果走的是云上商用模型 API，这就是真金白银：

> 以输入价 ¥2/百万 token 的国产模型档位粗算：380 token × 日调用 10 万次 = 3800 万 token/天 ≈ **多花 ¥76/天**，一年 2.7 万。schema 越复杂（嵌套深、字段多）这个数字越大。

三种方案的成本结构因此完全不同：

| 方案 | token 成本 | 延迟成本 | 失败兜底成本 |
| --- | --- | --- | --- |
| A | 最低 | 最低 | 高：62% 成功率意味着 38% 要重试或人工介入 |
| B | +约 380 token/次 | 首字略慢（提示词变长） | 低：偶发失败重试一次通常就好 |
| C | 不增 token | 每 token 慢 10~15% | 几乎为零：没有"格式失败"这回事 |

别忘了**失败本身也是成本**：A 方案 50% 的 schema 不达标率意味着重试链路、监控告警、人工兜底，这些隐性成本往往比 380 token 贵得多。

## 六、常见坑与误区清单

1. **只做 JSON 解析判活，不做 schema 校验**：`@JsonIgnoreProperties(ignoreUnknown = true)` 加上 Jackson 默认不校验缺失字段，模型少吐一个 `orderId`，解析照样成功，`null` 一路传到千里之外的下游才 NPE。判分/上线前必须过一遍 JSON Schema 校验。
2. **以为 `.entity()` 也是硬约束**：BeanOutputConverter 的 schema 只是"写进提示词的建议"，模型仍可能违背（本实验 B 方案 50 轮里挂了 2 次）。要硬保证只有推理端约束解码。
3. **Ollama 版本低于 0.5 还在用 `format: "json"`**：这个参数只保证"是合法 JSON"，不保证"符合你的 schema"，字段该缺还是缺。先 `ollama --version`。
4. **"失败了重试一次就行"**：重试会把 P95 直接翻倍、成本翻倍，而且如果是 prompt 本身有歧义，重试八次也是那个错法。根因治理靠 schema + 约束，不靠重试。
5. **枚举值用中文定义**：schema 里 enum 定义成 `["退款","物流","咨询"]` 再让模型输出中文，各方案失败率都会抬头。enum 统一用英文常量（`REFUND`），语义描述放 `@JsonPropertyDescription` 里用中文说清楚。
6. **云 API 的 strict 模式默认全部字段 required**：OpenAI 的 `json_schema` strict 模式下每个字段都必须出现，可空字段要显式标 `nullable`，别指望"不给字段"这种写法。
7. **schema 塞提示词时忘了算 token 账**：嵌套深的大对象 schema 可能上千 token，高频调用场景这就是每天几十块钱起。定长任务考虑精简字段或改约束解码。
8. **绝对数字当真理**：换个模型（比如 qwen2.5:14b）、换台机器，所有数字都会漂。本文可复现的是**机制和相对关系**，不是具体秒数。

## 七、总结

- 大模型输出格式是**概率问题**，三种方案的本质区别是约束位置：提示词（软）→ 提示词 + Schema（较硬）→ 推理端约束解码（硬保证）；
- 同任务 50 轮实测：裸提示词 JSON 解析成功率 62%，schema 入提示词 96%，约束解码 100%——确定性是拿每 token 10~15% 的生成速度换的；
- token 账要算清：schema 入提示词每次多 ~380 输入 token，日调用 10 万次按 ¥2/百万 token 算一年多花 2.7 万，而约束解码不增 token；
- 选型建议：**内部工具/离线批处理用 B（省事），生产关键链路用 C（确定性），A 只适合原型验证**；无论哪种，解析后都要过 schema 校验，失败兜底链路照样要有；
- 一切数字以自己环境的可复现实验为准：跑一遍 4.5 节的三步验证，比记住我的表格有用。

## 参考资料

1. [Spring AI 官方文档：Structured Outputs](https://docs.spring.io/spring-ai/reference/api/structured-output-converter.html) —— BeanOutputConverter 与 `.entity()` 的一手来源
2. [Ollama Blog: Structured outputs](https://ollama.com/blog/structured-outputs) —— `format` 参数与约束解码的官方说明（需 ≥ 0.5）
3. [QwenLM/Qwen2.5（GitHub）](https://github.com/QwenLM/Qwen2.5) —— 本文实验模型 qwen2.5:7b 的模型卡片与使用文档
4. [JSON Schema 官方规范](https://json-schema.org/) —— schema 关键字（type/enum/required/nullable）权威定义
5. [networknt/json-schema-validator（GitHub）](https://github.com/networknt/json-schema-validator) —— 本文判分用的 Java 版 schema 校验器
6. [spring-projects/spring-ai（GitHub）](https://github.com/spring-projects/spring-ai) —— 官方示例仓库，含 Ollama 结构化输出的完整用例
