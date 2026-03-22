---
title: 用 tcpdump + Wireshark 复盘一次 HTTPS 慢请求：从三次握手到 TLS 握手到底卡在哪
date: 2026-03-22 10:00:00
categories:
  - 计算机网络
  - 抓包与排障
tags:
  - tcpdump
  - Wireshark
  - HTTPS
  - TLS
  - 抓包
  - 网络排障
---
<hr>
<blockquote>
<p>线上一遇到 <strong>HTTPS</strong> 慢请求，很多人第一反应就是“服务端慢了”或者“网络抖了”，但如果你连一次完整的抓包都没复盘过，排障基本是在靠猜。真正有用的办法，是把一次慢请求拆成 <strong>DNS、TCP 三次握手、TLS 握手、首包等待、数据传输</strong> 这几段，看看时间到底耗在了哪。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这篇文章值得写"><a href="#为什么这篇文章值得写" class="headerlink" title="为什么这篇文章值得写"></a>为什么这篇文章值得写</h1><p>老板最近几天的文章主线，主要在 <strong>Java × AI 工程化</strong> 和 <strong>后端性能</strong> 这块。这个方向没问题，但如果连续几天都只盯应用层，很容易把博客写窄。今天我更想补一篇<strong>网络排障</strong>向的硬核文章：它离工程现场足够近，而且读者能马上拿去排查真实问题。</p>
<p>线上慢请求这件事，最烦人的地方就在于：症状看上去都差不多，结论却可能完全不同。你看到“接口 1.8 秒才返回”，可能是 <strong>DNS</strong> 慢，也可能是 <strong>SYN</strong> 重传，也可能是 <strong>TLS handshake</strong> 卡住了，还可能是服务端应用处理慢。要是这几类问题混在一起看，不管是调连接池、调超时，还是怀疑网关和负载均衡，都很容易跑偏。</p>
<p>这篇文章不讲空泛的“网络优化原则”，而是直接做一个<strong>可复现的小实验</strong>：用 <strong>tcpdump</strong> 抓包、用 <strong>Wireshark</strong> 复盘时间线，把一次 HTTPS 请求拆开看；然后再给一套命令行排查套路，告诉你慢到底慢在连接前、握手中，还是请求已经进了服务端。</p>

<h1 id="先说结论"><a href="#先说结论" class="headerlink" title="先说结论"></a>先说结论</h1><p>如果你现在时间不多，先记下面几条：</p>
<ul>
<li>排查 HTTPS 慢请求时，别上来就盯应用日志，先把请求拆成 <strong>DNS → TCP 三次握手 → TLS 握手 → 首字节等待 → 数据传输</strong> 五段。</li>
<li><strong>tcpdump</strong> 是抓原始网络包的命令行工具，适合在 Linux 机器上第一时间取证；<strong>Wireshark</strong> 是把这些包“翻译成人话”的图形化分析工具，适合复盘细节。</li>
<li>如果慢在 TCP 建连前半段，常见原因是丢包、重传、链路质量差、负载均衡回源异常；如果慢在 TLS 握手，常见原因是证书链、密码套件协商、服务端 CPU 压力、TLS 终止层处理慢。</li>
<li>很多所谓“服务端慢”，其实是客户端在 <strong>connect</strong> 或 <strong>TLS handshake</strong> 阶段就已经把时间花掉了；应用代码根本还没真正开始跑。</li>
<li>最稳的排查方式不是拍脑袋，而是：<strong>curl 打点 + tcpdump 抓包 + Wireshark 时间线 + 服务端 access log 对时</strong> 一起看。</li>
</ul>

<h1 id="先把几个关键名词说人话"><a href="#先把几个关键名词说人话" class="headerlink" title="先把几个关键名词说人话"></a>先把几个关键名词说人话</h1><p>为了后面看抓包不懵，这里先把几个术语说得接地气一点：</p>
<ul>
<li><strong>TCP 三次握手</strong>：就是客户端和服务端正式“建连接”前互相打招呼确认状态的过程，典型包序列是 <code>SYN → SYN,ACK → ACK</code>。</li>
<li><strong>TLS handshake</strong>：可以理解成 HTTPS 在真正传业务数据前，先协商“你是谁、我用什么密钥、后面怎么加密通信”的过程。慢在这里，通常和证书、加密套件、终止代理、CPU 压力有关。</li>
<li><strong>TTFB（Time To First Byte）</strong>：首字节时间，意思是从你发出请求到收到响应第一个字节，中间总共等了多久。它把建连、TLS、服务端处理都包进去了，所以只能拿来发现慢，不能直接说明慢在哪。</li>
<li><strong>RST</strong>：重置连接，口语化理解就是“对端不跟你玩了，连接直接掐断”。</li>
<li><strong>重传（Retransmission）</strong>：某个包发出去后迟迟没收到确认，于是又补发一次。抓包里如果重传很多，链路质量和拥塞通常值得重点怀疑。</li>
</ul>

