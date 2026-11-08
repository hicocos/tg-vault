# v3.0.0

2026-11-08 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v3.0.0)

## 新增

- **MCP AI 接入**：支持远程 Streamable HTTP 与本地 stdio，让 AI Agent 搜索文件和目录、读取文本、生成下载与预览链接，以及改名、移动、收藏和删除文件。
- **AI 任务与归档**：支持查询进度、暂停、继续、取消和重试任务，创建、编辑、启停和同步订阅，并按日期或标签提交 Telegram 历史归档。
- **AI 文件上传**：支持直接上传、分块上传、断点续传和内容校验，可查询上传状态、核对中断后的结果，减少重复传输。
- **「AI 接入」管理页**：可分别设置客户端权限、存储账户和有效期，生成或撤销令牌、验证连接并查看调用记录；写操作支持请求去重与操作预览。
- **一键安装入口**：新增根目录 `install.sh`，支持自动下载项目、指定安装目录和更新已有部署。
- **中文文档站**：提供部署、Telegram、存储、MCP 和日常运维教程，支持全文搜索与移动端浏览，可从应用「关于」页直接访问。

## 改进与修复

- 新增毛玻璃外观，更新深浅色界面与项目标识，统一操作按钮样式并改进「关于」页面。
- 存储账户详情支持直接更新认证信息并保留已有文件关联，修复 OneDrive 凭据刷新覆盖新配置的问题。
- 改进 Telegram 暂停、恢复和归档调度，细化下载、上传、等待上传及重试进度，修正任务目标账户的存储冷却判断。
- 修复并发转存和同名文件写入问题，避免覆盖已有文件；正确保留 `%20` 等字面文件名及目录中的连续空格、点号。
- Google Drive 删除改为移入回收站，并撤销文件自身的公开分享。
- 修复 OpenList 越界读取被误报为存储不可用的问题，完善 HTTP 416 响应与反代 Range 转发。
- 更新后端安全依赖，修复路径匹配与查询参数相关漏洞，发布检查拦截中危及以上告警。

## 升级

在项目目录运行：

```bash
./deploy/install.sh
```

# v2.6.0

2026-10-27 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.6.0)

- 新增可选的同机 qBittorrent 扩展，支持磁力链接、种子文件、文件选择和下载后转存，可选择保留做种。
- 完善下载与转存进度、失败重试和重启恢复，优化存储配置与移动端操作。
- 更新 HTTP 安全依赖，修复拒绝服务与跨源重定向凭据泄露问题。

升级前备份 `.env`、数据库和完整文件数据。qBittorrent 默认关闭，需自行部署下载器；下载目录另行备份。见[扩展配置](docs/configuration.md#qbittorrent-扩展)。

# v2.5.0

2026-10-19 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.5.0)

- Web 支持创建、编辑和恢复频道订阅，配置通知用户、存储与文件类型过滤。
- 改进 Telegram 连接恢复、断点续传及批量下载，完善下载并发和资源管理。
- 修复 OneDrive、Google Drive 分域授权，支持多个 OneDrive 账户及 WebDAV Basic / Digest 认证。
- 数据库改为独立迁移；部署支持 amd64 / arm64 预构建镜像和容器启动时配置 API 地址。

此版本起须在应用启动前完成独立数据库迁移。安装器会自动处理，手动升级见[部署指南](deploy/DEPLOY.md#数据库命令与手动升级)。

# v2.4.9

2026-10-16 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.4.9)

- 改进 Telegram 多账号下载隔离、来源权限校验、断线恢复与冷却处理，支持失效账号重新登录。
- 批量下载支持扫描后按文件类型选择，任务中心可分页查看失败文件与原因。
- 完善 OneDrive、Google Drive 上传恢复，修复 API 代理与安全响应头配置。
- 前端升级至 Tailwind CSS 4，更新依赖并改进部署兼容性。

# v2.4.8

2026-10-14 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.4.8)

- 完善频道下载向导，支持确认前修改范围与目录；统一 Web 与 Bot 的暂停、继续、取消和重试。
- 改进扫描进度、多账号调度和失败任务恢复，新增存储账户详情与重命名。
- 容器升级至 Node.js 24 LTS；移除 Bot 的 /list、/find，文件浏览和搜索统一使用 Web。

# v2.4.7

2026-10-04 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.4.7)

- 修复频道下载向导失效判断，完善 Bot 离线提示与连接诊断。
- 优化媒体预览缓存、磁盘占用和多语言界面。

# v2.4.6

2026-09-15 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.4.6)

