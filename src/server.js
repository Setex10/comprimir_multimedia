const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ZipArchive } = require('archiver');

const { compressImage, fileSize } = require('./image');
const { compressVideo, getFfmpeg, FFMPEG_HELP } = require('./video');

const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const JOB_TTL_MS = 60 * 60 * 1000; // los archivos se borran tras 1 hora

const WORK_DIR = path.join(os.tmpdir(), 'comprimir-multimedia');
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');
const OUTPUT_DIR = path.join(WORK_DIR, 'output');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff', '.gif', '.heic', '.heif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.3gp']);

function mediaKind(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.mimetype.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  if (file.mimetype.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** Nombre de archivo seguro y amigable para Shopify (sin espacios ni acentos). */
function slugify(name) {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'archivo'
  );
}

// ---------------------------------------------------------------------------
// Cola de trabajos: los videos se procesan de uno en uno (FFmpeg ya usa todos
// los núcleos); las imágenes en paralelo limitado.
// ---------------------------------------------------------------------------
const jobs = new Map();

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
const imageLimit = createLimiter(Math.max(1, Math.min(4, os.cpus().length)));
const videoLimit = createLimiter(1);

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: Math.round(job.progress),
    originalName: job.originalName,
    outputName: job.outputName,
    originalSize: job.originalSize,
    outputSize: job.outputSize,
    keptOriginal: job.keptOriginal,
    details: job.details,
    error: job.error,
  };
}

function parseOptions(body) {
  return {
    quality: ['maxima', 'alta', 'equilibrada'].includes(body.quality) ? body.quality : 'alta',
    format: ['auto', 'jpeg', 'webp', 'png', 'avif'].includes(body.format) ? body.format : 'auto',
    maxDimension: Number(body.maxDimension) || 0,
    maxResolution: Number(body.maxResolution) || 0,
    maxFps: Number(body.maxFps) || 0,
    removeAudio: body.removeAudio === 'true' || body.removeAudio === true,
  };
}

async function runJob(job, options) {
  const baseName = `${job.id}-${slugify(path.parse(job.originalName).name)}`;
  const limit = job.kind === 'video' ? videoLimit : imageLimit;

  try {
    await limit(async () => {
      job.status = 'processing';
      let result;
      if (job.kind === 'image') {
        result = await compressImage(job.inputPath, OUTPUT_DIR, baseName, {
          ...options,
          originalName: job.originalName,
        });
        job.details = {
          format: result.format,
          width: result.width,
          height: result.height,
          originalWidth: result.originalWidth,
          originalHeight: result.originalHeight,
        };
      } else {
        result = await compressVideo(job.inputPath, OUTPUT_DIR, baseName, options, (p) => {
          job.progress = p;
        });
        job.details = { format: 'mp4' };
      }

      job.outputPath = result.outputPath;
      job.outputSize = await fileSize(result.outputPath);

      // Si el resultado pesa más que el original y es el mismo formato,
      // devolvemos el original: nunca empeoramos un archivo ya optimizado.
      const inExt = path.extname(job.originalName).toLowerCase().replace('jpeg', 'jpg');
      const outExt = path.extname(result.outputPath).toLowerCase();
      if (job.outputSize >= job.originalSize && inExt === outExt) {
        await fsp.rm(result.outputPath, { force: true });
        job.outputPath = path.join(OUTPUT_DIR, `${baseName}${outExt}`);
        await fsp.copyFile(job.inputPath, job.outputPath);
        job.outputSize = job.originalSize;
        job.keptOriginal = true;
      }

      job.outputName = `${slugify(path.parse(job.originalName).name)}${path.extname(job.outputPath)}`;
      job.progress = 100;
      job.status = 'done';
    });
  } catch (err) {
    console.error(`[${job.id}] Error:`, err.message);
    job.status = 'error';
    job.error = err.message.split('\n')[0];
  } finally {
    fsp.rm(job.inputPath, { force: true }).catch(() => {});
  }
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS && job.status !== 'processing') {
      if (job.outputPath) fsp.rm(job.outputPath, { force: true }).catch(() => {});
      jobs.delete(id);
    }
  }
}
setInterval(cleanupOldJobs, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/jobs', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

  // multer entrega el nombre en latin1; lo pasamos a UTF-8 para conservar acentos.
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const kind = mediaKind({ ...req.file, originalname: originalName });
  if (!kind) {
    fsp.rm(req.file.path, { force: true }).catch(() => {});
    return res.status(415).json({ error: 'Formato no soportado. Sube imágenes o videos.' });
  }

  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    kind,
    status: 'queued',
    progress: 0,
    originalName,
    originalSize: req.file.size,
    inputPath: req.file.path,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  runJob(job, parseOptions(req.body));
  res.status(202).json(publicJob(job));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Trabajo no encontrado (puede haber expirado).' });
  res.json(publicJob(job));
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Archivo no disponible.' });
  res.download(job.outputPath, job.outputName);
});

app.get('/api/zip', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  const ready = ids.map((id) => jobs.get(id)).filter((j) => j && j.status === 'done');
  if (ready.length === 0) return res.status(404).json({ error: 'No hay archivos listos.' });

  res.attachment('multimedia-comprimida.zip');
  // Imágenes y videos ya están comprimidos: "store" evita gastar CPU en balde.
  const archive = new ZipArchive({ store: true });
  archive.on('error', (err) => res.destroy(err));
  archive.pipe(res);

  const used = new Set();
  for (const job of ready) {
    let name = job.outputName;
    const { name: base, ext } = path.parse(name);
    for (let i = 2; used.has(name); i++) name = `${base}-${i}${ext}`;
    used.add(name);
    archive.file(job.outputPath, { name });
  }
  archive.finalize();
});

app.use((err, req, res, _next) => {
  if (req.file) fsp.rm(req.file.path, { force: true }).catch(() => {});
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `El archivo supera el límite de ${MAX_UPLOAD_MB} MB.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Compresor multimedia listo en http://localhost:${PORT}`);
    getFfmpeg().then((ffmpeg) => {
      if (ffmpeg) console.log(`FFmpeg listo: ${ffmpeg}`);
      else console.warn(`\n⚠  Los videos no funcionarán. ${FFMPEG_HELP}\n`);
    });
  });
}

module.exports = { app, slugify };
