const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Conexión con la tienda de Shopify (GraphQL Admin API).
 *
 * Autenticación (desde 2026 ya no se pueden crear apps personalizadas en el admin):
 *  - Recomendada: app creada en el Dev Dashboard e instalada en la tienda. Con su
 *    Client ID y Client secret se pide un token ("client credentials grant") que
 *    dura 24 h; se renueva solo.
 *  - Compatibilidad: token "shpat_…" de una app personalizada antigua del admin.
 *
 * Permisos necesarios en la app: write_files, read_files, write_products, read_products.
 */

const API_VERSION = '2026-10';
const CONFIG_PATH = process.env.SHOPIFY_CONFIG_PATH || path.join(__dirname, '..', '.shopify.json');
const SCOPES = ['write_files', 'read_files', 'write_products', 'read_products'];

class ShopifyError extends Error {}

/** Acepta "mitienda", "mitienda.myshopify.com" o una URL del admin; devuelve "mitienda.myshopify.com". */
function normalizeShop(input) {
  let value = String(input || '').trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  const admin = /^admin\.shopify\.com$/.test(value) && /\/store\/([a-z0-9-]+)/.exec(String(input).toLowerCase());
  if (admin) value = admin[1];
  if (!value.includes('.')) value = `${value}.myshopify.com`;
  // Solo dominios *.myshopify.com: evita que la app envíe credenciales a otros servidores.
  if (!/^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$/.test(value)) {
    throw new ShopifyError('Escribe el dominio de tu tienda, por ejemplo "mitienda.myshopify.com".');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
function envConfig() {
  if (!process.env.SHOPIFY_SHOP) return null;
  return {
    shop: process.env.SHOPIFY_SHOP,
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
    fromEnv: true,
  };
}

function readConfig() {
  const env = envConfig();
  if (env) return env;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function saveConfig(config) {
  const data = JSON.stringify(
    { shop: config.shop, clientId: config.clientId, clientSecret: config.clientSecret, accessToken: config.accessToken },
    null,
    2,
  );
  // 0o600: solo el usuario actual puede leer el archivo con el secreto.
  await fsp.writeFile(CONFIG_PATH, data, { mode: 0o600 });
}

async function deleteConfig() {
  tokenCache = null;
  await fsp.rm(CONFIG_PATH, { force: true });
}

// ---------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------

/** Origen de la tienda. SHOPIFY_TEST_ORIGIN solo se usa en los tests (servidor simulado). */
function originFor(shop) {
  return process.env.SHOPIFY_TEST_ORIGIN || `https://${shop}`;
}

let tokenCache = null; // { key, token, expiresAt }

async function getAccessToken(config) {
  if (config.accessToken) return config.accessToken;
  if (!config.clientId || !config.clientSecret) {
    throw new ShopifyError('Falta el Client ID o el Client secret de la app de Shopify.');
  }
  const key = `${config.shop}|${config.clientId}|${config.clientSecret}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now()) return tokenCache.token;

  let res;
  try {
    res = await fetch(`${originFor(config.shop)}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'client_credentials',
      }),
    });
  } catch (err) {
    throw new ShopifyError(`No se pudo contactar con ${config.shop}: ${err.message}`);
  }
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Shopify responde HTML si la tienda no existe.
  }
  if (!res.ok || !body.access_token) {
    const detail = body.error_description || body.error || text.slice(0, 200);
    if (/shop_not_permitted/.test(text)) {
      throw new ShopifyError(
        'Shopify no permite este acceso: la app y la tienda deben pertenecer a la misma organización ' +
          'del Dev Dashboard, y la app debe estar instalada en la tienda.',
      );
    }
    if (res.status === 404) throw new ShopifyError(`No se encontró la tienda ${config.shop}.`);
    throw new ShopifyError(`Shopify rechazó las credenciales (${res.status}): ${detail || 'sin detalles'}`);
  }
  // Renovamos 5 minutos antes de que caduque (dura 24 h).
  const ttl = Math.max(60, (Number(body.expires_in) || 86399) - 300) * 1000;
  tokenCache = { key, token: body.access_token, expiresAt: Date.now() + ttl };
  return body.access_token;
}

