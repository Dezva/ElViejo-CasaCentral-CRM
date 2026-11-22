import {randomUUID} from 'node:crypto';
import {env,db} from './platform.mjs';
import {decodeImage,visionError} from './vision.mjs';
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const bucket=()=>env('MENU_PHOTO_BUCKET','el-viejo-menu-private');
async function storage(path,options={}) {
 const base=env('SUPABASE_URL'),key=env('SUPABASE_SECRET_KEY');
 if(!base||!key)throw visionError('storage_not_configured','Falta configurar almacenamiento privado.',409);
 const headers={apikey:key,...(key.startsWith('eyJ')?{authorization:'Bearer '+key}:{}),...options.headers};
 return fetch(base+'/storage/v1/'+path,{...options,headers,signal:AbortSignal.timeout(15000)});
}
async function privateBucket() {
 if(!/^[a-z0-9-]{1,100}$/.test(bucket()))throw visionError('invalid_bucket','Configuración de almacenamiento inválida.',409);
 const r=await storage('bucket/'+bucket());
 if(!r.ok)throw visionError('storage_not_ready','El bucket privado no está disponible. Aplicá la preparación de Storage en el entorno aislado.',409);
 const data=await r.json();
 if(data.public!==false)throw visionError('public_bucket_forbidden','El bucket debe ser privado. No se subió ni descargó una fotografía.',409);
}
export async function uploadPhoto(image,actor) {
 if(env('MENU_PHOTO_STORAGE_ENABLED')!=='true')throw visionError('storage_disabled','Storage privado está desactivado; se conserva el modo compatible.',409);
 const {bytes,type,hash}=decodeImage(image);
 const days=env('MENU_PHOTO_RETENTION_DAYS');
 if(days&&!/^[1-9][0-9]{0,3}$/.test(days))throw visionError('invalid_retention','La conservación debe ser un número de días positivo.',409);

 await privateBucket();
 const path=hash+'.'+type.split('/')[1];
 const existing=await db('/rest/v1/viejo_menu_photos?hash=eq.'+hash);
 if(existing.length)return existing[0];
 const r=await storage('object/'+bucket()+'/'+path,{method:'POST',headers:{'content-type':type,'x-upsert':'false'},body:bytes});
 if(!r.ok&&r.status!==409)throw visionError('storage_upload_failed','No se pudo guardar la foto privada. No se publicó ningún menú.');
 const photo={id:randomUUID(),hash,path,content_type:type,byte_size:bytes.length,created_by:actor,expires_at:days?new Date(Date.now()+Number(days)*86400000).toISOString():null};
 await db('/rest/v1/viejo_menu_photos?on_conflict=hash',{method:'POST',body:photo,prefer:'resolution=ignore-duplicates'});
 return (await db('/rest/v1/viejo_menu_photos?hash=eq.'+hash))[0];
}
export async function readPhoto({menuId,photoId}) {
 let legacy;
 if(menuId){
  if(!uuid(menuId))throw visionError('invalid_photo_id','Identificador de menú inválido.',400);
  const menus=await db('/rest/v1/viejo_menus?id=eq.'+menuId+'&select=photo_id,image');
  if(!menus.length)throw visionError('photo_not_found','No se encontró el menú.',404);
  photoId=menus[0].photo_id;legacy=menus[0].image;
 }
 if(!photoId){if(legacy)return decodeImage(legacy);throw visionError('photo_not_found','Este menú no tiene foto original.',404);}
 if(!uuid(photoId))throw visionError('invalid_photo_id','Identificador de foto inválido.',400);
 const photos=await db('/rest/v1/viejo_menu_photos?id=eq.'+photoId);
 if(!photos.length)throw visionError('photo_not_found','No se encontró la foto.',404);
 const p=photos[0];
 if(!/^[0-9a-f]{64}\.(png|jpeg|webp)$/.test(p.path))throw visionError('invalid_photo_path','La referencia de foto es inválida.');
 await privateBucket();
 const r=await storage('object/'+bucket()+'/'+p.path);
 if(!r.ok)throw visionError('storage_download_failed','No se pudo recuperar la foto original.');
 const bytes=Buffer.from(await r.arrayBuffer()),decoded=decodeImage('data:'+p.content_type+';base64,'+bytes.toString('base64'));
 if(decoded.hash!==p.hash)throw visionError('photo_integrity','La foto no coincide con su registro.');
 return decoded;
}
export async function readPhotoDataURL(ids) {
 const {bytes,type}=await readPhoto(ids);return 'data:'+type+';base64,'+bytes.toString('base64');
}
