// ── Synced document model ──────────────────────────────────────
// Everything in here exists to make one guarantee: two devices that have seen
// the same set of changes always show the same numbers, no matter what order
// those changes arrived in or which device was online when.
//
// The rules that get us there:
//
//  1. NOTHING synced is ever "read, add, write back". That shape is what loses
//     data when two devices do it at once (both write old+mine, the merge keeps
//     one of them). Study time is a LEDGER of immutable runs — {start, end,
//     subject} — and every device DERIVES the same daily totals from it. Two
//     devices can record two different runs at the same time and both survive;
//     two devices running the stopwatch on the same wall-clock minute count it
//     once, because totals come from the UNION of the intervals.
//     Manual ±15분 edits are immutable ledger entries too.
//  2. Anything that genuinely is one mutable value (a setting, the main timer,
//     a note's pin state) carries ITS OWN timestamp. Changing the theme on one
//     device can't roll back a daily-goal change made on another.
//  3. Every merge is commutative, associative and idempotent. Merging the same
//     remote twice changes nothing, so re-delivered snapshots are harmless.
//  4. Deletions are tombstones, never absences — an absence always loses to a
//     peer that still has the item.
//
// Because of (3) the upload can be a Firestore transaction that re-merges
// against whatever is in the cloud at write time (see pushCloud), which is what
// removes the last-writer-wins hole the old blind set() had.

const DOC_VERSION = 3;       // bump only for incompatible document changes
const FOLD_DAYS   = 400;     // runs older than this collapse into frozen totals

// Every session-owned thing (a countdown, a goal, a stretch of study time) is
// tagged with a session id. Data from before sessions existed has no tag, so it
// reads as belonging to this one — a fixed id, never a generated one, so every
// device migrates its history into the SAME session instead of each inventing
// its own and splitting the records.
const DEFAULT_SID = 'main';

// ── Stamps (skew-proof clock) ──────────────────────────────────
// "Newest wins" only works if the clocks agree, and two devices' clocks
// routinely differ by minutes. So a stamp is never raw Date.now(): it is
// max(now, highest stamp we have ever seen + 1). Once a device has seen a
// peer's change, anything it does afterwards is guaranteed to outrank it —
// even if its own clock is behind. (Run start/end times stay real wall-clock
// times; those measure duration, they don't order anything.)
const HLC_KEY = 'timer_clock_v1';
let hlcLast = (() => { try { return Number(localStorage.getItem(HLC_KEY)) || 0; } catch (e) { return 0; } })();
function persistHlc() { try { localStorage.setItem(HLC_KEY, String(hlcLast)); } catch (e) {} }
function stamp() {
  hlcLast = Math.max(Date.now(), hlcLast + 1);
  persistHlc();
  return hlcLast;
}
function observeStamp(t) {
  if (typeof t === 'number' && isFinite(t) && t > hlcLast) { hlcLast = t; persistHlc(); }
}
// Take note of every stamp in an incoming/merged bundle so our next action is
// ordered after it.
function observeBundle(b) {
  if (!b) return;
  for (const sid in (b.timer || {})) {
    const t = b.timer[sid];
    if (t) { observeStamp(t.at); observeStamp(t.emgAt); }
  }
  (b.goals || []).forEach(g => observeStamp(g.at));
  (b.notes || []).forEach(n => {
    observeStamp(n.updatedAt); observeStamp(n.pinAt); observeStamp(n.orderAt); observeStamp(n.itemsAt);
    (n.items || []).forEach(i => observeStamp(i.at));
  });
  for (const k in (b.tomb || {})) observeStamp(b.tomb[k]);
  const s = b.study;
  if (!s) return;
  for (const k in (s.settingsAt || {})) observeStamp(s.settingsAt[k]);
  for (const k in (s.subj || {})) observeStamp(s.subj[k]?.at);
  for (const k in (s.sess || {})) observeStamp(s.sess[k]?.at);
  for (const k in (s.runs || {})) observeStamp(s.runs[k]?.at);
  for (const k in (s.adj  || {})) observeStamp(s.adj[k]?.at);
  observeStamp(s.pomoRun?.at);
}

