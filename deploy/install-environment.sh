#!/usr/bin/env bash
# Source from install.sh, then: check_environment || exit $?
# Call BEFORE any .env writes. Returns 0 only when ready, 1 on a failed/cancelled
# preflight, 2 on invalid invocation. Never exits the caller or changes its options.
# NON_INTERACTIVE=true (also the unset default) forbids input/package/sudo calls.
# NON_INTERACTIVE=false permits installation only after an explicit "1" response.
# Runtime installs need Linux, Bash 4+, Python 3.7+, Git, Docker and Compose.
# Buildx/attestation checks run only for explicit source mode or pull fallback.
# Optional package installation still requires an explicit interactive consent.

_tg_env_manual_help() {
  printf '%s\n' \
    '需要 Linux、Bash 4+、Python 3.7+、Git、Docker Engine 和 Compose 插件。' \
    '默认拉取最新镜像，Compose 需支持健康等待与 pull 策略；无需 Buildx。' \
    '源码兜底需要可访问的 Buildx builder；标准构建要求 Compose >= 2.39.0 及构建证明支持。' \
    '较旧构建环境可主动选择 --compat，不生成本次构建证明；Compose 检查基线为 2.18.0。' \
    'Ubuntu/Debian 包名可能为 docker.io、docker-compose-v2（或 V2 的 docker-compose）、docker-buildx。' \
    '已配置的 Docker 官方仓库通常提供 docker-ce、docker-ce-cli、docker-compose-plugin、docker-buildx-plugin。' \
    'dnf/yum 只使用现有仓库；仓库没有兼容包时请按发行版/ Docker 官方文档手工配置受信任仓库。' \
    '安装文档：https://docs.docker.com/engine/install/ 和 https://docs.docker.com/compose/install/linux/' \
    '脚本不添加仓库、导入密钥、执行 curl|sh、修改 Docker socket 权限或启动服务；包管理器可能在安装时启动服务。' >&2
}

_tg_env_status() {
  printf '  %-24s %s\n' "$1" "$2"
}

_tg_env_compose_schema() {
  # A self-contained stdin config avoids reading or creating the project .env,
  # even on a first install where DB_PASSWORD is not generated yet. --quiet keeps
  # configuration values out of logs. Explicit -f also ignores COMPOSE_FILE.
  local attestation_fields=''
  if [[ "${INSTALL_CHECK_BUILD:-false}" == true && "${INSTALL_REQUIRE_ATTESTATIONS:-true}" == true ]]; then
    attestation_fields=$'      sbom: true\n      provenance: mode=max'
  fi
  docker compose --env-file /dev/null --project-name tg-vault-preflight -f - config --quiet <<YAML
services:
  preflight:
    build:
      context: .
$attestation_fields
    depends_on:
      database:
        condition: service_healthy
  database:
    image: scratch
    pull_policy: always
    healthcheck:
      test: ["CMD", "true"]
YAML
}

