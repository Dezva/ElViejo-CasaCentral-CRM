export const branchName = 'Ruta Villeta–Alberdi';
export const brandName = 'Buffet El Viejo';
export const businessName = `${brandName} — ${branchName}`;
export const branchReference = `${branchName}, Paraguay`;

const normalizedLabel = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function normalizeBranchIdentity(settings = {}) {
 const identity = {...settings};
 if (normalizedLabel(identity.branch) === 'casa central') identity.branch = branchName;
 if (normalizedLabel(identity.business_name) === 'buffet el viejo — casa central') identity.business_name = businessName;
 if (normalizedLabel(identity.business_address) === 'ruta guarambaré–villeta, esquina villetana, frente a impaco, paraguay') {
  identity.business_address = branchReference;
 }
 return identity;
}

// Las instalaciones anteriores generan este encabezado en SQL.
const legacyOrderHeader = '*🍽️ BUFFET EL VIEJO — CASA CENTRAL*';
export function branchMessageBody({actor,body}) {
 if (actor === 'system' && body?.startsWith(legacyOrderHeader+'\n\n*Pedido #')) {
  return '*🍽️ '+businessName.toUpperCase()+'*'+body.slice(legacyOrderHeader.length);
 }
 return body;
}
