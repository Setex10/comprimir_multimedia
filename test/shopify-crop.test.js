const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shopify-'));
// Antes de cargar el servidor: configuración en una carpeta temporal y
// peticiones dirigidas al Shopify simulado.
process.env.SHOPIFY_CONFIG_PATH = path.join(tmp, 'shopify.json');
process.env.SHOPIFY_POLL_MS = '10';

const { app } = require('../src/server');
const { cropRect } = require('../src/image');
const { normalizeShop } = require('../src/shopify');

// ---------------------------------------------------------------------------
// Shopify simulado: OAuth (client credentials), GraphQL y destino de subida.
// ---------------------------------------------------------------------------
const mock = { tokenRequests: 0, uploads: [], fileCreates: [], productUpdates: [], statusPolls: 0 };
const TOKEN = 'shpat_simulado';
const mockApp = express();
mockApp.post('/admin/oauth/access_token', express.urlencoded({ extended: false }), (req, res) => {
  mock.tokenRequests++;
  const { client_id: id, client_secret: secret, grant_type: grant } = req.body;
  if (grant !== 'client_credentials' || id !== 'cid' || secret !== 'csecret') {
    return res.status(400).json({ error: 'invalid_client', error_description: 'Client credentials are invalid' });
  }
  res.json({ access_token: TOKEN, scope: 'write_files,read_files,write_products,read_products', expires_in: 86399 });
});
mockApp.post('/admin/api/:version/graphql.json', express.json(), (req, res) => {
  if (req.get('X-Shopify-Access-Token') !== TOKEN) return res.status(401).json({ errors: 'Invalid API key' });
  mock.version = req.params.version;
  const { query, variables } = req.body;
  if (/query ShopInfo/.test(query)) {
    return res.json({ data: { shop: { name: 'Tienda de Prueba', myshopifyDomain: 'tienda-prueba.myshopify.com' } } });
  }
  if (/query SearchProducts/.test(query)) {
    mock.lastProductQuery = variables.query;
    return res.json({
      data: {
        products: {
          nodes: [{ id: 'gid://shopify/Product/42', title: 'Camiseta Azul', status: 'ACTIVE', featuredMedia: null }],
        },
      },
    });
  }
  if (/mutation StagedUpload/.test(query)) {
    mock.lastStaged = variables.input[0];
    const origin = `http://127.0.0.1:${mockServer.address().port}`;
    return res.json({
      data: {
        stagedUploadsCreate: {
          stagedTargets: [{
            url: `${origin}/staged-upload`,
            resourceUrl: `${origin}/tmp/recurso-123`,
            parameters: [
              { name: 'key', value: 'tmp/123/archivo' },
              { name: 'policy', value: 'abc' },
            ],
          }],
          userErrors: [],
        },
      },
    });
  }
  if (/mutation CreateFile/.test(query)) {
    mock.fileCreates.push(variables.files[0]);
    return res.json({
      data: { fileCreate: { files: [{ id: 'gid://shopify/MediaImage/7', fileStatus: 'UPLOADED', alt: variables.files[0].alt }], userErrors: [] } },
    });
  }
  if (/query FileStatus/.test(query)) {
    mock.statusPolls++;
    const ready = mock.statusPolls >= 2;
    return res.json({
      data: {
        node: {
          id: variables.id,
          fileStatus: ready ? 'READY' : 'PROCESSING',
          fileErrors: [],
          preview: { image: ready ? { url: 'https://cdn.shopify.com/s/files/imagen.jpg' } : null },
        },
      },
    });
  }
  if (/mutation AttachMedia/.test(query)) {
    mock.productUpdates.push(variables);
    return res.json({
      data: { productUpdate: { product: { id: variables.product.id, title: 'Camiseta Azul' }, userErrors: [] } },
    });
  }
  res.status(400).json({ errors: [{ message: 'Operación no simulada' }] });
});
// El destino de subida recibe un formulario multipart con los parámetros y el archivo al final.
mockApp.post('/staged-upload', multer({ storage: multer.memoryStorage() }).single('file'), (req, res) => {
  mock.uploads.push({ fields: { ...req.body }, size: req.file?.size, mimetype: req.file?.mimetype, name: req.file?.originalname });
  res.status(201).send('');
});

let mockServer;
let server;
let base;

test.before(async () => {
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once('listening', r));
  process.env.SHOPIFY_TEST_ORIGIN = `http://127.0.0.1:${mockServer.address().port}`;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  mockServer.close();
});

async function submit(filePath, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: form });
  assert.equal(res.status, 202);
  let job = await res.json();
  while (job.status !== 'done' && job.status !== 'error') {
    await new Promise((r) => setTimeout(r, 100));
    job = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
  }
  return job;
}

