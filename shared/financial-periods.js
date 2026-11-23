export const periods=[['today','Hoy'],['week','Esta semana'],['month','Este mes'],['previous_month','Mes anterior'],['custom','Rango personalizado'],['all','Todo el historial']];
export function localDay(date=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Asuncion',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
export function periodBounds(period='month',from,to,date=new Date()){
 const day=localDay(date),today=new Date(day+'T12:00:00Z'),iso=d=>d.toISOString().slice(0,10),month=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),1,12));
 if(period==='all')return {from:null,to:null};
 if(period==='custom'){if(![from,to].every(d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d)||from>to)throw Error('Revisá las fechas del período.');return {from,to};}
 if(period==='today')return {from:day,to:day};
 if(period==='week'){const start=new Date(today);start.setUTCDate(today.getUTCDate()-(today.getUTCDay()+6)%7);const end=new Date(start);end.setUTCDate(start.getUTCDate()+6);return {from:iso(start),to:iso(end)};}
 if(period==='previous_month'){const end=new Date(month);end.setUTCDate(0);month.setUTCMonth(month.getUTCMonth()-1);return {from:iso(month),to:iso(end)};}
 const end=new Date(month);end.setUTCMonth(month.getUTCMonth()+1);end.setUTCDate(0);return {from:iso(month),to:iso(end)};
}
export function demoFinancial(data,{period='month',from,to,service='all'}={}){
 const bounds=periodBounds(period,from,to),within=value=>value&&(period==='all'||localDay(new Date(value))>=bounds.from&&localDay(new Date(value))<=bounds.to),os=data.orders.filter(o=>service==='all'||o.service===service),ms=(data.paymentMovements||[]).filter(m=>(service==='all'||m.service===service)&&within(m.occurred_at)),completed=os.filter(o=>o.status==='delivered'&&(period==='all'||within(o.completed_at))),sum=kind=>ms.filter(m=>m.kind===kind).reduce((s,m)=>s+m.amount,0);
 return {...bounds,period,service,pending:os.filter(o=>o.status==='pending').length,active:os.filter(o=>['accepted','preparing','ready','out_for_delivery'].includes(o.status)).length,completed:completed.length,completed_amount:completed.reduce((s,o)=>s+(o.total||0),0),receipts:sum('receipt'),refunds:sum('refund'),net:sum('receipt')-sum('refund'),undated_completed:os.filter(o=>o.status==='delivered'&&!o.completed_at).length,unknown_completed_amount:os.filter(o=>o.status==='delivered'&&o.total==null).length,unknown_payments:os.filter(o=>['paid','refunded'].includes(o.payment_status)&&!(data.paymentMovements||[]).some(m=>m.original_order_id===o.id&&m.kind==='receipt')).length,retained_movements:ms.filter(m=>!m.order_id).length};
}
