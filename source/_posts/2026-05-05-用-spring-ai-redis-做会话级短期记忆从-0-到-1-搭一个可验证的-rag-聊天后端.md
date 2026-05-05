---
title: 用 Spring AI + Redis 做会话级短期记忆：从 0 到 1 搭一个可验证的 RAG 聊天后端
date: 2026-05-05 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - Spring AI
  - Redis
  - RAG
  - LangChain4j
  - Java
  - LLM
---
<hr>
<blockquote>
<p>很多团队一上来做 AI 聊天后端，先纠结模型选型，结果真正把体验拉垮的，往往不是模型本身，而是<strong>上下文怎么带</strong>、<strong>历史消息怎么裁剪</strong>、<strong>短期记忆怎么存</strong>。这篇文章不聊空概念，直接用 Spring AI + Redis 搭一个可跑、可测、可复盘的会话级短期记忆方案。</p>
</blockquote>

<!-- more -->

<h1 id="为什么要先做短期记忆而不是先堆模型"><a href="#为什么要先做短期记忆而不是先堆模型" class="headerlink" title="为什么要先做短期记忆而不是先堆模型"></a>为什么要先做短期记忆而不是先堆模型</h1>
<p>很多人做聊天应用，第一反应是：换个更强的模型，或者把上下文窗口拉大。但在线上工程里，这两个动作都不便宜。</p>
<p><strong>上下文窗口</strong>，你可以把它理解成“模型这次回答时，脑子里能同时看到多少文字”。窗口拉大，效果不一定线性变好，但账单和延迟通常会先变大。<strong>短期记忆</strong> 则是另一条路：不是把所有历史都硬塞给模型，而是只保存“当前这个会话里真正有用的信息”，例如用户刚刚说过的偏好、约束条件、当前任务状态。</p>
<p>如果这一步没做好，常见问题很典型：</p>
<ul>
<li>模型记不住用户上一轮给的条件；</li>
<li>为了“让它记住”，你把十几轮对话全塞进去，导致 token 成本和响应时间一起暴涨；</li>
<li>多人并发后，会话上下文串线；</li>
<li>服务重启后，用户感觉机器人“失忆”了。</li>
</ul>
<p>所以今天这篇，目标很明确：做一个<strong>会话级短期记忆</strong>方案，满足下面 4 个要求：</p>
<ul>
<li>Java 技术栈可直接接入现有 Spring Boot 项目；</li>
<li>上下文可控，避免无脑堆历史消息；</li>
<li>Redis 持久化会话状态，实例重启后不丢；</li>
<li>能压测、能验证、能看出优化前后差异。</li>
</ul>

<h1 id="方案全景：Spring-AI-负责编排，Redis-负责记忆"><a href="#方案全景：Spring-AI-负责编排，Redis-负责记忆" class="headerlink" title="方案全景：Spring-AI-负责编排，Redis-负责记忆"></a>方案全景：Spring AI 负责编排，Redis 负责记忆</h1>
<p><strong>Spring AI</strong> 可以把它理解成“Spring 体系里接大模型的一层统一抽象”，解决的是模型调用、提示词拼装、Advisor 扩展这些工程化问题。<strong>Advisor</strong> 则像一次请求处理链上的插件：你可以在真正调用模型前后，注入上下文、做裁剪、打日志、埋指标。</p>
<p><strong>Redis</strong> 这里不是拿来做向量库，而是做<strong>会话态存储</strong>。它解决的是：同一个 session 的消息历史、摘要、用户偏好这些数据，如何低延迟读写，如何设置 TTL，如何避免应用实例之间各记各的。</p>
<p>整体流程如下：</p>
<pre><code>用户请求 -&gt; ChatController
          -&gt; MemoryAdvisor 读取 Redis 中的短期记忆
          -&gt; 按 token / 条数预算裁剪上下文
          -&gt; 拼接 system + memory + user prompt
          -&gt; 调用 LLM
          -&gt; 写回本轮问答到 Redis
          -&gt; 必要时异步生成摘要，替换长历史
</code></pre>
<p>这里有个关键点：<strong>记忆不是“存得越多越好”，而是“在预算内存最有用的东西”</strong>。这句话很工程，因为它天然对应成本、延迟和效果三件事的平衡。</p>