// ── ids ────────────────────────────────────────────────────────
// Device-prefixed so two devices creating something in the same millisecond
// can never produce the same id (which would silently merge two notes into one).
let _idSeq = 0;
function uid() {
  _idSeq = (_idSeq + 1) % 46656;
  return DEVICE_ID + '-' + Date.now().toString(36) + '-' + _idSeq.toString(36);
}

// Stable stringify (sorted keys) — used for change detection and as a
// deterministic tie-break when two timestamps are exactly equal.
function stableStr(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}';
}
// Newest-wins pick between two objects on one stamp field. On an exact tie both
// devices must choose the SAME side or they'd never converge, hence the
// content-based tie-break.
function newerBy(a, b, key) {
  const av = a?.[key] || 0, bv = b?.[key] || 0;
  if (av !== bv) return av > bv ? a : b;
  return stableStr(a) >= stableStr(b) ? a : b;
}

// ── Study-day keying (respects the configurable reset hour) ────
function studyDayStart(ms) {
  const d = new Date(ms - study.resetHour * 3600000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + study.resetHour * 3600000;
}
function nextStudyDayStart(ms) {
  const d = new Date(ms - study.resetHour * 3600000);
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1);
  return d.getTime() + study.resetHour * 3600000;
}
function studyDayKey(ms) {
  const d = new Date(ms - study.resetHour * 3600000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function studyDayKeyOffset(n) {
  const base = new Date(Date.now() - study.resetHour * 3600000);
  base.setDate(base.getDate() - n);
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
}
// Walk the interval [from, to) day by day, calling cb(dayKey, seconds).
function eachDaySlice(from, to, cb) {
  let cur = from, guard = 0;
  while (cur < to && guard++ < 20000) {
    const boundary = nextStudyDayStart(cur);
    const until = Math.min(to, boundary);
    if (until > cur) cb(studyDayKey(cur), (until - cur) / 1000);
    cur = boundary;
  }
}

// ── Schema normalisation ───────────────────────────────────────
function normalizeStudy() {
  study = normalizeStudyDoc(study, true);
  foldOldEntries();
  rebuildSubjectCache();
  rebuildSessionCache();
  invalidateTotals();
}
// Fill in every field of a study document and upgrade it if it predates the
// ledger. Used for our own document and for one arriving from the cloud.
// `isLocal` also adopts this device's old device-local pomodoro state.
function normalizeStudyDoc(o, isLocal) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
  if (typeof o.resetHour !== 'number' || o.resetHour < 0 || o.resetHour > 23) o.resetHour = 0;
  if (o.theme !== 'light' && o.theme !== 'dark') o.theme = 'dark';
  if (typeof o.accent !== 'string') o.accent = '#cef231';
  if (typeof o.focusMode !== 'boolean') o.focusMode = false;
  if (typeof o.dailyGoalSec !== 'number') o.dailyGoalSec = 0;
  if (typeof o.curSubject !== 'string') o.curSubject = '';
  if (o.comboMode !== 'pomo' && o.comboMode !== 'study') o.comboMode = 'study';
  o.pomo = Object.assign({}, DEFAULT_POMO, (o.pomo && typeof o.pomo === 'object') ? o.pomo : {});

  if (typeof o.curSession !== 'string' || !o.curSession) o.curSession = DEFAULT_SID;
  const plain = k => { if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {}; };
  ['settingsAt', 'subj', 'sess', 'runs', 'adj', 'dist'].forEach(plain);
  // A brand-new document starts with one session. A low stamp so a rename or a
  // deletion on any device always outranks this default.
  if (!Object.keys(o.sess).length) {
    o.sess[DEFAULT_SID] = { at: 1, del: 0, name: '기본', color: SESSION_COLORS[0], ord: 0 };
  }
  if (!o.legacy || typeof o.legacy !== 'object' || Array.isArray(o.legacy)) o.legacy = {};
  // legacy.sess keeps the session split for compacted runs; days that predate
  // sessions have no entry and read as the default session.
  ['rec', 'recAt', 'subj', 'subjAt', 'sess'].forEach(k => {
    if (!o.legacy[k] || typeof o.legacy[k] !== 'object') o.legacy[k] = {};
  });
  if (typeof o.foldBefore !== 'number') o.foldBefore = 0;
  if (!o.pomoRun || typeof o.pomoRun !== 'object' || Array.isArray(o.pomoRun)) {
    o.pomoRun = { phase: 'focus', set: 0, endEpoch: null, remaining: 0, at: 0 };
  }
  if (o.v !== DOC_VERSION) migrateStudyDoc(o, isLocal);
  return o;
}

// One-time conversion of the pre-ledger (v1) document. Old finalised totals
// can't be re-derived, so they're frozen into `legacy` and merged the way v1
// merged them (max per day, with a manual correction winning by its stamp).
// New time only ever lands in the ledger, so the two layers just add up.
function migrateStudyDoc(o, isLocal) {
  // Only a genuinely pre-ledger document needs converting; a v2 document just
  // gains the default session that normalizeStudyDoc has already added, and
  // its untagged runs read as DEFAULT_SID (see sidOf) with nothing rewritten.
  const wasV1 = !(o.v >= 2);
  if (!wasV1) { o.v = DOC_VERSION; return; }
  const oldRec = (o.records && typeof o.records === 'object') ? o.records : {};
  const oldOv  = (o.recordsOverride && typeof o.recordsOverride === 'object') ? o.recordsOverride : {};
  Object.keys(oldRec).forEach(day => {
    const v = Math.max(0, oldRec[day] || 0);
    if (v > 0) o.legacy.rec[day] = Math.max(o.legacy.rec[day] || 0, v);
    if (oldOv[day] && oldOv[day].at) o.legacy.recAt[day] = oldOv[day].at;
  });

  const oldSub = (o.subjects && typeof o.subjects === 'object') ? o.subjects : {};
  const oldSubOv = (o.subjectsOverride && typeof o.subjectsOverride === 'object') ? o.subjectsOverride : {};
  Object.keys(oldSub).forEach(day => {
    Object.keys(oldSub[day] || {}).forEach(name => {
      // v1's effective value: an override plus anything accumulated after it.
      const acc = oldSub[day][name] || 0;
      const ov  = (oldSubOv[day] || {})[name];
      const eff = ov ? Math.max(0, ov.sec + Math.max(0, acc - (ov.base || 0))) : acc;
      if (eff > 0) {
        if (!o.legacy.subj[day]) o.legacy.subj[day] = {};
        o.legacy.subj[day][name] = Math.max(o.legacy.subj[day][name] || 0, eff);
      }
      if (ov && ov.at) {
        if (!o.legacy.subjAt[day]) o.legacy.subjAt[day] = {};
        o.legacy.subjAt[day][name] = ov.at;
      }
    });
  });

  // A stopwatch that was live at upgrade time becomes an open ledger run. Time
  // already committed into records (now legacy) is skipped so it isn't counted
  // twice.
  const s = o.session;
  if (s && s.startEpoch) {
    const committed = (o.committedRuns && o.committedRuns[s.runId]) || 0;
    o.runs[s.runId] = { s: Math.max(s.startEpoch, committed), e: null,
                        subj: o.curSubject || '', at: o.sessionAt || s.startEpoch };
  }

  // v1 distraction counts were a single number per day, max-merged. Park them
  // under a fixed key so they keep max-merging while new counts accumulate
  // per device (see addDistraction).
  const oldDist = (o.distractions && typeof o.distractions === 'object') ? o.distractions : {};
  Object.keys(oldDist).forEach(day => {
    const n = oldDist[day] || 0;
    if (n > 0) o.dist[day] = Object.assign({ v1: n }, o.dist[day]);
  });

  // Subject list + colours become a registry that can express deletion.
  // A low stamp so any real action taken on a peer after its own migration wins.
  const listAt = (o.settingsAt && o.settingsAt.subjectList) || 1;
  const oldList = Array.isArray(o.subjectList) ? o.subjectList : [];
  const oldColors = (o.subjectColors && typeof o.subjectColors === 'object') ? o.subjectColors : {};
  oldList.forEach((name, i) => {
    if (o.subj[name]) return;
    o.subj[name] = { at: listAt, del: 0, ord: i,
                     color: oldColors[name] || SUBJECT_COLORS[i % SUBJECT_COLORS.length] };
  });

  // The pomodoro used to be device-local; adopt this device's state weakly.
  try {
    const p = isLocal ? JSON.parse(localStorage.getItem('timer_pomo_v1')) : null;
    if (p && !o.pomoRun.at) {
      o.pomoRun = { phase: (p.phase === 'short' || p.phase === 'long') ? p.phase : 'focus',
                    set: p.set || 0, endEpoch: p.endEpoch || null,
                    remaining: typeof p.remaining === 'number' ? p.remaining : 0, at: 1 };
    }
  } catch (e) {}

  ['records', 'subjects', 'recordsOverride', 'subjectsOverride', 'committedRuns',
   'session', 'sessionAt', 'distractions', 'subjectList', 'subjectColors',
   'swRunning', 'swLastTick'].forEach(k => { delete o[k]; });
  o.v = DOC_VERSION;
}

// ── Settings ───────────────────────────────────────────────────
// Per-field stamps: only the field that actually changed travels, so a device
// that edited one setting never rolls back another device's change.
const SETTING_FIELDS = ['theme', 'accent', 'focusMode', 'dailyGoalSec',
                        'resetHour', 'curSubject', 'comboMode', 'pomo', 'curSession'];
function touchSetting(field) {
  if (!study.settingsAt) study.settingsAt = {};
  study.settingsAt[field] = stamp();
}

// ── Subject registry ───────────────────────────────────────────
// study.subj = { name: { at, del, ord, color } } — one LWW record per subject,
// so "deleted on phone" beats "still in the list on laptop".
function rebuildSubjectCache() {
  const names = Object.keys(study.subj).filter(n => study.subj[n] && !study.subj[n].del);
  names.sort((a, b) => ((study.subj[a].ord || 0) - (study.subj[b].ord || 0)) || (a < b ? -1 : a > b ? 1 : 0));
  subjectList = names;
  subjectColorMap = {};
  names.forEach((n, i) => {
    subjectColorMap[n] = study.subj[n].color || SUBJECT_COLORS[i % SUBJECT_COLORS.length];
  });
}
function subjectAdd(name, color) {
  const maxOrd = Object.keys(study.subj).reduce((m, n) => Math.max(m, study.subj[n].ord || 0), -1);
  const prev = study.subj[name];
  study.subj[name] = { at: stamp(), del: 0,
                       ord: prev && prev.ord != null ? prev.ord : maxOrd + 1,
                       color: color || (prev && prev.color) || SUBJECT_COLORS[(maxOrd + 1) % SUBJECT_COLORS.length] };
  rebuildSubjectCache();
}
function subjectRemove(name) {
  const prev = study.subj[name] || {};
  study.subj[name] = { at: stamp(), del: 1, ord: prev.ord || 0, color: prev.color || '' };
  rebuildSubjectCache();
}
// Switching subjects mid-run splits the run, so each stretch of time keeps the
// subject it was actually studied under (v1 credited the whole run to whatever
// subject happened to be selected when it stopped).
function setCurSubject(name) {
  name = name || '';
  const now = Date.now();   // where to cut the run: a real instant
  const at  = stamp();      // how to order the change: a stamp
  activeRunIds().forEach(id => {
    const r = study.runs[id];
    if ((r.subj || '') === name) return;
    if (now > r.s) {
      r.e = now; r.at = at;
      study.runs[uid()] = { s: now, e: null, subj: name, at };
    } else {
      r.subj = name; r.at = at;
    }
  });
  study.curSubject = name;
  touchSetting('curSubject');
  invalidateTotals();
}

// ── Session registry ───────────────────────────────────────────
// study.sess = { id: { at, del, name, color, ord } } — one LWW record each, the
// same shape as subjects, so renaming on one device and deleting on another
// resolve without either being resurrected.
function rebuildSessionCache() {
  const ids = Object.keys(study.sess).filter(id => study.sess[id] && !study.sess[id].del);
  ids.sort((a, b) => ((study.sess[a].ord || 0) - (study.sess[b].ord || 0)) || (a < b ? -1 : a > b ? 1 : 0));
  sessions = ids.map((id, i) => ({
    id,
    name:  study.sess[id].name || '세션',
    color: study.sess[id].color || SESSION_COLORS[i % SESSION_COLORS.length],
    ord:   study.sess[id].ord || 0,
  }));
  // Two devices could delete the last two sessions at once and leave none.
  // Fall back to an implicit default rather than showing an empty app; nothing
  // is written, so it can't fight with a peer's deletion.
  if (!sessions.length) sessions = [{ id: DEFAULT_SID, name: '기본', color: SESSION_COLORS[0], ord: 0 }];
}
function curSessionId() {
  const c = study.curSession;
  return sessions.some(s => s.id === c) ? c : sessions[0].id;
}
function curSession() { return sessions.find(s => s.id === curSessionId()) || sessions[0]; }
function sessionById(id) { return sessions.find(s => s.id === id) || null; }
function sessionName(id)  { const s = sessionById(id); return s ? s.name : '삭제된 세션'; }
function sessionColor(id) { const s = sessionById(id); return s ? s.color : 'var(--dim)'; }
// Which session a ledger entry belongs to. Untagged = written before sessions
// existed, so it reads as the default one.
function sidOf(x) { return (x && x.sid) || DEFAULT_SID; }

function sessionAdd(name, color) {
  const maxOrd = Object.keys(study.sess).reduce((m, id) => Math.max(m, study.sess[id].ord || 0), -1);
  const id = uid();
  study.sess[id] = { at: stamp(), del: 0, name: name || '세션', ord: maxOrd + 1,
                     color: color || SESSION_COLORS[(maxOrd + 1) % SESSION_COLORS.length] };
  rebuildSessionCache();
  return id;
}
function sessionUpdate(id, name, color) {
  const prev = study.sess[id] || {};
  study.sess[id] = { at: stamp(), del: prev.del || 0, ord: prev.ord || 0,
                     name: name != null ? name : (prev.name || '세션'),
                     color: color || prev.color || SESSION_COLORS[0] };
  rebuildSessionCache();
}
// Deleting a session never destroys the hours recorded under it — the ledger
// keeps them, and the dashboard groups them as 삭제된 세션.
function sessionRemove(id) {
  const prev = study.sess[id] || {};
  study.sess[id] = { at: stamp(), del: 1, ord: prev.ord || 0,
                     name: prev.name || '세션', color: prev.color || '' };
  rebuildSessionCache();
  if (study.curSession === id) setCurSession(curSessionId());
}
function setCurSession(id) {
  if (study.curSession === id) return;
  study.curSession = id;
  touchSetting('curSession');
  invalidateTotals();
}

// ── Run ledger ─────────────────────────────────────────────────
// A run is {s: startEpoch, e: endEpoch|null, subj, at}. `e === null` means it's
// still going. Elapsed time is always derived from the wall clock, so a locked
// screen, a closed tab or an offline device never loses (or invents) time.
function activeRunIds() {
  const out = [];
  for (const id in study.runs) if (study.runs[id] && study.runs[id].e == null) out.push(id);
  return out;
}
function swRunning() { return activeRunIds().length > 0; }

function startRun() {
  if (swRunning()) return;
  study.runs[uid()] = { s: Date.now(), e: null, subj: study.curSubject || '',
                        sid: curSessionId(), at: stamp() };
  invalidateTotals();
}
// The session a live run is being credited to (it stays with the session that
// started it — switching sessions is a view change, not a re-attribution).
function activeRunSid() {
  const ids = activeRunIds();
  return ids.length ? sidOf(study.runs[ids[0]]) : null;
}
// Stops every open run, including one another device started: "stop" means the
// user stopped studying, so no device is left silently counting.
function stopRuns() {
  const now = Date.now(), at = stamp();
  const ids = activeRunIds();
  ids.forEach(id => { const r = study.runs[id]; r.e = Math.max(r.s, now); r.at = at; });
  invalidateTotals();
  return ids.length > 0;
}
// Earliest start among the open runs — what the "running since" display uses.
function activeRunStart() {
  let m = 0;
  activeRunIds().forEach(id => { const s = study.runs[id].s; if (!m || s < m) m = s; });
  return m;
}

// Flatten the ledger into non-overlapping segments. Two devices that both had
// the stopwatch running over the same minute contribute that minute ONCE
// (overlap goes to the run that started first — a rule every device computes
// identically), so double counting is structurally impossible.
function runSegments() {
  const now = Date.now();
  const list = [];
  for (const id in study.runs) {
    const r = study.runs[id];
    if (!r || typeof r.s !== 'number') continue;
    const end = (r.e == null) ? now : r.e;
    if (end > r.s) list.push({ id, s: r.s, e: end, subj: r.subj || '', sid: sidOf(r) });
  }
  list.sort((a, b) => (a.s - b.s) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = [];
  let cursor = 0;
  for (const r of list) {
    const from = Math.max(r.s, cursor);
    // Each segment belongs to exactly one run, so per-session totals always
    // add up to the overall total — overlap can't be counted under two sessions.
    if (r.e > from) { out.push({ from, to: r.e, subj: r.subj, sid: r.sid }); cursor = r.e; }
  }
  return out;
}

// ── Manual adjustments ─────────────────────────────────────────
// The ±15분 buttons append an immutable entry instead of overwriting a total,
// so an adjustment made on the phone and one made on the laptop both count.
function addAdjustment(day, subj, sec) {
  sec = Math.round(sec);
  if (!sec) return;
  study.adj[uid()] = { d: day, j: subj || '', sec, sid: curSessionId(), at: stamp() };
  invalidateTotals();
  saveStudy();
}

// ── Derived totals ─────────────────────────────────────────────
let _totals = null, _totalsSec = -1;
function invalidateTotals() { _totals = null; }
function computeTotals() {
  const rec = {}, sub = {}, bySess = {}, sessSub = {};
  const addRec = (d, v) => { if (d) rec[d] = (rec[d] || 0) + v; };
  const addSub = (d, n, v) => { if (!d || !n) return; (sub[d] = sub[d] || {}); sub[d][n] = (sub[d][n] || 0) + v; };
  const addSess = (d, sid, n, v) => {
    if (!d) return;
    (bySess[d] = bySess[d] || {}); bySess[d][sid] = (bySess[d][sid] || 0) + v;
    if (!n) return;
    (sessSub[d] = sessSub[d] || {}); (sessSub[d][sid] = sessSub[d][sid] || {});
    sessSub[d][sid][n] = (sessSub[d][sid][n] || 0) + v;
  };

  // Frozen totals. Days compacted after sessions arrived carry their own split
  // in legacy.sess; older ones predate sessions and read as the default.
  for (const d in study.legacy.rec) {
    const v = study.legacy.rec[d] || 0;
    addRec(d, v);
    const split = study.legacy.sess[d];
    if (split && Object.keys(split).length) {
      for (const sid in split) addSess(d, sid, '', split[sid] || 0);
    } else {
      addSess(d, DEFAULT_SID, '', v);
    }
  }
  for (const d in study.legacy.subj)
    for (const n in study.legacy.subj[d]) {
      const v = study.legacy.subj[d][n] || 0;
      addSub(d, n, v);
      (sessSub[d] = sessSub[d] || {}); (sessSub[d][DEFAULT_SID] = sessSub[d][DEFAULT_SID] || {});
      sessSub[d][DEFAULT_SID][n] = (sessSub[d][DEFAULT_SID][n] || 0) + v;
    }

  runSegments().forEach(seg =>
    eachDaySlice(seg.from, seg.to, (day, sec) => {
      addRec(day, sec); addSub(day, seg.subj, sec); addSess(day, seg.sid, seg.subj, sec);
    }));

  for (const k in study.adj) {
    const a = study.adj[k];
    if (!a) continue;
    addRec(a.d, a.sec || 0);
    addSub(a.d, a.j, a.sec || 0);
    addSess(a.d, sidOf(a), a.j, a.sec || 0);
  }

  for (const d in rec) rec[d] = Math.max(0, rec[d]);
  for (const d in sub) for (const n in sub[d]) sub[d][n] = Math.max(0, sub[d][n]);
  for (const d in bySess) for (const s in bySess[d]) bySess[d][s] = Math.max(0, bySess[d][s]);
  return { rec, sub, bySess, sessSub };
}
function totals() {
  const sec = Math.floor(Date.now() / 1000);
  // While a run is open the numbers change every second; otherwise the cached
  // result stays valid until something actually mutates the ledger.
  if (_totals && (_totalsSec === sec || !swRunning())) return _totals;
  _totals = computeTotals(); _totalsSec = sec;
  return _totals;
}
function effRecords() { return totals().rec; }
function recSec(key) { return totals().rec[key] || 0; }
function todayStudySec() { return Math.floor(recSec(studyDayKey(Date.now()))); }
function effectiveSubjectSec(dayKey, name) { return Math.floor((totals().sub[dayKey] || {})[name] || 0); }
function todaySubjectSec(name) { return effectiveSubjectSec(studyDayKey(Date.now()), name); }
// { subjectName -> seconds } for a day, including registered subjects with no
// time yet (so they still show a row in the dashboard).
function effectiveSubjectsForDay(dayKey) {
  const raw = totals().sub[dayKey] || {};
  const out = {};
  new Set([...Object.keys(raw), ...subjectList]).forEach(n => { out[n] = Math.floor(raw[n] || 0); });
  return out;
}

// ── Per-session aggregation ────────────────────────────────────
function sessionSecOn(dayKey, sid) { return Math.floor((totals().bySess[dayKey] || {})[sid] || 0); }
function sessionSecToday(sid) { return sessionSecOn(studyDayKey(Date.now()), sid); }
// { sid -> seconds } over the last n study days. Ids that no longer match a
// live session are folded into one bucket so deleted sessions don't clutter
// the breakdown while their hours still count towards the total.
function sessionTotalsLastDays(n) {
  const by = totals().bySess, out = {};
  for (let i = 0; i < n; i++) {
    const m = by[studyDayKeyOffset(i)] || {};
    for (const sid in m) {
      const key = sessionById(sid) ? sid : '';
      out[key] = (out[key] || 0) + m[sid];
    }
  }
  return out;
}
function sessionSecAllTime(sid) {
  const by = totals().bySess;
  let t = 0;
  for (const d in by) t += by[d][sid] || 0;
  return Math.floor(t);
}

// ── Distractions ───────────────────────────────────────────────
// One counter per device, summed for display: two devices can both count a
// distraction in the same minute without either increment being swallowed.
function addDistraction(day) {
  if (!study.dist[day]) study.dist[day] = {};
  study.dist[day][DEVICE_ID] = (study.dist[day][DEVICE_ID] || 0) + 1;
}
function dayDistractions(day) {
  const m = study.dist[day] || {};
  return Object.keys(m).reduce((s, k) => s + (m[k] || 0), 0);
}

// ── Compaction ─────────────────────────────────────────────────
// Runs and adjustments older than FOLD_DAYS collapse into the frozen `legacy`
// totals so the document can't grow without bound. `foldBefore` is a watermark
// that merges by max, and the merge drops any run that ends before it — so a
// peer that folded later can't re-add time that's already frozen in.
function foldOldEntries() {
  const cutoff = studyDayStart(Date.now() - FOLD_DAYS * 86400000);
  if (cutoff > (study.foldBefore || 0)) study.foldBefore = cutoff;
  const before = study.foldBefore || 0;
  if (!before) return false;
  let changed = false;
  const fold = (day, sec, name, sid) => {
    study.legacy.rec[day] = (study.legacy.rec[day] || 0) + sec;
    if (name) {
      if (!study.legacy.subj[day]) study.legacy.subj[day] = {};
      study.legacy.subj[day][name] = (study.legacy.subj[day][name] || 0) + sec;
    }
    if (!study.legacy.sess[day]) study.legacy.sess[day] = {};
    study.legacy.sess[day][sid] = (study.legacy.sess[day][sid] || 0) + sec;
  };
  for (const id in study.runs) {
    const r = study.runs[id];
    if (!r || r.e == null || r.e >= before) continue;
    eachDaySlice(r.s, r.e, (day, sec) => fold(day, sec, r.subj, sidOf(r)));
    delete study.runs[id]; changed = true;
  }
  for (const id in study.adj) {
    const a = study.adj[id];
    if (!a || (a.at || 0) >= before) continue;
    fold(a.d, a.sec || 0, a.j, sidOf(a));
    delete study.adj[id]; changed = true;
  }
  if (changed) invalidateTotals();
  return changed;
}

// ── Pomodoro runtime (synced) ──────────────────────────────────
// Phase transitions are computed from the phase's own end time, not from
// "now", so every device derives byte-identical state and stamps it with the
// same logical timestamp — there is nothing for two devices to fight over.
function pomoPhaseSec(p) {
  const m = p === 'focus' ? study.pomo.focus : p === 'short' ? study.pomo.short : study.pomo.long;
  return Math.max(1, Math.round((parseFloat(m) || 0) * 60));
}
function pomoRunning() { return study.pomoRun.endEpoch != null; }
function pomoRemainingSec() {
  const st = study.pomoRun;
  if (st.endEpoch != null) return Math.max(0, (st.endEpoch - Date.now()) / 1000);
  // Idle with nothing stored yet (fresh install) shows the full phase. Derived
  // rather than written, so it never counts as a change to sync.
  return st.remaining > 0 ? st.remaining : pomoPhaseSec(st.phase);
}
function pomoAdvanceAt(t) {
  const st = study.pomoRun;
  let next;
  if (st.phase === 'focus') {
    st.set = (st.set || 0) + 1;
    next = (study.pomo.sets > 0 && st.set % study.pomo.sets === 0) ? 'long' : 'short';
  } else {
    next = 'focus';
  }
  st.phase = next;
  st.remaining = pomoPhaseSec(next);
  st.endEpoch = t + st.remaining * 1000;
  st.at = t;   // logical time of the transition, NOT Date.now()
  return next;
}
// Roll forward through every phase boundary that has passed. Returns the number
// of boundaries crossed (the caller decides whether to notify).
function pomoCatchUp() {
  const st = study.pomoRun;
  if (st.endEpoch == null) return 0;
  let crossed = 0;
  while (st.endEpoch != null && st.endEpoch <= Date.now()) {
    if (crossed > 20000) {   // absurdly stale — park it rather than spin
      st.phase = 'focus'; st.set = 0; st.endEpoch = null;
      st.remaining = pomoPhaseSec('focus'); st.at = Date.now();
      break;
    }
    pomoAdvanceAt(st.endEpoch);
    crossed++;
  }
  return crossed;
}
