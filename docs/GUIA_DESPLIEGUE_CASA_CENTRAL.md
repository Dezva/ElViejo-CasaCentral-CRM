# Guía de despliegue de Buffet El Viejo — Casa Central

Usá un proyecto Supabase, un sitio Netlify y un número de prueba propios de Casa Central. La rama para **Production branch** en Netlify es `release/casa-central-buffet`. En esta guía, el primer sitio publicado es de **prueba aislada**, aunque Netlify llame a ese contexto *Production*. La activación para clientes requiere la aprobación del responsable. Podés completar todas las etapas desde los paneles web con los archivos del repositorio.

## A. Supabase

1. En Supabase, creá un proyecto nuevo para Casa Central. En **SQL Editor → New query**, pegá y ejecutá el contenido completo de un archivo por consulta. Esperá el resultado de cada consulta antes de pasar al siguiente.
2. Ejecutá los archivos de la carpeta `database/` en este orden:

   1. `001_base_crm.sql`
   2. `002_guarnipitan.sql`
   3. `005_eliminacion_admin.sql`
   4. `006_ubicaciones_delivery.sql`
   5. `007_el_viejo.sql`
   6. `009_v11_fiabilidad.sql`
   7. `010_buffet_categories.sql`
   8. `011_configuracion_ux.sql`
   9. `013_metricas_ia.sql`
   10. `014_avisos_pedidos.sql`
   11. `015_historial_casa_central.sql`
   12. `016_pedidos_finanzas_buffet.sql`

   Omití 003, un marcador histórico, y 004, un ejemplo de alta. Los números 008 y 012 correspondían al catálogo de chipería excluido de Casa Central. Los nombres internos históricos identifican estructuras reutilizadas. Para fotos privadas aplicá, al final, `database/storage/001_menu_private_bucket.sql` y confirmá en **Storage** que el bucket `el-viejo-menu-private` es privado.

3. En **Authentication → Users**, invitá a la persona administradora o creá su usuario según el procedimiento interno. Copiá su UUID. En **SQL Editor**, pegá esta consulta y reemplazá los dos marcadores por el UUID y el nombre de la persona:

   ```sql
   insert into public.crm_members (user_id, display_name, role, menu_editor)
   values ('UUID-DEL-USUARIO', 'NOMBRE-DE-LA-PERSONA', 'admin', true);
   ```

   Si Auth reconoce la cuenta pero el CRM dice que no es integrante, verificá que el UUID corresponde al mismo proyecto. Si la consulta devuelve un duplicado, revisá el registro existente en **Table Editor → crm_members**.

4. Antes de ingresar datos de prueba, ejecutá estas consultas de lectura:

   ```sql
   select to_regclass('public.crm_members') as integrantes,
          to_regclass('public.viejo_menus') as menus,
          to_regclass('public.guarni_orders') as pedidos,
          to_regprocedure('public.viejo_pending_orders()') as rpc_pendientes;
   select count(*) as productos from public.guarni_catalog;
   select count(*) as pedidos from public.guarni_orders;
   select role, menu_editor from public.crm_members;
   select tablename, rowsecurity from pg_tables
   where schemaname='public'
     and tablename in ('crm_members','viejo_menus','guarni_orders','guarni_messages');
   ```

   Las relaciones y la RPC deben existir, los conteos deben dar cero, el administrador debe figurar con permiso de menú y `rowsecurity` debe ser verdadero. Si falta una tabla, revisá el primer error de migración antes de continuar. El SQL Editor usa un rol privilegiado. La prueba de permisos del CRM se hace también con cuentas de distinto rol en la etapa C.

5. En **Project Settings → API Keys**, copiá la URL del proyecto y las claves **Publishable** y **Secret** a tu gestor autorizado. La publishable empieza por `sb_publishable_` y la secret por `sb_secret_`. No uses la contraseña de PostgreSQL como clave API. Revisá el plan de copias de seguridad de Supabase. Incluí Storage si usás fotos privadas y verificá la restauración en un proyecto aislado.

## B. Netlify

