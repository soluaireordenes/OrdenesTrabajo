/* ══════════════════════════════════════════════════════════════════════
   APPS SCRIPT DE RESPALDO NOCTURNO — Sistema SolucionAIRE (uno solo)

   Cada noche hace una copia completa de las hojas de Google del sistema
   (órdenes e inventario de las 6 sedes, Proyectos y, si se configura,
   Usuarios) en una carpeta de respaldo: una subcarpeta por día
   ("Respaldo 2026-11-18") con una copia de cada hoja, con todas sus
   pestañas. Las subcarpetas de más de 30 días van a la papelera.

   Antes no había ningún respaldo programado: lo único era el historial de
   versiones de cada hoja, que se restaura a mano y vive en la misma cuenta
   (auditoría D-01). Un borrado por error de una pestaña o una cuenta
   comprometida podía costar días de operación.

   Si alguna hoja no se pudo copiar, manda un correo a la cuenta dueña del
   script (o a CORREO_AVISO) con cuáles y por qué, y la ejecución queda
   marcada como fallida en el registro de Apps Script.

   ── CÓMO SE INSTALA (una sola vez) ────────────────────────────────────
   1. Con la cuenta dueña de las hojas (o una que pueda abrirlas todas):
      script.google.com → Nuevo proyecto → pega este archivo completo.
      Ponle de nombre "Respaldo SolucionAIRE".
   2. En Drive crea la carpeta de respaldos. Lo mejor es que esté en una
      Unidad compartida o compartida con una segunda cuenta de confianza,
      así el respaldo no depende de una sola cuenta. Copia su ID (lo que va
      en la URL de la carpeta entre /folders/ y el signo ?).
   3. Configuración del proyecto (engranaje) → Propiedades del script →
        • CARPETA_RESPALDO_ID  el ID de la carpeta del paso 2 (obligatoria).
        • HOJAS_EXTRA          (opcional) IDs de otras hojas separados por
                               coma. Pon aquí la hoja de Usuarios: es el
                               mismo valor del secreto USUARIOS_SHEET_ID
                               del proxy en Cloudflare.
        • DIAS_RETENCION       (opcional) cuántos días se guardan; 30 si no
                               se pone.
        • CORREO_AVISO         (opcional) a quién avisar si algo falla; si no
                               se pone, a la cuenta dueña del script.
      Toca "Guardar propiedades del script".
   4. Ejecuta probarConfiguracion (menú de arriba → Ejecutar). La primera vez
      Google pide permisos: acepta. El registro dice si falta algo o si hay
      una hoja que esta cuenta no puede abrir.
   5. Ejecuta instalarRespaldoNocturno: deja programado el respaldo todos
      los días entre las 2 y las 3 de la mañana (hora del proyecto).
   6. Ejecuta respaldarAhora una vez para tener ya el primer respaldo, y
      revisa la carpeta.

   ── CÓMO SE RESTAURA ───────────────────────────────────────────────────
   La app usa el ID de cada hoja original, así que se restaura DENTRO de la
   hoja original, no cambiando de archivo:
   • Una pestaña: abre la copia del día que sirve → clic derecho en la
     pestaña → "Copiar en" → "Hoja de cálculo existente" → la original. En la
     original borra la pestaña dañada y cambia el nombre de la copia ("Copia
     de Ordenes" → "Ordenes").
   • Unas filas: cópialas desde la copia y pégalas en la original.
   Una vez por trimestre conviene hacer un simulacro: restaurar una pestaña
   en una hoja de prueba y ver que la app la lee.
   ═══════════════════════════════════════════════════════════════════ */

