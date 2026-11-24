const silent = new Set(['sticker', 'reaction', 'gif']);
const readable = new Set(['image', 'video', 'audio', 'document']);

// Marcador de historial sin URL, identificadores de medios ni datos del archivo.
export function mediaReceipt(message) {
  const animated = (message.type === 'image' || message.type === 'video') &&
    /^image\/gif(?:\s*;|$)/i.test(message[message.type]?.mime_type || '');
  const type = animated ? 'gif' : message.type;
  return `[Contenido ${silent.has(type) || readable.has(type) ? type : 'multimedia'} recibido]`;
}

export function mediaDisposition(message) {
  // Los eventos encolados antes del despliegue conservan el marcador anterior.
  const receipt = message.body?.match(/^\[Contenido ([a-z_]+) recibido(?:: requiere atención humana)?\]$/);
  const type = receipt?.[1] || message.content_type;
  if (silent.has(type)) return 'ignore';
  if (readable.has(type) || type === 'multimedia' || receipt && !['location', 'live_location'].includes(type)) return 'ask_text';
  return null;
}