1. En **Add new project → Import an existing project**, elegí GitHub y `Dezva/ElViejo-CasaCentral-CRM`. En la configuración de despliegue continuo, elegí `release/casa-central-buffet` en **Production branch**. Si el panel muestra la rama predeterminada antigua, cambiala antes de publicar. Si el propietario decide actualizar GitHub, debe ir a **Settings → General → Default branch**, seleccionar la rama estable y confirmar.
2. Conservá el comando `npm run build`, el directorio publicado `dist` y las funciones en `netlify/functions`, definidos en `netlify.toml`. Elegí Node.js 24 para el build, mediante `NODE_VERSION=24` si el sitio aún usa otra versión.
3. En **Project configuration → Environment variables**, configurá el contexto del sitio de prueba. Separá los ámbitos:

   | Variables | Origen y ámbito |
   | --- | --- |
   | `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_KEY` | La URL del proyecto nuevo y su clave publishable. Builds y Functions. |
   | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | La misma URL y la clave secret. Solo Functions. |
   | `WORKER_SECRET` | Valor aleatorio de alta entropía generado con el gestor autorizado. Solo Functions. |
   | `BOT_ENABLED`, `WHATSAPP_SEND_ENABLED`, `AI_IMAGE_ENABLED` | Guardá explícitamente `false` en Functions. Activá cada puerta en su etapa autorizada. |
   | `MENU_PHOTO_STORAGE_ENABLED` | `false` hasta preparar el bucket privado. Luego `true` en Functions. |
   | `MENU_PHOTO_BUCKET`, `MENU_PHOTO_RETENTION_DAYS` | Opcionales en Functions. Usá el nombre del bucket instalado. La retención indica cuándo revisar la conservación, sin borrado automático. |

   Netlify proporciona `URL` para el despacho programado. Usá el dominio del sitio de prueba y evitá redirecciones en la ruta del worker. Ante cambios en variables o ámbitos, generá un nuevo despliegue del sitio aislado.

4. Desde **Deploys**, comprobá que coinciden rama y commit. Abrí el CRM y `/.netlify/functions/health` en el mismo sitio. Un GET exitoso prueba que la función responde. El JSON separa cada integración:

   | Estado | Interpretación |
   | --- | --- |
   | `not_configured` | Faltan las variables nombradas en `missing`. |
   | `invalid_configuration` | Revisá el tipo de clave pública o el formato HTTPS de la URL de IA. |
   | `disabled` | La puerta está apagada intencionalmente. |
   | `configured` / `not_checked` | Hay configuración. Falta una comprobación de conexión. |
   | `verified` / `connection_error` | El POST de diagnóstico verificó lectura y RPC de Supabase, o falló al conectarse o al consultar. |

   Para el equipo técnico, el POST de salud exige `Authorization: Bearer <JWT de sesión del administrador>`. Ejecuta una lectura de configuración y una RPC de solo lectura. Evitá pegar el token en URL, tickets o capturas. El equipo que solo usa paneles puede verificar el acceso y las RPC desde el CRM en las etapas C y F. La clave privada se usa en `apikey` desde Functions, mientras que la sesión de usuario usa `Authorization`. Si el CRM aparece en demo, verificá ambas variables públicas en **Builds** y volvé a desplegar. Si hay un 401, volvé a iniciar sesión y revisá que coincidan el proyecto del frontend y el backend.

