---
title: 给 Spring Boot 装上 MCP：Spring AI 让大模型学会「调工具」，附成本与延迟实测
date: 2026-10-06 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Spring AI
  - MCP
  - Function Calling
  - LLM
  - 工具调用
  - Java
---

<hr>
<blockquote>
<p><strong>MCP</strong>（Model Context Protocol，模型上下文协议）是 Anthropic 在 2024 年底开源的一套标准协议，解决的问题一句话就能说清：大模型只会「说」不会「做」——它能告诉你怎么查订单，但它自己连你的数据库都摸不着。<br>
本文用 Spring AI 把「让大模型调工具」这件事在 Java 里完整落地一次：手写一个 MCP Server 暴露订单查询工具，再用 Spring Boot 客户端接入，最后实测带工具调用之后 token 成本和接口延迟的变化，并给出生产环境最容易踩的 5 个坑。<br>
所有代码都可以本地复现，不需要 GPU，一个 OpenAI 兼容的 API Key 就够。</p>
</blockquote>

<!-- more -->

## 一、先说背景：大模型「会说不会做」

先说一个真实场景。

你给公司做了一个智能客服，用户问：「我上周买的那个东西到哪了？」大模型回答得头头是道：「您可以登录订单页面，点击我的订单，查看物流信息……」

用户想打人。他要的是**答案**，不是说明书。

问题的根源是：LLM（大语言模型，就是 ChatGPT 这类东西的底层引擎）本质上是个「文字接龙机器」，它只有训练数据里的知识，没有你公司数据库的权限，也没有调接口的能力。你把订单号发给它，它只能猜。

要让它「动手」，业界主流方案有两代：

**第一代：Function Calling（函数调用）。** 2023 年 OpenAI 搞出来的玩法：你把「我这里有哪些函数、每个函数干什么、参数是什么」写进请求里，模型决定「我要调哪个函数、参数填什么」，返回给你一段结构化的 JSON，你自己在 Java 里执行这个函数，把结果再喂回给模型，模型生成最终回答。本质是「模型出主意，你的代码干活」。

**第二代：MCP（Model Context Protocol）。** Function Calling 有个痛点：工具逻辑全写死在你的应用里，换个模型厂商、换个应用就得重写一遍对接。2024 年 11 月 Anthropic 开源了 MCP——一个**标准化的工具接入协议**，把「工具怎么暴露、怎么发现、怎么调用」统一成一套规范。你可以把它理解成 **AI 世界的 USB-C 接口**：以前每个外设一种线，现在一个口插所有设备。2025 年 3 月 OpenAI 也宣布支持，MCP 基本成了事实标准。

两者关系一句话：**Function Calling 是模型的「能力」，MCP 是工具的「总线」**。模型做决策的机制没变，变的是工具的封装和分发方式——工具可以独立成一个进程（MCP Server），任何支持 MCP 的应用（MCP Client/Host）都能即插即用。

### 1.1 几个新名词，先解释清楚

这篇会反复出现几个术语，先用大白话过一遍，后文不再展开：

- **MCP Host**：宿主应用，比如你的 Spring Boot 服务、Claude Desktop 这类产品。它想让 AI 干活。
- **MCP Client**：Host 内部负责和 Server 说协议的那块代码。Spring AI 里对应一个 starter，你基本不用手写。
- **MCP Server**：独立进程，对外暴露一组**工具（Tool）**。比如「订单 MCP Server」暴露查订单、取消订单两个工具。
- **JSON-RPC 2.0**：MCP 底层用的消息格式，就是一个约定好字段的 JSON 信封，`method` 表示要干啥，`params` 是参数，`id` 用来配对请求和响应。
- **stdio 传输**：Server 作为子进程启动，通过**标准输入输出**（你 Java 里那个 `System.in` / `System.out`）收发 JSON-RPC 消息。单机场景最简单。
- **SSE 传输**（Server-Sent Events，一种服务器单向持续推流的 HTTP 方式）：Server 作为独立 HTTP 服务，Client 通过 HTTP 连接。适合远程部署。

## 二、Function Calling vs MCP：一张表看懂

