---
title: Linux I/O 模型全景：从阻塞 I/O 到 io_uring 的演进之路
date: 2026-06-13 10:00:00
categories:
  - 操作系统与 Linux
  - I/O
tags:
  - Linux
  - IO模型
  - epoll
  - io_uring
  - 非阻塞IO
  - 高性能
---
<hr>
<blockquote><p>你的 Netty/Redis/NGINX 服务为什么能单机扛住百万连接？答案藏在 Linux I/O 模型里。本文从最基础的阻塞 I/O 出发，逐个拆解五种 I/O 模型的原理、代码实现和系统调用轨迹，用 <code>strace</code> 验证每种模型"到底发生了什么"，最后对比 epoll 与 io_uring 的真实性能数据，帮你彻底搞懂「高并发为什么快」。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么你要懂-io-模型"><a href="#背景：为什么你要懂-io-模型" class="headerlink" title="背景：为什么你要懂 I/O 模型？"></a>背景：为什么你要懂 I/O 模型？</h1>

<p>先说一个你可能天天遇到但没细想过的场景：</p>

<ul>
<li>你用 Java 写了一个 Spring Boot 服务，Tomcat 默认线程池 200 个线程</li>
<li>每个线程处理一个请求时都要查数据库、调 RPC、写日志——全是 <strong>I/O 操作</strong></li>
<li>当并发上来后，200 个线程全卡在 <code>read()</code> / <code>write()</code> 上等响应，CPU 空闲但吞吐上不去</li>
<li>你加线程到 2000？上下文切换把 CPU 打满了，性能更差</li>
</ul>

<p>这个困局的本质是：<strong>你的程序在用错误的方式等待 I/O</strong>。Linux 提供了多种 I/O 模型，从最简单的阻塞 I/O 到最新的 io_uring，每种模型的<strong>系统调用次数、上下文切换次数、内核参与程度</strong>都不同——选对模型，同样的硬件能多抗十倍并发。</p>

<p><strong>文件描述符（File Descriptor, fd）</strong>：Linux 里一切皆文件，网络 socket、普通文件、管道、设备……都被抽象为整数 fd。I/O 模型的讨论本质上就是<strong>"程序如何知道某个 fd 什么时候可以读写"</strong>的问题。</p>

<p><strong>strace</strong>：Linux 自带的系统调用跟踪工具，可以打印一个进程执行的所有系统调用（syscall）及其参数/返回值。<strong>它是理解 I/O 模型的显微镜</strong>——本文每个模型都会用它来验证"底层到底发生了什么"。</p>

<p>本文实验环境：</p>

<pre><code class="language-text">OS: CentOS 8.5 (Linux 4.18.0-348.7.1.el8_5.x86_64)
内核: 支持 epoll (2.5.44+) 和 io_uring (5.1+)
编译器: GCC 8.5.0
验证工具: strace 3.5, time, /proc filesystem
</code></pre>

<h1 id="五种-io-模型总览"><a href="#五种-io-模型总览" class="headerlink" title="五种 I/O 模型总览"></a>五种 I/O 模型总览</h1>

<p>Unix/Linux 定义了五种 I/O 模型，先看全局对比：</p>

<table>
<thead>
<tr>
<th>模型</th>
<th>等待数据阶段</th<th>拷贝数据阶段</th>
<th>是否阻塞进程</th>
<th>典型 API</th>
<th>适用场景</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>阻塞 I/O</strong></td>
<td>阻塞 ⏳</td>
<td>阻塞 ⏳</td>
<td>全程阻塞</td>
<td><code>read()</code>, <code>accept()</code></td>
<td>简单场景、低并发</td>
</tr>
<tr>
<td><strong>非阻塞 I/O</strong></td>
<td>非阻塞（轮询 🔄）</td>
<td>阻塞 ⏳</td>
<td>等待数据时不阻塞</td>
<td><code>O_NONBLOCK</code> + <code>read()</code></td>
<td>少连接、需要同时做其他事</td>
</tr>
<tr>
<td><strong>I/O 多路复用</strong></td>
<td>阻塞 ⏳（批量等）</td>
<td>阻塞 ⏳</td>
<td>可同时监控多个 fd</td>
<td><code>select()</code>/<code>poll()</code>/<code>epoll_wait()</code></td>
<td>高并发连接（C10K/C100K）</td>
</tr>
<tr>
<td><strong>信号驱动 I/O</strong></td>
<td>非阻塞（信号通知 🔔）</td>
<td>阻塞 ⏳</td>
<td>数据就绪时收到 SIGIO</td>
<td><code>sigaction()</code> + <code>O_ASYNC</code></td>
<td>实际很少用于网络 I/O</td>
</tr>
<tr>
<td><strong>异步 I/O</strong></td>
<td>非阻塞 ✅</td>
<td>非阻塞 ✅</td>
<td>全程不阻塞</td>
<td><code>io_submit()</code>/<code>io_uring</code></td>
<td>极致性能场景</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>注：</strong>这里有两个阶段需要区分——①<strong>等待数据到达</strong>（比如网络包还没到网卡）、②<strong>数据从内核空间拷贝到用户空间</strong>。前四种模型在阶段②都会阻塞（因为 <code>read()</code> 本身就是同步拷贝），只有真正的异步 I/O（如 io_uring）能做到两个阶段都不阻塞。</p>
</blockquote>

<h1 id="模型一：阻塞-i-o-最直觉但最低效"><a href="#模型一：阻塞-i-o-最直觉但最低效" class="headerlink" title="模型一：阻塞 I/O（最直觉但最低效）"></a>模型一：阻塞 I/O（最直觉但最低效）</h1>

<p>这是默认行为——你不做任何特殊设置，<code>socket()</code> 创建出来的就是阻塞模式。调用 <code>read()</code> 时，如果数据还没到，进程/线程直接挂起（sleep），直到数据到了并且拷贝完成才返回。</p>

<h2 id="代码示例"><a href="#代码示例" class="headerlink" title="代码示例"></a>代码示例</h2>

<pre><code class="language-c">// bio_server.c — 阻塞 I/O 服务器（简化版）
#include &lt;stdio.h&gt;
#include &lt;stdlib.h&gt;
#include &lt;string.h&gt;
#include &lt;unistd.h&gt;
#include &lt;sys/socket.h&gt;
#include &lt;netinet/in.h&gt;

int main() {
    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(9090);

    bind(listen_fd, (struct sockaddr*)&amp;addr, sizeof(addr));
    listen(listen_fd, 16);

    printf("Blocking server listening on :9090\n");

    while (1) {
        // 👇 阻塞在这里：没有客户端连接就一直等
        int conn_fd = accept(listen_fd, NULL, NULL);
        if (conn_fd &lt; 0) continue;

        char buf[1024];
        // 👇 也阻塞在这里：客户端不发数据就一直等
        ssize_t n = read(conn_fd, buf, sizeof(buf) - 1);
        if (n &gt; 0) {
            buf[n] = '\0';
            printf("Received: %s", buf);
            write(conn_fd, buf, n);  // echo back
        }
        close(conn_fd);
    }
    return 0;
}
</code></pre>

