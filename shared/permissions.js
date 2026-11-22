export const canEditMenu = member => member?.role === 'admin' || member?.menu_editor === true;
