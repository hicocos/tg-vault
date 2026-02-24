#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少必要命令：$1" >&2
    exit 1
  fi
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

need_root_or_sudo() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    if has_cmd sudo; then
      SUDO=(sudo)
    else
      echo "需要 root 权限或 sudo 才能安装依赖。请使用 root 运行，或先安装 sudo。" >&2
      exit 1
    fi
  else
    SUDO=()
  fi
}

detect_os_id() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "${ID:-}"
  else
    echo ""
  fi
}

start_docker_service() {
  if has_cmd systemctl; then
    "${SUDO[@]}" systemctl enable --now docker >/dev/null 2>&1 || "${SUDO[@]}" systemctl start docker >/dev/null 2>&1 || true
    return
  fi
  if has_cmd service; then
    "${SUDO[@]}" service docker start >/dev/null 2>&1 || true
    return
  fi
  if [[ -x /etc/init.d/docker ]]; then
    "${SUDO[@]}" /etc/init.d/docker start >/dev/null 2>&1 || true
  fi
}

install_docker() {
  local os_id
  os_id="$(detect_os_id)"
  echo "检测到系统：${os_id:-unknown}"

  if ! has_cmd mktemp; then
    echo "缺少必要命令：mktemp（自动安装 Docker 需要它）。请先安装 mktemp 后重试。" >&2
    exit 1
  fi

  if has_cmd apk; then
    echo "正在使用 apk 安装 Docker..."
    "${SUDO[@]}" apk add --no-cache docker docker-cli-compose >/dev/null 2>&1 || "${SUDO[@]}" apk add --no-cache docker docker-compose
    start_docker_service
    return
  fi

  if has_cmd apt-get || has_cmd yum || has_cmd dnf; then
    echo "将使用 Docker 官方安装脚本进行安装（需要联网下载）。"
    local installer
    installer="$(mktemp)"
    "${DOWNLOADER[@]}" https://get.docker.com > "${installer}"
    "${SUDO[@]}" sh "${installer}"
    rm -f "${installer}" >/dev/null 2>&1 || true
    start_docker_service
    return
  fi

  echo "无法识别系统包管理器，无法自动安装 Docker。请手动安装后重试。" >&2
  exit 1
}

ensure_docker_and_compose() {
  if ! has_cmd docker; then
    echo "缺少必要命令：docker" >&2
    read -r -p "是否自动安装 Docker？(y/N)：" AUTO_INSTALL
    if [[ "${AUTO_INSTALL}" == "y" || "${AUTO_INSTALL}" == "Y" ]]; then
      need_root_or_sudo
      install_docker
    else
      echo "已取消。请先安装 Docker 后再运行本脚本。" >&2
      exit 1
    fi
  fi

  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker compose)
    return
  fi
  if has_cmd docker-compose; then
    DOCKER_COMPOSE=(docker-compose)
    return
  fi

  echo "缺少必要命令：docker compose（或 docker-compose）" >&2
  read -r -p "是否尝试自动安装 Docker Compose？(y/N)：" AUTO_INSTALL_COMPOSE
  if [[ "${AUTO_INSTALL_COMPOSE}" == "y" || "${AUTO_INSTALL_COMPOSE}" == "Y" ]]; then
    need_root_or_sudo
    install_docker
    if docker compose version >/dev/null 2>&1; then
      DOCKER_COMPOSE=(docker compose)
      return
    fi
    if has_cmd docker-compose; then
      DOCKER_COMPOSE=(docker-compose)
      return
    fi
    echo "Docker Compose 安装后仍不可用，请手动检查：docker compose version" >&2
    exit 1
  fi

  echo "已取消。请先安装 Docker Compose 后再运行本脚本。" >&2
  exit 1
}

require_cmd mkdir
require_cmd rm

if command -v curl >/dev/null 2>&1; then
  DOWNLOADER=(curl -fsSL)
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER=(wget -qO-)
else
  echo "缺少必要命令：curl 或 wget" >&2
  exit 1
fi

ensure_docker_and_compose

REPO_SLUG_DEFAULT="nccttc/foomclous"
BRANCH_DEFAULT="main"

read -r -p "GitHub 仓库（owner/name）[${REPO_SLUG_DEFAULT}]：" REPO_SLUG
REPO_SLUG="${REPO_SLUG:-$REPO_SLUG_DEFAULT}"

read -r -p "分支/标签（Branch/tag）[${BRANCH_DEFAULT}]：" REPO_REF
REPO_REF="${REPO_REF:-$BRANCH_DEFAULT}"

read -r -p "安装目录（绝对或相对路径）[./foomclous]：" INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-./foomclous}"

if [[ -d "${INSTALL_DIR}" ]]; then
  read -r -p "目录 '${INSTALL_DIR}' 已存在。是否删除并重新安装？(y/N)：" REINSTALL
  if [[ "${REINSTALL}" != "y" && "${REINSTALL}" != "Y" ]]; then
    echo "已取消。" >&2
    exit 1
  fi
  rm -rf "${INSTALL_DIR}"
fi

mkdir -p "${INSTALL_DIR}"

require_cmd tar
require_cmd mktemp
require_cmd mv

ARCHIVE_URL="https://codeload.github.com/${REPO_SLUG}/tar.gz/${REPO_REF}"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

