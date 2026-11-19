// ══════════════════════════════════════════════════════════════════════
// COBERTURA DE LAS PRUEBAS (auditoría P-04)
//
// Corre todas las pruebas midiendo qué parte del código ejecutan, y dice
// por archivo cuántas funciones y cuántas líneas de código se usaron al
// menos una vez, más las funciones grandes de la app que ninguna prueba
// toca. Sirve para saber dónde faltan pruebas; no aprueba ni reprueba nada
// por el porcentaje.
//
// Cómo se mide, sin herramientas extra:
//   • Pruebas de Node (proxy, bot, scripts de fotos y respaldo): con la
//     variable NODE_V8_COVERAGE, que hace que Node guarde lo que ejecutó.
//   • La app (index.html) en Chromium: pruebas/app.test.js guarda lo que
//     ejecutó cada página cuando existe COBERTURA_DIR.
//   • Las funciones se cuentan leyendo el código con acorn, porque V8 no
//     reporta las que están dentro de otra función que nunca corrió.
//
// Cómo correrla:
//   npm install --no-save acorn@8.14.0      (y Playwright, como app.test.js)
//   node pruebas/cobertura.mjs              (todo, unos 5 minutos)
//   node pruebas/cobertura.mjs --sin-app    (solo las pruebas de Node)
// Si existe GITHUB_STEP_SUMMARY (en GitHub), también escribe ahí el resumen.
// ══════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let acorn;
try { acorn = require('acorn'); }
catch (_) { console.error('Falta acorn. Instálalo con:  npm install --no-save acorn@8.14.0'); process.exit(2); }

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '..');
const conApp = !process.argv.includes('--sin-app');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cobertura-'));
const dirNode = path.join(tmp, 'node'), dirApp = path.join(tmp, 'app');

// ── 1. Correr las pruebas ────────────────────────────────────────────────
const PRUEBAS_NODE = ['worker.test.mjs', 'whatsapp-worker.test.mjs', 'fotos-script.test.mjs', 'respaldo-script.test.mjs'];
const fallidas = [];
const correr = (archivo, env) => {
  process.stdout.write('Corriendo ' + archivo + '… ');
  const r = spawnSync(process.execPath, [path.join(aqui, archivo)], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ultima = (r.stdout || '').trim().split('\n').pop();
  console.log(r.status === 0 ? (ultima || 'OK') : 'FALLÓ');
  if (r.status !== 0) { fallidas.push(archivo); console.log((r.stdout || '').split('\n').filter(l => /^FAIL/.test(l)).join('\n') || r.stderr); }
};
for (const p of PRUEBAS_NODE) correr(p, { NODE_V8_COVERAGE: dirNode });
if (conApp) correr('app.test.js', { COBERTURA_DIR: dirApp });

// ── 2. Qué se ejecutó de cada archivo ────────────────────────────────────
// Los archivos que se miden. Las pruebas de Node importan copias temporales
// de los Workers (cf-proxy-…, cf-whatsapp-…): se cuentan como el original.
const ARCHIVOS = {
  'proxy-seguridad/cloudflare-proxy.js': u => /cf-proxy-[^/]*\.mjs$/.test(u),
  'whatsapp-agente/cloudflare-worker.js': u => /cf-whatsapp-[^/]*\.mjs$/.test(u),
  'whatsapp-agente/Codigo-sin-ia.gs': u => u.endsWith('Codigo-sin-ia.gs'),
  'fotos-apps-script.gs': u => u.endsWith('fotos-apps-script.gs'),
  'respaldo-apps-script.gs': u => u.endsWith('respaldo-apps-script.gs'),
};

/** Para cada carácter del código: -1 si nunca se cubrió con un rango,
 *  0 si su bloque no corrió, >0 si corrió. Los rangos de V8 van anidados:
 *  se aplican de afuera hacia adentro, así el más interno manda. */
function marcar(conteo, funciones, base) {
  const rangos = funciones.flatMap(f => f.ranges);
  rangos.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of rangos) {
    const ini = base + r.startOffset, fin = Math.min(conteo.length, base + r.endOffset);
    for (let i = ini; i < fin; i++) conteo[i] = r.count;
  }
}

