// Coordenadas compartidas por el cliente. La API no acredita su presencia física.
function coordinate(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validPoint(location) {
  if (!location || location.kind && location.kind !== 'point') return false;
  const latitude = coordinate(location.latitude);
  const longitude = coordinate(location.longitude);
  return latitude !== null && longitude !== null &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function parseLocationMessage(message) {
  const location = message.location;
  if (message.type === 'live_location' || location?.is_live === true || Number(location?.live_period) > 0) {
    return {content_type: 'live_location', location: null};
  }
  if (!validPoint(location)) return {content_type: 'invalid_location', location: null};
  return {
    content_type: 'location',
    location: {
      latitude: coordinate(location.latitude), longitude: coordinate(location.longitude),
      name: typeof location.name === 'string' ? location.name.slice(0, 200) : '',
      address: typeof location.address === 'string' ? location.address.slice(0, 500) : ''
    }
  };
}

export function mapsUrl(location) {
  if (!validPoint(location)) return null;
  return 'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent(`${Number(location.latitude)},${Number(location.longitude)}`);
}

export async function copyLocationLink(location, clipboard = globalThis.navigator?.clipboard) {
  const url = mapsUrl(location);
  if (!url) throw Error('La ubicación no tiene coordenadas válidas.');
  if (!clipboard?.writeText) throw Error('No se pudo acceder al portapapeles. Abrí Google Maps y copiá su enlace.');
  try { await clipboard.writeText(url); }
  catch { throw Error('El navegador no permitió copiar el enlace. Abrí Google Maps y copiá su enlace.'); }
  return url;
}

export const locationRequest = '¡Perfecto! Para completar tu pedido de delivery, enviame tu ubicación actual desde WhatsApp 📍. No hace falta compartirla en tiempo real.';
export const fulfillmentQuestion = '¿Tu pedido sería para retirar en el local o para delivery?';
