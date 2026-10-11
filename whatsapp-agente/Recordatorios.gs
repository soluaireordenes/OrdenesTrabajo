/* ══════════════════════════════════════════════════════════════════════
   RECORDATORIOS DE TURNO — bot de WhatsApp (SolucionAIRE)

   Al empezar cada turno, el bot le escribe a cada encargado de ese turno
   con las actividades que el cronograma tiene programadas para ese día.
   Además agrega la palabra ACTIVIDADES al bot: el encargado la escribe
   cuando quiera y ve su lista, con lo que ya está marcado (✅) y lo que
   falta (⬜).

   De dónde sale cada cosa (hojas del libro de Zipaquirá):
     CronogramaPlan   lo que hay programado por turno y día. Lo publica la
                      aplicación sola cada vez que alguien la abre; aquí no
                      se toca.
     Operarios        los encargados: Nombre, Numero, Turno, Activo. Se
                      administra en la aplicación → Reportes → Encargados de
                      turno (solo admin). Solo se le escribe a quien tenga
                      turno y el recordatorio activo (Activo = SI).
     CronogramaRegistros y CronogramaActividadesAdicionales
                      lo marcado y lo agregado durante el turno (para la
                      respuesta a ACTIVIDADES).

   ── LA REGLA DE WHATSAPP QUE MANDA AQUÍ ─────────────────────────────
   WhatsApp solo deja escribirle a alguien con texto libre si esa persona
   le escribió al número en las últimas 24 horas. Fuera de esa ventana,
   solo se puede mandar una PLANTILLA aprobada por Meta (tiene un costo
   pequeño por mensaje). Por eso:
     • Si el encargado le escribió al bot hace menos de 24 h → le llega la
       lista completa de actividades, gratis.
     • Si no → le llega la plantilla corta ("tienes N actividades"). Al
       tocar el botón "Ver actividades" (o escribir ACTIVIDADES) el bot le
       responde con la lista completa, y queda abierta la ventana para el
       día siguiente.

   ── CÓMO SE INSTALA ──────────────────────────────────────────────────
   1. En Meta → WhatsApp Manager → Plantillas de mensajes → Crear plantilla:
        Categoría: Utilidad
        Nombre:    recordatorio_turno
        Idioma:    Español
        Cuerpo:    Hola {{1}}, empieza tu {{2}}. Tienes {{3}} actividades
                   programadas para hoy. Toca el botón para verlas.
        Botón:     Respuesta rápida → "Ver actividades"
      Ejemplos para la revisión: {{1}} Juan, {{2}} Turno 1 (06:00 – 14:00),
      {{3}} 6. Espera a que quede "Aprobada" (suele tardar minutos).
   2. En este mismo proyecto de Apps Script (donde está Codigo-sin-ia.gs):
      Archivo + → Secuencia de comandos → nómbralo Recordatorios → pega
      este archivo.
   3. Pega también la versión nueva de Codigo-sin-ia.gs (trae la palabra
      ACTIVIDADES y el botón de la plantilla) y publícala:
      Implementar → Gestionar implementaciones → lápiz → Versión: Nueva
      versión → Implementar. La URL no cambia.
   4. Corre probarRecordatorio: muestra en el registro, SIN enviar nada, qué
      le llegaría a cada encargado.
   5. Corre instalarRecordatorios UNA vez (pide permisos la primera vez).
      Desde ahí revisa solo cada 10 minutos; el mensaje llega entre 5 y 15
      minutos antes de que empiece cada turno.

   Propiedades del script (opcionales, las demás ya existen):
     PLANTILLA_RECORDATORIO  nombre de la plantilla (por defecto
                             recordatorio_turno)
     IDIOMA_PLANTILLA        código de idioma de la plantilla (por
                             defecto es)

   Este archivo no depende de las funciones de Codigo-sin-ia.gs: todo lo
   suyo empieza por rec_ / REC_, para que no choque con nada del proyecto.
   ═══════════════════════════════════════════════════════════════════ */


const REC_HOJA = '1_gIoYzZIZeURojSemB5vTtSQ1k4vw4_YfN-G6AjtaYU'; // Órdenes Zipaquirá
const REC_ZONA = 'America/Bogota';
const REC_DESFASE = '-05:00';   // Colombia no tiene horario de verano
const REC_DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const REC_DIAS_LABEL = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves',
                         viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo' };

