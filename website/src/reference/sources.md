# 文档来源与维护

本站对应 TG Vault 当前源码，版本记录见[更新日志](/reference/changelog)，实际发布见 [GitHub Releases](https://github.com/hicocos/tg-vault/releases)。

## 内容来源

这六篇在构建时从仓库原文件生成：

| 页面 | 维护文件 |
| --- | --- |
| [服务器部署](/deploy/installation) | `deploy/DEPLOY.md` |
| [配置参考](/reference/configuration) | `docs/configuration.md` |
| [本地存储](/storage/local) | `docs/local-storage.md` |
| [MCP：连接 AI Agent](/usage/mcp) | `docs/mcp.md` |
| [开发与发布](/reference/development) | `docs/development.md` |
| [更新日志](/reference/changelog) | `CHANGELOG.md` |

专题教程在 `website/src/`，导航在 `website/.vitepress/config.mts`。修改功能时同步更新对应教程，不编辑生成页面。

## 构建与发布

使用 Node.js 24，构建与 Pages 发布步骤见仓库 [`website/README.md`](https://github.com/hicocos/tg-vault/blob/main/website/README.md)。仅发布 `website/.vitepress/dist/`。

部署应用后按[验收清单](/deploy/verification)检查实际文件操作。项目使用 [MIT License](/LICENSE.txt)。
