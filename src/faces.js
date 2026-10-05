const path = require('path');
const { spawn } = require('child_process');

/**
 * Detección, seguimiento y censura de caras en videos.
 *
 * 1. Análisis: FFmpeg extrae fotogramas a pocos FPS y un detector de caras
 *    (TinyFaceDetector de face-api, ejecutado con WebAssembly) los analiza.
 * 2. Seguimiento: las detecciones se agrupan en "pistas" (una por cara) y la
 *    posición se interpola entre detecciones. Cada pista se extiende un poco
 *    antes y después para que ningún fotograma quede sin censurar.
 * 3. Censura: al recodificar, cada fotograma pasa por Node y se pixela o
 *    desenfoca un óvalo sobre cada cara.
 */

const PRECISION = {
  // Imagen completa: detecta caras desde ~7 % del ancho del video.
  normal: { fps: 8, maxSide: 960, tiles: false },
  // Imagen completa + mosaico solapado: detecta caras pequeñas (~3 % del ancho).
  alta: { fps: 5, maxSide: 1920, tiles: true },
};

const SCORE_THRESHOLD = 0.45;
// Margen alrededor de la caja detectada (incluye frente, pelo y barbilla).
const MARGIN_X = 1.5;
const MARGIN_Y = 1.7;

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------
let detectorPromise = null;

function loadDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const tf = require('@tensorflow/tfjs');
      require('@tensorflow/tfjs-backend-wasm');
      const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
      await tf.setBackend('wasm');
      await tf.ready();
      const modelDir = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
      await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
      return { tf, faceapi };
    })();
    detectorPromise.catch(() => {
      detectorPromise = null;
    });
  }
  return detectorPromise;
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (!inter) return { iou: 0, cover: 0 };
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  return { iou: inter / (areaA + areaB - inter), cover: inter / Math.min(areaA, areaB) };
}

/** Elimina detecciones duplicadas (p. ej. la misma cara vista en dos mosaicos). */
function mergeBoxes(boxes) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const b of sorted) {
    if (kept.some((k) => { const o = iou(k, b); return o.iou > 0.35 || o.cover > 0.6; })) continue;
    kept.push(b);
  }
  return kept;
}

/** Posiciones de los mosaicos solapados (en píxeles) para buscar caras pequeñas. */
function tileGrid(width, height) {
  const cols = width >= height ? 3 : 2;
  const rows = width >= height ? 2 : 3;
  const tw = Math.min(width, Math.ceil((width / cols) * 1.3));
  const th = Math.min(height, Math.ceil((height / rows) * 1.3));
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        x: cols === 1 ? 0 : Math.round(((width - tw) * c) / (cols - 1)),
        y: rows === 1 ? 0 : Math.round(((height - th) * r) / (rows - 1)),
        w: tw,
        h: th,
      });
    }
  }
  return tiles;
}

/**
 * Detecta caras en un fotograma RGB. Devuelve cajas normalizadas (0-1).
 */
async function detectFrame(detector, frame, cfg) {
  const { tf, faceapi } = detector;
  const { width: W, height: H } = frame;
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: SCORE_THRESHOLD });
  const image = tf.tensor3d(new Uint8Array(frame.data.buffer, frame.data.byteOffset, W * H * 3), [H, W, 3], 'int32');
  const boxes = [];
  const collect = (dets, ox, oy) => {
    for (const d of dets) {
      boxes.push({
        x: (d.box.x + ox) / W,
        y: (d.box.y + oy) / H,
        w: d.box.width / W,
        h: d.box.height / H,
        score: d.score,
      });
    }
  };
  try {
    collect(await faceapi.detectAllFaces(image, opts), 0, 0);
    if (cfg.tiles) {
      for (const t of tileGrid(W, H)) {
        const tile = tf.slice(image, [t.y, t.x, 0], [t.h, t.w, 3]);
        try {
          collect(await faceapi.detectAllFaces(tile, opts), t.x, t.y);
        } finally {
          tile.dispose();
        }
      }
    }
  } finally {
    image.dispose();
  }
  return mergeBoxes(boxes);
}

// ---------------------------------------------------------------------------
// Lectura de fotogramas PPM (formato que FFmpeg envía por la tubería)
// ---------------------------------------------------------------------------
const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

function parsePpmHeader(buf) {
  let i = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (i < buf.length && isWs(buf[i])) i++;
    if (i < buf.length && buf[i] === 0x23) {
      while (i < buf.length && buf[i] !== 0x0a) i++;
      continue;
    }
    const start = i;
    while (i < buf.length && !isWs(buf[i])) i++;
    if (i >= buf.length) return null; // cabecera incompleta
    tokens.push(buf.toString('latin1', start, i));
  }
  if (tokens[0] !== 'P6' || tokens[3] !== '255') throw new Error('Fotograma PPM no soportado.');
  return { width: Number(tokens[1]), height: Number(tokens[2]), length: i + 1 };
}

