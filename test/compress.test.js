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

test('APP_PASSWORD protege la app cuando está configurada', () => {
  const script = `
    process.env.APP_PASSWORD = 'secreta';
    const { app } = require('./src/server');
    const s = app.listen(0, async () => {
      const url = 'http://127.0.0.1:' + s.address().port;
      const auth = (p) => ({ headers: { Authorization: 'Basic ' + Buffer.from('tienda:' + p).toString('base64') } });
      const r = [
        (await fetch(url + '/')).status,
        (await fetch(url + '/', auth('mala'))).status,
        (await fetch(url + '/', auth('secreta'))).status,
        (await fetch(url + '/api/health')).status,
      ];
      console.log(JSON.stringify(r));
      s.close();
    });`;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') });
  assert.equal(out.stdout.toString().trim(), '[401,401,200,200]', out.stderr.toString());
});

// ---------------------------------------------------------------------------
// Censura de caras
// ---------------------------------------------------------------------------
const faces = require('../src/faces');
const { Readable } = require('stream');

test('buildTracks une detecciones de la misma cara e interpola entre ellas', () => {
  const box = (x) => ({ x, y: 0.2, w: 0.1, h: 0.15, score: 0.9 });
  const samples = [
    { t: 0, boxes: [box(0.1)] },
    { t: 0.5, boxes: [box(0.2), { x: 0.8, y: 0.5, w: 0.1, h: 0.1, score: 0.95 }] },
    { t: 1, boxes: [box(0.3)] },
  ];
  const tracks = faces.buildTracks(samples, 0.5);
  assert.equal(tracks.length, 2);
  const [moving] = tracks;
  assert.equal(moving.points.length, 3);
  // A mitad de camino entre 0.5 s y 1 s la caja está entre 0.2 y 0.3.
  const mid = faces.boxesAt(tracks, 0.75, 0.3).find((b) => b.x < 0.5);
  assert.ok(Math.abs(mid.x - 0.25) < 1e-9);
  // El margen extiende la pista antes de la primera detección...
  assert.equal(faces.boxesAt(tracks, -0.2, 0.3).length, 1);
  // ...pero no indefinidamente.
  assert.equal(faces.boxesAt(tracks, 2, 0.3).length, 0);
});

test('readPpmFrames reconstruye fotogramas aunque lleguen troceados', async () => {
  const frame = (v) => Buffer.concat([Buffer.from('P6\n3 2\n255\n'), Buffer.alloc(18, v)]);
  const all = Buffer.concat([frame(1), frame(2)]);
  const chunks = [all.subarray(0, 5), all.subarray(5, 20), all.subarray(20, 31), all.subarray(31)];
  const out = [];
  for await (const f of faces.readPpmFrames(Readable.from(chunks))) out.push(f);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].width, out[0].height], [3, 2]);
  assert.ok(out[0].data.every((b) => b === 1) && out[1].data.every((b) => b === 2));
});

test('el mosaico de búsqueda cubre todo el fotograma', () => {
  for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
    const tiles = faces.tileGrid(w, h);
    assert.ok(tiles.every((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= w && t.y + t.h <= h));
    for (const [x, y] of [[0, 0], [w - 1, h - 1], [w / 2, h / 2], [w - 1, 0], [0, h - 1]]) {
      assert.ok(tiles.some((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h), `${w}x${h} (${x},${y})`);
    }
  }
});

/** Cuenta los fotogramas de un video en los que el detector ve una cara con confianza. */
async function framesWithFaces(file, minScore) {
  const { tf, faceapi } = await faces.loadDetector();
  const { proc, done } = faces.spawnDecoder(FFMPEG_PATH, file, 'format=rgb24');
  let frames = 0;
  let withFaces = 0;
  for await (const fr of faces.readPpmFrames(proc.stdout)) {
    const img = tf.tensor3d(new Uint8Array(fr.data.buffer, fr.data.byteOffset, fr.data.length), [fr.height, fr.width, 3], 'int32');
    const dets = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: minScore }));
    img.dispose();
    frames++;
    if (dets.length) withFaces++;
  }
  await done;
  return { frames, withFaces };
}

test('censura una cara en movimiento en todos los fotogramas', { timeout: 180000 }, async () => {
  const input = path.join(tmp, 'cara-movil.mp4');
  const fixture = path.join(__dirname, 'fixtures', 'astronauta.jpg');
  const gen = spawnSync(FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x556677:s=1280x720:r=25:d=3',
    '-loop', '1', '-i', fixture,
    '-f', 'lavfi', '-i', 'sine=f=300:d=3',
    '-filter_complex', "[1:v]scale=680:-1[f];[0:v][f]overlay=x='-40+t*180':y=-60:shortest=1,format=yuv420p[v]",
    '-map', '[v]', '-map', '2:a', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-c:a', 'aac', input,
  ]);
  assert.equal(gen.status, 0, gen.stderr?.toString());

  const before = await framesWithFaces(input, 0.6);
  assert.ok(before.withFaces >= before.frames * 0.9, `el original debe tener la cara visible (${JSON.stringify(before)})`);

  const job = await submit(input, { blurFaces: true, faceStyle: 'pixelado' });
  assert.equal(job.status, 'done', job.error);
  assert.ok(job.details.faces >= 1);

  const out = path.join(tmp, 'cara-movil-censurada.mp4');
  fs.writeFileSync(out, Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer()));
  const after = await framesWithFaces(out, 0.6);
  assert.equal(after.frames, before.frames, 'no se deben perder fotogramas');
  assert.equal(after.withFaces, 0, `ninguna cara debe quedar visible (${JSON.stringify(after)})`);

  const probe = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', out]).stderr.toString();
  assert.match(probe, /Audio: aac/);
});

