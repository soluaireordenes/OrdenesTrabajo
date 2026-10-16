# Pruebas automáticas

Pruebas para revisar que el sistema siga funcionando **antes de publicar un cambio**.
No tocan datos reales: Google Sheets, Drive, el Apps Script y el proxy van **simulados**.

| Archivo | Qué revisa | Necesita |
|---|---|---|
| `sintaxis.js` | Que los bloques `<script>` de `index.html` y el `sw.js` no tengan errores de sintaxis. | Node |
| `worker.test.mjs` | El proxy de Cloudflare (`proxy-seguridad/cloudflare-proxy.js`): login, bloqueo por intentos fallidos, pases de sesión, cupo de Sheets por persona (`quotaUser`), permisos por rol (Proyectos, Usuarios, Config, pestañas de personal Operarios y ObservacionesOperarios), que desactivar o cambiar el rol en la hoja aplique sin esperar a que venza el pase, la lista blanca del operario, la clave de sede (`/sede`), los PIN con clave secreta (`PIN_PEPPER`), el pase de fotos (`/pase-fotos`), ruta `/foto` y que `/diag` ya no exista. | Node 18 o más reciente |
| `fotos-script.test.mjs` | El script de fotos de cada sede (`fotos-apps-script.gs`) con Google simulado y pases generados por el proxy real: sin pase válido no hace nada, solo borra dentro de la carpeta de fotos, solo sube y entrega imágenes y PDF. | Node 18 o más reciente |
| `whatsapp-worker.test.mjs` | El intermediario del bot (`whatsapp-agente/cloudflare-worker.js`): verificación del webhook y firma de Meta (`APP_SECRET`). | Node 18 o más reciente |
| `app.test.js` | La app (`index.html`) en un navegador real: carga sin errores, login por el proxy, roles operario/admin (Dashboard, Nueva orden, Proyectos, eliminar órdenes, Hoja de Vida, novedades, Plan, Reparar hoja, llamados de atención, borrar reportes, registrar equipos/servicios/proveedores), fotos por el proxy con respaldo por Apps Script y pausa tras un fallo, reintento cuando Google dice "cuota agotada", informe del cronograma (6 fotos, sin fotos, servidor colgado), inventario de herramienta, ver inspección, repuestos de la Hoja de Vida, PDF y exportación de órdenes, reintento sin duplicar, dashboard sin la librería de gráficas, salidas de inventario por fecha, login en modo oscuro, la lista de operarios de planta desde la hoja, reportes técnicos por franja (fecha y ventana), arranque con el almacenamiento bloqueado, "Salir" pide otra vez la clave de sede, colores de los PDF, caché de stock, escrituras que agregan antes de borrar, y el empalme de entrega de Zipaquirá 2 de punta a punta contra un Google Sheets en memoria (ficha con horómetro, hallazgo que se vuelve orden, repuestos por comprar, bodega pegada desde Excel y acta), y lo de la revisión general: fechas del inventario en hora de Colombia, la Hoja de Vida dentro de la pantalla, los filtros con el estilo de la app, la barra de abajo del celular y la pestaña "Actividades" solo en Zipaquirá; y el formato propio del Compresor IR en el Reporte Emergencia (campos, guardado, horómetro, vista y Variables); los reportes técnicos que bajan solo lo reciente (y lo viejo cuando el filtro lo pide) y el medidor de capacidad de las hojas, contra un Sheets en memoria que, como Google, deja las filas vacías al final de cada pestaña; el reporte de Máquinas de Formación (máquina, referencia, sección según la máquina, cavidades y velocidad); y el aspecto: logo sin fondo en claro y oscuro (encabezado, login y documentos, con el PDF siempre en claro), colores de estado y del Plan que siguen el tema, y el encabezado de una fila en el celular con la cuenta en el menú lateral; y el orden: Reportes en dos grupos (Turno y Reportes técnicos, fila deslizable en celular), el mismo encabezado en cada sección, una sola acción principal en las pendientes y el editor, y las herramientas plegadas al final del menú (que no se cierra al desplegar un grupo). | Node + Playwright + Chromium |

GitHub las corre solas: en cada pull request y en cada cambio a `main` (flujo
"Validar sintaxis"), y antes de publicar la página se corren la de sintaxis y
las de los Workers y el script de fotos; si alguna falla, no se publica.

## Cómo correrlas

Desde la carpeta raíz del repositorio:

```bash
# Sintaxis, proxy y bot (no necesitan instalar nada)
node pruebas/sintaxis.js
node pruebas/worker.test.mjs
node pruebas/whatsapp-worker.test.mjs
node pruebas/fotos-script.test.mjs

# App (la primera vez hay que instalar Playwright y su navegador)
npm install --no-save playwright
npx playwright install chromium
node pruebas/app.test.js
```

Cada archivo muestra una línea `PASS` / `FAIL` por prueba y al final el total
(por ejemplo `56/56 pruebas del Worker OK`). Si alguna falla, el proceso termina
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