/** Generador asíncrono de fotogramas {width, height, data(RGB24)} desde un stream PPM. */
async function* readPpmFrames(stream) {
  let header = Buffer.alloc(0);
  let frame = null;
  let offset = 0;
  for await (let chunk of stream) {
    while (chunk.length) {
      if (!frame) {
        header = header.length ? Buffer.concat([header, chunk]) : chunk;
        const parsed = parsePpmHeader(header);
        if (!parsed) {
          chunk = Buffer.alloc(0);
          break;
        }
        frame = { width: parsed.width, height: parsed.height, data: Buffer.allocUnsafe(parsed.width * parsed.height * 3) };
        offset = 0;
        chunk = header.subarray(parsed.length);
        header = Buffer.alloc(0);
      }
      const n = Math.min(chunk.length, frame.data.length - offset);
      chunk.copy(frame.data, offset, 0, n);
      offset += n;
      chunk = chunk.subarray(n);
      if (offset === frame.data.length) {
        yield frame;
        frame = null;
      }
    }
  }
}

/** Lanza un FFmpeg que decodifica el video a fotogramas PPM por stdout. */
function spawnDecoder(ffmpeg, inputPath, videoFilter) {
  const proc = spawn(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-v', 'error', '-i', inputPath, '-map', '0:v:0',
      '-vf', videoFilter, '-f', 'image2pipe', '-c:v', 'ppm', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  proc.stderr.on('data', (c) => {
    stderr += c.toString();
  });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      if (code === 0 || signal === 'SIGKILL') resolve();
      else reject(new Error(`FFmpeg no pudo leer el video: ${stderr.trim().split('\n').pop() || code}`));
    });
  });
  done.catch(() => {});
  return { proc, done };
}

// ---------------------------------------------------------------------------
// Análisis y seguimiento
// ---------------------------------------------------------------------------

/**
 * Recorre el video detectando caras.
 * @returns {Promise<{interval:number, samples:{t:number, boxes:object[]}[]}>}
 */
async function analyzeFaces(ffmpeg, inputPath, { precision = 'normal', duration = null, onProgress = () => {} } = {}) {
  const cfg = PRECISION[precision] || PRECISION.normal;
  const detector = await loadDetector();
  const s = cfg.maxSide;
  const filter =
    `fps=${cfg.fps},` +
    `scale='if(gte(iw,ih),min(iw,${s}),-2)':'if(gte(iw,ih),-2,min(ih,${s}))',format=rgb24`;
  const { proc, done } = spawnDecoder(ffmpeg, inputPath, filter);
  const samples = [];
  const expected = duration ? Math.max(1, Math.ceil(duration * cfg.fps)) : null;
  try {
    let k = 0;
    for await (const frame of readPpmFrames(proc.stdout)) {
      samples.push({ t: k / cfg.fps, boxes: await detectFrame(detector, frame, cfg) });
      k++;
      if (expected) onProgress(Math.min(99, (k / expected) * 100));
    }
  } catch (err) {
    proc.kill('SIGKILL');
    throw err;
  }
  await done;
  onProgress(100);
  return { interval: 1 / cfg.fps, samples };
}