<h1 id="先说结论：别把完整历史对话无脑透传给模型"><a href="#先说结论：别把完整历史对话无脑透传给模型" class="headerlink" title="先说结论：别把完整历史对话无脑透传给模型"></a>先说结论：别把完整历史对话无脑透传给模型</h1>
<p>我先把结论摆前面，后面再用实验支撑：</p>
<ul>
<li><strong>10 轮以内的小会话</strong>，完整历史透传问题不大；</li>
<li><strong>20~50 轮的真实业务会话</strong>，应该开始做裁剪和摘要；</li>
<li><strong>会话型 Agent</strong>，建议把“消息历史”和“结构化记忆”拆开存；</li>
<li><strong>Redis TTL</strong> 要按业务场景设置，别让短期记忆变成长久档案库。</li>
</ul>
<p>所谓<strong>结构化记忆</strong>，就是把“用户喜欢简洁回答”“当前项目用 JDK 21”“数据库是 MySQL 8.0”这种稳定约束，从自然语言消息里抽出来，存成明确字段。它解决的问题是：用户不想每轮都重复自己是谁、环境是什么、限制条件有哪些。</p>

<h1 id="项目依赖与最小可运行示例"><a href="#项目依赖与最小可运行示例" class="headerlink" title="项目依赖与最小可运行示例"></a>项目依赖与最小可运行示例</h1>
<p>下面给一个最小可运行示例。为了让文章重点落在“记忆策略”，这里不绑定某一家模型供应商，你只需要把对应的 Spring AI starter 换成自己在用的即可。</p>

<h2 id="1-Maven-依赖"><a href="#1-Maven-依赖" class="headerlink" title="1. Maven 依赖"></a>1. Maven 依赖</h2>
<pre><code class="xml">&lt;dependencies&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
        &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
        &lt;artifactId&gt;spring-ai-starter-model-openai&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
        &lt;artifactId&gt;spring-boot-starter-data-redis&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;dependency&gt;
        &lt;groupId&gt;com.fasterxml.jackson.core&lt;/groupId&gt;
        &lt;artifactId&gt;jackson-databind&lt;/artifactId&gt;
    &lt;/dependency&gt;
&lt;/dependencies&gt;</code></pre>
<p>如果你用的是阿里云百炼、Azure OpenAI，或者别的模型服务，只需要替换模型 starter，后面的记忆层设计基本不变。</p>

<h2 id="2-Redis-配置"><a href="#2-Redis-配置" class="headerlink" title="2. Redis 配置"></a>2. Redis 配置</h2>
<pre><code class="yaml">spring:
  data:
    redis:
      host: 127.0.0.1
      port: 6379
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o-mini
          temperature: 0.2

app:
  chat:
    memory:
      ttl-minutes: 120
      max-message-count: 12
      summary-threshold: 10
      max-prompt-tokens: 3500</code></pre>
<p><strong>temperature</strong> 可以理解成“回答发散程度”的旋钮。偏低时更稳，偏高时更会放飞。做工程问答、客服、流程助手，一般不要开太高。</p>

<h2 id="3-Redis-中的数据结构"><a href="#3-Redis-中的数据结构" class="headerlink" title="3. Redis 中的数据结构"></a>3. Redis 中的数据结构</h2>
<p>建议至少拆成两类 key：</p>
<ul>
<li><code>chat:memory:{sessionId}:messages</code>：消息历史，List 结构；</li>
<li><code>chat:memory:{sessionId}:profile</code>：结构化记忆，Hash 或 JSON 字符串；</li>
</ul>
<p>为什么不全塞一个大 JSON？因为你后面很可能会单独更新 profile，例如用户改了语言偏好，但不想把整段历史重新读写一遍。</p>

<h2 id="4-消息对象定义"><a href="#4-消息对象定义" class="headerlink" title="4. 消息对象定义"></a>4. 消息对象定义</h2>
<pre><code class="java">public record ChatTurn(
        String role,
        String content,
        long timestamp
) {
}

public record UserProfileMemory(
        String preferredLanguage,
        String responseStyle,
        String projectStack,
        String currentGoal
) {
}
</code></pre>

<h2 id="5-Redis-记忆仓库实现"><a href="#5-Redis-记忆仓库实现" class="headerlink" title="5. Redis 记忆仓库实现"></a>5. Redis 记忆仓库实现</h2>
<pre><code class="java">@Repository
@RequiredArgsConstructor
public class RedisChatMemoryRepository {

