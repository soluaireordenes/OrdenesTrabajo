/* ══════════════════════════════════════════════════════════════════════
   AGENTE DE WHATSAPP — Sistema Integral de Gestión (SolucionAIRE)

   Un operario le escribe al WhatsApp de la empresa y pregunta en lenguaje
   normal por el inventario:

     "¿cuánto filtro de aire nos queda?"
     "¿qué está por debajo del mínimo?"
     "¿dónde están guardados los filtros de aceite?"

   Este script recibe el mensaje, verifica que el número esté registrado
   como operario, le pasa la pregunta a Claude junto con las herramientas
   que puede usar, ejecuta contra Google Sheets la que Claude escoja, y
   devuelve la respuesta por WhatsApp.

   El stock se calcula con el MISMO método FIFO que usa la aplicación web
   (ver _agruparLotesFIFO en index.html), para que el número que da el bot
   sea exactamente el que se ve en pantalla.

   ── CÓMO SE INSTALA ──────────────────────────────────────────────────
   1. script.google.com → Proyecto nuevo → pega este archivo.
   2. Configuración del proyecto → Propiedades del script → agrega:
        CLAVE_CLAUDE       la clave de console.anthropic.com
        TOKEN_WHATSAPP     el token permanente de la API de WhatsApp
        ID_NUMERO_WHATSAPP el "Phone number ID" del panel de Meta
        TOKEN_VERIFICACION una palabra que tú inventes (ej. solucionaire2026)
      Van ahí y NO en el código: el código se puede compartir, las claves no.
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
   ═══════════════════════════════════════════════════════════════════ */


/* ── Dónde viven los datos ──
   Son las mismas hojas que usa la aplicación web. Si algún día cambia un
   ID allá, hay que cambiarlo aquí también. */
const HOJA_INVENTARIO = '1cqfk7gKRX4MfnHnPEZy7WGOunwT7kYLfJ14_W10Wh3s'; // Inventario Zipaquirá
const HOJA_SISTEMA    = '1_gIoYzZIZeURojSemB5vTtSQ1k4vw4_YfN-G6AjtaYU'; // Órdenes Zipaquirá (hoja "Operarios")

const MODELO_CLAUDE = 'claude-sonnet-5';

// Cuántos mensajes atrás recuerda la conversación de cada operario. Sin
// esto no se podría preguntar "¿y dónde está?" después de "¿cuánto queda
// de X?" — el bot no sabría de qué se está hablando.
const MENSAJES_DE_MEMORIA = 10;


/* ══════════════════════════════════════════════
   ENTRADA: lo que Meta le manda a este script
══════════════════════════════════════════════ */

/** Meta llama esto UNA vez, al registrar el webhook, para comprobar que la
 *  URL es realmente tuya: manda un desafío y espera que se lo devuelvas. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const esperado = _propiedad('TOKEN_VERIFICACION');
  if (p['hub.mode'] === 'subscribe' && p['hub.verify_token'] === esperado) {
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
   LAS HERRAMIENTAS QUE PUEDE USAR EL AGENTE
══════════════════════════════════════════════ */

const HERRAMIENTAS = [
  {
    name: 'buscar_producto',
    description: 'Busca productos del inventario por nombre o código, aunque el texto '
      + 'venga incompleto o con errores de tipeo. Úsala cuando no estés seguro del '
      + 'código exacto, antes de consultar el stock. Devuelve código, nombre, unidad, '
      + 'grupo, ubicación y proveedor de cada coincidencia.',
    input_schema: {
      type: 'object',
      properties: { texto: { type: 'string', description: 'Parte del nombre o del código a buscar.' } },
      required: ['texto'],
    },
  },
  {
    name: 'consultar_stock',
    description: 'Devuelve las existencias actuales de un producto, su stock mínimo, '
      + 'su unidad y dónde está guardado. Recibe el código exacto del producto.',
    input_schema: {
      type: 'object',
      properties: { codigo: { type: 'string', description: 'Código exacto del producto.' } },
      required: ['codigo'],
    },
  },
  {
    name: 'productos_bajo_minimo',
    description: 'Lista los productos cuyas existencias están en o por debajo de su '
      + 'stock mínimo, es decir, los que hay que reponer. No recibe parámetros.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ultimos_movimientos',
    description: 'Devuelve los últimos movimientos (entradas y salidas) de un producto, '
      + 'con fecha, tipo, cantidad, quién lo movió y a qué equipo se destinó. Sirve para '
      + 'responder cuándo entró algo o en qué se gastó.',
    input_schema: {
      type: 'object',
      properties: {
        codigo: { type: 'string', description: 'Código exacto del producto.' },
        cuantos: { type: 'integer', description: 'Cuántos movimientos traer (por defecto 5).' },
      },
      required: ['codigo'],
    },
  },
];

