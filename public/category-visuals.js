import {BUFFET_CATEGORIES,categoryName} from './shared/buffet-categories.js';

// Presentation only: no IDs, validation rules or prices are persisted by this map.
export const CATEGORY_VISUALS = Object.freeze({
  carne: {label:categoryName('carne'),className:'category-carne',paths:'<path d="M8 3C4 3 2 6 2 10c0 5 4 10 9 10 5 0 10-4 10-9 0-4-3-8-7-8Z"/><circle cx="14" cy="9" r="3"/><path d="M5 10c2-1 3 0 4 2m-2 3c2-1 4 0 5 2"/>'},
  pollo_chancho: {label:categoryName('pollo_chancho'),className:'category-pollo',paths:'<path d="M9 13C6 10 8 5 12 3c3-1 7 2 8 5 1 4-2 7-5 7-2 0-3-2-4-1l-4 4m1-7-4 5"/><path d="M4 16c-2-1-4 2-2 4 1 1 2 0 2 0s-1 2 1 2c2 0 3-2 2-4"/>'},
  guarniciones: {label:categoryName('guarniciones'),className:'category-guarniciones',paths:'<path d="M3 12h18a9 9 0 0 1-18 0Zm2-1a3 3 0 0 1 3-4 4 4 0 0 1 8 0 3 3 0 0 1 3 4M8 8l1 1m3-3 1 1m2 2 1-1M8 21h8"/>'},
  pending: {label:categoryName('pending'),className:'category-pending',paths:'<circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4"/><circle cx="12" cy="16" r=".8" fill="currentColor" stroke="none"/>'}
});
export const categoryVisual = id => CATEGORY_VISUALS[id] || CATEGORY_VISUALS.pending;
export function categoryIcon(id){
 return `<svg class="category-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${categoryVisual(id).paths}</svg>`;
}
export function categoryBadge(id,count){
 const v=categoryVisual(id);
 return `<span class="category-badge ${v.className}">${categoryIcon(id)}<span>${v.label}</span>${count==null?'':`<b>${count}</b>`}</span>`;
}
export function categoryLegend(referencePrices={}){
 return `<section class="buffet-category-guide" aria-label="Categorías oficiales del buffet"><div class="category-guide-heading"><h2>Tres categorías, más fácil de revisar.</h2><p>Tarifas de referencia. El encargado acuerda el importe final de cada pedido.</p></div><div class="category-guide-grid">${BUFFET_CATEGORIES.map(c=>{const v=categoryVisual(c.id);return `<article class="category-guide-card ${v.className}"><span class="category-icon-tile">${categoryIcon(c.id)}</span><div><h3>${v.label}</h3><p>${referencePrices[c.id]==null?'Tarifa pendiente de confirmación':new Intl.NumberFormat('es-PY').format(referencePrices[c.id])+' Gs./kg de referencia'}</p></div></article>`;}).join('')}</div><p class="category-pending-guide">${categoryBadge('pending')}<span>Estado para revisar, no una categoría comercial. Clasificá el plato antes de ofrecerlo.</span></p></section>`;
}
export function categorySummary(items,{includeEmpty=true}={}){
 const counts=Object.fromEntries(Object.keys(CATEGORY_VISUALS).map(id=>[id,items.filter(p=>p.category_id===id).length]));
 return `<div class="menu-category-summary">${BUFFET_CATEGORIES.filter(c=>includeEmpty||counts[c.id]).map(c=>categoryBadge(c.id,counts[c.id])).join('')}${counts.pending?categoryBadge('pending',counts.pending):''}</div>`;
}
