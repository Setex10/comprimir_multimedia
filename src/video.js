const { spawn } = require('child_process');
const path = require('path');

const FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static') || 'ffmpeg';

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

function buildArgs(inputPath, outputPath, options = {}) {
  const crf = CRF[options.quality] ?? CRF.alta;
  const filters = [];
  const scale = scaleFilter(options.maxResolution);
  if (scale) filters.push(scale);
  // x264 con yuv420p necesita dimensiones pares.
  filters.push("pad=ceil(iw/2)*2:ceil(ih/2)*2");

  const args = [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-vf', filters.join(','),
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
  ];

  // Limita los FPS sin aumentar nunca los del original (p. ej. 60 → 30).
  if (options.maxFps) args.push('-fpsmax', String(Number(options.maxFps)));

  if (options.removeAudio) {
    args.push('-an');
  } else {
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k');
  }

  args.push('-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Comprime un video a MP4 (H.264 + AAC), el formato más compatible con Shopify
 * y todos los navegadores.
 * @param {(percent:number)=>void} onProgress
 */
function compressVideo(inputPath, outputDir, baseName, options = {}, onProgress = () => {}) {
  const outputPath = path.join(outputDir, `${baseName}.mp4`);
  const args = buildArgs(inputPath, outputPath, options);

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let duration = null;

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      if (duration === null) duration = parseDuration(stderr);
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

    proc.on('error', (err) => reject(new Error(`No se pudo ejecutar FFmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        onProgress(100);
        resolve({ outputPath, format: 'mp4' });
      } else {
        const tail = stderr.split('\n').slice(-8).join('\n');
        reject(new Error(`FFmpeg terminó con código ${code}:\n${tail}`));
      }
    });
  });
}

module.exports = { compressVideo, buildArgs, scaleFilter, CRF, FFMPEG_PATH };
