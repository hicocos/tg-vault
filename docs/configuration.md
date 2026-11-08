# 配置与使用指南

[返回首页](../README.md) · [部署指南](../deploy/DEPLOY.md) · [本地存储位置](local-storage.md)

## 环境变量

部署配置见 [`.env.example`](../.env.example)，容器变量和默认值见 [`docker-compose.yml`](../docker-compose.yml)；日常运行设置在 Web 管理。安装器会自动生成 `.env`。

### 地址、数据库与密钥

| 变量 | 默认值或来源 | 用途 |
| --- | --- | --- |
| `VITE_API_URL` | 安装时填写 | 浏览器访问的 API origin；容器启动时注入前端及 CSP，修改后重建容器即可，无需编译镜像；显式留空使用同源 `/api` 代理 |
| `CORS_ORIGIN` | 安装时填写 | 允许的 Web origin；后端支持英文逗号分隔多个来源，安装器交互仅填写一个 |
| `MCP_PUBLIC_URL` | 安装器按 API 地址补齐 `/mcp` | AI Agent 使用的公开接入地址；已有非空自定义值保留。手动部署需要填写；非本机 HTTP 不自动生成远程接入地址 |
| `PORT` | `51947` | 后端监听及宿主机 API 端口；标准部署建议保留默认值 |
| `DB_PASSWORD` | 安装器生成 64 位十六进制值 | PostgreSQL 密码；已有数据库必须保留原值 |
| `DB_MIGRATION_LOCK_TIMEOUT_MS` | `10000` | 显式迁移的锁等待超时，毫秒 |
| `DB_MIGRATION_STATEMENT_TIMEOUT_MS` | `300000` | 显式迁移的语句超时，毫秒 |
| `SESSION_SECRET` | 新安装由安装器生成 | 文件链接签名及 TOTP 加密密钥 |
| `STORAGE_CREDENTIALS_SECRET` | 新安装由安装器生成 | 存储及敏感配置加密密钥 |
| `TG_VAULT_SECRET_DIR` | `/data/secrets` | 未通过环境变量指定的内部持久密钥目录 |
| `OAUTH_CALLBACK_BASE_URL` | 继承 `VITE_API_URL` | OneDrive/Google Drive 回调 origin |
| `OAUTH_FRONTEND_ORIGIN` | 继承 `CORS_ORIGIN` | OAuth 完成后通知的前端 origin；多来源时显式指定一个 |

Web、API 和 OAuth origin 使用完整的 `http(s)://主机[:端口]`，不带路径、查询、片段或末尾 `/`；`MCP_PUBLIC_URL` 则须以 `/mcp` 结束。生产环境使用同一主域名下的 HTTPS 子域名，以符合登录 Cookie 的 `SameSite=Lax` 策略；CORS 不能替代 Cookie 的同站要求，`CORS_ORIGIN` 不应设为 `*`。

OAuth 登录请求与提供方回调必须使用同一 API 主机；登录 Cookie 只属于设置它的主机，不会因两个子域名同属一个主域名而共享。分域部署须将 `VITE_API_URL` 传入实际前端容器；同源 `/api` 模式须将 `OAUTH_CALLBACK_BASE_URL` 设为 Web origin。检查浏览器加载的 `/runtime-config.js`，不能只看 `.env`。已有的 `OAUTH_CALLBACK_BASE_URL`、`OAUTH_FRONTEND_ORIGIN` 非空值优先于基础域名，改域名时需同步维护。

迁移或备份必须同时保留 `.env`、数据库和完整 `/data`，包括已有 `/data/secrets` 密钥；替换密钥可能使 TOTP 或存储凭证无法解密。构建版本信息由安装器生成，不要在 `.env` 固定 `IMAGE_VERSION`、`SOURCE_REVISION`、`SOURCE_VERSION`。

### 代理与登录安全

