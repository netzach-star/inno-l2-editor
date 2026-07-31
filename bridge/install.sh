#!/bin/bash
# ============================================================
# 把「对话寄存区」装进 InnoSpark
#
#   用法：./bridge/install.sh <inno-agent 目录>
#         ./bridge/install.sh <inno-agent 目录> --uninstall
#
# 装完之后 InnoSpark 右侧面板会多一个「寄存区」标签，
# 每段 AI 回答下方会多一个「加入寄存区」按钮。
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-}"
MODE="install"
[[ "${2:-}" == "--uninstall" ]] && MODE="uninstall"

if [[ -z "$TARGET" ]]; then
    cat <<'EOF'

  用法：./bridge/install.sh <inno-agent 目录> [--uninstall]

  例：  ./bridge/install.sh ~/Documents/GitHub/inno-agent

  目录要指向 InnoSpark 的安装位置——就是有 restart-dev.sh 的那一层。

EOF
    exit 1
fi

TARGET="$(cd "$TARGET" 2>/dev/null && pwd)" || { echo "✗ 找不到目录：${1}"; exit 1; }

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
  卸载： ./bridge/install.sh "$TARGET" --uninstall

  注意：寄存区把内容送到 L2 编辑器（默认 http://localhost:4321），
        所以用之前要先把编辑器跑起来。地址可在寄存区面板里改。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
else
    echo "  已卸载。重启 InnoSpark： cd \"$TARGET\" && ./restart-dev.sh restart --mode prod"
fi
echo ""