async function graphql(config, query, variables = {}, attempt = 0) {
  const token = await getAccessToken(config);
  let res;
  try {
    res = await fetch(`${originFor(config.shop)}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new ShopifyError(`No se pudo contactar con Shopify: ${err.message}`);
  }
  if (res.status === 401) {
    tokenCache = null;
    if (attempt === 0 && !config.accessToken) return graphql(config, query, variables, 1);
    throw new ShopifyError('Shopify rechazó el acceso (401). Revisa las credenciales de la app.');
  }
  if (res.status === 403) {
    throw new ShopifyError(`La app no tiene los permisos necesarios. Actívalos en la app: ${SCOPES.join(', ')}.`);
  }
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    return graphql(config, query, variables, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ShopifyError(`Error de Shopify (${res.status}).`);
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    if (/throttled/i.test(msg) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return graphql(config, query, variables, attempt + 1);
    }
    if (/access denied|required access/i.test(msg)) {
      throw new ShopifyError(`La app no tiene los permisos necesarios (${SCOPES.join(', ')}): ${msg}`);
    }
    throw new ShopifyError(`Error de Shopify: ${msg}`);
  }
  return body.data;
}

function userErrorsMessage(errors) {
  return (errors || []).map((e) => e.message).join('; ');
}

// ---------------------------------------------------------------------------
// Operaciones
// ---------------------------------------------------------------------------
const Q_SHOP = 'query ShopInfo { shop { name myshopifyDomain } }';

const Q_PRODUCTS = `query SearchProducts($query: String) {
  products(first: 15, query: $query, sortKey: UPDATED_AT, reverse: true) {
    nodes { id title status featuredMedia { preview { image { url(transform: {maxWidth: 80, maxHeight: 80}) } } } }
  }
}`;

const M_STAGED = `mutation StagedUpload($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const M_FILE_CREATE = `mutation CreateFile($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { id fileStatus alt ... on MediaImage { image { url } } }
    userErrors { field message code }
  }
}`;

const Q_FILE_STATUS = `query FileStatus($id: ID!) {
  node(id: $id) { ... on File { id fileStatus fileErrors { code message } preview { image { url } } } }
}`;

const M_PRODUCT_MEDIA = `mutation AttachMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) {
    product { id title }
    userErrors { field message }
  }
}`;

/** Prueba la conexión y devuelve el nombre de la tienda. */
async function testConnection(config) {
  const data = await graphql(config, Q_SHOP);
  return { name: data.shop.name, domain: data.shop.myshopifyDomain };
}

async function searchProducts(config, text) {
  const term = String(text || '').trim().replace(/["\\]/g, '');
  const data = await graphql(config, Q_PRODUCTS, { query: term ? `title:*${term}*` : null });
  return data.products.nodes.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    image: p.featuredMedia?.preview?.image?.url || null,
  }));
}

function storeHandle(shop) {
  return shop.replace(/\.myshopify\.com$/, '');
}

/**
 * Sube un archivo local a Shopify.
 * @param {object} file { path, filename, mimeType, kind: 'IMAGE'|'VIDEO', alt }
 * @param {object} target { productId } para añadirlo a un producto; vacío = Contenido → Archivos
 */
async function uploadFile(config, file, target = {}) {
  const { size } = await fsp.stat(file.path);

  // 1) Destino temporal de subida.
  const staged = await graphql(config, M_STAGED, {
    input: [
      {
        filename: file.filename,
        mimeType: file.mimeType,
        resource: file.kind,
        httpMethod: 'POST',
        fileSize: String(size),
      },
    ],
  });
  const stagedErrors = userErrorsMessage(staged.stagedUploadsCreate.userErrors);
  const stagedTarget = staged.stagedUploadsCreate.stagedTargets?.[0];
  if (stagedErrors || !stagedTarget?.url) {
    throw new ShopifyError(`Shopify no aceptó el archivo: ${stagedErrors || 'sin destino de subida'}`);
  }

  // 2) Subida del archivo (los parámetros primero, el archivo al final).
  const form = new FormData();
  for (const p of stagedTarget.parameters) form.append(p.name, p.value);
  const blob = await fs.openAsBlob(file.path, { type: file.mimeType });
  form.append('file', blob, file.filename);
  const up = await fetch(stagedTarget.url, { method: 'POST', body: form });
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    throw new ShopifyError(`Falló la subida a Shopify (${up.status}). ${text.slice(0, 200)}`);
  }

  const handle = storeHandle(config.shop);

  // 3a) Añadir al producto.
  if (target.productId) {
    const data = await graphql(config, M_PRODUCT_MEDIA, {
      product: { id: target.productId },
      media: [{ originalSource: stagedTarget.resourceUrl, mediaContentType: file.kind, alt: file.alt || '' }],
    });
    const errors = userErrorsMessage(data.productUpdate.userErrors);
    if (errors) throw new ShopifyError(`Shopify no pudo añadir el archivo al producto: ${errors}`);
    const numericId = target.productId.split('/').pop();
    return {
      status: 'PROCESSING',
      destination: `producto "${data.productUpdate.product.title}"`,
      adminUrl: `https://admin.shopify.com/store/${handle}/products/${numericId}`,
    };
  }

  // 3b) Contenido → Archivos.
  const created = await graphql(config, M_FILE_CREATE, {
    files: [{ originalSource: stagedTarget.resourceUrl, contentType: file.kind, alt: file.alt || '' }],
  });
  const errors = userErrorsMessage(created.fileCreate.userErrors);
  const createdFile = created.fileCreate.files?.[0];
  if (errors || !createdFile) throw new ShopifyError(`Shopify no pudo crear el archivo: ${errors || 'sin respuesta'}`);

  // Shopify procesa el archivo en segundo plano: esperamos un poco a que esté listo
  // (los videos pueden tardar más; en ese caso se devuelve "procesando").
  let status = createdFile.fileStatus;
  let url = createdFile.image?.url || null;
  const deadline = Date.now() + (file.kind === 'VIDEO' ? 20000 : 30000);
  while (status !== 'READY' && status !== 'FAILED' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Number(process.env.SHOPIFY_POLL_MS) || 1500));
    const node = (await graphql(config, Q_FILE_STATUS, { id: createdFile.id })).node;
    status = node?.fileStatus || status;
    url = node?.preview?.image?.url || url;
    if (status === 'FAILED') {
      const why = (node.fileErrors || []).map((e) => e.message).join('; ');
      throw new ShopifyError(`Shopify no pudo procesar el archivo${why ? `: ${why}` : '.'}`);
    }
  }
  return {
    status,
    destination: 'Contenido → Archivos',
    url,
    adminUrl: `https://admin.shopify.com/store/${handle}/content/files`,
  };
}

module.exports = {
  API_VERSION,
  SCOPES,
  ShopifyError,
  normalizeShop,
  readConfig,
  saveConfig,
  deleteConfig,
  testConnection,
  searchProducts,
  uploadFile,
};
