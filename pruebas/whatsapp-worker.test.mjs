// ══════════════════════════════════════════════════════════════════════
// PRUEBAS DEL INTERMEDIARIO DE WHATSAPP (whatsapp-agente/cloudflare-worker.js)
//
// Carga el Worker real con Apps Script SIMULADO (no se conecta a nada) y
// revisa la verificación del webhook y la firma de Meta: con APP_SECRET solo
// pasa lo que Meta firmó; sin APP_SECRET todo sigue como antes. Y del bot
// (Codigo-sin-ia.gs): que reconozca a los operarios por el número completo
// y que sus consultas (stock, mínimos, movimientos, órdenes, próximo
// mantenimiento) respondan lo correcto con hojas simuladas.
//
// Cómo correrlas:  node pruebas/whatsapp-worker.test.mjs   (Node 18 o más reciente)
// ══════════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

// El Worker es un módulo ES con extensión .js: se copia como .mjs temporal
// para poder importarlo sin package.json.
const aqui = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(os.tmpdir(), `cf-whatsapp-prueba-${process.pid}.mjs`);
fs.copyFileSync(path.join(aqui, '..', 'whatsapp-agente', 'cloudflare-worker.js'), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;
fs.unlinkSync(tmp);

const resultados = [];
const check = (n, ok, d) => resultados.push({ n, ok: !!ok, d });

let reenviados = [];
globalThis.fetch = async (url, init = {}) => { reenviados.push({ url: String(url), body: init.body }); return new Response('ok'); };
const ctx = { esperas: [], waitUntil(p) { this.esperas.push(p); } };

const env = { URL_APPS_SCRIPT: 'https://script.google.com/macros/s/X/exec', TOKEN_VERIFICACION: 'palabra', APP_SECRET: 'SECRETO' };
const sinSecreto = { URL_APPS_SCRIPT: env.URL_APPS_SCRIPT, TOKEN_VERIFICACION: env.TOKEN_VERIFICACION };
const cuerpo = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'm1', from: '573001112233', type: 'text', text: { body: 'minimos' } }] } }] }] });
const firmar = (texto, secreto) => 'sha256=' + crypto.createHmac('sha256', secreto).update(texto).digest('hex');
const post = async (cabeceras, e = env, texto = cuerpo) => {
  const r = await worker.fetch(new Request('https://bot.workers.dev/', { method: 'POST', body: texto, headers: cabeceras }), e, ctx);
  await Promise.all(ctx.esperas.splice(0));
  return r.status;
};

// Verificación del webhook (GET)
const get = q => worker.fetch(new Request('https://bot.workers.dev/?' + q), env, ctx);
const ok = await get('hub.mode=subscribe&hub.verify_token=palabra&hub.challenge=123');
check('Verificación con el token correcto devuelve el desafío', ok.status === 200 && (await ok.text()) === '123');
check('Verificación con token incorrecto → 403', (await get('hub.mode=subscribe&hub.verify_token=otra&hub.challenge=1')).status === 403);

// Firma de Meta
reenviados = [];
check('Mensaje con firma correcta pasa a Apps Script', (await post({ 'X-Hub-Signature-256': firmar(cuerpo, 'SECRETO') })) === 200
  && reenviados.length === 1 && reenviados[0].url === env.URL_APPS_SCRIPT && reenviados[0].body === cuerpo, reenviados);
reenviados = [];
check('Firma hecha con otra clave → 401 y no se reenvía', (await post({ 'X-Hub-Signature-256': firmar(cuerpo, 'OTRA') })) === 401 && reenviados.length === 0);
check('Cuerpo alterado después de firmar → 401', (await post({ 'X-Hub-Signature-256': firmar(cuerpo, 'SECRETO') }, env, cuerpo.replace('minimos', 'ordenes'))) === 401 && reenviados.length === 0);
check('Sin firma → 401', (await post({})) === 401 && reenviados.length === 0);

