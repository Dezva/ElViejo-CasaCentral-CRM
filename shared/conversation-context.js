import {referencePriceRequest} from './reference-prices.js';
import {orderStatusRequested} from './order-status.js';
import {BUFFET_CATEGORIES} from './buffet-categories.js';
import {fulfillmentIntent} from './fulfillment.js';
import {messageIntent} from './message-intent.js';
import {availabilityReply} from './customer-messages.js';
import {invalidOrderCommand,quantityProblem} from './order-diagnostics.js';
import {retryOrderCommand} from './order-retry.js';
import {cartOperationCommand} from './cart-operations.js';
import {deliveryStatusCommand,deliveryReferenceCommand,deliveryQueryRequested} from './delivery-context.js';
import {categoryKey,commercialText,productTerms,productName,sellable} from './catalog.js';
import {matchCommercial,deterministicOrder,quantityWords,orderOperation,inlineFulfillment,orderText,clarifyOptions,quantityWarning,validQuantity} from './catalog-matching.js';
const grammatical=new Set('producto productos porfa porfavor podes podria podrias traer traeme pasame preparame enviame mandame favor quiero quisiera necesito gustaria me el la lo los las un una uno y e para a mi agregar agrega agregame dame llevo llevar pedir pedido con sin bien caliente calientes frio fria queso sal azucar por favor gracias voy querer te dije al final total cambia cambiar solo solamente unicamente no'.split(' '));
const quantityToken=`(?:\\d+|${Object.keys(quantityWords).join('|')})`;
const quantityAlternatives=new RegExp(`\\b${quantityToken} o ${quantityToken}\\b`);
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
export function compactContext(cart,candidates){
 const {pending,focus_ids}=cart?.conversation||{};
 const conversation={focus_ids,...(pending?{pending:{candidate_ids:pending.candidate_ids,qty:pending.qty,operation:pending.operation}}:{})};
 return {service:cart?.service||null,cart:(cart?.items||[]).map(x=>[x.variant_id,x.qty]),conversation,products:candidates.map(p=>[p.id,productName(p),p.aliases||[],p.service==='buffet'?!!p.available:sellable(p)])};
}
function quantityFollowup(text,cart,catalog,found){
 const t=commercialText(text),correct=/\b(?:solo|solamente|unicamente|al final|en total|no una|no uno|cambia|cambiame|corrige|corregi|mejor|dejame)\b/.test(t),increment=orderOperation(text)==='add'&&/\b(?:mas|otro|otra)\b/.test(t);
 if(!correct&&!increment)return null;
 if(found.unknown.some(word=>!Object.hasOwn(quantityWords,word)&&!/^\d+$/.test(word)&&!['al','final','en','total','cambia','cambiame','corrige','corregi'].includes(word)))return null;
 const beforeNo=orderText(text),quantity=beforeNo.split(' ').map(x=>quantityWords[x]||(/^\d+$/.test(x)?Number(x):null)).find(x=>x!==null);
 if(quantity===undefined)return null;
 if(!validQuantity(quantity))return retryOrderCommand(quantityWarning);
 const pending=cart?.conversation?.pending;
 if(pending?.operation==='remove')return {intent:'clarify',message:'Decime qué plato querés quitar del borrador.'};
 if(pending?.candidate_ids?.length){
  const options=catalog.filter(p=>pending.candidate_ids.includes(p.id)),qty=correct?quantity:pending.qty+quantity;
  if(!options.length||!validQuantity(qty))return retryOrderCommand(quantityWarning);
  const command=clarifyOptions(options,qty,pending.operation);
  command.context.pending={...pending,qty};
  return command;
 }
 const ids=(cart?.conversation?.focus_ids?.length?cart.conversation.focus_ids:(cart?.items||[]).map(x=>x.variant_id)).filter(id=>cart?.items?.some(x=>x.variant_id===id)&&catalog.some(p=>p.id===id));
 if(ids.length!==1)return {intent:'clarify',message:'¿De qué producto querés cambiar la cantidad? Indicá su nombre y el total.'};
 const product=catalog.find(p=>p.id===ids[0]);if(product.service==='buffet'?!product.available:!sellable(product))return retryOrderCommand(productName(product)+': no disponible para nuevos pedidos.');
 const id=ids[0],items=cart.items.map(x=>({variant_id:x.variant_id,qty:x.variant_id===id?(correct?quantity:x.qty+quantity):x.qty,notes:x.notes||''}));
 if(items.some(x=>!validQuantity(x.qty)))return retryOrderCommand(quantityWarning);
 return {intent:'update_cart',items,context:{focus_ids:[id]},...(inlineFulfillment(text)?{fulfillment:inlineFulfillment(text)}:{})};
}
export const cartRequestKey=text=>String(text).trim().split(/\r?\n/).map(categoryKey).join('\n').replace(/[.!?]+$/,'');

