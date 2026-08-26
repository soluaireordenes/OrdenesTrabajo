/* ══════════════════════════════════════════════════════════════════════
   BOT DE WHATSAPP (SIN IA) — Sistema Integral de Gestión (SolucionAIRE)

   Un operario le escribe al WhatsApp de la empresa y consulta el
   inventario con palabras sencillas:

     filtro de aire          → existencias, mínimo y ubicación
     minimos                 → lo que hay que reponer
     movimientos FIL-001     → últimas entradas y salidas
     ayuda                   → qué se puede preguntar

   No llama a ningún servicio de inteligencia artificial, así que no
   cuesta nada de operación. A cambio, el operario escribe el nombre del
   producto o una de esas tres palabras, en vez de preguntar libremente.

   ⚠ ESTE ARCHIVO REEMPLAZA A Codigo.gs — no los pongas juntos en el mismo
   proyecto de Apps Script. Los dos definen doPost() y doGet(), así que si
   conviven se pisan entre ellos y el que quede de último manda.

   El stock se calcula con el MISMO método FIFO que usa la aplicación web
   (ver _agruparLotesFIFO en index.html), para que el número que da el bot
   sea exactamente el que se ve en pantalla.

   ── CÓMO SE INSTALA ──────────────────────────────────────────────────
   1. script.google.com → Proyecto nuevo → pega este archivo.
   2. Configuración del proyecto → Propiedades del script → agrega:
        TOKEN_WHATSAPP     el token permanente de la API de WhatsApp
        ID_NUMERO_WHATSAPP el "Phone number ID" del panel de Meta
        TOKEN_VERIFICACION una palabra que tú inventes (ej. solucionaire2026)
      Van ahí y NO en el código: el código se puede compartir, las claves no.
      (Esta versión NO necesita clave de Claude ni saldo de API.)
   3. Implementar → Nueva implementación → Aplicación web
        Ejecutar como: yo
        Quién tiene acceso: cualquier usuario
      Copia la URL que termina en /exec.
   4. En el panel de Meta → WhatsApp → Configuración → Webhooks:
        URL de devolución de llamada: la URL del paso 3
        Token de verificación: el mismo TOKEN_VERIFICACION del paso 2
        Suscríbete al campo "messages".
   5. Escríbele al número desde un celular que esté registrado como
      operario en el sistema.

   Antes de conectar nada, corre desde el editor las funciones de prueba
   del final: probarLectura, probarOperario y probarRespuestas.
   ═══════════════════════════════════════════════════════════════════ */


/* ── Dónde viven los datos ──
   Son las mismas hojas que usa la aplicación web. Si algún día cambia un
   ID allá, hay que cambiarlo aquí también. */
const HOJA_INVENTARIO = '1cqfk7gKRX4MfnHnPEZy7WGOunwT7kYLfJ14_W10Wh3s'; // Inventario Zipaquirá
const HOJA_SISTEMA    = '1_gIoYzZIZeURojSemB5vTtSQ1k4vw4_YfN-G6AjtaYU'; // Órdenes Zipaquirá (hoja "Operarios")

// Cuántos productos se listan cuando la búsqueda encuentra varios.
const MAX_COINCIDENCIAS = 8;


/* ══════════════════════════════════════════════
   ENTRADA: lo que Meta le manda a este script
══════════════════════════════════════════════ */

/** Meta llama esto UNA vez, al registrar el webhook, para comprobar que la
 *  URL es realmente tuya: manda un desafío y espera que se lo devuelvas. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p['hub.mode'] === 'subscribe' && p['hub.verify_token'] === _propiedad('TOKEN_VERIFICACION')) {
    return ContentService.createTextOutput(p['hub.challenge']);
  }
  return ContentService.createTextOutput('Token de verificación incorrecto.');
}

/** Cada mensaje entrante llega aquí.
 *
 *  Meta espera una respuesta rápida y, si no la recibe, REENVÍA el mismo
 *  mensaje. Como Apps Script no puede seguir trabajando después de
 *  contestar, la protección es acordarse de los mensajes ya atendidos por
 *  su id: si llega repetido, se ignora y el operario no recibe la misma
 *  respuesta dos veces. */
