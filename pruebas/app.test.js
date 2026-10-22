// ══════════════════════════════════════════════════════════════════════
// PRUEBAS DE LA APP (index.html) — Playwright + Chromium
//
// Abren la app en un navegador real con Google y el proxy SIMULADOS (no toca
// datos reales) y revisan los flujos principales: carga, login por el proxy,
// roles operario/admin, fotos, reintento por cuota, informe del cronograma,
// inventario de herramienta y repuestos de la Hoja de Vida.
//
// Cómo correrlas (ver pruebas/README.md):
//   npm install --no-save playwright && npx playwright install chromium
//   node pruebas/app.test.js
// Variables opcionales:
//   PLAYWRIGHT_MODULE  ruta del paquete playwright (si está instalado global)
//   CHROMIUM_PATH      ruta de un Chromium ya instalado
// ══════════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const http = require('http');

let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); }
catch (e) {
  console.error('Falta Playwright. Instálalo con:  npm install --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

// Servidor local que sirve la raíz del repositorio (index.html, sw.js, íconos…).
const RAIZ = path.resolve(__dirname, '..');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml' };
function iniciarServidor() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const ruta = path.join(RAIZ, decodeURIComponent(req.url.split('?')[0]));
      if (!ruta.startsWith(RAIZ) || !fs.existsSync(ruta) || fs.statSync(ruta).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(ruta)] || 'application/octet-stream' });
      fs.createReadStream(ruta).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
let BASE;
const resultados = [];
function check(nombre, ok, detalle) { resultados.push({ nombre, ok: !!ok, detalle }); }

async function nuevaPagina(b, rutas = {}) {
  const ctx = await b.newContext();
  const errs = [];
  // Nada sale al proxy real de producción (en GitHub sí hay internet): lo que
  // una prueba no simule responde como un proxy sin esa ruta. Playwright usa
  // primero la última ruta registrada, así que las de cada prueba mandan.
  await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false,"mensaje":"Ruta no encontrada."}' }));
  await ctx.route('**/pase-fotos', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pase: 'PASE.prueba.firma', exp: Math.floor(Date.now() / 1000) + 3600 }) }));
  for (const [patron, fn] of Object.entries(rutas)) await ctx.route(patron, fn);
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE, { waitUntil: 'load' });
  await p.waitForTimeout(500);
  return { ctx, p, errs };
}

/** Google Sheets en memoria, para las pruebas que escriben y vuelven a leer.
 *  Atiende lo que usa la app: leer rangos, escribir, anexar, crear pestañas y
 *  borrar filas. Un libro por spreadsheetId. Como en Google, cada pestaña
 *  tiene su cuadrícula (rowCount): nace con 1.000 filas y anexar INSERTA
 *  filas, así que las vacías del principio quedan siempre al final. */
