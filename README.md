# Compresor Multimedia para Shopify

Aplicación web para comprimir **imágenes y videos** antes de subirlos a Shopify,
manteniendo la mayor resolución y calidad visual posible para que tu tienda cargue más rápido.

## Características

- Arrastra y suelta varios archivos a la vez (imágenes y videos mezclados).
- Barra de progreso de subida y de compresión (los videos muestran el % real).
- Muestra el peso antes/después y el % de ahorro de cada archivo.
- Descarga individual o todo junto en un `.zip`.
- Renombra los archivos a un formato amigable para Shopify/SEO
  (`Camiseta Azul (Frente).JPG` → `camiseta-azul-frente.jpg`).
- Si un archivo ya estaba optimizado y no se puede reducir más, se conserva el original
  (nunca empeora un archivo).
- Los archivos se procesan en tu propio equipo/servidor y se borran automáticamente tras 1 hora.

### Imágenes (con [sharp](https://sharp.pixelplumbing.com/))

- **Mantiene la resolución original** por defecto (solo reduce si supera 4472 px, el límite de Shopify).
  Opcionalmente puedes limitarla a 2048 / 1600 / 1200 px.
- JPEG con **mozjpeg** progresivo (el codificador JPEG más eficiente que existe).
- Formato automático: JPEG para fotos, **WebP** para imágenes con transparencia (mucho más ligero que PNG).
  También puedes forzar JPEG, WebP, PNG (con paleta optimizada) o AVIF.
- Corrige la orientación de las fotos del móvil, convierte a sRGB (colores consistentes en todos
  los navegadores) y elimina metadatos EXIF/GPS innecesarios.
- Acepta JPG, PNG, WebP, AVIF, TIFF y GIF. Las fotos HEIC de iPhone hay que exportarlas antes
  como JPG (o activar en el iPhone *Ajustes → Cámara → Formatos → Más compatible*).

### Videos (con [FFmpeg](https://ffmpeg.org/))

- Salida **MP4 H.264 + AAC**, el formato más compatible con Shopify y todos los navegadores.
- Codificación por calidad constante (CRF) con preset `slow`: máxima calidad por cada MB.
- **`faststart`**: el video empieza a reproducirse antes de descargarse por completo.
- Resolución máxima configurable (Original, 4K, 1080p, 720p) — funciona igual con videos
  verticales (Reels/TikTok) y nunca agranda.
- Límite de FPS (p. ej. 60 → 30 fps, ahorra mucho peso sin diferencia visible en una tienda).
- Opción para **quitar el audio**, ideal para videos de fondo en banners/secciones hero.
- **Eliminar silencios**: detecta los momentos sin sonido y los corta automáticamente, uniendo
  el resto sin desincronizar audio y video. Puedes elegir a partir de qué duración se corta un
  silencio (0,5 s, 1 s o 2 s) y la sensibilidad (cuánto ruido de fondo se considera silencio).
  Se conserva un pequeño margen en cada corte para que no quede brusco. La app muestra la
  duración antes/después y cuántos segundos se quitaron.
- **Censurar caras**: censura la **cabeza completa** de cada persona y la sigue mientras se
  mueve, también cuando se gira, se pone de perfil o de espaldas. Combina dos modelos de IA que
  funcionan dentro de la app (sin enviar nada a internet):
  - un detector de caras (bueno en primeros planos), y
  - **MoveNet MultiPose**, que detecta la postura de hasta 6 personas (nariz, ojos, orejas,
    hombros…) y permite situar la cabeza aunque no se vea la cara.
  Entre detecciones la posición se interpola y cada aparición se extiende un instante antes y
  después para que no se escape ningún fotograma. Estilo pixelado o desenfoque (óvalo).
  - *Precisión normal*: cabezas de personas visibles y caras desde ~7 % del ancho del video.
  - *Precisión alta*: analiza además la imagen por zonas para caras pequeñas o lejanas; más lenta.
  - Limitaciones: personas muy pequeñas, muy tapadas o cortadas por el borde pueden no
    detectarse. **Revisa siempre el video antes de publicarlo.**
  - Se puede combinar con eliminar silencios, cambiar resolución, FPS, etc.
- Acepta MP4, MOV, M4V, WebM, MKV, AVI…

