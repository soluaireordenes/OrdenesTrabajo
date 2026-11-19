// ══════════════════════════════════════════════════════════════════════
// PRUEBAS DEL SCRIPT DE RESPALDO (respaldo-apps-script.gs) — solo Node
//
// Corre el código real del Apps Script con Google SIMULADO (Drive,
// propiedades, disparadores, correo) y revisa que copie todas las hojas de
// la app a la carpeta del día, que no duplique copias si se corre dos veces,
// que borre solo los respaldos de más de 30 días, que avise por correo si
// una hoja no se pudo copiar (sin borrar los respaldos viejos ese día) y que
// la lista de hojas del script tenga todas las que usa index.html.
//
// Cómo correrlas:  node pruebas/respaldo-script.test.mjs   (Node 18 o más reciente)
// ══════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raizRepo = path.join(aqui, '..');
const codigo = fs.readFileSync(path.join(raizRepo, 'respaldo-apps-script.gs'), 'utf8');
const resultados = [];
const check = (n, ok, d) => resultados.push({ n, ok: !!ok, d });

const iterador = lista => { let i = 0; return { hasNext: () => i < lista.length, next: () => lista[i++] }; };

// ── Google simulado ──
function nuevoGoogle({ propiedades = {}, sinAcceso = [], hoy = '2026-11-18' } = {}) {
  const drive = { carpetas: new Map(), archivos: [], correos: [], disparadores: [], registro: [] };
  let sig = 1;
  const carpeta = (id, nombre, padre) => {
    const c = { id, nombre, padre, papelera: false,
      getId: () => id, getName: () => nombre, setTrashed: v => { c.papelera = v; },
      getFoldersByName: n => iterador([...drive.carpetas.values()].filter(x => x.padre === id && x.nombre === n && !x.papelera)),
      getFolders: () => iterador([...drive.carpetas.values()].filter(x => x.padre === id && !x.papelera)),
      getFilesByName: n => iterador(drive.archivos.filter(a => a.padre === id && a.nombre === n && !a.papelera)),
      createFolder: n => carpeta('C' + sig++, n, id) };
    drive.carpetas.set(id, c); return c;
  };
  carpeta('RESPALDOS', 'Respaldos SolucionAIRE', null);
  const originales = id => {
    if (sinAcceso.includes(id)) throw new Error('No tienes permiso para acceder al archivo solicitado.');
    return { getName: () => 'Hoja ' + id.slice(0, 6),
      makeCopy: (nombre, destino) => { const a = { nombre, padre: destino.getId(), de: id, papelera: false, setTrashed: v => { a.papelera = v; } }; drive.archivos.push(a); return a; } };
  };
  const ctx = vm.createContext({
    console: { log: m => drive.registro.push(String(m)) }, JSON, Date, Math, String, Array, Object, parseInt,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => propiedades[k] || null }) },
    Session: { getScriptTimeZone: () => 'America/Bogota', getEffectiveUser: () => ({ getEmail: () => 'duenio@ejemplo.com' }) },
    Utilities: { formatDate: () => hoy },
    DriveApp: {
      getFolderById: id => { const c = drive.carpetas.get(id); if (!c) throw new Error('No existe la carpeta ' + id); return c; },
      getFileById: originales,
    },
    MailApp: { sendEmail: (para, asunto, cuerpo) => drive.correos.push({ para, asunto, cuerpo }) },
    ScriptApp: {
      getProjectTriggers: () => drive.disparadores.slice(),
      deleteTrigger: t => { drive.disparadores = drive.disparadores.filter(x => x !== t); },
      newTrigger: fn => { const t = { fn, getHandlerFunction: () => fn }; const b = { timeBased: () => b, everyDays: d => { t.cada = d; return b; }, atHour: h => { t.hora = h; return b; }, create: () => { drive.disparadores.push(t); return t; } }; return b; },
    },
  });
  vm.runInContext(codigo, ctx, { filename: path.join(raizRepo, 'respaldo-apps-script.gs') }); // el nombre, para la cobertura
  return { ctx, drive, carpeta };
}

const HOJAS = vm.runInContext('HOJAS_RESPALDO', nuevoGoogle().ctx).map(h => h.id);