<h1 id="实验目标：把一次慢-HTTPS-请求拆开看"><a href="#实验目标：把一次慢-HTTPS-请求拆开看" class="headerlink" title="实验目标：把一次慢 HTTPS 请求拆开看"></a>实验目标：把一次慢 HTTPS 请求拆开看</h1><p>今天这个实验不依赖复杂环境，用一台 Linux 主机就能跑通。目标很明确：</p>
<ol>
<li>对一个 HTTPS 接口发请求，并记录分段耗时；</li>
<li>同时用 <code>tcpdump</code> 把网络包抓下来；</li>
<li>用 Wireshark 或 tshark 复盘：到底慢在 TCP 建连、TLS 握手，还是服务端业务处理；</li>
<li>给出一个排障结论模板，后面线上遇到问题可以直接套。</li>
</ol>
<p>实验环境如下：</p>
<ul>
<li>客户端：Linux（CentOS / Ubuntu 都行）</li>
<li>抓包工具：tcpdump 4.x+</li>
<li>分析工具：Wireshark 4.x 或 tshark</li>
<li>测试命令：curl 8.x</li>
<li>目标站点：一个你能访问的 HTTPS 站点，本文用 <code>https://example.com</code> 做演示</li>
</ul>
<p>如果你线上不能直接装 Wireshark，也没关系：先抓 <code>pcap</code> 文件，下载到本地再分析。</p>

<h1 id="第一步：先用-curl-把时间切开"><a href="#第一步：先用-curl-把时间切开" class="headerlink" title="第一步：先用 curl 把时间切开"></a>第一步：先用 <code>curl</code> 把时间切开</h1><p><code>curl</code> 很适合做第一层定位，因为它能直接告诉你：DNS、TCP connect、TLS 握手、首字节、总耗时各花了多少时间。</p>
<pre><code class="language-bash">curl -o /dev/null -s -w '\nlookup=%{time_namelookup}\nconnect=%{time_connect}\nappconnect=%{time_appconnect}\nstarttransfer=%{time_starttransfer}\ntotal=%{time_total}\n' https://example.com
</code></pre>
<p>一组典型输出可能像这样：</p>
<pre><code class="language-text">lookup=0.008
connect=0.032
appconnect=0.214
starttransfer=0.486
total=0.491
</code></pre>
<p>这里几个字段要分清：</p>
<table>
<thead>
<tr><th>字段</th><th>含义</th><th>怎么看</th></tr>
</thead>
<tbody>
<tr><td><code>time_namelookup</code></td><td>DNS 解析完成时间</td><td>如果这里高，先查 DNS，不要急着看服务端</td></tr>
<tr><td><code>time_connect</code></td><td>TCP 连接建立完成时间</td><td>高了多半和链路、丢包、回源路径有关</td></tr>
<tr><td><code>time_appconnect</code></td><td>TLS 握手完成时间</td><td>高了重点看 TLS 协商、证书链、终止代理</td></tr>
<tr><td><code>time_starttransfer</code></td><td>收到首字节时间</td><td>减去前面几段后，剩下的更接近服务端处理时间</td></tr>
<tr><td><code>time_total</code></td><td>总耗时</td><td>只适合发现问题，不足以解释问题</td></tr>
</tbody>
</table>
<p>比如上面这组数据，<code>connect=32ms</code>，但 <code>appconnect=214ms</code>，就说明 TCP 建连并不慢，时间主要花在 TLS 握手阶段。<code>starttransfer=486ms</code>，说明服务端从 TLS 完成到开始回包又花了大约 272ms。</p>
<p>这个阶段你已经能做第一轮判断，但还不够。因为 <code>curl</code> 只告诉你“慢了”，不会告诉你包和包之间发生了什么。所以第二步一定是抓包。</p>

