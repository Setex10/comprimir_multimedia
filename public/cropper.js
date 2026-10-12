/**
 * Editor de recorte al estilo del editor de imágenes de Shopify:
 * proporciones predefinidas, recuadro que se arrastra y se redimensiona con
 * las esquinas (y los bordes en modo libre), cuadrícula de tercios.
 *
 * window.openCropper(file, { aspect, crop }) → Promise<{ aspect, crop } | null>
 *   - aspect: "1:1", "9:16"… o null (libre / sin recorte)
 *   - crop: { x, y, w, h } en fracciones 0-1 de la imagen (orientada), o null
 */
(() => {
  const RATIOS = [
    { id: 'libre', label: 'Libre' },
    { id: 'original', label: 'Original' },
    { id: '1:1', label: '1:1' },
    { id: '4:5', label: '4:5' },
    { id: '3:4', label: '3:4' },
    { id: '2:3', label: '2:3' },
    { id: '9:16', label: '9:16' },
    { id: '16:9', label: '16:9' },
    { id: '4:3', label: '4:3' },
    { id: '3:2', label: '3:2' },
  ];
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  const parseRatio = (id) => {
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(id || '');
    return m ? Number(m[1]) / Number(m[2]) : null;
  };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c);
    return node;
  }

  window.openCropper = function openCropper(file, init = {}) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = el('img', { class: 'crop-image', alt: '', draggable: 'false' });
      const box = el('div', { class: 'crop-box', tabindex: '0', 'aria-label': 'Área de recorte' }, [
        el('div', { class: 'crop-grid' }),
        ...HANDLES.map((h) => el('span', { class: `crop-handle h-${h}`, 'data-handle': h })),
      ]);
      // Cuatro capas oscurecen lo que queda fuera del recuadro.
      const shades = ['top', 'bottom', 'left', 'right'].map((side) => el('div', { class: `crop-shade shade-${side}` }));
      const frame = el('div', { class: 'crop-frame' }, [img, ...shades, box]);
      // El margen alrededor de la imagen deja ver y agarrar las asas en los bordes.
      const stage = el('div', { class: 'crop-stage' }, [frame]);
      const chips = el('div', { class: 'crop-ratios', role: 'group', 'aria-label': 'Proporción' });
      const flipBtn = el('button', { type: 'button', class: 'ghost small', text: '⇄ Girar proporción', title: 'Cambiar entre vertical y horizontal' });
      const info = el('span', { class: 'crop-info' });
      const resetBtn = el('button', { type: 'button', class: 'ghost', text: 'Sin recorte' });
      const cancelBtn = el('button', { type: 'button', class: 'ghost', text: 'Cancelar' });
      const applyBtn = el('button', { type: 'button', text: 'Aplicar recorte' });

      const dialog = el('dialog', { class: 'modal crop-modal' }, [
        el('h2', { text: 'Recortar imagen' }),
        el('div', { class: 'crop-toolbar' }, [chips, flipBtn]),
        stage,
        el('div', { class: 'modal-actions' }, [info, el('span', { class: 'spacer' }), resetBtn, cancelBtn, applyBtn]),
      ]);
      document.body.append(dialog);

      let natW = 0;
      let natH = 0;
      let ratioId = 'libre';
      let ratio = null; // ancho / alto, null = libre
      let crop = { x: 0, y: 0, w: 0, h: 0 }; // en píxeles de la imagen

      const scale = () => (natW ? img.clientWidth / natW : 1);

      function render() {
        const s = scale();
        box.style.left = `${crop.x * s}px`;
        box.style.top = `${crop.y * s}px`;
        box.style.width = `${crop.w * s}px`;
        box.style.height = `${crop.h * s}px`;
        const [top, bottom, left, right] = shades;
        top.style.cssText = `left:0;top:0;width:100%;height:${crop.y * s}px`;
        bottom.style.cssText = `left:0;top:${(crop.y + crop.h) * s}px;width:100%;bottom:0`;
        left.style.cssText = `left:0;top:${crop.y * s}px;width:${crop.x * s}px;height:${crop.h * s}px`;
        right.style.cssText = `left:${(crop.x + crop.w) * s}px;top:${crop.y * s}px;right:0;height:${crop.h * s}px`;
        box.classList.toggle('locked', ratio !== null);
        const w = Math.round(crop.w);
        const h = Math.round(crop.h);
        info.textContent = `${w} × ${h} px${Math.min(w, h) < 800 ? ' · resolución baja' : ''}`;
        info.classList.toggle('warn', Math.min(w, h) < 800);
        for (const chip of chips.children) chip.classList.toggle('active', chip.dataset.id === ratioId);
        flipBtn.disabled = !ratio || Math.abs(ratio - 1) < 1e-6 || ratioId === 'original';
      }

      /** Recuadro más grande con la proporción dada, centrado en el actual. */
      function fitRatio(r) {
        const cx = crop.w ? crop.x + crop.w / 2 : natW / 2;
        const cy = crop.h ? crop.y + crop.h / 2 : natH / 2;
        const w = Math.min(natW, natH * r);
        const h = w / r;
        crop = { w, h, x: clamp(cx - w / 2, 0, natW - w), y: clamp(cy - h / 2, 0, natH - h) };
      }

      function setRatio(id) {
        ratioId = id;
        if (id === 'libre') ratio = null;
        else if (id === 'original') ratio = natW / natH;
        else ratio = parseRatio(id);
        if (ratio) fitRatio(ratio);
        render();
      }

      for (const r of RATIOS) {
        const chip = el('button', { type: 'button', class: 'chip', 'data-id': r.id, text: r.label });
        chip.addEventListener('click', () => setRatio(r.id));
        chips.append(chip);
      }

      flipBtn.addEventListener('click', () => {
        const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratioId);
        if (!m) return;
        const flipped = `${m[2]}:${m[1]}`;
        // Añade la proporción girada como opción si no existe (p. ej. 5:4).
        if (![...chips.children].some((c) => c.dataset.id === flipped)) {
          const chip = el('button', { type: 'button', class: 'chip', 'data-id': flipped, text: flipped });
          chip.addEventListener('click', () => setRatio(flipped));
          chips.append(chip);
        }
        setRatio(flipped);
      });

      // ---- Arrastrar y redimensionar (ratón y táctil) ----
      let drag = null;
      box.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        box.setPointerCapture(e.pointerId);
        drag = { mode: e.target.dataset.handle || 'move', px: e.clientX, py: e.clientY, start: { ...crop } };
      });
      box.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const s = scale();
        const dx = (e.clientX - drag.px) / s;
        const dy = (e.clientY - drag.py) / s;
        const st = drag.start;
        const min = Math.max(16, 32 / s);
        const mode = drag.mode;

        if (mode === 'move') {
          crop = { ...st, x: clamp(st.x + dx, 0, natW - st.w), y: clamp(st.y + dy, 0, natH - st.h) };
        } else if (ratio) {
          // Con proporción fija: se redimensiona desde la esquina, anclada la opuesta.
          const east = mode.includes('e');
          const south = mode.includes('s');
          const ax = east ? st.x : st.x + st.w;
          const ay = south ? st.y : st.y + st.h;
          const px = (east ? st.x + st.w : st.x) + dx;
          const py = (south ? st.y + st.h : st.y) + dy;
          let w = Math.max(Math.abs(px - ax), Math.abs(py - ay) * ratio);
          const maxW = Math.min(east ? natW - ax : ax, (south ? natH - ay : ay) * ratio);
          w = clamp(w, Math.min(min, maxW), maxW);
          const h = w / ratio;
          crop = { w, h, x: east ? ax : ax - w, y: south ? ay : ay - h };
        } else {
          let x0 = st.x;
          let y0 = st.y;
          let x1 = st.x + st.w;
          let y1 = st.y + st.h;
          if (mode.includes('w')) x0 = clamp(st.x + dx, 0, x1 - min);
          if (mode.includes('e')) x1 = clamp(x1 + dx, x0 + min, natW);
          if (mode.includes('n')) y0 = clamp(st.y + dy, 0, y1 - min);
          if (mode.includes('s')) y1 = clamp(y1 + dy, y0 + min, natH);
          crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        }
        render();
      });
      const endDrag = () => { drag = null; };
      box.addEventListener('pointerup', endDrag);
      box.addEventListener('pointercancel', endDrag);

      // Flechas del teclado: mover el recuadro (Mayús = más rápido).
      box.addEventListener('keydown', (e) => {
        const step = (e.shiftKey ? 0.05 : 0.01) * Math.max(natW, natH);
        const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (!moves[e.key]) return;
        e.preventDefault();
        crop.x = clamp(crop.x + moves[e.key][0], 0, natW - crop.w);
        crop.y = clamp(crop.y + moves[e.key][1], 0, natH - crop.h);
        render();
      });

      const onResize = () => render();
      window.addEventListener('resize', onResize);

      function close(result) {
        window.removeEventListener('resize', onResize);
        dialog.close();
        dialog.remove();
        URL.revokeObjectURL(url);
        resolve(result);
      }

      resetBtn.addEventListener('click', () => close({ aspect: null, crop: null }));
      cancelBtn.addEventListener('click', () => close(null));
      dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
      applyBtn.addEventListener('click', () => {
        const full = crop.x < 0.5 && crop.y < 0.5 && Math.abs(crop.w - natW) < 1 && Math.abs(crop.h - natH) < 1;
        if (full) return close({ aspect: null, crop: null });
        close({
          aspect: ratio && ratioId !== 'original' ? ratioId : null,
          crop: { x: crop.x / natW, y: crop.y / natH, w: crop.w / natW, h: crop.h / natH },
        });
      });

      img.addEventListener('load', () => {
        // El navegador ya aplica la orientación EXIF: estas medidas coinciden con
        // las que usa el servidor (sharp con autoOrient).
        natW = img.naturalWidth;
        natH = img.naturalHeight;
        if (init.crop) {
          crop = { x: init.crop.x * natW, y: init.crop.y * natH, w: init.crop.w * natW, h: init.crop.h * natH };
          ratioId = init.aspect && parseRatio(init.aspect) ? init.aspect : 'libre';
          ratio = parseRatio(ratioId);
          if (ratioId !== 'libre' && ![...chips.children].some((c) => c.dataset.id === ratioId)) {
            const chip = el('button', { type: 'button', class: 'chip', 'data-id': ratioId, text: ratioId });
            chip.addEventListener('click', () => setRatio(ratioId));
            chips.append(chip);
          }
          render();
        } else if (init.aspect && parseRatio(init.aspect)) {
          crop = { x: 0, y: 0, w: natW, h: natH };
          setRatio(init.aspect);
        } else {
          crop = { x: 0, y: 0, w: natW, h: natH };
          setRatio('libre');
        }
        box.focus();
      });
      img.addEventListener('error', () => {
        alert('El navegador no puede mostrar esta imagen para recortarla.');
        close(null);
      });

      dialog.showModal();
      img.src = url;
    });
  };
})();
