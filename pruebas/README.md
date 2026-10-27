# Pruebas automáticas

Pruebas para revisar que el sistema siga funcionando **antes de publicar un cambio**.
No tocan datos reales: Google Sheets, Drive, el Apps Script y el proxy van **simulados**.

| Archivo | Qué revisa | Necesita |
|---|---|---|
| `sintaxis.js` | Que los bloques `<script>` de `index.html` y el `sw.js` no tengan errores de sintaxis. | Node |
| `analisis.js` | Con ESLint, en los `<script>` de `index.html` y en `sw.js`: nombres que no existen (una función mal escrita solo falla cuando alguien toca ese botón), declaraciones y claves repetidas, código que nunca se ejecuta y comparaciones imposibles; y que cada función que llama un `onclick="…"` (u otro `on…`) del HTML exista. Las variables sin usar salen como aviso, sin detener nada. | Node + ESLint (se instala con npm) |
| `worker.test.mjs` | El proxy de Cloudflare (`proxy-seguridad/cloudflare-proxy.js`): login, bloqueo por intentos fallidos, pases de sesión, cupo de Sheets por persona (`quotaUser`), permisos por rol (Proyectos, Usuarios, Config, pestañas de personal Operarios y ObservacionesOperarios), que desactivar o cambiar el rol en la hoja aplique sin esperar a que venza el pase, la lista blanca del operario, la clave de sede (`/sede`), los PIN con clave secreta (`PIN_PEPPER`), el pase de fotos (`/pase-fotos`), ruta `/foto` y que `/diag` ya no exista. | Node 18 o más reciente |
| `fotos-script.test.mjs` | El script de fotos de cada sede (`fotos-apps-script.gs`) con Google simulado y pases generados por el proxy real: sin pase válido no hace nada, solo borra dentro de la carpeta de fotos, solo sube y entrega imágenes y PDF. | Node 18 o más reciente |
| `whatsapp-worker.test.mjs` | El intermediario del bot (`whatsapp-agente/cloudflare-worker.js`): verificación del webhook y firma de Meta (`APP_SECRET`). | Node 18 o más reciente |
| `app.test.js` | La app (`index.html`) en un navegador real: carga sin errores, login por el proxy, roles operario/admin (Dashboard, Nueva orden, Proyectos, eliminar órdenes, Hoja de Vida, novedades, Plan, Reparar hoja, llamados de atención, borrar reportes, registrar equipos/servicios/proveedores), fotos por el proxy con respaldo por Apps Script y pausa tras un fallo, reintento cuando Google dice "cuota agotada", informe del cronograma (6 fotos, sin fotos, servidor colgado), inventario de herramienta, ver inspección, repuestos de la Hoja de Vida, PDF (con la sede en el título, el encabezado y el pie) y exportación de órdenes, reintento sin duplicar, dashboard sin la librería de gráficas, salidas de inventario por fecha, login en modo oscuro, la lista de operarios de planta desde la hoja, reportes técnicos por franja (fecha y ventana), arranque con el almacenamiento bloqueado, "Salir" pide otra vez la clave de sede, colores de los PDF, caché de stock, escrituras que agregan antes de borrar, y el empalme de entrega de Zipaquirá 2 de punta a punta contra un Google Sheets en memoria (ficha con horómetro, hallazgo que se vuelve orden, repuestos por comprar, bodega pegada desde Excel y acta), y lo de la revisión general: fechas del inventario en hora de Colombia, la Hoja de Vida dentro de la pantalla, los filtros con el estilo de la app, la barra de abajo del celular y la pestaña "Actividades" solo en Zipaquirá; y el formato propio del Compresor IR en el Reporte Emergencia (campos, guardado, horómetro, vista y Variables); los reportes técnicos que bajan solo lo reciente (y lo viejo cuando el filtro lo pide) y el medidor de capacidad de las hojas, contra un Sheets en memoria que, como Google, deja las filas vacías al final de cada pestaña; el reporte de Máquinas de Formación (máquina, referencia, sección según la máquina, cavidades y velocidad); y el aspecto: logo sin fondo en claro y oscuro (encabezado, login y documentos, con el PDF siempre en claro), colores de estado y del Plan que siguen el tema, y el encabezado de una fila en el celular con la cuenta en el menú lateral; y el orden: Reportes en dos grupos (Turno y Reportes técnicos, fila deslizable en celular), el mismo encabezado en cada sección, una sola acción principal en las pendientes y el editor, y las herramientas plegadas al final del menú (que no se cierra al desplegar un grupo); y la consistencia: la ventana de confirmación de la app en vez de la del navegador (Cancelar y Escape no borran), la ventana con campos en vez de prompt() (eliminar una orden pidiendo su número, nuevo alcance con sus tres datos), pantallas sin emojis (íconos de línea y banderas dibujadas) y los tamaños de letra y radios solo de la escala; e Inicio compacto (accesos directos con la ventana de reporte del turno, mapa al final) con los encabezados de tarjeta claros; y lo de la segunda revisión general: las ventanas de la app con el mouse de verdad (un doble clic no las cierra ni confirma un borrado, arrastrar desde un campo hasta el fondo no las cierra, la clave de sede igual) y el modo oscuro sin fondos claros ni letra poco legible en las listas de órdenes, el detalle, el Histórico, el inventario, la herramienta y Proyectos con su contrato cargado; y en el empalme, los mantenimientos anteriores desde un Excel armado en la prueba (título arriba, fechas de Excel y escritas, equipo en celdas combinadas, equipos que no existen, filas sin fecha y repetidas) y desde un CSV de Windows: vista previa, registro en una sola escritura, último mantenimiento en la ficha, el mismo archivo otra vez sin repetir, deshacer la carga, el .xls viejo, el acta, el operario sin poder subir ni borrar y un archivo como los del empalme (EQUIPOS, FECHA, AÑO, ACTIVIDADES REALIZADAS, HORÓMETRO y OBSERVACIONES) con el año tomado de la columna AÑO aunque la FECHA no lo muestre, sin columnas vacías en las tablas; y que la ficha muestre todo el texto: cada cuadro crece con lo que tiene (al escribir, en celular y aunque la ficha se haya dibujado oculta), la Hoja de vida es la más alta y la tabla de mantenimientos va completa, sin barra propia; y lo de revisar Zipaquirá 1 y 2: en celular el primer equipo tocado del empalme lleva hasta su ficha, Variables solo en la sede con reportes técnicos, en Zipaquirá 2 el acceso de Inicio y el botón de abajo llevan al empalme y Reportes no muestra formularios sin uso, el hallazgo queda Resuelto cuando su orden se cierra, el aviso de la hora de los reportes técnicos cabe en su recuadro, el Plan de Mantenimiento de Zipaquirá 2 solo con Registro y Configuración (y sus textos), y al arrancar Zipaquirá 2 no crea las pestañas de los informes por horas ni del catálogo de variables, mientras Zipaquirá sigue con sus 7 pestañas y su revisión; el Dashboard de Reportes sin la librería de gráficas (muestra los números y explica el cuadro vacío) y el Programa de Mantenimiento por año (la pestaña dice el año, y sin el programa del año en curso muestra el último con un aviso); y lo de la segunda revisión del empalme: la misma bodega cargada otra vez solo agrega lo nuevo y avisa cuáles ya estaban (el stock no se duplica), dos toques en "Crear orden" con Sheets lento crean una sola orden (la fila dice "Creando orden…"), y el hallazgo cuya orden se eliminó vuelve a Abierto, pero no el de una orden creada en otro equipo ni ninguno si no se pueden leer las órdenes; y la lista de equipos de Zipaquirá 2 con sus 14 bombas de vacío (en órdenes, inventario, Hoja de Vida, empalme y Plan de Mantenimiento, donde su horómetro se registra igual que el de los compresores, pero sin la evaluación técnica del empalme, que sigue siendo solo de los 22 compresores); y lo de revisar Zipaquirá 2 con sus bombas: la Hoja de Vida por grupos y, en celular, llevando a la hoja de vida del equipo tocado (no al recargar el mismo), los secadores de Zipaquirá 2 sin RPM, y guardar horas base en Zipaquirá 2 sin crear las pestañas de los informes por horas ni prometer órdenes, mientras Zipaquirá sigue reiniciando sus informes; y en la ficha del empalme, las fotos primero (debajo del nombre del equipo), grandes y sin recortar para poder leer la placa. | Node + Playwright + Chromium |

GitHub las corre solas: en cada pull request y en cada cambio a `main` (flujo
"Validar sintaxis"), y antes de publicar la página se corren la de sintaxis, el
análisis del código y las de los Workers y el script de fotos; si alguna falla,
no se publica.

## Cómo correrlas

Desde la carpeta raíz del repositorio:

```bash
# Sintaxis, proxy y bot (no necesitan instalar nada)
node pruebas/sintaxis.js
node pruebas/worker.test.mjs
node pruebas/whatsapp-worker.test.mjs
node pruebas/fotos-script.test.mjs

# Análisis del código (instala ESLint solo para esto)
npm install --no-save eslint@10.12.0 globals@17.12.0
node pruebas/analisis.js

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

### Variables opcionales (analisis.js)

- `ESLINT_MODULE` y `GLOBALS_MODULE`: rutas de los paquetes `eslint` y `globals` si están instalados en otra parte.

## Cuándo actualizarlas

Si un cambio modifica a propósito algo que estas pruebas revisan (por ejemplo, el
número de fotos por actividad o qué puede ver un operario), hay que ajustar la
prueba correspondiente en el mismo cambio.
