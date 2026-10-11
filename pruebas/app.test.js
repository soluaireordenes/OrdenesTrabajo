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
  for (const [patron, fn] of Object.entries(rutas)) await ctx.route(patron, fn);
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE, { waitUntil: 'load' });
  await p.waitForTimeout(500);
  return { ctx, p, errs };
}

const JPG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

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
        '_fotosBatchSoportado','CLAVE_ACCESO_HASH','LOGIN_APPSCRIPT_URL','_loginAppsScript','_tiempoRealIntervalId'];
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
    await p.evaluate(() => loginConDocumentoPinClick()); await p.waitForTimeout(800);
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

  // 8) Repuestos de la Hoja de Vida (sin Ubicación)
  {
    const { ctx, p } = await nuevaPagina(b);
    const r = await p.evaluate(() => {
      usuarioRol = 'admin';
      const host = document.createElement('div');
      host.innerHTML = `<table><tbody id="hvd_tbody_repuestos">${_htmlFilaRepuestoHVD({ codigo: 'C1', nombre: 'Filtro', cantidad: '2', ubicacion: 'B', observacion: 'o' })}</tbody></table>`;
      document.body.appendChild(host);
      const leido = _leerRepuestosEditorHVD()[0];
      return { inputs: host.querySelectorAll('input').length, leido };
    });
    check('Repuestos HVD: Código, Repuesto, Cantidad, Observación', r.inputs === 4 && r.leido.cantidad === '2' && r.leido.ubicacion === '' && r.leido.observacion === 'o', r);
    await ctx.close();
  }

  // 9) Permisos de la auditoría: lo que quedó solo para admin
  for (const rol of ['operario', 'admin']) {
    const { ctx, p } = await nuevaPagina(b, { '**/sheets/v4/**': r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"values":[],"sheets":[],"valueRanges":[]}' }) });
    const r = await p.evaluate(async (rol) => {
      const out = { alerts: [] };
      window.alert = m => out.alerts.push(String(m)); window.confirm = () => false; window.prompt = () => null;
      usuarioRol = rol; _aplicarRolUI(); googleAccessToken = 'SESS'; operacionAutenticada = true; renderSidebarOperaciones();
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

  await b.close();
  srv.close();
  let ok = 0;
  for (const x of resultados) { console.log((x.ok ? 'PASS ' : 'FAIL ') + x.nombre + (x.ok ? '' : '  → ' + JSON.stringify(x.detalle))); if (x.ok) ok++; }
  console.log(`\n${ok}/${resultados.length} pruebas de la app OK`);
  process.exit(ok === resultados.length ? 0 : 1);
})();
