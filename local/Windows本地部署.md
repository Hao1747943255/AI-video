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

### ComfyUI 克隆出现 Connection was reset

如果在 `Cloning into ... ComfyUI` 阶段出现 `Recv failure: Connection was reset`，说明 Git 源码传输连接被重置。Git、Python、FFmpeg、Ollama 等已完成的安装会保留。更新代码后重跑原安装命令，新版只对 ComfyUI 克隆使用 HTTP/1.1，并保留 TLS 校验，最多尝试三次。

每次下载使用独立临时目录，校验 `v0.3.59` 的固定提交 `72212fef660bcd7d9702fa52011d089c027a64d8` 后才启用。已有可用源码会复用；缺少 `main.py` 的旧残留目录会改名为 `ComfyUI.incomplete-...`，其中的文件不会删除。若三次均失败，需要先恢复到 GitHub 的连接，再继续安装；该步骤不需要 GitHub token。

### Python 依赖下载超时或找不到 aiohttp

如果安装 Python 依赖时反复出现 `Read timed out`，随后报告 `No matching distribution found for aiohttp>=3.11.8`，先检查下载源是否可达。Python 3.12 / Windows x64 有对应的 aiohttp 安装包；该错误本身不足以证明版本不兼容。

新版脚本为 pip 升级、PyTorch 和 ComfyUI 依赖安装设置 120 秒下载超时、最多 5 次重试。已安装的指定 CUDA 版 PyTorch 会复用，安装后执行 `pip check` 及现有 CUDA 可用性检查。默认主索引为官方 PyPI；网络不稳定时，可以为 pip 升级和 ComfyUI 普通依赖指定清华 TUNA HTTPS 镜像：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "D:\ai_video\AI-video\scripts\setup-windows.ps1" -InstallRoot "D:\ai_video\FrameRuntime" -PipIndexUrl "https://pypi.tuna.tsinghua.edu.cn/simple"
```

该参数不修改全局 pip 配置。PyTorch 下载仍使用官方 CUDA 12.8 索引，模型权重来源保持原样。脚本保留安装缓存和已装包，不使用 `--trusted-host` 或关闭 TLS 校验。若该镜像无法访问，可不传 `-PipIndexUrl` 使用官方源，或提供你能访问的 HTTPS 包索引。镜像说明见[清华 TUNA PyPI 帮助](https://mirrors.tuna.tsinghua.edu.cn/help/pypi/)。

### 启动 ComfyUI 时提示 No module named 'requests'

若日志已识别显卡和 PyTorch，但在 `app/frontend_management.py` 的 `import requests` 处停止，说明 ComfyUI 虚拟环境缺少这个启动依赖。`pip check` 只能验证已声明的包依赖，所以此前通过检查仍可能遇到此错误。新版安装器显式安装 `requests>=2.32.5,<3` 并验证导入，不改动固定版本 ComfyUI 的依赖清单。

已有环境无需重跑完整安装。在当前启动窗口按 `Ctrl+C`，然后依次执行下面两条命令；第一条成功后再执行第二条：

```powershell
& "D:\ai_video\FrameRuntime\ComfyUI\.venv\Scripts\python.exe" -m pip install "requests>=2.32.5,<3" --index-url "https://pypi.tuna.tsinghua.edu.cn/simple" --timeout 120 --retries 5
& "D:\ai_video\FrameRuntime\ComfyUI\.venv\Scripts\python.exe" -c "import requests; print(requests.__version__)"
```

这是为 ComfyUI 自己的 Python 环境补装依赖，不能换成系统 `pip`。清华 TUNA 无法连接时，将 `--index-url` 换为 `https://pypi.org/simple` 即可。确认导入成功后，再执行 `npm.cmd --prefix "D:\ai_video\AI-video" run local:start`。已校验的 Wan 模型和 Qwen 保留，不重新下载。

### Wan 视频模型下载失败

如果终端已经显示 Python 包安装成功、`No broken requirements found`、CUDA 显卡名称和 Qwen 下载 `success`，但随后 `models:download` 报网络失败，说明安装停在 Wan 权重下载。保留当前环境，更新项目后可以仅恢复此步骤：

```powershell
node "D:\ai_video\AI-video\scripts\download-models.mjs" "D:\ai_video\FrameRuntime\ComfyUI"
```

默认使用官方 Hugging Face。若无法连接，可以显式选择第三方 HF-Mirror：

```powershell
node "D:\ai_video\AI-video\scripts\download-models.mjs" "D:\ai_video\FrameRuntime\ComfyUI" --endpoint "https://hf-mirror.com"
```

完整安装命令也支持 `-ModelEndpoint "https://hf-mirror.com"`，它与 `-PipIndexUrl` 分别控制模型和 Python 包来源。HF-Mirror 不是 Hugging Face 官方站点；下载器不会自动切换端点，也不会向其发送 Hugging Face token。所有来源均按原始清单的固定版本、大小和 SHA-256 校验，不修改预期校验值。

