import {BUFFET_CATEGORIES} from './buffet-categories.js';
export const WEEK_DAYS=Object.freeze([{value:1,label:'Lunes'},{value:2,label:'Martes'},{value:3,label:'Miércoles'},{value:4,label:'Jueves'},{value:5,label:'Viernes'},{value:6,label:'Sábado'},{value:0,label:'Domingo'}]);
export const PAYMENT_METHODS=Object.freeze([{value:'Efectivo',label:'Efectivo'},{value:'Tarjeta de débito',label:'Débito'},{value:'Tarjeta de crédito',label:'Crédito'},{value:'QR',label:'QR'},{value:'Transferencia',label:'Transferencia'}]);
export const DELIVERY_MODES=Object.freeze(['scheduled','pending','disabled']);
const time=value=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export function deliveryMode(config,service){
 const s=config.schedules?.[service]||{};
 if(DELIVERY_MODES.includes(s.delivery_mode))return s.delivery_mode;
 if(Array.isArray(config.fulfillment_modes)&&!config.fulfillment_modes.includes('delivery'))return 'disabled';
 return time(s.delivery_open)&&time(s.delivery_close)?'scheduled':'pending';
}
export function normalizeSettings(config){
 const c=structuredClone(config);c.schedules??={};
 for(const service of ['buffet'])if(c.schedules[service])c.schedules[service].delivery_mode=deliveryMode(config,service);
 return c;
}
export function validateSettings(c){
 if(!c||typeof c!=='object'||Array.isArray(c))throw Error('La configuración no es válida.');
 if(typeof c.business_name!=='string'||!c.business_name.trim()||c.business_name.length>120)throw Error('Ingresá un nombre comercial de hasta 120 caracteres.');
 for(const k of ['branch','business_address','business_phone','business_email'])if(c[k]!=null&&(typeof c[k]!=='string'||c[k].length>500))throw Error('Revisá los datos de contacto del negocio.');
 if(c.business_email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.business_email))throw Error('Ingresá un correo de contacto válido.');
 if(c.logo_url&&(!/^(assets\/[A-Za-z0-9_./-]+|https:\/\/[^\s]+)$/.test(c.logo_url)||c.logo_url.length>1000))throw Error('La imagen debe ser un archivo del CRM o un enlace HTTPS.');
 if(c.timezone!=='America/Asuncion'||typeof c.bot_enabled!=='boolean')throw Error('Revisá la configuración del asistente y la zona horaria.');
 if(!Array.isArray(c.payment_methods)||new Set(c.payment_methods).size!==c.payment_methods.length||c.payment_methods.some(p=>!PAYMENT_METHODS.some(x=>x.value===p)))throw Error('Seleccioná únicamente los métodos de pago disponibles en la pantalla.');
 if(!Array.isArray(c.fulfillment_modes)||new Set(c.fulfillment_modes).size!==c.fulfillment_modes.length||c.fulfillment_modes.some(x=>!['retiro','delivery','local'].includes(x)))throw Error('Revisá las modalidades de entrega del local.');
 if(Object.keys(c.schedules||{}).some(service=>service!=='buffet'))throw Error('Solo se admite el horario del buffet.');
 for(const service of ['buffet']){
  const label='Buffet',s=c.schedules?.[service];
  if(!s||!Array.isArray(s.days)||new Set(s.days).size!==s.days.length||s.days.some(d=>!Number.isInteger(d)||d<0||d>6))throw Error(label+': seleccioná al menos un día de atención, sin repetir días.');
  if((s.days.length||s.open||s.close)&&(!s.days.length||!time(s.open)||!time(s.close)))throw Error(label+': completá los horarios de apertura y cierre.');
  if(s.days.length&&s.open>=s.close)throw Error(label+': el cierre debe ser posterior a la apertura.');
  if(!DELIVERY_MODES.includes(s.delivery_mode))throw Error(label+': elegí cómo funciona el delivery. Actualizá la pantalla si falta esta opción.');
  if(s.delivery_mode==='scheduled'){
   if(!s.days.length||!time(s.delivery_open)||!time(s.delivery_close))throw Error(label+': completá el inicio y el fin del delivery.');
   if(s.delivery_open>=s.delivery_close)throw Error(label+': el fin del delivery debe ser posterior al inicio.');
   if(s.delivery_open<s.open||s.delivery_close>s.close)throw Error(label+': el delivery debe estar dentro del horario de atención.');
  }
 }
 if(c.fulfillment_modes.includes('delivery')!==['buffet'].some(service=>c.schedules[service].delivery_mode!=='disabled'))throw Error('Revisá las modalidades de delivery del buffet.');
 for(const {id} of BUFFET_CATEGORIES)if(c.reference_prices?.[id]!=null&&(!Number.isSafeInteger(c.reference_prices[id])||c.reference_prices[id]<=0||c.reference_prices[id]>2147483647))throw Error('Las tarifas de referencia deben ser importes enteros positivos en guaraníes.');
 return c;
}
