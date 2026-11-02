---
title: 接口幂等性实战：Token、唯一索引、状态机，把重复扣款从 3 笔压到 0 笔（附压测数据与可复现实验）
date: 2026-11-02 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - 幂等性
  - Redis
  - 并发
  - 压测
  - Spring Boot
  - MySQL
---

<hr>
<blockquote>
<p>「用户手抖点了两次支付按钮」能造成几笔扣款？这篇在 Spring Boot + Redis + MySQL 的最小系统上实测：<strong>无防护时 200 并发真的会插出 3 笔订单</strong>。然后把三种方案——Token 原子消费、数据库唯一索引、状态机条件更新——逐一压给你看：订单数全部压回 1 笔，代价是 P50 多 1~4ms；最后给出一套「快车道拦截 + 慢车道兜底」的组合拳，和六个让幂等形同虚设的坑。</p>
</blockquote>

<!-- more -->

<h1 id="section-1">一、先复现一次事故：200 并发，扣款 3 次</h1>

<p>先讲场景。收银台页面，用户连点两次「确认支付」；或者更隐蔽一点：网关等响应超时了，主动替用户重发了一次请求。两种情况到了后端，都是<strong>同一个订单号发来多个支付请求</strong>。要是后端「先查一下有没有这单，没有就插单扣款」，故事就开始了——这套写法在单发请求时岁月静好，一上并发就出事。</p>

<p>空口无凭，先把这个事故压出来。技术栈：Spring Boot 3.2 + JDK 21 + MySQL 8.0 + Redis 7.2，全部跑在这台 4 核 8G 的普通云主机上（本专栏的老伙计）。中间件用 Docker 一键起：</p>

<pre><code>docker run -d --name redis-idem -p 127.0.0.1:6379:6379 redis:7.2
docker run -d --name mysql-idem \
  -e MYSQL_ROOT_PASSWORD=root123 -e MYSQL_DATABASE=shop \
  -p 127.0.0.1:3306:3306 mysql:8.0.36</code></pre>

<p>订单表（金额用「分」存 long，顺便躲开浮点数的另一类事故）：</p>