// Ventana para mandar el recordatorio, alrededor de la hora de inicio. Con
// el disparador cada 10 minutos, el mensaje sale entre 5 y 15 minutos
// antes; los 45 minutos de después cubren una ejecución que Google atrase
// o que falle, sin llegar tan tarde que ya no sirva.
const REC_MIN_ANTES = 15;
const REC_MIN_DESPUES = 45;
// Un poco menos de 24 h, por si el reloj de Meta y el de Google no coinciden.
const REC_VENTANA_LIBRE_MS = 23.5 * 3600 * 1000;
// Una actividad del cronograma puede traer un procedimiento entero; en el
// celular se corta y el detalle completo está en la aplicación.
const REC_MAX_CARACTERES_ACTIVIDAD = 280;


/* ══════════════════════════════════════════════
   DISPARADOR: corre solo cada 10 minutos
══════════════════════════════════════════════ */

function recordatoriosTurno() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;   // ya hay otra ejecución enviando
  try {
    const ahora = new Date();
    const plan = rec_plan();
    if (!plan.length) {
      console.warn('CronogramaPlan está vacía: abre la aplicación una vez para que la publique.');
      return;
    }
    rec_turnosDelPlan(plan).forEach(turno => {
      const vez = rec_vezPorEmpezar(turno, ahora);
      if (vez) rec_enviarRecordatoriosDeTurno(turno, vez, plan);
    });
    rec_borrarMarcasViejas();
  } finally {
    lock.releaseLock();
  }
}

/** Si el turno está por empezar (o acaba de empezar), la vez que toca
 *  recordar; si no, null. */
function rec_vezPorEmpezar(turno, ahora) {
  for (const vez of rec_vecesDelTurno(turno, ahora)) {
    const desde = vez.inicio.getTime() - REC_MIN_ANTES * 60000;
    const hasta = vez.inicio.getTime() + REC_MIN_DESPUES * 60000;
    if (ahora.getTime() >= desde && ahora.getTime() < hasta) return vez;
  }
  return null;
}

function rec_enviarRecordatoriosDeTurno(turno, vez, plan) {
  const actividades = rec_actividadesProgramadas(plan, turno.id, vez.dia);
  if (!actividades.length) return;   // nada programado: no se molesta a nadie
  const encargados = rec_encargados().filter(e => e.activo && e.turnoId === turno.id && e.numero);
  if (!encargados.length) return;

  const props = PropertiesService.getScriptProperties();
  encargados.forEach(e => {
    // Una marca por persona, turno y fecha: si una ejecución se cae a mitad
    // de camino, la siguiente no le repite el mensaje a quien ya lo recibió.
    const marca = 'REC_ENVIADO_' + vez.fecha + '_' + turno.id + '_' + e.numero;
    if (props.getProperty(marca)) return;
    const ok = rec_enviarRecordatorio(e, turno, vez, actividades);
    if (ok) props.setProperty(marca, new Date().toISOString());
  });
}

/** Lista completa si la ventana de 24 h está abierta; plantilla si no.
 *  Devuelve true si Meta aceptó el envío. */
function rec_enviarRecordatorio(encargado, turno, vez, actividades) {
  const ultimo = Number(PropertiesService.getScriptProperties()
    .getProperty('REC_ULTIMO_' + encargado.numero.slice(-10)) || 0);
  const ventanaAbierta = Date.now() - ultimo < REC_VENTANA_LIBRE_MS;

  if (ventanaAbierta) {
    const texto = 'Hola ' + rec_primerNombre(encargado.nombre) + ', empieza tu *'
      + rec_textoTurno(turno) + '*.\n\n'
      + rec_textoLista(turno, vez, actividades, {}, [])
      + '\n\nMárcalas en el sistema a medida que las hagas.';
    return rec_enviarTexto(encargado.numero, texto);
  }
  return rec_enviarPlantilla(encargado.numero, [
    rec_primerNombre(encargado.nombre),
    rec_textoTurno(turno),
    String(actividades.length),
  ]);
}


/* ══════════════════════════════════════════════
   PALABRA "ACTIVIDADES" (la llama Codigo-sin-ia.gs)
══════════════════════════════════════════════ */