| 变量 | Compose 默认值 | 说明 |
| --- | --- | --- |
| `TRUST_PROXY` | `loopback` | Express 信任代理范围；自定义网络部署仅信任实际代理地址，不要盲目设为 `true` |
| `COOKIE_SECURE` | `true` | 仅通过 HTTPS 发送登录 Cookie |
| `COOKIE_SECURE_FORCE` | 空；全新安装器写入 `true` | `true`/`false` 优先于 `COOKIE_SECURE`；只在本地 HTTP 调试中关闭 |
| `JSON_BODY_LIMIT` | `2mb` | JSON 请求体上限，不是文件总大小 |

首次启动没有默认管理员密码。限制 Web 和 API 入口的访问后，通过 HTTPS 创建至少 8 位的强密码，再开放给其他用户。管理员密码以加盐 `scrypt` 哈希保存在数据库；浏览器使用 HttpOnly Cookie 会话。修改类请求校验 `Origin`，因此 Web 地址必须与 `CORS_ORIGIN` 一致。

可在 Web 安全设置或 Bot `/setup_2fa` 启用 TOTP；启用后 Web 与 Bot 都需要二次验证。不要共享二维码或 TOTP 密钥。旧版手工配置的 `TOTP_SECRET` 会覆盖 Web 保存的密钥，改用 Web 管理时需先处理该旧配置。

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
| `ORPHAN_CLEANUP_MIN_AGE_MS` | `600000` | 新文件保护期，默认 10 分钟 |

重复文件策略与自动孤儿清理在 Web「设置 → 维护」管理。重复文件默认保留副本，重名加 `（1）`、`（2）`；选择跳过时，按同账户、同目录、同名、同大小识别。自动孤儿清理处理未登记到数据库的本地文件，新文件仍受保护期约束。

反向代理的请求体上限必须容纳分片与 multipart 开销；代理限制的是单次请求，不是文件总大小。远端存储也需要本地暂存空间，不要把下载并发当作无磁盘的直传模式。不要手工向受管理的 uploads 目录导入未索引文件，自动清理可能删除它们。

保存文件时优先保留原名，同账户、同目录重名时在扩展名前加编号，如 `视频（1）.mp4`；已有文件不自动改名。避免让其他程序同时写入受管理目录，文件命名检查受存储服务的可见范围和覆盖能力限制。

Web 与分片上传按原样接收文件名，`%20` 等字符不会作为 URL 编码解码；显式指定目录保留合法的连续空格与点号。OpenList 原始文件通过后端代理读取，支持 Range；越界范围返回 HTTP 416 和 `Content-Range: bytes */文件大小`。OpenList 不提供用户删除、远端配额和分享管理。

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

## Web 存储设置

- 在「设置 → 存储」搜索账号、测试连接、设为默认或查看详情；本地路径、用量与教程按需展开。
- 「添加存储」按类型填写连接信息。S3、OSS、WebDAV、OpenList 验证后添加，不自动切换默认；OneDrive、Google Drive 授权成功后成为默认。
- 「详情 / 编辑」可更新名称和该存储支持的认证信息，保存后新请求立即使用新凭据，无需删除账户或重启。留空保留原值，密码与令牌不回显；服务地址、根目录和存储桶等目标配置只供查看。
- 切换默认存储不迁移文件，也不改变进行中或已固定目标的任务。
- 移除非默认账号前会预览关联数据；有任务或上传占用时禁止移除。确认后删除连接配置及 TG Vault 关联记录，**不删除远端文件**；默认账号须先切换。

## qBittorrent 扩展

仅支持 TG Vault 与独立 qBittorrent 在同一服务器直接运行，TG Vault 不安装或启动下载器。默认关闭，在「设置 → 常规」启用后显示「BT 下载」入口；关闭仅停止转存调度，不删除记录或停止下载器已有任务。

### 同机目录与 API

设置中仅填写 qBittorrent 的 **WebUI 端口**（1–65535，默认 8080）、账号密码和本地下载目录。后端固定通过 `http://127.0.0.1:<端口>` 连接，不接受 IP、域名或完整 API 地址。qBittorrent 的 WebUI 须允许通过本机回环地址访问，保留其鉴权、Host 与 CSRF 校验。