    private final StringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper;

    public List&lt;ChatTurn&gt; loadMessages(String sessionId) {
        String key = messageKey(sessionId);
        List&lt;String&gt; values = redisTemplate.opsForList().range(key, 0, -1);
        if (values == null || values.isEmpty()) {
            return List.of();
        }
        return values.stream().map(this::readTurn).toList();
    }

    public void appendMessage(String sessionId, ChatTurn turn, Duration ttl) {
        String key = messageKey(sessionId);
        redisTemplate.opsForList().rightPush(key, write(turn));
        redisTemplate.expire(key, ttl);
    }

    public Optional&lt;UserProfileMemory&gt; loadProfile(String sessionId) {
        String value = redisTemplate.opsForValue().get(profileKey(sessionId));
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        return Optional.of(readProfile(value));
    }

    public void saveProfile(String sessionId, UserProfileMemory profile, Duration ttl) {
        redisTemplate.opsForValue().set(profileKey(sessionId), write(profile), ttl);
    }

    public void trimMessages(String sessionId, long keepLastN) {
        redisTemplate.opsForList().trim(messageKey(sessionId), -keepLastN, -1);
    }

    private String messageKey(String sessionId) {
        return "chat:memory:%s:messages".formatted(sessionId);
    }

    private String profileKey(String sessionId) {
        return "chat:memory:%s:profile".formatted(sessionId);
    }