/** Lo que tiene programado el encargado en su turno (el que está en curso
 *  o, si todavía no empieza, el próximo), con lo que ya está marcado. */
function rec_textoActividades(numero) {
  const plan = rec_plan();
  const turnos = rec_turnosDelPlan(plan);
  if (!turnos.length) {
    return 'Todavía no tengo el cronograma. Pídele a alguien que abra el sistema una vez y vuelve a intentar.';
  }
  const ahora = new Date();
  const digitos = String(numero || '').replace(/\D/g, '').slice(-10);
  const encargado = rec_encargados().find(e => digitos && e.numero.slice(-10) === digitos);

  let turno = encargado && turnos.find(t => t.id === encargado.turnoId);
  let aviso = '';
  if (!turno) {
    // Sin turno asignado: el que esté en curso ahora mismo.
    turno = turnos.find(t => rec_vecesDelTurno(t, ahora).some(v => ahora >= v.inicio && ahora < v.fin)) || turnos[0];
    aviso = 'No tienes un turno asignado en el sistema, así que te muestro el turno en curso.\n\n';
  }
  const vez = rec_vezActualOProxima(turno, ahora);
  const actividades = rec_actividadesProgramadas(plan, turno.id, vez.dia);
  const hechas = rec_estadoDelDia(vez.fecha);
  const adicionales = rec_adicionales(vez.fecha, turno.id);

  return aviso + '*' + rec_textoTurno(turno) + '*\n' + rec_textoLista(turno, vez, actividades, hechas, adicionales);
}

function rec_textoLista(turno, vez, actividades, hechas, adicionales) {
  let msg = REC_DIAS_LABEL[vez.dia] + ' ' + rec_fechaCorta(vez.fecha);
  if (!actividades.length && !adicionales.length) return msg + '\n\nNo hay actividades programadas.';

  const marcadas = actividades.concat(adicionales).filter(a => hechas[a.id]).length;
  if (Object.keys(hechas).length) {
    msg += ' · ' + marcadas + ' de ' + (actividades.length + adicionales.length) + ' hechas';
  }
  let horaActual = null;
  actividades.forEach(a => {
    if (a.hora !== horaActual) { horaActual = a.hora; msg += '\n\n*' + a.hora + '*'; }
    msg += '\n' + (hechas[a.id] ? '✅ ' : '⬜ ') + rec_cortar(a.texto);
  });
  if (adicionales.length) {
    msg += '\n\n*Adicionales*';
    adicionales.forEach(a => { msg += '\n' + (hechas[a.id] ? '✅ ' : '⬜ ') + rec_cortar(a.texto); });
  }
  return msg;
}


/* ══════════════════════════════════════════════
   LECTURA DE LAS HOJAS
══════════════════════════════════════════════ */

function rec_objetosDe(nombreHoja) {
  const hoja = SpreadsheetApp.openById(REC_HOJA).getSheetByName(nombreHoja);
  if (!hoja) return [];
  const valores = hoja.getDataRange().getValues();
  const encabezado = (valores[0] || []).map(c => String(c).trim());
  return valores.slice(1).map(fila => {
    const o = {};
    encabezado.forEach((nombre, i) => { if (nombre) o[nombre] = fila[i]; });
    return o;
  });
}

/** El plan cambia solo cuando cambia el cronograma, así que se guarda una
 *  hora en la caché: el disparador corre 144 veces al día y no tiene que
 *  leer la hoja en cada una. */
function rec_plan() {
  const cache = CacheService.getScriptCache();
  const guardado = cache.get('REC_PLAN');
  if (guardado) return JSON.parse(guardado);
  const plan = rec_objetosDe('CronogramaPlan')
    .filter(f => String(f.TurnoId || '').trim() && String(f.Dia || '').trim())
    .map(f => ({
      turnoId: String(f.TurnoId).trim(),
      turnoNombre: String(f.TurnoNombre || f.TurnoId).trim(),
      horaInicio: rec_hora(f.HoraInicio),
      horaFin: rec_hora(f.HoraFin),
      dia: String(f.Dia).trim(),
      orden: Number(f.Orden) || 0,
      hora: rec_hora(f.Hora),
      id: String(f.ActividadId || '').trim(),
      texto: String(f.Actividad || '').trim(),
    }));
  const json = JSON.stringify(plan);
  if (json.length < 90000) cache.put('REC_PLAN', json, 3600);   // tope de la caché: 100 KB
  return plan;
}

