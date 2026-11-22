# Validación Casa Central V1.1

El commit de partida `934d1fc0fcebe64f5a1c90127ac0ed912b53eb0b` reprodujo **89 resultados, 76 aprobados, 11 fallidos y 2 omitidos**. La corrida remota de referencia es [GitHub Actions 45070653157](https://github.com/Dezva/ElViejo-CasaCentral-CRM/actions/runs/45070653157).

| Fallo de partida | Diagnóstico | Corrección y cobertura |
| --- | --- | --- |
| `browser.test.mjs` | Recorrido de dos servicios y clave de almacenamiento de la demo anterior. | Recorrido de buffet con foto, publicación humana, retiro, entrega con punto y referencia, importe y costo manuales, roles y móvil. |
| `catalog-browser.test.mjs` | Módulo comercial retirado. | Administración del menú diario con borrador, categoría, publicación, agotados, historial y ancho móvil. |
| `catalog-v13.test.mjs` | Requería la migración 012 del catálogo retirado. | Cobertura de ambigüedad, cantidades, agotados, autorización de menú, RLS y rechazo de mutaciones de catálogo. |
| `el-viejo.test.mjs` | Requería el JSON comercial retirado. | Menús publicados ficticios, coincidencia de Chipa guazú y empanada, rechazo de otro servicio, inexistentes, importes y modalidades. |
| `locations.test.mjs` | El menú vacío del fixture dejó al descubierto que el reducer omitía el cambio de modalidad si faltaba el menú vigente. | El cambio se guarda antes del aviso de falta de menú. Con menú vigente se conservan los platos y se solicita ubicación para delivery. Al elegir retiro se limpian el punto y la referencia. Los fallos de procesamiento de ubicaciones siguen reintentándose. |
| `optimization-v14.test.mjs` | Requería el mismo JSON comercial retirado. | Candidatos de buffet, validación de propuestas simuladas, respuesta ante fallos del proveedor, visibilidad del menú actualizado y privacidad de métricas. |
| `settings-browser.test.mjs` | La prueba esperaba dos formularios, horarios precargados y la clave de la demo anterior. | Buffet sin horarios iniciales, configuración de días, pagos y los tres modos de delivery, recuperación y permisos. |
| `settings.test.mjs`, validación JS | El fixture asumía horarios y pagos confirmados. | Valores pendientes, configuración parcial segura y completa, y rechazo de combinaciones inválidas. |
| `settings.test.mjs`, instalación SQL | El fixture esperaba un horario de chipería tras migrar. | Validación, backup, guardado y recuperación de los datos de buffet, permisos en API y RPC. |
| `settings.test.mjs`, delivery y asistente | Preparaba pedidos de chipería y aceptaba con precio de catálogo. | Pedido de buffet en PGlite con ubicación, revisión de horario, control humano e importes manuales. Conserva las pruebas de pausa del bot. |
| `viejo-database.test.mjs` | Requería migración 008 y órdenes de chipería. | Secuencia limpia de Casa Central, menú con permiso y revisión, rechazo de chipería, confirmación humana, costo explícito, historial, idempotencia y RLS. |

Los contratos retirados corresponden a selección de sucursal, edición del catálogo de chipería y recotización por precio de artículo. Las dos omisiones preexistentes corresponden a contratos de la interfaz anterior. La suite de Casa Central comprueba las ubicaciones y los permisos en rutas vigentes. Los datos históricos en fixtures pertenecen a pruebas de compatibilidad local y quedan fuera de la secuencia de instalación.

Los proveedores de WhatsApp, OpenAI y Supabase alojado se simulan durante las pruebas. La instalación limpia se reproduce en PGlite con roles equivalentes y se documenta en el [README](../README.md). Los horarios y las tarifas de Casa Central quedan pendientes de confirmación comercial.

La validación local de V1.1 completó el build y la suite con **96 resultados, 94 aprobados, 0 fallidos y 2 omitidos** con Node.js 24, pnpm 11.25.0 y Chromium. El workflow de GitHub Actions se verifica por separado.
