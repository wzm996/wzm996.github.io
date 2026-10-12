---
title: 零拷贝实战：用 strace 数一数 read+write 的 4096 次拷贝，再看 sendfile 怎么把它砍成 2 次（附压测数据）
date: 2026-10-12 10:00:00
categories:
  - 操作系统与 Linux
  - I/O
tags:
  - 零拷贝
  - sendfile
  - strace
  - Java NIO
  - Kafka
  - Page Cache
---

<hr>
<blockquote>
<p><strong>零拷贝（Zero-Copy）</strong>不是"一次拷贝都没有"，而是把数据在<strong>内核缓冲区</strong>和<strong>用户态缓冲区</strong>之间来回倒腾的 CPU 拷贝砍掉。这篇用一个 30 行的小服务 + strace，把"读文件发给网络"这件事从 8192 次系统调用优化到 2 次，256MB 文件的传输延迟直接降了 30%。全文实验都在一台 2 核 2G 的普通云主机上跑通，你复制粘贴就能复现。</p>
</blockquote>

<!-- more -->

<h1 id="section-1">一、为什么突然又聊零拷贝</h1>

<p>先说结论：<strong>Kafka 快、Nginx 快，零拷贝功不可没</strong>。Kafka 的设计文档里明明白白写着"用 sendfile 把日志文件直接推给消费者"；Nginx 配置里那行默认开着的 <code>sendfile on;</code> 干的也是同一件事。</p>

<p>但"零拷贝"这个词被讲烂了，很多人背得出"4 次拷贝变 2 次"，却从来没亲眼见过这 4 次拷贝长什么样。所以这篇我们不背书，直接上手抓：用 <strong>strace</strong>（一个系统调用跟踪工具，能把进程跟内核打的每一声招呼都录下来）把两种传输方式的系统调用一条条数出来，再用压测数据验证省掉的 CPU 到底变成了什么。</p>

<p>目标读者：写过 Java 后端、被 Kafka/Nginx 的"高性能"唬住过、想知道背后发生了什么的工程师。先修知识：知道 Linux 有"文件"和"socket"这俩东西就行，其他的文中现讲。</p>

<h1 id="section-2">二、先把"笨办法"的账算清楚：read + write 的完整旅程</h1>

<p>最朴素的文件传输代码长这样（几乎所有后端工程师都写过）：</p>

<pre><code class="language-java">byte[] buf = new byte[64 * 1024];
try (InputStream in = new FileInputStream("big.bin");
     OutputStream out = socket.getOutputStream()) {
    int n;
    while ((n = in.read(buf)) != -1) {   // 读：内核 -&gt; 用户态
        out.write(buf, 0, n);            // 写：用户态 -&gt; 内核
    }
}</code></pre>

<p>看起来只有"一次读、一次写"，但内核里发生的事情多得多。先解释两个新名词：</p>

<p><strong>DMA（Direct Memory Access，直接内存访问）</strong>：它是主板上一个专门干搬运粗活的部件，能在 CPU 完全不参与的情况下，把数据在磁盘和内存之间直接搬。CPU 只需要下一道指令"把这 4KB 搬到内存这个地址"，然后就去干别的了，搬完 DMA 再喊一声。没有 DMA 的话，每搬一个字节都要 CPU 亲自出手，那 CPU 就别干别的了。</p>

<p><strong>Page Cache（页缓存）</strong>：Linux 会把 recently 读写过的文件内容缓存在内核的空闲内存里。你第二次读同一个文件，多半根本碰不到磁盘，直接从内存里拿——这也是为什么第二次跑同一个程序明显快了。</p>

<p>于是 <code>read + write</code> 的完整旅程是这样的，以"磁盘文件 → 网卡"为例：</p>

<pre><code>1. read() 调用：用户态 -&gt; 内核态（上下文切换 1 次）
2. 磁盘 -&gt; Page Cache            （DMA 拷贝 ①）
3. Page Cache -&gt; 用户态 byte[]   （CPU 拷贝 ②）
4. read() 返回：内核态 -&gt; 用户态（上下文切换 2 次）
5. write() 调用：用户态 -&gt; 内核态（上下文切换 3 次）
6. 用户态 byte[] -&gt; socket 缓冲区（CPU 拷贝 ③）
7. socket 缓冲区 -&gt; 网卡         （DMA 拷贝 ④）
8. write() 返回：内核态 -&gt; 用户态（上下文切换 4 次）</code></pre>

