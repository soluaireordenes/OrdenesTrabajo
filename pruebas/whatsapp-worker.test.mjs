// ══════════════════════════════════════════════════════════════════════
// PRUEBAS DEL INTERMEDIARIO DE WHATSAPP (whatsapp-agente/cloudflare-worker.js)
//
// Carga el Worker real con Apps Script SIMULADO (no se conecta a nada) y
// revisa la verificación del webhook y la firma de Meta: con APP_SECRET solo
// pasa lo que Meta firmó; sin APP_SECRET todo sigue como antes. Y del bot
// (Codigo-sin-ia.gs), que reconozca a los operarios por el número completo.
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

let total = 0;
for (const r of resultados) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.ok ? '' : '  → ' + JSON.stringify(r.d))); if (r.ok) total++; }
console.log(`\n${total}/${resultados.length} pruebas del intermediario de WhatsApp OK`);
process.exit(total === resultados.length ? 0 : 1);