const unidades = {}; // archivo → { texto, trozos: [{ base, fuente }], ejecutado: Uint8Array, visto: Uint8Array, fnEnd: Map(fin → corrió) }
function unidad(archivo, texto) {
  return (unidades[archivo] = unidades[archivo] || {
    texto, trozos: [], ejecutado: new Uint8Array(texto.length), visto: new Uint8Array(texto.length), fnFin: new Map(),
  });
}
function sumar(u, funciones, base, largo) {
  const conteo = new Int32Array(largo).fill(-1);
  marcar(conteo, funciones, 0);
  for (let i = 0; i < largo; i++) {
    if (conteo[i] !== -1) u.visto[base + i] = 1;
    if (conteo[i] > 0) u.ejecutado[base + i] = 1;
  }
  for (const f of funciones) {
    const r = f.ranges[0];
    const fin = base + r.endOffset;
    u.fnFin.set(fin, (u.fnFin.get(fin) || false) || r.count > 0);
  }
}

// Node
if (fs.existsSync(dirNode)) {
  for (const f of fs.readdirSync(dirNode)) {
    const datos = JSON.parse(fs.readFileSync(path.join(dirNode, f), 'utf8'));
    for (const s of datos.result || []) {
      const url = s.url.replace(/^file:\/\//, '');
      const archivo = Object.keys(ARCHIVOS).find(a => ARCHIVOS[a](url));
      if (!archivo) continue;
      const texto = fs.readFileSync(path.join(raiz, archivo), 'utf8');
      const u = unidad(archivo, texto);
      if (!u.trozos.length) u.trozos.push({ base: 0, fuente: texto });
      sumar(u, s.functions, 0, texto.length);
    }
  }
}

// La app: cada <script> de index.html es un trozo; Chromium da su texto y
// aquí se ubica dentro del archivo.
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const scriptsHtml = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => ({ base: m.index + '<script>'.length, fuente: m[1] }));
if (conApp && fs.existsSync(dirApp)) {
  const u = unidad('index.html', html);
  u.trozos = scriptsHtml;
  for (const f of fs.readdirSync(dirApp)) {
    for (const e of JSON.parse(fs.readFileSync(path.join(dirApp, f), 'utf8'))) {
      const trozo = scriptsHtml.find(t => t.fuente === e.source);
      if (trozo) sumar(u, e.functions, trozo.base, trozo.fuente.length);
    }
  }
}

