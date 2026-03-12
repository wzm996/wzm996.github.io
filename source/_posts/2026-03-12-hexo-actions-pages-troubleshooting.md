---
title: 一次搞懂：Hexo + GitHub Actions 部署 Pages 的排错清单（含可复现实验）
date: 2026-03-12 16:05:00
categories:
  - 软件工程与系统设计
  - CI/CD
tags:
  - Hexo
  - GitHub Actions
  - GitHub Pages
  - Debug
  - CI
---

最近把 Hexo 博客部署到 GitHub Pages 时，经常会遇到一种“本地能跑、线上不更新/不发布/404”的状态。问题的难点在于：**失败点可能在构建、产物、权限、分支/环境、缓存、甚至是 URL 配置**。

这篇文章给一份「可操作的排错清单」：每一步都包含**可复现的命令/配置**，并告诉你如何验证、怎么看日志、常见坑在哪里。

<!-- more -->

## 0. 先明确：你的 Pages 部署模型是哪一种

GitHub Pages 目前常见有两种部署模型（Repo Settings 里能看到）：

1) **Deploy from a branch**：从某个分支（例如 `gh-pages`）的某个目录（`/` 或 `/docs`）发布。
2) **GitHub Actions**：由 Actions workflow 构建并上传 artifact，再发布到 Pages（常见于 `actions/configure-pages` + `actions/upload-pages-artifact` + `actions/deploy-pages`）。

为什么要先分清？因为两种模型的**故障点完全不同**：

- 分支发布：重点看 **发布分支是否更新**、目录是否正确、是否把 `public/` 的内容推到了发布分支。
- Actions 发布：重点看 **workflow 是否成功**、artifact 是否生成、`permissions` 是否足够、`environment: github-pages` 是否正确。

验证方法：

- 打开仓库 **Settings → Pages**，看 `Build and deployment` 一栏。
- 或者直接看 `.github/workflows/` 里的工作流是否使用了 `deploy-pages`。

## 1. 本地先跑通：锁定“构建是否稳定”

即便你已经能 `hexo server`，也建议明确跑一遍“干净构建”，避免本地缓存掩盖问题。

在项目根目录执行：

```bash
# 1) 安装依赖（CI 上一般是 npm ci）
npm ci

# 2) 清理再构建（确保 public/ 是全新生成）
npx hexo clean
npx hexo generate

# 3) 检查产物
ls -al public | head

# 4) 可选：本地预览产物（不是 hexo server，而是看 public/）
# Python 方案：
python3 -m http.server 4000 --directory public
# 然后打开 http://localhost:4000
```

验证点：

- `public/index.html` 是否存在
- 新文章是否出现在首页、归档页
- 文章链接是否能打开（尤其是含中文标题/路径的文章）

常见坑：

- 只跑 `hexo server` 没问题，但 `hexo generate` 失败（主题插件/脚本在 generate 阶段才执行）。
- Node 版本差异导致依赖行为不同（CI 用 Node 20，本地用旧版本）。

## 2. 复现 CI 环境：用 Node 版本和 npm 行为对齐

很多“本地 OK、CI 挂”的问题来自环境差异。

建议你在本地模拟 CI 的关键部分：

```bash
node -v
npm -v

# 对齐 CI 的 Node 版本（如果仓库有 .nvmrc / .node-version / engines 字段）
# 没有的话，建议在 CI 中明确使用 Node 20+
```

在 GitHub Actions 里，通常会这样指定：

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: npm
```

验证方法：

- CI 日志里找 `node -v` 输出
- 如果有 `npm ci`，确保 `package-lock.json` 已提交且一致

常见坑：

- `npm install` 在 CI 上拉到了不同依赖版本（没 lock 或 lock 不一致），导致构建随机失败。
- `cache: npm` + lock 变化没触发正确缓存失效，出现“看似复现不了”的构建问题。

## 3. 看 workflow 的失败点：构建、上传还是部署？

如果你使用 Actions 部署 Pages，流程大概是：

1) build（生成 `public/`）
2) upload artifact
3) deploy to GitHub Pages

你需要判断挂在哪一段：

- **build 段失败**：通常是依赖/命令问题
- **upload 段失败**：通常是路径不对，artifact 为空
- **deploy 段失败**：通常是权限/环境/Pages 配置问题

验证方法（日志定位）：

- 进入 **Actions → 具体 workflow run → job logs**
- 找到以下关键字：
  - `hexo generate` / `npm run build`
  - `upload-pages-artifact`
  - `deploy-pages`

小实验：让 workflow 输出目录结构，确认 `public/` 真存在：

```yaml
- name: Debug list public
  run: |
    ls -al
    ls -al public | head -200
```

## 4. permissions 必须正确：否则 deploy-pages 会 403

使用 `actions/deploy-pages` 时，官方要求工作流具备必要权限。一个常见的“看起来都成功，但发布失败/403”的根因是权限不够。

推荐配置（示例）：

```yaml
permissions:
  contents: read
  pages: write
  id-token: write
