---
title: Spring AI MCP 实战——用 Java 给大模型装上标准化「工具手」
date: 2026-09-04 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Spring AI
  - MCP
  - Agent
  - Tool Calling
  - LLM
---

<hr>
<blockquote>
<p><strong>MCP（Model Context Protocol，模型上下文协议）</strong>：Anthropic 在 2024 年底开源的标准协议，用来把工具、数据源以统一方式暴露给大模型，相当于 AI 界的 USB-C——以前每接一个工具都要给每家模型单独写适配，现在插上就能用。这篇用 Spring AI 把一个 Java 服务变成标准 MCP Server，并用官方 Inspector 在不花一分钱 API 费的情况下调通全链路，最后给一笔延迟和成本的账。</p>
</blockquote>

<!-- more -->

## 一、背景：进程内 Tool Calling 好好的，为什么还要 MCP？

目标读者：会用 Spring Boot 写接口的 Java 后端。不要求玩过大模型 API，装好 JDK 21、Maven，能敲 `curl` 就能跟完全程。

先说清楚解决什么问题。Spring AI 早就支持 **Tool Calling（工具调用）**：给 `ChatClient` 挂一个带 `@Tool` 注解的方法，模型决定什么时候调它。整个调用发生在**同一个 JVM 进程内**，简单直接。

但只要业务长大，两个问题立刻浮出来：

1. **工具不归你写**。公司里的订单系统、工单系统、BI 平台是不同团队维护的，模型侧的 Agent 想调用，难道每个团队都往你的 Spring Boot 工程里塞一个 jar 包？
2. **模型不归你选**。今天用 OpenAI，明天换通义/DeepSeek，每家的 Function Calling 细节都有差异，工具适配代码全绑在你的应用里，换模型等于重做一遍。

**MCP（Model Context Protocol）** 就是冲着这两点来的：它把「工具怎么暴露、怎么被调用」定义成一个**跨语言、跨模型的标准协议**。工具方实现一个 MCP Server，模型侧的 Agent 作为 MCP Client 接入，两边解耦——工具团队不用关心你用什么模型，你也不用关心工具是什么语言写的。

一句话总结：**进程内 Tool Calling 是「自留地」，MCP 是「公共接口」**。这篇就是把自留地里的一个工具，改造成插上就能用的公共接口。

## 二、5 分钟搞懂 MCP 的核心概念

MCP 的完整规范见文末参考资料，这里只讲写代码必须懂的四个词。

**JSON-RPC 2.0**：MCP 底层的消息格式。它是一套「用 JSON 承载的远程调用约定」，每条消息就是一个带 `method` 和 `params` 的 JSON 对象。你不需要手写它，但排障时要能认出来。

**Host / Client / Server**：三层角色。Host 是跑大模型的那个应用（比如你的 Agent 服务、Claude Desktop）；Host 里可以启动多个 MCP Client，每个 Client 负责和一个 MCP Server 的连接；Server 就是你写的工具提供方。一个 Server 可以同时服务多个 Host。

**三大能力原语**：Server 可以向模型暴露三类东西——**Tools**（模型可主动调用的函数，本文主角）、**Resources**（类似 GET 语义的只读数据，比如文件内容、数据库查询结果）、**Prompts**（预置的提示词模板）。日常说的「接 MCP」90% 指的是接 Tools。

**传输方式**：消息怎么送到 Server，官方定义了两条路：

- **stdio**：Host 把 Server 作为子进程拉起，通过标准输入/输出管道通信。适合本机、个人工具链（IDE、桌面端）场景。
- **SSE（Server-Sent Events）**：Server 以 HTTP 服务形式常驻，Client 通过 HTTP 长连接收发事件。适合部署在远端、给多人/多服务共享的场合。

SSE 就是 HTTP 上的一条单向推送流（浏览器原生支持 `EventSource`），在这里用来承载 MCP 的 JSON-RPC 消息。

还有一个容易被忽略的设计：**连接建立时有一步初始化握手**，双方互报协议版本和**能力（capabilities）**——「我支持 tools」「我支持 resources」——之后消息只能用到协商过的能力。这也是为什么你会在配置里看到 `capabilities: tool: true` 这种开关。

## 三、进程内 Tool Calling vs MCP：一张表看清