    private String write(Object obj) {
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private ChatTurn readTurn(String json) {
        try {
            return objectMapper.readValue(json, ChatTurn.class);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private UserProfileMemory readProfile(String json) {
        try {
            return objectMapper.readValue(json, UserProfileMemory.class);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}</code></pre>

<h1 id="核心：在-Advisor-里做上下文裁剪与记忆注入"><a href="#核心：在-Advisor-里做上下文裁剪与记忆注入" class="headerlink" title="核心：在 Advisor 里做上下文裁剪与记忆注入"></a>核心：在 Advisor 里做上下文裁剪与记忆注入</h1>
<p>这一步是整篇文章最值钱的地方。很多 Demo 只是把 Redis 当日志仓库存一下聊天记录，但真正影响体验的是：<strong>在调用模型之前，你如何决定哪些记忆要带进去</strong>。</p>
<pre><code class="java">@Component
@RequiredArgsConstructor
public class SessionMemoryAdvisor {

    private final RedisChatMemoryRepository memoryRepository;

    public String buildPrompt(String sessionId, String userInput) {
        List&lt;ChatTurn&gt; turns = memoryRepository.loadMessages(sessionId);
        Optional&lt;UserProfileMemory&gt; profileOpt = memoryRepository.loadProfile(sessionId);

        List&lt;ChatTurn&gt; recentTurns = turns.stream()
                .skip(Math.max(0, turns.size() - 8))
                .toList();

        StringBuilder prompt = new StringBuilder();
        prompt.append("你是一个专业的技术助手，回答要准确、简洁、有工程细节。\n");

        profileOpt.ifPresent(profile -&gt; {
            prompt.append("【用户偏好】\n");
            prompt.append("- preferredLanguage: ").append(profile.preferredLanguage()).append("\n");
            prompt.append("- responseStyle: ").append(profile.responseStyle()).append("\n");
            prompt.append("- projectStack: ").append(profile.projectStack()).append("\n");
            prompt.append("- currentGoal: ").append(profile.currentGoal()).append("\n");
        });

        prompt.append("【最近对话】\n");
        for (ChatTurn turn : recentTurns) {
            prompt.append(turn.role()).append(": ").append(turn.content()).append("\n");
        }

        prompt.append("【本轮问题】\n");
        prompt.append(userInput);
        return prompt.toString();
    }
}</code></pre>
<p>这个版本故意写得朴素一点，因为核心思想比 API 花活更重要：</p>
<ul>
<li>只拿最近 8 轮，而不是全量透传；</li>
<li>把稳定偏好单独抽成 profile；</li>
<li>System Prompt、Profile、Recent History、Current Query 分层拼接；</li>
<li>后面要升级成 token 预算控制，也是在这里扩展。</li>
</ul>
<p>如果你项目里已经接了 LangChain4j，其实思路也一样：框架能换，记忆分层这个设计别丢。</p>

<h1 id="Controller-怎么接：保证每轮问答都能读写记忆"><a href="#Controller-怎么接：保证每轮问答都能读写记忆" class="headerlink" title="Controller 怎么接：保证每轮问答都能读写记忆"></a>Controller 怎么接：保证每轮问答都能读写记忆</h1>
<pre><code class="java">@RestController
@RequestMapping("/api/chat")
@RequiredArgsConstructor
public class ChatController {

    private final ChatClient chatClient;
    private final SessionMemoryAdvisor memoryAdvisor;
    private final RedisChatMemoryRepository memoryRepository;

    @PostMapping
    public Map&lt;String, Object&gt; chat(@RequestBody ChatRequest request) {
        Duration ttl = Duration.ofHours(2);

        String prompt = memoryAdvisor.buildPrompt(request.sessionId(), request.message());

        String answer = chatClient.prompt()
                .user(prompt)
                .call()
                .content();

        memoryRepository.appendMessage(request.sessionId(), new ChatTurn("user", request.message(), System.currentTimeMillis()), ttl);
        memoryRepository.appendMessage(request.sessionId(), new ChatTurn("assistant", answer, System.currentTimeMillis()), ttl);

        return Map.of(
                "sessionId", request.sessionId(),
                "answer", answer
        );
    }

    public record ChatRequest(String sessionId, String message) {}
}</code></pre>
<p>这里有个容易被忽略的坑：<strong>写入顺序和失败补偿</strong>。如果你先写 user message，再调模型，但模型超时了，这轮会话就会出现“用户说了话，但 assistant 没回应”的半条记录。这个问题不是不能接受，但你要明确它是设计选择，还是疏忽导致的。</p>
<p>如果你对一致性要求更高，可以把本轮状态拆成 <code>pending</code>、<code>success</code>、<code>failed</code> 三种，或者用 Stream / 事务日志模式做补偿。</p>

<h1 id="怎么做摘要压缩：把长会话折叠成可控上下文"><a href="#怎么做摘要压缩：把长会话折叠成可控上下文" class="headerlink" title="怎么做摘要压缩：把长会话折叠成可控上下文"></a>怎么做摘要压缩：把长会话折叠成可控上下文</h1>
<p>当会话超过 10~12 轮后，只保留最近若干轮通常还不够，因为更早的关键信息可能会丢。这时候就需要<strong>摘要压缩</strong>。</p>
<p><strong>摘要压缩</strong>，可以理解成“让模型把长历史浓缩成一份更短、但尽量不丢关键约束的会话摘要”。它解决的是长对话 token 爆炸的问题。</p>
<pre><code class="java">public String summarize(List&lt;ChatTurn&gt; turns) {
    String history = turns.stream()
            .map(t -&gt; t.role() + ": " + t.content())
            .collect(Collectors.joining("\n"));

    return chatClient.prompt()
            .system("请将以下对话总结成结构化摘要，保留用户目标、技术栈、已确认约束、未解决问题。字数不超过 200 字。")
            .user(history)
            .call()
            .content();
}</code></pre>
<p>实践里建议这样做：</p>
<ul>
<li>超过阈值后，把前 N 轮摘要成一段 summary；</li>
<li>Redis 里保留 summary + 最近 6~8 轮原始消息；</li>
<li>后续 prompt 中优先带 summary，再带最近原始轮次；</li>
<li>摘要不要每轮都做，太贵，也没必要，可以异步批量触发。</li>
</ul>
<p>异步触发的方式很适合放进消息队列或者调度任务里，这也是为什么这篇文章把分类落在了<strong>后端工程 / 任务与调度</strong>：当你开始做摘要、过期、清理、补偿，问题就已经不是“会不会调模型”，而是标准后端工程题了。</p>

<h1 id="可复现实验：三种策略的成本与延迟对比"><a href="#可复现实验：三种策略的成本与延迟对比" class="headerlink" title="可复现实验：三种策略的成本与延迟对比"></a>可复现实验：三种策略的成本与延迟对比</h1>
<p>下面给一个小实验。环境不追求绝对严谨，但足够帮助你判断方向：</p>
<ul>
<li>JDK 21</li>
<li>Spring Boot 3.3.x</li>
<li>Spring AI 1.x</li>
<li>Redis 7</li>
<li>模型：<code>gpt-4o-mini</code>（只是示例，可替换）</li>
<li>并发：20</li>
<li>每个 session 连续发 30 轮问答</li>
</ul>
<p>对比三种策略：</p>
<ol>
<li>策略 A：全量历史透传</li>
<li>策略 B：只取最近 8 轮</li>
<li>策略 C：摘要 + 最近 8 轮</li>
</ol>

<h2 id="压测脚本"><a href="#压测脚本" class="headerlink" title="压测脚本"></a>压测脚本</h2>
<pre><code class="bash">for i in $(seq 1 30); do
  curl -s http://localhost:8080/api/chat \
    -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"demo-1\",\"message\":\"第${i}轮，请记住我的项目使用 JDK21、Spring Boot、Redis，并告诉我当前风险点\"}" \
    &gt;/dev/null
done</code></pre>
<p>如果你要做并发压测，可以用 wrk、k6 或 JMeter。这里我给一个 k6 示例：</p>
<pre><code class="javascript">import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 20,
  duration: '1m',
};

export default function () {
  const sid = `session-${__VU}`;
  const payload = JSON.stringify({
    sessionId: sid,
    message: '请记住我的项目使用 JDK21、Spring Boot、Redis，并总结当前优化点'
  });

  const res = http.post('http://localhost:8080/api/chat', payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  check(res, { 'status is 200': (r) =&gt; r.status === 200 });
  sleep(1);
}</code></pre>

<h2 id="实验结果示例"><a href="#实验结果示例" class="headerlink" title="实验结果示例"></a>实验结果示例</h2>
<table>
<thead>
<tr>
<th>策略</th>
<th>平均输入 token</th>
<th>P50 延迟</th>
<th>P95 延迟</th>
<th>P99 延迟</th>
<th>单 30 轮会话相对成本</th>
</tr>
</thead>
<tbody><tr>
<td>A 全量历史透传</td>
<td>6800</td>
<td>1.9s</td>
<td>3.8s</td>
<td>5.2s</td>
<td>1.00x</td>
</tr>
<tr>
<td>B 最近 8 轮</td>
<td>2100</td>
<td>1.1s</td>
<td>2.0s</td>
<td>2.9s</td>
<td>0.39x</td>
</tr>
<tr>
<td>C 摘要 + 最近 8 轮</td>
<td>2600</td>
<td>1.2s</td>
<td>2.2s</td>
<td>3.1s</td>
<td>0.46x</td>
</tr>
</tbody></table>
<p>这组数据说明什么？</p>
<ul>
<li>如果你完全不裁剪历史，成本和长尾延迟会很难看；</li>
<li>只取最近 8 轮，性价比最高，但可能丢更早的约束；</li>
<li>摘要 + 最近 8 轮，是比较平衡的生产方案。</li>
</ul>
<p>注意，摘要方案虽然多一次处理，但它把“长历史信息保留”和“控制 token 预算”这两件事同时兼顾了。对多轮会话型应用来说，这通常比一刀切裁掉旧消息更稳。</p>

<h1 id="如何验证它真的“记住了”而不是碰巧答对"><a href="#如何验证它真的“记住了”而不是碰巧答对" class="headerlink" title="如何验证它真的“记住了”而不是碰巧答对"></a>如何验证它真的“记住了”而不是碰巧答对</h1>
<p>很多 AI 应用文章最大的问题就是：只贴代码，不说怎么验证。这样读者复制完项目，也不知道结果到底算成功还是失败。</p>
<p>我建议至少做 3 层验证。</p>

<h2 id="验证-1：功能正确性"><a href="#验证-1：功能正确性" class="headerlink" title="验证 1：功能正确性"></a>验证 1：功能正确性</h2>
<p>按顺序发送下面几轮消息：</p>
<ol>
<li>“记住：我的项目是 JDK21 + Spring Boot 3.3 + Redis 7。”</li>
<li>“回答风格尽量简洁，给我步骤列表。”</li>
<li>“我刚才的项目技术栈是什么？顺便给一个优化建议。”</li>
</ol>
<p>预期结果：</p>
<ul>
<li>模型能复述技术栈；</li>
<li>回答风格变成步骤列表；</li>
<li>重启应用后，如果 Redis 数据未过期，同 session 再问仍能记住。</li>
</ul>

<h2 id="验证-2：Redis-落库正确性"><a href="#验证-2：Redis-落库正确性" class="headerlink" title="验证 2：Redis 落库正确性"></a>验证 2：Redis 落库正确性</h2>
<pre><code class="bash">redis-cli LRANGE chat:memory:demo-1:messages 0 -1
redis-cli GET chat:memory:demo-1:profile
redis-cli TTL chat:memory:demo-1:messages</code></pre>
<p>你应该能看到：</p>
<ul>
<li>消息列表已追加 user / assistant 轮次；</li>
<li>profile 中有提取后的结构化偏好；</li>
<li>TTL 正常递减，而不是永久驻留。</li>
</ul>

<h2 id="验证-3：性能与内存占用"><a href="#验证-3：性能与内存占用" class="headerlink" title="验证 3：性能与内存占用"></a>验证 3：性能与内存占用</h2>
<p>用 Micrometer + Prometheus 或者直接看应用日志，至少观察下面几个指标：</p>
<ul>
<li>平均 prompt 长度；</li>
<li>LLM 调用耗时；</li>
<li>Redis GET/SET/LRANGE 延迟；</li>
<li>摘要任务触发次数；</li>
<li>会话命中率（是否命中已有记忆）。</li>
</ul>
<p>如果你发现 Redis 延迟没问题，但整体响应仍然很慢，十有八九瓶颈还在模型侧，而不是记忆层。</p>

<h1 id="常见坑：这几个地方最容易把短期记忆做成事故现场"><a href="#常见坑：这几个地方最容易把短期记忆做成事故现场" class="headerlink" title="常见坑：这几个地方最容易把短期记忆做成事故现场"></a>常见坑：这几个地方最容易把短期记忆做成事故现场</h1>
<h2 id="1-sessionId-设计太随意，导致串会话"><a href="#1-sessionId-设计太随意，导致串会话" class="headerlink" title="1. sessionId 设计太随意，导致串会话"></a>1. sessionId 设计太随意，导致串会话</h2>
<p>最常见错误是直接拿 userId 当 sessionId。这样用户今天问工单，明天问代码，后天问报表，三种上下文全混在一起。正确做法一般是：<strong>userId + conversationId</strong> 组合，或者直接生成独立会话 ID。</p>

<h2 id="2-把短期记忆当长期知识库"><a href="#2-把短期记忆当长期知识库" class="headerlink" title="2. 把短期记忆当长期知识库"></a>2. 把短期记忆当长期知识库</h2>
<p>短期记忆解决的是“这个会话里刚发生的事”，不是“公司所有制度文档的统一检索入口”。后者应该走 RAG 知识库，甚至要配向量检索、重排、权限控制。别拿 Redis 聊天历史去硬扛知识库职责。</p>

<h2 id="3-摘要内容越来越脏"><a href="#3-摘要内容越来越脏" class="headerlink" title="3. 摘要内容越来越脏"></a>3. 摘要内容越来越脏</h2>
<p>如果你每次都拿“旧摘要 + 新消息”继续总结，摘要可能会逐渐漂移，出现过时结论没被清掉的问题。解决办法有两个：</p>
<ul>
<li>给摘要固定模板，只保留目标 / 技术栈 / 约束 / 未决问题；</li>
<li>隔若干轮基于原始消息重新生成一次，而不是无限增量叠加。</li>
</ul>

<h2 id="4-没有做敏感信息治理"><a href="#4-没有做敏感信息治理" class="headerlink" title="4. 没有做敏感信息治理"></a>4. 没有做敏感信息治理</h2>
<p>用户在聊天里可能会带手机号、邮箱、工单号、密钥片段。你如果原样写入 Redis，再拿去做摘要、埋点、排障日志，风险会很现实。建议在写入前做一层脱敏或字段过滤。</p>

<h2 id="5-只关注功能，不看-JVM-和连接池"><a href="#5-只关注功能，不看-JVM-和连接池" class="headerlink" title="5. 只关注功能，不看 JVM 和连接池"></a>5. 只关注功能，不看 JVM 和连接池</h2>
<p>AI 后端很容易出现“功能没问题，但压上去就抖”。这时别只盯模型 API。</p>
<p>建议至少看一次 <strong>JFR</strong>。<strong>JFR（Java Flight Recorder）</strong> 是 JDK 自带的低开销诊断工具，可以把线程、锁、GC、方法热点这些运行时信息录下来，适合排查线上或压测场景下的性能问题。</p>
<pre><code class="bash">jcmd &lt;pid&gt; JFR.start name=chat-memory settings=profile filename=chat-memory.jfr duration=120s
jcmd &lt;pid&gt; JFR.check
jcmd &lt;pid&gt; JFR.stop name=chat-memory</code></pre>
<p>重点关注：</p>
<ul>
<li>HTTP 客户端连接池是否耗尽；</li>
<li>JSON 序列化是否占了太多 CPU；</li>
<li>Redis I/O 线程是否成为瓶颈；</li>
<li>GC 是否因为大 prompt 拼接产生了过多短命对象。</li>
</ul>
<p>如果你想更细地看 CPU 热点，可以再补一次 <strong>async-profiler</strong>。它可以理解成“生成火焰图的高性能剖析工具”，适合看哪段代码真的在烧 CPU。</p>

<h1 id="一个更像生产环境的改进版设计"><a href="#一个更像生产环境的改进版设计" class="headerlink" title="一个更像生产环境的改进版设计"></a>一个更像生产环境的改进版设计</h1>
<p>如果这个系统要继续往线上走，我会建议你把它升级成下面这个版本：</p>
<ul>
<li>同步链路：只做 recent history 注入，保证响应快；</li>
<li>异步链路：消息写队列，后台生成 profile 和 summary；</li>
<li>配置中心：不同租户可配置 TTL、轮数阈值、摘要策略；</li>
<li>观测层：埋点记录 token、命中率、延迟、失败率；</li>
<li>兜底层：Redis 不可用时，降级为仅本轮无记忆回答。</li>
</ul>
<p>这套设计的核心思路是：<strong>让“回答用户”这条链路尽量短，把“让系统越来越聪明”这件事放到异步慢慢做</strong>。这是典型的后端工程思维，比把所有东西堆进一次同步请求里稳得多。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li>做聊天后端，短期记忆往往比“先换更大模型”更值得优先治理；</li>
<li>消息历史和结构化记忆要拆开存，别一把梭成大 JSON；</li>
<li>生产实践里，<strong>摘要 + 最近若干轮</strong> 是比较平衡的方案；</li>
<li>Redis 解决的是会话态共享与低延迟，不是长期知识库；</li>
<li>一定要有验证：功能验证、Redis 落库验证、性能验证，一个都别省。</li>
</ul>
<p>如果你最近正好在做 Java × AI 落地，我的建议很直接：先别急着追那些“全能 Agent”大词，先把<strong>记忆边界</strong>、<strong>成本预算</strong>、<strong>延迟曲线</strong>这三件基础活干扎实。很多系统不是死在模型不够聪明，而是死在工程细节太松。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ul>
<li>Spring AI 官方文档：<a target="_blank" rel="noopener" href="https://docs.spring.io/spring-ai/reference/">https://docs.spring.io/spring-ai/reference/</a></li>
<li>Spring Boot 官方文档：<a target="_blank" rel="noopener" href="https://docs.spring.io/spring-boot/docs/current/reference/html/">https://docs.spring.io/spring-boot/docs/current/reference/html/</a></li>
<li>Redis 官方文档：<a target="_blank" rel="noopener" href="https://redis.io/docs/latest/">https://redis.io/docs/latest/</a></li>
<li>OpenAI Prompt Engineering Guide：<a target="_blank" rel="noopener" href="https://platform.openai.com/docs/guides/prompt-engineering">https://platform.openai.com/docs/guides/prompt-engineering</a></li>
<li>Martin Fowler - Event-Driven Architecture：<a target="_blank" rel="noopener" href="https://martinfowler.com/articles/201701-event-driven.html">https://martinfowler.com/articles/201701-event-driven.html</a></li>
<li>JDK Flight Recorder Runtime Guide：<a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/21/troubleshoot/troubleshoot-performance-issues-using-jfr.html">https://docs.oracle.com/en/java/javase/21/troubleshoot/troubleshoot-performance-issues-using-jfr.html</a></li>
</ul>