每个文件最多尝试 3 次，保留 `.part` 分片并校验断点响应。连接失败会显示如 `UND_ERR_CONNECT_TIMEOUT`、`ECONNRESET`、`ENOTFOUND` 等错误码，不打印代理凭据、完整签名链接或请求对象。若出现证书错误，保留 TLS 校验并检查受信任证书；如需使用已有 HTTP 代理，可通过其正常的 `HTTPS_PROXY` / `HTTP_PROXY` 环境配置运行，不把代理账号或密码发到聊天。

也可以在浏览器或其他已验证的下载工具中取得以下三个相同版本的文件，将它们放在一个目录中，再离线导入。版本与校验值见 `local/models.json`；[官方文件目录](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/tree/123acf1cc74bccbb9bfff8ac1ee72edc08c2341d/split_files)。

| 文件名 | ComfyUI 下的目标目录 |
| --- | --- |
| wan2.1_t2v_1.3B_fp16.safetensors | models/diffusion_models |
| umt5_xxl_fp8_e4m3fn_scaled.safetensors | models/text_encoders |
| wan_2.1_vae.safetensors | models/vae |

```powershell
node "D:\ai_video\AI-video\scripts\download-models.mjs" "D:\ai_video\FrameRuntime\ComfyUI" --from-dir "D:\Downloads\Wan"
```

导入时不会请求网络，原始文件保留；目标文件已验证则复用，目标文件校验不符则停止并保留，不覆盖。导入过程需要足够空间同时保存原文件与目标副本。三个模型都通过校验后，再按下面步骤启动服务。镜像仅在云端验证过小范围请求，目标电脑的完整下载仍需实际运行确认。

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
2. 输入例如：“一只小狐狸在森林中缓慢行走，清晨柔和阳光，镜头平稳跟随”。可以直接生成，也可点击“本地 AI 润色”，检查结果是一段保留原主体与动作的画面描述。新版要求结构化最终结果，不把分析过程当提示词；结果不满意可“撤销润色”，错误或等待期新编辑会保留原文。
3. 确认“生成模式”为默认的“本地 Wan”，使用 16:9、2 秒，点击“生成 AI 视频”。模型未就绪时先处理检测提示；不要为绕过检测改用演示模式，演示模式只对内置照片运镜。
4. 第一次加载模型可能较慢。请查看运行终端中的 ComfyUI 输出，完成后在网页播放并下载视频。

检测命令也可以单独运行：

```powershell
npm.cmd run local:check
```

该命令会显示电脑配置、工具是否可用、Ollama 模型和 ComfyUI 文件/节点检查结果。检查不通过会以非零状态退出，请把相关报错文字发回聊天继续排查，不需要提供 API 密钥。

`Ctrl+C` 停止本次启动脚本管理的服务；它会复用并保留原本已在运行的服务。Windows 若仍留有独立 Ollama 桌面应用，可从托盘退出。

想单独使用语言模型聊天，可在新终端运行 `ollama run qwen3:4b`。退出聊天后，在生成视频前运行 `ollama stop qwen3:4b` 释放显存。

### 收到任务后 ComfyUI 退回 PowerShell，网页提示连接失败

如果 ComfyUI 已显示 `Starting server`、`got prompt`，随后在模型加载信息之后直接出现 `PS D:\ai_video\FrameRuntime\ComfyUI>`，说明 Python 进程已退出。网页连接失败是后续结果，不能据此认定模型未安装。`Using scaled fp8: fp8 matrix mult: False, scale input: False` 是固定版本的普通日志，本身不是错误，也不能单凭它认定显存不足。

先在**该 ComfyUI 窗口**读取退出码，保留输出，再运行其他程序或重新启动；安装 `requests` 或下载模型的另一个窗口无法提供这次退出码：

```powershell
$LASTEXITCODE
```

如果原窗口已关闭或退出码被覆盖，确认没有仍在运行的 ComfyUI 任务后，可以启用 Python 故障诊断并重新运行一次。先看到服务器就绪，再在网页提交一次任务；若再次退回提示符，立即执行下面最后一行读取退出码。不要在服务仍运行时输入它：

```powershell
Set-Location "D:\ai_video\FrameRuntime\ComfyUI"
& ".\.venv\Scripts\python.exe" -X faulthandler -u ".\main.py" --listen 127.0.0.1 --port 8188 --lowvram
$LASTEXITCODE
```

保留故障诊断输出和退出码，用于区分可见 Python 异常、原生程序崩溃与其他终止原因。退出码也不一定能独立证明根因，必要时还需 Windows 应用程序或资源耗尽事件。不要在没有证据时重装 PyTorch、删除已校验模型或反复点击“重新生成”。新版网页会区分连接拒绝、连接中断、超时与 HTTP 返回错误；工作流被拒绝和连接失败分别报告，任务查询失败会提醒先检查控制台及队列。

### 视频没有按照提示词生成

先看任务的生成模式。若选择“演示样片”，海面、森林等画面来自内置照片，输入文字不会改变其主体。应切换“本地 Wan”，确认模型就绪后，用一段具体画面描述重新生成。新版默认使用本地 Wan，演示片需手动选择且在生成前确认。

