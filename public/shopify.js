/**
 * Conexión con Shopify en la interfaz:
 *  - Botón de estado + ventana para conectar la tienda.
 *  - Ventana para subir uno o varios archivos a "Archivos" o a un producto.
 *
 * window.ShopifyUI.init(onChange)        → consulta el estado; onChange(connected)
 * window.ShopifyUI.isConnected()
 * window.ShopifyUI.openUpload(jobs)      → Promise<Map<jobId, resultado|Error>>
 */
(() => {
  const DOCS_URL = 'https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard';
  let state = { connected: false };
  let onChange = () => {};

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  function modal(title, className = '') {
    const body = el('div', { class: 'modal-body' });
    const actions = el('div', { class: 'modal-actions' });
    const dialog = el('dialog', { class: `modal ${className}` }, [el('h2', { text: title }), body, actions]);
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    return { dialog, body, actions, close: () => dialog.close() };
  }

  // -------------------------------------------------------------------------
  // Estado y botón
  // -------------------------------------------------------------------------
  const button = document.getElementById('shopifyBtn');

  function renderButton() {
    button.classList.toggle('connected', Boolean(state.connected && !state.error));
    button.classList.toggle('warn', Boolean(state.connected && state.error));
    if (!state.connected) button.textContent = 'Conectar Shopify';
    else if (state.error) button.textContent = 'Shopify: revisar conexión';
    else button.textContent = `Shopify: ${state.name || state.shop}`;
  }

  async function refresh() {
    try {
      state = await api('/api/shopify/status');
    } catch {
      state = { connected: false };
    }
    renderButton();
    onChange(Boolean(state.connected && !state.error));
  }

  // -------------------------------------------------------------------------
  // Ventana de conexión
  // -------------------------------------------------------------------------
  function openSettings() {
    const m = modal('Conexión con Shopify', 'shopify-modal');

    if (state.connected) {
      m.body.append(
        el('p', { html: `Conectado a <strong></strong> (<span></span>).` }),
      );
      m.body.querySelector('strong').textContent = state.name || '—';
      m.body.querySelector('span').textContent = state.shop;
      if (state.error) m.body.append(el('p', { class: 'error-text', text: state.error }));
      if (state.fromEnv) {
        m.body.append(el('p', { class: 'hint', text: 'La conexión está configurada con variables de entorno (SHOPIFY_*).' }));
      } else {
        const disconnect = el('button', { type: 'button', class: 'ghost danger', text: 'Desconectar' });
        disconnect.addEventListener('click', async () => {
          await api('/api/shopify/config', { method: 'DELETE' });
          m.close();
          refresh();
        });
        m.actions.append(disconnect);
      }
      const close = el('button', { type: 'button', text: 'Cerrar' });
      close.addEventListener('click', () => m.close());
      m.actions.append(el('span', { class: 'spacer' }), close);
      return;
    }

    const steps = el('ol', { class: 'steps' }, [
      el('li', { html: `Entra al <strong>Dev Dashboard</strong> de Shopify y crea una app (<a href="${DOCS_URL}" target="_blank" rel="noopener">guía oficial</a>).` }),
      el('li', { html: 'En <em>Versions</em>, crea una versión con estos permisos (scopes) y pulsa <em>Release</em>: <code>write_files, read_files, write_products, read_products</code>.' }),
      el('li', { html: 'Pulsa <em>Install app</em> e instálala en tu tienda.' }),
      el('li', { html: 'En <em>Settings</em> de la app copia el <strong>Client ID</strong> y el <strong>Client secret</strong> y pégalos aquí.' }),
    ]);
    const form = el('form', { class: 'shopify-form' }, [
      el('label', { class: 'field' }, [
        el('span', { text: 'Tienda' }),
        el('input', { name: 'shop', required: '', placeholder: 'mitienda.myshopify.com', autocomplete: 'off' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: 'Client ID' }),
        el('input', { name: 'clientId', autocomplete: 'off' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: 'Client secret' }),
        el('input', { name: 'clientSecret', type: 'password', autocomplete: 'off' }),
      ]),
      el('details', {}, [
        el('summary', { text: '¿Tienes una app antigua con un token "shpat_…"?' }),
        el('label', { class: 'field' }, [
          el('span', { text: 'Admin API access token' }),
          el('input', { name: 'accessToken', type: 'password', autocomplete: 'off', placeholder: 'shpat_…' }),
        ]),
        el('p', { class: 'hint', text: 'Solo para apps creadas antes en el admin de Shopify (Apps → Desarrollar apps). Si lo rellenas, no hacen falta Client ID ni secret.' }),
      ]),
      el('p', { class: 'hint', text: 'Los datos se guardan solo en este equipo (archivo .shopify.json) y el secreto nunca se muestra en el navegador.' }),
    ]);
    const error = el('p', { class: 'error-text', hidden: '' });
    m.body.append(steps, form, error);

    const cancel = el('button', { type: 'button', class: 'ghost', text: 'Cancelar' });
    const submit = el('button', { type: 'button', text: 'Conectar' });
    cancel.addEventListener('click', () => m.close());
    const doConnect = async () => {
      const data = Object.fromEntries(new FormData(form).entries());
      submit.disabled = true;
      submit.textContent = 'Conectando…';
      error.hidden = true;
      try {
        await api('/api/shopify/config', { method: 'POST', body: JSON.stringify(data) });
        m.close();
        await refresh();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        submit.disabled = false;
        submit.textContent = 'Conectar';
      }
    };
    submit.addEventListener('click', doConnect);
    form.addEventListener('submit', (e) => { e.preventDefault(); doConnect(); });
    m.actions.append(el('span', { class: 'spacer' }), cancel, submit);
  }

  // -------------------------------------------------------------------------
  // Ventana de subida
  // -------------------------------------------------------------------------
  function openUpload(jobs) {
    return new Promise((resolve) => {
      const results = new Map();
      const single = jobs.length === 1;
      const m = modal(single ? 'Subir a Shopify' : `Subir ${jobs.length} archivos a Shopify`, 'shopify-modal');

      const destFiles = el('input', { type: 'radio', name: 'dest', value: 'files', checked: '' });
      const destProduct = el('input', { type: 'radio', name: 'dest', value: 'product' });
      const search = el('input', { type: 'search', placeholder: 'Buscar producto por nombre…', autocomplete: 'off' });
      const productList = el('ul', { class: 'product-list' });
      const productBox = el('div', { class: 'product-picker', hidden: '' }, [search, productList]);
      let selected = null;

      const altInput = el('input', { type: 'text', maxlength: '512' });
      if (single) altInput.value = jobs[0].alt;

      m.body.append(
        el('fieldset', { class: 'dest' }, [
          el('legend', { text: 'Destino' }),
          el('label', { class: 'check' }, [destFiles, el('span', { text: 'Contenido → Archivos (para usar en el tema, secciones, banners…)' })]),
          el('label', { class: 'check' }, [destProduct, el('span', { text: 'Añadir a un producto' })]),
          productBox,
        ]),
        single
          ? el('label', { class: 'field' }, [
            el('span', { text: 'Texto alternativo (SEO y accesibilidad)' }),
            altInput,
          ])
          : el('p', { class: 'hint', text: 'El texto alternativo de cada archivo se genera a partir de su nombre.' }),
      );
      const status = el('ul', { class: 'upload-status' });
      m.body.append(status);

      let timer = null;
      async function loadProducts() {
        productList.innerHTML = '<li class="hint">Buscando…</li>';
        try {
          const { products } = await api(`/api/shopify/products?q=${encodeURIComponent(search.value)}`);
          productList.innerHTML = '';
          if (!products.length) productList.append(el('li', { class: 'hint', text: 'No se encontraron productos.' }));
          for (const p of products) {
            const thumb = el('span', { class: 'product-thumb' });
            if (p.image) thumb.style.backgroundImage = `url("${p.image}")`;
            const li = el('li', { tabindex: '0', role: 'option' }, [
              thumb,
              el('span', { class: 'product-title', text: p.title }),
              el('span', { class: 'product-status', text: p.status === 'ACTIVE' ? '' : p.status.toLowerCase() }),
            ]);
            const pick = () => {
              selected = p;
              for (const other of productList.children) other.classList.remove('selected');
              li.classList.add('selected');
              upload.disabled = false;
            };
            li.addEventListener('click', pick);
            li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
            productList.append(li);
          }
        } catch (err) {
          productList.innerHTML = '';
          productList.append(el('li', { class: 'error-text', text: err.message }));
        }
      }
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(loadProducts, 300);
      });

      const syncDest = () => {
        const toProduct = destProduct.checked;
        productBox.hidden = !toProduct;
        upload.disabled = toProduct && !selected;
        if (toProduct && !productList.children.length) loadProducts();
      };
      destFiles.addEventListener('change', syncDest);
      destProduct.addEventListener('change', syncDest);

      const cancel = el('button', { type: 'button', class: 'ghost', text: 'Cancelar' });
      const upload = el('button', { type: 'button', text: 'Subir' });
      cancel.addEventListener('click', () => m.close());
      m.dialog.addEventListener('close', () => resolve(results));

      let finished = false;
      upload.addEventListener('click', async () => {
        if (finished) return m.close();
        upload.disabled = true;
        cancel.textContent = 'Cerrar';
        for (const input of m.body.querySelectorAll('input')) input.disabled = true;
        const productId = destProduct.checked ? selected?.id : null;
        let ok = 0;
        for (const job of jobs) {
          const row = el('li', { text: `${job.name}: subiendo…` });
          status.append(row);
          try {
            const result = await api(`/api/jobs/${job.id}/shopify`, {
              method: 'POST',
              body: JSON.stringify({ productId, alt: single ? altInput.value : job.alt }),
            });
            results.set(job.id, result);
            ok++;
            row.textContent = `✓ ${job.name} → ${result.destination}${result.status === 'READY' || productId ? '' : ' (Shopify lo está procesando)'} `;
            row.append(el('a', { href: result.adminUrl, target: '_blank', rel: 'noopener', text: 'Ver en Shopify' }));
            row.className = 'ok';
          } catch (err) {
            results.set(job.id, err);
            row.textContent = `✗ ${job.name}: ${err.message}`;
            row.className = 'error-text';
          }
        }
        upload.textContent = ok === jobs.length ? 'Listo' : 'Cerrar';
        upload.disabled = false;
        finished = true;
      });

      m.actions.append(el('span', { class: 'spacer' }), cancel, upload);
    });
  }

  button.addEventListener('click', openSettings);

  window.ShopifyUI = {
    init(callback) {
      onChange = callback;
      return refresh();
    },
    isConnected: () => Boolean(state.connected && !state.error),
    openUpload,
  };
})();
