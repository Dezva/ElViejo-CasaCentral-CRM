import {referencePriceRequest,referencePriceReply} from './reference-prices.js';
import {deterministicConversation,cartRequestKey} from './conversation-context.js';
import {deliveryMode} from './settings.js';
import {CATEGORY_IDS,categoryName} from './buffet-categories.js';
import {normalize,isConfirmation} from './order-engine.js';
import {fulfillmentChoice} from './fulfillment.js';
import {informationReply,paymentChoice} from './customer-messages.js';
import {retryOrderCommand,repeatOrderPrompt} from './order-retry.js';
import {deliveryReferenceCommand} from './delivery-context.js';
export {normalize,isConfirmation,fulfillmentChoice};
export const money=n=>n==null?'Pendiente':new Intl.NumberFormat('es-PY').format(n)+' Gs.';
export const greeting='¡Buenas! Bienvenido a Buffet El Viejo — Casa Central. ¿Querés consultar nuestro menú del día o hacer un pedido?';
export const defaults={"business_name":"Buffet El Viejo — Casa Central","branch":"Casa Central","business_address":"Ruta Guarambaré–Villeta, esquina Villetana, frente a IMPACO, Paraguay","logo_url":"assets/abuelito-provisional.png","timezone":"America/Asuncion","bot_enabled":false,"payment_methods":[],"fulfillment_modes":["retiro","delivery"],"schedules":{"buffet":{"days":[],"open":"","close":"","delivery_mode":"pending","delivery_open":null,"delivery_close":null}},"reference_prices":{"guarniciones":null,"carne":null,"pollo_chancho":null}};
export function localDate(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Asuncion',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function outsideBuffet(text){return /\bchiperia\b/.test(normalize(text));}
export function emptyCart(name='',service='buffet'){return {items:[],service,customer_name:name,fulfillment:'a_coordinar',address:'',payment:'a_coordinar',quoted:false,delivery_location_id:null,saved_carts:{}};}
export function activeCatalog(service,catalog,menus=[],now=new Date()){
 if(service==='buffet'){const menu=menus.find(m=>m.day===localDate(now)&&m.status==='published');return (menu?.items||[]).map(p=>({...p,service:'buffet',price:null,variant:'Base',category:categoryName(p.category_id),available:p.available!==false&&CATEGORY_IDS.includes(p.category_id)&&p.category_id!=='pending'}));}
 return [];
}
export function availability(service,fulfillment,settings=defaults,now=new Date()){
 const mode=deliveryMode(settings,service);
 if(fulfillment==='delivery'&&mode==='disabled')return 'El delivery está deshabilitado para este servicio. El equipo puede ayudarte a coordinar otra modalidad.';
 if(fulfillment==='delivery'&&mode==='pending')return 'El horario de delivery está pendiente de confirmación. El equipo debe coordinarlo antes de aceptar.';
 const s=settings.schedules?.[service]||defaults.schedules[service];
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Asuncion',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
 const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),time=parts.hour+':'+parts.minute;
 if(!s.days?.length||!s.open||!s.close)return 'El horario de atención está pendiente de confirmación.';
 if(!s.days.includes(day)||time<s.open||time>=s.close)return 'Fuera del horario de atención. El equipo debe revisar la solicitud.';
 if(fulfillment==='delivery'&&(!s.delivery_open||!s.delivery_close))return 'El horario de delivery está pendiente de confirmación. El equipo revisará la solicitud.';
 if(fulfillment==='delivery'&&(time<s.delivery_open||time>=s.delivery_close))return 'Fuera del horario de delivery. El equipo debe revisar la solicitud.';
 return null;
}
export function quote(items,service,catalog){
 if(service!=='buffet'||!Array.isArray(items)||items.length<1||items.length>30)throw Error('Seleccioná productos de un servicio.');
 const seen=new Set();
 const lines=items.map(x=>{
  const p=catalog.find(p=>p.id===x.variant_id&&p.service===service);
  if(!p||!p.available)throw Error('El plato no está disponible en el menú vigente.');
  if(!Number.isSafeInteger(x.qty)||x.qty<1||x.qty>30)throw Error('La cantidad debe ser entre 1 y 30.');
  if(seen.has(p.id))throw Error('Agrupá las cantidades del mismo producto.');seen.add(p.id);
  return {variant_id:p.id,name:p.name,variant:p.variant||'Base',qty:x.qty,unit_price:null,notes:String(x.notes||'').slice(0,300)};
 });
 return {items:lines,subtotal:null};
}
export function confirmation(order,input,catalog,{mode,owner_id,actor,menus=[],now=new Date(),settings=defaults}={}){
 if(input.fulfillment==='delivery'&&deliveryMode(settings,order.service)==='disabled')throw Error('El delivery está deshabilitado para este servicio.');
 const q=quote(order.items,order.service,activeCatalog(order.service,catalog,menus,now));
 if(!['retiro','delivery'].includes(input.fulfillment))throw Error('Confirmá retiro o delivery.');
 if(order.fulfillment!==input.fulfillment)throw Error('Revisá la modalidad del pedido antes de confirmar.');
 if(input.fulfillment==='delivery'&&!order.delivery_location_id)throw Error('Falta la ubicación puntual.');
 if(input.fulfillment==='delivery'&&(!Number.isSafeInteger(input.shipping_fee)||input.shipping_fee<0))throw Error('Establecé explícitamente el costo del delivery, incluso si es cero.');
 if(order.group_id&&!input.group_reviewed)throw Error('Revisá los pedidos relacionados para no duplicar el delivery.');
 const warning=availability(order.service,input.fulfillment,settings,now);if(warning&&!input.schedule_reviewed)throw Error(warning);
 if(order.service==='buffet'&&(mode!=='human'||owner_id!==actor))throw Error('Tomá la conversación para acordar el importe del buffet.');
 if(order.service==='buffet'&&(!Number.isSafeInteger(input.buffet_amount)||input.buffet_amount<=0||!input.price_agreed))throw Error('Registrá el importe acordado con el cliente.');
 const amount=input.buffet_amount,fee=input.fulfillment==='delivery'?input.shipping_fee:0;
 return {...q,subtotal:amount,shipping_fee:fee,total:amount+fee};
}
export function sameItems(a,b){const fields=['variant_id','name','variant','qty','unit_price','notes'];return JSON.stringify(a.map(x=>fields.map(k=>x[k])))===JSON.stringify(b.map(x=>fields.map(k=>x[k])));}
export function summary(cart){
 const modality={retiro:'Retiro en el local',delivery:'Delivery'}[cart.fulfillment]||'A coordinar';
 return cart.items.map(x=>`${x.qty} × ${x.name}${x.notes?' · '+x.notes:''}`).join('\n')+'\nImporte pendiente: el encargado lo acordará con vos.\nModalidad: '+modality+'.';
}
export function demoCommand(text,cart,catalog){
 return deterministicConversation(text,cart,catalog)||{intent:'help'};
}

