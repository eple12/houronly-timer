// ── Flag + tick rendering ──────────────────────────────────────
function refRange() {
  const refStart = startEpoch;
  const refEnd   = goalEpoch
    ?? (startEpoch && totalSeconds > 0 ? startEpoch + totalSeconds * 1000 : null);
  if (!refStart || !refEnd || refEnd <= refStart) return null;
  return { refStart, refEnd, span: refEnd - refStart };
}

function renderGoalFlags() {
  progressTrack.querySelectorAll('.goal-flag').forEach(f => f.remove());
  const r = refRange();
  if (!r) return;
  // Only this session's goals — each session's progress bar shows its own.
  sessionGoals().forEach(g => {
    const pct = ((g.endEpoch - r.refStart) / r.span) * 100;
    if (pct < 0 || pct > 100) return;
    const wrap = document.createElement('div');
    wrap.className = 'goal-flag';
    wrap.style.left = pct.toFixed(3) + '%';
    wrap.title = g.memo || '목표';
    wrap.innerHTML = makeFlagSVG(g.color);
    progressTrack.appendChild(wrap);
  });
}

// Day boundary ticks at each local midnight in the span.
function renderDayTicks() {
  progressTrack.querySelectorAll('.day-tick').forEach(t => t.remove());
  const r = refRange();
  if (!r) return;

  // Collect local midnights strictly inside (refStart, refEnd)
  const marks = [];
  const d = new Date(r.refStart);
  d.setHours(24, 0, 0, 0); // first midnight after start
  while (d.getTime() < r.refEnd) {
    marks.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  // Avoid clutter: if too many days, only show weekly ticks
  const step = marks.length > 60 ? 7 : 1;
  marks.forEach((ms, i) => {
    if (i % step !== 0) return;
    const pct = ((ms - r.refStart) / r.span) * 100;
    const tick = document.createElement('div');
    tick.className = 'day-tick';
    tick.style.left = pct.toFixed(3) + '%';
    progressTrack.appendChild(tick);
  });
}

// ── Goals list ─────────────────────────────────────────────────
let goalReorderMode = false;   // when on, each goal grows a drag pad

function renderGoals() {
  const list = sessionGoals();
  // Nothing to reorder below two goals — and the toggle is hidden there, so
  // leaving the mode on would strand the drag pads with no way to dismiss them.
  if (list.length < 2) goalReorderMode = false;
  if (list.length === 0) { goalsWrap.innerHTML = ''; return; }
  goalsWrap.innerHTML =
    `<div class="goals-section-label">
       <span>목표</span>
       ${list.length > 1
         ? `<button class="goal-reorder-toggle${goalReorderMode ? ' on' : ''}" id="goalsReorderToggle" title="순서 변경">${icoSm('grip')}</button>`
         : ''}
     </div>
     <div class="goals-list${goalReorderMode ? ' reordering' : ''}" id="goalsList">` +
    list.map(g => {
      const rem      = Math.max(0, Math.floor((g.endEpoch - Date.now()) / 1000));
      const remText  = fmtGoalRem(g.endEpoch);
      const remClass = rem === 0 ? 'goal-rem done-c' : 'goal-rem';
      return `<div class="goal-item" data-gid="${g.id}">
        <button class="goal-drag-handle" title="끌어서 순서 변경" tabindex="-1">${icoSm('grip')}</button>
        <div class="goal-stripe" style="--goal-c:${g.color}"></div>
        <div class="goal-body">
          <span class="goal-name">${escHtml(g.memo || '목표')}</span>
          <span class="${remClass}" data-rem="${g.id}">${remText}</span>
        </div>
        <button class="goal-del" data-del="${g.id}">✕</button>
      </div>`;
    }).join('') + '</div>';

  const toggle = $('goalsReorderToggle');
  if (toggle) toggle.addEventListener('click', () => {
    goalReorderMode = !goalReorderMode;
    renderGoals();
  });
  goalsWrap.querySelectorAll('.goal-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const delId = btn.dataset.del;
      goals = goals.filter(g => g.id !== delId);
      tombstone(delId);
      saveGoals(); renderGoals(); renderGoalFlags();
    });
  });
  if (goalReorderMode) {
    goalsWrap.querySelectorAll('.goal-drag-handle').forEach(h =>
      h.addEventListener('pointerdown', e => beginGoalDrag(e, h)));
  }
}

