// ══════════════════════════════════════════════════════════════════════
// PRUEBAS DEL PROXY (proxy-seguridad/cloudflare-proxy.js) — solo Node
//
// Cargan el Worker real con Google SIMULADO (no se conecta a nada) y revisan:
// login y bloqueo por intentos, pases de sesión, cupo por persona (quotaUser),
// permisos por rol (Proyectos, Usuarios, Config), ruta /foto y que /diag ya
// no exista. Se usa una llave RSA falsa generada en el momento.
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
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'TOKEN_SA', expires_in: 3600 }));
  if (url.includes('HOJAUSUARIOS')) return new Response(JSON.stringify({ values: [['Documento', 'Nombre', 'PINHash', 'Rol', 'Activo'],
    ['111', 'Op', h('1111'), 'operario', 'SI'], ['222', 'Ad', h('2222'), 'admin', 'SI'], ['333', 'Inactivo', h('3333'), 'operario', 'NO']] }));
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
check('Operario NO escribe en Operarios! (encargados del bot, 403)', (await st(op.session, 'HOJASEDE', 'POST', 'Operarios!A:E')) === 403);
check('Admin SÍ escribe en Operarios!', (await st(ad.session, 'HOJASEDE', 'POST', 'Operarios!A:E')) === 200);
check('Operario SÍ escribe en ObservacionesOperarios! (otra hoja)', (await st(op.session, 'HOJASEDE', 'POST', 'ObservacionesOperarios!A:H')) === 200);
check('Operario SÍ lee/escribe hojas de su sede', (await st(op.session, 'HOJASEDE')) === 200 && (await st(op.session, 'HOJASEDE', 'POST', 'Ordenes!A1')) === 200);

const f1 = await req('/foto?id=FOTOIDXXXXXXXXXX1', { headers: H(op.session) });
check('/foto entrega la imagen con sesión', f1.status === 200 && f1.headers.get('Content-Type') === 'image/jpeg' && f1.headers.get('Access-Control-Allow-Origin') === O.Origin);
check('/foto sin sesión → 401', (await req('/foto?id=FOTOIDXXXXXXXXXX1')).status === 401);
check('/foto id inválido → 400', (await req('/foto?id=../../etc', { headers: H(op.session) })).status === 400);
check('/foto inexistente → 404', (await req('/foto?id=NOEXISTEXXXXXX', { headers: H(op.session) })).status === 404);

let ok = 0;
for (const r of resultados) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.ok ? '' : '  → ' + JSON.stringify(r.d))); if (r.ok) ok++; }
console.log(`\n${ok}/${resultados.length} pruebas del Worker OK`);
process.exit(ok === resultados.length ? 0 : 1);