// Sin APP_SECRET: igual que antes
reenviados = [];
check('Sin APP_SECRET se reenvía como antes', (await post({}, sinSecreto)) === 200 && reenviados.length === 1);
check('Faltan variables → 500 con aviso', (await worker.fetch(new Request('https://bot.workers.dev/', { method: 'POST', body: '{}' }), {}, ctx)).status === 500);

// El bot (Codigo-sin-ia.gs): quién es operario. Se corre el código real del
// Apps Script con la hoja "Operarios" simulada.
const filasOperarios = [['Nombre', 'Numero', 'Activo'], ['Ana', '300 111 2233', 'SI'], ['Beto', '+57 310 444 5566', 'SI'],
  ['Caro', '3205556677', 'NO'], ['Dani', '+1 (305) 777-8899', 'SI'], ['Sin número', '', 'SI']];
const bot = vm.createContext({ console, SpreadsheetApp: { openById: () => ({ getSheetByName: () => ({ getDataRange: () => ({ getValues: () => filasOperarios }) }) }) } });
vm.runInContext(fs.readFileSync(path.join(aqui, '..', 'whatsapp-agente', 'Codigo-sin-ia.gs'), 'utf8'), bot);
const quien = n => bot._operarioDe(n);
check('Bot: reconoce al operario con o sin indicativo en la hoja (WhatsApp siempre lo trae)', quien('573001112233') === 'Ana' && quien('573104445566') === 'Beto');
check('Bot: un número de otro país que termina igual que uno de Colombia NO pasa por el operario', quien('13001112233') === null && quien('573057778899') === null && quien('13057778899') === 'Dani');
check('Bot: el inactivo, el desconocido y el vacío no son operarios', quien('573205556677') === null && quien('573009999999') === null && quien('') === null);