### Niveles de calidad

| Nivel        | Imágenes (calidad) | Videos (CRF) | Uso recomendado                          |
|--------------|--------------------|--------------|------------------------------------------|
| Máxima       | 90 (sin submuestreo de color) | 20 | Fotos de producto con mucho detalle/texto |
| Alta *(por defecto)* | 82         | 23           | La mayoría de imágenes y videos          |
| Equilibrada  | 75                 | 26           | Banners grandes, videos de fondo         |

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior.
- No necesitas instalar FFmpeg: se descarga automáticamente con `npm install` (paquete `ffmpeg-static`).
  Si prefieres usar el FFmpeg de tu sistema, define la variable `FFMPEG_PATH`.

## Uso

```bash
npm install
npm start
```

Abre <http://localhost:3000> en tu navegador, ajusta las opciones y arrastra tus archivos.

### Con Docker

```bash
docker build -t compresor-multimedia .
docker run -p 3000:3000 compresor-multimedia
```

### Variables de entorno

| Variable        | Por defecto | Descripción                               |
|-----------------|-------------|-------------------------------------------|
| `PORT`          | `3000`      | Puerto del servidor                        |
| `MAX_UPLOAD_MB` | `2048`      | Tamaño máximo por archivo subido (MB)      |
| `FFMPEG_PATH`   | (incluido)  | Ruta a un binario de FFmpeg alternativo    |
| `APP_PASSWORD`  | (ninguna)   | Si se define, la app pide esta contraseña (útil al publicarla en internet) |
| `VIDEO_PRESET`  | `slow`      | Preset de x264; `medium` o `fast` comprimen más rápido en servidores modestos |

## Consejos para Shopify

- **Imágenes de producto**: usa calidad *Alta* y tamaño *Original* o *2048 px*. Shopify recomienda
  2048 × 2048 px para que el zoom se vea nítido. Usa la misma proporción (p. ej. cuadrada) en todas.
- **Shopify ya convierte las imágenes a WebP/AVIF** al servirlas desde su CDN, pero lo hace a partir
  de tu archivo original: subir imágenes limpias y del tamaño correcto acelera la subida, reduce el
  peso de las variantes y evita imágenes gigantes en secciones que no las redimensionan
  (archivos en *Contenido → Archivos*, metacampos, etc.).
- **Videos de fondo / banners**: activa *Quitar audio*, 1080p, 30 fps y calidad *Equilibrada*.
  Intenta que pesen menos de ~5 MB.
- **Videos de producto**: 1080p y calidad *Alta* suele ser el mejor equilibrio. Shopify admite
  videos de hasta 1 GB y 10 minutos.

## Solución de problemas

**Error con FFmpeg al comprimir videos (`ffmpeg.exe ENOENT` / "No se encontró FFmpeg")**

El paquete `ffmpeg-static` descarga FFmpeg durante `npm install`, pero algunas versiones de npm
no ejecutan esa descarga, o la bloquea el antivirus, la red o un proxy. Si falta, la app intenta
descargarlo sola al arrancar ("Descargando FFmpeg…") y luego indica en la consola qué FFmpeg usa.
Si aun así no encuentra ninguno:

1. Reintenta la descarga en la carpeta del proyecto: `npm rebuild ffmpeg-static`
2. O instala FFmpeg en el sistema y abre una terminal nueva:
   - Windows: `winget install Gyan.FFmpeg`
   - Mac: `brew install ffmpeg`
3. O indica la ruta manualmente: `set FFMPEG_PATH=C:\ruta\a\ffmpeg.exe` (Windows) antes de `npm start`.

La app busca FFmpeg automáticamente en este orden: `FFMPEG_PATH` → `ffmpeg-static` → FFmpeg del sistema.

## Desarrollo

```bash
npm run dev   # reinicia el servidor al guardar cambios
npm test      # tests de extremo a extremo (imágenes, videos y ZIP)
```

Estructura:

```
src/server.js   API (subida, cola de trabajos, progreso, descarga, ZIP)
src/image.js    Compresión de imágenes (sharp)
src/video.js    Compresión de videos (FFmpeg)
public/         Interfaz web (HTML/CSS/JS sin dependencias)
test/           Tests con node:test
```
