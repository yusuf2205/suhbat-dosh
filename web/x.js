// A page with downloading switched off: no context menu on pictures and videos, no dragging them out. (This stops the casual save,
// not a screenshot or a determined person: what is shown on a screen can always be copied.)
for (const ev of ['contextmenu', 'dragstart']) document.addEventListener(ev, (e) => { if (e.target.closest?.('img, video, audio')) e.preventDefault(); });
