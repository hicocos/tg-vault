# 开发与发布

[首页](../README.md) · [部署指南](../deploy/DEPLOY.md) · [配置与使用](configuration.md)

## 仓库文件边界

| 路径 | 内容 | 是否提交 |
| --- | --- | --- |
| `backend/src/`、`frontend/src/` | 应用源码、数据库 baseline、迁移与快照 | 是 |
| `backend/scripts/`、`frontend/scripts/` | 构建、运行支持脚本与行为回归测试 | 是 |
| `deploy/`、`docs/`、`.github/` | 部署工具、使用文档与发布流水线 | 是 |
| `package.json`、`package-lock.json`（两端） | 依赖声明与锁文件 | 是 |
| `.env.example`、Compose、Dockerfile、`init.sql` | 脱敏配置模板、构建入口与生成的 schema 快照 | 是 |
| `.env`、`backend/.env`、`frontend/.env*` | 实际地址、数据库连接与部署密钥 | 否 |
| `data/`、`backend/data/`、备份与 session 文件 | 文件数据、账号会话和持久密钥 | 否；必须保留并独立备份 |
| `node_modules/`、`dist/`、覆盖率、缓存与日志 | 本地生成内容 | 否 |

`.gitignore` 不会取消已经跟踪的文件，也不会清除历史提交中的秘密。不要用 `git clean -fdx` 清理部署目录：被忽略的数据、配置和密钥也可能被删除。测试属于源码，不应因清理工作区而丢弃；Docker 构建上下文单独排除测试、运行数据和本地配置。

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

后端 `build` 使用 esbuild，不替代 TypeScript 类型检查；它同时打包数据库 CLI、baseline、迁移和快照清单。回归测试使用合成数据和注入的客户端，不需要真实 Telegram 账号。测试覆盖资源限制、Bot 断线清理、下载恢复、来源权限、OAuth 弹窗验证与重连判定。

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

1. 检查待提交文件和历史：不得包含实际 `.env`、Telegram session、私钥、存储凭证、数据库导出、原始日志或私有文件。截图与问题报告也需移除手机号、用户/聊天标识、真实域名和服务器私有路径。
2. 若秘密曾提交，先撤销或轮换凭证，再处理所有受影响历史及远端副本；仅删除当前文件或补 `.gitignore` 不足以补救。不要未经协商强推改写历史。
3. 提交所有新增源码、迁移、快照和行为测试；确认文档链接、两端版本和锁文件一致。不要通过提交依赖或编译产物让构建“可用”。
4. 在无私有配置、无预装依赖的干净副本执行上述检查，再用无敏感内容的小文件验证实际上传、下载和登录流程。
5. GitHub Actions 的 `quality` 作业使用独立 PostgreSQL，并依次运行依赖审计、回归、schema/typecheck/lint/build。全部通过后才构建镜像；PR 不推送镜像，默认分支更新 `latest`，`v*` 标签生成版本标签。发布产物还包含 CycloneDX SBOM、镜像 SBOM 与 provenance。
6. 首次发布需在 GitHub 确认前后端 GHCR 包可公开拉取。Fork 发布前同步修改工作流镜像命名、Compose、安装器中的仓库/镜像地址和更新检查仓库；不要假设 Fork 会自动切换部署来源。

未提交的整理不会改变现有运行容器。发布源码、推送 Git 和替换服务器容器是不同操作，部署流程见[部署指南](../deploy/DEPLOY.md)。
