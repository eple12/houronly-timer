// ── Formatters ─────────────────────────────────────────────────
const pad = n => String(n).padStart(2,'0');

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
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ goalEpoch, startEpoch, pausedRemaining, totalSeconds, emergency })); } catch(e) {}
  syncTouch();
}
function clearSave() { try { localStorage.removeItem(STORE_KEY); } catch(e) {} syncTouch(); }
function saveGoals() { try { localStorage.setItem(GOALS_KEY, JSON.stringify(goals)); } catch(e) {} syncTouch(); }
function loadGoals() { try { goals = JSON.parse(localStorage.getItem(GOALS_KEY)) || []; } catch(e) { goals = []; } }
function saveStudy() { try { localStorage.setItem(STUDY_KEY, JSON.stringify(study)); } catch(e) {} syncTouch(); }
function touchSetting(field) { if (!study.settingsAt) study.settingsAt = {}; study.settingsAt[field] = Date.now(); }
// Manually correct a day's study record. The correction propagates across devices
// even when it lowers the value, overriding max-merge for that day.
function setDayOverride(dayKey, sec) {
  sec = Math.max(0, sec);
  if (!study.recordsOverride) study.recordsOverride = {};
  study.records[dayKey] = sec;
  study.recordsOverride[dayKey] = { sec, at: Date.now() };
  saveStudy();
  updateStudyUI();
}
// Returns the effective (committed + live session) seconds for one subject on a day.
// Respects subjectsOverride: override.sec + any time accumulated after the override.
function effectiveSubjectSec(dayKey, name) {
  let accumulated = (study.subjects[dayKey] || {})[name] || 0;
  if (swRunning() && study.curSubject === name) accumulated += (sessionOverlay()[dayKey] || 0);
  const ov = (study.subjectsOverride[dayKey] || {})[name];
  if (!ov) return Math.floor(accumulated);
  return Math.max(0, Math.floor(ov.sec + Math.max(0, accumulated - ov.base)));
}
// Manually set a subject's study time for a given day.
// Stores an override that "wins" over any accumulated value unless new time is added later.
function setSubjectOverride(dayKey, name, sec) {
  sec = Math.max(0, sec);
  const accumulated = (study.subjects[dayKey] || {})[name] || 0;
  if (!study.subjectsOverride[dayKey]) study.subjectsOverride[dayKey] = {};
  study.subjectsOverride[dayKey][name] = { sec, at: Date.now(), base: accumulated };
  saveStudy();
  updateStudyUI();
}
// Returns a map { subjectName → effectiveSec } for the given day,
// covering all subjects in subjectList + any recorded in subjects[dayKey].
// Delegates to effectiveSubjectSec so the session overlay is counted exactly once.
function effectiveSubjectsForDay(dayKey) {
  const raw = study.subjects[dayKey] || {};
  const allNames = new Set([...Object.keys(raw), ...study.subjectList]);
  const out = {};
  allNames.forEach(name => { out[name] = effectiveSubjectSec(dayKey, name); });
  return out;
}
function saveNotes() { try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch(e) {} syncTouch(); }
function loadNotes() { try { notes = JSON.parse(localStorage.getItem(NOTES_KEY)) || []; } catch(e) { notes = []; } if (!Array.isArray(notes)) notes = []; }
function saveTomb()  { try { localStorage.setItem(TOMB_KEY, JSON.stringify(tomb)); } catch(e) {} syncTouch(); }
function loadTomb()  { try { tomb = JSON.parse(localStorage.getItem(TOMB_KEY)) || {}; } catch(e) { tomb = {}; } if (!tomb || typeof tomb !== 'object') tomb = {}; }
// Record a deletion so it propagates to other devices instead of resurrecting.
function tombstone(id) { tomb[id] = Date.now(); saveTomb(); }
function loadStudy() {
  try {
    const s = JSON.parse(localStorage.getItem(STUDY_KEY));
    if (s) study = Object.assign(study, s);
  } catch(e) {}
  if (!study.records) study.records = {};
  ensureSettings();
}

// ── Settings / extended study state defaults ───────────────────
const DEFAULT_POMO = { focus: 25, short: 5, long: 15, sets: 4 };
const ACCENTS = ['#cef231','#5ed3a8','#7aa2f7','#f7a23a','#f76b6b','#c47cff','#36d1dc'];
function ensureSettings() {
  if (!study.subjects     || typeof study.subjects !== 'object')     study.subjects = {};
  if (!study.distractions || typeof study.distractions !== 'object') study.distractions = {};
  if (!Array.isArray(study.subjectList)) study.subjectList = [];
  if (typeof study.curSubject !== 'string')   study.curSubject = '';
  if (typeof study.dailyGoalSec !== 'number') study.dailyGoalSec = 0;
  if (study.theme !== 'light' && study.theme !== 'dark') study.theme = 'dark';
  if (typeof study.accent !== 'string')  study.accent = '#cef231';
  if (typeof study.focusMode !== 'boolean') study.focusMode = false;
  if (study.comboMode !== 'pomo' && study.comboMode !== 'study') study.comboMode = 'study';
  study.pomo = Object.assign({}, DEFAULT_POMO, (study.pomo && typeof study.pomo === 'object') ? study.pomo : {});
  if (!study.settingsAt      || typeof study.settingsAt      !== 'object') study.settingsAt      = {};
  if (!study.recordsOverride || typeof study.recordsOverride !== 'object') study.recordsOverride = {};
  if (!study.committedRuns   || typeof study.committedRuns   !== 'object') study.committedRuns   = {};
  if (!study.subjectColors   || typeof study.subjectColors   !== 'object') study.subjectColors   = {};
  if (!study.subjectsOverride|| typeof study.subjectsOverride!== 'object') study.subjectsOverride= {};
  if (typeof study.sessionAt !== 'number') study.sessionAt = 0;
  if (study.session && typeof study.session !== 'object') study.session = null;
  // Migrate the old device-local run-state (swRunning/swLastTick) — just drop it;
  // any unsaved time from before the upgrade was already in records.
  delete study.swRunning; delete study.swLastTick;
}

// Apply the chosen theme + accent colour to the document.
function applyTheme() {
  document.documentElement.setAttribute('data-theme', study.theme === 'light' ? 'light' : 'dark');
  document.documentElement.style.setProperty('--accent', study.accent || '#cef231');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', study.theme === 'light' ? '#f3f4f6' : '#080808');
}

// ── Study day keying (respects configurable resetHour) ─────────
function studyDayKey(ms) {
  const d = new Date(ms - study.resetHour * 3600 * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
// Key for the study day that is `n` days before the current one.
function studyDayKeyOffset(n) {
  const base = new Date(Date.now() - study.resetHour * 3600 * 1000);
  base.setDate(base.getDate() - n);
  return `${base.getFullYear()}-${pad(base.getMonth()+1)}-${pad(base.getDate())}`;
}
function todayStudySec() { return Math.floor(recSec(studyDayKey(Date.now()))); }

// Returns the epoch ms when the study day containing 'ms' ends and the next begins.
function nextStudyDayStart(ms) {
  const d = new Date(ms - study.resetHour * 3600 * 1000);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime() + study.resetHour * 3600 * 1000;
}