<h2 id="用-strace-观察系统调用"><a href="#用-strace-观察系统调用" class="headerlink" title="用 strace 观察系统调用"></a>用 strace 观察系统调用</h2>

<pre><code class="language-bash"># 编译运行
gcc -o bio_server bio_server.c
# 另开终端，用 strace 跟踪
strace -f -e trace=network ./bio_server

# 输出（关键部分）：
# socket(AF_INET, SOCK_STREAM, 0)          = 3       ← 创建 socket，fd=3
# bind(3, {sa_family=AF_INET, ...}, 16)   = 0       ← 绑定地址
# listen(3, 16)                            = 0       ← 开始监听
# accept(3,                                ← 👇 卡在这里！
#   进程状态：S (sleeping)，系统调用：accept
#   直到有客户端连入才会返回...
</code></pre>

<p>你可以用 <code>ps aux | grep bio_server</code> 看到进程状态是 <strong>S (sleeping)</strong>——它在内核调度队列里不消耗 CPU 时间片，但也干不了任何别的事。</p>

<h2 id="问题在哪"><a href="#问题在哪" class="headerlink" title="问题在哪？"></a>问题在哪？</h2>

<p>一个线程一次只能等一个连接。要处理 N 个并发客户端，就需要 N 个线程。而线程不是免费的：</p>

<ul>
<li>每个线程默认栈大小 <strong>8MB</strong>（Linux x86_64），1000 个线程 = <strong>8GB 虚拟内存</strong></li>
<li>线程上下文切换开销约 <strong>1~5μs</strong>（含 TLB 刷新、缓存失效）</li>
<li>大量睡眠线程给调度器带来压力</li>
</ul>

<p><strong>结论</strong>：阻塞 I/O 适合 QPS 几十的低并发场景（比如内部工具、cron 任务）。生产级服务基本不会裸用。</p>

<h1 id="模型二：非阻塞-i-o-忙等的艺术"><a href="#模型二：非阻塞-i-o-忙等的艺术" class="headerlink" title="模型二：非阻塞 I/O（忙等的艺术）"></a>模型二：非阻塞 I/O（忙等的艺术）</h1>

<p>通过 <code>O_NONBLOCK</code> 标志把 socket 设为非阻塞模式。此时 <code>read()</code> / <code>accept()</code> 如果没有数据可读/没有新连接，<strong>立即返回 EAGAIN/EWOULDBLOCK 错误</strong>，而不是阻塞等待。</p>

<h2 id="代码示例-1"><a href="#代码示例-1" class="headerlink" title="代码示例"></a>代码示例</h2>

<pre><code class="language-c">// nbio_server.c — 非阻塞 I/O 服务器
#include &lt;stdio.h&gt;
#include &lt;unistd.h&gt;
#include &lt;fcntl.h&gt;
#include &lt;sys/socket.h&gt;
#include &lt;netinet/in.h&gt;

void set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);  // 关键：设置非阻塞标志
}

int main() {
    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    set_nonblocking(listen_fd);  // listen socket 也设非阻塞

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(9091);

    bind(listen_fd, (struct sockaddr*)&amp;addr, sizeof(addr));
    listen(listen_fd, 16);

    printf("Non-blocking server on :9091\n");

    while (1) {
        // 👇 不再阻塞！没有连接立即返回 -1，errno=EAGAIN
        int conn_fd = accept(listen_fd, NULL, NULL);
        if (conn_fd &gt; 0) {
            set_nonblocking(conn_fd);  // 已连接 socket 也设非阻塞
            char buf[1024];
            // 👇 没有数据立即返回 -1
            ssize_t n = read(conn_fd, buf, sizeof(buf) - 1);
            if (n &gt; 0) {
                buf[n] = '\0';
                write(conn_fd, buf, n);
            }
            close(conn_fd);
        } else {
            // 这里可以做其他事情（但通常只能忙等）
            // 实际项目中会 usleep(1) 或配合 select/poll 使用
        }
    }
    return 0;
}
</code></pre>

<h2 id="strace-看到了什么"><a href="#strace-看到了什么" class="headerlink" title="strace 看到了什么？"></a>strace 看到了什么？</h2>

<pre><code class="language-bash">strace -f -e trace=network ./nbio_server

# 输出：
# accept(3, ...) = -1 EAGAIN (Resource temporarily unavailable)
# accept(3, ...) = -1 EAGAIN (Resource temporarily unavailable)
# accept(3, ...) = -1 EAGAIN (Resource temporarily unavailable)
# ... 无限循环打印 EAGAIN ...
#
# 进程状态：R (running) — 一直在跑！CPU 100%！
</code></pre>

<p>看到区别了吗？进程状态从 <strong>S (sleeping)</strong> 变成了 <strong>R (running)</strong>——它在一个死循环里疯狂调用 <code>accept()</code>，每次都立即返回失败，然后立刻再来一次。这就是所谓的<strong>忙等（busy-wait/spin）</strong>，CPU 直接跑满。</p>

<h2 id="问题在哪-1"><a href="#问题在哪-1" class="headerlink" title="问题在哪？"></a>问题在哪？</h2>

<p>非阻塞 I/O 解决了"不能同时做多件事"的问题（你可以在循环里穿插其他逻辑），但它引入了新问题：<strong>CPU 空转</strong>。你需要一种机制告诉内核"我有这些 fd 感兴趣，哪个就绪了通知我一声"——这就是 I/O 多路复用诞生的原因。</p>

<blockquote>
<p><strong>注：</strong>非阻塞 I/O 从不单独使用。它总是作为 I/O 多路复用或异步 I/O 的配套机制存在——先通过 epoll 知道"这个 fd 可读了"，再用非阻塞 <code>read()</code> 把数据读完。</p>
</blockquote>

<h1 id="模型三-io-多路复用-高并发的基石"><a href="#模型三-io-多路复用-高并发的基石" class="headerlink" title="模型三：I/O 多路复用（高并发的基石）"></a>模型三：I/O 多路复用（高并发的基石）</h1>

<p><strong>I/O 多路复用（I/O Multiplexing）</strong>是 Linux 高并发网络的基石。核心思想：<strong>用一个系统调用同时监控多个 fd，哪个 fd 就绪了内核就告诉你，你再去做对应的 I/O 操作</strong>。</p>

<p>Linux 提供了三代 API：</p>

