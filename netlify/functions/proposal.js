// netlify/functions/proposal.js
//
// Fase 5 del Sabueso Digital: Generación de un mensaje de prospección único y
// personalizado para cada negocio, usando Gemini.
//
// Recibe { negocio, issues, score, prioridad } y devuelve { mensaje }.
//
// La API key se toma de:
//   1. El cuerpo (geminiApiKey) — útil para pruebas.
//   2. La variable de entorno GEMINI_API_KEY (recomendado en producción).
//
// Si no hay API key, se genera un mensaje de respaldo con plantilla (sin IA),
// para que el flujo nunca se rompa.

const MODEL = 'gemini-2.0-flash';

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

function mensajePlantilla(negocio, issues) {
  const nombre = negocio.nombre || 'su negocio';
  const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  const top = issues
    .slice(0, 2)
    .map((i) => lc(i.texto.replace(/\.$/, '')))
    .join(' y ');
  const detalle = top || 'algunas oportunidades de mejora en su presencia digital';
  return (
    `Hola, equipo de ${nombre}. Revisando su presencia en línea noté ${detalle}. ` +
    `Esto puede estar costándoles clientes potenciales que buscan sus servicios. ` +
    `Ayudamos a negocios como el suyo a mejorar su sitio y automatizar la atención para ` +
    `aumentar sus conversiones. ¿Le interesaría una auditoría gratuita y sin compromiso?`
  );
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
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const apiKey = payload.geminiApiKey || process.env.GEMINI_API_KEY;

  // Sin key → respaldo con plantilla, sin romper el flujo.
  if (!apiKey) {
    return json(200, { mensaje: mensajePlantilla(negocio, issues), fuente: 'plantilla' });
  }

  const listaProblemas = issues.map((i) => `- (${i.categoria}) ${i.texto}`).join('\n') || '- Presencia digital mejorable';

  const prompt =
    `Actúa como un consultor experto en marketing digital que prospecta de forma profesional y cercana.\n` +
    `Redacta un MENSAJE DE PROSPECCIÓN único, en español, dirigido al negocio "${negocio.nombre || 'el negocio'}"` +
    (negocio.categoria ? ` (categoría: ${negocio.categoria})` : '') + `.\n\n` +
    `Problemas detectados en su sitio web / presencia digital:\n${listaProblemas}\n\n` +
    `El mensaje debe:\n` +
    `1. Mencionar 1 o 2 problemas concretos de la lista (los más relevantes).\n` +
    `2. Explicar brevemente cómo esos problemas afectan sus ventas o clientes.\n` +
    `3. Proponer una solución concreta.\n` +
    `4. Mantener un tono profesional y amigable, tuteando con respeto.\n` +
    `5. Cerrar con una llamada a la acción (ofrecer una auditoría gratuita).\n\n` +
    `Restricciones: máximo 90 palabras, un solo párrafo, sin saludos genéricos largos, ` +
    `sin listas, sin emojis excesivos. Devuelve SOLO el mensaje, sin comillas ni encabezados.`;

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.85, maxOutputTokens: 220 },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      // Degradar a plantilla en caso de error de la API.
      return json(200, {
        mensaje: mensajePlantilla(negocio, issues),
        fuente: 'plantilla',
        aviso: `Gemini respondió ${resp.status}: ${errText.slice(0, 200)}`,
      });
    }

    const data = await resp.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!texto) {
      return json(200, { mensaje: mensajePlantilla(negocio, issues), fuente: 'plantilla' });
    }
    return json(200, { mensaje: texto, fuente: 'gemini' });
  } catch (err) {
    return json(200, {
      mensaje: mensajePlantilla(negocio, issues),
      fuente: 'plantilla',
      aviso: String(err),
    });
  }
};
