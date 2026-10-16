# 配置与使用指南

[返回首页](../README.md) · [部署指南](../deploy/DEPLOY.md) · [本地存储位置](local-storage.md)

## 环境变量

完整模板见 [`.env.example`](../.env.example)，容器实际接收的变量和默认值见 [`docker-compose.yml`](../docker-compose.yml)。安装器会生成 `.env`；新安装不要预先复制模板，否则会按已有部署处理存储位置。`.env` 是部署配置，不是应提交的源码。

### 地址、数据库与密钥

| 变量 | 默认值或来源 | 用途 |
| --- | --- | --- |
| `VITE_API_URL` | 安装时填写 | 浏览器访问的 API origin；容器启动时注入前端及 CSP，修改后重建容器即可，无需编译镜像；显式留空使用同源 `/api` 代理 |
| `CORS_ORIGIN` | 安装时填写 | 允许的 Web origin；后端支持英文逗号分隔多个来源，安装器交互仅填写一个 |
| `PORT` | `51947` | 后端监听及宿主机 API 端口；标准部署建议保留默认值 |
| `DB_PASSWORD` | 安装器生成 64 位十六进制值 | PostgreSQL 密码；已有数据库必须保留原值 |
| `SESSION_SECRET` | 新安装由安装器生成 | 文件链接签名及 TOTP 加密密钥 |
| `STORAGE_CREDENTIALS_SECRET` | 新安装由安装器生成 | 存储及敏感配置加密密钥 |
| `TG_VAULT_SECRET_DIR` | `/data/secrets` | 未通过环境变量指定的内部持久密钥目录 |
| `OAUTH_CALLBACK_BASE_URL` | 继承 `VITE_API_URL` | OneDrive/Google Drive 回调 origin |
| `OAUTH_FRONTEND_ORIGIN` | 继承 `CORS_ORIGIN` | OAuth 完成后通知的前端 origin；多来源时显式指定一个 |

地址应是完整的 `http(s)://主机[:端口]`，不带路径、查询、片段或末尾 `/`。生产环境使用 HTTPS，Web/API 建议为同一主域名的子域名，以符合登录 Cookie 的 `SameSite=Lax` 策略；仅设置 CORS 不会使跨站 Cookie 可用。不要把 `CORS_ORIGIN` 设置为 `*`。

已有部署缺少显式应用密钥时，安装器保留 `/data/secrets` 中的密钥，不生成替代值。迁移或备份必须同时保留 `.env`、数据库和完整 `/data`。替换密钥可能使 TOTP 或存储凭证无法解密。不要在 `.env` 固定 `IMAGE_VERSION`、`SOURCE_REVISION`、`SOURCE_VERSION`；安装器从 package 与 Git 临时注入构建元数据。

### 代理与登录安全

| 变量 | Compose 默认值 | 说明 |
| --- | --- | --- |
| `TRUST_PROXY` | `loopback` | Express 信任代理范围；自定义网络部署仅信任实际代理地址，不要盲目设为 `true` |
| `COOKIE_SECURE` | `true` | 仅通过 HTTPS 发送登录 Cookie |
| `COOKIE_SECURE_FORCE` | 空；全新安装器写入 `true` | `true`/`false` 优先于 `COOKIE_SECURE`；只在本地 HTTP 调试中关闭 |
| `JSON_BODY_LIMIT` | `2mb` | JSON 请求体上限，不是文件总大小 |

首次启动没有默认管理员密码。限制 Web 和 API 入口的访问后，通过 HTTPS 创建至少 8 位的强密码，再开放给其他用户。管理员密码以加盐 `scrypt` 哈希保存在数据库；浏览器使用 HttpOnly Cookie 会话。修改类请求校验 `Origin`，因此 Web 地址必须与 `CORS_ORIGIN` 一致。

可在 Web 安全设置或 Bot `/setup_2fa` 启用 TOTP；启用后 Web 与 Bot 都需要二次验证。不要共享二维码或 TOTP 密钥。通常不需要填写 `TOTP_SECRET`，该高级环境值会覆盖数据库中的 TOTP 密钥。

### 数据目录与上传限制

