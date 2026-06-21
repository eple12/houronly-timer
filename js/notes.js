// ── Notes / memo UI ────────────────────────────────────────────
const notesModal    = $('notesModal');
const noteEditModal = $('noteEditModal');
const memoWidget    = $('memoWidget');
let memoCollapseTimer = null;
let memoIndex = 0;     // which note the widget is showing
let editDraftItems = [];
let editDraftType  = 'text';

// Ordering: pinned first, then unpinned. Within each group the explicit `order`
// field (set by drag-reordering and on creation) is the source of truth, so
// editing a note never reshuffles the list. Notes that predate manual ordering
// fall back to the old implicit rule (pin order, then most-recent edit).
function noteSortCmp(a, b) {
  const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
  if (pa !== pb) return pb - pa;
  if (a.order != null && b.order != null && a.order !== b.order) return a.order - b.order;
  if (pa) return (a.pinnedAt || a.id || 0) - (b.pinnedAt || b.id || 0);
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}
// Give every note an explicit `order` following the current display order, so
// drag-reordering and new notes have a stable basis. Pinned notes keep smaller
// values (they always sort above unpinned regardless). Once every note has an
// order this is a no-op, so reloads don't renumber (which would churn sync).
// Seeded notes get no `orderAt`, so they don't claim authority over a peer's
// explicit reorder.
function normalizeNoteOrders() {
  if (notes.length && notes.every(n => Number.isFinite(n.order))) return;
  notes.slice().sort(noteSortCmp).forEach((n, i) => { n.order = i; });
}
// Smallest order value currently in use (new notes go just above it → top).
function minNoteOrder() {
  return notes.length ? Math.min(...notes.map(n => n.order || 0)) : 0;
}
// Apply a drag-reorder within one pinned/unpinned group, then persist.
function commitNoteReorder(pinnedFlag, fromIdx, toIdx) {
  const sorted   = notes.slice().sort(noteSortCmp);
  const pinnedG  = sorted.filter(n => n.pinned);
  const unpinG   = sorted.filter(n => !n.pinned);
  const target   = pinnedFlag === '1' ? pinnedG : unpinG;
  const [moved]  = target.splice(fromIdx, 1);
  target.splice(toIdx, 0, moved);
  // Stamp orderAt so this reorder propagates across devices independently of
  // note content (sync resolves `order` by orderAt, not updatedAt).
  const now = Date.now();
  pinnedG.concat(unpinG).forEach((n, i) => { n.order = i; n.orderAt = now; });
  saveNotes();
  renderNotesList();
  renderMemoWidget();
}
// Notes ordered for the main widget: pinned first, then most-recent.
function memoOrderedNotes() {
  return notes.slice().sort(noteSortCmp);
}
function pinnedOrRecentNote() {
  const list = memoOrderedNotes();
  return list.length ? list[0] : null;
}
function notePreviewText(n) {
  if (n.type === 'list') {
    const items = n.items || [];
    return `체크리스트 · ${items.filter(i => i.done).length}/${items.length} 완료`;
  }
  return (n.text || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '내용 없음';
}

// Main-screen memo widget. The fab is always in flow (fixed slot); the card is
// an absolute overlay so opening/closing never moves the UI below it.
// Inner HTML of the open card for a given note.
function memoCardInner(n, list) {
  const body = n.type === 'list'
    ? `<div class="memo-checks">${(n.items || []).map((it, i) =>
        `<label class="memo-check ${it.done ? 'done' : ''}"><input type="checkbox" data-i="${i}" ${it.done ? 'checked' : ''}><span>${escHtml(it.t || '')}</span></label>`
      ).join('') || '<div class="memo-empty">항목 없음</div>'}</div>`
    : `<div class="memo-text">${n.text ? escHtml(n.text) : '<span class="memo-empty">내용 없음</span>'}</div>`;
  const nav = list.length > 1
    ? `<div class="memo-nav">
         <button class="memo-mini-btn" id="memoPrev" title="이전">${ICONS.chevL}</button>
         <span class="memo-nav-count">${memoIndex + 1} / ${list.length}</span>
         <button class="memo-mini-btn" id="memoNext" title="다음">${ICONS.chevR}</button>
       </div>`
    : '';
  return `<div class="memo-card-head">
            ${n.pinned ? '<span class="memo-pin-ic">'+icoSm('pin')+'</span>' : ''}
            <span class="memo-card-title">${escHtml(n.title || '메모')}</span>
            <div class="memo-card-actions">
              <button class="memo-mini-btn" id="memoBig" title="크게 보기">${ICONS.expand}</button>
              <button class="memo-mini-btn" id="memoEdit" title="편집">${ICONS.pencil}</button>
              <button class="memo-mini-btn" id="memoOpen" title="메모장">${ICONS.list}</button>
              <button class="memo-mini-btn" id="memoCollapse" title="접기">${ICONS.close}</button>
            </div>
          </div>
          ${body}
          ${nav}`;
}
// Wire up the card's interactive elements. `n` and `list` describe the note
// currently shown in the card.
function bindMemoCard(n, list) {
  memoWidget.querySelectorAll('.memo-check input').forEach(cb => {
    cb.addEventListener('change', () => {
      cancelMemoAutoCollapse();
      n.items[+cb.dataset.i].done = cb.checked;
      n.updatedAt = Date.now();
      saveNotes();
      memoShowNote(n.id);  // update in place; keep showing this note
    });
  });
  // Prev/next swap the card contents in place (no re-mount → no flicker/animation).
  const go = d => {
    cancelMemoAutoCollapse();
    const cur = memoOrderedNotes();
    if (cur.length < 2) return;
    memoIndex = (memoIndex + d + cur.length) % cur.length;
    const next = cur[memoIndex];
    const card = memoWidget.querySelector('.memo-card');
    card.innerHTML = memoCardInner(next, cur);
    bindMemoCard(next, cur);
  };
  if ($('memoPrev')) $('memoPrev').addEventListener('click', () => go(-1));
  if ($('memoNext')) $('memoNext').addEventListener('click', () => go(1));
  $('memoBig').addEventListener('click', () => { cancelMemoAutoCollapse(); openMemoBig(n.id); });
  $('memoEdit').addEventListener('click', () => { collapseMemo(); openNoteEditor(n.id); });
  $('memoOpen').addEventListener('click', () => { collapseMemo(); openNotes(); });
  $('memoCollapse').addEventListener('click', collapseMemo);
  const card = memoWidget.querySelector('.memo-card');
  card.addEventListener('pointerdown', cancelMemoAutoCollapse, { once: true });
  // Horizontal swipe to flip between notes (swipe left → next, right → prev).
  if (list.length > 1) {
    let sx = 0, sy = 0, swiping = false;
    card.addEventListener('pointerdown', e => {
      if (e.target.closest('button, input, label')) return;  // don't hijack taps on controls
      sx = e.clientX; sy = e.clientY; swiping = true;
    });
    card.addEventListener('pointerup', e => {
      if (!swiping) return;
      swiping = false;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    });
  }
}
// Re-render just the open card in place to show the note with the given id,
// without re-mounting the widget (avoids the entrance animation re-firing).
function memoShowNote(id) {
  const cur = memoOrderedNotes();
  const i = cur.findIndex(x => x.id === id);
  if (i < 0 || !memoWidget.classList.contains('open')) { renderMemoWidget(); return; }
  memoIndex = i;
  const card = memoWidget.querySelector('.memo-card');
  if (!card) { renderMemoWidget(); return; }
  card.innerHTML = memoCardInner(cur[i], cur);
  bindMemoCard(cur[i], cur);
}
function renderMemoWidget() {
  const list = memoOrderedNotes();
  if (!list.length) { memoWidget.style.display = 'none'; memoWidget.innerHTML = ''; memoWidget.classList.remove('open'); return; }
  memoWidget.style.display = '';
  memoIndex = Math.max(0, Math.min(memoIndex, list.length - 1));
  const n = list[memoIndex];
  const open = memoWidget.classList.contains('open');
  let html = `<button class="memo-fab" id="memoFab" title="메모">${ICONS.note}<span class="memo-dot"></span></button>`;
  if (open) html += `<div class="memo-card">${memoCardInner(n, list)}</div>`;
  memoWidget.innerHTML = html;
  $('memoFab').addEventListener('click', () => memoWidget.classList.contains('open') ? collapseMemo() : expandMemo());
  if (open) bindMemoCard(n, list);
}
// User-initiated expand: stays open until the user closes it (no auto-collapse).
function expandMemo() { cancelMemoAutoCollapse(); memoIndex = 0; memoWidget.classList.add('open'); renderMemoWidget(); }
function collapseMemo() {
  cancelMemoAutoCollapse();
  const card = memoWidget.querySelector('.memo-card');
  if (card && memoWidget.classList.contains('open')) {
    card.classList.add('memo-out');
    const done = () => { memoWidget.classList.remove('open'); renderMemoWidget(); };
    card.addEventListener('animationend', done, { once: true });
    setTimeout(() => { if (memoWidget.classList.contains('open')) done(); }, 240);
  } else {
    memoWidget.classList.remove('open');
    renderMemoWidget();
  }
}
// Only the initial on-entry expansion auto-collapses.
function scheduleMemoAutoCollapse() { cancelMemoAutoCollapse(); memoCollapseTimer = setTimeout(collapseMemo, 2000); }
function cancelMemoAutoCollapse() { clearTimeout(memoCollapseTimer); memoCollapseTimer = null; }

// ── Large memo view ────────────────────────────────────────────
// Show the given note big (most of the screen). Checklists stay interactive and
// edits persist; text notes are read-only here (use 편집 to change them).
const memoBigModal = $('memoBigModal');
let memoBigId = null;
function openMemoBig(id) {
  const n = notes.find(x => x.id === id);
  if (!n) return;
  memoBigId = id;
  renderMemoBig(n);
  memoBigModal.classList.add('open');
}
function renderMemoBig(n) {
  $('memoBigTitle').textContent = n.title || '메모';
  const body = $('memoBigBody');
  if (n.type === 'list') {
    body.innerHTML = `<div class="memo-big-checks">${(n.items || []).map((it, i) =>
      `<label class="memo-big-check ${it.done ? 'done' : ''}"><input type="checkbox" data-i="${i}" ${it.done ? 'checked' : ''}><span>${escHtml(it.t || '')}</span></label>`
    ).join('') || '<div class="memo-empty">항목 없음</div>'}</div>`;
    body.querySelectorAll('.memo-big-check input').forEach(cb => {
      cb.addEventListener('change', () => {
        n.items[+cb.dataset.i].done = cb.checked;
        n.updatedAt = Date.now();
        saveNotes();
        renderMemoBig(n);
        memoShowNote(n.id);
      });
    });
  } else {
    body.innerHTML = n.text
      ? `<div class="memo-big-text">${escHtml(n.text)}</div>`
      : '<div class="memo-empty">내용 없음</div>';
  }
}
$('memoBigClose').addEventListener('click', () => memoBigModal.classList.remove('open'));
memoBigModal.addEventListener('click', e => { if (e.target === memoBigModal) memoBigModal.classList.remove('open'); });

// Notes manager
function openNotes() { renderNotesList(); notesModal.classList.add('open'); }
function renderNotesList() {
  const list = $('notesList');
  if (!notes.length) {
    list.innerHTML = '<div class="notes-empty">아직 메모가 없습니다.<br>위 버튼으로 새 메모를 추가하세요.</div>';
    return;
  }
  const sorted = notes.slice().sort(noteSortCmp);
  list.innerHTML = sorted.map(n =>
    `<div class="note-row" data-id="${n.id}" data-pinned="${n.pinned ? '1' : '0'}">
       <button class="note-drag-handle" title="끌어서 순서 변경">${ICONS.grip}</button>
       <div class="note-row-body">
         <div class="note-row-title">${n.pinned ? '<span class="note-pin-ic">'+icoSm('pin')+'</span> ' : ''}${n.type === 'list' ? icoSm('check')+' ' : ''}${escHtml(n.title || '메모')}</div>
         <div class="note-row-sub">${escHtml(notePreviewText(n))}</div>
       </div>
       <button class="note-row-del" data-del="${n.id}">${ICONS.trash}</button>
     </div>`).join('');
  list.querySelectorAll('.note-row').forEach(r => {
    r.addEventListener('click', e => {
      if (e.target.closest('.note-row-del') || e.target.closest('.note-drag-handle')) return;
      openNoteEditor(parseInt(r.dataset.id));
    });
  });
  enableNoteDrag(list);
  list.querySelectorAll('.note-row-del').forEach(b => {
    b.addEventListener('click', () => {
      const delId = parseInt(b.dataset.del);
      notes = notes.filter(n => n.id !== delId);
      tombstone(delId);
      saveNotes(); renderNotesList(); renderMemoWidget();
    });
  });
}

// Pointer-based drag reordering of note rows (works on touch). A row can only be
// reordered within its own group — pinned among pinned, unpinned among unpinned.
function enableNoteDrag(list) {
  list.querySelectorAll('.note-drag-handle').forEach(handle =>
    handle.addEventListener('pointerdown', e => beginNoteDrag(e, handle, list)));
}
function beginNoteDrag(e, handle, list) {
  if (e.button != null && e.button !== 0) return;
  e.preventDefault();
  const row     = handle.closest('.note-row');
  const pinned  = row.dataset.pinned;
  const group   = [...list.querySelectorAll('.note-row')].filter(r => r.dataset.pinned === pinned);
  const fromIdx = group.indexOf(row);
  const rect    = row.getBoundingClientRect();
  const gap     = parseFloat(getComputedStyle(list).rowGap) || 8;
  const step    = rect.height + gap;
  const startY  = e.clientY;
  let toIdx     = fromIdx;

  row.classList.add('note-dragging');
  try { handle.setPointerCapture(e.pointerId); } catch (err) {}

  function onMove(ev) {
    const dy = ev.clientY - startY;
    row.style.transform = `translateY(${dy}px)`;
    const nt = Math.max(0, Math.min(group.length - 1, fromIdx + Math.round(dy / step)));
    if (nt === toIdx) return;
    toIdx = nt;
    // Slide the other rows in the group to open a gap at the target slot.
    group.forEach((r, i) => {
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
    group.forEach(r => { r.style.transform = ''; });
    row.classList.remove('note-dragging');
    if (toIdx !== fromIdx) commitNoteReorder(pinned, fromIdx, toIdx);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

// Note editor
function openNoteEditor(id, newType) {
  editingNoteId = (id != null) ? id : null;
  const n = (id != null) ? notes.find(x => x.id === id)
                         : { title: '', type: newType || 'text', text: '', items: [], pinned: false };
  if (!n) return;
  $('noteEditTitle').textContent = (id != null) ? '메모 편집' : (n.type === 'list' ? '새 체크리스트' : '새 메모');
  $('noteTitleInput').value = n.title || '';
  $('notePinInput').checked = !!n.pinned;
  $('noteDelete').style.display = (id != null) ? '' : 'none';
  editDraftType = n.type === 'list' ? 'list' : 'text';
  if (editDraftType === 'text') {
    $('noteEditBody').innerHTML = `<textarea id="noteTextInput" placeholder="내용">${escHtml(n.text || '')}</textarea>`;
    const ta = $('noteTextInput');
    // ArrowUp at the very start moves focus up to the title.
    ta.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault(); $('noteTitleInput').focus();
      }
    });
  } else {
    editDraftItems = (n.items || []).map(i => ({ t: i.t || '', done: !!i.done }));
    if (!editDraftItems.length) editDraftItems.push({ t: '', done: false });  // start ready to type
    renderEditItems();
  }
  noteEditModal.classList.add('open');
}
function renderEditItems() {
  const body = $('noteEditBody');
  body.innerHTML =
    `<div class="note-items">` +
    editDraftItems.map((it, i) =>
      `<div class="note-item-edit">
         <input type="checkbox" data-i="${i}" ${it.done ? 'checked' : ''}>
         <input type="text" data-i="${i}" value="${escHtml(it.t)}" placeholder="할 일">
         <button class="note-item-del" data-i="${i}">✕</button>
       </div>`).join('') +
    `</div><button class="note-add-item" id="noteAddItem">+ 항목 추가</button>`;
  body.querySelectorAll('.note-item-edit input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', () => { editDraftItems[+cb.dataset.i].done = cb.checked; }));
  body.querySelectorAll('.note-item-edit input[type=text]').forEach(tx => {
    tx.addEventListener('input', () => { editDraftItems[+tx.dataset.i].t = tx.value; });
    tx.addEventListener('keydown', e => {
      const i = +tx.dataset.i;
      if (e.key === 'Enter') {
        // Enter adds a new item right below and focuses it.
        e.preventDefault();
        editDraftItems.splice(i + 1, 0, { t: '', done: false });
        renderEditItems();
        const inputs = body.querySelectorAll('.note-item-edit input[type=text]');
        if (inputs[i + 1]) inputs[i + 1].focus();
      } else if (e.key === 'ArrowDown') {
        // Move focus to the next item.
        const inputs = body.querySelectorAll('.note-item-edit input[type=text]');
        if (inputs[i + 1]) { e.preventDefault(); inputs[i + 1].focus(); }
      } else if (e.key === 'ArrowUp') {
        // Move focus to the previous item, or up to the title.
        e.preventDefault();
        const inputs = body.querySelectorAll('.note-item-edit input[type=text]');
        if (i > 0) inputs[i - 1].focus();
        else $('noteTitleInput').focus();
      }
    });
  });
  body.querySelectorAll('.note-item-del').forEach(b =>
    b.addEventListener('click', () => { editDraftItems.splice(+b.dataset.i, 1); renderEditItems(); }));
  $('noteAddItem').addEventListener('click', () => {
    editDraftItems.push({ t: '', done: false });
    renderEditItems();
    const inputs = body.querySelectorAll('.note-item-edit input[type=text]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
}
function saveNoteFromEditor() {
  let n = (editingNoteId != null) ? notes.find(x => x.id === editingNoteId) : null;
  // New notes land at the top of their group; orderAt lets that position sync.
  if (!n) { n = { id: Date.now(), type: editDraftType, order: minNoteOrder() - 1, orderAt: Date.now() }; notes.push(n); }
  n.title = $('noteTitleInput').value.trim();
  n.type  = editDraftType;
  if (editDraftType === 'text') { n.text = $('noteTextInput') ? $('noteTextInput').value : ''; n.items = []; }
  else { n.items = editDraftItems.filter(i => i.t.trim() !== '' || i.done).map(i => ({ t: i.t, done: i.done })); n.text = ''; }
  const now = Date.now();
  if ($('notePinInput').checked) {
    if (!n.pinned) n.pinnedAt = now;   // record pin order (keep prior value if already pinned)
    n.pinned = true;
  } else {
    n.pinned = false;
    n.pinnedAt = 0;
  }
  n.updatedAt = now;
  saveNotes();
  noteEditModal.classList.remove('open');
  renderNotesList();
  renderMemoWidget();
}
// True when a brand-new note has nothing worth keeping (so leaving doesn't create junk).
function noteEditorIsEmpty() {
  const title = $('noteTitleInput').value.trim();
  if (editDraftType === 'text') {
    const t = $('noteTextInput') ? $('noteTextInput').value.trim() : '';
    return !title && !t;
  }
  return !title && !editDraftItems.some(i => i.t.trim() !== '' || i.done);
}
// Leaving the editor (outside click / ✕) auto-saves, like a sticky note. An
// empty new note is just discarded; use 삭제 to discard an existing one.
function leaveNoteEditor() {
  if (editingNoteId == null && noteEditorIsEmpty()) {
    noteEditModal.classList.remove('open');
    return;
  }
  saveNoteFromEditor();
}
function deleteEditingNote() {
  if (editingNoteId != null) {
    notes = notes.filter(n => n.id !== editingNoteId);
    tombstone(editingNoteId);
    saveNotes();
  }
  noteEditModal.classList.remove('open');
  renderNotesList();
  renderMemoWidget();
}

$('notesBtn').addEventListener('click', openNotes);
$('notesClose').addEventListener('click', () => notesModal.classList.remove('open'));
notesModal.addEventListener('click', e => { if (e.target === notesModal) notesModal.classList.remove('open'); });
$('newTextNote').addEventListener('click', () => openNoteEditor(null, 'text'));
$('newListNote').addEventListener('click', () => openNoteEditor(null, 'list'));
$('noteEditClose').addEventListener('click', leaveNoteEditor);
noteEditModal.addEventListener('click', e => { if (e.target === noteEditModal) leaveNoteEditor(); });
$('noteSave').addEventListener('click', saveNoteFromEditor);
$('noteDelete').addEventListener('click', deleteEditingNote);
// ArrowDown from the title drops into the body (first checklist item / memo text).
$('noteTitleInput').addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown') return;
  const body = $('noteEditBody');
  if (editDraftType === 'list') {
    const first = body.querySelector('.note-item-edit input[type=text]');
    if (first) { e.preventDefault(); first.focus(); }
  } else {
    const ta = $('noteTextInput');
    if (ta) { e.preventDefault(); ta.focus(); ta.setSelectionRange(0, 0); }
  }
});

// ── Restore ────────────────────────────────────────────────────
loadGoals();
loadStudy();
loadNotes();
normalizeNoteOrders();   // seed `order` for notes that predate manual reordering
loadTomb();
loadPomo();
applyTheme();
lastSeenStudyDay = studyDayKey(Date.now());

// Resume a pomodoro phase that was running before reload (don't fast-forward
// through phases missed while away — just resume, or stop at 0 if it expired).
if (pomoEndEpoch) {
  if (Date.now() < pomoEndEpoch) {
    pomoRemaining = Math.ceil((pomoEndEpoch - Date.now()) / 1000);
    startPomoInterval();
  } else {
    pomoEndEpoch = null;
    pomoRemaining = 0;   // finished while the page was closed; tap to continue
  }
}
renderPomo();
setComboMode(study.comboMode === 'pomo' ? 'pomo' : 'study');
// On restore, resume the live session — its full elapsed time (including time
// spent with the tab closed or the screen locked) is credited.
reconcileSession();

(function restore() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)); } catch(e) {}
  if (!saved) { render(); renderGoals(); renderDayTicks(); renderGoalFlags(); updateStudyUI(); return; }

  totalSeconds = saved.totalSeconds || 0;
  startEpoch   = saved.startEpoch   || null;
  emergency    = saved.emergency    || false;

  let restoreMsg = '';
  if (saved.goalEpoch) {
    const rem = Math.floor((saved.goalEpoch - Date.now()) / 1000);
    if (rem > 0) {
      goalEpoch = saved.goalEpoch;
      restoreMsg = '세션 복원됨 — ' + fmt(rem) + ' 남음';
      startTick();
    } else {
      goalEpoch = null; pausedRemaining = 0;
      restoreMsg = '세션 복원됨 — 타이머가 종료되었습니다';
    }
  } else if (saved.pausedRemaining > 0) {
    pausedRemaining = saved.pausedRemaining;
    restoreMsg = '세션 복원됨 — ' + fmt(pausedRemaining) + ' (일시정지 상태)';
  }

  render(); renderGoals(); renderDayTicks(); renderGoalFlags(); updateStudyUI();
  // Don't show the restore notice when the reload was triggered by a sync update.
  let syncReload = false;
  try { syncReload = sessionStorage.getItem('syncReload') === '1'; sessionStorage.removeItem('syncReload'); } catch(e) {}
  if (restoreMsg && !syncReload) setTimeout(() => showToast(restoreMsg), 300);
})();

// Memo widget: show expanded on entry (if a memo exists), then auto-collapse.
renderMemoWidget();
if (pinnedOrRecentNote()) {
  memoWidget.classList.add('open');
  renderMemoWidget();
  scheduleMemoAutoCollapse();
}
