---
title: HTTP Keep-Alive 到底值不值得开？用 Node.js 小实验看懂连接复用、延迟和 TIME_WAIT
date: 2026-04-02 10:00:00
categories:
  - 计算机网络
  - HTTP/HTTPS
tags:
  - HTTP
  - Keep-Alive
  - Node.js
  - TIME_WAIT
  - 性能优化
---
<hr>
<blockquote>
<p><strong>HTTP Keep-Alive</strong> 说白了就是“别每次请求都重新打电话，能接着聊就接着聊”。它解决的是频繁建连带来的额外开销，尤其在服务间调用、网关转发、爬虫、批量请求这些场景里，差距往往不是一点点。</p>
<p>这篇文章不空谈概念，直接用一个 Node.js 小实验把问题跑明白：不开连接复用和开启 Keep-Alive，吞吐、延迟、TIME_WAIT 数量，到底差多少；以及它什么时候真有收益，什么时候反而会埋坑。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这事值得单独讲"><a href="#为什么这事值得单独讲" class="headerlink" title="为什么这事值得单独讲"></a>为什么这事值得单独讲</h1>
<p>很多同学第一次接触 <strong>HTTP Keep-Alive</strong>，脑子里的印象大概只有一句话：<strong>它能复用 TCP 连接，性能更好</strong>。这句话当然没错，但问题也在这里——太对了，导致没有信息量。</p>
<p>真正到了工程现场，你会遇到的是这些更具体的问题：</p>
<ul>
<li>为什么同样的接口，本地压测还行，一上并发 P95 就抖？</li>
<li>为什么服务明明 QPS 不高，机器上却一堆 <code>TIME_WAIT</code>？</li>
<li>为什么把连接池参数调大以后，性能没提升，反而偶尔报 <code>ECONNRESET</code>？</li>
<li>为什么有些 SDK 默认开 Keep-Alive，有些却很保守？</li>
</ul>
<p>说到底，Keep-Alive 不是一个“开或不开”的八股参数，它背后连着 <strong>TCP 建连成本</strong>、<strong>连接池复用</strong>、<strong>服务端空闲超时</strong>、<strong>负载均衡行为</strong>，以及你最终能看到的 <strong>吞吐、延迟、端口消耗</strong>。</p>
<p>所以这篇文章我想做两件事：</p>
<blockquote>
<p>1、先把 Keep-Alive 讲清楚；<br>2、再用一个你自己也能跑起来的小实验，把“值不值得开”这件事落到数据上。</p>
</blockquote>

<h1 id="先把几个容易混的概念掰开"><a href="#先把几个容易混的概念掰开" class="headerlink" title="先把几个容易混的概念掰开"></a>先把几个容易混的概念掰开</h1>
<p>先说一句很重要的：<strong>HTTP Keep-Alive</strong> 在日常讨论里，通常指的是 <strong>HTTP/1.1 下的持久连接</strong>，也就是一个 TCP 连接上连续跑多个 HTTP 请求，而不是请求一次就关连接。</p>
<p>这里有 3 个特别容易混在一起的概念：</p>
<table>
<thead>
<tr>
<th style="text-align:center">概念</th>
<th style="text-align:center">它是啥</th>
<th style="text-align:center">主要解决什么问题</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">TCP 三次握手</td>
<td style="text-align:center">客户端和服务端建立连接前要走的握手流程</td>
<td style="text-align:center">确认双方可收发、同步初始序号</td>
</tr>
<tr>
<td style="text-align:center">HTTP Keep-Alive</td>
<td style="text-align:center">一次建好的 TCP 连接别立刻关，后面的请求继续复用</td>
<td style="text-align:center">减少反复建连/关连的成本</td>
</tr>
<tr>
<td style="text-align:center">连接池</td>
<td style="text-align:center">客户端把连接缓存起来统一复用和管理</td>
<td style="text-align:center">控制复用效率、并发数和空闲连接数</td>
</tr>
</tbody>
</table>
<p><strong>TIME_WAIT</strong> 也顺手解释一下。它是 TCP 主动关闭连接的一方，在连接关闭后要保留一小段时间的状态。你可以把它理解成“电话刚挂断，但系统还要保留一下通话记录，防止旧包串进来”。如果你每个请求都新建连接再关闭，那 <code>TIME_WAIT</code> 往往就会涨得很快。</p>
<p>再补一个常见误区：<strong>HTTP/1.1 默认就是持久连接倾向</strong>，但“协议层默认倾向持久”不等于“你的客户端库就一定帮你把连接复用好了”。很多性能问题，最后卡的不是协议，而是客户端没有正确配置 agent / 连接池。</p>