<pre><code>CREATE TABLE orders (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  out_trade_no VARCHAR(64) NOT NULL,        -- 业务订单号：幂等的关键角色
  user_id      BIGINT      NOT NULL,
  amount_cents BIGINT      NOT NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'INIT',
  paid_at      DATETIME    NULL,
  created_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;</code></pre>

<p>反面教材版本 0，注意「先查后插」这个经典写法：</p>

<pre><code>// 版本 0：无任何防护（反面教材）
@PostMapping("/naive")
public String payNaive(@RequestBody PayReq req) throws Exception {
    Integer cnt = jdbc.queryForObject(
        "SELECT COUNT(*) FROM orders WHERE out_trade_no = ?",
        Integer.class, req.outTradeNo());
    if (cnt != null &amp;&amp; cnt &gt; 0) {     // 先查……
        return "duplicate";
    }
    Thread.sleep(5);                  // 模拟调用支付渠道的耗时，竞态窗口就是这 5ms
    jdbc.update(
        "INSERT INTO orders(out_trade_no, user_id, amount_cents) VALUES (?,?,?)",
        req.outTradeNo(), req.userId(), req.amountCents());   // ……后插
    return "ok";
}

public record PayReq(String outTradeNo, long userId, long amountCents) {}</code></pre>

<p>压测用 <strong>ab（ApacheBench）</strong>——Apache 自带的 HTTP 压测小钢炮，一条命令的事（<code>yum install -y httpd-tools</code> 或 <code>apt install -y apache2-utils</code>）。2000 个请求、200 并发，全部用同一个订单号，模拟「手抖 + 重试」：</p>

<pre><code>cat &gt; pay.json &lt;&lt;'EOF'
{"outTradeNo":"ORDER-1001","userId":9527,"amountCents":9900}
EOF

ab -n 2000 -c 200 -p pay.json -T application/json \
   http://127.0.0.1:8080/pay/naive

# 验证：这笔订单到底建了几条？
docker exec mysql-idem mysql -uroot -proot123 shop \
  -e "SELECT COUNT(*) AS cnt FROM orders WHERE out_trade_no='ORDER-1001';"</code></pre>

<p>结果：</p>

<pre><code>+-----+
| cnt |
+-----+
|   3 |     2000 个请求，同一个订单号，插了 3 条
+-----+</code></pre>

<p><strong>3 笔订单 = 扣款 3 次</strong>，用户血亏 198 元。为什么会这样？这叫 <strong>check-then-act 竞态</strong>：「检查」和「动作」是两步，中间隔着的那个空档就是 <strong>竞态窗口（race window）</strong>——两个请求同时通过了「没这单」的检查，然后挨个去插，每个都成功。版本 0 里我故意放的 <code>Thread.sleep(5)</code> 就是把这个窗口放大到肉眼可见；真实系统里窗口可能只有零点几毫秒，但 2000 个请求总能钻进去几个。多压几轮你会发现重复笔数在 2~5 笔之间波动——<strong>它不是必现 bug，是概率事故</strong>，这比必现可怕得多：测试环境没压出来，上线三个月后炸一次。</p>

<h1 id="section-2">二、幂等性到底是个啥：一个数学梗和三个词的分家</h1>

<p><strong>幂等（Idempotent）</strong>——从数学里借来的词，<code>f(f(x)) = f(x)</code>，函数套自己一遍结果不变。翻译成工程话：<strong>同一个操作执行一次和执行 N 次，对系统状态的影响完全一样</strong>。支付接口幂等 = 同一笔钱的支付请求来 1 次还是来 200 次，只扣 1 次款、只建 1 张单。</p>

<p>三个容易搅在一起的词，先分家：</p>

<ul>
<li><strong>防重</strong>：想办法不让重复请求进来（按钮置灰、防抖）。属于前端体验层，<strong>防不住</strong>网关重试、MQ 重投这种「不是人点的」重复；</li>
<li><strong>幂等</strong>：重复请求进来了，后端保证只生效一次。这是后端必须自己兜住的责任；</li>
<li><strong>事务</strong>：一次操作内部的多步写要么全成要么全不成。它管「内部一致」，<strong>不管</strong>「同一操作来两遍」。</li>
</ul>

<p>顺便补一个 HTTP 语义的冷知识：RFC 9110 把 GET、PUT、DELETE 定义为<strong>天然幂等方法</strong>（执行多次结果一样），而 <strong>POST 不幂等</strong>——「创建订单」连发两次就是两张单。所以幂等的主战场天然就是 POST 接口。</p>

<p>那重复请求到底从哪来？把来源列全，才知道对手有多广：</p>

<table>
<thead>
<tr><th>重复来源</th><th>典型场景</th><th>能在源头消灭吗</th></tr>
</thead>
<tbody>
<tr><td>用户连点/双击</td><td>按钮没置灰、页面卡住狂点</td><td>能（前端防抖），但不可靠</td></tr>
<tr><td>浏览器/HTTP 客户端重试</td><td>连接重置后自动重发</td><td>不能，客户端行为不可控</td></tr>
<tr><td>网关/负载均衡重试</td><td>Nginx <code>proxy_next_upstream</code> 转发给下一台</td><td>不能，重试是它的高可用手段</td></tr>
<tr><td>RPC 框架重试</td><td>Feign/Dubbo 超时重发</td><td>不能，重试策略常是默认开的</td></tr>
<tr><td>消息队列重投</td><td><strong>at-least-once</strong>（消息队列的投递语义：保证不丢，但可能重复）投递下消费端必然见到重复</td><td>不能，这正是 at-least-once 的定义</td></tr>
<tr><td>定时任务重叠</td><td>上一轮没跑完，下一轮又启动</td><td>能（分布式锁），但常被漏配</td></tr>
</tbody>
</table>

<p>结论一句话：<strong>重试是分布式系统的常态，不是异常。源头堵不干净，只能在接收端做幂等兜底。</strong>这也是为什么「幂等」和限流、熔断并列为流量治理三件套——上一篇限流管「来的太多」，这篇管「同一笔来太多」。</p>

<h1 id="section-3">三、三种方案一张表：拦截时机与代价</h1>

<p>对付重复请求，业界常用三条路，按拦截时机从早到晚排：</p>

<ol>
<li><strong>方案 A：Token 机制（应用层前置拦截）</strong>——进收银台先领一张一次性令牌，提交支付时把令牌带上，服务端用 Redis 的原子命令「核销」令牌：核销到的才有执行权，核销不到的一律当重复请求打回；</li>
<li><strong>方案 B：数据库唯一索引（存储层兜底）</strong>——给 <code>out_trade_no</code> 加唯一索引，重复插入直接被 MySQL 拒绝，代码里接住冲突即可。这是最后一道闸，<strong>错了也错不了账</strong>；</li>
<li><strong>方案 C：状态机（业务流转型幂等）</strong>——订单状态只能沿合法路径迁移（INIT → PAID → DELIVERED），推进时用条件更新 <code>UPDATE ... WHERE status='INIT'</code>，<strong>改到行 = 抢到执行权</strong>。美团技术团队那篇《消息队列设计精要》把它和版本号并列为幂等处理的通用两把刷子。</li>
</ol>

<p>三家的定位完全不同，先给一张总览表（具体压测数据在第五节）：</p>

<table>
<thead>
<tr><th>方案</th><th>拦截时机</th><th>实现成本</th><th>单次开销</th><th>能挡住什么</th><th>典型坑</th></tr>
</thead>
<tbody>
<tr><td>A Token</td><td>进业务逻辑前</td><td>中（要发令牌、传令牌）</td><td>1 次 Redis 往返（~1ms）</td><td>一切重复请求，业务零损耗</td><td>令牌消费后业务失败，重试被误杀</td></tr>
<tr><td>B 唯一索引</td><td>写库瞬间</td><td>低（一条 DDL）</td><td>冲突路径：异常 + 回滚（贵）</td><td>一切重复写入，<strong>数学上兜死</strong></td><td>吞掉异常返回「成功」</td></tr>
<tr><td>C 状态机</td><td>状态迁移时</td><td>低（改写 UPDATE）</td><td>条件 UPDATE（便宜）</td><td>重复推进 + 非法状态迁移</td><td>影响行数为 0 被当成功</td></tr>
</tbody>
</table>

<p>注意：<strong>A 是快车道，B 是保险丝，C 是业务流程自带的护栏</strong>，三者不是三选一，是搭档关系——第五节会给出 A+B 组合的实测数据。</p>

<h1 id="section-4">四、动手：三版代码 + 压测命令 + 验证方法</h1>

<p>工程上直接用 <a href="https://start.spring.io">start.spring.io</a> 勾三个 starter 就够：<code>web</code>、<code>data-redis</code>、<code>jdbc</code>（本篇用 <code>JdbcTemplate</code> 保持透明，MyBatis/JPA 同理）。配置文件：</p>

<pre><code>spring:
  data:
    redis:
      host: 127.0.0.1
      port: 6379
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/shop
    username: root
    password: root123</code></pre>

<h2>版本 1：Token 机制——Redis 的原子命令就是裁判</h2>

<p>先申请令牌（进入收银台时调用），令牌对应的 value 里存上订单号，把令牌和业务绑死：</p>

<pre><code>@PostMapping("/token")
public String newToken(@RequestBody PayReq req) {
    String token = UUID.randomUUID().toString();
    // SET key value EX 300：一条命令完成写入 + 5 分钟过期
    redis.opsForValue().set("pay:token:" + token, req.outTradeNo(),
                            Duration.ofMinutes(5));
    return token;   // 前端把令牌放进表单隐藏域，提交时一起带上
}</code></pre>

<p>提交支付时核销令牌。关键在 <code>DEL</code>：<strong>DEL 本身就是「检查 + 删除」合一的原子操作</strong>，删到（返回 true）= 全世界只有你抢到了执行权；删不到 = 令牌不存在，重复请求或已过期，直接打回：</p>

<pre><code>@PostMapping("/tokened")
public String payTokened(@RequestBody PayReq req,
        @RequestHeader("X-Idempotency-Token") String token) throws Exception {
    Boolean won = redis.delete("pay:token:" + token);   // 原子核销
    if (Boolean.FALSE.equals(won)) {
        return "duplicate";    // 令牌不存在：重复提交 / 已过期
    }
    try {
        Thread.sleep(5);
        jdbc.update("INSERT INTO orders(out_trade_no, user_id, amount_cents) VALUES (?,?,?)",
            req.outTradeNo(), req.userId(), req.amountCents());
        return "ok";
    } catch (RuntimeException e) {
        // 坑点预告：令牌已核销、业务却失败——正常重试会被误杀，见第六节坑 1
        throw e;
    }
}</code></pre>

<p>一个更省事的变体：不申请随机令牌，直接拿业务订单号当 key 用 <strong>SETNX</strong>（<code>SET key value NX EX 300</code>——「不存在才写入」的原子命令，一条命令完成检查 + 占位）做请求级互斥。写法更短，适合不想动前端协议的内部接口；对外部开放 API，Stripe 那套 <code>Idempotency-Key</code> 请求头方案（本质就是本文的令牌）是事实标准。</p>

<h2>版本 2：唯一索引——最后一道闸</h2>

<p>一条 DDL 完成布防：</p>

<pre><code>ALTER TABLE orders ADD UNIQUE KEY uk_out_trade_no (out_trade_no);</code></pre>

<p>代码里只剩一件事：<strong>接住冲突，回放真实状态</strong>。<strong>DuplicateKeyException</strong>（Spring 把数据库唯一键冲突翻译成的异常）被抛出时，说明单已经建好了，此时正确姿势是查单把现状返回给用户，而不是报错：</p>

<pre><code>import org.springframework.dao.DuplicateKeyException;   // 唯一键冲突的"翻译官"

@PostMapping("/unique")
public String payUnique(@RequestBody PayReq req) throws Exception {
    Thread.sleep(5);
    try {
        jdbc.update("INSERT INTO orders(out_trade_no, user_id, amount_cents) VALUES (?,?,?)",
            req.outTradeNo(), req.userId(), req.amountCents());
        return "ok";
    } catch (DuplicateKeyException e) {
        // 正确姿势：查出真实状态回放给用户，别一律抛"系统异常"
        String status = jdbc.queryForObject(
            "SELECT status FROM orders WHERE out_trade_no = ?",
            String.class, req.outTradeNo());
        return "exists:" + status;
    }
}</code></pre>

<h2>版本 3：状态机——把执行权写进 SQL</h2>

<p>先落一条 INIT 状态的订单（<code>INSERT IGNORE</code> 是 MySQL 方言：冲突时静默放弃插入），再用<strong>条件更新</strong>推进状态。并发提交时，<code>WHERE status = 'INIT'</code> 保证只有一条 UPDATE 能改到行：</p>

<pre><code>@PostMapping("/stateful")
public String payStateful(@RequestBody PayReq req) throws Exception {
    jdbc.update(
        "INSERT IGNORE INTO orders(out_trade_no, user_id, amount_cents, status) VALUES (?,?,?,'INIT')",
        req.outTradeNo(), req.userId(), req.amountCents());
    Thread.sleep(5);
    int rows = jdbc.update(
        "UPDATE orders SET status = 'PAID', paid_at = NOW() " +
        "WHERE out_trade_no = ? AND status = 'INIT'",
        req.outTradeNo());
    return rows == 1 ? "ok" : "duplicate-or-invalid-state";   // 影响行数 = 裁决书
}</code></pre>

<p>压测命令和第一节完全一致（换 URL、清场重压）：</p>

<pre><code># 每轮压测前清场
docker exec mysql-idem mysql -uroot -proot123 shop -e "TRUNCATE TABLE orders;"

TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"outTradeNo":"ORDER-1002","userId":9527,"amountCents":9900}' \
  http://127.0.0.1:8080/pay/token)

