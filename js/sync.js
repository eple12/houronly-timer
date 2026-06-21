// ── Account sync (Firebase, optional) ─────────────────────────
// To enable: create a Firebase project, enable Authentication →
// Google sign-in, create a Firestore database, then paste your web
// app config below. Firestore rule (per-user access):
//   match /users/{uid} { allow read, write: if request.auth.uid == uid; }
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBXiXFrwbR5QAv741MibNUFGD-fVu1NlHQ",
  authDomain: "houronly-timer.firebaseapp.com",
  projectId: "houronly-timer",
  storageBucket: "houronly-timer.firebasestorage.app",
  messagingSenderId: "680066324066",
  appId: "1:680066324066:web:a28d618323cde9c7f9233b",
  measurementId: "G-GDN5TL9DCR"
};
const META_KEY     = 'timer_sync_meta_v1';
const PUSH_DELAY    = 4000;    // settle time after the last change
const MAX_PUSH_WAIT = 30000;   // force a flush at least this often during
                               // continuous activity (e.g. a running stopwatch)
let fbAuth = null, db = null, cloudUid = null, cloudUnsub = null;
let syncReady = false, pushTimer = null, lastPushedJson = null, firstDirtyAt = 0;
let pushSilent = false; // true when the pending push is sync-driven (no toast)
let syncStatus = '';   // human-readable status shown in the account sheet
let syncError  = '';   // last error code, if any

function setSyncStatus(s, err) {
  syncStatus = s || '';
  syncError  = err || '';
  renderAcct();
}

const fbReady = !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId
                   && window.firebase);

function syncMeta() { try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch(e) { return {}; } }
function syncTouch() {
  try { localStorage.setItem(META_KEY, JSON.stringify({ updatedAt: Date.now() })); } catch(e) {}
  pushSilent = false;   // a genuine local change → confirm with a toast on upload
  if (cloudUid && syncReady) schedulePush();
}
function schedulePush() {
  if (!firstDirtyAt) firstDirtyAt = Date.now();
  clearTimeout(pushTimer);
  // Debounce after the last change, but never wait longer than MAX_PUSH_WAIT
  // so continuous per-second changes still upload periodically.
  const delay = Math.min(PUSH_DELAY, Math.max(0, MAX_PUSH_WAIT - (Date.now() - firstDirtyAt)));
  pushTimer = setTimeout(pushCloud, delay);
}

