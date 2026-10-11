// ══════════════════════════════════════════════════════════════════════
// PRUEBAS DEL BOT DE WHATSAPP — Codigo-sin-ia.gs + Recordatorios.gs
//
// Carga los dos archivos como los junta Apps Script (un solo espacio de
// nombres) con Google y Meta SIMULADOS: las hojas son arreglos en memoria,
// el reloj se fija a mano y los envíos a WhatsApp solo se anotan. No manda
// ningún mensaje real.
//
//   node pruebas/bot.test.mjs
// ══════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codigo = ['whatsapp-agente/Codigo-sin-ia.gs', 'whatsapp-agente/Recordatorios.gs']
  .map(f => fs.readFileSync(path.join(RAIZ, f), 'utf8')).join('\n;\n');

const resultados = [];
const check = (n, ok, d) => resultados.push({ n, ok: !!ok, d });

const PLAN_COLS = ['TurnoId', 'TurnoNombre', 'HoraInicio', 'HoraFin', 'Dia', 'Orden', 'Hora', 'ActividadId', 'Actividad', 'Huella'];
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const TURNOS = [['turno1', 'Turno 1', '06:00', '14:00'], ['turno2', 'Turno 2', '14:00', '22:00'], ['turno3', 'Turno 3', '22:00', '06:00']];

/** Un plan como el que publica la app: por turno y día, el reporte de datos
 *  y dos actividades. El domingo el turno 2 no tiene nada programado. */
function planDePrueba() {
  const filas = [PLAN_COLS];
  TURNOS.forEach(([id, nombre, hi, hf]) => DIAS.forEach(dia => {
    if (id === 'turno2' && dia === 'domingo') return;
    filas.push([id, nombre, hi, hf, dia, 1, hi, id + '_cp_' + hi.replace(':', ''), 'Reporte de datos de equipos ' + hi, 'h']);
    filas.push([id, nombre, hi, hf, dia, 2, hi, id + '_a_' + dia, 'Actividad A de ' + id + ' el ' + dia, 'h']);
    filas.push([id, nombre, hi, hf, dia, 3, hi, id + '_b_' + dia, 'Actividad B ' + 'x'.repeat(400), 'h']);
  }));
  return filas;
}

function crearEntorno(hojas, ahoraIso) {
  const enviados = [];
  const props = {};
  const cache = {};
  const ahora = new Date(ahoraIso).getTime();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(ahora); else super(...a); }
    static now() { return ahora; }
  }
  const fmt = (d, tz, patron) => {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(d).forEach(x => { p[x.type] = x.value; });
    const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
    return patron.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
      .replace('HH', p.hour).replace('mm', p.minute).replace(/^u$/, String(u));
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Date: FakeDate, JSON, Math, Number, String, Object, Array, RegExp, Error, parseInt, parseFloat, isNaN,
    SpreadsheetApp: { openById: () => ({ getSheetByName: n => hojas[n]
      ? { getDataRange: () => ({ getValues: () => hojas[n].map(f => f.slice()) }) } : null }) },
    Utilities: { formatDate: fmt },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    UrlFetchApp: { fetch: (url, o) => { enviados.push({ url, cuerpo: JSON.parse(o.payload) }); return { getResponseCode: () => 200, getContentText: () => '{}' }; } },
    ContentService: { createTextOutput: t => ({ t }) },
  };
  vm.createContext(ctx);
  vm.runInContext(codigo, ctx);
  props.TOKEN_WHATSAPP = 'tok'; props.ID_NUMERO_WHATSAPP = '123'; props.TOKEN_VERIFICACION = 'v';
  return { ctx, enviados, props, cache };
}

const OPERARIOS = () => [
  ['ID', 'Nombre', 'Numero', 'Turno', 'Activo'],
  ['OP-1', 'Juan Pérez', '573001112233', 'turno1', 'SI'],
  ['OP-2', 'Ana Gómez', '3004445566', 'Mañana', 'SI'],          // 10 dígitos + turno de la sección vieja
  ['OP-3', 'Luis Apagado', '573007778899', 'turno1', 'NO'],     // recordatorio apagado
  ['OP-4', 'Sin Turno', '573000000001', '', 'SI'],
  ['OP-5', 'Noche', '573009990000', 'turno3', 'SI'],
];
const hojasBase = () => ({ CronogramaPlan: planDePrueba(), Operarios: OPERARIOS(),
  CronogramaRegistros: [['Fecha', 'TurnoId', 'ActividadId', 'Realizado']],
  CronogramaActividadesAdicionales: [['Fecha', 'TurnoId', 'ActividadId', 'Descripcion']] });

