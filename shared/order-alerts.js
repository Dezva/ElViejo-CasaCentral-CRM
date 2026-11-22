// Solo IDs observados y preferencias locales. No almacena clientes ni mensajes.
export function createAlertTracker({storage,key}){
 let state={version:1,initialized:false,seen:[],unread:[],sound:false},pending=[],persisted=true;
 function sync(){try{const v=JSON.parse(storage.getItem(key)||'null');if(v?.version===1&&Array.isArray(v.seen)&&Array.isArray(v.unread))state={version:1,initialized:true,seen:v.seen.filter(x=>typeof x==='string'),unread:v.unread.filter(x=>typeof x==='string'),sound:v.sound===true};}catch{persisted=false;}}
 function save(){try{storage.setItem(key,JSON.stringify(state));}catch{persisted=false;}}
 sync();
 return {
  ingest(orders){sync();pending=orders.filter(o=>o.status==='pending').map(o=>({id:o.id,number:o.number,service:o.service,status:o.status,created_at:o.created_at}));const seen=new Set(state.seen),fresh=state.initialized?pending.filter(o=>!seen.has(o.id)):[];for(const o of orders)seen.add(o.id);const pendingIds=new Set(pending.map(o=>o.id));state.unread=[...new Set([...state.unread,...fresh.map(o=>o.id)])].filter(id=>pendingIds.has(id));state.seen=[...seen];state.initialized=true;save();return fresh;},
  markRead(ids){sync();const read=new Set(ids);state.unread=state.unread.filter(id=>!read.has(id));save();},
  setSound(value){sync();state.sound=value===true;save();},
  isNew:id=>state.unread.includes(id),
  snapshot:()=>({pending:[...pending],unread:[...state.unread],sound:state.sound,persisted})
 };
}