// 1) Las hojas del script son todas las que usa la app.
{
  const html = fs.readFileSync(path.join(raizRepo, 'index.html'), 'utf8');
  const bloque = nombre => (html.match(new RegExp('const ' + nombre + ' = \\{([\\s\\S]*?)\\n\\};')) || [])[1] || '';
  const ids = new Set([
    ...[...bloque('OPERACIONES').matchAll(/spreadsheetId: '([^']+)'/g)].map(m => m[1]),
    ...[...bloque('INVENTARIO_SHEETS').matchAll(/'([A-Za-z0-9_-]{30,})'/g)].map(m => m[1]),
    ...[...html.matchAll(/const PROY_SPREADSHEET_ID = '([^']+)'/g)].map(m => m[1]),
  ]);
  const faltan = [...ids].filter(id => !HOJAS.includes(id));
  check('Las hojas del respaldo son todas las que usa la app (órdenes e inventario de las 6 sedes y Proyectos)', ids.size === 13 && !faltan.length && HOJAS.length === 13, { enApp: ids.size, faltan });
}

// 2) Respaldo normal: carpeta del día con una copia de cada hoja (y las extra), sin correo.
{
  const { ctx, drive } = nuevoGoogle({ propiedades: { CARPETA_RESPALDO_ID: 'RESPALDOS', HOJAS_EXTRA: ' USUARIOS123 , ' + HOJAS[0] } });
  const r = vm.runInContext('respaldarAhora()', ctx);
  const dia = [...drive.carpetas.values()].find(c => c.nombre === 'Respaldo 2026-11-18');
  const copias = drive.archivos.filter(a => a.padre === dia?.id && !a.papelera);
  check('Respaldo: crea "Respaldo 2026-11-18" con una copia de cada hoja, más Usuarios (HOJAS_EXTRA, sin repetir)',
    dia && copias.length === 14 && r.copiadas === 14 && copias.some(a => a.de === 'USUARIOS123' && /^Extra 1 · /.test(a.nombre))
    && copias.some(a => a.nombre === 'Ordenes Zipaquira · Hoja 1_gIoY'), { n: copias.length, r });
  check('Respaldo: sin fallas no manda correo y deja el resumen en el registro', !drive.correos.length && /14 hojas copiadas/.test(drive.registro.join('\n')), drive.registro);
  // 3) Segunda corrida el mismo día: misma carpeta, sin copias repetidas.
  vm.runInContext('respaldarAhora()', ctx);
  const dias = [...drive.carpetas.values()].filter(c => c.nombre === 'Respaldo 2026-11-18');
  const vivas = drive.archivos.filter(a => a.padre === dia.id && !a.papelera);
  check('Respaldo: correrlo dos veces el mismo día no duplica la carpeta ni las copias', dias.length === 1 && vivas.length === 14, { carpetas: dias.length, copias: vivas.length });
}

// 4) Retención: van a la papelera los de más de 30 días; lo demás queda.
{
  const { ctx, drive, carpeta } = nuevoGoogle({ propiedades: { CARPETA_RESPALDO_ID: 'RESPALDOS' } });
  for (const [id, n] of [['V1', 'Respaldo 2026-10-18'], ['V2', 'Respaldo 2026-09-01'], ['R1', 'Respaldo 2026-10-19'], ['R2', 'Respaldo 2026-11-17'], ['OTRA', 'Fotos viejas 2020-01-01']]) carpeta(id, n, 'RESPALDOS');
  const r = vm.runInContext('respaldarAhora()', ctx);
  const papelera = id => drive.carpetas.get(id).papelera;
  check('Respaldo: borra solo los de más de 30 días y no toca otras carpetas',
    papelera('V1') && papelera('V2') && !papelera('R1') && !papelera('R2') && !papelera('OTRA') && r.borradas.length === 2, r.borradas);
  const { ctx: ctx7, carpeta: carpeta7, drive: drive7 } = nuevoGoogle({ propiedades: { CARPETA_RESPALDO_ID: 'RESPALDOS', DIAS_RETENCION: '7' } });
  carpeta7('S1', 'Respaldo 2026-11-10', 'RESPALDOS'); carpeta7('S2', 'Respaldo 2026-11-11', 'RESPALDOS');
  vm.runInContext('respaldarAhora()', ctx7);
  check('Respaldo: DIAS_RETENCION cambia cuántos días se guardan', drive7.carpetas.get('S1').papelera && !drive7.carpetas.get('S2').papelera);
}

