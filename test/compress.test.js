const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { app, slugify } = require('../src/server');
const { getFfmpeg } = require('../src/video');
let FFMPEG_PATH;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-'));
let server;
let base;

test.before(async () => {
  FFMPEG_PATH = await getFfmpeg();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function submit(filePath, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: form });
  assert.equal(res.status, 202);
  let job = await res.json();
  while (job.status !== 'done' && job.status !== 'error') {
    await new Promise((r) => setTimeout(r, 200));
    job = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
  }
  return job;
}

/** Imagen "fotográfica" con ruido para que la compresión sea realista. */
async function makePhoto(file, width, height) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i / 3) % width) + Math.random() * 40) & 255;
  await sharp(raw, { raw: { width, height, channels: 3 } }).blur(1.2).jpeg({ quality: 100 }).toFile(file);
}

test('slugify genera nombres aptos para Shopify', () => {
  assert.equal(slugify('Camiseta Azul Ñandú (Frente)'), 'camiseta-azul-nandu-frente');
});

test('comprime una foto JPEG sin cambiar la resolución', async () => {
  const input = path.join(tmp, 'Foto Producto.jpg');
  await makePhoto(input, 2400, 1600);
  const job = await submit(input);
  assert.equal(job.status, 'done', job.error);
  assert.ok(job.outputSize < job.originalSize, 'debe pesar menos');
  assert.equal(job.details.width, 2400);
  assert.equal(job.details.height, 1600);
  assert.equal(job.outputName, 'foto-producto.jpg');

  const dl = await fetch(`${base}/api/jobs/${job.id}/download`);
  const meta = await sharp(Buffer.from(await dl.arrayBuffer())).metadata();
  assert.equal(meta.format, 'jpeg');
});

test('limita el tamaño máximo cuando se solicita', async () => {
  const input = path.join(tmp, 'grande.jpg');
  await makePhoto(input, 3000, 1500);
  const job = await submit(input, { maxDimension: 2048 });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.details.width, 2048);
  assert.equal(job.details.height, 1024);
});

test('PNG con transparencia se convierte a WebP conservando el canal alfa', async () => {
  const input = path.join(tmp, 'logo.png');
  await sharp({
    create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 128, b: 96, alpha: 0.5 } },
  }).png({ compressionLevel: 0 }).toFile(input);
  const job = await submit(input);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.details.format, 'webp');
  const dl = await fetch(`${base}/api/jobs/${job.id}/download`);
  const meta = await sharp(Buffer.from(await dl.arrayBuffer())).metadata();
  assert.equal(meta.hasAlpha, true);
});

test('rechaza archivos que no son multimedia', async () => {
  const input = path.join(tmp, 'notas.txt');
  fs.writeFileSync(input, 'hola');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(input)], { type: 'text/plain' }), 'notas.txt');
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: form });
  assert.equal(res.status, 415);
});

test('comprime un video a MP4 H.264 con faststart y lo reduce a 720p', async () => {
  const input = path.join(tmp, 'Video Demo.mov');
  const gen = spawnSync(FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-crf', '5', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', input,
  ]);
  assert.equal(gen.status, 0, gen.stderr?.toString());

  const job = await submit(input, { maxResolution: 720, maxFps: 30, removeAudio: true });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.outputName, 'video-demo.mp4');
  assert.ok(job.outputSize < job.originalSize);

  const out = path.join(tmp, 'out.mp4');
  fs.writeFileSync(out, Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer()));
  const probe = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', out]).stderr.toString();
  assert.match(probe, /Video: h264/);
  assert.match(probe, /1280x720/);
  assert.match(probe, /30 fps/);
  assert.doesNotMatch(probe, /Audio:/);
  // faststart: el átomo "moov" debe aparecer antes que "mdat".
  const head = fs.readFileSync(out).subarray(0, 4096).toString('latin1');
  assert.ok(head.indexOf('moov') !== -1 && head.indexOf('moov') < (head.indexOf('mdat') + 1 || Infinity));
});

test('video vertical se limita por el lado corto', async () => {
  const input = path.join(tmp, 'vertical.mp4');
  const gen = spawnSync(FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=1',
    '-c:v', 'libx264', '-crf', '10', '-preset', 'ultrafast', input,
  ]);
  assert.equal(gen.status, 0);
  const job = await submit(input, { maxResolution: 720 });
  assert.equal(job.status, 'done', job.error);
  const out = path.join(tmp, 'vertical-out.mp4');
  fs.writeFileSync(out, Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer()));
  const probe = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', out]).stderr.toString();
  assert.match(probe, /720x1280/);
});

