// ── New-version notice ─────────────────────────────────────────
// This is a PWA people leave open for days, so a deploy would otherwise go
// unnoticed until they happened to reload. We poll the deployed index.html and
// compare its asset version with the one THIS page was loaded with.
//
// Both numbers come from the same place — the ?v= on the script tags — so there
// is nothing extra to remember at release time: bumping index.html is what
// makes running copies notice. (Reading our own <script src> is why this needs
// no build step or version file.)
const RUNNING_VERSION = (() => {
  const src = (document.currentScript && document.currentScript.src) || '';
  const m = src.match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
})();
// Coming back to the app checks immediately, which is when most people notice a
// new version anyway. This slower background poll is just the backstop for a
// copy left open and watched — kept long so the app isn't fetching constantly.
const UPDATE_POLL_MS   = 15 * 60 * 1000;   // background re-check
const UPDATE_SNOOZE_MS = 60 * 60 * 1000;   // how long 나중에 keeps it quiet
let updateSeen = null;        // version we've already told the user about
let updateSnoozedUntil = 0;
let updateChecking = false;

async function checkForUpdate() {
  // Nothing to compare against when opened straight off the filesystem.
  if (!RUNNING_VERSION || updateChecking) return;
  if (Date.now() < updateSnoozedUntil) return;
  updateChecking = true;
  try {
    const res = await fetch('index.html?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/js\/constants\.js\?v=([^"'&]+)/);
    const deployed = m && m[1];
    if (deployed && deployed !== RUNNING_VERSION && deployed !== updateSeen) {
      updateSeen = deployed;
      showUpdateBanner();
    }
  } catch (e) {
    // Offline or blocked — just try again on the next tick.
  } finally {
    updateChecking = false;
  }
}

function showUpdateBanner() {
  if ($('updateBanner')) return;
  const bar = document.createElement('div');
  bar.className = 'app-banner update';
  bar.id = 'updateBanner';
  bar.innerHTML =
    '<span>새 버전이 나왔어요. 새로고침하면 바로 적용됩니다.</span>' +
    '<button class="ab-later" id="updateLater">나중에</button>' +
    '<button class="ab-go" id="updateNow">새로고침</button>';
  document.body.appendChild(bar);
  $('updateNow').addEventListener('click', () => {
    // Flush anything unsaved before the reload takes the page away.
    try { pushCloud(); } catch (e) {}
    if (typeof fullCacheRefresh === 'function') fullCacheRefresh(true);
    else location.reload();
  });
  $('updateLater').addEventListener('click', () => {
    updateSnoozedUntil = Date.now() + UPDATE_SNOOZE_MS;
    bar.remove();
  });
}

// Check shortly after load (let the app settle first), then periodically, and
// whenever the app comes back to the foreground — that's when someone who left
// it open for a day is most likely to be looking at it.
setTimeout(checkForUpdate, 8000);
setInterval(checkForUpdate, UPDATE_POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForUpdate();
});
window.addEventListener('online', checkForUpdate);