function center(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Puntuación de que dos cajas sean la misma cara en detecciones consecutivas. */
function matchScore(a, b) {
  const overlap = iou(a, b).iou;
  if (overlap > 0.05) return 1 + overlap;
  const ca = center(a);
  const cb = center(b);
  const dist = Math.hypot(ca.x - cb.x, ca.y - cb.y);
  const size = Math.max(a.w, a.h, b.w, b.h);
  return dist < size * 1.2 ? 1 - dist / (size * 1.2) : 0;
}

/**
 * Agrupa las detecciones en pistas (una por cara) emparejando cada detección
 * con la pista más parecida del instante anterior.
 */
function buildTracks(samples, interval) {
  const maxGap = Math.max(0.8, interval * 3);
  const tracks = [];
  for (const sample of samples) {
    const active = tracks.filter((tr) => sample.t - tr.points[tr.points.length - 1].t <= maxGap);
    const pairs = [];
    sample.boxes.forEach((box, bi) => {
      for (const tr of active) {
        const score = matchScore(tr.points[tr.points.length - 1].box, box);
        if (score > 0) pairs.push({ bi, tr, score });
      }
    });
    pairs.sort((a, b) => b.score - a.score);
    const usedBoxes = new Set();
    const usedTracks = new Set();
    for (const p of pairs) {
      if (usedBoxes.has(p.bi) || usedTracks.has(p.tr)) continue;
      p.tr.points.push({ t: sample.t, box: sample.boxes[p.bi] });
      usedBoxes.add(p.bi);
      usedTracks.add(p.tr);
    }
    sample.boxes.forEach((box, bi) => {
      if (!usedBoxes.has(bi)) tracks.push({ points: [{ t: sample.t, box }] });
    });
  }
  // Una sola detección con poca confianza suele ser un falso positivo.
  return tracks.filter((tr) => tr.points.length > 1 || tr.points[0].box.score >= 0.6);
}

/**
 * Devuelve las cajas (normalizadas) a censurar en el instante t.
 * `pad` extiende cada pista antes de su primera y después de su última detección.
 */
function boxesAt(tracks, t, pad) {
  const out = [];
  for (const tr of tracks) {
    const pts = tr.points;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (t < first.t - pad || t > last.t + pad) continue;
    if (t <= first.t) {
      out.push(first.box);
      continue;
    }
    if (t >= last.t) {
      out.push(last.box);
      continue;
    }
    // Avanza el cursor de la pista (los instantes llegan en orden).
    let i = tr.cursor || 0;
    if (pts[i].t > t) i = 0;
    while (i < pts.length - 2 && pts[i + 1].t < t) i++;
    tr.cursor = i;
    const a = pts[i];
    const b = pts[i + 1];
    const k = (t - a.t) / (b.t - a.t || 1);
    const lerp = (p, q) => p + (q - p) * k;
    out.push({
      x: lerp(a.box.x, b.box.x),
      y: lerp(a.box.y, b.box.y),
      w: lerp(a.box.w, b.box.w),
      h: lerp(a.box.h, b.box.h),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Censura de píxeles
// ---------------------------------------------------------------------------

/** Rectángulo y elipse a censurar (en píxeles) para una caja normalizada. */
function censorArea(box, W, H) {
  const cx = (box.x + box.w / 2) * W;
  // El detector suele situar la caja algo baja: subimos un poco el centro.
  const cy = (box.y + box.h * 0.42) * H;
  const rx = (box.w * W * MARGIN_X) / 2;
  const ry = (box.h * H * MARGIN_Y) / 2;
  return {
    cx, cy, rx, ry,
    x0: Math.max(0, Math.floor(cx - rx)),
    y0: Math.max(0, Math.floor(cy - ry)),
    x1: Math.min(W, Math.ceil(cx + rx)),
    y1: Math.min(H, Math.ceil(cy + ry)),
  };
}

function insideEllipse(a, x, y) {
  const dx = (x + 0.5 - a.cx) / a.rx;
  const dy = (y + 0.5 - a.cy) / a.ry;
  return dx * dx + dy * dy <= 1;
}

function pixelate(data, W, a) {
  const block = Math.max(6, Math.round((a.rx * 2) / 9));
  for (let by = a.y0; by < a.y1; by += block) {
    for (let bx = a.x0; bx < a.x1; bx += block) {
      const ex = Math.min(bx + block, a.x1);
      const ey = Math.min(by + block, a.y1);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * W + x) * 3;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          if (!insideEllipse(a, x, y)) continue;
          const i = (y * W + x) * 3;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
        }
      }
    }
  }
}

/** Desenfoque fuerte: 3 pasadas de desenfoque de caja (≈ gaussiano) sobre la zona. */
function blur(data, W, a) {
  const w = a.x1 - a.x0;
  const h = a.y1 - a.y0;
  if (w <= 0 || h <= 0) return;
  const radius = Math.max(6, Math.round((a.rx * 2) / 7));
  const buf = new Float32Array(w * h * 3);
  const tmp = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((y + a.y0) * W + (x + a.x0)) * 3;
      const dst = (y * w + x) * 3;
      buf[dst] = data[src];
      buf[dst + 1] = data[src + 1];
      buf[dst + 2] = data[src + 2];
    }
  }
  // Media móvil 1D con bordes replicados.
  const pass = (from, to, len, count, stride, lineStride) => {
    const norm = 1 / (radius * 2 + 1);
    for (let line = 0; line < count; line++) {
      const base = line * lineStride;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const idx = Math.min(len - 1, Math.max(0, k));
          acc += from[base + idx * stride + c];
        }
        for (let i = 0; i < len; i++) {
          to[base + i * stride + c] = acc * norm;
          const outIdx = Math.max(0, i - radius);
          const inIdx = Math.min(len - 1, i + radius + 1);
          acc += from[base + inIdx * stride + c] - from[base + outIdx * stride + c];
        }
      }
    }
  };
  for (let p = 0; p < 3; p++) {
    pass(buf, tmp, w, h, 3, w * 3); // horizontal
    pass(tmp, buf, h, w, w * 3, 3); // vertical
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!insideEllipse(a, x + a.x0, y + a.y0)) continue;
      const src = (y * w + x) * 3;
      const dst = ((y + a.y0) * W + (x + a.x0)) * 3;
      data[dst] = buf[src];
      data[dst + 1] = buf[src + 1];
      data[dst + 2] = buf[src + 2];
    }
  }
}

/** Censura (en el sitio) las caras de un fotograma RGB24. */
function censorFrame(frame, boxes, style = 'pixelado') {
  const { width: W, height: H, data } = frame;
  for (const box of boxes) {
    const area = censorArea(box, W, H);
    if (area.x1 <= area.x0 || area.y1 <= area.y0) continue;
    if (style === 'desenfoque') blur(data, W, area);
    else pixelate(data, W, area);
  }
}

module.exports = {
  PRECISION,
  loadDetector,
  analyzeFaces,
  buildTracks,
  boxesAt,
  censorFrame,
  readPpmFrames,
  spawnDecoder,
  mergeBoxes,
  tileGrid,
};