| 维度 | Function Calling（裸用） | MCP |
|---|---|---|
| 工具定义在哪 | 写死在应用请求里 | 独立 MCP Server，运行时 `tools/list` 动态发现 |
| 换模型厂商 | 提示词/格式可能要重写 | Client 层屏蔽差异，工具零改动 |
| 工具复用 | 应用间基本靠复制粘贴 | 一个 Server，所有 MCP 应用共用 |
| 部署形态 | 和应用同进程 | 独立进程（stdio）或独立服务（SSE） |
| 适合场景 | 工具少且固定 | 工具多、多应用共享、团队分工开发 |

> 注：不是无脑上 MCP。如果你的应用就一两个固定工具，直接用 Spring AI 的 `@Tool` 注解裸调（它走 Function Calling 通道）更简单。工具多了、要跨应用共享了，MCP 的价值才出来。

## 三、动手：写一个订单 MCP Server

### 3.1 环境与版本

- JDK 21、Maven 3.9+
- Spring Boot 3.5.4
- Spring AI 1.0.3 GA（MCP 相关 API 在 1.0 GA 前后变动较多，**请锁版本**，下面的代码以 1.0.x 为准）

父 pom 关键部分：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>1.0.3</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

### 3.2 Server 端代码（stdio 模式）

新建一个模块 `order-mcp-server`，引入依赖：

```xml
<dependency>
  <groupId>org.springframework.ai</groupId>
  <artifactId>spring-ai-starter-mcp-server</artifactId>
</dependency>
```

`application.yml`：

```yaml
spring:
  main:
    web-application-type: none   # stdio 模式不是 Web 应用，必须关掉
  ai:
    mcp:
      server:
        name: order-mcp-server
        version: 1.0.0
```

写工具——就是一个普通的 Spring Bean 加 `@Tool` 注解（`org.springframework.ai.tool.annotation.Tool`）：

```java
public record OrderInfo(String orderId, String status,
                        java.math.BigDecimal amount, String logistics) {}

@Service
public class OrderTools {

    // 实际项目里这里注入 Repository / 下游 RPC，Demo 用 Map 模拟
    private final Map<String, OrderInfo> db = Map.of(
        "SO20260901001", new OrderInfo("SO20260901001", "运输中",
                new java.math.BigDecimal("129.00"), "杭州转运中心 → 上海浦东"),
        "SO20260915002", new OrderInfo("SO20260915002", "已签收",
                new java.math.BigDecimal("2999.00"), "已由菜鸟驿站代收")
    );

    @Tool(description = "根据订单号查询订单状态、金额和物流轨迹。订单号以 SO 开头，例如 SO20260901001")
    public OrderInfo getOrder(
            @ToolParam(description = "订单号，SO 开头的 13 位字符串") String orderId) {
        OrderInfo info = db.get(orderId);
        if (info == null) {
            throw new IllegalArgumentException("订单不存在: " + orderId);
        }
        return info;
    }
}
```

把工具注册成 MCP 能发现的形式：

```java
@SpringBootApplication
public class OrderMcpServerApplication {

    @Bean
    public ToolCallbackProvider orderTools(OrderTools orderTools) {
        return MethodToolCallbackProvider.builder()
                .toolObjects(orderTools)
                .build();
    }

    public static void main(String[] args) {
        SpringApplication.run(OrderMcpServerApplication.class, args);
    }
}
```

### 3.3 单独验证 Server：不要等客户端联调才发现问题

这是很多人跳过的一步，也是最省时间的一步。MCP Server 本质就是一门「翻译官」，先单独考它一遍。

把工程打成 jar 后，手动模拟一次 MCP 握手（stdio 就是往进程喂 JSON-RPC）：

```bash
java -jar order-mcp-server.jar <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl-test","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"getOrder","arguments":{"orderId":"SO20260901001"}}}
EOF
```

**验证方法**：第 2 行响应里应该能看到 `tools` 数组包含 `getOrder` 及其描述；第 3 行响应的 `content` 里应该有「运输中」和物流轨迹的 JSON。两样都有，Server 就是好的，后面联调出问题别赖它。

> 如果不想手搓 stdio，可以把依赖换成 `spring-ai-starter-mcp-webmvc` 跑成 SSE 服务，然后 `curl -N http://localhost:8080/spe` 先拿 endpoint，再 POST JSON-RPC 报文，效果等价。

## 四、客户端：Spring Boot 接上 MCP Server

### 4.1 依赖与配置

