// ── Study together: nicknames, groups, shared stats ────────────
// Everything here is additive: signed out, or with the group rules not yet
// deployed, the rest of the app behaves exactly as before and this screen just
// explains what's missing.
//
// Shape in Firestore (see firestore.rules — each doc is written only by the
// person it belongs to, so no member can alter another's numbers):
//   usernames/{nameLower}      { uid, name }
//   groups/{gid}               { name, ownerUid, createdAt }
//   groups/{gid}/members/{uid} { name, joinedAt }
//   groups/{gid}/stats/{uid}   { name, day, todaySec, weekSec, subjects, live, at }
//   invites/{gid}__{toUid}     { gid, gname, fromUid, fromName, toUid, toName, at }
const PROFILE_KEY = 'timer_profile_v1';   // { name } cached for instant display

const friendsModal = $('friendsModal');
let myName = (() => { try { return (JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}).name || ''; } catch (e) { return ''; } })();
let myGroups = [];          // [{ id, name, ownerUid }]
let myInvites = [];         // [{ id, gid, gname, fromName }]
let openGroupId = null;     // group whose detail view is showing
let groupMembers = [];      // [{ uid, name, stats }] for the open group
let groupUnsubs = [];       // live listeners for the open group
let friendsErr = '';        // last permission/network problem, shown inline
let friendsBusy = false;
let statsTimer = null;

const fsReady = () => !!(db && cloudUid);

// ── Profile / nickname ─────────────────────────────────────────
function saveMyName(name) {
  myName = name;
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ name })); } catch (e) {}
}
// Claim a nickname, releasing the previous one. A transaction so two people
// racing for the same name can't both win.
async function claimNickname(raw) {
  const name = (raw || '').trim().slice(0, 16);
  if (!name) throw new Error('닉네임을 입력하세요');
  if (!/^[\w가-힣][\w가-힣 .\-]*$/.test(name)) throw new Error('한글·영문·숫자만 쓸 수 있어요');
  const lower = name.toLowerCase();
  const prev = myName ? myName.toLowerCase() : null;
  await db.runTransaction(async tx => {
    const ref = db.collection('usernames').doc(lower);
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().uid !== cloudUid) throw new Error('이미 사용 중인 닉네임이에요');
    tx.set(ref, { uid: cloudUid, name, at: Date.now() });
    if (prev && prev !== lower) tx.delete(db.collection('usernames').doc(prev));
  });
  saveMyName(name);
  // Carry the new name into the places other people read it from.
  await Promise.all(myGroups.map(g =>
    db.collection('groups').doc(g.id).collection('members').doc(cloudUid)
      .set({ name }, { merge: true }).catch(() => {})));
  publishGroupStats(true);
}
async function loadMyName() {
  if (!fsReady()) return;
  // The username doc is the source of truth; the local copy is just a cache.
  const q = await db.collection('usernames').where('uid', '==', cloudUid).limit(1).get();
  if (!q.empty) saveMyName(q.docs[0].data().name);
}