async function download(job) {
  return Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer());
}

/** Imagen de 1200x800: mitad izquierda roja, mitad derecha azul. */
async function twoColor(file) {
  const red = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#ff0000' } }).png().toBuffer();
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#0000ff' } })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .toFile(file);
}

async function pixel(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

// ---------------------------------------------------------------------------
// Recorte
// ---------------------------------------------------------------------------
test('cropRect: proporción centrada y recorte manual', () => {
  assert.deepEqual(cropRect(1200, 800, { aspect: '1:1' }), { left: 200, top: 0, width: 800, height: 800 });
  assert.deepEqual(cropRect(1200, 800, { aspect: '9:16' }), { left: 375, top: 0, width: 450, height: 800 });
  assert.deepEqual(cropRect(1200, 800, { aspect: '16:9' }), { left: 0, top: 63, width: 1200, height: 675 });
  assert.deepEqual(cropRect(1000, 1000, { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 } }), { left: 100, top: 200, width: 500, height: 250 });
  // El recorte manual tiene prioridad sobre la proporción.
  assert.deepEqual(cropRect(1000, 1000, { aspect: '1:1', crop: { x: 0, y: 0, w: 0.5, h: 1 } }), { left: 0, top: 0, width: 500, height: 1000 });
  // Sin recorte, o recorte que ocupa toda la imagen.
  assert.equal(cropRect(1200, 800, {}), null);
  assert.equal(cropRect(1200, 800, { aspect: 'nada' }), null);
  assert.equal(cropRect(1200, 800, { crop: { x: 0, y: 0, w: 1, h: 1 } }), null);
});

test('recorta a 1:1 centrado', async () => {
  const input = path.join(tmp, 'dos-colores.jpg');
  await twoColor(input);
  const job = await submit(input, { aspect: '1:1' });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.details.width, 800);
  assert.equal(job.details.height, 800);
  assert.equal(job.details.cropped, true);
  const out = await download(job);
  const left = await pixel(out, 10, 400);
  const right = await pixel(out, 790, 400);
  assert.ok(left[0] > 200 && left[2] < 60, `izquierda roja ${left}`);
  assert.ok(right[2] > 200 && right[0] < 60, `derecha azul ${right}`);
});

