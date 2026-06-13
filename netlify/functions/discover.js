// netlify/functions/discover.js
//
// Fase 1 + 2 del Sabueso Digital: Descubrimiento de negocios y recolección de
// información básica usando la Places API (New) de Google.
//
// Devuelve una lista de negocios con: nombre, categoría, sitio web, teléfono,
// dirección, calificación, número de reseñas y enlace a Google Maps.
//
// La API key se toma (en este orden) de:
//   1. El cuerpo de la petición (campo placesApiKey) — útil para pruebas.
//   2. La variable de entorno GOOGLE_PLACES_API_KEY (recomendado en producción).
//
// El email NO lo entrega Google Places; se intenta extraer del sitio web en la
// fase de auditoría (audit.js).

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.primaryTypeDisplayName',
  'places.primaryType',
  'places.googleMapsUri',
].join(',');

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido.' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Cuerpo de la petición inválido.' });
  }

  const { categoria, ubicacion, maxResultados } = payload;
  const apiKey = payload.placesApiKey || process.env.GOOGLE_PLACES_API_KEY;

  if (!categoria || !ubicacion) {
    return json(400, { error: 'Faltan los campos "categoria" y/o "ubicacion".' });
  }
  if (!apiKey) {
    return json(400, {
      error:
        'No se encontró una API key de Google Places. Configura GOOGLE_PLACES_API_KEY en Netlify o ingrésala en la interfaz.',
      code: 'NO_PLACES_KEY',
    });
  }

  const textQuery = `${categoria} en ${ubicacion}`;
  const maxCount = Math.min(Math.max(parseInt(maxResultados, 10) || 20, 1), 20);

  try {
    const resp = await fetch(PLACES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery,
        languageCode: 'es',
        maxResultCount: maxCount,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json(resp.status, {
        error: `Google Places respondió con un error (${resp.status}).`,
        detail: errText.slice(0, 500),
      });
    }

    const data = await resp.json();
    const negocios = (data.places || []).map((p) => ({
      placeId: p.id || null,
      nombre: p.displayName?.text || 'Sin nombre',
      categoria: p.primaryTypeDisplayName?.text || p.primaryType || categoria,
      sitioWeb: p.websiteUri || '',
      telefono: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
      direccion: p.formattedAddress || '',
      calificacion: typeof p.rating === 'number' ? p.rating : null,
      numResenas: typeof p.userRatingCount === 'number' ? p.userRatingCount : 0,
      googleMapsUri: p.googleMapsUri || '',
    }));

    return json(200, { query: textQuery, total: negocios.length, negocios });
  } catch (err) {
    return json(502, { error: 'Fallo al consultar Google Places.', detail: String(err) });
  }
};