下载目录默认 `/qBittorrent/download`，须预先创建，允许下载器写入、TG Vault 后端读取。两个服务使用同一个绝对路径；不提供远端/本地路径转换。目标存储、目录与保留做种选项在添加任务时选择。

升级后旧的完整 API 地址不再用于连接，需重新填写并保存本机 WebUI 端口。已有任务仍校验原连接，连接不一致时停止处理。

「测试连接和目录」验证当前填写值，不保存或修改下载器全局设置；保存后才生效，密码留空保留旧值。账号凭证在数据库中加密，密码不返回浏览器。

### 下载、转存与清理

- 支持磁力链接与最大 10 MiB 的 `.torrent` 文件；磁力链接需等待元数据。可选择文件并保留目录结构，开始转存后不能改选；目标账号与目录固定，不随默认存储变化。
- 所选文件全部上传并入库后，默认通过 qBittorrent 删除种子及本地数据；勾选「保留本地文件」则继续做种。**取消会删除该下载器任务及源文件（含未完成文件），不受保留做种选项影响**；已转存文件不删除。删除失败可重试，不会恢复下载或重复转存。
- 下载与转存分别显示进度；完成和取消任务进入历史，移除记录不删除文件或做种任务。
- 失败可重试，已入库文件不重复上传，清理失败只重试清理；重启恢复未结束任务。下载器离线不阻止 TG Vault 启动，已有种子拒绝重复添加，不接管其他任务。
- 本地转存与媒体处理使用独立副本，须预留额外磁盘空间。下载器配置与外部下载目录须另行备份，不包含在 TG Vault `/data` 备份中。

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

Bot 支持自动重连，也可在设置页按当前状态重新连接；个人下载账号独立运行。连接持续失败时查看 Bot 状态和后端日志，避免反复重启打断其他任务。

### 权限与下载限制

| 场景 | 要求与边界 |
| --- | --- |
| 私聊发送文件给 Bot | 启用 Bot 并通过 PIN/允许列表认证；不要求登录个人账号 |
| 频道/群组日期、标签下载与订阅 | 启用有来源访问权限的个人账号；私有来源通常需要先加入，且能读取目标历史消息 |
| 转发媒体 | 启用账号下载且带完整来源与原帖 ID 时，使用个人账号重读原帖；无完整来源或未启用账号下载时使用 Bot。账号读取来源失败会明确报错，不自动改用 Bot 掩盖权限问题 |
| 大文件 | MTProto 与 HTTP Bot API `getFile` 不同，不能直接套用其大小上限；仍受 Telegram 账号类型、文件可用性、来源权限和服务端限制影响，不保证任意大小可下载 |

登录个人账号不会把 Bot 对话消息变成个人账号可读取的消息，也不会绕过受保护内容或不存在/已删除的来源。只归档有权访问和保存的内容，遵守 Telegram 与存储服务条款。遇到 FloodWait 应等待，不要反复重试或增加账号/并发规避限制。

来源解析失败时，先用实际下载账号确认能否读取原帖。账号不会自动加入私有频道，也不会复用其他账号的访问权限。

### 下载、订阅与任务

