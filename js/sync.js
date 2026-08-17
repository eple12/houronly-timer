// ── Account sync (Firebase, optional) ─────────────────────────
// To enable: create a Firebase project, enable Authentication →
// Google sign-in, create a Firestore database, then paste your web
// app config below. Firestore rule (per-user access):
//   match /users/{uid} { allow read, write: if request.auth.uid == uid; }
//
// How the sync stays consistent across devices:
//
//  • Uploads are a TRANSACTION, not an overwrite. Every push re-reads the
//    cloud document inside the transaction and writes merge(cloud, local), so
//    a change another device made a moment earlier can never be clobbered.
//    (The old blind set() lost exactly those writes.)
//  • Every merge is symmetric, idempotent and order-independent — see the
//    header of js/model.js — so it doesn't matter who merges what when, and
//    receiving our own echo back is a no-op.
//  • Nothing merges by "whichever device wrote last": study time comes from a
//    ledger, and each individual setting/flag carries its own timestamp.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBXiXFrwbR5QAv741MibNUFGD-fVu1NlHQ",
  authDomain: "houronly-timer.firebaseapp.com",
  projectId: "houronly-timer",
  storageBucket: "houronly-timer.firebasestorage.app",
  messagingSenderId: "680066324066",
  appId: "1:680066324066:web:a28d618323cde9c7f9233b",
  measurementId: "G-GDN5TL9DCR"
};
const META_KEY   = 'timer_sync_meta_v1';
const PUSH_DELAY = 1200;      // settle time after the last change
const TOMB_TTL   = 400 * 86400000;  // forget deletions after this long

let fbAuth = null, db = null, cloudUid = null, cloudUnsub = null;
let syncReady = false, pushTimer = null, pushInFlight = false, pushQueued = false;
let pushRetry = 0, retryTimer = null;
let applying = false;   // true while a merged bundle is being written locally
let appReady = false;   // set once every script has run (see the end of notes.js)
let syncStatus = '';    // human-readable status shown in the account sheet
let syncError  = '';    // last error code, if any

function setSyncStatus(s, err) {
  syncStatus = s || '';
  syncError  = err || '';
  renderAcct();
}

const fbReady = !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId
                   && window.firebase);

function syncMeta() { try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch(e) { return {}; } }
function setMeta(v) { try { localStorage.setItem(META_KEY, JSON.stringify({ updatedAt: v })); } catch(e) {} }
// Called by every local save. While a merged bundle is being applied we're
// writing data that already came from the cloud, so don't treat it as a change.
function syncTouch() {
  if (applying) return;
  setMeta(Date.now());
  if (cloudUid && syncReady) schedulePush();
}
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushCloud, PUSH_DELAY);
}
// For discrete actions (stopwatch start/stop, pomodoro control) where waiting
// out the debounce would leave the other device visibly behind.
function flushSyncSoon() {
  if (!cloudUid || !syncReady) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushCloud, 150);
}

// ── Bundle ─────────────────────────────────────────────────────
function localBundle() {
  // The live globals are the active session's copy — fold them in so an
  // in-flight edit is never a step behind the map.
  const t = Object.assign({}, timers, { [curSessionId()]: timerState() });
  return { timer: t, goals, study, notes, tomb };
}
function writeBundle(b) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(normalizeTimers(b.timer)));
    localStorage.setItem(GOALS_KEY, JSON.stringify(b.goals || []));
    localStorage.setItem(STUDY_KEY, JSON.stringify(b.study || {}));
    localStorage.setItem(NOTES_KEY, JSON.stringify(b.notes || []));
    localStorage.setItem(TOMB_KEY,  JSON.stringify(b.tomb  || {}));
  } catch(e) {}
}
function bundleSig(b) {
  return stableStr([b.timer || null, b.goals || [], b.study || {}, b.notes || [], b.tomb || {}]);
}

// ── Merges ─────────────────────────────────────────────────────
// Each of these is symmetric: merge(a,b) and merge(b,a) produce the same
// document, and merging an already-merged value again changes nothing.

// Tombstones: latest deletion time per id wins; very old ones are forgotten so
// the map can't grow forever.
function mergeTomb(a, b) {
  const o = {}, cut = Date.now() - TOMB_TTL;
  [a || {}, b || {}].forEach(src => {
    for (const k in src) if (src[k] > cut && (!(k in o) || src[k] > o[k])) o[k] = src[k];
  });
  return o;
}

