import {categoryKey} from './catalog.js';
export function orderStatusRequested(text){const t=categoryKey(text);return /\b(?:pedido|solicitud|carrito)\b/.test(t)&&/\b(?:tienes|tenes|tengo|esta|quedo|estado|como|va|almacenad\w*|guardad\w*|registrad\w*|recibier\w*|confirmad\w*|envie|hice|falta)\b/.test(t);}
export function registeredOrderCommand(text,order){
 if(!orderStatusRequested(text))return null;
 if(!order)return {intent:'status_reply',message:'No veo una solicitud registrada en esta conversación. Decime los productos y cantidades que querés pedir.'};
 const labels={draft:'en borrador',needs_info:'pendiente de información',pending:'pendiente de aceptación del local',accepted:'confirmada por el local',preparing:'en preparación',ready:order.fulfillment==='retiro'?'lista para retirar':'lista para el envío',out_for_delivery:'en reparto',delivered:order.fulfillment==='retiro'?'retirada':'entregada',cancelled:'cancelada',rejected:'rechazada'};
 return {intent:'status_reply',message:'La última solicitud registrada es la #'+order.number+' de buffet: '+(labels[order.status]||'en revisión del equipo')+'.'+(order.status==='pending'?' El equipo todavía debe confirmar disponibilidad, entrega y total.':'')};
}