- `/tg_download` 打开日期或标签下载向导，可选择来源、范围、目录及评论区选项，确认前核对目标；`/tg_sub` 管理自动订阅，`/tg_subs` 查看列表。
- Web **订阅中心 → 新增订阅** 可直接填写频道用户名或链接，选择已通过 Bot 认证的通知用户、固定/跟随全局的存储、相对目录及广告过滤模式；已有订阅可在 Web 修改配置、暂停或恢复。新订阅从当前最新消息之后同步，同一用户重复添加会恢复原订阅并保留游标；修改配置不移动已保存文件，也不改变已有下载任务。
- 每个订阅的 **过滤设置 → 保存／忽略文件类型** 支持不限制、只保存所选类型或忽略所选类型。显式选择优先于全局普通图片跳过设置；修改仅影响后续扫描。
- Web 与 Bot 可暂停、继续、取消和重试。暂停阻止后续下载读取，在途请求或存储写入仍可能完成；服务器冷却不能通过“继续”解除。
- 任务显示处理数量、失败/跳过、保存去向与下载速度。100% 表示已发现条目处理完成，不等于全部成功；扫描总量未知时不显示扫描百分比。排队不表示文件正在传输。
- 多账号按来源权限、冷却与占用调度，一个文件不会跨账号分片。已开始的文件在原账号上遵守限流并保留续传偏移；增加账号不会自动提高全局并发、带宽或存储上传额度。
- 下载并发在 **设置 → 维护 → 高级任务设置** 调整，也可用 `/download_workers` 和 `/file_concurrency`。分片并发默认 4、最高 12；同时文件默认 2、最高 10，可选上限随已启用账号数调整。按磁盘、网络与账号承受能力调整。
- 提高并发会增加内存、网络和暂存占用，不保证速度同比增加。遇到 FloodWait 时按账号等待冷却，任务会自动调整负载。

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
- **OneDrive**：注册 Microsoft **Web** 应用，填写 Client ID、租户（通常为 `common`）及必填的 Client Secret **Value**。微软账号密码只在弹出的微软页面输入，账户名称只是显示备注；后台保存刷新令牌。同一 Client ID 可分别授权多个账户，不覆盖已有账户。当前直连为国际版当前用户 OneDrive，不提供世纪互联、SharePoint site ID 或 OpenList 在线公共应用。
- **Google Drive**：启用 Drive API，配置 OAuth 应用、Client ID/Secret；使用共享云端硬盘时按界面填写其 ID，并确保账号有写入权限。
- **OSS / S3**：准备 bucket、region、访问密钥；S3 还需公网 HTTPS API endpoint，按服务商要求选择 path-style，R2 region 填 `auto`。请求由后端发起，无需为本站配置桶 CORS；当前表单不接受 STS 第三段令牌。使用仅覆盖所需 bucket 的最小权限凭证。
- **WebDAV**：填写 DAV endpoint；仅匿名服务可省略用户名和密码，普通服务填写提供商应用口令。自动协商 Basic / Digest 认证，正确凭据无需额外选择认证方式。默认拒绝不安全或私有地址；WebDAV 内网开关不放宽 S3 / OpenList 原生接入，不忽略 TLS 证书错误。
- **OpenList**：先在 OpenList 挂载好可写目录，填写站点根地址、虚拟根目录及专用 OpenList 用户名 / 密码；不是背后云盘账号，不追加 `/dav`。原生 API 添加时验证写入，不支持游客、手填 Token 或交互式二次验证。

OAuth 提供方登记的 redirect URI 必须与 Web 设置页显示的一致：OneDrive 默认 `https://api.example.com/api/storage/onedrive/callback`，Google Drive 默认 `https://api.example.com/api/storage/google-drive/callback`。改域名时同步修改提供方登记与部署配置。远端存储凭证保存在数据库中并依赖应用密钥解密；本地备份不包含远端对象，远端文件需按提供方另行备份。

授权时允许浏览器打开弹窗；请求失败后重新发起授权，不要复制或分享回调 URL。公网 IPv6 字面地址可用作存储端点，内网、回环与保留 IPv6 地址仍拒绝。

各类存储的字段来源、配置步骤及常见报错，见[存储接入指南](https://tgvault.pages.dev/storage/)。添加账户不会扫描或导入整个远端网盘；连接探测也不等于完整验证读写权限，切换前后应使用无敏感内容的小文件验证上传与下载。

## 本地开发

开发环境、数据库 CLI、回归检查与公开发布检查见[开发与发布](development.md)。请使用独立克隆和开发数据库，不在生产部署目录安装依赖或运行生成命令。