function doPost(e) {
  const ok = ContentService.createTextOutput('EVENT_RECEIVED');
  try {
    const cuerpo = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const mensaje = _extraerMensaje(cuerpo);
    if (!mensaje) return ok;                 // notificación que no es un mensaje de texto

    if (_yaSeAtendio(mensaje.id)) return ok; // reintento de Meta
    _marcarAtendido(mensaje.id);

    _atender(mensaje.de, mensaje.texto);
  } catch (err) {
    console.error('doPost:', err);
  }
  return ok;
}

/** Saca el mensaje de texto del sobre que manda Meta, que viene bastante
 *  anidado y trae también avisos de "entregado"/"leído" que no interesan. */
function _extraerMensaje(cuerpo) {
  try {
    const valor = cuerpo.entry[0].changes[0].value;
    const m = valor.messages && valor.messages[0];
    if (!m || m.type !== 'text') return null;
    return { id: m.id, de: m.from, texto: (m.text.body || '').trim() };
  } catch (_) {
    return null;
  }
}


/* ══════════════════════════════════════════════
   QUIÉN PREGUNTA
══════════════════════════════════════════════ */

/** Solo responde a números registrados como operarios en el sistema. Sin
 *  esto, cualquiera que dé con el número podría consultar el inventario de
 *  la empresa. Dar y quitar acceso es agregar o borrar al operario en
 *  Encargados Turnos → Operarios; aquí no hay nada que tocar.
 *
 *  Devuelve el nombre del operario, o null si el número no está. */
function _operarioDe(numero) {
  const soloDigitos = String(numero).replace(/\D/g, '');
  const filas = SpreadsheetApp.openById(HOJA_SISTEMA)
    .getSheetByName('Operarios').getDataRange().getValues();
  const encabezado = filas[0].map(c => String(c).trim());
  const iNombre = encabezado.indexOf('Nombre');
  const iNumero = encabezado.indexOf('Numero');
  if (iNombre < 0 || iNumero < 0) return null;

  for (let i = 1; i < filas.length; i++) {
    const registrado = String(filas[i][iNumero]).replace(/\D/g, '');
    if (!registrado) continue;
    // Comparar por el final: unos guardan el número con indicativo y otros
    // sin él, y WhatsApp siempre lo entrega con indicativo.
    if (soloDigitos.slice(-10) === registrado.slice(-10)) {
      return String(filas[i][iNombre]).trim() || 'Operario';
    }
  }
  return null;
}


/* ══════════════════════════════════════════════
   LECTURA DEL INVENTARIO

   Columnas, iguales a las de la aplicación web:
     Productos    A Código · B Nombre · C Unidad · D Grupo · E Stock Mínimo
                  F Fecha Creación · G Precio · H Tipo · I Ubicación · J Proveedor
     Movimientos  A Código · B Fecha · C Tipo · D Cantidad · E Usuario
                  F Timestamp · G Responsable · H Equipo Destino · I Observaciones
                  J Stock Resultante · K Precio · L TipoDocumento · M NumeroDocumento
══════════════════════════════════════════════ */

function _hojaInventario(nombre) {
  return SpreadsheetApp.openById(HOJA_INVENTARIO).getSheetByName(nombre);
}

function _productos() {
  const filas = _hojaInventario('Productos').getDataRange().getValues().slice(1);
  return filas.filter(f => f[0] && f[1]).map(f => ({
    codigo: String(f[0]).trim(),
    nombre: String(f[1]).trim(),
    unidad: String(f[2] || '').trim(),
    grupo: String(f[3] || '').trim(),
    stockMinimo: parseFloat(f[4]) || 0,
    ubicacion: String(f[8] || '').trim(),
    proveedor: String(f[9] || '').trim(),
  }));
}

function _movimientos() {
  return _hojaInventario('Movimientos').getDataRange().getValues().slice(1);
}

/** Existencias por código, con el MISMO FIFO de la aplicación web: cada
 *  ingreso abre un lote y cada salida va consumiendo los lotes más viejos
 *  primero. El stock es lo que queda sin consumir en todos los lotes.
 *  Debe dar exactamente el mismo número que se ve en pantalla. */