test('censurar caras junto con eliminar silencios mantiene la sincronización', { timeout: 180000 }, async () => {
  const input = path.join(tmp, 'cara-silencio.mp4');
  const fixture = path.join(__dirname, 'fixtures', 'astronauta.jpg');
  const gen = spawnSync(FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x556677:s=640x360:r=25:d=6',
    '-loop', '1', '-i', fixture,
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,4),0,0.5*sin(2*PI*440*t))':s=44100:d=6",
    '-filter_complex', '[1:v]scale=300:-1[f];[0:v][f]overlay=x=150:y=20:shortest=1,format=yuv420p[v]',
    '-map', '[v]', '-map', '2:a', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', input,
  ]);
  assert.equal(gen.status, 0, gen.stderr?.toString());
  const job = await submit(input, { blurFaces: true, faceStyle: 'desenfoque', removeSilence: true, minSilence: 1 });
  assert.equal(job.status, 'done', job.error);
  assert.ok(job.details.faces >= 1);
  assert.ok(Math.abs(job.details.removedSeconds - 1.7) < 0.3, `quitados ${job.details.removedSeconds}`);

  const out = path.join(tmp, 'cara-silencio-out.mp4');
  fs.writeFileSync(out, Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer()));
  const lastTime = (map) => {
    const s = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', out, '-map', map, '-f', 'null', '-']).stderr.toString();
    const m = [...s.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  };
  const a = lastTime('0:a');
  const v = lastTime('0:v');
  assert.ok(Math.abs(a - v) < 0.15 && Math.abs(v - 4.3) < 0.3, `audio ${a} video ${v}`);
});

test('headFromPose sitúa la cabeza encima de los hombros si no se ve la cara', () => {
  // 17 puntos (y, x, score) + caja (ymin, xmin, ymax, xmax, score); solo hombros visibles.
  const p = new Array(56).fill(0);
  const set = (i, x, y, score) => { p[3 * i] = y; p[3 * i + 1] = x; p[3 * i + 2] = score; };
  set(5, 0.6, 0.5, 0.9); // hombro izquierdo
  set(6, 0.4, 0.5, 0.9); // hombro derecho
  p[51] = 0.2; p[52] = 0.3; p[53] = 1; p[54] = 0.7; p[55] = 0.8;
  const head = faces.headFromPose(p, 1000);
  assert.ok(head, 'debe devolver una cabeza');
  const cx = head.x + head.w / 2;
  const cy = head.y + head.h / 2;
  assert.ok(Math.abs(cx - 500) < 1, `centrada entre los hombros (${cx})`);
  assert.ok(cy < 500 - 100, `por encima de los hombros (${cy})`);
  assert.ok(head.w > 120 && head.w < 220, `tamaño proporcional a los hombros (${head.w})`);
  // Sin persona detectada no hay cabeza.
  p[55] = 0.05;
  assert.equal(faces.headFromPose(p, 1000), null);
});

test('censura la cabeza aunque la persona deje de mostrar la cara', { timeout: 180000 }, async () => {
  const fixture = path.join(__dirname, 'fixtures', 'astronauta.jpg');
  const hidden = path.join(tmp, 'sin-cara.png');
  // Tapa la cara (como si la persona mirara hacia otro lado).
  const patch = Buffer.from('<svg width="400" height="400"><ellipse cx="173" cy="100" rx="50" ry="57" fill="#8a6a3a"/></svg>');
  await sharp(fixture).composite([{ input: patch }]).png().toFile(hidden);

  const input = path.join(tmp, 'girada.mp4');
  const gen = spawnSync(FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x556677:s=1280x720:r=25:d=4',
    '-loop', '1', '-i', fixture, '-loop', '1', '-i', hidden,
    '-filter_complex',
    "[1:v]scale=640:-1[a];[2:v]scale=640:-1[b];[0:v][a]overlay=x='100+t*60':y=40:enable='lt(t,1)':shortest=1[t1];" +
      "[t1][b]overlay=x='100+t*60':y=40:enable='gte(t,1)':shortest=1,format=yuv420p[v]",
    '-map', '[v]', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', input,
  ]);
  assert.equal(gen.status, 0, gen.stderr?.toString());

  const job = await submit(input, { blurFaces: true });
  assert.equal(job.status, 'done', job.error);
  const out = path.join(tmp, 'girada-out.mp4');
  fs.writeFileSync(out, Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer()));

  // En cada fotograma, la zona de la cabeza debe perder la mayor parte de su detalle.
  const readAll = async (file) => {
    const { proc, done } = faces.spawnDecoder(FFMPEG_PATH, file, 'format=rgb24');
    const frames = [];
    for await (const f of faces.readPpmFrames(proc.stdout)) frames.push(f);
    await done;
    return frames;
  };
  const detail = (f, x0, y0, x1, y1) => {
    let e = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1 - 1; x++) {
        const i = (y * f.width + x) * 3;
        e += Math.abs(f.data[i] - f.data[i + 3]) + Math.abs(f.data[i + 1] - f.data[i + 4]);
        n++;
      }
    }
    return e / n;
  };
  const [orig, cens] = await Promise.all([readAll(input), readAll(out)]);
  assert.equal(cens.length, orig.length);
  const uncensored = [];
  orig.forEach((f, k) => {
    const ox = Math.round(100 + (k / 25) * 60);
    // La cabeza ocupa aprox. x 0.30-0.56, y 0.05-0.40 de la foto (640 px de ancho).
    const box = [ox + 190, 40 + 30, ox + 360, 40 + 260];
    if (detail(cens[k], ...box) / detail(f, ...box) > 0.6) uncensored.push(k);
  });
  assert.deepEqual(uncensored, [], 'fotogramas con la cabeza sin censurar');
});
