// Runs once before app initialization, never during listening or SPA navigation.
const entryVersion = '__BUILD__';
try {
  const check = new URL('build.json', document.baseURI);
  check.searchParams.set('check', Date.now());
  const response = await fetch(check, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
  if (response.ok) {
    const { version } = await response.json();
    const current = new URL(location.href);
    if (/^[a-f0-9]{24}$/.test(version) && version !== entryVersion && current.searchParams.get('__ml_build') !== version) {
      current.searchParams.set('__ml_build', version);
      location.replace(current);
      // Navigation owns the next initialization; never start this old runtime.
      await new Promise(() => {});
    }
  }
} catch { /* An unavailable version check must not prevent a cached app starting. */ }
const cleanURL = new URL(location.href);
if (cleanURL.searchParams.get('__ml_build') === entryVersion) {
  cleanURL.searchParams.delete('__ml_build');
  history.replaceState(history.state, '', cleanURL);
}
