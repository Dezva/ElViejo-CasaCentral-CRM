import {referencePriceRequest} from './reference-prices.js';
import {orderStatusRequested} from './order-status.js';
import {deliveryStatusCommand,deliveryReferenceCommand} from './delivery-context.js';
import {commercialText,productTerms,productName,sellable} from './catalog.js';
import {matchCommercial,deterministicOrder,quantityWords,orderOperation,inlineFulfillment,orderText,requestedItems,clarifyOptions} from './catalog-matching.js';
const grammatical=new Set('producto productos porfa porfavor podes podria podrias traer traeme pasame preparame enviame mandame favor quiero quisiera necesito gustaria me el la lo los las un una uno y e para a mi agregar agrega agregame dame llevo llevar pedir pedido con sin bien caliente calientes frio fria queso sal azucar por favor gracias voy querer te dije al final total cambia cambiar solo solamente unicamente no'.split(' '));
export function categoryRequest(text,catalog,categories=[]){
 const t=commercialText(text),groups=categories.length?categories:[...new Map(catalog.filter(p=>p.category).map(p=>[p.category_id||p.category,{id:p.category_id||p.category,name:p.category,active:p.category_active!==false}])).values()];
 const hits=groups.filter(c=>c.active!==false&&commercialText(c.name)&&(' '+t+' ').includes(' '+commercialText(c.name)+' ')).sort((a,b)=>commercialText(b.name).length-commercialText(a.name).length);
 if(!hits.length)return null;
 const chosen=hits.filter(c=>!hits.some(other=>other!==c&&commercialText(other.name).startsWith(commercialText(c.name)+' '))),roots=chosen.map(c=>commercialText(c.name));
 return {category_ids:groups.filter(c=>c.active!==false&&roots.some(root=>commercialText(c.name)===root||commercialText(c.name).startsWith(root+' '))).map(c=>c.id),category_names:groups.filter(c=>c.active!==false&&roots.some(root=>commercialText(c.name)===root||commercialText(c.name).startsWith(root+' '))).map(c=>c.name)};
}
export function recoverCandidates(text,cart,catalog,{expanded=false}={}){
 if(expanded)return [...catalog];
 const found=matchCommercial(text,catalog,{context:cart?.conversation}),ids=new Set([...(cart?.items||[]).map(x=>x.variant_id),...(cart?.conversation?.pending?.candidate_ids||[]),...found.matches.map(m=>m.product.id),...found.ambiguous.flatMap(a=>a.products.map(p=>p.id))]);
 const tokens=commercialText(text).split(' ').filter(t=>t.length>2&&!grammatical.has(t)&&!/^\d+$/.test(t));
 for(const p of catalog){const terms=productTerms(p).join(' ').split(' '),cat=commercialText(p.category||'').split(' ');if(tokens.some(t=>terms.includes(t)||cat.includes(t)))ids.add(p.id);}
 return ids.size?catalog.filter(p=>ids.has(p.id)):[...catalog];
}
export function compactContext(cart,candidates,settings){
 return {service:cart?.service||null,cart:(cart?.items||[]).map(x=>[x.variant_id,x.qty]),...(cart?.conversation?{conversation:cart.conversation}:{}),products:candidates.map(p=>[p.id,productName(p),p.aliases||[],p.service==='buffet'?!!p.available:sellable(p)]),payments:settings.payment_methods||[]};
}
function quantityFollowup(text,cart,catalog){
 const t=commercialText(text),correct=/\b(?:solo|solamente|unicamente|al final|en total|no una|no uno|cambia|cambiame|corrige|corregi)\b/.test(t),increment=orderOperation(text)==='add'&&/\b(?:mas|otro|otra)\b/.test(t);
 if(!correct&&!increment)return null;
 const beforeNo=orderText(text),quantity=beforeNo.split(' ').map(x=>quantityWords[x]||(/^\d+$/.test(x)?Number(x):null)).find(x=>x!==null);
 if(quantity===undefined)return null;
 if(quantity<1||quantity>30)return {intent:'clarify',message:'Indicá entre 1 y 30 unidades por producto.'};
 const pending=cart?.conversation?.pending;
 if(pending?.candidate_ids?.length){const options=catalog.filter(p=>pending.candidate_ids.includes(p.id));return clarifyOptions(options,correct?quantity:(pending.qty||0)+quantity,pending.operation||'add');}
 const ids=(cart?.conversation?.focus_ids?.length?cart.conversation.focus_ids:(cart?.items||[]).map(x=>x.variant_id)).filter(id=>cart?.items?.some(x=>x.variant_id===id)&&catalog.some(p=>p.id===id));
 if(ids.length!==1)return {intent:'clarify',message:'¿De qué producto querés cambiar la cantidad? Indicá su nombre y el total.'};
 const product=catalog.find(p=>p.id===ids[0]);if(product.service==='buffet'?!product.available:!sellable(product))return {intent:'clarify',message:productName(product)+': no disponible para nuevos pedidos. El equipo puede ayudarte.'};
 const id=ids[0],items=cart.items.map(x=>({variant_id:x.variant_id,qty:x.variant_id===id?(correct?quantity:x.qty+quantity):x.qty,notes:x.notes||''}));
 if(items.some(x=>x.qty>30))return {intent:'clarify',message:'El máximo es 30 unidades por producto.'};
 return {intent:'update_cart',items,context:{focus_ids:[id]},...(inlineFulfillment(text)?{fulfillment:inlineFulfillment(text)}:{})};
}
export function deterministicConversation(text,cart,catalog,{categories=[]}={}){
 const pricing=referencePriceRequest(text,cart);if(pricing)return pricing;
 if(orderStatusRequested(text)&&cart?.items?.length)return {intent:'draft_status'};
 const status=deliveryStatusCommand(text,cart);if(status)return status;
 const t=commercialText(text);
 if(/^(?:que tienen(?: hoy)?|que hay(?: hoy)?|menu(?: de hoy)?)$/.test(t))return {intent:'menu'};
 if(/^(horario|horarios|forma pago|forma pago disponible|metodo pago|metodo pago disponible)$/.test(t))return {intent:'info'};
 const found=matchCommercial(text,catalog,{context:cart?.conversation}),category=categoryRequest(text,catalog,categories),isQuery=/\b(?:que|cual|clase|tipo|vendes|vende|venden|tienen|tiene|hay|mostra|mostrame|solo|unicamente|cuanto|menu|catalogo|carta)\b/.test(t)||category?.category_names?.some(name=>commercialText(name)===t);
 // Un nombre/variante específicos gana a una categoría; una consulta de categoría no arma carritos.
 if(category&&isQuery&&!found.matches.some(m=>m.product.variant&&m.product.variant!=='Base')&&!found.matches.some(m=>m.product.name!==m.product.category&&!m.product.legacy_generic))return {intent:'menu',...category};
 if(category&&isQuery&&!found.matches.length)return {intent:'menu',...category};
 if(isQuery&&/\bensalada\b/.test(t)&&!found.matches.length)return {intent:'menu',dish_ids:catalog.filter(dish=>/\bensalada\b/.test(commercialText(dish.name))).map(dish=>dish.id)};
 if(!found.matches.length&&!found.ambiguous.length){const followup=quantityFollowup(text,cart,catalog);if(followup)return followup;}
 const resolved=deterministicOrder(text,cart,catalog);
 if(/\b(tienen|hay|disponible)\b/.test(t)){
  if(category&&!found.matches.length)return {intent:'menu',...category};
  const f=resolved.found;if(f.ambiguous.length||f.matches.some(m=>m.product.service==='buffet'?!m.product.available:!sellable(m.product)))return resolved.command?.intent==='clarify'?resolved.command:{intent:'clarify',message:'El equipo debe confirmar la variedad y su disponibilidad.'};
  if(f.matches.length)return {intent:'clarify',message:'Disponible hoy: '+f.matches.map(m=>productName(m.product)).join(', ')+'.'};
  return {intent:'clarify',message:'No encontré ese plato en el menú publicado de hoy.'};
 }
 if(resolved.command)return resolved.command;
 if(/\b(?:repetir|lee|mensaje)\b/.test(t)&&!found.matches.length)return {intent:'clarify',message:cart?.conversation?.pending?'Decime la variedad que preferís; conservamos la cantidad que pediste.':'Decime qué producto o categoría querés revisar y te muestro solo esas opciones.'};
 return found.matches.length||found.ambiguous.length?null:deliveryReferenceCommand(text,cart);
}
export function validateInterpretation(command,text,cart,catalog,candidates){
 if(!command||typeof command!=='object'||!['update_cart','menu','info','summary','human','help','reference_prices'].includes(command.intent))throw Error('invalid_interpretation');
 if(command.intent==='menu'){const request=categoryRequest(text,catalog);if(request)Object.assign(command,request);else if(command.category){const group=categoryRequest(command.category,catalog);if(!group)throw Error('commercial_equivalence_unconfirmed');Object.assign(command,group);}return command;}
 if(command.intent!=='update_cart')return command;
 if(/^\s*no\s+(?:quiero|agreg|sum)/i.test(String(text)))throw Error('commercial_equivalence_unconfirmed');
 const found=matchCommercial(text,catalog,{context:cart?.conversation});
 if(found.ambiguous.length||!found.matches.length||found.unknown.some(t=>!grammatical.has(t)))throw Error('commercial_equivalence_unconfirmed');
 if(found.matches.some(m=>m.product.service==='buffet'?!m.product.available:!sellable(m.product)))throw Error('commercial_equivalence_unconfirmed');
 if(!Array.isArray(command.items)||!command.items.length||command.items.length>30)throw Error('invalid_interpretation');
 if(cart?.conversation?.pending?.resolved_items?.length&&found.matches.every(m=>m.variantOnly))found.matches=[...cart.conversation.pending.resolved_items.map(m=>({product:catalog.find(p=>p.id===m.id),qty:m.qty,explicitQty:true,variantOnly:true})).filter(m=>m.product),...found.matches];
 const expected=new Map(requestedItems(found,cart,text).map(x=>[x.variant_id,x.qty]));
 if(command.items.length!==expected.size)throw Error('commercial_equivalence_unconfirmed');
 const seen=new Set();for(const item of command.items){if(seen.has(item.variant_id)||!candidates.some(p=>p.id===item.variant_id)||!Number.isSafeInteger(item.qty)||item.qty<1||item.qty>30||item.qty!==expected.get(item.variant_id)||typeof item.notes!=='string'||item.notes.length>300)throw Error('commercial_equivalence_unconfirmed');seen.add(item.variant_id);}
 command.context={focus_ids:found.matches.map(m=>m.product.id)};const fulfillment=inlineFulfillment(text);if(fulfillment)command.fulfillment=fulfillment;return command;
}
