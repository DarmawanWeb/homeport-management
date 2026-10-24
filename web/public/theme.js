// Applied before first paint so a saved theme does not flash. Kept as a file so the CSP can forbid inline scripts.
try {
  const t = localStorage.getItem('hp_theme');
  if (t) document.documentElement.dataset.theme = t;
} catch {}