<h1 id="Keep-Alive-到底省了什么"><a href="#Keep-Alive-到底省了什么" class="headerlink" title="Keep-Alive 到底省了什么"></a>Keep-Alive 到底省了什么</h1>
<p>如果每次请求都重新建连，额外成本通常有这几块：</p>
<ul>
<li><strong>握手成本</strong>：TCP 三次握手不是白送的，跨机房、跨地域时 RTT 一上来，这部分更明显。</li>
<li><strong>内核资源开销</strong>：创建 socket、分配端口、维护状态，都要消耗系统资源。</li>
<li><strong>连接关闭成本</strong>：连接关闭后还会留下 <code>TIME_WAIT</code>，请求多了端口和状态表压力就上来了。</li>
<li><strong>TLS 成本</strong>：如果是 HTTPS，还可能叠加 TLS 握手。TLS 是传输层安全协议，解决的是链路加密和身份校验问题；它通常比纯 HTTP 建连更贵。</li>
</ul>
<p>所以 Keep-Alive 的收益，核心不是“省了一个参数”，而是：</p>
<blockquote>
<p><strong>用更少的连接建立与销毁，换来更低的平均延迟、更高的吞吐和更低的系统抖动。</strong></p>
</blockquote>
<p>这也是为什么网关、RPC 调用、数据库代理、对象存储 SDK 这些组件，通常都会非常重视连接复用。</p>

