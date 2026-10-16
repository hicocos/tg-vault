#!/usr/bin/env bash
set -Eeuo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  printf '需要 Bash 4 或更新版本，请不要使用 sh 运行。\n' >&2
  exit 2
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
NON_INTERACTIVE=false
AFTER_SOURCE_UPDATE=false
SKIP_SOURCE_UPDATE=false
INSTALL_REQUIRE_ATTESTATIONS="${INSTALL_REQUIRE_ATTESTATIONS:-true}"
for argument in "$@"; do
case "$argument" in
  --non-interactive) NON_INTERACTIVE=true ;;
  --after-source-update) AFTER_SOURCE_UPDATE=true ;;
  --skip-source-update) SKIP_SOURCE_UPDATE=true ;;
  --compat) INSTALL_REQUIRE_ATTESTATIONS=false ;;
  -h|--help)
    cat <<'EOF'
用法：./deploy/install.sh [--non-interactive] [--skip-source-update] [--compat]

检查源码更新和服务器环境，再填写 Web/API 地址。仅输入 1 才授权安装缺少的软件。
首次部署创建 .env 并生成密钥；已有地址按 Enter 保留。生产环境需配置 HTTPS。
--non-interactive  不读取输入或安装软件；从 .env 或环境变量取值，配置不足时退出。
--skip-source-update  使用当前源码，不拉取 Git 更新。
--compat  本次构建不生成 SBOM/provenance，适用于较旧 Compose/镜像存储；不改原配置。
EOF
    exit 0
    ;;
  *)
    echo "未知参数：$argument；使用 --help 查看用法。" >&2
    exit 2
    ;;
esac
done

if [[ "$NON_INTERACTIVE" == false && ! -t 0 ]]; then
  echo "当前没有交互式终端；请在终端中运行，或使用 --non-interactive。" >&2
  exit 2
fi

if [[ ! -f docker-compose.yml ]]; then
  echo "请从包含 docker-compose.yml 的项目目录运行 deploy/install.sh。" >&2
  exit 1
fi

update_source() {
  # 测试夹具和手工拷贝的源码可能没有 .git；真正的仓库才自动同步。
  [[ "$AFTER_SOURCE_UPDATE" == true ]] && return 0
  if [[ "$SKIP_SOURCE_UPDATE" == true ]]; then
    echo "已跳过源码更新，使用当前代码。"
    return 0
  fi
  [[ "${INSTALL_TEST_SKIP_GIT_UPDATE:-false}" == true ]] && return 0
  [[ -d .git ]] || return 0
  command -v git >/dev/null 2>&1 || return 0

  local branch before after
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$branch" ]]; then
    echo "当前处于 detached HEAD，无法自动更新分支。" >&2
    echo "请切换到部署分支后重试；若要保留当前源码，使用 --skip-source-update。" >&2
    exit 1
  fi
  before="$(git rev-parse HEAD 2>/dev/null || true)"

  echo "正在检查 origin/$branch 的更新..."
  if ! git diff --quiet || [[ -n "$(git status --porcelain)" ]]; then
    echo "检测到项目目录有本地修改，为避免覆盖文件，已停止升级。" >&2
    echo "请先处理这些修改，再重新运行 ./deploy/install.sh。" >&2
    exit 1
  fi
  if ! GIT_TERMINAL_PROMPT=0 git fetch origin || ! GIT_TERMINAL_PROMPT=0 git merge --ff-only "origin/$branch"; then
    echo "源码更新失败（网络、远端分支或提交分叉）。未开始部署。" >&2
    echo "请修复更新问题后重试；若要使用当前源码，添加 --skip-source-update。" >&2
    exit 1
  fi
  after="$(git rev-parse HEAD 2>/dev/null || true)"
  if [[ "$before" != "$after" ]]; then
    echo "源码已更新，重新加载安装器..."
    local reload_args=()
    [[ "$NON_INTERACTIVE" != true ]] || reload_args+=(--non-interactive)
    reload_args+=(--after-source-update)
    [[ "$INSTALL_REQUIRE_ATTESTATIONS" != false ]] || reload_args+=(--compat)
    exec bash ./deploy/install.sh "${reload_args[@]}"
  fi
  echo "代码已是最新。"
}

update_source

source "$SCRIPT_DIR/install-environment.sh"
check_environment || exit $?

normalize_origin() {
  python3 "$SCRIPT_DIR/install-config.py" origin "$1"
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
      echo "示例：$example（请填实际地址；已有占位值也会在 Enter 时保留）" >&2
      printf '> ' >&2
    fi
    if ! IFS= read -r entered; then
      echo "输入已结束，未保存配置或启动服务。" >&2
      return 2
    fi
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
    if ! IFS= read -r choice; then
      echo "输入已结束，未保存配置或启动服务。" >&2
      exit 2
    fi
    case "${choice,,}" in
      "") return 0 ;;
      e) return 1 ;;
      q) echo "已取消，未保存配置或启动服务。"; exit 0 ;;
      *) echo "请输入 Enter、e 或 q。" >&2 ;;
    esac
  done
}

upsert_env() {
  python3 "$SCRIPT_DIR/install-config.py" upsert "$1" "$2" .env
}

read_env() {
  python3 "$SCRIPT_DIR/install-config.py" read "$1" .env
}

