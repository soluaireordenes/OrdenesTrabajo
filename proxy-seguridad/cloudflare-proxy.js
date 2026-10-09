/* ══════════════════════════════════════════════════════════════════════
   PROXY DE SEGURIDAD (Cloudflare Worker) — Sistema SolucionAIRE
   ────────────────────────────────────────────────────────────────────────
   Qué hace y por qué existe
   -------------------------
   Hoy el navegador recibe un token de Google y habla DIRECTO con Google
   Sheets para todo. Eso deja el token poderoso en el navegador y hace
   imposible imponer roles de verdad. Este Worker se pone EN EL MEDIO:

       Navegador  →  ESTE WORKER (secretos + roles)  →  Google Sheets

   - El navegador ya NO recibe token de Google. Solo recibe un "pase de
     sesión" firmado por el Worker, con su rol (operario/admin).
   - El Worker guarda la CUENTA DE SERVICIO de Google (secreto) y con ella
     lee/escribe las hojas. El token de Google nunca baja al navegador.
   - Antes de cada operación, el Worker revisa el pase y el rol:
       • Borrar filas/hojas, tocar la hoja "Usuarios" o rangos "Config!"
         → SOLO admin.
       • Leer y escribir normal (órdenes, inventario, cronograma) → cualquier
         sesión válida.

   Endpoints
   ---------
   • POST /login            body {documento, pin}
         → {ok:true, session, nombre, rol}  |  {ok:false, mensaje}
   • /sheets/v4/spreadsheets/...   (mismo path/cuerpo que la API de Google)
         Requiere header  Authorization: Bearer <session>
         El Worker valida sesión + rol, mete el token de la cuenta de
         servicio y reenvía a Google. Devuelve la respuesta tal cual.
   • GET  /foto?id=<driveFileId>   (requiere Authorization: Bearer <session>)
         Devuelve la foto directo desde Google Drive con la cuenta de servicio.
   • GET  /ping             → {ok:true} (para probar que está arriba)

   ── VARIABLES Y SECRETOS DEL WORKER (Configuración → Variables y secretos) ──
   Secretos (tipo "Secreto"):
     • GOOGLE_SA_EMAIL        → client_email del JSON de la cuenta de servicio
     • GOOGLE_SA_PRIVATE_KEY  → private_key del JSON (pega el valor COMPLETO,
                                 incluido -----BEGIN PRIVATE KEY----- ...).
     • SESSION_SECRET         → una frase larga y aleatoria (firma los pases)
   Variables (tipo "Texto"):
     • USUARIOS_SHEET_ID      → ID de la hoja de cálculo que tiene la pestaña
                                 "Usuarios" (la del login)
     • USUARIOS_TAB           → (opcional) nombre de la pestaña; por defecto
                                 "Usuarios"
     • ALLOWED_ORIGIN         → https://soluaireordenes.github.io
     • ALLOWED_SHEETS         → (opcional) lista de IDs de hojas permitidas,
                                 separados por coma. Si se deja vacío, se
                                 permiten todas las hojas que la cuenta de
                                 servicio pueda abrir.
   ═══════════════════════════════════════════════════════════════════════ */

const GOOGLE_SHEETS_BASE = 'https://sheets.googleapis.com';
const SESSION_TTL_SEG = 12 * 60 * 60; // el pase de sesión dura 12 horas

// Token de la cuenta de servicio, cacheado entre peticiones del mismo isolate.
let _saToken = null;      // { access_token, exp (epoch seg) }

// Bloqueo por intentos fallidos (anti fuerza bruta), igual que el login
// original: 5 fallos → bloqueo 15 min. Nota: este conteo vive en memoria del
// isolate (no es 100% durable entre reinicios/instancias de Cloudflare); para
// un bloqueo totalmente persistente se migraría a Cloudflare KV más adelante.
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const _intentos = new Map(); // documento -> { intentos, bloqueadoHasta }

