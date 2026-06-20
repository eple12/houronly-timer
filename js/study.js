// ── Stopwatch session (synced, conflict-free) ──────────────────
// A run's elapsed time is a pure function of (startEpoch, now) so every device
// — and every commit — computes the same value. Time is NOT accumulated per
// tick; it's committed into `records` once on stop, keyed by runId so committing
// twice is a no-op. A run only ends on an explicit stop: the timer keeps
// counting while the device is locked/closed, and that wall-clock time is
// credited in full when it's stopped (or seen again on any device).
// NOTE: named swRunning (not isRunning) — isRunning() is the MAIN countdown
// timer's state. They are independent; don't conflate them.
function swRunning() { return !!(study.session && study.session.startEpoch); }

// Live (not-yet-committed) seconds the active session contributes, split by
// study-day. Starts from whatever has already been committed for this run so a
// resumed/resurrected run is never counted twice.
function sessionOverlay() {
  const s = study.session;
  if (!s || !s.startEpoch) return {};
  const cap = Date.now();
  const from = Math.max(s.startEpoch, (study.committedRuns && study.committedRuns[s.runId]) || 0);
  const out = {};
  let cur = from;
  while (cur < cap) {
    const key = studyDayKey(cur);
    const boundary = nextStudyDayStart(cur);
    const until = Math.min(cap, boundary);
    const dt = (until - cur) / 1000;
    if (dt > 0) out[key] = (out[key] || 0) + dt;
    cur = boundary;
  }
  return out;
}
// Committed records with the live session overlaid — what the UI should show.
function effRecords() {
  const ov = sessionOverlay();
  const out = Object.assign({}, study.records);
  for (const k in ov) out[k] = (out[k] || 0) + ov[k];
  return out;
}
function recSec(key) { return (study.records[key] || 0) + (sessionOverlay()[key] || 0); }

// Fold the session's elapsed time (up to `cap`) into committed records. Picks
// up from committedRuns[runId] so calling it repeatedly only adds new time.
function commitSession(cap) {
  const s = study.session;
  if (!s || !s.startEpoch) return;
  const from = Math.max(s.startEpoch, study.committedRuns[s.runId] || 0);
  let cur = from;
  while (cur < cap) {
    const key = studyDayKey(cur);
    const boundary = nextStudyDayStart(cur);
    const until = Math.min(cap, boundary);
    const dt = (until - cur) / 1000;
    if (dt > 0) {
      study.records[key] = (study.records[key] || 0) + dt;
      if (study.curSubject) {
        if (!study.subjects[key]) study.subjects[key] = {};
        study.subjects[key][study.curSubject] = (study.subjects[key][study.curSubject] || 0) + dt;
      }
    }
    cur = boundary;
  }
  study.committedRuns[s.runId] = Math.max(study.committedRuns[s.runId] || 0, cap);
  pruneCommittedRuns();
}
function pruneCommittedRuns() {
  const cut = Date.now() - 3 * 86400000;
  const keep = study.session && study.session.runId;
  for (const k in study.committedRuns) if (k !== keep && study.committedRuns[k] < cut) delete study.committedRuns[k];
}
function startSession() {
  const now = Date.now();
  study.session = { runId: DEVICE_ID + '-' + now, startEpoch: now, beatAt: now };
  study.sessionAt = now;
}
function stopSession() {
  commitSession(Date.now());
  study.session = null;
  study.sessionAt = Date.now();   // explicit stop: newest stamp wins over any peer
}
// Per-tick maintenance: keep the heartbeat fresh so peers periodically re-sync
// the live session. Time is derived from startEpoch, so a missed beat (closed
// tab, locked screen) never loses time — it's all credited on the next view/stop.
function accountStopwatch() {
  const s = study.session;
  if (!s || !s.startEpoch) return;
  if (document.visibilityState === 'visible') { s.beatAt = Date.now(); saveStudy(); }
}
// On load / returning to foreground: resume the live session's heartbeat.
function reconcileSession() {
  const s = study.session;
  if (!s || !s.startEpoch) return;
  if (document.visibilityState === 'visible') { s.beatAt = Date.now(); saveStudy(); }
}