```

验证方法：

- 在失败日志中搜索 `403`、`Resource not accessible by integration`。

常见坑：

- 仓库是组织仓库/开启了更严格的 Actions 权限策略，导致 `pages: write` 被限制。
- PR 来自 fork 时，默认权限更少（为了安全），部署步骤会被限制。

## 5. baseurl / url / root：最容易导致“发布了但 404”

如果你访问站点出现：

- 首页能打开，但文章链接 404
- 资源（CSS/JS）丢失、样式全无

大概率是 Hexo 配置里 `url`/`root` 或主题配置的路径问题。

典型场景：

- `https://<user>.github.io/`（用户主页仓库）通常 `root: /`
- `https://<user>.github.io/<repo>/`（项目页）通常 `root: /<repo>/`

验证方法：

1) 打开 `public/index.html`，看里面资源引用是 `/css/main.css` 还是 `/<repo>/css/main.css`。
2) 访问浏览器 Network，看看 404 的资源路径。

小实验：在本地用一个“子路径”模拟项目页：

```bash
# 例如你想模拟部署到 /myblog/ 子路径
python3 -m http.server 4000 --directory public
# 然后访问 http://localhost:4000/myblog/ 看是否资源路径正确
```

常见坑：

- 站点从项目页迁移到用户主页（或反过来）后，`root` 没同步调整。
- 主题里某些绝对路径写死（legacy 主题更常见），导致 root 调整后仍有资源 404。

## 6. artifact 路径必须指向 public/（或你的输出目录）

Actions 部署 Pages 时，你通常会上传一个目录作为 Pages artifact。如果你不小心上传了错误目录（例如根目录或空目录），部署会成功但页面是空/404。

推荐明确指定：

```yaml
- name: Build
  run: |
    npm ci
    npx hexo clean
    npx hexo generate

- name: Upload Pages artifact
  uses: actions/upload-pages-artifact@v3
  with:
    path: public
```

验证方法：

- 在 workflow run 页面，会显示 artifact（Pages artifact）的大小。
- artifact 如果只有几 KB，基本就是上传错了。

## 7. 缓存与“看起来没更新”：确认你真的发布了新内容

有时 workflow 显示成功、Pages 显示已部署，但你打开站点还是旧内容。

排查顺序：

1) **确认最新一次部署的时间**：Settings → Pages 会显示“Last deployed”。
2) 浏览器强刷：`Ctrl+F5` / 关闭缓存。
3) 在 URL 后加随机 query：`?v=20260312`。
4) 如果启用了 CDN/自定义域名，检查 CDN 缓存。

验证方法：

- 在生成的页面底部/页脚临时加入构建时间（作为排查手段），确认是否真的刷新。

小实验（临时注入，不建议长期保留）：

```bash
# 在某个布局模板中加入构建时间变量（视主题而定）
# 或在文章中写入当前时间，观察线上是否出现
```

## 8. PR 触发 vs push 触发：工作流事件别写错

如果你的 workflow 只在 `push` 触发：

```yaml
on:
  push:
    branches: [ master ]
```

那么 **仅仅创建 PR** 并不会部署（除非你还配置了 `pull_request`）。

验证方法：

- 看 `.github/workflows/*.yml` 的 `on:` 字段。
- 看 Actions 页面里有没有对应 PR 的 run。

常见坑：

- 以为“提 PR 就能预览”，但工作流只在 master push 才跑。
- 想要 PR 预览，却没有配置 preview 环境（需要额外设计，不是 Pages 默认能力）。

## 9. 一份可用的最小化 Pages workflow（参考）

下面是一份“尽量少坑”的 Hexo → Pages workflow（按需调整）：

```yaml
name: Deploy Hexo site to Pages

on:
  push:
    branches:
      - master

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install deps
        run: npm ci

      - name: Build
        run: |
          npx hexo clean
          npx hexo generate

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: public

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

验证方法：

- push 到 `master` 后，Actions 会跑起来
- Settings → Pages 显示最新部署

## 常见误区总结（速查）

- 误区 1：`hexo server` 能跑就代表 CI 一定能 generate —— 不一定。
- 误区 2：PR 会触发部署 —— 取决于 workflow `on:` 配置。
- 误区 3：部署成功就代表路径正确 —— `root/url` 错了照样 404。
- 误区 4：artifact 上传什么都行 —— 上传错目录会得到空站点。

## 参考资料

1. Hexo 官方文档：GitHub Pages 部署 <https://hexo.io/docs/github-pages>
2. GitHub 官方：Deploying to GitHub Pages with GitHub Actions <https://docs.github.com/en/pages/getting-started-with-github-pages/using-github-actions-to-deploy-to-github-pages>
3. actions/deploy-pages README <https://github.com/actions/deploy-pages>
4. actions/upload-pages-artifact README <https://github.com/actions/upload-pages-artifact>
5. actions/configure-pages README <https://github.com/actions/configure-pages>
6. actions/setup-node 文档 <https://github.com/actions/setup-node>
