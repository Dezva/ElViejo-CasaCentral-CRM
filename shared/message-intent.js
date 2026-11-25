import {commercialText,categoryKey} from './catalog.js';
import {isConfirmation} from './order-engine.js';
import {fulfillmentIntent} from './fulfillment.js';
import {orderStatusRequested} from './order-status.js';

export const removal=/\b(?:quita|saca|elimina|borra)(?:me|r(?:me)?|lo|la|los|las)?\b/;
const availabilityWords=/\b(?:tienen|tiene|tene|tenes|hay|habra|tendran|tendria|venden|vende|disponible|queda|quedan|agoto|agotado|termino)\b/;
const hoursWords=/\b(?:horario|atienden|atiende|abren|abre|cierran|cierra|abierto|abierta|cerrado|cerrada|hasta que hora|a que hora)\b/;
const paymentWords=/\b(?:pago|pagar|forma pago|metodo pago|transferencia|tarjeta|efectivo|qr)\b/;
const locationWords=/\b(?:donde|direccion|ubicados|ubicado|local|ubicacion)\b/;
const tentative=/\b(?:capaz|quizas|tal vez|estoy pensando|no se si|todavia no decidi|todavia no confirmo|aun no confirmo)\b/;
const requestOpening=/^(?:(?:hola|buena(?: tarde| noch)?|buen(?:o)? dia|por favor) )+/;
const politeOrder=/^(?:(?:me |nos )?(?:pode|puede|pueden|podria|podrian) )?(?:me |nos )?(?:(?:anota|prepara|agrega|suma|saca|quita|pone)(?:me|r(?:me)?)?)\b/;

export function humanRequested(text){
 const t=categoryKey(text);
 if(/\bno (?:quiero|necesito|deseo)\b.*\b(?:humano|persona|encargado|empleado|hablar)\b/.test(t))return false;
 if(/^(?:(?:un|una|el|la) )?(?:humano|persona|encargado|empleado|atencion humana)[.!?]*$/.test(t))return true;
 return /\b(?:hablar|comunicarme|pasame|contactar|que me atienda|quiero|necesito|prefiero)\b.*\b(?:humano|persona|encargado|empleado|alguien del equipo|hablar con alguien)\b/.test(t)||/\b(?:hablar|comunicarme|pasame)\b.*\b(?:alguien|equipo|local)\b/.test(t);
}

function dailyMenuRequested(text){
 const subject=text
  .replace(requestOpening,'')
  .replace(/\bpor favor\b/g,'').replace(/ gracias$/,'').replace(/\s+/g,' ').trim()
  .replace(/^(?:quiero|quisiera|necesito|me gustaria) /,'')
  .replace(/^(?:que me (?:diga|digan|muestre|muestren|pase|pasen|mande|manden|envie|envien)|(?:me )?(?:mostra|pasa|manda|envia|comparti)|mostrame|pasame|mandame|enviame|compartime|decime|ver|consultar|conocer|saber) /,'');
 return /^(?:(?:el|la) )?(?:menu|carta|catalogo)(?: (?:buffet|hoy|dia)){0,2}$/.test(subject);
}

// Intenciones lingüísticas generales; no contiene nombres de alimentos ni equivalencias.
export function messageIntent(text,{hasProducts=false}={}){
 const t=commercialText(text),raw=categoryKey(text);
 if(isConfirmation(text))return {kind:'confirmation'};
 if(/^(?:\/cancelar|\/reiniciar|cancelar (?:el )?pedido|cancela (?:el )?pedido)$/.test(raw))return {kind:'cancellation'};
 if(humanRequested(text))return {kind:'human'};
 if(/^(?:(?:muchas?|muchisimas?) )?(?:gracias|perfecto|perfecta|genial|excelente|entendido|de acuerdo|esta bien|ok|okay|dale|listo|bueno|hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches)(?: (?:gracias|por todo|por la ayuda|igualmente|hasta luego))?$/.test(t))return {kind:'social'};
 if(orderStatusRequested(text))return {kind:'query',topic:'status'};
 if(dailyMenuRequested(t))return {kind:'query',topic:'menu'};
 if(tentative.test(t))return {kind:'uncertain'};
 const change=removal.test(t)||/\b(?:(?:agrega|suma|cambia)(?:me|r(?:me)?)?|anade|anadi|anadir|corrige|corregi|en total|al final)\b/.test(t);
 const request=/\b(?:quiero|quisiera|querria|dame|deme|necesito|llevo|voy a llevar|voy a querer|me das|me darias|pedir)\b/.test(t);
 if(request&&!hasProducts&&!/\b(?:\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/.test(t)&&/\b(?:ayuda|ayudarme|informacion|explicar|explicame|entender|repetir|repitas|mensaje|responder|respuesta)\b/.test(t))return {kind:'query',topic:'general'};
 const mode=fulfillmentIntent(text);
 // Una corrección sobre retiro/delivery prevalece sobre palabras de consultas negadas.
 if(mode.choice&&!hasProducts&&!change)return {kind:'fulfillment'};
 const requestsChange=politeOrder.test(t.replace(requestOpening,''))||/\b(?:me das|me daria|dame|deme|llevo|voy a llevar|voy a querer)\b/.test(t);
 const asksAddress=/\b(?:pasan|pasa|comparti|mandan|manda|envian|envia) (?:la )?(?:direccion|ubicacion)\b/.test(t);
 const query=/[?¿]/.test(String(text))||/\b(?:quiero|quisiera|necesito|me gustaria) (?:saber|ver|consultar|entender|conocer|preguntar)\b/.test(t)||/\b(?:acepta|aceptan|reciben|ofrecen|hacen|cuanto|donde|puedo|se puede|forma pago|metodo pago)\b/.test(t)||
  availabilityWords.test(t)||hoursWords.test(t)||asksAddress;
 if(query&&!requestsChange){
  if(hoursWords.test(t))return {kind:'query',topic:'hours'};
  if(paymentWords.test(t))return {kind:'query',topic:'payments'};
  if(locationWords.test(t)&&!hasProducts&&!/\b(?:ya|envie|enviada|mande|mandada|recibi\w*|mi ubicacion|mi pedido|delivery)\b/.test(t))return {kind:'query',topic:'location'};
  if(/\b(?:retiro|retirar|buscar|para llevar|delivery|domicilio|envio|mandar a casa)\b/.test(t)&&!hasProducts&&!/\b(?:precio|costo|cuanto)\b/.test(t))return {kind:'query',topic:'fulfillment'};
  if(/\b(?:precio|cuanto|cuesta|sale|costo|tarifa|valor|cotizacion|presupuesto|kilo)\b/.test(t))return {kind:'query',topic:'price'};
  if(/\b(?:menu|catalogo|carta|clase|tipo|que .*venden|que .*tienen|que .*hay)\b/.test(t))return {kind:'query',topic:'menu'};
  if(availabilityWords.test(t))return {kind:'query',topic:'availability'};
  return {kind:'query',topic:'general'};
 }
 if(/^(?:horarios?|forma pago|metodo pago)$/.test(t))return {kind:'query',topic:t.startsWith('horario')?'hours':'payments'};
 if(change)return {kind:'modification'};
 if(request||requestsChange||/^(?:\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b\s+\S/.test(t))return {kind:'purchase'};
 if(hasProducts)return {kind:'product_mention'};
 return {kind:'unknown'};
}

export const isPurchaseAttempt=(text,options)=>['purchase','modification'].includes(messageIntent(text,options).kind);
