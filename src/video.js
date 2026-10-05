const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG_HELP =
  'No se encontró FFmpeg. Soluciones: 1) ejecuta "npm rebuild ffmpeg-static" en la carpeta ' +
  'del proyecto y reinicia; 2) o instala FFmpeg en el sistema (Windows: "winget install Gyan.FFmpeg", ' +
  'Mac: "brew install ffmpeg") y reinicia la terminal; 3) o indica la ruta con la variable FFMPEG_PATH.';

function works(bin) {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
}

function bundledPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return null;
  }
}

/**
 * Descarga el binario de ffmpeg-static si falta. Normalmente lo hace "npm install",
 * pero algunas versiones/configuraciones de npm no ejecutan los scripts de
 * instalación de las dependencias y el archivo nunca llega a descargarse.
 */
function downloadBundled() {
  let installer;
  try {
    installer = path.join(path.dirname(require.resolve('ffmpeg-static/package.json')), 'install.js');
  } catch {
    return Promise.resolve(false);
  }
  console.log('Descargando FFmpeg (solo la primera vez, puede tardar un minuto)…');
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [installer], {
      cwd: path.dirname(installer),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Busca FFmpeg en este orden: variable FFMPEG_PATH, el binario de ffmpeg-static
 * (descargándolo si falta) y el FFmpeg instalado en el sistema.
 */
async function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && works(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;

  const bundled = bundledPath();
  if (bundled && !fs.existsSync(bundled)) await downloadBundled();
  if (bundled && fs.existsSync(bundled) && works(bundled)) return bundled;

  if (works('ffmpeg')) return 'ffmpeg';
  return null;
}

let ffmpegPromise = null;
/** Devuelve la ruta de FFmpeg (o null). Se resuelve una sola vez. */
function getFfmpeg() {
  if (!ffmpegPromise) ffmpegPromise = resolveFfmpeg();
  return ffmpegPromise;
}

// CRF de x264: menor = más calidad. 18 es prácticamente indistinguible del original.
const CRF = {
  maxima: 20,
  alta: 23,
  equilibrada: 26,
};

/**
 * Filtro de escala que limita el lado CORTO del video (1080 = "1080p")
 * tanto para videos horizontales como verticales, sin agrandar nunca.
 */
function scaleFilter(maxShortSide) {
  if (!maxShortSide) return null;
  const s = Number(maxShortSide);
  return (
    `scale='if(gte(iw,ih),-2,min(iw,${s}))':'if(gte(iw,ih),min(ih,${s}),-2)'` +
    ':flags=lanczos'
  );
}

// Sensibilidad de la detección de silencios: nivel (dB) por debajo del cual se
// considera silencio. "alta" corta también ruido de fondo suave.
const SILENCE_THRESHOLD = {
  baja: -45,
  normal: -35,
  alta: -28,
};
// Margen de silencio que se conserva a cada lado del corte para que no quede brusco.
const SILENCE_PADDING = 0.15;
// Límite de tramos para no generar un filtro gigantesco en videos muy largos.
const MAX_SEGMENTS = 200;

/**
 * A partir de los silencios detectados devuelve los tramos que se conservan.
 * @param {{start:number,end:number}[]} silences
 * @param {number} duration
 * @param {number} padding
 * @returns {{start:number,end:number}[]}
 */
function keepSegments(silences, duration, padding = SILENCE_PADDING) {
  // Si hay demasiados, solo se cortan los silencios más largos.
  let cuts = silences
    .map((s) => ({
      start: s.start <= 0.01 ? 0 : s.start + padding,
      end: s.end >= duration - 0.01 ? duration : s.end - padding,
    }))
    .filter((c) => c.end - c.start > 0.05);
  if (cuts.length >= MAX_SEGMENTS) {
    cuts = cuts
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, MAX_SEGMENTS - 1);
  }
  cuts.sort((a, b) => a.start - b.start);

  const keep = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start - cursor > 0.05) keep.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (duration - cursor > 0.05) keep.push({ start: cursor, end: duration });
  return keep;
}

function parseSilences(stderr, duration) {
  const silences = [];
  let current = null;
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) current = Math.max(0, Number(start[1]));
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end && current !== null) {
      silences.push({ start: current, end: Number(end[1]) });
      current = null;
    }
  }
  // Silencio que dura hasta el final del video.
  if (current !== null && duration) silences.push({ start: current, end: duration });
  return silences;
}