// One session's countdown: one stamp for the timer state, one for the
// emergency flag, so pausing here can't undo an emergency toggle there.
function mergeTimer(a, b) {
  if (!a || !a.at) return b && b.at ? b : (a || b || null);
  if (!b || !b.at) return a;
  const base = newerBy(a, b, 'at');
  const emg  = newerBy(a, b, 'emgAt');
  return Object.assign({}, base, { emergency: !!emg.emergency, emgAt: emg.emgAt || 0 });
}
// Every session's countdown, resolved independently — starting a timer in one
// session never disturbs another session's clock.
function mergeTimers(a, b) {
  const out = {};
  new Set([...Object.keys(a || {}), ...Object.keys(b || {})]).forEach(sid => {
    const m = mergeTimer((a || {})[sid], (b || {})[sid]);
    if (m) out[sid] = m;
  });
  return out;
}

// Goals: union by id, newest version of each, minus anything deleted.
function mergeGoals(a, b, tmb) {
  const m = new Map();
  [...(a || []), ...(b || [])].forEach(g => {
    if (!g || g.id == null) return;
    const id = String(g.id);
    const prev = m.get(id);
    m.set(id, prev ? newerBy(prev, g, 'at') : g);
  });
  return [...m.values()]
    .filter(g => !(g.id in (tmb || {})))
    .sort((x, y) => (x.at || 0) - (y.at || 0));
}

// Notes: each independent part of a note resolves on its own stamp, so two
// devices editing two different things about the same note both win.
function mergeNote(a, b) {
  const base  = newerBy(a, b, 'updatedAt');           // title / text / type
  const pin   = newerBy(a, b, 'pinAt');               // pinned state
  const ord   = newerBy(a, b, 'orderAt');             // position in the list
  const items = newerBy(a, b, 'itemsAt');             // which items exist, in what order
  const other = items === a ? b : a;

  const n = Object.assign({}, base);
  n.pinned   = !!pin.pinned;
  n.pinnedAt = pin.pinnedAt || 0;
  n.pinAt    = pin.pinAt || 0;
  n.order    = ord.order;
  n.orderAt  = ord.orderAt || 0;
  // Checklist rows: membership/order from the side that last changed the
  // structure, but each row's own text/tick from whichever side touched it
  // last — so ticking item 3 here while item 1 is renamed there keeps both.
  const om = new Map((other.items || []).map(i => [i.id, i]));
  n.items = (items.items || []).map(i => {
    const j = om.get(i.id);
    return (j && (j.at || 0) > (i.at || 0)) ? j : i;
  });
  n.itemsAt   = Math.max(a.itemsAt || 0, b.itemsAt || 0);
  n.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  n.createdAt = Math.min(a.createdAt || 0, b.createdAt || 0) || (a.createdAt || b.createdAt || 0);
  return n;
}
function mergeNotes(a, b, tmb) {
  const m = new Map();
  [...(a || []), ...(b || [])].forEach(n => {
    if (!n || n.id == null) return;
    const id = String(n.id);
    const prev = m.get(id);
    m.set(id, prev ? mergeNote(prev, n) : n);
  });
  tmb = tmb || {};
  // A deletion sticks unless the note was edited after it was deleted.
  return [...m.values()].filter(n => {
    const d = tmb[n.id];
    if (!d) return true;
    const touched = Math.max(n.updatedAt || 0, n.pinAt || 0, n.orderAt || 0, n.itemsAt || 0);
    return touched > d;
  });
}

// Newest-per-key map merge (used for the per-field setting stamps).
function mergeStampMap(a, b) {
  const o = {};
  new Set([...Object.keys(a || {}), ...Object.keys(b || {})]).forEach(k => {
    o[k] = Math.max((a || {})[k] || 0, (b || {})[k] || 0);
  });
  return o;
}
// Frozen pre-ledger totals: a manual correction wins by its own stamp,
// otherwise take the larger value (neither device may lose recorded time).
function mergeLegacyLayer(av, aAt, bv, bAt) {
  const val = {}, at = {};
  const days = new Set([...Object.keys(av || {}), ...Object.keys(bv || {})]);
  days.forEach(d => {
    const x = (av || {})[d] || 0, y = (bv || {})[d] || 0;
    const xa = (aAt || {})[d] || 0, ya = (bAt || {})[d] || 0;
    val[d] = xa !== ya ? (xa > ya ? x : y) : Math.max(x, y);
    if (xa || ya) at[d] = Math.max(xa, ya);
  });
  return { val, at };
}