function sheetsEnMemoria() {
  const libros = {};
  const peticiones = [];
  let sigId = 1;
  const libro = id => (libros[id] = libros[id] || { pestanas: {} });
  const colANum = l => l.toUpperCase().split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const rango = txt => {
    const [conComillas, r = ''] = txt.split('!');
    const hoja = conComillas.replace(/^'(.*)'$/, '$1').replace(/''/g, "'"); // 'Mi hoja'!A1, como en Google
    const m = r.match(/^([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/i) || [];
    const fila = m[2] ? Number(m[2]) - 1 : 0;
    return { hoja, fila, col: m[1] ? colANum(m[1]) : 0,
      filaFin: m[4] ? Number(m[4]) - 1 : (m[2] && m[3] === undefined ? fila : Infinity),
      colFin: m[3] ? colANum(m[3]) : (m[1] && m[3] === undefined ? colANum(m[1]) : Infinity) };
  };
  const escribir = (L, txt, valores) => {
    const r = rango(txt); const p = L.pestanas[r.hoja];
    valores.forEach((fila, i) => {
      const destino = (p.filas[r.fila + i] = p.filas[r.fila + i] || []);
      fila.forEach((v, j) => { destino[r.col + j] = String(v); });
    });
    for (let k = 0; k < p.filas.length; k++) p.filas[k] = p.filas[k] || [];
    p.grid = Math.max(p.grid, p.filas.length);
  };
  const columnas = p => Math.max(26, ...p.filas.map(f => f.length));
  const route = async route => {
    const req = route.request();
    const url = decodeURIComponent(req.url());
    const [, id, resto] = url.match(/\/v4\/spreadsheets\/([^/?:]+)(.*)$/);
    const L = libro(id);
    const cuerpo = req.postData() ? JSON.parse(req.postData()) : null;
    const json = (status, b) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    peticiones.push({ libro: id, metodo: req.method(), ruta: resto });
    if (!resto || resto.startsWith('?')) return json(200, { properties: { title: 'Libro ' + id },
      sheets: Object.entries(L.pestanas).map(([title, p]) => ({ properties: { sheetId: p.id, title, gridProperties: { rowCount: p.grid, columnCount: columnas(p) } } })) });
    if (resto.startsWith(':batchUpdate')) {
      for (const rq of cuerpo.requests || []) {
        if (rq.addSheet) {
          const t = rq.addSheet.properties.title;
          if (L.pestanas[t]) return json(400, { error: { message: `A sheet with the name "${t}" already exists.` } });
          L.pestanas[t] = { id: sigId++, filas: [], grid: 1000 };
        }
        if (rq.deleteDimension) {
          const r = rq.deleteDimension.range;
          const pe = Object.values(L.pestanas).find(x => x.id === r.sheetId);
          pe.filas.splice(r.startIndex, r.endIndex - r.startIndex);
          pe.grid -= r.endIndex - r.startIndex;
        }
      }
      return json(200, { replies: [] });
    }
    if (resto.startsWith('/values:batchUpdate')) { cuerpo.data.forEach(d => escribir(L, d.range, d.values)); return json(200, {}); }
    const leer = (p, r) => p.filas.slice(r.fila, r.filaFin === Infinity ? undefined : r.filaFin + 1)
      .map(f => f.slice(r.col, r.colFin === Infinity ? undefined : r.colFin + 1));
    if (resto.startsWith('/values:batchGet')) {
      const rangos = new URL('http://x' + resto).searchParams.getAll('ranges');
      return json(200, { valueRanges: rangos.map(rg => { const r = rango(rg); const p = L.pestanas[r.hoja]; return { range: rg, values: p ? leer(p, r) : [] }; }) });
    }
    const mv = resto.match(/^\/values\/([^?]+?)(:append|:clear)?(\?.*)?$/);
    if (!mv) return json(200, {});
    const r = rango(mv[1]); const p = L.pestanas[r.hoja];
    if (!p) return json(400, { error: { code: 400, message: 'Unable to parse range: ' + mv[1], status: 'INVALID_ARGUMENT' } });
    if (mv[2] === ':clear') { p.filas = p.filas.slice(0, r.fila); return json(200, {}); }
    if (mv[2]) { p.filas.push(...cuerpo.values.map(f => f.map(String))); p.grid += cuerpo.values.length; return json(200, { updates: {} }); }
    if (req.method() === 'PUT') { escribir(L, mv[1], cuerpo.values); return json(200, {}); }
    return json(200, { values: leer(p, r) });
  };
  return {
    route,
    // Por defecto, como una pestaña que creó la app: 1.000 filas de cuadrícula y los datos insertados arriba.
    crear: (id, nombre, filas, grid) => { libro(id).pestanas[nombre] = { id: sigId++, filas: filas.map(f => f.map(String)), grid: grid ?? 1000 + Math.max(0, filas.length - 1) }; },
    peticiones,
    hoja: (id, nombre) => (libros[id] && libros[id].pestanas[nombre] ? libros[id].pestanas[nombre].filas : []),
  };
}

/** Un .xlsx mínimo (un zip con su XML), para probar el lector de Excel de la
 *  app sin Excel. filas: listas de celdas; una celda es texto, número o
 *  { n, estilo } (número con formato de fecha: 1 = dd/mm/yyyy propio del
 *  libro, 2 = el de fecha corta de Excel, 3 = d-mmm, que no muestra el
 *  año). Las partes grandes van
 *  comprimidas, como en un archivo de verdad. */
function xlsxDePrueba(filas) {
  const zlib = require('zlib');
  const crc32 = buf => {
    let crc = 0xFFFFFFFF;
    for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1; }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const textos = [];
  const indice = t => { if (!textos.includes(t)) textos.push(t); return textos.indexOf(t); };
  const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const hoja = filas.map((f, i) => (f ? `<row r="${i + 1}">${f.map((c, j) => {
    const ref = String.fromCharCode(65 + j) + (i + 1);
    if (c === '' || c == null) return '';
    if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
    if (typeof c === 'object') return `<c r="${ref}" s="${c.estilo || 1}"><v>${c.n}</v></c>`;
    return `<c r="${ref}" t="s"><v>${indice(c)}</v></c>`;
  }).join('')}</row>` : '')).join('');
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const partes = [
    ['xl/workbook.xml', `<workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Historial" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/styles.xml', `<styleSheet ${ns}><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/><numFmt numFmtId="165" formatCode="d-mmm"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="165"/></cellXfs></styleSheet>`, true],
    ['xl/worksheets/sheet1.xml', `<worksheet ${ns}><sheetData>${hoja}</sheetData></worksheet>`, true],
  ];
  partes.splice(2, 0, ['xl/sharedStrings.xml', `<sst ${ns}>${textos.map(t => `<si><t>${escXml(t)}</t></si>`).join('')}</sst>`, true]);
  const locales = [], central = [];
  let offset = 0;
  for (const [nombre, texto, comprimir] of partes) {
    const datos = Buffer.from('<?xml version="1.0"?>' + texto, 'utf8');
    const comp = comprimir ? zlib.deflateRawSync(datos) : datos;
    const n = Buffer.from(nombre);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(comprimir ? 8 : 0, 8);
    loc.writeUInt32LE(crc32(datos), 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(datos.length, 22); loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(comprimir ? 8 : 0, 10);
    cen.writeUInt32LE(crc32(datos), 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(datos.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
    locales.push(loc, n, comp); central.push(cen, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(partes.length, 8); fin.writeUInt16LE(partes.length, 10); fin.writeUInt32LE(cd.length, 12); fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, cd, fin]);
}

const JPG_B64 ='/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

(async () => {
  const srv = await iniciarServidor();
  BASE = `http://127.0.0.1:${srv.address().port}/index.html`;
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  // 1) Carga general
  {
    const { ctx, p, errs } = await nuevaPagina(b);
    const r = await p.evaluate(() => {
      const ids = {}; document.querySelectorAll('[id]').forEach(el => ids[el.id] = (ids[el.id] || 0) + 1);
      const fns = ['descargarInformeCronograma','_precargarFotosEnLotes','_obtenerDataUrlFoto','_fotoDesdeProxy','_reducirFotoParaInforme',
        '_cargarMiniaturasFotosCronograma','verInventarioInvh','_invhMarcarCompleta','_invhMarcarIncompleta','guardarInventarioHerramienta',
        'abrirModalNovedad','pmGuardarActividades','esAdmin','_aplicarRolUI','hvdSeleccionarEquipo','_htmlFilaRepuestoHVD','descargarOrdenPDF',
        'renderSidebarOperaciones','leerHojaGenerica','abrirPlanMantenimiento','abrirProyectos','_loginPorProxy','showPanel'];
      const quitados = ['abrirTiempoReal','UBIDOTS_CONFIG','abrirEncargadosTurnos','pmRenderOperarios','_traerLoteFotosServidor',
        '_fotosBatchSoportado','CLAVE_ACCESO_HASH','LOGIN_APPSCRIPT_URL','_loginAppsScript','_tiempoRealIntervalId',
        'exportarInformeIndividual','limpiarOrdenesAutomaticas','subirFotoNovedad','abrirFormFotoNovedad','confirmarSubidaFotoNovedad',
        'OPERARIOS_ZIPAQUIRA','_cronModalOperariosPrevios'];
      let sidebarErr = null; try { renderSidebarOperaciones(); } catch (e) { sidebarErr = e.message; }
      return {
        dups: Object.keys(ids).filter(k => ids[k] > 1),
        faltan: fns.filter(f => typeof window[f] !== 'function'),
        siguen: quitados.filter(s => { try { eval(s); return true; } catch (e) { return false; } }),
        sidebarErr, proxy: PROXY_URL, sheets: SHEETS_API, rol: usuarioRol,
        maxFotos: INFORME_MAX_FOTOS_POR_ACTIVIDAD, casilla: !!document.getElementById('cronInformeConFotos'),
        menuViejo: /TIEMPO REAL|ENCARGADOS TURNOS/i.test(document.body.innerText),
        gsi: !!document.querySelector('script[src*="gsi/client"]'),
      };
    });
    check('Carga sin errores de JS', errs.length === 0, errs.slice(0, 2));
    check('Sin IDs duplicados', r.dups.length === 0, r.dups);
    check('Funciones clave presentes', r.faltan.length === 0, r.faltan);
    check('Código eliminado no reaparece', r.siguen.length === 0, r.siguen);
    check('Menú lateral renderiza', !r.sidebarErr && !r.menuViejo, r.sidebarErr);
    check('Todo Sheets va por el proxy', r.sheets === r.proxy + '/sheets' && r.proxy.includes('workers.dev'), r.proxy);
    check('Rol por defecto = operario', r.rol === 'operario', r.rol);
    check('Informe: 6 fotos y casilla Incluir fotos', r.maxFotos === 6 && r.casilla, r.maxFotos);
    check('No carga librería de login de Google', !r.gsi);
    await ctx.close();
  }

  // 2) Login por el proxy
  {
    let body = null;
    const { ctx, p, errs } = await nuevaPagina(b, {
      '**/login': route => { body = route.request().postData(); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, session: 'SESS.abc', nombre: 'Alex', rol: 'admin', sede: 'zipaquira' }) }); },
      '**/sheets/v4/**': r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"values":[]}' }),
    });
    await p.fill('#loginDocumento', '1234567890'); await p.fill('#loginPin', '0000');
    // Al entrar, la app recarga la página: se espera a que termine de cargar
    // antes de mirar el estado (antes se esperaban 800 ms fijos, y si la
    // carga tardaba más, la consulta caía en la página a medio cargar).
    const recarga = p.waitForEvent('load');
    await p.evaluate(() => loginConDocumentoPinClick()); await recarga; await p.waitForTimeout(300);
    const r = await p.evaluate(() => ({ token: googleAccessToken, rol: usuarioRol, ss: sessionStorage.getItem('gToken') }));
    check('Login por proxy guarda pase y rol', r.token === 'SESS.abc' && r.rol === 'admin' && r.ss === 'SESS.abc' && JSON.parse(body).documento === '1234567890', r);
    check('Login sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }

  // 3) Roles: Dashboard / Nueva orden / Proyectos solo admin
  for (const rol of ['operario', 'admin']) {
    const { ctx, p } = await nuevaPagina(b, { '**/sheets/v4/**': r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"values":[],"sheets":[],"valueRanges":[]}' }) });
    const r = await p.evaluate(async (rol) => {
      const out = { alerts: [], prompts: 0 };
      window.alert = m => out.alerts.push(m); window.prompt = () => { out.prompts++; return null; };
      usuarioRol = rol; _aplicarRolUI(); googleAccessToken = 'SESS'; operacionAutenticada = true; renderSidebarOperaciones();
      const vis = el => !!el && getComputedStyle(el).display !== 'none';
      out.tabs = vis(document.querySelector(".nav-tab[onclick=\"showPanel('nueva')\"]")) || vis(document.querySelector(".nav-tab[onclick=\"showPanel('dashboard')\"]"));
      out.grupoProy = vis([...document.querySelectorAll('.solo-admin')].find(d => /Proyectos/.test(d.textContent)));
      try { await showPanel('dashboard'); } catch (e) {}
      out.dash = document.getElementById('panel-dashboard').classList.contains('active');
      try { await showPanel('nueva'); } catch (e) {}
      out.nueva = document.getElementById('panel-nueva').classList.contains('active');
      try { await abrirProyectos(); } catch (e) {}
      out.proy = document.getElementById('panel-proyectos').classList.contains('active');
      // botones de admin de #216 y bloqueos de #218
      out.btnEliminar = vis(document.querySelector('[onclick="eliminarOrdenCompleta()"]'));
      out.filaRepRO = /readonly/.test(_htmlFilaRepuestoHVD({}));
      const antes = out.alerts.length;
      try { abrirModalNovedad(); } catch (e) {} try { registrarNovedadRacha(); } catch (e) {}
      try { await pmGuardarActividades(); } catch (e) {}
      out.alertasNovPM = out.alerts.length - antes;
      document.querySelectorAll('.modal-overlay,.overlay').forEach(x => x.remove());
      return out;
    }, rol);
    if (rol === 'operario') {
      check('Operario: no ve Nueva orden/Dashboard/Proyectos', !r.tabs && !r.grupoProy, r);
      check('Operario: bloqueado al entrar a las 3', !r.dash && !r.nueva && !r.proy && r.alerts.filter(a => /solo para administradores/.test(a)).length === 3 && r.prompts === 0, r.alerts);
      check('Operario: no ve "Eliminar orden"', !r.btnEliminar);
      check('Operario: HVD/repuestos solo lectura', r.filaRepRO);
      check('Operario: novedades y Plan bloqueados', r.alertasNovPM >= 3, r.alertasNovPM);
    } else {
      check('Admin: ve y abre las 3 sin contraseña', r.tabs && r.grupoProy && r.dash && r.nueva && r.proy && r.prompts === 0, r);
      check('Admin: repuestos editables', !r.filaRepRO);
    }
    await ctx.close();
  }

  // 4) Fotos: por proxy primero, respaldo Apps Script
  for (const listo of [true, false]) {
    let proxyCalls = 0, appsCalls = 0, auth = true;
    const jpg = Buffer.from(JPG_B64, 'base64');
    const { ctx, p } = await nuevaPagina(b, {
      '**/foto?id=*': route => { proxyCalls++; if (route.request().headers()['authorization'] !== 'Bearer SESS.x') auth = false;
        return listo ? route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpg }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }); },
      'https://fake-apps/**': route => { appsCalls++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mimeType: 'image/jpeg', base64: JPG_B64 }) }); },
    });
    const r = await p.evaluate(async () => {
      googleAccessToken = 'SESS.x'; window._fotosUrlSede = () => 'https://fake-apps/exec';
      const ids = Array.from({ length: 6 }, (_, i) => 'FOTOIDXXXXXXXXXX' + i);
      await _precargarFotosEnLotes(ids, null, 3);
      return ids.filter(id => (_fotoDataUrlCache[id] || '').startsWith('data:image')).length;
    });
    if (listo) check('Fotos llegan por el proxy (sin Apps Script)', r === 6 && appsCalls === 0 && auth, { r, proxyCalls, appsCalls });
    else check('Si el proxy falla, respaldo por Apps Script', r === 6 && appsCalls === 6 && proxyCalls <= 3, { r, proxyCalls, appsCalls });
    await ctx.close();
  }

  // 5) Reintento ante cuota de Sheets (429)
  {
    let calls = 0;
    const { ctx, p } = await nuevaPagina(b, { '**/sheets/v4/**': route => { calls++; return calls <= 2
      ? route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":{"message":"Quota exceeded"}}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ values: [['A'], ['1']] }) }); } });
    const r = await p.evaluate(async () => { const f = await leerHojaGenerica('X'); return f.length === 1 && f[0].A === '1'; });
    check('Reintenta solo si Google responde "cuota agotada"', r && calls === 3, { calls });
    await ctx.close();
  }

  // 6) Informe del cronograma: normal (6 fotos/actividad), sin fotos, servidor colgado
  for (const modo of ['normal', 'sinfotos', 'colgado']) {
    const { ctx, p } = await nuevaPagina(b);
    const r = await p.evaluate(async (modo) => {
      const c = document.createElement('canvas'); c.width = 800; c.height = 600; c.getContext('2d').fillRect(0, 0, 800, 600);
      const b64 = c.toDataURL('image/jpeg', 0.9).split(',')[1];
      operacionActual = 'zipaquira'; const turno = CRONOGRAMA_POR_SEDE.zipaquira.turnos[0]; const fecha = '2026-10-07'; const dia = _diaSemanaDe(fecha);
      const bloques = turno.checkpoints.flatMap(cp => cp.bloques).filter(x => (x.actividad[dia] || '').trim()).slice(0, 3);
      const regs = {}, fotos = {};
      bloques.forEach((bq, i) => { regs[bq.id] = { realizado: true, realizadoPor: 'x' }; fotos[bq.id] = Array.from({ length: 8 }, (_, k) => ({ driveFileId: modo + i + '_' + k + 'XXXXXXXX' })); });
      _leerTodosRegistrosCronogramaAgrupados = async () => ({ [fecha]: regs }); _leerTodasFotosCronogramaAgrupadas = async () => ({ [fecha]: fotos });
      _leerTodasAdicionalesCronogramaAgrupadas = async () => ({}); _leerTodasEntregasTurnoAgrupadas = async () => ({});
      googleAccessToken = ''; window._fotosUrlSede = () => 'https://fake/exec';
      let reqs = 0; window.fetch = (url, opts) => { reqs++;
        if (modo === 'colgado') return new Promise((res, rej) => { opts && opts.signal && opts.signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); }); });
        return Promise.resolve(new Response(JSON.stringify({ ok: true, mimeType: 'image/jpeg', base64: b64 }), { status: 200 })); };
      let html = null; _entregarDocumentoImprimible = h => { html = h; }; _esNavegadorMovil = () => true; window.alert = m => { html = 'ALERT:' + m; };
      document.getElementById('cronInformeDesde').value = fecha; document.getElementById('cronInformeHasta').value = fecha;
      const sel = document.getElementById('cronInformeTurno'); sel.innerHTML = `<option value="${turno.id}">t</option>`; sel.value = turno.id;
      document.getElementById('cronInformeConFotos').checked = modo !== 'sinfotos';
      const btn = document.getElementById('btnDescargarInformeCron');
      const t0 = Date.now(); await descargarInformeCronograma(btn);
      return { ms: Date.now() - t0, reqs, imgs: ((html || '').match(/<img src="data:image/g) || []).length, notas: ((html || '').match(/2 fotos más/g) || []).length,
        generado: !!html && !html.startsWith('ALERT'), n: bloques.length, btn: btn.textContent.trim() };
    }, modo);
    if (modo === 'normal') check('Informe: 6 fotos por actividad + nota de sobrantes', r.generado && r.imgs === r.n * 6 && r.notas === r.n && r.btn === 'Descargar', r);
    if (modo === 'sinfotos') check('Informe sin fotos: al instante y sin pedir fotos', r.generado && r.reqs === 0 && r.imgs === 0 && r.ms < 3000, r);
    if (modo === 'colgado') check('Informe con servidor colgado: igual se genera (~45 s)', r.generado && r.imgs === 0 && r.ms >= 44000 && r.ms < 50000, r);
    await ctx.close();
  }

  // 7) Inventario de herramienta + ver inspección
  {
    const { ctx, p } = await nuevaPagina(b);
    const r = await p.evaluate(() => {
      renderInventarioHerramienta(); _recalcularResumenInvh();
      const it = INVENTARIO_HERRAMIENTA[0].items[0]; const n = it.n;
      const out = { dosBotones: !!document.getElementById('invh_btnC_' + n) && !!document.getElementById('invh_btnI_' + n) };
      _invhMarcarIncompleta(n); document.getElementById('invh_faltan_' + n).value = '1'; _recalcularResumenInvh();
      const f = _invhFaltantesActuales()[0]; out.faltante = f && f.faltan === 1 && f.encontradas === it.cant - 1;
      _invhMarcarCompleta(n); out.vuelveCompleto = /COMPLETO/.test(document.getElementById('invh_resumen').textContent);
      allInventarioHerramientaReg = [{ Fecha: '2026-10-06', Turno: 'T1', RegistradoPor: 'D', FechaHora: 'FH1', Tipo: 'RESUMEN', Completo: 'NO', TotalFaltantes: '2' }];
      allInventarioHerramientaDet = [
        { FechaHora: 'FH1', HerramientaN: '8', Herramienta: 'Tijera', CantEsperada: '1', CantEncontrada: '0', Faltan: '1', Problema: 'Perdida' },
        { FechaHora: 'FH1', HerramientaN: '5', Herramienta: 'Cuchillo', CantEsperada: '2', CantEncontrada: '1', Faltan: '1', Problema: '' }];
      if (!document.getElementById('invh_historialWrap')) { const d = document.createElement('div'); d.id = 'invh_historialWrap'; document.body.appendChild(d); }
      renderHistorialInvh(); verInventarioInvh('FH1');
      const ov = document.querySelector('.invh-modal-ov'); const t = ov ? ov.innerText : '';
      out.inspeccion = !!ov && /Perdida/.test(t) && /Sin novedad reportada/.test(t) && /Estado/.test(t);
      if (ov) ov.remove();
      return out;
    });
    check('Inventario: botones Completa/Incompleta y faltantes', r.dosBotones && r.faltante && r.vuelveCompleto, r);
    check('Ver inspección con columna Estado', r.inspeccion, r);
    await ctx.close();
  }

  // 8) Repuestos de la Hoja de Vida (sin Ubicación; con N° de parte, crítico, bodega y proveedor)
  {
    const { ctx, p } = await nuevaPagina(b);
    const r = await p.evaluate(() => {
      usuarioRol = 'admin';
      const host = document.createElement('div');
      host.innerHTML = `<table><tbody id="hvd_tbody_repuestos">${_htmlFilaRepuestoHVD({ codigo: 'C1', nombre: 'Filtro', cantidad: '2', ubicacion: 'B', observacion: 'o', numeroParte: 'P-9', critico: true, bodega: 'Comprar', proveedor: 'Prov' })}</tbody></table>`;
      document.body.appendChild(host);
      const leido = _leerRepuestosEditorHVD()[0];
      return { campos: [...host.querySelectorAll('[data-campo]')].map(e => e.dataset.campo).join(','), leido };
    });
    check('Repuestos HVD: código, repuesto, N° de parte, cantidad, crítico, bodega, proveedor y observación (sin Ubicación)',
      r.campos === 'codigo,nombre,numeroParte,cantidad,critico,bodega,proveedor,observacion' && r.leido.cantidad === '2' && r.leido.ubicacion === ''
      && r.leido.observacion === 'o' && r.leido.numeroParte === 'P-9' && r.leido.critico === true && r.leido.bodega === 'Comprar' && r.leido.proveedor === 'Prov', r);
    await ctx.close();
  }

  // 9) Permisos de la auditoría: lo que quedó solo para admin
  for (const rol of ['operario', 'admin']) {
    const { ctx, p } = await nuevaPagina(b, { '**/sheets/v4/**': r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"values":[],"sheets":[],"valueRanges":[]}' }) });
    const r = await p.evaluate(async (rol) => {
      const out = { alerts: [] };
      window.alert = m => out.alerts.push(String(m)); window.confirmarAccion = async () => false; window.prompt = () => null;
      usuarioRol = rol; _aplicarRolUI(); googleAccessToken = 'SESS'; operacionAutenticada = true;
      sidebarGrupoExpandido.herramientas = true; renderSidebarOperaciones(); // "Reparar hoja" va en Herramientas
      const vis = el => !!el && getComputedStyle(el).display !== 'none';
      const menu = document.getElementById('sidebarOperaciones').innerText;
      out.menuNueva = /Nueva Orden/.test(menu); out.menuDash = /Dashboard/.test(menu);
      out.reparar = vis(document.querySelector('[onclick="repararHoja()"]'));
      const tabObs = document.getElementById('cronTabObservaciones'); tabObs.style.display = '';
      out.tabObs = vis(tabObs);
      _filtrarReportesPorFecha = l => l;
      allReportesSecadores = [{ Codigo: 'RS-1', Fecha: '2026-10-01', Hora: '6:00 a.m.', Secador: 'S', Tecnico: 'T' }];
      renderTablaReportesSecadores();
      out.borrarReporte = vis(document.querySelector('#rs_tablaWrap button[onclick^="eliminarReporteSecador"]'));
      out.cards = ['ie_codificacion', 'ieobs_codificacion', 'invs_codigo', 'prov_nombre'].map(id => vis(document.getElementById(id).closest('.card')));
      if (rol === 'operario') {
        const antes = out.alerts.length;
        for (const fn of [() => eliminarReporteSecador('RS-1'), () => eliminarEntregaTurno('X'), () => eliminarFechaRacha('2026-01-01'),
                          () => guardarObservacionOperario(), () => registrarInventarioEquipo(), () => agregarObservacionEquipo(),
                          () => invRegistrarServicio(), () => invRegistrarProveedor(), () => repararHoja()]) {
          try { await fn(); } catch (e) {}
        }
        out.bloqueos = out.alerts.slice(antes).filter(a => /Solo un administrador/.test(a)).length;
        cronMostrarSubTab('observaciones');
        out.obsAbierta = document.getElementById('cronSub-observaciones').classList.contains('active');
      }
      return out;
    }, rol);
    if (rol === 'operario') {
      check('Operario: el menú lateral no muestra Nueva Orden ni Dashboard', !r.menuNueva && !r.menuDash, r);
      check('Operario: no ve Reparar hoja, Observaciones, borrar reportes ni registrar equipos/servicios/proveedores',
        !r.reparar && !r.tabObs && !r.borrarReporte && r.cards.every(v => !v), r);
      check('Operario: las 9 acciones de admin se niegan aunque se llamen directo', r.bloqueos === 9 && !r.obsAbierta, r);
    } else {
      check('Admin: ve todo lo anterior', r.menuNueva && r.menuDash && r.reparar && r.tabObs && r.borrarReporte && r.cards.every(Boolean), r);
    }
    await ctx.close();
  }

  // 10) Órdenes: documento para imprimir/PDF, Exportar y reintento sin duplicar
  {
    const leidas = [];
    const { ctx, p } = await nuevaPagina(b, {
      '**/sheets/v4/**': route => {
        const u = decodeURIComponent(route.request().url());
        leidas.push(u);
        // Columna NumeroOrden: en Ordenes ya está OT-R1 (el intento anterior alcanzó a escribirla); en Tareas no.
        if (/values\/Ordenes!A:A/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ values: [['NumeroOrden'], ['OT-R1']] }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ values: [['NumeroOrden']] }) });
      },
    });
    const r = await p.evaluate(async () => {
      window.alert = () => {}; window.open = () => null;
      let doc = null; _entregarDocumentoImprimible = html => { doc = html; };
      allOrdenes = [
        { id: 'T1', NumeroOrden: 'OT-T1', Title: 'Cambio de filtros', Estado: 'Cerrada', TipoMantenimiento: 'Preventivo',
          tareas: [{ descripcion: 'Cambiar filtro de aire', ok: true, responsable: 'Ana', observacionFantasma: 'nota interna del equipo' }],
          repuestos: [{ codigo: 'R1', nombre: 'Filtro de aire', cantidad: 2, costoUnitario: 1000 }],
          servicios: [{ codigo: 'S1', nombre: 'Torno externo', cantidad: 1, costoUnitario: 5000 }] },
        { id: 'T2', NumeroOrden: 'OT-T2', Title: '=HYPERLINK("x")', Estado: 'Cerrada', TipoMantenimiento: 'Correctivo' },
        { id: 'T3', NumeroOrden: 'OT-T3', Title: 'Sigue abierta', Estado: 'En ejecución', TipoMantenimiento: 'Correctivo' },
      ];
      await descargarOrdenPDF('T1');
      const pdf = doc || '';
      doc = null; ordenDetalleId = 'T1'; imprimirOrden(); await new Promise(x => setTimeout(x, 200));
      const imprimir = doc || '';
      // Exportar: solo lo filtrado, y sin fórmulas ejecutables
      let blob = null; URL.createObjectURL = b => { blob = b; return 'blob:prueba'; };
      document.getElementById('filtroEstado').value = 'Cerrada';
      exportarExcel();
      const csv = blob ? await blob.text() : '';
      const opcionEnEjecucion = [...document.getElementById('filtroEstado').options].some(o => o.value === 'En ejecución');
      // Reintento de una orden en cola: Ordenes ya tenía la fila → solo se anexan las tareas
      const anexadas = []; window.asegurarHoja = async (n, cols) => cols; window.appendHoja = async (n) => { anexadas.push(n); };
      await guardarOrdenEnSheets({ NumeroOrden: 'OT-R1', tareas: [{ descripcion: 'x' }] }, { reintento: true });
      const enReintento = anexadas.splice(0);
      await guardarOrdenEnSheets({ NumeroOrden: 'OT-R2', tareas: [{ descripcion: 'x' }] });
      return { pdf, imprimir, csv, opcionEnEjecucion, enReintento, normal: anexadas };
    });
    check('PDF de la orden trae tareas, repuestos, servicios y totales', /Cambiar filtro de aire/.test(r.pdf) && /Filtro de aire/.test(r.pdf) && /Torno externo/.test(r.pdf) && /Total/.test(r.pdf));
    check('PDF de la orden no trae la observación interna', !/nota interna del equipo/.test(r.pdf));
    check('"Imprimir / PDF" del detalle abre el documento de la orden', /OT-T1/.test(r.imprimir) && /Cambiar filtro de aire/.test(r.imprimir));
    check('Exportar descarga CSV solo con lo filtrado', /OT-T1/.test(r.csv) && /OT-T2/.test(r.csv) && !/OT-T3/.test(r.csv), r.csv.slice(0, 200));
    check('Exportar no deja fórmulas ejecutables', r.csv.includes(`"'=HYPERLINK(""x"")"`), r.csv.slice(0, 300));
    check('Filtro de Lista incluye "En ejecución"', r.opcionEnEjecucion);
    check('Reintento sin señal no duplica la fila de la orden', JSON.stringify(r.enReintento) === JSON.stringify(['Tareas']), r.enReintento);
    check('Guardado normal no hace lecturas de más', JSON.stringify(r.normal) === JSON.stringify(['Ordenes', 'Tareas']) && !leidas.some(u => /OT-R2/.test(u)), r.normal);
    await ctx.close();
  }

  // 11) Dashboard sin la librería de gráficas, inventario por fecha, novedades y colores
  {
    const { ctx, p } = await nuevaPagina(b, { '**/sheets/v4/**': r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"values":[],"sheets":[],"valueRanges":[]}' }) });
    const r = await p.evaluate(async () => {
      window.Chart = undefined;
      allOrdenes = [
        { NumeroOrden: 'A', Estado: 'Pendiente', TipoMantenimiento: 'Preventivo' },
        { NumeroOrden: 'B', Estado: 'En ejecución', TipoMantenimiento: 'Correctivo' },
        { NumeroOrden: 'C', Estado: 'Cerrada', TipoMantenimiento: 'Correctivo', servicios: [{ nombre: 'S', cantidad: 1, costoUnitario: 700 }] },
      ];
      let err = null; try { await cargarDashboard(); } catch (e) { err = e.message; }
      const kpi = id => document.getElementById(id).textContent;
      const movs = [['A', '2026-10-05', 'INGRESO', 10]];
      const fifo = { ok: _invConsumoSinLoteEnSuFecha(movs, 'A', '2026-10-06', 'SALIDA', 4), antes: _invConsumoSinLoteEnSuFecha(movs, 'A', '2026-10-01', 'SALIDA', 4) };
      // Novedades: abrir la sección ya no reescribe los encabezados
      const escrituras = []; window.sheetsRequest = async (m, r) => { escrituras.push(m + ' ' + r); return {}; };
      window.asegurarHoja = async (n, c) => c; window._leerHojaGenerica = async () => [];
      await cargarNovedadesDeSheets();
      const css = getComputedStyle(document.documentElement);
      return { err, total: kpi('kpi_total'), pend: kpi('kpi_pendientes'), serv: kpi('kpi_costo_serv'), fifo, escrituras, danger: css.getPropertyValue('--danger').trim() };
    });
    check('Dashboard sin Chart.js igual muestra los indicadores', !r.err && r.total === '3' && r.serv !== '—', r);
    check('Dashboard: "Pendientes" cuenta lo que está en ejecución, igual que Inicio', r.pend === '2', r.pend);
    check('Inventario: salida fechada antes de su ingreso se detecta', r.fifo.ok === 0 && r.fifo.antes === 4, r.fifo);
    check('Novedades no reescribe encabezados al abrir', r.escrituras.length === 0, r.escrituras);
    check('Color de error (--danger) definido', r.danger === '#c62828', r.danger);
    await ctx.close();
  }

  // 12) Fotos: un fallo del proxy lo pausa, pero no hasta recargar
  {
    let proxyCalls = 0, falla = true;
    const jpg = Buffer.from(JPG_B64, 'base64');
    const { ctx, p } = await nuevaPagina(b, {
      '**/foto?id=*': route => { proxyCalls++; return falla ? route.fulfill({ status: 503, body: '' }) : route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpg }); },
      'https://fake-apps/**': route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mimeType: 'image/jpeg', base64: JPG_B64 }) }),
    });
    await p.evaluate(async () => { googleAccessToken = 'SESS.x'; window._fotosUrlSede = () => 'https://fake-apps/exec'; await _obtenerDataUrlFoto('FOTOIDXXXXXXXXXXA1'); });
    const tras1 = proxyCalls;
    await p.evaluate(async () => { await _obtenerDataUrlFoto('FOTOIDXXXXXXXXXXA2'); });
    const enPausa = proxyCalls - tras1;
    falla = false;
    const r = await p.evaluate(async () => { _fotosProxyPausaHasta = Date.now() - 1; return (await _obtenerDataUrlFoto('FOTOIDXXXXXXXXXXA3')).startsWith('data:image'); });
    check('Fotos: tras un fallo, el proxy se pausa y luego se vuelve a usar', tras1 === 1 && enPausa === 0 && r && proxyCalls === 2, { tras1, enPausa, proxyCalls, r });
    await ctx.close();
  }

  // 13) Login legible en modo oscuro
  {
    const ctx = await b.newContext({ colorScheme: 'dark' });
    await ctx.addInitScript(() => { try { localStorage.setItem('tema', 'dark'); } catch (e) {} });
    const p = await ctx.newPage();
    await p.goto(BASE, { waitUntil: 'load' }); await p.waitForTimeout(500);
    const r = await p.evaluate(() => {
      if (!document.getElementById('loginOverlay')) mostrarLoginOverlay();
      const lab = document.querySelector('#loginOverlay label');
      return { label: getComputedStyle(lab).color, placeholder: document.getElementById('loginDocumento').placeholder };
    });
    check('Login en oscuro: etiquetas con color claro y ejemplo ficticio', r.label === 'rgb(170, 177, 188)' && !/\d{6,}/.test(r.placeholder), r);
    await ctx.close();
  }

  // 14) Arranque con la sesión ya abierta (como al volver a abrir la app).
  //     La carga de la prueba 1 es sin sesión; con sesión se dibuja el menú
  //     lateral apenas arranca el script, y un error ahí detenía toda la app.
  for (const rol of ['operario', 'admin']) {
    const ctx = await b.newContext();
    await ctx.route('**/sheets/v4/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"values":[],"sheets":[],"valueRanges":[]}' }));
    await ctx.addInitScript((rol) => {
      sessionStorage.setItem('gUser', JSON.stringify({ name: 'Prueba', email: 'p@x', initials: 'PR' }));
      sessionStorage.setItem('gToken', 'SESS.x'); sessionStorage.setItem('gRol', rol);
      sessionStorage.setItem('operacionAutenticada', 'zipaquira');
      try { localStorage.setItem('operacionActual', 'zipaquira'); } catch (e) {}
    }, rol);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.goto(BASE, { waitUntil: 'load' }); await p.waitForTimeout(1500);
    const r = await p.evaluate(() => ({ menu: document.getElementById('sidebarOperaciones').innerText, rol: usuarioRol }));
    const esperado = rol === 'admin' ? /Nueva Orden/.test(r.menu) : !/Nueva Orden/.test(r.menu);
    check(`Arranque con sesión abierta (${rol}): sin errores de JS y menú correcto`, errs.length === 0 && /Pendientes/.test(r.menu) && esperado && r.rol === rol, { errs: errs.slice(0, 2), rol: r.rol, menu: r.menu.slice(0, 300) });
    await ctx.close();
  }

  // 15) App + proxy real: todo lo que hace un operario pasa la lista blanca.
  //     Las peticiones al proxy van al código real del Worker (Google simulado):
  //     si una función nueva de la app usa una operación que el proxy no
  //     permite, esta prueba lo dice antes de publicar.
  {
    const crypto = require('crypto'); const os = require('os'); const { pathToFileURL } = require('url');
    const tmp = path.join(os.tmpdir(), `cf-proxy-app-${process.pid}.mjs`);
    fs.copyFileSync(path.join(RAIZ, 'proxy-seguridad', 'cloudflare-proxy.js'), tmp);
    const worker = (await import(pathToFileURL(tmp).href)).default; fs.unlinkSync(tmp);
    const h = p => crypto.createHash('sha256').update(p).digest('hex').toUpperCase();
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const env = { GOOGLE_SA_EMAIL: 'sa@x', GOOGLE_SA_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), SESSION_SECRET: 's', USUARIOS_SHEET_ID: 'HU' };
    const fetchOriginal = globalThis.fetch; let b1 = '';
    globalThis.fetch = async (url, init = {}) => {
      url = String(url); const m = init.method || 'GET'; const d = decodeURIComponent(url);
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }));
      if (url.includes('/HU/')) return new Response(JSON.stringify({ values: [['Documento', 'Nombre', 'PINHash', 'Rol', 'Activo'], ['111', 'Op', h('1111'), 'operario', 'SI']] }));
      if (url.includes('fields=')) return new Response(JSON.stringify({ sheets: ['Ordenes', 'Tareas', 'Config', 'HorasEquipos', 'Movimientos'].map((t, i) => ({ properties: { sheetId: i, title: t } })) }));
      if (d.includes('Config!A1:A1')) return new Response(JSON.stringify({ values: [[h('clave-sede').toLowerCase()]] }));
      if (d.includes('Config!B1')) { if (m === 'PUT') { b1 = JSON.parse(init.body).values[0][0]; return new Response('{}'); } return new Response(JSON.stringify({ values: b1 ? [[b1]] : [] })); }
      if (url.includes('values:batchGet')) { const n = (url.match(/ranges=/g) || []).length; return new Response(JSON.stringify({ valueRanges: Array.from({ length: n }, () => ({ values: [] })) })); }
      return new Response(JSON.stringify(m === 'GET' ? { values: [] } : { replies: [{}], updates: {} }), { headers: { 'Content-Type': 'application/json' } });
    };
    const ses = (await (await worker.fetch(new Request('https://w/login', { method: 'POST', body: JSON.stringify({ documento: '111', pin: '1111' }) }), env)).json()).session;
    const rechazos = [];
    const ctx = await b.newContext({ serviceWorkers: 'block' });
    await ctx.route('**/*.workers.dev/**', async route => {
      const rq = route.request();
      const resp = await worker.fetch(new Request(rq.url(), { method: rq.method(), headers: rq.headers(), body: ['GET', 'HEAD'].includes(rq.method()) ? undefined : rq.postData() }), env);
      const txt = await resp.text();
      if (resp.status === 403) rechazos.push(rq.method() + ' ' + decodeURIComponent(rq.url().replace(/^.*workers\.dev/, '')).slice(0, 120));
      return route.fulfill({ status: resp.status, body: txt, headers: { 'Content-Type': 'application/json' } });
    });
    await ctx.addInitScript(ses => {
      sessionStorage.setItem('gUser', JSON.stringify({ name: 'Op', email: '111', initials: 'OP' }));
      sessionStorage.setItem('gToken', ses); sessionStorage.setItem('gRol', 'operario');
      sessionStorage.setItem('operacionAutenticada', 'zipaquira'); try { localStorage.setItem('operacionActual', 'zipaquira'); } catch (e) {}
    }, ses);
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
    p.on('dialog', d => d.dismiss().catch(() => {}));
    await p.goto(BASE, { waitUntil: 'load' }); await p.waitForTimeout(2500);
    const r = await p.evaluate(async () => {
      const fallos = [];
      const pasos = [
        () => showPanel('pendientes'), () => showPanel('novedades'), () => showPanel('cronograma'),
        () => cronMostrarSubTab('compresores'), () => cronMostrarSubTab('herramienta'),
        () => abrirInventario('zipaquira'), () => invMostrarSubTab('stock'), () => invMostrarSubTab('movimiento'),
        () => abrirPlanMantenimiento('zipaquira'), () => pmMostrarSubTab('horas'),
        () => appendHoja(SH.cronogramaRegistros, [['2026-10-11', 'T1', 'A1', 'SI']]),
        () => _actualizarFilasPorClaveEnLote(SH.horasEquipos, HORAS_EQUIPOS_COLS, 'Equipo', { CA1: { HorasActuales: '100' } }),
        () => crearHojaSiNoExiste('HojaNuevaPrueba'),
        () => eliminarFilasDondeCumple(SH.tareas, f => f.NumeroOrden === 'OT-X'),
        async () => { const t = await _invAdquirirLock(_invSpreadsheetId('zipaquira')); await _invLiberarLock(_invSpreadsheetId('zipaquira'), t); },
        () => _origenesInformeEnSheets(),
        () => guardarOrdenEnSheets({ NumeroOrden: 'OT-P1', Title: 'x', tareas: [{ descripcion: 'y' }] }, { reintento: true }),
        // Empalme de entrega: lo que llena el operario en planta.
        () => _actualizarFilaPorClave(SH.empalmeRecepcion, EMPALME_RECEPCION_COLS, 'Equipo', 'JOY 2', { Estado: 'Operativo' }),
        () => appendHoja(SH.empalmeHallazgos, [['H-1', 'JOY 2', 'Fuga', 'Alta', 'Abierto', '', 'Op', '2026-10-14']]),
        () => appendHoja(SH.empalmeFotos, [['JOY 2', 'F1', '', 'Op', '2026-10-14']]),
        () => _actualizarFilasPorClaveEnLote(SH.empalmeEvaluacion, EMPALME_EVALUACION_COLS, 'Clave', { 'JOY 2|aceite': { Equipo: 'JOY 2', Item: 'aceite', Estado: 'Bueno' } }),
        // El operario abre la ficha: la pestaña de mantenimientos anteriores se crea y se lee.
        () => asegurarHoja(SH.empalmeMantenimientos, EMPALME_MANTENIMIENTOS_COLS), () => leerHojaGenerica(SH.empalmeMantenimientos),
      ];
      for (const paso of pasos) { try { await paso(); } catch (e) { fallos.push(String(e.message).slice(0, 120)); } await new Promise(x => setTimeout(x, 250)); }
      const sedeOk = await validarClaveSedeDirecto('zipaquira', 'clave-sede');
      const sedeMal = await validarClaveSedeDirecto('zipaquira', 'otra');
      return { fallos, sedeOk, sedeMal };
    });
    globalThis.fetch = fetchOriginal;
    check('App + proxy real: el operario no choca con la lista blanca', rechazos.length === 0 && r.fallos.length === 0 && errs.length === 0, { rechazos, fallos: r.fallos, errs: errs.slice(0, 2) });
    check('Clave de sede se valida en el proxy (correcta sí, incorrecta no)', r.sedeOk === true && r.sedeMal === false, r);
    await ctx.close();
  }

  // 16) Altos de la auditoría en la app
  {
    const { ctx, p, errs } = await nuevaPagina(b, { '**/sheets/v4/**': r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"values":[],"sheets":[],"valueRanges":[]}' }) });
    const r = await p.evaluate(async () => {
      const out = {};
      window.alert = m => { (out.alerts = out.alerts || []).push(String(m)); };
      window.confirmarAccion = async () => true;
      // A2: firma y comilla simple no se ejecutan
      window.__xss = 0;
      allOrdenes = [{ id: 'X1', NumeroOrden: 'OT-X1', Estado: 'Pendiente', FirmaCreador: 'x" onerror="window.__xss=1' }];
      await verDetalle('X1'); await new Promise(x => setTimeout(x, 300));
      _filtrarReportesPorFecha = l => l; window.verReporteSecador = () => {};
      allReportesSecadores = [{ Codigo: "A');window.__xss=2;//", Fecha: '2026-10-01', Hora: '6:00 a.m.', Secador: 'S', Tecnico: 'T' }];
      renderTablaReportesSecadores();
      document.querySelector('#rs_tablaWrap button')?.click();
      out.xss = window.__xss;
      out.esc0 = esc(0) + '|' + esc(null) + '|' + esc("a'b");
      // A7: stock sumado por producto
      window.obtenerStockInventarioDirecto = async () => [{ codigo: 'R1', nombre: 'Filtro', cantidad: 5 }];
      out.faltantes = await verificarStockSuficiente({ repuestos: [{ codigo: 'R1', cantidad: 3 }], insumos: [{ nombre: 'filtro', cantidad: 3 }] });
      // A4 + A7: marcar realizada sin stock no cierra; si Google falla, no descuenta y vuelve a como estaba
      let descontado = 0; window.descontarInventarioPorCierreOrden = async () => { descontado++; return { descontados: [], noEncontrados: [], errores: [] }; };
      googleAccessToken = 'SESS';
      allOrdenes = [{ id: 'C1', NumeroOrden: 'OT-C1', Estado: 'Pendiente', repuestos: [{ codigo: 'R1', cantidad: 9 }] }];
      await marcarRealizada('C1');
      out.sinStock = allOrdenes[0].Estado;
      allOrdenes = [{ id: 'C2', NumeroOrden: 'OT-C2', Estado: 'Pendiente', repuestos: [{ codigo: 'R1', cantidad: 1 }] }];
      window.actualizarOrdenEnSheets = async () => { throw new Error('HTTP 503'); };
      await marcarRealizada('C2');
      out.falloGoogle = { estado: allOrdenes[0].Estado, descontado, aviso: (out.alerts || []).some(a => /No se pudo marcar como realizada/.test(a)) };
      // A6: una orden borrada en otro equipo no vuelve; las que nunca subieron, sí
      localStorage.setItem(LS_KEY, JSON.stringify([
        { NumeroOrden: 'A', Estado: 'Pendiente', _enSheets: true }, { NumeroOrden: 'B', Estado: 'Pendiente', _enSheets: true },
        { NumeroOrden: 'C', Estado: 'Pendiente' }, { NumeroOrden: 'D', Estado: 'Pendiente', _pendienteSync: true, _enSheets: true }]));
      window.cargarOrdenesDeSheets = async () => [{ NumeroOrden: 'A', Estado: 'Pendiente' }];
      window.detectarNombreHoja = async () => {};
      await cargarOrdenes();
      out.merge = allOrdenes.map(o => o.NumeroOrden).sort().join(',');
      // A3: descuentos pendientes
      operacionActual = 'zipaquira'; inventarioOperacionActual = 'zipaquira';
      window.obtenerStockInventarioDirecto = async () => [{ codigo: 'R1', nombre: 'Filtro', cantidad: 10 }];
      window._invGet = async () => [['R1', '2026-10-01', 'SALIDA', 1, 'u', 't', 'OT-1']];
      const hoy = _isoLocal(new Date());
      allOrdenes = [
        { NumeroOrden: 'OT-1', Estado: 'Cerrada', FechaCierre: hoy, repuestos: [{ codigo: 'R1', cantidad: 3 }] },
        { NumeroOrden: 'OT-2', Estado: 'Cerrada', FechaCierre: hoy, insumos: [{ nombre: 'filtro', cantidad: 1 }] },
        { NumeroOrden: 'OT-3', Estado: 'Pendiente', repuestos: [{ codigo: 'R1', cantidad: 4 }] },
        { NumeroOrden: 'OT-4', Estado: 'Cerrada', FechaCierre: '2020-01-01', repuestos: [{ codigo: 'R1', cantidad: 4 }] },
      ];
      out.pendientes = (await _calcularDescuentosPendientes('2026-01-01')).map(p => p.numeroOrden + ':' + p.faltante).join(',');
      // A5: la clave de sede se escribe en un campo de contraseña
      const promesa = _pedirClaveSede('Zipaquirá');
      const campo = document.getElementById('claveSedeInput');
      out.tipoCampo = campo && campo.type;
      campo.value = 'secreta'; campo.closest('form').requestSubmit();
      out.clave = await promesa;
      return out;
    });
    check('A2: firma ni comilla simple en botones ejecutan código', r.xss === 0, r.xss);
    check('A2: esc() escapa comilla simple y muestra el 0', r.esc0 === "0||a&#39;b", r.esc0);
    check('A7: stock sumado por producto (3 + 3 > 5)', r.faltantes.length === 1 && r.faltantes[0].pedido === 6, r.faltantes);
    check('A7: "Marcar realizada" no cierra sin stock', r.sinStock === 'Pendiente', r.sinStock);
    check('A4: si Google no recibe el cierre, la orden vuelve a como estaba y no se descuenta inventario', r.falloGoogle.estado === 'Pendiente' && r.falloGoogle.descontado === 0 && r.falloGoogle.aviso, r.falloGoogle);
    check('A6: la orden borrada en otro equipo no reaparece (y las que no han subido, sí)', r.merge === 'A,C,D', r.merge);
    check('A3: descuentos pendientes por orden cerrada', r.pendientes === 'OT-1:2,OT-2:1', r.pendientes);
    check('A5: clave de sede en campo de contraseña', r.tipoCampo === 'password' && r.clave === 'secreta', r);
    check('Altos: sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }

  // 17) A8: la actualización en lote solo escribe las filas que cambian
  {
    const escrituras = [];
    const { ctx, p } = await nuevaPagina(b, {
      '**/sheets/v4/**': route => {
        const rq = route.request(); const u = decodeURIComponent(rq.url());
        if (rq.method() !== 'GET') { escrituras.push(rq.method() + ' ' + u.replace(/^.*spreadsheets\/[^/:]+/, '') + ' ' + (rq.postData() || '')); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
        if (/HorasEquipos!A:ZZ/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ values: [['Equipo', 'HorasActuales'], ['CA1', '10'], ['CA2', '20'], ['CA3', '30']] }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"values":[]}' });
      },
    });
    await p.evaluate(async () => {
      googleAccessToken = 'SESS'; window.asegurarHoja = async () => ['Equipo', 'HorasActuales'];
      await _actualizarFilasPorClaveEnLote('HorasEquipos', ['Equipo', 'HorasActuales'], 'Equipo', { CA2: { HorasActuales: '25' }, CA9: { HorasActuales: '1' } });
    });
    const lote = escrituras.find(e => /values:batchUpdate/.test(e)) || '';
    check('A8: lote escribe solo la fila que cambió y anexa la nueva', escrituras.length === 2 && /HorasEquipos!A3:B3/.test(lote) && !/CA1|CA3/.test(lote) && escrituras.some(e => /:append/.test(e) && /CA9/.test(e)), escrituras);
    await ctx.close();
  }

  // 18) C1: el script de fotos recibe el pase en cada operación
  {
    const alScript = [];
    let paseInvalidoUnaVez = true, pedidosDePase = 0;
    const { ctx, p } = await nuevaPagina(b, {
      '**/foto?id=*': r => r.fulfill({ status: 503, body: '' }),
      '**/pase-fotos': r => { pedidosDePase++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pase: 'PASE' + pedidosDePase, exp: Math.floor(Date.now() / 1000) + 3600 }) }); },
      'https://fake-apps/**': route => {
        const rq = route.request();
        alScript.push(rq.method() === 'GET' ? rq.url() : JSON.parse(rq.postData() || '{}'));
        if (rq.method() === 'POST' && paseInvalidoUnaVez) { paseInvalidoUnaVez = false; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false,"paseInvalido":true}' }); }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mimeType: 'image/jpeg', base64: JPG_B64, driveFileId: 'NUEVA' }) });
      },
    });
    const r = await p.evaluate(async () => {
      googleAccessToken = 'SESS.x'; window._fotosUrlSede = () => 'https://fake-apps/exec';
      const subida = await (await _postScriptFotos({ accion: 'subirFoto', tipo: 'orden', base64: 'AA==' })).json();
      _fotosProxyPausaHasta = 0;
      const foto = await _obtenerDataUrlFoto('FOTOIDXXXXXXXXXXZ9');
      return { subida, foto: foto.startsWith('data:image') };
    });
    const posts = alScript.filter(x => typeof x === 'object');
    const gets = alScript.filter(x => typeof x === 'string');
    check('C1: al subir, el script recibe el pase; si venció, se pide otro y se reintenta', r.subida.ok && posts.length === 2
      && posts[0].pase === 'PASE1' && posts[1].pase === 'PASE2' && pedidosDePase === 2, { posts: posts.map(x => x.pase), pedidosDePase });
    check('C1: al leer una foto por el script, va el pase en la dirección', r.foto && gets.length === 1 && new URL(gets[0]).searchParams.get('pase') === 'PASE2', gets);
    await ctx.close();
  }
  {
    // Proxy publicado sin /pase-fotos: se sigue sin pase (los scripts viejos no lo piden).
    const alScript = [];
    const { ctx, p } = await nuevaPagina(b, {
      '**/pase-fotos': r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false,"mensaje":"Ruta no encontrada."}' }),
      'https://fake-apps/**': route => { alScript.push(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); },
    });
    const ok = await p.evaluate(async () => {
      googleAccessToken = 'SESS.x'; window._fotosUrlSede = () => 'https://fake-apps/exec';
      return (await (await _postScriptFotos({ accion: 'eliminarFoto', driveFileId: 'X' })).json()).ok;
    });
    check('C1: con el proxy viejo las fotos siguen funcionando (sin pase)', ok && alScript.length === 1 && !('pase' in alScript[0]), alScript);
    await ctx.close();
  }

  // 19) Bajos (B1–B18)
  {
    const { ctx, p, errs } = await nuevaPagina(b);
    // Diagnóstico: si la página navega a mitad de la prueba, decir a dónde y
    // en qué paso iba (el paso queda en sessionStorage, que sobrevive).
    const navegaciones = [];
    p.on('framenavigated', f => { if (f === p.mainFrame()) navegaciones.push(f.url()); });
    p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') navegaciones.push('console.' + m.type() + ': ' + m.text().slice(0, 200)); });
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    for (const ev of ['Page.frameRequestedNavigation', 'Page.frameStartedLoading', 'Page.frameNavigated', 'Page.navigatedWithinDocument', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Inspector.targetCrashed', 'Page.javascriptDialogOpening']) {
      cdp.on(ev, d => navegaciones.push(new Date().toISOString().slice(11, 23) + ' ' + ev + ' ' + JSON.stringify(d).slice(0, 220)));
    }
    let r;
    try {
    r = await p.evaluate(async () => {
      const out = {};
      const paso = n => { try { sessionStorage.setItem('__paso', n); } catch (_) {} };
      paso('1: Login: fondo claro de la app con la marca de agua subiendo');
      // Login: fondo claro de la app con la marca de agua subiendo
      const marca = document.querySelector('#loginOverlay .login-marca');
      out.loginFondo = !!marca && getComputedStyle(marca).animationName === 'loginMarcaSube'
        && /url\("data:image\/png/.test(getComputedStyle(marca).backgroundImage)
        && getComputedStyle(document.getElementById('loginOverlay')).backgroundColor === 'rgb(246, 248, 251)';
      paso('2: Avisos de la app en vez de la ventanita del navegador');
      // Avisos de la app en vez de la ventanita del navegador
      const setTimeoutOriginal = window.setTimeout, esperas = [];
      window.setTimeout = (fn, ms, ...resto) => { esperas.push(ms); return setTimeoutOriginal(fn, ms, ...resto); };
      try { alert('✅ Orden guardada correctamente.'); alert('❌ Contraseña incorrecta.'); alert('Solo un administrador puede hacer esto.'); }
      finally { window.setTimeout = setTimeoutOriginal; }
      out.avisos = [...document.querySelectorAll('#avisos .aviso')].map(a => a.className.replace('aviso ', '') + ':' + a.querySelector('.aviso-texto').textContent).join(' | ');
      out.avisoTamano = getComputedStyle(document.querySelector('#avisos .aviso')).fontSize;
      out.avisoEsperas = esperas.join(',');
      document.querySelectorAll('#avisos .aviso-cerrar').forEach(b => b.click());
      paso('3: Rol junto al nombre');
      // Rol junto al nombre
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; _aplicarRolUI();
      out.rol = document.getElementById('userRol').hidden ? '' : document.getElementById('userRol').textContent;
      usuarioRol = 'operario'; _aplicarRolUI(); out.rolOperario = document.getElementById('userRol').textContent;
      googleAccessToken = null; usuarioRol = 'operario'; _aplicarRolUI();
      paso('4: Listas vacías: mensaje claro y "Quitar filtros" en la lista ');
      // Listas vacías: mensaje claro y "Quitar filtros" en la lista con filtros
      allOrdenes = []; renderPendientes();
      out.vacioPend = document.querySelector('#pendientesContainer .vacio-titulo, .panel .vacio-titulo')?.textContent || '';
      allOrdenes = [{ id: 'X1', NumeroOrden: 'OT-1', Estado: 'Pendiente', Title: 'a' }];
      document.getElementById('filtroTexto').value = 'zzz'; filtrarOrdenes();
      const vacioLista = document.querySelector('#listaContainer .vacio-titulo')?.textContent || '';
      document.querySelector('#listaContainer .empty-state button').click();
      out.vacioLista = vacioLista + ' → ' + document.getElementById('filtroTexto').value + ' → ' + document.querySelectorAll('#listaContainer .order-item').length;
      allOrdenes = []; filtrarOrdenes();
      paso('5: Pantalla de carga: se quita sola al terminar de arrancar');
      // Pantalla de carga: se quita sola al terminar de arrancar
      const carga = document.getElementById('pantallaCarga');
      out.cargaFuera = !carga || carga.classList.contains('oculta');
      paso('6: Saludo de Inicio con el primer nombre y las pendientes de la');
      // Saludo de Inicio con el primer nombre y las pendientes de la sede
      googleAccessToken = 'SESS.x'; currentUser = { name: 'ANA PÉREZ', initials: 'AP' }; operacionAutenticada = true;
      allOrdenes = [{ Estado: 'Pendiente', Prioridad: 'Urgente' }, { Estado: 'En ejecución' }, { Estado: 'Cerrada' }];
      renderSaludoInicio();
      out.saludo = document.getElementById('saludoInicio').innerText;
      operacionAutenticada = false; renderSaludoInicio();
      out.saludoSinSede = document.getElementById('saludoInicio').innerText;
      googleAccessToken = null; allOrdenes = [];
      paso('7: B17: números como los escribe una persona');
      // B17: números como los escribe una persona
      out.numeros = ['12', '-40', '0.75', '.5'].every(_esNumeroDecimal) && !['0x10', '1e5', 'Infinity', '', '1,5', '-'].some(_esNumeroDecimal);
      paso('8: B16: dinero escrito a mano en Proyectos');
      // B16: dinero escrito a mano en Proyectos
      out.dinero = [proyDineroEscrito('1.500'), proyDineroEscrito('25.000'), proyDineroEscrito('$ 1.500.000'), proyDineroEscrito('15063161.664'), proyDineroEscrito('1.5')];
      paso('9: B1: el filtro trae solo los estados de hoy, y agrega los vie');
      // B1: el filtro trae solo los estados de hoy, y agrega los viejos que existan
      const sel = document.getElementById('filtroEstado');
      out.estadosBase = [...sel.options].map(o => o.value).join(',');
      allOrdenes = [{ NumeroOrden: 'X1', Estado: 'Aprobada' }, { NumeroOrden: 'X2', Estado: 'Pendiente' }];
      _completarFiltroEstado();
      out.estadosConViejos = [...sel.options].map(o => o.value).join(',');
      allOrdenes = [];
      paso('10: B5: título y barra del navegador según el tema');
      // B5: título y barra del navegador según el tema
      out.titulo = document.title;
      alternarTema(); out.barraOscura = document.querySelector('meta[name="theme-color"]').content;
      paso('11: B4: el documento impreso trae la paleta clara, aun con la ap');
      // B4: el documento impreso trae la paleta clara, aun con la app en oscuro
      _mostrarDocumentoEnVisor(_conPaletaDePapel('<html><head><title>T</title><style>h1{color:var(--brand)}</style></head><body><h1 id="tituloDoc">x</h1></body></html>'));
      out.colorDoc = getComputedStyle(document.getElementById('tituloDoc')).color;
      out.fondoDoc = getComputedStyle(document.querySelector('.visor-doc-hoja')).backgroundColor;
      document.querySelector('.visor-doc [data-accion="cerrar"]').click();
      alternarTema(); out.barraClara = document.querySelector('meta[name="theme-color"]').content;
      paso('12: B3: un guardado anterior dejó el aviso en verde; el siguient');
      // B3: un guardado anterior dejó el aviso en verde; el siguiente error sale en rojo
      const msg = document.getElementById('rc_msg'); msg.style.color = '#15803d';
      await guardarReporteCompresor();
      out.colorError = msg.style.color;
      paso('13: B11: aviso de rango recortado');
      // B11: aviso de rango recortado
      out.recorte = !!_avisoRangoRecortado(['2026-01-01'], '2026-03-01', 45) && !_avisoRangoRecortado(['2026-03-01'], '2026-03-01', 45);
      paso('14: B10: actividades realizadas por turno');
      // B10: actividades realizadas por turno
      window.asegurarHoja = async (n, cols) => cols;
      window.leerHojaGenericaCacheada = async () => [
        { Fecha: '2026-10-10', TurnoId: 't1', ActividadId: 'a1', Realizado: 'SI' },
        { Fecha: '2026-10-10', TurnoId: 't1', ActividadId: 'a2', Realizado: 'NO' },
      ];
      const cumpl = await _leerCumplimientoTurnosCronograma();
      out.realizadas = cumpl.cumplido['2026-10-10|t1'] === true && cumpl.realizadas['2026-10-10|t1'].has('a1') && !cumpl.realizadas['2026-10-10|t1'].has('a2');
      paso('15: B9: el stock para pantalla se reutiliza y se borra al escrib');
      // B9: el stock para pantalla se reutiliza y se borra al escribir
      let lecturas = 0;
      window.obtenerStockInventarioDirecto = async () => { lecturas++; return [{ codigo: 'A', nombre: 'A' }]; };
      await _stockInventarioParaPantalla('zipaquira'); await _stockInventarioParaPantalla('zipaquira');
      const antes = lecturas;
      _invalidarStockPantalla(); await _stockInventarioParaPantalla('zipaquira');
      out.cacheStock = [antes, lecturas];
      paso('16: B15: la limpieza de caché muestra la descripción de la orden');
      // B15: la limpieza de caché muestra la descripción de la orden
      let textoPrompt = '';
      window.pedirDatos = async o => { textoPrompt = JSON.stringify(o.campos); return null; };
      localStorage.setItem(LS_KEY, JSON.stringify([{ NumeroOrden: 'OT-9', Equipo: 'CA', Estado: 'Pendiente', Title: 'Cambiar filtro de aceite' }]));
      await limpiarCacheLocal();
      out.cacheConDescripcion = /Cambiar filtro de aceite/.test(textoPrompt);
      localStorage.removeItem(LS_KEY);
      paso('17: B12/B18: la lista de operarios sale de la hoja; la primera v');
      // B12/B18: la lista de operarios sale de la hoja; la primera vez se llena con los registros
      usuarioRol = 'admin';
      const hoja = [];
      window._leerHojaGenerica = async n => n === 'OperariosPlanta' ? hoja.map((f, i) => ({ _row: i + 2, Nombre: f[0], Activo: f[1] }))
        : n === 'CronogramaRegistros' ? [{ OperariosRealizaron: 'Ana Uno, Beto  Dos' }, { OperariosRealizaron: 'Ana Uno' }]
        : n === 'ObservacionesOperarios' ? [{ Operario: 'Caro Tres' }] : [];
      window.appendHoja = async (n, filas) => { if (n === 'OperariosPlanta') hoja.push(...filas); };
      await cargarOperariosPlanta(true);
      out.operarios = operariosPlantaActivos().join(',');
      document.body.insertAdjacentHTML('beforeend', '<div id="cronModalOperariosLista"></div>');
      await _pintarOperariosModalCronograma();
      out.casillas = document.querySelectorAll('.cronOpChk').length;
      let cuerpoQuitar = null;
      const fetchOriginal = window.fetch;
      window.fetch = async (url, init) => { if (String(url).includes('values:batchUpdate')) { cuerpoQuitar = JSON.parse(init.body); return new Response('{}'); } return fetchOriginal(url, init); };
      await _marcarOperarioPlanta('Beto Dos', false);
      window.fetch = fetchOriginal;
      out.quitar = cuerpoQuitar && cuerpoQuitar.data.length === 1 && cuerpoQuitar.data[0].range === 'OperariosPlanta!B3' && cuerpoQuitar.data[0].values[0][0] === 'NO';
      out.listaFija = typeof OPERARIOS_ZIPAQUIRA;
      paso('18: B14: el inventario completa solo los encabezados que faltan');
      // B14: el inventario completa solo los encabezados que faltan
      const escritos = [];
      window.fetch = async (url, init) => {
        url = decodeURIComponent(String(url));
        if (init && init.method === 'PUT') { escritos.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); }
        return new Response(JSON.stringify({ values: [['Codigo', 'Nombre']] }));
      };
      await _invAsegurarHoja('INV', 'Productos', ['Codigo', 'Nombre', 'Unidad']);
      window.fetch = fetchOriginal;
      out.encabezados = escritos.length === 1 && /Productos!C1:C1/.test(escritos[0].url) && JSON.stringify(escritos[0].body.values) === '[["Unidad"]]';
      paso('19: B14: al editar una orden, primero se agregan las filas nueva');
      // B14: al editar una orden, primero se agregan las filas nuevas y después se borran las viejas
      const pasos = [];
      window.appendHoja = async n => { pasos.push('agregar ' + n); };
      window.fetch = async (url, init) => {
        url = decodeURIComponent(String(url));
        if (url.endsWith(':batchUpdate')) { pasos.push('borrar ' + JSON.parse(init.body).requests.length); return new Response('{}'); }
        if (url.includes('fields=sheets.properties')) return new Response(JSON.stringify({ sheets: [{ properties: { title: 'Tareas', sheetId: 7 } }] }));
        if (url.includes('Tareas!A:A')) return new Response(JSON.stringify({ values: [['NumeroOrden'], ['OT-B14'], ['OT-B14']] }));
        if (url.includes('Ordenes!A:A')) return new Response(JSON.stringify({ values: [['NumeroOrden'], ['OT-B14']] }));
        if (init && init.method === 'PUT') return new Response('{}');
        return new Response(JSON.stringify({ values: [['OT-B14']] }));
      };
      try { await actualizarOrdenEnSheets('OT-B14', { tareas: [{ descripcion: 'x' }] }); } catch (e) { pasos.push('error ' + e.message); }
      window.fetch = fetchOriginal;
      out.pasosOrden = pasos.join(' | ');
      paso('20: Hoja de Vida: "Otros equipos" con la lista fija de Zipaquirá');
      // Hoja de Vida: "Otros equipos" con la lista fija de Zipaquirá y los registrados
      window._listaEquiposSeguridad = async () => [{ Codificacion: 'EXT-1', Equipo: 'EXTINTOR' }];
      window._leerFilaHVD = async () => null;
      let historialDe = null; window._renderHistorialOrdenesEquipo = e => { historialDe = e; };
      hvdCambiarModo('seguridad');
      await new Promise(x => setTimeout(x, 50));
      const listaHvd = [...document.querySelectorAll('#hvdListaEquipos > div')].map(d => d.innerText.trim());
      await hvdSeleccionarEquipo('Arnés de cuerpo completo 1');
      const camposArnes = [...document.querySelectorAll('#hvdContenido .field label')].map(l => l.textContent);
      await hvdSeleccionarEquipo('Tie off 2');
      out.otrosEquipos = {
        pestana: document.getElementById('hvdTabSeguridad').textContent,
        lista: listaHvd.filter(x => !/^Extintor/.test(x)).join(' | '),
        sinVoltaje: camposArnes.includes('Marca') && !camposArnes.some(c => /Voltaje|RPM|Potencia/.test(c)),
        historialDe,
        aviso: /dado de baja/.test(document.getElementById('hvdContenido').innerText),
      };
      paso('21: Extintores: recargas (la última hace más de un año → vencida');
      // Extintores: recargas (la última hace más de un año → vencida) y agregar una
      const filasRecarga = [{ Codigo: 'REC-0001', Equipo: 'Extintor CO2 1', FechaRecarga: '2024-01-10', RegistradoPor: 'X' }];
      window.leerHojaGenericaCacheada = async n => n === 'RecargasExtintores' ? filasRecarga.slice() : [];
      const anexadasRecarga = []; window.appendHoja = async (n, filas) => { anexadasRecarga.push([n, filas]); };
      hvdCambiarModo('operacion'); hvdCambiarModo('seguridad');
      await new Promise(x => setTimeout(x, 50));
      const itemCo2 = [...document.querySelectorAll('#hvdListaEquipos > div')].find(d => /Extintor CO2 1\b/.test(d.innerText));
      await hvdSeleccionarEquipo('Extintor CO2 1');
      await new Promise(x => setTimeout(x, 50));
      const recargaChip = document.querySelector('#hvdRecargas .hvd-recargas-cab .hvd-recarga')?.textContent || '';
      document.getElementById('hvdRecargaFecha').value = '2026-01-05';
      document.getElementById('hvdRecargaObs').value = 'Proveedor';
      await agregarRecargaExtintor();
      const fila = anexadasRecarga[0] && anexadasRecarga[0][1][0];
      out.extintores = {
        total: listaHvd.filter(x => /^Extintor/.test(x)).length,
        co2: listaHvd.filter(x => /^Extintor CO2/.test(x)).length,
        multi: listaHvd.filter(x => /^Extintor multipropósito/.test(x)).length,
        vencidaEnLista: /Recarga vencida/.test(itemCo2?.innerText || ''),
        recargaChip,
        anexada: fila ? [anexadasRecarga[0][0], fila[1], fila[2], fila[3]].join(',') : '',
      };
      hvdCambiarModo('operacion');
      paso('22: Órdenes: los "Otros equipos" se pueden elegir (sin los de ba');
      // Órdenes: los "Otros equipos" se pueden elegir (sin los de baja)
      inicializarCampoEquipo();
      const grupoOtros = [...document.querySelectorAll('#f_equipo optgroup')].find(g => g.label === 'Otros equipos');
      const opcionesOtros = grupoOtros ? [...grupoOtros.querySelectorAll('option')].map(o => o.value) : [];
      out.ordenOtros = { cantidad: opcionesOtros.length, hidro: opcionesOtros.includes('Hidrolavadora'), extintor: opcionesOtros.includes('Extintor multipropósito 6'), deBaja: opcionesOtros.includes('Tie off 2') };
      paso('24: Menú: con la lista de sedes recogida se ofrece "Cambiar de s');
      // Menú: con la lista de sedes recogida se ofrece "Cambiar de sede", que la despliega
      operacionAutenticada = true; sidebarGrupoExpandido.operaciones = false; renderSidebarOperaciones();
      const menu = () => document.getElementById('sidebarOperaciones').innerText;
      out.cambiarSedeVisible = /Cambiar de sede/.test(menu()) && _sidebarClavesVisibles('operaciones').length === 1;
      const renglonSede = [...document.querySelectorAll('#sidebarOperaciones div')].find(d => /^Cambiar de sede/.test(d.innerText.trim()));
      paso('24b: antes del clic en ' + (renglonSede ? renglonSede.outerHTML.slice(0, 80) : 'nada'));
      renglonSede.click();
      paso('24c: después del clic');
      out.cambiarSedeDespliega = !/Cambiar de sede/.test(menu()) && _sidebarClavesVisibles('operaciones').length === Object.keys(OPERACIONES).length;
      paso('25: devolviendo el resultado');
      return out;
    });
    } catch (e) {
      await p.waitForLoadState('load').catch(() => {});
      const ultimo = await p.evaluate(() => sessionStorage.getItem('__paso')).catch(x => 'no se pudo leer: ' + x.message);
      console.log('DIAGNÓSTICO — último paso antes de navegar:', ultimo);
      console.log('DIAGNÓSTICO — navegaciones y avisos:', JSON.stringify(navegaciones, null, 1));
      throw e;
    }
    check('B17: los números solo aceptan dígitos con punto (y el menos)', r.numeros);
    check('B16: "1.500" escrito en Proyectos son mil quinientos', JSON.stringify(r.dinero) === '[1500,25000,1500000,15063161.664,1.5]', r.dinero);
    check('B1: el filtro de estados trae los de hoy y suma los viejos que existan', r.estadosBase === ',Pendiente,En ejecución,Cerrada' && r.estadosConViejos === ',Pendiente,En ejecución,Cerrada,Aprobada', r);
    check('B5: título sin "Microsoft 365" y barra del color del tema', /SolucionAIRE/.test(r.titulo) && !/Microsoft/.test(r.titulo) && r.barraOscura === '#1b212a' && r.barraClara === '#ffffff', r);
    check('B4: el documento impreso sale con los colores de la marca aun en modo oscuro', r.colorDoc === 'rgb(2, 69, 122)' && r.fondoDoc === 'rgb(255, 255, 255)', r);
    check('B3: después de un guardado bueno, el siguiente error sale en rojo', r.colorError === 'var(--danger)', r.colorError);
    check('B11: avisa cuando el rango de fechas se recorta', r.recorte);
    check('B10: cuenta qué actividades del turno se hicieron', r.realizadas);
    check('B9: el stock de pantalla se reutiliza y se vuelve a leer tras escribir', JSON.stringify(r.cacheStock) === '[1,2]', r.cacheStock);
    check('B15: limpiar caché muestra la descripción de la orden', r.cacheConDescripcion);
    check('B12/B18: operarios desde la hoja (se llena con los registros la primera vez)', r.operarios === 'Ana Uno,Beto Dos,Caro Tres' && r.casillas === 3 && r.listaFija === 'undefined', r);
    check('B18: quitar un operario lo deja inactivo sin borrar la fila', r.quitar, r);
    check('B14: el inventario completa solo los encabezados que faltan', r.encabezados);
    check('B14: al editar una orden se agrega antes de borrar', r.pasosOrden === 'agregar Tareas | borrar 2', r.pasosOrden);
    check('Menú: "Cambiar de sede" aparece con la lista recogida y la despliega', r.cambiarSedeVisible && r.cambiarSedeDespliega, r);
    check('Hoja de Vida: "Otros equipos" con los 10 de Zipaquirá (un tie off de baja) y los registrados',
      r.otrosEquipos.pestana === 'Otros equipos'
      && r.otrosEquipos.lista === 'Hidrolavadora | Pulidora | Taladro | Arnés de cuerpo completo 1 | Arnés de cuerpo completo 2 | Tie off 1 | Tie off 2 De baja | Eslinga de restricción | Eslinga en Y 1 | Eslinga en Y 2 | EXT-1 — EXTINTOR'
      && r.otrosEquipos.sinVoltaje && r.otrosEquipos.historialDe === 'Tie off 2' && r.otrosEquipos.aviso, r.otrosEquipos);
    check('Órdenes: se pueden elegir los "Otros equipos" (27, sin el tie off de baja)',
      r.ordenOtros.cantidad === 27 && r.ordenOtros.hidro && r.ordenOtros.extintor && !r.ordenOtros.deBaja, r.ordenOtros);
    check('Hoja de Vida: 18 extintores (12 CO2, 6 multipropósito) con recargas: avisa la vencida y se agregan fechas',
      r.extintores.total === 18 && r.extintores.co2 === 12 && r.extintores.multi === 6 && r.extintores.vencidaEnLista
      && /Recarga vencida desde/.test(r.extintores.recargaChip) && r.extintores.anexada === 'RecargasExtintores,Extintor CO2 1,2026-01-05,Proveedor', r.extintores);
    check('Login: fondo claro con la marca de agua animada', r.loginFondo, r.loginFondo);
    check('Pantalla de carga: se quita sola al arrancar', r.cargaFuera);
    check('Avisos de la app con su color (bien, error, falta algo) y sin el emoji', r.avisos === 'exito:Orden guardada correctamente. | error:Contraseña incorrecta. | advertencia:Solo un administrador puede hacer esto.', r.avisos);
    check('Avisos: letra grande y 2 s más en pantalla (6 s un aviso corto, 9 s un error)', r.avisoTamano === '16px' && r.avisoEsperas === '6000,9000,6255', { tamano: r.avisoTamano, esperas: r.avisoEsperas });
    check('Rol junto al nombre en el encabezado', r.rol === 'Admin' && r.rolOperario === 'Operario', r);
    check('Listas vacías: mensaje claro y "Quitar filtros" que sí los quita', r.vacioPend === 'No hay órdenes pendientes' && r.vacioLista === 'No hay órdenes con esos filtros →  → 1', r);
    check('Inicio: saludo con el nombre y las órdenes pendientes', /^Buen[oa]s (días|tardes|noches), Ana\b/.test(r.saludo) && /Hay 2 órdenes pendientes en .+, 1 urgente\./.test(r.saludo)
      && /Elige una operación/.test(r.saludoSinSede), { saludo: r.saludo, sinSede: r.saludoSinSede });
    check('Bajos: sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }
  {
    // Editar una orden de un equipo que ya no está en la lista (de baja): se conserva.
    // Va en su propia página y espera a que el editor termine lo que deja
    // programado (firmas, desplazamiento) antes de leer.
    const { ctx, p, errs } = await nuevaPagina(b);
    const editar = await p.evaluate(async () => {
      allOrdenes = [{ id: 'T9', NumeroOrden: 'OT-9', Equipo: 'Tie off 2', Estado: 'Pendiente', Title: 'Revisión', tareas: [], repuestos: [], insumos: [], servicios: [] }];
      abrirModalCompletar('T9');
      await new Promise(x => setTimeout(x, 400));
      return document.getElementById('e_equipo').value;
    });
    check('Órdenes: al editar una orden de un equipo que ya no está en la lista, el equipo se conserva', editar === 'Tie off 2' && errs.length === 0, { editar, errs: errs.slice(0, 2) });
    await ctx.close();
  }
  {
    // Zipaquirá 2 tiene su propia lista de equipos (ya no la general)
    const { ctx, p, errs } = await nuevaPagina(b);
    const r = await p.evaluate(() => {
      const grupos = _gruposEquiposParaOrden('zipaquira2');
      const nombres = Object.values(grupos).flat();
      operacionActual = 'zipaquira2';
      const hvd = _listaEquiposPlanaSede();
      operacionActual = 'zipaquira';
      return {
        grupos: Object.keys(grupos).join(' | '), total: nombres.length, unicos: new Set(nombres).size,
        sinGeneral: !nombres.includes('ARRANCADOR CA1') && !nombres.includes('SCA1'),
        hvd: hvd.length, soachaGeneral: _gruposEquiposParaOrden('soacha') === EQUIPOS_LISTADO_GENERAL,
      };
    });
    check('Zipaquirá 2: su propia lista de equipos (4 grupos, 31 equipos sin repetidos) en órdenes y Hoja de Vida; Soacha sigue con la general',
      r.grupos === 'Baja Presión | Alta Presión | Alta Presión Secadores | Baja Presión Secadores' && r.total === 31 && r.unicos === 31
      && r.sinGeneral && r.hvd === 31 && r.soachaGeneral && errs.length === 0, { ...r, errs: errs.slice(0, 2) });
    await ctx.close();
  }
  {
    // Empalme de entrega de Zipaquirá 2, de punta a punta, contra Sheets en memoria
    const fake = sheetsEnMemoria();
    const { ctx, p, errs } = await nuevaPagina(b, { '**/sheets/v4/**': fake.route });
    const ids = await p.evaluate(() => ({ ord: OPERACIONES.zipaquira2.spreadsheetId, inv: INVENTARIO_SHEETS.zipaquira2 }));
    fake.crear(ids.inv, 'Config', [['hash']]);
    const r = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const hasta = async cond => { for (let i = 0; i < 80 && !cond(); i++) await espera(100); };
      const avisos = []; window.alert = m => avisos.push(String(m)); window.confirmarAccion = async () => true;
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; currentUser = { name: 'Ana Prueba', email: 'ana@x', initials: 'AP' };
      operacionActual = 'zipaquira2'; operacionAutenticada = true; GOOGLE_CONFIG.spreadsheetId = OPERACIONES.zipaquira2.spreadsheetId;
      renderSidebarOperaciones();
      const out = { menu: /Empalme de entrega/.test(document.getElementById('sidebarOperaciones').innerText) };
      await showPanel('empalme'); await hasta(() => document.querySelector('#empListaEquipos .emp-equipo'));
      out.lista = document.querySelectorAll('#empListaEquipos .emp-equipo').length;
      out.kpiAntes = document.querySelector('#empKpis .emp-kpi-num').textContent.replace(/\s+/g, ' ').trim();

      // 1. Ficha de recepción
      empSeleccionarEquipo('JOY 2');
      document.getElementById('empf_horometro').value = '45210';
      await empGuardarFicha();
      out.sinEstado = document.getElementById('empfMsg').textContent;
      document.getElementById('empf_estado').value = 'Operativo con fallas';
      document.querySelectorAll('.empf-doc')[0].checked = true;
      document.getElementById('empf_obs').value = 'Fuga leve en el enfriador';
      document.getElementById('empf_Identificacion').value = 'Joy TA-48 / S/N 1234 / 2004';
      document.getElementById('empf_TorreEnfriamiento').value = 'Torre 2';
      const evalFila = id => document.querySelector(`.emp-tabla-evaluacion tr[data-item="${id}"]`);
      out.itemsEvaluacion = document.querySelectorAll('.emp-tabla-evaluacion tbody tr').length;
      evalFila('aceite').querySelector('[data-campo="estado"]').value = 'Bueno';
      evalFila('vibraciones').querySelector('[data-campo="estado"]').value = 'Malo';
      evalFila('vibraciones').querySelector('[data-campo="observaciones"]').value = '7,1 mm/s en el rodamiento lado acople';
      await empGuardarFicha();
      out.fichaMsg = document.getElementById('empfMsg').textContent;
      out.kpiEvaluacion = document.querySelector('#empKpis .emp-kpi-sub').textContent;
      empSeleccionarEquipo('Secador Kaeser 1');
      out.secadorSinEvaluacion = !document.querySelector('.emp-tabla-evaluacion') && !!document.getElementById('empf_Arrancador');
      empSeleccionarEquipo('JOY 2');
      out.evaluacionReabre = document.querySelector('.emp-tabla-evaluacion tr[data-item="vibraciones"] [data-campo="estado"]').value;
      out.kpiDespues = document.querySelector('#empKpis .emp-kpi-num').textContent.replace(/\s+/g, ' ').trim();
      out.chip = document.querySelector('#empListaEquipos .emp-equipo.activo .emp-chip').textContent;

      // 2. Hallazgo y su orden
      empNuevoHallazgoDe('JOY 2');
      document.getElementById('emph_descripcion').value = 'Válvula de alivio sin certificar';
      document.getElementById('emph_prioridad').value = 'Alta';
      await empRegistrarHallazgo();
      await empCrearOrdenDeHallazgo(_emp.hallazgos[0].ID);
      const h = _emp.hallazgos[0];
      const o = allOrdenes.find(x => x.NumeroOrden === h.OrdenNumero) || {};
      out.hallazgo = { estado: h.Estado, orden: h.OrdenNumero, equipo: o.Equipo, tipo: o.TipoMantenimiento, prioridad: o.Prioridad, tarea: (o.tareas || [])[0]?.descripcion };
      out.botonesHallazgo = document.getElementById('empHallazgosLista').innerText;

      // 3. Repuestos
      empMostrarSubTab('repuestos');
      document.getElementById('empr_equipo').value = 'JOY 2'; empCargarRepuestosEquipo();
      const llenar = (tr, datos) => Object.entries(datos).forEach(([c, v]) => { const el = tr.querySelector(`[data-campo="${c}"]`); if (el.type === 'checkbox') el.checked = v; else el.value = v; });
      llenar(document.querySelector('#empr_tbody tr'), { codigo: 'RK-1', nombre: 'Kit de sellos', critico: true, bodega: 'Comprar' });
      hvdAgregarFilaRepuesto('empr_tbody');
      llenar(document.querySelectorAll('#empr_tbody tr')[1], { codigo: 'FA-1', nombre: 'Filtro de aceite', bodega: 'En bodega' });
      await empGuardarRepuestos();
      out.comprar = [...document.querySelectorAll('#emprConsolidado tbody tr')].map(tr => tr.cells[1].textContent).join(',');
      out.kpiRepuestos = document.querySelectorAll('#empKpis .emp-kpi-num')[2].textContent.trim();

      // 4. Bodega inicial pegada desde Excel
      empMostrarSubTab('bodega'); await hasta(() => !/Cargando/.test(document.getElementById('empbCargado').innerText));
      document.getElementById('empb_pegar').value = 'Código\tNombre\tCantidad\nFA-1\tFiltro de aceite\t4\tUnidades\t$ 85.000\tEstante 2\nGR-2\tGrasa\t1.200,5\tKg';
      empPegarBodega();
      out.filasBodega = document.querySelectorAll('#empb_tbody tr').length;
      await empCargarBodega();
      out.bodegaMsg = document.getElementById('empbMsg').textContent;
      await hasta(() => document.querySelectorAll('#empbCargado tbody tr').length);
      out.cargado = document.querySelectorAll('#empbCargado tbody tr').length;

      // 5. Acta
      out.acta = _htmlActaEmpalme('zipaquira2', await _empMovimientosBodegaInicial('zipaquira2'));

      // Operario: llena, pero no crea órdenes ni toca repuestos
      usuarioRol = 'operario';
      empRenderHallazgos();
      out.operarioCreaOrden = /Crear orden/.test(document.getElementById('empHallazgosLista').innerText);
      empCargarRepuestosEquipo();
      out.operarioRepuestosRO = [...document.querySelectorAll('#empr_tbody input[type="text"]')].every(i => i.readOnly);
      usuarioRol = 'admin';

      operacionActual = 'zipaquira'; renderSidebarOperaciones();
      out.menuZipa1 = /Empalme de entrega/.test(document.getElementById('sidebarOperaciones').innerText);
      out.avisos = avisos;
      return out;
    });
    const ficha = fake.hoja(ids.ord, 'EmpalmeRecepcion');
    const horas = fake.hoja(ids.ord, 'HorasEquipos');
    const hall = fake.hoja(ids.ord, 'EmpalmeHallazgos');
    const ordenes = fake.hoja(ids.ord, 'Ordenes');
    const rep = fake.hoja(ids.ord, 'HVDRepuestos');
    const productos = fake.hoja(ids.inv, 'Productos');
    const movs = fake.hoja(ids.inv, 'Movimientos');
    const col = (filas, nombre) => filas[0] ? filas[0].indexOf(nombre) : -1;
    const filaJoy = horas.find(f => f[0] === 'JOY 2') || [];
    check('Empalme: aparece en el menú de Zipaquirá 2 (no en Zipaquirá) y lista sus 31 equipos', r.menu && !r.menuZipa1 && r.lista === 31 && r.kpiAntes === '0 de 31', { menu: r.menu, zipa1: r.menuZipa1, lista: r.lista, kpi: r.kpiAntes });
    check('Empalme: la ficha pide el estado y guarda; el horómetro queda como hora base del compresor',
      /Elige el estado/.test(r.sinEstado) && /Ficha guardada.*Plan de Mantenimiento/.test(r.fichaMsg) && r.kpiDespues === '1 de 31' && r.chip === 'Operativo con fallas'
      && ficha.length === 2 && ficha[1][col(ficha, 'Estado')] === 'Operativo con fallas' && ficha[1][col(ficha, 'Documentacion')] === 'Manual de operación'
      && ficha[1][col(ficha, 'Identificacion')] === 'Joy TA-48 / S/N 1234 / 2004' && ficha[1][col(ficha, 'TorreEnfriamiento')] === 'Torre 2'
      && filaJoy[col(horas, 'HoraBaseInformes')] === '45210' && filaJoy[col(horas, 'HorasActuales')] === '45210',
      { sinEstado: r.sinEstado, msg: r.fichaMsg, kpi: r.kpiDespues, ficha: ficha[1], horas: filaJoy });
    const evaluacion = fake.hoja(ids.ord, 'EmpalmeEvaluacion');
    const filaVib = evaluacion.find(f => f[0] === 'JOY 2|vibraciones') || [];
    check('Empalme: la evaluación técnica (11 ítems) va solo en los compresores y guarda estado y observaciones',
      r.itemsEvaluacion === 11 && evaluacion.length === 3 && filaVib[col(evaluacion, 'Estado')] === 'Malo'
      && filaVib[col(evaluacion, 'Observaciones')] === '7,1 mm/s en el rodamiento lado acople'
      && r.secadorSinEvaluacion && r.evaluacionReabre === 'Malo' && /Evaluación técnica completa: 0 de 22 compresores/.test(r.kpiEvaluacion),
      { items: r.itemsEvaluacion, evaluacion, secador: r.secadorSinEvaluacion, reabre: r.evaluacionReabre, kpi: r.kpiEvaluacion });
    check('Empalme: un hallazgo se vuelve orden correctiva con el hallazgo como tarea',
      r.hallazgo.estado === 'En orden' && /^OT-/.test(r.hallazgo.orden) && r.hallazgo.equipo === 'JOY 2' && r.hallazgo.tipo === 'Correctivo' && r.hallazgo.prioridad === 'Alta'
      && r.hallazgo.tarea === 'Válvula de alivio sin certificar' && ordenes.some(f => f.includes(r.hallazgo.orden))
      && hall[1] && hall[1][col(hall, 'OrdenNumero')] === r.hallazgo.orden && !/Crear orden/.test(r.botonesHallazgo),
      { hallazgo: r.hallazgo, filaHallazgo: hall[1] });
    check('Empalme: repuestos con crítico y bodega; la lista de compras trae solo lo que hay que comprar',
      r.comprar === 'RK-1' && r.kpiRepuestos === '1' && rep.length === 3 && rep[1][col(rep, 'Critico')] === 'SI' && rep[1][col(rep, 'Bodega')] === 'Comprar',
      { comprar: r.comprar, kpi: r.kpiRepuestos, rep });
    const movGrasa = movs.find(f => f[0] === 'GR-2') || [];
    check('Empalme: la bodega pegada desde Excel entra al inventario como inventario inicial (cantidades y precios en formato colombiano)',
      r.filasBodega === 2 && /2 productos cargados.*2 nuevos/.test(r.bodegaMsg) && r.cargado === 2 && productos.length === 3
      && movs.length === 3 && movGrasa[3] === '1200.5' && movGrasa[8] === 'Inventario inicial — empalme de entrega'
      && (movs.find(f => f[0] === 'FA-1') || [])[10] === '85000',
      { msg: r.bodegaMsg, filas: r.filasBodega, cargado: r.cargado, productos, movs });
    check('Empalme: el acta trae equipos, horómetro, hallazgos, compras, bodega y firmas',
      /Acta de empalme de entrega — CO O-I ZIPAQUIRA 2/.test(r.acta) && /JOY 2/.test(r.acta) && /45\.210 h/.test(r.acta)
      && /Válvula de alivio sin certificar/.test(r.acta) && /Kit de sellos/.test(r.acta) && /GRASA/.test(r.acta) && /<b>Entrega<\/b>/.test(r.acta) && /<b>Recibe<\/b>/.test(r.acta)
      && /Detalle por equipo/.test(r.acta) && /Torre de enfriamiento a la que está conectado/.test(r.acta) && /Medición de vibraciones/.test(r.acta) && /7,1 mm\/s/.test(r.acta),
      r.acta.length);
    check('Empalme: el operario no crea órdenes ni edita repuestos', !r.operarioCreaOrden && r.operarioRepuestosRO, r);
    check('Empalme: sin errores de JS ni avisos de error', errs.length === 0 && r.avisos.length === 0, { errs: errs.slice(0, 2), avisos: r.avisos });
    await ctx.close();
  }
  {
    // Plan de Mantenimiento: cada sede ve sus propios compresores
    const { ctx, p, errs } = await nuevaPagina(b, { '**/sheets/v4/**': r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"values":[],"sheets":[],"valueRanges":[],"replies":[]}' }) });
    const r = await p.evaluate(async () => {
      const espera = () => new Promise(x => setTimeout(x, 400));
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionAutenticada = true;
      const leer = async sede => {
        operacionActual = sede; abrirPlanMantenimiento(sede); await espera();
        const reg = document.getElementById('pmRegistroHorasContenido');
        const out = {
          equipos: [...reg.querySelectorAll('tbody td:first-child')].map(td => td.textContent.trim()),
          texto: reg.textContent,
        };
        pmMostrarSubTab('configinformes'); await espera();
        out.horaBase = document.querySelectorAll('#pmHoraBaseContenido .pm-hora-base').length;
        out.actividades = document.getElementById('pmActividadesContenido').innerText;
        return out;
      };
      return { zipa2: await leer('zipaquira2'), zipa1: await leer('zipaquira') };
    });
    const z2 = r.zipa2, z1 = r.zipa1;
    check('Plan de Mantenimiento de Zipaquirá 2: sus 22 compresores (Baja y Alta Presión) en Registro y Configuración',
      z2.equipos.length === 22 && z2.equipos.includes('JOY 2') && z2.equipos.includes('IR 12') && !z2.equipos.includes('COMPRESOR DE EMERGENCIA NX200')
      && !z2.equipos.some(e => /Secador/.test(e)) && /Baja Presión/.test(z2.texto) && /Alta Presión/.test(z2.texto)
      && !/no captura horómetro/.test(z2.texto) && z2.horaBase === 22 && /todavía no están disponibles para esta sede/.test(z2.actividades) && errs.length === 0,
      { equipos: z2.equipos.length, horaBase: z2.horaBase, actividades: z2.actividades.slice(0, 80), errs: errs.slice(0, 2) });
    check('Plan de Mantenimiento de Zipaquirá: sigue con sus 11 compresores y el editor de actividades',
      z1.equipos.length === 11 && z1.equipos.includes('COMPRESOR DE EMERGENCIA NX200') && z1.horaBase === 11 && /Se aplica a/.test(z1.actividades),
      { equipos: z1.equipos.length, horaBase: z1.horaBase, actividades: z1.actividades.slice(0, 80) });
    await ctx.close();
  }
  {
    // Inventario de una sede nueva: la hoja solo tiene "Config". Abrirlo no
    // falla, y el primer producto crea la pestaña Productos.
    const pestanas = new Set(['Config']), creadas = [];
    const { ctx, p, errs } = await nuevaPagina(b, { '**/sheets/v4/**': route => {
      const u = decodeURIComponent(route.request().url());
      const json = (status, cuerpo) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(cuerpo) });
      if (/:batchUpdate/.test(u)) {
        const nueva = JSON.parse(route.request().postData()).requests[0]?.addSheet?.properties?.title;
        if (nueva) { pestanas.add(nueva); creadas.push(nueva); }
        return json(200, { replies: [] });
      }
      const rango = (u.match(/\/values\/([^?:]+)/) || [])[1] || '';
      if (rango && !pestanas.has(rango.split('!')[0])) return json(400, { error: { code: 400, message: 'Unable to parse range: ' + rango, status: 'INVALID_ARGUMENT' } });
      return json(200, { values: [], replies: [] });
    } });
    const r = await p.evaluate(async () => {
      const avisos = []; window.alert = m => avisos.push(String(m));
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionActual = 'zipaquira2'; operacionAutenticada = true;
      abrirInventario('zipaquira2');
      for (const sub of ['stock', 'lotes', 'servicios', 'proveedores', 'dashboard']) { invMostrarSubTab(sub); await new Promise(x => setTimeout(x, 300)); }
      const textoPanel = document.getElementById('panel-inventario').innerText;
      let stock = null, error = '';
      try {
        stock = (await obtenerStockInventarioDirecto('zipaquira2')).length;
        await registrarProductoInventarioDirecto('zipaquira2', { codigo: 'P-1', nombre: 'Filtro' });
      } catch (e) { error = e.message; }
      return { avisos, conError: /Unable to parse range|Error leyendo inventario/.test(textoPanel), stock, error };
    });
    check('Inventario de una sede nueva (hoja sin pestañas): abre vacío y el primer producto crea "Productos"',
      !r.conError && r.stock === 0 && !r.error && !r.avisos.some(a => /Unable to parse range|Error leyendo/.test(a)) && creadas.includes('Productos') && errs.length === 0,
      { ...r, creadas, errs: errs.slice(0, 2) });
    await ctx.close();
  }
  {
    // B2: la fecha del reporte técnico sale de su franja y no se guarda antes de que abra
    const ctx = await b.newContext({ timezoneId: 'America/Bogota' });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-10-12T02:30:00-05:00') });
    await p.goto(BASE, { waitUntil: 'load' });
    const r = await p.evaluate(() => ({
      abierta: _motivoReporteFueraDeVentana('2:00 a.m.'),
      antes: _motivoReporteFueraDeVentana('6:00 a.m.'),
      cerrada: _motivoReporteFueraDeVentana('10:00 p.m.'),
      fecha2am: _fechaDeFranjaReporte('2:00 a.m.'),
      fecha10pm: _fechaDeFranjaReporte('10:00 p.m.'),
      soloLectura: document.getElementById('rc_fecha').readOnly,
    }));
    check('B2: reporte técnico no se guarda antes de abrir ni después de cerrar', r.abierta === '' && /todavía no abre/.test(r.antes) && /ya pasó/.test(r.cerrada), r);
    check('B2: la fecha la pone la franja (2 a.m. de hoy, 10 p.m. de anoche)', r.fecha2am === '2026-10-12' && r.fecha10pm === '2026-10-11' && r.soloLectura, r);
    await ctx.close();
  }
  {
    // B6: con el almacenamiento bloqueado la app igual arranca; B7: "Salir" pide otra vez la clave de sede
    const ctx = await b.newContext();
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    await ctx.addInitScript(() => {
      if (!location.search.includes('bloqueado')) return;
      for (const nombre of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, nombre, { configurable: true, get() { throw new DOMException('bloqueado', 'SecurityError'); } });
      }
    });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.goto(BASE + '?bloqueado', { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const login = await p.evaluate(() => !!document.getElementById('loginDocumento') && document.getElementById('loginDocumento').offsetParent !== null);
    check('B6: con el almacenamiento bloqueado la app arranca y muestra el login', errs.length === 0 && login, errs.slice(0, 2));

    await p.goto(BASE, { waitUntil: 'load' });
    // cerrarSesion recarga la página: se deja salir la llamada y se espera la recarga.
    await Promise.all([p.waitForEvent('load'), p.evaluate(() => { sessionStorage.setItem('operacionAutenticada', 'zipaquira'); setTimeout(() => cerrarSesion(), 50); })]);
    const tras = await p.evaluate(() => sessionStorage.getItem('operacionAutenticada'));
    await Promise.all([p.waitForEvent('load'), p.evaluate(() => { setTimeout(() => cerrarSesion(true), 50); })]);
    const trasSalir = await p.evaluate(() => sessionStorage.getItem('operacionAutenticada'));
    check('B7: "Salir" borra la sede validada; la sesión vencida no', tras === 'zipaquira' && trasSalir === null, { tras, trasSalir });

    // Un aviso seguido de una recarga ("Recargando...") se vuelve a mostrar al cargar
    await Promise.all([p.waitForEvent('load'), p.evaluate(() => { setTimeout(() => { alert('✅ Caché local limpiado. Recargando...'); location.reload(); }, 50); })]);
    await p.waitForTimeout(300);
    const avisoTrasRecarga = await p.evaluate(() => document.querySelector('#avisos .aviso.exito .aviso-texto')?.textContent || '');
    check('Avisos: el que va antes de una recarga se ve después de recargar', /Caché local limpiado/.test(avisoTrasRecarga), avisoTrasRecarga);

    await p.setViewportSize({ width: 390, height: 800 });
    const altoMapa = await p.evaluate(() => getComputedStyle(document.getElementById('mapaOperacion')).height);
    check('B13: el mapa de Inicio es más bajo en celular', altoMapa === '300px', altoMapa);
    await ctx.close();
  }
  {
    // Revisión general: fechas en hora de Colombia a las 8:30 p.m. (en UTC ya
    // es el día siguiente), la Hoja de Vida dentro de la pantalla, la barra
    // de abajo del celular, la pestaña "Actividades" solo en Zipaquirá y los
    // filtros con el estilo de la app.
    const fake = sheetsEnMemoria();
    const ctx = await b.newContext({ timezoneId: 'America/Bogota', viewport: { width: 1366, height: 900 } });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    await ctx.route('**/sheets/v4/**', fake.route);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.clock.install({ time: new Date('2026-10-15T20:30:00-05:00') });
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const invId = await p.evaluate(() => _invSpreadsheetId('zipaquira'));
    fake.crear(invId, 'Productos', [['Codigo', 'Nombre'], ['P-1', 'FILTRO']]);
    fake.crear(invId, 'Movimientos', [['Codigo', 'Fecha', 'Tipo', 'Cantidad'],
      ...['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'].map((f, i) => ['P-1', f, 'INGRESO', String(i + 1)])]);
    const anchoHvd = () => p.evaluate(() => ({ pagina: document.documentElement.scrollWidth, ventana: innerWidth }));
    const r = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionActual = 'zipaquira'; operacionAutenticada = true;
      const historial = await obtenerHistorialInventarioDirecto('zipaquira', { fechaDesde: '2026-10-15', fechaHasta: '2026-10-16' });
      abrirInventario('zipaquira'); await espera(300);
      const out = {
        historial: historial.map(m => m.fecha).sort().join(','),
        fechaMov: document.getElementById('invm_fecha').value,
        fechaServ: document.getElementById('invs_fecha').value,
      };
      // Borde, esquinas y fondo de la app (la letra puede ser propia: algunos filtros la llevan más pequeña).
      const muestra = document.body.appendChild(Object.assign(document.createElement('div'), { style: 'border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)' }));
      const estilo = el => { const cs = getComputedStyle(el); return [cs.borderTopColor, cs.borderTopLeftRadius, cs.backgroundColor].join(' '); };
      const esperado = estilo(muestra); muestra.remove();
      const filtros = ['novBuscar', 'novFiltroMes', 'histSelectorVista', 'histBuscarEquipo', 'ieFiltroTipo', 'lotesBuscarProducto',
        'invsBuscar', 'provFiltroTipo', 'emph_filtro', 'empr_filtro', 'empb_pegar'];
      out.sinEstilo = filtros.filter(id => !document.getElementById(id) || estilo(document.getElementById(id)) !== esperado);
      // Las reglas propias siguen mandando: una celda de tabla de órdenes conserva su letra de 12px.
      document.querySelector('.dyn-table tbody')?.insertAdjacentHTML('beforeend', '<tr><td><input id="pruebaCelda"></td></tr>');
      out.celda = document.getElementById('pruebaCelda') ? getComputedStyle(document.getElementById('pruebaCelda')).fontSize : 'sin tabla';
      showPanel('historico'); document.getElementById('histSelectorVista').value = 'hvd'; histCambiarVista(); await espera(300);
      await hvdSeleccionarEquipo('CA1'); await espera(300);
      out.tablaRepuestos = !!document.querySelector('#hvdContenido .tabla-repuestos');
      return out;
    });
    const hvdPc = await anchoHvd();
    await p.setViewportSize({ width: 1024, height: 768 });
    const hvdTablet = await anchoHvd();
    await p.setViewportSize({ width: 390, height: 844 });
    const nav = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const activo = () => [...document.querySelectorAll('#bottomNav button.activo')].map(x => x.dataset.panel).join(',') || 'ninguno';
      const tabActividades = () => document.querySelector('#panel-cronograma [data-crontab="actividades"]').style.display !== 'none';
      const out = {};
      showPanel('cronograma'); await espera(200); out.reportes = activo();
      out.tabActividadesZipa = tabActividades();
      abrirInventario('zipaquira'); await espera(200); out.inventario = activo();
      showPanel('pendientes'); await espera(100); out.pendientes = activo();
      abrirPlanMantenimiento('zipaquira'); await espera(200); out.plan = activo();
      showPanel('novedades'); await espera(100);
      abrirVariables(VARIABLES_APARTADOS[0].key); await espera(200); out.variables = activo();
      operacionActual = 'zipaquira2';
      showPanel('cronograma'); await espera(200);
      out.tabActividadesZipa2 = tabActividades();
      cronMostrarSubTab('actividades');
      out.subtabZipa2 = document.querySelector('#panel-cronograma .inv-subtab.active')?.dataset.crontab;
      return out;
    });
    check('Inventario: el historial filtrado por fechas trae los movimientos del día "Desde" y no los del día siguiente al "Hasta"',
      r.historial === '2026-10-15,2026-10-16', r.historial);
    check('Inventario: a las 8:30 p.m. la fecha de un movimiento o servicio nuevo es la de hoy, no la de mañana',
      r.fechaMov === '2026-10-15' && r.fechaServ === '2026-10-15', { mov: r.fechaMov, serv: r.fechaServ });
    check('Hoja de Vida: la ficha con su tabla de repuestos no se sale de la pantalla en computador ni en tablet',
      r.tablaRepuestos && hvdPc.pagina <= hvdPc.ventana && hvdTablet.pagina <= hvdTablet.ventana, { hvdPc, hvdTablet, tabla: r.tablaRepuestos });
    check('Filtros de Novedades, Histórico, Inventario y Empalme con el estilo de la app; las reglas propias siguen mandando',
      r.sinEstilo.length === 0 && r.celda === '12px', { sinEstilo: r.sinEstilo, celda: r.celda });
    check('Celular: la barra de abajo solo marca la sección en la que se está',
      nav.reportes === 'cronograma' && nav.pendientes === 'pendientes' && nav.inventario === 'ninguno' && nav.plan === 'ninguno' && nav.variables === 'ninguno', nav);
    check('Reportes: la pestaña "Actividades" (aviso de alturas) solo aparece en Zipaquirá',
      nav.tabActividadesZipa && !nav.tabActividadesZipa2 && nav.subtabZipa2 === 'temporal', nav);
    check('Revisión: sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }
  {
    // Reporte Emergencia: el Compresor IR tiene su propio formato (otro
    // controlador que el NXD 220). Se guarda a las 10:20 a.m., dentro de la
    // franja de las 10.
    const fake = sheetsEnMemoria();
    const ctx = await b.newContext({ timezoneId: 'America/Bogota' });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    await ctx.route('**/sheets/v4/**', fake.route);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.clock.install({ time: new Date('2026-10-15T10:20:00-05:00') });
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const r = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const avisos = []; window.alert = m => avisos.push(String(m)); window.confirmarAccion = async () => true;
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionActual = 'zipaquira'; operacionAutenticada = true;
      currentUser = { name: 'Ana Prueba', email: 'a@x' };
      showPanel('cronograma'); await espera(200);
      cronMostrarSubTab('emergencia'); await espera(500);
      const elegir = async c => { const s = document.getElementById('re_compresor'); s.value = c; s.dispatchEvent(new Event('change')); await espera(50); };
      const etiquetas = () => [...document.querySelectorAll('#re_camposMediciones .field label')].map(l => l.textContent);
      const out = { sinElegir: document.getElementById('re_camposMediciones').textContent.trim() };
      await elegir('Compresor NXD 220');
      out.nxd = { campos: etiquetas().length, disP: etiquetas().some(t => /^Dis\. P/.test(t)), nivelVisible: document.getElementById('re_nivelAceiteWrap').style.display !== 'none',
        estados: [...document.querySelectorAll('#re_estadoEquipo option')].map(o => o.value).filter(Boolean).join(',') };
      await elegir('Compresor IR');
      out.ir = { campos: etiquetas(), nivelVisible: document.getElementById('re_nivelAceiteWrap').style.display !== 'none',
        etiquetaEstado: document.getElementById('re_estadoEquipoLabel').textContent,
        estados: [...document.querySelectorAll('#re_estadoEquipo option')].map(o => o.value).filter(Boolean).join(','),
        listas: document.querySelectorAll('#re_camposMediciones select').length };
      // Se llena el reporte del IR
      document.getElementById('re_tecnico').value = TECNICOS_REPORTE_EMERGENCIA[0];
      document.getElementById('re_hora').value = '10:00 a.m.';
      document.getElementById('re_estadoEquipo').value = 'Si';
      REPORTE_EMERGENCIA_CAMPOS_IR.forEach((c, i) => {
        const el = document.getElementById('re_' + c.id);
        el.value = c.tipo === 'opciones' ? 'OK' : c.tipo === 'texto' ? 'Automático' : String(100 + i);
      });
      document.getElementById('re_irHorasFuncionamiento').value = '15234.5';
      document.getElementById('re_irArranques').value = '';
      await guardarReporteEmergencia();
      out.faltaArranques = document.getElementById('re_msg').textContent;
      await elegir('Compresor IR');
      document.getElementById('re_tecnico').value = TECNICOS_REPORTE_EMERGENCIA[0];
      document.getElementById('re_hora').value = '10:00 a.m.';
      document.getElementById('re_estadoEquipo').value = 'Si';
      REPORTE_EMERGENCIA_CAMPOS_IR.forEach((c, i) => {
        document.getElementById('re_' + c.id).value = c.tipo === 'opciones' ? (c.col === 'IrEstadoFiltroEntrada' ? 'Alerta' : 'OK') : c.tipo === 'texto' ? 'Automático' : String(100 + i);
      });
      document.getElementById('re_irHorasFuncionamiento').value = '15234.5';
      await guardarReporteEmergencia();
      await espera(300);
      out.msg = document.getElementById('re_msg').textContent;
      const guardado = allReportesEmergencia[0] || {};
      out.vista = _construirHtmlReporteEmergencia(guardado);
      // Un reporte del IR de antes de su formato (con los campos del NXD) se sigue viendo completo.
      out.vistaVieja = _construirHtmlReporteEmergencia({ Codigo: 'RE-0000', Compresor: 'Compresor IR', Fecha: '2026-10-01', Hora: '6:00 a.m.',
        Tecnico: 'X', EstadoEquipo: 'Si', NivelAceite: 'Normal', DisP: '95', RunTime: '15000' });
      out.variables = VARIABLES_APARTADOS.find(a => a.key === 'emergencia').fuentes[0].campos('Compresor IR');
      out.variablesNxd = VARIABLES_APARTADOS.find(a => a.key === 'emergencia').fuentes[0].campos('Compresor NXD 220').length;
      out.avisos = avisos;
      return out;
    });
    const filas = fake.hoja(await p.evaluate(() => GOOGLE_CONFIG.spreadsheetId), 'ReporteEmergencia');
    const enc = filas[0] || [], fila = filas[1] || [];
    const val = col => fila[enc.indexOf(col)];
    const horas = fake.hoja(await p.evaluate(() => GOOGLE_CONFIG.spreadsheetId), 'HorasEquipos');
    const horasIr = (horas.find(f => f[0] === 'COMPRESOR EMERGENCIA IR160') || [])[1];
    check('Reporte Emergencia: el NXD 220 sigue con sus campos y nivel de aceite; los campos salen al elegir el compresor',
      /Elige el compresor/.test(r.sinElegir) && r.nxd.campos === 26 && r.nxd.disP && r.nxd.nivelVisible && r.nxd.estados === 'Si,No,En espera', { sinElegir: r.sinElegir, nxd: r.nxd });
    check('Compresor IR: su formato (configuración, horas, mediciones y mantenimiento), "¿en línea?" Sí/No y sin nivel de aceite',
      r.ir.campos.length === 24 && r.ir.campos[0] === 'Presión de carga [PSI]' && r.ir.campos.includes('Offset de esclavo [PSI]')
      && r.ir.campos.includes('Presión del cárter (tanque separador aire/aceite) [PSI]') && r.ir.campos.includes('Intervalo de servicios [h]')
      && !r.ir.campos.some(t => /^Dis\. P/.test(t)) && !r.ir.nivelVisible && /en línea/.test(r.ir.etiquetaEstado) && r.ir.estados === 'Si,No' && r.ir.listas === 3,
      { ir: r.ir });
    check('Compresor IR: no guarda con un campo vacío; guardado, sus horas de funcionamiento pasan al horómetro del IR160',
      /Arranques/.test(r.faltaArranques) && /guardado correctamente/.test(r.msg) && val('Compresor') === 'Compresor IR' && val('EstadoEquipo') === 'Si'
      && val('NivelAceite') === '' && val('RunTime') === '15234.5' && val('IrModoOperacion') === 'Automático' && val('IrEstadoFiltroEntrada') === 'Alerta'
      && val('IrPresionCarter') === '111' && val('DisP') === '' && horasIr === '15234.5',
      { falta: r.faltaArranques, msg: r.msg, RunTime: val('RunTime'), carter: val('IrPresionCarter'), filtro: val('IrEstadoFiltroEntrada'), horasIr });
    check('Compresor IR: la vista y el PDF muestran su formato (los reportes de antes, con el del NXD); Variables grafica sus campos (sin los de texto)',
      /¿Compresor en línea\?/.test(r.vista) && /Presión del cárter/.test(r.vista) && /Estado filtro de entrada/.test(r.vista) && !/Nivel de aceite/.test(r.vista)
      && r.variables.length === 32 && !r.variables.some(c => c.col === 'IrModoOperacion') && JSON.stringify(r.variables.find(c => c.col === 'IrEstadoSeparador').escala) === '["Requiere cambio","Alerta","OK"]'
      && r.variablesNxd === 37 && /Dis\. P/.test(r.vistaVieja) && /Nivel de aceite/.test(r.vistaVieja) && !/Presión del cárter/.test(r.vistaVieja),
      { variables: r.variables.length, nxd: r.variablesNxd, vistaVieja: /Dis\. P/.test(r.vistaVieja) });
    check('Compresor IR: sin errores de JS ni avisos', errs.length === 0 && r.avisos.length === 0, { errs: errs.slice(0, 2), avisos: r.avisos });
    await ctx.close();
  }
  {
    // Reportes técnicos y capacidad: 60 días de reportes de compresores (42
    // por día) en una pestaña que, como las que crea la app, tiene sus 999
    // filas vacías al final.
    const fake = sheetsEnMemoria();
    const ctx = await b.newContext({ timezoneId: 'America/Bogota' });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    await ctx.route('**/sheets/v4/**', fake.route);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.clock.install({ time: new Date('2026-10-15T10:20:00-05:00') });
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const { id, invId, cols } = await p.evaluate(() => ({ id: GOOGLE_CONFIG.spreadsheetId, invId: _invSpreadsheetId('zipaquira'), cols: REPORTE_COMPRESORES_COLS }));
    const filas = [cols];
    let n = 0;
    for (let d = 59; d >= 0; d--) {
      const fecha = new Date(Date.UTC(2026, 9, 15 - d)).toISOString().slice(0, 10);
      for (let k = 0; k < 42; k++) {
        n++;
        filas.push(cols.map(c => ({ Codigo: `RC-${String(n).padStart(4, '0')}-P${n}`, Fecha: fecha, Hora: '6:00 a.m.', Tecnico: 'Técnico Uno',
          Compresor: 'Compresor de Alta Presión #1', Estado: 'Activo', FechaRegistro: fecha + 'T11:00:00Z' })[c] ?? '1'));
      }
    }
    fake.crear(id, 'ReporteCompresores', filas);
    fake.crear(invId, 'Config', [['clave-secreta']]);
    fake.crear(invId, 'Movimientos', [['Código', 'Fecha', 'Tipo'], ['P-1', '2026-07-01', 'INGRESO'], ['P-1', '2026-10-01', 'SALIDA']]);
    const lecturasCompletas = () => fake.peticiones.filter(x => /ReporteCompresores!A:ZZ/.test(x.ruta)).length;

    const abierto = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionActual = 'zipaquira'; operacionAutenticada = true;
      currentUser = { name: 'Ana Prueba', email: 'a@x' };
      showPanel('cronograma'); await espera(200);
      cronMostrarSubTab('compresores'); await espera(800);
      return { cargados: allReportesCompresores.length, siguiente: _siguienteCodigoReporteCompresor().slice(0, 7),
        masViejo: allReportesCompresores[allReportesCompresores.length - 1]?.Fecha };
    });
    const completasAlAbrir = lecturasCompletas();
    const viejos = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      window.confirmarAccion = async () => true;
      document.getElementById('rc_filtroDesde').value = '2026-08-17';
      document.getElementById('rc_filtroHasta').value = '2026-08-18';
      renderTablaReportesCompresores();
      const cargando = document.getElementById('rc_tablaWrap').textContent;
      await espera(800);
      const out = { cargando, filasTabla: document.querySelectorAll('#rc_tablaWrap tbody tr').length };
      const viejo = allReportesCompresores.find(f => f.Fecha === '2026-08-17');
      out.viejo = { codigo: viejo.Codigo, fila: viejo._row };
      await eliminarReporteCompresor(viejo.Codigo); await espera(500);
      out.trasEliminar = document.querySelectorAll('#rc_tablaWrap tbody tr').length;
      return out;
    });
    const hoja = fake.hoja(id, 'ReporteCompresores');
    const filaEliminada = hoja[viejos.viejo.fila - 1] || [];
    check('Reportes técnicos: al abrir se bajan los últimos días (no la historia entera) y el siguiente código sigue la numeración',
      completasAlAbrir === 0 && abierto.cargados > 300 && abierto.cargados < 700 && abierto.masViejo <= '2026-10-08' && abierto.siguiente === 'RC-2521',
      { completasAlAbrir, ...abierto });
    check('Reportes técnicos: fechas viejas en el filtro se traen al pedirlas; borrar uno viejo marca su fila correcta',
      /Cargando/.test(viejos.cargando) && viejos.filasTabla === 84 && filaEliminada[0] === viejos.viejo.codigo
      && filaEliminada[cols.indexOf('Estado')] === 'Eliminada' && viejos.trasEliminar === 83,
      { ...viejos, filaEliminada: filaEliminada[0] });

    // Capacidad de las hojas (admin): los tres archivos de la sede.
    const antesCapacidad = fake.peticiones.length;
    const cap = await p.evaluate(async () => {
      await abrirCapacidadHojas();
      const tarjetas = [...document.querySelectorAll('#capacidadOverlay .cap-archivo')];
      return {
        tarjetas: tarjetas.map(t => t.querySelector('.cap-titulo')?.textContent),
        operaciones: tarjetas[0]?.innerText || '',
        inventario: tarjetas[1]?.innerText || '',
        pct: Number(tarjetas[0]?.querySelector('.cap-barra')?.getAttribute('aria-valuenow')),
        primeraPestana: tarjetas[0]?.querySelector('.cap-tabla tbody td')?.textContent,
      };
    });
    const leidasCapacidad = fake.peticiones.slice(antesCapacidad).map(x => x.ruta).join(' ');
    check('Capacidad: mide operaciones, inventario y proyectos; la pestaña más pesada, sus filas con datos y el ritmo',
      cap.tarjetas.length === 3 && /^Operaciones — /.test(cap.tarjetas[0]) && /^Inventario — /.test(cap.tarjetas[1]) && /^Proyectos/.test(cap.tarjetas[2])
      && cap.primeraPestana === 'ReporteCompresores' && /2\.520/.test(cap.operaciones) && /Crece unas 3\.486 celdas por día/.test(cap.operaciones)
      && /filas vacías/.test(cap.operaciones) && cap.pct >= 2 && cap.pct < 10 && /Movimientos/.test(cap.inventario),
      { ...cap, operaciones: cap.operaciones.slice(0, 300) });
    check('Capacidad: no lee la celda de la clave de la sede (Config)', !/Config/.test(leidasCapacidad), leidasCapacidad.slice(0, 200));
    check('Reportes técnicos y capacidad: sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }
  {
    // Reportes → Máquinas de Formación (Zipaquirá): máquina, referencia de
    // botella, sección (de la lista de esa máquina: E1 12, E2 8, E3 y E4 10,
    // las F 12), cavidades y velocidad.
    const fake = sheetsEnMemoria();
    const ctx = await b.newContext({ timezoneId: 'America/Bogota' });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    await ctx.route('**/sheets/v4/**', fake.route);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.clock.install({ time: new Date('2026-10-16T09:15:00-05:00') });
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const r = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const avisos = []; window.alert = m => avisos.push(String(m));
      googleAccessToken = 'SESS.x'; usuarioRol = 'operario'; operacionAutenticada = true;
      currentUser = { name: 'Técnico Uno', email: 't@x' };
      const tab = () => document.getElementById('cronTabFormacion');
      operacionActual = 'zipaquira2'; showPanel('cronograma'); await espera(200);
      const out = { visibleZipa2: tab().style.display !== 'none' };
      operacionActual = 'zipaquira'; showPanel('cronograma'); await espera(200);
      out.visibleZipa = tab().style.display !== 'none';
      out.alLado = document.getElementById('cronTabCompresores').nextElementSibling === tab();
      cronMostrarSubTab('formacion'); await espera(500);
      const elegir = async (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); await espera(20); };
      out.maquinas = [...document.querySelectorAll('#rmf_maquina option')].map(o => o.value).filter(Boolean).join(',');
      out.cavidades = [...document.querySelectorAll('#rmf_cavidades option')].map(o => o.value).filter(Boolean).join(',');
      out.seccionSinMaquina = document.getElementById('rmf_seccion').disabled;
      out.hora = document.getElementById('rmf_hora').value;
      const secciones = async m => { await elegir('rmf_maquina', m); const el = document.getElementById('rmf_seccion'); return el.tagName === 'SELECT' ? [...el.options].filter(o => o.value).length : el.tagName; };
      out.secciones = {};
      for (const m of ['E1', 'E2', 'E3', 'E4', 'F1', 'F2', 'F3']) out.secciones[m] = await secciones(m);
      out.seccionesF = [...document.querySelectorAll('#rmf_seccion option')].map(o => o.value).filter(Boolean).join(',');
      // Faltan datos
      await elegir('rmf_tecnico', TECNICOS_REPORTE_MAQUINAS_FORMACION[0]);
      await guardarReporteMaquinasFormacion();
      out.falta = document.getElementById('rmf_msg').textContent;
      // F1, sección 7
      await elegir('rmf_maquina', 'F1');
      document.getElementById('rmf_referencia').value = 'BOT-355 ÁMBAR';
      await elegir('rmf_seccion', '7');
      await elegir('rmf_cavidades', '2');
      document.getElementById('rmf_velocidad').value = '65';
      await guardarReporteMaquinasFormacion(); await espera(200);
      out.msg = document.getElementById('rmf_msg').textContent;
      out.tecnicoQueda = document.getElementById('rmf_tecnico').value;
      // E3, sección 5 de su lista
      await elegir('rmf_maquina', 'E3');
      document.getElementById('rmf_referencia').value = 'BOT-200';
      await elegir('rmf_seccion', '5');
      await elegir('rmf_cavidades', '3');
      document.getElementById('rmf_velocidad').value = '70 bpm';
      await guardarReporteMaquinasFormacion(); await espera(200);
      document.getElementById('rmf_filtroDesde').value = '2026-10-16'; renderTablaReportesMaquinasFormacion();
      out.tabla = [...document.querySelectorAll('#rmf_tablaWrap tbody tr')].map(tr => [...tr.children].slice(3, 6).map(td => td.textContent.trim()).join('/'));
      out.vista = _construirHtmlReporteMaquinasFormacion(allReportesMaquinasFormacion.find(x => x.Maquina === 'F1'));
      out.avisos = avisos;
      return out;
    });
    const filas = fake.hoja(await p.evaluate(() => GOOGLE_CONFIG.spreadsheetId), 'ReporteMaquinasFormacion');
    const enc = filas[0] || [];
    const fila = m => (filas.find(f => f[enc.indexOf('Maquina')] === m) || []);
    const val = (m, c) => fila(m)[enc.indexOf(c)];
    check('Máquinas de Formación: pestaña solo en Zipaquirá, justo al lado de Reporte Compresores',
      r.visibleZipa && !r.visibleZipa2 && r.alLado, { zipa: r.visibleZipa, zipa2: r.visibleZipa2, alLado: r.alLado });
    check('Máquinas de Formación: E1–E4 y F1–F3, cavidades 1–3; secciones E1 12, E2 8, E3 10, E4 10 y las F 12',
      r.maquinas === 'E1,E2,E3,E4,F1,F2,F3' && r.cavidades === '1,2,3' && r.seccionSinMaquina && r.hora === '09:15'
      && JSON.stringify(r.secciones) === JSON.stringify({ E1: 12, E2: 8, E3: 10, E4: 10, F1: 12, F2: 12, F3: 12 })
      && r.seccionesF === '1,2,3,4,5,6,7,8,9,10,11,12',
      { maquinas: r.maquinas, cavidades: r.cavidades, secciones: r.secciones, seccionesF: r.seccionesF, hora: r.hora });
    check('Máquinas de Formación: pide lo que falta y guarda máquina, referencia, sección, cavidades y velocidad',
      /^Falta la referencia de botella, la sección, las cavidades y la velocidad\.$/.test(r.falta) && /F1 guardado/.test(r.msg) && r.tecnicoQueda !== ''
      && val('F1', 'ReferenciaBotella') === 'BOT-355 ÁMBAR' && val('F1', 'Seccion') === '7' && val('F1', 'Cavidades') === '2' && val('F1', 'Velocidad') === '65'
      && val('F1', 'Fecha') === '2026-10-16' && val('E3', 'Seccion') === '5' && val('E3', 'Velocidad') === '70 bpm'
      && r.tabla.length === 2 && r.tabla.includes('F1/7/BOT-355 ÁMBAR') && /Referencia de botella/.test(r.vista) && /BOT-355 ÁMBAR/.test(r.vista),
      { falta: r.falta, msg: r.msg, tabla: r.tabla, F1: fila('F1') });
    check('Máquinas de Formación: sin errores de JS ni avisos', errs.length === 0 && r.avisos.length === 0, { errs: errs.slice(0, 2), avisos: r.avisos });
    await ctx.close();
  }
  {
    // Aspecto: logo sin fondo (claro y oscuro) en el encabezado, el login y
    // los documentos; colores de estado y del Plan que siguen el tema; en
    // celular, encabezado de una fila con la cuenta en el menú lateral.
    const nuevo = async vp => {
      const ctx = await b.newContext({ viewport: vp, timezoneId: 'America/Bogota' });
      await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
      await ctx.route('**/sheets/v4/**', sheetsEnMemoria().route);
      const p = await ctx.newPage();
      const errs = []; p.on('pageerror', e => errs.push(String(e)));
      await p.clock.install({ time: new Date('2026-10-16T09:15:00-05:00') });
      await p.goto(BASE, { waitUntil: 'load' });
      await p.waitForTimeout(500);
      return { ctx, p, errs };
    };
    const pc = await nuevo({ width: 1366, height: 900 });
    const r = await pc.p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const out = {};
      const raiz = () => getComputedStyle(document.documentElement);
      const dataDe = v => (/url\(\s*['"]?([^'")\s]+)/.exec(raiz().getPropertyValue(v)) || [])[1] || '';
      const claro = dataDe('--logo-claro'), oscuro = dataDe('--logo-oscuro');
      out.logos = claro.startsWith('data:image/png;base64,') && oscuro.startsWith('data:image/png;base64,') && claro !== oscuro;
      out.sinJpeg = !document.documentElement.outerHTML.includes('data:image/jpeg');
      // Login: el logo arriba en la tarjeta, la tarjeta más ancha y el título
      // con corte parejo. Que quepa en una línea depende de la letra del
      // equipo (Segoe UI, Roboto…); en el servidor de pruebas hay otra más
      // ancha, así que se revisa el ancho y el corte, no el número de líneas.
      const tarjeta = document.querySelector('#loginOverlay .login-tarjeta');
      const logoLogin = tarjeta.querySelector('.login-logo');
      out.loginLogo = !!logoLogin && getComputedStyle(logoLogin).backgroundImage.includes(claro.slice(-40)) && logoLogin.getBoundingClientRect().width >= 200;
      const h2 = tarjeta.querySelector('h2');
      const csH2 = getComputedStyle(h2);
      out.tarjetaAncha = Math.round(tarjeta.getBoundingClientRect().width) === 440;
      out.tituloParejo = /balance/.test(csH2.textWrap || '') || csH2.textWrapStyle === 'balance';
      document.getElementById('loginOverlay').remove();
      const encabezado = () => getComputedStyle(document.querySelector('.header-logo-img')).backgroundImage;
      out.encabezadoClaro = encabezado().includes(claro.slice(-40));
      // Documento de la orden dentro de la app y en el visor (hoja blanca).
      const enApp = document.createElement('div'); enApp.innerHTML = _encabezadoPdfHtml('Orden de Trabajo', 'Prueba');
      const visor = document.createElement('div'); visor.className = 'visor-doc-hoja'; visor.innerHTML = _encabezadoPdfHtml('Orden de Trabajo', 'Prueba');
      document.body.append(enApp, visor);
      const muestra = css => { const s = document.createElement('span'); s.style.cssText = css; document.body.appendChild(s); const c = getComputedStyle(s); const v = [c.backgroundColor, c.color]; s.remove(); return v.join(' / '); };
      const timer = document.createElement('span'); timer.className = 'cron-timer'; timer.setAttribute('data-hora', '06:00'); document.body.appendChild(timer);
      const tarjetaAviso = document.querySelector('#cronSub-actividades .tarjeta-advertencia');
      out.claro = {
        peligro: muestra('background:var(--estado-peligro-bg);color:var(--estado-peligro-tx)'),
        pmVerde: muestra('background:var(--pm-verde)').split(' / ')[0],
      };
      // Modo oscuro
      alternarTema(); await espera(50);
      out.encabezadoOscuro = encabezado().includes(oscuro.slice(-40));
      out.pdfSiempreClaro = getLogoDataUrl() === claro && enApp.querySelector('img.logo-doc').getAttribute('src') === claro;
      out.docOscuroEnApp = getComputedStyle(enApp.querySelector('img.logo-doc')).content.includes(oscuro.slice(-40));
      out.docClaroEnVisor = getComputedStyle(visor.querySelector('img.logo-doc')).content === 'normal';
      _actualizarCronometrosCheckpoints();
      out.timer = timer.textContent + ' | ' + timer.style.background + ' | ' + getComputedStyle(timer).backgroundColor;
      out.oscuro = {
        peligro: muestra('background:var(--estado-peligro-bg);color:var(--estado-peligro-tx)'),
        pmVerde: muestra('background:var(--pm-verde)').split(' / ')[0],
        tarjetaAviso: getComputedStyle(tarjetaAviso).backgroundColor,
      };
      alternarTema(); await espera(50);
      // En computador la cuenta sigue en el encabezado, no en el menú.
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; currentUser = { name: 'Ana Prueba', initials: 'AP', email: 'a@x' };
      _aplicarRolUI();
      out.cuentaEnMenuPc = getComputedStyle(document.querySelector('#sidebarOperaciones .sidebar-cuenta')).display;
      out.botonesPc = ['btnTema', 'btnSalir'].map(id => getComputedStyle(document.getElementById(id)).display).join(',');
      return out;
    });
    check('Aspecto: el logo va sin fondo (PNG claro y oscuro) y ya no queda el JPEG con fondo blanco', r.logos && r.sinJpeg, { logos: r.logos, sinJpeg: r.sinJpeg });
    check('Aspecto: el login muestra el logo arriba, la tarjeta más ancha y el título con corte parejo', r.loginLogo && r.tarjetaAncha && r.tituloParejo,
      { loginLogo: r.loginLogo, tarjetaAncha: r.tarjetaAncha, tituloParejo: r.tituloParejo });
    check('Aspecto: el encabezado cambia al logo oscuro en modo oscuro; los documentos y el PDF siguen con el claro',
      r.encabezadoClaro && r.encabezadoOscuro && r.pdfSiempreClaro && r.docOscuroEnApp && r.docClaroEnVisor,
      { encabezadoClaro: r.encabezadoClaro, encabezadoOscuro: r.encabezadoOscuro, pdf: r.pdfSiempreClaro, docApp: r.docOscuroEnApp, visor: r.docClaroEnVisor });
    check('Aspecto: en oscuro los colores de estado, el Plan y la tarjeta de Actividades no quedan como parches claros',
      r.claro.peligro === 'rgb(253, 232, 232) / rgb(185, 28, 28)' && r.claro.pmVerde === 'rgb(198, 224, 180)'
      && r.oscuro.peligro === 'rgba(239, 107, 97, 0.15) / rgb(242, 139, 130)' && /^rgba\(112, 173, 71/.test(r.oscuro.pmVerde)
      && r.oscuro.tarjetaAviso === 'rgb(27, 33, 42)' && /Tiempo agotado \| var\(--estado-peligro-bg\) \| rgba\(239, 107, 97/.test(r.timer),
      { claro: r.claro, oscuro: r.oscuro, timer: r.timer });
    check('Aspecto: en computador "Oscuro" y "Salir" siguen en el encabezado', r.cuentaEnMenuPc === 'none' && !r.botonesPc.includes('none'), { menu: r.cuentaEnMenuPc, botones: r.botonesPc });
    await pc.ctx.close();

    const cel = await nuevo({ width: 390, height: 844 });
    const m = await cel.p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      document.getElementById('loginOverlay')?.remove();
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionAutenticada = true;
      currentUser = { name: 'Ana Prueba', initials: 'AP', email: 'a@x' };
      document.getElementById('userName').textContent = currentUser.name;
      document.getElementById('userInitials').textContent = currentUser.initials;
      _aplicarRolUI(); mostrarIndicadorStorage(true);
      const out = {};
      out.altoEncabezado = Math.round(document.querySelector('.app-header').getBoundingClientRect().height);
      out.ocultos = ['btnTema', 'btnSalir', 'userName', 'userRol'].map(id => getComputedStyle(document.getElementById(id)).display).join(',');
      const ind = document.getElementById('storageIndicator');
      out.conexion = ind.title + ' | ' + Math.round(ind.getBoundingClientRect().width);
      toggleSidebarMovil(true); await espera(350);
      const cuenta = document.querySelector('#sidebarOperaciones .sidebar-cuenta');
      out.cuenta = cuenta.innerText.replace(/\s+/g, ' ').trim();
      cuenta.querySelector('button[onclick="alternarTema()"]').click(); await espera(50);
      out.temaTrasMenu = document.documentElement.getAttribute('data-theme');
      toggleSidebarMovil(true); await espera(350);
      out.cuentaOscuro = cuenta.isConnected ? document.querySelector('#sidebarOperaciones .sidebar-cuenta').innerText.replace(/\s+/g, ' ').trim() : '';
      out.anchoPagina = document.documentElement.scrollWidth;
      return out;
    });
    check('Aspecto (celular): el encabezado va en una fila; "Oscuro", "Salir" y el nombre salen de él y la conexión queda como punto',
      m.altoEncabezado <= 60 && m.ocultos === 'none,none,none,none' && /^Google Sheets conectado \| \d+$/.test(m.conexion) && Number(m.conexion.split('| ')[1]) <= 12
      && m.anchoPagina <= 390, m);
    check('Aspecto (celular): el menú lateral trae el usuario, el cambio de tema y "Salir"',
      /^AP Ana Prueba admin Modo oscuro Salir$/i.test(m.cuenta) && m.temaTrasMenu === 'dark' && /Modo claro Salir$/.test(m.cuentaOscuro), m);
    check('Aspecto: sin errores de JS', pc.errs.length === 0 && cel.errs.length === 0, { pc: pc.errs.slice(0, 2), cel: cel.errs.slice(0, 2) });
    await cel.ctx.close();
  }
  {
    // Orden y navegación: Reportes en dos grupos, el mismo encabezado en
    // cada sección, una sola acción principal y las herramientas plegadas al
    // final del menú.
    const nuevo = async vp => {
      const ctx = await b.newContext({ viewport: vp, timezoneId: 'America/Bogota' });
      await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
      await ctx.route('**/sheets/v4/**', sheetsEnMemoria().route);
      const p = await ctx.newPage();
      const errs = []; p.on('pageerror', e => errs.push(String(e)));
      await p.goto(BASE, { waitUntil: 'load' });
      await p.waitForTimeout(500);
      await p.evaluate(() => {
        document.getElementById('loginOverlay')?.remove();
        googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionAutenticada = true; operacionActual = 'zipaquira';
        currentUser = { name: 'Ana Prueba', initials: 'AP', email: 'a@x' };
        _aplicarRolUI();
      });
      return { ctx, p, errs };
    };
    const pc = await nuevo({ width: 1366, height: 900 });
    const r = await pc.p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const out = {};
      const pestanas = id => [...document.querySelectorAll(`#${id} .inv-subtab`)].map(b => b.dataset.crontab).join(',');
      showPanel('cronograma'); await espera(200);
      out.turno = pestanas('cronGrupoTurno');
      out.tecnicos = pestanas('cronGrupoTecnicos');
      out.nombresTecnicos = [...document.querySelectorAll('#cronGrupoTecnicos .inv-subtab')].map(b => b.textContent.trim()).join(' | ');
      out.tecnicosZipa = getComputedStyle(document.getElementById('cronGrupoTecnicos')).display;
      operacionActual = 'soacha'; showPanel('cronograma'); await espera(200);
      out.tecnicosSoacha = getComputedStyle(document.getElementById('cronGrupoTecnicos')).display;
      operacionActual = 'zipaquira';
      // Encabezado común en cada sección
      const secciones = ['nueva', 'pendientes', 'realizadas', 'lista', 'dashboard', 'novedades', 'historico', 'cronograma', 'variables', 'inventario', 'empalme', 'planmantenimiento'];
      out.sinEncabezado = secciones.filter(k => {
        const h = document.querySelector(`#panel-${k} .seccion-encabezado .seccion-titulo`);
        return !h || !h.querySelector('svg') || !h.textContent.trim();
      }).join(',');
      // Pendientes: "Completar" es la principal y "Realizada" va con borde.
      try { await showPanel('pendientes'); } catch (e) {}
      await espera(300);
      allOrdenes = [{ id: 'P1', NumeroOrden: 'OT-P1', Title: 'Fuga', Estado: 'Pendiente', Equipo: 'CA1' }];
      renderPendientes(); await espera(150);
      const acciones = [...document.querySelectorAll('#pendientesContainer .item-actions .btn')];
      out.accionesPendiente = acciones.map(b => b.textContent.trim() + ':' + ['btn-primary', 'btn-success', 'btn-borde-ok', 'btn-ghost'].filter(c => b.classList.contains(c)).join('')).join(' | ');
      // Editor: "Guardar cambios" no es verde; la principal es "Marcar como Realizada".
      const guardar = document.querySelector('#subpanel-pend-editor [onclick="guardarEdicion()"]');
      out.guardarAdmin = getComputedStyle(guardar).backgroundImage === 'none' && getComputedStyle(guardar).color !== getComputedStyle(document.documentElement).getPropertyValue('--accent2').trim()
        && guardar.classList.contains('btn-ghost') && document.querySelector('#subpanel-pend-editor [onclick="guardarCierre()"]').classList.contains('btn-success');
      // Menú: las herramientas van plegadas al final.
      renderSidebarOperaciones();
      const menu = document.getElementById('sidebarOperaciones');
      out.herramientasPlegadas = !menu.querySelector('[onclick="repararHoja()"]') && !menu.querySelector('[onclick="limpiarCacheLocal()"]');
      const grupo = menu.querySelector('[data-grupo="herramientas"]');
      out.grupoAlFinal = !!grupo && [...menu.querySelectorAll('[data-grupo]')].pop() === grupo;
      grupo.click(); await espera(50);
      out.herramientasAbiertas = ['repararHoja()', 'abrirCapacidadHojas()', 'limpiarCacheLocal()'].every(f => menu.querySelector(`[onclick="${f}"]`));
      out.notificacionesArriba = menu.innerText.indexOf('Notificaciones') >= 0 && menu.innerText.indexOf('Notificaciones') < menu.innerText.indexOf('Nueva Orden');
      // El operario: sin "Marcar como Realizada", "Guardar cambios" es la principal.
      usuarioRol = 'operario'; _aplicarRolUI();
      out.guardarOperario = /linear-gradient/.test(getComputedStyle(guardar).backgroundImage);
      usuarioRol = 'admin'; _aplicarRolUI();
      return out;
    });
    check('Orden: Reportes en dos grupos (Turno y Reportes técnicos); los técnicos solo en Zipaquirá y sin repetir "Reporte"',
      r.turno === 'actividades,temporal,dashboard,observaciones,condiciones,herramienta'
      && r.tecnicos === 'compresores,formacion,secadores,drycoolers,decorado,emergencia,presiondrycooler'
      && !/Reporte /.test(r.nombresTecnicos) && r.tecnicosZipa !== 'none' && r.tecnicosSoacha === 'none', r);
    check('Orden: todas las secciones arrancan con el mismo encabezado (título con ícono)', r.sinEncabezado === '', r.sinEncabezado);
    check('Orden: una sola acción principal en las pendientes y en el editor',
      r.accionesPendiente === 'Ver:btn-ghost | Realizada:btn-borde-ok | Completar:btn-primary' && r.guardarAdmin && r.guardarOperario,
      { acciones: r.accionesPendiente, guardarAdmin: r.guardarAdmin, guardarOperario: r.guardarOperario });
    check('Orden: Reparar hoja, Capacidad y Limpiar caché van plegadas en "Herramientas", al final del menú',
      r.herramientasPlegadas && r.grupoAlFinal && r.herramientasAbiertas && r.notificacionesArriba, r);
    await pc.ctx.close();

    const cel = await nuevo({ width: 390, height: 844 });
    const m = await cel.p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const out = {};
      showPanel('cronograma'); await espera(200);
      const fila = document.querySelector('#cronGrupoTecnicos .cron-grupo-tabs');
      out.unaFila = new Set([...fila.querySelectorAll('.inv-subtab')].map(b => b.offsetTop)).size === 1 && fila.scrollWidth > fila.clientWidth;
      cronMostrarSubTab('presiondrycooler'); await espera(50);
      const tab = fila.querySelector('[data-crontab="presiondrycooler"]');
      const ft = fila.getBoundingClientRect(), tt = tab.getBoundingClientRect();
      out.pestanaAVista = tt.left >= ft.left - 1 && tt.right <= ft.right + 1;
      out.anchoPagina = document.documentElement.scrollWidth;
      // Novedades: la acción va debajo del título, que no se parte en tres líneas.
      showPanel('novedades'); await espera(100);
      const h2 = document.querySelector('#panel-novedades .seccion-titulo'), acc = document.querySelector('#panel-novedades .seccion-acciones');
      out.accionDebajo = acc.getBoundingClientRect().top >= h2.getBoundingClientRect().bottom - 1;
      out.tituloAncho = Math.round(h2.getBoundingClientRect().width) >= Math.round(h2.parentElement.getBoundingClientRect().width) - 1;
      // Tocar un grupo del menú lo despliega sin cerrar el menú.
      toggleSidebarMovil(true); await espera(300);
      const sb = document.getElementById('sidebarOperaciones');
      sb.querySelector('[data-grupo="herramientas"]').click(); await espera(50);
      out.menuSigueAbierto = sb.classList.contains('abierto') && !!sb.querySelector('[onclick="limpiarCacheLocal()"]');
      sb.querySelector('[onclick="showPanel(\'pendientes\')"]')?.click(); await espera(50);
      out.opcionCierra = !sb.classList.contains('abierto');
      return out;
    });
    check('Orden (celular): cada grupo de Reportes es una fila que se desliza y muestra la pestaña elegida',
      m.unaFila && m.pestanaAVista && m.anchoPagina <= 390, m);
    check('Orden (celular): en Novedades la acción va debajo del título, que usa todo el ancho', m.accionDebajo && m.tituloAncho, m);
    check('Orden (celular): desplegar un grupo del menú no lo cierra; elegir una opción sí', m.menuSigueAbierto && m.opcionCierra, m);
    check('Orden: sin errores de JS', pc.errs.length === 0 && cel.errs.length === 0, { pc: pc.errs.slice(0, 2), cel: cel.errs.slice(0, 2) });
    await cel.ctx.close();
  }
  {
    // Consistencia: la ventana de confirmación de la app (no la del
    // navegador), íconos de línea en vez de emojis y la escala corta de
    // tamaños de letra y radios.
    const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'America/Bogota' });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    await ctx.route('**/sheets/v4/**', sheetsEnMemoria().route);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.clock.install({ time: new Date('2026-10-16T09:15:00-05:00') });
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const r = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const out = {};
      document.getElementById('loginOverlay')?.remove();
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionAutenticada = true; operacionActual = 'zipaquira';
      currentUser = { name: 'Ana Prueba', initials: 'AP', email: 'a@x' };
      _aplicarRolUI();
      let nativas = 0; window.confirm = () => { nativas++; return true; };
      let escrituras = 0; const asegurarOriginal = window.asegurarHoja;
      window.asegurarHoja = async (...a) => { escrituras++; return asegurarOriginal(...a); };
      allReportesSecadores = [{ Codigo: 'RS-1', Fecha: '2026-10-16', Hora: '6:00 a.m.', Secador: 'S', Tecnico: 'T', _row: 2 }];
      // Borrar un reporte: la ventana de la app, en rojo, con el foco en "Cancelar".
      let pendiente = eliminarReporteSecador('RS-1'); await espera(VENTANA_PAUSA_MS + 50);
      const ventana = document.querySelector('.confirmar-fondo .confirmar-ventana');
      out.ventana = !!ventana && ventana.classList.contains('peligro');
      out.textos = ventana ? [ventana.querySelector('.confirmar-titulo').textContent, ventana.querySelector('.confirmar-texto').textContent,
        ...[...ventana.querySelectorAll('.confirmar-botones .btn')].map(b => b.textContent + ':' + (b.classList.contains('btn-peligro') ? 'rojo' : 'otro'))].join(' | ') : '';
      out.focoCancelar = document.activeElement && document.activeElement.textContent === 'Cancelar';
      document.activeElement.click(); await pendiente;
      out.cancelarNoBorra = !document.querySelector('.confirmar-fondo') && escrituras === 0;
      // Escape también cancela.
      pendiente = eliminarReporteSecador('RS-1'); await espera(50);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pendiente;
      out.escapeCancela = !document.querySelector('.confirmar-fondo') && escrituras === 0;
      // Una pregunta normal: azul, con el foco en la acción, y "sí" devuelve true.
      const pregunta = confirmarAccion({ titulo: '¿Marcar este hallazgo como resuelto?', aceptar: 'Marcar como resuelto' }); await espera(VENTANA_PAUSA_MS + 50);
      out.normal = !document.querySelector('.confirmar-ventana').classList.contains('peligro')
        && document.activeElement.classList.contains('btn-primary') && document.activeElement.textContent === 'Marcar como resuelto';
      document.activeElement.click();
      out.respuestaSi = await pregunta;
      window.asegurarHoja = asegurarOriginal;

      // Ventana con campos (en vez de prompt()): eliminar una orden pide su número.
      let nativasPrompt = 0; window.prompt = () => { nativasPrompt++; return null; };
      let hojasBorradas = 0; window.eliminarFilasDondeCumple = async () => { hojasBorradas++; return 0; };
      allOrdenes = [{ id: 'OT-77', NumeroOrden: 'OT-77', Equipo: 'CA1', Title: 'Fuga', Estado: 'Pendiente' }];
      ordenDetalleId = 'OT-77';
      const escribir = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      // Los botones de la ventana no responden en su primer medio segundo (doble clic).
      let borrar = eliminarOrdenCompleta(); await espera(VENTANA_PAUSA_MS + 50);
      let form = document.querySelector('.confirmar-fondo form.confirmar-ventana');
      out.eliminarOrden = form ? [form.querySelector('.confirmar-titulo').textContent, form.querySelector('label').textContent,
        form.querySelector('[data-respuesta="si"]').textContent, form.classList.contains('peligro') ? 'rojo' : 'otro',
        document.activeElement === form.querySelector('input') ? 'foco en el campo' : 'sin foco'].join(' | ') : '';
      escribir(form.querySelector('input'), 'OT-7');
      form.querySelector('[data-respuesta="si"]').click(); await espera(50);
      out.numeroMal = (document.querySelector('.confirmar-error')?.textContent || '') + ' | sigue abierta: ' + !!document.querySelector('.confirmar-fondo') + ' | borradas: ' + hojasBorradas;
      escribir(form.querySelector('input'), 'OT-77');
      out.errorSeLimpia = document.querySelector('.confirmar-error').textContent === '';
      form.querySelector('[data-respuesta="si"]').click(); await borrar;
      out.numeroBien = !document.querySelector('.confirmar-fondo') && hojasBorradas > 0 && !allOrdenes.some(o => o.NumeroOrden === 'OT-77');
      // Nuevo alcance: los tres datos en una sola ventana; Escape no crea nada.
      proyActual = 'PRY-001';
      let agregado = null; window._proyAgregarFila = async (tab, obj) => { agregado = obj; };
      let alcance = proyNuevoAlcance(); await espera(50);
      out.camposAlcance = [...document.querySelectorAll('.confirmar-campos label')].map(l => l.textContent).join(' | ');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await alcance;
      out.escapeNoCrea = !document.querySelector('.confirmar-fondo') && agregado === null;
      alcance = proyNuevoAlcance(); await espera(VENTANA_PAUSA_MS + 50);
      const [cNombre, cValor, cHoras] = document.querySelectorAll('.confirmar-campos input');
      document.querySelector('.confirmar-fondo [data-respuesta="si"]').click(); await espera(50);
      out.faltaNombre = document.querySelector('.confirmar-error')?.textContent || '';
      escribir(cNombre, 'Montaje de tubería'); escribir(cValor, '1.500.000'); escribir(cHoras, '120');
      document.querySelector('.confirmar-fondo [data-respuesta="si"]').click(); await alcance;
      out.alcance = agregado ? [agregado.Alcance, agregado.ValorContrato, agregado.HorasProgramadas].join(' | ') : '';
      out.nativas = nativas + nativasPrompt;

      // Sin emojis en pantalla: Reportes, el menú (banderas dibujadas) y las listas.
      const emoji = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u;
      const conEmoji = [];
      const revisar = nombre => { const t = document.body.innerText.match(new RegExp(emoji.source, 'gu')); if (t) conEmoji.push(nombre + ':' + t.join('')); };
      showPanel('cronograma'); await espera(300);
      cronMostrarSubTab('actividades'); await espera(100); revisar('actividades');
      cronMostrarSubTab('temporal'); await espera(500); revisar('temporal');
      renderSidebarOperaciones(); revisar('menu');
      out.banderas = document.querySelectorAll('#sidebarOperaciones svg.bandera').length;
      showPanel('novedades'); await espera(300); revisar('novedades');
      const opciones = [...document.querySelectorAll('option')].filter(o => emoji.test(o.textContent)).map(o => o.textContent);
      if (opciones.length) conEmoji.push('opciones:' + opciones.join(','));
      out.conEmoji = conEmoji;
      // El cronómetro lleva un ícono de línea, no un emoji.
      const chip = document.createElement('span'); chip.className = 'cron-timer'; chip.setAttribute('data-hora', '06:00'); document.body.appendChild(chip);
      _actualizarCronometrosCheckpoints();
      out.cronometro = !!chip.querySelector('svg.icono-txt') && /Tiempo agotado/.test(chip.textContent) && !emoji.test(chip.textContent);

      // Escala: los tamaños de letra y los radios escritos en la app son de la lista.
      const fuente = document.documentElement.outerHTML + [...document.querySelectorAll('script:not([src])')].map(s => s.textContent).join('\n');
      const LETRA = new Set(['10', '11', '12', '13', '14', '16', '18', '20', '22', '24', '26', '30', '64']);
      const RADIO = new Set(['2', '6', '8', '12', '20', '24', '999']);
      out.letraFuera = [...new Set([...fuente.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)].map(m => m[1]).filter(v => !LETRA.has(v)))];
      out.radioFuera = [...new Set([...fuente.matchAll(/border-radius\s*:\s*(\d+(?:\.\d+)?)px/g)].map(m => m[1]).filter(v => !RADIO.has(v)))];
      return out;
    });
    check('Consistencia: borrar pregunta con la ventana de la app (título, explicación y "Eliminar reporte" en rojo; foco en Cancelar)',
      r.ventana && r.textos === '¿Eliminar este reporte de secador? | Esta acción no se puede deshacer. | Cancelar:otro | Eliminar reporte:rojo' && r.focoCancelar,
      { ventana: r.ventana, textos: r.textos, foco: r.focoCancelar });
    check('Consistencia: Cancelar y Escape no borran; una pregunta normal va en azul y "sí" sigue; nunca sale la ventanita del navegador',
      r.cancelarNoBorra && r.escapeCancela && r.normal && r.respuestaSi === true && r.nativas === 0, r);
    check('Consistencia: eliminar una orden pide su número en la ventana; si no coincide lo dice ahí y no borra',
      r.eliminarOrden === '¿Eliminar la orden OT-77? | Para confirmar, escribe el número de la orden | Eliminar orden | rojo | foco en el campo'
      && r.numeroMal === 'El número no coincide con el de la orden. | sigue abierta: true | borradas: 0' && r.errorSeLimpia && r.numeroBien,
      { eliminarOrden: r.eliminarOrden, numeroMal: r.numeroMal, errorSeLimpia: r.errorSeLimpia, numeroBien: r.numeroBien });
    check('Consistencia: nuevo alcance pide nombre, valor y horas en una sola ventana (Escape no crea nada; el nombre es obligatorio)',
      r.camposAlcance === 'Nombre del alcance (frente de obra) | Valor de contrato | Horas programadas' && r.escapeNoCrea
      && /^Escribe nombre del alcance/.test(r.faltaNombre) && r.alcance === 'Montaje de tubería | 1500000 | 120',
      { campos: r.camposAlcance, escape: r.escapeNoCrea, falta: r.faltaNombre, alcance: r.alcance });
    check('Consistencia: Reportes, menú, Novedades y listas sin emojis (banderas dibujadas, cronómetro con ícono)',
      r.conEmoji.length === 0 && r.banderas > 0 && r.cronometro, { conEmoji: r.conEmoji, banderas: r.banderas, cronometro: r.cronometro });
    check('Consistencia: tamaños de letra y radios solo de la escala', r.letraFuera.length === 0 && r.radioFuera.length === 0,
      { letra: r.letraFuera, radio: r.radioFuera });
    check('Consistencia: sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }
  {
    // Inicio compacto (banner bajo, accesos directos arriba, mapa al final) y
    // encabezados de tarjeta claros.
    const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'America/Bogota' });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    await ctx.route('**/sheets/v4/**', sheetsEnMemoria().route);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.clock.install({ time: new Date('2026-10-16T14:20:00-05:00') });
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const r = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const out = {};
      document.getElementById('loginOverlay')?.remove();
      const accesos = document.getElementById('accesosInicio');
      operacionAutenticada = false; renderKpisInicio();
      out.sinOperacion = getComputedStyle(accesos).display;
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionAutenticada = true; operacionActual = 'zipaquira';
      currentUser = { name: 'Ana Prueba', initials: 'AP', email: 'a@x' }; _aplicarRolUI();
      allOrdenes = [{ id: 'P1', NumeroOrden: 'OT-P1', Estado: 'Pendiente', Title: 'x' }, { id: 'C1', NumeroOrden: 'OT-C1', Estado: 'Cerrada', Title: 'y' }];
      showPanel('inicio'); renderKpisInicio(); await espera(50);
      const vis = el => !!el && getComputedStyle(el).display !== 'none';
      out.accesos = [...accesos.querySelectorAll('.acceso-inicio')].filter(vis).map(b => b.innerText.replace(/\s+/g, ' ').trim());
      const panel = document.getElementById('panel-inicio');
      const pos = el => [...panel.querySelectorAll('*')].indexOf(el);
      const tarjetas = [...panel.querySelectorAll(':scope > .card')];
      const titulo = c => c.querySelector('.card-head').textContent.trim();
      out.orden = ['saludoInicio', 'accesosInicio', 'kpisInicio'].map(id => pos(document.getElementById(id))).every((v, i, a) => i === 0 || v > a[i - 1])
        && tarjetas.map(titulo).join(' > ') === 'Tratamiento de Datos > Dónde Operamos';
      out.botonesViejos = /Ir a Órdenes Pendientes|Ver Dashboard/.test(panel.innerText);
      out.altoBanner = Math.round(panel.querySelector('.inicio-banner').getBoundingClientRect().height);
      usuarioRol = 'operario'; _aplicarRolUI();
      out.nuevaOperario = vis(accesos.querySelector('[onclick="showPanel(\'nueva\')"]'));
      usuarioRol = 'admin'; _aplicarRolUI();
      // Encabezados claros: fondo suave, texto azul y línea de color.
      const cabeza = getComputedStyle(panel.querySelector('.card-head'));
      out.encabezado = [cabeza.backgroundColor, cabeza.color, cabeza.borderBottomStyle + ' ' + cabeza.borderBottomColor].join(' | ');
      allOrdenes = [{ id: 'D1', NumeroOrden: 'OT-D1', Estado: 'Pendiente', Title: 'Fuga', Equipo: 'CA1' }];
      await verDetalle('D1'); await espera(200);
      const seccion = getComputedStyle(document.querySelector('#panel-detalle .detail-section-title'));
      out.seccionDetalle = [seccion.backgroundColor, seccion.color].join(' | ');
      return out;
    });
    check('Inicio: accesos directos (reporte de la hora con su ventana, pendientes y nueva orden) solo con una operación abierta',
      r.sinOperacion === 'none' && JSON.stringify(r.accesos) === JSON.stringify(['Reporte de esta hora Turno 2 · ventana 14:00 – 15:00', 'Mis pendientes 1 orden por ejecutar', 'Nueva orden Crear una orden de trabajo'])
      && r.nuevaOperario === false, { sinOperacion: r.sinOperacion, accesos: r.accesos, nuevaOperario: r.nuevaOperario });
    check('Inicio: banner bajo, accesos antes de los indicadores y el mapa al final', r.orden && !r.botonesViejos && r.altoBanner <= 90,
      { orden: r.orden, botonesViejos: r.botonesViejos, altoBanner: r.altoBanner });
    check('Encabezados de tarjeta claros (fondo suave, texto azul, línea de color), también las secciones del detalle',
      r.encabezado === 'rgb(242, 245, 249) | rgb(2, 69, 122) | solid rgb(1, 138, 190)' && r.seccionDetalle === 'rgba(0, 0, 0, 0) | rgb(2, 69, 122)',
      { encabezado: r.encabezado, seccion: r.seccionDetalle });
    check('Inicio y encabezados: sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }
  {
    // Las ventanas de la app con el mouse de verdad: el segundo clic de un
    // doble clic no las cierra ni las confirma, y seleccionar el texto de un
    // campo arrastrando hasta el fondo no las cierra.
    const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      document.getElementById('loginOverlay')?.remove();
      window._respuesta = 'sin abrir';
      const boton = document.createElement('button');
      boton.id = 'abreVentana'; boton.textContent = 'Eliminar';
      boton.style.cssText = 'position:fixed;left:30px;bottom:30px;z-index:8000;padding:10px';
      boton.onclick = async () => {
        window._respuesta = 'abierta';
        window._respuesta = String(await confirmarAccion({ titulo: '¿Eliminar este reporte?', aceptar: 'Eliminar reporte', peligro: true }));
      };
      document.body.appendChild(boton);
    });
    const abiertas = () => p.locator('.confirmar-fondo').count();
    const respuesta = () => p.evaluate(() => window._respuesta);
    const out = {};
    // Doble clic lejos de la ventana: sigue abierta; después de la pausa, Cancelar responde.
    await p.dblclick('#abreVentana'); await p.waitForTimeout(150);
    out.lejos = (await abiertas()) + ' ' + (await respuesta());
    await p.waitForTimeout(600);
    await p.click('.confirmar-fondo [data-respuesta="no"]'); await p.waitForTimeout(50);
    out.cancelarDespues = await respuesta();
    // El botón justo donde aparece "Eliminar reporte": el segundo clic no confirma.
    await p.click('#abreVentana'); await p.waitForTimeout(100);
    const caja = await p.locator('.confirmar-fondo [data-respuesta="si"]').boundingBox();
    await p.keyboard.press('Escape'); await p.waitForTimeout(50);
    await p.evaluate(c => Object.assign(document.getElementById('abreVentana').style,
      { left: c.x + 'px', top: c.y + 'px', bottom: '', width: c.width + 'px', height: c.height + 'px' }), caja);
    await p.dblclick('#abreVentana'); await p.waitForTimeout(150);
    out.encima = (await abiertas()) + ' ' + (await respuesta());
    await p.keyboard.press('Escape'); await p.waitForTimeout(50);
    // Arrastrar desde el campo hasta el fondo; luego tocar afuera sí cancela.
    await p.evaluate(() => {
      window._datos = 'pendiente';
      pedirDatos({ titulo: 'Nombre del proyecto', campos: [{ nombre: 'n', etiqueta: 'Nombre', valor: 'Ampliación de planta' }] })
        .then(d => { window._datos = JSON.stringify(d); });
    });
    await p.waitForTimeout(600);
    const campo = await p.locator('.confirmar-campos input').boundingBox();
    await p.mouse.move(campo.x + campo.width - 4, campo.y + campo.height / 2); await p.mouse.down();
    await p.mouse.move(10, campo.y + campo.height / 2, { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(100);
    out.arrastre = [await abiertas(), await p.evaluate(() => window._datos), await p.inputValue('.confirmar-campos input')].join(' | ');
    await p.mouse.click(10, 10); await p.waitForTimeout(100);
    out.afuera = (await abiertas()) + ' ' + (await p.evaluate(() => window._datos));
    // La clave de sede: el doble clic sobre la sede no cierra su ventana.
    await p.evaluate(() => {
      window._clave = 'pendiente';
      const b = document.getElementById('abreVentana');
      b.onclick = async () => { window._clave = String(await _pedirClaveSede('Zipaquirá')); };
      Object.assign(b.style, { left: '30px', top: '', bottom: '30px', width: '', height: '' });
    });
    await p.dblclick('#abreVentana'); await p.waitForTimeout(150);
    out.clave = (await p.locator('#claveSedeInput').count()) + ' ' + (await p.evaluate(() => window._clave));
    await p.keyboard.press('Escape'); await p.waitForTimeout(50);
    out.claveEscape = await p.evaluate(() => window._clave);
    check('Ventanas: un doble clic no las cierra ni confirma (ni con el botón justo debajo de "Eliminar"); después de la pausa responden',
      out.lejos === '1 abierta' && out.cancelarDespues === 'false' && out.encima === '1 abierta', out);
    check('Ventanas: arrastrar desde un campo hasta el fondo no la cierra ni borra lo escrito; tocar afuera sí cancela',
      out.arrastre === '1 | pendiente | Ampliación de planta' && out.afuera === '0 null', out);
    check('Ventanas: la clave de sede tampoco se cierra con un doble clic', out.clave === '1 pendiente' && out.claveEscape === 'null', out);
    check('Ventanas: sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }
  {
    // Modo oscuro sin parches claros ni letra que no se lea: listas de
    // órdenes, el detalle con una observación interna, el Histórico y el
    // inventario de equipos, la herramienta incompleta, Movimientos del
    // inventario y Proyectos con su contrato cargado.
    const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'America/Bogota' });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' }));
    await ctx.route('**/sheets/v4/**', sheetsEnMemoria().route);
    await ctx.addInitScript(() => { try { localStorage.setItem('tema', 'dark'); } catch (_) {} });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const r = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      document.getElementById('loginOverlay')?.remove();
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; operacionAutenticada = true; operacionActual = 'zipaquira';
      currentUser = { name: 'Ana Prueba', initials: 'AP', email: 'a@x' }; _aplicarRolUI();
      // Luminancia (WCAG) de un color tal como lo da getComputedStyle.
      const color = c => {
        const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null;
        const [rr, g, bb, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return { L: 0.2126 * f(rr) + 0.7152 * f(g) + 0.0722 * f(bb), a };
      };
      const contraste = (x, y) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      // Lo que se ve detrás: el primer fondo opaco hacia arriba (null con un
      // degradado, que así no se puede medir).
      const fondoDe = el => {
        for (let x = el; x; x = x.parentElement) {
          const cs = getComputedStyle(x);
          if (/gradient/.test(cs.backgroundImage)) return null;
          const f = color(cs.backgroundColor); if (f && f.a >= 0.5) return f.L;
        }
        return color(getComputedStyle(document.body).backgroundColor).L;
      };
      const hallazgos = [];
      const revisar = (nombre, raiz) => {
        raiz.querySelectorAll('*').forEach(el => {
          if (el.closest('svg, canvas, .bandera')) return;
          const caja = el.getBoundingClientRect(); if (caja.width < 4 || caja.height < 4) return;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.3) return;
          const quien = el.id ? '#' + el.id : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '');
          const f = color(cs.backgroundColor);
          if (f && f.a >= 0.5 && f.L > 0.5) { hallazgos.push(`${nombre}: fondo claro en ${quien} (${cs.backgroundColor})`); return; }
          if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
          const t = color(cs.color), fondo = fondoDe(el);
          if (t && fondo !== null && contraste(t.L, fondo) < 3)
            hallazgos.push(`${nombre}: letra poco legible en ${quien} "${el.textContent.trim().slice(0, 30)}" (${cs.color})`);
        });
      };
      const hoy = _isoLocal(new Date());
      allOrdenes = [
        { id: 'P1', NumeroOrden: 'OT-P1', Title: 'Fuga en la línea', Equipo: 'CA1', Estado: 'Pendiente', Prioridad: 'Urgente', TipoMantenimiento: 'Correctivo',
          FechaInicio: hoy, Responsable: 'Técnico Uno', tareas: [{ descripcion: 'Revisar acople', ok: false, observacionFantasma: 'No había repuesto' }] },
        { id: 'R1', NumeroOrden: 'OT-R1', Title: 'Cambio de filtro', Equipo: 'CA2', Estado: 'Realizada', TipoMantenimiento: 'Preventivo', FechaInicio: hoy, FechaCierre: hoy },
        { id: 'C1', NumeroOrden: 'OT-C1', Title: 'Ajuste', Equipo: 'CA1', Estado: 'Cerrada', TipoMantenimiento: 'Correctivo', FechaInicio: hoy, FechaCierre: hoy },
      ];
      _ultimaCargaOrdenesMs = Date.now(); // recién cargadas: se pintan sin volver a leer
      for (const panel of ['pendientes', 'realizadas', 'lista']) {
        showPanel(panel); await espera(200); revisar(panel, document.getElementById('panel-' + panel));
      }
      await verDetalle('P1'); await espera(200); revisar('detalle', document.getElementById('panel-detalle'));
      showPanel('historico'); await espera(300); revisar('histórico', document.getElementById('panel-historico'));
      document.getElementById('histSelectorVista').value = 'inventario'; histCambiarVista(); await espera(300);
      _ieRenderTabla([{ Equipo: 'Extintor', Tipo: 'seguridad', Codificacion: 'EXT-1' }, { Equipo: 'Compresor', Tipo: 'operacion', Codificacion: 'CA1' }]);
      revisar('inventario de equipos', document.getElementById('panel-historico'));
      showPanel('cronograma'); await espera(300); cronMostrarSubTab('herramienta'); await espera(500);
      _invhPintarEstado(INVENTARIO_HERRAMIENTA[0].items[0].n, 'incompleta');
      revisar('herramienta', document.getElementById('panel-cronograma'));
      await abrirInventario('zipaquira'); await espera(300); invMostrarSubTab('movimiento'); await espera(300);
      revisar('movimientos', document.getElementById('panel-inventario'));
      window.pedirDatos = async () => ({ nombre: 'Ampliación de planta' });
      await abrirProyectos(); await espera(300); await proySembrarPanelGerencial(); await espera(500);
      for (const sub of ['caja', 'avance', 'alcances']) {
        proyMostrarSubTab(sub); await espera(300); revisar('proyectos/' + sub, document.getElementById('panel-proyectos'));
      }
      return { hallazgos, alcances: proyAlcances().length };
    });
    check('Modo oscuro: sin fondos claros ni letra poco legible (órdenes, detalle, Histórico, inventario, herramienta y Proyectos)',
      r.hallazgos.length === 0 && r.alcances > 0, { alcances: r.alcances, hallazgos: r.hallazgos.slice(0, 12), total: r.hallazgos.length });
    check('Modo oscuro: sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }
  {
    // Empalme: los mantenimientos anteriores se suben en un Excel (o CSV)
    // desde "Historial y documentos" de la ficha y quedan todos de una vez.
    const fake = sheetsEnMemoria();
    const { ctx, p, errs } = await nuevaPagina(b, { '**/sheets/v4/**': fake.route });
    const id = await p.evaluate(() => OPERACIONES.zipaquira2.spreadsheetId);
    await p.evaluate(async () => {
      document.getElementById('loginOverlay')?.remove();
      googleAccessToken = 'SESS.x'; usuarioRol = 'admin'; currentUser = { name: 'Ana Prueba', email: 'ana@x', initials: 'AP' };
      operacionActual = 'zipaquira2'; operacionAutenticada = true; GOOGLE_CONFIG.spreadsheetId = OPERACIONES.zipaquira2.spreadsheetId;
      _aplicarRolUI();
      await showPanel('empalme');
      for (let i = 0; i < 80 && !document.querySelector('#empListaEquipos .emp-equipo'); i++) await new Promise(x => setTimeout(x, 100));
      empSeleccionarEquipo('JOY 2');
    });
    const excel = xlsxDePrueba([
      ['Historial de mantenimientos — compresores'], null,
      ['Equipo', 'Fecha de mantenimiento', 'Tipo de mantenimiento', 'Descripción del trabajo', 'Horómetro (h)', 'Realizado por', 'Fecha próximo mantenimiento'],
      ['JOY 2', { n: 45366 }, 'Preventivo', 'Cambio de filtros de aire y aceite', 42500, 'Contratista anterior', { n: 45550 }],
      ['', '02/09/2024', 'Correctivo', 'Cambio de sello del enfriador', '44.010', 'Contratista anterior'], // equipo en celda combinada
      ['Compresor JOY 21', { n: 45000, estilo: 2 }, 'Preventivo', 'Análisis de aceite', 61000, 'Laboratorio'],
      ['JOY 20', { n: 45400 }, 'Preventivo', 'Revisión general', 1000, 'X'], // no existe (y no es JOY 2)
      ['JOY 3', '', 'Preventivo', 'Sin fecha'],
      ['JOY 3', '31/02/2024', 'Preventivo', 'Fecha imposible'],
      ['JOY 2', { n: 45366, estilo: 2 }, 'Preventivo', 'Cambio de filtros de aire y aceite', 42500, 'Contratista anterior'], // repetida
      ['Total'],
    ]);
    const entrada = '#empFicha input[type="file"][onchange^="empLeerExcelMantenimientos"]';
    const subir = async (name, buffer) => {
      await p.setInputFiles(entrada, { name, mimeType: 'application/octet-stream', buffer });
      await p.waitForFunction(() => !/Leyendo/.test(document.getElementById('empf_mantImport').innerText), null, { timeout: 10000 });
      return p.evaluate(() => document.getElementById('empf_mantImport').innerText.replace(/\s+/g, ' ').trim());
    };
    const out = {};
    out.vista = await subir('historial.xlsx', excel);
    const antes = fake.peticiones.length;
    out.registro = await p.evaluate(async () => {
      await empRegistrarMantenimientosImportados();
      return {
        msg: document.getElementById('empf_mantImport').innerText.replace(/\s+/g, ' ').trim(),
        lista: [...document.querySelectorAll('#empf_mantLista tbody tr')].map(tr => tr.cells[0].textContent + ' ' + tr.cells[1].textContent).join(', '),
        cuenta: document.getElementById('empf_mantCuenta').textContent,
        ultimo: document.getElementById('empf_mantFecha').value + ' | ' + document.getElementById('empf_mantDetalle').value,
      };
    });
    out.anexos = fake.peticiones.slice(antes).filter(x => /EmpalmeMantenimientos/.test(x.ruta) && /:append/.test(x.ruta)).length;
    // Copias: la hoja en memoria sigue cambiando con las cargas siguientes.
    const hoja = fake.hoja(id, 'EmpalmeMantenimientos').map(f => [...f]);
    const ficha = fake.hoja(id, 'EmpalmeRecepcion').map(f => [...f]);
    const col = (filas, nombre) => filas[0].indexOf(nombre);
    out.otraVez = await subir('historial.xlsx', excel);
    // CSV guardado por Excel en Windows (sin UTF-8), sin columna de equipo: va al equipo abierto.
    out.csv = await subir('joy2.csv', Buffer.from('Fecha;Actividad;Observaciones\r\n15/01/2023;Limpieza del radiador;tensión revisada\r\n20-feb-2023;Cambio de correa;\r\n', 'latin1'));
    out.deshacer = await p.evaluate(async () => {
      await empRegistrarMantenimientosImportados();
      const obs = _emp.mantenimientos.find(m => m.Descripcion === 'Limpieza del radiador')?.Observaciones;
      const carga = _emp.mantenimientos.find(m => m.Descripcion === 'Cambio de correa')?.Carga;
      const conCsv = _empMantenimientosDe('JOY 2').length;
      window.confirmarAccion = async () => true;
      await empDeshacerCargaMantenimientos(carga);
      return { obs, conCsv, sinCsv: _empMantenimientosDe('JOY 2').length };
    });
    out.filasTrasDeshacer = fake.hoja(id, 'EmpalmeMantenimientos').length;
    out.xls = await subir('viejo.xls', Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]));
    out.final = await p.evaluate(() => {
      const acta = _htmlActaEmpalme('zipaquira2', []);
      usuarioRol = 'operario'; _aplicarRolUI(); empRenderFicha();
      const operario = {
        subir: getComputedStyle(document.querySelector('#empFicha .emp-mant-acciones')).display,
        quitar: document.querySelectorAll('#empf_mantLista .emp-mant-quitar').length,
        lista: document.querySelectorAll('#empf_mantLista tbody tr').length,
      };
      usuarioRol = 'admin'; _aplicarRolUI();
      return { acta: /Mantenimientos anteriores registrados<\/th><td>2, del 15\/03\/2024 al 02\/09\/2024/.test(acta) && /<b>3<\/b>mantenimientos anteriores registrados/.test(acta), operario };
    });
    // Como los archivos del empalme: EQUIPOS, FECHA, AÑO, ACTIVIDADES
    // REALIZADAS, HORÓMETRO y OBSERVACIONES. El año sale de AÑO: la FECHA
    // "1-oct" la guardó Excel con el año en que se escribió (2025) y es de
    // 2023; "10/08" y "15 de marzo" no lo traen. Horómetro y observaciones
    // pueden ir vacíos.
    out.sencillo = await subir('mantenimientos.xlsx', xlsxDePrueba([
      ['EQUIPOS', 'FECHA', 'AÑO', 'ACTIVIDADES REALIZADAS', 'HORÓMETRO', 'OBSERVACIONES'],
      ['CB1', { n: 45931, estilo: 3 }, 2023, 'Cambio de rodamientos del motor', 15200, 'Ruido en el rodamiento lado acople'],
      ['CB1', '10/08', 2024, 'Limpieza de radiador', '16.050', ''],
      ['JOY 3', '05/05/2024', 2024, 'Cambio de aceite', '', ''],
      ['JOY 3', '15 de marzo', '2023', 'Revisión de válvulas', '', 'Sin novedad'],
    ]));
    out.sencilloTablas = await p.evaluate(async () => {
      const vista = [...document.querySelectorAll('#empf_mantImport thead th')].map(th => th.textContent).join(',');
      await empRegistrarMantenimientosImportados();
      empSeleccionarEquipo('CB1');
      return { vista, lista: [...document.querySelectorAll('#empf_mantLista thead th')].map(th => th.textContent).join(','),
        filas: document.querySelectorAll('#empf_mantLista tbody tr').length, ultimo: document.getElementById('empf_mantDetalle').value };
    });
    check('Empalme: el Excel de mantenimientos se lee (título arriba, fechas de Excel y escritas, equipo en celdas combinadas) y dice qué se registra y qué no',
      /3 mantenimientos listos para registrar: JOY 2 \(2\), JOY 21 \(1\)/.test(out.vista) && /1 fila está repetida en el archivo/.test(out.vista)
      && /Fila 7: el equipo "JOY 20" no está en la lista de la sede/.test(out.vista) && /Fila 8: no tiene fecha/.test(out.vista)
      && /Fila 9: la fecha "31\/02\/2024" no se reconoce/.test(out.vista)
      && /Columnas: Equipo \(A\), Fecha de mantenimiento \(B\), Tipo de mantenimiento \(C\), Descripción del trabajo \(D\), Horómetro \(h\) \(E\), Realizado por \(F\)/.test(out.vista),
      out.vista);
    check('Empalme: se registran todos de una vez (una sola escritura) y el último mantenimiento queda en la ficha',
      out.anexos === 1 && hoja.length === 4 && /3 mantenimientos registrados en 2 equipos/.test(out.registro.msg)
      && hoja.slice(1).map(f => [f[col(hoja, 'Equipo')], f[col(hoja, 'Fecha')], f[col(hoja, 'Horometro')]].join(' ')).join(', ') === 'JOY 2 2024-03-15 42500, JOY 2 2024-09-02 44010, JOY 21 2023-03-15 61000'
      && out.registro.lista === '02/09/2024 Correctivo, 15/03/2024 Preventivo' && out.registro.cuenta === '(2)'
      && out.registro.ultimo === '2024-09-02 | Correctivo — Contratista anterior'
      && (ficha.find(f => f[0] === 'JOY 21') || [])[col(ficha, 'UltimoMantFecha')] === '2023-03-15',
      { anexos: out.anexos, hoja, registro: out.registro });
    check('Empalme: el mismo archivo otra vez no repite nada',
      /0 mantenimientos listos para registrar/.test(out.otraVez) && /4 ya estaban registrados/.test(out.otraVez) && !/Registrar \d/.test(out.otraVez), out.otraVez);
    check('Empalme: un CSV sin columna de equipo (codificación de Windows) va al equipo abierto, y "Deshacer esta carga" lo quita',
      /sin columna de equipo: todo va a JOY 2/.test(out.csv) && /2 mantenimientos listos para registrar: JOY 2 \(2\)/.test(out.csv)
      && out.deshacer.obs === 'tensión revisada' && out.deshacer.conCsv === 4 && out.deshacer.sinCsv === 2 && out.filasTrasDeshacer === 4,
      { csv: out.csv, deshacer: out.deshacer, filas: out.filasTrasDeshacer });
    check('Empalme: un .xls viejo pide guardarlo como .xlsx; el acta cuenta los mantenimientos; el operario los ve pero no sube ni borra',
      /Excel 97-2003 \(\.xls\).*\.xlsx/.test(out.xls) && out.final.acta
      && out.final.operario.subir === 'none' && out.final.operario.quitar === 0 && out.final.operario.lista === 2,
      { xls: out.xls, final: out.final });
    const filasSencillo = fake.hoja(id, 'EmpalmeMantenimientos').filter(f => f[col(hoja, 'Archivo')] === 'mantenimientos.xlsx')
      .map(f => ['Equipo', 'Fecha', 'Horometro', 'Observaciones'].map(c => f[col(hoja, c)]).join(' | ')).join(' / ');
    check('Empalme: el archivo con EQUIPOS, FECHA, AÑO, ACTIVIDADES REALIZADAS, HORÓMETRO y OBSERVACIONES se registra con el año de la columna AÑO',
      /Columnas: EQUIPOS \(A\), FECHA \(B\), AÑO \(C\), ACTIVIDADES REALIZADAS \(D\), HORÓMETRO \(E\), OBSERVACIONES \(F\)/.test(out.sencillo)
      && /4 mantenimientos listos para registrar: CB1 \(2\), JOY 3 \(2\)/.test(out.sencillo)
      && filasSencillo === 'CB1 | 2023-10-01 | 15200 | Ruido en el rodamiento lado acople / CB1 | 2024-08-10 | 16050 |  / JOY 3 | 2024-05-05 |  |  / JOY 3 | 2023-03-15 |  | Sin novedad'
      && out.sencilloTablas.vista === 'Equipos,Fecha,Actividades realizadas,Horómetro,Observaciones'
      && out.sencilloTablas.lista === 'Fecha,Actividades realizadas,Horómetro,Observaciones,'
      && out.sencilloTablas.filas === 2 && out.sencilloTablas.ultimo === 'Limpieza de radiador',
      { vista: out.sencillo, filas: filasSencillo, tablas: out.sencilloTablas });
    // La ficha muestra todo lo que tiene cada cuadro, sin cortar ni esconder
    // texto detrás de una barra: crecen con lo que tienen (también al
    // escribir, en celular y si la ficha se dibujó oculta), la Hoja de vida
    // arranca más alta y la tabla de mantenimientos va completa.
    const medir = () => p.evaluate(() => {
      const t = [...document.querySelectorAll('#empFicha textarea.emp-texto')];
      const alto = id => document.getElementById(id).offsetHeight;
      const lista = document.querySelector('#empf_mantLista .emp-mant-lista');
      return {
        cuadros: t.length,
        cortados: t.filter(x => x.scrollHeight > x.clientHeight + 1).map(x => x.id || x.getAttribute('aria-label')),
        hojaVida: alto('empf_HojaVida'), mayores: alto('empf_MantMayores'), capacidad: alto('empf_CapacidadTipo'), arrancador: alto('empf_Arrancador'),
        mayorEsHojaVida: t.every(x => x.offsetHeight <= alto('empf_HojaVida')),
        listaEntera: !!lista && lista.scrollHeight <= lista.clientHeight + 1,
        filas: document.querySelectorAll('#empf_mantLista tbody tr').length,
      };
    });
    await p.evaluate(() => {
      const largo = 'El compresor cuenta con 51 intervenciones registradas entre marzo de 2021 y julio de 2026. '.repeat(9);
      Object.assign(_empFicha('JOY 2'), { HojaVida: largo, MantMayores: 'Lavado del intercambiador de aire\nLavado del intercambiador de aceite',
        CapacidadTipo: '5000 SCFM, 800 HP, 600 kW, compresor centrífugo de tres etapas con interenfriadores', Arrancador: '115 kV' });
      for (let i = 1; i <= 30; i++) _emp.mantenimientos.push({ ID: 'm' + i, Equipo: 'JOY 2', Fecha: `2025-01-${String(i).padStart(2, '0')}`, Descripcion: 'Cambio de filtros de succión' });
      empSeleccionarEquipo('JOY 2');
    });
    out.alto = await medir();
    out.alEscribir = await p.evaluate(() => {
      const t = document.getElementById('empf_Arrancador'), antes = t.offsetHeight;
      t.value += ', arranque suave con protecciones de sobrecorriente, falla a tierra y desbalance de fases';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return { antes, despues: t.offsetHeight, cortado: t.scrollHeight > t.clientHeight + 1 };
    });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    out.celular = await medir();
    await p.evaluate(async () => {
      const panel = document.getElementById('empSub-recepcion');
      panel.style.display = 'none';
      empRenderFicha();
      await new Promise(r => requestAnimationFrame(r));
      panel.style.display = '';
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    out.oculta = await medir();
    check('Empalme: la ficha muestra todo el texto (los cuadros crecen con lo que tienen, Hoja de vida la más alta, tabla de mantenimientos completa)',
      out.alto.cuadros >= 12 && out.alto.cortados.length === 0 && out.alto.mayorEsHojaVida && out.alto.hojaVida > 140
      && out.alto.mayores > 60 && out.alto.capacidad > out.alto.arrancador && out.alto.listaEntera && out.alto.filas === 32
      && out.alEscribir.despues > out.alEscribir.antes && !out.alEscribir.cortado
      && out.celular.cortados.length === 0 && out.celular.hojaVida > out.alto.hojaVida && out.celular.listaEntera
      && out.oculta.cortados.length === 0 && out.oculta.hojaVida === out.celular.hojaVida,
      { alto: out.alto, alEscribir: out.alEscribir, celular: out.celular, oculta: out.oculta });
    check('Empalme (mantenimientos): sin errores de JS', errs.length === 0, errs.slice(0, 2));
    await ctx.close();
  }
  {
    // Lo que salió de revisar Zipaquirá 1 y 2: en celular la ficha del
    // empalme se ve desde el primer toque; Variables solo en la sede con
    // reportes técnicos; en Zipaquirá 2 el acceso de Inicio y el botón de
    // abajo llevan al empalme y Reportes no muestra formularios que no
    // sirven; el hallazgo queda Resuelto cuando su orden se cierra; y el
    // aviso de la hora de los reportes técnicos cabe en su recuadro.
    const abrirSede = async (sede, opciones) => {
      const fake = sheetsEnMemoria();
      const ctx = await b.newContext({ serviceWorkers: 'block', ...opciones });
      await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false,"mensaje":"Ruta no encontrada."}' }));
      await ctx.route('**/sheets/v4/**', fake.route);
      await ctx.addInitScript(sede => {
        sessionStorage.setItem('gUser', JSON.stringify({ name: 'Ana Prueba', email: 'ana@x', initials: 'AP' }));
        sessionStorage.setItem('gToken', 'SESS.x'); sessionStorage.setItem('gRol', 'admin');
        sessionStorage.setItem('operacionAutenticada', sede); try { localStorage.setItem('operacionActual', sede); } catch (e) {}
      }, sede);
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
      await p.goto(BASE, { waitUntil: 'load' }); await p.waitForTimeout(2500);
      return { fake, ctx, p, errs };
    };
    const out = {};
    {
      const { fake, ctx, p, errs } = await abrirSede('zipaquira2', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const id = await p.evaluate(() => OPERACIONES.zipaquira2.spreadsheetId);
      fake.crear(id, 'EmpalmeHallazgos', [
        ['ID', 'Equipo', 'Descripcion', 'Prioridad', 'Estado', 'OrdenNumero', 'RegistradoPor', 'FechaRegistro'],
        ['H-1', 'JOY 2', 'Fuga en el enfriador', 'Alta', 'En orden', 'OT-A', 'Ana', '2026-10-01'],
        ['H-2', 'JOY 3', 'Válvula sin certificar', 'Media', 'En orden', 'OT-B', 'Ana', '2026-10-02'],
        ['H-3', 'JOY 4', 'Guarda suelta', 'Baja', 'Abierto', '', 'Ana', '2026-10-03'],
      ]);
      out.z2 = await p.evaluate(async () => {
        showPanel('inicio');
        renderAccesosInicio(0); // el reloj del acceso no lo vuelve a "Reporte de esta hora"
        const r = {
          acceso: document.querySelector('#accesoReporteBtn .acceso-titulo').textContent + ' | ' + document.getElementById('accesoReporte').textContent,
          abajo: [...document.querySelectorAll('#bottomNav button')].map(x => x.dataset.panel + ':' + x.textContent.trim()).join(', '),
          variables: !!document.querySelector('#sidebarOperaciones [data-grupo="variables"]'),
        };
        abrirVariables('compresores');
        r.variablesAbre = document.getElementById('panel-variables').classList.contains('active');
        showPanel('cronograma'); await new Promise(x => setTimeout(x, 300));
        r.tarjetas = ['cronConsultaCard', 'cronInformeCard'].map(id => getComputedStyle(document.getElementById(id)).display).join(',');
        document.getElementById('accesoReporteBtn').click();
        r.accesoAbre = document.getElementById('panel-empalme').classList.contains('active');
        showPanel('inicio');
        allOrdenes.push({ id: 'OT-A', NumeroOrden: 'OT-A', Estado: 'Realizada', Equipo: 'JOY 2', Title: 'Fuga' },
          { id: 'OT-B', NumeroOrden: 'OT-B', Estado: 'Pendiente', Equipo: 'JOY 3', Title: 'Válvula' });
        return r;
      });
      await p.locator('#bottomNav button[data-panel="empalme"]').tap();
      await p.waitForFunction(() => document.querySelector('#empListaEquipos .emp-equipo'), null, { timeout: 10000 });
      out.z2.abajoAbre = await p.evaluate(() => document.getElementById('panel-empalme').classList.contains('active')
        && document.querySelector('#bottomNav button[data-panel="empalme"]').classList.contains('activo'));
      out.z2.hallazgos = await p.evaluate(() => _emp.hallazgos.map(h => h.ID + ':' + h.Estado).join(', '));
      out.z2.hoja = fake.hoja(id, 'EmpalmeHallazgos').slice(1).map(f => f[0] + ':' + f[4]).join(', ');
      await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300);
      await p.locator('#empListaEquipos').getByText('JOY 3', { exact: true }).tap();
      await p.waitForTimeout(1500);
      out.z2.fichaAlToque = await p.evaluate(() => Math.round(document.getElementById('empFicha').getBoundingClientRect().top));
      // Plan de Mantenimiento sin las pestañas del programa por horas de
      // Zipaquirá, y sin crear las pestañas que esta sede no usa.
      out.z2.plan = await p.evaluate(async () => {
        abrirPlanMantenimiento('zipaquira2');
        pmMostrarSubTab('horas');
        const panel = document.getElementById('panel-planmantenimiento');
        const r = {
          pestanas: [...panel.querySelectorAll('.inv-subtab')].filter(b => b.offsetParent).map(b => b.dataset.pmtab).join(','),
          activa: panel.querySelector('.inv-subtab.active').dataset.pmtab,
          ayuda: document.getElementById('pmRegistroAyudaSinPrograma').textContent,
        };
        pmMostrarSubTab('configinformes');
        for (let i = 0; i < 50 && !document.querySelector('#pmHoraBaseContenido tbody tr'); i++) await new Promise(x => setTimeout(x, 100));
        r.horaBase = document.querySelector('#pmHoraBaseContenido tbody tr td:last-child')?.textContent.trim();
        r.actividades = !!document.getElementById('pmActividadesContenido').offsetParent;
        return r;
      });
      out.z2.sinUso = ['InformeTrimestralEstado', 'InformeSemestralEstado', 'InformeAnualEstado', 'CamposReportes'].filter(n => fake.hoja(id, n).length);
      out.z2.errs = errs;
      await ctx.close();
    }
    {
      const { fake, ctx, p, errs } = await abrirSede('zipaquira', { viewport: { width: 1366, height: 900 } });
      out.z1 = await p.evaluate(async () => {
        const espera = ms => new Promise(x => setTimeout(x, ms));
        showPanel('inicio');
        const r = {
          acceso: document.querySelector('#accesoReporteBtn .acceso-titulo').textContent,
          abajo: document.querySelector('#bottomNav button:nth-child(3)').dataset.panel,
          variables: !!document.querySelector('#sidebarOperaciones [data-grupo="variables"]'),
        };
        abrirVariables('compresores');
        r.variablesAbre = document.getElementById('panel-variables').classList.contains('active');
        showPanel('cronograma'); await espera(400);
        r.tarjetas = ['cronConsultaCard', 'cronInformeCard'].map(id => getComputedStyle(document.getElementById(id)).display).join(',');
        r.avisoSeSale = [];
        for (const [tab, prefijo] of [['compresores', 'rc'], ['secadores', 'rs'], ['drycoolers', 'rd'], ['decorado', 'rdec'], ['emergencia', 're']]) {
          cronMostrarSubTab(tab); await espera(200);
          const chip = document.getElementById(prefijo + '_cronTimer');
          if (chip.scrollWidth > chip.clientWidth + 1 || chip.getBoundingClientRect().right > chip.parentElement.getBoundingClientRect().right + 1) r.avisoSeSale.push(tab);
        }
        abrirPlanMantenimiento('zipaquira');
        r.plan = [...document.querySelectorAll('#panel-planmantenimiento .inv-subtab')].filter(b => b.offsetParent).map(b => b.dataset.pmtab).join(',');
        return r;
      });
      // Dashboard de Reportes sin la librería de gráficas (no cargó, sin
      // señal): los números se ven y el cuadro de la gráfica lo explica.
      out.z1.sinGraficas = await p.evaluate(async () => {
        const espera = ms => new Promise(x => setTimeout(x, ms));
        const original = window.Chart;
        window.Chart = undefined;
        showPanel('cronograma'); cronMostrarSubTab('dashboard');
        const texto = id => document.getElementById(id).textContent.replace(/\s+/g, ' ').trim();
        for (let i = 0; i < 80 && !(/cumplimiento/.test(texto('cronDashResumen')) && /Cumplimiento/.test(texto('rc_cumpResumen'))); i++) await espera(100);
        const aviso = id => !!document.getElementById(id).parentElement.querySelector('.aviso-sin-grafica');
        const r = {
          turnos: texto('cronDashResumen').slice(0, 60), compresores: texto('rc_cumpResumen').slice(0, 40),
          avisoTurnos: aviso('chartCumplimientoTurnos'), avisoCompresores: aviso('chartCumplimientoRc'),
          lienzoOculto: getComputedStyle(document.getElementById('chartCumplimientoTurnos')).display === 'none',
        };
        // Con la librería de vuelta, se dibuja y el aviso se va.
        let dibujadas = 0;
        window.Chart = function () { dibujadas++; this.destroy = () => {}; };
        await renderDashboardCronograma();
        r.conLibreria = { aviso: aviso('chartCumplimientoTurnos'), dibujadas, alto: document.getElementById('chartCumplimientoTurnos').parentElement.style.height };
        window.Chart = original;
        return r;
      });
      // Programa de Mantenimiento por año: el del año en curso si está
      // cargado; si no, el último, con un aviso (2099 nunca va a estar).
      out.z1.programa = await p.evaluate(async () => {
        abrirPlanMantenimiento('zipaquira');
        const r = {
          pestana: document.querySelector('[data-pmtab="programa2026"]').textContent.trim(),
          esperada: 'Programa ' + _pmProgramaVigente().anio,
          de2026: _pmProgramaVigente(new Date(2026, 9, 22)).anio,
        };
        const lejano = _pmProgramaVigente(new Date(2099, 0, 15));
        r.lejano = { anio: lejano.anio, esDelAnio: lejano.esDelAnio, ultimo: Math.max(...Object.keys(PROGRAMAS_MANTENIMIENTO_ZIPAQUIRA).map(Number)) };
        pmMostrarSubTab('programa2026');
        for (let i = 0; i < 50 && !document.querySelector('#pmPrograma2026Contenido table'); i++) await new Promise(x => setTimeout(x, 100));
        r.avisoHoy = !!document.querySelector('#pmPrograma2026Contenido .pm-aviso-anio');
        r.avisoHoyEsperado = !PROGRAMAS_MANTENIMIENTO_ZIPAQUIRA[new Date().getFullYear()];
        await pmRenderPrograma2026(new Date(2099, 0, 15));
        r.aviso2099 = document.querySelector('#pmPrograma2026Contenido .pm-aviso-anio')?.textContent.trim();
        r.filas2099 = document.querySelectorAll('#pmPrograma2026Contenido tbody tr').length;
        return r;
      });
      // Zipaquirá sí sigue revisando los informes por horas al arrancar.
      const idZ1 = await p.evaluate(() => OPERACIONES.zipaquira.spreadsheetId);
      for (let i = 0; i < 50 && !fake.hoja(idZ1, 'CamposReportes').length; i++) await p.waitForTimeout(100);
      out.z1.precarga = ['InformeTrimestralEstado', 'CamposReportes'].filter(n => fake.hoja(idZ1, n).length).join(',');
      out.z1.errs = errs;
      await ctx.close();
    }
    check('Zipaquirá 2: el acceso de Inicio y el botón de abajo del celular llevan al empalme, no a un Reportes vacío',
      out.z2.acceso === 'Empalme de entrega | Recepción de equipos, hallazgos y repuestos' && out.z2.accesoAbre && out.z2.abajoAbre
      && out.z2.abajo === 'inicio:Inicio, pendientes:Órdenes, empalme:Empalme, novedades:Novedades', out.z2);
    check('Zipaquirá 2: sin Variables (no tiene reportes técnicos) y Reportes sin "Consultar otro día" ni "Descargar informe"',
      !out.z2.variables && !out.z2.variablesAbre && out.z2.tarjetas === 'none,none', out.z2);
    check('Empalme: el hallazgo con su orden Realizada queda Resuelto (también en la hoja); los demás no cambian',
      out.z2.hallazgos === 'H-1:Resuelto, H-2:En orden, H-3:Abierto' && out.z2.hoja === out.z2.hallazgos, out.z2);
    check('Empalme en celular: el primer equipo tocado lleva hasta su ficha', Math.abs(out.z2.fichaAlToque) < 80, out.z2.fichaAlToque);
    check('Zipaquirá 1: Variables, Reportes y el acceso de Inicio siguen igual, y el aviso de la hora cabe en su recuadro en los 5 reportes técnicos',
      out.z1.acceso === 'Reporte de esta hora' && out.z1.abajo === 'cronograma' && out.z1.variables && out.z1.variablesAbre
      && out.z1.tarjetas === 'block,block' && out.z1.avisoSeSale.length === 0, out.z1);
    check('Zipaquirá 2: el Plan de Mantenimiento solo tiene Registro y Configuración, con sus textos, y no crea las pestañas de los informes por horas ni del catálogo',
      out.z2.plan.pestanas === 'registro,configinformes' && out.z2.plan.activa === 'registro' && /Empalme de entrega/.test(out.z2.plan.ayuda)
      && out.z2.plan.horaBase === 'Esta sede todavía no genera órdenes automáticas' && !out.z2.plan.actividades && out.z2.sinUso.length === 0, { plan: out.z2.plan, sinUso: out.z2.sinUso });
    check('Zipaquirá 1: el Plan sigue con sus 7 pestañas y al arrancar sigue revisando los informes por horas',
      out.z1.plan === 'registro,horas,programa2026,informetrimestral,informesemestral,informeanual,configinformes'
      && out.z1.precarga === 'InformeTrimestralEstado,CamposReportes', { plan: out.z1.plan, precarga: out.z1.precarga });
    check('Dashboard de Reportes sin la librería de gráficas: muestra los números y explica el cuadro vacío; con la librería, dibuja',
      /Turno 1: \d+% cumplimiento/.test(out.z1.sinGraficas.turnos) && /Cumplimiento: \d+%/.test(out.z1.sinGraficas.compresores)
      && out.z1.sinGraficas.avisoTurnos && out.z1.sinGraficas.avisoCompresores && out.z1.sinGraficas.lienzoOculto
      && !out.z1.sinGraficas.conLibreria.aviso && out.z1.sinGraficas.conLibreria.dibujadas === 1 && out.z1.sinGraficas.conLibreria.alto === '280px',
      out.z1.sinGraficas);
    check('Programa de Mantenimiento por año: la pestaña dice el año; sin el programa del año en curso muestra el último con un aviso',
      out.z1.programa.pestana === out.z1.programa.esperada && out.z1.programa.de2026 === 2026
      && out.z1.programa.lejano.anio === out.z1.programa.lejano.ultimo && !out.z1.programa.lejano.esDelAnio
      && out.z1.programa.avisoHoy === out.z1.programa.avisoHoyEsperado
      && new RegExp(`Programa de Mantenimiento 2099: se muestra el de ${out.z1.programa.lejano.ultimo}`).test(out.z1.programa.aviso2099 || '')
      && out.z1.programa.filas2099 > 100, out.z1.programa);
    check('Zipaquirá 1 y 2 (arreglos): sin errores de JS', !out.z1.errs.length && !out.z2.errs.length, [...out.z1.errs, ...out.z2.errs].slice(0, 2));
  }
  {
    // Lo que salió de la segunda revisión del empalme de Zipaquirá 2: la
    // misma bodega cargada dos veces no duplica el stock; dos toques en
    // "Crear orden" con Sheets lento no crean dos órdenes; y el hallazgo
    // cuya orden se eliminó vuelve a Abierto.
    const fake = sheetsEnMemoria();
    let lento = false, fallanOrdenes = false;
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1366, height: 900 } });
    await ctx.route('**/*.workers.dev/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false,"mensaje":"Ruta no encontrada."}' }));
    await ctx.route('**/sheets/v4/**', async r => {
      if (fallanOrdenes && /batchGet/.test(r.request().url()) && /Ordenes/.test(decodeURIComponent(r.request().url()))) {
        return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Servicio no disponible"}}' });
      }
      if (lento && r.request().method() !== 'GET') await new Promise(x => setTimeout(x, 1500));
      return fake.route(r);
    });
    await ctx.addInitScript(() => {
      sessionStorage.setItem('gUser', JSON.stringify({ name: 'Ana Prueba', email: 'ana@x', initials: 'AP' }));
      sessionStorage.setItem('gToken', 'SESS.x'); sessionStorage.setItem('gRol', 'admin');
      sessionStorage.setItem('operacionAutenticada', 'zipaquira2'); try { localStorage.setItem('operacionActual', 'zipaquira2'); } catch (e) {}
    });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.goto(BASE, { waitUntil: 'load' }); await p.waitForTimeout(2500);
    const ids = await p.evaluate(() => ({ ord: OPERACIONES.zipaquira2.spreadsheetId, inv: INVENTARIO_SHEETS.zipaquira2 }));
    fake.crear(ids.inv, 'Config', [['hash']]);
    const out = {};

    // 1. Bodega: la segunda vez solo entra lo nuevo, y si todo ya estaba, nada.
    out.bodega = await p.evaluate(async () => {
      const espera = ms => new Promise(x => setTimeout(x, ms));
      const preguntas = [];
      const confirmarOriginal = window.confirmarAccion;
      window.confirmarAccion = async o => { preguntas.push(o.titulo + ' ' + (o.texto || '')); return true; };
      showPanel('empalme');
      for (let i = 0; i < 50 && !document.querySelector('#empListaEquipos .emp-equipo'); i++) await espera(100);
      const cargar = async texto => {
        empMostrarSubTab('bodega');
        document.getElementById('empb_tbody').innerHTML = '';
        document.getElementById('empb_pegar').value = 'Código\tNombre\tCantidad\n' + texto;
        empPegarBodega();
        const antes = preguntas.length;
        await empCargarBodega();
        return { msg: document.getElementById('empbMsg').textContent, pregunta: preguntas.slice(antes).join(' | '),
          filasQuedan: document.querySelectorAll('#empb_tbody tr').length };
      };
      const lista = 'FIL-01\tFiltro de aceite\t4\nACE-02\tAceite compresor\t20';
      const r = { primera: await cargar(lista), segunda: await cargar(lista + '\nGRA-03\tGrasa\t2'), tercera: await cargar(lista) };
      const stock = await obtenerStockInventarioDirecto('zipaquira2');
      r.stock = stock.map(s => s.codigo + '=' + s.cantidad).sort().join(', ');
      r.movimientos = (await _empMovimientosBodegaInicial('zipaquira2')).length;
      window.confirmarAccion = confirmarOriginal;
      return r;
    });

    // 2. Dos toques en "Crear orden" mientras Sheets va lento.
    await p.evaluate(async () => {
      empMostrarSubTab('hallazgos');
      document.getElementById('emph_equipo').value = 'JOY 4';
      document.getElementById('emph_descripcion').value = 'Fuga en la válvula de alivio';
      await empRegistrarHallazgo();
    });
    const ordenesAntes = fake.hoja(ids.ord, 'Ordenes').length;
    lento = true;
    await p.locator('#empHallazgosLista button', { hasText: 'Crear orden' }).click();
    await p.waitForTimeout(700); // la ventana ignora los clics de su primer medio segundo
    await p.locator('.confirmar-ventana [data-respuesta="si"]').click();
    await p.waitForTimeout(300);
    out.doble = await p.evaluate(() => {
      const fila = document.querySelector('#empHallazgosLista tbody tr');
      const botones = [...fila.querySelectorAll('button')].map(b => b.textContent.trim() + (b.disabled ? ' (deshabilitado)' : '')).join(', ');
      empCrearOrdenDeHallazgo(_emp.hallazgos[0].ID); // el segundo toque, por si llega a la función
      return { botones, ventanas: document.querySelectorAll('.confirmar-ventana').length };
    });
    await p.waitForFunction(() => !_emp.hallazgos[0]._creandoOrden, null, { timeout: 30000 });
    lento = false;
    out.doble.ordenes = fake.hoja(ids.ord, 'Ordenes').length - ordenesAntes;
    out.doble.hallazgo = await p.evaluate(() => {
      const h = _emp.hallazgos[0];
      return { estado: h.Estado, conOrden: allOrdenes.some(o => o.NumeroOrden === h.OrdenNumero),
        botones: [...document.querySelectorAll('#empHallazgosLista tbody tr:first-child button')].map(b => b.textContent.trim()).join(', ') };
    });

    // 3. Hallazgos "En orden": el de una orden eliminada vuelve a Abierto; el
    // de una orden que otro equipo creó después de la última lectura, no; y
    // si no se pueden leer las órdenes, no se reabre ninguno.
    const encabezadosOrden = fake.hoja(ids.ord, 'Ordenes')[0];
    const filaOrden = (num, estado) => encabezadosOrden.map(c => ({ NumeroOrden: num, Estado: estado, Equipo: 'JOY 3', Title: 'Válvula', TipoMantenimiento: 'Correctivo' })[c] || '');
    const hallazgos = fake.hoja(ids.ord, 'EmpalmeHallazgos');
    const encabezadosH = hallazgos[0];
    const filaH = (id, orden) => encabezadosH.map(c => ({ ID: id, Equipo: 'JOY 3', Descripcion: 'Hallazgo ' + id, Prioridad: 'Media', Estado: 'En orden', OrdenNumero: orden, RegistradoPor: 'Ana', FechaRegistro: '2026-10-01' })[c] || '');
    hallazgos.push(filaH('H-BORRADA', 'OT-BORRADA'), filaH('H-OTRO', 'OT-OTRO-EQUIPO'));
    fake.hoja(ids.ord, 'Ordenes').push(filaOrden('OT-OTRO-EQUIPO', 'Pendiente')); // está en Sheets, no en este equipo
    const estados = () => Object.fromEntries(fake.hoja(ids.ord, 'EmpalmeHallazgos').slice(1)
      .map(f => [f[encabezadosH.indexOf('ID')], f[encabezadosH.indexOf('Estado')] + ':' + f[encabezadosH.indexOf('OrdenNumero')]]));
    const abrirEmpalme = () => p.evaluate(async () => {
      _invalidarCacheHoja(SH.empalmeHallazgos);
      await inicializarPanelEmpalme();
      empMostrarSubTab('hallazgos');
      const fila = id => [...document.querySelectorAll('#empHallazgosLista tbody tr')].find(tr => tr.textContent.includes('Hallazgo ' + id));
      return {
        memoria: Object.fromEntries(_emp.hallazgos.filter(h => h.ID.startsWith('H-')).map(h => [h.ID, h.Estado])),
        crearOrdenBorrada: !!fila('H-BORRADA') && /Crear orden/.test(fila('H-BORRADA').textContent),
      };
    });
    fallanOrdenes = true;
    out.sinLectura = { pantalla: await abrirEmpalme(), hoja: estados() };
    fallanOrdenes = false;
    out.conLectura = { pantalla: await abrirEmpalme(), hoja: estados() };
    out.errs = errs;
    await ctx.close();

    check('Empalme (bodega): la misma lista otra vez solo carga lo nuevo, avisa cuáles ya estaban y el stock no se duplica',
      /Listo: 2 productos cargados/.test(out.bodega.primera.msg) && !/ya se cargaron antes/.test(out.bodega.primera.pregunta)
      && /¿Cargar 1 producto/.test(out.bodega.segunda.pregunta) && /ya se cargaron antes y no se vuelven a cargar: FIL-01, ACE-02/.test(out.bodega.segunda.pregunta)
      && /Listo: 1 producto cargado/.test(out.bodega.segunda.msg) && /No se repitieron los que ya estaban: FIL-01, ACE-02/.test(out.bodega.segunda.msg)
      && out.bodega.tercera.pregunta === '' && /Todos esos productos ya se cargaron como inventario inicial \(FIL-01, ACE-02\); no se cargó nada otra vez/.test(out.bodega.tercera.msg)
      && out.bodega.tercera.filasQuedan === 2
      && out.bodega.stock === 'ACE-02=20, FIL-01=4, GRA-03=2' && out.bodega.movimientos === 3, out.bodega);
    check('Empalme (hallazgos): con Sheets lento, la fila dice "Creando orden…" y un segundo toque no crea otra orden',
      out.doble.botones === 'Creando orden… (deshabilitado)' && out.doble.ventanas === 0 && out.doble.ordenes === 1
      && out.doble.hallazgo.estado === 'En orden' && out.doble.hallazgo.conOrden && out.doble.hallazgo.botones === 'Resuelto', out.doble);
    check('Empalme (hallazgos): el de una orden eliminada vuelve a Abierto con "Crear orden"; el de una orden de otro equipo no cambia; sin poder leer las órdenes no se reabre ninguno',
      out.sinLectura.hoja['H-BORRADA'] === 'En orden:OT-BORRADA' && out.sinLectura.pantalla.memoria['H-BORRADA'] === 'En orden'
      && out.conLectura.hoja['H-BORRADA'] === 'Abierto:' && out.conLectura.pantalla.memoria['H-BORRADA'] === 'Abierto' && out.conLectura.pantalla.crearOrdenBorrada
      && out.conLectura.hoja['H-OTRO'] === 'En orden:OT-OTRO-EQUIPO' && out.conLectura.pantalla.memoria['H-OTRO'] === 'En orden',
      { sinLectura: out.sinLectura, conLectura: out.conLectura });
    check('Empalme (segunda revisión): sin errores de JS', !out.errs.length, out.errs.slice(0, 2));
  }

  await b.close();
  srv.close();
  let ok = 0;
  for (const x of resultados) { console.log((x.ok ? 'PASS ' : 'FAIL ') + x.nombre + (x.ok ? '' : '  → ' + JSON.stringify(x.detalle))); if (x.ok) ok++; }
  console.log(`\n${ok}/${resultados.length} pruebas de la app OK`);
  process.exit(ok === resultados.length ? 0 : 1);
})();