TMP_TAR="${TMP_DIR}/src.tar.gz"
${DOWNLOADER[@]} "${ARCHIVE_URL}" > "${TMP_TAR}"

tar -xzf "${TMP_TAR}" -C "${TMP_DIR}"

SRC_DIR="$(find "${TMP_DIR}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "${SRC_DIR}" || ! -d "${SRC_DIR}" ]]; then
  echo "未能在临时目录中定位解压后的源码目录：${TMP_DIR}" >&2
  exit 1
fi

rm -rf "${INSTALL_DIR}"
mv "${SRC_DIR}" "${INSTALL_DIR}"

cd "${INSTALL_DIR}"

read -r -p "请输入 VITE_API_URL（例如 https://cloud.example.com）：" VITE_API_URL
if [[ -z "${VITE_API_URL}" ]]; then
  echo "VITE_API_URL 为必填项。" >&2
  exit 1
fi

read -r -p "请输入 DOMAIN（例如 example.com）：" DOMAIN
if [[ -z "${DOMAIN}" ]]; then
  echo "DOMAIN 为必填项。" >&2
  exit 1
fi

read -r -p "请输入 CORS_ORIGIN（例如 https://cloud.example.com）：" CORS_ORIGIN
if [[ -z "${CORS_ORIGIN}" ]]; then
  echo "CORS_ORIGIN 为必填项。" >&2
  exit 1
fi

read -r -p "请输入 DB_PASSWORD（可留空，将使用 compose 默认值）：" DB_PASSWORD

read -r -p "请输入 ACCESS_PASSWORD_HASH（可选）：" ACCESS_PASSWORD_HASH
read -r -p "请输入 TELEGRAM_BOT_TOKEN（可选）：" TELEGRAM_BOT_TOKEN
read -r -p "请输入 TELEGRAM_API_ID（可选）：" TELEGRAM_API_ID
read -r -p "请输入 TELEGRAM_API_HASH（可选）：" TELEGRAM_API_HASH

if [[ ! -f "./init.sql" ]]; then
  cat > ./init.sql <<'SQL'
CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    size BIGINT NOT NULL,
    mime_type VARCHAR(100),
    path VARCHAR(500) NOT NULL,
    thumbnail_path VARCHAR(500),
    folder_id UUID REFERENCES files(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    access_count INTEGER DEFAULT 0,
    storage_provider VARCHAR(50) DEFAULT 'local',
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_name VARCHAR(100) NOT NULL,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    permissions JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
CREATE INDEX IF NOT EXISTS idx_files_original_name ON files(original_name);
SQL
fi

cat > ./.env <<ENV
DB_PASSWORD=${DB_PASSWORD}
ACCESS_PASSWORD_HASH=${ACCESS_PASSWORD_HASH}
DOMAIN=${DOMAIN}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_API_ID=${TELEGRAM_API_ID}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
ENV

if [[ ! -f "./docker-compose.prod.yml" ]]; then
  cat > ./docker-compose.prod.yml <<YAML
version: '3.8'

services:
  frontend:
    image: foomclous-frontend:latest
    container_name: foomclous-frontend
    ports:
      - "47832:80"
    environment:
      - VITE_API_URL=${VITE_API_URL}
    networks:
      - foomclous-network
    restart: unless-stopped

  backend:
    image: foomclous-backend:latest
    container_name: foomclous-backend
    ports:
      - "51947:51947"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      - DATABASE_URL=postgresql://foomclous:${DB_PASSWORD:-foomclous123}@postgres:5432/foomclous
      - PORT=51947
      - UPLOAD_DIR=/data/uploads
      - THUMBNAIL_DIR=/data/thumbnails
      - CHUNK_DIR=/data/chunks
      - CORS_ORIGIN=${CORS_ORIGIN}
      - ACCESS_PASSWORD_HASH=${ACCESS_PASSWORD_HASH:-}
      - DOMAIN=${DOMAIN}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - TELEGRAM_API_ID=${TELEGRAM_API_ID:-}
      - TELEGRAM_API_HASH=${TELEGRAM_API_HASH:-}
    volumes:
      - file-storage:/data
    networks:
      - foomclous-network
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    container_name: foomclous-postgres
    environment:
      - POSTGRES_DB=foomclous
      - POSTGRES_USER=foomclous
      - POSTGRES_PASSWORD=${DB_PASSWORD:-foomclous123}
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    networks:
      - foomclous-network
    restart: unless-stopped
    healthcheck:
      test: [ "CMD-SHELL", "pg_isready -U foomclous -d foomclous" ]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  file-storage:
    driver: local
  postgres-data:
    driver: local

networks:
  foomclous-network:
    driver: bridge
YAML
fi

echo "正在构建镜像..."
if [[ -f "./frontend/Dockerfile" ]]; then
  docker build --build-arg "VITE_API_URL=${VITE_API_URL}" -t foomclous-frontend:latest ./frontend
else
  echo "未找到 ./frontend/Dockerfile，已跳过前端镜像构建。" >&2
fi

if [[ -f "./backend/Dockerfile" ]]; then
  docker build -t foomclous-backend:latest ./backend
else
  echo "未找到 ./backend/Dockerfile，已跳过后端镜像构建。" >&2
fi

echo "正在启动服务（docker compose up -d）..."
"${DOCKER_COMPOSE[@]}" -f docker-compose.prod.yml up -d

echo "完成。"
echo "打开地址：http://<服务器IP>:47832"
