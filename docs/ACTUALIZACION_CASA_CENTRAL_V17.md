# Actualización de Casa Central desde V1.2

La rama de Netlify sigue siendo `release/casa-central-buffet`. La actualización parte de `dea4d338332e934a0488de4bc4e258f74045e2f3` y adapta las mejoras de Villeta verificadas en `1b15cfbb341e945a97ec8c8235551c8fd3a7fbe3`. Cada sucursal conserva su propio proyecto Supabase, sitio Netlify, número y credenciales.

## Instalación existente

1. Confirmá que estás en el proyecto Supabase **Casa Central**. Revisá la versión instalada y prepará una copia recuperable de la base y de las fotos privadas, si corresponden.
2. En SQL Editor, aplicá `database/015_historial_casa_central.sql` y luego `database/016_pedidos_finanzas_buffet.sql`. Ejecutá cada archivo completo, en una sesión administrativa. Si falla, revisá el error antes de pasar al siguiente.
3. Verificá usuarios, permisos de menú, configuraciones y pedidos existentes. La actualización conserva registros y configura una tabla de movimientos monetarios con RLS. Las fechas históricas se reconstruyen a partir de transiciones registradas. Las fechas sin evidencia quedan sin asignar.
4. Una vez verificado SQL, en **Netlify → Deploys** ejecutá un único despliegue manual de `release/casa-central-buffet`. Confirmá rama y SHA antes de publicar. Conservá las variables exclusivas de Casa Central. Prepará el despliegue de modo que no se active antes de aplicar SQL.
5. Usá la [guía de despliegue](GUIA_DESPLIEGUE_CASA_CENTRAL.md) para las verificaciones de servicios y el [checklist](CHECKLIST_DESPLIEGUE_CASA_CENTRAL.md) para registrar evidencias.

## Instalación nueva

Ejecutá los archivos de `database/` en este orden:

```text
001_base_crm.sql
002_guarnipitan.sql
005_eliminacion_admin.sql
006_ubicaciones_delivery.sql
007_el_viejo.sql
009_v11_fiabilidad.sql
010_buffet_categories.sql
011_configuracion_ux.sql
013_metricas_ia.sql
014_avisos_pedidos.sql
015_historial_casa_central.sql
016_pedidos_finanzas_buffet.sql
```

El archivo 003 es un marcador y 004 ilustra un alta. Para almacenamiento privado, aplicá después el archivo opcional `database/storage/001_menu_private_bucket.sql`. Creá la primera cuenta administradora siguiendo la guía. No se importan semillas de Villeta.

## Verificaciones antes de entregar al negocio

- Autenticación con cuentas distintas de administrador, empleado y editor de menú. Probá cierre, renovación y acceso con el permiso retirado.
- Menú del día por foto, revisión humana, cambios de disponibilidad y ausencia del menú anterior.
- WhatsApp del número de prueba, recibo firmado, corrección de cantidades, dos platos, retiro y delivery con punto válido y referencia en blanco. Confirmá desde la toma humana, con importe acordado y costo manual.
- Flujo de preparación, listo, reparto y entrega. Revisá formato del mensaje, hora paraguaya y responsable.
- Cobro y reembolso explícitos, sin repetición al reintentar. Compará los totales de períodos con los movimientos. Pendientes y activos son el estado actual de la cola, mientras que los demás indicadores se asignan por fecha de entrega o movimiento.
- Vista previa de limpieza y eliminación con datos ficticios en una instancia aislada. Verificá bloqueo de pedidos activos y conservación de movimientos sobre pedidos eliminados.
- Salud, funciones programadas y almacenamiento privado. Validá en móvil y escritorio.

Las pruebas locales usan PGlite, Chromium y proveedores simulados. La actualización no valida un proyecto Supabase alojado, un despliegue Netlify o un envío real. Los precios de referencia, contacto, horarios, delivery y medios de pago deben confirmarse con el negocio.

## Capturas del CRM

Las imágenes usan datos ficticios de Playwright.

- [Pedido en escritorio](capturas-casa-central/pedido-escritorio.png) y [pedido en móvil](capturas-casa-central/pedido-movil.png).
- [Resumen en escritorio](capturas-casa-central/resumen-escritorio.png) y [resumen en móvil](capturas-casa-central/resumen-movil.png).

El build local y la suite completa dieron 107 pruebas aprobadas, 0 fallidas y 2 omisiones heredadas. El resultado remoto se publica por separado en GitHub Actions.
