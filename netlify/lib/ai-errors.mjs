// Never expose upstream messages or request data in deployment diagnostics.
export async function aiProviderFailure(response) {
  const data = await response.json().catch(() => null);
  const upstream = data?.error?.code;
  if (response.status === 401 || response.status === 403) {
    return { code: 'ai_authentication', message: 'El proveedor rechazó la credencial o sus permisos.', status: 502 };
  }
  if (upstream === 'insufficient_quota' || upstream === 'billing_hard_limit_reached' || response.status === 402) {
    return { code: 'ai_quota', message: 'Revisá el saldo y los límites del proyecto de IA.', status: 503 };
  }
  if (response.status === 429) {
    return { code: 'ai_rate_limit', message: 'El proveedor limitó las solicitudes. Esperá antes de reintentar.', status: 503 };
  }
  if (response.status === 404 || upstream === 'model_not_found' || response.status === 400 || response.status === 422) {
    return { code: 'ai_model_or_format', message: 'Revisá que el modelo esté disponible y acepte Responses y el formato solicitado.', status: 502 };
  }
  return { code: 'ai_unavailable', message: 'El proveedor de IA no pudo procesar la solicitud.', status: 502 };
}
