// ══════════════════════════════════════════════════════════════════════
// PRUEBAS DEL PROXY (proxy-seguridad/cloudflare-proxy.js) — solo Node
//
// Cargan el Worker real con Google SIMULADO (no se conecta a nada) y revisan:
// login y bloqueo por intentos, pases de sesión, cupo por persona (quotaUser),
// permisos por rol (lista blanca del operario: Proyectos, Usuarios, Config,
// pestañas de personal, escrituras en lote, edición estructural), que
// desactivar o cambiar el rol en la hoja aplique sin esperar a que venza el
// pase, la clave de sede (/sede), ruta /foto y que /diag ya no exista. Se usa una llave RSA falsa
// generada en el momento.
//
// Cómo correrlas:  node pruebas/worker.test.mjs   (Node 18 o más reciente)
// ══════════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// El Worker es un módulo ES con extensión .js: se copia como .mjs temporal
// para poder importarlo sin package.json.
const aqui = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(os.tmpdir(), `cf-proxy-prueba-${process.pid}.mjs`);
fs.copyFileSync(path.join(aqui, '..', 'proxy-seguridad', 'cloudflare-proxy.js'), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;
fs.unlinkSync(tmp);

const resultados = [];
const check = (n, ok, d) => resultados.push({ n, ok: !!ok, d });
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const h = p => crypto.createHash('sha256').update(p).digest('hex').toUpperCase();
const env = { ALLOWED_ORIGIN: 'https://soluaireordenes.github.io', GOOGLE_SA_EMAIL: 'sa@x', GOOGLE_SA_PRIVATE_KEY: pem,
  SESSION_SECRET: 'secreto', USUARIOS_SHEET_ID: 'HOJAUSUARIOS' };
const PROY = '1rICqEwDTOjA8cxFIEa7m5rIw0gs2fd7CB682dRUj0nk';
const ORD_ZIPA = '1_gIoYzZIZeURojSemB5vTtSQ1k4vw4_YfN-G6AjtaYU', INV_ZIPA = '1cqfk7gKRX4MfnHnPEZy7WGOunwT7kYLfJ14_W10Wh3s';
const ORD_ZIPA2 = '1xM4UFaV1fZ5bEYVVNx55UjbPN9CldQ6ObaZl0EGlF8A';
let llamadas = [];
const escriturasUsuarios = [];
// La hoja Usuarios simulada se puede cambiar a mitad de prueba (desactivar a
// alguien, quitarle el rol) para ver que el proxy lo note.
let hojaUsuarios = [['Documento', 'Nombre', 'PINHash', 'Rol', 'Activo'],
  ['111', 'Op', h('111111'), 'operario', 'SI'], ['222', 'Ad', h('222222'), 'admin', 'SI'], ['333', 'Inactivo', h('333333'), 'operario', 'NO'],
  ['444', 'Op2', h('444444'), 'operario', 'SI'], ['555', 'Ad2', h('555555'), 'admin', 'SI']];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'TOKEN_SA', expires_in: 3600 }));
  if (url.includes('HOJAUSUARIOS') && init.method === 'PUT' && !init.headers?.['Authorization']?.includes('SESS')) {
    // El Worker guarda el PIN en el formato nuevo: se aplica a la hoja simulada.
    const celda = decodeURIComponent(url).match(/!([A-Z]+)(\d+)\?/);
    if (celda) { escriturasUsuarios.push(decodeURIComponent(url)); hojaUsuarios[Number(celda[2]) - 1][celda[1].charCodeAt(0) - 65] = JSON.parse(init.body).values[0][0]; }
    return new Response('{}');
  }
  if (url.includes('HOJAUSUARIOS') && !(init.method && init.method !== 'GET')) return new Response(JSON.stringify({ values: hojaUsuarios }));
  llamadas.push({ url, init });
  // Nombres de pestañas (para revisar qué filas se borran)
  if (url.includes('fields=') && url.includes('sheetId')) return new Response(JSON.stringify({ sheets: [
    { properties: { sheetId: 0, title: 'Config' } }, { properties: { sheetId: 7, title: 'Ordenes' } }, { properties: { sheetId: 9, title: 'Operarios' } }] }));
  // Hash de la clave de sede en Config!A1 (la clave es "clave-sede")
  if ((url.includes('HOJASEDEXXXXXXXXXXXXXXXX') || url.includes(INV_ZIPA)) && decodeURIComponent(url).includes('Config!A1:A1')) return new Response(JSON.stringify({ values: [[h('clave-sede').toLowerCase()]] }));
  if (url.includes('/drive/v3/files/')) {
    if (url.includes('NOEXISTEXXXXXX')) return new Response('{}', { status: 404 });
    if (url.includes('TEXTOXXXXXXXXX')) return new Response('secreto', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    if (url.includes('SVGIMGXXXXXXXX')) return new Response('<svg onload="x()"/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
    if (url.includes('PDFDOCXXXXXXXX')) return new Response('%PDF-1.4', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  }
  return new Response('{"values":[["ok"]]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const O = { Origin: 'https://soluaireordenes.github.io' };
const req = (path, opts = {}) => worker.fetch(new Request('https://w' + path, { ...opts, headers: { ...O, ...(opts.headers || {}) } }), env);
const login = async (d, p) => (await req('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documento: d, pin: p }) })).json();

const op = await login('111', '111111'); const ad = await login('222', '222222');
check('Login operario y admin', op.ok && op.rol === 'operario' && ad.ok && ad.rol === 'admin');
check('PIN incorrecto rechazado', !(await login('111', '9999')).ok);
check('Usuario inactivo rechazado', !(await login('333', '333333')).ok);
// bloqueo tras 5 fallos
for (let i = 0; i < 5; i++) await login('999', 'x');
const bloq = await req('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documento: '999', pin: 'x' }) });
check('Bloqueo tras 5 intentos fallidos (429)', bloq.status === 429);
// Un documento que no existe, uno inactivo con PIN malo y un PIN malo responden igual:
// no se puede averiguar qué documentos están registrados. "Inactivo" solo con el PIN bueno.
const loginR = async (d, p, ip) => { const x = await req('/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
  body: JSON.stringify({ documento: d, pin: p }) }); return { status: x.status, ...(await x.json()) }; };
const noExiste = await loginR('8888', '111111'), inactivoMal = await loginR('333', '0000'), pinMal = await loginR('444', '0000'), inactivoBien = await loginR('333', '333333');
check('Ingreso: documento inexistente, inactivo con PIN malo y PIN malo responden igual (401); "inactivo" solo con el PIN correcto',
  [noExiste, inactivoMal, pinMal].every(x => x.status === 401 && x.mensaje === 'Documento o PIN incorrecto.')
  && inactivoBien.status === 403 && inactivoBien.mensaje === 'Usuario inactivo.', { noExiste, inactivoMal, pinMal, inactivoBien });
// Rociado: el mismo PIN contra muchos documentos desde una conexión la bloquea; las demás siguen.
for (let i = 0; i < 10; i++) await loginR(String(7000 + i), '1234', '203.0.113.9');
const rociado = await loginR('111', '111111', '203.0.113.9'), otraIp = await loginR('111', '111111', '203.0.113.10');
for (let i = 0; i < 4; i++) await loginR('7100', '0000', '203.0.113.11');
const mismoDoc = await loginR('111', '111111', '203.0.113.11');
check('Ingreso: una conexión que falla con 10 documentos distintos queda bloqueada (429); otra conexión entra, y equivocarse con un mismo documento no bloquea la conexión',
  rociado.status === 429 && otraIp.ok && mismoDoc.ok, { rociado, otraIp, mismoDoc });

// Un operario solo abre las hojas de la sede cuya clave escribió: /sede le da
// un pase de sede que va en cada petición (X-Pase-Sede).
const SEDE = 'HOJASEDEXXXXXXXXXXXXXXXX';
const paseDe = {};
const H = s => ({ Authorization: 'Bearer ' + s, ...(paseDe[s] ? { 'X-Pase-Sede': paseDe[s] } : {}) });
const pedirPase = async (s, hoja = SEDE) => {
  const x = await req('/sede', { method: 'POST', headers: { Authorization: 'Bearer ' + s, 'Content-Type': 'application/json' }, body: JSON.stringify({ spreadsheetId: hoja, clave: 'clave-sede' }) });
  return (paseDe[s] = (await x.json()).paseSede);
};
await pedirPase(op.session);
check('/ping responde', (await req('/ping')).status === 200);
const diag = await req('/diag?doc=111&pin=1111');
check('/diag eliminado (404)', diag.status === 404);
check('Sin sesión → 401 en Sheets', (await req('/sheets/v4/spreadsheets/X/values/A1')).status === 401);
const sesFalsa = op.session.slice(0, -3) + 'abc';
check('Pase alterado → 401', (await req('/sheets/v4/spreadsheets/X/values/A1', { headers: H(sesFalsa) })).status === 401);

llamadas = [];
await req('/sheets/v4/spreadsheets/HOJASEDEXXXXXXXXXXXXXXXX/values/' + encodeURIComponent('Entrega Turno!A:ZZ'), { headers: H(op.session) });
await req('/sheets/v4/spreadsheets/HOJASEDEXXXXXXXXXXXXXXXX/values/' + encodeURIComponent('H1!A1') + ':append?valueInputOption=USER_ENTERED', { method: 'POST', headers: { ...H(op.session), 'Content-Type': 'application/json' }, body: '{"values":[["x"]]}' });
const u = llamadas.map(l => new URL(l.url));
check('quotaUser por persona en cada petición', u.length === 2 && u.every(x => x.searchParams.get('quotaUser') === 'u-111') && llamadas[1].init.body === '{"values":[["x"]]}');
check('Usa el token de la cuenta de servicio', llamadas.every(l => l.init.headers.Authorization === 'Bearer TOKEN_SA'));

const st = async (s, hoja, metodo = 'GET', rango = 'Ordenes!A1') => (await req(`/sheets/v4/spreadsheets/${hoja}/values/${encodeURIComponent(rango)}${metodo === 'POST' ? ':append' : ''}`,
  { method: metodo, headers: { ...H(s), 'Content-Type': 'application/json' }, body: metodo === 'POST' ? '{}' : undefined })).status;
check('Operario NO puede leer Proyectos (403)', (await st(op.session, PROY)) === 403);
check('Operario NO puede escribir Proyectos (403)', (await st(op.session, PROY, 'POST')) === 403);
check('Admin SÍ lee Proyectos', (await st(ad.session, PROY)) === 200);
check('Operario NO escribe en Usuarios (403)', (await st(op.session, 'HOJAUSUARIOS', 'POST')) === 403);
check('Operario NO escribe en Config! (403)', (await st(op.session, 'HOJASEDEXXXXXXXXXXXXXXXX', 'POST', 'Config!A1')) === 403);
check('Operario SÍ lee/escribe hojas de su sede', (await st(op.session, 'HOJASEDEXXXXXXXXXXXXXXXX')) === 200 && (await st(op.session, 'HOJASEDEXXXXXXXXXXXXXXXX', 'POST', 'Ordenes!A1')) === 200);

// Lista blanca del operario
const pedir = (s, ruta, metodo = 'GET', cuerpo) => req('/sheets/v4/spreadsheets/HOJASEDEXXXXXXXXXXXXXXXX' + ruta,
  { method: metodo, headers: { ...H(s), 'Content-Type': 'application/json' }, body: cuerpo }).then(x => x.status);
const enc = encodeURIComponent;
check('Operario NO lee la hoja de Usuarios (403)', (await st(op.session, 'HOJAUSUARIOS')) === 403);
check('Operario NO lee la clave de sede en Config!A1 (403)', (await pedir(op.session, '/values/' + enc('Config!A1:A1'))) === 403);
check("Operario NO escribe 'Config'!A1 con comillas (403)", (await pedir(op.session, '/values/' + enc("'Config'!A1") + '?valueInputOption=RAW', 'PUT', '{"values":[["x"]]}')) === 403);
check('Operario SÍ lee y escribe el candado Config!B1', (await pedir(op.session, '/values/' + enc('Config!B1:B1'))) === 200
  && (await pedir(op.session, '/values/' + enc('Config!B1') + '?valueInputOption=RAW', 'PUT', '{"values":[["t:1"]]}')) === 200);
check('Escritura en lote: se revisa cada rango del cuerpo (Config!A1 → 403) y no hay borrado en lote', (await pedir(op.session, '/values:batchUpdate', 'POST',
  JSON.stringify({ data: [{ range: 'HorasEquipos!A3:F3', values: [['x']] }, { range: 'Config!A1', values: [['x']] }] }))) === 403
  && (await pedir(op.session, '/values:batchClear', 'POST', '{"ranges":["Config!A1"]}')) === 403);
check('Operario SÍ escribe filas sueltas en lote (horas, estado de informes)', (await pedir(op.session, '/values:batchUpdate', 'POST',
  JSON.stringify({ valueInputOption: 'RAW', data: [{ range: 'HorasEquipos!A3:F3', values: [['x']] }, { range: "'InformeTrimestralEstado'!A2:C2", values: [['y']] }] }))) === 200);
check('Operario NO borra pestañas enteras (403)', (await pedir(op.session, ':batchUpdate', 'POST', JSON.stringify({ requests: [{ deleteSheet: { sheetId: 7 } }] }))) === 403);
const borrarFilas = (sheetId, desde) => JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: desde, endIndex: desde + 1 } } }] });
check('Operario SÍ borra filas de datos de Ordenes (editar una orden)', (await pedir(op.session, ':batchUpdate', 'POST', borrarFilas(7, 4))) === 200);
check('Operario NO borra la fila de encabezados ni filas de Config/Operarios (403)', (await pedir(op.session, ':batchUpdate', 'POST', borrarFilas(7, 0))) === 403
  && (await pedir(op.session, ':batchUpdate', 'POST', borrarFilas(0, 1))) === 403 && (await pedir(op.session, ':batchUpdate', 'POST', borrarFilas(9, 1))) === 403);
