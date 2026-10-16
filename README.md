<p align="center">
  <strong>简体中文</strong> | <a href="README_EN.md">English</a>
</p>

<p align="center"><img src="backend/logo.png" alt="TG Vault Logo" width="150" /></p>

# TG Vault

面向个人与小团队的 Telegram 文件转存、媒体归档和多存储源文件管理系统。在 Web 中管理文件，将 Telegram 私聊、频道或群组中有权保存的内容归档到自己的存储。

[快速部署](#快速部署) · [Bot 命令](#telegram-bot-命令) · [部署指南](deploy/DEPLOY.md) · [English](README_EN.md)

## 功能概览

- 文件上传、文件夹整理、搜索和媒体预览。
- Telegram Bot 文件转存，频道/群组按日期或标签批量下载，频道订阅同步。
- Web 与 Bot 任务管理：查看进度、保存去向和失败明细，暂停、继续、取消及重试。
- 本地磁盘、OneDrive、Google Drive、阿里云 OSS、S3 和 WebDAV 存储，按来源与目录规则归档。
- 管理员密码、Bot 用户允许列表与 PIN、TOTP 双重验证。

TG Vault 不是 Telegram 权限或下载限制的绕过工具。频道下载与订阅需要登录能访问来源的 Telegram 用户账号；仅向 Bot 发文件不要求登录个人账号。本项目的 Bot 下载使用 MTProto，而非 HTTP Bot API 的 `getFile`；不能套用后者的文件大小限制，也不能保证任意文件可下载。直接发送给 Bot 且没有可重读来源的文件仍由 Bot 下载，登录个人账号不会自动解除该路径的限制。详见[配置说明](docs/configuration.md#telegram-配置与能力)。

## 快速部署

准备 Linux 服务器、Docker Compose，以及同一主域名下的 Web/API 两个 HTTPS 地址，例如 `cloud.example.com` 与 `api.example.com`。证书和反向代理由宿主机或管理面板提供。

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
./deploy/install.sh
```

首次安装无需预先复制 `.env.example`。按提示填写 Web/API 地址和新的专用文件目录；安装器生成数据库密码及应用密钥，构建并启动 PostgreSQL、后端与前端。文件目录默认是安装目录下的 `data`，已有部署保留原挂载，不自动迁移文件。

1. 按[部署指南](deploy/DEPLOY.md#4-配置宿主机反向代理)配置 Web → `127.0.0.1:47832`、API → `127.0.0.1:51947` 的 HTTPS 反向代理。
2. **首次初始化前限制两个入口的访问，仅允许自己访问。** 第一个完成初始化的人会设置管理员密码；没有默认管理员密码。通过 HTTPS 创建至少 8 位的强密码后再开放服务。
3. 在 **设置 → Telegram** 填写 Bot Token、API ID、API Hash，设置 Bot PIN 与数字用户 ID 允许列表。频道下载或订阅还需要在同页登录个人 Telegram 账号。
4. 在 **设置 → 存储** 添加其他存储账户；妥善备份配置、数据库和完整 `/data`。

安装器选项、较旧 Compose 的 `--compat` 模式和故障排查见[完整部署指南](deploy/DEPLOY.md)。

## Telegram Bot 命令

连接后发送 `/start` 验证身份，发送 `/help` 查看完整命令和参数。文件浏览与搜索使用 Web。

| 命令 | 用途 |
| --- | --- |
| `/tasks` | 查看任务、进度与控制按钮 |
| `/storage` | 查看存储状态 |
| `/path_rules` | 设置保存位置与目录规则 |
| `/target` | 设置当前聊天的存储目标 |
| `/tg_download` | 打开频道/群组日期或标签下载向导 |
| `/tg_sub`、`/tg_subs` | 管理和查看订阅 |
| `/tg_retry` | 重试失败任务 |
| `/setup_2fa` | 设置 TOTP 双重验证 |

频道任务的处理进度包括成功、失败和跳过，100% 不等于全部成功。扫描总量可能未知；排队或 Telegram 冷却不代表正在传输。暂停阻止后续读取，但已发出的请求和存储写入可能仍需收尾。

## 备份与更新

从项目根目录执行协调备份，再运行安装器更新：

```bash
BACKUP_DIR=/path/to/secure-backups ./deploy/backup.sh
./deploy/restore-verify.sh /path/to/secure-backups/<timestamp>
./deploy/install.sh
```

备份脚本在归档期间停止 backend，结束时恢复其原运行状态。**另行安全备份 `.env` 和反向代理配置**；脚本只包含数据库、完整 `/data` 与校验清单，不包含远端存储的文件。归档校验不是恢复演练。升级自动应用数据库迁移，回退时必须考虑数据库与文件的一致性，不要直接覆盖旧版本。不要用 `docker compose down -v` 排障。详见[备份与恢复](deploy/DEPLOY.md#7-备份与恢复)。

## 本地构建与贡献

容器构建使用 Node.js 24；本地构建也建议使用 Node.js 24 和 npm。两个子项目分别安装依赖与构建：

```bash
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix backend run build
npm --prefix frontend run build
```

本地运行后端还需要 PostgreSQL 和 `DATABASE_URL`；缩略图/转码需要 ffmpeg。开发启动与环境要求见[配置说明](docs/configuration.md#本地开发)。提交变更时说明用途、复现步骤与实际执行的检查；保留锁文件，并同步中英文说明。数据库结构变更应同步 schema、迁移和 `init.sql`，不要改写已发布迁移。

GitHub Actions 的质量检查不需要生产凭证；公共 fork 无需配置 Docker Hub 即可参与开发。仅发布镜像时配置仓库 secrets `DOCKER_USERNAME`、`DOCKER_PASSWORD`，以及按需使用的变量 `VITE_API_URL`；未配置发布凭证时跳过推送。API 地址会进入前端静态资源，不能把秘密放进 `VITE_*` 变量。

发布、提交或共享问题日志前，确认不含 `.env`、Token、API Hash、密码、Cookie、Telegram session、数据库/备份、用户文件或服务器私有信息。不要提交 `node_modules`、`dist`、覆盖率、临时调试/冒烟脚本及本地执行报告；忽略规则不能移除已经进入 Git 历史的秘密，泄露后应撤销/轮换并清理历史。

## 文档

- [部署指南](deploy/DEPLOY.md)：安装、HTTPS、备份、恢复与更新。
- [配置与使用](docs/configuration.md)：环境变量、Telegram、存储与权限。
- [本地存储位置](docs/local-storage.md)：挂载、路径确认与数据保护。
- [版本发布](https://github.com/hicocos/tg-vault/releases)。

## 开源协议

[MIT License](LICENSE) · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