// 2026-10-12 es lunes. Bogotá = UTC-5.
// 1) Lunes 05:50 → recordatorio del turno 1 (plantilla: nadie ha escrito)
{
  const { ctx, enviados } = crearEntorno(hojasBase(), '2026-10-12T05:50:00-05:00');
  ctx.recordatoriosTurno();
  const a = enviados.map(e => e.cuerpo.to).sort();
  check('05:50 lunes: avisa a los activos del turno 1 (y a 10 dígitos le pone el 57)',
    JSON.stringify(a) === JSON.stringify(['573001112233', '573004445566']), a);
  const t = enviados[0] && enviados[0].cuerpo;
  check('Sin mensaje en 24 h → plantilla con nombre, turno y número de actividades',
    t && t.type === 'template' && t.template.name === 'recordatorio_turno' && t.template.language.code === 'es'
      && JSON.stringify(t.template.components[0].parameters.map(p => p.text)) === JSON.stringify(['Juan', 'Turno 1 (06:00 – 14:00)', '3']), t);
  ctx.recordatoriosTurno();
  check('No repite el recordatorio en la siguiente revisión', enviados.length === 2, enviados.length);
}

// 2) Quien escribió hace poco recibe la lista completa (texto libre)
{
  const { ctx, enviados, props } = crearEntorno(hojasBase(), '2026-10-12T05:55:00-05:00');
  props.REC_ULTIMO_3001112233 = String(new Date('2026-10-11T18:00:00-05:00').getTime());
  ctx.recordatoriosTurno();
  const juan = enviados.find(e => e.cuerpo.to === '573001112233');
  const cuerpo = juan && juan.cuerpo.text && juan.cuerpo.text.body;
  check('Ventana de 24 h abierta → lista completa por texto', juan && juan.cuerpo.type === 'text'
    && /Lunes 12\/10\/2026/.test(cuerpo) && /⬜ Reporte de datos de equipos 06:00/.test(cuerpo) && /Actividad A de turno1 el lunes/.test(cuerpo), cuerpo);
  check('Actividades largas se recortan', cuerpo && /…/.test(cuerpo) && !/x{300}/.test(cuerpo));
  const ana = enviados.find(e => e.cuerpo.to === '573004445566');
  check('A los demás les sigue llegando la plantilla', ana && ana.cuerpo.type === 'template');
}

// 3) Fuera de la ventana de inicio no se manda nada
{
  const { ctx, enviados } = crearEntorno(hojasBase(), '2026-10-12T09:00:00-05:00');
  ctx.recordatoriosTurno();
  check('A media jornada no manda nada', enviados.length === 0, enviados.length);
}

// 4) Turno 3 (cruza la medianoche): 21:50 del lunes
{
  const { ctx, enviados } = crearEntorno(hojasBase(), '2026-10-12T21:50:00-05:00');
  ctx.recordatoriosTurno();
  check('21:50: avisa al turno 3', enviados.length === 1 && enviados[0].cuerpo.to === '573009990000', enviados.map(e => e.cuerpo.to));
}

// 5) Día sin actividades programadas → no molesta
{
  const { ctx, enviados } = crearEntorno(hojasBase(), '2026-10-18T13:50:00-05:00'); // domingo, turno 2
  ctx.recordatoriosTurno();
  check('Turno sin actividades ese día: no manda nada', enviados.length === 0, enviados.length);
}

