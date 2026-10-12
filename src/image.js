const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

// Límite de Shopify para imágenes: 4472 x 4472 px (20 MP) y 20 MB.
const SHOPIFY_MAX_DIMENSION = 4472;

const QUALITY = {
  maxima: 90,
  alta: 82,
  equilibrada: 75,
};

/**
 * Decide el formato de salida.
 * - "auto": las fotos (sin transparencia) se guardan como JPEG optimizado (mozjpeg),
 *   las imágenes con transparencia como WebP (mucho más ligero que PNG).
 */
function pickFormat(requested, metadata) {
  if (requested && requested !== 'auto') return requested;
  if (metadata.hasAlpha) return 'webp';
  return 'jpeg';
}

/** "4:5" → 0.8 (ancho / alto). Devuelve null si no es una proporción válida. */
function parseAspect(aspect) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(aspect || ''));
  if (!m) return null;
  const ratio = Number(m[1]) / Number(m[2]);
  return ratio > 0 && Number.isFinite(ratio) ? ratio : null;
}

/**
 * Calcula el recorte en píxeles sobre la imagen ya orientada.
 * - `crop` ({x, y, w, h} en fracciones 0-1) lo elige el usuario en el editor.
 * - Si solo hay `aspect` ("1:1", "9:16"…), se recorta centrado lo más grande posible.
 * Devuelve null si no hay que recortar.
 */
function cropRect(width, height, { crop, aspect } = {}) {
  let x;
  let y;
  let w;
  let h;
  if (crop) {
    x = crop.x * width;
    y = crop.y * height;
    w = crop.w * width;
    h = crop.h * height;
  } else {
    const ratio = parseAspect(aspect);
    if (!ratio) return null;
    w = Math.min(width, height * ratio);
    h = w / ratio;
    x = (width - w) / 2;
    y = (height - h) / 2;
  }
  const left = Math.max(0, Math.min(width - 1, Math.round(x)));
  const top = Math.max(0, Math.min(height - 1, Math.round(y)));
  const rect = {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.round(w))),
    height: Math.max(1, Math.min(height - top, Math.round(h))),
  };
  if (rect.left === 0 && rect.top === 0 && rect.width === width && rect.height === height) return null;
  return rect;
}

/**
 * Comprime una imagen.
 * @param {string} inputPath
 * @param {string} outputDir
 * @param {object} options { quality: 'maxima'|'alta'|'equilibrada', format: 'auto'|'jpeg'|'webp'|'png'|'avif',
 *   maxDimension: number|0, aspect: '1:1'|'9:16'|…, crop: {x, y, w, h} (fracciones 0-1) }
 * @returns {Promise<{outputPath, format, width, height, originalWidth, originalHeight}>}
 */
async function compressImage(inputPath, outputDir, baseName, options = {}) {
  const quality = QUALITY[options.quality] || QUALITY.alta;
  const maxDimension = Math.min(
    Number(options.maxDimension) || SHOPIFY_MAX_DIMENSION,
    SHOPIFY_MAX_DIMENSION,
  );

  // limitInputPixels false: permite fotos de cámaras de muy alta resolución.
  let metadata;
  try {
    metadata = await sharp(inputPath, { limitInputPixels: false }).metadata();
  } catch (err) {
    if (/\.(heic|heif)$/i.test(options.originalName || '')) {
      throw new Error(
        'Las fotos HEIC de iPhone no son compatibles. Expórtalas como JPG o activa en el iPhone ' +
          'Ajustes → Cámara → Formatos → "Más compatible".',
      );
    }
    throw new Error('No se pudo leer la imagen (archivo dañado o formato no soportado).');
  }
  const format = pickFormat(options.format, metadata);

  // autoOrient aplica la orientación EXIF al leer: las fotos del móvil no quedan
  // giradas y el recorte se hace sobre la imagen tal como se ve en pantalla.
  const orientedWidth = metadata.autoOrient?.width ?? metadata.width;
  const orientedHeight = metadata.autoOrient?.height ?? metadata.height;
  const rect = cropRect(orientedWidth, orientedHeight, options);

  let pipeline = sharp(inputPath, { limitInputPixels: false, animated: false, autoOrient: true });
  if (rect) pipeline = pipeline.extract(rect);
  pipeline = pipeline
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: 'lanczos3',
    })
    // Convertimos a sRGB y conservamos el perfil de color para que los colores
    // se vean igual en todos los navegadores.
    .toColorspace('srgb')
    .withIccProfile('srgb');

  switch (format) {
    case 'jpeg':
      pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({
        quality,
        mozjpeg: true,
        progressive: true,
        // Sin submuestreo de color en calidad máxima: bordes y textos más nítidos.
        chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0',
      });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality, alphaQuality: 100, effort: 6, smartSubsample: true });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality: Math.max(quality - 20, 40), effort: 6 });
      break;
    case 'png':
      // PNG con paleta (cuantizado): reduce mucho el peso manteniendo la transparencia.
      pipeline = pipeline.png({
        compressionLevel: 9,
        palette: true,
        quality: Math.min(quality + 10, 100),
        effort: 10,
      });
      break;
    default:
      throw new Error(`Formato no soportado: ${format}`);
  }

  const ext = format === 'jpeg' ? 'jpg' : format;
  const outputPath = path.join(outputDir, `${baseName}.${ext}`);
  const info = await pipeline.toFile(outputPath);

  return {
    outputPath,
    format,
    width: info.width,
    height: info.height,
    cropped: Boolean(rect),
    originalWidth: metadata.autoOrient?.width ?? metadata.width,
    originalHeight: metadata.autoOrient?.height ?? metadata.height,
  };
}

async function fileSize(p) {
  return (await fs.stat(p)).size;
}

module.exports = { compressImage, cropRect, parseAspect, fileSize, SHOPIFY_MAX_DIMENSION, QUALITY };