<p>数一下：<strong>4 次拷贝（2 次 CPU + 2 次 DMA）、4 次上下文切换</strong>。最要命的是第 ②③ 步：数据明明就待在内核的 Page Cache 里，非要先抄一份到用户态的 byte[]，再原封不动抄回内核的 socket 缓冲区——这两次 CPU 拷贝纯属内耗，数据一个字节都没变。而且每次系统调用都意味着 CPU 要在用户态和内核态之间来回切换（保存现场、换页表权限、恢复现场），这个开销在数据量大的时候非常可观。</p>

<p><strong>零拷贝要砍掉的，就是第 ②③ 步这两次 CPU 拷贝。</strong></p>

<h1 id="section-3">三、零拷贝家族图谱：mmap+write、sendfile、sendfile + DMA gather</h1>

<p>零拷贝不是一个单一技术，而是一族优化，按"砍拷贝的狠度"排三代：</p>

<h2 id="section-3-1">第一代：mmap + write（砍掉 1 次 CPU 拷贝）</h2>

<p><strong>mmap（memory map，内存映射）</strong>：把文件直接"铺"到进程的虚拟地址空间上，用户代码读写这块内存就等于读写文件，数据不需要从内核抄到用户缓冲区。它解决的问题是"省掉 Page Cache → 用户态这一跳"。</p>

<p>路径变成：磁盘 →(DMA)→ Page Cache →(CPU)→ socket 缓冲区 →(DMA)→ 网卡。3 次拷贝（1 CPU + 2 DMA）。缺点是 write 那一下还是要 CPU 亲自动手，而且上下文切换次数没省。</p>

<h2 id="section-3-2">第二代：sendfile（一次系统调用搞定，再砍 1 次）</h2>

<p><strong>sendfile</strong>：Linux 2.2 引入的系统调用，签名一句话：<code>sendfile(输出 socket, 输入文件, 偏移, 字节数)</code>——直接把文件的一段塞进 socket，数据全程不进用户态。</p>

<p>路径变成：磁盘 →(DMA)→ Page Cache →(CPU)→ socket 缓冲区 →(DMA)→ 网卡。拷贝数和 mmap+write 一样是 3 次，但<strong>系统调用从 2 次降到 1 次，上下文切换从 4 次降到 2 次</strong>，而且用户态连数据长什么样都不知道（对网关/代理来说还有安全副作用，后面讲坑）。</p>

<h2 id="section-3-3">第三代：sendfile + DMA gather（CPU 拷贝归零，"真·零拷贝"）</h2>

<p>如果网卡支持 <strong>scatter-gather（分散-聚集，DMA gather）</strong>——意思是 DMA 能按"地址 + 长度"的清单从多个内存页拼着搬——那么 socket 缓冲区里干脆不放数据了，只放页描述符，DMA 直接从 Page Cache 把数据搬到网卡。</p>

<p>路径变成：磁盘 →(DMA)→ Page Cache →(DMA gather)→ 网卡。<strong>0 次 CPU 拷贝，2 次 DMA，2 次上下文切换。</strong>这才配得上"零拷贝"这个名字。</p>

<h2 id="section-3-4">对比表</h2>

<table>
<thead>
<tr><th>方式</th><th>CPU 拷贝</th><th>DMA 拷贝</th><th>上下文切换</th><th>备注</th></tr>
</thead>
<tbody>
<tr><td>read + write</td><td>2</td><td>2</td><td>4</td><td>基线，数据在用户态走一圈</td></tr>
<tr><td>mmap + write</td><td>1</td><td>2</td><td>4~6</td><td>省 1 次 CPU 拷贝，用户态还能改数据</td></tr>
<tr><td>sendfile</td><td>1</td><td>2</td><td>2</td><td>系统调用 1 次，用户态摸不到数据</td></tr>
<tr><td>sendfile + DMA gather</td><td>0</td><td>2</td><td>2</td><td>"真·零拷贝"，需要网卡支持</td></tr>
</tbody>
</table>

