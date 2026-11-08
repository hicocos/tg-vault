# TG Vault 文档站

正式地址：**https://tgvault.pages.dev/**

VitePress 静态文档，使用独立依赖，不读取生产配置或数据。

## 构建与预览

Node.js 24，在仓库根目录执行：

```bash
npm --prefix website ci
npm --prefix website run build
npm --prefix website run preview
```

预览仅监听 `127.0.0.1:4173`。构建检查本地页面、资源与章节链接。

专题教程维护在 `src/`，导航配置在 `.vitepress/config.mts`。部署、配置、本地存储、开发、MCP 和更新日志由 `scripts/prepare.mjs` 从仓库原文生成，修改原文件，不编辑生成页面。

一键安装命令使用 GitHub `main` 分支的根目录 `install.sh`。

## Cloudflare Pages

当前项目 `tgvault` 使用 Direct Upload，生产分支为 `main`。只上传 `website/.vitepress/dist/`，不上传整个项目。

### 新建 Git 集成项目

| 配置 | 值 |
| --- | --- |
| 框架 | VitePress 或 None |
| 根目录 | 仓库根，留空 |
| 构建命令 | `npm --prefix website ci && npm --prefix website run build` |
| 输出目录 | `website/.vitepress/dist` |
| 环境变量 | `NODE_VERSION=24` |
| 可选 `SITE_URL` | 默认 `https://tgvault.pages.dev`，自定义域名时覆盖 |

### Direct Upload

需要目标账户的 **Cloudflare Pages Edit / Pages Write (`page.write`)** 权限：

```bash
npm --prefix website exec -- wrangler login
npm --prefix website run deploy
```

项目名为 `tgvault`；迁移到其他项目时同步 `package.json` 发布命令和站点地址。

自定义文档域名时设置 `SITE_URL=https://docs.example.com`，用于 canonical 与 sitemap。Direct Upload 不能原地切换为 Cloudflare 原生 Git 集成。

### GitHub Actions

`website-pages.yml` 在文档变更时构建。配置以下仓库值后，非 PR 构建会发布：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | 目标账户 Pages 写权限 Token |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | 账户 ID |
| Variable | `CLOUDFLARE_PAGES_PROJECT` | 已创建的项目名 |
| Variable | `DOCS_SITE_URL` | 正式 origin，可选 |

未配置时只构建。PR 不读取发布凭据。

## 发布检查

发布前检查首页、搜索、移动导航、深链接与安全响应头。仅上传构建目录，不包含 `.env`、数据、备份或 session。

[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) · [Pages 构建配置](https://developers.cloudflare.com/pages/configuration/build-configuration/)
