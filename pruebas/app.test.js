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
    await p.fill('#loginDocumento', '1007788656'); await p.fill('#loginPin', '2026');
    await p.evaluate(() => loginConDocumentoPinClick()); await p.waitForTimeout(800);
    const r = await p.evaluate(() => ({ token: googleAccessToken, rol: usuarioRol, ss: sessionStorage.getItem('gToken') }));
    check('Login por proxy guarda pase y rol', r.token === 'SESS.abc' && r.rol === 'admin' && r.ss === 'SESS.abc' && JSON.parse(body).documento === '1007788656', r);
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

  await b.close();
  srv.close();
  let ok = 0;
  for (const x of resultados) { console.log((x.ok ? 'PASS ' : 'FAIL ') + x.nombre + (x.ok ? '' : '  → ' + JSON.stringify(x.detalle))); if (x.ok) ok++; }
  console.log(`\n${ok}/${resultados.length} pruebas de la app OK`);
  process.exit(ok === resultados.length ? 0 : 1);
})();
