// ── Sessions UI ────────────────────────────────────────────────
// A session bundles a main countdown, its goals and the study time recorded
// under it. Subjects, memos and settings stay shared across all of them.
// Every session's countdown runs at once — they're epoch arithmetic, so the
// ones you aren't looking at keep counting without any work.
const sessModal = $('sessModal');
let sessEditingId = null;                       // row expanded for rename/recolour
let selectedSessColor = SESSION_COLORS[0];      // colour picked for the next new session

// ── Reusable confirm dialog ────────────────────────────────────
const confirmModal = $('confirmModal');
let confirmAction = null;
// askConfirm('제목', '설명', onYes, { yes: '삭제', danger: true })
function askConfirm(title, msg, onYes, opts) {
  opts = opts || {};
  confirmAction = onYes;
  $('confirmTitle').textContent = title;
  $('confirmMsg').innerHTML = msg;
  const yes = $('confirmYes');
  yes.textContent = opts.yes || '확인';
  yes.classList.toggle('danger', !!opts.danger);
  $('confirmNo').textContent = opts.no || '취소';
  confirmModal.classList.add('open');
}
function closeConfirm() { confirmModal.classList.remove('open'); confirmAction = null; }
on('confirmYes', 'click', () => {
  const fn = confirmAction;
  closeConfirm();
  if (fn) fn();
});
on('confirmNo', 'click', closeConfirm);
on('confirmClose', 'click', closeConfirm);
on('confirmModal', 'click', e => { if (e.target === confirmModal) closeConfirm(); });

// ── Header chip ────────────────────────────────────────────────
function renderSessionChip() {
  const btn = $('sessionBtn');
  if (!btn) return;
  const s = curSession();
  btn.querySelector('.sess-dot').style.background = s.color;
  btn.querySelector('.sess-name').textContent = s.name;
  btn.classList.toggle('multi', sessions.length > 1);
}

