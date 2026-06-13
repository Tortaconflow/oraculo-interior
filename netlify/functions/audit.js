// netlify/functions/audit.js
//
// Fase 3 + 4 del Sabueso Digital: Auditoría automática del sitio web y
// calificación de la oportunidad.
//
// Recibe { url, negocio } y devuelve:
//   { ok, finalUrl, https, metrics, issues, score, prioridad, email, whatsapp }
//
// La auditoría se basa en heurísticas reales sobre el HTML descargado (sin
// dependencias externas, sólo regex). No ejecuta JavaScript del sitio, por lo
// que es un análisis del HTML servido (suficiente para detectar la mayoría de
// los problemas técnicos y de conversión que importan en prospección).

const TIMEOUT_MS = 9000;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

// Catálogo de problemas. Cada uno aporta "peso" puntos al score de oportunidad.
// Más problemas = mayor oportunidad comercial (mayor score).
const ISSUE = {
  SIN_HTTPS: { peso: 14, categoria: 'Confianza', texto: 'El sitio no usa HTTPS (conexión no segura).' },
  NO_RESPONSIVE: { peso: 12, categoria: 'Experiencia móvil', texto: 'No es responsive (falta meta viewport): mala experiencia en móvil.' },
  CARGA_LENTA: { peso: 12, categoria: 'Rendimiento', texto: 'Carga lenta del documento HTML.' },
  PAGINA_PESADA: { peso: 8, categoria: 'Rendimiento', texto: 'Página pesada / HTML voluminoso.' },
  IMAGENES_SIN_OPTIMIZAR: { peso: 6, categoria: 'Rendimiento', texto: 'Imágenes sin carga diferida (lazy-load) ni optimización aparente.' },
  SIN_WHATSAPP: { peso: 10, categoria: 'Conversión', texto: 'No tiene integración de WhatsApp.' },
  SIN_CTA: { peso: 9, categoria: 'Conversión', texto: 'Sin llamadas a la acción claras (cotizar, comprar, contactar).' },
  SIN_FORMULARIO: { peso: 5, categoria: 'Conversión', texto: 'No se detectó formulario de contacto.' },
  CONTACTO_OCULTO: { peso: 7, categoria: 'Conversión', texto: 'Datos de contacto difíciles de encontrar (sin teléfono/email visible).' },
  TITULO_DEFICIENTE: { peso: 7, categoria: 'SEO', texto: 'Título de página ausente o mal optimizado.' },
  SIN_META_DESC: { peso: 7, categoria: 'SEO', texto: 'Falta la meta descripción.' },
  ENCABEZADOS_INCORRECTOS: { peso: 5, categoria: 'SEO', texto: 'Uso incorrecto de encabezados H1 (ninguno o varios).' },
  SIN_SEO_LOCAL: { peso: 6, categoria: 'SEO', texto: 'Sin señales de SEO local (datos estructurados LocalBusiness / dirección).' },
  SIN_TESTIMONIOS: { peso: 5, categoria: 'Confianza', texto: 'Sin testimonios ni reseñas visibles.' },
  INFO_DESACTUALIZADA: { peso: 5, categoria: 'Confianza', texto: 'Información desactualizada (año de copyright antiguo).' },
};

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const WHATSAPP_RE = /(wa\.me\/|api\.whatsapp\.com|web\.whatsapp\.com|whatsapp:\/\/|chat\.whatsapp\.com)/i;

function normalizeUrl(url) {
  if (!url) return null;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    return new URL(u).toString();
  } catch (e) {
    return null;
  }
}