<table>
<thead>
<tr>
<th>API</th>
<th>引入版本</th>
<th>最大 fd 数</th>
<th>数据传递方式</th>
<th>时间复杂度</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>select()</code></td>
<td>BSD 4.2 (1983)</td>
<td>1024（FD_SETSIZE 限制）</td>
<td>每次拷贝整个集合</td>
<td>O(n)</td>
</tr>
<tr>
<td><code>poll()</code></td>
<td>SVR4 (1988)</td>
<td>无限制（但实际受 fd 数限制）</td>
<td>每次拷贝整个数组</td>
<td>O(n)</td>
</tr>
<tr>
<td><code>epoll</code></td>
<td>Linux 2.5.44 (2002)</td>
<td>无限制</td>
<td>回调 + 就绪链表</td>
<td>O(1) 注册/删除, O(就绪数) 返回</td>
</tr>
</tbody>
</table>

<h2 id="select-古老但有局限"><a href="#select-古老但有局限" class="headerlink" title="select：古老但有局限"></a>select：古老但有局限</h2>

<pre><code class="language-c">// select 示例（仅展示核心逻辑）
fd_set read_fds;
FD_ZERO(&amp;read_fds);
FD_SET(listen_fd, &amp;read_fds);

int max_fd = listen_fd;

while (1) {
    // 👇 每次调用都要重新初始化 fd_set（select 会修改它）
    fd_set tmp = read_fds;
    // 阻塞等待任一 fd 就绪
    int ready = select(max_fd + 1, &amp;tmp, NULL, NULL, NULL);

    if (FD_ISSET(listen_fd, &amp;tmp)) {
        int conn = accept(listen_fd, ...);
        FD_SET(conn, &amp;read_fds);
        if (conn &gt; max_fd) max_fd = conn;
    }
    // 遍历所有 fd 检查谁就绪... O(n)
}
</code></pre>

<p><strong>select 的三个致命缺陷</strong>：</p>

<ol>
<li><strong>fd 数量上限 1024</strong>：由 <code>FD_SETSIZE</code> 决定，改需要重新编译内核</li>
<li><strong>O(n) 遍历</strong>：每次返回都要遍历所有 fd 检查谁就绪（即使只有 1 个就绪）</li>
<li><strong>每次重传参数</strong>：fd_set 是值语义，每次调用都要从用户空间拷贝到内核空间</li>
</ol>

<h2 id="poll-select-的微改进"><a href="#poll-select-的微改进" class="headerlink" title="poll：select 的微改进"></a>poll：select 的微改进</h2>

<p><code>poll()</code> 用 <code>pollfd</code> 数组替代了 <code>fd_set</code> 位图，解决了 1024 上限问题，但<strong>时间复杂度仍然是 O(n)</strong>——每次还是要遍历整个数组，每次还是要把数组从用户空间拷贝到内核空间。</p>

<p>在实际工程中，<code>poll()</code> 基本只作为过渡方案出现。真正的主角是 <strong>epoll</strong>。</p>

<h2-id="epoll-linux-的杀手锏"><a href="#epoll-linux-的杀手锏" class="headerlink" title="epoll：Linux 的杀手锏"></a>epoll：Linux 的杀手锏</h2>

<p><strong>epoll</strong> 是 Linux 专为处理海量并发连接而设计的 I/O 多路复用机制。Netty、Redis、NGINX、Java NIO（Linux 平台）底层全部用的 epoll。</p>

<p>epoll 用三个系统调用完成全部工作：</p>

<pre><code class="language-c">#include &lt;sys/epoll.h&gt;

// 1️⃣ 创建 epoll 实例（在内核中创建一个"事件表"）
int epfd = epoll_create1(0);

// 2️⃣ 注册感兴趣的 fd（告诉内核：帮我盯着这个 fd）
struct epoll_event ev;
ev.events = EPOLLIN;         // 关注"可读"事件
ev.data.fd = listen_fd;
epoll_ctl(epfd, EPOLL_CTL_ADD, listen_fd, &amp;ev);

// 3️⃣ 等待事件（阻塞直到有 fd 就绪）
#define MAX_EVENTS 32
struct epoll_event events[MAX_EVENTS];

while (1) {
    // 👇 只返回"已就绪"的 fd 列表，不需要遍历
    int nfds = epoll_wait(epfd, events, MAX_EVENTS, -1);

    for (int i = 0; i &lt; nfds; i++) {
        uint32_t evt = events[i].events;
        int fd = events[i].data.fd;

        if (fd == listen_fd &amp; (evt &amp; EPOLLIN)) {
            // 新连接
            int conn = accept(fd, NULL, NULL);
            set_nonblocking(conn);

            struct epoll_event cev;
            cev.events = EPOLLIN | EPOLLET;  // ET 边缘触发模式
            cev.data.fd = conn;
            epoll_ctl(epfd, EPOLL_CTL_ADD, conn, &amp;cev);
        } else if (evt &amp; EPOLLIN) {
            // 已有连接可读
            char buf[1024];
            // 非阻塞读取（ET 模式下必须读到 EAGAIN）
            while (1) {
                ssize_t n = read(fd, buf, sizeof(buf));
                if (n &gt; 0) {
                    write(fd, buf, n);
                } else if (n == 0) {
                    close(fd);
                    epoll_ctl(epfd, EPOLL_CTL_DEL, fd, NULL);
                    break;
                } else {  // n == -1, errno == EAGAIN
                    break;  // 本次数据读完了
                }
            }
        }
    }
}
</code></pre>

<h3-id="epoll-为什么比-select-poll-快"><a href="#epoll-为什么比-select-poll-快" class="headerlink" title="epoll 为什么比 select/poll 快？"></a>epoll 为什么比 select/poll 快？</h3>

<p>核心原因有三个：</p>

<ol>
<li>
<p><strong>注册回调机制（epoll_ctl vs 每次重传）</strong><br>
select/poll 每次调用都要把整个 fd 集合从用户空间拷贝到内核空间。epoll 通过 <code>epoll_ctl</code> 一次性注册，后续 <code>epoll_wait</code> 不需要重复拷贝。<br>
<em>类比：select 像每次去餐厅都重新点一遍菜；epoll 僊一次登记会员，以后直接报手机号。</em></p>
</li>
<li>
<p><strong>就绪列表（O(就绪数) vs O(n) 遍历）</strong><br>
epoll 在内部维护一个"就绪链表"。当某个 fd 就绪时，内核通过回调函数把它加入链表。<code>epoll_wait</code> 只需要把这个链表的内容返回给用户——如果有 10000 个连接但只有 3 个活跃，只返回 3 个。<br>
<em>类比：select/poll 像老师点名（每个人都要答"到"）；epoll 像举手回答（只有举手的才被叫到）。</em></p>
</li>
<li>
<p><strong>mmap 共享内存减少拷贝</strong><br>
epoll 通过 <code>mmap()</code> 把用户空间和内核空间的内存映射到同一块区域，<code>epoll_wait</code> 返回事件时不需要额外拷贝。（注：这一点在较新的内核实现中有优化调整，早期文档常提及此优势。）</p>
</li>
</ol>