// ── Las consultas del bot (auditoría P-02) ──────────────────────────────
// El mismo código real, ahora con los dos libros simulados: el inventario
// (Productos, Movimientos) y el del sistema (Ordenes, HorasEquipos). Cada
// hoja se busca en SU libro: si el bot leyera del libro equivocado, la hoja
// no aparece y la respuesta sale vacía.
const P = (codigo, nombre, unidad, grupo, minimo, ubicacion = '', proveedor = '') => [codigo, nombre, unidad, grupo, minimo, '', '', '', ubicacion, proveedor];
const M = (codigo, fecha, tipo, cantidad, responsable = '', destino = '') => [codigo, fecha, tipo, cantidad, '', '', responsable, destino];
const hojasInventario = {
  Productos: [
    ['Codigo', 'Nombre', 'Unidad', 'Grupo', 'StockMinimo', '', '', '', 'Ubicacion', 'Proveedor'],
    P('FA-200', 'Filtro de aire NX200', 'und', 'Filtros', 2, 'Estante A', 'Compresores SA'),
    P('FC-100', 'Filtro de aceite', 'und', 'Filtros', 1),
    P('AC-46', 'Aceite compresor 46', 'gal', 'Lubricantes', 4),
    P('RD-01', 'Rodamiento 6205', 'und', 'Repuestos', 3, '', 'Rodamientos SAS'),
    P('MG-01', 'Manguera 1/2', 'm', 'Accesorios', 0),
    P('VC-01', 'Válvula check', 'und', 'Accesorios', 0),
    P('CR-01', 'Correa en V', 'und', 'Transmisión', 2),
    ...Array.from({ length: 10 }, (_, i) => P('EM-' + (i + 1), 'Empaque ' + (i + 1), 'und', 'Sellos', 0)),
    ['', 'Fila a medias sin código', 'und', '', 0, '', '', '', '', ''],
  ],
  // Desordenadas a propósito: el FIFO tiene que ordenarlas por fecha. En el
  // orden de la hoja la salida de 8 iría primero, no consumiría nada, y el
  // stock daría 11 en lugar de 3.
  Movimientos: [
    ['Codigo', 'Fecha', 'Tipo', 'Cantidad', '', '', 'Responsable', 'EquipoDestino'],
    M('FA-200', '2026-04-01', 'SALIDA', 8, 'Beto', 'CB2'),
    M('FA-200', '2026-01-05', 'INGRESO', 10, 'Ana'),
    M('fa-200', '2026-03-01', 'INGRESO', 5, 'Ana'),
    M('FA-200', '2026-02-01', 'SALIDA', 4, 'Ana', 'CB1'),
    M('FA-200', '2026-04-10', 'AJUSTE_POSITIVO', 1, 'Caro'),
    M('FA-200', '2026-04-20', 'AJUSTE_NEGATIVO', 1, 'Caro'),
    M('FC-100', '2026-01-01', 'INGRESO', 2),
    M('FC-100', '2026-02-01', 'SALIDA', 5),
    M('AC-46', '2026-01-01', 'INGRESO', 10),
    M('AC-46', '2026-01-20', 'AJUSTE_NEGATIVO', 7),
    M('RD-01', '2026-01-01', 'INGRESO', 5),
    M('RD-01', '2026-03-01', 'SALIDA', 3),
    M('MG-01', '2026-01-01', 'INGRESO', 25.5),
    M('MG-01', '2026-01-02', 'SALIDA', 0.25),
    M('CR-01', '2026-01-01', 'INGRESO', 2),
  ],
};
const hojasSistema = {
  Ordenes: [
    ['NumeroOrden', 'Equipo', 'Title', 'TipoMantenimiento', 'Estado', 'FechaInicio', 'Responsable'],
    ['OT-3', 'CB1', 'Cambio de filtros', 'Preventivo', 'Pendiente', '2026-03-01', 'Ana'],
    ['OT-1', 'CB1', 'Fuga de aceite', 'Correctivo', 'En ejecución', '2026-01-15', ''],
    ['OT-2', 'CB2', 'Revisión general', 'Preventivo', 'Cerrada', '2026-01-10', 'Beto'],
    ['OT-5', 'CB2', 'Ruido en motor', 'Correctivo', 'Aprobada', '2026-02-01', 'Beto'],
  ],
  HorasEquipos: [
    ['Equipo', 'HorasActuales', 'UltimaActualizacion'],
    ['CB1', 24353, '2026-11-18'],
    ['CB2', 3900, ''],
  ],
};
let libros = {};
const consultas = vm.createContext({ console, SpreadsheetApp: { openById: id => ({
  getSheetByName: nombre => { const v = (libros[id] || {})[nombre]; return v ? { getDataRange: () => ({ getValues: () => v }) } : null; },
}) } });
vm.runInContext(fs.readFileSync(path.join(aqui, '..', 'whatsapp-agente', 'Codigo-sin-ia.gs'), 'utf8'), consultas);
libros = { [vm.runInContext('HOJA_INVENTARIO', consultas)]: hojasInventario, [vm.runInContext('HOJA_SISTEMA', consultas)]: hojasSistema };
const B = consultas;

// Qué entiende de cada mensaje
const entiende = t => { const r = B._interpretar(t); return r.comando + (r.texto !== undefined ? ':' + r.texto : ''); };
const comandos = {
  '': 'ayuda', 'Hola': 'ayuda', 'Buenos días': 'ayuda', '¿Mínimos?': 'minimos', 'que falta': 'minimos',
  'movimientos filtro de aire': 'movimientos:filtro de aire', 'Órdenes de CB1': 'ordenes:cb1', 'ordenes': 'ordenes:', 'OTs': 'ordenes:',
  'próximo para CB1': 'proximo:cb1', 'cuanto falta': 'proximo:', 'ficha CB1': 'ficha:cb1', 'lectura del CB1': 'lectura:cb1',
  'resumen de ayer': 'resumen:ayer', 'turno': 'resumen:', '¿Cuánto queda de filtro de aire? ': 'stock:¿Cuánto queda de filtro de aire?',
};
const malEntendidos = Object.entries(comandos).filter(([t, esperado]) => entiende(t) !== esperado).map(([t, e]) => ({ t, esperado: e, dio: entiende(t) }));
check('Bot: interpreta cada comando sin importar tildes, mayúsculas ni signos; lo demás es un producto', !malEntendidos.length, malEntendidos);