// ── Session list ───────────────────────────────────────────────
function sessionSubtitle(s) {
  const bits = [];
  const rem = timerRemainingOf(s.id);
  if (rem != null && rem > 0) {
    bits.push((timerRunningOf(s.id) ? '진행중 ' : '일시정지 ') + fmt(rem).slice(0, 5));
  } else if (rem === 0) {
    bits.push('타이머 완료');
  }
  const goalCount = goals.filter(g => g.sid === s.id).length;
  if (goalCount) bits.push(`목표 ${goalCount}`);
  bits.push(`오늘 ${fmtHrs(sessionSecToday(s.id))}`);
  return bits.join(' · ');
}
function renderSessionList() {
  const wrap = $('sessList');
  if (!wrap) return;
  const cur = curSessionId();
  wrap.innerHTML = sessions.map(s => {
    if (sessEditingId === s.id) {
      const swatches = SESSION_COLORS.map(c =>
        `<button class="subj-cswatch${c === s.color ? ' selected' : ''}" data-editcolor="${c}" style="background:${c}"></button>`).join('');
      return `<div class="sess-row editing" data-sid="${escHtml(s.id)}">
          <input type="text" class="goal-memo-input sess-name-input" id="sessNameInput" maxlength="20" value="${escHtml(s.name)}">
          <div class="subj-color-row sess-edit-colors">${swatches}</div>
          <div class="sess-edit-actions">
            <button class="acct-secondary sess-del" data-del="${escHtml(s.id)}">삭제</button>
            <button class="modal-confirm sess-save" data-save="${escHtml(s.id)}">저장</button>
          </div>
        </div>`;
    }
    return `<div class="sess-row${s.id === cur ? ' active' : ''}" data-sid="${escHtml(s.id)}">
        <span class="sess-row-dot" style="background:${s.color}"></span>
        <div class="sess-row-body">
          <div class="sess-row-name">${escHtml(s.name)}</div>
          <div class="sess-row-sub">${escHtml(sessionSubtitle(s))}</div>
        </div>
        ${s.id === cur ? '<span class="sess-cur-tag">사용 중</span>' : ''}
        <button class="sess-edit" data-edit="${escHtml(s.id)}" title="이름 · 색 변경">${icoSm('pencil')}</button>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.sess-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.sess-edit') || row.classList.contains('editing')) return;
      switchSession(row.dataset.sid);
      sessModal.classList.remove('open');
    });
  });
  wrap.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', e => {
      e.stopPropagation();
      sessEditingId = b.dataset.edit;
      selectedSessColor = (sessionById(sessEditingId) || {}).color || SESSION_COLORS[0];
      renderSessionList();
      const inp = $('sessNameInput');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }));
  wrap.querySelectorAll('[data-editcolor]').forEach(b =>
    b.addEventListener('click', e => {
      e.stopPropagation();
      selectedSessColor = b.dataset.editcolor;
      wrap.querySelectorAll('[data-editcolor]').forEach(x => x.classList.toggle('selected', x === b));
    }));
  wrap.querySelectorAll('[data-save]').forEach(b =>
    b.addEventListener('click', e => {
      e.stopPropagation();
      const id = b.dataset.save;
      const name = ($('sessNameInput').value || '').trim().slice(0, 20) || '세션';
      sessionUpdate(id, name, selectedSessColor);
      sessEditingId = null;
      saveStudy(); renderSessionList(); renderSessionChip(); updateStudyUI();
    }));
  wrap.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); confirmDeleteSession(b.dataset.del); }));

  const inp = $('sessNameInput');
  if (inp) inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); wrap.querySelector('[data-save]').click(); }
  });
}
// Deleting a session removes it from the list but keeps the hours it recorded —
// they stay in the ledger and show up under 삭제된 세션 in the dashboard.
function confirmDeleteSession(id) {
  if (sessions.length <= 1) { showToast('마지막 세션은 삭제할 수 없어요'); return; }
  const s = sessionById(id);
  if (!s) return;
  const sec = sessionSecAllTime(id);
  askConfirm('세션 삭제',
    `<b>${escHtml(s.name)}</b> 세션을 삭제할까요?<br>` +
    `이 세션의 타이머와 목표가 사라집니다.` +
    (sec > 0.5 ? `<br><span class="confirm-note">기록된 공부 시간 ${fmtHrs(sec)}는 그대로 남습니다.</span>` : ''),
    () => {
      goals = goals.filter(g => { if (g.sid !== id) return true; tombstone(g.id); return false; });
      delete timers[id];
      sessionRemove(id);
      sessEditingId = null;
      saveGoals(); saveStudy();
      adoptTimer(curSessionId());
      restartTick(); render();
      renderGoals(); renderDayTicks(); renderGoalFlags();
      renderSessionList(); renderSessionChip(); updateStudyUI();
      flushSyncSoon();
    },
    { yes: '삭제', danger: true });
}
function buildSessColorSwatches() {
  const wrap = $('sessColorSwatches');
  if (!wrap) return;
  wrap.innerHTML = SESSION_COLORS.map(c =>
    `<button class="subj-cswatch${c === selectedSessColor ? ' selected' : ''}" data-newcolor="${c}" style="background:${c}"></button>`).join('');
  wrap.querySelectorAll('[data-newcolor]').forEach(b =>
    b.addEventListener('click', () => {
      selectedSessColor = b.dataset.newcolor;
      wrap.querySelectorAll('[data-newcolor]').forEach(x => x.classList.toggle('selected', x === b));
    }));
}
function addSessionFromInput() {
  const inp = $('sessAddInput');
  const name = (inp.value || '').trim().slice(0, 20);
  if (!name) { showToast('세션 이름을 입력하세요'); return; }
  const id = sessionAdd(name, selectedSessColor);
  inp.value = '';
  // Advance the palette so the next new session gets a different colour.
  selectedSessColor = SESSION_COLORS[(SESSION_COLORS.indexOf(selectedSessColor) + 1) % SESSION_COLORS.length];
  saveStudy();
  switchSession(id);
  renderSessionList(); buildSessColorSwatches(); renderSessionChip();
}
function openSessions() {
  sessEditingId = null;
  // Default the new-session colour to one that isn't in use yet.
  const used = sessions.map(s => s.color);
  selectedSessColor = SESSION_COLORS.find(c => !used.includes(c)) || SESSION_COLORS[sessions.length % SESSION_COLORS.length];
  renderSessionList();
  buildSessColorSwatches();
  sessModal.classList.add('open');
}
on('sessionBtn', 'click', openSessions);
on('sessClose', 'click', () => sessModal.classList.remove('open'));
on('sessModal', 'click', e => { if (e.target === sessModal) sessModal.classList.remove('open'); });
on('sessAddBtn', 'click', addSessionFromInput);
on('sessAddInput', 'keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addSessionFromInput(); }
});