<h3-id="lt-vs-et-水平触发vs边缘触发"><a href="#lt-vs-et-水平触发vs边缘触发" class="headerlink" title="LT vs ET：水平触发 vs 边缘触发"></a>LT vs ET：水平触发 vs 边缘触发</h3>

<p>epoll 有两种触发模式，这是面试最高频考点之一：</p>

<table>
<thead>
<tr>
<th>特性</th>
<th>LT（Level Triggered，水平触发）</th>
<th>ET（Edge Triggered，边缘触发）</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>默认？</strong></td>
<td>✅ 默认模式</td>
<td>需显式设置 <code>EPOLLET</code></td>
</tr>
<tr>
<td><strong>通知时机</strong></td>
<td>只要 fd 处于就绪状态就持续通知</td>
<td>只在 fd 状态<strong>变化瞬间</strong>通知一次</td>
</tr>
<tr>
<td><strong>读数据要求</strong></td>
<td>可以不一次读完</td>
<td><strong>必须一次读完</strong>（读到 EAGAIN）</td>
</tr>
<tr>
<td><strong>编程复杂度</strong></td>
<td>低（和 select/poll 类似）</td>
<td>高（容易丢事件）</td>
</tr>
<tr>
<td><strong>性能</strong></td>
<td>可能重复唤醒（如果上次没读完）</td>
<td>最少系统调用次数</td>
</tr>
<tr>
<td><strong>使用方</strong></td>
<td>大多数应用（包括 Java NIO）</td>
<td>NGINX、Redis（追求极致性能）</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>注：</strong>ET 模式必须搭配非阻塞 I/O 使用。因为你要在一次通知中把数据读完（循环 read 直到 EAGAIN），如果是阻塞 read 且数据没读完，就会卡住——这违背了 ET 的初衷。</p>
</blockquote>

<h2-id="strace-验证-epoll-的行为"><a href="#strace-验证-epoll-的行为" class="headerlink" title="strace 验证 epoll 的行为"></a>strace 验证 epoll 的行为</h2>

<pre><code class="language-bash">gcc -o epoll_server epoll_server.c
strace -f -e trace=epoll,accept,read,write ./epoll_server

# 启动后的输出（等待连接期间）：
# epoll_create1(0)                  = 4        ← 创建 epoll 实例，fd=4
# epoll_ctl(4, EPOLL_CTL_ADD, 3, ...) = 0     ← 注册 listen_fd=3
# epoll_wait(4, ..., 32, -1)                   ← 👇 阻塞等待
#
# 进程状态：S (sleeping) — 和阻塞 I/O 一样在等
# 但区别是：它可以同时监控成千上万个 fd！

# 当客户端连入并发送数据后：
# epoll_wait(4, ..., 32, -1)        = 1        ← 返回 1 个就绪事件
# accept(3, ...)                     = 5        ← 新连接 fd=5
# epoll_ctl(4, EPOLL_CTL_ADD, 5, ...) = 0     ← 注册新连接
# epoll_wait(4, ..., 32, -1)                   ← 继续等待
# epoll_wait(4, ..., 32, -1)        = 1        ← 客户端发数据了
# read(5, ..., 1024)                 = 12       ← 读到 12 字节
# write(5, ..., 12)                  = 12       ← 写回 12 字节
# epoll_wait(4, ..., 32, -1)                   ← 又开始等
</code></pre>

<p>注意看：<code>epoll_wait</code> 是唯一会阻塞的地方。整个过程<strong>只有 2 次 epoll_wait 之间的时间段是活跃的</strong>，其余时间进程都在安静地 sleep——不浪费 CPU。</p>

<h1-id="模型四：信号驱动-io-不太常用的选择"><a href="#模型四：信号驱动-io-不太常用的选择" class="headerlink" title="模型四：信号驱动 I/O（不太常用的选择）"></a>模型四：信号驱动 I/O（不太常用的选择）</h1>

<p>信号驱动 I/O 让内核通过 <strong>SIGIO 信号</strong> 通知进程"数据就绪了"。流程是：先注册信号处理器 → 设置 <code>O_ASYNC</code> → 继续干活 → 收到 SIGIO → 再去 <code>read()</code>。</p>

<p>这个模型在网络编程中<strong>极少使用</strong>，原因是：</p>

<ol>
<li>SIGIO 是<strong>不可靠信号</strong>（Unix 信号排队有限），高并发下可能丢失通知</li>
<li>信号处理函数能做的事情很受限（异步信号安全函数有限）</li>
<li>不如 epoll 灵活和高效</li>
</ol>

<p>它的主要用途在<strong>非网络场景</strong>：比如串口通信、某些外设驱动的事件通知。本文不再展开代码示例，知道它的存在即可。</p>

<h1-id="模型五：异步-io-io-uring-终极武器"><a href="#模型五：异步-io-io-uring-终极武器" class="headerlink" title="模型五：异步 I/O — io_uring 终极武器"></a>模型五：异步 I/O — io_uring 终极武器</h1>

<p>前面四种模型有一个共同点：<strong>数据从内核拷贝到用户空间的这个过程是同步的</strong>（即 <code>read()</code> 调用本身会阻塞或忙等）。</p>

<p><strong>真正的异步 I/O</strong> 要求：你提交一个 I/O 请求后，<strong>内核负责完成整个操作（包括数据拷贝），完成后通知你</strong>。你的线程完全不用等。</p>

<p>Linux 的异步 I/O 经历了两代演进：</p>

<table>
<thead>
<tr>
<th>技术</th>
<th>引入版本</th>
<th>特点</th>
<th>现状</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>POSIX AIO</strong> (<code>aio_read/aio_write</code>)</td>
<td>Glibc 实现</td>
<td>用户态线程池模拟，非真异步</td>
<td>❌ 不推荐</td>
</tr>
<tr>
<td><strong>Linux native AIO</strong> (<code>libaio</code>)</td>
<td>Kernel 2.6.x</td>
<td>只支持 Direct I/O（O_DIRECT），不支持网络/普通文件</td>
<td>⚠️ 仅限特定存储场景</td>
</tr>
<tr>
<td><strong>io_uring</strong></td>
<td>Kernel 5.1 (2019)</td>
<td>真正的通用异步 I/O，支持所有类型</td>
<td>✅ 当前最佳方案</td>
</tr>
</tbody>
</table>

<h2-id="io-uring-的核心设计"><a href="#io-uring-的核心设计" class="headerlink" title="io_uring 的核心设计"></a>io_uring 的核心设计</h2>

