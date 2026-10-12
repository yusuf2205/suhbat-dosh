// Bots are created and configured in one place: the built-in "BotGrandFather" chat (commands + buttons).
import { api } from './net.js';
import { errText } from './i18n.js';
import { S, fire } from './state.js';
import { toast } from './ui.js';

/** Open the chat with BotGrandFather. */
export async function openBotFather() {
  try {
    const f = await api('GET', '/api/bots/father');
    const r = await api('POST', '/api/chats/direct', { user_id: f.user.id });
    S.chats.set(r.chat.id, r.chat);
    S.users.set(f.user.id, f.user);
    fire('view');
    fire('open-chat', r.chat.id);
  } catch (e) { toast(errText(e.code)); }
}
