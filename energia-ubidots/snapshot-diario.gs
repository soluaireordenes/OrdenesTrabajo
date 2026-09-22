/* ══════════════════════════════════════════════════════════════════
   SNAPSHOT DIARIO DE ENERGÍA — Ubidots → Google Sheets
   Sistema Integral de Gestión · SolucionAIRE

   Qué hace:
   Una vez al día toma de Ubidots, por cada compresor:
     • el consumo de energía del día  (kWh)
     • la potencia promedio           (kW)
     • el flujo de aire promedio       (SCFM / pcm)
   y agrega UNA fila por (Fecha, Compresor) en la hoja "EnergiaDiaria".
   La app lee esa hoja y arma la sección de Eficiencia Energética
   (consumo diario/mensual/anual, costo, comparativos, KPIs).

   Por qué así:
   El token de Ubidots NUNCA puede ir en el index.html (es un sitio
   público). Este script vive en Apps Script, guarda el token en las
   Propiedades del Script y deja en Sheets solo los números agregados.
   Además queda historial propio aunque Ubidots borre datos por retención.

   ── INSTALACIÓN (una sola vez) ──
   1) Extensions → Apps Script en la hoja donde quieres "EnergiaDiaria"
      (puede ser la misma hoja de la sede o una nueva).
   2) Pega este archivo.
   3) Project Settings → Script Properties, agrega:
        UBIDOTS_TOKEN   = <tu token de Ubidots>   (NO el token del device,
                          usa un token de cuenta con permiso de lectura)
   4) Ajusta CONFIG abajo: DEVICE_LABEL, SHEET_ID (o déjalo '' para usar
      la hoja activa), y sobre todo COMPRESORES con las etiquetas reales
      de TUS 25 variables.
   5) Corre una vez `probarConexionUbidots()` para verificar token/labels.
   6) Corre `crearTriggerDiario()` una vez para programar el snapshot
      (~00:20 cada día, toma el día ANTERIOR completo).
   7) Opcional: corre `snapshotAyer()` a mano para cargar el primer día.
   ══════════════════════════════════════════════════════════════════ */

var CONFIG = {
  // Endpoint de la API. Cuenta Industrial: industrial.api.ubidots.com
  // Cuenta estándar: industrial.api.ubidots.com también suele servir; si
  // usas la comunitaria, cámbialo a things.ubidots.com.
  API_BASE: 'https://industrial.api.ubidots.com/api/v1.6',

  DEVICE_LABEL: 'falcon-compresores-1',

  // Deja '' para escribir en la hoja donde está pegado el script.
  // O pon el ID de otra hoja (el trozo largo de su URL).
  SHEET_ID: '',
  SHEET_NAME: 'EnergiaDiaria',

  // Cómo interpretar las variables energia_*_diff_kwh:
  //   'delta'    → cada dato ya es el consumo de su intervalo → se SUMAN.
  //   'contador' → es un acumulado que solo sube → consumo = último - primero.
  // (Confírmalo mirando la variable en Ubidots; el nombre "diff" sugiere delta.)
  MODO_ENERGIA: 'delta',

  // Zona horaria para cortar el "día". Colombia = -5, sin horario de verano.
  TZ_OFFSET_HORAS: -5,

  // ── EL MAPA DE COMPRESORES ──
  // Una entrada por compresor. Completa con las etiquetas EXACTAS de tus
  // 25 variables (las de la izquierda en Ubidots). Si a algún compresor le
  // falta alguna variable, deja '' y ese dato se omite.
  // (Prellenado con lo que se ve en la captura — REVÍSALO Y COMPLÉTALO.)
  COMPRESORES: [
    { id: 'a1', energia: 'energia_a1_diff_kwh', potencia: 'a1_pot_act_kw', flujo: '' },
    { id: 'a2', energia: 'energia_a2_diff_kwh', potencia: 'a2_pot_act_kw', flujo: '' },
    { id: 'a3', energia: 'energia_a3_diff_kwh', potencia: 'a3_pot_act_kw', flujo: '' },
    { id: 'b1', energia: 'energia_b1_diff_kwh', potencia: 'b1_pot_act_kw', flujo: 'seco_b1_flujo_scfm' },
    { id: 'b2', energia: 'energia_b2_diff_kwh', potencia: 'b2_pot_act_kw', flujo: 'seco_b2_flujo_scfm' },
    { id: 'b4', energia: 'energia_b4_diff_kwh', potencia: 'b4_pot_act_kw', flujo: 'seco_b4_flujo_scfm' },
  ],
};

var ENERGIA_COLS = ['Fecha', 'Compresor', 'ConsumoKWh', 'PotenciaPromKW', 'FlujoPromSCFM', 'Muestras', 'FechaRegistro'];

/** Punto de entrada del trigger diario: procesa el día de AYER completo. */
function snapshotEnergiaDiaria() {
  var ayer = _diaLocal(-1);
  _snapshotDeUnDia(ayer);
}

/** Igual que el trigger, pero llamable a mano para cargar el primer día. */
function snapshotAyer() { snapshotEnergiaDiaria(); }

/** Carga a mano un día específico. Ej: snapshotDeFecha('2026-09-20'). */
function snapshotDeFecha(fechaStr) {
  var d = _fechaDesdeISO(fechaStr);
  if (!d) throw new Error('Fecha inválida, usa YYYY-MM-DD');
  _snapshotDeUnDia(d);
}

