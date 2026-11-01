import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { applyOfflineUpdate } from '../scripts/offline-update.mjs';

const branch = 'codex/local-ai-video';
const origin = 'https://github.com/Hao1747943255/AI-video.git';
function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(directory, message) {
  git(directory, 'add', '.');
  git(directory, '-c', 'user.name=Offline test', '-c', 'user.email=offline@example.test', 'commit', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'frame offline 测试 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const repoDir = path.join(root, 'target');
  const packageDir = path.join(root, 'update package');
  mkdirSync(source);
  mkdirSync(packageDir);
  git(source, 'init', '-b', branch);
  writeFileSync(path.join(source, '.gitignore'), '.env\ndata/\n');
  writeFileSync(path.join(source, 'app.txt'), 'previous source\n');
  const base = commit(source, '初始测试源码');
  git(root, 'clone', '--no-local', source, repoDir);
  git(repoDir, 'remote', 'set-url', 'origin', origin);
  writeFileSync(path.join(source, 'app.txt'), 'updated source\n');
  const next = commit(source, '更新测试源码');
  const bundle = path.join(packageDir, 'AI-video.bundle');
  git(source, 'bundle', 'create', bundle, `refs/heads/${branch}`);
  const manifest = {
    schemaVersion: 1,
    repository: 'Hao1747943255/AI-video',
    branch,
    commit: next,
    bundle: path.basename(bundle),
    sha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
  };
  const saveManifest = () => writeFileSync(path.join(packageDir, 'update-manifest.json'), JSON.stringify(manifest));
  saveManifest();
  writeFileSync(path.join(repoDir, '.env'), 'PRIVATE_SETTING=keep-me\n');
  mkdirSync(path.join(repoDir, 'data'));
  writeFileSync(path.join(repoDir, 'data', 'saved-video.mp4'), Buffer.from([0, 1, 2, 255]));
  const fetchHead = path.join(repoDir, '.git', 'FETCH_HEAD');
  writeFileSync(fetchHead, 'offline test sentinel\n');
  return { repoDir, packageDir, source, base, next, bundle, manifest, saveManifest, fetchHead };
}
function snapshot(f) {
  return {
    head: git(f.repoDir, 'rev-parse', 'HEAD'),
    status: git(f.repoDir, 'status', '--porcelain=v1', '--untracked-files=all'),
    refNames: git(f.repoDir, 'for-each-ref', '--format=%(refname)'),
    origin: git(f.repoDir, 'remote', 'get-url', 'origin'),
    fetchHead: readFileSync(f.fetchHead, 'utf8'),
    env: readFileSync(path.join(f.repoDir, '.env'), 'utf8'),
    video: readFileSync(path.join(f.repoDir, 'data', 'saved-video.mp4')).toString('hex'),
    app: readFileSync(path.join(f.repoDir, 'app.txt'), 'utf8'),
  };
}
function rejectsUnchanged(f) {
  const before = snapshot(f);
  assert.throws(() => applyOfflineUpdate({ repoDir: f.repoDir, packageDir: f.packageDir, gitPath: 'git' }));
  assert.deepEqual(snapshot(f), before);
}
function refreshBundle(f) {
  rmSync(f.bundle);
  git(f.source, 'bundle', 'create', f.bundle, `refs/heads/${branch}`);
  f.manifest.commit = git(f.source, 'rev-parse', 'HEAD');
  f.manifest.sha256 = createHash('sha256').update(readFileSync(f.bundle)).digest('hex');
  f.saveManifest();
}

test('offline bundle fast-forwards a clean repository while preserving private files and remote metadata', t => {
  const f = fixture(t);
  const before = snapshot(f);
  const result = applyOfflineUpdate({ repoDir: f.repoDir, packageDir: f.packageDir, gitPath: 'git' });
  assert.equal(result.status, 'updated');
  assert.equal(result.commit, f.next);
  const after = snapshot(f);
  assert.deepEqual(after, { ...before, head: f.next, app: 'updated source\n' });
});

test('applying the same offline update twice makes no further change', t => {
  const f = fixture(t);
  applyOfflineUpdate({ repoDir: f.repoDir, packageDir: f.packageDir, gitPath: 'git' });
  const before = snapshot(f);
  const result = applyOfflineUpdate({ repoDir: f.repoDir, packageDir: f.packageDir, gitPath: 'git' });
  assert.equal(result.status, 'current');
  assert.equal(result.commit, f.next);
  assert.deepEqual(snapshot(f), before);
});

test('offline update refuses both tracked edits and untracked files without stashing or deleting them', async t => {
  for (const kind of ['tracked', 'untracked']) await t.test(kind, t => {
    const f = fixture(t);
    writeFileSync(path.join(f.repoDir, kind === 'tracked' ? 'app.txt' : 'my-note.txt'), 'keep this local edit\n');
    rejectsUnchanged(f);
    assert.equal(readFileSync(path.join(f.repoDir, kind === 'tracked' ? 'app.txt' : 'my-note.txt'), 'utf8'), 'keep this local edit\n');
  });
});

test('offline update refuses a different branch and detached HEAD', async t => {
  for (const detached of [false, true]) await t.test(detached ? 'detached' : 'different branch', t => {
    const f = fixture(t);
    if (detached) git(f.repoDir, 'checkout', '--detach', f.base);
    else git(f.repoDir, 'checkout', '-b', 'my-local-work');
    rejectsUnchanged(f);
  });
});

test('offline update refuses an unrelated origin', t => {
  const f = fixture(t);
  git(f.repoDir, 'remote', 'set-url', 'origin', 'https://github.com/example/different-repository.git');
  rejectsUnchanged(f);
});

test('offline update refuses divergent commits without resetting the local branch', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.repoDir, 'my-work.txt'), 'local committed work\n');
  commit(f.repoDir, '保留本地提交');
  rejectsUnchanged(f);
});

