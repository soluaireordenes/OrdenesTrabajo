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
       • Un admin puede todo.
       • Un operario solo puede lo que la app usa (lista blanca, ver
         _motivoNoPermitido): leer, escribir y anexar rangos con su pestaña,
         agregar pestañas y borrar filas de datos. Nunca la hoja Usuarios,
         la de Proyectos (HOJAS_SOLO_ADMIN), las pestañas de personal
         "Operarios" y "ObservacionesOperarios", ni "Config" (salvo su celda
         B1, el candado del inventario).
       • Cada petición se cruza con la hoja Usuarios (releída cada 5 min):
         quien quede inactivo o borrado pierde el acceso, y un cambio de
         rol aplica sin esperar a que venza el pase.

   Endpoints
   ---------
   • POST /login            body {documento, pin}
         → {ok:true, session, nombre, rol}  |  {ok:false, mensaje}
         Con un PIN de menos de 6 números trae además cambiarPin:true y un
         pase que solo sirve para POST /cambiar-pin.
   • POST /cambiar-pin      body {pinActual, pinNuevo}  (con el pase)
         → {ok:true, session} con un pase normal. PIN de 6 a 8 números, que
         no sea repetido, seguido ni parte del documento.
   • /sheets/v4/spreadsheets/...   (mismo path/cuerpo que la API de Google)
         Requiere header  Authorization: Bearer <session>
         y, para un operario, X-Pase-Sede: <pase de sede> (lo da /sede):
         solo abre las hojas de la sede cuya clave escribió.
         El Worker valida sesión + rol, mete el token de la cuenta de
         servicio y reenvía a Google. Devuelve la respuesta tal cual.
   • POST /sede             body {spreadsheetId, clave}   (con el pase)
         → {ok:true, paseSede} si la clave coincide con el hash de Config!A1
         de esa hoja. El hash nunca sale del Worker; hay bloqueo por intentos.
   • GET  /pase-fotos       (con el pase) → {ok, pase, exp} para los scripts
         de fotos de cada sede.
   • GET  /foto?id=<driveFileId>   (requiere Authorization: Bearer <session>)
         Devuelve la foto directo desde Google Drive con la cuenta de servicio.
   • GET  /ping             → {ok:true} (para probar que está arriba)

   ── VARIABLES Y SECRETOS DEL WORKER (Configuración → Variables y secretos) ──
   Secretos (tipo "Secreto"):
     • PIN_PEPPER             → frase larga y aleatoria con la que se guardan
                                 los PIN (ver _pinCoincide). NO se puede
                                 cambiar ni perder una vez en uso.
     • FOTOS_SECRETO          → frase larga y aleatoria que firma el pase de
                                 fotos; la MISMA va en las Propiedades de cada
                                 script de fotos (fotos-apps-script.gs).
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
     • BLOQUEOS               → (opcional, recomendado) no es una variable:
                                 es un "Espacio de nombres KV" enlazado con ese
                                 nombre (Configuración → Enlaces → Agregar →
                                 Espacio de nombres KV). Guarda los intentos
                                 fallidos para que el bloqueo valga en todas
                                 las copias del Worker. Sin él, el conteo queda
                                 en la memoria de cada copia.
     • ALLOWED_SHEETS         → (opcional) lista de IDs de hojas permitidas,
                                 separados por coma. Si se deja vacío, se
                                 permiten todas las hojas que la cuenta de
                                 servicio pueda abrir.
   ═══════════════════════════════════════════════════════════════════════ */

const GOOGLE_SHEETS_BASE = 'https://sheets.googleapis.com';

// Hojas de cálculo que SOLO un admin puede abrir (ni leer ni escribir).
// Proyectos: contratos, valores por alcance, calendario de pagos y montos.
const HOJAS_SOLO_ADMIN = [
  '1rICqEwDTOjA8cxFIEa7m5rIw0gs2fd7CB682dRUj0nk', // Proyectos (panel gerencial)
];
const SESSION_TTL_SEG = 12 * 60 * 60; // el pase de sesión dura 12 horas