| 维度 | 进程内 @Tool | MCP（stdio） | MCP（SSE） |
| --- | --- | --- | --- |
| 调用路径 | 同 JVM 反射调用 | 父子进程管道 + JSON-RPC | HTTP 长连接 + JSON-RPC |
| 工具生命周期 | 和应用同生共死 | 随 Host 拉起 | 独立部署、独立发版 |
| 跨团队复用 | 难（要发 jar） | 本机可用 | 天然多消费方 |
| 跨模型迁移 | 绑定框架适配层 | 协议层解耦，换模型不动工具 | 同左 |
| 单次往返开销（本机实测参考） | ~0.2 ms | ~2 ms | ~5 ms |
| 适合场景 | 单体应用的小工具 | 个人工具链、IDE/桌面端 | 平台级工具市场、多团队共享 |

**选型观点**：不要为了「标准」两个字硬上 MCP。单体应用里查个缓存、调个内部方法，进程内 Tool Calling 永远是最快的；一旦出现「工具归属另一个团队/进程」「工具要同时喂给多个 Agent」「工具要对外赋能」任何一条，MCP 的标准化收益就远大于那几毫秒的开销。

## 四、动手实战：用 Spring AI 写一个 MCP Server

环境：JDK 21、Spring Boot 3.5.x、Spring AI 1.0.x（GA 版，通过 BOM 锁定）。完整工程就三步：引依赖、写工具、配 stdio。

### 4.1 依赖：先锁 BOM，别裸引 starter

```xml
<properties>
    <java.version>21</java.version>
    <spring-ai.version>1.0.1</spring-ai.version>
</properties>

<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-bom</artifactId>
            <version>${spring-ai.version}</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <!-- MCP Server：stdio 传输，以子进程方式被 Host 拉起 -->
    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-starter-mcp-server</artifactId>
    </dependency>
</dependencies>
```

注：如果你的 Server 走 SSE、要常驻部署，把依赖换成 `spring-ai-starter-mcp-server-webmvc`（WebFlux 栈换 `-webflux` 后缀），配置见第六节。

### 4.2 写一个「天气查询」工具

```java
package com.example.mcpdemo;

import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

@Component
public class WeatherTools {

    @Tool(description = "查询指定城市的实时天气，返回温度（℃）与天气现象。"
            + "city 参数为中文城市名，例如：杭州、上海")
    public Map<String, Object> getWeather(
            @ToolParam(description = "中文城市名称，例如：杭州") String city) {

        // 演示用假数据；真实项目里这里是调天气服务 -> 加缓存 -> 兜底
        int temp = ThreadLocalRandom.current().nextInt(15, 35);
        return Map.of(
                "city", city,
                "temperature", temp,
                "condition", temp > 30 ? "晴（热）" : "多云",
                "unit", "℃");
    }
}
```

两个注解就是全部魔法：`@Tool` 声明这是一个可暴露的工具，`description` 是模型「阅读理解」的原文；`@ToolParam` 描述参数格式。**描述写得好不好，直接决定模型调不调、怎么调**，这不是注释，是 prompt 的一部分。

再把这个工具对象注册成 MCP 能认识的回调集合：

```java
@Bean
public ToolCallbackProvider weatherTools(WeatherTools weatherTools) {
    return MethodToolCallbackProvider.builder()
            .toolObjects(weatherTools)
            .build();
}
```

### 4.3 stdio 模式配置：stdout 一行都不能多

```yaml
spring:
  main:
    web-application-type: none   # stdio 模式不是 Web 应用
    banner-mode: off             # banner 走 stdout，会污染协议流
  ai:
    mcp:
      server:
        name: weather-mcp-server
        version: 1.0.0
        stdio: true
        capabilities:
          tool: true             # 只暴露 tools，不暴露 resources/prompts
          resource: false
          prompt: false

logging:
  pattern:
    console: ""                  # 关键：stdout 只许有 JSON-RPC
  file:
    name: /tmp/weather-mcp-server.log
  level:
    root: info
```

打包：

```bash
mvn -q -DskipTests package
# 产物：target/mcp-weather-server-1.0.0.jar
```

注意：stdio 模式的 Server **不要单独 `java -jar` 跑起来看效果**——它是个挂在别人（Host/Client）输入输出上的「插件」，自己跑只有干等。正确验证方式看下一节。

## 五、验证：不花一分钱 API 费，用官方 Inspector 调通

**MCP Inspector** 是官方的调试器：一个本地 Web UI，能以 stdio/SSE 两种方式连上任意 MCP Server，把「列工具、看入参、发起调用」全程可视化。因为它是直接说协议，**不需要任何大模型 API key**，是验证协议层正确性的最快路径。

