import {commercialText,productTerms,productName,sellable} from './catalog.js';
import {matchCommercial,deterministicOrder} from './catalog-matching.js';
const grammatical=new Set('producto productos porfa porfavor podes podria podrias traer traeme pasame preparame enviame mandame favor quiero quisiera necesito gustaria me el la lo los las un una uno y e para a mi agregar agrega agregame dame llevo llevar pedir pedido con sin bien caliente calientes frio fria queso sal azucar por favor gracias'.split(' '));
export function recoverCandidates(text,cart,catalog,{expanded=false}={}){
 if(expanded)return [...catalog];
 const found=matchCommercial(text,catalog),ids=new Set([...(cart?.items||[]).map(x=>x.variant_id),...found.matches.map(m=>m.product.id),...found.ambiguous.flatMap(a=>a.products.map(p=>p.id))]);
 const tokens=commercialText(text).split(' ').filter(t=>t.length>2&&!grammatical.has(t)&&!/^\d+$/.test(t));
 for(const p of catalog){const terms=productTerms(p).join(' ').split(' '),cat=commercialText(p.category||'').split(' ');if(tokens.some(t=>terms.includes(t)||cat.includes(t)))ids.add(p.id);}
 // Sin coincidencias se amplía a todo el catálogo compacto; nunca a los primeros N registros.
 return ids.size?catalog.filter(p=>ids.has(p.id)):[...catalog];
}
export function compactContext(cart,candidates,settings){
 return {service:cart?.service||null,cart:(cart?.items||[]).map(x=>[x.variant_id,x.qty]),products:candidates.map(p=>[p.id,productName(p),p.aliases||[],p.service==='buffet'?!!p.available:sellable(p)]),payments:settings.payment_methods||[]};
}
export function deterministicConversation(text,cart,catalog){
 const t=commercialText(text);
 if(/^(horario|horarios|forma pago|forma pago disponible|metodo pago|metodo pago disponible)$/.test(t))return {intent:'info'};
 const resolved=deterministicOrder(text,cart,catalog);
 if(/\b(precio|cuanto|cuesta|sale|tienen|hay|disponible)\b/.test(t)){
  const f=resolved.found;
  if(cart?.service==='buffet'){
   if(f.ambiguous.length||f.matches.some(m=>!m.product.available))return resolved.command;
   const names=f.matches.map(m=>productName(m.product));
   return {intent:'clarify',message:(names.length?'Disponible: '+names.join(', ')+'. ':'')+'El encargado acuerda los precios finales.'};
  }
  if(f.ambiguous.length||f.matches.some(m=>!sellable(m.product)))return resolved.command?.intent==='clarify'?resolved.command:{intent:'clarify',message:'El equipo debe confirmar la variedad y su disponibilidad.'};
  if(f.matches.length)return {intent:'clarify',message:f.matches.map(m=>productName(m.product)+': '+new Intl.NumberFormat('es-PY').format(m.product.price)+' Gs.').join('\n')+'\nNo agregué productos al carrito.'};
  return {intent:'clarify',message:'¿De qué producto querés consultar el precio?'};
 }
 // «sin …» es una nota que requiere interpretación; las cantidades y equivalencias siguen validadas.
 return resolved.command;
}
export function validateInterpretation(command,text,cart,catalog,candidates){
 if(!command||typeof command!=='object'||!['update_cart','menu','info','summary','human','help'].includes(command.intent))throw Error('invalid_interpretation');
 if(command.intent!=='update_cart')return command;
 const found=matchCommercial(text,catalog);
 if(found.ambiguous.length||!found.matches.length||found.unknown.some(t=>!grammatical.has(t)))throw Error('commercial_equivalence_unconfirmed');
 if(found.matches.some(m=>m.product.service==='buffet'?!m.product.available:!sellable(m.product)))throw Error('commercial_equivalence_unconfirmed');
 if(!Array.isArray(command.items)||!command.items.length||command.items.length>30)throw Error('invalid_interpretation');
 const expected=new Map((cart?.items||[]).map(x=>[x.variant_id,x.qty]));for(const m of found.matches)expected.set(m.product.id,(expected.get(m.product.id)||0)+m.qty);
 if(command.items.length!==expected.size)throw Error('commercial_equivalence_unconfirmed');
 const seen=new Set();for(const item of command.items){if(seen.has(item.variant_id)||!candidates.some(p=>p.id===item.variant_id)||!Number.isSafeInteger(item.qty)||item.qty<1||item.qty>30||item.qty!==expected.get(item.variant_id)||typeof item.notes!=='string'||item.notes.length>300)throw Error('commercial_equivalence_unconfirmed');seen.add(item.variant_id);}
 return command;
}
