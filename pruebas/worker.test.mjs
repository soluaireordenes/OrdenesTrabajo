// ══════════════════════════════════════════════════════════════════════
// PRUEBAS DEL PROXY (proxy-seguridad/cloudflare-proxy.js) — solo Node
//
// Cargan el Worker real con Google SIMULADO (no se conecta a nada) y revisan:
// login y bloqueo por intentos, pases de sesión, cupo por persona (quotaUser),
// permisos por rol (Proyectos, Usuarios, Config, pestañas de personal), que
// desactivar o cambiar el rol en la hoja aplique sin esperar a que venza el
// pase, ruta /foto y que /diag ya no exista. Se usa una llave RSA falsa
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
let llamadas = [];
// La hoja Usuarios simulada se puede cambiar a mitad de prueba (desactivar a
// alguien, quitarle el rol) para ver que el proxy lo note.
let hojaUsuarios = [['Documento', 'Nombre', 'PINHash', 'Rol', 'Activo'],
  ['111', 'Op', h('1111'), 'operario', 'SI'], ['222', 'Ad', h('2222'), 'admin', 'SI'], ['333', 'Inactivo', h('3333'), 'operario', 'NO'],
  ['444', 'Op2', h('4444'), 'operario', 'SI'], ['555', 'Ad2', h('5555'), 'admin', 'SI']];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'TOKEN_SA', expires_in: 3600 }));
  if (url.includes('HOJAUSUARIOS') && !(init.method && init.method !== 'GET')) return new Response(JSON.stringify({ values: hojaUsuarios }));
  llamadas.push({ url, init });
  if (url.includes('/drive/v3/files/')) {
    if (url.includes('NOEXISTEXXXXXX')) return new Response('{}', { status: 404 });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  }
  return new Response('{"values":[["ok"]]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const O = { Origin: 'https://soluaireordenes.github.io' };
const req = (path, opts = {}) => worker.fetch(new Request('https://w' + path, { ...opts, headers: { ...O, ...(opts.headers || {}) } }), env);
const login = async (d, p) => (await req('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documento: d, pin: p }) })).json();

const op = await login('111', '1111'); const ad = await login('222', '2222');
check('Login operario y admin', op.ok && op.rol === 'operario' && ad.ok && ad.rol === 'admin');
check('PIN incorrecto rechazado', !(await login('111', '9999')).ok);
check('Usuario inactivo rechazado', !(await login('333', '3333')).ok);
// bloqueo tras 5 fallos
for (let i = 0; i < 5; i++) await login('999', 'x');
const bloq = await req('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documento: '999', pin: 'x' }) });
check('Bloqueo tras 5 intentos fallidos (429)', bloq.status === 429);

const H = s => ({ Authorization: 'Bearer ' + s });
check('/ping responde', (await req('/ping')).status === 200);
const diag = await req('/diag?doc=111&pin=1111');
check('/diag eliminado (404)', diag.status === 404);
check('Sin sesión → 401 en Sheets', (await req('/sheets/v4/spreadsheets/X/values/A1')).status === 401);
const sesFalsa = op.session.slice(0, -3) + 'abc';
check('Pase alterado → 401', (await req('/sheets/v4/spreadsheets/X/values/A1', { headers: H(sesFalsa) })).status === 401);

llamadas = [];
await req('/sheets/v4/spreadsheets/ABC/values/' + encodeURIComponent('Entrega Turno!A:ZZ'), { headers: H(op.session) });
await req('/sheets/v4/spreadsheets/ABC/values/' + encodeURIComponent('H1!A1') + ':append?valueInputOption=USER_ENTERED', { method: 'POST', headers: { ...H(op.session), 'Content-Type': 'application/json' }, body: '{"values":[["x"]]}' });
const u = llamadas.map(l => new URL(l.url));
check('quotaUser por persona en cada petición', u.length === 2 && u.every(x => x.searchParams.get('quotaUser') === 'u-111') && llamadas[1].init.body === '{"values":[["x"]]}');
check('Usa el token de la cuenta de servicio', llamadas.every(l => l.init.headers.Authorization === 'Bearer TOKEN_SA'));

const st = async (s, hoja, metodo = 'GET', rango = 'A1') => (await req(`/sheets/v4/spreadsheets/${hoja}/values/${encodeURIComponent(rango)}${metodo === 'POST' ? ':append' : ''}`,
  { method: metodo, headers: { ...H(s), 'Content-Type': 'application/json' }, body: metodo === 'POST' ? '{}' : undefined })).status;
check('Operario NO puede leer Proyectos (403)', (await st(op.session, PROY)) === 403);
check('Operario NO puede escribir Proyectos (403)', (await st(op.session, PROY, 'POST')) === 403);
check('Admin SÍ lee Proyectos', (await st(ad.session, PROY)) === 200);
check('Operario NO escribe en Usuarios (403)', (await st(op.session, 'HOJAUSUARIOS', 'POST')) === 403);
check('Operario NO escribe en Config! (403)', (await st(op.session, 'HOJASEDE', 'POST', 'Config!A1')) === 403);
check('Operario SÍ lee/escribe hojas de su sede', (await st(op.session, 'HOJASEDE')) === 200 && (await st(op.session, 'HOJASEDE', 'POST', 'Ordenes!A1')) === 200);

// Pestañas de personal: Operarios (números del bot) y llamados de atención.
const rango = (s, r, metodo = 'GET', cuerpo) => req(`/sheets/v4/spreadsheets/HOJASEDE/values/${encodeURIComponent(r)}`,
  { method: metodo, headers: { ...H(s), 'Content-Type': 'application/json' }, body: cuerpo }).then(x => x.status);
check('Operario NO lee Operarios (403)', (await rango(op.session, 'Operarios!A:E')) === 403);
check("Operario NO escribe 'Operarios' con comillas (403)", (await rango(op.session, "'Operarios'!A2", 'PUT', '{"values":[["x"]]}')) === 403);
check('Operario NO lee llamados de atención (403)', (await rango(op.session, 'ObservacionesOperarios!A:H')) === 403);
const lote = await req('/sheets/v4/spreadsheets/HOJASEDE/values:batchGet?ranges=' + encodeURIComponent('Ordenes!A:Z') + '&ranges=' + encodeURIComponent('Operarios!A:E'), { headers: H(op.session) });
check('Operario NO lee Operarios dentro de una lectura en lote (403)', lote.status === 403);
const cuerpoLote = JSON.stringify({ valueInputOption: 'RAW', data: [{ range: 'ObservacionesOperarios!A2', values: [['x']] }] });
check('Operario NO escribe llamados de atención en lote (403)', (await req('/sheets/v4/spreadsheets/HOJASEDE/values:batchUpdate',
  { method: 'POST', headers: { ...H(op.session), 'Content-Type': 'application/json' }, body: cuerpoLote })).status === 403);
check('Admin SÍ lee Operarios', (await rango(ad.session, 'Operarios!A:E')) === 200);
check('Operario SÍ lee Observaciones de inventario (no es personal)', (await rango(op.session, 'InventarioEquiposObs!A:C')) === 200);

// Cambios en la hoja Usuarios con el pase ya entregado. El login relee la
// hoja, así que entrar con otra cuenta refresca lo que el proxy sabe.
const op2 = await login('444', '4444'); const ad2 = await login('555', '5555');
check('Pase de Op2 y Ad2 sirven antes del cambio', (await st(op2.session, 'HOJASEDE')) === 200 && (await st(ad2.session, PROY)) === 200);
hojaUsuarios = hojaUsuarios.map(f => f[0] === '444' ? [...f.slice(0, 4), 'NO'] : f[0] === '555' ? [f[0], f[1], f[2], 'operario', 'SI'] : f);
await login('111', '1111');
check('Usuario desactivado pierde el acceso sin esperar a que venza el pase (401)', (await st(op2.session, 'HOJASEDE')) === 401);
check('Admin al que le quitan el rol ya no abre Proyectos (403)', (await st(ad2.session, PROY)) === 403);
check('Los demás siguen entrando', (await st(op.session, 'HOJASEDE')) === 200 && (await st(ad.session, PROY)) === 200);

const f1 = await req('/foto?id=FOTOIDXXXXXXXXXX1', { headers: H(op.session) });
check('/foto entrega la imagen con sesión', f1.status === 200 && f1.headers.get('Content-Type') === 'image/jpeg' && f1.headers.get('Access-Control-Allow-Origin') === O.Origin);
check('/foto sin sesión → 401', (await req('/foto?id=FOTOIDXXXXXXXXXX1')).status === 401);
check('/foto id inválido → 400', (await req('/foto?id=../../etc', { headers: H(op.session) })).status === 400);
check('/foto inexistente → 404', (await req('/foto?id=NOEXISTEXXXXXX', { headers: H(op.session) })).status === 404);

let ok = 0;
for (const r of resultados) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.ok ? '' : '  → ' + JSON.stringify(r.d))); if (r.ok) ok++; }
console.log(`\n${ok}/${resultados.length} pruebas del Worker OK`);
process.exit(ok === resultados.length ? 0 : 1);