function _stockPorCodigo() {
  const porCodigo = {};
  _movimientos().forEach(f => {
    const codigo = String(f[0] || '').trim().toUpperCase();
    if (!codigo) return;
    (porCodigo[codigo] = porCodigo[codigo] || []).push({
      fecha: f[1] || '',
      tipo: String(f[2] || '').trim().toUpperCase(),
      cantidad: parseFloat(f[3]) || 0,
    });
  });

  const stock = {};
  Object.keys(porCodigo).forEach(codigo => {
    const movs = porCodigo[codigo].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    const lotes = [];
    movs.forEach(m => {
      if (m.tipo === 'INGRESO' || m.tipo === 'AJUSTE_POSITIVO') {
        lotes.push({ restante: m.cantidad });
      } else if (m.tipo === 'SALIDA' || m.tipo === 'AJUSTE_NEGATIVO') {
        let porConsumir = m.cantidad;
        for (let i = 0; i < lotes.length && porConsumir > 0; i++) {
          const consumido = Math.min(lotes[i].restante, porConsumir);
          lotes[i].restante -= consumido;
          porConsumir -= consumido;
        }
      }
    });
    const total = lotes.reduce((s, l) => s + l.restante, 0);
    stock[codigo] = Math.max(0, Math.round(total * 100) / 100);
  });
  return stock;
}

/* Palabras que la gente escribe alrededor de lo que de verdad busca:
   "cuánto queda de filtro de aire", "necesito filtro de aire", "filtro de
   aire hay?". Sin IA que interprete la frase, se descartan y queda solo lo
   que sirve para buscar. Quitarlas nunca hace perder resultados: la
   búsqueda exige que TODAS las palabras aparezcan, así que menos palabras
   es siempre igual o más permisivo. */
const PALABRAS_DE_RELLENO = [
  'cuanto', 'cuantos', 'cuanta', 'cuantas', 'queda', 'quedan', 'quedo',
  'hay', 'tenemos', 'tengo', 'tiene', 'necesito', 'busco', 'buscar',
  'stock', 'existencias', 'inventario', 'disponible', 'disponibles',
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'me', 'mi', 'por', 'para', 'favor', 'que', 'y', 'o', 'a', 'en',
];

/** Las palabras del mensaje que de verdad sirven para buscar. */
function _palabrasDeBusqueda(texto) {
  const todas = _normalizar(texto).split(/\s+/).filter(Boolean);
  const utiles = todas.filter(w => PALABRAS_DE_RELLENO.indexOf(w) === -1);
  // Si TODO era relleno ("cuánto hay"), es mejor buscar con lo que vino que
  // no buscar nada: al menos el operario ve que no se encontró y por qué.
  return utiles.length ? utiles : todas;
}

/** Busca por código o por nombre. Todas las palabras útiles del texto
 *  tienen que aparecer, en cualquier orden y sin importar tildes,
 *  mayúsculas ni signos: así "aire nx200" encuentra "Filtro de aire
 *  NX200", y "¿cuánto queda de filtro de aceite?" encuentra el de aceite. */
function _buscarProducto(texto) {
  const palabras = _palabrasDeBusqueda(texto);
  if (!palabras.length) return [];
  return _productos().filter(p => {
    const donde = _normalizar(p.codigo + ' ' + p.nombre + ' ' + p.grupo);
    return palabras.every(w => donde.indexOf(w) !== -1);
  });
}

function _bajoMinimo() {
  const stock = _stockPorCodigo();
  return _productos()
    .map(p => ({ producto: p, existencias: stock[p.codigo.toUpperCase()] || 0 }))
    .filter(x => x.producto.stockMinimo > 0 && x.existencias <= x.producto.stockMinimo)
    // Primero lo más urgente. Se compara qué TAN corto está cada uno frente
    // a su propio mínimo, no la diferencia en unidades: quedarse en 0 de 1
    // aprieta más que tener 2 de 3, aunque a los dos les falte lo mismo.
    .sort((a, b) => (a.existencias / a.producto.stockMinimo) - (b.existencias / b.producto.stockMinimo)
                 || (a.existencias - a.producto.stockMinimo) - (b.existencias - b.producto.stockMinimo));
}