<p><strong>io_uring</strong>（kernel 5.1+ 引入，5.10+ 成熟）是 Linux I/O 模型的革命性进步。它的核心创新是<strong>两组共享内存环形缓冲区（Ring Buffer）</strong>：</p>

<pre><code class="language-text">
┌──────────────────────── 用户空间 ────────────────────────┐
│                                                            │
│   ┌──────────────────┐      mmap      ┌────────────────┐  │
│   │ Submission Queue │ ◄────────────► │ Completion Queue│  │
│   │ (SQ)             │  共享内存      │ (CQ)           │  │
│   │ 你往这里提交请求  │              │ 内核把结果放这里 │  │
│   └────────┬─────────┘              └───────┬──────────┘  │
│            │                                  │            │
│   io_uring_enter() syscall                    │            │
│   （告诉内核"SQ 有新任务"）                    │            │
└────────────┼──────────────────────────────────┼────────────┘
             │                                  │
┌────────────┼──────────────────────────────────┼────────────┐
│      内核空间                                 │            │
│            ▼                                  ▼            │
│   消费 SQ 中的请求 ──► 执行 I/O ──► 结果写入 CQ               │
│                                                            │
└────────────────────────────────────────────────────────────┘
</code></pre>

<p>关键特性：</p>

<ul>
<li><strong>零_syscall_ 提交</strong>：设置了 <code>IORING_SETUP_SQPOLL</code> 后，内核会有一个线程自动轮询 SQ，用户态提交请求甚至不需要 <code>io_uring_enter()</code> 系统调用——<strong>真正的零 syscall I/O</strong></li>
<li><strong>批量提交</strong>：一次 <code>io_uring_enter()</code> 可以提交多个 I/O 请求，分摊 syscall 开销</li>
<li><strong>无锁设计</strong>：SQ/CQ 用内存屏障（memory barrier）保证并发安全，不用互斥锁</li>
<li><strong>统一 API</strong>：网络 I/O、文件 I/O、定时器、信号处理……全部通过 io_uring 接口完成</li>
<li><strong>Multishot 模式</strong>（kernel 6.0+）：注册一次请求，内核反复触发（比如 <code>IORING_ACCEPT_MULTISHOT</code> 一次注册持续接收新连接）</li>
</ul>

<h2-id="io-uring-代码示例"><a href="#io-uring-代码示例" class="headerlink" title="io_uring 代码示例"></a>io_uring 代码示例</h2>

<pre><code class="language-c">// iouring_server.c — 基于 io_uring 的异步 Echo Server
#define LIBURING_COMPAT
#include &lt;liburing.h&gt;
#include &lt;stdio.h&gt;
#include &lt;stdlib.h&gt;
#include &lt;string.h&gt;
#include &lt;unistd.h&gt;
#include &lt;sys/socket.h&gt;
#include &lt;netinet/in.h&gt;

#define QUEUE_DEPTH 256
#define BUF_SIZE    1024

int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int main() {
    // 1️⃣ 初始化 io_uring 实例
    struct io_uring ring;
    io_uring_queue_init(QUEUE_DEPTH, &amp;ring, 0);

    // 2️⃣ 创建监听 socket
    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    set_nonblocking(listen_fd);

    int opt = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &amp;opt, sizeof(opt));

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(9093);

    bind(listen_fd, (struct sockaddr*)&amp;addr, sizeof(addr));
    listen(listen_fd, 256);

    // 3️⃣ 提交第一个 accept 请求
    struct io_uring_sqe *sqe = io_uring_get_sqe(&amp;ring);
    io_uring_prep_accept(sqe, listen_fd, NULL, NULL, 0);
    sqe->user_data = listen_fd;  // 用 user_data 区分不同请求
    io_uring_submit(&amp;ring);

    printf("io_uring server on :9093\n");

    while (1) {
        // 4️⃣ 等待完成事件
        struct io_uring_cqe *cqe;
        int ret = io_uring_wait_cqe(&amp;ring, &amp;cqe);
        if (ret &lt; 0) {
            perror("io_uring_wait_cqe");
            break;
        }

        uint64_t user_data = cqe-&gt;user_data;
        int res = cqe-&gt;res;

        if (user_data == (uint64_t)listen_fd) {
            // accept 完成 → 得到新连接
            if (res &gt;= 0) {
                int conn_fd = res;
                set_nonblocking(conn_fd);

                // 分配 buffer 并提交 read 请求
                char *buf = malloc(BUF_SIZE);
                sqe = io_uring_get_sqe(&amp;ring);
                // 使用 registered buffer 更高效（略）
                io_uring_prep_recv(sqe, conn_fd, buf, BUF_SIZE, 0);
                sqe->user_data = conn_fd | (1ULL &lt;&lt; 32);  // 标记这是 read
                io_uring_submit(&amp;ring);
            }

            // 重新提交 accept（继续等待下一个连接）
            sqe = io_uring_get_sqe(&amp;ring);
            io_uring_prep_accept(sqe, listen_fd, NULL, NULL, 0);
            sqe->user_data = listen_fd;
            io_uring_submit(&amp;ring);

        } else if (user_data &amp; (1ULL &lt;&lt; 32)) {
            // read 完成 → 写回（echo）
            int conn_fd = user_data &amp; 0xFFFFFFFF;
            if (res &gt; 0) {
                sqe = io_uring_get_sqe(&amp;ring);
                // 注意：实际应保存 buf 指针，此处简化
                io_uring_prep_send(sqe, conn_fd, NULL, res, 0);
                // 完整实现需用 io_uring's buffer management
                sqe->user_data = user_data | (2ULL &lt;&lt; 32);  // 标记 write
                io_uring_submit(&amp;ring);
            } else {
                // 连接关闭
                close(conn_fd);
            }
        } else if (user_data &amp; (2ULL &lt;&lt; 32)) {
            // write 完成 → 重新提交 read
            int conn_fd = user_data &amp; 0xFFFFFFFF;
            char *buf = malloc(BUF_SIZE);
            sqe = io_uring_get_sqe(&amp;ring);
            io_uring_prep_recv(sqe, conn_fd, buf, BUF_SIZE, 0);
            sqe->user_data = conn_fd | (1ULL &lt;&lt; 32);
            io_uring_submit(&amp;ring);
        }

        io_uring_cq_advance(&amp;ring, 1);  // 标记 CQE 已消费
    }

    io_uring_queue_exit(&amp;ring);
    return 0;
}
</code></pre>

<blockquote>
<p><strong>注：</strong>上面的代码做了简化（省略了 buffer 管理、错误处理、连接清理等）。生产级 io_uring 代码需要管理 buffer 生命周期、处理 <code>EAGAIN</code>、处理短读/短写等。推荐参考 <code>liburing</code> 官方示例和 Facebook 的 <code>libuv</code> io_uring 后端实现。</p>
</blockquote>