// Las hojas de cada sede: [órdenes, inventario], las mismas de index.html
// (OPERACIONES e INVENTARIO_SHEETS; una prueba revisa que coincidan). Un
// operario solo abre las de la sede cuya clave escribió (ver _sede y
// _hojasDelPaseSede); antes la clave la pedía solo la app, y con un pase de
// sesión se podía leer y escribir en cualquier sede pidiéndole al proxy.
const SEDES_HOJAS = [
  ['1_gIoYzZIZeURojSemB5vTtSQ1k4vw4_YfN-G6AjtaYU', '1cqfk7gKRX4MfnHnPEZy7WGOunwT7kYLfJ14_W10Wh3s'], // Zipaquirá
  ['1xM4UFaV1fZ5bEYVVNx55UjbPN9CldQ6ObaZl0EGlF8A', '14yHP8GGumzc6c4CfAlLjTtnqJoWU8ATfQ3d1DAAafUk'], // Zipaquirá 2
  ['1Dv4veJWQPP2tZkYXRXLPo0MQmu8cR843TBO3D0uChP8', '1WpunyOSCJDDoIHgz-JKmJ_uNkHCloCQtIM36lm1RWdk'], // Soacha
  ['1cqMzlHEBbzKy9d_GDkVTVarvzL0Es2J1_bSXeKpkHYs', '1Dj12a7g7s25A6bTb-oR54-FQY9qs0ffFHDtNq64q4fk'], // Antioquia
  ['13kf6xZPfdnxDJmCyKJ0q-1z7ijRak7oMNhzemzq2KpI', '1TEwFSN-p-XcPiKHqiv-dqp8B2eefB-0Ecui5KcFU_VI'], // México
  ['1UbN_mnzJZBxpaL0mZqE-z0U_CIA-MbGwPiokpmKRjvI', '15LoJbWh1aB2cJLLRDLTadbFjeU-U7nFW54K7eM5M6Fc'], // Perú
];
const PASE_SEDE_TTL_SEG = 7 * 24 * 60 * 60; // dura más que la sesión: volver a entrar no pide otra vez la clave

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

      if (url.pathname === '/pase-fotos' && peticion.method === 'GET') {
        return _cors(await _paseFotos(peticion, entorno), entorno, origen);
      }

      if (url.pathname === '/sede' && peticion.method === 'POST') {
        return _cors(await _sede(peticion, entorno), entorno, origen);
      }

      if (url.pathname === '/foto' && peticion.method === 'GET') {
        return _cors(await _foto(peticion, entorno, url), entorno, origen);
      }

      if (url.pathname === '/cambiar-pin' && peticion.method === 'POST') {
        return _cors(await _cambiarPin(peticion, entorno), entorno, origen);
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

  // Bloqueo por intentos fallidos (anti fuerza bruta): por documento, y por
  // conexión para quien prueba un mismo PIN contra muchos documentos.
  const ip = peticion.headers.get('CF-Connecting-IP') || '';
  const minIp = _revisarBloqueoIp(ip);
  if (minIp > 0) return _json({ ok: false, mensaje: `Demasiados intentos desde esta conexión. Intenta de nuevo en ${minIp} minuto(s).` }, 429);
  const minBloqueo = await _revisarBloqueo(documento, entorno);
  if (minBloqueo > 0) return _json({ ok: false, mensaje: `Demasiados intentos. Intenta de nuevo en ${minBloqueo} minuto(s).` }, 429);

  if (!entorno.USUARIOS_SHEET_ID) return _json({ ok: false, mensaje: 'Falta configurar USUARIOS_SHEET_ID en el Worker.' }, 500);

  let usuarios;
  try {
    usuarios = await _leerUsuarios(entorno);
  } catch (err) {
    return _json({ ok: false, mensaje: err.message }, err.status || 502);
  }

  // Un documento que no existe y un PIN equivocado responden igual (y
  // tardan lo mismo): así no se puede averiguar qué documentos están
  // registrados. Que la persona está inactiva solo se le dice a quien
  // escribió el PIN correcto.
  const u = usuarios.get(documento);
  let pinBien = false;
  if (u) pinBien = await _pinCoincide(pin, documento, u.pinHash, entorno);
  else await _firmaPinV2(pin, documento, '0', entorno.PIN_PEPPER || 'x'); // el mismo trabajo que un PIN equivocado
  if (!pinBien) {
    await _registrarFallo(documento, entorno);
    _registrarFalloIp(ip, documento);
    return _json({ ok: false, mensaje: 'Documento o PIN incorrecto.' }, 401);
  }
  // Usuario inactivo/deshabilitado no entra.
  if (!u.activo) return _json({ ok: false, mensaje: 'Usuario inactivo.' }, 403);
  // PIN todavía en el formato viejo: se pasa al nuevo ahora que se conoce.
  if (entorno.PIN_PEPPER && !/^v2\$/i.test(u.pinHash)) await _guardarPinV2(entorno, u, documento, pin);

  await _limpiarFallos(documento, entorno);
  // PIN de menos de 6 números: entra, pero con un pase que solo sirve para
  // crear el PIN nuevo (ver _cambiarPin); nada más funciona hasta entonces.
  if (pin.length < PIN_MINIMO) {
    const session = await _firmarSesion({ doc: documento, nombre: u.nombre, rol: u.rol, sede: u.sede, cp: true }, entorno, 60 * 60);
    return _json({ ok: true, session, nombre: u.nombre, rol: u.rol, sede: u.sede, cambiarPin: true });
  }
  const session = await _firmarSesion({ doc: documento, nombre: u.nombre, rol: u.rol, sede: u.sede }, entorno);
  return _json({ ok: true, session, nombre: u.nombre, rol: u.rol, sede: u.sede });
}

/* ── CAMBIAR EL PIN ─────────────────────────────────────────────────────
   POST /cambiar-pin  body {pinActual, pinNuevo}  (con el pase de sesión)
   Un PIN de 4 números se adivina probando (son 10.000); uno de 6 son un
   millón. Quien entra con un PIN corto tiene que crear uno nuevo antes de
   seguir, y así además cada persona termina con el suyo (a los nuevos se
   les da uno provisional). El PIN nuevo se guarda en su celda de la hoja
   Usuarios en el formato con clave secreta (PIN_PEPPER). */
const PIN_MINIMO = 6;

function _motivoPinDebil(pin, documento, actual) {
  if (!/^\d{6,8}$/.test(pin)) return 'El PIN nuevo debe tener de 6 a 8 números.';
  if (pin === actual) return 'El PIN nuevo tiene que ser distinto al actual.';
  if (/^(\d)\1+$/.test(pin)) return 'Ese PIN es muy fácil de adivinar: no repitas el mismo número.';
  const subiendo = '01234567890123456789', bajando = '98765432109876543210';
  if (subiendo.includes(pin) || bajando.includes(pin)) return 'Ese PIN es muy fácil de adivinar: no uses números seguidos.';
  if (String(documento || '').includes(pin)) return 'No uses números de tu documento en el PIN.';
  return null;
}

async function _cambiarPin(peticion, entorno) {
  const sesion = await _sesionVigente(peticion, entorno);
  if (!sesion) return _json({ ok: false, mensaje: 'Sesión inválida o vencida. Vuelve a iniciar sesión.' }, 401);
  let cuerpo;
  try { cuerpo = await peticion.json(); } catch { return _json({ ok: false, mensaje: 'Body inválido.' }, 400); }
  const actual = String(cuerpo.pinActual || '').trim();
  const nuevo = String(cuerpo.pinNuevo || '').trim();
  const doc = String(sesion.doc || '');

  const minBloqueo = await _revisarBloqueo(doc, entorno);
  if (minBloqueo > 0) return _json({ ok: false, mensaje: `Demasiados intentos. Intenta de nuevo en ${minBloqueo} minuto(s).` }, 429);

  let usuarios;
  try { usuarios = await _leerUsuarios(entorno); } catch (err) { return _json({ ok: false, mensaje: err.message }, err.status || 502); }
  const u = usuarios.get(doc);
  if (!u || !u.activo) return _json({ ok: false, mensaje: 'Sesión inválida o vencida. Vuelve a iniciar sesión.' }, 401);
  if (!(await _pinCoincide(actual, doc, u.pinHash, entorno))) {
    await _registrarFallo(doc, entorno);
    return _json({ ok: false, mensaje: 'El PIN actual no es correcto.' }, 401);
  }
  const debil = _motivoPinDebil(nuevo, doc, actual);
  if (debil) return _json({ ok: false, mensaje: debil }, 400);

  const valor = entorno.PIN_PEPPER ? await _pinV2(nuevo, doc, entorno.PIN_PEPPER) : await _sha256HexUpper(nuevo);
  if (!(await _escribirPin(entorno, u, valor))) return _json({ ok: false, mensaje: 'No se pudo guardar el PIN nuevo. Intenta de nuevo en un momento.' }, 502);
  await _limpiarFallos(doc, entorno);
  const session = await _firmarSesion({ doc, nombre: u.nombre, rol: u.rol, sede: u.sede }, entorno);
  return _json({ ok: true, session, nombre: u.nombre, rol: u.rol });
}

