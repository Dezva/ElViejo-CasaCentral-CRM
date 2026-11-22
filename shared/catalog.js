// La categoría organiza; cada registro vendible conserva su propio precio e ID.
export const categoryKey=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
export const INITIAL_CATEGORIES=['Chipas','Chipas rellenas','Empanadas','Tartas','Panes','Sándwiches','Facturas','Otros','Productos de temporada'].map((name,i)=>({id:'chiperia-'+i,name,position:i,active:true}));
export const productName=p=>p.name+(p.variant&&p.variant!=='Base'?' · '+p.variant:'');
export const searchProduct=(p,q)=>categoryKey([p.name,p.variant,...(p.aliases||[])].join(' ')).includes(categoryKey(q));
export const sellable=p=>p.active!==false&&p.category_active!==false&&!p.legacy_generic&&categoryKey(p.name)!=='facturas'&&p.available&&Number.isSafeInteger(p.price)&&p.price>0;
export function validateProduct(p){
 if(!p||typeof p.id!=='string'||!p.id||p.id.length>120||typeof p.name!=='string'||!p.name.trim()||p.name.length>120||typeof p.variant!=='string'||!p.variant.trim()||p.variant.length>80||typeof p.category_id!=='string'||!p.category_id)throw Error('Completá nombre y categoría del producto.');
 if(p.price!==null&&(!Number.isSafeInteger(p.price)||p.price<=0||p.price>2147483647))throw Error('Ingresá un precio individual entero positivo, o dejalo pendiente.');
 for(const k of ['available','active','seasonal'])if(typeof p[k]!=='boolean')throw Error('Revisá el estado del producto.');
 if(p.available&&p.active&&p.price===null)throw Error('Confirmá el precio individual antes de ofrecer este producto.');
 if(!Array.isArray(p.aliases)||p.aliases.length>30||p.aliases.some(x=>typeof x!=='string'||!x.trim()||x.length>120||categoryKey(x)==='facturas')||new Set(p.aliases.map(categoryKey)).size!==p.aliases.length)throw Error('Usá nombres alternativos distintos, de hasta 120 caracteres. «Facturas» es una categoría, no un sinónimo vendible.');
 return p;
}
export function validateCategory(c){
 if(!c||typeof c.id!=='string'||!c.id||c.id.length>120)throw Error('Categoría inválida.');
 if(c.remove)return c;
 if(typeof c.name!=='string'||!c.name.trim()||c.name.length>80||typeof c.active!=='boolean'||!Number.isSafeInteger(c.position)||c.position<0||c.position>9999)throw Error('Completá el nombre, orden y estado de la categoría.');return c;
}
export function migrateCatalogDemo(d){
 if(d.catalogMigrationV13)return;
 d.catalogBackupV12=structuredClone(d.catalog);d.categories=structuredClone(INITIAL_CATEGORIES);
 const find=name=>{const key=categoryKey(name==='Temporada'?'Productos de temporada':name);let c=d.categories.find(c=>categoryKey(c.name)===key);if(!c){c={id:'categoria-'+crypto.randomUUID(),name:name.trim(),position:d.categories.length,active:true};d.categories.push(c);}return c;};
 for(const p of d.catalog){const c=find(p.category);p.category_id=c.id;p.active=p.active??(p.price!==null);p.aliases??=[];p.created_at??=p.updated_at||new Date().toISOString();p.updated_at??=p.created_at;
 if(p.id==='facturas-base'&&categoryKey(p.name)==='facturas'){p.legacy_generic=true;p.active=false;p.available=false;}
 if(['pasta-frola-base','bollito-base'].includes(p.id)&&categoryKey(p.category)==='otros')p.category_id=INITIAL_CATEGORIES[6].id;
 if(p.id==='pasta-frola-base'&&categoryKey(p.name)==='pasta frola'&&!p.aliases.length)p.aliases=['Pastafrola'];
 p.category=d.categories.find(c=>c.id===p.category_id).name;
 }d.catalogMigrationV13=true;
}
export function withCategories(products,categories){return products.map(p=>({...p,category:categories.find(c=>c.id===p.category_id)?.name||p.category,category_active:categories.find(c=>c.id===p.category_id)?.active??true}));}
// Equivalencias gramaticales acotadas. Nunca convierte bollo en bollito ni usa categorías como alias.
export const commercialText=text=>categoryKey(text).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(x=>x&&!['de','del'].includes(x)).map(x=>x.length>3&&x.endsWith('s')&&!['tres','seis','gracias','mas'].includes(x)?x.slice(0,-1):x).join(' ');
export function productTerms(p){const full=p.name+(p.variant&&p.variant!=='Base'?' '+p.variant:'');return [...new Set([full,...(p.aliases||[]),p.name].map(commercialText))].filter(Boolean);}
export function synonymCollisions(product,catalog){return catalog.filter(p=>p.id!==product.id&&productTerms(p).some(t=>productTerms(product).includes(t))).map(productName);}