test('recorte manual del editor: solo la mitad derecha', async () => {
  const input = path.join(tmp, 'dos-colores-b.jpg');
  await twoColor(input);
  const job = await submit(input, { crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual([job.details.width, job.details.height], [600, 800]);
  const out = await download(job);
  for (const [x, y] of [[5, 5], [300, 400], [594, 794]]) {
    const p = await pixel(out, x, y);
    assert.ok(p[2] > 200 && p[0] < 60, `(${x},${y}) debe ser azul: ${p}`);
  }
});

test('el recorte respeta la orientación EXIF de las fotos del móvil', async () => {
  // Almacenada 1200x800 (rojo izquierda) con orientación 6: se ve girada, 800x1200, rojo ARRIBA.
  const stored = path.join(tmp, 'stored.jpg');
  await twoColor(stored);
  const input = path.join(tmp, 'girada-exif.jpg');
  await sharp(stored).withMetadata({ orientation: 6 }).toFile(input);
  // El editor trabaja sobre la imagen como se ve: recortamos la mitad de arriba.
  const job = await submit(input, { crop: { x: 0, y: 0, w: 1, h: 0.5 } });
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual([job.details.width, job.details.height], [800, 600]);
  const p = await pixel(await download(job), 400, 300);
  assert.ok(p[0] > 200 && p[2] < 60, `debe ser la parte roja: ${p}`);
});

test('un recorte inválido se ignora en lugar de fallar', async () => {
  const input = path.join(tmp, 'dos-colores-c.jpg');
  await twoColor(input);
  const job = await submit(input, { crop: { x: 0.8, y: 0, w: 0.5, h: 1 } });
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual([job.details.width, job.details.height], [1200, 800]);
});

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------
const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('normalizeShop acepta formatos habituales y rechaza otros dominios', () => {
  assert.equal(normalizeShop('MiTienda'), 'mitienda.myshopify.com');
  assert.equal(normalizeShop('https://mitienda.myshopify.com/admin/products'), 'mitienda.myshopify.com');
  assert.equal(normalizeShop('https://admin.shopify.com/store/mitienda/products'), 'mitienda.myshopify.com');
  assert.throws(() => normalizeShop('evil.com'));
  assert.throws(() => normalizeShop('mitienda.myshopify.com.evil.com'));
  assert.throws(() => normalizeShop(''));
});

test('sin conexión: estado desconectado y la subida pide conectar', async () => {
  const status = await (await fetch(`${base}/api/shopify/status`)).json();
  assert.equal(status.connected, false);
  const res = await post('/api/jobs/noexiste/shopify', {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Conecta/);
});

test('credenciales incorrectas: no se guarda la conexión', async () => {
  const res = await post('/api/shopify/config', { shop: 'tienda-prueba', clientId: 'cid', clientSecret: 'mal' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /credenciales/);
  assert.equal(fs.existsSync(process.env.SHOPIFY_CONFIG_PATH), false);
});

test('conecta con Client ID y secret, y no expone el secreto', async () => {
  const res = await post('/api/shopify/config', { shop: 'tienda-prueba', clientId: 'cid', clientSecret: 'csecret' });
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  assert.equal(body.name, 'Tienda de Prueba');
  assert.equal(body.shop, 'tienda-prueba.myshopify.com');
  assert.equal(JSON.stringify(body).includes('csecret'), false);

  const status = await (await fetch(`${base}/api/shopify/status`)).json();
  assert.equal(status.connected, true);
  assert.equal(status.name, 'Tienda de Prueba');
  assert.equal(JSON.stringify(status).includes('csecret'), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(process.env.SHOPIFY_CONFIG_PATH).mode & 0o777, 0o600);
  }
  assert.equal(mock.version, '2026-10');
});

test('busca productos', async () => {
  const res = await fetch(`${base}/api/shopify/products?q=camis`);
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  assert.equal(body.products[0].title, 'Camiseta Azul');
  assert.equal(mock.lastProductQuery, 'title:*camis*');
});

test('sube una imagen comprimida a Contenido → Archivos', async () => {
  const input = path.join(tmp, 'Producto Final.jpg');
  await twoColor(input);
  const job = await submit(input, { aspect: '1:1' });
  assert.equal(job.status, 'done', job.error);

  const res = await post(`/api/jobs/${job.id}/shopify`, { alt: 'Camiseta azul de frente' });
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  assert.equal(body.status, 'READY');
  assert.equal(body.url, 'https://cdn.shopify.com/s/files/imagen.jpg');
  assert.equal(body.adminUrl, 'https://admin.shopify.com/store/tienda-prueba/content/files');

  // Destino temporal pedido con los datos del archivo comprimido.
  assert.deepEqual(
    { ...mock.lastStaged },
    { filename: 'producto-final.jpg', mimeType: 'image/jpeg', resource: 'IMAGE', httpMethod: 'POST', fileSize: String(job.outputSize) },
  );
  // Shopify recibió el archivo completo y los parámetros firmados.
  const up = mock.uploads.at(-1);
  assert.equal(up.size, job.outputSize);
  assert.deepEqual(up.fields, { key: 'tmp/123/archivo', policy: 'abc' });
  assert.equal(up.name, 'producto-final.jpg');
  // Registro del archivo con la URL de recurso y el texto alternativo.
  assert.match(mock.fileCreates.at(-1).originalSource, /\/tmp\/recurso-123$/);
  assert.equal(mock.fileCreates.at(-1).alt, 'Camiseta azul de frente');
  assert.equal(mock.fileCreates.at(-1).contentType, 'IMAGE');
  // El token se pidió una sola vez y se reutiliza (dura 24 h).
  assert.equal(mock.tokenRequests, 2); // 1 fallido (credenciales malas) + 1 correcto
});

test('añade una imagen a un producto', async () => {
  const input = path.join(tmp, 'para-producto.jpg');
  await twoColor(input);
  const job = await submit(input);
  const res = await post(`/api/jobs/${job.id}/shopify`, { productId: 'gid://shopify/Product/42' });
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  assert.equal(body.adminUrl, 'https://admin.shopify.com/store/tienda-prueba/products/42');
  assert.match(body.destination, /Camiseta Azul/);
  const update = mock.productUpdates.at(-1);
  assert.deepEqual(update.product, { id: 'gid://shopify/Product/42' });
  assert.equal(update.media[0].mediaContentType, 'IMAGE');
  assert.equal(update.media[0].alt, 'Para producto'); // texto alternativo a partir del nombre
  assert.match(update.media[0].originalSource, /recurso-123/);
});

test('rechaza un producto con un identificador no válido', async () => {
  const input = path.join(tmp, 'id-malo.jpg');
  await twoColor(input);
  const job = await submit(input);
  const res = await post(`/api/jobs/${job.id}/shopify`, { productId: 'gid://shopify/Order/1' });
  assert.equal(res.status, 400);
});

test('desconectar borra la configuración', async () => {
  const res = await fetch(`${base}/api/shopify/config`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(process.env.SHOPIFY_CONFIG_PATH), false);
  const status = await (await fetch(`${base}/api/shopify/status`)).json();
  assert.equal(status.connected, false);
});
