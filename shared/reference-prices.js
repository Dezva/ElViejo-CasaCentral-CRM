import { BUFFET_CATEGORIES } from './buffet-categories.js';
import { categoryKey, commercialText, productTerms } from './catalog.js';
import { deliveryQueryRequested, deliveryReferenceCommand } from './delivery-context.js';
import { fulfillmentChoice } from './order-engine.js';
import { orderStatusRequested } from './order-status.js';

const byName = new Map([
  ['guarnicion', 'guarniciones'], ['guarniciones', 'guarniciones'],
  ['carne', 'carne'], ['carne vacuna', 'carne'], ['carne res', 'carne'], ['res', 'carne'],
  ['pollo', 'pollo_chancho'], ['chancho', 'pollo_chancho'], ['cerdo', 'pollo_chancho'],
  ['pollo y chancho', 'pollo_chancho'], ['pollo y cerdo', 'pollo_chancho'],
]);
const priceTerms = /\b(?:precios?|tarifas?|costos?|cuanto (?:me |nos )?(?:cuesta|cuestan|sale|salen|vale|valen|esta|estan|es|seria|queda|quedaria|cobran)|(?:a|en) cuanto|a como|presupuesto|cotizacion)\b/;
const orderTerms = /\b(?:quiero|quisiera|necesito|deme|dame|agrega\w*|suma\w*|anad\w*|pedir|pido|llevo|mandame|enviame|cambia\w*|corrig\w*|corregi)\b/;
const otherTopic = /^(?:hola|buenas|gracias|menu|carta|catalogo|que tienen|que hay|horarios?|forma de pago|metodo de pago|pago|ubicacion|localizacion|referencia|confirmo|confirmar|cancelar|reiniciar|retiro|delivery|a domicilio)\b/;
const handoff = /\b(?:humano|persona|encargado|empleado)\b/;
const finalAmount = /\b(?:total(?:es)?|subtotal(?:es)?|presupuesto|cotizacion|descuentos?|impuestos?|cuanto (?:me |nos )?(?:queda|quedaria)|(?:mi|el) pedido|envio|delivery)\b/;
const subjectWords = new Set('a al como cual cuales cuanto cuesta cuestan sale salen vale valen esta estan es son seria precio tarifa costo valor figura kilo kilogramo kg kgr por el la lo los las un uno una y que tiene tienen tenes me nos uds ustedes cobra cobran saben saber podrias podes decir dirias decime dime pasame referencia buffet hoy ahora porfa favor gracias consultar consulta quiero quisiera para del de'.split(' '));
const format = new Intl.NumberFormat('es-PY', { useGrouping: 'always' });
const staff = 'El importe final de tu pedido lo confirma el encargado.';

function subjectOf(text) {
  return commercialText(text).split(' ').filter(word => !subjectWords.has(word)).join(' ');
}

export function referencePriceRequest(text, cart) {
  const value = categoryKey(text).replace(/[^a-z0-9\s]/g, ' ').trim().replace(/\s+/g, ' ');
  if (/\b(?:hablar con|pasame con|que me atienda) (?:un[ae]? |el |la )?(?:humano|persona|encargado|empleado)\b/.test(value)) return null;
  if (priceTerms.test(value) || /^(?:y )?(?:cuanto|por (?:kilos?|kg|kilogramos?))\b/.test(value) &&
      !/\b(?:tarda|demora|dura|tiempo)\b/.test(value)) return { intent: 'reference_prices' };
  // Un nombre suelto después de una consulta sigue siendo una consulta.
  if (cart?.reference_price_context && value && !orderTerms.test(value) && !otherTopic.test(value) &&
      !handoff.test(value) && !fulfillmentChoice(value) && !orderStatusRequested(value) &&
      !deliveryQueryRequested(text) && !deliveryReferenceCommand(text, cart)) {
    return { intent: 'reference_prices' };
  }
  return null;
}

function rate(category, settings) {
  const value = settings.reference_prices?.[category.id];
  return Number.isSafeInteger(value) && value > 0
    ? `Gs. ${format.format(value)} por kilo`
    : 'tarifa por kilo pendiente de confirmación';
}

export function referencePriceReply(text, menu, settings) {
  const value = categoryKey(text);
  if (finalAmount.test(value)) {
    return 'Las tarifas por kilo son de referencia. El equipo revisa el pedido y determina el importe final y el costo de envío cuando corresponda.';
  }

  const subject = subjectOf(text);
  if (!subject) {
    const rates = BUFFET_CATEGORIES.map(category => `• ${category.name} — ${rate(category, settings)}`);
    return ['Estas son nuestras tarifas de referencia por kilo:', ...rates, staff].join('\n');
  }

  const categoryId = byName.get(subject);
  const dishes = categoryId ? [] : menu.filter(dish => productTerms(dish).some(term => subjectOf(term) === subject));
  if (dishes.length > 1) return '¿Cuál de estos platos querés consultar? ' + dishes.map(dish => dish.name).join(', ') + '.';
  const dish = dishes[0];
  const category = BUFFET_CATEGORIES.find(entry => entry.id === (categoryId || dish?.category_id));
  if (!category) {
    if (dish) return `La clasificación de ${dish.name} está pendiente. El equipo puede confirmar la referencia. ${staff}`;
    return 'No identifiqué ese plato en el menú publicado de hoy. Decime el nombre tal como figura en el menú o consultame por una categoría del buffet.';
  }

  const reference = `${category.name} — ${rate(category, settings)}.`;
  const dishInfo = dish ? `${dish.name} figura en la categoría ${category.name}${dish.available ? '' : ' y está agotado hoy'}. ` : '';
  return dishInfo + reference + ' ' + staff;
}
