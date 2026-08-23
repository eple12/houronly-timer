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
  if (pa) return (a.pinnedAt || a.createdAt || 0) - (b.pinnedAt || b.createdAt || 0);
  if ((a.updatedAt || 0) !== (b.updatedAt || 0)) return (b.updatedAt || 0) - (a.updatedAt || 0);
  // Ids are strings now, so fall back to a stable comparison — two devices must
  // never draw the same list in a different order.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
  const now = stamp();
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
// Tick a checklist row. Only the row's own stamp moves — ticking item 3 here
// while item 1 is ticked on another device keeps both, instead of the whole
// note's last write winning.
function toggleNoteItem(note, i) {
  if (!note || note.type !== 'list' || !note.items || !note.items[i]) return false;
  const it = note.items[i];
  if (it.sep) return false;
  it.done = !it.done;
  it.at = stamp();
  saveNotes();
  return true;
}
// ── Memo markup ────────────────────────────────────────────────
// Text memos stay plain strings (which keeps them trivially syncable — see
// mergeNote); the structure lives in a tiny line-based markup:
//
//   >>            내용 구분선
//   >> 제목        제목이 붙은 구분선 (제목 옆으로 선이 이어짐)
//   | a | b |     표 한 줄. 이어지는 줄들이 하나의 표가 되고,
//   | --- | --- | 이 줄이 있으면 바로 윗줄이 표의 머리글이 됩니다.
const RE_DIVIDER = /^\s*>>\s?(.*)$/;
const RE_TABLE_ROW = /^\s*\|(.*)$/;
const isTableRow = l => RE_TABLE_ROW.test(l) && l.trim().length > 1;
const isSepRow   = cells => cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c.trim()));
function splitTableRow(line) {
  let s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split('|').map(c => c.trim());
}
function dividerHTML(label) {
  return label
    ? `<div class="memo-hr labeled"><span class="memo-hr-label">${escHtml(label)}</span><i></i></div>`
    : `<div class="memo-hr"></div>`;
}
function tableHTML(rows) {
  const head = rows.length > 1 && isSepRow(rows[1]) ? rows[0] : null;
  const body = rows.filter((r, i) => !(head && (i === 0 || i === 1)) && !isSepRow(r));
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const cells = (r, tag) => {
    let s = '';
    for (let i = 0; i < width; i++) s += `<${tag}>${escHtml(r[i] || '')}</${tag}>`;
    return s;
  };
  return `<div class="memo-table-wrap"><table class="memo-table">` +
    (head ? `<thead><tr>${cells(head, 'th')}</tr></thead>` : '') +
    `<tbody>${body.map(r => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody>` +
    `</table></div>`;
}
// Turn a memo's raw text into HTML. Everything that isn't a divider or a table
// stays exactly as typed (the paragraph blocks keep their line breaks).
function renderNoteText(raw) {
  const lines = String(raw || '').split('\n');
  let out = '', para = [];
  const flushPara = () => {
    if (para.join('').trim()) out += `<div class="memo-para">${escHtml(para.join('\n'))}</div>`;
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const div = lines[i].match(RE_DIVIDER);
    if (div) { flushPara(); out += dividerHTML(div[1].trim()); continue; }
    if (isTableRow(lines[i])) {
      flushPara();
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(splitTableRow(lines[i++]));
      i--;
      out += tableHTML(rows);
      continue;
    }
    para.push(lines[i]);
  }
  flushPara();
  return out;
}
// Markup stripped back to a single line, for the list row preview.
function plainNoteText(raw) {
  return String(raw || '')
    .split('\n')
    .map(l => {
      const div = l.match(RE_DIVIDER);
      if (div) return div[1].trim();
      if (isTableRow(l)) {
        const cells = splitTableRow(l);
        return isSepRow(cells) ? '' : cells.join(' · ');
      }
      return l;
    })
    .join(' ').replace(/\s+/g, ' ').trim();
}
// Put a memo straight into the notification tray, so a checklist or a note can
// sit where you'll see it without the app open. Tagged per note, so pushing the
// same one again replaces it rather than stacking up.
async function pushNoteToNotification(id) {
  const n = notes.find(x => x.id === id);
  if (!n) return;
  const state = await requestNotifyPermission();
  if (state !== 'granted') {
    showToast(state === 'denied' ? '알림이 차단되어 있어요. 브라우저 설정에서 허용해 주세요.'
                                 : '알림 권한이 필요해요');
    return;
  }
  const body = n.type === 'list'
    ? checkItems(n).map(i => `${i.done ? '☑' : '☐'} ${i.t}`).join('\n') || '항목 없음'
    : plainNoteText(n.text) || '내용 없음';
  const ok = await showNote('memo-' + n.id, n.title || '메모', body.slice(0, 400),
                            { sticky: true, quiet: true });
  showToast(ok ? '알림으로 띄웠어요' : '알림을 띄울 수 없어요');
}
function notePreviewText(n) {
  if (n.type === 'list') {
    const items = checkItems(n);
    return `체크리스트 · ${items.filter(i => i.done).length}/${items.length} 완료`;
  }
  return plainNoteText(n.text).slice(0, 60) || '내용 없음';
}