/** Ejecuta la herramienta que pidió Claude y devuelve el resultado como
 *  texto. Nunca lanza: si algo falla, el error viaja como respuesta para
 *  que el agente pueda explicárselo al operario en vez de quedarse mudo. */
function _ejecutarHerramienta(nombre, args) {
  try {
    if (nombre === 'buscar_producto')      return JSON.stringify(_buscarProducto(args.texto));
    if (nombre === 'consultar_stock')      return JSON.stringify(_consultarStock(args.codigo));
    if (nombre === 'productos_bajo_minimo') return JSON.stringify(_bajoMinimo());
    if (nombre === 'ultimos_movimientos')  return JSON.stringify(_ultimosMovimientos(args.codigo, args.cuantos));
    return 'No existe una herramienta llamada ' + nombre;
  } catch (err) {
    console.error('Herramienta ' + nombre + ':', err);
    return 'Error consultando los datos: ' + err.message;
  }
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

function _buscarProducto(texto) {
  const q = String(texto || '').trim().toLowerCase();
  if (!q) return { encontrados: [] };
  // Todas las palabras del texto tienen que aparecer, en cualquier orden:
  // así "filtro nx200" encuentra "Filtro de aire NX200".
  const palabras = q.split(/\s+/);
  const encontrados = _productos().filter(p => {
    const donde = (p.codigo + ' ' + p.nombre + ' ' + p.grupo).toLowerCase();
    return palabras.every(w => donde.indexOf(w) !== -1);
  });
  return {
    encontrados: encontrados.slice(0, 15),
    hayMas: Math.max(0, encontrados.length - 15),
  };
}

function _consultarStock(codigo) {
  const buscado = String(codigo || '').trim().toUpperCase();
  const producto = _productos().filter(p => p.codigo.toUpperCase() === buscado)[0];
  if (!producto) return { error: 'No existe ningún producto con el código ' + codigo + '.' };
  const cantidad = _stockPorCodigo()[buscado] || 0;
  return {
    codigo: producto.codigo,
    nombre: producto.nombre,
    existencias: cantidad,
    unidad: producto.unidad,
    stockMinimo: producto.stockMinimo,
    porDebajoDelMinimo: producto.stockMinimo > 0 && cantidad <= producto.stockMinimo,
    ubicacion: producto.ubicacion,
    proveedor: producto.proveedor,
  };
}

function _bajoMinimo() {
  const stock = _stockPorCodigo();
  const criticos = _productos()
    .map(p => ({
      codigo: p.codigo, nombre: p.nombre, unidad: p.unidad,
      existencias: stock[p.codigo.toUpperCase()] || 0,
      stockMinimo: p.stockMinimo, proveedor: p.proveedor,
    }))
    .filter(p => p.stockMinimo > 0 && p.existencias <= p.stockMinimo)
    // Primero lo más urgente. Se compara qué TAN corto está cada uno frente
    // a su propio mínimo, no la diferencia en unidades: quedarse en 0 de 1
    // aprieta más que tener 2 de 3, aunque a los dos les falte lo mismo.
    .sort((a, b) => (a.existencias / a.stockMinimo) - (b.existencias / b.stockMinimo)
                 || (a.existencias - a.stockMinimo) - (b.existencias - b.stockMinimo));
  return { cuantos: criticos.length, productos: criticos.slice(0, 30) };
}

function _ultimosMovimientos(codigo, cuantos) {
  const buscado = String(codigo || '').trim().toUpperCase();
  const n = Math.min(Math.max(parseInt(cuantos, 10) || 5, 1), 20);
  const suyos = _movimientos()
    .filter(f => String(f[0] || '').trim().toUpperCase() === buscado)
    .map(f => ({
      fecha: _comoTexto(f[1]),
      tipo: String(f[2] || '').trim(),
      cantidad: parseFloat(f[3]) || 0,
      responsable: String(f[6] || '').trim(),
      equipoDestino: String(f[7] || '').trim(),
      observaciones: String(f[8] || '').trim(),
    }))
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  return { codigo: buscado, movimientos: suyos.slice(0, n) };
}

/** Las fechas de Sheets llegan como objeto Date; se pasan a texto para que
 *  viajen legibles dentro del JSON que ve el agente. */
function _comoTexto(valor) {
  if (valor instanceof Date) return Utilities.formatDate(valor, 'America/Bogota', 'yyyy-MM-dd');
  return String(valor || '').trim();
}


/* ══════════════════════════════════════════════
   EL AGENTE
══════════════════════════════════════════════ */

function _instrucciones(nombreOperario) {
  return 'Eres el asistente de inventario de SolucionAIRE en la planta de Zipaquirá. '
    + 'Estás hablando por WhatsApp con ' + nombreOperario + ', que trabaja ahí.\n\n'
    + 'Cómo responder:\n'
    + '- En español, breve y directo. Es un chat de WhatsApp, no un informe: '
    + 'dos o tres frases suelen bastar.\n'
    + '- Nada de markdown ni tablas. Para enumerar, usa guiones.\n'
    + '- Di siempre la cantidad con su unidad, y avisa cuando algo esté en el mínimo o por debajo.\n'
    + '- Si la búsqueda devuelve varios productos parecidos, pregunta cuál es en vez de adivinar.\n'
    + '- Si no encuentras el producto, dilo claro y sugiere cómo se llama en el sistema.\n'
    + '- Responde solo con lo que devuelvan las herramientas. Si un dato no está, di que no lo tienes; '
    + 'nunca inventes cantidades, códigos ni ubicaciones.\n'
    + '- Solo puedes consultar. Si te piden registrar una entrada o salida, explica que eso se hace '
    + 'desde el sistema, en la sección de Inventario.';
}

/** Le pasa la conversación a Claude y le deja ejecutar las herramientas que
 *  necesite, hasta que responda con texto. El tope de vueltas evita que una
 *  pregunta rara deje al script dando vueltas hasta agotar su tiempo. */
function _responderConAgente(nombreOperario, historial) {
  let mensajes = historial.slice();

  for (let vuelta = 0; vuelta < 5; vuelta++) {
    const respuesta = _llamarClaude(_instrucciones(nombreOperario), mensajes);

    const usosDeHerramienta = (respuesta.content || []).filter(b => b.type === 'tool_use');
    if (!usosDeHerramienta.length) {
      const texto = (respuesta.content || [])
        .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { texto: texto || 'No pude armar una respuesta. Intenta preguntarlo de otra forma.', mensajes: mensajes };
    }

    mensajes.push({ role: 'assistant', content: respuesta.content });
    mensajes.push({
      role: 'user',
      content: usosDeHerramienta.map(u => ({
        type: 'tool_result',
        tool_use_id: u.id,
        content: _ejecutarHerramienta(u.name, u.input || {}),
      })),
    });
  }
  return { texto: 'La consulta se enredó más de la cuenta. ¿Puedes preguntármelo más puntual?', mensajes: mensajes };
}

function _llamarClaude(instrucciones, mensajes) {
  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': _propiedad('CLAVE_CLAUDE'),
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: MODELO_CLAUDE,
      max_tokens: 1024,
      system: instrucciones,
      tools: HERRAMIENTAS,
      messages: mensajes,
    }),
    muteHttpExceptions: true,
  });

  const cuerpo = resp.getContentText();
  if (resp.getResponseCode() !== 200) {
    throw new Error('La API de Claude respondió ' + resp.getResponseCode() + ': ' + cuerpo);
  }
  return JSON.parse(cuerpo);
}