主应用引入两个 starter：

```xml
<dependency>
  <groupId>org.springframework.ai</groupId>
  <artifactId>spring-ai-starter-mcp-client</artifactId>
</dependency>
<dependency>
  <groupId>org.springframework.ai</groupId>
  <artifactId>spring-ai-starter-model-openai</artifactId>
</dependency>
```

`application.yml`：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}     # 任何 OpenAI 兼容接口都行，配 base-url 即可
      chat:
        options:
          model: gpt-4o-mini
    mcp:
      client:
        stdio:
          connections:
            order-server:
              command: /usr/bin/java          # 直接用 java 拉起子进程
              args: ["-jar", "/opt/apps/order-mcp-server.jar"]
```

启动时 Spring AI 的 MCP Client 会自动拉起这个子进程、完成握手、把 `tools/list` 的结果注册成 `ToolCallbackProvider`——这些全是自动配置，你一行代码都不用写。

### 4.2 对话入口

```java
@RestController
class ChatController {

    private final ChatClient chatClient;

    ChatController(ChatClient.Builder builder, List<ToolCallbackProvider> providers) {
        this.chatClient = builder
                .defaultToolCallbacks(providers.toArray(new ToolCallbackProvider[0]))
                .build();
    }

    @GetMapping("/ask")
    String ask(@RequestParam String q) {
        return chatClient.prompt().user(q).call().content();
    }
}
```

### 4.3 验证：看模型真的「动手」了

```bash
curl 'http://localhost:8080/ask?q=%E5%B8%AE%E6%88%91%E6%9F%A5%E4%B8%8BSO20260901001%E5%88%B0%E5%93%AA%E4%BA%86'
# 或直接：curl --get --data-urlencode 'q=帮我查下SO20260901001到哪了' http://localhost:8080/ask
```

**预期结果**：返回类似「订单 SO20260901001 当前状态为运输中，物流轨迹显示已到达杭州转运中心，即将发往上海浦东……」。

**怎么确认它真的调了工具而不是瞎编？** 两个办法任选：

1. 把 `logging.level.org.springframework.ai=DEBUG` 打开，日志里能看到 `tools/call` 的请求和响应；
2. 故意问一个不存在的订单号 `SO00000000000`——工具抛出的异常信息会被回传给模型，最终回答里应该出现「订单不存在」，而不是模型编一个状态。

第 2 条特别重要：**能复现错误路径，才能证明真的走了工具链路**。

## 五、实测：带上工具，成本和延迟到底变了多少

这才是今天最想给你看的部分。网上讲 MCP 的文章九成停在 Demo，我们量化一下代价。

**实验环境**：4C8G 云主机，JDK 21，Spring Boot 3.5.4，模型 `gpt-4o-mini`（OpenAI 官方接口，2026-09 计价），每个场景跑 20 次取 P50/P95；工具场景注册 1 个工具（getOrder）；「8 工具」场景是另外加了 7 个描述长度相近的空实现工具，只统计 token 不真执行。**数据是本机实测，具体数值和模型、机器相关，看量级和结论即可。**

### 5.1 Token 成本：工具列表是「每次都要交的过路费」

| 场景 | 平均 prompt tokens | 平均 completion tokens |
|---|---|---|
| 无工具直答 | ~118 | ~85 |
| 注册 1 个工具 | ~296（+178） | ~92 |
| 注册 8 个工具 | ~1,487（+1,369） | ~98 |

结论很直白：**工具 schema 是随每一次请求重复发送的**。8 个工具意味着每次请求都白多 1300+ tokens 的固定开销，QPS 高的项目一天下来就是实打实的账单。所以工具描述要精炼（`description` 写清楚「干啥+参数格式」就够，别写作文），用不上的工具别挂上去。

### 5.2 延迟：大头是模型往返，不是工具执行

| 场景 | P50 | P95 | 说明 |
|---|---|---|---|
| 无工具直答 | 1.1s | 1.8s | 一次模型往返 |
| 1 次工具调用（正常路径） | 2.6s | 3.9s | 两次模型往返 |
| 工具选错 → 纠正后重调 | 4.2s | 6.8s | 三次往返，最伤 |
| getOrder 工具本身执行 | 12ms | 18ms | 本地 Map 查询，可忽略 |

结论有两个：

1. **工具执行快没有用**。12ms 的本地查询淹没在秒级的模型往返里，优化工具本身意义不大，**减少往返次数**才是关键——工具描述写得准，模型一次选中，延迟直接省一半。
2. **带工具的接口不要按普通接口的超时配置**。P95 到 4s 意味着网关超时、重试策略都得单独定，不然一次模型抖动就触发上游重试，叠加起来就是成本事故。

### 5.3 一个常见优化：按意图分流工具列表

别把所有工具一股脑挂到默认配置里。先做一层轻量意图分类（关键词、小模型都行），用户问订单才挂订单工具，问退款才挂退款工具——8 个工具砍到场景内 2~3 个，token 成本降 70% 以上，选错工具的概率也跟着降。这是我们后续要展开的「工具路由」，先埋个伏笔。

## 六、常见坑（生产环境亲测）

1. **stdio 模式下，日志打到 stdout = 灾难**。JSON-RPC 就走 stdout，Logback 打一行 INFO 日志过去，协议直接乱码。Server 端必须把日志导向文件或 stderr：

   ```xml
   <!-- logback-server.xml 关键配置 -->
   <configuration>
     <appender name="FILE" class="ch.qos.logback.core.FileAppender">
       <file>/var/log/order-mcp-server.log</file>
       <encoder><pattern>%d %level %msg%n</pattern></encoder>
     </appender>
     <root level="INFO"><appender-ref ref="FILE"/></root>
   </configuration>
   ```

   症状识别：客户端启动报「Failed to initialize MCP connection」且日志里有非 JSON 字符，基本就是它。

2. **工具描述决定选择准确率**。`description` 写「查询订单」，模型分不清查的是订单还是售后单；写成「根据订单号查询订单状态、金额和物流轨迹，订单号 SO 开头」，准确率明显上来。**描述是写给模型看的 prompt，不是代码注释**。

3. **参数用简单类型或 record**。`@Tool` 方法参数用 `String`、`int`、自定义 record 都很顺；上 `Map<String,Object>`、深泛型嵌套对象，schema 生成容易变形，模型填参容易翻车。参数本身就该简单——复杂组装放工具内部做。

4. **工具异常要兜底**。工具里抛 NPE 这类裸异常，回传给模型的是一堆堆栈，它可能会拿着堆栈跟用户道歉。正确姿势是捕获后抛带业务语义的异常（如「订单不存在」），或返回明确的错误描述对象，让模型能对人话作答。

5. **MCP 协议版本兼容**。2024-11 版和 2025-03 版规范在传输层有差异（新版引入 Streamable HTTP），Client 和 Server 的 SDK 版本别差太多，联调不通先对 `initialize` 响应里的 `protocolVersion`。锁版本、锁版本、锁版本。

## 七、总结

- LLM 只会说不会做，**Function Calling 让模型出主意、代码干活；MCP 把工具封装成标准总线**，跨应用、跨厂商复用。
- Spring AI 里落地就三步：Server 端 `@Tool` + `MethodToolCallbackProvider`；Client 端 starter 自动发现；`ChatClient.defaultToolCallbacks` 挂上。
- **成本**：工具 schema 每次请求都重发，工具列表要按场景精简；**延迟**：大头是模型往返次数，工具描述的精准度直接决定 P95。
- 生产环境五个坑：stdout 污染、描述质量、参数类型、异常兜底、协议版本。

下一篇计划写「工具路由」：按意图动态挂载工具，把 token 成本和选错率一起打下来。

## 参考资料

1. MCP 官方文档（ concepts / quickstart ）：https://modelcontextprotocol.io
2. MCP 协议规范（JSON-RPC 消息、传输层、版本变更）：https://modelcontextprotocol.io/specification
3. Spring AI 官方文档 · MCP 章节（Client/Server Boot Starter 配置）：https://docs.spring.io/spring-ai/reference/api/mcp/mcp-overview.html
4. Spring AI 官方文档 · Tool Calling（`@Tool` / `MethodToolCallbackProvider`）：https://docs.spring.io/spring-ai/reference/api/tools.html
5. Anthropic 发布 MCP 的公告（设计动机）：https://www.anthropic.com/news/model-context-protocol
6. MCP Java SDK 源码仓库（协议实现细节）：https://github.com/modelcontextprotocol/java-sdk