// Existencias con el mismo FIFO de la aplicación
const stock = B._stockPorCodigo();
check('Bot: el stock sigue el FIFO por fecha (no el orden de la hoja), suma el código en minúsculas y nunca baja de 0',
  stock['FA-200'] === 3 && stock['FC-100'] === 0 && stock['AC-46'] === 3 && stock['RD-01'] === 2 && stock['MG-01'] === 25.25 && !('fa-200' in stock), stock);

// Cuánto queda de un producto
const uno = B._textoStock('filtro aire');
check('Bot: un producto encontrado muestra cuánto queda, el mínimo, la ubicación y el proveedor',
  uno === '*Filtro de aire NX200* (FA-200)\nQuedan 3 und · mínimo 2\nUbicación: Estante A\nProveedor: Compresores SA', uno);
const agotado = B._textoStock('¿cuánto queda de filtro de aceite?'), bajo = B._textoStock('aceite compresor');
check('Bot: avisa si está agotado o por debajo del mínimo (y descarta el relleno de la pregunta)',
  agotado === '*Filtro de aceite* (FC-100)\nQuedan 0 und · mínimo 1\n⚠ Agotado. Hay que reponer.'
  && bajo === '*Aceite compresor 46* (AC-46)\nQuedan 3 gal · mínimo 4\n⚠ Por debajo del mínimo. Hay que reponer.', { agotado, bajo });
const justo = B._textoStock('correa');
check('Bot: justo en el mínimo también avisa que hay que reponer', justo === '*Correa en V* (CR-01)\nQuedan 2 und · mínimo 2\n⚠ Por debajo del mínimo. Hay que reponer.', justo);
const sinMinimo = B._textoStock('manguera'), porCodigo = B._textoStock('fa-200'), sinTilde = B._textoStock('valvula');
check('Bot: sin mínimo no lo menciona; encuentra por código y sin tildes',
  sinMinimo === '*Manguera 1/2* (MG-01)\nQuedan 25.25 m' && porCodigo.startsWith('*Filtro de aire NX200* (FA-200)') && sinTilde === '*Válvula check* (VC-01)\nQuedan 0 und', { sinMinimo, porCodigo, sinTilde });
const varios = B._textoStock('filtro');
check('Bot: con varios resultados los lista con su stock y marca ⚠ los que hay que reponer',
  varios === 'Encontré 2 productos con "filtro":\n\n• *Filtro de aire NX200* (FA-200): 3 und\n• *Filtro de aceite* (FC-100): 0 und ⚠\n\nPara el detalle de uno, escríbeme su código.', varios);
const muchos = B._textoStock('empaque');
check('Bot: con más de 8 muestra 8 y dice cuántos faltan',
  muchos.startsWith('Encontré 10 productos con "empaque":') && (muchos.match(/^• /gm) || []).length === 8 && muchos.includes('…y 2 más. Afina la búsqueda para verlos.'), muchos);
const nada = B._textoStock('tornillo');
check('Bot: si no encuentra nada lo dice y sugiere cómo buscar', nada.startsWith('No encontré ningún producto con "tornillo".') && nada.includes('*ayuda*'), nada);

// Lo que hay que reponer
const minimos = B._textoMinimos();
check('Bot: "minimos" lista lo que está en o por debajo del mínimo, primero lo más corto frente a su propio mínimo',
  minimos === 'Hay 4 productos por reponer:\n\n• *Filtro de aceite* (FC-100): 0 de 1 und\n• *Rodamiento 6205* (RD-01): 2 de 3 und — Rodamientos SAS\n'
    + '• *Aceite compresor 46* (AC-46): 3 de 4 gal\n• *Correa en V* (CR-01): 2 de 2 und', minimos);

