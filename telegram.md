---
title: Telegram 配置与命令
description: 配置 TG Vault Bot、账号级下载器、频道任务与通知
---

{% include nav.html %}

# Telegram 配置与命令

TG Vault 提供两层 Telegram 能力：**Bot 基础能力**和可选的**账号级下载器**。二者用途不同，不需要为了使用 Bot 而登录个人 Telegram 账号。

## 能力区别

| 能力 | 只配置 Bot | 再启用账号级下载器 |
| --- | :---: | :---: |
| 私聊发送文件转存 | ✅ | ✅ |
| 文件搜索、任务管理和存储诊断 | ✅ | ✅ |
| `/ytdlp` 链接下载 | ✅ | ✅ |
| 按日期/标签抓取频道或群组 | — | ✅ |
| 频道订阅自动同步 | — | ✅ |
| 通过用户账号处理大文件 | — | ✅ |

## 1. 创建 Bot

1. 在 Telegram 私聊 [@BotFather](https://t.me/BotFather)。
2. 发送 `/newbot` 并按提示完成创建。
3. 安全保存 BotFather 返回的 HTTP API Token。
4. 访问 [my.telegram.org](https://my.telegram.org/)，在 **API development tools** 创建应用并取得 `api_id` 和 `api_hash`。

填写服务器 `.env`：

```dotenv
TELEGRAM_REQUIRED=true
TELEGRAM_BOT_TOKEN=来自 BotFather 的 Token
TELEGRAM_API_ID=数字 API ID
TELEGRAM_API_HASH=API Hash
TELEGRAM_ALLOWED_USER_IDS=123456789
```

重建并启动：

```bash
docker compose up -d --build
docker compose logs --tail=150 backend
curl -fsS http://127.0.0.1:51947/readyz
```

如果 Bot 只是可选能力，可设置 `TELEGRAM_REQUIRED=false`；此时 Bot 故障会显示为 degraded，但不会阻止 Web/API 就绪。

## 2. 限制允许用户

建议显式填写 `TELEGRAM_ALLOWED_USER_IDS`，多个数字 ID 用英文逗号分隔。用户可以通过 `@userinfobot` 查看自己的数字 ID。

如果留空，并且后台还没有任何 Telegram 用户认证成功，系统允许第一个正确输入 Bot PIN 的用户加入允许列表。之后应在 **设置 → Telegram Bot 设置** 中维护允许用户。

首次使用时：

1. 向 Bot 发送 `/start`。
2. 输入 Web 首次初始化时设置的 4 位 Bot PIN。
3. 如果启用了 TOTP，再按提示输入动态验证码。

## 3. 启用账号级下载器（可选）

```bash
docker compose run --rm --no-deps backend npm run login:telegram-user
```

根据交互提示登录你的 Telegram 用户账号。session 默认写入持久卷：

```dotenv
TELEGRAM_USER_SESSION_FILE=/data/telegram_user_session.txt
```

注意：

- 该账号必须已经加入需要读取的频道或群组，并能看到目标历史消息。
- session 等同于登录凭据，不能提交到 GitHub、公开下载或随意复制。
- 如需限制允许抓取的来源，可设置 `TELEGRAM_ALLOWED_SOURCES`。

## 4. 常用命令

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

### 文件与目标

| 命令 | 用途 |
| --- | --- |
| `/list [数量] [页码]` | 查看最近文件和文件 ID |
| `/find [关键词] [筛选]` | 按名称、类型、目录、日期或收藏搜索文件 |
| `/delete <至少8位ID前缀>` | 请求删除指定文件 |
| `/storage_switch` | 切换系统默认存储 |
| `/target [once\|session\|clear] [local\|账户ID]` | 设置当前聊天的一次性/会话级存储目标 |
| `/path_rules` | 打开保存位置面板 |
| `/p <目录>` | 仅下一次下载使用指定目录 |
| `/ps <目录>` | 当前聊天会话持续使用指定目录 |
| `/pc` | 清除自定义目录 |

`/find` 可组合使用 `type:image|video|audio|document`、`folder:目录`、`after:YYYY-MM-DD`、`before:YYYY-MM-DD` 和 `fav`。

### 任务控制与策略

- `/task_pause [任务ID]`
- `/task_resume [任务ID]`
- `/task_cancel <任务ID|all>`
- `/tg_retry [数量] [任务ID]`
- `/download_workers`：设置单文件内部的分片并发
- `/file_concurrency`：设置同时下载的文件数量
- `/duplicate_mode`：设置同名、同目录且同大小文件的处理方式
- `/cleanup_settings`：管理未登记临时文件的自动清理

危险操作会要求单独确认。暂停、取消任务和删除文件不是同一件事。

### 频道抓取与订阅

需要账号级下载器：

- `/tg_download`：打开按日期或标签下载向导
- `/tg_download date <频道> <开始日期> <结束日期>`
- `/tg_download tag <频道> <#标签>`
- `/tg_sub <频道>`：添加或管理订阅
- `/tg_subs`：查看订阅列表
- `/tg_unsub <频道或订阅ID>`：请求取消订阅

大量文件会进入持久化任务队列；使用 `/tasks` 查看，不要重复提交同一个范围。

## 5. 并发建议

两个参数控制不同层级：

- `TELEGRAM_FILE_DOWNLOAD_CONCURRENCY`：同时处理几个文件，支持 `1/2/3/4`
- `TELEGRAM_DOWNLOAD_WORKERS`：单个文件内部的分片 worker，支持 `4/8/12/16`

优先从 `1 × 4` 或默认的 `2 × 4` 开始。提高并发会增加 Telegram FloodWait、服务器磁盘和网络压力；应根据 `/status` 与日志逐步调整。

## 6. 故障排查

```bash
docker compose logs --tail=250 backend
curl -i http://127.0.0.1:51947/readyz
```

- Bot 无响应：检查 Token、API ID/Hash、允许用户和后端日志。
- `/readyz=503`：如果 Telegram 是必需组件，Bot 或账号 session 未就绪会影响 readiness。
- 频道抓取失败：检查用户账号 session、频道成员关系、历史消息权限和来源允许列表。
- 频繁 FloodWait：降低文件级并发和分片 worker 数量。

---

[返回文档中心](./) · [查看 yt-dlp](./ytdlp.html) · [了解任务架构](./architecture.html)
