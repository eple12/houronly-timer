
// ── Goal modal ─────────────────────────────────────────────────
const goalModal = $('goalModal');
function buildColorSwatches() {
  const c = $('colorSwatches'); c.innerHTML = '';
  GOAL_COLORS.forEach(color => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch' + (color===selectedColor ? ' selected' : '');
    btn.style.background = color;
    btn.addEventListener('click', () => {
      selectedColor = color;
      c.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      btn.classList.add('selected');
    });
    c.appendChild(btn);
  });
}
$('goalBtn').addEventListener('click', () => {
  $('goalH').value=''; $('goalM').value=''; $('goalS').value=''; $('goalMemoInput').value='';
  buildColorSwatches(); goalModal.classList.add('open');
});
$('goalModalClose').addEventListener('click', () => goalModal.classList.remove('open'));
goalModal.addEventListener('click', e => { if(e.target===goalModal) goalModal.classList.remove('open'); });
$('goalConfirm').addEventListener('click', () => {
  const h=parseInt($('goalH').value)||0, m=parseInt($('goalM').value)||0, s=parseInt($('goalS').value)||0;
  const total = h*3600+m*60+s;
  if (!total) { alert('시간을 입력해주세요.'); return; }
  const memo = $('goalMemoInput').value.trim();
  goals.push({ id: Date.now(), memo, endEpoch: Date.now()+total*1000, color: selectedColor });
  saveGoals(); renderGoals(); renderGoalFlags();
  goalModal.classList.remove('open');
});

// ── Dashboard ──────────────────────────────────────────────────
const dashModal = $('dashModal');

// ── Dashboard helpers (period sums, subjects, heatmap) ─────────
function sumLastDays(n) {
  const R = effRecords();
  let t = 0;
  for (let i = 0; i < n; i++) t += R[studyDayKeyOffset(i)] || 0;
  return t;
}
function todayDistractions() { return study.distractions[studyDayKey(Date.now())] || 0; }

function goalGaugeHTML(today) {
  if (!study.dailyGoalSec) return '';
  const pct = Math.min(100, today / study.dailyGoalSec * 100);
  const hit = today >= study.dailyGoalSec;
  return `
    <div class="chart-block">
      <div class="chart-title"><span>오늘 목표 달성률</span></div>
      <div class="goal-gauge ${hit ? 'hit' : ''}">
        <div class="gg-top">
          <span class="gg-pct">${Math.round(pct)}%</span>
          <span class="gg-sub">${fmt(today).slice(0,5)} / ${fmtHrs(study.dailyGoalSec)}${hit ? ' · 달성 🎉' : ''}</span>
        </div>
        <div class="gg-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      </div>
    </div>`;
}

function subjectColor(name) {
  return (study.subjectColors && study.subjectColors[name]) || null;
}
// Just the per-subject bar rows (the part that changes live while studying).
// Kept separate so refreshDashboardLive() can rebuild only this, leaving the
// "add time" dropdown intact.
function subjectBreakRowsHTML() {
  const dayKey = studyDayKey(Date.now());
  const effMap = effectiveSubjectsForDay(dayKey);
  const total  = todayStudySec();

  // Sort: by effective seconds desc; zero-time subjects from subjectList go last
  const allNames = Array.from(new Set([...Object.keys(effMap), ...study.subjectList]));
  allNames.sort((a, b) => {
    const va = effMap[a] || 0, vb = effMap[b] || 0;
    if (va !== vb) return vb - va;
    return (study.subjectList.indexOf(a) ?? 99) - (study.subjectList.indexOf(b) ?? 99);
  });

  // Bar widths are proportional to each subject's share of the total shown.
  const taggedSec = allNames.reduce((s, n) => s + (effMap[n] || 0), 0);

  // Generate a fallback palette color by list-index (for subjects without a custom color)
  const paletteColor = name => {
    const i = study.subjectList.indexOf(name);
    return SUBJECT_COLORS[(i >= 0 ? i : allNames.indexOf(name)) % SUBJECT_COLORS.length];
  };

  if (!allNames.length) return '';

  const line = (name, sec, color) => {
    const pct  = taggedSec > 0 ? Math.min(100, sec / taggedSec * 100) : 0;
    const zero = sec < 1;
    const nameEsc = escHtml(name);
    return `<div class="subj-line${zero ? ' zero' : ''}">
      <div class="subj-line-top">
        <span class="sl-name">${nameEsc}</span>
        <div class="sl-right"><span class="sl-val">${fmt(sec).slice(0, 5)}</span></div>
      </div>
      <div class="subj-line-bar"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></div>
    </div>`;
  };

  const rows = allNames.map(name => {
    const sec   = effMap[name] || 0;
    const color = subjectColor(name) || paletteColor(name);
    return line(name, sec, color);
  });
  return rows.join('');
}

