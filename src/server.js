const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ZipArchive } = require('archiver');

const { compressImage, fileSize, parseAspect } = require('./image');
const { compressVideo, getFfmpeg, FFMPEG_HELP } = require('./video');
const shopify = require('./shopify');

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
    phase: job.phase,
    originalName: job.originalName,
    outputName: job.outputName,
    originalSize: job.originalSize,
    outputSize: job.outputSize,
    keptOriginal: job.keptOriginal,
    details: job.details,
    error: job.error,
  };
}

/** Recorte elegido en el editor: JSON {x, y, w, h} en fracciones 0-1. */
function parseCrop(value) {
  if (!value) return null;
  let crop;
  try {
    crop = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  const nums = ['x', 'y', 'w', 'h'].map((k) => Number(crop?.[k]));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

function parseOptions(body) {
  return {
    quality: ['maxima', 'alta', 'equilibrada'].includes(body.quality) ? body.quality : 'alta',
    format: ['auto', 'jpeg', 'webp', 'png', 'avif'].includes(body.format) ? body.format : 'auto',
    maxDimension: Number(body.maxDimension) || 0,
    maxResolution: Number(body.maxResolution) || 0,
    maxFps: Number(body.maxFps) || 0,
    removeAudio: body.removeAudio === 'true' || body.removeAudio === true,
    removeSilence: body.removeSilence === 'true' || body.removeSilence === true,
    silenceSensitivity: ['baja', 'normal', 'alta'].includes(body.silenceSensitivity)
      ? body.silenceSensitivity
      : 'normal',
    minSilence: [0.5, 1, 2].includes(Number(body.minSilence)) ? Number(body.minSilence) : 1,
    blurFaces: body.blurFaces === 'true' || body.blurFaces === true,
    faceStyle: body.faceStyle === 'desenfoque' ? 'desenfoque' : 'pixelado',
    facePrecision: body.facePrecision === 'alta' ? 'alta' : 'normal',
    aspect: parseAspect(body.aspect) ? String(body.aspect) : null,
    crop: parseCrop(body.crop),
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
          cropped: result.cropped,
        };
      } else {
        result = await compressVideo(job.inputPath, OUTPUT_DIR, baseName, options, (p, phase) => {
          job.progress = p;
          job.phase = phase;
        });
        job.details = result.details;
      }

      job.outputPath = result.outputPath;
      job.outputSize = await fileSize(result.outputPath);

      // Si el resultado pesa más que el original y es el mismo formato,
      // devolvemos el original: nunca empeoramos un archivo ya optimizado.
      // (Salvo que se hayan quitado silencios o censurado caras: el contenido ya no es
      // el mismo y devolver el original anularía la censura.)
      const inExt = path.extname(job.originalName).toLowerCase().replace('jpeg', 'jpg');
      const outExt = path.extname(result.outputPath).toLowerCase();
      const edited = job.details?.removedSeconds || job.details?.faces || job.details?.cropped;
      if (job.outputSize >= job.originalSize && inExt === outExt && !edited) {
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
    console.error(`[${job.id}] Error procesando "${job.originalName}": ${err.message}`);
    if (err.details) console.error(`[${job.id}] Últimas líneas de FFmpeg:\n${err.details}`);
    job.status = 'error';
    job.error = err.message;
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Contraseña opcional (variable APP_PASSWORD) para que nadie más use tu servidor
// cuando la app está publicada en internet. El navegador la pide con su ventana nativa.
if (process.env.APP_PASSWORD) {
  const expected = Buffer.from(process.env.APP_PASSWORD);
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const password = scheme === 'Basic' && encoded
      ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':')
      : '';
    const given = Buffer.from(password);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Compresor multimedia", charset="UTF-8"');
    res.status(401).send('Se requiere contraseña.');
  });
}

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

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
};