// ── Groups ─────────────────────────────────────────────────────
// Which groups I'm in is kept in my own doc rather than found with a
// collectionGroup query — that kind of query needs an index created by hand in
// the Firebase console, and it failing is not something a user could diagnose.
// One doc read, no index, and it's mine to write.
function myGroupsRef() { return db.collection('userGroups').doc(cloudUid); }
async function rememberGroup(gid, add) {
  const ref = myGroupsRef();
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const gids = (snap.exists && snap.data().gids) || [];
    const next = add ? Array.from(new Set([...gids, gid])) : gids.filter(g => g !== gid);
    tx.set(ref, { gids: next, at: Date.now() });
  });
}
async function loadMyGroups() {
  if (!fsReady()) { myGroups = []; return; }
  const snap = await myGroupsRef().get();
  const gids = (snap.exists && snap.data().gids) || [];
  const out = [];
  const stale = [];
  for (const gid of gids) {
    try {
      const g = await db.collection('groups').doc(gid).get();
      // A group we can't read any more (deleted, or we were removed) drops off
      // the list instead of erroring on every open.
      if (g.exists) out.push({ id: gid, name: g.data().name, ownerUid: g.data().ownerUid });
      else stale.push(gid);
    } catch (e) { stale.push(gid); }
  }
  if (stale.length) { for (const gid of stale) await rememberGroup(gid, false).catch(() => {}); }
  myGroups = out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
async function createGroup(rawName) {
  const name = (rawName || '').trim().slice(0, 20);
  if (!name) throw new Error('그룹 이름을 입력하세요');
  if (!myName) throw new Error('먼저 닉네임을 정해 주세요');
  const ref = db.collection('groups').doc();
  await ref.set({ name, ownerUid: cloudUid, createdAt: Date.now() });
  await ref.collection('members').doc(cloudUid).set({ uid: cloudUid, name: myName, joinedAt: Date.now() });
  await rememberGroup(ref.id, true);
  await loadMyGroups();
  publishGroupStats(true);
  return ref.id;
}
async function leaveGroup(gid) {
  await db.collection('groups').doc(gid).collection('members').doc(cloudUid).delete();
  await db.collection('groups').doc(gid).collection('stats').doc(cloudUid).delete().catch(() => {});
  await rememberGroup(gid, false);
  if (openGroupId === gid) closeGroupView();
  await loadMyGroups();
}

// ── Invites ────────────────────────────────────────────────────
async function inviteByNickname(gid, rawName) {
  const name = (rawName || '').trim();
  if (!name) throw new Error('닉네임을 입력하세요');
  const snap = await db.collection('usernames').doc(name.toLowerCase()).get();
  if (!snap.exists) throw new Error(`'${name}' 닉네임을 찾을 수 없어요`);
  const toUid = snap.data().uid;
  if (toUid === cloudUid) throw new Error('본인은 초대할 수 없어요');
  const already = await db.collection('groups').doc(gid).collection('members').doc(toUid).get();
  if (already.exists) throw new Error('이미 그룹에 있는 사람이에요');
  const g = myGroups.find(x => x.id === gid);
  await db.collection('invites').doc(gid + '__' + toUid).set({
    gid, gname: (g && g.name) || '그룹', fromUid: cloudUid, fromName: myName,
    toUid, toName: snap.data().name, at: Date.now(),
  });
  return snap.data().name;
}
async function loadMyInvites() {
  if (!fsReady()) { myInvites = []; return; }
  const q = await db.collection('invites').where('toUid', '==', cloudUid).get();
  myInvites = q.docs.map(d => Object.assign({ id: d.id }, d.data()));
}
async function acceptInvite(inv) {
  if (!myName) throw new Error('먼저 닉네임을 정해 주세요');
  await db.collection('groups').doc(inv.gid).collection('members').doc(cloudUid)
    .set({ uid: cloudUid, name: myName, joinedAt: Date.now() });
  await rememberGroup(inv.gid, true);
  await db.collection('invites').doc(inv.id).delete().catch(() => {});
  await Promise.all([loadMyGroups(), loadMyInvites()]);
  publishGroupStats(true);
}
async function declineInvite(inv) {
  await db.collection('invites').doc(inv.id).delete();
  await loadMyInvites();
}

// ── Publishing my numbers ──────────────────────────────────────
// What gets shared, and nothing else: today's and this week's total, the
// per-subject split, and whether the stopwatch is running right now. Session
// names, memos, goals and todos stay private.
function myShareableStats() {
  const day = studyDayKey(Date.now());
  const t = totals();
  const subjects = {};
  const raw = t.sub[day] || {};
  Object.keys(raw).forEach(n => { const v = Math.floor(raw[n] || 0); if (v > 0) subjects[n] = v; });
  let weekSec = 0;
  for (let i = 0; i < 7; i++) weekSec += t.rec[studyDayKeyOffset(i)] || 0;
  const runSid = activeRunSid();
  return {
    name: myName || '이름 없음',
    day,
    todaySec: Math.floor(t.rec[day] || 0),
    weekSec: Math.floor(weekSec),
    subjects,
    live: { on: !!runSid, since: runSid ? activeRunStart() : 0, subj: study.curSubject || '' },
    at: Date.now(),
  };
}
let lastPublished = '';
let publishTimer = null;
function publishGroupStats(force) {
  if (!fsReady() || !myGroups.length) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(async () => {
    const s = myShareableStats();
    // `at` always moves, so compare everything else to avoid pointless writes.
    const sig = stableStr(Object.assign({}, s, { at: 0 }));
    if (!force && sig === lastPublished) return;
    lastPublished = sig;
    await Promise.all(myGroups.map(g =>
      db.collection('groups').doc(g.id).collection('stats').doc(cloudUid).set(s).catch(() => {})));
  }, force ? 0 : 4000);
}
// While the stopwatch runs the shared "today" figure would otherwise go stale;
// refresh it a couple of times a minute rather than on every tick.
function startStatsHeartbeat() {
  clearInterval(statsTimer);
  statsTimer = setInterval(() => { if (fsReady() && myGroups.length) publishGroupStats(false); }, 90000);
}

// ── Live group view ────────────────────────────────────────────
function closeGroupView() {
  groupUnsubs.forEach(u => { try { u(); } catch (e) {} });
  groupUnsubs = [];
  openGroupId = null;
  groupMembers = [];
}
function openGroupView(gid) {
  closeGroupView();
  openGroupId = gid;
  renderFriends();
  const base = db.collection('groups').doc(gid);
  // Two live listeners: who's in the group, and everyone's numbers.
  groupUnsubs.push(base.collection('members').onSnapshot(snap => {
    const names = {};
    snap.forEach(d => names[d.id] = d.data().name || '이름 없음');
    groupMembers = Object.keys(names).map(uid => {
      const prev = groupMembers.find(m => m.uid === uid);
      return { uid, name: names[uid], stats: prev ? prev.stats : null };
    });
    renderFriends();
  }, e => { friendsErr = friendlyErr(e); renderFriends(); }));
  groupUnsubs.push(base.collection('stats').onSnapshot(snap => {
    const by = {};
    snap.forEach(d => by[d.id] = d.data());
    groupMembers.forEach(m => { m.stats = by[m.uid] || m.stats; });
    Object.keys(by).forEach(uid => {
      if (!groupMembers.some(m => m.uid === uid)) return;   // ignore ex-members' leftovers
    });
    renderFriends();
  }, e => { friendsErr = friendlyErr(e); renderFriends(); }));
}
function friendlyErr(e) {
  const code = (e && e.code) || String(e);
  if (/permission-denied/.test(code)) {
    return '권한이 없습니다. Firebase 콘솔에 firestore.rules 를 게시했는지 확인해 주세요.';
  }
  if (/unavailable|network/.test(code)) return '네트워크에 연결할 수 없어요.';
  return code;
}

// ── UI ─────────────────────────────────────────────────────────
function fmtAgo(ms) {
  if (!ms) return '';
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간 전';
  return Math.floor(h / 24) + '일 전';
}
function memberRowHTML(m, rank) {
  const s = m.stats;
  const mine = m.uid === cloudUid;
  const fresh = s && s.day === studyDayKey(Date.now());
  const today = fresh ? (s.todaySec || 0) : 0;
  const live = s && s.live && s.live.on;
  const subj = s ? Object.entries(s.subjects || {}).sort((a, b) => b[1] - a[1]).slice(0, 4) : [];
  return `<div class="fr-row${mine ? ' me' : ''}">
    <span class="fr-rank">${rank}</span>
    <div class="fr-body">
      <div class="fr-top">
        <span class="fr-name">${escHtml(m.name)}${mine ? '<span class="fr-me-tag">나</span>' : ''}</span>
        ${live ? `<span class="fr-live"><span class="fr-live-dot"></span>공부 중${s.live.subj ? ' · ' + escHtml(s.live.subj) : ''}</span>` : ''}
      </div>
      ${subj.length
        ? `<div class="fr-subj">${subj.map(([n, v]) =>
            `<span class="fr-chip">${escHtml(n)} ${fmtHrs(v)}</span>`).join('')}</div>`
        : `<div class="fr-subj empty">${s ? (fresh ? '아직 기록 없음' : '오늘 기록 없음') : '기록을 기다리는 중'}</div>`}
    </div>
    <div class="fr-nums">
      <span class="fr-today">${fmtHrs(today)}</span>
      <span class="fr-week">주 ${s ? fmtHrs(s.weekSec || 0) : '—'}</span>
      ${s && s.at ? `<span class="fr-ago">${fmtAgo(s.at)}</span>` : ''}
    </div>
  </div>`;
}
function renderFriends() {
  const body = $('friendsBody');
  if (!body) return;
  const user = fbAuth && fbAuth.currentUser;
  if (!fbReady || !user) {
    body.innerHTML = '<div class="acct-note">친구와 같이 공부하려면 먼저 <b>계정 / 동기화</b>에서 로그인해 주세요.</div>';
    return;
  }
  const err = friendsErr ? `<div class="fr-err">${escHtml(friendsErr)}</div>` : '';

  // ── group detail ──
  if (openGroupId) {
    const g = myGroups.find(x => x.id === openGroupId);
    const rows = groupMembers.slice().sort((a, b) => {
      const av = (a.stats && a.stats.day === studyDayKey(Date.now())) ? a.stats.todaySec || 0 : 0;
      const bv = (b.stats && b.stats.day === studyDayKey(Date.now())) ? b.stats.todaySec || 0 : 0;
      if (av !== bv) return bv - av;
      return (a.name || '').localeCompare(b.name || '');
    });
    body.innerHTML = `
      ${err}
      <button class="fr-back" id="frBack">${icoSm('chevL')} 그룹 목록</button>
      <div class="fr-group-title">${escHtml((g && g.name) || '그룹')}<span class="fr-count">${groupMembers.length}명</span></div>
      <div class="fr-list">${rows.map((m, i) => memberRowHTML(m, i + 1)).join('') || '<div class="acct-note">멤버가 없습니다.</div>'}</div>
      <div class="modal-field">
        <span class="modal-field-label">닉네임으로 초대</span>
        <div class="subj-add-row">
          <input type="text" class="goal-memo-input" id="frInviteInput" placeholder="친구 닉네임" maxlength="16">
          <button class="modal-confirm" id="frInviteBtn">초대</button>
        </div>
      </div>
      <button class="acct-secondary fr-leave" id="frLeave">그룹 나가기</button>`;
    on('frBack', 'click', () => { closeGroupView(); renderFriends(); });
    on('frLeave', 'click', () => {
      askConfirm('그룹 나가기', `<b>${escHtml((g && g.name) || '그룹')}</b> 에서 나갈까요?<br>` +
        `<span class="confirm-note">내 공부 기록은 그대로 남고, 그룹에서만 보이지 않게 됩니다.</span>`,
        () => guard(() => leaveGroup(openGroupId)).then(renderFriends), { yes: '나가기', danger: true });
    });
    const doInvite = () => {
      const v = $('frInviteInput').value;
      guard(async () => {
        const who = await inviteByNickname(openGroupId, v);
        $('frInviteInput').value = '';
        showToast(`${who} 님에게 초대를 보냈어요`);
      });
    };
    on('frInviteBtn', 'click', doInvite);
    on('frInviteInput', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doInvite(); } });
    return;
  }

  // ── list view ──
  body.innerHTML = `
    ${err}
    <div class="modal-field">
      <span class="modal-field-label">내 닉네임</span>
      <div class="subj-add-row">
        <input type="text" class="goal-memo-input" id="frNameInput" placeholder="예: 민준" maxlength="16" value="${escHtml(myName)}">
        <button class="modal-confirm" id="frNameBtn">${myName ? '변경' : '정하기'}</button>
      </div>
      <div class="fr-hint">친구가 이 이름으로 초대할 수 있어요.</div>
    </div>
    ${myInvites.length ? `
      <div class="modal-field">
        <span class="modal-field-label">받은 초대</span>
        ${myInvites.map(inv => `
          <div class="fr-invite" data-inv="${escHtml(inv.id)}">
            <div class="fr-invite-body">
              <div class="fr-invite-g">${escHtml(inv.gname || '그룹')}</div>
              <div class="fr-invite-from">${escHtml(inv.fromName || '누군가')} 님이 초대했어요</div>
            </div>
            <button class="fr-no" data-decline="${escHtml(inv.id)}">거절</button>
            <button class="fr-yes" data-accept="${escHtml(inv.id)}">수락</button>
          </div>`).join('')}
      </div>` : ''}
    <div class="modal-field">
      <span class="modal-field-label">내 그룹</span>
      ${myGroups.length
        ? `<div class="fr-groups">${myGroups.map(g => `
            <button class="fr-group-row" data-gid="${escHtml(g.id)}">
              <span class="fr-group-name">${escHtml(g.name)}</span>
              ${g.ownerUid === cloudUid ? '<span class="fr-owner">방장</span>' : ''}
              <span class="fr-go">${icoSm('chevR')}</span>
            </button>`).join('')}</div>`
        : '<div class="acct-note">아직 그룹이 없습니다. 아래에서 만들어 친구를 초대해 보세요.</div>'}
    </div>
    <div class="modal-field">
      <span class="modal-field-label">새 그룹</span>
      <div class="subj-add-row">
        <input type="text" class="goal-memo-input" id="frGroupInput" placeholder="예: 3반 스터디" maxlength="20">
        <button class="modal-confirm" id="frGroupBtn">만들기</button>
      </div>
    </div>`;

  on('frNameBtn', 'click', () => guard(async () => {
    await claimNickname($('frNameInput').value);
    showToast('닉네임을 저장했어요');
    renderFriends();
  }));
  on('frGroupBtn', 'click', () => guard(async () => {
    const gid = await createGroup($('frGroupInput').value);
    $('frGroupInput').value = '';
    openGroupView(gid);
  }));
  body.querySelectorAll('[data-gid]').forEach(b =>
    b.addEventListener('click', () => openGroupView(b.dataset.gid)));
  body.querySelectorAll('[data-accept]').forEach(b =>
    b.addEventListener('click', () => guard(async () => {
      await acceptInvite(myInvites.find(i => i.id === b.dataset.accept));
      renderFriends();
    })));
  body.querySelectorAll('[data-decline]').forEach(b =>
    b.addEventListener('click', () => guard(async () => {
      await declineInvite(myInvites.find(i => i.id === b.dataset.decline));
      renderFriends();
    })));
}
// Run an async action, surfacing its message instead of failing silently.
async function guard(fn) {
  if (friendsBusy) return;
  friendsBusy = true;
  friendsErr = '';
  try {
    await fn();
  } catch (e) {
    friendsErr = (e && e.message) ? e.message : friendlyErr(e);
    renderFriends();
  } finally {
    friendsBusy = false;
  }
}