<h1 id="第二步：用-tcpdump-抓到原始证据"><a href="#第二步：用-tcpdump-抓到原始证据" class="headerlink" title="第二步：用 tcpdump 抓到原始证据"></a>第二步：用 <code>tcpdump</code> 抓到原始证据</h1><p><strong>tcpdump</strong> 可以理解成“网络世界的黑匣子”。它不负责讲故事，它负责把真相原封不动记下来。</p>
<p>先找到网卡名：</p>
<pre><code class="language-bash">ip addr
</code></pre>
<p>然后抓目标主机 443 端口的包：</p>
<pre><code class="language-bash">sudo tcpdump -i eth0 -nn host example.com and port 443 -w /tmp/https-slow.pcap
</code></pre>
<p>参数解释一下：</p>
<ul>
<li><code>-i eth0</code>：指定网卡；如果你不知道用哪块网卡，可以先 <code>tcpdump -D</code> 看列表。</li>
<li><code>-nn</code>：不要把 IP 和端口再翻译成域名/服务名，避免输出看起来更乱。</li>
<li><code>-w</code>：把包写进 pcap 文件，方便后面复盘。</li>
</ul>
<p>抓包开始后，另开一个终端发请求：</p>
<pre><code class="language-bash">curl -o /dev/null -s -w '\nlookup=%{time_namelookup}\nconnect=%{time_connect}\nappconnect=%{time_appconnect}\nstarttransfer=%{time_starttransfer}\ntotal=%{time_total}\n' https://example.com
</code></pre>
<p>跑完以后按 <code>Ctrl+C</code> 结束抓包。接着你可以先在命令行快速扫一眼：</p>
<pre><code class="language-bash">tcpdump -nn -tttt -r /tmp/https-slow.pcap | sed -n '1,40p'
</code></pre>
<p>一段典型的时间线可能像这样：</p>
<pre><code class="language-text">2026-03-22 09:58:00.101234 IP 10.0.0.5.49832 &gt; 93.184.216.34.443: Flags [S], seq 1000, win 64240, options ..., length 0
2026-03-22 09:58:00.132881 IP 93.184.216.34.443 &gt; 10.0.0.5.49832: Flags [S.], seq 2000, ack 1001, win 65160, options ..., length 0
2026-03-22 09:58:00.133012 IP 10.0.0.5.49832 &gt; 93.184.216.34.443: Flags [.], ack 2001, win 64240, length 0
2026-03-22 09:58:00.133540 IP 10.0.0.5.49832 &gt; 93.184.216.34.443: TLSv1.3, Client Hello
2026-03-22 09:58:00.304107 IP 93.184.216.34.443 &gt; 10.0.0.5.49832: TLSv1.3, Server Hello
2026-03-22 09:58:00.487992 IP 10.0.0.5.49832 &gt; 93.184.216.34.443: Flags [P.], length 517
2026-03-22 09:58:00.588345 IP 93.184.216.34.443 &gt; 10.0.0.5.49832: Flags [P.], length 1368
</code></pre>
<p>只看这几行，已经能判断很多事：</p>
<ul>
<li><code>SYN → SYN,ACK</code> 大约花了 31ms，说明 TCP 建连正常；</li>
<li><code>Client Hello → Server Hello</code> 大约花了 170ms，TLS 握手比较慢；</li>
<li>HTTP 请求发出后，服务端首个响应包大约 100ms 后回来，应用处理不算离谱。</li>
</ul>

<h1 id="第三步：用-Wireshark-把慢点可视化"><a href="#第三步：用-Wireshark-把慢点可视化" class="headerlink" title="第三步：用 Wireshark 把慢点可视化"></a>第三步：用 Wireshark 把慢点可视化</h1><p>如果你直接看 tcpdump 文本输出，能定位八成问题；但一旦遇到重传、窗口缩小、TLS 多轮协商，还是 Wireshark 更稳。它最大的价值，是能把“包的顺序”和“时间差”展示得特别直观。</p>
<p>打开 <code>/tmp/https-slow.pcap</code> 后，建议按这个顺序看：</p>
<ol>
<li>过滤表达式：<code>tcp.stream eq 0</code>，先只看这一条连接；</li>
<li>看 <strong>Time</strong> 列，确认三次握手有没有明显空洞；</li>
<li>看 TLS 的 <strong>Client Hello / Server Hello / Certificate / Finished</strong>；</li>
<li>看 HTTP 请求发出后，到服务端第一个 Application Data 回来的时间差；</li>
<li>看有没有 <strong>TCP Retransmission</strong>、<strong>Dup ACK</strong>、<strong>RST</strong>。</li>
</ol>
<p>如果你更习惯命令行，也可以用 <code>tshark</code> 提取关键信息：</p>
<pre><code class="language-bash">tshark -r /tmp/https-slow.pcap -Y 'tcp or tls' \
  -T fields \
  -e frame.time_relative \
  -e ip.src -e tcp.srcport \
  -e ip.dst -e tcp.dstport \
  -e _ws.col.Protocol \
  -e _ws.col.Info | sed -n '1,40p'
