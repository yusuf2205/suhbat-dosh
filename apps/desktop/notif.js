const q = new URLSearchParams(location.search);
const title = q.get('title') || 'Suhbat-dosh';
document.getElementById('title').textContent = title;
document.getElementById('body').textContent = q.get('body') || '';
document.getElementById('ico').textContent = (title.trim()[0] || 'S').toUpperCase();
document.getElementById('card').addEventListener('click', () => window.suhbatShell.notifClick(Number(q.get('chat')) || 0));
document.getElementById('x').addEventListener('click', (e) => { e.stopPropagation(); window.suhbatShell.notifClose(); });