export function deterministicConversation(text,cart,catalog,{categories=[]}={}){
 const found=matchCommercial(text,catalog,{context:cart?.conversation});
 const hasProducts=!!(found.matches.length||found.ambiguous.length),state=messageIntent(text,{hasProducts}),t=commercialText(text);
 const mode=fulfillmentIntent(text);
 if(state.kind==='human')return {intent:'human'};
 if(state.kind==='cancellation')return ['/cancelar','/reiniciar','cancelar pedido'].includes(categoryKey(text))?{intent:'cancel_order'}:{intent:'clarify',message:'Para cancelar el borrador, escribí CANCELAR PEDIDO. Conservamos tus solicitudes registradas.'};
 if(state.kind==='confirmation')return {intent:'summary'};
 if(/^(?:si|si por favor|si gracias|no|no gracias)$/.test(t))return {intent:'clarify',message:cart?.items?.length&&cart.fulfillment==='a_coordinar'?'¿Preferís retirar en el local o pedir delivery?':'Decime qué platos querés pedir o escribí MENÚ para ver las opciones.'};
 if(state.kind==='social')return {intent:'social',message:/^buen|^hola/.test(t)?null:/gracias/.test(t)?'¡Gracias a vos!':'De acuerdo. Cuando quieras, seguimos.'};
 if(state.kind==='uncertain')return {intent:'clarify',message:'Tu borrador sigue guardado. Cuando decidas, decime qué querés agregar o cambiar.'};

 const price=referencePriceRequest(text,cart,catalog);
 if(price)return price;
 if(orderStatusRequested(text))return cart?.items?.length?{intent:'draft_status'}:{intent:'registered_status'};
 const reference=deliveryReferenceCommand(text,cart);
 if(reference)return reference;
 const category=categoryRequest(text,catalog,categories.length?categories:BUFFET_CATEGORIES);
 const asksMenu=state.topic==='menu'||/^(?:que tienen|que hay)(?: hoy)?$/.test(t)||/\bmenu\b/.test(t)&&/\b(?:mostrame|solo|ensalada)\b/.test(t);
 if(asksMenu&&/\bensalada\b/.test(t))return {intent:'menu',dish_ids:catalog.filter(p=>/\bensalada\b/.test(commercialText(p.name))).map(p=>p.id)};
 if(asksMenu||category&&!hasProducts&&(state.kind==='query'||category.category_names.some(name=>commercialText(name)===t)))return {intent:'menu',...category};
 if(['location','payments','hours','fulfillment'].includes(state.topic))return {intent:'info',topic:state.topic};
 const delivery=deliveryStatusCommand(text,cart);
 if(delivery)return delivery;
 if(deliveryQueryRequested(text)&&/\b(?:mi|ya|recibi\w*|envi\w*|mande|ubicacion|referencia)\b/.test(t))return cart?.items?.length?{intent:'clarify',message:'Para usar una ubicación en el pedido, elegí delivery y compartí un punto válido de WhatsApp.'}:{intent:'registered_delivery'};
 if(state.topic==='price')return {intent:'reference_prices'};
 if(state.topic==='availability'||state.kind==='query'&&hasProducts)return {intent:'clarify',message:availabilityReply(found)};
 if(state.kind==='query')return {intent:'clarify',message:'¿Podés aclararme qué querés consultar? Tu borrador sigue guardado.'};

 if(mode.mentioned&&!mode.choice&&!hasProducts)return {intent:'clarify',message:'¿Preferís retirar en el local o pedir delivery? Tu borrador sigue guardado.'};
 if(mode.choice&&!hasProducts&&found.unknown.every(word=>['es','sera','prefiero','queremos','entonces','asi','perfecto'].includes(word))&&!/\b(?:agrega\w*|suma\w*|\d+)\b/.test(t))return {intent:'summary',fulfillment:mode.choice};
 if(/^(?:pago|pagare|voy a pagar|quiero pagar|prefiero pagar)\b/.test(t))return {intent:'payment'};
 if(/^\s*(?:no|nunca)\s+(?:quiero|agreg|sum|sac|quit|elimin|borr)/i.test(text))return {intent:'clarify',message:'Tu borrador sigue igual. Decime qué plato querés cambiar o quitar.'};
 if(cart?.last_cart_request===cartRequestKey(text))return {intent:'repeat_cart'};
 const edit=cartOperationCommand(text,cart,catalog);
 if(edit)return edit;
 if(!catalog.length)return {intent:'menu'};
 if(hasProducts&&quantityAlternatives.test(t))return {intent:'clarify',message:'¿Con qué cantidad te quedás? Tu borrador sigue guardado.'};
 if((hasProducts||state.kind==='purchase'||state.kind==='modification')&&quantityProblem(text))return invalidOrderCommand(text,cart,catalog);
 if(!hasProducts){
  const followup=quantityFollowup(text,cart,catalog,found);
  if(followup)return followup;
 }
 const noteMatch=String(text).trim().match(/^(?:sin|bien|con (?:poc[oa]|much[oa]|extra)|nota:|observación:)\s+[^?¿]+$/i);
 if(noteMatch&&!hasProducts){
  const ids=(cart?.conversation?.focus_ids?.length?cart.conversation.focus_ids:cart?.items?.map(item=>item.variant_id)||[]).filter(id=>cart?.items?.some(item=>item.variant_id===id));
  if(ids.length!==1||cart?.conversation?.pending)return {intent:'clarify',message:'¿Para qué plato es esa observación? Indicá su nombre para anotarla.'};
  const items=cart.items.map(item=>item.variant_id===ids[0]?{...item,notes:noteMatch[0].replace(/[.!]+$/,'')}:item);
  return {intent:'update_cart',items,context:{focus_ids:ids}};
 }
 const {command}=deterministicOrder(text,cart,catalog,found);
 if(command)return command;
 if(state.kind==='purchase'||state.kind==='modification')return invalidOrderCommand(text,cart,catalog);
 if(state.kind==='product_mention')return {intent:'clarify',message:'¿Querés pedir ese plato o consultarme por él? Tu borrador sigue guardado.'};
 return null;
}

export function validateInterpretation(command,text,cart,catalog,candidates){
 const trusted=deterministicConversation(text,cart,catalog);
 if(command?.intent!=='update_cart'||trusted?.intent!=='update_cart'||!Array.isArray(command.items)||trusted.items.length!==command.items.length)throw Error('commercial_equivalence_unconfirmed');
 const expected=new Map(trusted.items.map(item=>[item.variant_id,item.qty]));
 for(const item of command.items){
  if(!item||!candidates.some(p=>p.id===item.variant_id)||!expected.has(item.variant_id)||expected.get(item.variant_id)!==item.qty)throw Error('commercial_equivalence_unconfirmed');
  expected.delete(item.variant_id);
 }
 // Las notas y la modalidad también salen del texto del cliente.
 return trusted;
}
