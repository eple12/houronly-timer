// ── Session todo list ──────────────────────────────────────────
// Sits above the goal list in the side panel; both fold away, and whichever
// stays open takes the freed space. Todos belong to a session, the same as
// goals and the countdown, so switching sessions swaps the list.
const todosSection = $('todosSection');
let todoAdding = false;      // the inline "new todo" field is open
let todoDraft  = '';         // survives a re-render while typing
let todoCommitting = false;  // guards the blur that a re-render triggers
let todoEditingId = null;    // row being renamed inline
let todoEditDraft = '';      // its text, kept here so a sync re-render can't lose it
let todoReorderMode = false; // when on, undone rows grow a drag pad
let todosFolded = (() => { try { return localStorage.getItem(TODOS_FOLD_KEY) === '1'; } catch (e) { return false; } })();

function setTodosFolded(v) {
  todosFolded = !!v;
  try { localStorage.setItem(TODOS_FOLD_KEY, todosFolded ? '1' : '0'); } catch (e) {}
  if (todosFolded) { todoReorderMode = false; todoAdding = false; }
  renderTodos();
}

function renderTodos() {
  if (!todosSection) return;
  const list = sessionTodos();
  const doneCount = list.filter(t => t.done).length;
  const openCount = list.length - doneCount;
  if (list.length < 2) todoReorderMode = false;

  const rows = list.map(t => {
    const editing = todoEditingId === t.id;
    return `
    <div class="todo-row${t.done ? ' done' : ''}${editing ? ' editing' : ''}" data-tid="${escHtml(t.id)}" data-done="${t.done ? '1' : '0'}">
      ${!t.done && !editing ? `<button class="todo-drag-handle" title="끌어서 순서 변경" tabindex="-1">${icoSm('grip')}</button>` : ''}
      <button class="todo-check" data-toggle="${escHtml(t.id)}" aria-label="완료">
        <span class="todo-box">${t.done ? ICONS.tick : ''}</span>
      </button>
      ${editing
        ? `<input type="text" class="todo-input" id="todoEditInput" maxlength="80" value="${escHtml(todoEditDraft)}">`
        : `<span class="todo-text">${escHtml(t.t)}</span>
           <button class="todo-edit" data-edit="${escHtml(t.id)}" title="수정">${icoSm('pencil')}</button>`}
      <button class="todo-del" data-del="${escHtml(t.id)}" title="삭제">✕</button>
    </div>`;
  }).join('');

  todosSection.innerHTML = `
    <div class="list-head">
      <button class="list-fold${todosFolded ? ' folded' : ''}" id="todosFold"
              title="${todosFolded ? '펼치기' : '접기'}">
        ${icoSm('chevD')}<span>할 일</span>
        ${list.length ? `<span class="list-count${doneCount === list.length ? ' all' : ''}">${doneCount}/${list.length}</span>` : ''}
      </button>
      ${!todosFolded && doneCount ? `<button class="todo-clear" id="todoClear">완료 지우기</button>` : ''}
      ${!todosFolded && openCount > 1
        ? `<button class="list-reorder-toggle${todoReorderMode ? ' on' : ''}" id="todoReorder" title="순서 변경">${icoSm('grip')}</button>`
        : ''}
      <button class="todo-add-btn" id="todoAddBtn" title="할 일 추가">${icoSm('plus')}</button>
    </div>
    <div class="todo-list${todoReorderMode ? ' reordering' : ''}${todosFolded ? ' folded' : ''}" id="todoList">
      ${rows || (todoAdding ? '' : '<div class="todo-empty">+ 를 눌러 할 일을 추가하세요</div>')}
      ${todoAdding ? `<div class="todo-row adding">
          <span class="todo-box ghost"></span>
          <input type="text" class="todo-input" id="todoInput" placeholder="할 일 입력 후 Enter"
                 maxlength="80" value="${escHtml(todoDraft)}">
          <button class="todo-del" id="todoAddCancel" title="닫기">✕</button>
        </div>` : ''}
    </div>`;

  const fold = $('todosFold');
  if (fold) fold.addEventListener('click', () => setTodosFolded(!todosFolded));
  const addBtn = $('todoAddBtn');
  if (addBtn) addBtn.addEventListener('click', () => {
    if (todosFolded) setTodosFolded(false);      // adding into a folded list would hide the result
    todoAdding = !todoAdding; todoDraft = '';
    renderTodos();
    const inp = $('todoInput');
    if (inp) inp.focus();
  });
  if (todosFolded) return;

  const clear = $('todoClear');
  if (clear) clear.addEventListener('click', clearDoneTodos);
  const reorder = $('todoReorder');
  if (reorder) reorder.addEventListener('click', () => { todoReorderMode = !todoReorderMode; renderTodos(); });

  todosSection.querySelectorAll('[data-toggle]').forEach(b =>
    b.addEventListener('click', () => toggleTodo(b.dataset.toggle)));
  todosSection.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => removeTodo(b.dataset.del)));
  todosSection.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => startEditTodo(b.dataset.edit)));
  // Tapping the label toggles too — the checkbox alone is a small target.
  todosSection.querySelectorAll('.todo-text').forEach(el =>
    el.addEventListener('click', () => {
      if (todoReorderMode) return;
      toggleTodo(el.closest('.todo-row').dataset.tid);
    }));

  // Inline rename. Same shape as the add field: the commit re-renders, which
  // detaches this input and fires blur, so the guard stops it committing twice.
  const edit = $('todoEditInput');
  if (edit) {
    edit.addEventListener('input', () => { todoEditDraft = edit.value; });
    edit.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitEditTodo(); }
      else if (e.key === 'Escape') { cancelEditTodo(); }
    });
    edit.addEventListener('blur', () => { if (!todoCommitting) commitEditTodo(); });
    // Re-focus after a re-render (a sync landing mid-edit repaints the list).
    if (document.activeElement !== edit) {
      edit.focus();
      edit.setSelectionRange(edit.value.length, edit.value.length);
    }
  }
  if (todoReorderMode) {
    todosSection.querySelectorAll('.todo-drag-handle').forEach(h =>
      h.addEventListener('pointerdown', e => beginTodoDrag(e, h)));
  }

  const input = $('todoInput');
  if (input) {
    input.addEventListener('input', () => { todoDraft = input.value; });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitTodoInput(input, true); }
      else if (e.key === 'Escape') { todoAdding = false; todoDraft = ''; renderTodos(); }
    });
    // Leaving the field commits what's in it and closes. Re-rendering detaches
    // this input, which fires blur on the way out — todoCommitting keeps that
    // from adding the same text a second time.
    input.addEventListener('blur', () => {
      if (todoCommitting) return;
      commitTodoInput(input, false);
    });
  }
  const cancel = $('todoAddCancel');
  if (cancel) cancel.addEventListener('mousedown', e => {
    e.preventDefault();                       // don't blur-commit before we close
    todoAdding = false; todoDraft = ''; renderTodos();
  });
}

