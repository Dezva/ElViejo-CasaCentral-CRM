import {categoryKey} from './catalog.js';
export const hasDeliveryReference=cart=>typeof cart?.address==='string'&&cart.address.trim().length>=3;
export const deliveryReadyPrompt='Ya recibí tu ubicación 📍. Escribí CONFIRMAR PEDIDO para enviar tu solicitud al local. La referencia adicional es opcional.';
export function deliveryQueryRequested(text){
 const t=categoryKey(text),referenceStatus=/\breferencia\b/.test(t)&&(/^(?:que|cual|como|no|ya|sin|falta)\b/.test(t)||/[?¿]/.test(String(text||''))||t==='referencia');
 return referenceStatus||/\b(?:ubicacion|localizacion)\b/.test(t)||/\bno (?:te )?(?:estoy |estaba )?pidiendo\b.*\b(?:horario|informacion)\b/.test(t)||/\bya\b.*\b(?:envi\w*|mand\w*|pase|comparti\w*)\b/.test(t);
}
export function deliveryStatusCommand(text,cart){
 if(cart?.fulfillment!=='delivery'||!cart.items?.length||!deliveryQueryRequested(text))return null;
 return {intent:'status_reply',message:cart.delivery_location_id?deliveryReadyPrompt:'Todavía falta una ubicación puntual válida de WhatsApp para este delivery. Enviá el punto desde Adjuntar → Ubicación. La referencia escrita es opcional.'};
}
export function registeredDeliveryCommand(order,cart){
 if(cart.delivery_location_id)return {intent:'status_reply',message:'Recibí tu nueva ubicación. Decime los productos y cantidades para preparar la solicitud.'};
 if(order&&['delivered','cancelled','rejected'].includes(order.status))return {intent:'status_reply',message:'La última solicitud #'+order.number+' ya está finalizada. Su ubicación pertenece a ese pedido anterior. Para preparar otro delivery, decime los productos y compartí un nuevo punto.'};
 if(order?.fulfillment==='delivery')return {intent:'status_reply',message:order.delivery_location_id?'Tu solicitud #'+order.number+' ya tiene la ubicación asociada. No hace falta reenviarla ni agregar una referencia. El equipo gestiona su entrega.':'La solicitud #'+order.number+' todavía necesita un punto válido de WhatsApp para el delivery. Enviá el punto desde Adjuntar → Ubicación.'};
 return {intent:'status_reply',message:cart.delivery_location_id?'Recibí tu ubicación. Decime los productos y cantidades para preparar una nueva solicitud.':'Para preparar un delivery, decime los productos y cantidades y compartí un punto válido desde Adjuntar → Ubicación. La referencia escrita es opcional.'};
}
export function deliveryReferenceCommand(text,cart){
 if(cart?.fulfillment!=='delivery'||!cart.items?.length)return null;
 const value=String(text||'').trim(),t=categoryKey(value);
 if(!/^(?:referencia|porton|frente|al lado|casa|calle|avenida|barrio|detras|esquina)\b/.test(t))return null;
 if(value.length<3||value.length>500||/^(?:hola|buenas|gracias|ok|dale|listo|si|no|no se|nose|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|confirmar pedido|confirmo pedido|delivery|retiro|menu|catalogo|carta)[.!?]*$/.test(t)||value.startsWith('/')||/[?¿]/.test(value))return null;
 return {intent:'summary',address:value};
}
// Solo la fila consultada por ID y conversación puede hidratar el punto del borrador.
export function hydrateDeliveryLocation(cart,point){
 const result={...cart,delivery_location_id:point?.id||null};
 if(result.address_location_id&&result.address_location_id!==point?.id){result.address='';result.address_location_id=null;}
 if(point&&!hasDeliveryReference(result)&&typeof point.address==='string'&&point.address.trim().length>=3){result.address=point.address.trim().slice(0,500);result.address_location_id=point.id;}
 return result;
}