test('descarga en ZIP', async () => {
  const input = path.join(tmp, 'zip.jpg');
  await makePhoto(input, 400, 300);
  const a = await submit(input);
  const b = await submit(input);
  const res = await fetch(`${base}/api/zip?ids=${a.id},${b.id}`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.ok(buf.includes(Buffer.from('zip.jpg')) && buf.includes(Buffer.from('zip-2.jpg')));
});

test('una foto HEIC ilegible devuelve un error claro', async () => {
  const input = path.join(tmp, 'IMG_0001.HEIC');
  fs.writeFileSync(input, Buffer.alloc(2048, 7));
  const job = await submit(input);
  assert.equal(job.status, 'error');
  assert.match(job.error, /HEIC/);
});

test('keepSegments conserva los tramos con sonido y un margen en cada corte', () => {
  const { keepSegments } = require('../src/video');
  const keep = keepSegments([{ start: 0, end: 1 }, { start: 3, end: 6 }, { start: 9, end: 10 }], 10, 0.1);
  assert.deepEqual(
    keep.map((k) => [Number(k.start.toFixed(2)), Number(k.end.toFixed(2))]),
    [[0.9, 3.1], [5.9, 9.1]],
  );
});

test('parseSilences lee la salida de silencedetect, incluido un silencio hasta el final', () => {
  const { parseSilences } = require('../src/video');
  const out = [
    '[silencedetect @ 0x1] silence_start: 2.01',
    '[silencedetect @ 0x1] silence_end: 5.002 | silence_duration: 2.99',
    '[silencedetect @ 0x1] silence_start: 8.5',
  ].join('\n');
  assert.deepEqual(parseSilences(out, 10), [{ start: 2.01, end: 5.002 }, { start: 8.5, end: 10 }]);
});

function probeDurations(file) {
  const info = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', file, '-f', 'null', '-']).stderr.toString();
  const times = [...info.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = times[times.length - 1];
  return { info, seconds: Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) };
}

test('elimina los silencios de un video manteniendo audio y video sincronizados', async () => {
  const input = path.join(tmp, 'con-silencios.mp4');
  // 7 s: tono 0-2 s, silencio 2-5 s, tono 5-7 s.
  const gen = spawnSync(FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=7',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,5),0,0.5*sin(2*PI*440*t))':s=44100:d=7",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', input,
  ]);
  assert.equal(gen.status, 0, gen.stderr?.toString());

  const job = await submit(input, { removeSilence: true, minSilence: 1 });
  assert.equal(job.status, 'done', job.error);
  assert.ok(Math.abs(job.details.originalDuration - 7) < 0.2, `duración original ${job.details.originalDuration}`);
  // Se quitan ~3 s menos los márgenes (2 × 0,15 s).
  assert.ok(Math.abs(job.details.removedSeconds - 2.7) < 0.3, `quitados ${job.details.removedSeconds}`);

  const out = path.join(tmp, 'sin-silencios.mp4');
  fs.writeFileSync(out, Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer()));
  const { info, seconds } = probeDurations(out);
  assert.match(info, /Audio: aac/);
  assert.ok(Math.abs(seconds - 4.3) < 0.3, `duración final ${seconds}`);

  // Audio y video deben durar lo mismo (sin desincronización).
  const a = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', out, '-map', '0:a', '-f', 'null', '-']).stderr.toString();
  const vOnly = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', out, '-map', '0:v', '-f', 'null', '-']).stderr.toString();
  const lastTime = (s) => {
    const m = [...s.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  };
  assert.ok(Math.abs(lastTime(a) - lastTime(vOnly)) < 0.15, `audio ${lastTime(a)} vs video ${lastTime(vOnly)}`);
});

test('quitar silencios en un video sin audio no falla', async () => {
  const input = path.join(tmp, 'mudo.mp4');
  const gen = spawnSync(FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', input,
  ]);
  assert.equal(gen.status, 0);
  const job = await submit(input, { removeSilence: true });
  assert.equal(job.status, 'done', job.error);
  assert.match(job.details.silenceNote, /no tiene audio/);
});
