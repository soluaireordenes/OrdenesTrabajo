/* ══════════════════════════════════════════════
   SERVICE WORKER — Sistema Optimizado SolucionAIRE
   Permite que la app cargue (interfaz) aunque no haya
   internet en el momento de abrirla. Los datos en vivo
   (Google Sheets/Drive) siempre intentan ir a la red
   primero; si no hay conexión, el propio sistema guarda
   los cambios en localStorage y los sincroniza solo
   cuando vuelva la señal.

   La interfaz (index.html y el resto del app shell) usa
   "caché primero, actualiza en segundo plano": la app abre
   al instante con lo último guardado, y de una vez se pide
   la versión más nueva por red para que la SIGUIENTE apertura
   ya quede al día — así en celulares con datos lentos no toca
   esperar la descarga completa (~1 MB) cada vez que se abre.
═══════════════════════════════════════════════ */

// Sube este número cada vez que publiques una actualización del sistema,
// así los navegadores descartan el caché viejo y traen la versión nueva.
const CACHE_VERSION = 'v4';
const CACHE_NAME = 'solucionaire-shell-' + CACHE_VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './favicon.png',
];

// ── Instalación: guarda en caché la interfaz de la app ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activación: borra cachés de versiones viejas ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(
        nombres
          .filter((n) => n.startsWith('solucionaire-shell-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Peticiones de red ──
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Nunca interceptar llamadas a Google (Sheets, Drive, OAuth, Apps Script):
  // esas SIEMPRE deben ir directo a la red para traer datos en vivo.
  // Si fallan por falta de internet, el propio index.html ya las maneja
  // guardando en localStorage y reintentando cuando vuelva la conexión.
  if (
    url.includes('googleapis.com') ||
    url.includes('google.com') ||
    url.includes('script.google.com') ||
    url.includes('accounts.google.com')
  ) {
    return; // deja pasar la petición sin tocarla
  }

  // Solo nos interesa cachear peticiones del mismo sitio (la app en sí)
  if (event.request.method !== 'GET' || !url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    // Caché primero (respuesta instantánea); en paralelo se pide la red
    // para refrescar el caché de cara a la próxima apertura. Si no hay
    // nada en caché (primera visita), sí se espera la red.
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cacheada) => {
        const actualizarDesdeRed = fetch(event.request)
          .then((respuesta) => {
            cache.put(event.request, respuesta.clone());
            return respuesta;
          })
          .catch(() => null);

        if (cacheada) {
          actualizarDesdeRed; // en segundo plano, no bloquea la respuesta
          return cacheada;
        }
        return actualizarDesdeRed.then((respuesta) => respuesta || caches.match('./index.html'));
      })
    )
  );
});