// Las hojas que usa la app (index.html: OPERACIONES, INVENTARIO_SHEETS y
// PROY_SPREADSHEET_ID). La prueba pruebas/respaldo-script.test.mjs avisa si
// la app suma una hoja que no esté aquí.
var HOJAS_RESPALDO = [
  { id: '1_gIoYzZIZeURojSemB5vTtSQ1k4vw4_YfN-G6AjtaYU', nombre: 'Ordenes Zipaquira' },
  { id: '1xM4UFaV1fZ5bEYVVNx55UjbPN9CldQ6ObaZl0EGlF8A', nombre: 'Ordenes Zipaquira 2' },
  { id: '1Dv4veJWQPP2tZkYXRXLPo0MQmu8cR843TBO3D0uChP8', nombre: 'Ordenes Soacha' },
  { id: '1cqMzlHEBbzKy9d_GDkVTVarvzL0Es2J1_bSXeKpkHYs', nombre: 'Ordenes Antioquia' },
  { id: '13kf6xZPfdnxDJmCyKJ0q-1z7ijRak7oMNhzemzq2KpI', nombre: 'Ordenes Mexico' },
  { id: '1SqiKOzrqvMSOAdeoF_8QqzSylh2Rccq7oDh-UpHaEhY', nombre: 'Ordenes Peru' },
  { id: '1cqfk7gKRX4MfnHnPEZy7WGOunwT7kYLfJ14_W10Wh3s', nombre: 'Inventario Zipaquira' },
  { id: '14yHP8GGumzc6c4CfAlLjTtnqJoWU8ATfQ3d1DAAafUk', nombre: 'Inventario Zipaquira 2' },
  { id: '1WpunyOSCJDDoIHgz-JKmJ_uNkHCloCQtIM36lm1RWdk', nombre: 'Inventario Soacha' },
  { id: '1Dj12a7g7s25A6bTb-oR54-FQY9qs0ffFHDtNq64q4fk', nombre: 'Inventario Antioquia' },
  { id: '1TEwFSN-p-XcPiKHqiv-dqp8B2eefB-0Ecui5KcFU_VI', nombre: 'Inventario Mexico' },
  { id: '1CsrOhNBFQN_6vpbo-QqzbJJIx2qtY1CdQeTGwR3EPDQ', nombre: 'Inventario Peru' },
  { id: '1rICqEwDTOjA8cxFIEa7m5rIw0gs2fd7CB682dRUj0nk', nombre: 'Proyectos' }
];

var PREFIJO_CARPETA = 'Respaldo ';
var DIAS_RETENCION_DEFECTO = 30;

function _propiedadOpcional(nombre) {
  return PropertiesService.getScriptProperties().getProperty(nombre) || '';
}

function _propiedad(nombre) {
  var valor = _propiedadOpcional(nombre);
  if (!valor) throw new Error('Falta la propiedad "' + nombre + '" en Configuración del proyecto → Propiedades del script.');
  return valor;
}

/** Las hojas a respaldar: las de la app más las de HOJAS_EXTRA, sin repetir. */
function _hojasARespaldar() {
  var lista = HOJAS_RESPALDO.slice();
  var vistos = {};
  lista.forEach(function (h) { vistos[h.id] = true; });
  _propiedadOpcional('HOJAS_EXTRA').split(',').forEach(function (id, i) {
    id = id.trim();
    if (id && !vistos[id]) { vistos[id] = true; lista.push({ id: id, nombre: 'Extra ' + (i + 1) }); }
  });
  return lista;
}