5. En **Functions**, revisá este inventario y los registros:

   | Ruta bajo `/.netlify/functions/` | Cómo verificarla en el sitio de pruebas |
   | --- | --- |
   | `api` (también `/api`) | Iniciá sesión, abrí menús y pedidos y probá las operaciones de C y F. Un acceso sin sesión debe dar 401. |
   | `health` | GET de presencia y configuración. POST administrativo para Supabase. |
   | `menu-recognize` | Propuesta de foto completa con permiso de menú. Requiere la etapa D. |
   | `menu-photo` | Guardá un borrador con foto y volvé a abrirlo. Si activaste Storage, verificá el archivo en el bucket privado y su acceso desde la sesión. |
   | `whatsapp` | GET de presencia, verificación de Meta y eventos de la etapa E. |
   | `dispatch-background` | Worker protegido por `WORKER_SECRET`. Verificá registros y efecto sobre la cola con un mensaje de prueba. |
   | `sweep` | Programada cada minuto. `dispatch_accepted` significa que se aceptó el despacho. Confirmá el procesamiento observando el trabajo en la cola del sitio de pruebas. |

   Netlify ejecuta las funciones programadas automáticamente en despliegues publicados. Un preview puede tener la función sin ejecución automática. Ante `dispatch_error`, revisá la URL del sitio, la ruta, el secreto y los registros del worker. Para comprobar recuperación en el sitio aislado, observá que un mensaje pendiente de una interrupción transitoria pasa a completado cuando el worker vuelve a estar disponible. No alteres filas ni fuerces fallos en producción. La suite comprueba la recuperación de una reserva vencida en PostgreSQL local.

## C. CRM

1. Iniciá sesión como administrador. En **Usuarios**, agregá una segunda cuenta de Auth con rol empleado. Comprobá que pueda abrir el CRM y que no pueda administrar usuarios ni guardar la configuración. Asignale permiso de menú únicamente si corresponde y comprobá que pueda publicar con ese permiso.
2. En **Configuración**, ingresá solo datos confirmados. Dejá en blanco días y horarios, tarifas y pagos sin confirmación. Conservá delivery pendiente si falta coordinación. La dirección precargada es una referencia por confirmar.
3. En **Menú del buffet**, cargá una foto de prueba y agregá platos manualmente. Guardá un borrador, volvé a abrirlo, revisá platos y categorías, y marcá la revisión antes de publicar. Probá marcar uno agotado. Si el botón de publicación no aparece, revisá el permiso. Si falla la foto, confirmá formato PNG/JPEG/WebP, máximo 3 MB y estado privado del bucket cuando corresponda.

## D. OpenAI

1. Con autorización explícita para realizar una prueba integrada y consumir tokens, creá una clave de un proyecto de prueba en el panel de OpenAI. En **Netlify → Environment variables → Functions**, guardá `AI_API_KEY`, `AI_MODEL` y `AI_VISION_MODEL`. El modelo conversacional debe admitir Responses y salida estructurada, y el de visión también debe admitir imágenes. `AI_BASE_URL` puede quedar vacío para usar OpenAI o contener la base HTTPS del proveedor compatible, sin `/responses` al final. Se admiten los alias `OPENAI_API_KEY`, `OPENAI_MODEL` y `OPENAI_VISION_MODEL`. Las variables `AI_*` prevalecen.
2. En el sitio aislado, activá `AI_IMAGE_ENABLED=true` y desplegá. Dejá bot y envío de WhatsApp en `false` si solo estás probando visión. Entrá al CRM con permiso de menú, cargá una foto completa y elegí **Analizar menú con IA**. Usá una foto autorizada que aún no se haya analizado para probar una inferencia nueva. Compará cada plato y categoría con la imagen. La propuesta requiere revisión y publicación humana. El botón de análisis por sí solo no publica.
3. Si falta una variable, completala en Functions. Para `ai_authentication`, revisá credencial, proyecto y permisos. Para `ai_model_or_format`, verificá el nombre exacto y las capacidades del modelo. Para `ai_quota` o `ai_rate_limit`, revisá saldo, cuotas o frecuencia antes de reintentar. Para `vision_timeout` o `vision_network`, revisá conexión y disponibilidad. Ante una respuesta inválida o incompleta, conservá el borrador y transcribí manualmente si hace falta.
4. La prueba conversacional se hace en E y F con un mensaje que requiera interpretación, por ejemplo una cantidad más una nota sobre un plato publicado. Una bienvenida o un pedido resuelto por reglas puede funcionar sin llamar al modelo. Verificá que se registró uso de la operación `conversation` en `viejo_ai_usage` si el proveedor informa métricas. CI usa proveedores simulados. La prueba manual por terminal, si el equipo técnico la requiere, está en `scripts/vision-smoke.mjs` y exige autorización explícita.

## E. WhatsApp