/** Texto alternativo a partir del nombre: "camiseta-azul-frente.jpg" → "Camiseta azul frente". */
function altFromName(name) {
  const text = path.parse(name).name.replace(/[-_]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shopifyError(res, err) {
  const known = err instanceof shopify.ShopifyError;
  if (!known) console.error('[shopify]', err);
  res.status(known ? 400 : 500).json({ error: known ? err.message : `Error inesperado: ${err.message}` });
}

function requireShopify(res) {
  const config = shopify.readConfig();
  if (!config) {
    res.status(400).json({ error: 'Conecta primero tu tienda de Shopify.' });
    return null;
  }
  return config;
}

const jsonBody = express.json({ limit: '100kb' });

app.get('/api/shopify/status', async (req, res) => {
  const config = shopify.readConfig();
  if (!config) return res.json({ connected: false, scopes: shopify.SCOPES });
  const info = {
    connected: true,
    shop: config.shop,
    mode: config.accessToken ? 'token' : 'client',
    fromEnv: Boolean(config.fromEnv),
    scopes: shopify.SCOPES,
  };
  try {
    info.name = (await shopify.testConnection(config)).name;
  } catch (err) {
    info.error = err.message;
  }
  res.json(info);
});

app.post('/api/shopify/config', jsonBody, async (req, res) => {
  if (shopify.readConfig()?.fromEnv) {
    return res.status(400).json({ error: 'La conexión está fijada con variables de entorno (SHOPIFY_*).' });
  }
  try {
    const body = req.body || {};
    const config = {
      shop: shopify.normalizeShop(body.shop),
      clientId: String(body.clientId || '').trim(),
      clientSecret: String(body.clientSecret || '').trim(),
      accessToken: String(body.accessToken || '').trim(),
    };
    if (!config.accessToken && !(config.clientId && config.clientSecret)) {
      throw new shopify.ShopifyError('Escribe el Client ID y el Client secret de tu app de Shopify.');
    }
    // Solo se guarda si la conexión funciona.
    const info = await shopify.testConnection(config);
    await shopify.saveConfig(config);
    res.json({ connected: true, shop: config.shop, name: info.name });
  } catch (err) {
    shopifyError(res, err);
  }
});

app.delete('/api/shopify/config', async (req, res) => {
  if (shopify.readConfig()?.fromEnv) {
    return res.status(400).json({ error: 'La conexión está fijada con variables de entorno (SHOPIFY_*).' });
  }
  await shopify.deleteConfig();
  res.json({ connected: false });
});

app.get('/api/shopify/products', async (req, res) => {
  const config = requireShopify(res);
  if (!config) return;
  try {
    res.json({ products: await shopify.searchProducts(config, req.query.q) });
  } catch (err) {
    shopifyError(res, err);
  }
});

app.post('/api/jobs/:id/shopify', jsonBody, async (req, res) => {
  const config = requireShopify(res);
  if (!config) return;
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Archivo no disponible (puede haber expirado).' });

  const mimeType = MIME[path.extname(job.outputPath).toLowerCase()];
  if (!mimeType) return res.status(400).json({ error: 'Shopify no admite este formato de archivo.' });
  const productId = req.body?.productId ? String(req.body.productId) : null;
  if (productId && !/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    return res.status(400).json({ error: 'Producto no válido.' });
  }
  try {
    const result = await shopify.uploadFile(
      config,
      {
        path: job.outputPath,
        filename: job.outputName,
        mimeType,
        kind: job.kind === 'video' ? 'VIDEO' : 'IMAGE',
        alt: String(req.body?.alt ?? altFromName(job.outputName)).slice(0, 512),
      },
      { productId },
    );
    job.shopify = result;
    res.json(result);
  } catch (err) {
    shopifyError(res, err);
  }
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
  start(PORT);
}

/**
 * Arranca el servidor. Si el puerto está ocupado (p. ej. por otra copia de la app
 * abierta en otra terminal) prueba los siguientes, salvo que PORT se haya fijado.
 */
function start(port, attempts = 0) {
  // Express 5 entrega los errores de listen al callback en vez de lanzarlos.
  app.listen(port, (err) => {
    if (err) {
      if (err.code === 'EADDRINUSE' && !process.env.PORT && attempts < 10) {
        console.log(`El puerto ${port} está ocupado, probando el ${port + 1}…`);
        return start(port + 1, attempts + 1);
      }
      console.error(
        err.code === 'EADDRINUSE'
          ? `No se pudo arrancar: el puerto ${port} está ocupado. Cierra la otra app que lo usa ` +
            'o elige otro puerto con la variable PORT.'
          : `No se pudo arrancar el servidor: ${err.message}`,
      );
      process.exit(1);
    }
    console.log(`Compresor multimedia listo en http://localhost:${port}`);
    console.log('Deja esta ventana abierta mientras uses la app (Ctrl + C para cerrarla).');
    getFfmpeg().then((ffmpeg) => {
      if (ffmpeg) console.log(`FFmpeg listo: ${ffmpeg}`);
      else console.warn(`\n⚠  Los videos no funcionarán. ${FFMPEG_HELP}\n`);
    });
  });
}

module.exports = { app, slugify };
