// ── Notifications ──────────────────────────────────────────────
// Everything goes through the service worker's registration, because Android
// Chrome doesn't allow `new Notification()` from a page — which is why the
// app's notifications never appeared on Android before. Desktop is happy
// either way, so the direct constructor is only a fallback.
//
// Each notification carries a `tag`, which is what lets one replace or close
// another: the 공부 중 notice updates in place when the subject changes and is
// closed outright when the stopwatch stops.
const NOTE_TAGS = {
  studying: 'studying',   // ongoing "공부 중" notice
  timer:    'timer-done',
  dayEnd:   'day-end',
  pomo:     'pomo',
};
let swReg = null;
// Resolves once registration has settled either way. A notification fired at
// page-load time (the day-open catch-up note) would otherwise race this: with
// swReg still null it falls through to `new Notification()`, which Android
// Chrome silently refuses — awaiting this first keeps that path off Android.
let swReady = Promise.resolve();

// `'serviceWorker' in navigator` is true even where the property reads back
// undefined (e.g. served over plain http from a non-localhost host), so test the
// value — a throw here would take the whole file's functions down with it.
if (navigator.serviceWorker) {
  swReady = navigator.serviceWorker.register('sw.js')
    .then(r => { swReg = r; })
    .catch(() => { /* file:// or unsupported — falls back to page notifications */ });
}

function notifyState() {
  if (!('Notification' in window) || !window.Notification) return 'unsupported';
  return Notification.permission;             // 'granted' | 'denied' | 'default'
}
function notifyReady() { return notifyState() === 'granted'; }
function requestNotifyPermission() {
  if (notifyState() !== 'default') return Promise.resolve(notifyState());
  try { return Promise.resolve(Notification.requestPermission()); }
  catch (e) { return Promise.resolve(notifyState()); }
}

// Show (or replace, when the tag matches an existing one) a notification.
// `opts.sticky` asks the platform to keep it up until the user acts — honoured
// on desktop; Android ignores it and lets the user swipe it away.
async function showNote(tag, title, body, opts) {
  opts = opts || {};
  if (!opts.quiet) showToast(body ? `${title} · ${body}` : title);
  if (!notifyReady()) return false;
  const options = {
    body: body || '',
    tag,
    icon: 'icons/icon-192.png',
    // Android draws the status-bar icon from ONLY this image's alpha channel,
    // filled solid white — it ignores every other pixel's color entirely. Our
    // full icon is opaque nearly edge-to-edge (a dark square with a mark on
    // it), so handing that in made the status bar show a plain white square.
    // badge.png is a transparent-background silhouette of just the mark, with
    // no background fill, which is what a monochrome status-bar icon needs.
    badge: 'icons/badge.png',
    renotify: !opts.silent,
    silent: !!opts.silent,
    requireInteraction: !!opts.sticky,
  };
  try {
    if (swReg && swReg.showNotification) { await swReg.showNotification(title, options); return true; }
    new Notification(title, options);
    return true;
  } catch (e) {
    return false;
  }
}
async function closeNote(tag) {
  try {
    if (swReg && swReg.getNotifications) {
      (await swReg.getNotifications({ tag })).forEach(n => n.close());
    }
  } catch (e) {}
}
// Kept for the callers that just want a one-off message (pomodoro phases).
function notify(title, body) { showNote(NOTE_TAGS.pomo, title, body); }

// ── The ongoing "공부 중" notice ────────────────────────────────
// Shown while the stopwatch runs and closed when it stops. It's refreshed when
// the subject changes (same tag replaces in place) but NOT every second — a
// per-tick rewrite would be pointless battery drain, so the body names the
// subject and the start time instead of counting up.
function showStudyingNote() {
  if (!swRunning()) return;
  const started = activeRunStart();
  const when = started ? new Date(started) : new Date();
  const subj = study.curSubject ? study.curSubject : '과목 없음';
  showNote(NOTE_TAGS.studying, `${subj} 공부 중`,
           `${pad(when.getHours())}:${pad(when.getMinutes())} 시작 · 공부를 멈추면 사라집니다`,
           { sticky: true, silent: true, quiet: true });
}
function clearStudyingNote() { closeNote(NOTE_TAGS.studying); }
// Called whenever the run state or the subject changes.
function refreshStudyingNote() {
  if (swRunning()) showStudyingNote(); else clearStudyingNote();
}