</code></pre>
<p>这条命令特别适合线上没图形界面的场景。</p>

<h2 id="一个实用的判断模板"><a href="#一个实用的判断模板" class="headerlink" title="一个实用的判断模板"></a>一个实用的判断模板</h2><table>
<thead>
<tr><th>现象</th><th>更可能的慢点</th><th>优先排查方向</th></tr>
</thead>
<tbody>
<tr><td><code>time_namelookup</code> 高</td><td>DNS</td><td>本地 DNS、公司内网 DNS、上游权威解析、缓存命中</td></tr>
<tr><td><code>time_connect</code> 高，抓包里 SYN 重传</td><td>TCP 建连</td><td>丢包、网络质量、四层 LB、跨地域回源</td></tr>
<tr><td><code>time_appconnect</code> 高，TLS 包间隔大</td><td>TLS 握手</td><td>证书链、密码套件协商、TLS 终止层、服务端 CPU</td></tr>
<tr><td><code>starttransfer</code> 明显高于 <code>appconnect</code></td><td>服务端处理</td><td>应用日志、线程池、DB、缓存、下游依赖</td></tr>
<tr><td>传输中多次重传或零窗口</td><td>数据传输阶段</td><td>拥塞、接收方消费慢、网卡/内核参数、带宽瓶颈</td></tr>
</tbody>
</table>
<p>这张表的价值在于：它能帮你把“慢请求”从一句空话，变成一条条可验证的假设。</p>

<h1 id="可复现实验：人为制造一个更慢的-TLS-阶段"><a href="#可复现实验：人为制造一个更慢的-TLS-阶段" class="headerlink" title="可复现实验：人为制造一个更慢的 TLS 阶段"></a>可复现实验：人为制造一个更慢的 TLS 阶段</h1><p>光看正常流量还不够，最好自己造一个“明显慢在握手”的场景。最简单的办法，是通过一个本地代理或者测试环境中的 TLS 终止层，给握手前后加一点延迟。</p>
<p>比如你可以在测试机上用 <code>tc</code> 注入网络延迟：</p>
<pre><code class="language-bash">sudo tc qdisc add dev eth0 root netem delay 120ms 20ms
</code></pre>
<p>然后再次执行：</p>
<pre><code class="language-bash">curl -o /dev/null -s -w '\nlookup=%{time_namelookup}\nconnect=%{time_connect}\nappconnect=%{time_appconnect}\nstarttransfer=%{time_starttransfer}\ntotal=%{time_total}\n' https://example.com
</code></pre>
<p>你通常会看到像这样的变化：</p>
<table>
<thead>
<tr><th>场景</th><th>lookup</th><th>connect</th><th>appconnect</th><th>starttransfer</th><th>total</th></tr>
</thead>
<tbody>
<tr><td>正常网络</td><td>8ms</td><td>32ms</td><td>214ms</td><td>486ms</td><td>491ms</td></tr>
<tr><td>增加 120ms 延迟后</td><td>8ms</td><td>151ms</td><td>471ms</td><td>742ms</td><td>747ms</td></tr>
</tbody>
</table>
<p>这个对比很有意思：你会发现总耗时变长，不是服务端应用代码突然慢了，而是 <strong>connect</strong> 和 <strong>appconnect</strong> 一起被抬高了。这就是“网络和握手阶段拖慢整体体验”的一个最小复现。</p>
<p>实验结束别忘了恢复：</p>
<pre><code class="language-bash">sudo tc qdisc del dev eth0 root netem
</code></pre>

