import {commercialText,productName} from './catalog.js';
import {matchCommercial,clarifyOptions} from './catalog-matching.js';

const removal=/\b(?:quita\w*|saca\w*|elimina\w*|borra\w*)\b/;
export function cartOperationCommand(text,cart,catalog){
 if(/^\s*(?:no|nunca)\b/i.test(text))return null;
 const t=commercialText(text),pending=cart?.conversation?.pending;
 const explicit=removal.test(t),followup=!explicit&&pending?.operation==='remove'&&!/\b(?:quiero|quisiera|agrega\w*|suma\w*|\d+)\b/.test(t);
 if(!explicit&&!followup)return null;
 if(!cart?.items?.length)return {intent:'clarify',message:'El borrador no tiene productos para quitar. Si querés hacer un pedido, enviame los artículos y cantidades.'};
 const available=cart.items.map(item=>catalog.find(product=>product.id===item.variant_id)||{...item,id:item.variant_id,service:'buffet'});
 const cleaned=t.replace(removal,' ').replace(/\b(?:borrador|carrito|pedido|entonces)\b/g,' ');
 const found=matchCommercial(cleaned,available,{context:cart.conversation});
 if(found.unknown.length||!found.matches.length&&!found.ambiguous.length)return {intent:'clarify',message:'No identifiqué qué producto del borrador querés quitar. Decime su nombre y variedad; tu pedido sigue igual.'};
 if(found.ambiguous.length){
  const match=found.ambiguous[0],command=clarifyOptions(match.products,match.qty,'remove');
  command.message='¿Qué producto querés quitar: '+match.products.map(productName).join(', ')+'? Tu pedido sigue igual.';
  command.context.pending.remove_qty=match.explicitQty?match.qty:null;
  command.context.pending.remove_resolved=found.matches.map(m=>({id:m.product.id,qty:m.explicitQty?m.qty:null}));
  return command;
 }
 if(followup&&!found.matches.every(m=>pending.candidate_ids.includes(m.product.id)))return {intent:'clarify',message:'Elegí uno de los productos que querés quitar. No cambié el pedido.'};
 const mentions=[...(followup?pending.remove_resolved||[]:[]),...found.matches.map(m=>({id:m.product.id,qty:followup?pending.remove_qty:m.explicitQty?m.qty:null}))],grouped=new Map();
 for(const target of mentions){const previous=grouped.get(target.id);grouped.set(target.id,previous?{id:target.id,qty:previous.qty===null||target.qty===null?null:previous.qty+target.qty}:target);}
 const targets=[...grouped.values()];
 if(targets.some(target=>!available.some(product=>product.id===target.id)))return {intent:'clarify',message:'El borrador cambió desde esa consulta. Decime nuevamente qué producto querés quitar; no cambié tu pedido.'};
 if(targets.some(target=>target.qty!==null&&(!Number.isSafeInteger(target.qty)||target.qty<1||target.qty>(cart.items.find(item=>item.variant_id===target.id)?.qty||0))))return {intent:'clarify',message:'La cantidad que querés quitar no coincide con el borrador. Indicá el producto y cuántas unidades querés quitar; no cambié tu pedido.'};
 const items=cart.items.flatMap(item=>{
  const target=targets.find(target=>target.id===item.variant_id);if(!target)return [{...item}];
  const qty=target.qty===null?0:item.qty-target.qty;return qty>0?[{...item,qty}]:[];
 });
 return {intent:'cart_edit',items,context:{focus_ids:items.map(item=>item.variant_id)},message:'Quité '+targets.map(target=>productName(available.find(product=>product.id===target.id))).join(', ')+'.'};
}