_tg_env_builder_ready() {
  local output line driver='' running=false store major minor
  # inspect may print "Error:" and still exit 0; inspect its result as well as
  # its status. Never --bootstrap: that could create/start a BuildKit container.
  if ! output="$(LC_ALL=C docker buildx inspect 2>/dev/null)"; then
    printf '%s\n' '当前 Buildx builder 不可访问；请运行 docker buildx inspect 并检查 BUILDX_BUILDER / Docker context。' >&2
    return 1
  fi
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*Error: ]]; then
      printf '%s\n' 'docker buildx inspect 报告节点 Error；请修复所选 builder 后重试。' >&2
      return 1
    elif [[ "$line" =~ ^[[:space:]]*Driver:[[:space:]]+([^[:space:]]+) ]]; then
      driver="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^[[:space:]]*Status:[[:space:]]+([^[:space:]]+) ]]; then
      if [[ "${BASH_REMATCH[1]}" != running ]]; then
        printf '%s\n' '所选 Buildx builder 未运行；请检查并手动启动后重试。' >&2
        return 1
      fi
      running=true
    elif [[ "${line,,}" =~ ^[[:space:]]*buildkit([[:space:]]version)?:[[:space:]]+v?([0-9]+)\.([0-9]+) ]]; then
      major=$((10#${BASH_REMATCH[2]}))
      minor=$((10#${BASH_REMATCH[3]}))
      if [[ "${INSTALL_REQUIRE_ATTESTATIONS:-true}" == true ]] && (( major == 0 && minor < 11 )); then
        printf '%s\n' '当前 BuildKit < 0.11，不支持所需 sbom/provenance；请升级 Docker Engine 或所选 builder。' >&2
        return 1
      fi
    fi
  done <<< "$output"
  if [[ "$running" != true || -z "$driver" ]]; then
    printf '%s\n' '无法确认 Buildx builder 已运行；请检查 docker buildx inspect 输出后重试。' >&2
    return 1
  fi
  [[ "${INSTALL_REQUIRE_ATTESTATIONS:-true}" == true ]] || return 0
  if [[ "$driver" == docker ]]; then
    # The default docker driver cannot emit requested attestations with the
    # classic image store. Probe the daemon's capability, not its version.
    if ! store="$(docker info --format '{{json .DriverStatus}}' 2>/dev/null)" ||
        [[ "$store" != *'io.containerd.snapshotter.v1'* ]]; then
      printf '%s\n' 'docker builder 的镜像存储未启用 containerd；当前 sbom/provenance 构建不受支持。' >&2
      printf '%s\n' '请按 Docker 文档配置支持证明的镜像存储/builder，或主动使用 --compat 放弃本次构建证明；预检不更改 daemon 配置。' >&2
      printf '%s\n' 'https://docs.docker.com/build/metadata/attestations/#driver-and-image-store-support' >&2
      return 1
    fi
  else
    printf '%s\n' '注意：需在实际构建后检查该 builder 的本地镜像导出和证明保留情况；classic image store 不保留构建证明。' >&2
  fi
}

_tg_env_probe() {
  # These two variables are local to check_environment (Bash dynamic scope).
  # Do not use namerefs: those would raise the runtime requirement to Bash 4.3.
  _tg_env_missing=()
  _tg_env_blocked=false
  local daemon_ok=false detail compose_version buildx_help compose_help
  printf '%s\n' '服务器环境检测（只读）'
  if ! command -v docker >/dev/null 2>&1; then
    _tg_env_missing+=(docker compose)
    [[ "${INSTALL_CHECK_BUILD:-false}" != true ]] || _tg_env_missing+=(buildx)
    _tg_env_status 'Docker Engine' '✗ 缺失 (docker)'
    _tg_env_status 'Docker Compose 插件' '✗ 不可用 (compose；Docker CLI 缺失)'
    [[ "${INSTALL_CHECK_BUILD:-false}" != true ]] || _tg_env_status 'Docker Buildx' '✗ 不可用 (buildx；Docker CLI 缺失)'
  else
    if detail="$(docker info --format '{{.ServerVersion}}' 2>&1)"; then
      daemon_ok=true
      _tg_env_status 'Docker Engine / daemon' '✓ 当前用户可访问'
    else
      _tg_env_blocked=true
      _tg_env_status 'Docker Engine / daemon' '✗ 当前用户无法访问'
      if [[ "${detail,,}" == *'permission denied'* || "${detail,,}" == *'access is denied'* ]]; then
        printf '%s\n' 'Docker 权限不足。请使用有权限的账户或正确配置 rootless Docker；不要 chmod 666 Docker socket。' >&2
        printf '%s\n' 'docker 组权限等同 root 权限；如已获授权加入该组，请重新登录后重试。不要只给个别 Docker 命令加 sudo。' >&2
      else
        printf '%s\n' 'Docker daemon 不可达。请确认服务已由管理员启动，或确认 rootless Docker 服务正在运行。' >&2
      fi
      # Do not print raw errors: a remote DOCKER_HOST may contain credentials.
      printf '%s\n' '请检查 DOCKER_HOST / DOCKER_CONTEXT、docker context show，并以当前账户运行 docker info 后重试。' >&2
    fi

    if compose_version="$(docker compose version --short 2>/dev/null)"; then
      if _tg_env_compose_schema >/dev/null 2>&1 &&
          compose_help="$(docker compose up --help 2>/dev/null)" &&
          [[ "$compose_help" == *'--wait-timeout'* && "$compose_help" == *'--no-recreate'* && "$compose_help" == *'--pull'* &&
             "$compose_help" =~ (^|[[:space:]])--wait([[:space:]]|$) ]]; then
        _tg_env_status 'Docker Compose 插件' "✓ 配置和健康等待检查通过 (${compose_version:-版本未知})"
      else
        _tg_env_missing+=(compose)
        _tg_env_status 'Docker Compose 插件' '✗ 不支持所需配置，或 config 验证失败'
        if [[ "${INSTALL_CHECK_BUILD:-false}" == true && "${INSTALL_REQUIRE_ATTESTATIONS:-true}" == true ]]; then
          printf '%s\n' '需要上游 Compose >= 2.39.0（或兼容回移版本），且支持 build.sbom / build.provenance 与 --wait-timeout。' >&2
        else
          printf '%s\n' '兼容模式验证基线为 Compose >= 2.18.0；回移版本也需通过配置和 --wait-timeout 检查。' >&2
        fi
      fi
    else
      _tg_env_missing+=(compose)
      _tg_env_status 'Docker Compose 插件' '✗ 缺失或不可执行 (compose)'
    fi


    if [[ "${INSTALL_CHECK_BUILD:-false}" == true ]]; then
    if docker buildx version >/dev/null 2>&1; then
      if buildx_help="$(docker buildx build --help 2>/dev/null)" &&
          { [[ "${INSTALL_REQUIRE_ATTESTATIONS:-true}" == false ]] ||
            [[ "$buildx_help" == *'--sbom'* && "$buildx_help" == *'--provenance'* ]]; }; then
        _tg_env_status 'Docker Buildx' '✓ 构建命令可用'
        if [[ "$daemon_ok" == true ]] && ! _tg_env_builder_ready; then
          _tg_env_blocked=true
          printf '%s\n' 'Buildx builder 检查未通过，请按上方提示处理后重试。' >&2
          printf '%s\n' '预检不启动、创建或切换 builder，也不下载 BuildKit 镜像。' >&2
        fi
      else
        _tg_env_missing+=(buildx)
        _tg_env_status 'Docker Buildx' '✗ 需要支持 --sbom / --provenance 的版本'
      fi
    else
      _tg_env_missing+=(buildx)
      _tg_env_status 'Docker Buildx' '✗ 缺失或不可执行；构建需要 Buildx'
    fi
    else
      _tg_env_status 'Docker Buildx' '— 镜像安装不需要；仅源码兜底时检查'
    fi
  fi

  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 7))' >/dev/null 2>&1; then
    _tg_env_status 'Python 3.7+' '✓ 可执行'
  else
    _tg_env_missing+=(python3)
    _tg_env_status 'Python 3.7+' '✗ 缺失或版本过低'
  fi
  if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
    _tg_env_status 'Git' '✓ 可执行'
  else
    _tg_env_missing+=(git)
    _tg_env_status 'Git' '✗ 缺失或不可执行'
  fi
  if [[ "${INSTALL_CHECK_BUILD:-false}" == true && "${DOCKER_BUILDKIT:-}" == 0 ]]; then
    _tg_env_blocked=true
    printf '%s\n' 'DOCKER_BUILDKIT=0 禁用了所需构建能力；请取消该变量或设为 1 后重试。' >&2
  fi
  [[ "$_tg_env_blocked" == false && ${#_tg_env_missing[@]} -eq 0 ]]
}

_tg_env_package_manager() {
  if command -v apt-get >/dev/null 2>&1 && command -v apt-cache >/dev/null 2>&1; then
    printf 'apt'
  elif command -v dnf >/dev/null 2>&1; then
    printf 'dnf'
  elif command -v yum >/dev/null 2>&1; then
    printf 'yum'
  else
    printf 'unsupported'
  fi
}

_tg_env_privileged() {
  # The consent flag is local to check_environment; no public environment switch
  # skips consent, and noninteractive mode can never invoke sudo (even cached).
  if [[ "${NON_INTERACTIVE:-true}" != false || "${_tg_env_install_approved:-false}" != true ]]; then
    printf '%s\n' '未明确授权安装；不会调用包管理器或 sudo。' >&2
    return 1
  fi
  if [[ "$EUID" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -- "$@"
  else
    printf '%s\n' '安装需要 root 权限，但当前账户不是 root 且未找到 sudo。请由管理员安装缺失项后重试。' >&2
    return 1
  fi
}

_tg_env_package_version() {
  local manager="$1" package="$2" output line name version rest
  case "$manager" in
    apt)
      output="$(LC_ALL=C apt-cache policy "$package" 2>/dev/null)" || return 1
      while IFS= read -r line; do
        if [[ "$line" =~ Candidate:[[:space:]]+([^[:space:]]+) ]]; then
          version="${BASH_REMATCH[1]}"
          [[ "$version" != '(none)' ]] || return 1
          printf '%s' "$version"
          return 0
        fi
      done <<< "$output"
      ;;
    dnf|yum)
      # list --available is supported by both yum and dnf; repoquery would need
      # an additional plugin on older hosts. No repo additions or install guesses.
      output="$(LC_ALL=C "$manager" -q list --available "$package" 2>/dev/null)" || return 1
      while read -r name version rest; do
        if [[ "$name" == "$package" || "$name" == "$package".* ]]; then
          [[ -n "$version" ]] || continue
          printf '%s' "$version"
          return 0
        fi
      done <<< "$output"
      ;;
  esac
  return 1
}

_tg_env_candidate_compatible() {
  local component="$1" version="${2##*:}" major minor
  # Package epochs and distro suffixes are accepted, but a known old candidate
  # is never installed merely because its package happens to be called a plugin.
  # Already-installed backports are handled by the capability probe instead.
  if [[ "$component" == compose || "$component" == buildx ]]; then
    [[ "$version" =~ ^v?([0-9]+)\.([0-9]+)(\.|$|[-+~]) ]] || return 1
    major=$((10#${BASH_REMATCH[1]}))
    minor=$((10#${BASH_REMATCH[2]}))
    if [[ "$component" == compose ]]; then
      local required_minor=39
      [[ "${INSTALL_REQUIRE_ATTESTATIONS:-true}" == true ]] || required_minor=18
      (( major > 2 || (major == 2 && minor >= required_minor) ))
    else
      if [[ "${INSTALL_REQUIRE_ATTESTATIONS:-true}" == true ]]; then
        (( major > 0 || minor >= 10 ))
      else
        return 0
      fi
    fi
  else
    return 0
  fi
}

_tg_env_choose_package() {
  local manager="$1" component="$2" package version
  shift 2
  _tg_env_selected=''
  for package in "$@"; do
    if version="$(_tg_env_package_version "$manager" "$package")" &&
        _tg_env_candidate_compatible "$component" "$version"; then
      _tg_env_selected="$package"
      return 0
    fi
  done
  printf '现有仓库没有适合 %s 的可安装候选包（检查过：%s）。\n' "$component" "$*" >&2
  return 1
}

_tg_env_install() {
  local manager="$1" item cli version _tg_env_selected
  local packages=() package seen existing
  # This function is reachable only after consent. apt metadata must be current
  # before selecting a candidate. Explicit security options override unsafe apt
  # defaults; --no-remove refuses a package plan that removes an existing engine.
  if [[ "$manager" == apt ]]; then
    if ! _tg_env_privileged apt-get -o APT::Get::AllowUnauthenticated=false \
        -o Acquire::AllowInsecureRepositories=false update; then
      printf '%s\n' '更新 apt 包索引失败；已停止。请检查网络、仓库签名和管理员权限。' >&2
      return 1
    fi
  fi
  for item in "${_tg_env_missing[@]}"; do
    case "$item" in
      docker)
        if ! _tg_env_choose_package "$manager" docker docker-ce docker.io moby-engine docker; then return 1; fi
        packages+=("$_tg_env_selected")
        case "$_tg_env_selected" in
          docker-ce) cli=docker-ce-cli ;;
          moby-engine) cli=moby-cli ;;
          *) cli='' ;;
        esac
        if [[ -n "$cli" ]]; then
          if ! version="$(_tg_env_package_version "$manager" "$cli")"; then
            printf '现有仓库缺少与所选 Engine 配套的 %s；不会安装不完整工具链。\n' "$cli" >&2
            return 1
          fi
          packages+=("$cli")
        fi
        ;;
      compose)
        if ! _tg_env_choose_package "$manager" compose docker-compose-plugin docker-compose-v2 docker-compose; then return 1; fi
        packages+=("$_tg_env_selected")
        ;;
      buildx)
        if ! _tg_env_choose_package "$manager" buildx docker-buildx-plugin docker-buildx moby-buildx; then return 1; fi
        packages+=("$_tg_env_selected")
        ;;
      python3|git)
        if ! _tg_env_choose_package "$manager" "$item" "$item"; then return 1; fi
        packages+=("$_tg_env_selected")
        ;;
      *) return 1 ;;
    esac
  done
  # All candidates must exist before any package is installed. Use ordinary
  # arrays, not associative arrays/namerefs, to support every Bash 4 release.
  local unique=()
  for package in "${packages[@]}"; do
    seen=false
    # Bash 4.0-4.3 treats an empty array as unset with nounset enabled.
    for existing in ${unique[@]+"${unique[@]}"}; do
      [[ "$existing" != "$package" ]] || seen=true
    done
    [[ "$seen" == true ]] || unique+=("$package")
  done
  printf '安装现有仓库候选包：%s\n' "${unique[*]}"
  case "$manager" in
    apt)
      _tg_env_privileged apt-get -o APT::Get::AllowUnauthenticated=false \
        -o Acquire::AllowInsecureRepositories=false install -y --no-remove "${unique[@]}"
      ;;
    dnf|yum)
      _tg_env_privileged "$manager" --setopt=gpgcheck=1 '--setopt=*.gpgcheck=1' install -y "${unique[@]}"
      ;;
    *) return 1 ;;
  esac
}