如果输入框里出现“首先，用户要求……”或“关键点”等分析文字，先恢复自己的原始描述；无需先润色才能使用 Wan。比如要展示设备操作，可直接写：“皮秒激光设备在诊室内运行，操作人员手持治疗头沿前臂纹身区域缓慢移动，设备与治疗头清晰可见，近景平稳拍摄。”当前单段为最多 2 秒、288p，较长成片由多段合成；真实模型对专业设备、精细操作和语义一致性的表现仍需实际验证，不能保证精确复现。

### 多时长与参考模板

在创作区“视频时长”选择 2、4、6、8、12、20、30、60 秒，或选择“根据提示词识别”，并写明“总时长十二秒”等目标。每次生成一个时长，本地与演示 API 接受 2–60 秒整数，Sora 仍仅支持 4、8、12 秒。长片按最多 2 秒的独立片段串行生成后用 FFmpeg 合成，人物和动作衔接可能变化。先确认本机 2 秒真实任务能够完成，再生成更长视频；原有 PyTorch/c10.dll 崩溃仍需先解决。

模板视觉分析需额外安装模型，现有 Qwen3 文字模型不能读图：

```powershell
ollama pull qwen2.5vl:3b
```

在“生成设置”重新检测后，打开左侧“参考模板”上传图片或视频，点击“分析模板”。检查摘要、人物、场景、物体、风格、动作、镜头描述，修改后保存，再点击“用于创作”。创作区勾选需要参考的要点并输入自己的创作要求。默认 `TEMPLATE_VISION_MODEL=qwen2.5vl:3b` 可在 `.env` 改为已安装且有视觉能力的 Ollama 模型；也可手动保存参考描述。

支持 JPEG、PNG、WebP、MP4、MOV、WebM，单文件最多 100 MiB，视频最长 5 分钟，最多 20 个模板。视频只抽取最多 6 个画面，不分析音频。素材与描述保存在项目 `data/templates/`，不会因为选择模板就训练模型权重，也不能锁定原人物或保证全部细节一致。分析与生成错开运行，视觉模型完成后自动卸载。模板描述随生成任务保存快照，后续修改模板不改变已有任务；删除作品会清理该任务的长片分段。

### 创作记忆与连续修改

创作区默认开启“使用上下文记忆”，复用已安装的 `qwen3:4b`。先写完整画面描述并润色或生成，之后在同一会话中输入“把背景换成夜景”“保持时长，镜头拉近”等要求即可联系上下文。生成前会把跟进要求整理为完整描述；需要本机语言模型正常运行，并与视频、模板分析错开执行。有历史的任务会多一次语言模型调用，耗时依硬件而定。

用“新会话”区分不同主题，在“创作记忆”页可重命名、查看和删除会话，手动编辑长期偏好，或清空记录。长期偏好适用于所有会话，当前明确要求和界面参数优先；会话之间不混入历史。刷新后保留会话与参数，切换会话可恢复最近描述。记忆最多 20 个会话，每个最近 30 条；实际模型输入仅使用最近最多 4 条和有限字数，不能保证记住全部细节。

记忆保存在项目 `data/memory.json`，不训练模型权重。润色建议和已提交要求会记录，渲染完成或失败会标记状态；AI 不会因此自动观看成片。撤销润色会尝试移除相应建议；可关闭记忆、逐条删除、清空当前或清除全部。清除期间的旧模型结果不能重新写入；已有作品和已提交任务的描述快照仍保留。历史任务重试沿用其原整理描述，不套用当前其他会话。记忆文件损坏时保留原文件并停止初始化，需先备份检查；本机真实 Qwen 连续对话效果仍需验证。

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

- 本地画面为 512×288 横屏或 288×512 竖屏，单段最多 2 秒（2 秒时为 33 帧），每段默认 20 步采样，无音轨；较长成片合成为 16fps、2–60 秒。先验证短片参数和机器稳定性，长片耗时更久，独立分段不能保证角色与动作连续。
- 文本编码器在 CPU 运行以减少显存占用，系统内存和分页文件仍会影响速度。不能保证具体生成耗时；显存不足或系统卡顿时先停止任务、关闭其他程序，后续可再降低分辨率或升级到 32GB 内存。
- 切勿通过降低显存限制强行同时加载多个模型。网页用不确定进度指示，本地采样细节以 ComfyUI 控制台为准。
- 模型、ComfyUI 输出和网页作品是不同目录。删除网页作品只删除网页持有的副本；原始 ComfyUI 输出仍在其 `output/frame` 子目录，可自行清理。
- 默认使用本地 Wan；演示模式只供手动确认后体验内置照片运镜。本地模式失败不会自动转为演示或付费服务。Sora 选项是独立的，仅当自行配置密钥并手动选择时使用。
- 本地服务仅绑定本机，不需要打开防火墙端口、端口转发或公网访问。

官方来源：[Ollama](https://ollama.com/download/windows)、[Qwen3 4B](https://ollama.com/library/qwen3:4b)、[ComfyUI](https://github.com/Comfy-Org/ComfyUI)、[Wan 官方示例](https://comfyanonymous.github.io/ComfyUI_examples/wan/)。
