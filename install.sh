#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DIARY_APP_DIR:-$HOME/diary}"
MODEL_DIR="${DIARY_MODEL_DIR:-$HOME/.local/share/diary/models}"
WHISPER_MODEL="${DIARY_WHISPER_MODEL:-$MODEL_DIR/ggml-base.bin}"
WHISPER_MODEL_URL="${DIARY_WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin}"
TEXT_MODEL="${DIARY_TEXT_MODEL:-qwen3.6:35b-mlx}"
VISION_MODEL="${DIARY_VISION_MODEL:-qwen3-vl:8b}"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/diary"
APP_NAME="Local Diary.app"
INSTALLED_APP="$HOME/Applications/$APP_NAME"
SYSTEM_APP="/Applications/$APP_NAME"

say() {
  printf '\n==> %s\n' "$1"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

say "准备本地日记工具"
if [ ! -d "$APP_DIR" ]; then
  echo "没有找到 $APP_DIR。请先把项目放到 ~/diary，或设置 DIARY_APP_DIR。"
  exit 1
fi

if ! has_cmd brew; then
  say "安装 Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

say "安装系统依赖"
brew install node ffmpeg whisper-cpp ollama

say "安装应用依赖"
cd "$APP_DIR"
npm install

say "下载 Whisper 默认模型"
mkdir -p "$MODEL_DIR"
if [ ! -f "$WHISPER_MODEL" ]; then
  curl -L "$WHISPER_MODEL_URL" -o "$WHISPER_MODEL"
else
  echo "已存在：$WHISPER_MODEL"
fi

say "启动 Ollama 后台服务"
if brew services list >/dev/null 2>&1; then
  brew services start ollama || true
fi
if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  nohup ollama serve >/tmp/diary-ollama.log 2>&1 &
  sleep 3
fi

say "尝试拉取默认本地模型：$TEXT_MODEL"
if has_cmd ollama; then
  ollama pull "$TEXT_MODEL" || {
    echo "模型拉取失败。应用仍可安装完成；请在设置里填写你本机可用的 Ollama 模型。"
  }
  say "尝试拉取默认图片理解模型：$VISION_MODEL"
  ollama pull "$VISION_MODEL" || {
    echo "图片理解模型拉取失败。应用仍可安装完成；请在设置里填写你本机可用的视觉模型。"
  }
fi

say "创建全局命令：diary"
mkdir -p "$BIN_DIR"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
if [ -d "$SYSTEM_APP" ]; then
  open "$SYSTEM_APP"
elif [ -d "$INSTALLED_APP" ]; then
  open "$INSTALLED_APP"
else
  cd "$APP_DIR"
  exec npm start
fi
EOF
chmod +x "$LAUNCHER"

for profile in "$HOME/.zshrc" "$HOME/.bashrc"; do
  touch "$profile"
  if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$profile"; then
    printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$profile"
  fi
done

say "安装检查"
npm run check || true

say "打包并安装可双击打开的 App"
npm run package

cat <<EOF

安装完成。

现在可以直接双击打开：
  $SYSTEM_APP

如果系统 Applications 目录没有权限，则打开：
  $INSTALLED_APP

也可以新开一个 Terminal 后运行：
  diary

当前 Terminal 可以先运行：
  export PATH="\$HOME/.local/bin:\$PATH"
  diary

EOF