function buildArgs(inputPath, outputPath, options = {}, segments = null) {
  const crf = CRF[options.quality] ?? CRF.alta;
  const filters = [];
  const scale = scaleFilter(options.maxResolution);
  if (scale) filters.push(scale);
  // x264 con yuv420p necesita dimensiones pares.
  filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');

  const args = ['-hide_banner', '-y', '-i', inputPath];

  if (segments) {
    // Recorta cada tramo con sonido y los une (vídeo y audio juntos para no
    // perder la sincronización).
    const t = (n) => n.toFixed(3);
    const parts = [];
    let inputs = '';
    segments.forEach((seg, i) => {
      parts.push(`[0:v:0]trim=start=${t(seg.start)}:end=${t(seg.end)},setpts=PTS-STARTPTS[v${i}]`);
      parts.push(`[0:a:0]atrim=start=${t(seg.start)}:end=${t(seg.end)},asetpts=PTS-STARTPTS[a${i}]`);
      inputs += `[v${i}][a${i}]`;
    });
    parts.push(`${inputs}concat=n=${segments.length}:v=1:a=1[vc][ac]`);
    parts.push(`[vc]${filters.join(',')}[vout]`);
    args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
    if (!options.removeAudio) args.push('-map', '[ac]');
  } else {
    args.push('-map', '0:v:0', '-vf', filters.join(','));
    if (!options.removeAudio) args.push('-map', '0:a:0?');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', options.preset || 'slow',
    '-crf', String(crf),
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    // Elimina metadatos innecesarios.
    '-map_metadata', '-1',
    // "faststart": mueve el índice al inicio para que el video empiece
    // a reproducirse antes de descargarse completo (clave para la web).
    '-movflags', '+faststart',
  );

  // Limita los FPS sin aumentar nunca los del original (p. ej. 60 → 30).
  if (options.maxFps) args.push('-fpsmax', String(Number(options.maxFps)));

  if (options.removeAudio) args.push('-an');
  else args.push('-c:a', 'aac', '-b:a', '128k');

  args.push('-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Ejecuta FFmpeg informando del progreso (0-100) respecto a `expectedDuration`
 * (o la duración del archivo de entrada si no se indica). Devuelve el stderr.
 */
function runFfmpeg(ffmpeg, args, { expectedDuration = null, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let duration = expectedDuration;

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 5_000_000) stderr = stderr.slice(-2_500_000);
      if (!duration) duration = parseDuration(stderr);
    });

    proc.stdout.on('data', (chunk) => {
      if (!duration) return;
      const m = /out_time_us=(\d+)/g;
      let match;
      let last = null;
      while ((match = m.exec(chunk.toString()))) last = match[1];
      if (last) {
        const seconds = Number(last) / 1e6;
        onProgress(Math.min(99, Math.max(0, (seconds / duration) * 100)));
      }
    });

    proc.on('error', () => reject(new Error(FFMPEG_HELP)));
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else {
        const tail = stderr.split('\n').slice(-8).join('\n');
        reject(new Error(`FFmpeg terminó con código ${code}:\n${tail}`));
      }
    });
  });
}

/**
 * Analiza el audio y devuelve los silencios encontrados.
 * @returns {Promise<{hasAudio:boolean, duration:number|null, silences:{start,end}[]}>}
 */
/** Lee la información del archivo (duración y si tiene audio) sin procesarlo. */
function probeInput(ffmpeg, inputPath) {
  return new Promise((resolve) => {
    // "ffmpeg -i" sin salida termina con error, pero imprime la información.
    const proc = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', inputPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', () => resolve({ hasAudio: false, duration: null }));
    proc.on('close', () =>
      resolve({ hasAudio: /Stream #0:\d+.*Audio:/.test(stderr), duration: parseDuration(stderr) }),
    );
  });
}

async function detectSilences(ffmpeg, inputPath, options, onProgress) {
  const probe = await probeInput(ffmpeg, inputPath);
  if (!probe.hasAudio) return { hasAudio: false, duration: probe.duration, silences: [] };

  const threshold = SILENCE_THRESHOLD[options.silenceSensitivity] ?? SILENCE_THRESHOLD.normal;
  const minDuration = Number(options.minSilence) || 1;
  const stderr = await runFfmpeg(
    ffmpeg,
    [
      '-hide_banner', '-nostdin', '-i', inputPath,
      '-map', '0:a:0', '-vn',
      '-af', `silencedetect=noise=${threshold}dB:d=${minDuration}`,
      '-f', 'null', '-progress', 'pipe:1', '-nostats', '-',
    ],
    { onProgress },
  );
  const duration = probe.duration || parseDuration(stderr);
  return { hasAudio: true, duration, silences: parseSilences(stderr, duration) };
}

/**
 * Comprime un video a MP4 (H.264 + AAC), el formato más compatible con Shopify
 * y todos los navegadores. Opcionalmente elimina los tramos sin sonido.
 * @param {(percent:number)=>void} onProgress
 */
async function compressVideo(inputPath, outputDir, baseName, options = {}, onProgress = () => {}) {
  const ffmpeg = await getFfmpeg();
  if (!ffmpeg) throw new Error(FFMPEG_HELP);
  const outputPath = path.join(outputDir, `${baseName}.mp4`);
  const details = { format: 'mp4' };

  let segments = null;
  let expectedDuration = null;
  let encodeStart = 0;

  if (options.removeSilence) {
    // El análisis del audio es rápido: ocupa el primer 15 % de la barra.
    encodeStart = 15;
    const analysis = await detectSilences(ffmpeg, inputPath, options, (p) => onProgress(p * 0.15));
    if (!analysis.hasAudio) {
      details.silenceNote = 'el video no tiene audio, no se quitaron silencios';
    } else if (analysis.duration && analysis.silences.length) {
      const keep = keepSegments(analysis.silences, analysis.duration);
      expectedDuration = keep.reduce((sum, k) => sum + (k.end - k.start), 0);
      if (keep.length === 0) {
        details.silenceNote = 'todo el video es silencio, se mantuvo completo';
        expectedDuration = null;
      } else if (analysis.duration - expectedDuration > 0.1) {
        segments = keep;
        details.originalDuration = analysis.duration;
        details.duration = expectedDuration;
        details.removedSeconds = analysis.duration - expectedDuration;
        details.cuts = analysis.silences.length;
      }
    }
    if (!segments && !details.silenceNote) details.silenceNote = 'no se encontraron silencios';
  }

  const args = buildArgs(inputPath, outputPath, options, segments);
  await runFfmpeg(ffmpeg, args, {
    expectedDuration,
    onProgress: (p) => onProgress(encodeStart + p * (1 - encodeStart / 100)),
  });
  onProgress(100);
  return { outputPath, format: 'mp4', details };
}

module.exports = {
  compressVideo,
  buildArgs,
  scaleFilter,
  keepSegments,
  parseSilences,
  CRF,
  getFfmpeg,
  FFMPEG_HELP,
};
