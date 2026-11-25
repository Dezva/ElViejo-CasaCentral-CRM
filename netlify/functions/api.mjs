import {validateSettings} from '../../shared/settings.js';
import {normalizeBranchIdentity,branchMessageBody} from '../../shared/branch-identity.js';
import {validateMenuItems} from '../../shared/buffet-categories.js';
import {canEditMenu} from '../../shared/permissions.js';
import {env,db,rpc,member,json,kick} from '../lib/platform.mjs';
import {validateImage} from './menu-recognize.mjs';
import {whatsappDiagnostics} from '../lib/diagnostics.mjs';
const allowed=new Set(['take','release','read','send','create_order','order_status','settings','client','delete_preview','delete_record','assign_location','menu','member','payment_status','order_details','history_preview','clear_history']);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export default async request=>{
 try{
  const m=await member(request);
  if(request.method==='GET'){
   const url=new URL(request.url);const chat=url.searchParams.get('conversation_id');
   if(url.searchParams.get('financial_summary')==='1'){
    const period=url.searchParams.get('period')||'month',service=url.searchParams.get('service')||'all',from=url.searchParams.get('from'),to=url.searchParams.get('to');
    const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
    if(!['today','week','month','previous_month','custom','all'].includes(period)||!['all','buffet'].includes(service)||period==='custom'&&(!date(from)||!date(to)||from>to))return json({error:'Revisá el período seleccionado.'},400);
    try{return json({summary:await rpc('viejo_financial_summary',{p_actor:m.user_id,p_period:period,p_service:service,p_from:period==='custom'?from:null,p_to:period==='custom'?to:null})});}catch(error){if(error.code==='PGRST202')return json({error:'Falta aplicar database/016_pedidos_finanzas_buffet.sql para consultar el resumen.'},409);throw error;}
   }
   if(url.searchParams.get('pending_orders')==='1')return json({orders:await rpc('viejo_pending_orders',{})});
   if(url.searchParams.has('order_id')){const id=url.searchParams.get('order_id');if(!uuid(id))return json({error:'Pedido inválido.'},400);const rows=await db('/rest/v1/guarni_orders?id=eq.'+id+'&select=*,delivery_location:guarni_locations!delivery_location_id(*)');if(!rows.length)return json({error:'El pedido ya no existe.'},404);const [history,clients]=await Promise.all([db('/rest/v1/viejo_history?order_id=eq.'+id+'&order=created_at.desc'),db('/rest/v1/crm_clients?id=eq.'+rows[0].client_id+'&select=id,name,phone')]);return json({order:rows[0],history,client:clients[0]});}
   if(url.searchParams.has('conversation_locations')){const id=url.searchParams.get('conversation_locations');if(!uuid(id))return json({error:'Conversación inválida.'},400);return json({locations:await db('/rest/v1/guarni_locations?conversation_id=eq.'+id+'&order=received_at.desc&limit=100')});}
   const locationId=url.searchParams.get('location_orders'),orderId=url.searchParams.get('order_locations');
   if(locationId||orderId){
    if(!uuid(locationId||orderId))return json({error:'Registro inválido.'},400);
    if(locationId){
     const points=await db('/rest/v1/guarni_locations?id=eq.'+locationId);
     if(!points.length)return json({error:'La ubicación ya no existe.'},404);
     const orders=await db('/rest/v1/guarni_orders?conversation_id=eq.'+points[0].conversation_id+'&or='+encodeURIComponent('(status.eq.pending,and(status.in.(accepted,preparing,ready,out_for_delivery),fulfillment.eq.delivery))')+'&order=created_at.desc&select=*,delivery_location:guarni_locations!delivery_location_id(*)');
     return json({locations:points,orders});
    }
    const orders=await db('/rest/v1/guarni_orders?id=eq.'+orderId+'&select=*,delivery_location:guarni_locations!delivery_location_id(*)');
    if(!orders.length)return json({error:'El pedido ya no existe.'},404);
    const locations=await db('/rest/v1/guarni_locations?conversation_id=eq.'+orders[0].conversation_id+'&order=received_at.desc&limit=100');
    return json({orders,locations});
   }
   if(url.searchParams.get('diagnostics')==='whatsapp'){
    if(m.role!=='admin')return json({error:'Esta comprobación requiere un administrador.'},403);
    return json(await whatsappDiagnostics());
   }
   if(chat){if(!/^[0-9a-f-]{36}$/i.test(chat))return json({error:'Chat inválido.'},400);
    const before=url.searchParams.get('before'),beforeId=url.searchParams.get('before_id');
    if(before&&(!/^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$/.test(before)||!/^[0-9a-f-]{36}$/i.test(beforeId||'')))return json({error:'Cursor inválido.'},400);
    const cursor=before?'&or='+encodeURIComponent(`(created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId}))`):'';
    const messages=await db('/rest/v1/guarni_messages?conversation_id=eq.'+chat+'&order=created_at.desc,id.desc&limit=100'+cursor);
    if(messages.length){
     const locations=await db('/rest/v1/guarni_locations?message_id=in.('+messages.map(message=>message.id).join(',')+')');
     const byMessage=new Map(locations.map(location=>[location.message_id,location]));
     for(const message of messages){
      message.body=branchMessageBody(message);
      if(byMessage.has(message.id))message.location=byMessage.get(message.id);
     }
    }
    return json({messages:messages.reverse()});
   }
   const [clients,conversations,orders,settings,members,menus,history,pendingOrders]=await Promise.all([
    db('/rest/v1/crm_clients?select=id,name,phone,email,notes,status,created_at&order=created_at.desc&limit=1000'),
    db('/rest/v1/guarni_conversations?select=id,client_id,wa_id,mode,owner_id,revision,unread,last_inbound_at,updated_at,cart,draft_location_id&order=updated_at.desc&limit=500'),
    db('/rest/v1/guarni_orders?order=created_at.desc&limit=500&select=*,delivery_location:guarni_locations!delivery_location_id(*)'),
    db('/rest/v1/guarni_settings?id=eq.true'),
    db('/rest/v1/crm_members?select=user_id,display_name,role,catalog_editor,menu_editor'),db('/rest/v1/viejo_menus?select=id,day,status,items,created_by,created_at,photo_id,has_legacy_image&order=created_at.desc&limit=90'),db('/rest/v1/viejo_history?order=created_at.desc&limit=2000'),rpc('viejo_pending_orders',{})
   ]);
   return json({photoStorageEnabled:env('MENU_PHOTO_STORAGE_ENABLED')==='true',member:m,clients,conversations,orders,catalog:[],pendingOrders,settings:normalizeBranchIdentity(settings[0]?.config),members,menus,history});
  }
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const raw=await request.text();if(raw.length>4500000)return json({error:'Solicitud demasiado grande.'},413);
  const body=JSON.parse(raw);if(!allowed.has(body.action))return json({error:'Acción inválida.'},400);
  if(body.action==='create_order'&&body.data?.service!=='buffet')return json({error:'Solo se admiten pedidos de buffet.'},400);
  if(body.action==='settings'){if(m.role!=='admin')return json({error:'Esta acción requiere un administrador.'},403);try{validateSettings(body.data?.config);}catch(error){return json({error:error.message},400);}}
  if(body.action==='assign_location'){
   const data=body.data||{};
   if(!uuid(data.order_id)||!uuid(data.location_id)||(data.expected_location_id!=null&&!uuid(data.expected_location_id)))return json({error:'Registro inválido.'},400);
   return json(await rpc('guarni_assign_location',{p_actor:m.user_id,p_order:data.order_id,p_location:data.location_id,p_expected:data.expected_location_id||null,p_approve:data.approve===true}));
  }
  if(['history_preview','clear_history','delete_preview','delete_record'].includes(body.action)){
   if(m.role!=='admin')return json({error:'Esta acción requiere un administrador.'},403);
   const data=body.data||{},history=['history_preview','clear_history'].includes(body.action),confirm=['clear_history','delete_record'].includes(body.action);
   if(!uuid(data.id)||!history&&!['client','order'].includes(data.kind))return json({error:'Registro inválido.'},400);
   if(confirm&&data.confirmation!==(history?'LIMPIAR':'ELIMINAR'))return json({error:history?'Escribí LIMPIAR para confirmar.':'Escribí ELIMINAR para confirmar.'},400);
   if(confirm&&!/^[a-f0-9]{32}$/.test(data.preview_token||''))return json({error:'Abrí y revisá la vista previa antes de confirmar.'},400);
   try{
    if(history)return json(await rpc('viejo_clear_history',{p_actor:m.user_id,p_conversation:data.id,p_confirm:confirm,p_preview_token:confirm?data.preview_token:null}));
    if(data.kind==='client')return json(await rpc('viejo_delete_client',{p_actor:m.user_id,p_id:data.id,p_confirm:confirm,p_delete_orders:confirm&&data.delete_orders===true,p_preview_token:confirm?data.preview_token:null}));
    return json(await rpc('viejo_delete_order',{p_actor:m.user_id,p_id:data.id,p_confirm:confirm,p_confirmation:confirm?data.confirmation:null,p_preview_token:confirm?data.preview_token:null,p_payment_ack:confirm&&data.payment_ack===true}));
   }catch(error){if(error.code==='PGRST202')return json({error:'Falta aplicar '+(!history&&data.kind==='order'?'database/016_pedidos_finanzas_buffet.sql':'database/015_historial_casa_central.sql')+' antes de usar estas herramientas.'},409);throw error;}
  }
  if(body.action==='menu'&&!canEditMenu(m))return json({error:'Necesitás permiso de edición de menú.'},403);
  if(body.action==='menu'){
   try{validateMenuItems(body.data?.items,{published:body.data?.status==='published'});const day=body.data?.day;if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw Error('Fecha de menú inválida.');}catch(error){return json({error:error.message},400);}
  }
  if(body.action==='menu'&&body.data?.image)validateImage(body.data.image);
  const result=await rpc('viejo_staff',{p_actor:m.user_id,p_action:body.action,p_data:body.data||{}});
  await kick(request);return json(result);
 }catch(error){
  const names={order_changed:'El pedido cambió mientras lo revisabas. Abrilo de nuevo antes de guardar.',confirmation_required:'Escribí ELIMINAR para confirmar.',payment_ack_required:'Revisá y confirmá la conservación de los movimientos de pago.',location_review_required:'Revisá la ubicación puntual antes de aceptar el delivery.',duplicate_delivery_fee:'El envío conjunto ya tiene un costo registrado. Usá cero para este pedido si comparten la entrega.',payment_method_required:'Seleccioná cómo se recibió el pago.',confirmed_amount_required:'Confirmá el importe del pedido antes de registrar un cobro.',invalid_payment_transition:'Revisá el estado del pago. Un cobro recibido se corrige mediante un reembolso.',invalid_period:'Revisá el período seleccionado.',active_orders:'Hay pedidos en curso. Terminá su atención antes de limpiar o eliminar.',queue_pending:'Hay envíos pendientes o de resultado incierto. Resolvelos antes de limpiar o eliminar.',preview_required:'Revisá primero la vista previa.',preview_changed:'La conversación cambió. Cerrá y actualizá la vista previa antes de confirmar.',history_ack_required:'Confirmá expresamente la eliminación de los pedidos históricos.',linked_records:'Hay registros relacionados con otro cliente. El equipo debe revisarlos antes de eliminar.',catalog_permission_required:'Necesitás permiso de edición de catálogo.',invalid_category:'Revisá el nombre y estado de la categoría.',duplicate_category:'Ya existe una categoría con ese nombre.',category_reassignment_required:'Elegí una categoría activa para reasignar los productos.',invalid_aliases:'Revisá los nombres alternativos. Facturas es una categoría.',generic_product_review:'Facturas es un registro histórico. Creá cada variedad con su precio individual.',delivery_disabled:'El delivery está deshabilitado para este servicio.',schedule_day_required:'Seleccioná al menos un día de atención por servicio.',invalid_schedule_days:'Revisá los días de atención seleccionados.',schedule_time_required:'Completá apertura y cierre.',schedule_close_after_open:'El cierre debe ser posterior a la apertura.',delivery_mode_required:'Elegí cómo funciona el delivery. Actualizá la pantalla si esta opción no aparece.',delivery_time_required:'Completá el inicio y el fin del delivery.',delivery_close_after_open:'El fin del delivery debe ser posterior al inicio.',delivery_outside_hours:'El horario de delivery debe estar dentro del horario de atención.',invalid_payment_methods:'Seleccioná métodos de pago reconocidos, sin duplicados.',invalid_reference_prices:'Revisá las tarifas de referencia: deben ser importes enteros positivos.',business_name_required:'Ingresá el nombre comercial.',invalid_business_contact:'Revisá los datos de contacto del negocio.',invalid_business_logo:'Usá un archivo del CRM o una imagen HTTPS.',invalid_fulfillment_modes:'Revisá las modalidades de entrega del local.',invalid_buffet_category:'Usá las categorías oficiales del buffet.',pending_category_available:'Clasificá los platos pendientes o marcalos como no disponibles.',duplicate_item:'Hay platos o identificadores duplicados.',invalid_menu_date:'Fecha del menú inválida.',invalid_availability:'Revisá la disponibilidad de los platos.',menu_permission_required:'Necesitás permiso de edición de menú.',schedule_review_required:'Verificá horarios y coordiná cualquier excepción antes de confirmar.',group_review_required:'Revisá los pedidos relacionados y el envío conjunto.',explicit_delivery_fee_required:'Ingresá explícitamente el costo del delivery, incluso si es cero.',agreed_buffet_amount_required:'Registrá el importe del buffet acordado con el cliente.',price_or_availability_changed:'Cambió el precio o la disponibilidad. Revisá el catálogo y la solicitud.',daily_menu_required:'Falta un menú del buffet publicado para hoy.',human_review_required:'Revisá el menú antes de publicarlo.',review_fulfillment:'Revisá y guardá la modalidad antes de confirmar.',invalid_payment:'Seleccioná un método de pago configurado.',price_required:'El producto disponible necesita un precio confirmado.',last_admin:'Debe quedar al menos un administrador.',owned_by_another_member:'Otro integrante está atendiendo este chat.',not_owner:'Solo quien tomó el chat o un administrador puede reactivar el bot.',processing_wait:'Hay un mensaje en proceso. Esperá unos segundos y volvé a intentar.',outside_customer_window:'Pasaron 24 horas desde el último mensaje del cliente. Esperá que escriba nuevamente.',take_conversation_first:'Tomá la conversación antes de responder.',invalid_transition:'El pedido cambió de estado. Actualizá la vista.',admin_required:'Esta acción requiere un administrador.',address_required:'Ingresá la dirección de entrega.',confirm_fulfillment_and_fee:'Confirmá la modalidad y el costo de envío.'};
  if(['order_changed','active_orders','queue_pending','preview_required','preview_changed','history_ack_required','linked_records','processing_wait'].includes(error.message))return json({error:names[error.message]},409);
  if(error.message==='not_found')return json({error:'El registro ya no existe. Actualizá la vista.'},404);
  const locationErrors={delivery_location_required:'Este delivery necesita una ubicación puntual válida. Asociá la ubicación recibida antes de aceptar.',invalid_location:'La ubicación no es válida para esta conversación.',location_order_closed:'La ubicación solo puede asociarse a un pedido pendiente o a un delivery en curso.',location_changed:'La ubicación del pedido cambió. Actualizá la vista y revisala otra vez.',location_approval_required:'Revisá y aprobá el cambio de ubicación del pedido aceptado.'};
  if(locationErrors[error.message])return json({error:locationErrors[error.message]},409);
  return json({error:names[error.message]||((error.status)?error.message:'No se pudo completar la operación. Revisá los datos y la conexión.')},error.status||400);
 }
};