// Main-screen memo widget. The fab is always in flow (fixed slot); the card is
// an absolute overlay so opening/closing never moves the UI below it.
// Inner HTML of the open card for a given note.
function memoCardInner(n, list) {
  const body = n.type === 'list'
    ? `<div class="memo-checks">${(n.items || []).map((it, i) => it.sep
        ? dividerHTML(it.t)
        : `<label class="memo-check ${it.done ? 'done' : ''}"><input type="checkbox" data-i="${i}" ${it.done ? 'checked' : ''}><span>${escHtml(it.t || '')}</span></label>`
      ).join('') || '<div class="memo-empty">항목 없음</div>'}</div>`
    : `<div class="memo-text">${renderNoteText(n.text) || '<span class="memo-empty">내용 없음</span>'}</div>`;
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
// Horizontal-swipe / tap gestures shared by the small card and the big view.
// A horizontal drag past the threshold navigates (onSwipe); a near-still tap on
// a checklist row toggles it (onToggle); vertical drags scroll normally. Toggles
// go through onToggle rather than the native checkbox, so a swipe that begins on
// an item never accidentally checks it.
function attachNoteGestures(el, opts) {
  let sx = 0, sy = 0, moved = false, checkEl = null, didSwipe = false, inScroller = false;
  el.addEventListener('pointerdown', e => {
    if (opts.onDown) opts.onDown();
    sx = e.clientX; sy = e.clientY; moved = false; didSwipe = false;
    checkEl = e.target.closest('.memo-check, .memo-big-check');
    // A drag that starts inside a table wide enough to scroll is scrolling the
    // table, not flipping to the next memo.
    const sc = e.target.closest('.memo-table-wrap');
    inScroller = !!sc && sc.scrollWidth > sc.clientWidth + 1;
  });
  el.addEventListener('pointermove', e => {
    if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) moved = true;
  });
  el.addEventListener('pointerup', e => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!inScroller && opts.canSwipe && opts.canSwipe() && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      didSwipe = true;
      opts.onSwipe(dx < 0 ? 1 : -1);
      return;
    }
    if (!moved && checkEl) {
      const cb = checkEl.querySelector('input[type=checkbox]');
      if (cb && opts.onToggle) opts.onToggle(+cb.dataset.i);
    }
  });
  // Capture clicks: swallow the one synthesized after a swipe, and stop the
  // native label→checkbox toggle (onToggle drives the state instead).
  el.addEventListener('click', e => {
    if (didSwipe) { e.preventDefault(); e.stopPropagation(); didSwipe = false; return; }
    if (e.target.closest('.memo-check, .memo-big-check')) e.preventDefault();
  }, true);
}

