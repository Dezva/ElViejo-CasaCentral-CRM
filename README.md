# Buffet El Viejo — Casa Central

CRM de pedidos y conversaciones para el buffet de Casa Central, con menú diario sujeto a revisión humana. El encargado acuerda el precio final del pedido. La dirección de referencia es Ruta Guarambaré–Villeta, esquina Villetana, frente a IMPACO, Paraguay. La dirección, los días y horarios, la modalidad de delivery, las tarifas por kilogramo, las formas de pago y los datos de contacto siguen pendientes de confirmación.

La base técnica proviene de `Dezva/Chiperia-CRM`, commit `284b3c449d7600aa76b4646972d49fac0ea99524`. Esta rama está en desarrollo. La suite heredada todavía incluye contratos de chipería que requieren adaptación. Validá la rama antes de desplegarla.

## Demo local en Linux y Windows

Instalá Node.js 24 y pnpm 11.25.0. Desde el directorio del proyecto, con las variables públicas de Supabase sin definir, ejecutá:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Abrí el puerto 5173 en el navegador. En PowerShell, si cargaste anteriormente las variables públicas de Supabase, podés construir la demo en una terminal nueva o quitar ambas del proceso con `Remove-Item Env:PUBLIC_SUPABASE_URL, Env:PUBLIC_SUPABASE_KEY -ErrorAction SilentlyContinue`.

En **Menú del buffet**, cargá una foto de prueba, agregá los platos manualmente, marcá disponibilidad y confirmá la revisión antes de publicar. En **Conversaciones**, abrí el chat de demostración y simulá `MENÚ`, un pedido con nombre y cantidad de cada plato, `retiro` y `CONFIRMAR PEDIDO`. Para simular delivery, cargá también una ubicación ficticia con su referencia. El encargado toma el chat y registra el importe acordado antes de confirmar. Los datos de la demo se guardan en ese navegador. El botón **Restablecer demo** limpia esos datos.

## Supabase exclusivo para Casa Central

Creá un proyecto de prueba vacío para Casa Central. Ejecutá una vez las migraciones de `database/` en este orden:

| Orden | Archivos |
| --- | --- |
| 1 | `001_base_crm.sql`, `002_guarnipitan.sql` |
| 2 | `005_eliminacion_admin.sql`, `006_ubicaciones_delivery.sql`, `007_el_viejo.sql` |
| 3 | `009_v11_fiabilidad.sql`, `010_buffet_categories.sql`, `011_configuracion_ux.sql` |
| 4 | `013_metricas_ia.sql`, `014_avisos_pedidos.sql` |

Los prefijos históricos de algunas tablas y migraciones corresponden al código reutilizado. El archivo 003 es un marcador histórico y el 004 es un ejemplo de alta de usuarios. Los números 008 y 012 se omiten porque el catálogo comercial de Villeta queda fuera de esta instalación.

Invitá a la primera persona administradora desde Supabase Auth. Desde el SQL Editor, con el UUID de su cuenta, ejecutá:

```sql
insert into public.crm_members (user_id, display_name, role, menu_editor)
values ('UUID-DE-LA-CUENTA-DE-AUTH', 'Nombre confirmado', 'admin', true);
```

Invitá a las demás personas en Auth y otorgá acceso desde **Usuarios**. Reservá `menu_editor` para quienes revisan y publican el menú. Conservá las políticas RLS y los permisos de las RPC. Para almacenamiento privado de imágenes, revisá y aplicá luego `database/storage/001_menu_private_bucket.sql` y habilitá la opción correspondiente. Configurá las copias de seguridad de la base y del almacenamiento del proyecto nuevo. Comprobá la restauración en un entorno aislado.

## Netlify, WhatsApp y OpenAI

Creá un sitio Netlify independiente conectado al repositorio de Casa Central. El build publica `dist` y `netlify.toml` registra las funciones. Consultá [.env.example](.env.example) para ver los nombres de las variables.

| Configuración | Ámbito |
| --- | --- |
| `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_KEY` | Build del frontend. Usá la clave publishable de Casa Central. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `WORKER_SECRET` | Solo funciones Netlify. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_VERSION`, `META_APP_SECRET` | Solo funciones Netlify. Usá una configuración de Meta dedicada. |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_VISION_MODEL` | Solo funciones Netlify. Seleccioná modelos compatibles con Responses, y con imágenes para visión. |
| `MENU_PHOTO_STORAGE_ENABLED`, `MENU_PHOTO_BUCKET`, `MENU_PHOTO_RETENTION_DAYS` | Opciones de almacenamiento privado de fotografías. |

En el sitio de prueba, configurá en Meta la URL HTTPS de `/.netlify/functions/whatsapp`, el token de verificación y la suscripción a mensajes. Verificá el webhook y la validación de firma con el número de prueba de Casa Central. Conservá inicialmente `BOT_ENABLED=false`, `WHATSAPP_SEND_ENABLED=false` y `AI_IMAGE_ENABLED=false`. Habilitá cada integración por separado cuando esté validada y autorizada. Las propuestas del reconocimiento se revisan y publican desde el CRM.

## Pruebas

`pnpm build` genera la demo. `node --test tests/casa-central.test.mjs` ejecuta las comprobaciones dirigidas de Casa Central con PGlite y transporte simulado. `pnpm test` incluye la suite heredada. Para los casos de navegador usá `CHROMIUM_PATH` con la ruta del ejecutable de Chromium. GitHub Actions tiene el workflow de build y pruebas en `.github/workflows/test.yml`.
