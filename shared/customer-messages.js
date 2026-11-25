import {commercialText,productName} from './catalog.js';
import {WEEK_DAYS,deliveryMode} from './settings.js';

const queryWords=new Set(commercialText('que cual cuales tambien mas tienen tiene tenés hay habra tendran tendria venden vende disponible queda quedan agotó agotado terminó esta estan puedo podria podes favor porfa porfavor gracias hola buenas saber saberlo me decime decir decirme el la lo los las les se a con para quiero quisiera hoy ahora todavía ya o y e por su ustedes consulta consultar necesito solo solamente buffet').split(' '));
const time=value=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function availabilityReply(found){
 const unknown=found.unknown.filter(word=>!queryWords.has(word));
 if(!found.matches.length&&!found.ambiguous.length||unknown.length)return 'No identifiqué ese plato en el menú publicado de hoy. Escribí MENÚ para ver las opciones.';
 if(found.ambiguous.length)return '¿Cuál querés consultar? '+[...new Set(found.ambiguous.flatMap(match=>match.products.map(productName)))].join(', ')+'.';
 return found.matches.map(({product})=>productName(product)+(product.available?' está disponible en el menú de hoy.':' no está disponible en el menú de hoy.')).join('\n');
}

export function paymentChoice(text,settings){
 if(/[?¿]/.test(text)||/\b(?:no|sin|puedo|podria|quizas|tal vez)\b/.test(commercialText(text)))return null;
 const value=commercialText(text),prefix=/^(?:pago|pagare|voy a pagar|quiero pagar|prefiero pagar)(?: con| por| en)?\s+/;
 if(!prefix.test(value))return null;
 return settings.payment_methods?.find(method=>commercialText(method)===value.replace(prefix,'').replace(/ (?:por favor|gracias)$/,''))||null;
}

export function informationReply(topic,settings){
 const payments=settings.payment_methods?.length?'Podés pagar con: '+settings.payment_methods.join(', ')+'.':'El equipo debe confirmar los métodos de pago disponibles.';
 if(topic==='payments')return payments;
 if(topic==='location')return settings.business_address?'Dirección de referencia: '+settings.business_address+'. El equipo puede confirmar la ubicación exacta.':'El equipo puede compartirte la dirección del local.';
 const hours=settings.schedules?.buffet,days=WEEK_DAYS.filter(day=>hours?.days?.includes(day.value)).map(day=>day.label).join(', ');
 const attention=days&&time(hours.open)&&time(hours.close)?'Atención: '+days+', '+hours.open+'–'+hours.close+'.':'Horario de atención pendiente de confirmación.';
 const mode=deliveryMode(settings,'buffet');
 const delivery=mode==='disabled'?'Delivery deshabilitado para el buffet.':mode==='scheduled'&&time(hours?.delivery_open)&&time(hours?.delivery_close)?'Horario de delivery: '+hours.delivery_open+'–'+hours.delivery_close+'. El equipo confirma disponibilidad y costo.':'El equipo debe confirmar la disponibilidad, el horario y el costo de delivery.';
 if(topic==='fulfillment')return 'Podés solicitar retiro en el local. '+delivery;
 return [attention,delivery,...(topic?[]:[payments])].join('\n');
}
