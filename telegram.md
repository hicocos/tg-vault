---
title: Telegram 配置与命令
description: 在 Web 中配置 TG Vault Bot、用户账号下载器、频道任务与通知
---

{% include nav.html %}

# Telegram 配置与命令

TG Vault 提供两层 Telegram 能力：**Bot 基础能力**和可选的**账号级下载器**。现在二者都推荐在 Web 的 **设置 → Telegram** 中配置，不需要手工编辑 session 文件。

## 能力区别

| 能力 | 只配置 Bot | 再启用账号级下载器 |
| --- | :---: | :---: |
| 私聊发送文件转存 | ✅ | ✅ |
| 文件搜索、任务管理和存储诊断 | ✅ | ✅ |
| `/ytdlp` 链接下载 | ✅ | ✅ |
| 按日期/标签抓取频道或群组 | — | ✅ |
| 频道订阅自动同步 | — | ✅ |
| 通过用户账号处理大文件 | — | ✅ |

## 1. 准备 Telegram 凭据

### 创建 Bot Token

1. 在 Telegram 私聊 [@BotFather](https://t.me/BotFather)。
2. 发送 `/newbot` 并按提示完成创建。
3. 安全保存 BotFather 返回的 HTTP API Token。

### 获取 API ID 与 API Hash

1. 打开 [my.telegram.org](https://my.telegram.org/)并登录。
2. 进入 **API development tools**。
3. 创建应用，记录数字 `api_id` 和 32 位 `api_hash`。

API ID/Hash 同时供 Bot 客户端和账号级下载器使用。

## 2. 在 Web 中连接 Bot

进入 **设置 → Telegram → Telegram Bot 连接**，填写：

- Bot Token
- API ID
- API Hash
- 4 位数字 Bot PIN（首次配置时）

先点击 **测试连接**，确认显示正确的 Bot 用户名，再点击 **保存并启用**。配置立即生效，不需要重建或重启容器。

保存后：

- Token、API ID、API Hash 使用 AES-256-GCM 加密保存。
- 页面和 API 只返回连接状态、Bot 身份和最近错误，不回显凭据。
- 可以更换凭据、修改 Bot PIN或永久删除 Web 配置。
- 修改 PIN 时需使用当前 PIN 或网页管理员密码验证；修改后已认证的 Telegram 用户需要重新验证。

<div class="callout warning">
永久删除 Bot 配置会立即停止 Bot，并删除已保存的凭据和 Bot session；允许用户列表会保留。此操作需要二次确认。
</div>

### 旧 `.env` 配置

旧部署仍可使用：

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_REQUIRED=false
```

Web 会标记“环境变量兼容”，并提供 **迁移到网页管理**。迁移时后端直接读取环境变量并加密保存，原值不会传回浏览器；确认运行正常后可从 `.env` 删除旧凭据。网页配置存在时优先使用网页配置，且不完整的网页凭据不会静默回退到环境变量。

`TELEGRAM_REQUIRED=false` 是默认值：Bot 故障显示为 degraded，但不会阻止 Web/API 的 `/readyz`。只有确实要求“Bot 不在线即判定整套服务未就绪”时才设置为 `true`。

## 3. 限制允许用户

在 **设置 → Telegram → Telegram Bot 用户权限** 填写允许使用 Bot 的数字 user ID；多个值可用英文逗号、空格或换行分隔。用户可通过 `@userinfobot` 查看自己的 ID。

- 推荐在首次对外使用前显式保存允许列表。
- 如果还没有任何 Telegram 用户认证成功，首个正确输入 Bot PIN 的用户可自动加入允许列表。
- 如果 `.env` 设置了 `TELEGRAM_ALLOWED_USER_IDS`，页面会显示“由环境变量管理”；此时需要修改 `.env` 并重启 backend。

首次使用 Bot：

1. 向 Bot 发送 `/start`。
2. 输入 4 位 Bot PIN。
3. 如果启用了 TOTP，再按提示输入动态验证码。

## 4. 在 Web 中登录账号级下载器（可选）

仅在需要频道/群组历史抓取、订阅同步或用户账号下载能力时启用。

进入 **设置 → Telegram → Telegram 账号下载器**：

1. 点击 **登录并启用**。
2. 输入含国家区号的手机号，例如 `+86...`。
3. 输入 Telegram App 或短信收到的验证码。
4. 如果账号开启了 Telegram 两步验证，再输入两步验证密码。
5. 页面显示账号、连接状态和最近检查时间后即完成。

登录流程约 5 分钟内有效，连续多次输错会要求重新开始。session 加密保存在服务端设置中，不会回显到浏览器。账号级下载器复用 Bot 的 API ID 和 API Hash，因此需先完成 Bot 凭据配置。

账号管理：

- **停用（保留登录）**：停止账号级下载，保留加密 session，之后可直接重新启用。
- **解除绑定**：永久删除保存的账号 session，需要重新登录才能恢复。
- 如果启用后 session 未就绪，任务会明确失败，不会悄悄回退到旧逻辑。

旧部署仍可用命令行生成 session：

```bash
docker compose run --rm --no-deps backend npm run login:telegram-user
```

旧文件默认位于 `/data/telegram_user_session.txt`。新版后端会把可用的旧 session 迁移到加密设置，并在连接成功后删除旧明文文件。新安装推荐直接使用 Web 登录。

账号必须已经加入要读取的频道或群组，并具有查看历史消息的权限。可用 `TELEGRAM_ALLOWED_SOURCES` 限制允许抓取的来源。

## 5. 下载明细与并发设置

在 **设置 → 高级设置 → 数据维护** 可选择：

- **仅保留错误（推荐）**：任务运行时仍记录明细；任务完成后自动删除成功和跳过项，仅留下失败项用于排错和重试。
- **保留全部（完整审计）**：保留逐条下载历史，适合磁盘充足且需要完整核对的部署。

切换到“仅保留错误”会立即压缩已有的成功/跳过明细。手动“删除任务历史”、临时文件清理和删除实体文件是三类不同操作。

两个并发参数控制不同层级：

- `TELEGRAM_FILE_DOWNLOAD_CONCURRENCY`：同时处理几个文件，支持 `1/2/3/4`。
- `TELEGRAM_DOWNLOAD_WORKERS`：单文件内分片 worker，支持 `4/8/12/16`。

优先从 `1 × 4` 或默认 `2 × 4` 开始。提高并发会增加 FloodWait、磁盘和网络压力，应结合 `/status` 与日志逐步调整。

## 6. 常用 Bot 命令

### 入口与诊断

| 命令 | 用途 |
| --- | --- |
| `/start` | 开始使用或验证身份 |
| `/help` | 显示完整帮助 |
| `/tasks` | 查看实时传输任务 |
| `/storage` | 查看存储状态，并在确认后处理本地实体文件 |
| `/status` | 查看 Bot、账号下载器、存储、磁盘、队列、订阅和对账状态 |
| `/notifications` | 设置成功/失败/订阅摘要、时区和安静时段 |
| `/logout` | 撤销当前 Telegram 用户的 Bot 认证 |
| `/setup_2fa` | 配置 TOTP 双重验证 |

### 文件与存储目标

| 命令 | 用途 |
| --- | --- |
| `/list [数量] [页码]` | 查看最近文件和文件 ID |
| `/find [关键词] [筛选]` | 按名称、类型、目录、日期或收藏搜索文件 |
| `/delete <至少8位ID前缀>` | 请求删除指定文件 |
| `/storage_switch` | 切换系统默认存储 |
| `/target [once\|session\|clear] [local\|账户ID]` | 设置当前聊天的一次性/会话级目标 |
| `/path_rules` | 打开保存位置面板 |
| `/p <目录>` | 下一次下载使用指定目录 |
| `/ps <目录>` | 当前聊天会话持续使用指定目录 |
| `/pc` | 清除自定义目录 |

`/find` 可组合使用 `type:image|video|audio|document`、`folder:目录`、`after:YYYY-MM-DD`、`before:YYYY-MM-DD` 和 `fav`。

### 任务控制与策略

- `/task_pause [任务ID]`
- `/task_resume [任务ID]`
- `/task_cancel <任务ID|all>`
- `/stop_tasks`
- `/tg_retry [数量] [任务ID]`
- `/download_workers`：设置单文件内分片并发
- `/file_concurrency`：设置同时下载的文件数量
- `/duplicate_mode`：设置同名、同目录且同大小文件的处理方式
- `/cleanup_settings`：管理未登记临时文件的自动清理

危险操作会要求单独确认。暂停或取消任务不等于删除已经保存的文件。

### 频道抓取与订阅

以下命令需要账号级下载器：

- `/tg_download`：打开按日期或标签下载向导
- `/tg_download date <频道> <开始日期> <结束日期>`
- `/tg_download tag <频道> <#标签>`
- `/tg_sub <频道>`：添加或管理订阅
- `/tg_subs`：查看订阅列表
- `/tg_unsub <频道或订阅ID>`：请求取消订阅

大量文件会进入持久化任务队列；使用 `/tasks` 或 Web **任务中心**查看，不要重复提交同一范围。

## 7. Web 任务中心

Web 任务中心汇总 Telegram Bot、频道抓取、订阅、Web 上传和 yt-dlp 任务。支持按来源/状态查看，并对可操作任务执行取消或重试。删除终态任务记录需要确认，只移除任务中心记录，不会删除文件、云端对象或订阅。

## 8. 故障排查

```bash
docker compose logs --tail=250 backend
curl -i http://127.0.0.1:51947/readyz
```

- Bot 无响应：检查测试连接结果、Token、API ID/Hash、Bot PIN、允许用户和后端网络。
- `/readyz=503`：检查是否把 Telegram 设置为必需组件，以及 Bot/session 的最近错误。
- 收不到登录验证码：确认手机号含国家区号，并检查验证码是否发到 Telegram App 而不是短信。
- 账号下载器失效：在 Web 查看状态；必要时解除绑定后重新登录。
- 频道抓取失败：检查账号是否为频道成员、历史消息权限和来源允许列表。
- 频繁 FloodWait：降低文件级并发和分片 worker 数量。

---

[返回文档中心](./) · [快速部署](./quick-start.html) · [查看 yt-dlp](./ytdlp.html) · [了解任务架构](./architecture.html)