- 更新文件、上传、任务、订阅和设置界面，新增外观与背景设置，改善移动端及多语言体验。
- 订阅中心支持暂停、恢复和删除；改进 Bot 重连、媒体流和云存储文件操作。

# v2.4.5

2026-09-13 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.4.5)

- 修复 Telegram 任务暂停、恢复后的进度更新，优化 Web 下载进度与速度显示。
- 改进本地存储空间展示、多语言界面及安装升级流程。

# v2.4.3

2026-09-06 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.4.3)

- 简化安装与升级流程，更新前检查 GitHub；发现本地修改或无法快进时停止，保留现有文件。

# v2.4.2

2026-09-05 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.4.2)

- Web 与 Telegram Bot 支持简体中文、英文和俄语，完善语言选择与移动端体验。
- Telegram 凭证和运行设置统一由 Web 管理，增强账号、订阅和任务的生命周期管理。
- 移除 yt-dlp 媒体链接下载功能及其遗留配置和任务。

# v2.4.1

2026-09-01 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.4.1)

- 强化 Bot 与个人账号的启动隔离，恢复已启用账号及频道后台任务时分阶段连接。
- 改进 Bot 凭证检测与命令菜单同步，修复改密码时误退出登录及清理任务重复启动。

# v2.4.0

2026-09-01 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.4.0)

- 收紧 Bot 凭证、会话与个人账号的生命周期边界，避免更换凭证时触发非预期操作。
- 个人账号改为显式激活；该版本不再随 Bot 启动自动执行订阅扫描、任务恢复和定期清理。
- 完善连接超时、失败清理与失效凭证提示，Bot 可选模式下离线仍可使用 Web。

# v2.3.1

2026-08-31 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.3.1)

- 新增 Web 订阅中心、广告过滤规则与误判纠正，支持按订阅查看同步状态。
- 新增跳过频道普通图片设置；广告过滤与跳过图片默认关闭，保留原有下载行为。

# v2.3.0

2026-08-29 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.3.0)

- Telegram 个人账号支持二维码和手机号登录、多账号管理与来源调度。
- 新增可恢复的缩略图和预览生成队列、增量数据库迁移及搜索索引。
- 改进存储清理、媒体代理、Bot 认证和移动端操作。

# v2.2.1

2026-08-27 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.2.1)

- 修复 HTTP 环境下分片上传的哈希计算，续传前核对内容以避免误用上传会话。
- 修复加密配置下的管理员改密，改进安装器兼容性和生产 Cookie 配置。

# v2.2.0

2026-08-27 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.2.0)

- 新增 OpenList 原生存储接入和 GitHub 版本更新提醒。
- 修复文件搜索、分页、目录整理及存储切换的一致性问题。
- 加强 OAuth、外部请求安全和任务管理，完善移动端与部署配置。

# v2.1.1

2026-08-26 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.1.1)

- 修复各存储上传、存储账户删除确认及失效会话处理，避免异常导致服务重启。
- 任务中心支持按存储账户过滤，改进上传失败提示。

# v2.1.0

2026-08-26 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.1.0)

- 新增 Telegram Bot 网页管理和个人账号网页登录，加密保存凭证与会话。
- 新增 Web 媒体链接下载任务及下载明细保留策略。
- 新增交互式安装向导与非交互部署，移除废弃的 AI / pgvector 依赖。
- 改善上传与移动端体验，修复 HTTP 依赖的凭据泄露问题。

# v2.0.5

2026-08-25 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.0.5)

- 新增独立上传中心，整合文件分类，改善列表缓存与移动端布局。
- 增加 WebDAV 私有网络访问策略及安全校验。

# v2.0.4

2026-08-25 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.0.4)

- 统一存储账户连接测试的加载状态和结果反馈，在对应账户卡片中直接显示。

# v2.0.3

2026-08-25 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.0.3)

- 修复连续执行任务时成功提示的显示和自动关闭。

# v2.0.2

2026-08-25 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.0.2)

- 加强媒体链接、流式响应、Cookie 与构建配置安全。
- 修复 Telegram 相册并发、通知及 WebDAV 清理，改进主题切换、登录和操作反馈。

# v2.0.1

2026-08-25 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.0.1)

- 改进 Web 路由、任务管理和媒体预览，统一版本信息并完善构建部署。

# v2.0.0

2026-08-25 · [GitHub Release](https://github.com/hicocos/tg-vault/releases/tag/v2.0.0)

- 首个稳定版，提供 Web 与 Telegram 文件管理、本地及多种云存储接入。
- 支持文件夹、多文件上传、缩略图、批量操作、分享和下载队列，提供 Docker Compose 部署。
