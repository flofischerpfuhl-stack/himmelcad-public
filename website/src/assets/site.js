const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}

const videos = [...document.querySelectorAll('video[data-in-view]')];
if (videos.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const video = entry.target;
        if (entry.isIntersecting && !reducedMotion.matches) video.play().catch(() => {});
        else video.pause();
      }
    },
    { rootMargin: '100px' },
  );
  videos.forEach((video) => observer.observe(video));
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(button.dataset.copy || '');
    button.textContent = 'Copied';
  });
}

const ua = `${navigator.userAgentData?.platform || ''} ${navigator.userAgent}`.toLowerCase();
const os = ua.includes('win')
  ? 'windows'
  : ua.includes('mac')
    ? 'macos'
    : ua.includes('linux')
      ? 'linux'
      : '';
if (os) {
  for (const link of document.querySelectorAll(`[data-os-primary="${os}"]`)) link.hidden = false;
  for (const row of document.querySelectorAll(`[data-os="${os}"]`))
    row.classList.add('detected-os');
}
