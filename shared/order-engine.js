import {locationRequest,fulfillmentQuestion} from './locations.js';
export const money = value => new Intl.NumberFormat('es-PY').format(value) + ' Gs.';
export const normalize = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
export const isConfirmation = s => /^(confirmar|confirmo)\s+(el\s+)?pedido[.!]?$/i.test(normalize(s));
const fulfillmentAnswers={retiro:'retiro',retirar:'retiro','para retirar':'retiro','para retiro':'retiro','retirar en el local':'retiro','para retirar en el local':'retiro',delivery:'delivery','para delivery':'delivery','a domicilio':'delivery','envio a domicilio':'delivery',local:'local','en el local':'local'};
export function fulfillmentChoice(text) {
 const key=normalize(text).replace(/[.!?]+$/,'');
 return Object.hasOwn(fulfillmentAnswers,key)?fulfillmentAnswers[key]:null;
}
export function emptyCart(name='') { return {items:[],customer_name:name,fulfillment:'a_coordinar',address:'',payment:'a_coordinar',quoted:false,delivery_location_id:null,fulfillment_asked:false,location_requested:false}; }

function fulfillmentPrompt(cart, force=false) {
  if(cart.fulfillment==='a_coordinar'&&(force||!cart.fulfillment_asked)) {
    cart.fulfillment_asked=true;
    return '\n'+fulfillmentQuestion;
  }
  if(cart.fulfillment==='delivery'&&!cart.delivery_location_id&&(force||!cart.location_requested)) {
    cart.location_requested=true;
    return '\n'+locationRequest;
  }
  return '';
}
export function hydrateCart(cart, catalog) {
  const c={...emptyCart(),...cart,items:[]};
  let changed=false;
  for(const item of cart?.items||[]) {
    const p=catalog.find(p=>p.id===item.variant_id);
    if(!p||!p.available||!Number.isSafeInteger(p.price)||p.price<=0){changed=true;continue;}
    if(!Number.isInteger(item.qty)||item.qty<1||item.qty>30)throw Error('La cantidad debe ser entre 1 y 30.');
    if(p.price!==item.unit_price)changed=true;
    c.items.push({variant_id:p.id,name:p.name,variant:p.variant,qty:item.qty,unit_price:p.price,notes:String(item.notes||'').slice(0,300)});
  }
  if(changed)c.quoted=false;
  return {cart:c,changed};
}
export function subtotal(cart) { return cart.items.reduce((s,x)=>s+x.unit_price*x.qty,0); }
export function cartSummary(cart) {
  return cart.items.map(x=>`${x.qty} × ${x.name}${x.variant==='Base'?'':' · '+x.variant}: ${money(x.qty*x.unit_price)}${x.notes?' ('+x.notes+')':''}`).join('\n')+
    `\nSubtotal de productos: ${money(subtotal(cart))}.\nModalidad: ${cart.fulfillment.replaceAll('_',' ')}${cart.address?' · '+cart.address:''}.\nPago: ${cart.payment}.\nEnvío y tiempo de preparación: a confirmar por el local.`;
}
export function reduceOrder({text,cart:oldCart,catalog,command,profileName='',settings={}}) {
  const refreshed=hydrateCart(oldCart||emptyCart(profileName),catalog);
  let cart=refreshed.cart;
  const key=normalize(text);
  const choice=fulfillmentChoice(text);
  if(choice)command={intent:'summary',fulfillment:choice};
  if(['/cancelar','/reiniciar','cancelar pedido'].includes(key))return {cart:emptyCart(profileName),reply:'Borrador cancelado. El historial del chat se conserva. ¿Qué te gustaría pedir?',kind:'reply'};
  if(/\b(humano|persona|encargado|empleado)\b/.test(key)&&/\b(hablar|atender|quiero|necesito)\b/.test(key)||command?.intent==='human')return {cart,reply:'Avisé al equipo para que continúe la atención por este chat.',kind:'human'};
  if(isConfirmation(text)) {
    if(!cart.items.length)return {cart,reply:'Todavía no hay productos en tu pedido. Decime qué querés pedir.',kind:'reply'};
    if(refreshed.changed||!cart.quoted){cart.quoted=true;return {cart,reply:'Revisá este resumen actualizado:\n'+cartSummary(cart)+'\nSi está correcto, escribí CONFIRMAR PEDIDO. Quedará pendiente de aceptación del local.'+fulfillmentPrompt(cart),kind:'reply'};}
    const missing=fulfillmentPrompt(cart,true);
    if(missing)return {cart,reply:missing.trim(),kind:'reply'};
    return {cart,reply:'',kind:'submit'};
  }
  if(command?.intent==='update_cart') {
    if(!Array.isArray(command.items)||command.items.length>30)throw Error('Pedido inválido.');
    const seen=new Set();
    const items=command.items.map(x=>{
      const p=catalog.find(p=>p.id===x.variant_id&&p.available);
      if(!p)throw Error('Ese producto no está disponible.');
      if(!Number.isInteger(x.qty)||x.qty<1||x.qty>30)throw Error('La cantidad debe ser entre 1 y 30.');
      const key=x.variant_id+'|'+String(x.notes||'');if(seen.has(key))throw Error('Agrupá los productos repetidos en una sola cantidad.');seen.add(key);
      return {variant_id:p.id,name:p.name,variant:p.variant,qty:x.qty,unit_price:p.price,notes:String(x.notes||'').slice(0,300)};
    });
    cart={...cart,items,quoted:false};
  }
  const oldMetadata=JSON.stringify([cart.customer_name,cart.fulfillment,cart.address,cart.payment]);
  if(command?.customer_name)cart.customer_name=String(command.customer_name).slice(0,120);
  if(command?.fulfillment&&['retiro','delivery','local'].includes(command.fulfillment)){
    if(cart.fulfillment!==command.fulfillment)cart.location_requested=false;
    cart.fulfillment=command.fulfillment;
  }
  if(command?.address)cart.address=String(command.address).slice(0,500);
  if(command?.payment)cart.payment=String(command.payment).slice(0,120);
  const metadataChanged=oldMetadata!==JSON.stringify([cart.customer_name,cart.fulfillment,cart.address,cart.payment]);
  if(cart.items.length&&(command?.intent==='update_cart'||command?.intent==='summary'||refreshed.changed||metadataChanged)) {
    cart.quoted=true;
    return {cart,reply:cartSummary(cart)+'\nPara enviarlo al local, escribí CONFIRMAR PEDIDO. Todavía no está aceptado.'+fulfillmentPrompt(cart),kind:'reply'};
  }
  // El texto libre de la IA no anuncia registros, precios ni aceptación de pedidos.
  if(command?.intent==='info')return {cart,reply:`Horarios para pedidos: ${settings.hours||'a confirmar con el local'}.\nModalidades: ${(settings.fulfillment_modes||[]).join(', ')||'a coordinar con el local'}.\nFormas de pago: ${(settings.payment_methods||[]).join(', ')||'a confirmar con el local'}.\nEnvíos: ${settings.delivery_notes||'zonas y costos a confirmar con el local'}.`,kind:'reply'};
  if(command?.intent==='menu') {
    const list=catalog.filter(p=>p.available&&(!command.category||normalize(p.category).includes(normalize(command.category)))&&(!command.query||normalize(p.name+' '+p.variant).includes(normalize(command.query))));
    if(!list.length)return {cart,reply:'No encontré una opción disponible con ese nombre. Decime el nombre tal como aparece en el menú o pedime hablar con el equipo.',kind:'reply'};
    return {cart,reply:list.slice(0,24).map(p=>`${p.name}${p.variant==='Base'?'':' · '+p.variant}: ${money(p.price)}`).join('\n')+(list.length>24?'\nHay más opciones. Pedime una categoría: pizzas, sándwiches, hamburguesas o acompañamientos.':'')+'\nDisponibilidad y aceptación sujetas al local.',kind:'reply'};
  }
  const prompt=cart.items.length||cart.fulfillment==='delivery'?fulfillmentPrompt(cart):'';
  if(prompt&&(cart.items.length||cart.fulfillment==='delivery'))return {cart,reply:prompt.trim(),kind:'reply'};
  return {cart,reply:'¡Hola! Soy el asistente de Guarnipitan Bar. Puedo mostrarte el menú y preparar tu pedido para que el local lo confirme. Decime qué productos y cantidades querés, o escribí MENÚ. Para atención del equipo, escribí QUIERO HABLAR CON UNA PERSONA.',kind:'reply'};
}
// Solo para la demo; la conexión real interpreta el texto mediante IA y valida aquí.
export function demoCommand(text,cart,catalog) {
 const s=normalize(text);
 if(['retiro','para retirar','retirar','delivery','para delivery','local','en el local'].includes(s))return {intent:'summary',fulfillment:s.includes('delivery')?'delivery':s.includes('local')?'local':'retiro'};
 if(s.includes('menu')||s.includes('carta'))return {intent:'menu',category:''};
 const match=catalog.filter(p=>p.variant==='Base'&&s.includes(normalize(p.name))).sort((a,b)=>b.name.length-a.name.length)[0];
 if(match){const qty=Number(s.match(/\b(\d{1,2})\b/)?.[1]||1);return {intent:'update_cart',items:[...(cart?.items||[]).filter(x=>x.variant_id!==match.id),{variant_id:match.id,qty,notes:''}]};}
 return {intent:'summary'};
}