export default {
  async fetch(peticion, entorno) {
    const url = new URL(peticion.url);
    const origen = peticion.headers.get('Origin') || '';

    // CORS: responder el preflight y permitir solo el origen del sistema.
    if (peticion.method === 'OPTIONS') {
      return _cors(new Response(null, { status: 204 }), entorno, origen);
    }

    try {
      if (url.pathname === '/ping') {
        return _cors(_json({ ok: true }), entorno, origen);
      }

      if (url.pathname === '/login' && peticion.method === 'POST') {
        return _cors(await _login(peticion, entorno), entorno, origen);
      }

      if (url.pathname.startsWith('/sheets/')) {
        return _cors(await _gatewaySheets(peticion, entorno, url), entorno, origen);
      }

      if (url.pathname === '/foto' && peticion.method === 'GET') {
        return _cors(await _foto(peticion, entorno, url), entorno, origen);
      }

      return _cors(_json({ ok: false, mensaje: 'Ruta no encontrada.' }, 404), entorno, origen);
    } catch (err) {
      return _cors(_json({ ok: false, mensaje: 'Error del proxy: ' + err.message }, 500), entorno, origen);
    }
  },
};

/* ── LOGIN ─────────────────────────────────────────────────────────────
   Valida documento + PIN contra la pestaña "Usuarios" y devuelve un pase
   de sesión firmado con el rol. Las columnas se detectan por su encabezado
   (no por posición), así que no importa el orden exacto. */