function rec_turnosDelPlan(plan) {
  const turnos = [];
  plan.forEach(f => {
    if (turnos.some(t => t.id === f.turnoId)) return;
    turnos.push({ id: f.turnoId, nombre: f.turnoNombre, horaInicio: f.horaInicio, horaFin: f.horaFin });
  });
  return turnos;
}

function rec_actividadesProgramadas(plan, turnoId, dia) {
  return plan.filter(f => f.turnoId === turnoId && f.dia === dia).sort((a, b) => a.orden - b.orden);
}

function rec_encargados() {
  return rec_objetosDe('Operarios').map(o => ({
    nombre: String(o.Nombre || '').trim() || 'compañero',
    numero: rec_numeroWhatsApp(o.Numero),
    turnoId: rec_turnoId(o.Turno),
    activo: String(o.Activo || '').trim().toUpperCase() === 'SI',
  }));
}

/** Último estado de cada actividad en una fecha: la hoja es un registro de
 *  marcar/desmarcar que solo crece, así que manda la última fila. */
function rec_estadoDelDia(fechaIso) {
  const hechas = {};
  rec_objetosDe('CronogramaRegistros').forEach(r => {
    if (rec_aIso(r.Fecha) !== fechaIso) return;
    const id = String(r.ActividadId || '').trim();
    if (id) hechas[id] = String(r.Realizado || '').trim().toUpperCase() === 'SI';
  });
  Object.keys(hechas).forEach(id => { if (!hechas[id]) delete hechas[id]; });
  return hechas;
}

function rec_adicionales(fechaIso, turnoId) {
  return rec_objetosDe('CronogramaActividadesAdicionales')
    .filter(a => rec_aIso(a.Fecha) === fechaIso && String(a.TurnoId || '').trim() === turnoId)
    .map(a => ({ id: String(a.ActividadId || '').trim(), texto: String(a.Descripcion || '').trim() }))
    .filter(a => a.id);
}


/* ══════════════════════════════════════════════
   FECHAS Y TURNOS

   Un turno que cruza la medianoche (Turno 3: 22:00 → 06:00) pertenece a
   la fecha en que EMPEZÓ, igual que en la aplicación.
══════════════════════════════════════════════ */

function rec_instante(fechaIso, hora) {
  return new Date(fechaIso + 'T' + hora + ':00' + REC_DESFASE);
}

function rec_fechaIso(fecha) {
  return Utilities.formatDate(fecha, REC_ZONA, 'yyyy-MM-dd');
}

function rec_sumarDias(fechaIso, n) {
  return rec_fechaIso(new Date(rec_instante(fechaIso, '12:00').getTime() + n * 86400000));
}

function rec_diaSemana(fechaIso) {
  // 'u' = día de la semana con lunes = 1 … domingo = 7.
  return REC_DIAS[Number(Utilities.formatDate(rec_instante(fechaIso, '12:00'), REC_ZONA, 'u')) - 1];
}

function rec_minutos(hora) {
  const p = String(hora).split(':').map(Number);
  return p[0] * 60 + (p[1] || 0);
}

/** Las veces del turno que empiezan ayer, hoy y mañana, con su fin. */
function rec_vecesDelTurno(turno, ahora) {
  const hoy = rec_fechaIso(ahora);
  let duracion = rec_minutos(turno.horaFin) - rec_minutos(turno.horaInicio);
  if (duracion <= 0) duracion += 24 * 60;
  return [-1, 0, 1].map(n => {
    const fecha = rec_sumarDias(hoy, n);
    const inicio = rec_instante(fecha, turno.horaInicio);
    return { fecha: fecha, dia: rec_diaSemana(fecha), inicio: inicio,
             fin: new Date(inicio.getTime() + duracion * 60000) };
  });
}

/** La vez del turno que está en curso o, si ninguna lo está, la próxima. */
function rec_vezActualOProxima(turno, ahora) {
  const veces = rec_vecesDelTurno(turno, ahora);
  return veces.find(v => ahora >= v.inicio && ahora < v.fin)
      || veces.find(v => v.inicio > ahora)
      || veces[1];
}