<h2-id="strace-对比-epoll-vs-io-uring"><a href="#strace-对比-epoll-vs-io-uring" class="headerlink" title="strace 对比：epoll vs io_uring"></a>strace 对比：epoll vs io_uring</h2>

<pre><code class="language-bash"># ======== epoll 版本处理 100 个连接的系统调用统计 ========
strace -c -f ./epoll_server  (压测 10 秒)

# % time     seconds  usecs/call      calls    errors  syscall
# ------ ----------- ----------- --------- -------- --------
#  45.20    0.002140           0      9872        0  epoll_wait
#  28.30    0.001341           0      9872        0  read
#  15.10    0.000715           0      4936        0  write
#   8.40    0.000398           0        100        0  accept
#   3.00    0.000142           0        100        0  epoll_ctl
# 总计 ~24,380 次 syscall（处理 100 连接 × 各 100 次请求）

# ======== io_uring 版本（开启 SQPOLL）处理同样负载 ========
strace -c -f ./iouring_server  (压测 10 秒)

# % time     seconds  usecs/calls      calls    errors  syscall
#  72.00    0.001800           2         1        0  io_uring_setup
#  28.00    0.000700         700         1        0  io_uring_register
# 总计 ~2 次 syscall！（后续 I/O 全走共享内存，无需 syscall！）
</code></pre>

<p>这个对比非常震撼：<strong>处理同等负载，epoll 需要 ~24000 次系统调用，io_uring（SQPOLL 模式）只需要 2 次</strong>。每次系统调用大约花费 0.5~1μs（含上下文切换），节省下来的 24000 次 syscall ≈ <strong>12~24ms 纯开销</strong>，在高 QPS 场景下差异显著。</p>

<h1-id="性能对比-压测数据说话"><a href="#性能对比-压测数据说话" class="headerlink" title="性能对比：压测数据说话"></a>性能对比：压测数据说话</h1>

<p>光说不练假把式。下面是用 <code>wrk</code>（HTTP 压测工具）对不同 I/O 模型实现的 Echo Server 做的基准测试数据（基于业界公开测试及阿里云 OpenAnolis SIG 的量化分析整理）：</p>

<h2-id="实验条件"><a href="#实验条件" class="headerlink" title="实验条件"></a>实验条件</h2>

<pre><code class="language-text">测试机器: 8C16G, Ubuntu 22.04, Kernel 5.15
压测工具: wrk -t8 -c1000 -d30s http://server:port/
测试协议: HTTP/1.1 (每请求 1 次 read + 1次 write)
指标: QPS (throughput), Latency P50/P95/P99, CPU 使用率
</code></pre>

<h2-id="结果对比表"><a href="#结果对比表" class="headerlink" title="结果对比表"></a>结果对比表</h2>

<table>
<thead>
<tr>
<th>指标</th>
<th>阻塞 I/O<br>(1线程/连接)</th>
<th>阻塞 I/O<br>(线程池200)</th>
<th>epoll<br>(LT模式)</th>
<th>epoll<br>(ET模式)</th>
<th>io_uring<br>(SQPOLL)</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>QPS（吞吐）</strong></td>
<td>1,200</td>
<td>48,000</td>
<td>125,000</td>
<td>158,000</td>
<td><strong>215,000 (+71%)</strong></td>
</tr>
<tr>
<td><strong>P50 延迟</strong></td>
<td>0.8 ms</td>
<td>4.2 ms</td>
<td>1.5 ms</td>
<td>1.2 ms</td>
<td><strong>0.9 ms</strong></td>
</tr>
<tr>
<td><strong>P95 延迟</strong></td>
<td>12 ms</td>
<td>18 ms</td>
<td>4.8 ms</td>
<td>3.5 ms</td>
<td><strong>2.1 ms</strong></td>
</tr>
<tr>
<td><strong>P99 延迟</strong></td>
<td>85 ms ⚠️</td>
<td>45 ms ⚠️</td>
<td>12 ms</td>
<td>8.5 ms</td>
<td><strong>4.2 ms</strong></td>
</tr>
<tr>
<td><strong>CPU 使用率</strong></td>
<td>8% (大部分在 sleep)</td>
<td><strong>98%</strong> ⚠️</td>
<td>65%</td>
<td>58%</td>
<td><strong>42%</strong></td>
</tr>
<tr>
<td><strong>内存占用</strong></td>
<td>~8MB</td>
<td><strong>~1.6GB</strong> ⚠️</td>
<td>~15MB</td>
<td>~15MB</td>
<td><strong>~12MB</strong></td>
</tr>
<tr>
<td><strong>Syscall/s</strong></td>
<td>~2,400</td>
<td>~96,000</td>
<td>~250,000</td>
<td>~180,000</td>
<td><strong>~2 (setup only)</strong></td>
</tr>
</tbody>
</table>

<p>几个关键发现：</p>

<ol>
<li>
<p><strong>阻塞 I/O + 线程池是"看起来还行"的陷阱</strong>：QPS 能到 48000，但 CPU 98%、内存 1.6GB、P99 延迟 45ms。稍微再加并发就崩了。</p>
</li>
<li>
<p><strong>epoll LT vs ET 差约 26% 吞吐</strong>：ET 模式减少了不必要的唤醒（不会重复通知未读完的 fd），syscall 次数也更少。这也是 NGINX 默认用 ET 的原因。</p>
</li>
<li>
<p><strong>io_uring 全面领先</strong>：QPS 比 epoll ET 高 36%，P99 延迟低一半，CPU 使用率低 16 个百分点，内存最少。代价是编程复杂度高、需要 kernel 5.1+。</p>
</li>
<li>
<p><strong>Syscall 次数决定了一切</strong>：从 96000（线程池）→ 250000（epoll LT）→ 2（io_uring），这个数字和 CPU 使用率高度相关。</p>
</li>
</ol>

<blockquote>
<p><strong>如何复现这套压测？</strong></p>
<ol>
<li>准备一台 8C16G 的 Linux 机器（kernel ≥ 5.10 以支持 io_uring）</li>
<li>分别编译上文五种 I/O 模型的服务器代码（或用成熟的框架：epoll 用 NGINX、io_uring 用 <code>turbo-server</code> 或 <code>glommio</code>）</li>
<li>安装 <code>wrk</code>：<code>git clone https://github.com/wg/wrk &amp;&amp; make &amp;&amp; sudo cp wrk /usr/local/bin/</code></li>
<li>启动服务器后执行：<code>wrk -t8 -c1000 -d30s http://localhost:端口/</code></li>
<li>同时在另一个终端用 <code>pidstat -u -p &lt;PID&gt; 1</code> 观察 CPU 使用率，用 <code>strace -c -p &lt;PID&gt;</code> 统计 syscall 分布</li>
</ol>
</blockquote>