function mergeStudy(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { v: DOC_VERSION };

  // Settings: strictly per field, so changing the theme here can't roll back
  // the daily goal set over there.
  const aAt = a.settingsAt || {}, bAt = b.settingsAt || {};
  out.settingsAt = mergeStampMap(aAt, bAt);
  SETTING_FIELDS.forEach(f => {
    const x = aAt[f] || 0, y = bAt[f] || 0;
    if (x === y) out[f] = stableStr(a[f]) >= stableStr(b[f]) ? a[f] : b[f];
    else         out[f] = x > y ? a[f] : b[f];
    if (out[f] === undefined) out[f] = a[f] !== undefined ? a[f] : b[f];
  });

  // Subject registry: one LWW record per subject, so a deletion propagates
  // instead of being resurrected by a peer's stale list.
  out.subj = {};
  new Set([...Object.keys(a.subj || {}), ...Object.keys(b.subj || {})]).forEach(n => {
    const x = (a.subj || {})[n], y = (b.subj || {})[n];
    out.subj[n] = (x && y) ? newerBy(x, y, 'at') : (x || y);
  });
  // Session registry: same one-record-per-session rule, so renaming on one
  // device and deleting on another resolve without resurrecting anything.
  out.sess = {};
  new Set([...Object.keys(a.sess || {}), ...Object.keys(b.sess || {})]).forEach(id => {
    const x = (a.sess || {})[id], y = (b.sess || {})[id];
    out.sess[id] = (x && y) ? newerBy(x, y, 'at') : (x || y);
  });

  // Watermark first: anything older than it is already frozen into `legacy`,
  // so re-adding it from a peer that hasn't compacted yet would double-count.
  out.foldBefore = Math.max(a.foldBefore || 0, b.foldBefore || 0);

  // The ledger: union of runs. A run is immutable except for its end, so the
  // only thing to resolve is which side saw the stop.
  out.runs = {};
  new Set([...Object.keys(a.runs || {}), ...Object.keys(b.runs || {})]).forEach(id => {
    const x = (a.runs || {})[id], y = (b.runs || {})[id];
    const r = (x && y) ? newerBy(x, y, 'at') : (x || y);
    if (r && (r.e == null || r.e >= out.foldBefore)) out.runs[id] = r;
  });
  // Manual ±corrections: immutable entries, so a union keeps every one of them.
  out.adj = {};
  [a.adj || {}, b.adj || {}].forEach(src => {
    for (const id in src) if ((src[id].at || 0) >= out.foldBefore) out.adj[id] = src[id];
  });

  // Frozen totals from before the ledger existed.
  out.legacy = {};
  const rec = mergeLegacyLayer(a.legacy?.rec, a.legacy?.recAt, b.legacy?.rec, b.legacy?.recAt);
  out.legacy.rec = rec.val; out.legacy.recAt = rec.at;
  out.legacy.subj = {}; out.legacy.subjAt = {};
  new Set([...Object.keys(a.legacy?.subj || {}), ...Object.keys(b.legacy?.subj || {})]).forEach(day => {
    const l = mergeLegacyLayer(a.legacy?.subj?.[day], a.legacy?.subjAt?.[day],
                               b.legacy?.subj?.[day], b.legacy?.subjAt?.[day]);
    out.legacy.subj[day] = l.val;
    if (Object.keys(l.at).length) out.legacy.subjAt[day] = l.at;
  });
  // Session split of compacted days (max per session per day, like the totals).
  out.legacy.sess = {};
  new Set([...Object.keys(a.legacy?.sess || {}), ...Object.keys(b.legacy?.sess || {})]).forEach(day => {
    const x = a.legacy?.sess?.[day] || {}, y = b.legacy?.sess?.[day] || {}, m = {};
    new Set([...Object.keys(x), ...Object.keys(y)]).forEach(sid => m[sid] = Math.max(x[sid] || 0, y[sid] || 0));
    out.legacy.sess[day] = m;
  });

  // Distraction counters: each device owns its own key, so max per key is
  // exact and summing them can't lose a concurrent increment.
  out.dist = {};
  new Set([...Object.keys(a.dist || {}), ...Object.keys(b.dist || {})]).forEach(day => {
    const x = (a.dist || {})[day] || {}, y = (b.dist || {})[day] || {}, m = {};
    new Set([...Object.keys(x), ...Object.keys(y)]).forEach(k => m[k] = Math.max(x[k] || 0, y[k] || 0));
    out.dist[day] = m;
  });

  out.pomoRun = newerBy(a.pomoRun || {}, b.pomoRun || {}, 'at');
  return out;
}

