import {commercialText,productTerms,productName,sellable} from './catalog.js';
export const quantityWords={un:1,uno:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12,otro:1,otra:1};
const filler=new Set('quiero quisiera querria dame llevo llevar necesito pedir pedido agregar agrega agregame por favor y e con para el la lo los las me mi a unidad unidades unidade gracias hola buenas voy querer solo solamente unicamente mas suma sumame sumar anade anadi te dije lee lea mensaje bien'.split(' '));
// Una cantidad declarada establece el total; sumar requiere una intención de incremento.
export function orderText(text){
 let t=commercialText(text);if(/^\s*no\s*,/i.test(String(text)))t=t.replace(/^no\s+/,'');
 return t.replace(/\bno\s+(?:[0-9]+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b.*$/,'').trim();
}
export function orderOperation(text){const t=orderText(text);if(/\b(?:solo|solamente|unicamente|al final|en total|cambia|cambiar|cambiame|corrige|corregi|te dije)\b/.test(t))return 'set';return /\b(?:agrega|agregame|agregar|suma|sumame|sumar|anade|anadi|mas|otro|otra)\b/.test(t)?'add':'set';}
export function inlineFulfillment(text){const t=commercialText(text);if(/\b(?:no|sin) (?:delivery|retiro)\b/.test(t))return null;if(/\bdelivery\b|\ba domicilio\b/.test(t))return 'delivery';if(/\b(?:retiro|retirar)\b/.test(t))return 'retiro';return null;}
function prepared(text){return orderText(text).replace(/\b(?:lee|lea) (?:el )?mensaje(?: bien)?\b/g,' ').replace(/\b(?:deja|deje) repetir(?: el mismo mensaje)?\b/g,' ').replace(/\bpara (?:delivery|retiro|retirar)\b|\ba domicilio\b/g,' ').replace(/\bdelivery\b/g,' ').trim();}
export function matchCommercial(text,catalog,{context}={}){
 const tokens=prepared(text).split(/\s+/).filter(Boolean),terms=new Map();
 function add(term,p){const list=terms.get(term)||[];list.push(p);terms.set(term,list);}
 for(const p of catalog)for(const t of productTerms(p))add(t,p);
 const pending=context?.pending,focus=context?.focus_ids||[];
 const contextual=catalog.filter(p=>pending?.candidate_ids?.includes(p.id)||focus.some(id=>catalog.find(x=>x.id===id)?.name===p.name));
 const used=new Set(),matches=[],ambiguous=[];let last=null;
 for(let i=0;i<tokens.length;){let hit=null;
  const variants=[...contextual];
  if(last&&tokens.slice(last.end,i).some(t=>['y','e'].includes(t)))variants.push(...catalog.filter(p=>p.name===last.product.name));
  for(let n=tokens.length-i;n>=1;n--){const term=tokens.slice(i,i+n).join(' '),exact=terms.get(term),variant=variants.filter(p=>p.variant&&p.variant!=='Base'&&commercialText(p.variant)===term);const products=[...(exact||[]),...variant];
   if(products.length){hit={n,term,products:[...new Map(products.map(p=>[p.id,p])).values()],variantOnly:!exact};break;}}
  if(hit){let quantity=null,quantityIndex=null;
   // Una cantidad pertenece a su segmento, no al último número de todo el mensaje.
   const start=last?.end||0;
   for(let j=start;j<i;j++)if(!used.has(j)&&(quantityWords[tokens[j]]||/^\d+$/.test(tokens[j]))){quantity=quantityWords[tokens[j]]||Number(tokens[j]);quantityIndex=j;}
   if(quantityIndex!==null)used.add(quantityIndex);
   if(quantity===null){for(let j=i+hit.n;j<tokens.length;j++){if(['y','e'].includes(tokens[j]))break;if(quantityWords[tokens[j]]||/^\d+$/.test(tokens[j])){quantity=quantityWords[tokens[j]]||Number(tokens[j]);used.add(j);break;}}}
   for(let j=i;j<i+hit.n;j++)used.add(j);
   const m={product:hit.products[0],products:hit.products,qty:quantity??pending?.qty??1,explicitQty:quantity!==null,term:hit.term,variantOnly:hit.variantOnly,start:i,end:i+hit.n};
   if(hit.products.length>1)ambiguous.push(m);else matches.push(m);last=m;i+=hit.n;
  }else{i++;}
 }
 for(let i=0;i<tokens.length;i++)if(filler.has(tokens[i]))used.add(i);
 const unknown=tokens.filter((_,i)=>!used.has(i));return {matches,ambiguous,unknown,tokens};
}
export function clarifyOptions(products,qty=1,operation='add'){
 const common=products.length&&products.every(p=>p.name===products[0].name),names=products.map(p=>common&&p.variant&&p.variant!=='Base'?p.variant:productName(p));
 return {intent:'clarify',message:'¿Cuál preferís: '+names.join(', ')+'?',context:{pending:{candidate_ids:products.map(p=>p.id),qty,operation},focus_ids:[]}};
}
export function requestedItems(found,cart,text){
 const items=new Map((cart?.items||[]).map(x=>[x.variant_id,{variant_id:x.variant_id,qty:x.qty,notes:x.notes||''}]));
 const pending=cart?.conversation?.pending,correction=orderOperation(text)==='set';
 const resolvedContext=found.matches.every(m=>m.variantOnly)&&!/^\s*(?:agrega|agregame|sumame)/.test(commercialText(text));
 for(const m of found.matches){let operation=pending?.operation||(correction?'set':'add');
  if(resolvedContext&&!pending)operation='set';
  let qty=m.qty;
  if(operation==='set'&&!m.explicitQty&&!pending){const focused=(cart?.conversation?.focus_ids||[]).map(id=>items.get(id)).filter(Boolean);if(focused.length===1)qty=focused[0].qty;else if(items.has(m.product.id))qty=items.get(m.product.id).qty;}
  if(resolvedContext&&operation==='set')for(const id of cart?.conversation?.focus_ids||[]){const previous=items.get(id);if(previous&&id!==m.product.id&&cart.items.find(x=>x.variant_id===id)?.name===m.product.name)items.delete(id);}
  const old=items.get(m.product.id);items.set(m.product.id,{variant_id:m.product.id,qty:(operation==='add'?old?.qty||0:0)+qty,notes:old?.notes||''});
 }
 return [...items.values()];
}
export function deterministicOrder(text,cart,catalog){
 const found=matchCommercial(text,catalog,{context:cart?.conversation}),fulfillment=inlineFulfillment(text),operation=orderOperation(text);
 if(/^\s*no\s+(?:quiero|agreg|sum)/i.test(String(text)))return {found,command:{intent:'clarify',message:'¿Querés quitar un producto o cambiar su cantidad? Indicá el artículo y el total.'}};
 if(!found.matches.length&&!found.ambiguous.length)return {found,command:null};
 if(found.ambiguous.length){const a=found.ambiguous[0],command=clarifyOptions(a.products,a.qty,operation);command.context.pending.resolved_items=found.matches.map(m=>({id:m.product.id,qty:m.qty}));command.context.pending.remaining=found.ambiguous.slice(1).map(m=>({candidate_ids:m.products.map(p=>p.id),qty:m.qty}));return {found,command:{...command,...(fulfillment?{fulfillment}:{})}};}
 const blocked=found.matches.filter(m=>m.product.service==='buffet'?!m.product.available:!sellable(m.product));
 if(blocked.length)return {found,command:{intent:'clarify',message:blocked.map(m=>productName(m.product)+': '+(m.product.service==='buffet'?'agotado':m.product.price===null?'precio individual pendiente de confirmar':'no disponible para nuevos pedidos')).join('. ')+'. El equipo puede ayudarte. Conservamos tu carrito sin agregar productos.',...(fulfillment?{fulfillment}:{})}};
 const correctionOnly=found.unknown.every(t=>['al','final','en','total','cambia','cambiar','cambiame','corrige','corregi','no'].includes(t));
 if(found.unknown.length&&!correctionOnly)return {found,command:null};
 const pending=cart?.conversation?.pending;
 if(pending&&found.matches.every(m=>m.variantOnly)){const resolved=[...(pending.resolved_items||[]),...found.matches.map(m=>({id:m.product.id,qty:m.qty}))];if(pending.remaining?.length){const next=pending.remaining[0],command=clarifyOptions(catalog.filter(p=>next.candidate_ids.includes(p.id)),next.qty,pending.operation);command.context.pending.resolved_items=resolved;command.context.pending.remaining=pending.remaining.slice(1);return {found,command};}found.matches=resolved.map(m=>({product:catalog.find(p=>p.id===m.id),qty:m.qty,explicitQty:true,variantOnly:true})).filter(m=>m.product);}
 const items=requestedItems(found,cart,text);
 if(items.some(x=>x.qty<1||x.qty>30))return {found,command:{intent:'clarify',message:'Indicá entre 1 y 30 unidades por producto.'}};
 return {found,command:{intent:'update_cart',items,context:{focus_ids:found.matches.map(m=>m.product.id)},...(fulfillment?{fulfillment}:{})}};
}
