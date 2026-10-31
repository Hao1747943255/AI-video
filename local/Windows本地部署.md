# 在你的 Windows 11 电脑部署

适用配置：i7-12700F、RTX 3060 Ti 8GB、内存 16GB。目标是本机运行 Qwen3 4B 语言模型与 Wan 2.1 1.3B 视频模型，不需要购买 API token。首次下载安装需要联网，之后模型生成在本机完成。硬件、电费和下载流量仍由你承担。

这份部署包和接口是在云端准备的，**尚未在你的电脑执行安装，也没有验证过你这张显卡的实际生成效果**。云端网页无法通过 localhost 操作你的电脑；请在电脑上运行本部署包。

## 1. 安装前准备

1. 更新 [NVIDIA 官方驱动](https://www.nvidia.com/Download/index.aspx)并按提示重启。脚本使用 CUDA 12.8 版 PyTorch，旧驱动可能无法启动。无需单独安装 CUDA Toolkit。
2. 解压本部署包到一个普通目录，例如 `D:\AI\Frame`。不要在压缩包内部运行。
3. 为安装位置保留至少 50GB 空间。Wan 的三个模型文件共约 **9.83GB**，还会安装 Qwen、Python、PyTorch 等。目录默认位于 `%LOCALAPPDATA%\FrameAI`，可改到 D 盘。
4. 内存只有 16GB，请关闭游戏等占用显存的程序，并保留 Windows 的**系统管理分页文件**及足够磁盘空间。若此前关闭过：搜索“查看高级系统设置”→“性能/设置”→“高级”→“虚拟内存/更改”，启用“自动管理所有驱动器的分页文件大小”，按 Windows 提示重启。脚本不会自行更改分页文件。
5. 语言模型和视频模型不要同时生成。此版本会在润色结束后卸载 Qwen；再次润色前请求 ComfyUI 释放缓存。

## 2. 执行安装

在解压后的项目目录中，右键选择“在终端中打开”，使用 PowerShell：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows.ps1
```

如果希望模型和运行环境安装在 D 盘：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows.ps1 -InstallRoot D:\AI\FrameRuntime
```

如果 Windows 因下载来源标记阻止脚本，先检查脚本内容、确认来源，再仅解除该文件的锁定，然后重新执行上面的命令：

```powershell
Get-Content .\scripts\setup-windows.ps1
Unblock-File .\scripts\setup-windows.ps1
```

脚本会安装缺少的 Git、Node.js、Python 3.12、FFmpeg、Ollama，下载固定版本 ComfyUI `v0.3.59`，创建独立 Python 虚拟环境，安装 CUDA PyTorch，下载模型并生成本机路径配置。Windows 可能弹出官方安装器权限提示。若已有 Node 版本过旧或新命令尚未进入 PATH，脚本会停止并给出提示；更新或重开终端后重试即可。

已有 `.env` 和不同版本的 ComfyUI 不会被覆盖或重置。如果路径已被其他安装占用，用不同的 `-InstallRoot`。

可以先加 `-SkipModels` 只安装运行环境，之后再下载模型：

```powershell
ollama pull qwen3:4b
npm.cmd run models:download -- "D:\AI\FrameRuntime\ComfyUI"
```

Wan 文件来自 ComfyUI 官方示例指定的公开仓库。下载脚本固定模型版本，并对每个文件验证 SHA-256；中断后可续传，不会将未校验文件当作已安装模型。不要关闭 TLS 或校验来绕过下载错误。

## 3. 启动并验证

### FFmpeg 下载出现 InternetOpenUrl / 0x80072efd

这表示 Winget 下载 FFmpeg 安装包时连接失败。已经成功安装的 Git、Python 会保留。更新项目后重新运行安装脚本，新版会在 Winget 失败时自动使用 Windows 自带的 curl 下载官方 9.0.2 essentials ZIP（约 115MB），校验 SHA-256 再解压，并将工具目录追加到用户 PATH。它不会关闭 TLS 校验或跳过文件校验。

只修复 FFmpeg 也可以运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\install-ffmpeg.ps1 -InstallRoot D:\ai_video\FrameRuntime
```

如果 curl 也无法连接，在浏览器下载[官方 FFmpeg 9.0.2 essentials ZIP](https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip)，然后指定下载文件：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\install-ffmpeg.ps1 -InstallRoot D:\ai_video\FrameRuntime -ArchivePath "$env:USERPROFILE\Downloads\ffmpeg-9.0.2-essentials_build.zip"
```

两种方式都使用官方发布元数据中的固定 SHA-256：`60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`。完整安装版或其他版本的 ZIP 不匹配此校验值，请选择名称完全相同的 essentials ZIP。完成后重新运行主安装脚本继续安装剩余工具与模型；无需删除已有环境。

### 启动服务

在项目目录运行：

```powershell
npm.cmd run local:start
```

启动脚本会复用已有的本机 Ollama / ComfyUI 服务；没有服务时，按 `.env` 中的绝对路径启动。ComfyUI 使用 `--lowvram`，网页服务仅监听本机。打开：

```text
http://127.0.0.1:3001
```

1. 打开“生成设置”，点击“重新检测”。语言模型应显示“已连接”，视频模型应显示“文件与节点就绪”。这只说明连接、文件和节点检查通过，**不代表已验证显存足够或已生成成功**。
2. 输入例如：“一只小狐狸在森林中缓慢行走，清晨柔和阳光，镜头平稳跟随”。点击“本地 AI 润色”，确认出现完整提示词。
3. 将“生成模式”改为“本地 Wan · 无需 Token”，使用 16:9、2 秒，点击生成。
4. 第一次加载模型可能较慢。请查看运行终端中的 ComfyUI 输出，完成后在网页播放并下载视频。

检测命令也可以单独运行：

```powershell
npm.cmd run local:check
```

该命令会显示电脑配置、工具是否可用、Ollama 模型和 ComfyUI 文件/节点检查结果。检查不通过会以非零状态退出，请把相关报错文字发回聊天继续排查，不需要提供 API 密钥。

`Ctrl+C` 停止本次启动脚本管理的服务；它会复用并保留原本已在运行的服务。Windows 若仍留有独立 Ollama 桌面应用，可从托盘退出。

想单独使用语言模型聊天，可在新终端运行 `ollama run qwen3:4b`。退出聊天后，在生成视频前运行 `ollama stop qwen3:4b` 释放显存。

## 配置与限制

### 打开 3001 端口却显示 Cannot GET /

这说明端口上的服务有响应，但没有提供网页首页。常见原因是使用旧版本后端、前端尚未构建，或构建后没有重启旧进程。无需重新下载模型。

在正在运行服务的终端按 `Ctrl+C`，然后进入**包含 package.json 的项目目录**运行：

```powershell
npm.cmd run build
npm.cmd start
```

打开 `http://127.0.0.1:3001`。新版 `npm start` 会自动构建前端；`npm start` 只启动网页/API，不负责启动模型服务。Ollama 与 ComfyUI 已有服务时可继续复用。

如果使用的是 `npm.cmd run dev`，开发网页地址是 `http://127.0.0.1:5173`，3001 是后端端口。检查 `http://127.0.0.1:3001/api/health`，新版后端返回 `app: frame-ai-video` 和 `frontendReady: true`。若此接口也返回 Cannot GET，仍运行的是旧进程或其他项目，请确认已关闭旧终端并在正确目录启动。

### 参数

```dotenv
HOST=127.0.0.1
PORT=3001
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_DIR="D:/AI/FrameRuntime/ComfyUI"
COMFYUI_PYTHON="D:/AI/FrameRuntime/ComfyUI/.venv/Scripts/python.exe"
```

- 本地视频固定为 512×288 横屏或 288×512 竖屏，33 帧，约 16fps，2 秒，无音轨。默认 20 步采样。先验证这组参数，再考虑更高分辨率或更长视频；它不会有云端大模型相同的质量。
- 文本编码器在 CPU 运行以减少显存占用，系统内存和分页文件仍会影响速度。不能保证具体生成耗时；显存不足或系统卡顿时先停止任务、关闭其他程序，后续可再降低分辨率或升级到 32GB 内存。
- 切勿通过降低显存限制强行同时加载多个模型。网页用不确定进度指示，本地采样细节以 ComfyUI 控制台为准。
- 模型、ComfyUI 输出和网页作品是不同目录。删除网页作品只删除网页持有的副本；原始 ComfyUI 输出仍在其 `output/frame` 子目录，可自行清理。
- 默认仍可使用不理解提示词的演示模式；本地模式失败不会转向付费服务。Sora 选项是独立的，仅当自行配置密钥并手动选择时使用。
- 本地服务仅绑定本机，不需要打开防火墙端口、端口转发或公网访问。

官方来源：[Ollama](https://ollama.com/download/windows)、[Qwen3 4B](https://ollama.com/library/qwen3:4b)、[ComfyUI](https://github.com/Comfy-Org/ComfyUI)、[Wan 官方示例](https://comfyanonymous.github.io/ComfyUI_examples/wan/)。