export function reduceOrder({text,cart:old,catalog,menus=[],command,profileName='',settings=defaults,now=new Date()}){
 let cart=structuredClone({...emptyCart(profileName),...old,service:'buffet'});
 const reply=message=>({cart,kind:'reply',reply:message});
 const reset=message=>{
  const {reference_price_context,last_cart_request,...preserved}=cart;
  cart={...preserved,items:[],subtotal:null,quoted:false,conversation:{retry_order:true}};
  return reply(message);
 };
 if(outsideBuffet(text))return reply('Este número corresponde exclusivamente a Buffet El Viejo — Casa Central.');
 const list=activeCatalog(cart.service,catalog,menus,now);
 command??=demoCommand(text,cart,list);
 // Un resultado de interpretación no convierte un seguimiento de tarifa en una compra.
 if(command.intent==='update_cart'&&referencePriceRequest(text,cart,list))command={intent:'reference_prices'};
 const intent=command.intent;
 if(intent==='human')return {cart,kind:'human',reply:'El equipo continuará la atención. El asistente queda pausado.'};
 if(intent==='cancel_order')return {cart:emptyCart(profileName),kind:'reply',reply:'Borrador cancelado. Conservamos el historial.'};
 if(intent==='reference_prices'){
  cart.reference_price_context=true;
  return reply(referencePriceReply(text,list,settings));
 }
 if(intent==='technical_error')return reply('Por el momento no pude interpretar tu mensaje. Tu borrador sigue guardado. Reenviá el mensaje o pedí hablar con el equipo.');
 if(intent==='social')return reply(command.message||greeting);
 if(intent==='info')return reply(informationReply(command.topic,settings));
 if(intent==='status_reply')return reply(command.message);
 if(intent==='registered_status')return reply('No veo una solicitud registrada. Decime qué platos querés pedir.');
 if(intent==='registered_delivery')return reply('Para preparar un delivery, compartí un punto válido desde Adjuntar → Ubicación.');
 if(intent==='draft_status')return reply('Tu pedido está en borrador.\n'+summary(cart)+'\n'+(cart.fulfillment==='delivery'&&!cart.delivery_location_id?'Falta el punto de WhatsApp.':'Podés revisar los platos y confirmar la solicitud.'));
 if(intent==='retry_order')return reset(command.message);
 if(intent==='clarify'){
  if(command.context)cart.conversation=structuredClone(command.context);
  return reply(command.message);
 }
 if(intent==='menu'){
  if(!list.length)return reply('Todavía no hay menú del buffet confirmado para hoy. Podés pedir atención del encargado.');
  const dishes=list.filter(p=>p.available&&(!command.category_ids?.length||command.category_ids.includes(p.category_id))&&(!command.dish_ids||command.dish_ids.includes(p.id)));
  return reply(dishes.length?dishes.map(p=>p.name).join('\n')+'\nEl encargado acuerda los precios finales.':'Por ahora no hay platos disponibles en el menú de hoy.');
 }

 const updating=intent==='update_cart'||intent==='cart_edit';
 if(intent==='repeat_cart')delete cart.reference_price_context;
 if(updating){
  try{
   const updated=intent==='cart_edit'?{items:command.items,subtotal:null}:quote(command.items,cart.service,list);
   cart={...cart,...updated,conversation:structuredClone(command.context||{}),last_cart_request:cartRequestKey(text),quoted:false};
   delete cart.reference_price_context;
  }catch{
   return reset(retryOrderCommand('Cambió la disponibilidad del menú o hay una cantidad que no puedo registrar.').message);
  }
 }
 const choice=fulfillmentChoice(text);
 if(['retiro','delivery'].includes(choice)&&(intent==='summary'||intent==='update_cart')){
  delete cart.reference_price_context;
  cart.fulfillment=choice;
  if(choice==='retiro'){cart.delivery_location_id=null;cart.address='';cart.address_location_id=null;}
  if(!list.length)return reply('Todavía no hay menú del buffet confirmado para hoy. Podés pedir atención del encargado.');
 }
 const reference=deliveryReferenceCommand(text,cart);
 if(intent==='summary'&&reference){
  cart.address=reference.address;
  cart.address_location_id=null;
 }
 if(intent==='payment'){
  const payment=paymentChoice(text,settings);
  if(!payment)return reply(informationReply('payments',settings));
  cart.payment=payment;
  delete cart.reference_price_context;
  return reply('Anoté '+payment+' como forma de pago.');
 }
 if(isConfirmation(text)){
  if(!cart.items.length)return reply(cart.conversation?.retry_order?repeatOrderPrompt:'Elegí productos y cantidades antes de enviar la solicitud.');
  let fresh;
  try{fresh=quote(cart.items,cart.service,list);}
  catch{return reset(retryOrderCommand('Cambió la disponibilidad del menú.').message);}
  if(!cart.quoted||!sameItems(fresh.items,cart.items)){cart={...cart,...fresh,quoted:true};return reply('Revisá el resumen actualizado:\n'+summary(cart)+'\nEscribí CONFIRMAR PEDIDO.');}
  if(!['retiro','delivery'].includes(cart.fulfillment))return reply('¿Será retiro o delivery?');
  if(cart.fulfillment==='delivery'&&deliveryMode(settings,cart.service)==='disabled')return reply('El delivery está deshabilitado para este servicio. Elegí retiro o pedí atención del equipo.');
  if(cart.fulfillment==='delivery'&&!cart.delivery_location_id)return reply('Enviá tu ubicación puntual de WhatsApp para este delivery.');
  const warning=availability(cart.service,cart.fulfillment,settings,now);
  return {cart,kind:'submit',reply:'Solicitud pendiente de revisión humana.'+(warning?' '+warning:'')};
 }
 if(cart.items.length&&(updating||intent==='summary'||intent==='repeat_cart')){
  if(intent!=='repeat_cart')cart.quoted=true;
  return reply((intent==='cart_edit'?command.message+'\n':'')+summary(cart)+'\n'+(cart.fulfillment==='a_coordinar'?'¿Será retiro o delivery?':cart.fulfillment==='delivery'&&!cart.delivery_location_id?'Enviá tu ubicación puntual de WhatsApp.':'Escribí CONFIRMAR PEDIDO para solicitar revisión del local.'));
 }
 if(intent==='cart_edit'||intent==='repeat_cart')return reply((command.message?command.message+' ':'')+'El borrador quedó sin platos.');
 if(choice)return reply((choice==='retiro'?'Anoté retiro.':'Anoté delivery.')+' Decime qué platos y cantidades querés.');
 if(cart.conversation?.retry_order)return reply(repeatOrderPrompt);
 return reply(cart.items.length?'Tu borrador sigue guardado. Decime qué querés consultar o cambiar.':greeting);
}