// A document straight out of Firestore has no stamps on the parts that gained
// them, and (right after an upgrade) may still be in the pre-ledger shape.
// Bring it up to the current schema before merging so both sides are comparable.
function normalizeRemote(remote) {
  if (!remote) return null;
  // Any document from the ledger era (v2 and up) upgrades cleanly and must be
  // merged in full — dropping it would throw away whatever the other device
  // recorded. Only a genuinely PRE-ledger document is risky: its day totals
  // describe the same hours our runs already hold, so adding both would count
  // them twice. That one we skip once this device has a ledger of its own.
  let rStudy = null;
  if (remote.study) {
    const preLedger = !(remote.study.v >= 2);
    const localHasLedger = Object.keys(study.runs || {}).length > 0
                        || Object.keys(study.adj  || {}).length > 0;
    if (!preLedger || !localHasLedger) rStudy = normalizeStudyDoc(remote.study, false);
  }
  return {
    timer: normalizeTimers(remote.timer),
    goals: (remote.goals || []).filter(g => g && g.id != null).map(normalizeGoal),
    study: rStudy,
    notes: (remote.notes || []).filter(n => n && n.id != null).map(normalizeNote),
    tomb:  remote.tomb || {},
  };
}
function mergeBundle(local, remote) {
  if (!remote) return local;
  const tmb = mergeTomb(local.tomb, remote.tomb);
  const merged = {
    timer: mergeTimers(local.timer, remote.timer),
    goals: mergeGoals(local.goals, remote.goals, tmb),
    study: mergeStudy(local.study, remote.study),
    notes: mergeNotes(local.notes, remote.notes, tmb),
    tomb:  tmb,
  };
  // Anything we do from now on must outrank everything we just learned about,
  // whatever this device's clock happens to say.
  observeBundle(merged);
  return merged;
}

// ── Upload ─────────────────────────────────────────────────────
// A transaction, so the write is always merge(whatever-is-there-now, ours).
// Two devices pushing at the same moment can't drop each other's changes: the
// loser of the race retries against the winner's document.
function pushCloud() {
  clearTimeout(pushTimer); pushTimer = null;
  if (!cloudUid || !syncReady || !db) return Promise.resolve();
  if (pushInFlight) { pushQueued = true; return Promise.resolve(); }
  pushInFlight = true;

  const ref = db.collection('users').doc(cloudUid);
  let merged = null;
  const tx$ = db.runTransaction(tx => tx.get(ref).then(doc => {
    const raw = doc.exists ? doc.data() : null;
    if (raw && (raw.docVersion || 0) > DOC_VERSION) throw { code: 'app/stale-client' };
    const remote = normalizeRemote(raw);
    merged = mergeBundle(localBundle(), remote);
    // Skip the write when the cloud already holds exactly this — keeps a
    // snapshot echo from turning into an endless write/receive loop.
    if (remote && bundleSig(merged) === bundleSig(remote)) return;
    tx.set(ref, {
      docVersion: DOC_VERSION,
      timer: merged.timer ?? null, goals: merged.goals || [], study: merged.study || {},
      notes: merged.notes || [], tomb: merged.tomb || {},
      updatedAt: Math.max(syncMeta().updatedAt || 0, raw?.updatedAt || 0) || Date.now(),
    });
  }));
  // A transaction can sit unresolved on a flaky connection; don't let that wedge
  // the uploader. A late-landing write is harmless — every write is a merge.
  const guard = new Promise((_, rej) => setTimeout(() => rej({ code: 'app/timeout' }), 25000));
  return Promise.race([tx$, guard]).then(() => {
    pushRetry = 0;
    applyBundle(merged);          // adopt anything the cloud had that we didn't
    setSyncStatus('동기화됨', '');
    if (pushQueued) { pushQueued = false; schedulePush(); }
  }).catch(e => {
    const code = e?.code || String(e);
    if (code === 'app/stale-client') {
      setSyncStatus('앱이 최신 버전이 아닙니다 — 새로고침하세요', code);
      return;
    }
    // Offline or contention: keep the change locally and try again. Nothing is
    // lost by a failed push — the next successful one re-merges everything.
    setSyncStatus('업로드 대기 중', code);
    pushRetry = Math.min(pushRetry + 1, 6);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(pushCloud, Math.min(60000, 2000 * Math.pow(2, pushRetry - 1)));
  }).then(() => { pushInFlight = false; });
}