// Flip the small card to the prev/next note — swap contents in place so the
// entrance animation doesn't replay.
function goMemo(d) {
  cancelMemoAutoCollapse();
  const cur = memoOrderedNotes();
  if (cur.length < 2) return;
  memoIndex = (memoIndex + d + cur.length) % cur.length;
  const card = memoWidget.querySelector('.memo-card');
  if (!card) return;
  card.innerHTML = memoCardInner(cur[memoIndex], cur);
  bindMemoCard(card);
}
// Wire up the open card. The controls live inside the card and are re-bound on
// every content swap; the swipe/tap gestures attach once per card element (they
// read the current note dynamically, so they survive content swaps).
function bindMemoCard(card) {
  const cur = memoOrderedNotes();
  const n = cur[memoIndex];
  if (!n) return;
  if ($('memoPrev')) $('memoPrev').addEventListener('click', () => goMemo(-1));
  if ($('memoNext')) $('memoNext').addEventListener('click', () => goMemo(1));
  $('memoBig').addEventListener('click', () => { cancelMemoAutoCollapse(); openMemoBig(n.id); });
  $('memoEdit').addEventListener('click', () => { collapseMemo(); openNoteEditor(n.id); });
  $('memoOpen').addEventListener('click', () => { collapseMemo(); openNotes(); });
  $('memoCollapse').addEventListener('click', collapseMemo);
  if (!card._gesturesBound) {
    card._gesturesBound = true;
    attachNoteGestures(card, {
      onDown: cancelMemoAutoCollapse,
      canSwipe: () => memoOrderedNotes().length > 1,
      onSwipe: goMemo,
      onToggle: i => {
        const note = memoOrderedNotes()[memoIndex];
        if (!toggleNoteItem(note, i)) return;
        memoShowNote(note.id);
      },
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
  bindMemoCard(card);
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
  if (open) bindMemoCard(memoWidget.querySelector('.memo-card'));
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
let memoBigList = [], memoBigIdx = 0;
function openMemoBig(id) {
  memoBigList = memoOrderedNotes();
  if (!memoBigList.length) return;
  memoBigIdx = Math.max(0, memoBigList.findIndex(x => x.id === id));
  renderMemoBig();
  memoBigModal.classList.add('open');
}
function goMemoBig(d) {
  if (memoBigList.length < 2) return;
  memoBigIdx = (memoBigIdx + d + memoBigList.length) % memoBigList.length;
  renderMemoBig();
}
function renderMemoBig() {
  const n = memoBigList[memoBigIdx];
  if (!n) return;
  $('memoBigTitle').textContent = n.title || '메모';
  const body = $('memoBigBody');
  body.innerHTML = n.type === 'list'
    ? `<div class="memo-big-checks">${(n.items || []).map((it, i) => it.sep
        ? dividerHTML(it.t)
        : `<label class="memo-big-check ${it.done ? 'done' : ''}"><input type="checkbox" data-i="${i}" ${it.done ? 'checked' : ''}><span>${escHtml(it.t || '')}</span></label>`
      ).join('') || '<div class="memo-empty">항목 없음</div>'}</div>`
    : (renderNoteText(n.text)
        ? `<div class="memo-big-text">${renderNoteText(n.text)}</div>`
        : '<div class="memo-empty">내용 없음</div>');
  // Prev/next nav (shown only when there's more than one note).
  const nav = $('memoBigNav');
  if (memoBigList.length > 1) {
    nav.style.display = '';
    nav.innerHTML =
      `<button class="memo-mini-btn" id="memoBigPrev" title="이전">${ICONS.chevL}</button>
       <span class="memo-nav-count">${memoBigIdx + 1} / ${memoBigList.length}</span>
       <button class="memo-mini-btn" id="memoBigNext" title="다음">${ICONS.chevR}</button>`;
    $('memoBigPrev').addEventListener('click', () => goMemoBig(-1));
    $('memoBigNext').addEventListener('click', () => goMemoBig(1));
  } else {
    nav.style.display = 'none';
    nav.innerHTML = '';
  }
  // Gestures attach once to the persistent body element; they read the current
  // note dynamically, so they keep working across content swaps.
  if (!body._gesturesBound) {
    body._gesturesBound = true;
    attachNoteGestures(body, {
      canSwipe: () => memoBigList.length > 1,
      onSwipe: goMemoBig,
      onToggle: i => {
        const note = memoBigList[memoBigIdx];
        if (!toggleNoteItem(note, i)) return;
        renderMemoBig();
        memoShowNote(note.id);
      },
    });
  }
}
on('memoBigClose', 'click', () => memoBigModal.classList.remove('open'));
on('memoBigModal', 'click', e => { if (e.target === memoBigModal) memoBigModal.classList.remove('open'); });

// Notes manager
let noteReorderMode = false;  // when on, a drag pad slides in beside each row
let confirmDeleteId = null;   // id of the row showing a delete confirmation
function openNotes() {
  // Always open in the calm default state (no reorder pad, no pending delete).
  noteReorderMode = false;
  confirmDeleteId = null;
  const tg = $('notesReorderToggle');
  if (tg) tg.classList.remove('on');
  renderNotesList();
  notesModal.classList.add('open');
}
function renderNotesList() {
  const list = $('notesList');
  list.classList.toggle('reordering', noteReorderMode);
  if (!notes.length) {
    list.innerHTML = '<div class="notes-empty">아직 메모가 없습니다.<br>위 버튼으로 새 메모를 추가하세요.</div>';
    return;
  }
  const sorted = notes.slice().sort(noteSortCmp);
  list.innerHTML = sorted.map(n => {
    const tail = (confirmDeleteId === n.id)
      ? `<div class="note-row-confirm">
           <span class="note-confirm-q">삭제할까요?</span>
           <button class="note-confirm-yes" data-del="${n.id}">삭제</button>
           <button class="note-confirm-no" data-cancel="${n.id}">취소</button>
         </div>`
      : `<button class="note-row-bell" data-bell="${n.id}" title="알림으로 띄우기">${icoSm('bell')}</button>
         <button class="note-row-del" data-del="${n.id}" title="삭제">${ICONS.trash}</button>`;
    return `<div class="note-row${confirmDeleteId === n.id ? ' confirming' : ''}" data-id="${n.id}" data-pinned="${n.pinned ? '1' : '0'}">
       <button class="note-drag-handle" title="끌어서 순서 변경" tabindex="-1">${ICONS.grip}</button>
       <div class="note-row-body">
         <div class="note-row-title">${n.pinned ? '<span class="note-pin-ic">'+icoSm('pin')+'</span> ' : ''}${n.type === 'list' ? icoSm('check')+' ' : ''}${escHtml(n.title || '메모')}</div>
         <div class="note-row-sub">${escHtml(notePreviewText(n))}</div>
       </div>
       ${tail}
     </div>`;
  }).join('');
  list.querySelectorAll('.note-row').forEach(r => {
    r.addEventListener('click', e => {
      if (e.target.closest('.note-row-del') || e.target.closest('.note-row-bell') ||
          e.target.closest('.note-drag-handle') || e.target.closest('.note-row-confirm')) return;
      if (noteReorderMode) return;                    // reorder mode: a row tap shouldn't open the editor
      if (confirmDeleteId != null) { confirmDeleteId = null; renderNotesList(); return; }  // a stray tap cancels a pending delete
      openNoteEditor(r.dataset.id);
    });
  });
  if (noteReorderMode) enableNoteDrag(list);
  list.querySelectorAll('.note-row-del').forEach(b =>
    b.addEventListener('click', () => { confirmDeleteId = b.dataset.del; renderNotesList(); }));
  list.querySelectorAll('.note-row-bell').forEach(b =>
    b.addEventListener('click', () => pushNoteToNotification(b.dataset.bell)));
  list.querySelectorAll('.note-confirm-yes').forEach(b =>
    b.addEventListener('click', () => {
      const delId = b.dataset.del;
      notes = notes.filter(n => n.id !== delId);
      tombstone(delId);
      confirmDeleteId = null;
      saveNotes(); renderNotesList(); renderMemoWidget();
    }));
  list.querySelectorAll('.note-confirm-no').forEach(b =>
    b.addEventListener('click', () => { confirmDeleteId = null; renderNotesList(); }));
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
  resetNoteDeleteBtn();
  editDraftType = n.type === 'list' ? 'list' : 'text';
  if (editDraftType === 'text') {
    $('noteEditBody').innerHTML =
      `<div class="note-tools">
         <button class="note-tool" type="button" data-ins="hr" title="내용 구분선">${icoSm('hr')}구분선</button>
         <button class="note-tool" type="button" data-ins="hrTitle" title="제목이 붙은 구분선">${icoSm('hr')}제목 구분선</button>
         <button class="note-tool" type="button" id="noteTableBtn" title="표 크기 선택">${icoSm('table')}표</button>
         <button class="note-tool right" type="button" id="notePreviewBtn" title="미리보기">${icoSm('eye')}미리보기</button>
       </div>
       <div class="note-tool-panel" id="noteToolPanel" style="display:none"></div>
       <textarea id="noteTextInput" placeholder="내용">${escHtml(n.text || '')}</textarea>
       <div class="note-preview" id="notePreview" style="display:none"></div>`;
    const ta = $('noteTextInput');
    // ArrowUp at the very start moves focus up to the title.
    ta.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault(); $('noteTitleInput').focus();
      }
    });
    $('noteEditBody').querySelectorAll('.note-tool[data-ins]').forEach(b =>
      b.addEventListener('click', () => { closeTablePicker(); insertNoteSnippet(b.dataset.ins); }));
    $('noteTableBtn').addEventListener('click', openTablePicker);
    $('notePreviewBtn').addEventListener('click', () => { closeTablePicker(); toggleNotePreview(); });
  } else {
    // Item ids are carried through the editor so a row edited here can be
    // matched with the same row edited on another device.
    editDraftItems = (n.items || []).map(i => ({ id: i.id || uid(), t: i.t || '', done: !!i.done, at: i.at || 0, sep: i.sep ? 1 : 0 }));
    if (!editDraftItems.length) editDraftItems.push(newDraftItem());  // start ready to type
    renderEditItems();
  }
  noteEditModal.classList.add('open');
}
// ── Text-memo editing tools ────────────────────────────────────
// Drop a snippet in at the cursor, on its own line, and put the caret where
// the user will want to type next (the divider's title, the first table cell).
const NOTE_SNIPPETS = {
  hr:      { text: '>>\n',      select: null },
  hrTitle: { text: '>> 제목\n', select: '제목' },
};
// Build the markup for a cols × rows table. The first row is a header (with the
// |---| separator under it); the rest are blank cells ready to fill in.
function tableSnippet(cols, rows) {
  const line = cells => '| ' + cells.join(' | ') + ' |\n';
  let out = line(Array.from({ length: cols }, (_, i) => '제목' + (i + 1)));
  out += line(Array.from({ length: cols }, () => '---'));
  for (let r = 0; r < rows; r++) out += line(Array.from({ length: cols }, () => ' '));
  return out;
}
function insertTable(cols, rows) {
  insertSnippetText(tableSnippet(cols, rows), '제목1');
}
function insertNoteSnippet(kind) {
  const snip = NOTE_SNIPPETS[kind];
  if (snip) insertSnippetText(snip.text, snip.select);
}
// Where a new block should go: after the line the caret is on, and — if that
// line is part of a table — after the whole table. Without this, inserting a
// second block while the previous one's placeholder is still selected would
// drop it into the middle of that block and corrupt the markup.
function blockInsertIndex(v, at) {
  // The line text must exclude its newline: isTableRow's `$` won't match past
  // one, so passing the newline in would report every line as "not a table".
  const lineAt    = i => { const n = v.indexOf('\n', i); return v.slice(i, n === -1 ? v.length : n); };
  const nextStart = i => { const n = v.indexOf('\n', i); return n === -1 ? v.length : n + 1; };
  const lineStart = v.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
  let idx = nextStart(lineStart);
  if (isTableRow(lineAt(lineStart))) {
    while (idx < v.length && isTableRow(lineAt(idx))) idx = nextStart(idx);
  }
  return idx;
}
// Drop a block in on its own line; if `select` is given, leave that placeholder
// highlighted so the user can type straight over it.
function insertSnippetText(text, select) {
  const ta = $('noteTextInput');
  if (!ta) return;
  if ($('notePreview') && $('notePreview').style.display !== 'none') toggleNotePreview();
  const v = ta.value;
  const idx = blockInsertIndex(v, Math.max(ta.selectionStart ?? 0, ta.selectionEnd ?? 0));
  const head = v.slice(0, idx), tail = v.slice(idx);
  const lead = (head === '' || head.endsWith('\n')) ? '' : '\n';
  // Consecutive pipe rows read as ONE table, so a new table going in right
  // after an existing one needs a blank line or the two would fuse together.
  const prevLine  = head.replace(/\n$/, '').split('\n').pop() || '';
  const firstLine = text.split('\n')[0];   // isTableRow tests one line, not a block
  const gap = (isTableRow(firstLine) && isTableRow(prevLine)) ? '\n' : '';
  const body = lead + gap + text;
  ta.value = head + body + tail;
  const caret = select ? head.length + body.indexOf(select) : head.length + body.length;
  ta.focus();
  ta.setSelectionRange(caret, caret + (select ? select.length : 0));
  ta.dispatchEvent(new Event('input'));
}

// ── Table size picker ──────────────────────────────────────────
// Hovering/dragging over the grid sizes the table, the way a word processor's
// insert-table control works; the label spells out the chosen 열 × 행.
const TBL_MAX_COLS = 6, TBL_MAX_ROWS = 8;
let tblCols = 2, tblRows = 2;
function tablePickerHTML() {
  let cells = '';
  for (let r = 1; r <= TBL_MAX_ROWS; r++)
    for (let c = 1; c <= TBL_MAX_COLS; c++)
      cells += `<button type="button" class="tp-cell" data-c="${c}" data-r="${r}" tabindex="-1"></button>`;
  return `<div class="table-picker" id="tablePicker">
      <div class="tp-grid" id="tpGrid" style="grid-template-columns:repeat(${TBL_MAX_COLS},1fr)">${cells}</div>
      <div class="tp-foot">
        <span class="tp-label" id="tpLabel">2 × 2</span>
        <button type="button" class="tp-insert" id="tpInsert">넣기</button>
      </div>
    </div>`;
}
function highlightTablePicker(c, r) {
  tblCols = c; tblRows = r;
  $('tpGrid').querySelectorAll('.tp-cell').forEach(el =>
    el.classList.toggle('on', +el.dataset.c <= c && +el.dataset.r <= r));
  $('tpLabel').textContent = `${c} × ${r}`;
}
function bindTablePicker() {
  const pick = $('tablePicker');
  if (!pick) return;
  const grid = $('tpGrid');
  grid.querySelectorAll('.tp-cell').forEach(el => {
    const c = +el.dataset.c, r = +el.dataset.r;
    el.addEventListener('pointerenter', () => highlightTablePicker(c, r));
    el.addEventListener('pointerdown', e => { e.preventDefault(); highlightTablePicker(c, r); });
    el.addEventListener('click', () => { highlightTablePicker(c, r); commitTablePicker(); });
  });
  $('tpInsert').addEventListener('click', commitTablePicker);
  highlightTablePicker(tblCols, tblRows);
}
function commitTablePicker() {
  insertTable(tblCols, tblRows);
  closeTablePicker();
}
function openTablePicker() {
  const wrap = $('noteToolPanel');
  if (!wrap) return;
  if (wrap.dataset.open === 'table') { closeTablePicker(); return; }
  wrap.dataset.open = 'table';
  wrap.innerHTML = tablePickerHTML();
  wrap.style.display = '';
  bindTablePicker();
  const btn = $('noteTableBtn');
  if (btn) btn.classList.add('on');
}
function closeTablePicker() {
  const wrap = $('noteToolPanel');
  if (!wrap) return;
  wrap.dataset.open = '';
  wrap.innerHTML = '';
  wrap.style.display = 'none';
  const btn = $('noteTableBtn');
  if (btn) btn.classList.remove('on');
}
// Flip the editor between the raw text and how it will actually look. The
// textarea stays in the DOM (just hidden) so saving still reads its value.
function toggleNotePreview() {
  const ta = $('noteTextInput'), pv = $('notePreview'), btn = $('notePreviewBtn');
  if (!ta || !pv) return;
  const showing = pv.style.display === 'none';
  if (showing) {
    pv.innerHTML = renderNoteText(ta.value) || '<span class="memo-empty">내용 없음</span>';
    ta.style.display = 'none'; pv.style.display = '';
  } else {
    ta.style.display = ''; pv.style.display = 'none';
    ta.focus();
  }
  btn.classList.toggle('on', showing);
  btn.innerHTML = icoSm('eye') + (showing ? '편집' : '미리보기');
}

function newDraftItem() { return { id: uid(), t: '', done: false, at: 0 }; }
// A checklist can carry divider rows too: same item shape, sep flag set, and
// its text is the divider's optional title.
function newDraftSep()  { return { id: uid(), t: '', done: false, at: 0, sep: 1 }; }
// Only real rows count towards "n/m 완료" — dividers aren't tasks.
const checkItems = n => (n.items || []).filter(i => !i.sep);
function renderEditItems() {
  const body = $('noteEditBody');
  body.innerHTML =
    `<div class="note-items" id="noteItems">` +
    editDraftItems.map((it, i) => it.sep
      ? `<div class="note-item-edit sep" data-i="${i}">
           <button class="note-drag-pad" title="끌어서 순서 변경" tabindex="-1">${icoSm('grip')}</button>
           <span class="note-sep-ic">${icoSm('hr')}</span>
           <input type="text" data-i="${i}" value="${escHtml(it.t)}" placeholder="구분선 제목 (선택)">
           <button class="note-item-del" data-i="${i}">✕</button>
         </div>`
      : `<div class="note-item-edit" data-i="${i}">
           <button class="note-drag-pad" title="끌어서 순서 변경" tabindex="-1">${icoSm('grip')}</button>
           <input type="checkbox" data-i="${i}" ${it.done ? 'checked' : ''}>
           <input type="text" data-i="${i}" value="${escHtml(it.t)}" placeholder="할 일">
           <button class="note-item-del" data-i="${i}">✕</button>
         </div>`).join('') +
    `</div>
     <div class="note-item-actions">
       <button class="note-add-item" id="noteAddItem">+ 항목 추가</button>
       <button class="note-add-item" id="noteAddSep">${icoSm('hr')} 구분선</button>
     </div>`;
  body.querySelectorAll('.note-item-edit input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', () => { editDraftItems[+cb.dataset.i].done = cb.checked; }));
  body.querySelectorAll('.note-item-edit input[type=text]').forEach(tx => {
    tx.addEventListener('input', () => { editDraftItems[+tx.dataset.i].t = tx.value; });
    tx.addEventListener('keydown', e => {
      const i = +tx.dataset.i;
      if (e.key === 'Enter') {
        // Enter adds a new item right below and focuses it.
        e.preventDefault();
        editDraftItems.splice(i + 1, 0, newDraftItem());
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
    editDraftItems.push(newDraftItem());
    renderEditItems();
    const inputs = body.querySelectorAll('.note-item-edit input[type=text]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  $('noteAddSep').addEventListener('click', () => {
    editDraftItems.push(newDraftSep());
    renderEditItems();
    const inputs = body.querySelectorAll('.note-item-edit.sep input[type=text]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  // Rows are draggable straight away — this is already an editing surface, so
  // there's no separate reorder mode to switch into.
  const list = $('noteItems');
  list.querySelectorAll('.note-drag-pad').forEach(h =>
    h.addEventListener('pointerdown', e => {
      const rows = [...list.querySelectorAll('.note-item-edit')];
      beginRowDrag(e, h, '.note-item-edit', rows, list, (from, to) => {
        const [moved] = editDraftItems.splice(from, 1);
        editDraftItems.splice(to, 0, moved);
        renderEditItems();
      });
    }));
}
function saveNoteFromEditor() {
  let n = (editingNoteId != null) ? notes.find(x => x.id === editingNoteId) : null;
  const now = stamp();
  // New notes land at the top of their group; orderAt lets that position sync.
  if (!n) {
    n = { id: uid(), createdAt: now, type: editDraftType, items: [],
          order: minNoteOrder() - 1, orderAt: now, itemsAt: 0, pinAt: 0 };
    notes.push(n);
  }
  n.title = $('noteTitleInput').value.trim();
  n.type  = editDraftType;
  if (editDraftType === 'text') {
    if (n.items && n.items.length) n.itemsAt = now;
    n.text = $('noteTextInput') ? $('noteTextInput').value : '';
    n.items = [];
  } else {
    const kept = editDraftItems.filter(i => i.sep || i.t.trim() !== '' || i.done);
    const prevIds = (n.items || []).map(i => i.id);
    const prev = new Map((n.items || []).map(i => [i.id, i]));
    // Only rows whose text or tick actually changed get a fresh stamp, so
    // re-saving a note doesn't outrank another device's edit to a row we
    // didn't touch.
    n.items = kept.map(i => {
      const p = prev.get(i.id);
      const changed = !p || p.t !== i.t || !!p.done !== !!i.done || !!p.sep !== !!i.sep;
      return { id: i.id, t: i.t, done: !!i.done, sep: i.sep ? 1 : 0, at: changed ? now : (p.at || 0) };
    });
    // itemsAt covers the structure (which rows exist, in what order).
    const sameShape = n.items.length === prevIds.length
                   && n.items.every((i, k) => i.id === prevIds[k]);
    if (!sameShape) n.itemsAt = now;
    n.text = '';
  }
  const wantPinned = $('notePinInput').checked;
  if (wantPinned !== !!n.pinned) {
    n.pinned = wantPinned;
    n.pinnedAt = wantPinned ? now : 0;   // pin order
    n.pinAt = now;                        // pin state's own stamp
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
  resetNoteDeleteBtn();
  noteEditModal.classList.remove('open');
  renderNotesList();
  renderMemoWidget();
}
// The editor's 삭제 button is two-tap: the first tap arms it (and re-labels),
// the second within a few seconds actually deletes — guarding against misfires.
let noteDeleteArmed = false, noteDeleteTimer = null;
function resetNoteDeleteBtn() {
  noteDeleteArmed = false;
  clearTimeout(noteDeleteTimer);
  const b = $('noteDelete');
  if (b) { b.textContent = '삭제'; b.classList.remove('armed'); }
}
function noteDeleteClick() {
  if (!noteDeleteArmed) {
    noteDeleteArmed = true;
    const b = $('noteDelete');
    b.textContent = '한 번 더 누르면 삭제';
    b.classList.add('armed');
    clearTimeout(noteDeleteTimer);
    noteDeleteTimer = setTimeout(resetNoteDeleteBtn, 3000);
    return;
  }
  deleteEditingNote();
}

on('notesBtn', 'click', openNotes);
on('notesClose', 'click', () => notesModal.classList.remove('open'));
on('notesModal', 'click', e => { if (e.target === notesModal) notesModal.classList.remove('open'); });
on('newTextNote', 'click', () => openNoteEditor(null, 'text'));
on('newListNote', 'click', () => openNoteEditor(null, 'list'));
on('noteEditClose', 'click', leaveNoteEditor);
on('noteEditModal', 'click', e => { if (e.target === noteEditModal) leaveNoteEditor(); });
on('noteSave', 'click', saveNoteFromEditor);
on('noteDelete', 'click', noteDeleteClick);
on('notesReorderToggle', 'click', () => {
  noteReorderMode = !noteReorderMode;
  confirmDeleteId = null;
  $('notesReorderToggle').classList.toggle('on', noteReorderMode);
  renderNotesList();
});
// ArrowDown from the title drops into the body (first checklist item / memo text).
on('noteTitleInput', 'keydown', e => {
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
loadTodos();
loadTomb();
loadTimer();
observeBundle(localBundle());   // never issue a stamp older than our own data
applyTheme();
renderSessionChip();
lastSeenStudyDay = studyDayKey(Date.now());

// Catch-up day-end notice: if the app was closed when the day actually ended
// (the common case — checkDayRollover only fires while the app is open, so a
// day that ends overnight otherwise never gets reported), deliver it now, on
// the first open of the new day. Guarded per-device so re-opening later the
// same day doesn't repeat it, and silent on a device's very first run (no
// prior day to report on).
(function catchUpDayEnd() {
  const today = studyDayKey(Date.now());
  let lastNotified = null;
  try { lastNotified = localStorage.getItem(LAST_NOTIFIED_DAY_KEY); } catch (e) {}
  if (lastNotified && lastNotified !== today) {
    swReady.then(() => notifyDayEnd(lastNotified));
  }
  try { localStorage.setItem(LAST_NOTIFIED_DAY_KEY, today); } catch (e) {}
})();

// Roll the pomodoro forward through any phase boundary that passed while the
// page was closed. The roll-forward is derived from the phase's own end time,
// so a device that was closed and one that stayed open land on the same phase.
resumePomo(true);
applyComboMode(study.comboMode === 'pomo' ? 'pomo' : 'study');
reconcileSession();

(function restore() {
  const saved = loadTimer();
  if (!saved) { render(); renderGoals(); renderTodos(); renderDayTicks(); renderGoalFlags(); updateStudyUI(); return; }

  let restoreMsg = '';
  if (goalEpoch) {
    const rem = Math.floor((goalEpoch - Date.now()) / 1000);
    if (rem > 0) {
      restoreMsg = '세션 복원됨 — ' + fmt(rem) + ' 남음';
      startTick();
    } else {
      // Ran out while the app was closed. Stamp the end with the moment it was
      // due so every device agrees on it without a race.
      goalEpoch = null; pausedRemaining = 0;
      restoreMsg = '세션 복원됨 — 타이머가 종료되었습니다';
      save(saved.goalEpoch);
    }
  } else if (pausedRemaining > 0) {
    restoreMsg = '세션 복원됨 — ' + fmt(pausedRemaining) + ' (일시정지 상태)';
  }

  render(); renderGoals(); renderTodos(); renderDayTicks(); renderGoalFlags(); updateStudyUI();
  if (restoreMsg) setTimeout(() => showToast(restoreMsg), 300);
})();

// Memo widget: show expanded on entry (if a memo exists), then auto-collapse.
renderMemoWidget();
if (pinnedOrRecentNote()) {
  memoWidget.classList.add('open');
  renderMemoWidget();
  scheduleMemoAutoCollapse();
}

// Everything is defined and painted — from here a cloud snapshot can be applied
// straight to the live UI.
appReady = true;

// ── Stale-page guard ───────────────────────────────────────────
// A browser will happily serve a cached index.html next to freshly fetched JS.
// The markup then lacks elements the new code binds to, and the app comes up
// with several buttons quietly doing nothing — which is impossible to diagnose
// from the outside. Detect it and say so, with a one-tap fix.
(function checkStalePage() {
  if (!missingEls.length) return;
  console.warn('Stale page: missing elements', missingEls);
  const bar = document.createElement('div');
  bar.className = 'stale-banner';
  bar.innerHTML = '<span>앱이 업데이트되었어요. 새로고침해야 정상 동작합니다.</span>' +
                  '<button id="staleReload">새로고침</button>';
  document.body.appendChild(bar);
  bar.querySelector('#staleReload').addEventListener('click', () => {
    if (typeof fullCacheRefresh === 'function') fullCacheRefresh(true);
    else location.reload();
  });
})();