async function _login(peticion, entorno) {
  let cuerpo;
  try { cuerpo = await peticion.json(); } catch { return _json({ ok: false, mensaje: 'Body inválido.' }, 400); }

  const documento = String(cuerpo.documento || '').trim();
  const pin = String(cuerpo.pin || '').trim();
  if (!documento || !pin) return _json({ ok: false, mensaje: 'Falta documento o PIN.' }, 400);

  // Bloqueo por intentos fallidos (anti fuerza bruta).
  const minBloqueo = _revisarBloqueo(documento);
  if (minBloqueo > 0) return _json({ ok: false, mensaje: `Demasiados intentos. Intenta de nuevo en ${minBloqueo} minuto(s).` }, 429);

  const sheetId = entorno.USUARIOS_SHEET_ID;
  if (!sheetId) return _json({ ok: false, mensaje: 'Falta configurar USUARIOS_SHEET_ID en el Worker.' }, 500);
  const tab = entorno.USUARIOS_TAB || 'Usuarios';

  const token = await _tokenCuentaServicio(entorno);
  const rango = encodeURIComponent(tab + '!A1:Z100000');
  const resp = await fetch(`${GOOGLE_SHEETS_BASE}/v4/spreadsheets/${sheetId}/values/${rango}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!resp.ok) {
    const t = await resp.text();
    return _json({ ok: false, mensaje: 'No se pudo leer la hoja Usuarios: ' + t }, 502);
  }
  const datos = (await resp.json()).values || [];
  if (datos.length < 2) return _json({ ok: false, mensaje: 'La hoja Usuarios está vacía.' }, 500);

  // Mapear columnas por encabezado (acepta sinónimos comunes).
  const enc = datos[0].map(h => String(h || '').trim().toLowerCase());
  const idxDoc = _buscarCol(enc, ['documento', 'cedula', 'cédula', 'identificacion', 'identificación', 'usuario']);
  const idxPin = _buscarCol(enc, ['pinhash', 'pin hash', 'hash', 'pin', 'clave', 'contraseña', 'contrasena', 'password']);
  const idxNom = _buscarCol(enc, ['nombre', 'nombres', 'nombre completo']);
  const idxRol = _buscarCol(enc, ['rol', 'perfil', 'tipo']);
  const idxAct = _buscarCol(enc, ['activo', 'estado', 'habilitado']);
  const idxSede = _buscarCol(enc, ['sede', 'operacion', 'operación']);

  if (idxDoc < 0 || idxPin < 0) {
    return _json({ ok: false, mensaje: 'La hoja Usuarios debe tener columnas de documento y PIN.' }, 500);
  }

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const docFila = String(fila[idxDoc] || '').trim();
    if (docFila !== documento) continue;

    // Usuario inactivo/deshabilitado no entra.
    if (idxAct >= 0) {
      const estado = String(fila[idxAct] || '').trim().toLowerCase();
      if (estado === 'no' || estado === 'inactivo' || estado === 'false' || estado === '0' || estado === 'deshabilitado') {
        return _json({ ok: false, mensaje: 'Usuario inactivo.' }, 403);
      }
    }

    // El PIN se guarda como hash SHA-256 (hex mayúsculas), igual que el
    // Apps Script de login original. Se compara hash contra hash.
    const pinHash = await _sha256HexUpper(pin);
    const pinGuardado = String(fila[idxPin] || '').trim().toUpperCase();
    if (pinHash !== pinGuardado) {
      _registrarFallo(documento);
      return _json({ ok: false, mensaje: 'Documento o PIN incorrecto.' }, 401);
    }

    _limpiarFallos(documento);
    const nombre = idxNom >= 0 ? String(fila[idxNom] || '').trim() : documento;
    const sede = idxSede >= 0 ? String(fila[idxSede] || '').trim().toLowerCase() : '';
    let rol = idxRol >= 0 ? String(fila[idxRol] || '').trim().toLowerCase() : 'operario';
    if (rol !== 'admin') rol = 'operario'; // cualquier valor que no sea admin = operario

    const session = await _firmarSesion({ doc: documento, nombre, rol, sede }, entorno);
    return _json({ ok: true, session, nombre, rol, sede });
  }

  _registrarFallo(documento);
  return _json({ ok: false, mensaje: 'Documento o PIN incorrecto.' }, 401);
}

/* ── FOTOS DESDE DRIVE ──────────────────────────────────────────────────
   GET /foto?id=<driveFileId>  (con el pase de sesión en Authorization)
   Devuelve la imagen directo desde Google Drive usando la cuenta de
   servicio. Reemplaza la lectura de fotos por el Apps Script, cuya
   respuesta pasa por script.googleusercontent.com y en Workspace a veces
   no llega ("No se pudo abrir el archivo en este momento").
   Requiere: la API de Google Drive habilitada en el proyecto de la cuenta
   de servicio, y la carpeta de fotos compartida (Lector) con esa cuenta. */
async function _foto(peticion, entorno, url) {
  const sesion = await _sesionDeLaPeticion(peticion, entorno);
  if (!sesion) return _json({ ok: false, mensaje: 'Sesión inválida o vencida. Vuelve a iniciar sesión.' }, 401);

  const id = String(url.searchParams.get('id') || '');
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return _json({ ok: false, mensaje: 'id de foto inválido.' }, 400);

  const token = await _tokenCuentaServicio(entorno);
  const respDrive = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!respDrive.ok) {
    const detalle = (await respDrive.text()).slice(0, 300);
    return _json({ ok: false, mensaje: 'Drive respondió ' + respDrive.status, detalle }, respDrive.status === 404 ? 404 : 502);
  }
  // Una foto nunca cambia (mismo id = misma imagen): el navegador puede
  // guardarla en caché mucho tiempo y no volver a pedirla.
  return new Response(respDrive.body, {
    status: 200,
    headers: {
      'Content-Type': respDrive.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

/* ── GATEWAY A GOOGLE SHEETS ────────────────────────────────────────────
   Reenvía a la API de Google cualquier ruta /sheets/v4/spreadsheets/...
   igual que si el navegador hablara directo, pero: valida el pase de
   sesión, revisa el rol para operaciones sensibles, y reemplaza la
   autorización por el token de la cuenta de servicio. */
async function _gatewaySheets(peticion, entorno, url) {
  const sesion = await _sesionDeLaPeticion(peticion, entorno);
  if (!sesion) return _json({ ok: false, mensaje: 'Sesión inválida o vencida. Vuelve a iniciar sesión.' }, 401);

  // Ruta destino en Google: todo lo que venga después de /sheets
  const rutaGoogle = url.pathname.replace(/^\/sheets/, '') + url.search;
  const spreadsheetId = (rutaGoogle.match(/\/v4\/spreadsheets\/([^/:?]+)/) || [])[1] || '';

  // Restringir a las hojas permitidas (si se definió la lista).
  const permitidas = String(entorno.ALLOWED_SHEETS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (permitidas.length && !permitidas.includes(spreadsheetId)) {
    return _json({ ok: false, mensaje: 'Hoja no permitida por el proxy.' }, 403);
  }

  // Leer el cuerpo una sola vez (se usa para el chequeo de rol y para reenviar).
  const esEscritura = peticion.method !== 'GET' && peticion.method !== 'HEAD';
  const cuerpoTexto = esEscritura ? await peticion.text() : null;

  // ── Chequeo de rol para operaciones sensibles (solo admin) ──
  if (sesion.rol !== 'admin') {
    const motivo = _requiereAdmin(peticion.method, rutaGoogle, cuerpoTexto, spreadsheetId, entorno);
    if (motivo) return _json({ ok: false, mensaje: 'Esta acción es solo para administradores (' + motivo + ').' }, 403);
  }

  const token = await _tokenCuentaServicio(entorno);
  const cabeceras = { Authorization: 'Bearer ' + token };
  const ct = peticion.headers.get('Content-Type');
  if (ct) cabeceras['Content-Type'] = ct;

  // quotaUser: Google cuenta el cupo "por usuario" (60 lecturas/min) por la
  // identidad que llama. Como TODO pasa por la misma cuenta de servicio, todos
  // los técnicos compartían esos 60. Con quotaUser = documento de la sesión,
  // cada persona vuelve a tener su propio cupo (el tope del proyecto sigue).
  const destino = new URL(GOOGLE_SHEETS_BASE + rutaGoogle);
  destino.searchParams.set('quotaUser', 'u-' + String(sesion.doc || 'anon').slice(0, 30));
  const respGoogle = await fetch(destino.toString(), {
    method: peticion.method,
    headers: cabeceras,
    body: esEscritura ? cuerpoTexto : undefined,
  });

  // Reenviar la respuesta de Google tal cual (cuerpo + status).
  const texto = await respGoogle.text();
  return new Response(texto, {
    status: respGoogle.status,
    headers: { 'Content-Type': respGoogle.headers.get('Content-Type') || 'application/json' },
  });
}

/* Decide si una operación es "sensible" (solo admin). Devuelve el motivo
   (texto) si lo es, o null si cualquier sesión puede hacerla. */
function _requiereAdmin(metodo, rutaGoogle, cuerpoTexto, spreadsheetId, entorno) {
  // Escribir en la hoja de Usuarios = gestionar usuarios → admin.
  if (spreadsheetId && spreadsheetId === entorno.USUARIOS_SHEET_ID && metodo !== 'GET') {
    return 'gestión de usuarios';
  }
  // Tocar rangos "Config!" (claves de sede, etc.) → admin.
  if (metodo !== 'GET' && /Config!/i.test(decodeURIComponent(rutaGoogle))) {
    return 'configuración de sede';
  }
  // NOTA: no se bloquea deleteDimension de forma genérica. El sistema lo usa
  // internamente al EDITAR una orden (reemplaza las filas de tareas/repuestos),
  // algo que también hace un operario; distinguir "borrar una orden" de
  // "reescribir filas al editar" no es posible a este nivel. Por eso la
  // restricción de borrar/cerrar para operarios se hará ocultando esos botones
  // en la interfaz (y, más adelante, con endpoints dedicados). Del lado del
  // servidor queda protegido lo inequívoco: usuarios y configuración.
  return null;
}

/* ── SESIÓN (pase firmado con HMAC-SHA256, tipo JWT) ──────────────────── */
async function _firmarSesion(datos, entorno) {
  const ahora = Math.floor(Date.now() / 1000);
  const payload = { ...datos, iat: ahora, exp: ahora + SESSION_TTL_SEG };
  const head = _b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = _b64url(JSON.stringify(payload));
  const firma = await _hmac(head + '.' + body, entorno.SESSION_SECRET);
  return head + '.' + body + '.' + firma;
}

async function _sesionDeLaPeticion(peticion, entorno) {
  const auth = peticion.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const partes = m[1].split('.');
  if (partes.length !== 3) return null;
  const [head, body, firma] = partes;
  const esperada = await _hmac(head + '.' + body, entorno.SESSION_SECRET);
  if (!_igualSeguro(firma, esperada)) return null;
  let payload;
  try { payload = JSON.parse(_deB64url(body)); } catch { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null; // vencido
  return payload;
}

/* ── TOKEN DE LA CUENTA DE SERVICIO (JWT RS256 → OAuth) ─────────────────
   Firma un JWT con la clave privada de la cuenta de servicio y lo cambia
   por un access_token de Google. Se cachea hasta ~1 min antes de vencer. */
async function _tokenCuentaServicio(entorno) {
  const ahora = Math.floor(Date.now() / 1000);
  if (_saToken && _saToken.exp - 60 > ahora) return _saToken.access_token;

  const email = entorno.GOOGLE_SA_EMAIL;
  const clavePem = entorno.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !clavePem) throw new Error('Faltan GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY en el Worker.');

  const scope = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';
  const head = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = _b64url(JSON.stringify({
    iss: email, scope, aud: 'https://oauth2.googleapis.com/token',
    iat: ahora, exp: ahora + 3600,
  }));
  const firma = await _firmarRS256(head + '.' + claims, clavePem);
  const assertion = head + '.' + claims + '.' + firma;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(assertion),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error('No se pudo obtener token de la cuenta de servicio: ' + JSON.stringify(data));
  }
  _saToken = { access_token: data.access_token, exp: ahora + (data.expires_in || 3600) };
  return _saToken.access_token;
}

/* ── Criptografía (WebCrypto, disponible en Workers) ──────────────────── */
async function _firmarRS256(mensaje, clavePem) {
  const key = await crypto.subtle.importKey(
    'pkcs8', _pemADer(clavePem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const firma = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(mensaje));
  return _b64urlBytes(new Uint8Array(firma));
}

async function _hmac(mensaje, secreto) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secreto || ''),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const firma = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(mensaje));
  return _b64urlBytes(new Uint8Array(firma));
}

function _pemADer(pem) {
  const cuerpo = String(pem || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(cuerpo);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function _sha256HexUpper(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.toUpperCase();
}

/* ── Bloqueo por intentos fallidos ────────────────────────────────────── */
function _revisarBloqueo(documento) {
  const d = _intentos.get(documento);
  if (d && d.bloqueadoHasta && Date.now() < d.bloqueadoHasta) {
    return Math.ceil((d.bloqueadoHasta - Date.now()) / 60000);
  }
  return 0;
}
function _registrarFallo(documento) {
  let d = _intentos.get(documento) || { intentos: 0 };
  if (d.bloqueadoHasta && Date.now() >= d.bloqueadoHasta) d = { intentos: 0 };
  d.intentos = (d.intentos || 0) + 1;
  if (d.intentos >= MAX_INTENTOS) { d.bloqueadoHasta = Date.now() + BLOQUEO_MS; d.intentos = 0; }
  _intentos.set(documento, d);
}
function _limpiarFallos(documento) {
  _intentos.delete(documento);
}

/* ── Utilidades ───────────────────────────────────────────────────────── */
function _buscarCol(encabezados, posibles) {
  for (const p of posibles) {
    const i = encabezados.indexOf(p);
    if (i >= 0) return i;
  }
  return -1;
}

function _b64url(texto) {
  return _b64urlBytes(new TextEncoder().encode(texto));
}
function _b64urlBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _deB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}
function _igualSeguro(a, b) {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function _json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function _cors(resp, entorno, origen) {
  const permitido = entorno.ALLOWED_ORIGIN || '';
  // Si coincide el origen del sistema, se devuelve ese; si no, se usa el
  // configurado (para llamadas desde la propia app).
  const allow = (permitido && origen === permitido) ? origen : (permitido || '*');
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', allow);
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return new Response(resp.body, { status: resp.status, headers: h });
}
