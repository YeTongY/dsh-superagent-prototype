#!/bin/sh
set -eu

APP_ROOT=${DSH_SUPERAGENT_APP_ROOT:-/opt/dsh-superagent}
PROFILE=${DSH_SUPERAGENT_PROFILE:-superagent}
PROFILE_DIR=${DSH_HOME:-/data/dsh}/profiles/$PROFILE
PROFILE_PACKAGE=$PROFILE_DIR/package.json
PROFILE_PATCH=$APP_ROOT/docker/profile.patch.yml
PLUGIN_LINK="link:$APP_ROOT"

usage() {
  cat <<'EOF'
dsh-superagent 容器命令：
  run          安全初始化 profile 并以前台模式启动 DSH（默认）
  init         只初始化缺失的 profile 并链接本地 bundle
  doctor       检查运行时 CLI 版本和 profile 安装状态
  status       查看运行时健康和 setup 等待状态
  healthcheck  检查 loopback 管理 API 是否可应答
  help         显示本帮助

持久化约定：DSH_HOME=/data/dsh，产品 stateDir=/data/superagent，profile=superagent。
EOF
}

fail() {
  printf 'dsh-superagent: %s\n' "$1" >&2
  exit 1
}

profile_has_link() {
  node - "$PROFILE_PACKAGE" "$PLUGIN_LINK" <<'NODE'
const fs = require('node:fs')
const [file, expected] = process.argv.slice(2)
try {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  const actual = value.dependencies?.['dsh-superagent']
  if (actual === expected) process.exit(0)
  if (actual) process.exit(2)
  process.exit(1)
} catch {
  process.exit(3)
}
NODE
}

init_profile() {
  [ -f "$PROFILE_PATCH" ] || fail "缺少容器 profile 覆盖文件：$PROFILE_PATCH"
  mkdir -p "${DSH_HOME:-/data/dsh}" /data/superagent /data/gh /data/glab /data/work

  if [ ! -e "$PROFILE_DIR" ]; then
    printf '初始化新的 DSH Web profile：%s\n' "$PROFILE"
    dsh --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null
  elif [ ! -f "$PROFILE_PACKAGE" ]; then
    fail "发现不完整的已有 profile：$PROFILE_DIR；为避免覆盖数据，请先检查或备份该目录"
  fi

  if [ ! -f "$PROFILE_PACKAGE" ]; then
    fail "DSH 未生成 profile 清单：$PROFILE_PACKAGE"
  fi

  link_state=0
  profile_has_link || link_state=$?
  case "$link_state" in
    0) : ;;
    1)
      printf '将 dsh-superagent bundle 链接到 profile %s\n' "$PROFILE"
      dsh plugin --profile "$PROFILE" add "$PLUGIN_LINK"
      profile_has_link || fail "profile 中的 dsh-superagent 链接未指向 $APP_ROOT"
      ;;
    2) fail "已有 profile 安装了不同来源的 dsh-superagent；请先人工检查，容器不会替换它" ;;
    *) fail "无法读取 profile package.json：$PROFILE_PACKAGE" ;;
  esac
}

check_minimum() {
  label=$1
  found=$2
  minimum=$3
  if ! printf '%s\n%s\n' "$minimum" "$found" | sort -V -C; then
    fail "$label 版本 $found 不满足最低要求 $minimum"
  fi
}

doctor() {
  for command in dsh pnpm gh glab git python3 tmux; do
    command -v "$command" >/dev/null 2>&1 || fail "缺少运行命令：$command"
  done
  dsh --version
  pnpm --version
  gh_version=$(gh --version | awk 'NR == 1 { print $3 }')
  glab_version=$(glab --version | awk 'NR == 1 { print $2 }')
  check_minimum gh "$gh_version" 2.48.0
  check_minimum glab "$glab_version" 1.50.0
  [ -f "$PROFILE_PACKAGE" ] || fail "profile 尚未初始化；先运行容器的 init 命令"
  link_state=0
  profile_has_link || link_state=$?
  [ "$link_state" -eq 0 ] || fail "profile 未链接当前镜像内的 dsh-superagent bundle；先运行 init"
  dsh --profile "$PROFILE" --patch "$PROFILE_PATCH" --dump-config >/dev/null
  printf '检查通过：DSH profile=%s；持久化目录=/data/dsh、/data/superagent；gh=%s；glab=%s\n' \
    "$PROFILE" "$gh_version" "$glab_version"
}

healthcheck() {
  status_json=$(curl --fail --silent --show-error --max-time 3 \
    -H 'Host: 127.0.0.1:3082' \
    -H 'x-orchestrator-request: 1' \
    http://127.0.0.1:3082/orchestrator/api/state) || return 1
  printf '%s' "$status_json" | jq -e '.health.runtime.state == "ready" or .health.runtime.state == "paused"' >/dev/null
}

status() {
  curl --fail --silent --show-error --max-time 5 \
    -H 'Host: 127.0.0.1:3082' \
    -H 'x-orchestrator-request: 1' \
    http://127.0.0.1:3082/orchestrator/api/state | jq '{runtime: .health.runtime, setup: .setup}'
}

command=${1:-run}
case "$command" in
  help|-h|--help) usage ;;
  init) init_profile ;;
  doctor) doctor ;;
  status) status ;;
  healthcheck) healthcheck ;;
  run)
    init_profile
    doctor
    shift || true
    exec dsh --profile "$PROFILE" --patch "$PROFILE_PATCH" --no-open "$@"
    ;;
  *) usage >&2; fail "未知容器命令：$command" ;;
esac
