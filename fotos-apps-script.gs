/* ══════════════════════════════════════════════════════════════════════
   APPS SCRIPT DE FOTOS — Sistema SolucionAIRE (una instancia por sede)

   Guarda y sirve las fotos de Órdenes, Reportes y Novedades (y los PDF de
   los informes). El sistema (index.html) NO sube a Drive directamente: le
   manda la foto a este Web App, que la guarda SIEMPRE en la carpeta de la
   cuenta dueña del proyecto — así cualquier persona de la sede puede subir
   y ver fotos sin depender de su propio login ni de sus permisos de Drive.

   ── SEGURIDAD ─────────────────────────────────────────────────────────
   Este Web App está publicado para "cualquier usuario" y corre con la
   cuenta dueña, así que por sí solo cualquiera que conociera su dirección
   podía leer, subir o mandar a la papelera archivos de esa cuenta. Ahora:
     • Toda petición trae un "pase de fotos" que entrega el proxy del
       sistema solo a quien inició sesión. El pase va firmado con
       FOTOS_SECRETO (la misma clave en el Worker y aquí) y vence a las 6 h.
     • Solo se borran archivos que estén dentro de la carpeta de fotos.
     • Solo se suben imágenes y PDF, de hasta 15 MB.
     • Solo se entregan imágenes y PDF (nunca hojas de cálculo ni
       documentos de Google).

   ── CONTRATO QUE ESPERA EL SISTEMA (no cambiar nombres de campos) ──────
   • Subir   (POST, body JSON):
       { accion:'subirFoto', pase, tipo:'orden'|'cronograma'|'novedad'|'empalme',
         codigo, nombreArchivo, mimeType, base64 (SIN prefijo data:),
         tareaDescripcion, subidoPor, correo }
     → responde { ok:true, driveFileId, urlVer }
   • Mostrar (GET):  ?id=<driveFileId>&pase=<pase>
     → responde { ok:true, mimeType, base64 }
   • Eliminar(POST, body JSON):
       { accion:'eliminarFoto', pase, driveFileId, correo }
     → responde { ok:true }
   En cualquier error responde { ok:false, mensaje:'...' } para que el
   sistema muestre el motivo. Si el pase falta o venció, además trae
   paseInvalido:true y el sistema pide uno nuevo.

   ── CÓMO SE INSTALA O ACTUALIZA (una vez por sede) ────────────────────
   1. script.google.com → el proyecto de fotos de la sede (o uno nuevo) →
      pega este archivo completo, reemplazando el anterior.
   2. Configuración del proyecto (engranaje) → Propiedades del script →
      agrega estas dos y toca "Guardar propiedades del script":
        • CARPETA_ID     el ID de la carpeta de fotos de ESTA sede (lo que va
                         en la URL de la carpeta de Drive, entre /folders/ y
                         el signo ?). Si actualizas un script que ya
                         funcionaba, es el que estaba escrito en la línea
                         "var CARPETA_ID = '...'" del código anterior.
        • FOTOS_SECRETO  la misma frase que pusiste en el Worker del proxy.
   3. Implementar → Administrar implementaciones → lápiz de la implementación
      que ya existe → Versión: "Nueva versión" → Implementar. (Así la
      dirección /exec no cambia.) Si es un proyecto nuevo: Nueva
      implementación → Aplicación web → Ejecutar como: Yo · Quién tiene
      acceso: Cualquier usuario, y pega la URL /exec en index.html →
      FOTOS_CONFIG.
   4. Corre una vez la función probarConfiguracion (menú de arriba →
      Ejecutar) y mira el registro: dice si falta algo.
   ═══════════════════════════════════════════════════════════════════ */

// Cada tipo de foto se guarda en su propia subcarpeta (se crean solas si no
// existen). El sistema envía el campo "tipo" en cada subida. Las fotos se
// sirven por su ID, así que la subcarpeta no afecta cómo se ven.
var SUBCARPETAS = {
  orden:      'FOTOS OT',
  cronograma: 'FOTOS REPORTES',
  novedad:    'FOTOS NOVEDADES',
  empalme:    'FOTOS EMPALME'
};

// Tope de tamaño de lo que se sube (las fotos llegan ya reducidas por la app).
var MAX_BYTES_SUBIDA = 15 * 1024 * 1024;