// 6) ACTIVIDADES: estado marcado, adicionales y fecha del turno de noche
{
  const hojas = hojasBase();
  hojas.CronogramaRegistros.push(
    ['2026-10-12', 'turno3', 'turno3_cp_2200', 'SI'],
    ['2026-10-12', 'turno3', 'turno3_a_lunes', 'SI'],
    ['2026-10-12', 'turno3', 'turno3_a_lunes', 'NO'],       // la desmarcaron: manda la última
    ['2026-10-13', 'turno3', 'turno3_b_martes', 'SI']);      // otra fecha: no cuenta
  hojas.CronogramaActividadesAdicionales.push(['2026-10-12', 'turno3', 'adic_1', 'Cambiar bombillo del pasillo']);
  const { ctx } = crearEntorno(hojas, '2026-10-13T01:30:00-05:00'); // martes 01:30, turno 3 del lunes en curso
  const r = ctx.rec_textoActividades('573009990000');
  check('ACTIVIDADES de madrugada muestra el turno 3 del día en que empezó',
    /Turno 3 \(22:00 – 06:00\)/.test(r) && /Lunes 12\/10\/2026/.test(r) && /Actividad A de turno3 el lunes/.test(r), r);
  check('ACTIVIDADES marca ✅ lo hecho y ⬜ lo desmarcado, con adicionales',
    /✅ Reporte de datos de equipos 22:00/.test(r) && /⬜ Actividad A de turno3/.test(r)
      && /\*Adicionales\*\n⬜ Cambiar bombillo/.test(r) && /1 de 4 hechas/.test(r), r);
  const sinTurno = ctx.rec_textoActividades('573000000001');
  check('Sin turno asignado: avisa y muestra el turno en curso', /No tienes un turno asignado/.test(sinTurno) && /Turno 3/.test(sinTurno), sinTurno);
}

// 7) Mensajes entrantes: botón de la plantilla, registro de la ventana, desconocidos
{
  const { ctx, enviados, props } = crearEntorno(hojasBase(), '2026-10-12T06:10:00-05:00');
  const sobre = m => ({ postData: { contents: JSON.stringify({ entry: [{ changes: [{ value: { messages: [m] } }] }] }) } });
  ctx.doPost(sobre({ id: 'w1', from: '573004445566', type: 'button', button: { text: 'Ver actividades', payload: 'x' } }));
  const resp = enviados[0] && enviados[0].cuerpo;
  check('Botón "Ver actividades" de la plantilla responde con la lista',
    resp && resp.to === '573004445566' && resp.type === 'text' && /Turno 1/.test(resp.text.body) && /Actividad A de turno1 el lunes/.test(resp.text.body), resp);
  check('Queda anotado que escribió (ventana de 24 h)', props.REC_ULTIMO_3004445566 === String(new Date('2026-10-12T06:10:00-05:00').getTime()));
  ctx.doPost(sobre({ id: 'w2', from: '573004445566', type: 'text', text: { body: 'actividades' } }));
  check('La palabra ACTIVIDADES también funciona', enviados[1] && /Actividad A de turno1/.test(enviados[1].cuerpo.text.body));
  ctx.doPost(sobre({ id: 'w3', from: '575555555555', type: 'text', text: { body: 'actividades' } }));
  check('Número desconocido: no se le da nada ni se anota', /no está registrado/.test(enviados[2].cuerpo.text.body) && !props.REC_ULTIMO_5555555555);
  check('La ayuda menciona actividades', /\*actividades\*/.test(ctx._textoAyuda('Juan')));
}

// 8) Instalación y limpieza de marcas viejas
{
  const { ctx, props } = crearEntorno(hojasBase(), '2026-10-12T12:00:00-05:00');
  props['REC_ENVIADO_2026-10-01_turno1_573001112233'] = 'x';
  props['REC_ENVIADO_2026-10-12_turno1_573001112233'] = 'x';
  ctx.rec_borrarMarcasViejas();
  check('Borra marcas de más de 3 días y deja las de hoy',
    !props['REC_ENVIADO_2026-10-01_turno1_573001112233'] && props['REC_ENVIADO_2026-10-12_turno1_573001112233'] === 'x');
}

let ok = 0;
for (const r of resultados) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.ok ? '' : '  → ' + JSON.stringify(r.d))); if (r.ok) ok++; }
console.log(`\n${ok}/${resultados.length} pruebas del bot OK`);
process.exit(ok === resultados.length ? 0 : 1);