/* ══════════════════════════════════════════════
   ENVÍO
══════════════════════════════════════════════ */

function rec_enviarTexto(numero, texto) {
  return rec_enviar({
    messaging_product: 'whatsapp', to: numero, type: 'text',
    text: { body: texto.slice(0, 4000) },   // tope de WhatsApp: 4096 caracteres
  });
}

function rec_enviarPlantilla(numero, parametros) {
  const props = PropertiesService.getScriptProperties();
  return rec_enviar({
    messaging_product: 'whatsapp', to: numero, type: 'template',
    template: {
      name: props.getProperty('PLANTILLA_RECORDATORIO') || 'recordatorio_turno',
      language: { code: props.getProperty('IDIOMA_PLANTILLA') || 'es' },
      components: [{
        type: 'body',
        // Meta rechaza parámetros con saltos de línea o muchos espacios.
        parameters: parametros.map(p => ({ type: 'text', text: String(p).replace(/\s+/g, ' ').trim() || '-' })),
      }],
    },
  });
}

function rec_enviar(cuerpo) {
  const props = PropertiesService.getScriptProperties();
  const idNumero = props.getProperty('ID_NUMERO_WHATSAPP');
  const token = props.getProperty('TOKEN_WHATSAPP');
  if (!idNumero || !token) {
    console.error('Faltan TOKEN_WHATSAPP o ID_NUMERO_WHATSAPP en las propiedades del script.');
    return false;
  }
  const resp = UrlFetchApp.fetch('https://graph.facebook.com/v21.0/' + idNumero + '/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(cuerpo),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() >= 300) {
    console.error('Recordatorio a ' + cuerpo.to + ' (' + cuerpo.type + ') rechazado: ' + resp.getContentText());
    return false;
  }
  console.log('Recordatorio enviado a ' + cuerpo.to + ' (' + cuerpo.type + ').');
  return true;
}

/** Codigo-sin-ia.gs llama esto con cada mensaje que llega, para saber si la
 *  ventana de 24 h de esa persona está abierta. */
function rec_registrarMensajeEntrante(numero) {
  const digitos = String(numero || '').replace(/\D/g, '').slice(-10);
  if (!digitos) return;
  PropertiesService.getScriptProperties().setProperty('REC_ULTIMO_' + digitos, String(Date.now()));
}

/** Las marcas de "ya enviado" solo sirven el mismo día; se borran a los 3
 *  días para no llenar las propiedades del script (tienen tope). */
function rec_borrarMarcasViejas() {
  const props = PropertiesService.getScriptProperties();
  const limite = rec_sumarDias(rec_fechaIso(new Date()), -3);
  Object.keys(props.getProperties()).forEach(clave => {
    const m = clave.match(/^REC_ENVIADO_(\d{4}-\d{2}-\d{2})_/);
    if (m && m[1] < limite) props.deleteProperty(clave);
  });
}


/* ══════════════════════════════════════════════
   AUXILIARES
══════════════════════════════════════════════ */

/** Igual que en la aplicación: la hoja puede traer el turno viejo (Mañana /
 *  Tarde / Noche) o el nombre ("Turno 1"); todo se lleva al id. */
function rec_turnoId(valor) {
  const t = String(valor || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t) return '';
  const viejo = { manana: 'turno1', tarde: 'turno2', noche: 'turno3' }[t];
  if (viejo) return viejo;
  const m = t.match(/^turno\s*(\d+)$/);
  return m ? 'turno' + m[1] : t;
}

/** Solo dígitos y con indicativo; un celular colombiano de 10 dígitos
 *  lleva 57 delante. '' si no parece un número de WhatsApp. */
function rec_numeroWhatsApp(valor) {
  let d = String(valor || '').replace(/\D/g, '');
  if (d.length === 10 && d.charAt(0) === '3') d = '57' + d;
  return d.length >= 11 && d.length <= 15 ? d : '';
}

/** Sheets devuelve una hora escrita como texto ("06:00") tal cual, pero si
 *  alguien la convirtió en hora de verdad llega como fecha. */
function rec_hora(valor) {
  if (valor instanceof Date) return Utilities.formatDate(valor, REC_ZONA, 'HH:mm');
  const m = String(valor || '').trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : String(valor || '').trim();
}

