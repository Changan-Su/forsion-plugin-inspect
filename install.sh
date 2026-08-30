#!/usr/bin/env bash
# 装/更新「检视台」插件到 Forsion 家目录。
#   用法:sh install.sh [dev|prod]     缺省 dev(~/.forsion-dev);prod=~/.forsion
# 捆绑包:随包带两份技能(skills/inspect-skin、skills/inspect-motion),让 agent 能替用户做刀皮
# 和检视动作。没有 agents/ / spaces/,不写 ~/.tangu,重装不影响任何 agent 活体。
# ⚠️skills/ 必须跟着拷 —— 漏了的话本机一切正常、用户机器上那两个技能压根不存在(静默)。
# node_modules/ 与构建源不拷进去 —— 装的是 main.js 这份已构建产物。
set -euo pipefail
MODE="${1:-dev}"
case "$MODE" in
  dev)  HOME_DIR="$HOME/.forsion-dev" ;;
  prod) HOME_DIR="$HOME/.forsion" ;;
  *) echo "用法:sh install.sh [dev|prod]" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME_DIR/plugins/inspect"

# 不许从已安装目录内自更新:下面的 rm -rf 会先删掉复制源(自己),把插件卸成空壳
if [ "$HERE" = "$(cd "$DEST" 2>/dev/null && pwd || true)" ]; then
  echo "❌ 正在从已安装目录运行,请从源码仓的 forsion-plugin-inspect/ 目录执行 install.sh" >&2
  exit 2
fi

[ -f "$HERE/main.js" ] || { echo "❌ 缺 main.js,先跑 npm run build" >&2; exit 2; }

mkdir -p "$DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
for f in main.js manifest.json README.md CHANGELOG.md icon.png; do
  [ -e "$HERE/$f" ] && cp "$HERE/$f" "$DEST/"
done
if [ -d "$HERE/skills" ]; then cp -R "$HERE/skills" "$DEST/"; fi

echo "✅ 已安装 → $DEST"
echo "   随包技能:$(ls "$DEST/skills" 2>/dev/null | tr '\n' ' ')"
echo "重开 Forsion(dev:重启 desktop)后:在 Tangu Space 按 F,或命令面板搜「检视台」。"