// ── 3. Contar funciones y líneas ─────────────────────────────────────────
function medir(archivo, u) {
  const funciones = [];
  const comentario = new Uint8Array(u.texto.length);
  for (const t of u.trozos) {
    const ast = acorn.parse(t.fuente, {
      ecmaVersion: 'latest', sourceType: /\.mjs$|\.js$/.test(archivo) && /^\s*export\s/m.test(t.fuente) ? 'module' : 'script',
      allowHashBang: true, allowReturnOutsideFunction: true,
      onComment: (_b, _txt, ini, fin) => { for (let i = ini; i < fin; i++) comentario[t.base + i] = 1; },
    });
    (function recorrer(n, nombre) {
      if (!n || typeof n.type !== 'string') return;
      if (/Function/.test(n.type)) {
        const ini = t.base + n.start, fin = t.base + n.end;
        funciones.push({ nombre: (n.id && n.id.name) || nombre || '(anónima)', ini, fin, corrio: u.fnFin.get(fin) === true });
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        const hijoNombre = n.type === 'VariableDeclarator' && n.id ? n.id.name
          : (n.type === 'Property' || n.type === 'MethodDefinition') && n.key ? (n.key.name || n.key.value) : undefined;
        if (Array.isArray(v)) v.forEach(x => recorrer(x, hijoNombre));
        else if (v && typeof v === 'object' && k !== 'loc') recorrer(v, hijoNombre);
      }
    })(ast);
  }
  // Líneas de código (sin las de solo comentarios o espacios): cubierta si
  // algún carácter de código de la línea corrió.
  let lineas = 0, cubiertas = 0;
  for (const t of u.trozos) {
    let i = t.base, fin = t.base + t.fuente.length;
    while (i < fin) {
      let j = u.texto.indexOf('\n', i); if (j === -1 || j > fin) j = fin;
      let codigo = false, corrio = false;
      for (let k = i; k < j; k++) {
        if (comentario[k] || /\s/.test(u.texto[k])) continue;
        codigo = true; if (u.ejecutado[k]) { corrio = true; break; }
      }
      if (codigo) { lineas++; if (corrio) cubiertas++; }
      i = j + 1;
    }
  }
  const linea = pos => u.texto.slice(0, pos).split('\n').length;
  return { funciones, lineas, cubiertas, linea };
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '—') + ' %';
const filas = [];
let sinProbar = [];
for (const archivo of [...Object.keys(ARCHIVOS), 'index.html']) {
  const u = unidades[archivo];
  if (!u) { if (archivo !== 'index.html' || conApp) filas.push([archivo, 'sin datos', '', '']); continue; }
  const m = medir(archivo, u);
  const corridas = m.funciones.filter(f => f.corrio).length;
  filas.push([archivo, `${corridas} de ${m.funciones.length}`, pct(corridas, m.funciones.length), pct(m.cubiertas, m.lineas)]);
  if (archivo === 'index.html') {
    sinProbar = m.funciones.filter(f => !f.corrio && f.nombre !== '(anónima)')
      .map(f => ({ nombre: f.nombre, linea: m.linea(f.ini), largo: m.linea(f.fin) - m.linea(f.ini) + 1 }))
      // Solo las de más afuera: si una función nunca corrió, las de adentro tampoco.
      .filter((f, _i, todas) => !todas.some(o => o !== f && o.linea <= f.linea && o.linea + o.largo >= f.linea + f.largo && (o.linea < f.linea || o.largo > f.largo)))
      .sort((a, b) => b.largo - a.largo).slice(0, 20);
  }
}

// ── 4. Informe ────────────────────────────────────────────────────────────
const ancho = [0, 1, 2, 3].map(c => Math.max(...[['Archivo', 'Funciones usadas', '%', 'Líneas'], ...filas].map(f => String(f[c]).length)));
const fila = f => f.map((x, c) => String(x).padEnd(ancho[c])).join('   ');
console.log('\nCobertura de las pruebas\n');
console.log(fila(['Archivo', 'Funciones usadas', '%', 'Líneas']));
filas.forEach(f => console.log(fila(f)));
if (sinProbar.length) {
  console.log('\nFunciones más grandes de la app que ninguna prueba ejecuta:');
  sinProbar.forEach(f => console.log(`  ${f.nombre} (index.html:${f.linea}, ${f.largo} líneas)`));
}
if (fallidas.length) console.log('\nOJO: fallaron ' + fallidas.join(', ') + '. La cobertura de esas pruebas queda incompleta.');

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ['## Cobertura de las pruebas', '', '| Archivo | Funciones usadas | % | Líneas |', '|---|---|---|---|',
    ...filas.map(f => '| ' + f.join(' | ') + ' |'),
    ...(sinProbar.length ? ['', '### Funciones más grandes de la app sin ninguna prueba', '', ...sinProbar.map(f => `- \`${f.nombre}\` (index.html:${f.linea}, ${f.largo} líneas)`)] : []),
    ...(fallidas.length ? ['', '**Fallaron:** ' + fallidas.join(', ')] : [])];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fallidas.length ? 1 : 0);
