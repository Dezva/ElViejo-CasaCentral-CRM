import {fulfillmentIntent,stripFulfillment} from './fulfillment.js';
import {commercialText,productTerms,productName,sellable} from './catalog.js';
import {correctOrderTokens} from './order-spelling.js';
import {retryOrderCommand} from './order-retry.js';
export const quantityWords={un:1,uno:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12,otro:1,otra:1};
export const orderFillers=new Set(commercialText('quiero quisiera querria dame deme llevo llevar necesito pedir pedido agregar agrega agregame por favor y e con para el la lo los las me mi a unidad unidades unidade gracias hola buenas voy querer solo solamente unicamente mas suma sumame sumar anade anadi te dije lee lea mensaje bien entonces das darias podes podrias podria traeme preparame pasame enviame mandame gustaria').split(' '));
const filler=orderFillers;
const literalWords=new Set([...filler,...Object.keys(quantityWords),'sin','poca','poco','extra']);
// Una cantidad declarada establece el total; sumar requiere una intención de incremento.
export function orderText(text){
 let t=commercialText(text);if(/^\s*no\s*,/i.test(String(text)))t=t.replace(/^no\s+/,'');
 return t.replace(/\bno\s+(?:[0-9]+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b.*$/,'').trim();
}
export function orderOperation(text){const t=orderText(text);if(/\b(?:solo|solamente|unicamente|al final|en total|cambia|cambiar|cambiame|corrige|corregi|te dije)\b/.test(t))return 'set';return /\b(?:agrega|agregame|agregar|suma|sumame|sumar|anade|anadi|mas|otro|otra)\b/.test(t)?'add':'set';}
export function inlineFulfillment(text){return fulfillmentIntent(text).choice;}
function prepared(text){return orderText(stripFulfillment(text)).replace(/\b(?:lee|lea) (?:el )?mensaje(?: bien)?\b/g,' ').replace(/\b(?:deja|deje) repetir(?: el mismo mensaje)?\b/g,' ').trim();}
export function matchCommercial(text,catalog,{context}={}){
 const tokens=[],segments=[],terms=new Map(),shortNames=new Map();
 // La cantidad de una línea nunca pertenece a un producto de otra línea.
 for(const line of String(text).replace(/^\s*no\s*,/i,'').split(/[\r\n;,]+/)){
  const start=tokens.length;tokens.push(...prepared(line).split(/\s+/).filter(Boolean));
  const segment={start,end:tokens.length,source:line.trim()};for(let i=start;i<tokens.length;i++)segments[i]=segment;
 }
 function add(term,p){const list=terms.get(term)||[];list.push(p);terms.set(term,list);}
 for(const p of catalog)for(const t of productTerms(p))add(t,p);
 // Solo prefijos del nombre real del plato de hoy, nunca ingredientes sueltos.
 for(const p of catalog.filter(p=>p.service==='buffet')){
  const words=commercialText(p.name).split(' ');
  for(let n=1;n<words.length;n++){const term=words.slice(0,n).join(' ');if(term.length<4)continue;const list=shortNames.get(term)||[];list.push(p);shortNames.set(term,list);}
 }
 if(catalog.some(p=>p.service==='buffet')){
  const vocabulary=new Set([...terms.keys()].flatMap(term=>term.split(' ')));
  tokens.splice(0,tokens.length,...correctOrderTokens(tokens,vocabulary,literalWords));
 }
 const pending=context?.pending,focus=context?.focus_ids||[];
 const contextual=catalog.filter(p=>pending?.candidate_ids?.includes(p.id)||focus.some(id=>catalog.find(x=>x.id===id)?.name===p.name));
 const used=new Set(),matches=[],ambiguous=[],hits=[];let last=null;
 for(let i=0;i<tokens.length;){let hit=null;
  const variants=[...contextual];
  if(last&&tokens.slice(last.end,i).some(t=>['y','e'].includes(t)))variants.push(...catalog.filter(p=>p.name===last.product.name));
  for(let n=segments[i].end-i;n>=1;n--){const term=tokens.slice(i,i+n).join(' '),exact=terms.get(term),short=exact?null:shortNames.get(term),variant=variants.filter(p=>p.variant&&p.variant!=='Base'&&commercialText(p.variant)===term);const products=[...(exact||short||[]),...variant];
   if(products.length){hit={n,term,products:[...new Map(products.map(p=>[p.id,p])).values()],variantOnly:!exact&&!short};break;}}
  if(hit){const m={product:hit.products[0],products:hit.products,term:hit.term,variantOnly:hit.variantOnly,prefixOnly:!!shortNames.get(hit.term)&&!terms.has(hit.term),segmentEnd:segments[i].end,start:i,end:i+hit.n};
   hits.push(m);last=m;i+=hit.n;}else{i++;}
 }
 last=null;
 for(let index=0;index<hits.length;index++){
   const m=hits[index],i=m.start;let quantity=null,quantityIndex=null;
   // Una cantidad pertenece a su segmento, no al último número de todo el mensaje.
   const start=Math.max(last?.end||0,segments[i].start);
   for(let j=start;j<i;j++)if(!used.has(j)&&(quantityWords[tokens[j]]||/^\d+$/.test(tokens[j]))){quantity=quantityWords[tokens[j]]||Number(tokens[j]);quantityIndex=j;}
   if(quantityIndex!==null)used.add(quantityIndex);
   if(quantity===null){for(let j=m.end;j<Math.min(segments[i].end,hits[index+1]?.start??tokens.length);j++){if(['y','e'].includes(tokens[j]))break;if(quantityWords[tokens[j]]||/^\d+$/.test(tokens[j])){quantity=quantityWords[tokens[j]]||Number(tokens[j]);used.add(j);break;}}}
   for(let j=i;j<m.end;j++)used.add(j);
   const pendingQty=pending?.operation!=='remove'&&hits.length===1&&m.products.every(p=>pending?.candidate_ids?.includes(p.id))?pending.qty:1;
   Object.assign(m,{qty:quantity??pendingQty,explicitQty:quantity!==null});
   if(m.products.length>1)ambiguous.push(m);else matches.push(m);last=m;
 }
 for(const m of hits){
  let start=m.end;
  if(used.has(start)&&m.explicitQty)start++;
  const marker=tokens[start];
  if(!['sin','con','bien','aparte','nota','observacion'].includes(marker))continue;
  if(marker==='con'&&!['poca','poco','mucha','mucho','extra','bastante'].includes(tokens[start+1]))continue;
  let end=start+1;
  while(end<m.segmentEnd&&!['y','e'].includes(tokens[end]))end++;
  if(end-start<2||hits.some(other=>other!==m&&other.start>=start&&other.start<end))continue;
  const segment=segments[start],source=segment.source;
  const words=[...source.matchAll(/[\p{L}\p{N}]+/gu)].filter(word=>commercialText(word[0]));
  const phrase=tokens.slice(start,end);
  const rawStart=words.findIndex((_,i)=>phrase.every((token,j)=>commercialText(words[i+j]?.[0])===token));
  if(rawStart<0)continue;
  m.notes=source.slice(words[rawStart].index,words[rawStart+phrase.length-1].index+words[rawStart+phrase.length-1][0].length);
  for(let j=start;j<end;j++)used.add(j);
 }
 for(let i=0;i<tokens.length;i++)if(filler.has(tokens[i]))used.add(i);
 const unknown=tokens.filter((_,i)=>!used.has(i));return {matches,ambiguous,unknown,tokens,segments:[...new Set(segments)],unmatched:[...tokens.keys()].filter(i=>!used.has(i))};
}
export function clarifyOptions(products,qty=1,operation='add'){
 const common=products.length&&products.every(p=>p.name===products[0].name),names=products.map(p=>common&&p.variant&&p.variant!=='Base'?p.variant:productName(p));
 return {intent:'clarify',message:'¿Cuál preferís: '+names.join(', ')+'?',context:{pending:{candidate_ids:products.map(p=>p.id),qty,operation},focus_ids:[]}};
}
export function requestedItems(found,cart,text){
 const items=new Map((cart?.items||[]).map(x=>[x.variant_id,{variant_id:x.variant_id,qty:x.qty,notes:x.notes||''}]));
 const savedPending=cart?.conversation?.pending?.operation==='remove'?null:cart?.conversation?.pending,pending=found.resolvingPending||found.matches.every(m=>m.variantOnly||savedPending?.candidate_ids?.includes(m.product.id))?savedPending:null,correction=orderOperation(text)==='set';
 const resolvedContext=found.matches.every(m=>m.variantOnly)&&orderOperation(text)!=='add';
 const mentions=new Map();
 for(const m of found.matches){const previous=mentions.get(m.product.id);mentions.set(m.product.id,previous?{...m,qty:previous.qty+m.qty,explicitQty:previous.explicitQty||m.explicitQty,notes:[...new Set([previous.notes,m.notes].filter(Boolean))].join(' / ')}:m);}
 for(const m of mentions.values()){let operation=pending?.operation||(correction?'set':'add');
  if(resolvedContext&&!pending)operation='set';
  let qty=m.qty;
  if(operation==='set'&&!m.explicitQty&&!pending){const focused=(cart?.conversation?.focus_ids||[]).map(id=>items.get(id)).filter(Boolean);if(focused.length===1&&(m.product.service!=='buffet'||m.variantOnly))qty=focused[0].qty;else if(items.has(m.product.id))qty=items.get(m.product.id).qty;}
  if(resolvedContext&&operation==='set')for(const id of cart?.conversation?.focus_ids||[]){const previous=items.get(id);if(previous&&id!==m.product.id&&cart.items.find(x=>x.variant_id===id)?.name===m.product.name)items.delete(id);}
  const old=items.get(m.product.id);items.set(m.product.id,{variant_id:m.product.id,qty:(operation==='add'?old?.qty||0:0)+qty,notes:m.notes||old?.notes||''});
 }
 return [...items.values()];
}
export const quantityWarning='Indicá entre 1 y 30 unidades enteras por plato.';
export const validQuantity=qty=>Number.isSafeInteger(qty)&&qty>=1&&qty<=30;
export function deterministicOrder(text,cart,catalog,found=matchCommercial(text,catalog,{context:cart?.conversation})){
 const fulfillment=inlineFulfillment(text),operation=orderOperation(text);
 if(/^\s*no\s+(?:quiero|agreg|sum)/i.test(String(text)))return {found,command:{intent:'clarify',message:'¿Querés quitar un producto o cambiar su cantidad? Indicá el artículo y el total.'}};
 if(!found.matches.length&&!found.ambiguous.length)return {found,command:null};
 const correctionOnly=found.unknown.every(t=>['al','final','en','total','cambia','cambiar','cambiame','corrige','corregi','no'].includes(t));
 if(!correctionOnly)return {found,command:null};
 const blocked=found.matches.filter(m=>m.product.service==='buffet'?!m.product.available:!sellable(m.product));
 if(blocked.length)return {found,command:retryOrderCommand(blocked.map(m=>productName(m.product)+': agotado o no disponible en el menú de hoy').join('. ')+'.')};
 if([...found.matches,...found.ambiguous].some(m=>!validQuantity(m.qty)))return {found,command:retryOrderCommand(quantityWarning)};
 if(found.ambiguous.length){
  const a=found.ambiguous[0],command=clarifyOptions(a.products,a.qty,operation);
  command.context.pending.notes=a.notes||'';
  command.context.pending.resolved_items=found.matches.map(m=>({id:m.product.id,qty:m.qty,notes:m.notes||''}));
  command.context.pending.remaining=found.ambiguous.slice(1).map(m=>({candidate_ids:m.products.map(p=>p.id),qty:m.qty,notes:m.notes||''}));
  return {found,command};
 }
 const pending=cart?.conversation?.pending?.operation==='remove'?null:cart?.conversation?.pending;
 if(pending&&found.matches.every(m=>m.variantOnly||pending.candidate_ids?.includes(m.product.id))){
  const resolved=[...(pending.resolved_items||[]),...found.matches.map(m=>({id:m.product.id,qty:m.qty,notes:m.notes||pending.notes||''}))];
  if(resolved.some(item=>!catalog.some(product=>product.id===item.id&&product.available)))return {found,command:retryOrderCommand('Cambió la disponibilidad de los platos de la aclaración.')};
  if(pending.remaining?.length){
   const next=pending.remaining[0],options=catalog.filter(p=>next.candidate_ids.includes(p.id));
   if(!options.length)return {found,command:retryOrderCommand('Cambió la disponibilidad de los platos de la aclaración.')};
   const command=clarifyOptions(options,next.qty,pending.operation);
   command.context.pending={...command.context.pending,resolved_items:resolved,remaining:pending.remaining.slice(1),notes:next.notes};
   return {found,command};
  }
  found.resolvingPending=true;
  found.matches=resolved.map(m=>({product:catalog.find(p=>p.id===m.id),qty:m.qty,notes:m.notes,explicitQty:true,variantOnly:true}));
 }
 const items=requestedItems(found,cart,text);
 if(items.some(item=>item.notes.length>300))return {found,command:{intent:'clarify',message:'La observación puede tener hasta 300 caracteres. Tu borrador sigue guardado.'}};
 if(items.some(x=>!validQuantity(x.qty)))return {found,command:retryOrderCommand(quantityWarning)};
 return {found,command:{intent:'update_cart',items,context:{focus_ids:[...new Set(found.matches.map(m=>m.product.id))]},...(fulfillment?{fulfillment}:{})}};
}
