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

/**
 * Comprime una imagen.
 * @param {string} inputPath
 * @param {string} outputDir
 * @param {object} options { quality: 'maxima'|'alta'|'equilibrada', format: 'auto'|'jpeg'|'webp'|'png'|'avif', maxDimension: number|0 }
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

  // .rotate() aplica la orientación EXIF antes de eliminar los metadatos,
  // así las fotos del móvil no quedan giradas.
  let pipeline = sharp(inputPath, { limitInputPixels: false, animated: false })
    .rotate()
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
    originalWidth: metadata.autoOrient?.width ?? metadata.width,
    originalHeight: metadata.autoOrient?.height ?? metadata.height,
  };
}

async function fileSize(p) {
  return (await fs.stat(p)).size;
}

module.exports = { compressImage, fileSize, SHOPIFY_MAX_DIMENSION, QUALITY };