function _propiedad(nombre) {
  var valor = PropertiesService.getScriptProperties().getProperty(nombre);
  if (!valor) throw new Error('Falta la propiedad "' + nombre + '" en Configuración del proyecto → Propiedades del script.');
  return valor;
}

/* ── Pase de fotos ──
   Mismo formato que el pase de sesión del proxy: tres partes base64url
   "cabecera.datos.firma", con la firma HMAC-SHA256 de "cabecera.datos"
   usando FOTOS_SECRETO. Los datos traen exp (segundos). */
function _paseValido(pase) {
  var secreto = _propiedad('FOTOS_SECRETO');
  var partes = String(pase || '').split('.');
  if (partes.length !== 3) return false;
  var firma = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(partes[0] + '.' + partes[1], secreto, Utilities.Charset.UTF_8)
  ).replace(/=+$/, '');
  if (!_igualSeguro(firma, partes[2])) return false;
  var datos;
  try {
    var b64 = partes[1];
    while (b64.length % 4) b64 += '=';
    datos = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(b64)).getDataAsString());
  } catch (e) {
    return false;
  }
  return !!datos.exp && datos.exp > Math.floor(Date.now() / 1000);
}

function _igualSeguro(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var dif = 0;
  for (var i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function _sinPase() {
  return _json({ ok: false, paseInvalido: true, mensaje: 'Pase de fotos inválido o vencido. Vuelve a abrir la sección o inicia sesión de nuevo.' });
}

/** ¿El archivo está dentro de la carpeta de fotos (o de sus subcarpetas)? */
function _estaEnCarpetaDeFotos(archivo) {
  var raiz = _propiedad('CARPETA_ID');
  var pendientes = [];
  var padres = archivo.getParents();
  while (padres.hasNext()) pendientes.push(padres.next());
  for (var nivel = 0; nivel < 6 && pendientes.length; nivel++) {
    var siguientes = [];
    for (var i = 0; i < pendientes.length; i++) {
      if (pendientes[i].getId() === raiz) return true;
      var arriba = pendientes[i].getParents();
      while (arriba.hasNext()) siguientes.push(arriba.next());
    }
    pendientes = siguientes;
  }
  return false;
}

/** Solo se entregan imágenes y PDF: nunca hojas de cálculo, documentos ni
 *  otros archivos de la cuenta, aunque alguien conozca su ID. */
function _esEntregable(archivo) {
  var tipo = String(archivo.getMimeType() || '').toLowerCase();
  return tipo.indexOf('image/') === 0 || tipo === 'application/pdf';
}

// ── Mostrar fotos ──
//   GET ?id=<driveFileId>&pase=…       -> una foto  { ok, mimeType, base64 }
//   GET ?ids=<id1,id2,...>&pase=…      -> varias    { ok, fotos:{ id:{mimeType,base64} } }
//   &thumb=1 en cualquiera de los dos  -> miniatura liviana (para informes)
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!_paseValido(p.pase)) return _sinPase();
    var quiereThumb = p.thumb === '1' || p.thumb === 'true';

    if (p.ids) {
      var lista = String(p.ids).split(',').filter(function (x) { return x; }).slice(0, 50);
      var fotos = {};
      for (var i = 0; i < lista.length; i++) {
        var fid = lista[i];
        try {
          var archivoLote = DriveApp.getFileById(fid);
          if (!_esEntregable(archivoLote)) continue;
          var bl = _blobFoto(archivoLote, quiereThumb);
          fotos[fid] = {
            mimeType: bl.getContentType() || 'image/jpeg',
            base64: Utilities.base64Encode(bl.getBytes())
          };
        } catch (errFoto) { /* una foto que falle no tumba el resto del lote */ }
      }
      return _json({ ok: true, fotos: fotos });
    }

    var id = p.id;
    if (!id) return _json({ ok: false, mensaje: 'Falta el parámetro id.' });
    var archivo = DriveApp.getFileById(id);
    if (!_esEntregable(archivo)) return _json({ ok: false, mensaje: 'Ese archivo no es una foto ni un PDF.' });
    var blob = _blobFoto(archivo, quiereThumb);
    return _json({
      ok: true,
      mimeType: blob.getContentType() || 'image/jpeg',
      base64: Utilities.base64Encode(blob.getBytes())
    });
  } catch (err) {
    return _json({ ok: false, mensaje: 'No se pudo leer la foto: ' + err.message });
  }
}

