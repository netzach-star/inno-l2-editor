#!/bin/bash
# ============================================================
# 把「对话寄存区」装进 InnoSpark
#
#   用法：./bridge/install.sh                    自动找 InnoSpark
#         ./bridge/install.sh --uninstall        卸载
#         ./bridge/install.sh <inno-agent 目录>  指定目录（自动找不到时）
#
# 装完之后 InnoSpark 右侧面板会多一个「寄存区」标签，
# 每段 AI 回答下方会多一个「加入寄存区」按钮。
#
# **这个脚本不负责安装 InnoSpark 本身**——它只往一个已经装好的 InnoSpark 里
# 加东西。没装的话先去 https://github.com/hhyqhh/inno-agent 按它的说明装。
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$(cd "$HERE/.." && pwd)"

# 参数可以任意顺序：--uninstall 和目录都是可选的
TARGET=""
MODE="install"
for arg in "$@"; do
    case "$arg" in
        --uninstall) MODE="uninstall" ;;
        -*) echo "✗ 不认识的参数：$arg"; exit 1 ;;
        *) TARGET="$arg" ;;
    esac
done

# 是不是一个 InnoSpark 目录：要有 package.json，
# 而且得有 restart-dev.sh 或 apps/inno-agent 之一（光有 package.json 满地都是）
looks_like_inno() {
    [[ -f "$1/package.json" ]] || return 1
    [[ -f "$1/restart-dev.sh" || -d "$1/apps/inno-agent" ]] || return 1
    return 0
}

# 没给目录就自己找。顺序：环境变量 → 常见相对位置 → 插件同级目录里名字像的
if [[ -z "$TARGET" ]]; then
    CANDIDATES=()
    [[ -n "${INNO_AGENT_DIR:-}" ]] && CANDIDATES+=("$INNO_AGENT_DIR")
    CANDIDATES+=("$PLUGIN/../inno-agent" "$PWD/../inno-agent" "$PWD/inno-agent" "$HOME/inno-agent")
    for d in "$PLUGIN"/../inno-agent*; do [[ -d "$d" ]] && CANDIDATES+=("$d"); done

    FOUND=()
    for c in "${CANDIDATES[@]}"; do
        [[ -d "$c" ]] || continue
        abs="$(cd "$c" && pwd)"
        looks_like_inno "$abs" || continue
        # 去重
        dup=0; for f in "${FOUND[@]:-}"; do [[ "$f" == "$abs" ]] && dup=1; done
        [[ "$dup" == "0" ]] && FOUND+=("$abs")
    done

    if [[ "${#FOUND[@]}" == "1" ]]; then
        TARGET="${FOUND[0]}"
        echo ""
        echo "  自动找到 InnoSpark：$TARGET"
    elif [[ "${#FOUND[@]}" == "0" ]]; then
        cat <<'EOF'

  ✗ 没找到 InnoSpark。

  这个脚本只往**已经装好的** InnoSpark 里加东西，它不负责安装 InnoSpark 本身。

  · 还没装：先去 https://github.com/hhyqhh/inno-agent 按它的说明装好并能跑起来
  · 装了但不在旁边：把目录传进来，例如
        ./bridge/install.sh ~/Documents/GitHub/inno-agent
    目录要指向有 restart-dev.sh 的那一层

EOF
        exit 1
    else
        echo ""
        echo "  ✗ 找到多个 InnoSpark，不替你猜用哪个："
        for f in "${FOUND[@]}"; do echo "      $f"; done
        echo ""
        echo "    把要装的那个传进来： ./bridge/install.sh <目录>"
        echo ""
        exit 1
    fi
fi

TARGET="$(cd "$TARGET" 2>/dev/null && pwd)" || { echo "✗ 找不到目录：$TARGET"; exit 1; }
looks_like_inno "$TARGET" || {
    echo "✗ $TARGET 不像 InnoSpark 的目录（要有 package.json，且有 restart-dev.sh 或 apps/inno-agent）"
    exit 1
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  对话寄存区 → InnoSpark"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  目标：$TARGET"
echo ""

# 改动前先记一笔 git 状态，方便出事时回退
if git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
    DIRTY="$(git -C "$TARGET" status --porcelain -- 'apps/inno-agent/web/src' | wc -l | tr -d ' ')"
    if [[ "$DIRTY" != "0" && "$MODE" == "install" ]]; then
        echo "  ! 前端源码已有 $DIRTY 处未提交改动"
        echo "    出问题可以用 git checkout 还原，但会连你自己的改动一起丢"
        echo ""
    fi
    echo "  回退办法： git -C \"$TARGET\" checkout -- apps/inno-agent/web/src"
    echo ""
fi

node "$HERE/apply.mjs" "$TARGET" "$MODE"

echo ""
echo "  重新构建前端..."
if (cd "$TARGET" && npm run build >/tmp/inno-bridge-build.log 2>&1); then
    echo "  ✓ 构建完成"
else
    echo "  ✗ 构建失败，日志：/tmp/inno-bridge-build.log"
    tail -20 /tmp/inno-bridge-build.log
    exit 1
fi

echo ""
if [[ "$MODE" == "install" ]]; then
    cat <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  装好了。重启 InnoSpark 后：

    · 右侧面板多一个「寄存区」标签
    · 每段 AI 回答下方多一个「加入寄存区」
    · 攒够了点「开始总结」，自动打开 L2 编辑器开始生成

  重启： cd "$TARGET" && ./restart-dev.sh restart --mode prod
  卸载： ./bridge/install.sh --uninstall

  注意：寄存区把内容送到 L2 编辑器（默认 http://localhost:4321），
        所以用之前要先把编辑器跑起来。地址可在寄存区面板里改。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
else
    echo "  已卸载。重启 InnoSpark： cd \"$TARGET\" && ./restart-dev.sh restart --mode prod"
fi
echo ""