<h1 id="如何验证你的结论站得住"><a href="#如何验证你的结论站得住" class="headerlink" title="如何验证你的结论站得住"></a>如何验证你的结论站得住</h1><p>排障最怕“看着像”。所以你至少要做下面这几步验证：</p>
<ol>
<li>用 <code>curl -w</code> 连续打 10~20 次，确认慢点是否稳定落在同一段；</li>
<li>抓一份对应时间窗口内的 pcap，确认是否真有 SYN 重传、TLS 包间隔异常、RST 等现象；</li>
<li>把客户端时间线和服务端 access log 对齐，看请求什么时候真正进入应用；</li>
<li>如果怀疑服务端 TLS 终止层慢，检查 Nginx / Ingress / 网关的 TLS 终止位置和 CPU 利用率；</li>
<li>如果怀疑链路质量，换一台机器、换一条网络出口再复测，排除单点环境问题。</li>
</ol>
<p>只有这几步对上了，你才能比较有底气地说：“这次慢，不是后端业务慢，而是前面的握手阶段拖了后腿。”</p>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1><ol>
<li><strong>误区一：只看接口总耗时，不拆阶段。</strong><br>这基本等于没定位。总耗时只能说明“慢了”，不能说明“慢在哪”。</li>
<li><strong>误区二：抓包只在服务端抓。</strong><br>如果问题出在客户端到入口链路之间，只在服务端抓，很多细节你根本看不到。最好客户端和服务端两边都能抓，至少抓客户端侧。</li>
<li><strong>误区三：看到 TLS 慢就怀疑证书快过期。</strong><br>证书过期当然是大事，但 TLS 慢更常见的原因其实是握手轮次、密码套件协商、终止代理压力、链路 RTT 变大。</li>
<li><strong>误区四：把 Wireshark 当成“有问题再学”的工具。</strong><br>真出故障时现学很容易慌。平时就该拿正常流量练手，知道一条健康的 HTTPS 连接长什么样。</li>
<li><strong>误区五：认为 HTTPS 慢一定是加密算法太重。</strong><br>现在大多数线上场景里，纯加解密开销未必是主因，很多时候慢在 RTT、重传、TLS 终止层、服务端排队，而不是“加密本身太贵”。</li>
</ol>

<h1 id="线上排障时我更推荐的套路"><a href="#线上排障时我更推荐的套路" class="headerlink" title="线上排障时我更推荐的套路"></a>线上排障时我更推荐的套路</h1><p>如果你线上真的遇到 HTTPS 慢请求，我更建议按这个顺序来，不容易乱：</p>
<ol>
<li>先用 <code>curl -w</code> 把分段耗时切出来；</li>
<li>再用 <code>tcpdump</code> 抓一小段目标流量，别一上来抓全机全端口；</li>
<li>用 Wireshark / tshark 看单条连接时间线；</li>
<li>把抓包时间和服务端 access log、网关日志对时；</li>
<li>最后再决定去优化 DNS、链路、TLS 终止层，还是应用代码。</li>
</ol>
<p>这套流程有个很大的好处：它能避免团队陷入“各部门互相甩锅”。网络、网关、应用、运维都可以围着同一份时间线说话，效率会高很多。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1><p>把这篇文章压缩成一句话，就是：<strong>HTTPS 慢请求别靠猜，抓包之后按阶段拆开看，问题通常会比你想象得更具体</strong>。</p>
<p>你完全可以把今天这套方法当成一个固定排障模板：</p>
<ul>
<li>先用 <code>curl</code> 拆阶段；</li>
<li>再用 <code>tcpdump</code> 取证；</li>
<li>接着用 Wireshark 看时间线；</li>
<li>最后和服务端日志对时，确认慢点到底在哪。</li>
</ul>
<p>很多“服务端慢”的结论，最后都会被抓包推翻：真正慢的，可能是建连、握手、重传、链路质量，甚至只是一个 TLS 终止层配置不合理。工程排障最值钱的，不是经验本身，而是<strong>把经验变成可复现、可验证的方法</strong>。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1><ol>
<li>tcpdump 官方手册：抓包过滤表达式与 pcap 输出</li>
<li>Wireshark 官方文档：Display Filter 与 TCP/TLS 分析方法</li>
<li>curl 官方文档：<code>--write-out</code> 时间指标说明</li>
<li>RFC 8446：The Transport Layer Security (TLS) Protocol Version 1.3</li>
<li>RFC 9293：Transmission Control Protocol (TCP)</li>
<li>Nginx 官方文档：SSL/TLS Termination 配置与调优</li>
</ol>
