#!/usr/bin/env bash
set -euo pipefail

NON_INTERACTIVE=false
case "${1:-}" in
  "") ;;
  --non-interactive) NON_INTERACTIVE=true ;;
  -h|--help)
    cat <<'EOF'
用法：./deploy/install.sh [--non-interactive]

默认先检测服务器环境；缺少组件时由用户选择自动补全、查看提示或退出，随后只询问 Web 前端 URL 和后端 API URL。
首次部署会创建 `.env` 并生成密钥；已有部署会显示当前地址，按 Enter 保留即可。
--non-interactive  不等待输入；从现有 .env 或同名环境变量读取地址，缺少配置时退出。
EOF
    exit 0
    ;;
  *)
    echo "未知参数：$1；使用 --help 查看用法。" >&2
    exit 2
    ;;
esac

if [[ "$NON_INTERACTIVE" == false && ! -t 0 ]]; then
  echo "当前没有交互式终端；请在终端中运行，或使用 --non-interactive。" >&2
  exit 2
fi

detect_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    printf 'apt'
  elif command -v dnf >/dev/null 2>&1; then
    printf 'dnf'
  elif command -v yum >/dev/null 2>&1; then
    printf 'yum'
  else
    printf 'unsupported'
  fi
}

run_privileged() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "需要管理员权限，但当前不是 root 且未找到 sudo。" >&2
    return 1
  fi
}

install_missing_packages() {
  local manager="$1"
  shift
  case "$manager" in
    apt)
      run_privileged apt-get update
      run_privileged apt-get install -y "$@"
      ;;
    dnf) run_privileged dnf install -y "$@" ;;
    yum) run_privileged yum install -y "$@" ;;
    *) return 1 ;;
  esac
}

check_environment() {
  local missing=()
  command -v docker >/dev/null 2>&1 || missing+=(docker)
  if command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
    missing+=(compose)
  fi
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  command -v git >/dev/null 2>&1 || missing+=(git)

  echo "服务器环境检测"
  printf '  %-24s %s\n' "Docker Engine" "$([[ ! " ${missing[*]} " =~ " docker " ]] && echo '✓ 已安装' || echo '✗ 缺失')"
  printf '  %-24s %s\n' "Docker Compose 插件" "$([[ ! " ${missing[*]} " =~ " compose " ]] && echo '✓ 已安装' || echo '✗ 缺失')"
  printf '  %-24s %s\n' "Python 3" "$([[ ! " ${missing[*]} " =~ " python3 " ]] && echo '✓ 已安装' || echo '✗ 缺失')"
  printf '  %-24s %s\n' "Git" "$([[ ! " ${missing[*]} " =~ " git " ]] && echo '✓ 已安装' || echo '✗ 缺失')"

  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "环境检测通过。"
    return 0
  fi

  echo
  echo "缺少必需环境：${missing[*]}"
  if [[ "$NON_INTERACTIVE" == true ]]; then
    echo "非交互模式不会自动修改服务器环境；请先安装缺失项后重试。" >&2
    exit 1
  fi

  local manager choice
  manager="$(detect_package_manager)"
  if [[ "$manager" == unsupported ]]; then
    echo "未识别受支持的包管理器（apt/dnf/yum），请手动安装缺失项后重试。" >&2
    exit 1
  fi

  echo "请选择处理方式："
  echo "  1) 自动安装缺失环境（推荐）"
  echo "  2) 显示手动处理提示并退出"
  echo "  q) 退出"
  while true; do
    printf '> '
    IFS= read -r choice
    case "${choice,,}" in
      1|"") break ;;
      2)
        echo "请安装 Docker Engine、Docker Compose 插件、Python 3 和 Git 中的缺失项后重新运行。"
        exit 0
        ;;
      q) echo "已退出，未修改服务器环境。"; exit 0 ;;
      *) echo "请输入 1、2 或 q。" >&2 ;;
    esac
  done

  local packages=()
  for item in "${missing[@]}"; do
    case "$manager:$item" in
      apt:docker) packages+=(docker.io) ;;
      apt:compose) packages+=(docker-compose-plugin) ;;
      apt:python3) packages+=(python3) ;;
      apt:git) packages+=(git) ;;
      dnf:docker|yum:docker) packages+=(docker) ;;
      dnf:compose|yum:compose) packages+=(docker-compose-plugin) ;;
      dnf:python3|yum:python3) packages+=(python3) ;;
      dnf:git|yum:git) packages+=(git) ;;
    esac
  done
  install_missing_packages "$manager" "${packages[@]}"

  if [[ "${INSTALL_TEST_SKIP_ENV_RECHECK:-false}" == true ]]; then
    echo "测试模式：已记录缺失环境安装命令。"
    exit 1
  fi

  local still_missing=()
  command -v docker >/dev/null 2>&1 || still_missing+=(docker)
  if command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
    still_missing+=(compose)
  fi
  command -v python3 >/dev/null 2>&1 || still_missing+=(python3)
  command -v git >/dev/null 2>&1 || still_missing+=(git)
  if [[ ${#still_missing[@]} -gt 0 ]]; then
    echo "自动安装后仍缺少：${still_missing[*]}。请按系统提示完成 Docker 官方安装后重试。" >&2
    exit 1
  fi
  echo "缺失环境已补全。"
}

if [[ ! -f docker-compose.yml ]]; then
  echo "请从包含 docker-compose.yml 的项目目录运行 deploy/install.sh。" >&2
  exit 1
fi

check_environment

normalize_origin() {
  python3 - "$1" <<'PY'
from urllib.parse import urlsplit
import sys
value = sys.argv[1].strip()
parsed = urlsplit(value)
if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
    raise SystemExit(1)
print(f'{parsed.scheme}://{parsed.netloc}')
PY
}

prompt_origin() {
  local label="$1"
  local example="$2"
  local current="$3"
  local entered normalized
  while true; do
    echo >&2
    echo "$label" >&2
    if [[ -n "$current" && "$current" != *example.com* ]]; then
      echo "当前值：$current" >&2
      printf '直接按 Enter 保留当前值：' >&2
    else
      echo "示例：$example" >&2
      printf '> ' >&2
    fi
    IFS= read -r entered
    entered="${entered:-$current}"
    if normalized="$(normalize_origin "$entered")"; then
      printf '%s' "$normalized"
      return 0
    fi
    echo "地址无效。请输入完整的 http(s) origin，不能包含路径、查询参数或片段。" >&2
  done
}

confirm_install() {
  local choice
  while true; do
    echo
    echo "配置确认"
    echo "Web 前端 URL：$CORS_ORIGIN_VALUE"
    echo "后端 API URL：$VITE_API_URL_VALUE"
    echo
    printf '按 Enter 保存配置并开始安装，输入 e 重新编辑，输入 q 退出：'
    IFS= read -r choice
    case "${choice,,}" in
      "") return 0 ;;
      e) return 1 ;;
      q) echo "已取消，未保存配置或启动服务。"; exit 0 ;;
      *) echo "请输入 Enter、e 或 q。" >&2 ;;
    esac
  done
}