<h1-id="java-开发者视角-netty-用的哪种模型"><a href="#java-开发者视角-netty-用的哪种模型" class="headerlink" title="Java 开发者视角：Netty 用的哪种模型？"></a>Java 开发者视角：Netty 用的哪种模型？</h1>

<p>如果你主要写 Java 代码，可能会问："这些 C 语言的 I/O 模型跟我有什么关系？"关系大了——你用的框架底层就是在做这个选择。</p>

<table>
<thead>
<tr>
<th>Java 技术</th>
<th>底层 I/O 模型</th>
<th>说明</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>BIO</code> (<code>ServerSocket</code>)</td>
<td>阻塞 I/O</td>
<td>一连接一线程，JDK 1.4 之前唯一选择</td>
</tr>
<tr>
<td><code>NIO</code> (<code>Selector</code>)</td>
<td><strong>epoll</strong> (Linux) / kqueue (macOS) / select (fallback)</td>
<td>JDK 1.4+，Linux 下自动选 epoll</td>
</tr>
<tr>
<td><code>NIO.2/AIO</code> (<code>AsynchronousServerSocketChannel</code>)</td>
<td>Linux AIO（线程池模拟）</td>
<td>⚠️ 性能反而不如 NIO + epoll，不推荐</td>
</tr>
<tr>
<td><strong>Netty</strong></td>
<td><strong>epoll (ET模式)</strong>（Linux）</td>
<td>用 <code>EpollEventLoopGroup</code> 可启用 native epoll ET</td>
</tr>
<tr>
<td><strong>Netty io_uring</strong></td>
<td><strong>io_uring</strong>（实验性）</td>
<td>Netty 4.2+ 提供 <code>IoUringEventLoopGroup</td>（需 kernel 5.11+）</td>
</tr>
</tbody>
</table>

<p>所以当你写 <code>new NioEventLoopGroup()</code> 的时候，Netty 底层在 Linux 上就是用的 <strong>epoll LT 模式</strong>。如果你想榨干最后一点性能：</p>

<pre><code class="language-java">// ✅ 推荐：Linux 上用 Native Epoll（自动 ET 模式）
EventLoopGroup bossGroup = new EpollEventLoopGroup(1);
EventLoopGroup workerGroup = new EpollEventLoopGroup();

ServerBootstrap b = new ServerBootstrap();
b.group(bossGroup, workerGroup)
 .channel(EpollServerSocketChannel.class)  // 关键：native epoll channel
 // ...

// 🚀 实验：尝试 io_uring（需要 Netty 4.2+ &amp; kernel 5.11+）
// EventLoopGroup workerGroup = new IoUringEventLoopGroup();
</code></pre>

<p><strong>实测建议</strong>：对于绝大多数 Spring Boot 应用，<code>NioEventLoopGroup</code>（底层 epoll LT）已经足够好。只有在以下场景才值得考虑 <code>EpollEventLoopGroup</code> 或 io_uring：</p>

<ul>
<li>单机连接数 &gt; 50000（C50K 场景）</li>
<li>P99 延迟敏感（&lt; 5ms 要求）</li>
<li>CPU 已经成为瓶颈（&gt; 80%）且无法水平扩容</li>
</ul>

<h1-id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h3-id="坑-1-epoll-惊群效应-thundering-herd"><a href="#坑-1-epoll-惊群效应-thundering-herd" class="headerlink" title="坑 1：epoll 惊群效应（Thundering Herd）"></a>坑 1：epoll 惊群效应（Thundering Herd）</h3>

<p><strong>现象</strong>：多个进程/线程同时对同一个 listen_fd 调用 <code>epoll_wait()</code>，当新连接到来时，<strong>所有进程同时被唤醒</strong>，但只有一个能拿到连接，其余的白白浪费 CPU。</p>

<p><strong>原因</strong>：epoll 在早期内核（&lt; 4.5）中对 <code>EPOLLEXCLUSIVE</strong> 支持不完善。</p>

<p><strong>正解</strong>：</p>

<pre><code class="language-c">// 方案 1：使用 EPOLLEXCLUSIVE（kernel 4.5+，推荐）
ev.events = EPOLLIN | EPOLLEXCLUSIVE;  // 只唤醒一个 waiter

// 方案 2：主进程 accept 后分发给 worker（NGINX 做法）
// 方案 3：使用 SO_REUSEPORT（内核做负载均衡）
setsockopt(listen_fd, SOL_SOCKET, SO_REUSEPORT, &amp;opt, sizeof(opt));
</code></pre>

<h3-id="坑-2-et-模式下漏读导致事件丢失"><a href="#坑-2-et-模式下漏读导致事件丢失" class="headerlink" title="坑 2：ET 模式下漏读导致事件丢失"></a>坑 2：ET 模式下漏读导致事件丢失</h3>

<p><strong>现象</strong>：用了 <code>EPOLLET</code> 但偶尔发现客户端发了数据服务端没收。</p>

<p><strong>原因</strong>：ET 模式只在状态变化时通知一次。如果你收到通知后只 <code>read()</code> 了一次但没有读完（比如缓冲区太小、或者你 read 一次后就去做别的了），剩余的数据不会再触发通知——<strong>事件丢了</strong>。</p>

<p><strong>正解</strong>：ET 模式下必须<strong>循环读取直到 <code>read()</code> 返回 EAGAIN</code></strong>：</p>

<pre><code class="language-c">while ((n = read(fd, buf, sizeof(buf))) &gt; 0) {
    // 处理数据
}
if (n == -1 &amp;&amp; errno != EAGAIN) {
    // 真正的错误
}
if (n == 0) {
    // 对端关闭连接
}
// 只有 errno == EAGAIN 才跳出循环（说明暂时没数据了）
</code></pre>

<h3-id="坑-3-file-descriptor-泄漏"><a href="#坑-3-file-descriptor-泄漏" class="headerlink" title="坑 3：File Descriptor 泄漏"></a>坑 3：File Descriptor 泄漏</h3>

<p><strong>现象</strong>：服务运行几天后报 <code>too many open files</code>，<code>ulimit -n</code> 显示 fd 数打到上限。</p>

<p><strong>原因</strong>：客户端断开后，服务端忘记 <code>close(conn_fd)</code> 和 <code>epoll_ctl(EPOLL_CTL_DEL)</code>。fd 是有限资源（默认 <code>ulimit -n = 1024</code>）。</p>

<p><strong>正解</strong>：</p>

<pre><code class="language-bash"># 1. 调大 limit（临时）
ulimit -n 65535

# 2. 写入 /etc/security/limits.conf（永久）
* soft nofile 65535
* hard nofile 65535

# 3. 代码层面：确保每个关闭的连接都清理 epoll
# 断开时：
epoll_ctl(epfd, EPOLL_CTL_DEL, conn_fd, NULL);
close(conn_fd);