test('an older offline package cannot roll back a newer local commit', t => {
  const f = fixture(t);
  applyOfflineUpdate({ repoDir: f.repoDir, packageDir: f.packageDir, gitPath: 'git' });
  writeFileSync(path.join(f.repoDir, 'my-new-work.txt'), 'newer local work\n');
  commit(f.repoDir, '更新本地提交');
  rejectsUnchanged(f);
});

test('offline update rejects a corrupted bundle before changing the repository', t => {
  const f = fixture(t);
  writeFileSync(f.bundle, Buffer.concat([readFileSync(f.bundle), Buffer.from('corruption')]));
  rejectsUnchanged(f);
});

test('offline update rejects a manifest that names a different commit', t => {
  const f = fixture(t);
  f.manifest.commit = f.base;
  f.saveManifest();
  rejectsUnchanged(f);
});

test('offline update rejects a bundle path outside the package directory', t => {
  const f = fixture(t);
  f.manifest.bundle = '../AI-video.bundle';
  f.saveManifest();
  rejectsUnchanged(f);
});

test('offline update refuses a subdirectory instead of silently updating its enclosing repository', t => {
  const f = fixture(t);
  const before = snapshot(f);
  const nestedDir = path.join(f.repoDir, 'data');
  assert.throws(() => applyOfflineUpdate({ repoDir: nestedDir, packageDir: f.packageDir, gitPath: 'git' }));
  assert.deepEqual(snapshot(f), before);
});

test('offline update refuses to overwrite ignored local configuration or saved data newly tracked upstream', async t => {
  for (const relativePath of ['.env', 'data/saved-video.mp4']) await t.test(relativePath, t => {
    const f = fixture(t);
    const upstreamFile = path.join(f.source, relativePath);
    mkdirSync(path.dirname(upstreamFile), { recursive: true });
    writeFileSync(upstreamFile, 'upstream content must not replace private local bytes\n');
    git(f.source, 'add', '-f', relativePath);
    commit(f.source, '测试上游开始跟踪本地忽略文件');
    refreshBundle(f);
    assert.equal(git(f.repoDir, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    rejectsUnchanged(f);
  });
});

test('offline update refuses unfinished Git operations even when the index and worktree are clean', async t => {
  for (const marker of ['MERGE_HEAD', 'rebase-merge']) await t.test(marker, t => {
    const f = fixture(t);
    const markerPath = path.join(f.repoDir, '.git', marker);
    if (marker === 'MERGE_HEAD') writeFileSync(markerPath, `${f.base}\n`);
    else mkdirSync(markerPath);
    assert.equal(git(f.repoDir, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    rejectsUnchanged(f);
    if (marker === 'MERGE_HEAD') assert.equal(readFileSync(markerPath, 'utf8'), `${f.base}\n`);
    else assert.equal(statSync(markerPath).isDirectory(), true);
  });
});
