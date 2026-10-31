// The Android app's own page when the messenger cannot be loaded: "Nearby" works with no server at all (see scripts/sync-offline.mjs).
import { t } from './i18n.js';
import { openNearby } from './nearby.js';

document.documentElement.lang = navigator.language?.startsWith('uz') ? 'uz' : 'ru';
document.getElementById('lead').textContent = t('nb.intro_offline');
const near = document.getElementById('near');
near.textContent = t('nb.title');
near.addEventListener('click', () => openNearby());
const again = document.getElementById('again');
again.textContent = t('nb.retry_connect');
again.addEventListener('click', () => location.replace('/index.html'));
window.__nativeBack = () => false;
openNearby();
