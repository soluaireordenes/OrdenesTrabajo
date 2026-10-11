// ══════════════════════════════════════════════════════════════════════
// REVISIÓN DE SINTAXIS — los bloques <script> de index.html y el service
// worker. Es la misma revisión que hacía el flujo "Validar sintaxis", ahora
// en un archivo para poder correrla igual en GitHub y en el computador.
//
// Cómo correrla:  node pruebas/sintaxis.js
// ══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const raiz = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) { console.log('No se encontraron bloques <script>.'); process.exit(1); }

let hayError = false;
scripts.forEach((s, i) => {
  try { new Function(s); console.log('Script ' + i + ': OK'); }
  catch (e) { console.log('Script ' + i + ': ERROR - ' + e.message); hayError = true; }
});
try { new Function(fs.readFileSync(path.join(raiz, 'sw.js'), 'utf8')); console.log('sw.js: OK'); }
catch (e) { console.log('sw.js: ERROR - ' + e.message); hayError = true; }
process.exit(hayError ? 1 : 0);