function subjectBreakHTML() {
  const rowsHTML = subjectBreakRowsHTML();
  if (!rowsHTML) return '';

  // Custom dropdown (native <select> popups can't be rounded/styled). The chosen
  // subject is held in `sadSubject`; default to the first subject if unset/stale.
  const cur = study.subjectList.includes(sadSubject) ? sadSubject : (study.subjectList[0] || '');
  const opts = study.subjectList.map(n =>
    `<button type="button" class="subj-dd-opt${n === cur ? ' sel' : ''}" data-val="${escHtml(n)}">${escHtml(n)}</button>`
  ).join('');
  const addRow = study.subjectList.length ? `
    <div class="subj-add-time-wrap">
      <div class="subj-add-time-row">
        <div class="subj-dd" id="sadDropdown" data-val="${escHtml(cur)}">
          <button class="subj-dd-btn" id="sadDdBtn" type="button">
            <span class="dd-label">${escHtml(cur)}</span>
            <svg class="dd-caret" width="11" height="7" viewBox="0 0 11 7" fill="none"><path d="M1 1l4.5 4.5L10 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="subj-dd-menu" id="sadDdMenu">${opts}</div>
        </div>
        <button class="sad-btn" id="sadMinus">-15분</button>
        <button class="sad-btn" id="sadPlus">+15분</button>
      </div>
    </div>` : '';

  return `<div class="chart-block" id="subjBreakBlock">
    <div class="chart-title">
      <span>오늘 과목별</span>
    </div>
    <div class="subj-break" id="subjBreakRows">${rowsHTML}</div>
    ${addRow}
  </div>`;
}

function heatmapHTML() {
  const WEEKS = 18;
  const base = new Date(Date.now() - study.resetHour * 3600 * 1000);
  base.setHours(0,0,0,0);
  const todayDow = base.getDay();
  const start = new Date(base);
  start.setDate(start.getDate() - (WEEKS - 1) * 7 - todayDow);
  const R = effRecords();
  const cells = [];
  let max = 1;
  const cur = new Date(start);
  for (let i = 0; i < WEEKS * 7; i++) {
    const key = `${cur.getFullYear()}-${pad(cur.getMonth()+1)}-${pad(cur.getDate())}`;
    const future = cur.getTime() > base.getTime();
    const sec = future ? -1 : (R[key] || 0);
    if (sec > max) max = sec;
    cells.push({ sec, future, label: `${cur.getMonth()+1}/${cur.getDate()}` });
    cur.setDate(cur.getDate() + 1);
  }
  const body = cells.map(c => {
    if (c.future) return `<div class="heat-cell" style="visibility:hidden"></div>`;
    let bg = 'var(--surf2)';
    if (c.sec > 0.5) {
      const t = Math.min(1, c.sec / max);
      bg = `color-mix(in srgb, var(--accent) ${Math.round((0.22 + 0.78*t)*100)}%, var(--surf2))`;
    }
    return `<div class="heat-cell" style="background:${bg}" title="${c.label} · ${fmtHrs(Math.max(0,c.sec))}"></div>`;
  }).join('');
  const lg = ['var(--surf2)','color-mix(in srgb, var(--accent) 35%, var(--surf2))','color-mix(in srgb, var(--accent) 70%, var(--surf2))','var(--accent)']
    .map(c => `<span class="hl-cell" style="background:${c}"></span>`).join('');
  return `<div class="chart-block">
    <div class="chart-title"><span>최근 18주</span></div>
    <div class="heat-wrap"><div class="heat">${body}</div></div>
    <div class="heat-legend">적음 ${lg} 많음</div>
  </div>`;
}