function _snapshotDeUnDia(diaBase) {
  var token = _token();
  var hoja = _hoja();
  var fechaISO = _iso(diaBase);
  var inicio = _inicioDia(diaBase);           // 00:00 local
  var fin = inicio + 24 * 3600 * 1000;         // 00:00 del día siguiente

  var yaExiste = _fechasCompresorExistentes(hoja);
  var filasNuevas = [];

  CONFIG.COMPRESORES.forEach(function (c) {
    if (yaExiste[fechaISO + '|' + c.id]) return; // idempotente: no duplica

    var kwh = '';
    if (c.energia) {
      var ve = _ubiValores(token, c.energia, inicio, fin);
      kwh = _energiaDelDia(ve);
    }
    var kwProm = c.potencia ? _promedio(_ubiValores(token, c.potencia, inicio, fin)) : '';
    var flujoProm = c.flujo ? _promedio(_ubiValores(token, c.flujo, inicio, fin)) : '';
    var muestras = c.potencia ? _ubiValores(token, c.potencia, inicio, fin).length : '';

    filasNuevas.push([
      fechaISO, c.id,
      _num(kwh), _num(kwProm), _num(flujoProm), muestras,
      new Date(),
    ]);
  });

  if (filasNuevas.length) {
    hoja.getRange(hoja.getLastRow() + 1, 1, filasNuevas.length, ENERGIA_COLS.length).setValues(filasNuevas);
  }
  Logger.log('Snapshot ' + fechaISO + ': ' + filasNuevas.length + ' fila(s).');
}

/** Consumo del día a partir de la serie de energia_*_diff_kwh. */
function _energiaDelDia(valores) {
  if (!valores.length) return '';
  if (CONFIG.MODO_ENERGIA === 'contador') {
    // Acumulado: último - primero (los datos vienen del más nuevo al más viejo).
    var nums = valores.map(function (v) { return v.value; });
    var maxV = Math.max.apply(null, nums), minV = Math.min.apply(null, nums);
    return Math.max(0, maxV - minV);
  }
  // delta: se suman todos los deltas del día.
  return valores.reduce(function (a, v) { return a + (v.value || 0); }, 0);
}

function _promedio(valores) {
  if (!valores.length) return '';
  var s = valores.reduce(function (a, v) { return a + (v.value || 0); }, 0);
  return s / valores.length;
}

/** Trae los valores crudos de una variable entre dos instantes (ms). */
function _ubiValores(token, variableLabel, startMs, endMs) {
  var url = CONFIG.API_BASE + '/devices/' + encodeURIComponent(CONFIG.DEVICE_LABEL) +
    '/' + encodeURIComponent(variableLabel) + '/values' +
    '?start=' + startMs + '&end=' + endMs + '&page_size=5000';
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'X-Auth-Token': token },
    muteHttpExceptions: true,
  });
  var code = resp.getResponseCode();
  if (code === 404) return []; // variable sin datos en ese rango
  if (code < 200 || code >= 300) {
    throw new Error('Ubidots ' + code + ' en ' + variableLabel + ': ' + resp.getContentText().slice(0, 200));
  }
  var data = JSON.parse(resp.getContentText());
  return (data.results || []).map(function (r) {
    return { timestamp: r.timestamp, value: Number(r.value) };
  });
}

/** Prueba rápida: lista los últimos valores de la primera variable. */
function probarConexionUbidots() {
  var token = _token();
  var c = CONFIG.COMPRESORES[0];
  var fin = Date.now(), ini = fin - 6 * 3600 * 1000;
  var v = _ubiValores(token, c.energia || c.potencia, ini, fin);
  Logger.log('OK. ' + v.length + ' valores de ' + (c.energia || c.potencia) +
    ' en las últimas 6 h. Muestra: ' + JSON.stringify(v.slice(0, 3)));
}

/** Programa el snapshot diario (~00:20). Córrelo UNA vez. */
function crearTriggerDiario() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'snapshotEnergiaDiaria') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('snapshotEnergiaDiaria').timeBased().atHour(0).nearMinute(20).everyDays(1).create();
  Logger.log('Trigger diario creado (~00:20).');
}

/* ── utilidades ── */
function _token() {
  var t = PropertiesService.getScriptProperties().getProperty('UBIDOTS_TOKEN');
  if (!t) throw new Error('Falta la Propiedad de Script UBIDOTS_TOKEN.');
  return t;
}
function _hoja() {
  var ss = CONFIG.SHEET_ID ? SpreadsheetApp.openById(CONFIG.SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  var h = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!h) { h = ss.insertSheet(CONFIG.SHEET_NAME); h.appendRow(ENERGIA_COLS); }
  else if (h.getLastRow() === 0) { h.appendRow(ENERGIA_COLS); }
  return h;
}
function _fechasCompresorExistentes(hoja) {
  var out = {};
  if (hoja.getLastRow() < 2) return out;
  var vals = hoja.getRange(2, 1, hoja.getLastRow() - 1, 2).getValues();
  vals.forEach(function (r) { out[_iso(r[0]) + '|' + String(r[1])] = true; });
  return out;
}
function _num(v) { return (v === '' || v === null || isNaN(v)) ? '' : Math.round(v * 100) / 100; }
function _diaLocal(deltaDias) {
  var d = new Date(Date.now() + CONFIG.TZ_OFFSET_HORAS * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + (deltaDias || 0));
  return d;
}
function _inicioDia(d) {
  // Medianoche local expresada en ms UTC.
  var y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  return Date.UTC(y, m, day) - CONFIG.TZ_OFFSET_HORAS * 3600 * 1000;
}
function _iso(d) {
  var x = (d instanceof Date) ? d : new Date(d);
  var l = new Date(x.getTime() + CONFIG.TZ_OFFSET_HORAS * 3600 * 1000);
  return l.getUTCFullYear() + '-' + String(l.getUTCMonth() + 1).padStart(2, '0') + '-' + String(l.getUTCDate()).padStart(2, '0');
}
function _fechaDesdeISO(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
