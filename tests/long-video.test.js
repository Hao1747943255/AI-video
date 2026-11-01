import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderLongVideo } from '../server/long-video.js';

const prompt = '皮秒激光设备的治疗头在前臂纹身区域缓慢移动，镜头固定近景。';

async function fixture(t, seconds = 5) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'frame-long 测试 '));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const job = { id: 'long-video-test', provider: 'comfyui', ratio: '16:9', style: 'cinematic', prompt, seconds };
  const updates = [];
  const update = changes => { Object.assign(job, structuredClone(changes)); updates.push(structuredClone(changes)); };
  return { dataDir, job, update, updates };
}

function writeClip(job, { dataDir, update }) {
  update({ remoteId: `remote-${job.id}`, progress: 2 });
  const index = Number(job.id.match(/part-(\d+)$/)?.[1] || 1) - 1;
  const color = ['red', 'lime', 'blue'][index % 3];
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=${color}:s=160x90:r=${job.seconds === 1 ? '17' : '33/2'}`,
    '-frames:v', String(job.seconds * 16 + 1), '-an', '-c:v', 'libx264', '-threads', '1',
    '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dataDir, `${job.id}.mp4`),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function videoInfo(file) {
  return JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', file,
  ], { encoding: 'utf8' }));
}

function pixel(file, second) {
  return execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', file,
    '-vf', 'crop=2:2:0:0,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] }).subarray(0, 3);
}

test('two-second rendering retains the original single-clip call without a compositor', async t => {
  const f = await fixture(t, 2);
  let calls = 0;
  const result = await renderLongVideo(f.job, { dataDir: f.dataDir, update: f.update }, async (job, context) => {
    calls++;
    assert.equal(job, f.job);
    assert.equal(context.dataDir, f.dataDir);
    assert.equal(context.update, f.update);
    return 'single-result';
  });
  assert.equal(result, 'single-result');
  assert.equal(calls, 1);
  assert.equal(f.job.segments, undefined);
});

test('a five-second result contains independently generated 2+2+1 second clips at exactly 16 fps', async t => {
  const f = await fixture(t);
  const children = [];
  await renderLongVideo(f.job, { dataDir: f.dataDir, update: f.update }, async (job, context) => {
    children.push(structuredClone(job));
    writeClip(job, context);
  });
  assert.deepEqual(children.map(job => job.seconds), [2, 2, 1]);
  assert.equal(new Set(children.map(job => job.id)).size, 3);
  assert.equal(new Set(children.map(job => job.prompt)).size, 3);
  assert.ok(children.every(job => job.prompt.startsWith(prompt)));
  assert.equal(f.job.remoteId, undefined);
  assert.equal(f.job.completedSegments, 3);
  assert.equal(f.job.totalSegments, 3);
  assert.ok(f.job.segments.every(segment => segment.status === 'completed' && segment.remoteId));
  assert.ok(f.updates.some(update => update.stage === '全部片段完成，正在合成视频'));
  const output = path.join(f.dataDir, `${f.job.id}.mp4`);
  const info = videoInfo(output);
  assert.equal(info.streams[0].codec_name, 'h264');
  assert.equal(info.streams[0].r_frame_rate, '16/1');
  assert.equal(Number(info.streams[0].nb_frames), 80);
  assert.ok(Math.abs(Number(info.format.duration) - 5) < 0.01);
  // Distinct scene colors demonstrate that the compositor did not loop the first clip.
  for (const [second, channel] of [[0.5, 0], [2.5, 1], [4.5, 2]]) {
    const values = pixel(output, second);
    assert.ok(values[channel] > 200);
    assert.ok(values.every((value, index) => index === channel || value < 30));
  }
});

test('interrupted generation resumes the saved remote task and preserves completed clips', async t => {
  const f = await fixture(t);
  const calls = [];
  let failing = true;
  const renderer = async (job, context) => {
    calls.push({ id: job.id, remoteId: job.remoteId });
    if (job.id.endsWith('part-2') && failing) {
      context.update({ remoteId: 'accepted-before-restart' });
      throw new Error('临时连接中断，请先检查服务。');
    }
    writeClip(job, context);
  };
  await assert.rejects(renderLongVideo(f.job, { dataDir: f.dataDir, update: f.update }, renderer), /第 2\/3 段生成失败/);
  assert.deepEqual(f.job.segments.map(segment => segment.status), ['completed', 'failed', 'queued']);
  assert.equal(f.job.segments[1].remoteId, 'accepted-before-restart');
  const first = path.join(f.dataDir, 'segments', f.job.id, `${f.job.id}-part-1.mp4`);
  const firstBytes = await readFile(first);
  const firstMtime = (await stat(first)).mtimeMs;
  const resumedJob = JSON.parse(JSON.stringify(f.job));
  failing = false;
  await renderLongVideo(resumedJob, { dataDir: f.dataDir, update: changes => Object.assign(resumedJob, changes) }, renderer);
  assert.deepEqual(calls.map(call => call.id), [
    `${f.job.id}-part-1`, `${f.job.id}-part-2`, `${f.job.id}-part-2`, `${f.job.id}-part-3`,
  ]);
  assert.equal(calls[2].remoteId, 'accepted-before-restart');
  assert.deepEqual(await readFile(first), firstBytes);
  assert.equal((await stat(first)).mtimeMs, firstMtime);
  assert.ok(Math.abs(Number(videoInfo(path.join(f.dataDir, `${f.job.id}.mp4`)).format.duration) - 5) < 0.01);
});

test('a corrupt completed clip is regenerated using its recorded remote task instead of skipped', async t => {
  const f = await fixture(t, 4);
  const calls = [];
  const renderer = async (job, context) => { calls.push(structuredClone(job)); writeClip(job, context); };
  await renderLongVideo(f.job, { dataDir: f.dataDir, update: f.update }, renderer);
  const first = path.join(f.dataDir, 'segments', f.job.id, `${f.job.id}-part-1.mp4`);
  await writeFile(first, Buffer.from('incomplete mp4 bytes'));
  calls.length = 0;
  await renderLongVideo(f.job, { dataDir: f.dataDir, update: f.update }, renderer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, `${f.job.id}-part-1`);
  assert.equal(calls[0].remoteId, `remote-${f.job.id}-part-1`);
  assert.equal(videoInfo(first).streams[0].codec_name, 'h264');
});

test('failed composition keeps all clips and can be retried without generating them again', async t => {
  const f = await fixture(t, 4);
  let calls = 0;
  const renderer = async (job, context) => { calls++; writeClip(job, context); };
  await assert.rejects(renderLongVideo(f.job, {
    dataDir: f.dataDir, update: f.update, ffmpeg: 'frame-nonexistent-ffmpeg', ffprobe: 'ffprobe',
  }, renderer), /合成失败/);
  assert.equal(calls, 2);
  assert.ok(f.job.segments.every(segment => segment.status === 'completed'));
  await assert.rejects(stat(path.join(f.dataDir, `${f.job.id}.mp4.part`)), { code: 'ENOENT' });
  await renderLongVideo(f.job, { dataDir: f.dataDir, update: f.update }, renderer);
  assert.equal(calls, 2);
  assert.equal(videoInfo(path.join(f.dataDir, `${f.job.id}.mp4`)).format.duration, '4.000000');
});

test('invalid duration, traversal IDs and inconsistent saved segments are refused before rendering', async t => {
  const f = await fixture(t);
  let calls = 0;
  const renderer = async () => { calls++; };
  for (const change of [{ seconds: 1 }, { seconds: 61 }, { seconds: 3.5 }, { id: '../another-directory' }]) {
    await assert.rejects(renderLongVideo({ ...f.job, ...change }, { dataDir: f.dataDir, update: f.update }, renderer), /参数无效/);
  }
  await assert.rejects(renderLongVideo({ ...f.job, segments: [] }, { dataDir: f.dataDir, update: f.update }, renderer), /分段记录/);
  await assert.rejects(renderLongVideo({ ...f.job, segments: [
    { id: 'unrelated', seconds: 2 }, { id: `${f.job.id}-part-2`, seconds: 2 }, { id: `${f.job.id}-part-3`, seconds: 1 },
  ] }, { dataDir: f.dataDir, update: f.update }, renderer), /分段编号/);
  assert.equal(calls, 0);
});
