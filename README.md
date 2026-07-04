# 本地日记工具

一个运行在 macOS 本机的桌面日记工具。它把语音、草稿文字、照片放进当天的原料池，使用本地语音转文字和本地 AI 处理后，生成一篇自然、简洁的日记，并保存为当天的 Markdown 文件。

## 一键安装

双击：

```text
~/diary/Install Local Diary.command
```

或在 Terminal 里运行：

```bash
cd ~/diary
./install.sh
```

安装完成后，新开一个 Terminal，运行：

```bash
diary
```

也可以直接双击打开：

```text
~/Applications/Local Diary.app
```

## 打包成 .app

```bash
cd ~/diary
npm run package
```

这会生成 `dist/.../Local Diary.app`，并复制一份到 `~/Applications/Local Diary.app`。

`.app` 不包含 Ollama 大模型，也不包含几十 GB 的模型文件。它只负责 GUI 和本地调用；Ollama、Whisper 和模型由安装脚本安装在系统目录里。

## 测试材料

可以手动生成测试材料：

```bash
cd ~/diary
npm run samples
```

文件会放在本机临时开发目录：

```text
~/diary/test-materials
```

## 默认本地能力

- 语音转文字：`whisper-cli` 或 `whisper-cpp`，默认模型放在 `~/.local/share/diary/models/ggml-base.bin`
- 本地 AI：Ollama 兼容 API，默认地址 `http://127.0.0.1:11434`
- 默认日记模型：`qwen3.6:35b-mlx`
- 默认图片理解模型：`qwen3-vl:8b`

如果你的图片模型不是同一个模型，可以在应用右上角设置里改成支持视觉的本地模型。

## 数据保存

应用默认保存到 `~/Documents/DiaryVault`。可以在 UI 设置里改到任何文件夹。该目录里包含：

- `diary.sqlite3`：本地数据库
- `entries/YYYY-MM-DD/`：每天的原料和处理中间结果
- `entries/YYYY-MM-DD/YYYY-MM-DD.md`：当天生成的日记