1. En **Meta for Developers**, seleccioná o creá una aplicación del negocio para Casa Central y agregá WhatsApp. En **WhatsApp → API Setup**, seleccioná el número de prueba, copiá el **Phone Number ID** y agregá un destinatario de prueba autorizado si Meta lo exige.
2. En Netlify, copiá el ID a `WHATSAPP_PHONE_NUMBER_ID` y el token autorizado para ese número a `WHATSAPP_TOKEN`. En Meta **App settings → Basic**, obtené el **App Secret** y guardalo como `META_APP_SECRET`. Generá un Verify Token propio y guardalo como `WHATSAPP_VERIFY_TOKEN`. En `WHATSAPP_GRAPH_VERSION`, usá la versión vigente aprobada para la app en formato `vNN.N`. Guardá todo en Functions. Revisá vencimiento del token y permisos del activo.
3. En **WhatsApp → Configuration**, registrá la URL HTTPS del sitio seguida de `/.netlify/functions/whatsapp`. Introducí el mismo Verify Token. Guardá y suscribí el campo **messages** del objeto **WhatsApp Business Account** para ese número. Un GET normal solo prueba presencia. La validación de Meta debe devolver su desafío y la recepción real debe producir un POST firmado.
4. Enviá un mensaje desde el destinatario de prueba y comprobá que aparece en **Conversaciones**. Si no llega, revisá la suscripción, el Phone Number ID, la firma y los registros de Functions. Para verificar envío, con autorización de prueba habilitá `WHATSAPP_SEND_ENABLED=true`, desplegá, iniciá una conversación desde el teléfono de prueba y respondé desde el CRM. Confirmá que llega al teléfono. Si falla, revisá ID, versión, token, destinatario, permisos y ventana de atención.
5. Compartí un punto desde WhatsApp y verificá el mapa y la referencia en el pedido. Tomá la conversación y comprobá que el bot no contesta hasta liberarla. Dentro de la ventana de atención de **24 horas** desde el último mensaje del cliente se pueden enviar respuestas de texto libre. Fuera de esa ventana Meta restringe el envío y esta versión no incluye plantillas aprobadas ni un flujo de envío por plantillas. Pedí al destinatario de prueba que inicie una nueva conversación antes de reintentar.

## F. Validación de extremo a extremo

1. Publicá un menú ficticio en el sitio aislado. Para probar el asistente con autorización, activá `BOT_ENABLED=true` en Functions y habilitalo en **Configuración** del CRM. Iniciá el chat desde el número de prueba.
2. Consultá el menú y pedí dos platos con cantidades. Probá un agotado. Completá una solicitud de retiro y otra de delivery enviando un punto válido de WhatsApp (referencia escrita opcional). Verificá que aparecen como pendientes, sin precio automático.
3. Tomá la conversación, coordiná importe y disponibilidad y confirmá cada pedido. En delivery, ingresá explícitamente el costo. Verificá el cambio de estado, el historial y, si el envío se autorizó, la recepción en el teléfono.
4. Verificá que el empleado con permiso puede publicar, que un usuario sin el permiso no puede hacerlo y que el administrador conserva el acceso a configuración. Revisá el sitio en móvil.
5. Registrá en el [checklist](CHECKLIST_DESPLIEGUE_CASA_CENTRAL.md) la evidencia de cada etapa. Anotá la rama, el commit y el contexto, sin incluir claves, sesiones ni datos personales.

## G. Activación

Mantené `BOT_ENABLED`, `WHATSAPP_SEND_ENABLED` y `AI_IMAGE_ENABLED` en `false` en cualquier contexto que aún no haya sido aprobado. Para habilitar atención al público, confirmá con el responsable los datos comerciales, las pruebas integradas, los permisos, el número, el presupuesto de IA, las copias de seguridad y la protección de credenciales. Habilitá cada puerta en su ámbito y volvé a verificarla. Los cambios de la puerta del bot se coordinan con su opción en el CRM. La recepción del webhook depende de la suscripción de Meta. Para detener recepción en un entorno de prueba, retirala desde Meta.
