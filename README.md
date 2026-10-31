# Frame · AI 视频生成器

中文视频创作工作台，基于 React、Vite、Express 和 FFmpeg。支持提示词、四种画面风格、横竖屏、4 / 8 / 12 秒时长、后台任务、进度预览、MP4 下载与作品管理，适配桌面和手机。

## 在自己的电脑上免费运行真实模型

只想先看界面时，可以运行 `npm run preview:export`，然后直接用浏览器打开 `artifacts/Frame-preview.html`。这个独立 HTML 内嵌所有图片、脚本和样式，无需服务器、Node.js 或模型即可查看界面。可切换风格、参数、导航和弹窗；视频生成和 AI 润色明确禁用。聊天中的 localhost 网页卡片不能用作可分享的云端预览地址。

已增加 Ollama 提示词润色与 ComfyUI / Wan 2.1 本机视频生成接口，不需要付费 API token。针对 Windows 11、RTX 3060 Ti 8GB、16GB 内存准备了安装脚本和低显存参数。请先阅读 [Windows 本地部署说明](local/Windows本地部署.md)。该硬件从 512×288 / 288×512、2 秒视频开始，语言模型与视频模型错开运行。

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows.ps1
npm.cmd run local:start
```

浏览器打开 `http://127.0.0.1:3001`，先在生成设置检查本机模型，再使用“本地 AI 润色”与“本地 Wan”。`npm run local:check` 可报告工具与服务状态。下载模型需联网；生成使用本机算力，无付费 API 调用。接口与模拟流程已测试，Windows 安装和真实 GPU 推理仍需在你自己的电脑验证。

## 快速运行

需要 Node.js 22+、npm 和带 `libx264` 编码器的 FFmpeg。当前云环境已安装所需工具。

```bash
cd /workspace/AI-video
npm ci
npm run dev
```

前端使用 5173 端口，后端使用 3001 端口；Vite 自动代理 `/api` 请求。开发模式后端端口请保持 3001。在其他机器中，可先用 `ffmpeg -version` 检查安装，Debian / Ubuntu 可通过系统包管理器安装 `ffmpeg`。

生产运行：

```bash
npm run build
npm start
```

生产服务默认监听本机 3001 端口，同时提供静态页面与 API。可通过 `PORT` 修改生产端口，通过 `HOST` 显式修改监听地址；本机部署保留 `127.0.0.1`。

`npm start` 现在会先自动构建前端（需要安装完整开发依赖）。开发模式使用 5173，生产模式使用 3001。如果出现 `Cannot GET /`，先停止旧进程，在项目根目录执行 `npm run build` 再执行 `npm start`，无需重装模型。`/api/health` 可查看应用标识和 `frontendReady` 状态；缺少构建文件时首页会显示修复命令。

## 生成模式

### 本地 Wan 2.1（真实 AI，无 API 费用）

在自己电脑启动 ComfyUI 并安装 `local/models.json` 中的三个官方模型文件，选择“本地 Wan”。后端使用原生节点提交工作流、轮询任务历史并保存 MP4，无自定义节点依赖。本地视频默认 33 帧、约 16fps、2 秒；模型处理阶段显示不确定进度，不虚构百分比。生成失败不转向付费服务。服务重启后，已保存 ComfyUI 任务编号的任务会继续查询。

Ollama 的“本地 AI 润色”使用 `qwen3:4b`，完成后 `keep_alive=0` 卸载模型。视频任务运行时禁止润色，润色前请求 ComfyUI 释放缓存。本机模型地址仅支持 HTTP loopback，默认分别为 `127.0.0.1:11434` 和 `127.0.0.1:8188`。

### 演示模式（默认，无需密钥）

FFmpeg 将所选风格的内置照片处理为缓慢推近、带淡入淡出的 H.264 MP4，实际应用所选比例和时长。**演示模式不会理解提示词，也不会调用 AI 模型；它不是文生视频的真实 AI 输出。**界面、任务记录与作品卡片均标明“演示样片”。

输出为 1280×720 横屏或 720×1280 竖屏，24 fps，无音轨。此模式用于完整体验生成、播放和下载流程。

### OpenAI Sora 2（配置后可用）

复制 `.env.example` 为 `.env`，在本机安全编辑并填入自己的密钥：

```dotenv
VIDEO_API_KEY=你的_OpenAI_API_密钥
```

重启服务器，在“生成模式”中选择 Sora 2。也支持服务器已有的 `OPENAI_API_KEY`，优先使用非空 `VIDEO_API_KEY`。密钥仅供后端调用，不返回前端，不应放在 `VITE_*` 变量或提示词中。`.env` 已被 Git 忽略。

