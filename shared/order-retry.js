export const repeatOrderPrompt='Volvé a enviar el pedido completo, con todos los productos y cantidades. La nueva lista comenzará un pedido nuevo, sin sumar artículos del intento anterior. Escribí MENÚ para ver las opciones.';

// Acción interna: el modelo no puede ordenar reiniciar un borrador.
export function retryOrderCommand(reason='No pude identificar todos los productos del pedido en las opciones disponibles.'){
 return {intent:'retry_order',message:reason+' Reinicié el borrador del buffet; este intento no se envió al local.\n'+repeatOrderPrompt};
}