ab -n 2000 -c 200 -p pay.json -T application/json \
   -H "X-Idempotency-Token: $TOKEN" \
   http://127.0.0.1:8080/pay/tokened    # 版本 2/3 换成 /pay/unique、/pay/stateful</code></pre>

<p><strong>如何验证结论？三条证据链</strong>，比只看返回值靠谱：</p>

<pre><code># 证据 1：订单数必须 = 1（每个方案压完都查）
docker exec mysql-idem mysql -uroot -proot123 shop \
  -e "SELECT COUNT(*) FROM orders WHERE out_trade_no='ORDER-1002';"

# 证据 2：Redis 侧观察 DEL 到底核销成功几次（应只成功 1 次）
docker exec redis-idem redis-cli MONITOR | grep -i 'DEL pay:token'

# 证据 3：唯一索引版统计冲突被兜住的次数（应用日志里应约 1999 次）
grep -c DuplicateKeyException app.log</code></pre>

<h1 id="section-5">五、压测结果：3 笔压回 1 笔，代价是多少毫秒</h1>

<p>统一条件：2000 请求 / 200 并发 / 同一订单号，每轮 <code>TRUNCATE</code> 清场，每组方案连压 3 轮取中位数。绝对值依机器而异，<strong>相对关系是稳定的</strong>：</p>

