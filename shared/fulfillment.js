import {categoryKey} from './catalog.js';
import {fulfillmentChoice as exactChoice} from './order-engine.js';

const mentions=/\b(?:voy a retirar|vamos a retirar|paso a buscar|paso a retirar|voy a buscar|vamos a buscar|voy a pasar a buscar|lo retiro|los retiro|retiro en el local|retirar en el local|para retirar|para llevar|para retiro|retiro|retirar|retirarlo|retiramos|retirare|recogerlo|buscarlo|envio a domicilio|a domicilio|para delivery|delivery|envialo a casa|traemelo a casa)\b/g;
const delivery=/delivery|domicilio|envialo a casa|traemelo a casa/;
const negative=/(?:^|\b)(?:no|sin|nunca)\s+(?:(?:voy|vamos|va|quiero|queremos|prefiero|necesito|pienso|me|te|interesa|interesan|gustaria|gusta|es|sera|seria|a|el|mi|pedido|para|por|favor)\s+)*$/;

export function fulfillmentIntent(text){
 const value=categoryKey(text),found=[...value.matchAll(mentions)];
 const options=[];
 for(const hit of found){
  const prefix=value.slice(0,hit.index).split(/[,.;!?]|\b(?:pero|sino|en cambio)\b/).at(-1);
  const suffix=value.slice(hit.index+hit[0].length);
  if(!negative.test(prefix)&&!/^\s*[,]?\s+no\b/.test(suffix))options.push(delivery.test(hit[0])?'delivery':'retiro');
 }
 const choices=[...new Set(options)],question=/^(?:(?:que|cual|cuales|a que|en que) )?(?:horarios?|precios?|tarifas?|costos?)\b|\b(?:a que hora|que horario|hasta que hora)\b/.test(value)||/[?¿]/.test(value)||/\b(?:no se|todavia no se|tal vez|quizas|puedo|podria|podemos|se puede|si elijo|tienen|tenes|ofrecen|hacen|hay|cuanto|consultar|consulto)\b/.test(value);
 const exact=exactChoice(text);
 return {choice:!question&&choices.length===1?choices[0]:!question&&!found.length&&exact==='local'?'retiro':null,mentioned:found.length>0,ambiguous:choices.length>1,question};
}
export const fulfillmentChoice=text=>fulfillmentIntent(text).choice;
export function stripFulfillment(text){
 const value=String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(),state=fulfillmentIntent(text);if(!state.choice)return text;
 return value.replace(mentions,(match,offset)=>{const prefix=value.slice(0,offset).split(/[,.;!?]|\b(?:pero|sino|en cambio)\b/).at(-1);return negative.test(prefix)?match:' ';});
}