// Últimos movimientos
const movs = B._textoMovimientos('filtro de aire');
check('Bot: "movimientos" muestra los 5 más recientes primero, con destino y responsable',
  movs === 'Últimos movimientos de *Filtro de aire NX200* (FA-200):\n\n'
    + '• 20/04/2026 AJUSTE_NEGATIVO 1 und (Caro)\n• 10/04/2026 AJUSTE_POSITIVO 1 und (Caro)\n• 01/04/2026 SALIDA 8 und → CB2 (Beto)\n'
    + '• 01/03/2026 INGRESO 5 und (Ana)\n• 01/02/2026 SALIDA 4 und → CB1 (Ana)', movs);
const movsVarios = B._textoMovimientos('filtro'), movsNinguno = B._textoMovimientos('valvula');
check('Bot: "movimientos" pide el código si hay varios y avisa si no hay ninguno',
  movsVarios.startsWith('Hay 2 productos con "filtro". Dime cuál con su código:') && movsNinguno === '*Válvula check* (VC-01) no tiene movimientos registrados.', { movsVarios, movsNinguno });

// Órdenes pendientes
const ordCB1 = B._textoOrdenes(B._interpretar('ordenes CB1').texto);
check('Bot: "ordenes CB1" da las pendientes de ese equipo, la más vieja primero, sin las cerradas',
  ordCB1 === '2 órdenes pendientes de CB1:\n\n• *OT-1*\n   Fuga de aceite\n   Correctivo · En ejecución · desde 15/01/2026\n\n'
    + '• *OT-3*\n   Cambio de filtros\n   Preventivo · Pendiente · desde 01/03/2026\n   Responsable: Ana', ordCB1);
const ordTodas = B._textoOrdenes(''), ordNinguna = B._textoOrdenes('CB9');
check('Bot: "ordenes" sin equipo da todas con su equipo; un equipo sin pendientes lo dice',
  ordTodas.startsWith('Hay 3 órdenes pendientes:') && ordTodas.includes('• *OT-1* · CB1') && ordTodas.includes('• *OT-5* · CB2') && !ordTodas.includes('OT-2')
  && ordNinguna.startsWith('No hay órdenes pendientes para "CB9".'), { ordTodas, ordNinguna });

// Próximo mantenimiento
const h = n => n.toLocaleString('es-CO');
const proxCB1 = B._textoProximo('cb1'), proxTodos = B._textoProximo('');
check('Bot: "proximo CB1" calcula cada mantenimiento desde las horas actuales',
  proxCB1 === `*CB1*: ${h(24353)} h\n\nTrimestral a las ${h(26000)} h → faltan ${h(1647)} h\nSemestral a las ${h(28000)} h → faltan ${h(3647)} h\nAnual a las ${h(32000)} h → faltan ${h(7647)} h\n\nÚltima actualización: 18/11/2026`, proxCB1);
check('Bot: "proximo" sin equipo pone primero el que está por cumplirse y lo marca ⚠',
  proxTodos === `Próximo mantenimiento de cada equipo:\n\n• *CB2* · ${h(3900)} h\n   Semestral a las ${h(4000)} h → faltan 100 h ⚠\n• *CB1* · ${h(24353)} h\n   Trimestral a las ${h(26000)} h → faltan ${h(1647)} h`, proxTodos);

// De punta a punta: _responder elige la respuesta según el mensaje
check('Bot: _responder saluda con el nombre del operario y lleva cada mensaje a su consulta',
  B._responder('Ana', 'hola').startsWith('Hola Ana.') && B._responder('Ana', 'Mínimos') === minimos && B._responder('Ana', 'filtro aire') === uno
  && B._responder('Ana', 'ordenes cb1') === ordCB1);

let total = 0;
for (const r of resultados) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.ok ? '' : '  → ' + JSON.stringify(r.d))); if (r.ok) total++; }
console.log(`\n${total}/${resultados.length} pruebas del intermediario de WhatsApp OK`);
process.exit(total === resultados.length ? 0 : 1);