function rec_aIso(valor) {
  if (valor instanceof Date) return Utilities.formatDate(valor, REC_ZONA, 'yyyy-MM-dd');
  const t = String(valor || '').trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const dmy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return dmy[3] + '-' + ('0' + dmy[2]).slice(-2) + '-' + ('0' + dmy[1]).slice(-2);
  return t;
}

function rec_fechaCorta(fechaIso) {
  const p = fechaIso.split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}

function rec_textoTurno(turno) {
  return turno.nombre + ' (' + turno.horaInicio + ' – ' + turno.horaFin + ')';
}

function rec_primerNombre(nombre) {
  return String(nombre || '').trim().split(/\s+/)[0] || 'compañero';
}

function rec_cortar(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > REC_MAX_CARACTERES_ACTIVIDAD ? t.slice(0, REC_MAX_CARACTERES_ACTIVIDAD - 1).trim() + '…' : t;
}


/* ══════════════════════════════════════════════
   INSTALAR Y PROBAR — para correr a mano desde el editor
══════════════════════════════════════════════ */

/** Crea el disparador que revisa cada 10 minutos. Se puede correr otra vez
 *  sin miedo: borra el anterior antes de crear el nuevo. */
function instalarRecordatorios() {
  desinstalarRecordatorios();
  ScriptApp.newTrigger('recordatoriosTurno').timeBased().everyMinutes(10).create();
  console.log('Listo: los recordatorios de turno quedaron activos (revisión cada 10 minutos).');
}

/** Apaga los recordatorios (el resto del bot sigue funcionando). */
function desinstalarRecordatorios() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'recordatoriosTurno')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Muestra en el registro, SIN ENVIAR NADA, qué le llegaría hoy a cada
 *  encargado de cada turno y si iría como lista o como plantilla. */
function probarRecordatorio() {
  CacheService.getScriptCache().remove('REC_PLAN');
  const plan = rec_plan();
  console.log('Filas en CronogramaPlan: ' + plan.length);
  const encargados = rec_encargados();
  console.log('Encargados en Operarios: ' + encargados.length);
  encargados.forEach(e => {
    let problema = '';
    if (!e.numero) problema = ' ← número no válido, no le llega nada';
    else if (!e.turnoId) problema = ' ← sin turno, no recibe recordatorio';
    else if (!e.activo) problema = ' ← recordatorio apagado';
    console.log('  ' + e.nombre + ' · ' + (e.numero || '¿?') + ' · ' + (e.turnoId || 'sin turno') + problema);
  });

  const ahora = new Date();
  const props = PropertiesService.getScriptProperties();
  rec_turnosDelPlan(plan).forEach(turno => {
    const vez = rec_vezActualOProxima(turno, ahora);
    const actividades = rec_actividadesProgramadas(plan, turno.id, vez.dia);
    console.log('════════════════════════════════');
    console.log(rec_textoTurno(turno) + ' · ' + REC_DIAS_LABEL[vez.dia] + ' ' + rec_fechaCorta(vez.fecha)
      + ' · ' + actividades.length + ' actividades');
    encargados.filter(e => e.activo && e.turnoId === turno.id && e.numero).forEach(e => {
      const ultimo = Number(props.getProperty('REC_ULTIMO_' + e.numero.slice(-10)) || 0);
      const comoLista = Date.now() - ultimo < REC_VENTANA_LIBRE_MS;
      console.log('→ ' + e.nombre + ': ' + (comoLista ? 'lista completa (ventana abierta)' : 'plantilla'));
    });
    console.log(rec_textoLista(turno, vez, actividades, {}, []));
  });
}

/** Manda la plantilla de verdad a un número, para comprobar que Meta ya la
 *  aprobó y que llega bien. Cambia el número por el tuyo. */
function probarPlantilla() {
  const miNumero = '573001234567';   // ← TU número, con indicativo y sin signos
  const ok = rec_enviarPlantilla(miNumero, ['Prueba', 'Turno 1 (06:00 – 14:00)', '6']);
  console.log(ok ? 'Meta aceptó la plantilla: revisa tu WhatsApp.' : 'Meta la rechazó: el motivo está arriba en el registro.');
}