function _fechaHoy(ahora) {
  return Utilities.formatDate(ahora || new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** La subcarpeta del día; si ya existe (segunda corrida del día), la misma. */
function _carpetaDelDia(raiz, fecha) {
  var existentes = raiz.getFoldersByName(PREFIJO_CARPETA + fecha);
  return existentes.hasNext() ? existentes.next() : raiz.createFolder(PREFIJO_CARPETA + fecha);
}

/** Copia una hoja a la carpeta del día. Si ya había una copia de hoy con ese
 *  nombre (se corrió dos veces), la anterior va a la papelera. */
function _copiarHoja(hoja, carpetaDia) {
  var original = DriveApp.getFileById(hoja.id);
  var nombre = hoja.nombre + ' · ' + original.getName();
  var previas = carpetaDia.getFilesByName(nombre);
  while (previas.hasNext()) previas.next().setTrashed(true);
  original.makeCopy(nombre, carpetaDia);
  return nombre;
}

/** Manda a la papelera las subcarpetas "Respaldo AAAA-MM-DD" de más de
 *  `dias` días. No toca nada que no tenga ese nombre. */
function _borrarRespaldosViejos(raiz, fechaHoy, dias) {
  var limite = new Date(fechaHoy + 'T00:00:00Z').getTime() - dias * 86400000;
  var borradas = [];
  var carpetas = raiz.getFolders();
  while (carpetas.hasNext()) {
    var c = carpetas.next();
    var m = /^Respaldo (\d{4}-\d{2}-\d{2})$/.exec(c.getName());
    if (m && new Date(m[1] + 'T00:00:00Z').getTime() < limite) { c.setTrashed(true); borradas.push(c.getName()); }
  }
  return borradas;
}

/** El respaldo. Lo corre el disparador nocturno; también se puede correr a mano. */
function respaldarAhora() {
  var raiz = DriveApp.getFolderById(_propiedad('CARPETA_RESPALDO_ID'));
  var fecha = _fechaHoy();
  var carpetaDia = _carpetaDelDia(raiz, fecha);
  var copiadas = [], fallas = [];
  _hojasARespaldar().forEach(function (hoja) {
    try { copiadas.push(_copiarHoja(hoja, carpetaDia)); }
    catch (e) { fallas.push(hoja.nombre + ' (' + hoja.id + '): ' + (e && e.message ? e.message : e)); }
  });
  var dias = parseInt(_propiedadOpcional('DIAS_RETENCION'), 10) || DIAS_RETENCION_DEFECTO;
  // Solo se borran respaldos viejos si el de hoy salió completo: si algo
  // falla varios días seguidos, no se quiere perder además los anteriores.
  var borradas = fallas.length ? [] : _borrarRespaldosViejos(raiz, fecha, dias);
  console.log('Respaldo ' + fecha + ': ' + copiadas.length + ' hojas copiadas'
    + (borradas.length ? '; a la papelera: ' + borradas.join(', ') : '')
    + (fallas.length ? '; FALLARON ' + fallas.length + ': ' + fallas.join(' | ') : '') + '.');
  if (fallas.length) {
    var correo = _propiedadOpcional('CORREO_AVISO') || Session.getEffectiveUser().getEmail();
    MailApp.sendEmail(correo, 'SolucionAIRE: el respaldo del ' + fecha + ' quedó incompleto',
      'El respaldo nocturno no pudo copiar ' + fallas.length + ' de ' + (copiadas.length + fallas.length) + ' hojas:\n\n'
      + fallas.join('\n') + '\n\nSe copiaron bien ' + copiadas.length + '. Mientras esto siga, los respaldos de más de '
      + dias + ' días no se borran.\n\nCausa común: la cuenta del script ya no tiene acceso a esa hoja. '
      + 'Ábrela con esa cuenta o compártela con ella y corre respaldarAhora para comprobar.');
    throw new Error('Respaldo incompleto: ' + fallas.length + ' hoja(s) sin copiar. Ver el correo y el registro.');
  }
  return { fecha: fecha, copiadas: copiadas.length, borradas: borradas };
}

/** Programa el respaldo diario (2 a 3 a.m.). Si ya estaba, no lo duplica. */
function instalarRespaldoNocturno() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'respaldarAhora') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('respaldarAhora').timeBased().everyDays(1).atHour(2).create();
  console.log('Listo: el respaldo corre todos los días entre las 2 y las 3 a.m. (' + Session.getScriptTimeZone() + ').');
}

/** Revisa la configuración sin copiar nada: la carpeta y que cada hoja abra. */
function probarConfiguracion() {
  var raiz = DriveApp.getFolderById(_propiedad('CARPETA_RESPALDO_ID'));
  var problemas = [];
  var hojas = _hojasARespaldar();
  hojas.forEach(function (hoja) {
    try { DriveApp.getFileById(hoja.id).getName(); }
    catch (e) { problemas.push(hoja.nombre + ' (' + hoja.id + '): ' + (e && e.message ? e.message : e)); }
  });
  var programado = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'respaldarAhora'; });
  if (problemas.length) {
    console.log('Esta cuenta no puede abrir ' + problemas.length + ' hoja(s):\n' + problemas.join('\n'));
    return false;
  }
  console.log('Todo listo. Carpeta de respaldos: "' + raiz.getName() + '". Hojas: ' + hojas.length + '.'
    + (programado ? ' El respaldo nocturno está programado.' : ' Falta programarlo: ejecuta instalarRespaldoNocturno.'));
  return true;
}