/* ══════════════════════════════════════════════
   MEMORIA DE LA CONVERSACIÓN

   Guardada por número, y se olvida sola a la hora de inactividad: una
   conversación de ayer no debe ensuciar la pregunta de hoy.
══════════════════════════════════════════════ */

function _historialDe(numero) {
  const guardado = CacheService.getScriptCache().get('chat_' + numero);
  return guardado ? JSON.parse(guardado) : [];
}

function _guardarHistorial(numero, mensajes) {
  // Solo se conservan los últimos turnos, y sin los bloques de herramientas:
  // lo que importa para el hilo es qué se preguntó y qué se respondió.
  const limpio = mensajes
    .filter(m => typeof m.content === 'string')
    .slice(-MENSAJES_DE_MEMORIA);
  CacheService.getScriptCache().put('chat_' + numero, JSON.stringify(limpio), 3600);
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

  const historial = _historialDe(numero);
  historial.push({ role: 'user', content: texto });

  let respuesta;
  try {
    respuesta = _responderConAgente(operario, historial);
  } catch (err) {
    console.error('_atender:', err);
    _enviarWhatsApp(numero, 'Tuve un problema consultando el sistema. Vuelve a intentarlo en un momento.');
    return;
  }

  historial.push({ role: 'assistant', content: respuesta.texto });
  _guardarHistorial(numero, historial);
  _enviarWhatsApp(numero, respuesta.texto);
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
 *  funcionar. Mira el resultado en Ver → Registros. */
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
  const criticos = _bajoMinimo();
  console.log('Productos bajo el mínimo: ' + criticos.cuantos);
}

/** Comprueba que un número queda reconocido como operario. Cambia el
 *  número por uno que esté registrado en el sistema. */
function probarOperario() {
  const numero = '573001234567';
  console.log(numero + ' → ' + (_operarioDe(numero) || 'NO está registrado'));
}

/** Prueba el agente completo SIN pasar por WhatsApp: hace la pregunta y
 *  escribe la respuesta en el registro. Ideal para afinar el tono y las
 *  herramientas antes de conectar nada. */
function probarAgente() {
  const pregunta = '¿qué productos están por debajo del mínimo?';
  const r = _responderConAgente('Alex Prieto', [{ role: 'user', content: pregunta }]);
  console.log('Pregunta:  ' + pregunta);
  console.log('Respuesta: ' + r.texto);
}