// ── Applying a merged bundle locally ───────────────────────────
function applyBundle(merged) {
  if (!merged) return;
  const before = bundleSig(localBundle());
  if (bundleSig(merged) === before) return;   // nothing new for us
  const notesBefore = stableStr(notes);
  applying = true;
  try {
    writeBundle(merged);
    loadTimer();
    loadGoals();
    loadStudy();
    loadNotes();
    loadTomb();
  } finally { applying = false; }
  // A snapshot can land before the last script has defined its renderers. The
  // data is already in localStorage by now, so start-up picks it up either way.
  if (appReady) applyLive(stableStr(notes) !== notesBefore);
}
// Repaint everything from the freshly loaded state. The main countdown is
// restarted in place — v1 reloaded the whole page here, which threw away
// whatever the user was doing.
function applyLive(notesChanged) {
  reconcileSession();
  applyTheme();
  adoptTimer(curSessionId());   // the active session may have changed on a peer
  renderSessionChip();
  applyComboMode(study.comboMode === 'pomo' ? 'pomo' : 'study');
  resumePomo(true);
  restartTick();
  render();
  renderGoals();
  renderDayTicks();
  renderGoalFlags();
  updateStudyUI();
  // Only rebuild the memo card when the notes themselves changed — otherwise a
  // study-only sync would replay its open/close animation and look like a flicker.
  if (notesChanged !== false) renderMemoWidget();
  const isOpen = id => { const m = $(id); return !!m && m.classList.contains('open'); };
  if (isOpen('dashModal'))  renderDashboard();
  if (isOpen('notesModal')) renderNotesList();
  if (isOpen('setModal'))   renderSettings();
  if (isOpen('subjModal'))  renderSubjChips();
  if (isOpen('sessModal'))  renderSessionList();
  renderAcct();
}

// Cloud snapshot → merge into local. Loop-free: the merge of our own echo is
// byte-identical to what we already have, so it produces no further writes.
function onCloud(doc) {
  const raw = doc.exists ? doc.data() : null;
  if (raw && (raw.docVersion || 0) > DOC_VERSION) {
    setSyncStatus('앱이 최신 버전이 아닙니다 — 새로고침하세요', 'app/stale-client');
    return;
  }
  syncReady = true;
  setSyncStatus(raw ? '동기화됨' : '클라우드에 데이터 없음 — 이 기기 데이터를 업로드합니다', '');

  const remote = normalizeRemote(raw);
  const merged = mergeBundle(localBundle(), remote);
  applyBundle(merged);
  // Push whenever the cloud is missing something we hold.
  if (!remote || bundleSig(merged) !== bundleSig(remote)) schedulePush();
  renderAcct();
}

function onAuthChange(user) {
  if (cloudUnsub) { cloudUnsub(); cloudUnsub = null; }
  cloudUid = user ? user.uid : null;
  syncReady = false; pushRetry = 0;
  clearTimeout(retryTimer);
  syncStatus = ''; syncError = '';
  if (user && db) {
    setSyncStatus('연결 중…', '');
    cloudUnsub = db.collection('users').doc(user.uid)
      .onSnapshot({ includeMetadataChanges: false }, onCloud, e => {
        const code = e?.code || String(e);
        setSyncStatus('데이터 받기 실패', code);
        showToast('동기화 연결 실패: ' + code);
      });
  }
  $('acctBtn').classList.toggle('on', !!user);
  renderAcct();
}

function signIn() {
  if (!fbAuth) return;
  const provider = new firebase.auth.GoogleAuthProvider();
  fbAuth.signInWithPopup(provider).catch(err => {
    if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment')) {
      fbAuth.signInWithRedirect(provider);
    } else {
      showToast('로그인 실패: ' + (err?.code || err));
    }
  });
}
function signOut() {
  pushCloud().then(() => { if (fbAuth) fbAuth.signOut(); });
}

