# Checklist de entrega — Casa Central

Marcá cada paso con evidencia del despliegue aislado. La columna de cobertura describe lo que puede comprobarse localmente o en CI.

| Elemento | Cobertura automatizada | Confirmación del equipo |
| --- | --- | --- |
| Repositorio y rama estable | Commit validado por el workflow de la rama | Revisar rama y commit en Netlify |
| Build y GitHub Actions | Instalación, build y suite completa | Consultar ejecución del commit publicado |
| Supabase independiente y migraciones | Instalación limpia en PGlite, RPC y ausencia de semillas comerciales | Crear proyecto exclusivo y verificar SQL Editor |
| Administrador, autenticación y permisos | Sesiones y roles simulados, RLS en PGlite | Probar cuentas distintas en Supabase Auth y CRM |
| Netlify y variables | Funciones probadas localmente y clave privada fuera del build | Verificar despliegue y ámbitos en Functions y Builds |
| Worker y recuperación programada | Despacho protegido y recuperación de reserva vencida en PGlite | Verificar cron y trabajos con el sitio aislado publicado |
| OpenAI conversacional | Modelo y fallos simulados | Autorizar y probar una solicitud que requiera interpretación |
| OpenAI visión y fotos | Imagen, propuesta, permisos y almacenamiento simulados | Autorizar foto completa con proveedor real y revisar la propuesta |
| WhatsApp y webhook | Verificación, firma, persistencia y envío simulado | Suscribir y comprobar recepción y envío con teléfono de prueba |
| Ubicaciones y pedidos | Retiro, delivery, ubicación y estado en PGlite y navegador | Probar ubicación real y pedido de entrega en entorno aislado |
| Confirmación humana | Importes manuales, costo de envío y permisos | Tomar conversación, confirmar y comprobar historial |
| Configuración comercial | Valores pendientes y guardado por administrador | Confirmar dirección, horarios, tarifas, pagos y contacto |
| Copias de seguridad | Procedimiento documentado | Revisar plan, cobertura de Storage y recuperación aislada |
| Protección de secretos | Encabezados comprobados y diagnóstico sin credenciales | Revisar permisos, ámbitos, rotación y gestor seguro |

La activación real, los envíos, las inferencias con costo y la validación contra Supabase alojado quedan pendientes de autorización y pruebas integradas.
