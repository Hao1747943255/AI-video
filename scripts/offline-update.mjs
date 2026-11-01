import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'Hao1747943255/AI-video';
export const BRANCH = 'codex/local-ai-video';

export function findGit() {
  const candidates = ['git'];
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
      const desktop = path.join(process.env.LOCALAPPDATA, 'GitHubDesktop');
      let versions = [];
      try { versions = readdirSync(desktop).filter(name => /^app-\d/.test(name)); } catch {}
      versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      for (const version of versions) {
        candidates.push(path.join(desktop, version, 'resources', 'app', 'git', 'cmd', 'git.exe'));
        candidates.push(path.join(desktop, version, 'resources', 'app', 'git', 'mingw64', 'bin', 'git.exe'));
      }
    }
  }
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!result.error && result.status === 0 && result.stdout.startsWith('git version ')) return candidate;
  }
  throw new Error('找不到 Git。请先安装 Git 或 GitHub Desktop，然后重新运行。');
}

function sameDirectory(first, second) {
  const normalize = value => {
    const result = path.normalize(realpathSync(value));
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };
  return normalize(first) === normalize(second);
}

function matchesOrigin(origin) {
  const ssh = /^git@github\.com:(.+)$/i.exec(origin);
  if (ssh) return ssh[1].replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase() === REPOSITORY.toLowerCase();
  try {
    const url = new URL(origin);
    return ['https:', 'ssh:'].includes(url.protocol) && url.hostname.toLowerCase() === 'github.com' &&
      url.pathname.replace(/^\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase() === REPOSITORY.toLowerCase();
  } catch { return false; }
}

export function applyOfflineUpdate({ repoDir, packageDir, gitPath = findGit() }) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'update-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.repository !== REPOSITORY || manifest.branch !== BRANCH ||
      !/^[a-f0-9]{40}$/.test(manifest.commit) || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      manifest.bundle !== 'AI-video.bundle') {
    throw new Error('更新清单无效，或不是此项目及分支的更新包。');
  }
  const bundle = path.resolve(packageDir, manifest.bundle);
  if (!statSync(bundle).isFile()) throw new Error('更新包缺少 bundle 文件。');
  const digest = createHash('sha256').update(readFileSync(bundle)).digest('hex');
  if (digest !== manifest.sha256) throw new Error('更新包 SHA-256 校验失败，请重新下载并解压。');
  const git = (args, failure) => {
    try {
      return execFileSync(gitPath, ['-C', repoDir, ...args], {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }, maxBuffer: 8 * 1024 * 1024,
      }).trim();
    } catch { throw new Error(failure || 'Git 本地更新失败，原始更新包与已有文件已保留。'); }
  };
  const root = git(['rev-parse', '--show-toplevel'], '目标目录不是已有 Git 仓库。');
  if (!sameDirectory(root, repoDir)) throw new Error('请指定仓库根目录，不能指定其子目录。');
  if (!matchesOrigin(git(['remote', 'get-url', 'origin'], '仓库缺少 origin，无法确认项目。'))) {
    throw new Error('目标仓库的 origin 不是 Hao1747943255/AI-video，已停止。');
  }
  if (git(['symbolic-ref', '--quiet', '--short', 'HEAD'], '当前处于分离 HEAD，已停止。') !== manifest.branch) {
    throw new Error(`请先在 GitHub Desktop 切换到 ${manifest.branch} 分支。`);
  }
  if (git(['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('仓库存在未提交改动，已停止。请先保留并提交改动；更新包应解压在仓库外。');
  }
  // A previous interrupted operation can have a clean index. Do not complete it implicitly.
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const markerPath = git(['rev-parse', '--git-path', marker]);
    try {
      statSync(path.resolve(repoDir, markerPath));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('仓库有尚未完成的 Git 操作，请先在 GitHub Desktop 处理。');
  }
  git(['bundle', 'verify', bundle], 'Git bundle 验证失败，请重新下载完整更新包。');
  const advertised = git(['bundle', 'list-heads', bundle]).split(/\r?\n/);
  if (!advertised.includes(`${manifest.commit} refs/heads/${manifest.branch}`)) {
    throw new Error('bundle 中的分支或提交与更新清单不符，已停止。');
  }
  const before = git(['rev-parse', 'HEAD']);
  if (before === manifest.commit) return { status: 'current', commit: before };
  const temporaryRef = `refs/frame-offline/${randomUUID()}`;
  try {
    git(['-c', 'fetch.recurseSubmodules=false', 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
      bundle, `refs/heads/${manifest.branch}:${temporaryRef}`], '从本地 bundle 导入失败，已有文件未修改。');
    const imported = git(['rev-parse', `${temporaryRef}^{commit}`]);
    if (imported !== manifest.commit) throw new Error('导入提交与清单不一致，已有分支未修改。');
    git(['merge-base', '--is-ancestor', before, imported], '本地分支含有更新包未包含的提交，已停止，不会回退或覆盖。');
    // Disable automatic stash and hooks for this merge only; leave repository configuration intact.
    git(['-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-edit', temporaryRef],
      '无法安全快进更新。请检查 GitHub Desktop 的仓库状态；不会强制覆盖文件。');
    if (git(['rev-parse', 'HEAD']) !== manifest.commit) throw new Error('更新后提交检查失败，请查看仓库状态。');
    return { status: 'updated', commit: manifest.commit };
  } finally {
    git(['update-ref', '-d', temporaryRef], '清理临时 Git 引用失败，请查看仓库状态。');
  }
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('用法：node apply-offline-update.mjs [已有仓库路径]');
    const result = applyOfflineUpdate({
      repoDir: path.resolve(process.argv[2] || 'D:\\ai_video\\AI-video'),
      packageDir: path.dirname(fileURLToPath(import.meta.url)),
    });
    console.log(`${result.status === 'current' ? '已经是更新包中的版本' : '离线更新成功'}：${result.commit.slice(0, 7)}`);
    console.log('配置、模型和运行数据已保留。GitHub 网络恢复后，可正常 Fetch origin。');
  } catch (error) {
    console.error(`离线更新已停止：${error.message}`);
    process.exitCode = 1;
  }
}
