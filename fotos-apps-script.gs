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
//    (CO/O-I ZIPAQUIRA — carpeta en Workspace)
var CARPETA_ID = '1UMMHSC-A5YITjRLkpS5me6s1w-OdwAAZ';

// ── Mostrar una foto: GET ?id=<driveFileId> ──
function doGet(e) {
  try {
    var id = e && e.parameter && e.parameter.id;
    if (!id) return _json({ ok: false, mensaje: 'Falta el parámetro id.' });
    var archivo = DriveApp.getFileById(id);
    var blob = archivo.getBlob();
    return _json({
      ok: true,
      mimeType: blob.getContentType() || 'image/jpeg',
      base64: Utilities.base64Encode(blob.getBytes())
    });
  } catch (err) {
    return _json({ ok: false, mensaje: 'No se pudo leer la foto: ' + err.message });
  }
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

  var carpeta  = DriveApp.getFolderById(CARPETA_ID);
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
