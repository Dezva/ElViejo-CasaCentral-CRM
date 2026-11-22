// Referencias comerciales, nunca tarifas para calcular pedidos del buffet.
export const BUFFET_CATEGORIES = Object.freeze([
  {id:'guarniciones',name:'Guarniciones'},
  {id:'carne',name:'Carne'},
  {id:'pollo_chancho',name:'Pollo y chancho'}
]);
export const CATEGORY_IDS = Object.freeze([...BUFFET_CATEGORIES.map(c=>c.id),'pending']);
export const categoryName = id => BUFFET_CATEGORIES.find(c=>c.id===id)?.name || 'Pendiente de clasificación';
export function legacyCategory(item){
 const raw=String(item.category_id??item.category??'').trim().toLowerCase();
 return ({guarniciones:'guarniciones',carne:'carne',pollo_chancho:'pollo_chancho','pollo y chancho':'pollo_chancho',pending:'pending'})[raw]||'pending';
}
export function normalizeLegacyItem(item){
 const category_id=legacyCategory(item);
 return {...item,category_id,available:category_id==='pending'?false:item.available===true};
}
export function validateMenuItems(items,{published=false}={}){
 if(!Array.isArray(items)||items.length>100||(published&&!items.length))throw Error('El menú debe tener entre 1 y 100 platos para publicar.');
 const ids=new Set(),names=new Set();
 for(const p of items){
  if(!p||typeof p.id!=='string'||!p.id.trim()||p.id.length>120||typeof p.name!=='string'||!p.name.trim()||p.name.length>120||/[<>\u0000-\u001f]/.test(p.name))throw Error('Revisá los nombres e identificadores de los platos.');
  if(!CATEGORY_IDS.includes(p.category_id)||Object.hasOwn(p,'category'))throw Error('Usá los identificadores oficiales de categorías.');
  if(typeof p.available!=='boolean')throw Error('La disponibilidad debe indicarse para cada plato.');
  const name=p.name.trim().normalize('NFC').toLocaleLowerCase('es');
  if(ids.has(p.id)||names.has(name))throw Error('Hay platos o identificadores duplicados.');
  ids.add(p.id);names.add(name);
  if(published&&p.category_id==='pending'&&p.available)throw Error('Clasificá los platos pendientes o marcalos como no disponibles antes de publicar.');
 }
 return items;
}

const nameKey=p=>p.name.trim().normalize('NFC').toLocaleLowerCase('es');
export function mergeMenuProposal(current,proposed,mode){
 const prior=new Map(current.map(p=>[nameKey(p),p]));
 const incoming=proposed.map(p=>{const old=prior.get(nameKey(p));return {...p,id:old?.id||p.id,available:p.category_id!=='pending'&&(mode!=='replace'&&old&&old.category_id!=='pending'?old.available===true:p.available!==false)};});
 if(mode==='replace')return incoming;
 const byName=new Map(current.map(p=>[nameKey(p),p]));for(const p of incoming)byName.set(nameKey(p),p);return [...byName.values()];
}
