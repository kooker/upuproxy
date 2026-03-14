专为 **Cloudflare Pages** 打造的工业级无端代理（Web Proxy）完整解决方案。未解决Youtube和Google等复杂SPA现代化网站问题

相比于传统的 Cloudflare Workers，**Cloudflare Pages 高级模式**（Advanced Mode）具备巨大的优势：它拥有原生的静态资源托管（ASSETS）能力，不再需要通过外部 URL 回源 `sw.js`。代码的结构也更加清晰。

以下是完整的项目结构与部署指南。

---

### 项目结构初始化

在你的本地电脑上，创建一个新的文件夹 `upp-proxy-pages`，并在其中创建以下目录和文件结构：

```text
upp-proxy-pages/
├── dist/
│   ├── _worker.js      (边缘网关与SEO渲染核心)
│   ├── sw.js           (Service Worker流媒体缓存核心)
│   └── _routes.json    (Pages 路由优化配置)
└── wrangler.toml       (部署配置)
```

### 一键部署指南

你有两种方式可以部署这个项目到 Cloudflare Pages：

#### 方法 A：使用 Wrangler CLI 直接部署 (推荐，最快)

1. 确保你安装了 Node.js。在终端运行：
   ```bash
   npm install -g wrangler
   ```
2. 登录你的 Cloudflare 账号：
   ```bash
   wrangler login
   ```
3. 在 `upp-proxy-pages` 根目录执行部署命令：
   ```bash
   wrangler pages deploy dist --project-name upp-proxy
   ```
4. 部署完成后，CLI 会返回一个 `.pages.dev` 域名，例如 `https://upp-proxy.pages.dev`。直接访问 `https://upp-proxy.pages.dev/https://example.com` 即可。

#### 方法 B：通过 GitHub 自动构建 (适合持续集成)

1. 将整个 `upp-proxy-pages` 文件夹推送到你的 GitHub 仓库。
2. 登录 Cloudflare 控制台 -> **Workers & Pages** -> **Create application** -> **Pages** -> **Connect to Git**。
3. 选择你的仓库。在设置页面：
   - **Framework preset**: 选择 `None`
   - **Build command**: 留空
   - **Build output directory**: 填写 `dist`
4. 点击 **Save and Deploy** 即可。以后每次推送到 GitHub，Cloudflare Pages 都会在几秒内自动更新并在全球边缘节点生效。

### Pages 版本相对纯 Worker 版本的提升总结：
1. **0 开销资源下发**：请求 `/sw.js` 时触发 `_routes.json` 规则，直接由 Cloudflare 内部的 Pages Assets CDN 直接返回，不计入 Worker 免费计算时间额度。
2. **避免双重 Fetch 回源**：以前纯 Worker 架构为了服务 `sw.js` 需要在代码里从 Github Raw 再 fetch 一遍，大幅增加延迟。Pages 模式原生解决。
3. **最极客的文件结构**：分离了前端渲染与后端代理的逻辑。