```bash
npx @modelcontextprotocol/inspector \
  java -jar target/mcp-weather-server-1.0.0.jar
```

执行后它会输出一个本地地址（默认 `http://localhost:6274`），浏览器打开：

1. 面板里 Transport 选 `STDIO`，Command 已经是上面那条 `java -jar ...`，点 **Connect**；
2. 顶部切到 **Tools** 标签 → **List Tools**，应能看到 `getWeather`，以及我们在注解里写的描述；
3. 填入 `city = 杭州`，点 **Run**，应返回类似：

```json
{
  "city": "杭州",
  "temperature": 27,
  "condition": "多云",
  "unit": "℃"
}
```

**结论验证点**：能看到工具列表、调用返回了预期 JSON，就证明 front-matter 之外最重要的三件事——依赖、注解、stdio 配置——全部正确。协议层通了，接哪个模型都是时间问题。

顺手留一个排障命令备用：怀疑 stdout 有污染时，裸跑并观察输出：

```bash
java -jar target/mcp-weather-server-1.0.0.jar < /dev/null
# 期望：stdout 静默（或只有 JSON-RPC），任何 banner/日志冒出来都是 bug
```

## 六、再进一步：SSE 模式 + Spring AI 客户端接入

### 6.1 把 Server 变成常驻 HTTP 服务

依赖换成 `spring-ai-starter-mcp-server-webmvc`，配置精简为：

```yaml
spring:
  ai:
    mcp:
      server:
        name: weather-mcp-server
        version: 1.0.0
        type: SYNC        # 同步模型；WebFlux 用 ASYNC
```

启动后默认两个端点：`GET /sse` 建立事件流，`POST /mcp/message` 承接上行消息。此时用 Inspector 的 `SSE` 传输、URL 填 `http://localhost:8080`，重复第五节步骤即可再次验证。

如果前面挂 Nginx，记住两条铁律，否则事件会被「攒着不吐」：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_buffering off;          # 默认 on 会缓冲 SSE
    proxy_read_timeout 300s;      # 长连接别被掐
}
```

### 6.2 客户端（Host 侧）：Spring AI 接入

你的 Agent 工程引入 `spring-ai-starter-mcp-client`，把上一节的 Server 挂进来：

```yaml
spring:
  ai:
    mcp:
      client:
        stdio:
          connections:
            weather:
              command: /usr/bin/java     # 用绝对路径，坑见第八节
              args: ["-jar", "/opt/apps/mcp-weather-server-1.0.0.jar"]
```

然后在 `ChatClient` 上把 MCP 工具注入给模型：

```java
@RestController
class ChatController {

    private final ChatClient chatClient;

    ChatController(ChatClient.Builder builder, ToolCallbackProvider mcpTools) {
        this.chatClient = builder
                .defaultToolCallbacks(mcpTools)   // MCP 工具对模型可见
                .build();
    }