// Pointer-based drag reordering, the same mechanic as the note list: the row
// follows the finger while its neighbours slide open a gap at the target slot.
function beginGoalDrag(e, handle) {
  if (e.button != null && e.button !== 0) return;
  e.preventDefault();
  const list    = $('goalsList');
  const row     = handle.closest('.goal-item');
  const rows    = [...list.querySelectorAll('.goal-item')];
  const fromIdx = rows.indexOf(row);
  const rect    = row.getBoundingClientRect();
  const gap     = parseFloat(getComputedStyle(list).rowGap) || 6;
  const step    = rect.height + gap;
  const startY  = e.clientY;
  let toIdx     = fromIdx;

  row.classList.add('goal-dragging');
  try { handle.setPointerCapture(e.pointerId); } catch (err) {}

  function onMove(ev) {
    const dy = ev.clientY - startY;
    row.style.transform = `translateY(${dy}px)`;
    const nt = Math.max(0, Math.min(rows.length - 1, fromIdx + Math.round(dy / step)));
    if (nt === toIdx) return;
    toIdx = nt;
    rows.forEach((r, i) => {
      if (r === row) return;
      let shift = 0;
      if (fromIdx < toIdx && i > fromIdx && i <= toIdx) shift = -step;
      else if (fromIdx > toIdx && i >= toIdx && i < fromIdx) shift = step;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    rows.forEach(r => { r.style.transform = ''; });
    row.classList.remove('goal-dragging');
    if (toIdx !== fromIdx) commitGoalReorder(fromIdx, toIdx);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}
// Renumber this session's goals and stamp the move, so the new order syncs
// without disturbing the goals themselves.
function commitGoalReorder(fromIdx, toIdx) {
  const list = sessionGoals();
  const [moved] = list.splice(fromIdx, 1);
  list.splice(toIdx, 0, moved);
  const now = stamp();
  list.forEach((g, i) => { g.order = i; g.orderAt = now; });
  saveGoals();
  renderGoals();
  renderGoalFlags();
  flushSyncSoon();
}
function updateGoalTimes() {
  sessionGoals().forEach(g => {
    const el = goalsWrap.querySelector(`[data-rem="${g.id}"]`);
    if (!el) return;
    const rem = Math.max(0, Math.floor((g.endEpoch - Date.now()) / 1000));
    el.textContent = fmtGoalRem(g.endEpoch);
    el.className   = rem === 0 ? 'goal-rem done-c' : 'goal-rem';
  });
}

// ── Study stats ────────────────────────────────────────────────
function studyStats() {
  const R = effRecords();   // committed + live session
  const entries = Object.entries(R).filter(([,v]) => v > 0.5);
  const total   = entries.reduce((a,[,v]) => a + v, 0);
  const days    = entries.length;
  const avg     = days ? total / days : 0;
  const best    = entries.reduce((m,[,v]) => Math.max(m, v), 0);
  // streak: consecutive study days ending today or yesterday
  let streak = 0;
  const todayHas = (R[studyDayKeyOffset(0)] || 0) > 0.5;
  let i = todayHas ? 0 : 1;
  while ((R[studyDayKeyOffset(i)] || 0) > 0.5) { streak++; i++; }
  return { total, days, avg, best, streak };
}

// ── Projection line on main screen ─────────────────────────────
function updateProjection() {
  metaRow2.innerHTML = '';
  const dd = dDayNum();
  if (dd === null) return;

  // D-day chip
  let ddText, ddClass = 'dday-chip';
  if (dd > 0)       ddText = `D-${dd}`;
  else if (dd === 0) ddText = 'D-DAY';
  else { ddText = `D+${-dd}`; ddClass += ' past'; }
  metaRow2.insertAdjacentHTML('beforeend', `<span class="${ddClass}">${ddText}</span>`);

  // Projection: if we have study data and days remain
  const st = studyStats();
  if (st.days > 0 && dd > 0) {
    const projSec = st.avg * dd;
    metaRow2.insertAdjacentHTML('beforeend',
      `<span class="proj-text">평균 <b>${fmtHrs(st.avg)}/일</b> · 이대로면 <b>+${fmtHrs(projSec)}</b> 더 공부</span>`);
  }
}

// ── Study UI ───────────────────────────────────────────────────
function updateStudyUI() {
  const running = swRunning();
  const sec = todayStudySec();
  swTimeEl.textContent = fmt(sec);
  swTimeEl.classList.toggle('running', running);
  swToggle.innerHTML = running ? ICONS.pause : ICONS.play;
  swToggle.classList.toggle('running', running);
  updateSubjectLabel();
  updateGoalBar(sec);
  updateProjection();
  if (typeof updateModeDots === 'function') updateModeDots();
}

function updateSubjectLabel() {
  const btn = $('swSubjectBtn');
  if (!btn) return;
  const tagged = !!study.curSubject;
  btn.classList.toggle('tagged', tagged);
  btn.innerHTML = `${icoSm('tag')}<span class="subj-name">${tagged ? escHtml(study.curSubject) : '과목 선택'}</span><span class="subj-caret">▾</span>`;
  // A run stays with the session that started it, so say so plainly when you're
  // looking at a different one — otherwise a ticking clock next to another
  // session's total would just look wrong.
  const note = $('swSessNote');
  if (!note) return;
  const runSid = activeRunSid();
  const elsewhere = runSid && runSid !== curSessionId();
  note.style.display = elsewhere ? '' : 'none';
  if (elsewhere) {
    note.innerHTML = `<span class="sess-inline-dot" style="background:${sessionColor(runSid)}"></span>` +
                     `${escHtml(sessionName(runSid))}에서 진행 중`;
  }
}

function updateGoalBar(sec) {
  const bar = $('swGoalBar');
  if (!bar) return;
  const goal = study.dailyGoalSec;
  if (!goal || goal <= 0) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  const pct = Math.min(100, (sec / goal) * 100);
  bar.querySelector('i').style.width = pct.toFixed(1) + '%';
  bar.classList.toggle('hit', sec >= goal);
}

// ── Core render ────────────────────────────────────────────────
function render() {
  const rem  = getRem();
  const done = rem === 0 && totalSeconds > 0;

  if (rem !== lastDisplayed) {
    lastDisplayed = rem;
    const txt = fmt(rem);
    timeDisplay.textContent = txt;
    // Space Mono is fixed-width, so the clock's width tracks its character
    // count exactly. Past the usual 8 ("HH:MM:SS") a five-digit hour count
    // would run off the right edge; scale by 8/chars to hold the same width.
    timeDisplay.style.setProperty('--clock-fit',
      txt.length > 8 ? (8 / txt.length).toFixed(3) : '1');
  }

  timeDisplay.classList.toggle('done',      done && !emergency);
  timeDisplay.classList.toggle('emergency', emergency && !done);

  let pct = 0;
  if (startEpoch && goalEpoch) {
    const span = goalEpoch - startEpoch, elapsed = Date.now() - startEpoch;
    pct = Math.min(100, Math.max(0, elapsed / span * 100));
    elapsedLabel.textContent = fmtElapsed(Math.floor(elapsed / 1000));
  } else if (totalSeconds > 0) {
    const elapsed = totalSeconds - rem;
    pct = Math.min(100, elapsed / totalSeconds * 100);
    elapsedLabel.textContent = fmtElapsed(elapsed);
  } else {
    elapsedLabel.textContent = '—';
  }
  progressFill.style.width = pct.toFixed(3) + '%';
  progressFill.classList.toggle('running',   isRunning() && !emergency);
  progressFill.classList.toggle('emergency', emergency);

  const hasEnd = !!goalEpoch;
  endLabel.textContent  = hasEnd ? fmtDate(goalEpoch) : '';
  metaSep.style.display = hasEnd ? '' : 'none';

  if (done)            { statusDot.className = 'dot done';   statusText.textContent = '완료'; }
  else if (isRunning()){ statusDot.className = 'dot active'; statusText.textContent = '진행중'; }
  else if (isPaused()) { statusDot.className = 'dot';        statusText.textContent = '일시정지'; }
  else                 { statusDot.className = 'dot';        statusText.textContent = ''; }

  // Single toggle: 시작 (idle) → 일시정지 (running) → 계속 (paused)
  startBtn.disabled    = done;
  startBtn.textContent = isRunning() ? '일시정지' : isPaused() ? '계속' : '시작';
  startBtn.classList.toggle('running', isRunning());

  const locked = isRunning();
  if (locked !== lastLocked) {
    lastLocked = locked;
    [hInput, mInput, sInput].forEach(inp => { inp.disabled = locked; inp.style.opacity = locked ? '0.5' : '1'; });
    document.querySelectorAll('.preset-btn').forEach(b => {
      b.disabled = locked; b.style.opacity = locked ? '0.5' : '1'; b.style.pointerEvents = locked ? 'none' : '';
    });
  }

  emgBtn.classList.toggle('on', emergency);

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec !== lastGoalSec) {
    lastGoalSec = nowSec;
    updateGoalTimes();
    updateProjection();
  }
}

// ── Main timer tick ────────────────────────────────────────────
// Driven by a low-frequency interval, NOT requestAnimationFrame: the clock
// only changes once a second and the progress bar smooths itself with a CSS
// transition, so 4 ticks/sec is plenty and avoids the 60fps frame drops.
function startTick() {
  if (rafId) clearInterval(rafId);
  render();
  rafId = setInterval(() => {
    render();
    if (getRem() === 0 && goalEpoch !== null) {
      const endedAt = goalEpoch;
      goalEpoch = null;
      if ('vibrate' in navigator) navigator.vibrate([400,200,400,200,400]);
      // Stamp the finish with the moment it was due, not "now": every device
      // then derives an identical end state instead of racing to claim it.
      render(); save(endedAt);
      clearInterval(rafId); rafId = null;
    }
  }, 250);
}
// Bring the tick in line with the current state — used after a sync adopts a
// timer another device started, paused or reset. v1 reloaded the page here.
function restartTick() {
  if (rafId) { clearInterval(rafId); rafId = null; }
  lastDisplayed = -1; lastLocked = null;
  if (isRunning() && getRem() > 0) startTick();
}

// ── 1-second housekeeping (always running) ─────────────────────
// Nothing here writes state — the stopwatch's elapsed time is derived from the
// ledger, so a running stopwatch produces no storage writes and no sync traffic.
setInterval(() => {
  checkDayRollover();
  updateStudyUI();
  if (goals.length && !rafId) { updateGoalTimes(); }
  // Keep the session list's clocks live while it's open.
  if (isModalOpen('sessModal')) refreshSessionTimes();
  // Keep the dashboard numbers/bars live while the stopwatch is running.
  // Surgical update (not a full re-render) so an open subject dropdown stays open.
  if (swRunning() && isModalOpen('dashModal')) {
    refreshDashboardLive();
  }
}, 1000);

// Re-account when returning to foreground (don't count background time
// beyond the wall clock; accounting uses real dt so this just commits).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { reconcileSession(); updateStudyUI(); }
});

