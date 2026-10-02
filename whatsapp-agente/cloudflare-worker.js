/* ══════════════════════════════════════════════════════════════════════
   INTERMEDIARIO ENTRE META Y APPS SCRIPT (Cloudflare Worker)

   Meta no puede entregarle los mensajes directamente a Apps Script. Las
   URL que terminan en /exec responden a las peticiones POST con una
   REDIRECCIÓN a otro dominio de Google (script.googleusercontent.com), y
   el cliente de webhooks de Meta no sigue redirecciones en POST. Por eso
   la verificación del webhook funciona a la primera —esa es un GET— pero
   ningún mensaje llega nunca.

   Este Worker se pone en el medio: recibe de Meta, que sí le puede
   entregar, y le reenvía el mensaje a Apps Script siguiendo la
   redirección. De paso resuelve un segundo problema: Meta espera una
   respuesta en pocos segundos y Apps Script tarda entre 3 y 6 en hacer su
   trabajo. El Worker contesta de inmediato y reenvía por detrás, así Meta
   nunca reintenta por demora.

   No cambia nada de lo que ya está montado: el bot, el número, el token y
   las credenciales se quedan igual. Solo cambia por dónde entran los
   mensajes.

   ── CÓMO SE INSTALA ──────────────────────────────────────────────────
   1. Crea una cuenta gratuita en dash.cloudflare.com (no pide tarjeta).
   2. Workers y Pages → Crear → Worker → ponle un nombre (ej. "bot-whatsapp")
      → Implementar.
   3. Editar código → borra lo que traiga de ejemplo → pega este archivo.
   4. Define las dos variables del Worker (NO se escriben en el código, para
      no dejar secretos a la vista en un repositorio público):
        Configuración → Variables y secretos → Agregar:
          • URL_APPS_SCRIPT    (tipo Texto)   = tu URL de Apps Script /exec
          • TOKEN_VERIFICACION (tipo Secreto)  = tu palabra de verificación
      La URL de Apps Script la sacas de: Apps Script → Implementar →
      Administrar implementaciones.
   5. Implementar. Copia la URL que te queda, algo como
      https://bot-whatsapp.TU-USUARIO.workers.dev
   6. En el panel de Meta → WhatsApp → Configuración → Webhooks → Editar:
        URL de devolución de llamada: la URL del Worker
        Token de verificación: el mismo valor que pusiste en TOKEN_VERIFICACION
      Verificar y guardar, y confirma que "messages" siga suscrito.
   7. Escríbele al bot. Ahora sí debe responder.

   Nota de seguridad: antes estos dos valores estaban escritos aquí. Se
   movieron a variables del Worker para que el token de verificación no quede
   expuesto en el código público. Conviene además cambiar (rotar) ese token
   de verificación en Meta y en el Worker, ya que el anterior estuvo a la vista.
   ═══════════════════════════════════════════════════════════════════ */


export default {
  async fetch(peticion, entorno, contexto) {

    // Los valores sensibles viven en las variables del Worker (entorno), no
    // en el código. Si faltan, se avisa claro en vez de fallar en silencio.
    const URL_APPS_SCRIPT = entorno && entorno.URL_APPS_SCRIPT;
    const TOKEN_VERIFICACION = entorno && entorno.TOKEN_VERIFICACION;
    if (!URL_APPS_SCRIPT || !TOKEN_VERIFICACION) {
      return new Response(
        'Faltan variables del Worker: define URL_APPS_SCRIPT y TOKEN_VERIFICACION en Configuración → Variables y secretos.',
        { status: 500 });
    }

    // ── Verificación del webhook ──
    // Meta manda un GET una sola vez, al registrar la URL, con un desafío
    // que hay que devolverle tal cual. Se responde aquí mismo para no
    // depender de que Apps Script esté despierto en ese momento.
    if (peticion.method === 'GET') {
      const parametros = new URL(peticion.url).searchParams;
      if (parametros.get('hub.mode') === 'subscribe'
          && parametros.get('hub.verify_token') === TOKEN_VERIFICACION) {
        return new Response(parametros.get('hub.challenge'), { status: 200 });
      }
      return new Response('Token de verificación incorrecto.', { status: 403 });
    }

    // Cualquier otro método que no sea POST no nos interesa, pero se
    // contesta 200 para que Meta no lo tome como un fallo.
    if (peticion.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    // ── Un mensaje entrante ──
    const cuerpo = await peticion.text();

    // Se le contesta a Meta de INMEDIATO y el reenvío queda corriendo por
    // detrás con waitUntil. Si se esperara a que Apps Script termine (3 a
    // 6 segundos), Meta podría darlo por perdido y reenviar el mismo
    // mensaje, y el operario recibiría la respuesta repetida.
    contexto.waitUntil(
      fetch(URL_APPS_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: cuerpo,
        // Esto es lo que Meta no hace y aquí sí: seguir la redirección de
        // Apps Script hasta el destino real.
        redirect: 'follow',
      }).catch((err) => {
        // Si el reenvío falla, queda en los registros del Worker
        // (dash.cloudflare.com → tu Worker → Registros).
        console.error('No se pudo reenviar a Apps Script:', err);
      })
    );

    return new Response('EVENT_RECEIVED', { status: 200 });
  },
};