function auditHtml(html, finalUrl, elapsedMs, negocio) {
  const lower = html.toLowerCase();
  const issues = [];
  const add = (key) => issues.push({ ...ISSUE[key], key });

  const metrics = {
    elapsedMs,
    bytes: Buffer.byteLength(html, 'utf8'),
    imgCount: (html.match(/<img\b/gi) || []).length,
  };

  // --- Confianza: HTTPS ---
  const https = finalUrl.startsWith('https://');
  if (!https) add('SIN_HTTPS');

  // --- Experiencia móvil: responsive ---
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) add('NO_RESPONSIVE');

  // --- Rendimiento ---
  if (elapsedMs > 4000) add('CARGA_LENTA');
  if (metrics.bytes > 1_500_000) add('PAGINA_PESADA');
  const hasLazy = /loading=["']lazy["']/i.test(html);
  if (metrics.imgCount > 8 && !hasLazy) add('IMAGENES_SIN_OPTIMIZAR');

  // --- Conversión ---
  const whatsappFound = WHATSAPP_RE.test(html);
  if (!whatsappFound) add('SIN_WHATSAPP');

  const ctaWords = /(cotiz|comprar|compra ahora|contáctanos|contactanos|contactar|reservar|agendar|solicitar|llámanos|llamanos|pedir|presupuesto|add to cart|book now|get a quote)/i;
  const hasButton = /<button\b|class=["'][^"']*btn|role=["']button["']/i.test(html);
  if (!ctaWords.test(html) && !hasButton) add('SIN_CTA');

  if (!/<form\b/i.test(html)) add('SIN_FORMULARIO');

  const hasTel = /href=["']tel:/i.test(html);
  const emails = (html.match(EMAIL_RE) || []).filter(
    (e) => !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(e) && !e.includes('@2x')
  );
  const hasMailto = /href=["']mailto:/i.test(html);
  if (!hasTel && !hasMailto && emails.length === 0) add('CONTACTO_OCULTO');

  // --- SEO ---
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  if (!title || title.length < 15 || title.length > 65) add('TITULO_DEFICIENTE');

  const hasMetaDesc = /<meta[^>]+name=["']description["'][^>]*content=["'][^"']{20,}/i.test(html);
  if (!hasMetaDesc) add('SIN_META_DESC');

  const h1Count = (html.match(/<h1\b/gi) || []).length;
  if (h1Count !== 1) add('ENCABEZADOS_INCORRECTOS');

  const hasLocalBusiness = /localbusiness|"@type"\s*:\s*"[^"]*business/i.test(html);
  const hasAddressTag = /<address\b|itemprop=["']address["']/i.test(html);
  if (!hasLocalBusiness && !hasAddressTag) add('SIN_SEO_LOCAL');

  // --- Confianza: testimonios e info actualizada ---
  if (!/(testimoni|reseñ|resena|opinion|opiniones|review|★|⭐|valoracion|valoración)/i.test(lower)) {
    add('SIN_TESTIMONIOS');
  }

  const yearMatches = html.match(/©\s*(\d{4})|copyright\s*(\d{4})|&copy;\s*(\d{4})/gi) || [];
  const currentYear = new Date().getFullYear();
  if (yearMatches.length) {
    const years = yearMatches
      .map((m) => parseInt((m.match(/\d{4}/) || [])[0], 10))
      .filter((y) => y >= 2000 && y <= currentYear);
    if (years.length && Math.max(...years) < currentYear - 1) add('INFO_DESACTUALIZADA');
  }

  // Email y WhatsApp para recolección de información (Fase 2)
  const email = emails.length ? emails[0] : '';
  let whatsapp = '';
  const waMatch = html.match(/wa\.me\/(\+?\d{6,15})/i) || html.match(/api\.whatsapp\.com\/send\?phone=(\+?\d{6,15})/i);
  if (waMatch) whatsapp = waMatch[1];

  return { https, metrics, issues, email, whatsapp, title };
}

function computeScore(issues, { tieneWeb, calificacion, numResenas }) {
  // Score 0-100: mayor = mayor oportunidad comercial.
  let score;
  let detalle;

  if (!tieneWeb) {
    // Sin sitio web = oportunidad crítica por definición.
    score = 92;
    detalle = 'Sin sitio web: máxima necesidad de presencia digital.';
  } else {
    const pesoTotal = issues.reduce((s, i) => s + i.peso, 0);
    // El peso máximo realista ronda ~110; lo normalizamos a 0-85 por fallas,
    // dejando margen para los ajustes por potencial económico.
    score = Math.min(85, Math.round((pesoTotal / 110) * 85));
    detalle = `${issues.length} problema(s) detectado(s) (peso ${pesoTotal}).`;
  }

  // Ajuste por potencial económico: negocios con muchas reseñas tienen tráfico
  // y demanda → corregir su web rinde más → mayor prioridad comercial.
  if (typeof numResenas === 'number') {
    if (numResenas >= 200) score += 8;
    else if (numResenas >= 50) score += 5;
    else if (numResenas >= 10) score += 2;
  }
  // Buena reputación pero web deficiente = oportunidad muy clara de mensaje.
  if (typeof calificacion === 'number' && calificacion >= 4.3 && issues.length >= 4) {
    score += 3;
  }

  score = Math.max(0, Math.min(100, score));

  let prioridad;
  if (score >= 90) prioridad = 'Crítica';
  else if (score >= 70) prioridad = 'Alta';
  else if (score >= 50) prioridad = 'Media';
  else prioridad = 'Baja';

  return { score, prioridad, detalle };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido.' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Cuerpo de la petición inválido.' });
  }

  const negocio = payload.negocio || {};
  const url = normalizeUrl(payload.url || negocio.sitioWeb);

  // Caso: el negocio no tiene sitio web → oportunidad crítica sin necesidad de fetch.
  if (!url) {
    const issues = [
      { key: 'SIN_WEB', peso: 0, categoria: 'Presencia digital', texto: 'El negocio no tiene sitio web detectable.' },
    ];
    const { score, prioridad, detalle } = computeScore(issues, {
      tieneWeb: false,
      calificacion: negocio.calificacion,
      numResenas: negocio.numResenas,
    });
    return json(200, {
      ok: true,
      finalUrl: '',
      https: false,
      tieneWeb: false,
      metrics: null,
      issues,
      score,
      prioridad,
      scoreDetalle: detalle,
      email: '',
      whatsapp: '',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SabuesoDigitalBot/1.0; +https://github.com/tortaconflow/oraculo-interior)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const elapsedMs = Date.now() - t0;
    clearTimeout(timer);

    const finalUrl = resp.url || url;
    const html = await resp.text();

    if (!resp.ok) {
      // Sitio caído o con error → fuerte señal de oportunidad.
      const issues = [
        { key: 'SITIO_ERROR', peso: 0, categoria: 'Rendimiento', texto: `El sitio responde con error HTTP ${resp.status}.` },
      ];
      return json(200, {
        ok: false,
        finalUrl,
        https: finalUrl.startsWith('https://'),
        tieneWeb: true,
        metrics: { elapsedMs, status: resp.status },
        issues,
        score: 80,
        prioridad: 'Alta',
        scoreDetalle: `Sitio con error HTTP ${resp.status}.`,
        email: '',
        whatsapp: '',
      });
    }

    const result = auditHtml(html, finalUrl, elapsedMs, negocio);
    const { score, prioridad, detalle } = computeScore(result.issues, {
      tieneWeb: true,
      calificacion: negocio.calificacion,
      numResenas: negocio.numResenas,
    });

    return json(200, {
      ok: true,
      finalUrl,
      https: result.https,
      tieneWeb: true,
      metrics: result.metrics,
      issues: result.issues,
      score,
      prioridad,
      scoreDetalle: detalle,
      email: result.email,
      whatsapp: result.whatsapp,
      title: result.title,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    // No se pudo cargar / timeout → oportunidad (web rota o muy lenta).
    return json(200, {
      ok: false,
      finalUrl: url,
      https: url.startsWith('https://'),
      tieneWeb: true,
      metrics: { elapsedMs: Date.now() - t0, timeout: aborted },
      issues: [
        {
          key: aborted ? 'CARGA_LENTA' : 'SITIO_INACCESIBLE',
          peso: 0,
          categoria: 'Rendimiento',
          texto: aborted
            ? `El sitio no respondió en ${TIMEOUT_MS / 1000}s (carga muy lenta o caído).`
            : 'No se pudo acceder al sitio web.',
        },
      ],
      score: aborted ? 85 : 78,
      prioridad: aborted ? 'Alta' : 'Alta',
      scoreDetalle: aborted ? 'Timeout al cargar.' : 'Sitio inaccesible.',
      email: '',
      whatsapp: '',
    });
  }
};
