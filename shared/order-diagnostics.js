import {matchCommercial,orderFillers,quantityWords} from './catalog-matching.js';
import {productName} from './catalog.js';
import {retryOrderCommand} from './order-retry.js';
import {isPurchaseAttempt} from './message-intent.js';

export function unavailableReason(product){
 const name=productName(product);
 return name+(product.category_id==='pending'?' está pendiente de revisión.':' está agotado o no disponible en el menú de hoy.');
}

export function quantityProblem(text){
 return /(?:^|\s)-\s*\d|\d+[.,]\d+/.test(String(text))?'Las cantidades deben ser unidades enteras entre 1 y 30.':null;
}

export function invalidOrderCommand(text,cart,catalog,{reason}={}){
 const found=matchCommercial(text,catalog,{context:cart?.conversation});
 if(!isPurchaseAttempt(text,{hasProducts:!!(found.matches.length||found.ambiguous.length)}))return {intent:'clarify',message:'No entendí bien el mensaje. Tu pedido sigue guardado. ¿Podés explicarme qué necesitás o preferís hablar con el equipo?'};
 if(reason||quantityProblem(text))return retryOrderCommand(reason||quantityProblem(text));
 const blocked=found.matches.filter(m=>!(found.unknown.length&&(m.variantOnly||m.prefixOnly))&&!m.product.available);
 if(blocked.length)return retryOrderCommand([...new Set(blocked.map(m=>unavailableReason(m.product)))].join(' '));
 if(found.matches.some(m=>m.qty<1||m.qty>30))return retryOrderCommand('Las cantidades deben ser unidades enteras entre 1 y 30.');
 const unknownIndices=found.unmatched.filter(i=>!orderFillers.has(found.tokens[i])&&!quantityWords[found.tokens[i]]&&!/^\d+$/.test(found.tokens[i])&&!['al','final','en','total','cambia','cambiar','cambiame','corrige','corregi','no'].includes(found.tokens[i]));
 const hits=[...found.matches,...found.ambiguous],missing=new Set(),uncertain=new Set();
 for(const index of unknownIndices){
  const segment=found.segments.find(part=>index>=part.start&&index<part.end);
  let start=index,end=index+1;
  while(start>segment.start&&!['y','e'].includes(found.tokens[start-1]))start--;
  while(end<segment.end&&!['y','e'].includes(found.tokens[end]))end++;
  const prefix=hits.find(match=>match.prefixOnly&&match.start>=start&&match.end<=end);
  if(prefix){
   uncertain.add(prefix);
   const qualifier=found.tokens.slice(prefix.end,index+1);
   missing.add([...found.tokens.slice(prefix.start,prefix.end),...qualifier].join(' '));
  }else missing.add(found.tokens[index]);
 }
 const known=[...new Set(found.matches.filter(match=>!match.variantOnly&&!uncertain.has(match)).map(match=>productName(match.product)))];
 if(missing.size){
  const label=[...missing].join(', ').slice(0,160);
  return retryOrderCommand((known.length?'Reconocí '+known.join(', ')+', pero no encontré ':'No encontré ')+'«'+label+'» en el menú del buffet de hoy.');
 }
 return retryOrderCommand('No pude identificar con seguridad todos los productos y cantidades de ese pedido.');
}
