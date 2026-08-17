// ── Study stopwatch (ledger-backed, conflict-free) ─────────────
// Starting the stopwatch appends an open run to the ledger; stopping closes it.
// Nothing is written per tick — the elapsed time is derived from the wall clock
// — so a locked screen, a closed tab or an offline device can neither lose nor
// invent time, and the stopwatch running produces zero sync traffic.
// See js/model.js for the ledger itself (startRun / stopRuns / runSegments).
// NOTE: swRunning() is the STUDY stopwatch; isRunning() is the MAIN countdown.
// They are independent — don't conflate them.

function toggleStopwatch() {
  if (swRunning()) {
    stopRuns();
  } else {
    requestNotifyPermission();
    startRun();
  }
  saveStudy();
  updateStudyUI();
  // Propagate start/stop promptly instead of waiting out the debounce.
  flushSyncSoon();
}

// Returning to the foreground: the ledger already holds the truth, so there is
// nothing to reconcile — just recompute what's on screen.
function reconcileSession() {
  invalidateTotals();
  lastSeenStudyDay = studyDayKey(Date.now());
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
  const R = effRecords();
  const sec = R[dayKey] || 0;
  const others = Object.entries(R)
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
// The runtime state lives in the synced document (study.pomoRun) and every
// phase transition is derived from the phase's own end time, so two devices
// always show the same phase and the same clock without negotiating.
let pomoTimer = null;          // setInterval handle (display only)
const pomoToggleBtn = $('pomoToggle');
const pomoTimeEl    = $('pomoTime');

function phaseName(p) { return p === 'focus' ? '집중' : p === 'short' ? '짧은 휴식' : '긴 휴식'; }
function fmtClock(secs) {
  secs = Math.max(0, Math.round(secs));
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = secs%60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function pomoStart() {
  const st = study.pomoRun;
  if (!(st.remaining > 0)) st.remaining = pomoPhaseSec(st.phase);
  st.endEpoch = Date.now() + st.remaining * 1000;
  st.at = stamp();
  startPomoInterval();
  requestNotifyPermission();
  saveStudy(); renderPomo(); flushSyncSoon();
}
function pomoPause() {
  if (!pomoRunning()) return;
  const st = study.pomoRun;
  st.remaining = Math.max(0, Math.ceil((st.endEpoch - Date.now()) / 1000));
  st.endEpoch = null;
  st.at = stamp();
  stopPomoInterval();
  saveStudy(); renderPomo(); flushSyncSoon();
}
function pomoReset() {
  stopPomoInterval();
  study.pomoRun = { phase: 'focus', set: 0, endEpoch: null,
                    remaining: pomoPhaseSec('focus'), at: stamp() };
  saveStudy(); renderPomo(); flushSyncSoon();
}
function pomoToggle() { pomoRunning() ? pomoPause() : pomoStart(); }

function startPomoInterval() {
  stopPomoInterval();
  pomoTimer = setInterval(pomoTick, 250);
}
function stopPomoInterval() { if (pomoTimer) { clearInterval(pomoTimer); pomoTimer = null; } }
// Keeps the display in step and rolls the phase over when it ends. The rollover
// is a pure function of the previous end time, so a peer computes the identical
// next phase — the two never disagree, whichever one is awake.
function pomoTick() {
  if (!pomoRunning()) { stopPomoInterval(); renderPomo(); return; }
  const crossed = pomoCatchUp();
  if (crossed) {
    if ('vibrate' in navigator) navigator.vibrate([300,150,300]);
    const st = study.pomoRun;
    if (st.phase === 'focus') notify('휴식 끝', '다시 집중해 볼까요');
    else notify('집중 완료', st.phase === 'long' ? '긴 휴식 시간이에요' : '잠깐 휴식하세요');
    saveStudy(); renderPomo();
  } else {
    renderPomoTime();
  }
}
// On load / after a sync: roll forward through any boundaries missed while the
// page was closed, quietly, then resume ticking if it's still running.
function resumePomo(quiet) {
  const crossed = pomoCatchUp();
  if (crossed && !quiet) saveStudy();
  if (pomoRunning()) startPomoInterval(); else stopPomoInterval();
  renderPomo();
}

function renderPomoTime() { if (pomoTimeEl) pomoTimeEl.textContent = fmtClock(pomoRemainingSec()); }
function renderPomo() {
  const label = $('pomoPhaseLabel'), dots = $('pomoDots');
  if (!label) return;
  const st = study.pomoRun;
  renderPomoTime();
  label.textContent = phaseName(st.phase);
  label.classList.toggle('brk', st.phase !== 'focus');
  const sets = Math.max(1, study.pomo.sets || 4);
  const doneInCycle = (st.set || 0) % sets;
  let d = '';
  for (let i = 0; i < sets; i++) {
    const cls = (st.phase === 'focus' && i === doneInCycle) ? 'pomo-dot cur'
              : (i < doneInCycle ? 'pomo-dot done' : 'pomo-dot');
    d += `<span class="${cls}"></span>`;
  }
  dots.innerHTML = d;
  pomoToggleBtn.innerHTML = pomoRunning() ? ICONS.pause : ICONS.play;
  pomoToggleBtn.classList.toggle('running', pomoRunning());
  pomoTimeEl.classList.toggle('running', pomoRunning());
  updateModeDots();
}

on('pomoToggle', 'click', pomoToggle);
on('pomoReset', 'click', pomoReset);

// ── Combined study/pomo card: mode switch ──────────────────────
const studyCard = $('studyCard');
function updateModeDots() {
  const m = studyCard.dataset.mode;
  $('modeStudy').classList.toggle('live', swRunning() && m !== 'study');
  $('modePomo').classList.toggle('live', pomoRunning() && m !== 'pomo');
}
// Paint the mode without recording a change — used on load and after a sync, so
// merely opening the app never stamps a "newer" setting over a peer's choice.
function applyComboMode(m) {
  studyCard.dataset.mode = m;
  $('modeStudy').classList.toggle('active', m === 'study');
  $('modePomo').classList.toggle('active', m === 'pomo');
  updateModeDots();
}
function setComboMode(m) {
  applyComboMode(m);
  if (study.comboMode === m) return;
  study.comboMode = m; touchSetting('comboMode'); saveStudy();
}
on('modeStudy', 'click', () => setComboMode('study'));
on('modePomo', 'click', () => setComboMode('pomo'));
// initial mode is applied during init (after study/sync state is loaded)