<blockquote><p><strong>注：</strong>所以严格说，日常口语里的"零拷贝"（包括 Kafka 用的 sendfile）多数时候指"零次 <strong>CPU</strong> 拷贝"，DMA 搬运是省不掉的——数据总得从磁盘走到网卡。跟人聊技术时把这个口径对齐，能避免很多抬杠。</p></blockquote>

<h1 id="section-4">四、实验一：30 秒、不装 JDK，用 strace 亲眼数一遍</h1>

<p>纸上谈兵到此为止，开始动手。实验设计：写一个极简 HTTP 服务，同一个文件提供两种发法——<code>stream</code>（传统 read+write）和 <code>sendfile</code>（零拷贝），然后用 strace 分别数系统调用。</p>

<p>我手头这台 2 核小云机没装 JDK，所以演示代码用 Python 3 写（<code>socket.sendfile()</code> 底层就是 sendfile(2)，一回事）；第六节给出等价的 Java <code>transferTo</code> 代码，你可以在自己的机器上跑出同款结果。</p>

<h2 id="section-4-1">实验代码（保存为 zero_copy_server.py）</h2>

<pre><code class="language-python">#!/usr/bin/env python3
"""两种姿势把同一个文件发给 HTTP 客户端：
用法：python3 zero_copy_server.py &lt;stream|sendfile&gt; &lt;file&gt;
"""
import os, socket, sys

MODE, PATH = sys.argv[1], sys.argv[2]

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', 9000))
srv.listen(5)
print('listening on 9000, mode=%s' % MODE, flush=True)

while True:
    conn, _ = srv.accept()
    with conn:
        conn.recv(65536)  # 收掉 HTTP 请求头（不解析，丢弃）
        size = os.path.getsize(PATH)
        conn.sendall(('HTTP/1.1 200 OK\r\nContent-Length: %d\r\n'
                      'Connection: close\r\n\r\n' % size).encode())
        with open(PATH, 'rb') as f:
            if MODE == 'sendfile':
                conn.sendfile(f)          # -&gt; sendfile(2)，数据不过用户态
            else:
                while True:               # -&gt; read(2) + send(2) 循环
                    buf = f.read(64 * 1024)
                    if not buf:
                        break
                    conn.sendall(buf)</code></pre>

<h2 id="section-4-2">跑一遍 stream 模式</h2>

<pre><code class="language-bash"># 造一个 256MB 的测试文件
dd if=/dev/zero of=/tmp/sendfile_test.bin bs=1M count=256

# 终端 1：strace 全程跟梢（-c 输出统计摘要）
strace -f -c -o /tmp/trace_stream.txt \
  python3 zero_copy_server.py stream /tmp/sendfile_test.bin

# 终端 2：拉一次全量
curl -s -o /dev/null http://127.0.0.1:9000/

# 回终端 1 按 Ctrl+C，看统计
cat /tmp/trace_stream.txt</code></pre>

<p>我机器上的真实输出（去掉 Python 解释器启动的噪音后）：</p>

<pre><code>% time     seconds  usecs/call  calls  syscall
------ ----------- ----------- ------- ---------
 66.26    0.101838          24   4194   read
 32.16    0.049433          12   4097   sendto
  ...（openat/stat/close 等启动噪音略）</code></pre>

<p>读法：256MB ÷ 64KB 缓冲区 = 4096 次 <code>read</code>，每个 read 配一次 <code>sendto</code>，数据面系统调用合计 <strong>8192 次</strong>。每次系统调用 = 2 次用户态/内核态切换，即 256MB 的传输产生了 <strong>约 16000 次模式切换</strong>。这就是"笨办法"的真实成本。</p>

<h2 id="section-4-3">跑一遍 sendfile 模式</h2>

<pre><code class="language-bash">strace -f -c -o /tmp/trace_sendfile.txt \
  python3 zero_copy_server.py sendfile /tmp/sendfile_test.bin
# 终端 2 同样 curl 一次，Ctrl+C 后：
cat /tmp/trace_sendfile.txt</code></pre>

<p>真实输出：</p>

<pre><code>% time     seconds  usecs/call  calls  syscall
------ ----------- ----------- ------- ---------
 89.78    0.050931       25465      2   sendfile
  ...（read 97 次全是解释器启动读库，与数据无关）</code></pre>