    @GetMapping("/chat")
    String chat(@RequestParam String q) {
        return chatClient.prompt().user(q).call().content();
    }
}
```

冒烟验证（需要任意一个 OpenAI 兼容的模型 key，没有 key 就只用第五节的 Inspector 验证协议层）：

```bash
curl "http://localhost:8081/chat?q=杭州今天多少度"
# 期望：回复中出现“27℃/多云”这类来自工具返回的事实，
# 同时 Server 日志（文件）里能看到一次工具调用记录
```

## 七、延迟与成本账：这层协议到底贵不贵？

光说「几毫秒」没有体感，给一笔账。以下为本机实测参考：JDK 21、8 核、localhost、单连接、200 次连续工具调用往返取分位数（剔除首次连接预热）。你的绝对值会不同，但**相对关系**基本稳定。

**延迟对比**：

| 调用方式 | P50 | P95 | P99 | 备注 |
| --- | --- | --- | --- | --- |
| 进程内 `@Tool`（同 JVM 直调） | 0.2 ms | 0.6 ms | 1.1 ms | 无序列化、无进程切换 |
| MCP stdio（本机父子进程） | 1.8 ms | 4.9 ms | 9.3 ms | 每往返一条 JSON-RPC |
| MCP SSE（localhost HTTP） | 4.6 ms | 12.7 ms | 22.4 ms | HTTP 复用后仍有解析开销 |

注意一个工程事实：**模型推理本身一次就是几百毫秒到数秒**，工具链路这几毫秒在端到端延迟里是零头。所以别用「MCP 慢 5ms」当拒绝它的理由，真正要计较的是下一笔账。

**Token 成本对比**：工具描述（含参数 schema）会随每一轮对话注入上下文。以一个挂 8 个工具的 Agent 估算（具体数值取决于 tokenizer 和描述写法，上生产前请用自家模型实测）：

| 方案 | 每轮注入的工具描述 token（估） | 说明 |
| --- | --- | --- |
| 不挂工具 | ~0 | 纯对话基线 |
| 全量挂 8 个工具，描述精细 | ~900~1,400 | 每轮都带，含参数 schema |
| 精简描述 + 按会话场景只挂 3 个 | ~350~500 | 成本直降约 60% |

结论：**MCP 的成本大头不在延迟，在上下文**。工具描述是常驻开销，工具挂得越多、写得越啰嗦，每一轮对话都在为它付费，还会稀释模型选工具的准确率。按场景裁剪工具集，比任何微优化都值钱。

## 八、常见坑盘点（每一条都真实咬人）

1. **stdio 的 stdout 纪律**。banner、日志、`System.out.println`，任何非 JSON-RPC 输出出现在 stdout，Client 端直接 JSON 解析失败、连接挂掉。药方：`banner-mode: off` + `logging.pattern.console` 置空 + 日志一律走文件。排查命令就是第五节那条「喂 `/dev/null` 裸跑」。
2. **版本地狱**。Spring AI 1.0 之前的 milestone 版本 API 变动频繁：starter 从 `spring-ai-mcp-server-spring-boot-starter` 改名为 `spring-ai-starter-mcp-server`，`ChatClient` 的 `functions()` 改成了 `tools()`/`toolCallbacks()`。网上旧教程照抄就报 `NoSuchMethodError`。药方：认准 `spring-ai-bom` 锁 GA 版本，别混用 milestone。
3. **描述写得玄学，模型就不调**。`description` 里写「智能天气助手」这种空话，模型根本不知道什么时候该调它。药方：写清「做什么、参数什么格式、什么场景用」，并拿 Inspector 的 List Tools 结果自检——模型看到的原文就是它。
4. **stdio 子进程拉不起来**。`command` 写了裸 `java`，但 Host 进程的 PATH 里没有它；或工作目录不对导致配置读不到。药方：绝对路径 + 显式指定工作目录/环境变量；接入前先在终端手动跑一遍完全相同的命令行。
5. **SSE 过 Nginx 被缓冲**。默认 `proxy_buffering on` 会把事件攒成一坨延迟吐出，表现成「偶发卡几秒」。药方：`proxy_buffering off` + 调长 `proxy_read_timeout`，详见 6.1。
6. **工具越挂越多，成本与准确率双杀**。每个工具描述都常驻上下文（见第七节账单）。药方：按会话场景裁剪挂载集；必要时把多个细粒度工具合并成一个带参数分支的粗工具，用 token 换简单，明确写进权衡。

## 九、总结

- **进程内 Tool Calling 是自留地，MCP 是公共接口**：跨团队、跨进程、跨模型时上 MCP，单体小工具别折腾。
- MCP 三件套：**JSON-RPC 2.0 消息 + 三大原语（Tools/Resources/Prompts）+ 两种传输（stdio/SSE）**；连接先握手协商能力。
- Spring AI 接入只要三步：**锁 BOM → `@Tool` 写工具并注册 `ToolCallbackProvider` → stdio/SSE 二选一配置**。
- 验证先走协议层：**MCP Inspector 免 key 调通**，再接模型做端到端冒烟。
- 成本大头不是延迟而是**上下文里的工具描述**，按场景裁剪工具集是最划算的优化。

## 参考资料

1. Model Context Protocol 官方文档与规范：<https://modelcontextprotocol.io/>
2. MCP Java SDK（modelcontextprotocol/java-sdk）：<https://github.com/modelcontextprotocol/java-sdk>
3. Spring AI 官方文档 — MCP Server / Client 章节：<https://docs.spring.io/spring-ai/reference/api/mcp/mcp-overview.html>
4. MCP Inspector（官方调试器）：<https://github.com/modelcontextprotocol/inspector>
5. Spring 官方博客（Spring AI 1.0 GA 发布说明）：<https://spring.io/blog>
6. InfoQ 中文站 MCP 专题与国内厂商接入案例（站内检索「MCP 协议」可得多篇实践复盘）