实现使用官方 `POST /v1/videos` multipart 接口、`GET /v1/videos/:id` 轮询和 `GET /v1/videos/:id/content` 下载。模型为 `sora-2`，时长为 4 / 8 / 12 秒，尺寸为 1280×720 / 720×1280；风格以英文视觉指导附加到提示词。保留环境提供的 HTTPS 代理与 TLS 校验。

实际 AI 调用需要账户具备视频接口权限、足够额度，以及访问 `api.openai.com` 的网络权限，可能按服务商规则计费。当前版本未配置密钥，所以**真实模型生成尚未进行在线验证**；接口适配器的成功与失败路径通过模拟响应测试。未配置密钥时，AI 请求明确失败，不会退回演示模式。

## 数据与任务

- `data/jobs.json` 保存任务元数据，原子替换写入；`data/<任务 UUID>.mp4` 保存成片。部署时请将 `data/` 挂载为持久卷并备份。
- 单个服务器串行生成任务，最多 5 个待处理任务和 100 条历史记录。视频只在本机保存，不上传第三方存储。
- 浏览器刷新或离开页面不影响后台任务；在“我的作品”可找回记录。服务重启后，已取得远端 ID 的 Sora 任务会继续轮询，本地未完成的演示任务标为失败，可手动重新生成。
- 删除作品同时删除本地视频与记录；活动任务不可删除。失败任务可重试，重试 AI 生成可能创建新的付费任务。
- 此版本为单用户工作台，不提供登录或用户隔离。对外部署前，应在网关添加认证和访问限制，尤其是已配置付费密钥的服务。不要启动多个实例共同写入同一个 JSON 存储。
- 图生视频、声音编辑与多镜头剪辑不在当前版本范围内。

## 验证

```bash
npm run build
npm test

# 先运行 npm run dev，再在另一个终端执行：
npm run test:ui
```

API 测试会实际生成横竖屏视频，通过 FFprobe 验证 H.264、尺寸与时长，同时检查视频流范围请求、下载、删除、参数校验、失败状态、重启恢复和模拟 Sora 接口。UI 测试使用系统 Chromium（默认 `/usr/bin/chromium`），覆盖提示词校验、选择灵感、生成、播放、下载、刷新找回、搜索、删除及移动端导航。可通过 `CHROMIUM_PATH` 和 `TEST_BASE_URL` 覆盖浏览器路径与测试地址。

UI 测试创建带独立标记的测试作品，流程完成后仅删除该作品；API 测试使用独立临时目录，不修改开发作品。

Windows 安装器在 Winget 下载 FFmpeg 失败时，会使用带固定 SHA-256 校验的官方 essentials ZIP 作为备用来源，也支持手动指定已下载的 ZIP。可运行 `powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File tests/ffmpeg-installer.tests.ps1` 验证错误校验值会在解压和修改 PATH 前被拒绝，并保留已有文件。该检查不安装真实工具；Windows 安装与网络连通性仍须在目标电脑验证。

ComfyUI 源码克隆使用单次命令级 HTTP/1.1 和 TLS 校验，并最多重试三次；每次在新目录下载，验证固定提交后启用，已有不完整目录会备份保留。可运行 `powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File tests/comfy-source.tests.ps1` 验证连接失败重试、旧文件保留、固定提交检查和重试上限；测试模拟 Git 传输，不下载模型。

## 项目结构

```text
src/                 React 工作台和响应式样式
server/app.js        HTTP API、持久化与任务队列
server/providers.js  FFmpeg 演示渲染与 Sora 接口
public/images/       随应用提供的演示照片
tests/               API 集成测试和浏览器流程测试
```

## 文档维护约定

每次新增功能、调整现有功能或增加新模块，都同步更新本 README，说明变更内容及受影响的使用方法、命令、配置、依赖和限制。新增模块补充用途和项目结构说明，对用户可见的变更维护简明的中文更新记录，代码与文档一起提交。

完整的长期协作偏好见 [AGENTS.md](AGENTS.md)，包括中文提交说明及环境发布后的 GitHub 同步规则。

演示照片来源于 [Unsplash](https://unsplash.com/license)：[海面](https://images.unsplash.com/photo-1518837695005-2083093ee35b)、[森林](https://images.unsplash.com/photo-1448375240586-882707db888b)、[湖泊](https://images.unsplash.com/photo-1470770841072-f978cf4d019e)、[都市](https://images.unsplash.com/photo-1519608487953-e999c86e7455)。素材已打包在仓库，运行时无需访问图片网站。
