import {createHmac,timingSafeEqual} from 'node:crypto';
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
// El encabezado siempre es ASCII, aunque la variable contenga Unicode.
// Es una credencial de portador: no registrar su valor ni exponerla al navegador.
export function workerToken(secret){
 return typeof secret==='string'&&secret.length?'v1.'+createHmac('sha256',secret).update('el-viejo:dispatch-background:v1','utf8').digest('hex'):null;
}
export function workerAuthorized(candidate,secret){
 const expected=workerToken(secret);if(!expected)return false;
 if(equal(candidate,expected))return true;
 // Compatibilidad con invocadores anteriores que ya usaban un secreto ASCII válido.
 return /^[\x21-\x7e]+$/.test(secret)&&equal(candidate,secret);
}