// Seconds studied today for one subject ('' = total of all tagged).
function todaySubjectSec(name) {
  const key = studyDayKey(Date.now());
  const day = study.subjects[key] || {};
  let v = day[name] || 0;
  if (swRunning() && study.curSubject && name === study.curSubject) v += (sessionOverlay()[key] || 0);
  return Math.floor(v);
}

function toggleStopwatch() {
  if (swRunning()) {
    stopSession();
  } else {
    requestNotifyPermission();
    startSession();
  }
  saveStudy();
  updateStudyUI();
  // Propagate the start/stop promptly instead of waiting out the debounce.
  if (cloudUid && syncReady) { lastPushedJson = null; schedulePush(); }
}

// ── Day rollover detection + notification ──────────────────────
function checkDayRollover() {
  const cur = studyDayKey(Date.now());
  if (lastSeenStudyDay === null) { lastSeenStudyDay = cur; return; }
  if (cur !== lastSeenStudyDay) {
    notifyDayEnd(lastSeenStudyDay);
    lastSeenStudyDay = cur;
  }
}
function notifyDayEnd(dayKey) {
  const sec = study.records[dayKey] || 0;
  const others = Object.entries(study.records)
    .filter(([k,v]) => k !== dayKey && v > 0.5).map(([,v]) => v);
  const avg = others.length ? others.reduce((a,b)=>a+b,0) / others.length : 0;
  const diff = sec - avg;
  const sign = diff >= 0 ? '+' : '−';
  const body = `오늘 ${fmtHrs(sec)} · 평균 ${fmtHrs(avg)} (${sign}${fmtHrs(Math.abs(diff))})`;
  notify('하루 공부 기록', body);
}

// ── Notifications ──────────────────────────────────────────────
function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch(e) {}
  }
}
function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body }); showToast(`${title} · ${body}`); return; }
    catch(e) {}
  }
  showToast(`${title} · ${body}`);
}
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
}

// ── Pomodoro (independent engine — runs alongside the main timer) ──
const POMO_KEY  = 'timer_pomo_v1';
let pomoPhase     = 'focus';   // 'focus' | 'short' | 'long'
let pomoSet       = 0;         // completed focus blocks in the current cycle
let pomoRemaining = 0;         // seconds left in the current phase
let pomoEndEpoch  = null;      // epoch ms when the phase ends (null = not running)
let pomoTimer     = null;      // setInterval handle
const pomoToggleBtn = $('pomoToggle');
const pomoTimeEl    = $('pomoTime');

