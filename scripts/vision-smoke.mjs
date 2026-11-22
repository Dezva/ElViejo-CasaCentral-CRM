// Prueba MANUAL con costo potencial. Nunca se importa desde las suites ni se ejecuta en CI.
import {readFile,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateImage} from '../netlify/lib/vision.mjs';
export function checkOptIn(vars){
 if(vars.CI)throw Error('La prueba real está prohibida en CI.');
 if(vars.RUN_REAL_VISION_TEST!=='I_AUTHORIZE_ISOLATED_VISION_TEST')throw Error('Falta autorización explícita RUN_REAL_VISION_TEST para una prueba aislada.');
 const url=new URL(vars.VISION_TEST_BASE_URL||'');
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.hostname!==vars.VISION_TEST_ALLOWED_HOST)throw Error('Definí la URL HTTPS y el hostname exacto del despliegue AISLADO autorizado.');
 if(!vars.VISION_TEST_BEARER)throw Error('Falta la sesión del encargado autorizado en VISION_TEST_BEARER (variable segura).');
 return url.origin;
}
export async function main(){
 const origin=checkOptIn(process.env),file=process.argv[2],output=process.argv[3];
 if(!file||!output)throw Error('Uso: node scripts/vision-smoke.mjs FOTO RUTA_RESULTADO.json');
 const type={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[extname(file).toLowerCase()];
 const bytes=await readFile(file),image='data:'+type+';base64,'+bytes.toString('base64');validateImage(image);
 const response=await fetch(origin+'/.netlify/functions/menu-recognize',{method:'POST',headers:{authorization:'Bearer '+process.env.VISION_TEST_BEARER,'content-type':'application/json'},body:JSON.stringify({image}),signal:AbortSignal.timeout(90000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Falló la prueba aislada.');
 // No publicar, no enviar WhatsApp, no incluir token/foto/credenciales en resultados.
 await writeFile(output,JSON.stringify({review_required:result.review_required,cached:result.cached,items:result.items,usage:result.usage||{}},null,2)+'\n',{flag:'wx'});
 console.log('Propuesta guardada para revisión humana. No se publicó ningún menú.');
 console.log('Uso informado por proveedor:',JSON.stringify(result.usage||{}));
 if(result.cached)console.log('Resultado de caché: esta llamada no mide una inferencia nueva.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(err=>{console.error(err.message);process.exitCode=1;});