upsert_env() {
  local key="$1"
  local value="$2"
  local temp
  temp="$(mktemp)"
  python3 - "$key" "$value" .env "$temp" <<'PY'
from pathlib import Path
import sys
key, value, source, target = sys.argv[1:]
path = Path(source)
lines = path.read_text().splitlines() if path.exists() else []
replacement = f'{key}={value}'
updated = []
found = False
for line in lines:
    if line.startswith(f'{key}='):
        if not found:
            updated.append(replacement)
            found = True
        continue
    updated.append(line)
if not found:
    updated.append(replacement)
Path(target).write_text('\n'.join(updated) + '\n')
PY
  chmod 600 "$temp"
  mv "$temp" .env
}

read_env() {
  local key="$1"
  python3 - "$key" .env <<'PY'
from pathlib import Path
import sys
key = sys.argv[1]
for line in Path(sys.argv[2]).read_text().splitlines():
    if line.startswith(f'{key}='):
        print(line.split('=', 1)[1], end='')
        break
PY
}

ensure_generated_secret() {
  local key="$1"
  if [[ -z "$(read_env "$key")" ]]; then
    upsert_env "$key" "$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
}

remove_env_keys() {
  local temp
  temp="$(mktemp)"
  python3 - .env "$temp" "$@" <<'PY'
from pathlib import Path
import sys
source, target, *keys = sys.argv[1:]
blocked = set(keys)
lines = Path(source).read_text().splitlines() if Path(source).exists() else []
kept = [line for line in lines if line.split('=', 1)[0] not in blocked]
Path(target).write_text('\n'.join(kept) + ('\n' if kept else ''))
PY
  chmod 600 "$temp"
  mv "$temp" .env
}

created_env=false
CURRENT_CORS_ORIGIN=""
CURRENT_VITE_API_URL=""
if [[ -f .env ]]; then
  CURRENT_CORS_ORIGIN="$(read_env CORS_ORIGIN)"
  CURRENT_VITE_API_URL="$(read_env VITE_API_URL)"
else
  created_env=true
fi

if [[ "$NON_INTERACTIVE" == true && "$created_env" == false ]]; then
  # Existing installations treat .env as the source of truth. Ambient shell variables
  # are often staging/audit overrides and must never silently rewrite production.
  if [[ -n "${CORS_ORIGIN:-}" && -n "$CURRENT_CORS_ORIGIN" && "$CORS_ORIGIN" != "$CURRENT_CORS_ORIGIN" ]] ||
     [[ -n "${VITE_API_URL:-}" && -n "$CURRENT_VITE_API_URL" && "$VITE_API_URL" != "$CURRENT_VITE_API_URL" ]]; then
    echo "警告：已有安装以 .env 为准，已忽略环境变量中的 URL 覆盖。" >&2
  fi
  CORS_ORIGIN_VALUE="${CURRENT_CORS_ORIGIN:-${CORS_ORIGIN:-}}"
  VITE_API_URL_VALUE="${CURRENT_VITE_API_URL:-${VITE_API_URL:-}}"