ensure_generated_secret() {
  local key="$1"
  local current
  current="$(read_env "$key")" || return $?
  if [[ -z "$current" ]]; then
    upsert_env "$key" "$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
}

remove_env_keys() {
  python3 "$SCRIPT_DIR/install-config.py" remove .env "$@"
}

created_env=false
STORAGE_EXISTING="$(python3 "$SCRIPT_DIR/install-storage.py" existing)"
export STORAGE_EXISTING
LOCAL_STORAGE_NEW_PATH=""
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
    echo "首次部署：填写 Web 和 API 的 HTTPS 地址。"
    echo "数据库密码和应用密钥会自动生成。"
  else
    echo "已有部署：核对地址，按 Enter 保留。升级前请备份 .env、数据库和文件卷。"
    echo "本次只重建前后端，保留数据库和文件卷；替换服务会短暂中断访问。"
  fi
  echo
  while true; do
    CORS_ORIGIN_VALUE="$(prompt_origin '请输入 Web 前端 URL' 'https://cloud.example.com' "$CORS_ORIGIN_VALUE")"
    VITE_API_URL_VALUE="$(prompt_origin '请输入后端 API URL' 'https://api.example.com' "$VITE_API_URL_VALUE")"
    if [[ "$CORS_ORIGIN_VALUE" != https://* || "$VITE_API_URL_VALUE" != https://* ]]; then
      echo "警告：HTTP 不加密请求，默认安全 Cookie 无法用于 HTTP 登录；生产环境请改用 HTTPS。" >&2
    fi
    if [[ "$STORAGE_EXISTING" == false ]]; then
      printf '文件保存位置（服务器目录，默认 %s/data）：' "$PWD"
      IFS= read -r LOCAL_STORAGE_NEW_PATH || exit 2
      LOCAL_STORAGE_NEW_PATH="${LOCAL_STORAGE_NEW_PATH:-$PWD/data}"
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

# Runtime dependency startup is required even with a pre-existing .env.
source "$SCRIPT_DIR/install-runtime.sh"
CURRENT_DB_PASSWORD="$(read_env DB_PASSWORD)"
assert_database_credentials_safe "$CURRENT_DB_PASSWORD"
validate_install_timeout

if [[ "$STORAGE_EXISTING" == false ]]; then
  LOCAL_STORAGE_NEW_PATH="$(python3 "$SCRIPT_DIR/install-storage.py" create "${LOCAL_STORAGE_NEW_PATH:-${INSTALL_STORAGE_PATH:-$PWD/data}}")"
else
  echo '保留原文件保存位置；不迁移文件，不应用新目录默认值。'
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

if [[ -n "$LOCAL_STORAGE_NEW_PATH" ]]; then
  upsert_env LOCAL_STORAGE_SOURCE "$LOCAL_STORAGE_NEW_PATH"
  STORAGE_METADATA="$(python3 "$SCRIPT_DIR/install-storage.py" metadata "$LOCAL_STORAGE_NEW_PATH" bind)"
  while IFS='=' read -r key value; do upsert_env "$key" "$value"; done < <(
    printf '%s' "$STORAGE_METADATA" | python3 -c 'import json,sys; [print(k+"="+v) for k,v in json.load(sys.stdin).items()]'
  )
fi
# Pin persisted storage settings against ambient Compose overrides.
for key in LOCAL_STORAGE_SOURCE LOCAL_STORAGE_MOUNT_TYPE LOCAL_STORAGE_HOST_ROOT LOCAL_STORAGE_CONTAINER_ROOT LOCAL_STORAGE_DEVICE LOCAL_STORAGE_INODE; do
  value="$(read_env "$key")"
  export "$key=$value"
done
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

# Shell variables have higher Compose precedence than .env. Pin confirmed URLs
# in the actual child environment as well as the file.
CORS_ORIGIN="$CORS_ORIGIN_VALUE"
VITE_API_URL="$VITE_API_URL_VALUE"
DB_PASSWORD="$(read_env DB_PASSWORD)"
DB_PASSWORD_URI="$(python3 - "$DB_PASSWORD" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1], safe=''))
PY
)"
SESSION_SECRET="$(read_env SESSION_SECRET)"
STORAGE_CREDENTIALS_SECRET="$(read_env STORAGE_CREDENTIALS_SECRET)"
export CORS_ORIGIN VITE_API_URL DB_PASSWORD DB_PASSWORD_URI SESSION_SECRET STORAGE_CREDENTIALS_SECRET
prepare_install_compose
start_installation

if [[ "$created_env" == true ]]; then
  echo "TG Vault 首次部署完成"
else
  echo "TG Vault 升级完成"
fi
echo "Web：$CORS_ORIGIN_VALUE"
echo "API：$VITE_API_URL_VALUE"
echo
API_PORT="${PORT:-$(read_env PORT)}"
API_PORT="${API_PORT:-51947}"
echo "容器健康检查已通过。公网访问还需宿主机 Nginx/面板的 HTTPS 反向代理："
echo "  Web  -> http://127.0.0.1:47832"
echo "  API  -> http://127.0.0.1:$API_PORT"
echo "本机就绪检查：curl -fsS http://127.0.0.1:$API_PORT/readyz；另请验证 Web/API 的 HTTPS 地址。"