function renderAcct() {
  const body = $('acctBody');
  if (!body) return;
  if (!fbReady) {
    body.innerHTML =
      '<div class="acct-note">계정 동기화를 켜려면 Firebase 설정이 필요합니다.<br><br>' +
      'Firebase 프로젝트를 만들고 <b>Authentication → Google 로그인</b>과 <b>Firestore</b>를 활성화한 뒤, ' +
      '<code>js/sync.js</code>의 <code>FIREBASE_CONFIG</code> 값을 채워 주세요.</div>';
    return;
  }
  const user = fbAuth && fbAuth.currentUser;
  if (!user) {
    body.innerHTML =
      '<div class="acct-note">로그인하면 목표·공부 기록·타이머가 기기 간에 자동으로 동기화됩니다.</div>' +
      '<button class="modal-confirm" id="acctSignIn">Google로 로그인</button>';
    $('acctSignIn').addEventListener('click', signIn);
  } else {
    const when = syncMeta().updatedAt ? new Date(syncMeta().updatedAt).toLocaleString('ko-KR') : '—';
    const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const statusLine = syncError
      ? '<div class="acct-meta" style="color:var(--danger)">⚠ ' + esc(syncStatus) + ' (' + esc(syncError) + ')</div>'
      : '<div class="acct-meta">' + esc(syncStatus || '동기화됨') + ' · 마지막 변경 ' + when + '</div>';
    body.innerHTML =
      '<div class="acct-row"><div class="acct-email">' + esc(user.email || user.displayName || user.uid) + '</div>' +
      statusLine + '</div>' +
      '<button class="modal-confirm" id="acctSyncNow">지금 동기화</button>' +
      '<button class="acct-secondary" id="acctPull">클라우드에서 다시 불러오기</button>' +
      '<button class="acct-secondary" id="acctSignOut">로그아웃</button>';
    $('acctSyncNow').addEventListener('click', () => { pushCloud(); showToast('동기화 중…'); });
    $('acctPull').addEventListener('click', pullNow);
    $('acctSignOut').addEventListener('click', signOut);
  }
}

// Force a one-time read from the cloud and merge it in (useful if the live
// listener was blocked or the user wants to re-pull on demand).
function pullNow() {
  if (!cloudUid || !db) { showToast('로그인이 필요합니다'); return; }
  showToast('불러오는 중…');
  db.collection('users').doc(cloudUid).get()
    .then(doc => {
      if (!doc.exists) { showToast('클라우드에 데이터가 없습니다'); setSyncStatus('클라우드에 데이터 없음', ''); return; }
      onCloud(doc);
      showToast('불러오기 완료');
    })
    .catch(e => {
      const code = e?.code || String(e);
      setSyncStatus('불러오기 실패', code);
      showToast('불러오기 실패: ' + code);
    });
}

if (fbReady) {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    db = firebase.firestore();
    // Cached reads so the app still shows the right data with no connection;
    // writes go through our own retry loop above, not Firestore's queue.
    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    fbAuth.onAuthStateChanged(onAuthChange);
  } catch(e) { console.warn('Firebase init failed', e); }
}

// Flush on the way out. visibilitychange is the reliable one on mobile (a phone
// often never fires beforeunload); a missed flush costs nothing but time, since
// the change is still in localStorage and re-merges on the next push.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { clearTimeout(pushTimer); pushCloud(); }
});
window.addEventListener('beforeunload', () => { clearTimeout(pushTimer); pushCloud(); });
window.addEventListener('online', () => { pushRetry = 0; pushCloud(); });

// Two tabs on the same device share localStorage but not memory, so without
// this the second tab would happily overwrite the first tab's work.
window.addEventListener('storage', e => {
  if (applying) return;
  if (![STORE_KEY, GOALS_KEY, STUDY_KEY, NOTES_KEY, TOMB_KEY].includes(e.key)) return;
  let other;
  try {
    other = normalizeRemote({
      timer: JSON.parse(localStorage.getItem(STORE_KEY) || 'null'),
      goals: JSON.parse(localStorage.getItem(GOALS_KEY) || '[]'),
      study: JSON.parse(localStorage.getItem(STUDY_KEY) || '{}'),
      notes: JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'),
      tomb:  JSON.parse(localStorage.getItem(TOMB_KEY)  || '{}'),
    });
  } catch (err) { return; }
  const merged = mergeBundle(localBundle(), other);
  applyBundle(merged);
  // The other tab's write may have landed on top of something only we still
  // hold (both tabs write the whole bundle, and our own write-back can cross
  // theirs). Put the merge back on disk whenever it holds more than what's
  // there — the same "peer is stale, push" rule the cloud path uses. It
  // terminates because merging is idempotent: once a tab has nothing extra to
  // contribute, its merge equals what it just read and it stops writing.
  if (bundleSig(merged) !== bundleSig(other)) {
    applying = true;
    try { writeBundle(merged); } finally { applying = false; }
  }
});

const acctModal = $('acctModal');
$('acctBtn').addEventListener('click', () => { renderAcct(); acctModal.classList.add('open'); });
$('acctClose').addEventListener('click', () => acctModal.classList.remove('open'));
on('acctModal', 'click', e => { if (e.target === acctModal) acctModal.classList.remove('open'); });