// `keepOpen` is Enter: add and leave a fresh field focused so a list can be
// typed straight through. Otherwise (blur) add and close.
function commitTodoInput(input, keepOpen) {
  const text = input.value;
  todoCommitting = true;
  input.value = '';                 // belt and braces: nothing left for blur to re-add
  todoDraft = '';
  const added = addTodo(text);
  if (!keepOpen) todoAdding = false;
  if (keepOpen && !added) { todoCommitting = false; return; }   // empty Enter: no-op
  renderTodos();
  todoCommitting = false;
  if (keepOpen) { const next = $('todoInput'); if (next) next.focus(); }
}

function addTodo(text) {
  const t = (text || '').trim().slice(0, 80);
  if (!t) return false;
  const maxOrd = sessionTodos().reduce((m, x) => Math.max(m, Number.isFinite(x.order) ? x.order : -1), -1);
  const now = stamp();
  todos.push({ id: uid(), sid: curSessionId(), t, done: false,
               at: now, doneAt: 0, order: maxOrd + 1, orderAt: now });
  saveTodos();
  flushSyncSoon();
  return true;
}
function startEditTodo(id) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  todoAdding = false;            // one field at a time
  todoReorderMode = false;
  todoEditingId = id;
  todoEditDraft = t.t || '';
  renderTodos();
}
function cancelEditTodo() {
  todoCommitting = true;         // the re-render's blur must not commit
  todoEditingId = null; todoEditDraft = '';
  renderTodos();
  todoCommitting = false;
}
function commitEditTodo() {
  const id = todoEditingId;
  if (!id) return;
  const t = todos.find(x => x.id === id);
  const text = (todoEditDraft || '').trim().slice(0, 80);
  todoCommitting = true;
  todoEditingId = null; todoEditDraft = '';
  // Emptying the field is treated as "leave it alone", not as a delete — that's
  // what the ✕ is for.
  if (t && text && text !== t.t) {
    t.t = text;
    t.at = stamp();              // its own stamp, so a peer's tick still stands
    saveTodos();
    flushSyncSoon();
  }
  renderTodos();
  todoCommitting = false;
}
function toggleTodo(id) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = stamp();      // its own stamp: ticking never overwrites a rename
  saveTodos();
  renderTodos();
  flushSyncSoon();
}
function removeTodo(id) {
  todos = todos.filter(t => t.id !== id);
  tombstone(id);
  saveTodos();
  renderTodos();
  flushSyncSoon();
}
function clearDoneTodos() {
  const done = sessionTodos().filter(t => t.done);
  if (!done.length) return;
  askConfirm('완료한 할 일 지우기',
    `완료한 <b>${done.length}개</b>를 목록에서 지울까요?`,
    () => {
      const ids = new Set(done.map(t => t.id));
      todos = todos.filter(t => !ids.has(t.id));
      ids.forEach(tombstone);
      saveTodos();
      renderTodos();
      flushSyncSoon();
    },
    { yes: '지우기', danger: true });
}

// Only the unfinished rows are draggable — ticked ones sit at the bottom by
// rule, so letting one be dragged above them would just snap back.
function beginTodoDrag(e, handle) {
  const list = $('todoList');
  const rows = [...list.querySelectorAll('.todo-row[data-done="0"]')];
  beginRowDrag(e, handle, '.todo-row', rows, list, (fromIdx, toIdx) => {
    const open = sessionTodos().filter(t => !t.done);
    const [moved] = open.splice(fromIdx, 1);
    open.splice(toIdx, 0, moved);
    const now = stamp();
    open.forEach((t, i) => { t.order = i; t.orderAt = now; });
    saveTodos();
    renderTodos();
    flushSyncSoon();
  });
}
