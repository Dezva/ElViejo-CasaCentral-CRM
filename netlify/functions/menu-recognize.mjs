import {createHash} from 'node:crypto';
import {providerConfig} from '../../shared/ai-provider.js';
import {canEditMenu} from '../../shared/permissions.js';
import {env,member,json,db} from '../lib/platform.mjs';
import {validateImage,validateVisionResult,recognizeImage,VISION_SCHEMA_VERSION,usageCounts} from '../lib/vision.mjs';
import {readPhotoDataURL} from '../lib/menu-photos.mjs';
export {validateImage} from '../lib/vision.mjs';
export default async request=>{
 try {
  const m=await member(request);
  if(!canEditMenu(m))return json({error:'Necesitás permiso de edición de menú.'},403);
  if(request.method!=='POST')return json({error:'Método inválido.'},405);
  const raw=await request.text();if(raw.length>4300000)return json({error:'Imagen demasiado grande.'},413);
  const body=JSON.parse(raw);
  const image=body.image||await readPhotoDataURL({menuId:body.menu_id,photoId:body.photo_id});
  const imageHash=validateImage(image),config=providerConfig(env,true);
  const hash=createHash('sha256').update([imageHash,config.endpoint,config.model,VISION_SCHEMA_VERSION].join('|')).digest('hex');
  const cached=await db('/rest/v1/viejo_image_cache?hash=eq.'+hash);
  if(cached.length){
   const proposal=validateVisionResult({items:cached[0].items.map(p=>({name:p.name,category_id:p.category_id}))});
   return json({items:proposal.map((p,i)=>({...p,id:'plato-'+hash.slice(0,16)+'-'+i,available:p.category_id!=='pending'})),cached:true,review_required:true,usage:usageCounts(cached[0].usage)});
  }
  if(env('AI_IMAGE_ENABLED')!=='true')return json({error:'Reconocimiento real desactivado. Podés transcribir y revisar el menú manualmente.'},409);
  const result=await recognizeImage(image,{config});
  const items=result.items.map((p,i)=>({...p,id:'plato-'+hash.slice(0,16)+'-'+i,available:p.category_id!=='pending'}));
  await db('/rest/v1/viejo_image_cache?on_conflict=hash',{method:'POST',body:{hash,items,usage:result.usage},prefer:'resolution=merge-duplicates'});
  return json({items,review_required:true,usage:result.usage,cached:false});
 }catch(error){return json({error:error.status?error.message:'No se pudo procesar la imagen. Revisá el formato y la configuración.',...(error.code?{code:error.code}:{})},error.status||400);}
};
