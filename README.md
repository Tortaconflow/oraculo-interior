# Oráculo Interior 🌌 + Sabueso Digital AI 🐾

Este repositorio contiene dos aplicaciones web estáticas que comparten el mismo
despliegue en Netlify (frontend estático + funciones serverless):

| App | Archivo | Descripción |
|-----|---------|-------------|
| **El Oráculo Interior** | [`index.html`](index.html) | Viaje filosófico interactivo guiado por IA. |
| **Sabueso Digital AI** | [`sabueso.html`](sabueso.html) | Agente autónomo de prospección comercial / generación de leads. |

---

## 🐾 Sabueso Digital AI

Agente experto en generación de leads para agencias digitales, consultores web,
desarrolladores y especialistas SEO. Identifica negocios locales que necesitan
mejorar su presencia digital y genera oportunidades comerciales calificadas.

### Flujo de trabajo (6 fases)

1. **Descubrimiento** — Busca negocios por categoría + ubicación usando la
   **Google Places API (New)** (`netlify/functions/discover.js`).
2. **Recolección de información** — Nombre, categoría, sitio web, teléfono,
   dirección, calificación y número de reseñas. El email se extrae del sitio en
   la fase de auditoría.
3. **Auditoría automática del sitio web** — Descarga el HTML público de cada
   sitio y aplica heurísticas reales (`netlify/functions/audit.js`):
   - **Diseño/UX:** uso de encabezados, estructura.
   - **Móvil:** meta `viewport` (responsive).
   - **Rendimiento:** tiempo de carga, peso del HTML, imágenes sin `lazy-load`.
   - **Conversión:** CTA, WhatsApp, formularios, visibilidad de contacto.
   - **SEO:** `<title>`, meta descripción, `<h1>`, señales de SEO local.
   - **Confianza:** HTTPS, testimonios/reseñas, año de copyright.
4. **Calificación** — Puntúa de 0 a 100 (mayor = mayor oportunidad) ponderando
   problemas detectados + potencial económico (reseñas/reputación). Clasifica en
   **Crítica (90-100)**, **Alta (70-89)**, **Media (50-69)**, **Baja (0-49)**.
5. **Propuesta personalizada** — Genera un mensaje de prospección único por
   negocio con **Gemini** (`netlify/functions/proposal.js`); si no hay clave de
   Gemini, usa una plantilla para no romper el flujo.
6. **Entrega de resultados** — Tabla priorizada ordenable + exportación a
   **CSV** con todas las columnas (nombre, categoría, ubicación, web, email,
   teléfono, WhatsApp, puntuación, problemas, prioridad y mensaje).

### Arquitectura

```
sabueso.html ──► js/sabueso.js  (orquesta las 6 fases en el navegador)
                      │
       ┌──────────────┼───────────────────┐
       ▼              ▼                     ▼
 /discover        /audit               /proposal
 (Places API)  (fetch + heurísticas)   (Gemini)
```

El frontend audita los sitios en paralelo (concurrencia limitada) y muestra el
progreso fase por fase.

### Configuración de claves de API

Las funciones leen las claves desde variables de entorno (recomendado en
producción) o desde la interfaz (se guardan sólo en `localStorage`):

| Variable de entorno | Uso |
|---------------------|-----|
| `GOOGLE_PLACES_API_KEY` | **Requerida** para el descubrimiento de negocios. Habilita "Places API (New)" en Google Cloud. |
| `GEMINI_API_KEY` | Opcional. Mensajes de prospección con IA; sin ella se usa plantilla. |

En Netlify: **Site settings → Environment variables**.

### Desarrollo local

```bash
npm install -g netlify-cli
netlify dev          # sirve el sitio + las funciones en /.netlify/functions
```

Luego abre `http://localhost:8888/sabueso.html`.

### ⚖️ Uso responsable

Esta herramienta es para prospección comercial **B2B legítima**. Respeta las
leyes de protección de datos y anti-spam aplicables (LFPDPPP en México, GDPR en
la UE, etc.), verifica los datos antes de contactar y honra las solicitudes de
no contacto. La auditoría sólo analiza HTML servido públicamente.
