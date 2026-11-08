# 认识 TG Vault

TG Vault 是自托管的 Telegram 文件转存与归档工具，支持多个人账号调度、Web 文件管理，可保存到本地磁盘或云存储。

## 选择使用方式

| 需求 | 需要配置 |
| --- | --- |
| Web 上传与文件管理 | 基础部署，本地存储即可使用 |
| 给 Bot 发送或转发文件 | Bot Token、API ID/Hash、PIN 和允许用户 |
| 频道/群组按日期或标签下载 | 有来源访问权限的个人 Telegram 账号 |
| 自动保存频道新内容 | 个人账号与订阅配置 |
| 保存到云端 | [对应存储的凭据](/storage/) |
| 多个账号分担来源读取 | [添加并启用多个个人账号](/usage/multi-account)，分别确认来源权限 |

只用 Web 不必配置 Telegram；只用本地磁盘不必注册云平台应用。

## 功能

- Bot 文件接收、频道历史下载与订阅同步。
- [多账号调度](/usage/multi-account)：已确认来源权限优先，结合冷却、权重和占用逐文件分配，同负载轮换。
- Web 上传、分片续传、搜索、收藏、文件夹和媒体预览。
- Web/Bot 任务进度、失败明细、暂停、继续与重试。
- 本地、OneDrive、Google Drive、OSS、S3、WebDAV、OpenList，支持多个账户。
- 管理员密码、Bot 用户允许列表、TOTP 与存储凭据加密。

可选扩展包括 [MCP：连接 AI Agent](/usage/mcp)（向 Codex、Rikka 等客户端开放受控文件与归档能力）与 [qBittorrent 下载转存](/usage/qbittorrent)（需自行部署同机下载器，支持下载后转存与保留做种）。

## 使用限制

频道下载需要实际账号的来源权限，不绕过私有权限、受保护内容或 Telegram 限流。远端存储仍需要本地暂存空间。

多账号不会把单个文件拆给不同账号，也不自动提高当前并发；服务器带宽、暂存和目标存储仍会限制整体速度。

添加存储不会导入整盘已有文件；切换默认存储不迁移文件，也不改变已固定的任务目标。

在[更新日志](/reference/changelog)查看版本变化，发布信息见 [GitHub Releases](https://github.com/hicocos/tg-vault/releases)。