<h1 id="一个可复现的小实验"><a href="#一个可复现的小实验" class="headerlink" title="一个可复现的小实验"></a>一个可复现的小实验</h1>
<p>光讲原理不够，我们直接跑实验。实验目标很简单：同一个本地 HTTP 服务，分别用 <strong>不开 Keep-Alive</strong> 和 <strong>开启 Keep-Alive</strong> 两种方式发起 2000 个请求，对比吞吐和延迟。</p>
<p>实验环境：</p>
<ul>
<li>Node.js 24</li>
<li>本地回环地址 <code>127.0.0.1</code></li>
<li>请求总数：2000</li>
<li>并发度：50</li>
</ul>
<p>先启动一个最简单的 HTTP 服务：</p>
<figure class="highlight javascript"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">const</span> http = <span class="built_in">require</span>(<span class="string">'http'</span>);</span><br><span class="line"><span class="keyword">const</span> server = http.createServer((req, res) =&gt; &#123;</span><br><span class="line">  res.writeHead(<span class="number">200</span>, &#123; <span class="string">'Content-Type'</span>: <span class="string">'application/json'</span> &#125;);</span><br><span class="line">  res.end(JSON.stringify(&#123; ok: <span class="literal">true</span>, ts: Date.now() &#125;));</span><br><span class="line">&#125;);</span><br><span class="line">server.keepAliveTimeout = <span class="number">5000</span>;</span><br><span class="line">server.listen(<span class="number">3100</span>, <span class="string">'127.0.0.1'</span>);</span><br></pre></td></tr></table></figure>
<p>然后准备一个压测脚本，唯一的变量就是客户端 <code>http.Agent</code> 的 <code>keepAlive</code> 开关：</p>
<figure class="highlight javascript"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br></pre></td><td class="code"><pre><span class="line"><span class="keyword">const</span> agent1 = <span class="keyword">new</span> http.Agent(&#123; keepAlive: <span class="literal">false</span>, maxSockets: <span class="number">50</span> &#125;);</span><br><span class="line"><span class="keyword">const</span> agent2 = <span class="keyword">new</span> http.Agent(&#123;</span><br><span class="line">  keepAlive: <span class="literal">true</span>,</span><br><span class="line">  maxSockets: <span class="number">50</span>,</span><br><span class="line">  maxFreeSockets: <span class="number">10</span>,</span><br><span class="line">  timeout: <span class="number">60000</span>,</span><br><span class="line">  keepAliveMsecs: <span class="number">1000</span></span><br><span class="line">&#125;);</span><br><span class="line"><span class="comment">// 其他逻辑保持一致，只比较是否复用连接</span></span><br><span class="line"></span><br></pre></td></tr></table></figure>
<p>这几个参数第一次见的话，我用人话解释一下：</p>
<ul>
<li><code>maxSockets</code>：同一个目标地址最多允许多少个并发连接；太小会排队，太大可能把下游打抖。</li>
<li><code>maxFreeSockets</code>：空闲连接最多留多少条；你可以把它理解成“别把所有打过的电话都一直挂在线上”。</li>
<li><code>keepAliveMsecs</code>：空闲连接多久尝试保持活性；不同客户端实现里细节会略有差异，但核心都是“连接不要太快被丢”。</li>
</ul>

<h1 id="实验结果"><a href="#实验结果" class="headerlink" title="实验结果"></a>实验结果</h1>
<p>下面是我在当前环境里直接跑出来的数据：</p>
<table>
<thead>
<tr>
<th style="text-align:center">模式</th>
<th style="text-align:center">总请求</th>
<th style="text-align:center">并发</th>
<th style="text-align:center">吞吐（req/s）</th>
<th style="text-align:center">P50 延迟</th>
<th style="text-align:center">P95 延迟</th>
<th style="text-align:center">P99 延迟</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">no-keepalive</td>
<td style="text-align:center">2000</td>
<td style="text-align:center">50</td>
<td style="text-align:center">6709.53</td>
<td style="text-align:center">5.27 ms</td>
<td style="text-align:center">19.84 ms</td>
<td style="text-align:center">38.87 ms</td>
</tr>
<tr>
<td style="text-align:center">keepalive</td>
<td style="text-align:center">2000</td>
<td style="text-align:center">50</td>
<td style="text-align:center">9990.71</td>
<td style="text-align:center">4.24 ms</td>
<td style="text-align:center">8.90 ms</td>
<td style="text-align:center">12.85 ms</td>
</tr>
</tbody>
</table>
<p>结论很直接：</p>
<blockquote>
<p>在这个小实验里，开启 Keep-Alive 后，吞吐提升了大约 <strong>48.9%</strong>，P95 延迟从 <strong>19.84 ms</strong> 降到 <strong>8.90 ms</strong>，P99 延迟从 <strong>38.87 ms</strong> 降到 <strong>12.85 ms</strong>。</p>
</blockquote>
<p>这还是在 <strong>本地回环</strong> 的情况下，也就是网络 RTT 已经非常小了。如果是跨容器网络、跨可用区、跨地域调用，连接建立成本会更敏感，Keep-Alive 的收益通常只会更明显，不会更小。</p>
<p>另外，我顺手看了一下连接状态，能看到明显的 <code>TIME_WAIT</code> 痕迹。这不算严格的系统级采样，但足够说明趋势：<strong>不复用连接时，关闭动作更频繁，TIME_WAIT 更容易堆起来</strong>。</p>

<h1 id="如何自己复现并验证"><a href="#如何自己复现并验证" class="headerlink" title="如何自己复现并验证"></a>如何自己复现并验证</h1>
<p>你可以直接按下面步骤自己跑一遍。</p>
<h2 id="步骤-1：启动服务"><a href="#步骤-1：启动服务" class="headerlink" title="步骤 1：启动服务"></a>步骤 1：启动服务</h2>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line">node keepalive-server.js</span><br><span class="line"><span class="comment"># 服务监听 127.0.0.1:3100</span></span><br></pre></td></tr></table></figure>

<h2 id="步骤-2：运行压测"><a href="#步骤-2：运行压测" class="headerlink" title="步骤 2：运行压测"></a>步骤 2：运行压测</h2>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td><td class="code"><pre><span class="line">node keepalive-bench.js</span><br><span class="line"><span class="comment"># 输出 no-keepalive 和 keepalive 两组 JSON 结果</span></span><br></pre></td></tr></table></figure>

<h2 id="步骤-3：观察连接状态"><a href="#步骤-3：观察连接状态" class="headerlink" title="步骤 3：观察连接状态"></a>步骤 3：观察连接状态</h2>
<p>如果你的机器有 <code>ss</code> 命令，可以这么看：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">ss -tan | grep :3100</span><br></pre></td></tr></table></figure>
<p>如果没有 <code>ss</code>，也可以退而求其次用 <code>netstat</code>：</p>
<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br></pre></td><td class="code"><pre><span class="line">netstat -an | grep 3100</span><br></pre></td></tr></table></figure>
<p><strong>验证结论的方法</strong> 很简单，就看两件事：</p>
<ul>
<li>开启 Keep-Alive 后，吞吐是不是明显更高；</li>
<li>开启 Keep-Alive 后，高位延迟（P95/P99）是不是明显更稳。</li>
</ul>
<p>如果你愿意再多走一步，还可以把服务端改成 HTTPS，再压一次。通常你会更明显地看到：<strong>连接复用在有 TLS 的场景里更值钱</strong>。</p>

<h1 id="为什么高位延迟改善更明显"><a href="#为什么高位延迟改善更明显" class="headerlink" title="为什么高位延迟改善更明显"></a>为什么高位延迟改善更明显</h1>
<p>很多文章只盯着平均值，但工程上更该盯的是 <strong>P95 / P99</strong>。P95 的意思是 95% 的请求都不超过这个时间；P99 则是 99% 的请求不超过这个时间。它们更能反映“尾部请求有没有抖”。</p>
<p>不开 Keep-Alive 时，每个请求都更像一次完整的“冷启动”：</p>
<ul>
<li>要分配新连接；</li>
<li>要走握手；</li>
<li>要进入关闭流程；</li>
<li>系统负载一高，还会出现排队和状态切换开销。</li>
</ul>
<p>这些额外动作在平均值上可能没那么夸张，但一旦并发上来，尾部延迟通常先炸。所以你会看到：<strong>P95/P99 的收益，往往比 P50 更明显</strong>。这也是为什么线上做性能优化时，盯均值很容易把自己骗了。</p>

<h1 id="什么时候一定建议开"><a href="#什么时候一定建议开" class="headerlink" title="什么时候一定建议开"></a>什么时候一定建议开</h1>
<p>下面这些场景，我的建议基本是：<strong>优先考虑开启 Keep-Alive，并认真配连接池</strong>。</p>
<ul>
<li><strong>服务间频繁调用</strong>：比如网关调后端、A 服务调 B 服务、B 服务再调 C 服务。</li>
<li><strong>短请求、高并发</strong>：请求本身很轻，结果大部分时间都浪费在建连和关连上。</li>
<li><strong>HTTPS 调用</strong>：TLS 握手成本更高，复用收益更大。</li>
<li><strong>批量拉取/推送</strong>：比如爬虫、文件元数据查询、批量写 WebHook。</li>
</ul>
<p>特别是在 Java、Node.js、Go 这种服务端常见技术栈里，连接复用通常不是“锦上添花”，而是一个相当基础的工程优化项。</p>

<h1 id="什么时候不要无脑开大"><a href="#什么时候不要无脑开大" class="headerlink" title="什么时候不要无脑开大"></a>什么时候不要无脑开大</h1>
<p>注意，我说的是“建议开”，不是“无脑把连接池开到最大”。Keep-Alive 常见的坑，很多都不是出在开关本身，而是出在参数和上下游协同上。</p>
<h2 id="坑-1：客户端空闲时间比服务端还长"><a href="#坑-1：客户端空闲时间比服务端还长" class="headerlink" title="坑 1：客户端空闲时间比服务端还长"></a>坑 1：客户端空闲时间比服务端还长</h2>
<p>这类问题特别常见。服务端已经因为空闲超时把连接关了，但客户端还以为这条连接能继续用，下次拿出来一发请求，直接 <code>ECONNRESET</code>。</p>
<p>经验上，<strong>客户端的空闲连接保活时长，要略短于服务端的 Keep-Alive 超时</strong>，这样更稳。</p>

<h2 id="坑-2：maxSockets-设太大，把下游打穿"><a href="#坑-2：maxSockets-设太大，把下游打穿" class="headerlink" title="坑 2：maxSockets 设太大，把下游打穿"></a>坑 2：maxSockets 设太大，把下游打穿</h2>
<p>有些人一看连接池能调，就想当然地拉满。问题是，连接数本质上也是并发放大器。你本机舒服了，不代表下游舒服。特别是数据库代理、老服务、第三方接口，连接一多反而更容易抖。</p>
<p>所以 <code>maxSockets</code> 要结合：</p>
<ul>
<li>下游实例数；</li>
<li>下游单机承载能力；</li>
<li>你的超时与重试策略；</li>
<li>是否经过负载均衡或 Sidecar。</li>
</ul>

<h2 id="坑-3：以为-HTTP-2-就不需要关心连接池"><a href="#坑-3：以为-HTTP-2-就不需要关心连接池" class="headerlink" title="坑 3：以为 HTTP/2 就不需要关心连接池"></a>坑 3：以为 HTTP/2 就不需要关心连接池</h2>
<p><strong>HTTP/2</strong> 引入了多路复用，也就是一条连接里能并发跑多个流，这确实比 HTTP/1.1 更先进。但这不等于“连接管理不用管了”。连接生命周期、空闲超时、负载均衡均匀性，还是一样要看。</p>
<p>别把“协议升级了”误解成“系统复杂度没了”。</p>

<h2 id="坑-4：只看-QPS，不看错误率和尾延迟"><a href="#坑-4：只看-QPS，不看错误率和尾延迟" class="headerlink" title="坑 4：只看 QPS，不看错误率和尾延迟"></a>坑 4：只看 QPS，不看错误率和尾延迟</h2>
<p>性能优化最容易把人带沟里的一件事，就是只看吞吐。Keep-Alive 调优时，至少要同时看：</p>
<ul>
<li>吞吐（QPS / req/s）</li>
<li>P50 / P95 / P99</li>
<li>错误率</li>
<li>TIME_WAIT / ESTABLISHED 数量趋势</li>
<li>连接池命中率或复用率（如果框架有暴露）</li>
</ul>
<p>单看 QPS，结论经常不完整。</p>

<h1 id="线上怎么落地更稳"><a href="#线上怎么落地更稳" class="headerlink" title="线上怎么落地更稳"></a>线上怎么落地更稳</h1>
<p>如果你要在线上服务里落地 Keep-Alive，我建议按这个顺序来：</p>
<blockquote>
<p>1、先确认客户端真的在复用连接；<br>2、再确认客户端和服务端的空闲超时是不是匹配；<br>3、然后压测看吞吐、P95/P99、错误率；<br>4、最后再去细调 <code>maxSockets</code>、空闲连接数和超时参数。</p>
</blockquote>
<p>如果你的服务有监控体系，最好顺手加上这些指标：</p>
<ul>
<li>连接池总连接数、活跃连接数、空闲连接数</li>
<li>请求耗时分位数</li>
<li>连接复用命中率</li>
<li>连接建立失败数 / 重置数</li>
</ul>
<p>你会发现，Keep-Alive 不是一个孤立优化点，它其实是调用链稳定性的组成部分。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li><strong>Keep-Alive 的本质</strong>：复用 TCP 连接，减少重复建连和关连成本。</li>
<li><strong>它最直接的收益</strong>：吞吐更高，P95/P99 更稳，TIME_WAIT 压力更小。</li>
<li><strong>实验结论</strong>：在本文的小实验里，开启 Keep-Alive 后吞吐提升约 48.9%，P95/P99 明显下降。</li>
<li><strong>最常见的坑</strong>：客户端和服务端超时不匹配、连接池过大、只盯 QPS 不看尾延迟。</li>
<li><strong>工程建议</strong>：Keep-Alive 值得开，但必须和连接池、超时、压测、监控一起看。</li>
</ul>
<p>如果你之前对 Keep-Alive 的理解还停留在“减少握手，性能更好”，那到这里至少应该多一层判断：<strong>它不是要不要开的问题，而是怎么配、怎么验证、怎么避免副作用的问题。</strong></p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li><a target="_blank" rel="noopener" href="https://nodejs.org/api/http.html">Node.js 官方文档：HTTP</a></li>
<li><a target="_blank" rel="noopener" href="https://developer.mozilla.org/en-US/docs/Web/HTTP/Connection_management_in_HTTP_1.x">MDN：Connection management in HTTP/1.x</a></li>
<li><a target="_blank" rel="noopener" href="https://datatracker.ietf.org/doc/html/rfc7230">RFC 7230：HTTP/1.1 Message Syntax and Routing</a></li>
<li><a target="_blank" rel="noopener" href="https://hpbn.co/http1x/">High Performance Browser Networking：HTTP/1.x</a></li>
<li><a target="_blank" rel="noopener" href="https://www.nginx.com/blog/http-keepalives-and-web-performance/">NGINX：HTTP keepalives and web performance</a></li>
</ol>