/* ── PIN ────────────────────────────────────────────────────────────────
   Formato viejo: SHA-256 del PIN (hex). Un PIN numérico corto se saca de
   ese resumen en segundos, así que quien viera la hoja Usuarios tenía los
   PIN de todos.
   Formato nuevo ("v2$sal$firma"): HMAC-SHA256 del PIN con PIN_PEPPER, una
   clave que solo vive en el Worker, y una sal distinta por persona. Sin esa
   clave, lo que hay en la hoja no sirve para nada.
   No hay que cambiar ningún PIN: cada persona pasa al formato nuevo la
   próxima vez que entra (el Worker escribe el valor nuevo en su celda). Un
   PIN nuevo o restablecido se puede seguir escribiendo en el formato viejo;
   también se convierte solo al entrar.
   ⚠ PIN_PEPPER no se puede cambiar ni perder: los PIN ya convertidos dejan
   de funcionar. Guárdala en un lugar seguro. */
async function _pinCoincide(pin, documento, guardado, entorno) {
  const g = String(guardado || '').trim();
  if (/^v2\$/i.test(g)) {
    if (!entorno.PIN_PEPPER) return false; // sin la clave no hay cómo comprobarlo
    const [, sal, firma] = g.split('$');
    if (!sal || !firma) return false;
    return _igualSeguro(await _firmaPinV2(pin, documento, sal.toLowerCase(), entorno.PIN_PEPPER), firma.toLowerCase());
  }
  return _igualSeguro(await _sha256HexUpper(pin), g.toUpperCase());
}

async function _firmaPinV2(pin, documento, sal, pepper) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sal + '|' + documento + '|' + pin)));
  return Array.from(mac).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Escribe el PIN en el formato nuevo en la celda de esa persona. Si no se
 *  puede (Google no responde), no pasa nada: entra igual y se intenta la
 *  próxima vez. */
async function _guardarPinV2(entorno, u, documento, pin) {
  await _escribirPin(entorno, u, await _pinV2(pin, documento, entorno.PIN_PEPPER));
}

