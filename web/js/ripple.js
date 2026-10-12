// Press feedback: a soft ripple from the pointer position on any button-like control.
const SEL = '.btn, .icon-btn, .chip, .menu button, .bottomnav button, .list-item.clickable, .adm-tabs button';

document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.(SEL);
  if (!el || el.disabled) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${e.clientX - r.left - size / 2}px`;
  dot.style.top = `${e.clientY - r.top - size / 2}px`;
  el.classList.add('has-ripple');
  el.append(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
}, { passive: true });