// Devuelve el blob de la foto. Con thumb=true entrega la miniatura de Drive
// (mucho más liviana); si no hay miniatura, cae a la imagen original.
function _blobFoto(archivo, thumb) {
  if (thumb) {
    try {
      var t = archivo.getThumbnail();
      if (t && t.getBytes().length > 0) return t;
    } catch (e) { /* sin miniatura: usar original */ }
  }
  return archivo.getBlob();
}

// ── Subir o eliminar: POST con body JSON ──
function doPost(e) {
  try {
    var datos = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!_paseValido(datos.pase)) return _sinPase();

    if (datos.accion === 'subirFoto')   return _subirFoto(datos);
    if (datos.accion === 'eliminarFoto') return _eliminarFoto(datos);

    return _json({ ok: false, mensaje: 'Acción no reconocida: ' + datos.accion });
  } catch (err) {
    return _json({ ok: false, mensaje: 'Error procesando la solicitud: ' + err.message });
  }
}

function _subirFoto(datos) {
  if (!datos.base64) return _json({ ok: false, mensaje: 'No llegó el contenido de la imagen.' });

  var mimeType = String(datos.mimeType || 'image/jpeg').toLowerCase();
  if (mimeType.indexOf('image/') !== 0 && mimeType !== 'application/pdf') {
    return _json({ ok: false, mensaje: 'Solo se pueden subir fotos o PDF.' });
  }
  var bytes = Utilities.base64Decode(datos.base64);
  if (bytes.length > MAX_BYTES_SUBIDA) return _json({ ok: false, mensaje: 'El archivo pesa más de 15 MB.' });

  var carpeta  = _carpetaDestino(datos.tipo);
  var nombre   = String(datos.nombreArchivo
              || ((datos.tipo || 'foto') + '_' + (datos.codigo || '') + '_' + Date.now() + '.jpg')).slice(0, 200);
  var blob  = Utilities.newBlob(bytes, mimeType, nombre);
  var archivo = carpeta.createFile(blob);

  // Dar vista por enlace (para que urlVer funcione al abrir/descargar). Si
  // la política del Workspace no permite "cualquiera con el enlace", no se
  // interrumpe la subida: las fotos igual se muestran dentro del sistema.
  try {
    archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (errShare) { /* la política del dominio lo bloquea; no importa */ }

  var id = archivo.getId();
  return _json({
    ok: true,
    driveFileId: id,
    urlVer: 'https://drive.google.com/file/d/' + id + '/view'
  });
}

// Devuelve la subcarpeta que le toca a este tipo de foto, creándola dentro de
// la carpeta raíz si todavía no existe. Si el tipo no está mapeado, guarda en
// la carpeta raíz (no se pierde nada).
function _carpetaDestino(tipo) {
  var raiz = DriveApp.getFolderById(_propiedad('CARPETA_ID'));
  var nombre = SUBCARPETAS[String(tipo || '').toLowerCase()];
  if (!nombre) return raiz;
  var it = raiz.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : raiz.createFolder(nombre);
}

function _eliminarFoto(datos) {
  try {
    if (!datos.driveFileId) return _json({ ok: false, mensaje: 'Falta el id de la foto.' });
    var archivo = DriveApp.getFileById(datos.driveFileId);
    // Solo lo que está en la carpeta de fotos: nunca otros archivos de la
    // cuenta, aunque alguien conozca su ID.
    if (!_estaEnCarpetaDeFotos(archivo)) return _json({ ok: false, mensaje: 'Ese archivo no está en la carpeta de fotos; no se borró.' });
    archivo.setTrashed(true);
    return _json({ ok: true });
  } catch (err) {
    // Que no falle el flujo del sistema si la foto ya no existe.
    return _json({ ok: false, mensaje: 'No se pudo eliminar: ' + err.message });
  }
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Para correr a mano desde el editor después de instalar o actualizar:
 *  revisa que estén las dos propiedades y que la carpeta se pueda abrir. */
function probarConfiguracion() {
  var carpeta = DriveApp.getFolderById(_propiedad('CARPETA_ID'));
  _propiedad('FOTOS_SECRETO');
  console.log('Todo listo. Carpeta de fotos: "' + carpeta.getName() + '".');
}