function renderDashboard() {
  const body = $('dashBody');
  const st   = studyStats();
  const today = todayStudySec();

  // Reset-hour selector options
  const hourOpts = Array.from({length:24}, (_,h) =>
    `<option value="${h}" ${h===study.resetHour?'selected':''}>${pad(h)}:00</option>`).join('');

  if (st.days === 0 && today < 1) {
    body.innerHTML = `
      <div class="dash-empty">아직 기록이 없어요.<br>공부 스톱워치를 시작해 보세요 ${icoSm('play')}</div>
      ${subjectBreakHTML()}
      ${resetHourBlock(hourOpts)}`;
    bindResetHour();
    bindSubjectEdits();
    return;
  }

  // Last 14 days bar chart data
  const N = 14;
  const R = effRecords();
  const data = [];
  for (let i = N-1; i >= 0; i--) {
    const key = studyDayKeyOffset(i);
    const sec = R[key] || 0;
    const parts = key.split('-');
    data.push({ key, sec, label: `${parseInt(parts[1])}/${parseInt(parts[2])}` });
  }
  const maxSec = Math.max(...data.map(d => d.sec), 1);

  // Build SVG bar chart
  const W = 440, H = 150, padL = 4, padR = 4, padT = 12, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bw = plotW / N;
  const avgY = padT + plotH - (st.avg / maxSec) * plotH;

  const bars = data.map((d,i) => {
    const bh = (d.sec / maxSec) * plotH;
    const x  = padL + i*bw + bw*0.18;
    const y  = padT + plotH - bh;
    const w  = bw*0.64;
    const isToday = i === N-1;
    // Today: full accent. Past days with study: a subdued shade of the chosen
    // accent (like the heatmap). Empty days: the theme track colour.
    const fill = isToday ? 'var(--accent)'
               : (d.sec > 0 ? 'color-mix(in srgb, var(--accent) 45%, var(--surf2))' : 'var(--surf2)');
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0,bh).toFixed(1)}" rx="2" fill="${fill}"></rect>`;
  }).join('');

  // x labels: show every other to avoid crowding
  const labels = data.map((d,i) => {
    if (i % 2 !== (N-1)%2) return '';
    const x = padL + i*bw + bw/2;
    return `<text x="${x.toFixed(1)}" y="${H-6}" fill="var(--dim)" font-size="9" text-anchor="middle" font-family="Space Mono">${d.label}</text>`;
  }).join('');

  const avgLine = st.avg > 0
    ? `<line x1="${padL}" y1="${avgY.toFixed(1)}" x2="${W-padR}" y2="${avgY.toFixed(1)}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"></line>`
    : '';

  // Projection block
  const dd = dDayNum();
  let projHTML = '';
  if (dd !== null && dd > 0 && st.avg > 0) {
    const projSec = st.avg * dd;
    projHTML = `
      <div class="proj-card">
        <div class="pc-label">목표까지 예상</div>
        <div class="pc-main">남은 <b>D-${dd}</b> 동안 하루 평균 <b>${fmtHrs(st.avg)}</b> 페이스면<br>
        앞으로 <b>+${fmtHrs(projSec)}</b> 더 공부할 수 있어요.</div>
      </div>`;
  } else if (dd !== null && dd > 0) {
    projHTML = `
      <div class="proj-card">
        <div class="pc-label">목표까지</div>
        <div class="pc-main">남은 <b>D-${dd}</b> · 공부 기록이 쌓이면 예상치를 보여드려요.</div>
      </div>`;
  }

  const distToday = todayDistractions();
  const focusCard = (study.focusMode || distToday > 0)
    ? `<div class="stat-card"><div class="stat-label">오늘 이탈</div><div class="stat-value">${distToday}<small> 회</small></div></div>`
    : '';

  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">오늘</div><div class="stat-value"><span id="dvToday">${fmtHrs(today)}</span><small id="dvTodayS"> ${fmt(today).slice(0,5)}</small></div></div>
      <div class="stat-card"><div class="stat-label">일 평균</div><div class="stat-value" id="dvAvg">${fmtHrs(st.avg)}</div></div>
      <div class="stat-card"><div class="stat-label">총 공부</div><div class="stat-value" id="dvTotal">${fmtHrs(st.total)}</div></div>
      <div class="stat-card"><div class="stat-label">연속 일수</div><div class="stat-value">${st.streak}<small> 일</small></div></div>
    </div>

    <div id="dashGoalGauge">${goalGaugeHTML(today)}</div>

    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">최근 7일</div><div class="stat-value" id="dvWeek">${fmtHrs(sumLastDays(7))}</div></div>
      <div class="stat-card"><div class="stat-label">최근 30일</div><div class="stat-value" id="dvMonth">${fmtHrs(sumLastDays(30))}</div></div>
    </div>

    ${projHTML}

    ${subjectBreakHTML()}

    <div class="chart-block">
      <div class="chart-title">
        <span>최근 14일</span>
        <span class="legend-avg"><span class="legend-dash"></span>평균 ${fmtHrs(st.avg)}</span>
      </div>
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${avgLine}${bars}${labels}
      </svg>
    </div>

    ${heatmapHTML()}

    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">하루 최대</div><div class="stat-value" id="dvBest">${fmtHrs(st.best)}</div></div>
      ${focusCard}
    </div>

    ${resetHourBlock(hourOpts)}
  `;
  bindResetHour();
  bindSubjectEdits();
}

// Update only the live-changing numbers/bars while the stopwatch runs, without
// rebuilding the whole dashboard (a full re-render would close the open subject
// dropdown every second). If the full structure isn't present (empty state),
// fall back to a one-time full render.
function refreshDashboardLive() {
  if (!$('subjBreakRows') || !$('dvToday')) { renderDashboard(); return; }
  $('subjBreakRows').innerHTML = subjectBreakRowsHTML();

  const st    = studyStats();
  const today = todayStudySec();
  const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  set('dvToday',  fmtHrs(today));
  set('dvTodayS', ' ' + fmt(today).slice(0,5));
  set('dvAvg',    fmtHrs(st.avg));
  set('dvTotal',  fmtHrs(st.total));
  set('dvWeek',   fmtHrs(sumLastDays(7)));
  set('dvMonth',  fmtHrs(sumLastDays(30)));
  set('dvBest',   fmtHrs(st.best));
  const gg = $('dashGoalGauge');
  if (gg) gg.innerHTML = goalGaugeHTML(today);
}

function bindSubjectEdits() {
  const dayKey = studyDayKey(Date.now());

  // Bottom "add time" row: custom subject dropdown + ±15m buttons
  const dd       = $('sadDropdown');
  const ddBtn    = $('sadDdBtn');
  const ddMenu   = $('sadDdMenu');
  const sadMinus = $('sadMinus');
  const sadPlus  = $('sadPlus');
  if (!dd || !ddBtn || !ddMenu || !sadMinus || !sadPlus) return;

  // Sync the module-level selection with what's actually shown.
  sadSubject = dd.dataset.val || sadSubject;

  ddBtn.addEventListener('click', e => {
    e.stopPropagation();
    dd.classList.toggle('open');
  });
  ddMenu.querySelectorAll('.subj-dd-opt').forEach(opt => {
    opt.addEventListener('click', e => {
      e.stopPropagation();
      sadSubject       = opt.dataset.val;
      dd.dataset.val   = sadSubject;
      dd.querySelector('.dd-label').textContent = sadSubject;
      ddMenu.querySelectorAll('.subj-dd-opt').forEach(o => o.classList.toggle('sel', o === opt));
      dd.classList.remove('open');
    });
  });

  const applyAdj = delta => {
    const name = dd.dataset.val;
    if (!name) return;
    const cur  = effectiveSubjectSec(dayKey, name);
    const next = Math.max(0, cur + delta);
    const actualDelta = next - cur;
    setSubjectOverride(dayKey, name, next);
    if (actualDelta !== 0) {
      const totalCur = study.records[dayKey] || 0;
      setDayOverride(dayKey, Math.max(0, totalCur + actualDelta));
    }
    refreshDashboardLive();   // updates bars/numbers in place, keeps dropdown
  };
  sadMinus.addEventListener('click', () => applyAdj(-900));
  sadPlus.addEventListener('click',  () => applyAdj(900));
}

function resetHourBlock(hourOpts) {
  return `
    <div class="chart-block">
      <div class="chart-title"><span>스톱워치 리셋 기준</span></div>
      <div class="stat-card">
        <div class="reset-hour-row">
          <div>
            <div class="rh-label">하루 시작 시각</div>
            <div class="rh-sub">이 시각에 공부 기록이 새 날로 넘어가요</div>
          </div>
          <select class="reset-hour-select" id="resetHourSelect">${hourOpts}</select>
        </div>
      </div>
    </div>`;
}
function bindResetHour() {
  const sel = $('resetHourSelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    study.resetHour = parseInt(sel.value) || 0;
    touchSetting('resetHour'); saveStudy();
    lastSeenStudyDay = studyDayKey(Date.now());
    updateStudyUI();
    renderDashboard();
  });
}

$('dashBtn').addEventListener('click', () => { requestNotifyPermission(); renderDashboard(); dashModal.classList.add('open'); });
$('dashClose').addEventListener('click', () => dashModal.classList.remove('open'));
dashModal.addEventListener('click', e => { if(e.target===dashModal) dashModal.classList.remove('open'); });
// Close any open custom subject dropdown when clicking elsewhere (registered
// once; survives dashboard re-renders since it targets live .subj-dd nodes).
document.addEventListener('click', e => {
  document.querySelectorAll('.subj-dd.open').forEach(dd => {
    if (!dd.contains(e.target)) dd.classList.remove('open');
  });
});

// ── Subject picker ─────────────────────────────────────────────
const subjModal = $('subjModal');
function buildSubjColorSwatches() {
  const wrap = $('subjColorSwatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  SUBJECT_COLORS.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'subj-cswatch' + (c === selectedSubjColor ? ' selected' : '');
    btn.style.background = c;
    btn.title = c;
    btn.addEventListener('click', () => {
      selectedSubjColor = c;
      wrap.querySelectorAll('.subj-cswatch').forEach(s => s.classList.toggle('selected', s === btn));
    });
    wrap.appendChild(btn);
  });
}
function renderSubjChips() {
  const wrap = $('subjChips');
  const chips = [`<button class="subj-chip ${study.curSubject==='' ? 'active' : ''}" data-subj="">전체</button>`];
  study.subjectList.forEach(name => {
    const color = (study.subjectColors && study.subjectColors[name]) || SUBJECT_COLORS[study.subjectList.indexOf(name) % SUBJECT_COLORS.length];
    chips.push(
      `<button class="subj-chip ${study.curSubject===name ? 'active' : ''}" data-subj="${escHtml(name)}">
         <span class="subj-color-dot" style="background:${color}"></span>
         ${escHtml(name)}<span class="subj-x" data-del="${escHtml(name)}" title="삭제">✕</span>
       </button>`);
  });
  wrap.innerHTML = chips.join('');
  wrap.querySelectorAll('.subj-chip').forEach(btn => {
    btn.addEventListener('click', e => {
      if (e.target.closest('.subj-x') || e.target.closest('.subj-color-dot')) return;
      study.curSubject = btn.dataset.subj || '';
      touchSetting('curSubject'); saveStudy(); updateStudyUI();
      subjModal.classList.remove('open');
    });
  });
  wrap.querySelectorAll('.subj-x').forEach(x => {
    x.addEventListener('click', e => {
      e.stopPropagation();
      const name = x.dataset.del;
      study.subjectList = study.subjectList.filter(s => s !== name);
      if (study.subjectColors) delete study.subjectColors[name];
      if (study.curSubject === name) { study.curSubject = ''; touchSetting('curSubject'); }
      touchSetting('subjectList'); saveStudy(); renderSubjChips(); updateStudyUI();
    });
  });
  buildSubjColorSwatches();
}
function addSubject() {
  const inp = $('subjAddInput');
  const name = (inp.value || '').trim().slice(0, 16);
  if (!name) return;
  if (!study.subjectList.includes(name)) {
    study.subjectList.push(name);
    touchSetting('subjectList');
    // Assign the currently selected color (or auto-assign from palette)
    if (!study.subjectColors) study.subjectColors = {};
    const autoColor = SUBJECT_COLORS[(study.subjectList.length - 1) % SUBJECT_COLORS.length];
    study.subjectColors[name] = selectedSubjColor || autoColor;
    touchSetting('subjectColors');
  }
  study.curSubject = name;
  inp.value = '';
  // Advance selectedSubjColor to the next in the palette for the next add
  const ni = (SUBJECT_COLORS.indexOf(selectedSubjColor) + 1) % SUBJECT_COLORS.length;
  selectedSubjColor = SUBJECT_COLORS[ni];
  touchSetting('curSubject'); saveStudy(); renderSubjChips(); updateStudyUI();
}
$('swSubjectBtn').addEventListener('click', () => { renderSubjChips(); subjModal.classList.add('open'); });
$('subjClose').addEventListener('click', () => subjModal.classList.remove('open'));
subjModal.addEventListener('click', e => { if (e.target === subjModal) subjModal.classList.remove('open'); });
$('subjAddBtn').addEventListener('click', addSubject);
$('subjAddInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSubject(); } });

// ── Settings ───────────────────────────────────────────────────
const setModal = $('setModal');
function renderSettings() {
  const body = $('setBody');
  const accentSwatches = ACCENTS.map(c =>
    `<button class="color-swatch ${study.accent===c?'selected':''}" data-accent="${c}" style="background:${c}"></button>`).join('');
  const goalH = study.dailyGoalSec ? (Math.round(study.dailyGoalSec / 360) / 10) : '';
  body.innerHTML = `
    <div class="set-section">
      <div class="modal-field-label">테마</div>
      <div class="seg" id="themeSeg">
        <button class="seg-btn ${study.theme==='dark'?'active':''}" data-theme="dark">다크</button>
        <button class="seg-btn ${study.theme==='light'?'active':''}" data-theme="light">라이트</button>
      </div>
      <div class="modal-field-label" style="margin-top:6px">강조 색</div>
      <div class="color-swatches" id="accentSwatches">${accentSwatches}</div>
    </div>

    <div class="set-section">
      <div class="setting-row">
        <div class="sr-text">
          <div class="sr-label">하루 공부 목표</div>
          <div class="sr-sub">0 이면 목표 표시를 끕니다</div>
        </div>
        <input type="number" class="goal-hours-input" id="goalHoursInput" min="0" max="24" step="0.5" placeholder="0" inputmode="decimal" value="${goalH}">
      </div>
    </div>

    <div class="set-section">
      <div class="setting-row">
        <div class="sr-text">
          <div class="sr-label">집중 모드</div>
          <div class="sr-sub">스톱워치 진행 중 다른 화면으로 나가면 이탈로 기록해요</div>
        </div>
        <label class="switch"><input type="checkbox" id="focusModeToggle" ${study.focusMode?'checked':''}><span class="track"></span></label>
      </div>
    </div>

    <div class="set-section">
      <div class="modal-field-label">뽀모도로 (분)</div>
      <div class="pomo-config">
        <div class="input-group"><label>집중</label><input type="number" id="pomoFocus" min="1" max="180" inputmode="numeric" value="${study.pomo.focus}"></div>
        <div class="input-group"><label>휴식</label><input type="number" id="pomoShort" min="1" max="60" inputmode="numeric" value="${study.pomo.short}"></div>
        <div class="input-group"><label>긴휴식</label><input type="number" id="pomoLong" min="1" max="60" inputmode="numeric" value="${study.pomo.long}"></div>
        <div class="input-group"><label>세트</label><input type="number" id="pomoSets" min="1" max="12" inputmode="numeric" value="${study.pomo.sets}"></div>
      </div>
    </div>

    <div class="set-section">
      <div class="setting-row">
        <div class="sr-text">
          <div class="sr-label">캐시 비우고 새로고침</div>
          <div class="sr-sub">앱이 최신 버전으로 안 보일 때 캐시를 지우고 다시 불러와요 (저장된 기록·메모는 유지)</div>
        </div>
        <button class="acct-secondary" id="cacheReset">새로고침</button>
      </div>
    </div>`;

  body.querySelectorAll('#themeSeg .seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      study.theme = b.dataset.theme; touchSetting('theme'); applyTheme(); saveStudy();
      body.querySelectorAll('#themeSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    }));
  body.querySelectorAll('#accentSwatches .color-swatch').forEach(b =>
    b.addEventListener('click', () => {
      study.accent = b.dataset.accent; touchSetting('accent'); applyTheme(); saveStudy();
      body.querySelectorAll('#accentSwatches .color-swatch').forEach(x => x.classList.toggle('selected', x === b));
    }));
  $('goalHoursInput').addEventListener('change', e => {
    const h = Math.max(0, Math.min(24, parseFloat(e.target.value) || 0));
    study.dailyGoalSec = Math.round(h * 3600);
    touchSetting('dailyGoalSec'); saveStudy(); updateStudyUI();
  });
  $('focusModeToggle').addEventListener('change', e => { study.focusMode = e.target.checked; touchSetting('focusMode'); saveStudy(); });
  const bindPomo = (id, key, min, max) => $(id).addEventListener('change', e => {
    study.pomo[key] = Math.max(min, Math.min(max, parseInt(e.target.value) || min));
    e.target.value = study.pomo[key];
    touchSetting('pomo'); saveStudy(); if (!pomoPhase) renderPomo();
  });
  bindPomo('pomoFocus','focus',1,180); bindPomo('pomoShort','short',1,60);
  bindPomo('pomoLong','long',1,60);    bindPomo('pomoSets','sets',1,12);
  $('cacheReset').addEventListener('click', fullCacheRefresh);
}

// Clear cached app assets (Cache Storage + any service worker) and hard-reload
// to the freshest deployed version. Saved data in localStorage is kept — and if
// signed in it's in the cloud anyway. Flushes pending sync first.
async function fullCacheRefresh() {
  if (!confirm('앱 캐시를 비우고 최신 버전으로 새로고침할까요?\n저장된 공부 기록·메모는 그대로 유지됩니다.')) return;
  try { pushCloud(); } catch (e) {}
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) {}
  const u = new URL(location.href);
  u.searchParams.set('_', Date.now());   // cache-bust the document fetch
  location.replace(u.toString());
}
$('setBtn').addEventListener('click', () => { renderSettings(); setModal.classList.add('open'); });
$('setClose').addEventListener('click', () => setModal.classList.remove('open'));
setModal.addEventListener('click', e => { if (e.target === setModal) setModal.classList.remove('open'); });

// ── Focus mode: distraction detection ──────────────────────────
let focusLeftCount = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (study.focusMode && swRunning()) {
      const key = studyDayKey(Date.now());
      study.distractions[key] = (study.distractions[key] || 0) + 1;
      focusLeftCount++;
      saveStudy();
    }
  } else if (focusLeftCount > 0) {
    const key = studyDayKey(Date.now());
    showToast(`집중 모드 · 오늘 ${study.distractions[key] || focusLeftCount}회 이탈했어요`);
    if ('vibrate' in navigator) navigator.vibrate(120);
  }
});

