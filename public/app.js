(() => {
  const $ = (id) => document.getElementById(id);
  const dropzone = $('dropzone');
  const fileInput = $('fileInput');
  const list = $('fileList');
  const template = $('itemTemplate');
  const summary = $('summary');
  const summaryText = $('summaryText');
  const zipBtn = $('zipBtn');
  const clearBtn = $('clearBtn');

  /** @type {{el: HTMLElement, job: any|null}[]} */
  let items = [];
  const queue = [];
  let activeUploads = 0;
  const MAX_PARALLEL_UPLOADS = 2;

  const PHASES = {
    silencios: 'buscando silencios',
    caras: 'detectando caras',
    comprimiendo: 'comprimiendo',
  };

  function formatSeconds(sec) {
    const s = Math.round(sec);
    if (s < 60) return `${sec < 10 ? sec.toFixed(1).replace('.', ',') : s} s`;
    return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  }

  function formatBytes(bytes) {
    if (bytes == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function getOptions() {
    return {
      quality: $('quality').value,
      format: $('format').value,
      maxDimension: $('maxDimension').value,
      maxResolution: $('maxResolution').value,
      maxFps: $('maxFps').value,
      removeAudio: $('removeAudio').checked,
      removeSilence: $('removeSilence').checked,
      minSilence: $('minSilence').value,
      silenceSensitivity: $('silenceSensitivity').value,
      blurFaces: $('blurFaces').checked,
      faceStyle: $('faceStyle').value,
      facePrecision: $('facePrecision').value,
    };
  }

  function addFiles(fileList) {
    const options = getOptions();
    for (const file of fileList) {
      const el = template.content.firstElementChild.cloneNode(true);
      el.querySelector('.name').textContent = file.name;
      el.querySelector('.meta').textContent = `${formatBytes(file.size)} · en cola`;
      const thumb = el.querySelector('.thumb');
      if (file.type.startsWith('image/') && file.size < 30 * 1024 * 1024) {
        const url = URL.createObjectURL(file);
        thumb.style.backgroundImage = `url("${url}")`;
      } else {
        thumb.textContent = file.type.startsWith('video/') ? 'VIDEO' : 'ARCHIVO';
      }
      list.prepend(el);
      const item = { el, job: null };
      items.push(item);
      queue.push({ file, item, options });
    }
    summary.hidden = items.length === 0;
    updateSummary();
    pump();
  }

  function pump() {
    while (activeUploads < MAX_PARALLEL_UPLOADS && queue.length) {
      const task = queue.shift();
      activeUploads++;
      processFile(task).finally(() => {
        activeUploads--;
        pump();
      });
    }
  }

  function setProgress(item, percent, text) {
    item.el.querySelector('.fill').style.width = `${percent}%`;
    if (text) item.el.querySelector('.meta').textContent = text;
  }

  function upload(file, options, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(options)) form.append(k, String(v));
      form.append('file', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/jobs');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* respuesta vacía */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `Error ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Error de red al subir el archivo.'));
      xhr.send(form);
    });
  }

  async function poll(id, onUpdate) {
    for (;;) {
      const res = await fetch(`/api/jobs/${id}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || 'Error consultando el progreso.');
      onUpdate(job);
      if (job.status === 'done' || job.status === 'error') return job;
      await new Promise((r) => setTimeout(r, job.kind === 'video' ? 1000 : 400));
    }
  }

  async function processFile({ file, item, options }) {
    try {
      const sizeText = formatBytes(file.size);
      let job = await upload(file, options, (p) => {
        setProgress(item, p * 0.3, `${sizeText} · subiendo ${Math.round(p)}%`);
      });
      job = await poll(job.id, (j) => {
        const label = j.status === 'queued'
          ? 'en espera'
          : j.kind === 'video'
            ? `${PHASES[j.phase] || 'comprimiendo'} ${j.progress}%`
            : 'comprimiendo…';
        setProgress(item, 30 + j.progress * 0.7, `${sizeText} · ${label}`);
      });
      if (job.status === 'error') throw new Error(job.error);
      item.job = job;
      showResult(item, job);
    } catch (err) {
      item.el.classList.add('error');
      setProgress(item, 100, `Error: ${err.message}`);
    }
    updateSummary();
  }

  function showResult(item, job) {
    const saved = 1 - job.outputSize / job.originalSize;
    const d = job.details || {};
    const parts = [`${formatBytes(job.originalSize)} → ${formatBytes(job.outputSize)}`];
    if (d.width) {
      const resized = d.width !== d.originalWidth;
      parts.push(resized ? `${d.originalWidth}×${d.originalHeight} → ${d.width}×${d.height}` : `${d.width}×${d.height}`);
    }
    if (d.format) parts.push(d.format.toUpperCase());
    if (d.removedSeconds) {
      parts.push(`${formatSeconds(d.originalDuration)} → ${formatSeconds(d.duration)} (−${formatSeconds(d.removedSeconds)} de silencios)`);
    } else if (d.silenceNote) {
      parts.push(d.silenceNote);
    }
    if (d.faces) parts.push('caras censuradas');
    else if (d.facesNote) parts.push(d.facesNote);
    if (job.keptOriginal) parts.push('ya estaba optimizado, se mantiene el original');

    setProgress(item, 100, parts.join(' · '));
    item.el.querySelector('.name').textContent = job.outputName;
    item.el.querySelector('.badge').textContent = saved > 0 ? `−${Math.round(saved * 100)}%` : '0%';
    const link = item.el.querySelector('.download');
    link.href = `/api/jobs/${job.id}/download`;
    link.setAttribute('download', job.outputName);
    link.hidden = false;
  }

  function updateSummary() {
    const done = items.filter((i) => i.job);
    const original = done.reduce((s, i) => s + i.job.originalSize, 0);
    const output = done.reduce((s, i) => s + i.job.outputSize, 0);
    const pending = items.length - done.length - items.filter((i) => i.el.classList.contains('error')).length;
    let text = `${done.length} de ${items.length} listos`;
    if (done.length) {
      text += ` · ${formatBytes(original)} → ${formatBytes(output)} (ahorro ${Math.round((1 - output / original) * 100)}%)`;
    }
    if (pending > 0) text += ` · procesando ${pending}…`;
    summaryText.textContent = text;
    zipBtn.disabled = done.length === 0;
  }

  const toggles = [['removeSilence', 'silenceOptions'], ['blurFaces', 'faceOptions']];
  for (const [check, panel] of toggles) {
    const sync = () => { $(panel).hidden = !$(check).checked; };
    $(check).addEventListener('change', sync);
    sync();
  }

  zipBtn.addEventListener('click', () => {
    const ids = items.filter((i) => i.job).map((i) => i.job.id);
    if (ids.length) window.location.href = `/api/zip?ids=${ids.join(',')}`;
  });

  clearBtn.addEventListener('click', () => {
    if (queue.length || activeUploads) return alert('Espera a que terminen los archivos en proceso.');
    items = [];
    list.innerHTML = '';
    summary.hidden = true;
  });

  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('over'); }));
  dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  // Evita que el navegador abra el archivo si se suelta fuera de la zona.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
})();