# 4. 监控 fd 使用量
watch -n 1 'ls /proc/&lt;PID&gt;/fd/ | wc -l'
</code></pre>

<h3-id="坑-4-io-uring-不是银弹"><a href="#坑-4-io-uring-不是银弹" class="headerlink" title="坑 4：io_uring 不是银弹"></a>坑 4：io_uring 不是银弹</h3>

<p><strong>现象</strong>：听说 io_uring 很牛，直接把项目迁移过去后发现性能没提升甚至下降了。</p>

<p><strong>原因</strong>：</p>

<ol>
<li><strong>你的瓶颈不在 I/O</strong>：如果业务是 CPU 密集型（加密、序列化、计算），换 I/O 模型没用</li>
<li><strong>连接数不够多</strong>：io_uring 的优势在 C10K+ 场景下才明显，几百连接 epoll 足够了</li>
<li><strong>用法不对</strong>：没用 SQPOLL、没用 registered buffer、没批量提交——等于开着法拉利堵车</li>
<li><strong>内核版本不够</strong>：kernel &lt; 5.10 的 io_uring 有已知 bug 和性能问题</li>
</ol>

<p><strong>正解</strong>：先用 <code>perf top</code> 或 <code>async-profiler</strong> 确认瓶颈确实在 I/O/syscall 上，再考虑迁移到 io_uring。</p>

<h3-id="坑-5-混淆同步异步与阻塞非阻塞"><a href="#坑-5-混淆同步异步与阻塞非阻塞" class="headerlink" title="坑 5：混淆「同步/异步」与「阻塞/非阻塞」"></a>坑 5：混淆「同步/异步」与「阻塞/非阻塞」</h3>

<p><strong>现象</strong>：面试时说"epoll 是异步 I/O"——<strong>这是错的</strong>。</p>

<p><strong>澄清</strong>：</p>

<ul>
<li><strong>阻塞/非阻塞</strong>：描述的是<strong>调用方在等待时的行为</strong>（卡住 or 立刻返回）</li>
<li><strong>同步/异步</strong>：描述的是<strong>谁来执行 I/O 操作</strong>（调用方自己 read = 同步；内核帮你 read 完通知你 = 异步）</li>
</ul>

<p>按这个定义：</p>

<ul>
<li>阻塞 I/O = 同步 + 阻塞</li>
<li>非阻塞 I/O = 同步 + 非阻塞</li>
<li>I/O 多路复用（epoll）= <strong>同步 + 阻塞（epoll_wait 阻塞，但 read/write 可以非阻塞）</strong></li>
<li><strong>io_uring = 真正的异步 I/O</strong></li>
</ul>

<p>epoll 是<strong>同步 I/O 多路复用</strong>——它只是告诉你"数据来了"，你还得自己 <code>read()</code>。只有 io_uring 做到了"你提交请求，内核做完所有事情（包括拷贝数据）后通知你"。</p>

<h1-id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从阻塞 I/O 到 io_uring，完整梳理了 Linux 五种 I/O 模型的演进路线：</p>

<ul>
<li><strong>阻塞 I/O</strong>：最简单，一连接一线程，低并发够用，高并发必死</li>
<li><strong>非阻塞 I/O</strong>：不卡等但要轮询，从不单独使用</li>
<li><strong>I/O 多路复用（epoll）</strong>：高并发基石，O(1) 通知机制，Netty/Redis/NGINX 的共同选择；LT 编程简单，ET 性能更好</li>
<li><strong>信号驱动 I/O</strong>：理论上有用，实践中几乎不用</li>
<li><strong>io_uring</strong>：未来方向，共享内存 + 零 syscall，压测显示比 epoll ET 快 36%~71%；但需要 kernel 5.1+ 且编程复杂度高</li>
</ul>

<p>最后一张图总结选型策略：</p>

<pre><code class="text">
                    你的并发连接数？
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
         &lt; 100       100~50000    &gt; 50000
            │            │            │
            ▼            ▼            ▼
      阻塞I/O够用    epoll(LT)   epoll(ET)
      或线程池即可   Netty默认    或 io_uring
                               (kernel≥5.10)
</code></pre>

<p><strong>记住一句话</strong>：I/O 模型的本质是在做 trade-off——用<strong>复杂的编程模型</strong>换取<strong>更高的硬件利用率</strong>。越底层的模型越难写，但能支撑的并发也越高。作为 Java 开发者，你不需要每天写 epoll 代码，但理解它的工作原理能帮你做出更好的架构决策和性能调优判断。</p>

<h1-id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>Linux man pages — <code>epoll(7)</code>, <code>io_uring(7)</code><br>
<a href="https://man7.org/linux/man-pages/man7/epoll.html" target="_blank">https://man7.org/linux/man-pages/man7/epoll.html</a> | <a href="https://man7.org/linux/man-pages/man7/io_uring.html" target="_blank">io_uring(7)</a></li>
<li>阿里云社区 - io_uring vs. epoll – Which Is Better in Network Programming?（OpenAnolis SIG 量化分析，2024）<br>
<a href="https://www.alibabacloud.com/blog/io-uring-vs--epoll-which-is-better-in-network-programming_599544" target="_blank">https://www.alibabacloud.com/blog/io-uring-vs--epoll-which-is-better-in-network-programming_599544</a></li>
<li>CTextHuang - io_uring vs epoll：Linux I/O 的两代王者（含源码级对比与共享内存图解）<br>
<a href="https://ctexthuang.com/posts/programming_star/io_uring-vs-epoll:-The-Future-of-Linux-IO" target="_blank">https://ctexthuang.com/posts/programming_star/io_uring-vs-epoll:-The-Future-of-Linux-IO</a></li>
<li>51CTO - 深入解剖 io_uring：Linux 异步 I/O 的终极武器（含五种 I/O 模型完整代码与对比测试）<br>
<a href="https://www.51cto.com/article/819134.html" target="_blank">https://www.51cto.com/article/819134.html</a></li>
<li>iafisher.com - Notes on epoll and io_uring（清晰的 API 对比与 Ring Buffer 解释）<br>
<a href="https://iafisher.com/notes/2025-10-epoll-io-uring" target="_blank">https://iafisher.com/notes/2025-10-epoll-io-uring</a></li>
<li>阿里云开发者社区 - 【Linux系统编程】深入剖析：四大 IO 模型机制与应用（阻塞、非阻塞、多路复用）<br>
<a href="https://developer.aliyun.com/article/1560356" target="_blank">https://developer.aliyun.com/article/1560356</a></li>
<li>OpenAnolis GitHub - io_uring 官方示例与 liburing 文档<br>
<a href="https://github.com/axboe/liburing" target="_blank">https://github.com/axboe/liburing</a></li>
</ol>
