import {rm,mkdir,cp,writeFile} from 'node:fs/promises';
import {defaults} from '../shared/viejo-engine.js';
const dist=new URL('../dist/',import.meta.url);
await rm(dist,{recursive:true,force:true});await mkdir(dist,{recursive:true});
await cp(new URL('../public/',import.meta.url),dist,{recursive:true});
await cp(new URL('../shared/',import.meta.url),new URL('shared/',dist),{recursive:true});

const config={supabaseUrl:process.env.PUBLIC_SUPABASE_URL||'',publishableKey:process.env.PUBLIC_SUPABASE_KEY||'',apiBase:'/api'};
if(config.publishableKey&& !config.publishableKey.startsWith('sb_publishable_'))throw Error('Usá una clave Supabase publishable; nunca service_role/secret.');
await writeFile(new URL('config.js',dist),'window.VIEJO_CONFIG='+JSON.stringify(config)+';\n');
// No SQL generation at build time; migration files remain stable.
await writeFile(new URL('defaults.json',dist),JSON.stringify(defaults));
console.log(`Build Buffet El Viejo — Casa Central`);