check('Operario SÍ agrega una pestaña nueva, pero no una llamada Config (403)', (await pedir(op.session, ':batchUpdate', 'POST', JSON.stringify({ requests: [{ addSheet: { properties: { title: 'Tareas' } } }] }))) === 200
  && (await pedir(op.session, ':batchUpdate', 'POST', JSON.stringify({ requests: [{ addSheet: { properties: { title: 'config' } } }] }))) === 403);
check('Operario NO usa rangos sin nombre de pestaña (403); admin sí', (await pedir(op.session, '/values/' + enc('A1:C3'))) === 403 && (await pedir(ad.session, '/values/' + enc('A1:C3'))) === 200);
check('Operario SÍ lee metadatos, rango con espacios y lectura en lote normal', (await pedir(op.session, '?fields=sheets.properties')) === 200
  && (await pedir(op.session, '/values/' + enc("'Entrega Turno'!A:ZZ"))) === 200
  && (await pedir(op.session, '/values:batchGet?ranges=' + enc('Ordenes!A:Z') + '&ranges=' + enc('Tareas!A:H'))) === 200
  && (await pedir(op.session, '/values/' + enc('Ordenes!A:Z') + ':append?valueInputOption=RAW', 'POST', '{"values":[["x"]]}')) === 200
  && (await pedir(op.session, '/values/' + enc('CamposReportes!A5:ZZ') + ':clear', 'POST', '{}')) === 200);
