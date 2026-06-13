/* Sabueso Digital AI — Orquestador del flujo de prospección (frontend).
 *
 * Coordina las 6 fases llamando a las funciones serverless de Netlify:
 *   Fase 1+2  /.netlify/functions/discover  → descubrir negocios + datos
 *   Fase 3+4  /.netlify/functions/audit     → auditar sitio + score
 *   Fase 5    /.netlify/functions/proposal  → mensaje personalizado (Gemini)
 *   Fase 6    Exportación a CSV en el cliente.
 */
(function () {
  'use strict';

  const FN = '/.netlify/functions';
  const AUDIT_CONCURRENCY = 4; // sitios auditados en paralelo

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $('form-busqueda'),
    categoria: $('categoria'),
    ubicacion: $('ubicacion'),
    maxResultados: $('maxResultados'),
    placesKey: $('placesApiKey'),
    geminiKey: $('geminiApiKey'),
    btnBuscar: $('btn-buscar'),
    toggleAdv: $('toggle-adv'),
    advKeys: $('adv-keys'),
    progress: $('progress'),
    progressFill: $('progress-fill'),
    progressLabel: $('progress-label'),
    error: $('error'),
    resultados: $('resultados'),
    stats: $('stats'),
    tablaBody: $('tabla-body'),
    btnCsv: $('btn-csv'),
    toast: $('toast'),
  };

  let prospectos = [];
  let sortKey = 'score';
  let sortDir = -1; // descendente por defecto

  // --- Persistencia de claves en localStorage ---
  const KEY_STORE = 'sabueso.keys';
  function loadKeys() {
    try {
      const k = JSON.parse(localStorage.getItem(KEY_STORE) || '{}');
      if (k.places) el.placesKey.value = k.places;
      if (k.gemini) el.geminiKey.value = k.gemini;
    } catch (e) {}
  }
  function saveKeys() {
    try {
      localStorage.setItem(
        KEY_STORE,
        JSON.stringify({ places: el.placesKey.value.trim(), gemini: el.geminiKey.value.trim() })
      );
    } catch (e) {}
  }

  // --- UI helpers ---
  function setProgress(pct, label) {
    el.progress.classList.add('show');
    el.progressFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (label) el.progressLabel.textContent = label;
  }
  function hideProgress() {
    el.progress.classList.remove('show');
  }
  function showError(msg) {
    el.error.hidden = false;
    el.error.textContent = '⚠️ ' + msg;
  }
  function clearError() {
    el.error.hidden = true;
    el.error.textContent = '';
  }
  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  function scoreColor(score) {
    if (score >= 90) return '#ef4444';
    if (score >= 70) return '#f97316';
    if (score >= 50) return '#eab308';
    return '#64748b';
  }

  async function postJSON(url, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error || `Error ${resp.status}`);
      err.code = data.code;
      err.detail = data.detail;
      throw err;
    }
    return data;
  }

  // Ejecuta tareas async con límite de concurrencia.
  async function runPool(items, limit, worker, onTick) {
    const results = new Array(items.length);
    let idx = 0;
    let done = 0;
    async function next() {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { __error: String(e) };
      }
      done++;
      if (onTick) onTick(done, items.length);
      return next();
    }
    const runners = [];
    for (let k = 0; k < Math.min(limit, items.length); k++) runners.push(next());
    await Promise.all(runners);
    return results;
  }

  // --- Flujo principal ---
  async function ejecutarProspeccion(e) {
    e.preventDefault();
    clearError();
    saveKeys();
    prospectos = [];
    el.resultados.hidden = true;
    el.tablaBody.innerHTML = '';
    el.btnBuscar.disabled = true;

    const placesApiKey = el.placesKey.value.trim();
    const geminiApiKey = el.geminiKey.value.trim();

    try {
      // === Fase 1+2: Descubrimiento ===
      setProgress(8, '🔍 Descubriendo negocios en Google Maps…');
      const disc = await postJSON(`${FN}/discover`, {
        categoria: el.categoria.value.trim(),
        ubicacion: el.ubicacion.value.trim(),
        maxResultados: el.maxResultados.value,
        placesApiKey,
      });

      const negocios = disc.negocios || [];
      if (!negocios.length) {
        hideProgress();
        showError('No se encontraron negocios para esa búsqueda. Prueba con otra categoría o ubicación.');
        return;
      }
      setProgress(22, `✅ ${negocios.length} negocios encontrados. Auditando sitios web…`);

      // === Fase 3+4: Auditoría + Calificación (en paralelo) ===
      const auditados = await runPool(
        negocios,
        AUDIT_CONCURRENCY,
        async (negocio) => {
          const audit = await postJSON(`${FN}/audit`, { url: negocio.sitioWeb, negocio });
          return { negocio, audit };
        },
        (done, total) => {
          setProgress(22 + (done / total) * 48, `🩺 Auditando sitios… (${done}/${total})`);
        }
      );

      // === Fase 5: Mensajes personalizados (en paralelo) ===
      setProgress(72, '✍️ Generando mensajes de prospección personalizados…');
      const conMensaje = await runPool(
        auditados,
        AUDIT_CONCURRENCY,
        async (item) => {
          if (item.__error || !item.audit) {
            return { ...item, mensaje: 'No fue posible auditar este negocio.', fuente: 'error' };
          }
          const prop = await postJSON(`${FN}/proposal`, {
            negocio: item.negocio,
            issues: item.audit.issues || [],
            score: item.audit.score,
            prioridad: item.audit.prioridad,
            geminiApiKey,
          });
          return { ...item, mensaje: prop.mensaje, fuente: prop.fuente };
        },
        (done, total) => {
          setProgress(72 + (done / total) * 25, `✍️ Redactando mensajes… (${done}/${total})`);
        }
      );

      // Construir modelo de prospectos
      prospectos = conMensaje
        .filter((x) => x && x.negocio)
        .map((x) => {
          const a = x.audit || {};
          const issues = a.issues || [];
          return {
            nombre: x.negocio.nombre,
            categoria: x.negocio.categoria,
            ubicacion: x.negocio.direccion || el.ubicacion.value.trim(),
            web: a.finalUrl || x.negocio.sitioWeb || '',
            email: a.email || '',
            telefono: x.negocio.telefono || '',
            whatsapp: a.whatsapp || '',
            calificacion: x.negocio.calificacion,
            numResenas: x.negocio.numResenas,
            googleMapsUri: x.negocio.googleMapsUri || '',
            score: typeof a.score === 'number' ? a.score : 0,
            prioridad: a.prioridad || 'Baja',
            issues,
            numProblemas: issues.length,
            metrics: a.metrics,
            mensaje: x.mensaje || '',
          };
        });

      setProgress(100, `🎯 Listo: ${prospectos.length} prospectos calificados y priorizados.`);
      sortKey = 'score';
      sortDir = -1;
      render();
      el.resultados.hidden = false;
      setTimeout(hideProgress, 800);
    } catch (err) {
      hideProgress();
      if (err.code === 'NO_PLACES_KEY') {
        el.advKeys.classList.add('open');
        showError(
          'Se requiere una API key de Google Places para descubrir negocios. Ábrela en "⚙️ Claves de API" o configúrala en Netlify.'
        );
      } else {
        showError(err.message + (err.detail ? ` — ${String(err.detail).slice(0, 200)}` : ''));
      }
    } finally {
      el.btnBuscar.disabled = false;
    }
  }

  // --- Render de la tabla ---
  function sortProspectos() {
    prospectos.sort((a, b) => {
      let va = a[sortKey];
      let vb = b[sortKey];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render() {
    sortProspectos();

    // Stats
    const crit = prospectos.filter((p) => p.prioridad === 'Crítica').length;
    const alta = prospectos.filter((p) => p.prioridad === 'Alta').length;
    const conEmail = prospectos.filter((p) => p.email).length;
    const conWa = prospectos.filter((p) => p.whatsapp).length;
    el.stats.innerHTML = `
      <div class="stat"><div class="n">${prospectos.length}</div><div class="l">Prospectos</div></div>
      <div class="stat"><div class="n" style="color:#fca5a5">${crit}</div><div class="l">Crítica</div></div>
      <div class="stat"><div class="n" style="color:#fdba74">${alta}</div><div class="l">Alta</div></div>
      <div class="stat"><div class="n">${conEmail}</div><div class="l">Con email</div></div>
      <div class="stat"><div class="n">${conWa}</div><div class="l">Con WhatsApp</div></div>
    `;

    el.tablaBody.innerHTML = '';
    prospectos.forEach((p, i) => {
      const tr = document.createElement('tr');

      const chips = p.issues
        .slice(0, 3)
        .map((is) => `<span class="chip">${esc(is.categoria || '')}</span>`)
        .join('');

      const contacto = [
        p.telefono ? `📞 ${esc(p.telefono)}` : '',
        p.email ? `✉️ ${esc(p.email)}` : '',
        p.whatsapp ? `💬 ${esc(p.whatsapp)}` : '',
        p.web ? `<a href="${esc(p.web)}" target="_blank" rel="noopener">🌐 sitio</a>` : '<span class="meta">sin sitio</span>',
      ]
        .filter(Boolean)
        .join('<br>');

      const rating = p.calificacion != null ? `⭐ ${p.calificacion} (${p.numResenas || 0})` : '';

      tr.innerHTML = `
        <td><span class="score-pill" style="background:${scoreColor(p.score)}">${p.score}</span></td>
        <td><span class="prio ${esc(p.prioridad)}">${esc(p.prioridad)}</span></td>
        <td>
          <div class="nombre">${esc(p.nombre)}</div>
          <div class="meta">${esc(p.ubicacion)}</div>
          <div class="meta">${rating}</div>
        </td>
        <td class="meta">${esc(p.categoria)}</td>
        <td class="meta">${contacto}</td>
        <td>
          <div class="nombre">${p.numProblemas}</div>
          <div class="issue-chips">${chips}</div>
        </td>
        <td><button class="expand-btn" data-i="${i}">Ver detalle ▾</button></td>
      `;
      el.tablaBody.appendChild(tr);

      const detail = document.createElement('tr');
      detail.className = 'detail-row';
      detail.hidden = true;
      const issuesList = p.issues.length
        ? p.issues.map((is) => `<li><strong>${esc(is.categoria || '')}:</strong> ${esc(is.texto || '')}</li>`).join('')
        : '<li>Sin problemas relevantes detectados.</li>';
      detail.innerHTML = `
        <td colspan="7">
          <div class="detail-box">
            <h4>Problemas detectados (${p.issues.length})</h4>
            <ul>${issuesList}</ul>
            <h4>Mensaje de prospección personalizado</h4>
            <div class="msg-box" id="msg-${i}">${esc(p.mensaje)}</div>
            <div class="msg-actions">
              <button class="btn-ghost" data-copy="${i}">📋 Copiar mensaje</button>
              ${p.googleMapsUri ? `<a class="btn-ghost" style="text-decoration:none;display:inline-block" href="${esc(p.googleMapsUri)}" target="_blank" rel="noopener">📍 Google Maps</a>` : ''}
            </div>
          </div>
        </td>`;
      el.tablaBody.appendChild(detail);
    });

    // Actualizar indicador de ordenamiento en encabezados
    document.querySelectorAll('#tabla th[data-sort]').forEach((th) => {
      const k = th.getAttribute('data-sort');
      th.textContent = th.textContent.replace(/[▾▴]/g, '').trim();
      if (k === sortKey) th.textContent += sortDir === -1 ? ' ▾' : ' ▴';
    });
  }

  // --- Eventos de tabla (delegados) ---
  el.tablaBody.addEventListener('click', (e) => {
    const exp = e.target.closest('.expand-btn');
    if (exp) {
      const tr = exp.closest('tr');
      const detail = tr.nextElementSibling;
      const open = detail.hidden;
      detail.hidden = !open;
      exp.textContent = open ? 'Ocultar ▴' : 'Ver detalle ▾';
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const i = copy.getAttribute('data-copy');
      const txt = prospectos[i].mensaje || '';
      navigator.clipboard?.writeText(txt).then(
        () => toast('Mensaje copiado al portapapeles'),
        () => toast('No se pudo copiar')
      );
    }
  });

  // --- Ordenamiento por columna ---
  document.querySelectorAll('#tabla th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.getAttribute('data-sort');
      if (sortKey === k) sortDir *= -1;
      else {
        sortKey = k;
        sortDir = k === 'nombre' || k === 'categoria' ? 1 : -1;
      }
      render();
    });
  });

  // === Fase 6: Exportación CSV ===
  function toCSV() {
    const headers = [
      'Nombre del negocio', 'Categoría', 'Ubicación', 'Web', 'Email', 'Teléfono',
      'WhatsApp', 'Calificación', 'Reseñas', 'Puntuación', 'Prioridad',
      'Problemas detectados', 'Mensaje personalizado',
    ];
    const q = (v) => {
      const s = String(v == null ? '' : v).replace(/"/g, '""');
      return `"${s}"`;
    };
    const rows = prospectos.map((p) =>
      [
        p.nombre, p.categoria, p.ubicacion, p.web, p.email, p.telefono,
        p.whatsapp, p.calificacion != null ? p.calificacion : '', p.numResenas || 0,
        p.score, p.prioridad,
        p.issues.map((i) => i.texto).join(' | '),
        p.mensaje,
      ].map(q).join(',')
    );
    return '﻿' + [headers.map(q).join(','), ...rows].join('\r\n');
  }

  el.btnCsv.addEventListener('click', () => {
    if (!prospectos.length) return;
    const blob = new Blob([toCSV()], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = `${el.categoria.value}-${el.ubicacion.value}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    a.href = url;
    a.download = `sabueso-prospectos-${slug || 'lista'}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('CSV descargado');
  });

  // --- Toggle de claves avanzadas ---
  el.toggleAdv.addEventListener('click', () => el.advKeys.classList.toggle('open'));

  el.form.addEventListener('submit', ejecutarProspeccion);

  loadKeys();
})();
