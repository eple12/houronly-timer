const STORE_KEY = 'timer_v4';
const GOALS_KEY = 'timer_goals_v1';
const STUDY_KEY = 'timer_study_v1';
const NOTES_KEY = 'timer_notes_v1';
const TOMB_KEY  = 'timer_tomb_v1';   // deletion tombstones: { id: deletedAt }

const GOAL_COLORS = [
  '#f03c3c', '#ff8800', '#cef231',
  '#2edf7a', '#3a8fff', '#a855f7',
  '#f542c8', '#00cfff',
];

// Colors available for subject tags (palette shown in subject picker)
const SUBJECT_COLORS = [
  '#7aa2f7','#5ed3a8','#f7a23a','#f76b6b',
  '#c47cff','#36d1dc','#cef231','#ff9f7a',
  '#ff7eb3','#facc15',
];

/* ── Flag SVG geometry (must stay in sync with CSS .progress-track padding-top) ──
   BAR_Y    = padding-top of .progress-track   = 28
   BAR_H    = .progress-bar height             = 4
   BANNER_H = banner height                    = 14
   POLE_TOP = banner bottom                    = 14
   POLE_BOT = BAR_Y + BAR_H + 2 = 34  (pole tip 2px below bar)
   Marker (goal position) = pole LEFT edge (x=0) so nothing pokes left of it. */
const BAR_Y    = 14;
const BAR_H    = 4;
const BANNER_H = 10;
const POLE_TOP = BANNER_H;
const POLE_BOT = BAR_Y + BAR_H + 1;
const SVG_H    = POLE_BOT;

function makeFlagSVG(color) {
  const tip = BANNER_H / 2;
  /* Pole left edge at x=0 (the marker). Slim pole with a short swallowtail
     banner; the pole sits close to the bar so the marker isn't tall & skinny. */
  return `<svg width="17" height="${SVG_H}" viewBox="0 0 17 ${SVG_H}"
    xmlns="http://www.w3.org/2000/svg" fill="${color}">
    <rect x="0" y="0" width="1.8" height="${POLE_BOT}" rx="0.9"/>
    <path d="M0,0 H12 L8,${tip} L12,${BANNER_H} H0 Z"/>
  </svg>`;
}

// ── Timer state ────────────────────────────────────────────────
let goalEpoch       = null;
let startEpoch      = null;
let pausedRemaining = null;
let totalSeconds    = 0;
let rafId           = null;
let lastDisplayed   = -1;
let lastLocked      = null;
let emergency       = false;

// ── Goals state ────────────────────────────────────────────────
let goals              = [];
let selectedColor      = GOAL_COLORS[0];
let selectedSubjColor  = SUBJECT_COLORS[0];   // color chosen in subject picker
let sadSubject         = '';                  // subject chosen in dashboard "add time" dropdown
let lastGoalSec        = -1;

// ── Study state ────────────────────────────────────────────────
let study = {
  resetHour: 0,        // local hour at which the study day rolls over
  records:   {},       // 'YYYY-MM-DD' -> committed (finalized) seconds
  // Active stopwatch run, synced across devices. While a session is live the
  // elapsed time is DERIVED from startEpoch (see sessionOverlay) rather than
  // accumulated per-tick, so several devices counting at once can never double
  // up. committedRuns[runId] = epoch-ms already folded into records (lets a
  // run be committed/resumed idempotently). See toggleStopwatch & mergeStudy.
  session:   null,     // { runId, startEpoch, beatAt } or null
  sessionAt: 0,        // LWW stamp for the last start/stop transition
  committedRuns: {},   // runId -> epoch ms committed up to
};
let lastSeenStudyDay = null;

// Stable per-device id (NOT synced) used to tag the runs this device starts.
const DEVICE_ID = (() => {
  try {
    let d = localStorage.getItem('timer_device_id');
    if (!d) { d = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('timer_device_id', d); }
    return d;
  } catch (e) { return 'dev' + Math.random().toString(36).slice(2, 8); }
})();