以下路径是**容器内路径**，应保持在持久挂载 `/data` 内。`LOCAL_STORAGE_*` 由安装器维护，不是修改保存位置的快捷方式，详见[存储说明](local-storage.md)。

| 变量 | Compose 默认值 | 说明 |
| --- | --- | --- |
| `UPLOAD_DIR` | `/data/uploads` | 本地文件与下载暂存目录 |
| `THUMBNAIL_DIR` | `/data/thumbnails` | 缩略图 |
| `PREVIEW_DIR` | `/data/previews` | 预览衍生文件 |
| `CHUNK_DIR` | `/data/chunks` | 分片上传暂存 |
| `MAX_UPLOAD_CHUNK_MB` | `32` | 单个上传分片上限（MiB） |
| `MAX_CHUNK_UPLOAD_GB` | `20` | 单次分片上传会话总大小上限（GiB） |
| `CHUNK_GLOBAL_BUDGET_GB` | `40` | 全局分片预算（GiB），不能小于单会话上限 |
| `CHUNK_DISK_RESERVE_GB` | `8` | 分片上传的磁盘保留空间（GiB） |
| `MAX_TOTAL_CHUNKS` | `50000` | 分片数量保护上限 |
| `CHUNK_SESSION_TTL_MS` | `86400000` | 上传会话有效期，默认 24 小时 |
| `CHUNK_COMPLETION_LEASE_MS` | `1800000` | 分片合并完成租约，默认 30 分钟 |
| `DUPLICATE_FILE_MODE` | `copy` | `copy` 生成副本；`skip` 跳过同目录、同名、同大小文件 |
| `AUTO_CLEANUP_ORPHANS` | `true` | 清理未登记到数据库的本地孤儿文件；也可在 Web/Bot 维护设置中管理 |
| `ORPHAN_CLEANUP_MIN_AGE_MS` | `600000` | 新文件保护期，默认 10 分钟 |

反向代理的请求体上限必须容纳分片与 multipart 开销；代理限制的是单次请求，不是文件总大小。远端存储也需要本地暂存空间，不要把下载并发当作无磁盘的直传模式。不要手工向受管理的 uploads 目录导入未索引文件，自动清理可能删除它们。

### 存储连接与日志

| 变量 | Compose 默认值 | 说明 |
| --- | --- | --- |
| `ALLOW_INSECURE_STORAGE_ENDPOINTS` | `false` | 保持默认，避免开放不安全存储地址 |
| `STORAGE_PROBE_TIMEOUT_MS` | `15000` | 存储探测超时 |
| `WEBDAV_INACTIVITY_TIMEOUT_MS` | `300000` | WebDAV 无活动超时 |
| `WEBDAV_UPLOAD_TIMEOUT_MS` | `21600000` | WebDAV 上传总超时，默认 6 小时 |
| `LOG_LEVEL` | `info` | 应用日志级别 |
| `SQL_LOG_SLOW_MS` | `500` | 慢查询日志阈值 |
| `SQL_LOG_ALL` | `false` | 全量 SQL 日志，仅排障时按需启用 |
| `UPDATE_CHECK_ENABLED` | `true` | 是否向 GitHub 查询新版本；设为 `false` 关闭自动检测 |
| `UPDATE_CHECK_REPOSITORY` | `hicocos/tg-vault` | 更新检测使用的公开 GitHub 仓库，格式为 `owner/repo` |

不要公开原始日志、请求头、数据库导出或调试归档。提供问题报告前，移除凭证、session、用户/聊天标识、文件名和私有服务器路径。

## Telegram 配置与能力

### 连接 Bot 与个人账号

本项目通过 GramJS/MTProto 连接 Telegram；Bot 配置也需要 API ID 与 API Hash，而不只是 Bot Token。

