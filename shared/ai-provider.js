// Configuración de servidor, nunca obtenida desde prompts ni desde el navegador.
export function providerConfig(env,vision=false){
 const base=env('AI_BASE_URL')||'https://api.openai.com/v1';
 const url=new URL(base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('invalid_ai_endpoint');
 return {endpoint:base.replace(/\/$/,'')+'/responses',key:env('AI_API_KEY')||env('OPENAI_API_KEY'),model:vision?(env('AI_VISION_MODEL')||env('OPENAI_VISION_MODEL')):(env('AI_MODEL')||env('OPENAI_MODEL'))};
}
