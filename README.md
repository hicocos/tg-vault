# FoomClous

本地全栈云存储应用

## 技术栈

- **前端**: React + TypeScript + Vite + Tailwind CSS
- **后端**: Node.js + Express + TypeScript
- **数据库**: PostgreSQL
- **容器化**: Docker + Docker Compose

## 快速开始

### 开发模式（本地运行）

#### 1. 启动数据库

```bash
# 使用 Docker 启动 PostgreSQL
docker run -d \
  --name foomclous-postgres \
  -e POSTGRES_DB=foomclous \
  -e POSTGRES_USER=foomclous \
  -e POSTGRES_PASSWORD=foomclous123 \
  -p 5432:5432 \
  postgres:16-alpine

# 初始化数据库表
docker exec -i foomclous-postgres psql -U foomclous -d foomclous < backend/src/db/schema.sql
```

#### 2. 启动后端

```bash
cd backend
npm install
npm run dev
```

后端将在 http://localhost:51947 启动

#### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端将在 http://localhost:5173 启动

### 生产模式（Docker Compose）

```bash
# 构建并启动所有服务
docker-compose up -d --build

# 查看日志
docker-compose logs -f

# 停止所有服务
docker-compose down
```

服务端口：
- 前端: http://localhost:47832
- 后端 API: http://localhost:51947
- PostgreSQL: localhost:5432

## 项目结构

```
FoomClous/
├── frontend/                 # 前端代码
│   ├── src/
│   │   ├── components/      # UI 组件
│   │   ├── services/        # API 服务
│   │   ├── hooks/           # React Hooks
│   │   └── ...
│   ├── Dockerfile
│   └── nginx.conf
├── backend/                  # 后端代码
│   ├── src/
│   │   ├── routes/          # API 路由
│   │   ├── middleware/      # 中间件
│   │   ├── db/              # 数据库
│   │   └── index.ts         # 入口文件
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```

## API 接口

### 文件管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/files` | 获取文件列表 |
| GET | `/api/files/:id` | 获取单个文件信息 |
| GET | `/api/files/:id/preview` | 预览文件 |
| GET | `/api/files/:id/download` | 下载文件 |
| GET | `/api/files/:id/thumbnail` | 获取缩略图 |
| DELETE | `/api/files/:id` | 删除文件 |

### 上传

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/upload` | 上传单个文件 |
| POST | `/api/upload/batch` | 批量上传 |
| POST | `/api/v1/upload/external` | 外部 API 上传（需要 API Key） |

### 存储统计

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/storage/stats` | 获取存储统计 |
| GET | `/api/storage/stats/types` | 获取文件类型统计 |

### 外部 API

外部 API 用于集成第三方应用（如 Telegram Bot）。

请求头：
```
X-API-Key: fc_xxxxxx
```

示例：
```bash
curl -X POST http://localhost:51947/api/v1/upload/external \
  -H "X-API-Key: fc_your_api_key" \
  -F "file=@image.png"
```

## 环境变量

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | PostgreSQL 连接字符串 | `postgresql://foomclous:password@localhost:5432/foomclous` |
| `PORT` | 后端端口 | `51947` |
| `UPLOAD_DIR` | 上传文件目录 | `./data/uploads` |
| `THUMBNAIL_DIR` | 缩略图目录 | `./data/thumbnails` |
| `CORS_ORIGIN` | CORS 来源 | `*` |
| `VITE_API_URL` | 前端 API 地址 | `http://localhost:51947` |

## 功能特性

- ✅ 文件上传（支持拖拽、进度显示）
- ✅ 实时图片预览
- ✅ 自动生成缩略图（WebP 格式）
- ✅ 视频流播放（Range 请求支持）
- ✅ 存储空间统计
- ✅ 外部 API 接口
- ✅ Docker 容器化
- ✅ i18n 国际化支持

## License

MIT
