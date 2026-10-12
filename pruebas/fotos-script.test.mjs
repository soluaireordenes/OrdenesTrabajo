// ══════════════════════════════════════════════════════════════════════
// PRUEBAS DEL SCRIPT DE FOTOS (fotos-apps-script.gs) — solo Node
//
// Corre el código real del Apps Script con Google SIMULADO (Drive,
// Utilities, Propiedades) y con pases generados por el código real del
// proxy (/pase-fotos), para comprobar que los dos se entienden. Revisa que
// sin pase válido no se haga nada, que solo se borre lo que está en la
// carpeta de fotos, que solo se suban y entreguen imágenes y PDF.
//
// Cómo correrlas:  node pruebas/fotos-script.test.mjs   (Node 18 o más reciente)
// ══════════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const resultados = [];
const check = (n, ok, d) => resultados.push({ n, ok: !!ok, d });

// ── Google simulado ──
const aBytes = buf => Array.from(new Int8Array(buf.buffer, buf.byteOffset, buf.length)); // como Apps Script: bytes con signo
const deBytes = bytes => Buffer.from(Int8Array.from(bytes).buffer);
function nuevoBlob(bytes, tipo, nombre) {
  return { getBytes: () => bytes, getContentType: () => tipo, getName: () => nombre, getDataAsString: () => deBytes(bytes).toString('utf8') };
}
const iterador = lista => { let i = 0; return { hasNext: () => i < lista.length, next: () => lista[i++] }; };
const drive = { archivos: new Map(), carpetas: new Map() };
function carpeta(id, nombre, padre) {
  const c = { id, nombre, padre, getId: () => id, getName: () => nombre,
    getParents: () => iterador(padre ? [drive.carpetas.get(padre)] : []),
    getFoldersByName: n => iterador([...drive.carpetas.values()].filter(x => x.padre === id && x.nombre === n)),
    createFolder: n => carpeta('CARP-' + n.replace(/\W/g, ''), n, id),
    createFile: blob => archivo('NUEVO' + (drive.archivos.size + 1) + 'XXXXXXXXXX', blob.getContentType(), id, blob) };
  drive.carpetas.set(id, c); return c;
}
function archivo(id, tipo, padre, blob) {
  const a = { id, tipo, padre, papelera: false, compartido: false,
    getId: () => id, getMimeType: () => tipo,
    getParents: () => iterador(padre ? [drive.carpetas.get(padre)] : []),
    getBlob: () => blob || nuevoBlob(aBytes(Buffer.from('contenido de ' + id)), tipo, id),
    getThumbnail: () => null,
    setTrashed: v => { a.papelera = v; }, setSharing: () => { a.compartido = true; } };
  drive.archivos.set(id, a); return a;
}
carpeta('RAIZFOTOS', 'fotos sede', 'MIDRIVE');
carpeta('MIDRIVE', 'Mi unidad', null);
carpeta('CARP-FOTOSOT', 'FOTOS OT', 'RAIZFOTOS');
archivo('FOTO1', 'image/jpeg', 'CARP-FOTOSOT');
archivo('PDF1', 'application/pdf', 'RAIZFOTOS');
archivo('FOTOVIEJA', 'image/jpeg', 'MIDRIVE');                          // foto vieja fuera de la carpeta
archivo('HOJA1', 'application/vnd.google-apps.spreadsheet', 'MIDRIVE'); // hoja de cálculo de la cuenta

const propiedades = {};
const contexto = vm.createContext({
  console, JSON, Date, Math, String, Array, Object,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => propiedades[k] || null }) },
  Utilities: {
    Charset: { UTF_8: 'UTF-8' },
    base64Encode: bytes => deBytes(bytes).toString('base64'),
    base64Decode: s => aBytes(Buffer.from(s, 'base64')),
    base64EncodeWebSafe: bytes => deBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'), // con relleno "=", como Apps Script
    base64DecodeWebSafe: s => aBytes(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    computeHmacSha256Signature: (valor, clave) => aBytes(crypto.createHmac('sha256', Buffer.from(clave, 'utf8')).update(Buffer.from(valor, 'utf8')).digest()),
    newBlob: (bytes, tipo, nombre) => nuevoBlob(bytes, tipo, nombre),
  },
  DriveApp: {
    Access: { ANYONE_WITH_LINK: 'link' }, Permission: { VIEW: 'view' },
    getFileById: id => { const a = drive.archivos.get(id); if (!a) throw new Error('No existe ' + id); return a; },
    getFolderById: id => { const c = drive.carpetas.get(id); if (!c) throw new Error('No existe la carpeta ' + id); return c; },
  },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => ({ contenido: JSON.parse(t) }) }) },
});
vm.runInContext(fs.readFileSync(path.join(aqui, '..', 'fotos-apps-script.gs'), 'utf8'), contexto);
const get = params => contexto.doGet({ parameter: params }).contenido;
const post = cuerpo => contexto.doPost({ postData: { contents: JSON.stringify(cuerpo) } }).contenido;