async function openFriends() {
  friendsErr = '';
  closeGroupView();
  renderFriends();
  friendsModal.classList.add('open');
  if (!fsReady()) return;
  await guard(async () => {
    await loadMyName();
    await Promise.all([loadMyGroups(), loadMyInvites()]);
  });
  renderFriends();
  publishGroupStats(true);
}
on('friendsBtn', 'click', openFriends);
on('friendsClose', 'click', () => { closeGroupView(); friendsModal.classList.remove('open'); });
on('friendsModal', 'click', e => {
  if (e.target === friendsModal) { closeGroupView(); friendsModal.classList.remove('open'); }
});

// Keep the badge on the header button in step with pending invites.
function renderFriendsBadge() {
  const b = $('friendsBtn');
  if (b) b.classList.toggle('has-invite', myInvites.length > 0);
}
// Sign-in state is owned by sync.js; this just piggybacks on the same auth.
if (fbReady && fbAuth) {
  fbAuth.onAuthStateChanged(async user => {
    myGroups = []; myInvites = []; closeGroupView();
    if (!user) { renderFriendsBadge(); renderFriends(); return; }
    try {
      await loadMyName();
      await Promise.all([loadMyGroups(), loadMyInvites()]);
      renderFriendsBadge();
      if (isModalOpen('friendsModal')) renderFriends();
      publishGroupStats(true);
      startStatsHeartbeat();
    } catch (e) { friendsErr = friendlyErr(e); }
  });
}