<table>
<thead>
<tr><th>方案</th><th>订单数（应为 1）</th><th>P50</th><th>P95</th><th>P99</th><th>备注</th></tr>
</thead>
<tbody>
<tr><td>无防护（版本 0）</td><td><strong>3</strong></td><td>8ms</td><td>23ms</td><td>41ms</td><td>重复扣款事故本体</td></tr>
<tr><td>Token（DEL 原子核销）</td><td>1</td><td>9ms</td><td>26ms</td><td>47ms</td><td>每请求多 1 次 Redis 往返</td></tr>
<tr><td>唯一索引兜底</td><td>1</td><td>12ms</td><td>38ms</td><td>72ms</td><td>1999 个请求走异常路径</td></tr>
<tr><td>状态机条件更新</td><td>1</td><td>11ms</td><td>34ms</td><td>61ms</td><td>重复请求走 0 行分支</td></tr>
<tr><td>Token + 唯一索引（推荐）</td><td>1</td><td>9ms</td><td>27ms</td><td>48ms</td><td>快车道拦截 + 慢车道兜底</td></tr>
</tbody>
</table>

<p>三个值得咀嚼的观察：</p>

<ul>
<li><strong>Token 是性价比之王。</strong>P50 只比无防护多 1ms——一次内网 Redis 往返的钱，就把「概率事故」变成「数学上不可能」。代价前置且恒定，不随重复量上涨；</li>
<li><strong>唯一索引单打独斗时，长尾最难看。</strong>2000 个重复请求里 1999 个撞异常，Java 异常构造（填栈）+ 事务回滚都是真金白银的 CPU，P99 被顶到 72ms。它天生该当兜底，不该当主力；</li>
<li><strong>组合拳几乎白嫖。</strong>Token 在前面把 1999 个重复请求拦在 Redis 层，唯一索引全程只兜真冲突（正常业务里接近 0 次），P95/P99 基本回到 Token 单打的水平。这就是「快车道 + 保险丝」的搭法。</li>
</ul>

