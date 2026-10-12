# Боты Suhbat-dosh

Боты работают как в Telegram: токен, методы `/bot<TOKEN>/<method>`, обновления через `getUpdates` или вебхук.

## Создать бота
Меню «Новый чат» → **Создать бота (BotGrandFather)** или поиск `@botgrandfather`. Команды `/newbot` и `/mybots`, дальше кнопками:
токен, команды, описание, вебхук, удаление. Токен показывается один раз; «Новый токен» делает старый недействительным.

## Адрес API
```
https://suhbat-dosh.uz/bot<TOKEN>/<method>
```
Тело: JSON или `application/x-www-form-urlencoded`; параметры можно передавать и в строке запроса.
Ответ: `{"ok": true, "result": …}` или `{"ok": false, "error_code": …, "description": …}`.

## Поддерживаемые методы
`getMe`, `getUpdates`, `sendMessage`, `sendPhoto` / `sendDocument` / `sendVoice` / `sendAudio` / `sendVideo` (файл по URL или `file_id`),
`editMessageText`, `editMessageReplyMarkup`, `deleteMessage`, `sendChatAction`, `answerCallbackQuery`,
`setMyCommands` / `getMyCommands` / `deleteMyCommands`, `setWebhook` / `deleteWebhook` / `getWebhookInfo`, `getChat`, `getFile`
(+ скачивание `GET /file/bot<TOKEN>/files/<id>`).

Inline-кнопки: `reply_markup: {"inline_keyboard": [[{"text": "Да", "callback_data": "yes"}]]}`; кнопки с `url` открывают ссылку.

## Что получает бот
* В личном чате — все сообщения пользователя.
* В группе — только команды (`/…`), упоминания `@имя_бота` и ответы на сообщения бота (как «режим приватности» в Telegram).
* Нажатие inline-кнопки приходит как `callback_query`.
* Команды из `setMyCommands` показываются у пользователей кнопкой «/» рядом со смайлом.

## Пример на Node.js (long polling)
```js
const BASE = 'https://suhbat-dosh.uz/bot' + process.env.TOKEN;
const call = (m, body) => fetch(`${BASE}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
let offset = 0;
for (;;) {
  const { result = [] } = await call('getUpdates', { offset, timeout: 30 });
  for (const u of result) {
    offset = u.update_id + 1;
    const m = u.message;
    if (m?.text === '/start') await call('sendMessage', { chat_id: m.chat.id, text: 'Привет! Выберите:', reply_markup: { inline_keyboard: [[{ text: 'Да', callback_data: 'yes' }, { text: 'Нет', callback_data: 'no' }]] } });
    if (u.callback_query) {
      await call('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: 'Принято' });
      await call('sendMessage', { chat_id: u.callback_query.message.chat.id, text: `Вы выбрали: ${u.callback_query.data}` });
    }
  }
}
```

## Вебхук и безопасность
* `setWebhook` принимает только публичные адреса. Адреса из локальной сети NAS запрещены (защита от SSRF); если бот живёт на том же NAS,
  используйте `getUpdates` либо включите `BOT_WEBHOOK_ALLOW_PRIVATE=1` в `.env`.
* Для вебхука можно задать `secret_token` — он придёт в заголовке `X-Telegram-Bot-Api-Secret-Token`.
* Лимит: 60 запросов в секунду на бота, до 10 ботов на пользователя.
* Загрузка файлов `multipart/form-data` не поддерживается — передавайте URL или `file_id`.