check_environment() {
  local system manager choice _tg_env_blocked=false _tg_env_install_approved=false
  local _tg_env_missing=()
  if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
    printf '%s\n' '安装预检需要 Bash >= 4；请使用 bash 运行安装脚本。' >&2
    return 2
  fi
  case "${NON_INTERACTIVE:-true}" in
    true|false) ;;
    *) printf '%s\n' 'NON_INTERACTIVE 必须为 true 或 false。' >&2; return 2 ;;
  esac
  case "${INSTALL_REQUIRE_ATTESTATIONS:-true}" in
    true) ;;
    false) [[ "${INSTALL_CHECK_BUILD:-false}" != true ]] || printf '%s\n' '兼容构建模式：本次不生成 sbom/provenance；原部署配置不变。' >&2 ;;
    *) printf '%s\n' 'INSTALL_REQUIRE_ATTESTATIONS 必须为 true 或 false。' >&2; return 2 ;;
  esac
  system="$(uname -s 2>/dev/null)" || system=unknown
  if [[ "$system" != Linux ]]; then
    printf '此安装器仅支持 Linux（当前：%s），已停止。\n' "$system" >&2
    return 1
  fi
  if _tg_env_probe; then
    printf '%s\n' '环境检测通过。'
    return 0
  fi
  # Missing plugins are repairable; a daemon/context/permission/builder problem
  # is not. Stop rather than install packages or change privileges around it.
  if [[ "$_tg_env_blocked" == true ]]; then
    printf '%s\n' '环境不可用，已停止；未保存 .env 或执行部署。请先解决以上问题。' >&2
    return 1
  fi
  printf '缺少或不兼容的必需环境：%s\n' "${_tg_env_missing[*]}" >&2
  if [[ "${NON_INTERACTIVE:-true}" == true ]]; then
    printf '%s\n' '非交互模式不会读取输入、安装软件或调用 sudo；请手动补全后重试。' >&2
    _tg_env_manual_help
    return 1
  fi
  manager="$(_tg_env_package_manager)"
  if [[ "$manager" == unsupported ]]; then
    printf '%s\n' '未找到受支持的包管理器（apt/dnf/yum；apt 还需要 apt-cache）。请手动安装。' >&2
    _tg_env_manual_help
    return 1
  fi
  printf '%s\n' \
    '请选择处理方式：' \
    '  1) 授权从现有受信任仓库安装/升级缺失项（更新包索引，可能请求 sudo 密码或触发服务启动）' \
    '  2) 显示手动处理提示并退出' \
    '  q) 退出（默认；直接按 Enter 不安装）'
  while true; do
    printf '> '
    if ! IFS= read -r choice; then
      printf '\n%s\n' '未收到明确授权，已停止；未安装软件。' >&2
      return 1
    fi
    case "${choice,,}" in
      1) _tg_env_install_approved=true; break ;;
      2) _tg_env_manual_help; return 1 ;;
      ''|q) printf '%s\n' '已取消；未安装软件或保存 .env。'; return 1 ;;
      *) printf '%s\n' '请输入 1、2 或 q；不会默认选择安装。' >&2 ;;
    esac
  done
  if ! _tg_env_install "$manager"; then
    printf '%s\n' '软件安装失败，已停止；可能已更新包索引或部分软件包，但未保存 .env。' >&2
    _tg_env_manual_help
    return 1
  fi
  hash -r
  if ! _tg_env_probe; then
    printf '%s\n' '安装后复检仍未通过；未保存 .env 或执行部署。请按上方提示手工修复后重试。' >&2
    return 1
  fi
  printf '%s\n' '依赖安装完成，环境复检通过。'
}
