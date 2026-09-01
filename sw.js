/* ══════════════════════════════════════════════
   SERVICE WORKER — Sistema Optimizado SolucionAIRE
   Permite que la app cargue (interfaz) aunque no haya
   internet en el momento de abrirla. Los datos en vivo
   (Google Sheets/Drive) siempre intentan ir a la red
   primero; si no hay conexión, el propio sistema guarda
   los cambios en localStorage y los sincroniza solo
   cuando vuelva la señal.

   La interfaz (index.html y el resto del app shell) usa "red con tope
   de tiempo, caché como respaldo": si la red responde rápido (lo normal
   con cualquier señal decente), se usa esa versión — así nunca se ve
   una versión vieja del sistema aunque haya cambiado hace un minuto.
   Si la red tarda más del tope, se muestra de una vez lo que haya en
   caché para que la app no se sienta "colgada" en datos móviles lentos,
   mientras la descarga real sigue en curso por detrás y deja el caché
   listo para la próxima vez.
═══════════════════════════════════════════════ */

// Sube este número cada vez que publiques una actualización del sistema,
// así los navegadores descartan el caché viejo y traen la versión nueva.
const CACHE_VERSION = 'v25';
const CACHE_NAME = 'solucionaire-shell-' + CACHE_VERSION;

// Cuánto se espera a la red antes de resignarse a mostrar el caché.
const TOPE_RED_MS = 2500;

const APP_SHELL = [
  './',
  './index.html',
  // La política de privacidad se abre desde el menú lateral, dentro de la
  // app. Va en el caché para que también se pueda leer sin señal, igual
  // que el resto de la interfaz.
  './privacidad.html',
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

// Le avisa a todas las pestañas abiertas que ya hay una versión nueva
// descargada, para que ofrezcan recargar.
async function avisarNuevaVersion() {
  const clientes = await self.clients.matchAll({ type: 'window' });
  clientes.forEach((c) => c.postMessage({ tipo: 'nueva-version' }));
}

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
    caches.open(CACHE_NAME).then(async (cache) => {
      // La red SIEMPRE se pide y SIEMPRE actualiza el caché al responder,
      // así la próxima vez que toque usar el caché ya está al día.
      //
      // El HTML se pide con cache:'reload' para SALTARSE la caché HTTP del
      // navegador. Sin eso, "ir a la red" era mentira a medias: GitHub
      // Pages sirve el HTML con Cache-Control: max-age=600, así que el
      // navegador podía devolver una copia de hasta 10 MINUTOS sin
      // consultar al servidor — y el sistema se veía viejo un buen rato
      // después de publicar una actualización. Los iconos y el manifest
      // sí pueden seguir usando la caché normal: casi nunca cambian.
      const esDocumento = event.request.mode === 'navigate'
        || event.request.destination === 'document'
        || url.endsWith('/') || url.endsWith('/index.html');

      // Guardamos la versión que ya teníamos ANTES de pedir la red, para
      // poder comparar si lo que llegó es una versión distinta.
      const cacheada = await cache.match(event.request);
      const etiquetaVieja = cacheada && (cacheada.headers.get('etag') || cacheada.headers.get('last-modified'));
      let seSirvioElCache = false;

      const peticionRed = (esDocumento
          ? fetch(event.request.url, { cache: 'reload', credentials: 'same-origin' })
          : fetch(event.request))
        .then((respuesta) => {
          cache.put(event.request, respuesta.clone());
          // En datos móviles el HTML (más de 1 MB) casi siempre pierde la
          // carrera contra el tope, así que el operario termina viendo la
          // versión guardada. Cuando la descarga real llega y resulta ser
          // OTRA versión, le avisamos a la app para que ofrezca recargar —
          // si no, el celular se queda con el sistema viejo sin que nadie
          // se entere.
          const etiquetaNueva = respuesta.headers.get('etag') || respuesta.headers.get('last-modified');
          if (esDocumento && seSirvioElCache && etiquetaVieja && etiquetaNueva && etiquetaNueva !== etiquetaVieja) {
            avisarNuevaVersion();
          }
          return respuesta;
        })
        .catch(() => null);

      // Si la red responde antes del tope, se usa esa (siempre la versión
      // más reciente). Si no, se muestra el caché sin seguir esperando.
      const tope = new Promise((resolve) => setTimeout(() => resolve(undefined), TOPE_RED_MS));
      const primeraEnResponder = await Promise.race([peticionRed, tope]);
      if (primeraEnResponder) return primeraEnResponder;

      if (cacheada) { seSirvioElCache = true; return cacheada; }

      // Sin caché tampoco (primera visita con red lenta): esperar la red.
      return (await peticionRed) || caches.match('./index.html');
    })
  );
});