function localBundle() {
  const j = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch(e) { return d; } };
  return { timer: j(STORE_KEY, null), goals: j(GOALS_KEY, []), study: j(STUDY_KEY, null),
           notes: j(NOTES_KEY, []), tomb: j(TOMB_KEY, {}) };
}
// Merge deletion tombstones: keep the latest deletedAt per id.
function mergeTomb(a, b) {
  const o = Object.assign({}, a || {}); const r = b || {};
  for (const k in r) { if (!(k in o) || r[k] > o[k]) o[k] = r[k]; }
  return o;
}
// Union notes by id. Content (title/text/items/pinned) resolves by updatedAt
// newest-wins; list ORDER resolves independently by its own `orderAt` stamp, so
// reordering on one device doesn't clobber a content edit on another (and vice
// versa). Drops notes deleted after their last edit.
function mergeNotes(local, remote, tmb) {
  local = local || []; remote = remote || []; tmb = tmb || {};
  const lm = new Map(local.map(n => [n.id, n]));
  const rm = new Map(remote.map(n => [n.id, n]));
  const out = [];
  new Set([...lm.keys(), ...rm.keys()]).forEach(id => {
    const a = lm.get(id), b = rm.get(id);
    let n;
    if (a && b) {
      n = Object.assign({}, (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b);
      // Order: keep whichever side last reordered (newest orderAt wins).
      const ord = (a.orderAt || 0) >= (b.orderAt || 0) ? a : b;
      n.order   = ord.order;
      n.orderAt = Math.max(a.orderAt || 0, b.orderAt || 0);
    } else {
      n = a || b;
    }
    out.push(n);
  });
  return out
    .filter(n => !(n.id in tmb) || (n.updatedAt || 0) > tmb[n.id])
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Merge study: recorded time never lost (max per day), each setting uses its
// own per-field timestamp so only the field that actually changed on a device
// wins — not every setting on whichever device happened to touch anything last.
// The live stopwatch run-state stays device-local (no cross-device double-count).
function mergeStudy(local, remote, remoteNewer) {
  if (!remote) return local;
  if (!local)  return remote;
  const la = local.settingsAt  || {};
  const ra = remote.settingsAt || {};
  // Merge settingsAt: keep the highest timestamp per field so every device
  // eventually learns when each setting was last changed.
  const mergedAt = {};
  new Set([...Object.keys(la), ...Object.keys(ra)]).forEach(f => {
    mergedAt[f] = Math.max(la[f] || 0, ra[f] || 0);
  });
  // Start with the newer device as the base (backwards-compat fallback for any
  // fields not listed in SETTING_FIELDS below).
  const out = remoteNewer ? Object.assign({}, local, remote)
                          : Object.assign({}, remote, local);
  // Per-setting newest-wins: each field independently resolved by its own stamp.
  const SETTING_FIELDS = ['theme', 'accent', 'focusMode', 'dailyGoalSec',
                          'resetHour', 'curSubject', 'pomo', 'comboMode'];
  SETTING_FIELDS.forEach(f => {
    const lt = la[f] || 0, rt = ra[f] || 0;
    if (lt === 0 && rt === 0) return; // no per-field stamp yet: keep Object.assign result
    out[f] = rt > lt ? remote[f] : local[f];
  });
  out.settingsAt = mergedAt;
  // Subject list ordering: prefer the device whose subjectList stamp is newer.
  const useRemoteOrder = (ra.subjectList || 0) > (la.subjectList || 0) ? true
                       : (la.subjectList || 0) > (ra.subjectList || 0) ? false
                       : remoteNewer;
  const baseList  = (useRemoteOrder ? remote.subjectList : local.subjectList) || [];
  const otherList = (useRemoteOrder ? local.subjectList  : remote.subjectList) || [];
  out.subjectList = Array.from(new Set([...baseList, ...otherList]));
  // Active stopwatch session: resolve without ever double-counting time.
  // - same run on both sides → keep it, adopt the freshest heartbeat;
  // - two different live runs → newest START wins ("최신 시작 채택");
  // - otherwise (a stop on one side) → newest transition stamp wins.
  const ls = local.session, rs = remote.session;
  const lAt = local.sessionAt || 0, rAt = remote.sessionAt || 0;
  if (ls && rs) {
    if (ls.runId === rs.runId) {
      out.session = Object.assign({}, ls, rs, { beatAt: Math.max(ls.beatAt || 0, rs.beatAt || 0) });
    } else {
      out.session = (rs.startEpoch || 0) > (ls.startEpoch || 0) ? rs : ls;
    }
    out.sessionAt = Math.max(lAt, rAt, out.session.beatAt || 0);
  } else if (rAt !== lAt) {
    // one side is null (an explicit stop): newest transition stamp wins.
    if (rAt > lAt) { out.session = rs || null; out.sessionAt = rAt; }
    else           { out.session = ls || null; out.sessionAt = lAt; }
  } else {
    // Equal stamp with one side null: prefer the running side (a device that
    // hasn't yet seen the stop keeps showing the run until the stop propagates).
    out.session = rs || ls || null;
    out.sessionAt = lAt;
  }
  // committedRuns: highest committed-up-to epoch per run (so neither side
  // re-commits time the other already folded into records).
  out.committedRuns = {};
  new Set([...Object.keys(local.committedRuns || {}), ...Object.keys(remote.committedRuns || {})]).forEach(k =>
    out.committedRuns[k] = Math.max(local.committedRuns?.[k] || 0, remote.committedRuns?.[k] || 0));
  // Records: max per day for natural accumulation; manual corrections (recordsOverride)
  // take precedence so a user-initiated fix propagates even though it lowers the value.
  out.records = {};
  out.recordsOverride = {};
  const keys = new Set([
    ...Object.keys(local.records || {}), ...Object.keys(remote.records || {}),
    ...Object.keys(local.recordsOverride || {}), ...Object.keys(remote.recordsOverride || {}),
  ]);
  keys.forEach(k => {
    const lv = local.records?.[k] || 0;
    const rv = remote.records?.[k] || 0;
    const lo = local.recordsOverride?.[k];   // { sec, at }
    const ro = remote.recordsOverride?.[k];  // { sec, at }
    if (!lo && !ro) {
      out.records[k] = Math.max(lv, rv);     // no correction: normal max-merge
    } else {
      const winner = (!lo) ? ro : (!ro) ? lo : (lo.at >= ro.at ? lo : ro);
      out.recordsOverride[k] = winner;
      if (lo && ro && lo.at === ro.at) {
        // Both sides share the same correction: max-merge accumulation above it.
        out.records[k] = Math.max(lv, rv);
      } else {
        // Winning correction overrides the other side; keep any accumulation above it.
        out.records[k] = Math.max(winner.sec, winner === lo ? lv : rv);
      }
    }
  });
  // Per-day subject seconds: max per subject per day.
  out.subjects = {};
  const sdays = new Set([...Object.keys(local.subjects || {}), ...Object.keys(remote.subjects || {})]);
  sdays.forEach(d => {
    const ls = local.subjects?.[d] || {}, rs = remote.subjects?.[d] || {}, m = {};
    new Set([...Object.keys(ls), ...Object.keys(rs)]).forEach(s => m[s] = Math.max(ls[s] || 0, rs[s] || 0));
    out.subjects[d] = m;
  });
  // Per-day distraction counts: max.
  out.distractions = {};
  const xkeys = new Set([...Object.keys(local.distractions || {}), ...Object.keys(remote.distractions || {})]);
  xkeys.forEach(k => out.distractions[k] = Math.max(local.distractions?.[k] || 0, remote.distractions?.[k] || 0));

  // subjectsOverride: newest `at` wins per subject per day.
  out.subjectsOverride = {};
  const ovDays = new Set([
    ...Object.keys(local.subjectsOverride  || {}),
    ...Object.keys(remote.subjectsOverride || {}),
  ]);
  ovDays.forEach(day => {
    const lo = local.subjectsOverride?.[day]  || {};
    const ro = remote.subjectsOverride?.[day] || {};
    const m  = {};
    new Set([...Object.keys(lo), ...Object.keys(ro)]).forEach(name => {
      if      (!lo[name]) m[name] = ro[name];
      else if (!ro[name]) m[name] = lo[name];
      else m[name] = (lo[name].at || 0) >= (ro[name].at || 0) ? lo[name] : ro[name];
    });
    out.subjectsOverride[day] = m;
  });

  // subjectColors: merge by union; if both have a color for the same name, newest
  // settingsAt.subjectColors timestamp wins (falls back to remoteNewer).
  const useRemoteColors = (ra.subjectColors || 0) > (la.subjectColors || 0) ? true
                        : (la.subjectColors || 0) > (ra.subjectColors || 0) ? false
                        : remoteNewer;
  const baseColors  = (useRemoteColors ? remote.subjectColors : local.subjectColors)  || {};
  const otherColors = (useRemoteColors ? local.subjectColors  : remote.subjectColors) || {};
  out.subjectColors = Object.assign({}, otherColors, baseColors);

  return out;
}
// Union goals by id, preserving local order; drop tombstoned (deleted) ones.
function mergeGoals(local, remote, tmb) {
  local = local || []; remote = remote || []; tmb = tmb || {};
  const ids = new Set(local.map(g => g.id));
  return local.concat(remote.filter(g => !ids.has(g.id))).filter(g => !(g.id in tmb));
}

function pushCloud() {
  clearTimeout(pushTimer); pushTimer = null; firstDirtyAt = 0;
  pushSilent = false;
  if (!cloudUid || !syncReady || !db) return;
  const b = localBundle();
  const payload = { timer: b.timer ?? null, goals: b.goals || [], study: b.study ?? null,
                    notes: b.notes || [], tomb: b.tomb || {}, updatedAt: syncMeta().updatedAt || Date.now() };
  const json = JSON.stringify(payload);
  if (json === lastPushedJson) return;
  lastPushedJson = json;
  db.collection('users').doc(cloudUid).set(payload)
    .then(() => {
      setSyncStatus('동기화됨', '');
      // No toast on automatic sync — silent background upload.
    })
    .catch(e => {
      lastPushedJson = null;   // allow retry
      const code = e?.code || String(e);
      setSyncStatus('업로드 실패', code);
      showToast('동기화 업로드 실패: ' + code);
    });
}

// ── Canonical, jitter-free comparison helpers ──
// Stable key order + rounded seconds so semantically equal data never looks
// "changed" (which is what caused the reload ping-pong between devices).
function stableStr(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}';
}
function canonTimer(t) { return stableStr(t ?? null); }
function canonGoals(g) { return stableStr([...(g || [])].sort((a, b) => (a.id || 0) - (b.id || 0))); }
function canonStudy(s) {
  if (!s) return 'null';
  const rec = {};
  Object.keys(s.records || {}).forEach(k => { const v = Math.floor(s.records[k] || 0); if (v > 0) rec[k] = v; });
  const subj = {};
  Object.keys(s.subjects || {}).forEach(d => {
    const m = {}, sd = s.subjects[d] || {};
    Object.keys(sd).forEach(k => { const v = Math.floor(sd[k] || 0); if (v > 0) m[k] = v; });
    if (Object.keys(m).length) subj[d] = m;
  });
  const dist = {};
  Object.keys(s.distractions || {}).forEach(k => { const v = Math.floor(s.distractions[k] || 0); if (v > 0) dist[k] = v; });
  // Active session is included (so a peer start/stop reaches the UI) but the
  // per-second heartbeat is coarsened to ~10s buckets to avoid sig churn on
  // every beat; runId+startEpoch still flip the signature on start/stop.
  const sess = s.session
    ? { runId: s.session.runId, startEpoch: s.session.startEpoch || 0, beat: Math.floor((s.session.beatAt || 0) / 10000) }
    : null;
  const subjOv = {};
  Object.keys(s.subjectsOverride || {}).forEach(day => {
    const m = {}, sd = s.subjectsOverride[day] || {};
    Object.keys(sd).forEach(n => {
      if (sd[n]) m[n] = { sec: Math.floor(sd[n].sec || 0), at: Math.floor(sd[n].at || 0) };
    });
    if (Object.keys(m).length) subjOv[day] = m;
  });
  return stableStr({
    resetHour: s.resetHour || 0, records: rec, subjects: subj, distractions: dist,
    subjectList: s.subjectList || [], curSubject: s.curSubject || '',
    dailyGoalSec: s.dailyGoalSec || 0, theme: s.theme || 'dark',
    accent: s.accent || '#cef231', focusMode: !!s.focusMode,
    comboMode: s.comboMode || 'study', pomo: s.pomo || null,
    settingsAt: s.settingsAt || {}, recordsOverride: s.recordsOverride || {},
    session: sess, sessionAt: s.sessionAt || 0, committedRuns: s.committedRuns || {},
    subjectsOverride: subjOv, subjectColors: s.subjectColors || {},
  });
}
function canonNotes(n) {
  return stableStr([...(n || [])].sort((a, b) => (a.id || 0) - (b.id || 0))
    .map(x => ({ id: x.id, title: x.title || '', type: x.type || 'text',
                 text: x.text || '', items: x.items || [], pinned: !!x.pinned, pinnedAt: x.pinnedAt || 0,
                 order: Number.isFinite(x.order) ? x.order : null, orderAt: x.orderAt || 0 })));
}
function canonTomb(t) { return stableStr(t || {}); }

function setMeta(v) { try { localStorage.setItem(META_KEY, JSON.stringify({ updatedAt: v })); } catch(e) {} }
function writeBundle(b) {
  try {
    if (b.timer) localStorage.setItem(STORE_KEY, JSON.stringify(b.timer));
    else         localStorage.removeItem(STORE_KEY);
    localStorage.setItem(GOALS_KEY, JSON.stringify(b.goals || []));
    if (b.study) localStorage.setItem(STUDY_KEY, JSON.stringify(b.study));
    localStorage.setItem(NOTES_KEY, JSON.stringify(b.notes || []));
    localStorage.setItem(TOMB_KEY, JSON.stringify(b.tomb || {}));
  } catch(e) {}
}
// Refresh goals + study + notes in the live UI without a full page reload.
function applyGoalsStudyLive() {
  const notesSigBefore = canonNotes(notes);
  loadGoals();
  loadStudy();
  loadNotes();
  loadTomb();
  reconcileSession();   // adopt/resume or finalize the merged session
  lastSeenStudyDay = studyDayKey(Date.now());
  applyTheme();
  renderGoals();
  renderDayTicks();
  renderGoalFlags();
  updateStudyUI();
  renderPomo();
  // Only re-render the memo widget when the notes themselves changed — otherwise
  // a study-only sync (e.g. a session heartbeat) would needlessly rebuild it and
  // replay its open/close animation, which looked like a flicker.
  if (canonNotes(notes) !== notesSigBefore) renderMemoWidget();
  if (dashModal.classList.contains('open')) renderDashboard();
  if (notesModal.classList.contains('open')) renderNotesList();
  if (setModal.classList.contains('open')) renderSettings();
}

// Reconcile a cloud snapshot with local data. Loop-free: the merged version
// is max(local, remote) — never "now" — so receiving an update doesn't make
// this device look newer and bounce back to the peer.
function onCloud(doc) {
  const remote = doc.exists ? doc.data() : null;
  setSyncStatus(remote ? '클라우드 연결됨' : '클라우드에 데이터 없음 — 이 기기 데이터를 업로드합니다', '');

  const local = localBundle();
  const lm = syncMeta().updatedAt || 0;
  const rm = remote?.updatedAt || 0;
  const remoteNewer = rm > lm;

  const mergedTomb = mergeTomb(local.tomb, remote?.tomb);
  const merged = {
    timer: remoteNewer ? (remote?.timer ?? local.timer ?? null) : (local.timer ?? null),
    goals: mergeGoals(local.goals, remote?.goals, mergedTomb),
    study: mergeStudy(local.study, remote?.study, remoteNewer),
    notes: mergeNotes(local.notes, remote?.notes, mergedTomb),
    tomb: mergedTomb,
  };
  const mergedVer = Math.max(lm, rm);

  // Canonical signatures for change detection.
  const sig = b => canonTimer(b.timer) + '|' + canonGoals(b.goals) + '|' + canonStudy(b.study)
                 + '|' + canonNotes(b.notes) + '|' + canonTomb(b.tomb);
  const localSig  = sig(local);
  const mergedSig = sig(merged);
  const remoteSig = remote ? sig({ timer: remote.timer, goals: remote.goals, study: remote.study, notes: remote.notes, tomb: remote.tomb }) : '';

  const localChanged = mergedSig !== localSig;     // our stored data needs updating
  const cloudStale   = mergedSig !== remoteSig;    // cloud is missing some of our data

  syncReady = true;

  if (localChanged) {
    writeBundle(merged);
    setMeta(mergedVer);
    const timerChanged = canonTimer(local.timer) !== canonTimer(merged.timer);
    if (timerChanged) {
      // Active countdown changed — a reload is the safe way to restart it.
      if (cloudStale) { lastPushedJson = null; pushSilent = true; schedulePush(); }
      try { sessionStorage.setItem('syncReload', '1'); } catch(e) {}
      location.reload();
      return;
    }
    applyGoalsStudyLive();      // goals / study only → no reload needed
  } else {
    setMeta(mergedVer);         // adopt the higher version so we stop re-diffing
  }

  if (cloudStale) { lastPushedJson = null; pushSilent = true; schedulePush(); }
  renderAcct();
}

function onAuthChange(user) {
  if (cloudUnsub) { cloudUnsub(); cloudUnsub = null; }
  cloudUid = user ? user.uid : null;
  syncReady = false; lastPushedJson = null;
  syncStatus = ''; syncError = '';
  if (user && db) {
    setSyncStatus('연결 중…', '');
    cloudUnsub = db.collection('users').doc(user.uid)
      .onSnapshot(onCloud, e => {
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
  pushCloud();
  if (fbAuth) fbAuth.signOut();
}

function renderAcct() {
  const body = $('acctBody');
  if (!body) return;
  if (!fbReady) {
    body.innerHTML =
      '<div class="acct-note">계정 동기화를 켜려면 Firebase 설정이 필요합니다.<br><br>' +
      'Firebase 프로젝트를 만들고 <b>Authentication → Google 로그인</b>과 <b>Firestore</b>를 활성화한 뒤, ' +
      '<code>index.html</code>의 <code>FIREBASE_CONFIG</code> 값을 채워 주세요.</div>';
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
      '<button class="modal-confirm" id="acctSyncNow">지금 업로드</button>' +
      '<button class="acct-secondary" id="acctPull">클라우드에서 다시 불러오기</button>' +
      '<button class="acct-secondary" id="acctSignOut">로그아웃</button>';
    $('acctSyncNow').addEventListener('click', () => { lastPushedJson = null; pushCloud(); showToast('업로드 중…'); });
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
      onCloud(doc);   // merges + reloads if there are changes
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
    fbAuth.onAuthStateChanged(onAuthChange);
  } catch(e) { console.warn('Firebase init failed', e); }
}
window.addEventListener('beforeunload', () => { clearTimeout(pushTimer); pushCloud(); });

const acctModal = $('acctModal');
$('acctBtn').addEventListener('click', () => { renderAcct(); acctModal.classList.add('open'); });
$('acctClose').addEventListener('click', () => acctModal.classList.remove('open'));
acctModal.addEventListener('click', e => { if (e.target === acctModal) acctModal.classList.remove('open'); });
