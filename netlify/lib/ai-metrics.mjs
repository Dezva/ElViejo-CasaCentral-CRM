import {randomUUID} from 'node:crypto';
import {db} from './platform.mjs';
export function metricRecord({model,operation,usage,contextChars}){
 if(!['conversation','vision'].includes(operation)||typeof model!=='string'||!model||model.length>160)return null;
 const row={id:randomUUID(),model,operation,created_at:new Date().toISOString()};
 for(const key of ['input_tokens','output_tokens','total_tokens'])if(Number.isSafeInteger(usage?.[key])&&usage[key]>=0)row[key]=usage[key];
 if(Number.isSafeInteger(contextChars)&&contextChars>=0)row.context_chars=contextChars;
 return row;
}
export async function recordUsage(input){const row=metricRecord(input);if(!row)return false;try{await db('/rest/v1/viejo_ai_usage',{method:'POST',body:row});return true;}catch{return false;}}