<p><strong>2 次。</strong>同样 256MB，数据面只有 2 次 <code>sendfile</code> 调用（内核单次调用有长度上限，分了 2 次），模式切换从 16000 次跌到 4 次。两张 strace 统计表放在一起，就是零拷贝最硬核的证据。</p>

<blockquote><p><strong>注：怎么验证结论</strong>——你在自己机器上跑，只需要盯两点：① stream 模式的 <code>read</code>/<code>sendto</code>（或 <code>write</code>）次数 ≈ 文件大小 ÷ 缓冲区大小；② sendfile 模式的 <code>sendfile</code> 调用是个位数。只要这两条成立，"拷贝次数砍掉"就坐实了。</p></blockquote>

<h1 id="section-5">五、实验二：压测 15 轮，看省下来的 CPU 变成了什么</h1>

<p>系统调用数只是过程指标，还得看结果：同样拉 256MB，两种模式的速度差多少？</p>

<pre><code class="language-bash"># 不带 strace（避免观测开销），每轮记录总耗时和下载速度
# warm 跑一次预热 Page Cache 后，正式跑 15 轮：
for i in $(seq 1 15); do
  curl -s -o /dev/null -w '%{time_total} %{speed_download}\n' \
    http://127.0.0.1:9000/
done</code></pre>

<p>实测环境：2 vCPU / 1.8G 内存的云主机（General Purpose Processor），内核 <code>4.18.0-348.7.1.el8_5.x86_64</code>，ext4 数据盘，Python 3.6.8，loopback 回环，测试文件 256MB。</p>

<h2 id="section-5-1">结果（热缓存后取分位数）</h2>

<table>
<thead>
<tr><th>指标（256MB，loopback）</th><th>stream（read+write）</th><th>sendfile</th><th>变化</th></tr>
</thead>
<tbody>
<tr><td>P50 延迟</td><td>86.1 ms</td><td>60.2 ms</td><td><strong>-30%</strong></td></tr>
<tr><td>P95 延迟</td><td>94.0 ms</td><td>61.6 ms</td><td><strong>-34%</strong></td></tr>
<tr><td>吞吐（P50）</td><td>3.12 GB/s</td><td>4.47 GB/s</td><td><strong>≈ 1.43 倍</strong></td></tr>
<tr><td>数据面系统调用</td><td>8192 次</td><td>2 次</td><td><strong>≈ 1/4000</strong></td></tr>
</tbody>
</table>

<p>30% 的延迟不是白来的——省掉的是"抄出用户态再抄回去"的两趟 CPU 内存带宽和 8190 次系统调用的现场保存/恢复。连接越快（万兆、RDMA）、CPU 越忙，这块占比越高。</p>

<h2 id="section-5-2">一个意外之喜：Page Cache 的威力被拍在脸上</h2>

<p>stream 模式前两轮的数据特别有意思：<strong>2.87s（93 MB/s）→ 2.19s（122 MB/s）→ 0.086s（3.1 GB/s）</strong>。前两轮是磁盘真实速度（云盘带宽也就百来 MB/s），从第三轮起文件整个进了 Page Cache，速度直接起飞，快了 30 倍。</p>

<p>两个推论：① <strong>压测不预热 = 测了个寂寞</strong>，前两轮的"数据"和后面根本不是一个物理世界的东西；② Kafka 敢把刷盘参数放开让 OS 自己玩，吃的正是这个红利——<strong>热点日志永远躺在 Page Cache 里，消费者读的是内存不是磁盘</strong>。</p>

<blockquote><p><strong>注：loopback 数据的边界</strong>——本实验走回环地址，没有真实网卡参与，DMA 拷贝和 DMA gather 的收益体现不出来，测到的纯粹是"CPU 拷贝 + 系统调用开销"的差异。所以生产环境万兆网卡下 sendfile 的实际收益，通常比这个 1.43 倍<strong>更可观</strong>（省的是服务器 CPU，换来的是同硬件更高吞吐）。别拿 4.5 GB/s 去外推线上带宽。</p></blockquote>

<h1 id="section-6">六、Java 这边怎么抄作业：transferTo 与 mmap</h1>

<p>Java 把 sendfile 封装成了 <code>FileChannel.transferTo()</code>（JDK 1.4 就有，NIO 老将），Kafka 的 Broker 拉日志走的正是这条路：</p>

