import {member,json} from '../lib/platform.mjs';
import {canEditMenu} from '../../shared/permissions.js';
import {uploadPhoto,readPhoto} from '../lib/menu-photos.mjs';
export default async request=>{
 try{
  const m=await member(request);
  if(request.method==='GET'){
   const url=new URL(request.url),photo=await readPhoto({menuId:url.searchParams.get('menu_id'),photoId:url.searchParams.get('photo_id')});
   return new Response(photo.bytes,{headers:{'content-type':photo.type,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }
  if(request.method!=='POST')return json({error:'Método inválido.'},405);
  if(!canEditMenu(m))return json({error:'Necesitás permiso de edición de menú.'},403);
  const raw=await request.text();if(raw.length>4300000)return json({error:'Imagen demasiado grande.'},413);
  const photo=await uploadPhoto(JSON.parse(raw).image,m.user_id);
  return json({photo_id:photo.id});
 }catch(error){return json({error:error.status?error.message:'No se pudo acceder a la foto privada.'},error.status||502);}
};
