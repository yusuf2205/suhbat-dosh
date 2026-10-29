// Parts of the app that are switched off in the menus: fewer things to look at while working.
// Nothing is deleted: the data stays on the server, and a part comes back as soon as its name is taken out of this list.
const OFF = new Set(['calendar', 'tasks', 'selfnotes', 'rooms', 'focus', 'digest', 'stories', 'storage', 'scheduled', 'chattheme', 'autodelete', 'chatsound', 'chatexport', 'deals']);

export const featureOn = (id) => !OFF.has(id);