<p>顺带把「验证」闭环：把压测并发从 200 提到 500 再压无防护版本，重复笔数会涨到 5 笔上下——重复量和竞态窗口被踩中的概率成正比，<strong>流量越大，幂等越不是可选项</strong>。</p>

<h1 id="section-6">六、常见坑：六个让幂等形同虚设的写法</h1>

<ol>
<li><strong>令牌核销与业务执行不是原子的。</strong><code>DEL</code> 成功后业务挂了（支付渠道超时、机器重启），令牌已烧掉，用户 legitimate 重试却被 <code>duplicate</code> 误杀。对策：业务失败时把令牌 key 改写成「失败结果」而非删除；重试进来时先查这个 key——有值就回放上次的处理结果。Stripe 的做法更进一步：把第一次请求的响应体缓存下来，同 key 重试直接原样回放；</li>
<li><strong>先 GET 再 DEL，等于又写了一个 check-then-act。</strong>两步之间令牌可能被别的请求核销。要么用原子 <code>DEL</code>/<code>GETDEL</code>（Redis 6.2+ 的「取值顺便删除」），要么当需要「校验 value 匹配才删」时上 <strong>Lua 脚本</strong>（Redis 服务端执行的脚本，把多条命令打包成一个原子操作执行）；</li>
<li><strong>唯一索引兜底后吞异常返回「ok」。</strong>代码没炸、用户看到成功，但这一单根本不是这次请求建的，后续状态推进全乱。也别一律抛「系统异常」吓用户——查单回放真实状态才是正解；</li>
<li><strong>状态机 UPDATE 影响行数为 0 却继续走成功分支。</strong><code>jdbc.update()</code> 的返回值被无视，是状态机方案翻车的第一名。0 行 = 重复请求或非法状态迁移，必须走拒绝分支；</li>
<li><strong>多实例部署还用本地内存防重。</strong>用一个 <code>ConcurrentHashMap</code> 存已处理请求，网关轮询把重复请求打到另一台实例，防重直接穿帮。防重状态必须放集中式存储（Redis/DB）。再想一层：Redis 挂了怎么办？<strong>fail-open</strong>（放行，靠唯一索引兜底）还是 <strong>fail-close</strong>（直接拒服务）？有数据库唯一索引垫底时，fail-open 是合理默认——保险丝在，快车道堵一下没关系；</li>
<li><strong>幂等键选错，防了个寂寞。</strong>前端每次刷新重新生成的 UUID、每次都变的时间戳，拿来当幂等键等于没防。幂等键要么服务端签发（令牌），要么来自稳定业务号（订单号）。Stripe 的建议是客户端生成 UUID v4 且足够随机，同时<strong>别拿邮箱、手机号这类敏感信息当幂等键</strong>。另外留意 TTL：用户填十分钟表单回来令牌过期，照样被误杀——TTL 要盖过最长填写时间。</li>
</ol>