<pre><code class="language-java">// transferTo 版（Kafka 同款路径）：文件 -&gt; socket，数据不过用户态
try (FileChannel from = FileChannel.open(Paths.get("big.bin"), StandardOpenOption.READ);
     SocketChannel to = SocketChannel.open(new InetSocketAddress("10.0.0.2", 9000))) {
    long pos = 0;
    long size = from.size();
    while (pos &lt; size) {
        // 底层就是 sendfile(2)；一次调用可能只传一部分，必须循环
        pos += from.transferTo(pos, size - pos, to);
    }
}</code></pre>

<p>如果是"文件 → 文件"或者想边读边处理（比如算个校验和），mmap 更合适：</p>

<pre><code class="language-java">// mmap 版：把文件映射进内存，读写映射区 = 读写文件
try (FileChannel ch = FileChannel.open(Paths.get("big.bin"), StandardOpenOption.READ)) {
    MappedByteBuffer buf = ch.map(FileChannel.MapMode.READ_ONLY, 0, ch.size());
    // MappedByteBuffer 是 DirectByteBuffer 的子类，数据天然不经过堆
    while (buf.hasRemaining()) {
        // ... 对 buf 做处理或写出到 channel ...
    }
}</code></pre>

<p>这里要解释一组 Java 特有的新名词：<strong>Heap Buffer</strong>（堆内缓冲，如 <code>byte[]</code> 包的 <code>HeapByteBuffer</strong>）和 <strong>Direct Buffer</strong>（堆外直接内存缓冲）。JVM 做 socket I/O 时，如果你递进来的是 Heap Buffer，JVM 会<strong>先把数据抄一份到堆外的 Direct Buffer</strong> 再交给内核——因为 GC 会挪动堆对象，内核拿着堆内地址做 I/O 等于拿着一张会变卦的地图。所以用 Heap Buffer 写 socket，你在无意间又加了一道 CPU 拷贝。<code>MappedByteBuffer</code> 直接是堆外映射，没有这个隐藏成本。</p>

<p>顺便对号入座：Nginx 的 <code>sendfile on;</code>（默认开）对应第二代；Tomcat 的 Connector 也有 <code>useSendfile</code>，默认开。你现在知道它们省的是哪两次拷贝了。</p>

<h1 id="section-7">七、常见坑与误区</h1>

<ol>
<li><p><strong>transferTo 的返回值不等于请求值。</strong>它返回"实际传输的字节数"，内核单次能传多少受实现限制（跨平台兼容起见单次别超 2GB），所以大文件必须像上面那样 while 循环。写一次就当传完了，是这份 API 最经典的误用。</p></li>
<li><p><strong>Heap Buffer 的"伪零拷贝"。</strong>如上节所说，堆内 buffer 进 socket 前会被 JVM 悄悄拷到堆外。想让 transferTo/mmap 的收益落袋，路径上别掺 <code>byte[]</code>。</p></li>
<li><p><strong>TLS 场景 sendfile 直接失效。</strong>加密必须先进用户态过一遍密码学，数据在内核里"裸奔"的 sendfile 没法用——所以 Nginx/Tomcat 在 SSL 下会自动回退到 read+write，不是 bug 是物理规律。想让 HTTPS 也吃零拷贝，得看 <strong>kTLS</strong>（Kernel TLS：把 TLS 记录层的加解密下沉到内核，密钥交给内核后 sendfile 就能继续用，Nginx 1.21.4+、OpenSSL 3.x 已支持）。</p></li>
<li><p><strong>sendfile 的输入不能是 socket。</strong>它要求 in_fd 是"支持 mmap 语义"的文件；想在两个 socket 之间转发（典型如 TCP 代理），sendfile 用不了，该用的是 <strong>splice</strong>（Linux 2.6.17 引入的管道搬运系统调用，思路类似：借助内核管道在两个 fd 之间倒数据，不进用户态）。另外老内核（&lt;2.6.33）还要求输出端必须是 socket。</p></li>
<li><p><strong>mmap 适合大文件，小文件别凑热闹。</strong>映射本身有成本：缺页中断（第一次访问映射页时的陷阱）、TLB 压力、地址空间管理。传输一个 4KB 的小图，mmap 的固定开销可能比 4 次拷贝还贵。RocketMQ 默认用 mmap、Kafka 用 sendfile，都是按自己消息粒度权衡过的结果，别无脑对齐。</p></li>
<li><p><strong>mmap 的进程杀手：SIGBUS。</strong>文件映射进内存后如果被别人 truncate 缩短了，进程一碰那块"悬空"的映射，内核直接发 SIGBUS 把进程带走，连 try-catch 都拦不住（这是信号不是异常）。多进程共享文件 + mmap 的场景，裁剪文件前先想清楚谁还映射着它。</p></li>
<li><p><strong>压测忘了预热 Page Cache。</strong>本次实验 stream 模式第一轮 93 MB/s、第三轮 3.1 GB/s，差 30 倍——差的就是缓存。做 I/O 基准测试，先空跑几轮把 Page Cache 喂饱，或者明确声明你在测"冷读"。</p></li>
<li><p><strong>loopback 数据别外推。</strong>回环测试看不到真实网卡 DMA 的收益与瓶颈（带宽上限、中断、软中断分布），线上容量规划请用真实链路复测。</p></li>
</ol>

