# Pruebas automáticas

Pruebas para revisar que el sistema siga funcionando **antes de publicar un cambio**.
No tocan datos reales ni mandan mensajes: Google Sheets, Drive, el Apps Script, el proxy
y WhatsApp van **simulados**.

| Archivo | Qué revisa | Necesita |
|---|---|---|
| `worker.test.mjs` | El proxy de Cloudflare (`proxy-seguridad/cloudflare-proxy.js`): login, bloqueo por intentos fallidos, pases de sesión, cupo de Sheets por persona (`quotaUser`), permisos por rol (Proyectos, Usuarios, Config, Operarios), ruta `/foto` y que `/diag` ya no exista. | Node 18 o más reciente |
| `bot.test.mjs` | El bot de WhatsApp (`whatsapp-agente/Codigo-sin-ia.gs` + `Recordatorios.gs`): recordatorio al empezar cada turno (a quién, cuándo, plantilla o lista completa, sin repetir, turno de noche), la palabra ACTIVIDADES y el botón "Ver actividades". | Node 18 o más reciente |
| `app.test.js` | La app (`index.html`) en un navegador real: carga sin errores, login por el proxy, roles operario/admin (Dashboard, Nueva orden, Proyectos, eliminar órdenes, Hoja de Vida, novedades, Plan), fotos por el proxy con respaldo por Apps Script, reintento cuando Google dice "cuota agotada", informe del cronograma (6 fotos, sin fotos, servidor colgado), inventario de herramienta, ver inspección, repuestos de la Hoja de Vida, cronograma publicado para el bot y la pestaña Encargados de turno. | Node + Playwright + Chromium |

## Cómo correrlas

Desde la carpeta raíz del repositorio:

```bash
# Proxy y bot (no necesitan instalar nada)
node pruebas/worker.test.mjs
node pruebas/bot.test.mjs

# App (la primera vez hay que instalar Playwright y su navegador)
npm install --no-save playwright
npx playwright install chromium
node pruebas/app.test.js
```

Cada archivo muestra una línea `PASS` / `FAIL` por prueba y al final el total
(por ejemplo `20/20 pruebas del Worker OK`). Si alguna falla, el proceso termina
con error y la línea `FAIL` dice qué esperaba.

La prueba del informe con "servidor colgado" tarda unos 45 segundos a propósito:
comprueba que el informe se genere igual cuando las fotos no llegan.

### Variables opcionales (app.test.js)

- `PLAYWRIGHT_MODULE`: ruta del paquete `playwright` si está instalado de forma global.
- `CHROMIUM_PATH`: ruta de un Chromium ya instalado, para no descargar otro.

## Cuándo actualizarlas

Si un cambio modifica a propósito algo que estas pruebas revisan (por ejemplo, el
número de fotos por actividad o qué puede ver un operario), hay que ajustar la
prueba correspondiente en el mismo cambio.