1. 向 [@BotFather](https://t.me/BotFather) 发送 `/newbot` 创建 Bot，取得 Token。
2. 在 [my.telegram.org](https://my.telegram.org) 的 `API development tools` 创建应用，取得 `api_id` 与 `api_hash`。
3. 在 Web **设置 → Telegram → Telegram Bot 连接** 中填写三项凭证，测试连接、设置 4 位数字 Bot PIN，再保存并启用。
4. 在 **Telegram Bot 用户权限** 中预先填写允许使用 Bot 的数字 user ID，多个 ID 用英文逗号分隔，然后向 Bot 发送 `/start` 完成认证。
5. 需要频道/群组批量转存或订阅时，在同页通过手机号、验证码和可选的两步验证密码登录个人 Telegram 账号；无需手工生成 session 文件。

PIN 不是用户允许列表的替代品。如果允许列表为空且没有已认证的 Telegram 用户，第一个正确输入 PIN 的用户可自动加入。不要在允许列表未设置时公开 Bot/PIN。环境变量 `TELEGRAM_ALLOWED_USER_IDS` 非空时优先于 Web 列表，并禁止在 Web 修改；新部署应统一使用 Web。Bot 凭证的 Web 设置优先于环境凭证，不要同时维护两套凭证。

Token、API Hash、手机号验证码、两步验证密码和登录 session 都是秘密。session 可用于访问 Telegram 账号；只通过自己的 HTTPS 管理页面登录，不要提交到仓库、粘贴到 issue 或共享备份。丢失或泄露后，应在 Telegram 中撤销相关会话，并按需撤销/更换 Bot 凭证。

### 权限与下载限制

| 场景 | 要求与边界 |
| --- | --- |
| 私聊发送文件给 Bot | 启用 Bot 并通过 PIN/允许列表认证；不要求登录个人账号 |
| 频道/群组日期、标签下载与订阅 | 启用有来源访问权限的个人账号；私有来源通常需要先加入，且能读取目标历史消息 |
| 转发媒体 | 有可重读原始来源时可以使用具备访问权限的个人账号；没有可读来源时仍走 Bot 下载 |
| 大文件 | MTProto 与 HTTP Bot API `getFile` 不同，不能直接套用其大小上限；仍受 Telegram 账号类型、文件可用性、来源权限和服务端限制影响，不保证任意大小可下载 |

登录个人账号不会把 Bot 对话消息变成个人账号可读取的消息，也不会绕过受保护内容或不存在/已删除的来源。只归档有权访问和保存的内容，遵守 Telegram 与存储服务条款。遇到 FloodWait 应等待，不要反复重试或增加账号/并发规避限制。

### 下载、订阅与任务

- `/tg_download` 打开日期或标签下载向导，可选择来源、范围、目录及评论区选项，确认前核对目标；`/tg_sub` 管理自动订阅，`/tg_subs` 查看列表。
- Web 与 Bot 可暂停、继续、取消和重试。暂停阻止后续下载读取，在途请求或存储写入仍可能完成；服务器冷却不能通过“继续”解除。
- 任务显示处理数量、失败/跳过、保存去向与下载速度。100% 表示已发现条目处理完成，不等于全部成功；扫描总量未知时不显示扫描百分比。排队不表示文件正在传输。
- 多账号按来源权限、冷却与占用调度，一个文件不会跨账号分片。已开始的文件在原账号上遵守限流并保留续传偏移；增加账号不会自动提高全局并发、带宽或存储上传额度。
- 下载并发在 **设置 → 维护 → 高级任务设置** 调整，也可用 `/download_workers` 和 `/file_concurrency`。分片默认 4，范围 1–16；同时文件默认 2，允许 1–10，实际最高为 `min(10, max(2, 已启用账号数 × 2))`。保持默认值，按磁盘、网络与账号承受能力调整。
- 账号共享冷却，普通 FloodWait 只等待；单次服务端等待达到 1 小时才触发减半降载，后续成功读取逐步恢复。扫描按账号串行并限速；用户命令限流与扫描限速不是同一设置。

新部署的 Telegram 运行设置在 Web 管理。高级/兼容环境参数默认值见 Compose；常用项如下（单位 `_MS` 为毫秒）：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TELEGRAM_REQUIRED` | `false` | 是否将 Bot 可用性纳入服务就绪条件 |
| `TELEGRAM_RATE_WINDOW_MS` / `TELEGRAM_RATE_MAX` | `60000` / `30` | 普通命令限流 |
| `TELEGRAM_HEAVY_RATE_WINDOW_MS` / `TELEGRAM_HEAVY_RATE_MAX` | `600000` / `5` | 重型命令限流 |
| `TELEGRAM_PIN_FAIL_WINDOW_MS` / `TELEGRAM_PIN_FAIL_MAX` / `TELEGRAM_PIN_LOCK_MS` | `900000` / `5` / `900000` | PIN 错误尝试保护 |
| `TELEGRAM_SUBSCRIPTION_INTERVAL_MS` / `TELEGRAM_SUBSCRIPTION_SCAN_LIMIT` | `300000` / `100` | 订阅扫描间隔与条数 |
| `TELEGRAM_COMMENTS_MAX_PER_POST` | `200` | 每条主帖评论扫描上限 |
| `TG_JOB_SCAN_SEGMENT_SIZE` | `100` | 频道任务扫描分页大小 |
| `TG_JOB_MAX_ATTEMPTS` | `3` | 后台条目尝试上限 |
| `TG_MIN_FREE_DISK_GB` | `8` | Telegram 下载磁盘保留空间（GiB） |
| `TG_DISK_WATERMARK_RECHECK_MS` / `TG_DISK_WATERMARK_MAX_WAIT_MS` | `30000` / `0` | 空间不足时复查间隔与最长等待；`0` 不设置等待超时 |
| `TG_STATUS_DEBUG` | `0` | 本地状态调试日志，日常保持关闭 |

## 添加存储

在 **设置 → 存储** 添加账户并选择默认目标；任务提交前确认保存账户与目录。切换默认存储不等于迁移已有文件。

- **本地磁盘**：路径由部署挂载决定，Web 只读展示；参见[本地存储位置](local-storage.md)。
- **OneDrive**：创建 Microsoft 应用，填写 Client ID、租户与按需使用的 Client Secret，再完成 OAuth 授权。
- **Google Drive**：启用 Drive API，配置 OAuth 应用、Client ID/Secret；使用共享云端硬盘时按界面填写其 ID，并确保账号有写入权限。
- **OSS / S3**：准备 bucket、region、访问密钥；S3 还需 endpoint，按服务商要求选择 path-style。使用仅覆盖所需 bucket 的最小权限凭证。
- **WebDAV**：填写 endpoint、用户名和密码。默认拒绝不安全或私有地址；仅在明确理解 SSRF/内网访问风险时调整安全设置，不要为了连接失败盲目放开限制。

OAuth 提供方登记的 redirect URI 必须与 Web 设置页显示的一致：OneDrive 默认 `https://api.example.com/api/storage/onedrive/callback`，Google Drive 默认 `https://api.example.com/api/storage/google-drive/callback`。改域名时同步修改提供方登记与部署配置。远端存储凭证保存在数据库中并依赖应用密钥解密；本地备份不包含远端对象，远端文件需按提供方另行备份。

## 本地开发

使用 Node.js 24、npm 和可访问的 PostgreSQL；ffmpeg 用于视频缩略图/转码。两个子项目均有独立锁文件，先执行首页的 `npm --prefix ... ci`。后端从其工作目录读取 `.env`，容器根目录 `.env` 不会自动成为本地后端配置。

1. 创建独立开发数据库，在 `backend/.env` 设置真实的开发 `DATABASE_URL`，不要连接生产库；后端启动会初始化 schema 并应用迁移。
2. 设置 `CORS_ORIGIN=http://localhost:5173`、`OAUTH_CALLBACK_BASE_URL=http://localhost:51947`、`OAUTH_FRONTEND_ORIGIN=http://localhost:5173`。本地 HTTP 使用 `COOKIE_SECURE=false`，确保 `COOKIE_SECURE_FORCE` 未开启；数据目录可用默认的 `backend/data`。
3. 在一个终端运行 `npm --prefix backend run dev`；另一个终端运行 `VITE_API_URL=http://localhost:51947 npm --prefix frontend run dev -- --host 127.0.0.1`。若 Vite 使用了其他端口，同步修改前端 origin。不要将开发服务器暴露给公网。

本地检查入口：`npm --prefix backend run typecheck`、`npm --prefix backend run schema:check`、两端 `run build`、`npm --prefix frontend run lint`。后端 `run build` 使用 esbuild，不替代 TypeScript 类型检查。schema 变更后使用 `npm --prefix backend run schema:generate-init` 更新根目录快照，不要手工改写生成文件或已发布迁移。执行哪些检查取决于变更范围；提交时只报告实际执行的结果。