// ── Keyboard-aware modals ──────────────────────────────────────
// On phones the on-screen keyboard overlaps bottom-sheet modals. Track its
// height via visualViewport and expose it as --kb so the overlay lifts up,
// then keep the focused field scrolled into the visible area.
const vv = window.visualViewport;
if (vv) {
  let kbRaf = 0;
  const applyKb = () => {
    // Track the viewport on the next frame so --kb follows the keyboard's own
    // slide animation 1:1. No CSS transition (see .modal-overlay) — letting both
    // animate at once is what made the sheet shake.
    cancelAnimationFrame(kbRaf);
    kbRaf = requestAnimationFrame(() => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', (kb > 40 ? kb : 0) + 'px');
    });
  };
  vv.addEventListener('resize', applyKb);
}
// When a field is focused, bring it into view only if it's actually hidden by
// the keyboard. 'nearest' scrolls the minimum needed — 'center' over-scrolled
// the sheet way up on iPad.
document.addEventListener('focusin', e => {
  if (e.target.matches && e.target.matches('.modal input, .modal textarea')) {
    setTimeout(() => e.target.scrollIntoView({ block: 'nearest' }), 300);
  }
});

// ── Timer actions ──────────────────────────────────────────────
function doStart() {
  const rem = getRem();
  if (rem <= 0) return;
  if (!startEpoch) startEpoch = Date.now();
  goalEpoch = Date.now() + rem * 1000;
  pausedRemaining = null; lastDisplayed = -1;
  startTick(); render(); save();
  renderDayTicks(); renderGoalFlags();
}
function doPause() {
  if (!isRunning()) return;
  pausedRemaining = getRem(); goalEpoch = null;
  if (rafId) { clearInterval(rafId); rafId = null; }
  render(); save();
  renderGoalFlags();
}
function doReset() {
  if (rafId) { clearInterval(rafId); rafId = null; }
  goalEpoch = null; startEpoch = null; pausedRemaining = null;
  totalSeconds = 0; lastDisplayed = -1;
  render(); clearSave();
  renderDayTicks(); renderGoalFlags();
}
function setDuration(secs) {
  doReset(); totalSeconds = secs; pausedRemaining = secs; render(); save();
}

