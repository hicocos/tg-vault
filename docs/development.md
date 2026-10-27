# 开发与发布

[首页](../README.md) · [部署指南](../deploy/DEPLOY.md) · [配置与使用](configuration.md)

## 仓库文件边界

提交源码、行为回归测试、锁文件、部署脚本、脱敏模板及数据库迁移/快照。以下内容仅在本地保留并独立备份，不提交：

- 实际 `.env`、文件数据、Telegram session、密钥和存储凭证。
- 数据库导出、备份、原始日志、依赖、构建产物及缓存。

`.gitignore` 不会取消已跟踪文件或清除历史秘密。不要用 `git clean -fdx` 清理部署目录；Docker 构建上下文另行排除测试与私有数据。

## 独立开发环境

使用独立克隆与开发数据库，不复用生产目录、数据库、文件挂载或 Telegram session。要求：

- Node.js 24 与 npm；两端分别使用自己的锁文件。
- PostgreSQL 16；生成或检查 schema 时还需要相同主版本的 `pg_dump`。
- ffmpeg：运行视频缩略图和转码功能时需要。
- 原生 npm 依赖缺少预编译包时，需要 Python 3、make 和 C/C++ 编译器。

从开发副本根目录安装依赖：

```bash
npm --prefix backend ci
npm --prefix frontend ci
```

在 `backend/.env` 中填写独立开发配置。下面的数据库连接仅展示格式，先创建自己的开发角色、密码与空数据库，再替换连接串；不要复制生产密码。密码含 URL 保留字符时需编码。

```dotenv
DATABASE_URL=postgresql://dev_user:replace-with-dev-password@127.0.0.1:5432/tgvault_dev
CORS_ORIGIN=http://localhost:5173
OAUTH_CALLBACK_BASE_URL=http://localhost:51947
OAUTH_FRONTEND_ORIGIN=http://localhost:5173
COOKIE_SECURE=false
COOKIE_SECURE_FORCE=false
```

后端从进程工作目录读取 `.env`，项目根目录的 Compose `.env` 不会自动成为 `backend/.env`。默认本地数据目录是 `backend/data`。内部密钥会持久保存，不要在重启或升级时替换。

### 初始化与迁移

后端启动只检查数据库版本，不执行 DDL。首次启动及拉取新迁移后，先构建，再在 `backend` 工作目录运行数据库 CLI：

```bash
npm --prefix backend run build
(cd backend && node dist/scripts/database.js status)
(cd backend && node dist/scripts/database.js plan)
(cd backend && node dist/scripts/database.js migrate)
(cd backend && node dist/scripts/database.js check)
```

`status`、`plan`、`check` 只读；只有 `migrate` 写入数据库。任一步失败即停止后续操作。生产升级还必须先备份并停止旧应用写入，参见[部署指南](../deploy/DEPLOY.md#数据库命令与手动升级)。不要手工执行历史 SQL，也不要用 `init.sql` 代替迁移账本。

### 启动开发服务器

分别在两个终端执行：

```bash
npm --prefix backend run dev
```

```bash
VITE_API_URL=http://localhost:51947 npm --prefix frontend run dev -- --host 127.0.0.1
```

访问 `http://localhost:5173`；若 Vite 使用其他端口，同步修改后端 `CORS_ORIGIN` 与 OAuth 前端地址。HTTP Cookie 配置只用于本地开发，不要带入生产，也不要把开发服务器暴露到公网。

## 检查与数据库快照

在独立开发副本根目录执行：

```bash
(cd backend && node --import tsx --test scripts/*.test.ts)
(cd frontend && node --experimental-strip-types --test scripts/*.test.ts)
npm --prefix backend run typecheck
npm --prefix backend run build
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix backend audit --omit=dev --audit-level=high
npm --prefix frontend audit --omit=dev --audit-level=high
```

后端 `build` 不替代类型检查，同时打包数据库 CLI 与迁移资源。回归测试使用合成数据，无需真实 Telegram 或存储账号。

schema 快照检查会创建并删除临时数据库，**必须使用独立、可丢弃的 PostgreSQL 16 服务**，账号需有 `CREATE DATABASE` 权限。不要将它指向生产，即使命令名是 `check`。配置该服务的 `DATABASE_URL` 后运行：

```bash
npm --prefix backend run schema:check
```

`pg_dump` 必须可执行；不在 `PATH` 时通过 `PG_DUMP=/absolute/path/to/pg_dump` 指定。schema 变更使用新的迁移文件，随后运行 `schema:generate`，由 baseline 与迁移重放生成以下三个文件并一起提交：

- `backend/src/db/schema.sql`
- `backend/src/db/snapshot.json`
- 根目录 `init.sql`

不要手工编辑生成文件、修改已发布迁移，或使用旧的“复制 schema”脚本代替迁移重放。升级固定依赖 GramJS 2.26.22 前，必须重新验证下载分片、请求取消、sender 清理和账号隔离；项目适配层使用了其内部 API。

## GitHub 公开发布检查

1. 检查待提交文件与历史中的凭证、session、数据库导出及私有信息；截图与日志也需脱敏。秘密曾提交时先撤销或轮换，再协商清理历史，不能只删当前文件。
2. 提交完整新增源码与行为测试；两端 `package.json`、锁文件根版本及 `CHANGELOG.md` 保持一致。
3. 在无私有配置的干净副本完成上述检查，再以无敏感内容的小文件验证登录、上传与下载。
4. 推送默认分支会在 CI 通过后更新 GHCR `latest`；`v<版本>` 标签发布版本镜像，PR 不推送镜像。CI 同时生成 SBOM 和 provenance；首次发布确认两个 GHCR 包可公开拉取。
5. CI 通过且镜像就绪后创建 GitHub Release，说明取自更新日志对应版本。Fork 须同步修改镜像、部署来源和更新检测仓库。

提交、推送与服务器升级是独立操作；本地整理不会替换运行容器，升级见[部署指南](../deploy/DEPLOY.md)。