// La información de la hoja no puede traer el contenido de las celdas: por ahí
// se saltaba la revisión de pestañas (Config, Operarios, llamados de atención).
llamadas = [];
const conCeldas = ['?includeGridData=true&ranges=' + enc('Config!A1'), '?includeGridData=TRUE&ranges=' + enc('ObservacionesOperarios!A:H'),
  '?includeGridData=1', '?ranges=' + enc('Operarios!A:E') + '&fields=' + enc('sheets.data.rowData.values.formattedValue'),
  '?fields=' + enc('sheets(properties,data(rowData))'), '?fields=' + enc('sheets/data'), '?fields=*', '?fields=sheets(*)',
  '?includeGridData=false&includeGridData=true', '?fields=' + enc('sheets.properties') + '&fields=' + enc('sheets.data')];
const estadosCeldas = [];
for (const q of conCeldas) estadosCeldas.push(await pedir(op.session, q));
check('Operario NO lee celdas por la información de la hoja (includeGridData o máscara con data, 403) y no llega nada a Google',
  estadosCeldas.every(s => s === 403) && llamadas.length === 0, { estadosCeldas, llamadas: llamadas.length });
const camposApp = ['sheets.properties.title', 'sheets.properties', 'properties.title,sheets(properties(title,gridProperties(rowCount,columnCount)))',
  'sheets(properties(title,gridProperties(rowCount)))', 'sheets(properties(sheetId,title))', 'sheets.properties(sheetId,title)'];