/** El valor que se guarda en la celda, en el formato con clave secreta. */
async function _pinV2(pin, documento, pepper) {
  const salBytes = crypto.getRandomValues(new Uint8Array(16));
  const sal = Array.from(salBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'v2$' + sal + '$' + await _firmaPinV2(pin, documento, sal, pepper);
}

/** Escribe el PIN guardado en la celda de esa persona. Devuelve true si
 *  Google lo aceptó. */
async function _escribirPin(entorno, u, nuevo) {
  try {
    const tab = entorno.USUARIOS_TAB || 'Usuarios';
    const celda = "'" + tab.replace(/'/g, "''") + "'!" + _letraColumna(u.colPin) + u.fila;
    const token = await _tokenCuentaServicio(entorno);
    const resp = await fetch(`${GOOGLE_SHEETS_BASE}/v4/spreadsheets/${entorno.USUARIOS_SHEET_ID}/values/${encodeURIComponent(celda)}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[nuevo]] }),
    });
    if (resp.ok) u.pinHash = nuevo;
    return resp.ok;
  } catch (_) { return false; /* se reintenta en el próximo ingreso */ }
}

function _letraColumna(indice) {
  let n = indice + 1, letra = '';
  while (n > 0) { const r = (n - 1) % 26; letra = String.fromCharCode(65 + r) + letra; n = Math.floor((n - 1) / 26); }
  return letra;
}

/* ── PASE DE FOTOS ──────────────────────────────────────────────────────
   GET /pase-fotos (con el pase de sesión) → { ok, pase, exp }
   Los scripts de fotos de cada sede (fotos-apps-script.gs) solo atienden
   peticiones que traen este pase, firmado con FOTOS_SECRETO (la misma
   clave va en las Propiedades de cada script). Así nadie de afuera puede
   leer, subir ni borrar archivos con ellos. Dura 6 horas; la app pide
   otro cuando vence. */
async function _paseFotos(peticion, entorno) {
  const sesion = await _sesionVigente(peticion, entorno);
  if (!sesion) return _json({ ok: false, mensaje: 'Sesión inválida o vencida. Vuelve a iniciar sesión.' }, 401);
  if (sesion.cp) return _debeCambiarPin();
  if (!entorno.FOTOS_SECRETO) return _json({ ok: false, mensaje: 'Falta configurar FOTOS_SECRETO en el Worker.' }, 501);
  const exp = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  const head = _b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = _b64url(JSON.stringify({ doc: sesion.doc, rol: sesion.rol, exp }));
  const firma = await _hmac(head + '.' + body, entorno.FOTOS_SECRETO);
  return _json({ ok: true, pase: head + '.' + body + '.' + firma, exp });
}

/* ── USUARIOS: lectura y estado vigente ──────────────────────────────────
   El pase de sesión dura 12 horas y lleva el rol adentro. Sin una revisión
   aparte, desactivar a alguien o quitarle el rol de admin en la hoja no
   tenía efecto hasta que su pase venciera. Por eso cada petición compara el
   pase con lo que dice HOY la hoja Usuarios: si la persona ya no está o
   quedó inactiva, el pase deja de servir; si le cambiaron el rol, se aplica
   el rol nuevo. La hoja se relee como mucho cada 5 minutos por instancia del
   Worker (una lectura, no una por petición). */
const USUARIOS_VIGENCIA_MS = 5 * 60 * 1000;
let _usuariosCache = null;     // { leidoEn, porDoc: Map }
let _usuariosEnVuelo = null;   // una sola lectura a la vez

async function _leerUsuarios(entorno) {
  const tab = entorno.USUARIOS_TAB || 'Usuarios';
  const token = await _tokenCuentaServicio(entorno);
  const rango = encodeURIComponent(tab + '!A1:Z100000');
  const resp = await fetch(`${GOOGLE_SHEETS_BASE}/v4/spreadsheets/${entorno.USUARIOS_SHEET_ID}/values/${rango}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!resp.ok) {
    const err = new Error('No se pudo leer la hoja Usuarios (Google respondió ' + resp.status + ').');
    err.status = 502;
    throw err;
  }
  const datos = (await resp.json()).values || [];
  if (datos.length < 2) { const err = new Error('La hoja Usuarios está vacía.'); err.status = 500; throw err; }

  // Mapear columnas por encabezado (acepta sinónimos comunes).
  const enc = datos[0].map(h => String(h || '').trim().toLowerCase());
  const idxDoc = _buscarCol(enc, ['documento', 'cedula', 'cédula', 'identificacion', 'identificación', 'usuario']);
  const idxPin = _buscarCol(enc, ['pinhash', 'pin hash', 'hash', 'pin', 'clave', 'contraseña', 'contrasena', 'password']);
  const idxNom = _buscarCol(enc, ['nombre', 'nombres', 'nombre completo']);
  const idxRol = _buscarCol(enc, ['rol', 'perfil', 'tipo']);
  const idxAct = _buscarCol(enc, ['activo', 'estado', 'habilitado']);
  const idxSede = _buscarCol(enc, ['sede', 'operacion', 'operación']);
  if (idxDoc < 0 || idxPin < 0) {
    const err = new Error('La hoja Usuarios debe tener columnas de documento y PIN.'); err.status = 500; throw err;
  }

  const porDoc = new Map();
  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const doc = String(fila[idxDoc] || '').trim();
    if (!doc || porDoc.has(doc)) continue; // si se repite, manda la primera fila (como antes)
    const estado = idxAct >= 0 ? String(fila[idxAct] || '').trim().toLowerCase() : '';
    let rol = idxRol >= 0 ? String(fila[idxRol] || '').trim().toLowerCase() : 'operario';
    if (rol !== 'admin') rol = 'operario'; // cualquier valor que no sea admin = operario
    porDoc.set(doc, {
      nombre: idxNom >= 0 ? String(fila[idxNom] || '').trim() : doc,
      pinHash: String(fila[idxPin] || '').trim(),
      fila: i + 1,          // número de fila en la hoja (para actualizar el PIN)
      colPin: idxPin,
      rol,
      activo: !['no', 'inactivo', 'false', '0', 'deshabilitado'].includes(estado),
      sede: idxSede >= 0 ? String(fila[idxSede] || '').trim().toLowerCase() : '',
    });
  }
  _usuariosCache = { leidoEn: Date.now(), porDoc };
  return porDoc;
}

/** Lo que dice hoy la hoja de un documento, o undefined si ya no está.
 *  Si Google no responde, se usa la última lectura buena, y si nunca hubo
 *  una, devuelve null ("no se sabe"): una caída de Google no debe sacar a
 *  todo el mundo del sistema. */
async function _usuarioVigente(doc, entorno) {
  if (!_usuariosCache || Date.now() - _usuariosCache.leidoEn > USUARIOS_VIGENCIA_MS) {
    if (!_usuariosEnVuelo) {
      _usuariosEnVuelo = _leerUsuarios(entorno).finally(() => { _usuariosEnVuelo = null; });
    }
    try { await _usuariosEnVuelo; } catch (_) { /* se sigue con lo último que se leyó */ }
  }
  if (!_usuariosCache) return null;
  return _usuariosCache.porDoc.get(String(doc || '')) || undefined;
}

/** Respuesta para un pase que solo sirve para cambiar el PIN (cp). */
function _debeCambiarPin() {
  return _json({ ok: false, cambiarPin: true, mensaje: 'Antes de seguir, crea tu PIN nuevo de 6 números.' }, 403);
}

/** Valida el pase y lo cruza con la hoja Usuarios. Devuelve la sesión con
 *  el rol vigente, o null si el pase no sirve o la persona ya no puede
 *  entrar. */
async function _sesionVigente(peticion, entorno) {
  const sesion = await _sesionDeLaPeticion(peticion, entorno);
  if (!sesion) return null;
  const u = await _usuarioVigente(sesion.doc, entorno);
  if (u === null) return sesion;              // no se pudo comprobar: se confía en el pase
  if (!u || !u.activo) return null;           // borrado o desactivado
  return { ...sesion, rol: u.rol };           // rol de hoy, no el de cuando entró
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
  const sesion = await _sesionVigente(peticion, entorno);
  if (!sesion) return _json({ ok: false, mensaje: 'Sesión inválida o vencida. Vuelve a iniciar sesión.' }, 401);
  if (sesion.cp) return _debeCambiarPin();

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
  // Solo fotos y PDF: la cuenta de servicio puede abrir más archivos que
  // esos, y conociendo el id de cualquiera se lo llevaba quien tuviera
  // sesión. Un SVG tampoco, porque puede llevar código.
  const tipo = String(respDrive.headers.get('Content-Type') || '').toLowerCase();
  if (!_esFotoOPdf(tipo)) {
    try { await respDrive.body?.cancel(); } catch (_) { /* nada que cerrar */ }
    return _json({ ok: false, mensaje: 'Ese archivo no es una foto ni un PDF.' }, 403);
  }
  // Una foto nunca cambia (mismo id = misma imagen): el navegador puede
  // guardarla en caché mucho tiempo y no volver a pedirla.
  return new Response(respDrive.body, {
    status: 200,
    headers: {
      'Content-Type': tipo,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

function _esFotoOPdf(tipo) {
  return (/^image\//.test(tipo) && !/svg/.test(tipo)) || /^application\/pdf\b/.test(tipo);
}

/* ── GATEWAY A GOOGLE SHEETS ────────────────────────────────────────────
   Reenvía a la API de Google cualquier ruta /sheets/v4/spreadsheets/...
   igual que si el navegador hablara directo, pero: valida el pase de
   sesión, revisa el rol para operaciones sensibles, y reemplaza la
   autorización por el token de la cuenta de servicio. */
async function _gatewaySheets(peticion, entorno, url) {
  const sesion = await _sesionVigente(peticion, entorno);
  if (!sesion) return _json({ ok: false, mensaje: 'Sesión inválida o vencida. Vuelve a iniciar sesión.' }, 401);
  if (sesion.cp) return _debeCambiarPin();

  // Ruta destino en Google: todo lo que venga después de /sheets
  const rutaGoogle = url.pathname.replace(/^\/sheets/, '') + url.search;
  const spreadsheetId = (rutaGoogle.match(/\/v4\/spreadsheets\/([^/:?]+)/) || [])[1] || '';

  // Restringir a las hojas permitidas (si se definió la lista).
  const permitidas = String(entorno.ALLOWED_SHEETS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (permitidas.length && !permitidas.includes(spreadsheetId)) {
    return _json({ ok: false, mensaje: 'Hoja no permitida por el proxy.' }, 403);
  }

  // Un operario solo abre las hojas de la sede cuya clave escribió.
  if (sesion.rol !== 'admin' && !(await _hojasDelPaseSede(peticion, entorno, sesion)).includes(spreadsheetId)) {
    return _json({ ok: false, sede: true, mensaje: 'Escribe la clave de la sede para abrir sus datos.' }, 403);
  }

  // Leer el cuerpo una sola vez (se usa para el chequeo de rol y para reenviar).
  const esEscritura = peticion.method !== 'GET' && peticion.method !== 'HEAD';
  const cuerpoTexto = esEscritura ? await peticion.text() : null;

  const token = await _tokenCuentaServicio(entorno);

  // ── Chequeo de rol: un operario solo puede hacer lo que la app usa ──
  if (sesion.rol !== 'admin') {
    const motivo = await _motivoNoPermitido(peticion.method, rutaGoogle, cuerpoTexto, spreadsheetId, entorno, token);
    if (motivo) return _json({ ok: false, mensaje: 'Esta acción es solo para administradores (' + motivo + ').' }, 403);
  }

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

/* ── QUÉ PUEDE HACER UN OPERARIO ─────────────────────────────────────────
   Lista blanca: solo las operaciones que la app usa de verdad. Antes era al
   revés —se bloqueaba lo peligroso que se alcanzaba a reconocer en la
   dirección— y quedaban caminos por fuera (escrituras en lote con el rango
   en el cuerpo, ediciones estructurales que borran pestañas enteras).

     • Leer los datos de la hoja (metadatos de las pestañas), sin el
       contenido de las celdas (ver _pideCeldasEnMetadatos).
     • Leer un rango, o varios en una lectura en lote.
     • Escribir, anexar o borrar el contenido de UN rango que va en la
       dirección, o escribir varios rangos en lote (cada uno revisado),
       sin escrituras grandes (ver _motivoEscritura).
     • Edición estructural, solo para agregar una pestaña nueva o borrar
       filas de a una (nunca la de encabezados).
   Siempre con el nombre de la pestaña escrito, y nunca sobre:
     • la hoja de Usuarios ni la de Proyectos (ni para leer),
     • las pestañas de personal "Operarios" y "ObservacionesOperarios",
     • la pestaña "Config", salvo su celda B1, que es el candado del
       inventario (cada movimiento lo toma y lo suelta). La A1 guarda la
       clave de la sede, que solo se comprueba aquí, en /sede.
   Un admin puede todo. Devuelve el motivo del bloqueo, o null. */
const PESTANAS_SOLO_ADMIN = ['config', 'operarios', 'observacionesoperarios', 'usuarios'];

async function _motivoNoPermitido(metodo, rutaGoogle, cuerpoTexto, spreadsheetId, entorno, token) {
  if (!spreadsheetId) return 'operación no permitida';
  if (HOJAS_SOLO_ADMIN.includes(spreadsheetId)) return 'hoja de Proyectos';
  if (spreadsheetId === entorno.USUARIOS_SHEET_ID) return 'hoja de usuarios';

  const destino = new URL('https://x' + rutaGoogle);
  const ruta = destino.pathname;
  const base = '/v4/spreadsheets/' + spreadsheetId;

  if (ruta === base) {
    if (metodo !== 'GET') return 'operación no permitida';
    return _pideCeldasEnMetadatos(destino.searchParams) ? 'operación no permitida' : null;
  }

  if (ruta === base + '/values:batchGet') {
    if (metodo !== 'GET') return 'operación no permitida';
    const rangos = destino.searchParams.getAll('ranges');
    if (!rangos.length) return 'operación no permitida';
    for (const r of rangos) { const m = _motivoRango(r); if (m) return m; }
    return null;
  }

  // Escritura en lote: varias filas sueltas en una sola petición (la app la
  // usa para no reescribir hojas enteras). Cada rango viene en el cuerpo y
  // se revisa igual que uno en la dirección.
  if (ruta === base + '/values:batchUpdate') {
    if (metodo !== 'POST') return 'operación no permitida';
    let cuerpo;
    try { cuerpo = JSON.parse(cuerpoTexto || '{}'); } catch (_) { return 'cuerpo inválido'; }
    const datos = Array.isArray(cuerpo.data) ? cuerpo.data : [];
    if (!datos.length) return 'operación no permitida';
    if (datos.length > MAX_FILAS_POR_PETICION_OPERARIO) return 'demasiadas filas de una vez';
    for (const d of datos) {
      if (!d || typeof d.range !== 'string') return 'operación no permitida';
      const motivo = _motivoEscritura(d.range, d);
      if (motivo) return motivo;
    }
    return null;
  }

  if (ruta === base + ':batchUpdate') {
    return metodo === 'POST' ? _motivoEdicionEstructural(cuerpoTexto, spreadsheetId, token) : 'operación no permitida';
  }

  const m = ruta.match(/^\/v4\/spreadsheets\/[^/]+\/values\/([^/]+?)(:append|:clear)?$/);
  if (m) {
    const accion = m[2] || '';
    const permitido = accion ? metodo === 'POST' : (metodo === 'GET' || metodo === 'PUT');
    if (!permitido) return 'operación no permitida';
    let rango;
    try { rango = decodeURIComponent(m[1]); } catch (_) { return 'rango inválido'; }
    const motivo = _motivoRango(rango);
    if (motivo) return motivo;
    // Vaciar un rango solo en las pestañas que la app limpia (el catálogo
    // de variables); en las demás, un rango abierto se lleva todo.
    if (accion === ':clear' && !PESTANAS_EN_BLOQUE.includes(_pestanaDe(rango))) return 'vaciar datos';
    if (metodo === 'PUT') {
      let cuerpo;
      try { cuerpo = JSON.parse(cuerpoTexto || '{}'); } catch (_) { return 'cuerpo inválido'; }
      return _motivoEscritura(rango, cuerpo);
    }
    return null;
  }
  return 'operación no permitida';
}

/* ── Escrituras grandes de un operario ──
   Un operario puede escribir y borrar (la app lo necesita), pero la app
   siempre lo hace fila por fila: un registro, una celda de estado, una fila
   de horas. Una sola petición que sobrescribe, vacía o borra cientos de
   filas no la manda nunca, y con ella alguien con un pase de operario se
   llevaba de un golpe todas las órdenes. Aquí se pone el tope:
     • cada rango que se escribe trae una sola fila (salvo el catálogo de
       variables, que la app reescribe entero),
     • vaciar (:clear) solo en ese catálogo,
     • cada borrado de filas es de una fila, y
     • como mucho MAX_FILAS_POR_PETICION_OPERARIO por petición.
   Esto no impide escribir encima fila por fila: para deshacer cualquier
   daño está el historial de versiones de cada hoja de Google. */
const MAX_FILAS_POR_PETICION_OPERARIO = 200;
const PESTANAS_EN_BLOQUE = ['camposreportes'];

function _pestanaDe(rango) {
  return String(_partesRango(rango).pestana || '').trim().toLowerCase();
}

/** Filas que ocupa lo que se escribe (por filas o, si así viene, por columnas). */
function _filasEscritas(valores) {
  const v = Array.isArray(valores && valores.values) ? valores.values : [];
  if (String((valores && valores.majorDimension) || '').toUpperCase() === 'COLUMNS') {
    return v.reduce((max, col) => Math.max(max, Array.isArray(col) ? col.length : 1), 0);
  }
  return v.length;
}

function _motivoEscritura(rango, valores) {
  const motivo = _motivoRango(rango);
  if (motivo) return motivo;
  if (_filasEscritas(valores) > 1 && !PESTANAS_EN_BLOQUE.includes(_pestanaDe(rango))) return 'demasiadas filas de una vez';
  return null;
}

/** ¿La lectura de la información de la hoja (nombres de pestañas, tamaños)
 *  pide también el contenido de las celdas? Google lo entrega con
 *  includeGridData o con una máscara de campos que nombre "data" (o "*"),
 *  y por ahí no pasa la revisión de pestañas de las lecturas normales. La
 *  app nunca lo pide: un operario solo lee celdas con /values. */
function _pideCeldasEnMetadatos(params) {
  for (const [nombre, valor] of params) {
    const n = nombre.toLowerCase(), v = String(valor || '');
    if (n === 'includegriddata' && v.trim().toLowerCase() !== 'false') return true;
    if (n === 'fields' && (v.includes('*') || v.split(/[^A-Za-z0-9_]+/).some(t => t.toLowerCase() === 'data'))) return true;
  }
  return false;
}

/** Pestaña y celdas de un rango A1: "'Hoja 2'!A1:B2" → { pestana: 'Hoja 2',
 *  celdas: 'A1:B2' }. Sin nombre de pestaña ("A1:C9") devuelve pestana null:
 *  apuntaría a la primera pestaña, sea cual sea. */
function _partesRango(rango) {
  const r = String(rango || '').trim();
  if (r.startsWith("'")) {
    let i = 1, nombre = '';
    while (i < r.length) {
      if (r[i] === "'") {
        if (r[i + 1] === "'") { nombre += "'"; i += 2; continue; }
        break;
      }
      nombre += r[i++];
    }
    if (r[i] !== "'") return { pestana: null, celdas: '' };
    const resto = r.slice(i + 1);
    if (resto && !resto.startsWith('!')) return { pestana: null, celdas: '' };
    return { pestana: nombre, celdas: resto.slice(1) };
  }
  const k = r.indexOf('!');
  if (k >= 0) return { pestana: r.slice(0, k), celdas: r.slice(k + 1) };
  // Sin "!": o es la pestaña completa ("Ordenes") o son celdas sueltas
  // ("A1:C9", "B:B", "3:5"), que caerían en la primera pestaña.
  if (/^\$?[A-Z]*\$?\d*(:\$?[A-Z]*\$?\d*)?$/i.test(r)) return { pestana: null, celdas: r };
  return { pestana: r, celdas: '' };
}

function _motivoRango(rango) {
  const { pestana, celdas } = _partesRango(rango);
  if (pestana === null) return 'rango sin nombre de pestaña';
  const p = pestana.trim().toLowerCase();
  if (p === 'config') {
    return /^\$?B\$?1(:\$?B\$?1)?$/i.test(String(celdas).trim()) ? null : 'configuración de sede';
  }
  if (PESTANAS_SOLO_ADMIN.includes(p)) return 'datos del personal';
  return null;
}

/** Edición estructural de un operario: solo agregar pestañas (que no se
 *  llamen como las protegidas) o borrar filas de datos de pestañas no
 *  protegidas. Para saber qué pestaña es cada sheetId se piden los nombres
 *  a Google (solo cuando hay filas que borrar). */
async function _motivoEdicionEstructural(cuerpoTexto, spreadsheetId, token) {
  let cuerpo;
  try { cuerpo = JSON.parse(cuerpoTexto || '{}'); } catch (_) { return 'cuerpo inválido'; }
  const pedidos = Array.isArray(cuerpo.requests) ? cuerpo.requests : [];
  if (!pedidos.length) return 'operación no permitida';
  if (pedidos.length > MAX_FILAS_POR_PETICION_OPERARIO) return 'demasiadas filas de una vez';
  let nombres = null;
  for (const pedido of pedidos) {
    const tipos = Object.keys(pedido || {});
    if (tipos.length !== 1) return 'operación no permitida';
    if (tipos[0] === 'addSheet') {
      const titulo = String((pedido.addSheet && pedido.addSheet.properties && pedido.addSheet.properties.title) || '').trim().toLowerCase();
      if (!titulo || PESTANAS_SOLO_ADMIN.includes(titulo)) return 'operación no permitida';
      continue;
    }
    if (tipos[0] === 'deleteDimension') {
      const r = (pedido.deleteDimension && pedido.deleteDimension.range) || {};
      if (r.dimension !== 'ROWS' || !(Number(r.startIndex) >= 1) || !(Number(r.endIndex) > Number(r.startIndex))) {
        return 'operación no permitida';
      }
      // La app borra fila por fila (varias en una petición, de abajo hacia arriba).
      if (Number(r.endIndex) - Number(r.startIndex) !== 1) return 'demasiadas filas de una vez';
      if (!nombres) nombres = await _nombresDePestanas(spreadsheetId, token);
      const nombre = nombres.get(Number(r.sheetId));
      if (nombre === undefined || PESTANAS_SOLO_ADMIN.includes(nombre.trim().toLowerCase())) return 'operación no permitida';
      continue;
    }
    return 'operación no permitida';
  }
  return null;
}

async function _nombresDePestanas(spreadsheetId, token) {
  const resp = await fetch(`${GOOGLE_SHEETS_BASE}/v4/spreadsheets/${spreadsheetId}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const nombres = new Map();
  if (!resp.ok) return nombres; // sin nombres, nada pasa
  const datos = await resp.json();
  (datos.sheets || []).forEach(h => nombres.set(Number(h.properties.sheetId), String(h.properties.title || '')));
  return nombres;
}

/* ── CLAVE DE SEDE ──────────────────────────────────────────────────────
   POST /sede  body {spreadsheetId, clave}  (con el pase de sesión)
   Compara la clave con el hash guardado en Config!A1 de esa hoja. Antes el
   navegador leía ese hash y comparaba él mismo, así que cualquiera con
   sesión podía llevárselo y probar claves sin límite. Ahora el hash no sale
   de aquí y hay bloqueo por intentos, igual que en el login. */
async function _sede(peticion, entorno) {
  const sesion = await _sesionVigente(peticion, entorno);
  if (!sesion) return _json({ ok: false, mensaje: 'Sesión inválida o vencida. Vuelve a iniciar sesión.' }, 401);
  if (sesion.cp) return _debeCambiarPin();

  let cuerpo;
  try { cuerpo = await peticion.json(); } catch { return _json({ ok: false, mensaje: 'Body inválido.' }, 400); }
  const spreadsheetId = String(cuerpo.spreadsheetId || '').trim();
  const clave = String(cuerpo.clave || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId) || !clave) return _json({ ok: false, mensaje: 'Falta la hoja o la clave.' }, 400);
  const permitidas = String(entorno.ALLOWED_SHEETS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (permitidas.length && !permitidas.includes(spreadsheetId)) return _json({ ok: false, mensaje: 'Hoja no permitida por el proxy.' }, 403);

  const llave = 'sede:' + sesion.doc + ':' + spreadsheetId;
  const minBloqueo = await _revisarBloqueo(llave, entorno);
  if (minBloqueo > 0) return _json({ ok: false, mensaje: `Demasiados intentos. Intenta de nuevo en ${minBloqueo} minuto(s).` }, 429);

  const token = await _tokenCuentaServicio(entorno);
  const resp = await fetch(`${GOOGLE_SHEETS_BASE}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent('Config!A1:A1')}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!resp.ok) return _json({ ok: false, mensaje: 'No se pudo leer la configuración de la sede (Google respondió ' + resp.status + ').' }, 502);
  const valores = (await resp.json()).values || [];
  const hash = String((valores[0] && valores[0][0]) || '').trim().toLowerCase();
  if (!hash) return _json({ ok: false, mensaje: 'Esta sede aún no tiene configurada su clave de acceso (falta la pestaña "Config", celda A1, con el hash).' }, 404);

  const ingresada = (await _sha256HexUpper(clave)).toLowerCase();
  if (!_igualSeguro(ingresada, hash)) {
    await _registrarFallo(llave, entorno);
    return _json({ ok: false, mensaje: 'Contraseña incorrecta.' }, 401);
  }
  await _limpiarFallos(llave, entorno);
  return _json({ ok: true, paseSede: await _firmarPaseSede(sesion.doc, _hojasDeSede(spreadsheetId), entorno) });
}

/* ── PASE DE SEDE ──
   Lo da /sede con la clave correcta y la app lo manda en cada petición a
   Sheets (cabecera X-Pase-Sede). Lleva las hojas de esa sede y el documento
   de quien lo pidió, y va firmado con una clave distinta a la de la sesión
   (derivada de SESSION_SECRET): no sirve como pase de sesión ni al revés. */
function _hojasDeSede(spreadsheetId) {
  const fila = SEDES_HOJAS.find(f => f.includes(spreadsheetId));
  return fila ? fila.slice() : [spreadsheetId];
}
function _clavePaseSede(entorno) {
  return 'pase-sede|' + _secretoSesion(entorno);
}
async function _firmarPaseSede(doc, hojas, entorno) {
  const exp = Math.floor(Date.now() / 1000) + PASE_SEDE_TTL_SEG;
  const head = _b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = _b64url(JSON.stringify({ tipo: 'sede', doc: String(doc), hojas, exp }));
  return head + '.' + body + '.' + await _hmac(head + '.' + body, _clavePaseSede(entorno));
}
async function _hojasDelPaseSede(peticion, entorno, sesion) {
  const partes = String(peticion.headers.get('X-Pase-Sede') || '').split('.');
  if (partes.length !== 3) return [];
  if (!_igualSeguro(partes[2], await _hmac(partes[0] + '.' + partes[1], _clavePaseSede(entorno)))) return [];
  let d;
  try { d = JSON.parse(_deB64url(partes[1])); } catch { return []; }
  if (!d || d.tipo !== 'sede' || String(d.doc) !== String(sesion.doc) || !(d.exp > Math.floor(Date.now() / 1000))) return [];
  return Array.isArray(d.hojas) ? d.hojas.map(String) : [];
}

/* ── SESIÓN (pase firmado con HMAC-SHA256, tipo JWT) ──────────────────── */
/** SESSION_SECRET firma los pases: sin ella, cualquiera podría fabricar
 *  uno (la firma con una clave vacía se calcula en cualquier lado). Si
 *  falta, el proxy no entrega ni acepta pases. */
function _secretoSesion(entorno) {
  if (!entorno.SESSION_SECRET) throw new Error('Falta configurar SESSION_SECRET en el Worker.');
  return entorno.SESSION_SECRET;
}

async function _firmarSesion(datos, entorno, ttlSeg) {
  const ahora = Math.floor(Date.now() / 1000);
  const payload = { ...datos, iat: ahora, exp: ahora + (ttlSeg || SESSION_TTL_SEG) };
  const head = _b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = _b64url(JSON.stringify(payload));
  const firma = await _hmac(head + '.' + body, _secretoSesion(entorno));
  return head + '.' + body + '.' + firma;
}

async function _sesionDeLaPeticion(peticion, entorno) {
  const auth = peticion.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const partes = m[1].split('.');
  if (partes.length !== 3) return null;
  const [head, body, firma] = partes;
  const esperada = await _hmac(head + '.' + body, _secretoSesion(entorno));
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

/* ── Bloqueo por intentos fallidos ──────────────────────────────────────
   Cloudflare reparte las peticiones entre muchas copias del Worker, cada
   una con su memoria: un contador solo en memoria se evadía repartiendo los
   intentos (así se sacó un PIN de 4 dígitos en la auditoría). Si el Worker
   tiene enlazado un espacio KV con el nombre BLOQUEOS (Configuración →
   Enlaces → Espacio de nombres KV), el conteo se guarda ahí y vale para
   todas las copias. Sin él, o si KV falla (sin cupo, caído), sigue en
   memoria como antes: nunca deja a nadie por fuera por culpa de KV. */
function _kv(entorno) {
  return entorno && entorno.BLOQUEOS && typeof entorno.BLOQUEOS.get === 'function' ? entorno.BLOQUEOS : null;
}
async function _leerIntentos(llave, entorno) {
  const enMemoria = _intentos.get(llave) || null;
  const kv = _kv(entorno);
  let enKv = null;
  if (kv) { try { enKv = await kv.get('intentos:' + llave, 'json'); } catch (_) { /* KV caído */ } }
  if (!enKv) return enMemoria;
  if (!enMemoria) return enKv;
  // Las dos: manda la que va más adelante (KV tarda unos segundos en verse igual en todas partes).
  return (enKv.bloqueadoHasta || 0) > (enMemoria.bloqueadoHasta || 0) || (enKv.intentos || 0) > (enMemoria.intentos || 0) ? enKv : enMemoria;
}
async function _revisarBloqueo(llave, entorno) {
  const d = await _leerIntentos(llave, entorno);
  if (d && d.bloqueadoHasta && Date.now() < d.bloqueadoHasta) {
    return Math.ceil((d.bloqueadoHasta - Date.now()) / 60000);
  }
  return 0;
}
async function _registrarFallo(llave, entorno) {
  let d = { ...((await _leerIntentos(llave, entorno)) || { intentos: 0 }) };
  if (d.bloqueadoHasta && Date.now() >= d.bloqueadoHasta) d = { intentos: 0 };
  d.intentos = (d.intentos || 0) + 1;
  if (d.intentos >= MAX_INTENTOS) { d.bloqueadoHasta = Date.now() + BLOQUEO_MS; d.intentos = 0; }
  _intentos.set(llave, d);
  const kv = _kv(entorno);
  if (kv) {
    try { await kv.put('intentos:' + llave, JSON.stringify(d), { expirationTtl: Math.ceil(BLOQUEO_MS / 1000) }); }
    catch (_) { /* sin cupo de escrituras o caído: queda en memoria */ }
  }
}
async function _limpiarFallos(llave, entorno) {
  const habia = _intentos.delete(llave);
  const kv = _kv(entorno);
  if (!kv) return;
  try { if (habia || await kv.get('intentos:' + llave)) await kv.delete('intentos:' + llave); } catch (_) { /* nada */ }
}

/* Por conexión: quien falla con muchos documentos distintos en poco tiempo
   está probando un PIN contra la lista de personas (en una planta, los
   que se equivocan de PIN son pocos y casi siempre los mismos). Igual que
   el bloqueo por documento, vive en la memoria de esta instancia. */
const IP_MAX_DOCUMENTOS = 10;
const IP_VENTANA_MS = 15 * 60 * 1000;
const _fallosPorIp = new Map(); // ip -> { desde, documentos: Set, bloqueadoHasta }

function _revisarBloqueoIp(ip) {
  const d = ip && _fallosPorIp.get(ip);
  if (d && d.bloqueadoHasta && Date.now() < d.bloqueadoHasta) return Math.ceil((d.bloqueadoHasta - Date.now()) / 60000);
  return 0;
}
function _registrarFalloIp(ip, documento) {
  if (!ip) return;
  if (_fallosPorIp.size > 5000) _fallosPorIp.clear(); // que la memoria no crezca sin fin
  let d = _fallosPorIp.get(ip);
  if (!d || Date.now() - d.desde > IP_VENTANA_MS || (d.bloqueadoHasta && Date.now() >= d.bloqueadoHasta)) {
    d = { desde: Date.now(), documentos: new Set(), bloqueadoHasta: 0 };
  }
  d.documentos.add(documento);
  if (d.documentos.size >= IP_MAX_DOCUMENTOS) d.bloqueadoHasta = Date.now() + BLOQUEO_MS;
  _fallosPorIp.set(ip, d);
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
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Pase-Sede');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return new Response(resp.body, { status: resp.status, headers: h });
}