// ── Button events ──────────────────────────────────────────────
on('startBtn', 'click', () => {
  if (isRunning()) { doPause(); return; }
  if (isPaused())  { doStart(); return; }
  // idle → read inputs and start
  const h = parseInt(hInput.value)||0, m = parseInt(mInput.value)||0, s = parseInt(sInput.value)||0;
  const t = h*3600+m*60+s; if (!t) return;
  totalSeconds = t; pausedRemaining = t;
  doStart();
});
// Reset wipes the session's countdown, so it asks first — it used to fire on a
// single stray tap, right next to 시작/일시정지.
on('resetBtn', 'click', () => {
  if (isIdle() && totalSeconds === 0) { doReset(); return; }   // nothing to lose
  const rem = getRem();
  askConfirm('타이머 초기화',
    `<b>${escHtml(curSession().name)}</b> 세션의 타이머를 초기화할까요?` +
    (rem > 0 ? `<br><span class="confirm-note">${fmt(rem)} 남은 타이머가 사라집니다.</span>` : '') +
    `<br><span class="confirm-note">공부 기록과 목표는 지워지지 않아요.</span>`,
    doReset, { yes: '초기화', danger: true });
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isRunning() || !btn.dataset.h) return;
    hInput.value = btn.dataset.h; mInput.value = 0; sInput.value = 0;
    setDuration(parseInt(btn.dataset.h) * 3600);
  });
});
[hInput, mInput, sInput].forEach(inp => {
  inp.addEventListener('change', () => {
    if (isRunning()) return;
    const h = parseInt(hInput.value)||0, m = parseInt(mInput.value)||0, s = parseInt(sInput.value)||0;
    const t = h*3600+m*60+s; if (t) setDuration(t);
  });
});
on('emgBtn', 'click', () => { emergency = !emergency; render(); saveEmergency(); });
on('swToggle', 'click', toggleStopwatch);