// 5) Una hoja sin acceso: las demás se copian, llega el correo, la ejecución
//    queda fallida y ese día no se borran respaldos viejos.
{
  const { ctx, drive, carpeta } = nuevoGoogle({ propiedades: { CARPETA_RESPALDO_ID: 'RESPALDOS' }, sinAcceso: [HOJAS[4]] });
  carpeta('V1', 'Respaldo 2026-09-01', 'RESPALDOS');
  let error = '';
  try { vm.runInContext('respaldarAhora()', ctx); } catch (e) { error = e.message; }
  const copias = drive.archivos.filter(a => !a.papelera).length;
  const correo = drive.correos[0] || {};
  check('Respaldo: si una hoja falla, copia las demás y avisa por correo a la cuenta dueña con cuál y por qué',
    copias === 12 && drive.correos.length === 1 && correo.para === 'duenio@ejemplo.com' && /quedó incompleto/.test(correo.asunto)
    && /Ordenes Mexico/.test(correo.cuerpo) && /No tienes permiso/.test(correo.cuerpo), { copias, correo });
  check('Respaldo: con una falla la ejecución queda marcada como fallida y no borra respaldos viejos',
    /Respaldo incompleto: 1 hoja/.test(error) && !drive.carpetas.get('V1').papelera, error);
  const { ctx: ctxC, drive: driveC } = nuevoGoogle({ propiedades: { CARPETA_RESPALDO_ID: 'RESPALDOS', CORREO_AVISO: 'mantenimiento@ejemplo.com' }, sinAcceso: [HOJAS[0]] });
  try { vm.runInContext('respaldarAhora()', ctxC); } catch (_) {}
  check('Respaldo: CORREO_AVISO cambia a quién se avisa', driveC.correos[0]?.para === 'mantenimiento@ejemplo.com');
}

// 6) Configuración y disparador.
{
  const { ctx } = nuevoGoogle();
  let error = '';
  try { vm.runInContext('respaldarAhora()', ctx); } catch (e) { error = e.message; }
  check('Respaldo: sin CARPETA_RESPALDO_ID dice qué propiedad falta', /Falta la propiedad "CARPETA_RESPALDO_ID"/.test(error), error);
  const g = nuevoGoogle({ propiedades: { CARPETA_RESPALDO_ID: 'RESPALDOS' } });
  vm.runInContext('instalarRespaldoNocturno(); instalarRespaldoNocturno();', g.ctx);
  const t = g.drive.disparadores;
  check('Respaldo: instalarRespaldoNocturno deja un solo disparador diario a las 2 a.m. aunque se corra dos veces',
    t.length === 1 && t[0].fn === 'respaldarAhora' && t[0].cada === 1 && t[0].hora === 2, t);
  const ok = vm.runInContext('probarConfiguracion()', g.ctx);
  check('Respaldo: probarConfiguracion confirma la carpeta, las hojas y el disparador', ok === true && /Todo listo.*Hojas: 13\. El respaldo nocturno está programado/.test(g.drive.registro.join('\n')), g.drive.registro);
  const sin = nuevoGoogle({ propiedades: { CARPETA_RESPALDO_ID: 'RESPALDOS' }, sinAcceso: [HOJAS[12]] });
  const malo = vm.runInContext('probarConfiguracion()', sin.ctx);
  check('Respaldo: probarConfiguracion dice qué hoja no puede abrir esta cuenta', malo === false && /no puede abrir 1 hoja\(s\):\nProyectos/.test(sin.drive.registro.join('\n')), sin.drive.registro);
}

let ok = 0;
for (const x of resultados) { console.log((x.ok ? 'PASS ' : 'FAIL ') + x.n + (x.ok ? '' : '  → ' + JSON.stringify(x.d))); if (x.ok) ok++; }
console.log(`\n${ok}/${resultados.length} pruebas del script de respaldo OK`);
process.exit(ok === resultados.length ? 0 : 1);
