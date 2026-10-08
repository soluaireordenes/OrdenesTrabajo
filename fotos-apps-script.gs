/* ══════════════════════════════════════════════════════════════════════
   APPS SCRIPT DE FOTOS — Sistema SolucionAIRE (una instancia por sede)

   Guarda y sirve las fotos de Órdenes y Novedades. El sistema (index.html)
   NO sube a Drive directamente: le manda la foto a este Web App, que la
   guarda SIEMPRE en la carpeta de la cuenta dueña del proyecto — así
   cualquier persona de la sede puede subir y ver fotos sin depender de su
   propio login ni de sus permisos de Google Drive.

   ── CONTRATO QUE ESPERA EL SISTEMA (no cambiar nombres de campos) ──────
   • Subir   (POST, body JSON):
       { accion:'subirFoto', tipo:'orden'|'novedad', codigo, nombreArchivo,
         mimeType, base64 (SIN prefijo data:), tareaDescripcion, subidoPor,
         correo }
     → responde { ok:true, driveFileId, urlVer }
   • Mostrar (GET):  ?id=<driveFileId>
     → responde { ok:true, mimeType, base64 }
   • Eliminar(POST, body JSON):
       { accion:'eliminarFoto', driveFileId, correo }
     → responde { ok:true }
   En cualquier error responde { ok:false, mensaje:'...' } para que el
   sistema muestre el motivo.

   ── CÓMO SE INSTALA (una vez, en la cuenta de Workspace) ──────────────
   1. script.google.com → Proyecto nuevo → pega este archivo.
   2. Cambia CARPETA_ID por el ID de la carpeta destino de fotos de ESTA
      sede (el ID es lo que va en la URL de la carpeta de Drive, entre
      /folders/ y el signo ?).
   3. Implementar → Nueva implementación → tipo "Aplicación web":
        • Ejecutar como:  Yo (la cuenta de Workspace dueña de la carpeta)
        • Quién tiene acceso:  Cualquier usuario
      Implementar, autoriza los permisos, y copia la URL que termina en
      /exec.
   4. Esa URL /exec se pega en index.html → FOTOS_CONFIG (la clave de la
      sede). Cada sede usa su propio despliegue con su propia carpeta.
   ═══════════════════════════════════════════════════════════════════ */

// ⬇️ ID de la carpeta de Drive donde se guardan las fotos de ESTA sede.
//    (CO/O-I ZIPAQUIRA — carpeta en Workspace "solucion aire fotos zipaquira")
var CARPETA_ID = '1UMMHSC-A5YITjRLkpS5me6s1w-OdwAAZ';

// Cada tipo de foto se guarda en su propia subcarpeta (se crean solas si no
// existen). El sistema envía el campo "tipo" en cada subida. Las fotos se
// sirven por su ID, así que la subcarpeta no afecta cómo se ven.
var SUBCARPETAS = {
  orden:      'FOTOS OT',
  cronograma: 'FOTOS REPORTES',
  novedad:    'FOTOS NOVEDADES'
};

// ── Mostrar fotos ──
//   GET ?id=<driveFileId>                -> una foto  { ok, mimeType, base64 }
//   GET ?ids=<id1,id2,...>               -> varias    { ok, fotos:{ id:{mimeType,base64} } }
//   &thumb=1 en cualquiera de los dos    -> miniatura liviana (para informes)
// El modo ?ids baja muchas fotos en UNA sola petición, para que armar un
// informe con decenas de fotos tome pocas idas y vueltas en vez de cientos.
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var quiereThumb = p.thumb === '1' || p.thumb === 'true';

    if (p.ids) {
      var lista = String(p.ids).split(',').filter(function (x) { return x; });
      var fotos = {};
      for (var i = 0; i < lista.length; i++) {
        var fid = lista[i];
        try {
          var bl = _blobFoto(DriveApp.getFileById(fid), quiereThumb);
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
    var blob = _blobFoto(DriveApp.getFileById(id), quiereThumb);
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

    if (datos.accion === 'subirFoto')   return _subirFoto(datos);
    if (datos.accion === 'eliminarFoto') return _eliminarFoto(datos);

    return _json({ ok: false, mensaje: 'Acción no reconocida: ' + datos.accion });
  } catch (err) {
    return _json({ ok: false, mensaje: 'Error procesando la solicitud: ' + err.message });
  }
}

function _subirFoto(datos) {
  if (!datos.base64) return _json({ ok: false, mensaje: 'No llegó el contenido de la imagen.' });

  var carpeta  = _carpetaDestino(datos.tipo);
  var mimeType = datos.mimeType || 'image/jpeg';
  var nombre   = datos.nombreArchivo
              || ((datos.tipo || 'foto') + '_' + (datos.codigo || '') + '_' + Date.now() + '.jpg');

  var bytes = Utilities.base64Decode(datos.base64);
  var blob  = Utilities.newBlob(bytes, mimeType, nombre);
  var archivo = carpeta.createFile(blob);

  // Dar vista por enlace (para que urlVer funcione al abrir/descargar). Si
  // la política del Workspace no permite "cualquiera con el enlace", no se
  // interrumpe la subida: las fotos igual se muestran dentro del sistema,
  // que las pide por doGet (ejecutándose como la cuenta dueña).
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
  var raiz = DriveApp.getFolderById(CARPETA_ID);
  var nombre = SUBCARPETAS[String(tipo || '').toLowerCase()];
  if (!nombre) return raiz;
  var it = raiz.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : raiz.createFolder(nombre);
}

function _eliminarFoto(datos) {
  try {
    if (datos.driveFileId) DriveApp.getFileById(datos.driveFileId).setTrashed(true);
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