function phaseSec(p) {
  const m = p === 'focus' ? study.pomo.focus : p === 'short' ? study.pomo.short : study.pomo.long;
  return Math.max(1, Math.round((parseFloat(m) || 0) * 60));
}
function phaseName(p) { return p === 'focus' ? '집중' : p === 'short' ? '짧은 휴식' : '긴 휴식'; }
function pomoRunning() { return pomoEndEpoch !== null; }
function fmtClock(secs) {
  secs = Math.max(0, Math.round(secs));
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = secs%60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function savePomo() {
  try { localStorage.setItem(POMO_KEY, JSON.stringify(
    { phase: pomoPhase, set: pomoSet, remaining: pomoRemaining, endEpoch: pomoEndEpoch })); } catch(e) {}
}
function loadPomo() {
  let p; try { p = JSON.parse(localStorage.getItem(POMO_KEY)); } catch(e) {}
  if (p) {
    pomoPhase     = (p.phase === 'short' || p.phase === 'long') ? p.phase : 'focus';
    pomoSet       = p.set || 0;
    pomoRemaining = (typeof p.remaining === 'number') ? p.remaining : phaseSec(pomoPhase);
    pomoEndEpoch  = p.endEpoch || null;
  } else {
    pomoRemaining = phaseSec('focus');
  }
}

// Pomodoro runs entirely on its own — it never touches the study stopwatch.

function pomoStart() {
  if (pomoRemaining <= 0) pomoRemaining = phaseSec(pomoPhase);
  pomoEndEpoch = Date.now() + pomoRemaining * 1000;
  startPomoInterval();
  requestNotifyPermission();
  savePomo(); renderPomo();
}
function pomoPause() {
  if (!pomoRunning()) return;
  pomoRemaining = Math.max(0, Math.ceil((pomoEndEpoch - Date.now()) / 1000));
  pomoEndEpoch = null;
  stopPomoInterval();
  savePomo(); renderPomo();
}
function pomoReset() {
  stopPomoInterval();
  pomoPhase = 'focus'; pomoSet = 0; pomoEndEpoch = null;
  pomoRemaining = phaseSec('focus');
  savePomo(); renderPomo();
}
function pomoToggle() { pomoRunning() ? pomoPause() : pomoStart(); }

function startPomoInterval() {
  stopPomoInterval();
  pomoTimer = setInterval(pomoTick, 250);
}
function stopPomoInterval() { if (pomoTimer) { clearInterval(pomoTimer); pomoTimer = null; } }

function pomoTick() {
  if (!pomoRunning()) { stopPomoInterval(); return; }
  const rem = (pomoEndEpoch - Date.now()) / 1000;
  if (rem <= 0) { pomoAdvance(); return; }
  pomoRemaining = rem;
  renderPomoTime();
}
// A phase finished → notify and roll into the next one (keeps running).
function pomoAdvance() {
  if ('vibrate' in navigator) navigator.vibrate([300,150,300]);
  let next;
  if (pomoPhase === 'focus') {
    pomoSet++;
    const isLong = study.pomo.sets > 0 && pomoSet % study.pomo.sets === 0;
    next = isLong ? 'long' : 'short';
    notify('집중 완료', isLong ? '긴 휴식 시간이에요' : '잠깐 휴식하세요');
  } else {
    next = 'focus';
    notify('휴식 끝', '다시 집중해 볼까요');
  }
  pomoPhase = next;
  pomoRemaining = phaseSec(next);
  pomoEndEpoch = Date.now() + pomoRemaining * 1000;
  savePomo(); renderPomo();
}

function renderPomoTime() { if (pomoTimeEl) pomoTimeEl.textContent = fmtClock(pomoRemaining); }
function renderPomo() {
  const label = $('pomoPhaseLabel'), dots = $('pomoDots');
  if (!label) return;
  renderPomoTime();
  label.textContent = phaseName(pomoPhase);
  label.classList.toggle('brk', pomoPhase !== 'focus');
  const sets = Math.max(1, study.pomo.sets || 4);
  const doneInCycle = pomoSet % sets;
  let d = '';
  for (let i = 0; i < sets; i++) {
    const cls = (pomoPhase === 'focus' && i === doneInCycle) ? 'pomo-dot cur'
              : (i < doneInCycle ? 'pomo-dot done' : 'pomo-dot');
    d += `<span class="${cls}"></span>`;
  }
  dots.innerHTML = d;
  pomoToggleBtn.innerHTML = pomoRunning() ? ICONS.pause : ICONS.play;
  pomoToggleBtn.classList.toggle('running', pomoRunning());
  pomoTimeEl.classList.toggle('running', pomoRunning());
  updateModeDots();
}

pomoToggleBtn.addEventListener('click', pomoToggle);
$('pomoReset').addEventListener('click', pomoReset);

// ── Combined study/pomo card: mode switch ──────────────────────
const studyCard = $('studyCard');
function updateModeDots() {
  const m = studyCard.dataset.mode;
  $('modeStudy').classList.toggle('live', swRunning() && m !== 'study');
  $('modePomo').classList.toggle('live', pomoRunning() && m !== 'pomo');
}
function setComboMode(m) {
  studyCard.dataset.mode = m;
  $('modeStudy').classList.toggle('active', m === 'study');
  $('modePomo').classList.toggle('active', m === 'pomo');
  study.comboMode = m; touchSetting('comboMode'); saveStudy();
  updateModeDots();
}
$('modeStudy').addEventListener('click', () => setComboMode('study'));
$('modePomo').addEventListener('click', () => setComboMode('pomo'));
// initial mode is applied during init (after study/sync state is loaded)