// ── Pases reales del proxy ──
const tmp = path.join(os.tmpdir(), `cf-proxy-fotos-${process.pid}.mjs`);
fs.copyFileSync(path.join(aqui, '..', 'proxy-seguridad', 'cloudflare-proxy.js'), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;
fs.unlinkSync(tmp);
const h = p => crypto.createHash('sha256').update(p).digest('hex').toUpperCase();
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
globalThis.fetch = async url => {
  url = String(url);
  if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }));
  return new Response(JSON.stringify({ values: [['Documento', 'PINHash', 'Rol'], ['111', h('1111'), 'operario']] }));
};
const pase = async secreto => {
  const env = { GOOGLE_SA_EMAIL: 'sa@x', GOOGLE_SA_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), SESSION_SECRET: 's', USUARIOS_SHEET_ID: 'HU', FOTOS_SECRETO: secreto };
  const ses = (await (await worker.fetch(new Request('https://w/login', { method: 'POST', body: '{"documento":"111","pin":"1111"}' }), env)).json()).session;
  return (await (await worker.fetch(new Request('https://w/pase-fotos', { headers: { Authorization: 'Bearer ' + ses } }), env)).json()).pase;
};
const PASE = await pase('secreto-fotos');
const PASE_OTRA_CLAVE = await pase('otra-clave');
const vencido = (() => {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const hd = b({ alg: 'HS256', typ: 'JWT' }), bd = b({ doc: '111', exp: Math.floor(Date.now() / 1000) - 60 });
  return hd + '.' + bd + '.' + crypto.createHmac('sha256', 'secreto-fotos').update(hd + '.' + bd).digest('base64url');
})();

// ── Sin configurar ──
check('Sin propiedades: no hace nada y dice qué falta', /FOTOS_SECRETO/.test(get({ id: 'FOTO1', pase: PASE }).mensaje));
propiedades.FOTOS_SECRETO = 'secreto-fotos';
propiedades.CARPETA_ID = 'RAIZFOTOS';

// ── Pase ──
check('Sin pase: no entrega la foto', get({ id: 'FOTO1' }).paseInvalido === true);
check('Pase firmado con otra clave: no', get({ id: 'FOTO1', pase: PASE_OTRA_CLAVE }).paseInvalido === true);
check('Pase vencido: no', get({ id: 'FOTO1', pase: vencido }).paseInvalido === true);
check('Pase alterado: no', get({ id: 'FOTO1', pase: PASE.slice(0, -2) + 'xx' }).paseInvalido === true);
const r1 = get({ id: 'FOTO1', pase: PASE });
check('Con el pase del proxy: entrega la foto', r1.ok && r1.mimeType === 'image/jpeg' && Buffer.from(r1.base64, 'base64').toString() === 'contenido de FOTO1', r1);
check('Sin pase no se sube ni se borra', post({ accion: 'subirFoto', base64: 'AA==', mimeType: 'image/jpeg' }).paseInvalido === true
  && post({ accion: 'eliminarFoto', driveFileId: 'FOTO1' }).paseInvalido === true && !drive.archivos.get('FOTO1').papelera);

// ── Leer ──
check('No entrega hojas de cálculo aunque se conozca su ID', !get({ id: 'HOJA1', pase: PASE }).ok);
check('Entrega PDF y fotos viejas fuera de la carpeta (compatibilidad)', get({ id: 'PDF1', pase: PASE }).ok && get({ id: 'FOTOVIEJA', pase: PASE }).ok);
const lote = get({ ids: 'FOTO1,HOJA1,NOEXISTE', pase: PASE });
check('Lectura en lote: solo fotos, sin tumbarse por una mala', lote.ok && Object.keys(lote.fotos).join() === 'FOTO1', lote);

// ── Borrar ──
check('Borra una foto de la carpeta (subcarpeta incluida)', post({ accion: 'eliminarFoto', pase: PASE, driveFileId: 'FOTO1' }).ok && drive.archivos.get('FOTO1').papelera);
const rHoja = post({ accion: 'eliminarFoto', pase: PASE, driveFileId: 'HOJA1' });
const rVieja = post({ accion: 'eliminarFoto', pase: PASE, driveFileId: 'FOTOVIEJA' });
check('No borra nada fuera de la carpeta de fotos (ni hojas de cálculo)', !rHoja.ok && !rVieja.ok
  && !drive.archivos.get('HOJA1').papelera && !drive.archivos.get('FOTOVIEJA').papelera, { rHoja, rVieja });

// ── Subir ──
const sub = post({ accion: 'subirFoto', pase: PASE, tipo: 'orden', codigo: 'OT-1', nombreArchivo: 'f.jpg', mimeType: 'image/jpeg', base64: Buffer.from('jpg').toString('base64') });
const nuevo = drive.archivos.get(sub.driveFileId);
check('Sube una foto a su subcarpeta, compartida por enlace', sub.ok && nuevo && nuevo.padre === 'CARP-FOTOSOT' && nuevo.compartido
  && sub.urlVer === 'https://drive.google.com/file/d/' + sub.driveFileId + '/view', sub);
const subPdf = post({ accion: 'subirFoto', pase: PASE, tipo: 'novedad', mimeType: 'application/pdf', base64: Buffer.from('%PDF').toString('base64') });
check('Sube un PDF (crea la subcarpeta de novedades si no existe)', subPdf.ok && drive.archivos.get(subPdf.driveFileId).padre === 'CARP-FOTOSNOVEDADES', subPdf);
check('No sube archivos que no son fotos ni PDF', !post({ accion: 'subirFoto', pase: PASE, mimeType: 'text/html', base64: Buffer.from('<script>').toString('base64') }).ok);
check('No sube archivos de más de 15 MB', !post({ accion: 'subirFoto', pase: PASE, mimeType: 'image/jpeg', base64: Buffer.alloc(16 * 1024 * 1024).toString('base64') }).ok);
check('Acción desconocida: no', !post({ accion: 'borrarTodo', pase: PASE }).ok);

let total = 0;
for (const r of resultados) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.ok ? '' : '  → ' + JSON.stringify(r.d))); if (r.ok) total++; }
console.log(`\n${total}/${resultados.length} pruebas del script de fotos OK`);
process.exit(total === resultados.length ? 0 : 1);
