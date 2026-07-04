#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
./install.sh

printf '\n安装流程结束。可以关闭这个窗口。\n'
read -r -p "按回车退出..."