function _ultimosMovimientos(codigo, cuantos) {
  const buscado = String(codigo || '').trim().toUpperCase();
  return _movimientos()
    .filter(f => String(f[0] || '').trim().toUpperCase() === buscado)
    .map(f => ({
      fecha: f[1],
      tipo: String(f[2] || '').trim(),
      cantidad: parseFloat(f[3]) || 0,
      responsable: String(f[6] || '').trim(),
      equipoDestino: String(f[7] || '').trim(),
    }))
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, cuantos || 5);
}


/* ══════════════════════════════════════════════
   INTERPRETAR LO QUE ESCRIBIÓ EL OPERARIO

   Sin IA, la regla tiene que ser simple y perdonar de más: si el mensaje
   no empieza por una palabra clave, se asume que es el nombre de un
   producto. Así, en el caso más común —querer saber cuánto queda de algo—
   el operario no tiene que aprenderse nada: escribe el nombre y ya.
══════════════════════════════════════════════ */

/** Minúsculas y sin tildes, para poder comparar sin que importe cómo se
 *  escribió. En un celular casi nadie pone las tildes. */
function _normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    // \u0300-\u036f son las tildes y diéresis, que normalize('NFD') separa
    // de su letra. Se escriben con el código y no con el carácter para que
    // el archivo sobreviva a copiar y pegar sin dañarse.
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // Signos fuera: nadie escribe "¿cuánto hay?" pensando en el bot, y los
    // signos nunca ayudan a encontrar nada.
    .replace(/[¿?¡!.,;:()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _interpretar(texto) {
  const t = _normalizar(texto);
  if (!t) return { comando: 'ayuda' };

  if (/^(ayuda|help|menu|hola|buenas|buenos dias|buenas tardes|buenas noches)$/.test(t)) {
    return { comando: 'ayuda' };
  }
  if (/^(minimos|minimo|reponer|bajo minimo|bajos|criticos|faltantes|que falta)$/.test(t)) {
    return { comando: 'minimos' };
  }
  const movs = t.match(/^(movimientos|movimiento|historial|ultimos)\s+(.+)$/);
  if (movs) return { comando: 'movimientos', texto: movs[2] };

  // Todo lo demás se toma como el nombre de un producto. El relleno
  // ("cuánto queda de…") lo descarta después _palabrasDeBusqueda, así que
  // aquí no hay que recortarle nada al texto.
  return { comando: 'stock', texto: texto.trim() };
}


/* ══════════════════════════════════════════════
   ARMAR LA RESPUESTA

   Texto plano, pensado para leerse en un celular. WhatsApp pone en negrita
   lo que va entre asteriscos, y eso es todo el formato que admite.
══════════════════════════════════════════════ */

function _responder(operario, texto) {
  const orden = _interpretar(texto);
  if (orden.comando === 'ayuda')       return _textoAyuda(operario);
  if (orden.comando === 'minimos')     return _textoMinimos();
  if (orden.comando === 'movimientos') return _textoMovimientos(orden.texto);
  return _textoStock(orden.texto);
}

function _textoAyuda(operario) {
  return 'Hola ' + operario + '. Puedo consultarte el inventario:\n\n'
    + '• Escribe el *nombre o el código* de un producto y te digo cuánto queda.\n'
    + '   Ejemplo: filtro de aire\n\n'
    + '• *minimos* — lo que está por debajo del mínimo y hay que reponer.\n\n'
    + '• *movimientos* seguido del producto — las últimas entradas y salidas.\n'
    + '   Ejemplo: movimientos filtro de aire\n\n'
    + 'Solo consulto. Para registrar entradas o salidas, usa el sistema.';
}

function _textoStock(texto) {
  const encontrados = _buscarProducto(texto);
  if (!encontrados.length) {
    return 'No encontré ningún producto con "' + texto + '".\n\n'
      + 'Prueba con menos palabras (por ejemplo solo "filtro"), '
      + 'o escribe *ayuda* para ver qué puedo consultar.';
  }

  const stock = _stockPorCodigo();
  const conStock = p => stock[p.codigo.toUpperCase()] || 0;

  if (encontrados.length === 1) {
    const p = encontrados[0];
    const cantidad = conStock(p);
    let msg = '*' + p.nombre + '* (' + p.codigo + ')\n'
      + 'Quedan ' + _numero(cantidad) + ' ' + p.unidad;
    if (p.stockMinimo > 0) msg += ' · mínimo ' + _numero(p.stockMinimo);
    if (p.stockMinimo > 0 && cantidad <= p.stockMinimo) {
      msg += '\n⚠ ' + (cantidad === 0 ? 'Agotado.' : 'Por debajo del mínimo.') + ' Hay que reponer.';
    }
    if (p.ubicacion) msg += '\nUbicación: ' + p.ubicacion;
    if (p.proveedor) msg += '\nProveedor: ' + p.proveedor;
    return msg;
  }

  const mostrados = encontrados.slice(0, MAX_COINCIDENCIAS);
  let msg = 'Encontré ' + encontrados.length + ' productos con "' + texto + '":\n\n'
    + mostrados.map(p => {
        const cantidad = conStock(p);
        const alerta = p.stockMinimo > 0 && cantidad <= p.stockMinimo ? ' ⚠' : '';
        return '• *' + p.nombre + '* (' + p.codigo + '): ' + _numero(cantidad) + ' ' + p.unidad + alerta;
      }).join('\n');
  if (encontrados.length > mostrados.length) {
    msg += '\n\n…y ' + (encontrados.length - mostrados.length) + ' más. Afina la búsqueda para verlos.';
  }
  msg += '\n\nPara el detalle de uno, escríbeme su código.';
  return msg;
}

function _textoMinimos() {
  const criticos = _bajoMinimo();
  if (!criticos.length) return 'Todo el inventario está por encima del mínimo. Nada por reponer.';

  const mostrados = criticos.slice(0, 20);
  let msg = criticos.length === 1
    ? 'Hay 1 producto por reponer:\n\n'
    : 'Hay ' + criticos.length + ' productos por reponer:\n\n';
  msg += mostrados.map(x =>
    '• *' + x.producto.nombre + '* (' + x.producto.codigo + '): '
    + _numero(x.existencias) + ' de ' + _numero(x.producto.stockMinimo) + ' ' + x.producto.unidad
    + (x.producto.proveedor ? ' — ' + x.producto.proveedor : '')
  ).join('\n');
  if (criticos.length > mostrados.length) {
    msg += '\n\n…y ' + (criticos.length - mostrados.length) + ' más.';
  }
  return msg;
}

function _textoMovimientos(texto) {
  const encontrados = _buscarProducto(texto);
  if (!encontrados.length) {
    return 'No encontré ningún producto con "' + texto + '".';
  }
  if (encontrados.length > 1) {
    return 'Hay ' + encontrados.length + ' productos con "' + texto + '". '
      + 'Dime cuál con su código:\n\n'
      + encontrados.slice(0, MAX_COINCIDENCIAS)
          .map(p => '• *' + p.nombre + '* (' + p.codigo + ')').join('\n');
  }

  const p = encontrados[0];
  const movs = _ultimosMovimientos(p.codigo, 5);
  if (!movs.length) return '*' + p.nombre + '* (' + p.codigo + ') no tiene movimientos registrados.';

  return 'Últimos movimientos de *' + p.nombre + '* (' + p.codigo + '):\n\n'
    + movs.map(m => {
        let linea = '• ' + _fecha(m.fecha) + ' ' + m.tipo + ' ' + _numero(m.cantidad) + ' ' + p.unidad;
        if (m.equipoDestino) linea += ' → ' + m.equipoDestino;
        if (m.responsable) linea += ' (' + m.responsable + ')';
        return linea;
      }).join('\n');
}

/** Sin decimales cuando no hacen falta: "4" se lee mejor que "4.0". */
function _numero(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return String(v);
}

function _fecha(valor) {
  if (valor instanceof Date) return Utilities.formatDate(valor, 'America/Bogota', 'dd/MM/yyyy');
  const t = String(valor || '').trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[3] + '/' + iso[2] + '/' + iso[1] : t;
}


/* ══════════════════════════════════════════════
   ATENDER UN MENSAJE, DE PRINCIPIO A FIN
══════════════════════════════════════════════ */

function _atender(numero, texto) {
  const operario = _operarioDe(numero);
  if (!operario) {
    // A un desconocido no se le confirma ni se le niega nada del inventario.
    _enviarWhatsApp(numero,
      'Este número no está registrado en el Sistema Integral de Gestión, así que no puedo '
      + 'darte información. Si trabajas en la planta, pídele al encargado que te registre '
      + 'como operario.');
    return;
  }

  let respuesta;
  try {
    respuesta = _responder(operario, texto);
  } catch (err) {
    console.error('_atender:', err);
    respuesta = 'Tuve un problema consultando el inventario. Vuelve a intentarlo en un momento.';
  }
  _enviarWhatsApp(numero, respuesta);
}


/* ══════════════════════════════════════════════
   SALIDA: mandar el mensaje de vuelta
══════════════════════════════════════════════ */

function _enviarWhatsApp(numero, texto) {
  const url = 'https://graph.facebook.com/v21.0/' + _propiedad('ID_NUMERO_WHATSAPP') + '/messages';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + _propiedad('TOKEN_WHATSAPP') },
    payload: JSON.stringify({
      messaging_product: 'whatsapp',
      to: numero,
      type: 'text',
      text: { body: texto.slice(0, 4000) },  // tope de WhatsApp: 4096 caracteres
    }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() >= 300) {
    console.error('No se pudo enviar el WhatsApp: ' + resp.getContentText());
  }
}


/* ══════════════════════════════════════════════
   AUXILIARES
══════════════════════════════════════════════ */

/** Las claves viven en las Propiedades del script, nunca en el código. */
function _propiedad(nombre) {
  const valor = PropertiesService.getScriptProperties().getProperty(nombre);
  if (!valor) throw new Error('Falta la propiedad "' + nombre + '" en Configuración del proyecto → Propiedades del script.');
  return valor;
}

function _yaSeAtendio(idMensaje) {
  return CacheService.getScriptCache().get('msg_' + idMensaje) !== null;
}

function _marcarAtendido(idMensaje) {
  CacheService.getScriptCache().put('msg_' + idMensaje, '1', 600); // 10 minutos
}


/* ══════════════════════════════════════════════
   PRUEBAS — para correr a mano desde el editor,
   antes de conectar el webhook de Meta
══════════════════════════════════════════════ */

/** Comprueba que el script llega a las dos hojas y que los datos se leen
 *  bien. Es lo primero que hay que correr: si esto falla, nada más va a
 *  funcionar. El resultado sale en el panel "Registro de ejecución" que se
 *  abre solo abajo del editor. */
function probarLectura() {
  const productos = _productos();
  const stock = _stockPorCodigo();
  console.log('Productos en el inventario: ' + productos.length);
  console.log('Productos con movimientos: ' + Object.keys(stock).length);
  productos.slice(0, 5).forEach(p => {
    console.log('  ' + p.codigo + ' — ' + p.nombre + ': '
      + (stock[p.codigo.toUpperCase()] || 0) + ' ' + p.unidad
      + ' (mínimo ' + p.stockMinimo + ')');
  });
  console.log('Productos bajo el mínimo: ' + _bajoMinimo().length);
}

/** Comprueba que un número queda reconocido como operario. Cambia el
 *  número por uno que esté registrado en el sistema. */
function probarOperario() {
  const numero = '573001234567';
  console.log(numero + ' → ' + (_operarioDe(numero) || 'NO está registrado'));
}

/** Escribe en el registro las respuestas EXACTAS que daría el bot a varias
 *  preguntas, sin pasar por WhatsApp. Cambia los textos por productos que
 *  existan en tu inventario y revisa cómo se leen. */
function probarRespuestas() {
  const pruebas = ['ayuda', 'filtro', 'minimos', 'movimientos filtro de aire', 'asdfgh'];
  pruebas.forEach(t => {
    console.log('════════════════════════════════');
    console.log('El operario escribe: ' + t);
    console.log('--------------------------------');
    console.log(_responder('Alex Prieto', t));
  });
}
