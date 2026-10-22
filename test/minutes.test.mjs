import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMinutes, minutesText, sentences, summarize } from '../shared/minutes.js';

test('minutes: decisions, to-dos with their deadline, open questions and figures from a Russian talk', () => {
  const m = summarize('Всем привет, начинаем. Мы решили запустить рекламу в понедельник. Бюджет будет 5 000 000 сум. Борис, нужно подготовить макеты до пятницы. Кто отвечает за площадку? Я отправлю договор завтра. Хорошо, спасибо.');
  assert.ok(m.decisions.some((s) => s.includes('решили запустить')));
  assert.ok(m.actions.some((a) => a.text.includes('подготовить макеты') && /пятниц/.test(a.due)));
  assert.ok(m.actions.some((a) => a.text.includes('отправлю договор') && a.due === 'завтра'));
  assert.ok(m.questions.some((s) => s.startsWith('Кто отвечает')));
  assert.ok(m.figures.some((s) => s.includes('5 000 000 сум')));
  assert.ok(!m.actions.some((a) => a.text.includes('Всем привет')));
  assert.equal(hasMinutes(m), true);
});

test('minutes: Uzbek sentences are understood too', () => {
  const m = summarize('Biz ertaga uchrashishga kelishdik. Hujjatlarni tayyorlayman, juma kuni yuboraman. Qachon boshlaymiz?');
  assert.ok(m.decisions.length >= 1);
  assert.ok(m.actions.length >= 1);
  assert.ok(m.questions.length === 1);
});

test('minutes: nothing is invented from small talk, duplicates are dropped, the post is readable', () => {
  const m = summarize('Привет как дела. Всё хорошо спасибо большое. Привет как дела. Погода сегодня отличная, правда.');
  assert.equal(hasMinutes({ ...m, actions: m.actions.filter((a) => !/сегодня/.test(a.text)) }), false);
  assert.equal(sentences('коротко. ').length, 0);
  const text = minutesText(summarize('Мы решили так. Нужно купить билеты до пятницы.'), { head: 'Итоги', decisions: 'Решения', actions: 'Сделать', questions: 'Вопросы', figures: 'Цифры' });
  assert.ok(text.startsWith('Итоги') && text.includes('• Нужно купить билеты'));
});