const estadosApp = [];
for (const c of camposApp) estadosApp.push(await pedir(op.session, '?fields=' + enc(c)));
estadosApp.push(await pedir(op.session, ''), await pedir(op.session, '?includeGridData=false'));
check('Operario SÍ lee la información que usa la app (nombres y tamaños de pestañas)', estadosApp.every(s => s === 200), estadosApp);
check('Admin SÍ lee celdas por la información de la hoja', (await pedir(ad.session, conCeldas[0])) === 200);
// Escrituras grandes: la app escribe y borra fila por fila; de un golpe no.
const filas = n => Array.from({ length: n }, (_, i) => ['v' + i]);
const put = (s, rango, cuerpo) => pedir(s, '/values/' + enc(rango) + '?valueInputOption=RAW', 'PUT', JSON.stringify(cuerpo));
const lotePut = (s, data) => pedir(s, '/values:batchUpdate', 'POST', JSON.stringify({ valueInputOption: 'RAW', data }));
const borrarN = (s, pedidos) => pedir(s, ':batchUpdate', 'POST', JSON.stringify({ requests: pedidos }));
const filaSuelta = i => ({ deleteDimension: { range: { sheetId: 7, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } });
llamadas = [];
const grandes = [
  await put(op.session, 'Ordenes!A2:A3', { values: filas(2) }),
  await put(op.session, 'Ordenes!A2:A500', { majorDimension: 'COLUMNS', values: [filas(499).map(f => f[0])] }),
  await lotePut(op.session, [{ range: 'HorasEquipos!A3:F4', values: filas(2) }]),
  await lotePut(op.session, Array.from({ length: 201 }, (_, i) => ({ range: 'HorasEquipos!A' + (i + 2), values: [['x']] }))),
  await pedir(op.session, '/values/' + enc('Ordenes!A2:ZZ') + ':clear', 'POST', '{}'),
  await borrarN(op.session, [{ deleteDimension: { range: { sheetId: 7, dimension: 'ROWS', startIndex: 1, endIndex: 1000000 } } }]),
  await borrarN(op.session, Array.from({ length: 201 }, (_, i) => filaSuelta(201 - i))),
];
check('Operario NO sobrescribe, vacía ni borra muchas filas de un golpe (403) y nada llega a Google', grandes.every(x => x === 403) && llamadas.length === 0, { grandes, llamadas: llamadas.length });
const normales = [
  await put(op.session, 'Ordenes!A5:C5', { values: [['a', 'b', 'c']] }),
  await put(op.session, 'CamposReportes!A2:C4', { values: filas(3) }),
  await lotePut(op.session, Array.from({ length: 200 }, (_, i) => ({ range: 'HorasEquipos!A' + (i + 2) + ':F' + (i + 2), values: [['x']] }))),
  await borrarN(op.session, [filaSuelta(9), filaSuelta(5), filaSuelta(3)]),
];
check('Operario SÍ escribe una fila, el catálogo de variables entero, 200 filas sueltas en lote y borra varias filas de a una', normales.every(x => x === 200), normales);
const admin = [
  await put(ad.session, 'Ordenes!A2:A3', { values: filas(2) }),
  await pedir(ad.session, '/values/' + enc('Ordenes!A2:ZZ') + ':clear', 'POST', '{}'),
  await borrarN(ad.session, [{ deleteDimension: { range: { sheetId: 7, dimension: 'ROWS', startIndex: 1, endIndex: 50 } } }]),
];
check('Admin SÍ escribe, vacía y borra en bloque', admin.every(x => x === 200), admin);
check('Admin SÍ puede escrituras en lote y borrar pestañas', (await pedir(ad.session, '/values:batchUpdate', 'POST', '{"data":[]}')) === 200
  && (await pedir(ad.session, ':batchUpdate', 'POST', JSON.stringify({ requests: [{ deleteSheet: { sheetId: 7 } }] }))) === 200);

// Clave de sede: se compara en el proxy, con bloqueo por intentos.
const sede = (s, clave, hoja = 'HOJASEDEXXXXXXXXXXXXXXXX') => req('/sede', { method: 'POST', headers: { ...H(s), 'Content-Type': 'application/json' },
  body: JSON.stringify({ spreadsheetId: hoja, clave }) }).then(async x => ({ status: x.status, ...(await x.json()) }));
const sOk = await sede(op.session, 'clave-sede');
check('Clave de sede correcta → ok con el pase de sede (sin devolver el hash)', sOk.status === 200 && sOk.ok === true && Object.keys(sOk).join() === 'status,ok,paseSede'
  && !JSON.stringify(sOk).includes(h('clave-sede').toLowerCase()), sOk);
check('Clave de sede incorrecta → 401', (await sede(op.session, 'otra')).status === 401);
for (let i = 0; i < 5; i++) await sede(ad.session, 'mal');
check('Clave de sede: bloqueo tras 5 intentos (429)', (await sede(ad.session, 'clave-sede')).status === 429);
check('Clave de sede sin sesión → 401', (await req('/sede', { method: 'POST', body: '{"spreadsheetId":"HOJASEDEXXXXXXXXXXXXXXXX","clave":"x"}' })).status === 401);

// Pestañas de personal: Operarios (números del bot) y llamados de atención.
const rango = (s, r, metodo = 'GET', cuerpo) => req(`/sheets/v4/spreadsheets/HOJASEDEXXXXXXXXXXXXXXXX/values/${encodeURIComponent(r)}`,
  { method: metodo, headers: { ...H(s), 'Content-Type': 'application/json' }, body: cuerpo }).then(x => x.status);
check('Operario NO lee Operarios (403)', (await rango(op.session, 'Operarios!A:E')) === 403);
check("Operario NO escribe 'Operarios' con comillas (403)", (await rango(op.session, "'Operarios'!A2", 'PUT', '{"values":[["x"]]}')) === 403);
check('Operario NO lee llamados de atención (403)', (await rango(op.session, 'ObservacionesOperarios!A:H')) === 403);
const lote = await req('/sheets/v4/spreadsheets/HOJASEDEXXXXXXXXXXXXXXXX/values:batchGet?ranges=' + encodeURIComponent('Ordenes!A:Z') + '&ranges=' + encodeURIComponent('Operarios!A:E'), { headers: H(op.session) });
check('Operario NO lee Operarios dentro de una lectura en lote (403)', lote.status === 403);
const cuerpoLote = JSON.stringify({ valueInputOption: 'RAW', data: [{ range: 'ObservacionesOperarios!A2', values: [['x']] }] });
check('Operario NO escribe llamados de atención en lote (403)', (await req('/sheets/v4/spreadsheets/HOJASEDEXXXXXXXXXXXXXXXX/values:batchUpdate',
  { method: 'POST', headers: { ...H(op.session), 'Content-Type': 'application/json' }, body: cuerpoLote })).status === 403);
check('Admin SÍ lee Operarios', (await rango(ad.session, 'Operarios!A:E')) === 200);
check('Operario SÍ lee Observaciones de inventario (no es personal)', (await rango(op.session, 'InventarioEquiposObs!A:C')) === 200);

// Cambios en la hoja Usuarios con el pase ya entregado. El login relee la
// hoja, así que entrar con otra cuenta refresca lo que el proxy sabe.
const op2 = await login('444', '444444'); const ad2 = await login('555', '555555');
await pedirPase(op2.session);
check('Pase de Op2 y Ad2 sirven antes del cambio', (await st(op2.session, 'HOJASEDEXXXXXXXXXXXXXXXX')) === 200 && (await st(ad2.session, PROY)) === 200);
hojaUsuarios = hojaUsuarios.map(f => f[0] === '444' ? [...f.slice(0, 4), 'NO'] : f[0] === '555' ? [f[0], f[1], f[2], 'operario', 'SI'] : f);
await login('111', '111111');
check('Usuario desactivado pierde el acceso sin esperar a que venza el pase (401)', (await st(op2.session, 'HOJASEDEXXXXXXXXXXXXXXXX')) === 401);
check('Admin al que le quitan el rol ya no abre Proyectos (403)', (await st(ad2.session, PROY)) === 403);
check('Los demás siguen entrando', (await st(op.session, 'HOJASEDEXXXXXXXXXXXXXXXX')) === 200 && (await st(ad.session, PROY)) === 200);

// PIN con clave secreta (PIN_PEPPER): se convierte al entrar, sin cambiar el PIN.
const envPepper = { ...env, PIN_PEPPER: 'pimienta-de-prueba', FOTOS_SECRETO: 'secreto-fotos' };
const reqP = (ruta, opts = {}) => worker.fetch(new Request('https://w' + ruta, { ...opts, headers: { ...O, ...(opts.headers || {}) } }), envPepper);
const loginP = async (d, pin) => (await reqP('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documento: d, pin }) })).json();
check('Sin PIN_PEPPER no se toca la hoja Usuarios', escriturasUsuarios.length === 0);
const l1 = await loginP('111', '111111');
const celdaOp = hojaUsuarios.find(f => f[0] === '111')[2];
check('Con PIN_PEPPER: entra con el PIN de siempre y su celda pasa al formato nuevo', l1.ok && /^v2\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(celdaOp)
  && escriturasUsuarios.length === 1 && escriturasUsuarios[0].includes("'Usuarios'!C2"), { l1, celdaOp, escriturasUsuarios });
check('El formato nuevo no contiene el resumen SHA-256 del PIN', !celdaOp.toUpperCase().includes(h('111111')));
const l2 = await loginP('111', '111111');
check('Con el formato nuevo: PIN correcto entra, incorrecto no, y no se reescribe', l2.ok && !(await loginP('111', '1112')).ok && escriturasUsuarios.length === 1);
check('Formato nuevo sin PIN_PEPPER no entra (la clave no se puede perder)', !(await login('111', '111111')).ok);
const sal1 = celdaOp.split('$')[1];
await loginP('222', '222222');
check('Cada persona queda con su propia sal', hojaUsuarios.find(f => f[0] === '222')[2].split('$')[1] !== sal1);

// Pase de fotos
const pf = await (await reqP('/pase-fotos', { headers: H(l2.session) })).json();
const [ph, pb, pfirma] = String(pf.pase || '').split('.');
const firmaEsperada = crypto.createHmac('sha256', 'secreto-fotos').update(ph + '.' + pb).digest('base64url');
const cuerpoPase = pb ? JSON.parse(Buffer.from(pb, 'base64url').toString()) : {};
check('Pase de fotos firmado con FOTOS_SECRETO, dura 6 horas', pf.ok && pfirma === firmaEsperada && cuerpoPase.doc === '111'
  && Math.abs(cuerpoPase.exp - (Date.now() / 1000 + 6 * 3600)) < 60, { pf, cuerpoPase });
check('Pase de fotos sin sesión → 401; sin FOTOS_SECRETO → 501', (await reqP('/pase-fotos')).status === 401
  && (await req('/pase-fotos', { headers: H(ad.session) })).status === 501);

const f1 = await req('/foto?id=FOTOIDXXXXXXXXXX1', { headers: H(op.session) });
check('/foto entrega la imagen con sesión', f1.status === 200 && f1.headers.get('Content-Type') === 'image/jpeg' && f1.headers.get('Access-Control-Allow-Origin') === O.Origin);
check('/foto sin sesión → 401', (await req('/foto?id=FOTOIDXXXXXXXXXX1')).status === 401);
check('/foto id inválido → 400', (await req('/foto?id=../../etc', { headers: H(op.session) })).status === 400);
check('/foto inexistente → 404', (await req('/foto?id=NOEXISTEXXXXXX', { headers: H(op.session) })).status === 404);
const fTexto = await req('/foto?id=TEXTOXXXXXXXXX', { headers: H(op.session) });
const fSvg = await req('/foto?id=SVGIMGXXXXXXXX', { headers: H(op.session) });
const fPdf = await req('/foto?id=PDFDOCXXXXXXXX', { headers: H(op.session) });
const cuerpoTexto = await fTexto.text();
check('/foto solo entrega fotos y PDF: otro archivo o un SVG → 403 sin su contenido; el PDF sí, y nada se adivina por el tipo (nosniff)',
  fTexto.status === 403 && !cuerpoTexto.includes('secreto') && fSvg.status === 403 && fPdf.status === 200 && fPdf.headers.get('Content-Type') === 'application/pdf'
  && f1.headers.get('X-Content-Type-Options') === 'nosniff', { texto: fTexto.status, svg: fSvg.status, pdf: fPdf.status });

// ── Clave de sede en el proxy: el operario solo abre las hojas de la sede que desbloqueó ──
// (555 quedó de operario arriba; 111 ya tiene el PIN con PIN_PEPPER y aquí no entraría)
const opSede = await login('555', '555555');
const sinPase = await req(`/sheets/v4/spreadsheets/${ORD_ZIPA}/values/${enc('Ordenes!A1')}`, { headers: { Authorization: 'Bearer ' + opSede.session } });
const sinPaseJ = await sinPase.json();
const paseZipa = await pedirPase(opSede.session, INV_ZIPA);
const conPase = (id, s = opSede.session, pase = paseZipa) => req(`/sheets/v4/spreadsheets/${id}/values/${enc('Ordenes!A1')}`,
  { headers: { Authorization: 'Bearer ' + s, ...(pase ? { 'X-Pase-Sede': pase } : {}) } }).then(x => x.status);
const paseAlterado = paseZipa.slice(0, -3) + 'abc';
check('Sede: sin pase de sede el operario no abre la hoja (403, pide la clave)', sinPase.status === 403 && sinPaseJ.sede === true, sinPaseJ);
check('Sede: con la clave de Zipaquirá abre sus órdenes y su inventario, pero no las de Zipaquirá 2',
  (await conPase(ORD_ZIPA)) === 200 && (await conPase(INV_ZIPA)) === 200 && (await conPase(ORD_ZIPA2)) === 403);
check('Sede: el pase no sirve con otra persona, alterado, ni como pase de sesión',
  (await conPase(ORD_ZIPA, op.session)) === 403 && (await conPase(ORD_ZIPA, opSede.session, paseAlterado)) === 403
  && (await req(`/sheets/v4/spreadsheets/${ORD_ZIPA}/values/A1`, { headers: { Authorization: 'Bearer ' + paseZipa } })).status === 401);
check('Sede: el admin abre cualquier sede sin pase', (await conPase(ORD_ZIPA2, ad.session, null)) === 200);
// La tabla de sedes del proxy es la misma de la app (index.html).
{
  const app = fs.readFileSync(path.join(aqui, '..', 'index.html'), 'utf8');
  const proxy = fs.readFileSync(path.join(aqui, '..', 'proxy-seguridad', 'cloudflare-proxy.js'), 'utf8');
  const bloque = (txt, nombre) => txt.slice(txt.indexOf(nombre), txt.indexOf('};', txt.indexOf(nombre)));
  const ordenes = Object.fromEntries([...bloque(app, 'const OPERACIONES').matchAll(/(\w+)\s*:\s*\{[^}]*spreadsheetId:\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
  const inventario = Object.fromEntries([...bloque(app, 'const INVENTARIO_SHEETS').matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
  const tabla = [...proxy.slice(proxy.indexOf('const SEDES_HOJAS')).matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].slice(0, 50).map(m => m[1] + '|' + m[2]);
  const deLaApp = Object.keys(ordenes).map(k => ordenes[k] + '|' + inventario[k]);
  check('Sede: la tabla de hojas del proxy coincide con la de la app (OPERACIONES e INVENTARIO_SHEETS)',
    deLaApp.length === 6 && deLaApp.every(x => tabla.includes(x)) && tabla.length >= 6, { deLaApp, tabla: tabla.slice(0, 8) });
}

// ── PIN corto: entra, pero debe crear uno nuevo de 6 antes de hacer nada ──
hojaUsuarios.push(['90817263', 'Nuevo', h('4321'), 'operario', 'SI']);
const corto = await login('90817263', '4321');
const ses = corto.session;
const cpSheets = await req(`/sheets/v4/spreadsheets/${SEDE}/values/A1`, { headers: { Authorization: 'Bearer ' + ses } });
check('PIN corto: el ingreso avisa que hay que cambiarlo y nada más funciona hasta entonces',
  corto.ok && corto.cambiarPin === true && cpSheets.status === 403 && (await cpSheets.json()).cambiarPin === true
  && (await req('/pase-fotos', { headers: H(ses) })).status === 403 && (await sede(ses, 'clave-sede')).cambiarPin === true, corto);
const cambiar = (actual, nuevo, s = ses) => req('/cambiar-pin', { method: 'POST', headers: { Authorization: 'Bearer ' + s, 'Content-Type': 'application/json' },
  body: JSON.stringify({ pinActual: actual, pinNuevo: nuevo }) }).then(async x => ({ status: x.status, ...(await x.json()) }));
const debiles = [await cambiar('4321', '4321'), await cambiar('4321', '12345'), await cambiar('4321', '777777'), await cambiar('4321', '345678'),
  await cambiar('4321', '876543'), await cambiar('4321', '908172'), await cambiar('4321', '12ab56')];
check('Cambiar PIN: no acepta un PIN corto, repetido, seguido, del documento ni con letras (400)', debiles.every(x => x.status === 400), debiles.map(x => x.mensaje));
check('Cambiar PIN: con el PIN actual equivocado → 401', (await cambiar('9999', '583920')).status === 401);
const cambio = await cambiar('4321', '583920');
const filaNuevo = hojaUsuarios.find(f => f[0] === '90817263');
check('Cambiar PIN: se guarda en la hoja y da un pase que ya sirve', cambio.ok && filaNuevo[2] === h('583920')
  && (await sede(cambio.session, 'clave-sede')).ok === true, { cambio, fila: filaNuevo[2] });
const viejo = await login('90817263', '4321'), nuevoPin = await login('90817263', '583920');
check('Cambiar PIN: el PIN viejo ya no entra; el nuevo sí, sin pedir cambio', !viejo.ok && nuevoPin.ok && !nuevoPin.cambiarPin, { viejo, nuevoPin });

// ── Bloqueo que vale para todas las copias del Worker (KV) ──
{
  const kvDatos = new Map();
  const kv = { async get(k, tipo) { const v = kvDatos.get(k); return v === undefined ? null : (tipo === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { kvDatos.set(k, v); }, async delete(k) { kvDatos.delete(k); } };
  const copia = async n => { const t = path.join(os.tmpdir(), `cf-proxy-copia-${process.pid}-${n}.mjs`); fs.copyFileSync(path.join(aqui, '..', 'proxy-seguridad', 'cloudflare-proxy.js'), t);
    const w = (await import(pathToFileURL(t).href)).default; fs.unlinkSync(t); return w; };
  const w1 = await copia(1), w2 = await copia(2);
  const envKv = { ...env, BLOQUEOS: kv };
  const ing = (w, d, pin, e = envKv) => w.fetch(new Request('https://w/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documento: d, pin }) }), e).then(x => x.status);
  for (let i = 0; i < 5; i++) await ing(w1, '222', '000000');
  const enOtra = await ing(w2, '222', '222222');
  check('Bloqueo con KV: 5 fallos en una copia del Worker bloquean el documento también en otra (429)', enOtra === 429, { enOtra, kv: [...kvDatos.keys()] });
  const kvCaido = { get: async () => { throw new Error('caído'); }, put: async () => { throw new Error('sin cupo'); }, delete: async () => {} };
  check('Bloqueo con KV: si KV falla, el ingreso sigue funcionando (cuenta en memoria)', (await ing(w2, '555', '555555', { ...env, BLOQUEOS: kvCaido })) === 200);
}
// Sin SESSION_SECRET el proxy no entrega ni acepta pases (antes los firmaba con una clave vacía).
{
  const sinSecreto = { ...env }; delete sinSecreto.SESSION_SECRET;
  const r1 = await worker.fetch(new Request('https://w/login', { method: 'POST', body: JSON.stringify({ documento: '555', pin: '555555' }) }), sinSecreto);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const hd = b64({ alg: 'HS256', typ: 'JWT' }), bd = b64({ doc: '222', rol: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 });
  const falso = hd + '.' + bd + '.' + crypto.createHmac('sha256', '').update(hd + '.' + bd).digest('base64url');
  const r2 = await worker.fetch(new Request('https://w/sheets/v4/spreadsheets/' + PROY + '/values/A1', { headers: { Authorization: 'Bearer ' + falso } }), sinSecreto);
  check('Sin SESSION_SECRET: no entrega pase y no acepta uno firmado con clave vacía', r1.status === 500 && !(await r1.json()).session && r2.status !== 200, { r1: r1.status, r2: r2.status });
}

let ok = 0;
for (const r of resultados) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.ok ? '' : '  → ' + JSON.stringify(r.d))); if (r.ok) ok++; }
console.log(`\n${ok}/${resultados.length} pruebas del Worker OK`);
process.exit(ok === resultados.length ? 0 : 1);
