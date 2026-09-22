# Eficiencia Energética — datos desde Ubidots

Tubería de datos para la sección de **Eficiencia Energética** del sistema.

## Idea

```
Ubidots  ──(Apps Script, 1 vez al día)──▶  Hoja "EnergiaDiaria"  ──▶  App (sección Eficiencia)
```

- El **token de Ubidots vive solo en Apps Script** (nunca en el index.html, que es público).
- En Sheets quedan solo números **agregados por día** (compacto y con historial propio).
- La app lee esa hoja y calcula los KPIs y las gráficas del lado del navegador.

## Contrato de la hoja `EnergiaDiaria`

Una fila por **(Fecha, Compresor)**:

| Columna | Ejemplo | Qué es |
|---|---|---|
| `Fecha` | `2026-09-21` | Día (hora local) |
| `Compresor` | `b2` | Id del compresor |
| `ConsumoKWh` | `18240.5` | Energía consumida ese día |
| `PotenciaPromKW` | `760.4` | Potencia activa promedio del día |
| `FlujoPromSCFM` | `4801.2` | Flujo de aire promedio del día |
| `Muestras` | `288` | Nº de lecturas usadas (control de calidad) |
| `FechaRegistro` | `2026-09-22 00:20` | Cuándo se guardó la fila |

Formato **largo** a propósito: sirve para cualquier número de compresores sin cambiar columnas.

## Instalación

Ver los pasos numerados al inicio de `snapshot-diario.gs`. Resumen:

1. Apps Script en la hoja destino → pegar `snapshot-diario.gs`.
2. Script Properties → `UBIDOTS_TOKEN`.
3. Completar `CONFIG.COMPRESORES` con las **etiquetas reales de las 25 variables**.
4. `probarConexionUbidots()` → verificar.
5. `crearTriggerDiario()` → programar.
6. `snapshotAyer()` → cargar el primer día.

## Lo que falta confirmar para dejarlo fino

- [ ] Semántica de `energia_*_diff_kwh`: ¿delta por intervalo (`MODO_ENERGIA='delta'`) o contador acumulado (`'contador'`)?
- [ ] Lista completa de las 25 variables → mapa `COMPRESORES` (id, energía, potencia, flujo).
- [ ] ¿Hay más devices además de `falcon-compresores-1`?
- [ ] Tarifa de energía ($/kWh) — para el costo (se puede poner también editable en la app).
- [ ] Potencia nominal (kW) por compresor — para el factor de carga (etapa 2).

## Siguiente paso (lado app)

Con la hoja poblada, se agrega la pestaña **Eficiencia Energética**:
- **v1 (básico):** consumo hoy/mes/año + promedio diario, costo estimado, comparativo por compresor, gráfica de consumo por mes, tabla — con el mismo filtro mes/año del resto.
- **v2:** consumo específico (kWh/1000 pcm), factor de carga, energía en vacío/fugas, línea base y % de mejora.