else
  CORS_ORIGIN_VALUE="${CORS_ORIGIN:-$CURRENT_CORS_ORIGIN}"
  VITE_API_URL_VALUE="${VITE_API_URL:-$CURRENT_VITE_API_URL}"
fi

if [[ "$NON_INTERACTIVE" == false ]]; then
  echo "TG Vault 安装向导"
  echo
  if [[ "$created_env" == true ]]; then
    echo "这是首次部署。你只需要提供 Web 前端 URL 和后端 API URL。"
    echo "数据库密码和应用密钥会自动生成。"
  else
    echo "检测到已有部署。请确认下面的地址仍然正确；直接按 Enter 保留。"
    echo "本次升级只重建 backend/frontend，不删除数据库和持久化文件。"
  fi
  echo
  while true; do
    CORS_ORIGIN_VALUE="$(prompt_origin '请输入 Web 前端 URL' 'https://cloud.example.com' "$CORS_ORIGIN_VALUE")"
    VITE_API_URL_VALUE="$(prompt_origin '请输入后端 API URL' 'https://api.example.com' "$VITE_API_URL_VALUE")"
    if [[ "$CORS_ORIGIN_VALUE" != https://* || "$VITE_API_URL_VALUE" != https://* ]]; then
      echo "警告：当前配置包含 HTTP 地址，登录 Cookie 或接口流量可能无法获得生产级保护。" >&2
    fi
    if confirm_install; then
      break
    fi
  done
else
  if [[ -z "$CORS_ORIGIN_VALUE" || -z "$VITE_API_URL_VALUE" ]]; then
    echo "非交互模式需要在 .env 或环境变量中提供 CORS_ORIGIN 和 VITE_API_URL。" >&2
    exit 2
  fi
  if ! CORS_ORIGIN_VALUE="$(normalize_origin "$CORS_ORIGIN_VALUE")"; then
    echo "CORS_ORIGIN 必须是完整的 http(s) origin，不能包含路径、查询参数或片段。" >&2
    exit 2
  fi
  if ! VITE_API_URL_VALUE="$(normalize_origin "$VITE_API_URL_VALUE")"; then
    echo "VITE_API_URL 必须是完整的 http(s) origin，不能包含路径、查询参数或片段。" >&2
    exit 2
  fi
fi

if [[ "$created_env" == true ]]; then
  umask 077
  touch .env
fi
upsert_env CORS_ORIGIN "$CORS_ORIGIN_VALUE"
upsert_env VITE_API_URL "$VITE_API_URL_VALUE"
if [[ "$created_env" == true ]]; then
  upsert_env COOKIE_SECURE true
  upsert_env COOKIE_SECURE_FORCE true
fi

chmod 600 .env
ensure_generated_secret DB_PASSWORD
if [[ "$created_env" == true ]]; then
  ensure_generated_secret SESSION_SECRET
  ensure_generated_secret STORAGE_CREDENTIALS_SECRET
fi

# v2.2.0 及更早版本曾把构建元数据写入 .env，升级时主动清理，避免旧值覆盖新版本。
remove_env_keys IMAGE_VERSION SOURCE_REVISION SOURCE_VERSION

RELEASE_REVISION="$(git rev-parse HEAD 2>/dev/null || printf unknown)"
RELEASE_VERSION="v$(python3 - <<'PY'
import json
from pathlib import Path
print(json.loads(Path('backend/package.json').read_text())['version'])
PY
)"

env IMAGE_VERSION="$RELEASE_VERSION" SOURCE_REVISION="$RELEASE_REVISION" SOURCE_VERSION="$RELEASE_VERSION" docker compose config --quiet
env IMAGE_VERSION="$RELEASE_VERSION" SOURCE_REVISION="$RELEASE_REVISION" SOURCE_VERSION="$RELEASE_VERSION" docker compose build backend frontend
env IMAGE_VERSION="$RELEASE_VERSION" SOURCE_REVISION="$RELEASE_REVISION" SOURCE_VERSION="$RELEASE_VERSION" docker compose up -d --no-build --no-deps backend frontend
docker compose ps

if [[ "$created_env" == true ]]; then
  echo "TG Vault 首次部署完成"
else
  echo "TG Vault 升级完成"
fi
echo "Web：$CORS_ORIGIN_VALUE"
echo "API：$VITE_API_URL_VALUE"
echo
echo "请在宿主机 Nginx/面板中配置 HTTPS："
echo "  Web  -> http://127.0.0.1:47832"
echo "  API  -> http://127.0.0.1:51947"
echo "验证：curl -fsS http://127.0.0.1:51947/readyz"
