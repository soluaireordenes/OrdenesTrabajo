// ══════════════════════════════════════════════════════════════════════
// ANÁLISIS DEL CÓDIGO — un paso más que la revisión de sintaxis. Busca en
// los bloques <script> de index.html y en sw.js:
//   • nombres que no existen (una función mal escrita no da error al abrir
//     la app, solo cuando alguien toca ese botón),
//   • declaraciones y claves repetidas, casos de switch duplicados, código
//     que nunca se ejecuta y comparaciones que nunca pueden cumplirse;
// y en los onclick="…" (y demás on…) del HTML, que ESLint no ve, que cada
// función llamada exista. Las variables locales sin usar salen como aviso:
// no detienen la publicación.
//
// Cómo correrlo (instala ESLint solo para esto, sin package.json):
//   npm install --no-save eslint@10.12.0 globals@17.12.0
//   node pruebas/analisis.js
// Con ESLint instalado en otra parte:
//   ESLINT_MODULE=/ruta/eslint GLOBALS_MODULE=/ruta/globals node pruebas/analisis.js
// ══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { Linter } = require(process.env.ESLINT_MODULE || 'eslint');
const globals = require(process.env.GLOBALS_MODULE || 'globals');

const raiz = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');

// Bibliotecas copiadas tal cual dentro de index.html (el mapa): no son nuestras.
const esBiblioteca = s => s.startsWith('!function(t,e)') || s.startsWith('"use strict";jsVectorMap');

// Todos los <script> propios en un solo texto y lo demás en blanco: así los
// números de línea son los de index.html y, como en el navegador, lo que
// declara un bloque se ve en los siguientes.
let codigo = '';
let ultimo = 0;
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  if (esBiblioteca(m[1])) continue;
  const inicio = m.index + '<script>'.length;
  codigo += html.slice(ultimo, inicio).replace(/[^\n]/g, '') + m[1] + ';';
  ultimo = inicio + m[1].length;
}

const ERRORES = {
  'no-undef': 'error', 'no-redeclare': 'error', 'no-dupe-keys': 'error', 'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error', 'no-unreachable': 'error', 'no-self-assign': 'error', 'no-self-compare': 'error',
  'no-cond-assign': 'error', 'no-unsafe-finally': 'error', 'no-unsafe-negation': 'error', 'use-isnan': 'error',
  'valid-typeof': 'error', 'no-func-assign': 'error', 'no-const-assign': 'error', 'no-sparse-arrays': 'error',
  'no-constant-binary-expression': 'error', 'no-loss-of-precision': 'error', 'no-empty-pattern': 'error',
  'no-async-promise-executor': 'error', 'getter-return': 'error', 'no-setter-return': 'error',
};
const AVISOS = { 'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }] };

function analizar(nombre, texto, globales) {
  const linter = new Linter({ configType: 'flat' });
  const mensajes = linter.verify(texto, [{
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globales },
    rules: { ...ERRORES, ...AVISOS },
  }], { filename: nombre + '.js' });
  return { mensajes: mensajes.map(m => ({ ...m, archivo: nombre })), fuente: linter.getSourceCode() };
}

const globalesApp = { ...globals.browser, Chart: 'readonly', jsVectorMap: 'readonly' };
const app = analizar('index.html', codigo, globalesApp);
const sw = analizar('sw.js', fs.readFileSync(path.join(raiz, 'sw.js'), 'utf8'), globals.serviceworker);
const mensajes = [...app.mensajes, ...sw.mensajes];

// Los on…="…" del HTML (también los que arman las plantillas): cada función
// que llaman tiene que existir como global de la app o del navegador.
const declaradas = new Set(app.fuente.scopeManager.globalScope.variables.map(v => v.name));
for (const m of codigo.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) declaradas.add(m[1]);
const PALABRAS = new Set(['if', 'for', 'while', 'switch', 'return', 'function', 'typeof', 'new', 'await', 'catch']);
const lineas = html.split('\n');
for (const m of html.matchAll(/\son[a-z]+\s*=\s*(["'])([\s\S]*?)\1/g)) {
  const linea = html.slice(0, m.index).split('\n').length;
  // Los on…="fn()" que aparecen dentro de un comentario no son código.
  if (/^\s*(\*|\/\/|\/\*)/.test(lineas[linea - 1])) continue;
  // Fuera lo que no es código del manejador: las partes ${…} de la plantilla
  // (las revisa ESLint con el resto del script) y los textos entre comillas,
  // como 'var(--brand-light)'.
  let manejador = m[2];
  while (/\$\{[^{}]*\}/.test(manejador)) manejador = manejador.replace(/\$\{[^{}]*\}/g, 'x');
  manejador = manejador.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|&#39;[\s\S]*?&#39;|&quot;[\s\S]*?&quot;/g, "''");
  for (const [, nombre] of manejador.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (PALABRAS.has(nombre) || declaradas.has(nombre) || nombre in globalesApp) continue;
    mensajes.push({ archivo: 'index.html', line: linea, severity: 2, ruleId: 'manejador', message: `"${nombre}()" no existe (lo llama un on…="…")` });
  }
}

const errores = mensajes.filter(m => m.severity === 2 || m.fatal);
const avisos = mensajes.filter(m => !(m.severity === 2 || m.fatal));
const linea = m => `${m.archivo}:${m.line}  ${m.message}${m.ruleId ? ' (' + m.ruleId + ')' : ''}`;
avisos.forEach(m => console.log('AVISO  ' + linea(m)));
errores.forEach(m => console.log('ERROR  ' + linea(m)));
console.log(errores.length
  ? `\nAnálisis: ${errores.length} error(es)${avisos.length ? ' y ' + avisos.length + ' aviso(s)' : ''}.`
  : `Análisis: sin errores${avisos.length ? ' (' + avisos.length + ' aviso(s))' : ''} en index.html y sw.js.`);
process.exit(errores.length ? 1 : 0);
