import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRANCH, REPOSITORY, findGit } from './offline-update.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitPath = findGit();
const git = args => execFileSync(gitPath, ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (git(['branch', '--show-current']) !== BRANCH) throw new Error(`请从 ${BRANCH} 导出。`);
if (git(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('请先提交源码和文档，再导出离线更新包。');
const commit = git(['rev-parse', 'HEAD']);
const historyPaths = git(['rev-list', '--objects', `refs/heads/${BRANCH}`]).split('\n')
  .filter(line => line.includes(' ')).map(line => line.slice(line.indexOf(' ') + 1));
const blocked = historyPaths.some(name => /(^|\/)(node_modules|data|\.venv|artifacts)(\/|$)/i.test(name) ||
  /(^|\/)\.env($|\.(?!example$))/i.test(name) || /\.(safetensors|gguf|ckpt)$/i.test(name));
if (blocked) throw new Error('分支历史包含配置、运行数据或模型路径，已停止导出；请先检查历史，勿直接分享完整 bundle。');
const output = path.join(repo, 'artifacts', `AI-video-offline-update-${commit.slice(0, 7)}`);
mkdirSync(output, { recursive: true });
const bundle = 'AI-video.bundle';
git(['bundle', 'create', path.join(output, bundle), `refs/heads/${BRANCH}`]);
const sha256 = createHash('sha256').update(readFileSync(path.join(output, bundle))).digest('hex');
writeFileSync(path.join(output, 'update-manifest.json'), JSON.stringify({
  schemaVersion: 1, repository: REPOSITORY, branch: BRANCH, commit, bundle, sha256,
}, null, 2) + '\n');
copyFileSync(path.join(repo, 'scripts', 'offline-update.mjs'), path.join(output, 'apply-offline-update.mjs'));
writeFileSync(path.join(output, 'start-update.cmd'), [
  '@echo off', 'setlocal DisableDelayedExpansion', 'set "frameNode=node"',
  'if exist "%ProgramFiles%\\nodejs\\node.exe" set "frameNode=%ProgramFiles%\\nodejs\\node.exe"',
  'set "frameRepo=D:\\ai_video\\AI-video"', 'if not "%~1"=="" set "frameRepo=%~1"',
  '"%frameNode%" "%~dp0apply-offline-update.mjs" "%frameRepo%"',
  'set "frameExitCode=%errorlevel%"', 'if not "%frameExitCode%"=="0" echo Update stopped. See the message above.',
  'pause', 'exit /b %frameExitCode%', '',
].join('\r\n'));
writeFileSync(path.join(output, '使用说明.txt'), `AI-video 离线更新包\n\n版本：${commit}\n分支：${BRANCH}\nbundle SHA-256：${sha256}\n\n1. 先解压整个 ZIP 到仓库外，例如 D:\\ai_video\\offline-update。不要直接在 ZIP 内运行。\n2. 关闭 GitHub Desktop 的错误弹窗，停止正在运行的项目，再双击 start-update.cmd。默认更新 D:\\ai_video\\AI-video。\n3. 看到“离线更新成功”或“已经是更新包中的版本”即完成。\n\n其他安装位置：在 PowerShell 执行 node .\\apply-offline-update.mjs "你的已有仓库路径"。\n需要已有 Node.js 22+ 及 Git 或 GitHub Desktop。运行更新无需 npm install、GitHub 联网或管理员权限。\n更新器检查项目、分支、包哈希、工作区及提交关系，只允许快进更新。不自动暂存、重置或切换分支。遇到未提交改动或本地独有提交会停止，请先保留这些改动。\n.env、data、已有模型和 FrameRuntime 不参与代码更新。不修改 GitHub 远端地址。\nGitHub Desktop 的 origin 状态可能仍是上次联网状态；网络恢复后 Fetch origin 即可刷新。\n此包只更新代码，不能修复你电脑到 github.com 的网络连通性。\n`);

// The exporter uses Python's standard ZIP library; the consumer needs only Node and Git.
const python = process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']];
const zipPath = `${output}.zip`;
const code = 'import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nfiles=["AI-video.bundle","update-manifest.json","apply-offline-update.mjs","start-update.cmd","使用说明.txt"]\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as z:\n for name in files:\n  z.write(p/name,name)\n';
let zipped = false;
for (const [command, ...prefix] of python) {
  const result = spawnSync(command, [...prefix, '-c', code, output, zipPath], { encoding: 'utf8', windowsHide: true });
  if (!result.error && result.status === 0) { zipped = true; break; }
}
if (!zipped) throw new Error(`已生成目录 ${output}，但生成 ZIP 需要 Python 3。`);
console.log(`离线更新包：${zipPath}\n目标提交：${commit}\nbundle SHA-256：${sha256}`);
