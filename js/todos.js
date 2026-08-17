// ── Session todo list ──────────────────────────────────────────
// Sits under the goal list in the side panel and takes over the space when the
// goals are folded away. Todos belong to a session, the same as goals and the
// countdown above them, so switching sessions swaps the list.
const todosSection = $('todosSection');
let todoAdding = false;      // the inline "new todo" field is open
let todoDraft  = '';         // survives a re-render while typing

function renderTodos() {
  if (!todosSection) return;
  const list = sessionTodos();
  const doneCount = list.filter(t => t.done).length;

  const rows = list.map(t => `
    <div class="todo-row${t.done ? ' done' : ''}" data-tid="${escHtml(t.id)}">
      <button class="todo-check" data-toggle="${escHtml(t.id)}" aria-label="완료">
        <span class="todo-box">${t.done ? ICONS.tick : ''}</span>
      </button>
      <span class="todo-text">${escHtml(t.t)}</span>
      <button class="todo-del" data-del="${escHtml(t.id)}" title="삭제">✕</button>
    </div>`).join('');

  todosSection.innerHTML = `
    <div class="todo-head">
      <span class="todo-title">할 일</span>
      ${list.length ? `<span class="todo-count${doneCount === list.length ? ' all' : ''}">${doneCount}/${list.length}</span>` : ''}
      ${doneCount ? `<button class="todo-clear" id="todoClear">완료 지우기</button>` : ''}
      <button class="todo-add-btn" id="todoAddBtn" title="할 일 추가">${icoSm('plus')}</button>
    </div>
    <div class="todo-list">
      ${rows || (todoAdding ? '' : '<div class="todo-empty">+ 를 눌러 할 일을 추가하세요</div>')}
      ${todoAdding ? `<div class="todo-row adding">
          <span class="todo-box ghost"></span>
          <input type="text" class="todo-input" id="todoInput" placeholder="할 일 입력 후 Enter"
                 maxlength="80" value="${escHtml(todoDraft)}">
          <button class="todo-del" id="todoAddCancel" title="닫기">✕</button>
        </div>` : ''}
    </div>`;

  const addBtn = $('todoAddBtn');
  if (addBtn) addBtn.addEventListener('click', () => {
    todoAdding = !todoAdding; todoDraft = '';
    renderTodos();
    if (todoAdding && $('todoInput')) $('todoInput').focus();
  });
  const clear = $('todoClear');
  if (clear) clear.addEventListener('click', clearDoneTodos);

  todosSection.querySelectorAll('[data-toggle]').forEach(b =>
    b.addEventListener('click', () => toggleTodo(b.dataset.toggle)));
  todosSection.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => removeTodo(b.dataset.del)));
  // Tapping the label toggles too — the checkbox alone is a small target.
  todosSection.querySelectorAll('.todo-text').forEach(el =>
    el.addEventListener('click', () => toggleTodo(el.closest('.todo-row').dataset.tid)));

  const input = $('todoInput');
  if (input) {
    input.addEventListener('input', () => { todoDraft = input.value; });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Keep the field open so a list can be typed straight through.
        if (addTodo(input.value)) { todoDraft = ''; renderTodos(); $('todoInput').focus(); }
      } else if (e.key === 'Escape') {
        todoAdding = false; todoDraft = ''; renderTodos();
      }
    });
    input.addEventListener('blur', () => {
      // Leaving an empty field closes it; text is kept and committed.
      if (input.value.trim()) { addTodo(input.value); todoDraft = ''; }
      todoAdding = false;
      setTimeout(renderTodos, 0);
    });
  }
}

function addTodo(text) {
  const t = (text || '').trim().slice(0, 80);
  if (!t) return false;
  const mine = sessionTodos();
  const maxOrd = mine.reduce((m, x) => Math.max(m, Number.isFinite(x.order) ? x.order : -1), -1);
  const now = stamp();
  todos.push({ id: uid(), sid: curSessionId(), t, done: false,
               at: now, doneAt: 0, order: maxOrd + 1, orderAt: now });
  saveTodos();
  flushSyncSoon();
  return true;
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