<p>再补一条 MQ 场景的专属坑：消费端幂等别只写在 Redis 里，<strong>建一张幂等表</strong>（消息唯一键 + 唯一索引），和业务写库放进<strong>同一个本地事务</strong>——消息处理和「已消费」记录同生共死，重启、重复投递都冲不垮。</p>

<h1 id="section-7">七、落地建议：组合拳怎么打</h1>

<ul>
<li><strong>接入层：</strong>前端按钮防抖 + loading 罩。体验层手段，能挡 90% 的手抖，但<strong>不算幂等</strong>，别指望它；</li>
<li><strong>快车道：</strong>应用层 Token / <code>Idempotency-Key</code>（Redis 原子核销），把重复请求拦在业务逻辑之前，这是日常流量的主力；</li>
<li><strong>保险丝：</strong>数据库唯一索引压在写入层，代码唯一要做的分支是「接住冲突、回放状态」。它平时沉默，出事时兜底，<strong>永远不要省</strong>；</li>
<li><strong>流程型业务：</strong>订单、审批这类有状态流转的，用状态机条件更新管迁移，幂等和业务规则（「已发货的不能退款」）一份 SQL 同时管住；</li>
<li><strong>MQ 消费：</strong>幂等表 + 本地事务，别只依赖 Redis。</li>
</ul>

<h1 id="section-8">八、总结</h1>

<ul>
<li><strong>重复请求是常态不是异常：</strong>重试是分布式系统的自带行为，接收端幂等是必答题；</li>
<li><strong>事故根源是 check-then-act 竞态：</strong>200 并发实测插出 3 笔订单，且重复笔数随流量波动——概率事故比必现 bug 更危险；</li>
<li><strong>三种方案三种定位：</strong>Token 是快车道（P50 +1ms 拦截一切）、唯一索引是保险丝（数学上兜死）、状态机是业务护栏（幂等与流程规则合一）；</li>
<li><strong>落地打组合拳：</strong>Token + 唯一索引实测 P99 48ms，与单用 Token 基本持平，但多一层「错了也错不了账」的保底；</li>
<li><strong>六个高频坑按住不表不行：</strong>核销与业务不原子、GET+DEL 伪原子、吞冲突报成功、无视影响行数、本地内存防重、幂等键选错——每一个都能让上面的功夫全部白费；</li>
<li>方法论沉淀：<strong>结论要用证据链说话</strong>——订单数 COUNT、Redis MONITOR、异常计数三条证据凑齐，才算验证过。</li>
</ul>

<p>下一篇预告（已在路上）：既然扣款要「只生效一次」，那就绕不开一个更根本的问题——同一行数据被两个事务同时改，MySQL 到底怎么裁决。下次把 InnoDB 的锁与 MVCC 的协作过程拆开看。</p>

<h2>参考资料</h2>

<ol>
<li>美团技术团队，《消息队列设计精要》—— 幂等处理消息的通用两把刷子（版本号、状态机）与可靠投递设计：<a href="https://tech.meituan.com/2016/07/01/mq-design.html">https://tech.meituan.com/2016/07/01/mq-design.html</a></li>
<li>阿里巴巴《Java 开发手册》（黄山版），p3c 开源仓库 —— 并发处理与幂等相关规约：<a href="https://github.com/alibaba/p3c">https://github.com/alibaba/p3c</a></li>
<li>Stripe Blog, <em>Designing robust and predictable APIs with idempotency</em> —— <code>Idempotency-Key</code> 方案的事实标准与结果回放设计：<a href="https://stripe.com/blog/idempotency">https://stripe.com/blog/idempotency</a></li>
<li>RFC 9110 (HTTP Semantics) — Idempotent Methods —— GET/PUT/DELETE 幂等、POST 不幂等的权威定义：<a href="https://httpwg.org/specs/rfc9110.html#idempotent.methods">https://httpwg.org/specs/rfc9110.html#idempotent.methods</a></li>
<li>Redis 官方文档 — SET / GETDEL 命令（NX、EX 选项与原子性语义）：<a href="https://redis.io/docs/latest/commands/set/">https://redis.io/docs/latest/commands/set/</a></li>
<li>MySQL 8.0 Reference Manual — PRIMARY KEY and UNIQUE Index Constraints —— 唯一约束的冲突处理语义：<a href="https://dev.mysql.com/doc/refman/8.0/en/constraint-primary-key.html">https://dev.mysql.com/doc/refman/8.0/en/constraint-primary-key.html</a></li>
</ol>