<h1 id="section-8">八、总结</h1>

<ul>
<li>"零拷贝"的准确口径：<strong>砍的是 Page Cache 和用户态之间的 CPU 拷贝</strong>，DMA 搬运省不掉；Kafka/Nginx 的 sendfile 属于"1 次 CPU 拷贝"或"DMA gather 后 0 次"。</li>
<li>传统 read+write 传 256MB 要 8192 次数据面系统调用（实测），sendfile 只要 2 次——这就是 4 次上下文切换对 2 次的本质差距。</li>
<li>loopback 实测（2C 云机、热缓存）：P50 延迟 86.1ms → 60.2ms（-30%），吞吐 3.12 → 4.47 GB/s（1.43 倍）。真实网卡下收益更大。</li>
<li>Java 落地：<code>FileChannel.transferTo()</code> = sendfile（Kafka 在用），<code>FileChannel.map()</code> = mmap（RocketMQ 在用）；注意 Heap Buffer 的隐藏拷贝。</li>
<li>三道红线：TLS 下 sendfile 失效（除非 kTLS）；socket→socket 转发用 splice；mmap 当心 SIGBUS 和小文件不划算。</li>
<li>实验方法论彩蛋：压测先预热 Page Cache，否则你会把"磁盘冷读"当成"服务性能"。</li>
</ul>

<h1 id="section-9">参考资料</h1>

<ol>
<li>Linux man-pages：<em>sendfile(2)</em> — <a href="https://man7.org/linux/man-pages/man2/sendfile.2.html">https://man7.org/linux/man-pages/man2/sendfile.2.html</a></li>
<li>Linux man-pages：<em>mmap(2)</em> — <a href="https://man7.org/linux/man-pages/man2/mmap.2.html">https://man7.org/linux/man-pages/man2/mmap.2.html</a></li>
<li>Java Platform SE：<em>FileChannel#transferTo</em> Javadoc — <a href="https://docs.oracle.com/javase/8/docs/api/java/nio/channels/FileChannel.html">https://docs.oracle.com/javase/8/docs/api/java/nio/channels/FileChannel.html</a></li>
<li>M. Tim Jones, <em>Zero copy I: user-mode perspective</em>, IBM developerWorks — 讲零拷贝绕不开的经典老文</li>
<li>Nginx 官方文档：<em>ngx_http_core_module 的 sendfile 指令</em> — <a href="https://nginx.org/en/docs/http/ngx_http_core_module.html#sendfile">https://nginx.org/en/docs/http/ngx_http_core_module.html#sendfile</a></li>
<li>Jay Kreps, Neha Narkhede, Jun Rao, <em>Kafka: a Distributed Messaging System for Log Processing</em> (NetDB 2011) — Kafka 设计论文，明确阐述了 sendfile 零拷贝路径</li>
<li>Python 官方文档：<em>socket.sendfile()</em> — <a href="https://docs.python.org/3/library/socket.html#socket.sendfile">https://docs.python.org/3/library/socket.html#socket.sendfile</a>（本文实验的演示实现）</li>
</ol>
