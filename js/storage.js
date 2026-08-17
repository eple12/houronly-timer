// ── Formatters ─────────────────────────────────────────────────
function fmt(secs) {
  secs = Math.max(0, Math.floor(secs));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function fmtDate(ms) {
  const d = new Date(ms);
  return `종료 ${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Fixed-width so the label never shifts as the value changes: always two-digit
// 분·초 (e.g. "경과 02분 00초"), with 시간 prefixed only once an hour is reached.
function fmtElapsed(secs) {
  secs = Math.max(0, Math.floor(secs));
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = secs%60;
  return `경과 ${h ? pad(h) + '시간 ' : ''}${pad(m)}분 ${pad(s)}초`;
}
function fmtGoalRem(endEpoch) {
  const rem = Math.max(0, Math.floor((endEpoch - Date.now()) / 1000));
  if (rem === 0) return '완료';
  const h = Math.floor(rem / 3600), m = Math.floor((rem % 3600) / 60), s = rem % 60;
  if (h >= 1) return `${h}h ${pad(m)}m`;
  if (m >= 1) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}
function fmtHrs(sec) {
  const h = sec / 3600;
  if (h >= 10) return Math.round(h) + 'h';
  return (Math.round(h * 10) / 10) + 'h';
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Timer helpers ──────────────────────────────────────────────
function getRem() {
  if (goalEpoch !== null) return Math.max(0, Math.floor((goalEpoch - Date.now()) / 1000));
  if (pausedRemaining !== null) return pausedRemaining;
  return 0;
}
function isRunning() { return goalEpoch !== null; }
function isPaused()  { return goalEpoch === null && pausedRemaining !== null; }
function isIdle()    { return goalEpoch === null && pausedRemaining === null; }

// D-day count: whole days from today (local midnight) to goal date.
function dDayNum() {
  if (!goalEpoch) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const gd    = new Date(goalEpoch); gd.setHours(0,0,0,0);
  return Math.round((gd - today) / 86400000);
}

// ── Persistence ────────────────────────────────────────────────
// The main countdown syncs as one stamped object. `at` marks the last state
// change (start / pause / reset / expiry) and `emgAt` the emergency toggle, so
// pausing on one device can't undo an emergency toggle on another.
function timerState() {
  return { goalEpoch, startEpoch, pausedRemaining, totalSeconds, emergency,
           at: timerAt, emgAt: timerEmgAt };
}
// Every save writes the globals back into the active session's slot, so the map
// is always current and switching sessions is just a read.
function persistTimer() {
  timers[curSessionId()] = timerState();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(timers)); } catch(e) {}
  syncTouch();
}
const EMPTY_TIMER = { goalEpoch: null, startEpoch: null, pausedRemaining: null,
                      totalSeconds: 0, emergency: false, at: 0, emgAt: 0 };
// Point the live globals at one session's countdown.
function adoptTimer(sid) {
  const t = timers[sid] || EMPTY_TIMER;
  goalEpoch       = typeof t.goalEpoch === 'number' ? t.goalEpoch : null;
  startEpoch      = typeof t.startEpoch === 'number' ? t.startEpoch : null;
  pausedRemaining = typeof t.pausedRemaining === 'number' ? t.pausedRemaining : null;
  totalSeconds    = t.totalSeconds || 0;
  emergency       = !!t.emergency;
  timerAt         = t.at || 0;
  timerEmgAt      = t.emgAt || 0;
}
// Seconds left on a session's countdown without disturbing the live globals
// (the session list shows every session's clock at once).
function timerRemainingOf(sid) {
  const t = timers[sid];
  if (!t) return null;
  if (typeof t.goalEpoch === 'number') return Math.max(0, Math.floor((t.goalEpoch - Date.now()) / 1000));
  if (typeof t.pausedRemaining === 'number') return t.pausedRemaining;
  return null;
}
function timerRunningOf(sid) { return typeof (timers[sid] || {}).goalEpoch === 'number'; }
// `at` may be given explicitly for transitions that happen at a known moment
// (a countdown reaching zero) — stamping those with their logical time keeps
// every device's copy identical instead of racing on Date.now().
function save(at) {
  timerAt = at || stamp();
  persistTimer();
}
function saveEmergency() {
  timerEmgAt = stamp();
  persistTimer();
}
// Reset writes an explicit idle state rather than deleting the key: an absence
// would lose to any peer that still has a timer, resurrecting what was cleared.
function clearSave() { save(); }
function loadTimer() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORE_KEY)); } catch(e) {}
  timers = normalizeTimers(raw);
  adoptTimer(curSessionId());
  return timers[curSessionId()] || null;
}
// Accepts both shapes: the current { sessionId: timer } map, and the single
// timer object stored before sessions existed (which becomes the default
// session's countdown).
function normalizeTimers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if ('goalEpoch' in raw || 'pausedRemaining' in raw || 'totalSeconds' in raw) {
    return { [DEFAULT_SID]: raw };
  }
  const out = {};
  for (const sid in raw) if (raw[sid] && typeof raw[sid] === 'object') out[sid] = raw[sid];
  return out;
}
// Switch which session the app is showing: the active timer is already saved in
// the map, so this just re-points the globals and repaints.
function switchSession(sid) {
  if (sid === curSessionId()) return;
  persistTimer();              // make sure the outgoing session's slot is current
  setCurSession(sid);
  saveStudy();
  adoptTimer(curSessionId());
  restartTick();
  render();
  renderGoals(); renderDayTicks(); renderGoalFlags();
  updateStudyUI();
  renderSessionChip();
  flushSyncSoon();
}

function saveGoals() { try { localStorage.setItem(GOALS_KEY, JSON.stringify(goals)); } catch(e) {} syncTouch(); }
function loadGoals() {
  try { goals = JSON.parse(localStorage.getItem(GOALS_KEY)) || []; } catch(e) { goals = []; }
  if (!Array.isArray(goals)) goals = [];
  goals = goals.map(normalizeGoal);
}
// Ids became device-prefixed strings (two devices could otherwise mint the same
// Date.now() id and have their items merged into one). Old numeric ids are kept
// — just as strings — so existing data and its tombstones still line up.
function normalizeGoal(g) {
  g.id = String(g.id);
  if (typeof g.at !== 'number') g.at = Number(g.id) || 1;
  if (typeof g.sid !== 'string') g.sid = DEFAULT_SID;   // goals made before sessions
  return g;
}
// The goals belonging to the session on screen.
function sessionGoals() { return goals.filter(g => g.sid === curSessionId()); }

function saveStudy() { try { localStorage.setItem(STUDY_KEY, JSON.stringify(study)); } catch(e) {} invalidateTotals(); syncTouch(); }
function loadStudy() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STUDY_KEY)); } catch(e) {}
  study = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
  normalizeStudy();
}

function saveNotes() { try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch(e) {} syncTouch(); }
function loadNotes() {
  try { notes = JSON.parse(localStorage.getItem(NOTES_KEY)) || []; } catch(e) { notes = []; }
  if (!Array.isArray(notes)) notes = [];
  notes = notes.map(normalizeNote);
}
// Fill in the per-part stamps and checklist item ids that the merge needs.
// Missing stamps default to the note's updatedAt (or 0), never to "now" — a
// load must never look like a fresh edit or it would outrank a real one.
function normalizeNote(n) {
  n.id = String(n.id);
  const u = n.updatedAt || 0;
  if (typeof n.createdAt !== 'number') n.createdAt = Number(n.id) || u;
  if (typeof n.pinAt   !== 'number') n.pinAt   = n.pinned ? (n.pinnedAt || u) : 0;
  if (typeof n.orderAt !== 'number') n.orderAt = 0;
  if (typeof n.itemsAt !== 'number') n.itemsAt = u;
  if (!Array.isArray(n.items)) n.items = [];
  n.items = n.items.map((it, i) => ({
    id: it.id ? String(it.id) : (n.id + '#' + i),
    t: it.t || '', done: !!it.done, at: it.at || u,
  }));
  return n;
}

function saveTomb()  { try { localStorage.setItem(TOMB_KEY, JSON.stringify(tomb)); } catch(e) {} syncTouch(); }
function loadTomb()  { try { tomb = JSON.parse(localStorage.getItem(TOMB_KEY)) || {}; } catch(e) { tomb = {}; } if (!tomb || typeof tomb !== 'object') tomb = {}; }
// Record a deletion so it propagates to other devices instead of resurrecting.
function tombstone(id) { tomb[String(id)] = stamp(); saveTomb(); }

// ── Manual record corrections ──────────────────────────────────
// Both of these append to the adjustment ledger (see addAdjustment): a delta is
// safe to merge from several devices, whereas "set the total to N" silently
// discards whatever the other device recorded.
function adjustDayTotal(dayKey, deltaSec) { addAdjustment(dayKey, '', deltaSec); updateStudyUI(); }
function adjustSubject(dayKey, name, deltaSec) { addAdjustment(dayKey, name, deltaSec); updateStudyUI(); }

// Apply the chosen theme + accent colour to the document.
function applyTheme() {
  document.documentElement.setAttribute('data-theme', study.theme === 'light' ? 'light' : 'dark');
  document.documentElement.style.setProperty('--accent', study.accent || '#cef231');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', study.theme === 'light' ? '#f3f4f6' : '#080808');
}