// ── Notes / memos state ────────────────────────────────────────
// note: { id, title, type:'text'|'list', text, items:[{t,done}], pinned, updatedAt }
let notes = [];
let editingNoteId = null;
let tomb = {};   // id -> deletedAt, so deletions propagate across devices

// ── DOM ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Monochrome line/area icons (currentColor, transparent bg) ──
const ICONS = {
  play:   '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 7 5.5z"/></svg>',
  pause:  '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
  flag:   '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4"/><path d="M6 4.5h11l-2.2 4 2.2 4H6"/></svg>',
  warn:   '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l8.5 15h-17z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/></svg>',
  chart:  '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="11" width="4" height="9" rx="1"/><rect x="10" y="6" width="4" height="14" rx="1"/><rect x="16" y="14" width="4" height="6" rx="1"/></svg>',
  note:   '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8l5 5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M14 3.5V9h5"/><line x1="8.5" y1="13" x2="15.5" y2="13"/><line x1="8.5" y1="16.5" x2="13" y2="16.5"/></svg>',
  pencil: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 16z"/><line x1="14.5" y1="6.5" x2="17.5" y2="9.5"/></svg>',
  list:   '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><line x1="8.5" y1="9" x2="15.5" y2="9"/><line x1="8.5" y1="13" x2="15.5" y2="13"/><line x1="8.5" y1="17" x2="12.5" y2="17"/></svg>',
  calendar:'<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="2.5"/><line x1="4" y1="9.5" x2="20" y2="9.5"/><line x1="9" y1="3" x2="9" y2="6"/><line x1="15" y1="3" x2="15" y2="6"/></svg>',
  cloud:  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 18.5a4 4 0 0 1-.3-8 5 5 0 0 1 9.6-1.2 3.6 3.6 0 0 1 .2 7.2z"/></svg>',
  expand: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M20 9V5a1 1 0 0 0-1-1h-4"/><path d="M4 15v4a1 1 0 0 0 1 1h4"/><path d="M20 15v4a1 1 0 0 1-1 1h-4"/></svg>',
  close:  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  chevL:  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  chevR:  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  trash:  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M9.5 7V5h5v2"/><path d="M7 7l.8 12.2a1 1 0 0 0 1 .8h6.4a1 1 0 0 0 1-.8L18 7"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  pin:    '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 2.5V14H8v-1.5L11 10z"/><line x1="12" y1="14" x2="12" y2="20"/></svg>',
  check:  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12.5l2.5 2.5 5-5"/></svg>',
  gear:   '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  tag:    '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13.3 13 20.8a1.6 1.6 0 0 1-2.3 0L3.2 13.3a1.6 1.6 0 0 1-.5-1.1V5a1.6 1.6 0 0 1 1.6-1.6h7.2a1.6 1.6 0 0 1 1.1.5l7.9 7.9a1.6 1.6 0 0 1 0 2.5z"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/></svg>',
  refresh:'<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.5L20 16"/><path d="M20 20v-4h-4"/></svg>',
  grip:   '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
};
const icoSm = n => ICONS[n].replace('class="ico"', 'class="ico ico-sm"');
// Swap the static button glyphs for the monochrome icons.
['acctBtn:cloud','setBtn:gear','goalBtn:flag','emgBtn:warn','notesBtn:note','dashBtn:chart','calBtn:calendar','fsBtn:expand','pomoReset:refresh']
  .forEach(p => { const [id, name] = p.split(':'); const el = $(id); if (el) el.innerHTML = ICONS[name]; });
const timeDisplay   = $('timeDisplay');
const elapsedLabel  = $('elapsedLabel');
const endLabel      = $('endLabel');
const metaSep       = $('metaSep');
const metaRow2      = $('metaRow2');
const progressFill  = $('progressFill');
const progressTrack = $('progressTrack');
const statusDot     = $('statusDot');
const statusText    = $('statusText');
const startBtn      = $('startBtn');
const resetBtn      = $('resetBtn');
const hInput        = $('hInput');
const mInput        = $('mInput');
const sInput        = $('sInput');
const emgBtn        = $('emgBtn');
const goalsWrap     = $('goalsWrap');
const swToggle      = $('swToggle');
const swTimeEl      = $('swTime');

