import {commercialText,productTerms,productName,sellable} from './catalog.js';
const quantities={un:1,uno:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12};
const filler=new Set('quiero quisiera querria dame llevo llevar necesito pedir pedido agregar agrega agregame por favor y e con para el la lo los las me mi a un una uno unidad unidades unidade gracias hola buenas'.split(' '));
export function matchCommercial(text,catalog){
 const tokens=commercialText(text).split(' ').filter(Boolean),terms=new Map();
 for(const p of catalog)for(const t of productTerms(p)){const list=terms.get(t)||[];list.push(p);terms.set(t,list);}
 const used=new Set(),matches=[],ambiguous=[];let qty=1,quantityIndex=null;
 for(let i=0;i<tokens.length;){let hit=null;
  for(let n=tokens.length-i;n>=1;n--){const term=tokens.slice(i,i+n).join(' ');if(terms.has(term)){hit={n,term,products:[...new Map(terms.get(term).map(p=>[p.id,p])).values()]};break;}}
  if(hit){if(quantityIndex!==null)used.add(quantityIndex);quantityIndex=null;for(let j=i;j<i+hit.n;j++)used.add(j);if(hit.products.length>1)ambiguous.push({term:hit.term,products:hit.products});else matches.push({product:hit.products[0],qty,term:hit.term});qty=1;i+=hit.n;}
  else {const token=tokens[i];if(/^\d+$/.test(token)||quantities[token]){qty=quantities[token]||Number(token);quantityIndex=i;}else if(filler.has(token))used.add(i);i++;}
 }
 const unknown=tokens.filter((_,i)=>!used.has(i));return {matches,ambiguous,unknown};
}
export function deterministicOrder(text,cart,catalog){
 const found=matchCommercial(text,catalog);
 if(!found.matches.length&&!found.ambiguous.length)return {found,command:null};
 if(found.ambiguous.length)return {found,command:{intent:'clarify',message:'¿Cuál preferís? '+found.ambiguous.map(a=>a.products.map(productName).join(' / ')).join('; ')+'.'}};
 const blocked=found.matches.filter(m=>m.product.service==='buffet'?!m.product.available:!sellable(m.product));
 if(blocked.length)return {found,command:{intent:'clarify',message:blocked.map(m=>productName(m.product)+': '+(m.product.service==='buffet'?'agotado':m.product.price===null?'precio individual pendiente de confirmar':m.product.legacy_generic?'hay que elegir una variedad individual':'no disponible para nuevos pedidos')).join('. ')+'. El equipo puede ayudarte. Conservamos tu carrito sin agregar productos.'}};
 if(found.unknown.length)return {found,command:null};
 const items=new Map((cart?.items||[]).map(x=>[x.variant_id,{variant_id:x.variant_id,qty:x.qty,notes:x.notes||''}]));
 for(const m of found.matches){const old=items.get(m.product.id);items.set(m.product.id,{variant_id:m.product.id,qty:(old?.qty||0)+m.qty,notes:old?.notes||''});}
 if([...items.values()].some(x=>x.qty<1||x.qty>30))return {found,command:{intent:'clarify',message:'Indicá entre 1 y 30 unidades por producto.'}};
 return {found,command:{intent:'update_cart',items:[...items.values()]}};
}
