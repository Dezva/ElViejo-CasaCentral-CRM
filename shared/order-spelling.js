// Correcciones ortográficas, nunca equivalencias entre productos o categorías.
// Solo se corrige hacia palabras presentes en el catálogo actual del servicio.
function oneEdit(a, b) {
 if (Math.abs(a.length - b.length) > 1) return false;
 let i = 0;
 while (i < a.length && a[i] === b[i]) i++;
 if (i === a.length) return b.length === a.length + 1;
 if (a.length === b.length) {
  return a.slice(i + 1) === b.slice(i + 1) ||
   (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
 }
 return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function correctOrderTokens(tokens, vocabulary, reserved) {
 const words = [...vocabulary].filter(word => word.length >= 4 && /^[a-z]+$/.test(word));
 return tokens.map(token => {
  // Un nombre o sinónimo confirmado siempre gana a cualquier semejanza.
  if (reserved.has(token) || vocabulary.has(token) || !/^[a-z]+$/.test(token)) return token;
  // En palabras cortas una letra puede ser otro alimento: bollo/pollo, torta/tarta.
  if (token.length < 6) return token;
  const candidates = words.filter(word => oneEdit(token, word));
  // Dos candidatos cercanos requieren aclaración. No se elige por precio o disponibilidad.
  return candidates.length === 1 ? candidates[0] : token;
 });
}