// ── Fullscreen ─────────────────────────────────────────────────
const fsBtn = $('fsBtn');
on('fsBtn', 'click', () => {
  const el = document.documentElement, isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFs) { const req = el.requestFullscreen || el.webkitRequestFullscreen; if (req) req.call(el); }
  else       { const ex  = document.exitFullscreen || document.webkitExitFullscreen; if (ex) ex.call(document); }
});
['fullscreenchange','webkitfullscreenchange'].forEach(ev => {
  document.addEventListener(ev, () => {
    fsBtn.innerHTML = (document.fullscreenElement || document.webkitFullscreenElement) ? ICONS.close : ICONS.expand;
  });
});

// ── Wake lock ──────────────────────────────────────────────────
async function reqWakeLock() {
  if ('wakeLock' in navigator) try { await navigator.wakeLock.request('screen'); } catch(e) {}
}
reqWakeLock();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reqWakeLock(); });

// ── Calendar modal ─────────────────────────────────────────────
const calModal = $('calModal'), calMonthLbl = $('calMonthLabel'), calGridEl = $('calGrid');
let calYear, calMonth, selStart = null, selEnd = null, picking = 'start';
const DAYS   = ['일','월','화','수','목','금','토'];
const MONTHS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

function openCal() {
  const now = new Date();
  calYear = now.getFullYear(); calMonth = now.getMonth(); selStart = null; selEnd = null; picking = 'start';
  $('sH').value = now.getHours(); $('sM').value = now.getMinutes(); $('sS').value = now.getSeconds();
  $('eH').value = ''; $('eM').value = ''; $('eS').value = '';
  renderCal(); calModal.classList.add('open');
}
function dateKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function sameDay(a,b) { return a && b && dateKey(a) === dateKey(b); }
function between(d,a,b) {
  if (!a || !b) return false;
  const t = d.getTime(), ta = a.getTime(), tb = b.getTime();
  return t > Math.min(ta,tb) && t < Math.max(ta,tb);
}
function fmtCalDate(d) { return d ? `${d.getMonth()+1}월 ${d.getDate()}일 (${DAYS[d.getDay()]})` : '—'; }
function calDateTime(d, hId, mId, sId) {
  const x = new Date(d);
  x.setHours(parseInt($(hId).value)||0, parseInt($(mId).value)||0, parseInt($(sId).value)||0, 0);
  return x;
}
function updateCalHint() {
  $('calStartVal').textContent = fmtCalDate(selStart);
  $('calEndVal').textContent   = fmtCalDate(selEnd);
  $('calStepStart').classList.toggle('active', picking === 'start');
  $('calStepEnd').classList.toggle('active', picking === 'end');
  const hint = $('calHint');
  if (selStart && selEnd) {
    const s = calDateTime(selStart, 'sH', 'sM', 'sS');
    const e = calDateTime(selEnd, 'eH', 'eM', 'eS');
    const secs = Math.floor((e - s) / 1000);
    if (secs > 0) {
      const dys = Math.floor(secs/86400), hrs = Math.floor((secs%86400)/3600), mins = Math.floor((secs%3600)/60);
      hint.textContent = '기간 ' + [dys?dys+'일':'', hrs?hrs+'시간':'', (!dys&&mins)?mins+'분':''].filter(Boolean).join(' ');
      hint.classList.remove('warn');
    } else { hint.textContent = '종료가 시작보다 빨라요'; hint.classList.add('warn'); }
  } else {
    hint.classList.remove('warn');
    hint.textContent = picking === 'start' ? '달력에서 시작일을 선택하세요' : '달력에서 종료일을 선택하세요';
  }
}
function renderCal() {
  calMonthLbl.textContent = `${calYear}년 ${MONTHS[calMonth]}`;
  updateCalHint();
  calGridEl.innerHTML = '';
  DAYS.forEach(d => { const el = document.createElement('div'); el.className='cal-dow'; el.textContent=d; calGridEl.appendChild(el); });
  const first = new Date(calYear, calMonth, 1).getDay();
  const days  = new Date(calYear, calMonth+1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);
  for (let i=0; i<first; i++) calGridEl.appendChild(document.createElement('div'));
  for (let d=1; d<=days; d++) {
    const btn = document.createElement('button'), day = new Date(calYear, calMonth, d);
    btn.className = 'cal-day'; btn.textContent = d;
    if (day.toDateString()===today.toDateString()) btn.classList.add('today');
    if (sameDay(day,selStart)) btn.classList.add('sel-start');
    else if (sameDay(day,selEnd)) btn.classList.add('sel-end');
    else if (selStart && selEnd && between(day,selStart,selEnd)) btn.classList.add('in-range');
    btn.addEventListener('click', () => {
      const clicked = new Date(calYear, calMonth, d);
      if (picking==='start') {
        selStart = clicked;
        if (sameDay(clicked,today)) { const n=new Date(); $('sH').value=n.getHours(); $('sM').value=n.getMinutes(); $('sS').value=n.getSeconds(); }
        picking = 'end';
      } else {
        if (clicked < selStart) { selEnd=selStart; selStart=clicked; } else selEnd=clicked;
        picking = 'start';
      }
      renderCal();
    });
    calGridEl.appendChild(btn);
  }
}
on('calPrev', 'click', () => { calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderCal(); });
on('calNext', 'click', () => { calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderCal(); });
on('calStepStart', 'click', () => { picking = 'start'; updateCalHint(); });
on('calStepEnd', 'click', () => { picking = 'end'; updateCalHint(); });
['sH','sM','sS','eH','eM','eS'].forEach(id => on(id, 'input', updateCalHint));
on('calClose', 'click', () => calModal.classList.remove('open'));
on('calModal', 'click', e => { if(e.target===calModal) calModal.classList.remove('open'); });
on('calConfirm', 'click', () => {
  if (!selStart||!selEnd) { alert('시작일과 종료일을 모두 선택해주세요.'); return; }
  const sh=parseInt($('sH').value)||0, sm=parseInt($('sM').value)||0, ss=parseInt($('sS').value)||0;
  const eh=parseInt($('eH').value)||0, em=parseInt($('eM').value)||0, es=parseInt($('eS').value)||0;
  const start=new Date(selStart); start.setHours(sh,sm,ss,0);
  const end  =new Date(selEnd);   end.setHours(eh,em,es,0);
  if (end<=start) { alert('종료 시각이 시작 시각보다 늦어야 해요.'); return; }
  const span=Math.floor((end-start)/1000), remSecs=Math.floor((end-Date.now())/1000);
  calModal.classList.remove('open');
  if (rafId) { clearInterval(rafId); rafId=null; }
  startEpoch=start.getTime(); goalEpoch=end.getTime();
  totalSeconds=span; pausedRemaining=null; lastDisplayed=-1;
  if (remSecs>0) startTick(); else { goalEpoch=null; pausedRemaining=0; }
  render(); save(); renderDayTicks();
});
on('calBtn', 'click', () => { if (!isRunning()) openCal(); });
