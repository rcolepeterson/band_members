// Six Degrees game engine + UI wiring (v1).
//
// Engine (pure, Node-testable): buildGraph, shortestPath, bandHops,
// randomBand, pickFairPair. Operates on the /api/bands payload shape
// ({ bands, members, memberships }).
//
// Browser UI (guarded by typeof document): wires the 6° entries in the
// burger sheet + desktop header to the game modal — two band fields with
// autocomplete, three play modes, matchup-first flow (both bands shown with
// a Connect button; the chain only renders on reveal), path banner or
// "No rawk found." results, dead-end drink rule + add-the-connector funnel,
// native share on wins, and an after-3-chains signup nudge for logged-out
// players.

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function buildGraph(payload) {
  const bands = new Map((payload.bands || []).map((b) => [b.id, b]));
  const members = new Map((payload.members || []).map((m) => [m.id, m]));
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const ms of payload.memberships || []) {
    if (ms.relation && ms.relation !== 'member_of') continue;
    if (!ms.band_id || !ms.member_id) continue;
    link('b:' + ms.band_id, 'm:' + ms.member_id);
  }
  return { bands, members, adj };
}

function nodeLabel(graph, id) {
  if (id.startsWith('b:')) return graph.bands.get(id.slice(2))?.name || id;
  return graph.members.get(id.slice(2))?.name || id;
}

// BFS shortest path between two band ids. Returns an array of
// { kind: 'band'|'member', id, name } alternating band -> member -> band,
// or null when unreachable.
export function shortestPath(graph, bandIdA, bandIdB) {
  const start = 'b:' + bandIdA;
  const goal = 'b:' + bandIdB;
  if (start === goal) return [{ kind: 'band', id: bandIdA, name: nodeLabel(graph, start) }];
  const prev = new Map([[start, null]]);
  const queue = [start];
  let found = false;
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (cur === goal) { found = true; break; }
    for (const nb of graph.adj.get(cur) || []) {
      if (!prev.has(nb)) { prev.set(nb, cur); queue.push(nb); }
    }
  }
  if (!found) return null;
  const ids = [];
  let cur = goal;
  while (cur) { ids.unshift(cur); cur = prev.get(cur); }
  return ids.map((id) => ({
    kind: id.startsWith('b:') ? 'band' : 'member',
    id: id.slice(2),
    name: nodeLabel(graph, id),
  }));
}

// Number of band-to-band steps in a path.
export function bandHops(path) {
  return path ? (path.length - 1) / 2 : Infinity;
}

export function randomBand(graph) {
  const ids = [...graph.bands.keys()];
  return ids[(Math.random() * ids.length) | 0];
}

// Pick a random pair whose shortest path is within [minHops, maxHops].
// Returns { a, b, path } or null after maxTries.
export function pickFairPair(graph, minHops = 3, maxHops = 5, maxTries = 400) {
  for (let i = 0; i < maxTries; i++) {
    const a = randomBand(graph);
    const b = randomBand(graph);
    if (a === b) continue;
    const path = shortestPath(graph, a, b);
    if (!path) continue;
    const hops = bandHops(path);
    if (hops >= minHops && hops <= maxHops) return { a, b, path };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signup nudge (pure helpers, Node-testable)
// ---------------------------------------------------------------------------

// The nudge fires exactly once, after the third chain reveal ("end of the
// match"). Copy is deliberately quiet: no hype, no exclamation marks.
export const NUDGE_THRESHOLD = 3;
export const NUDGE_COPY = "That's the match — sign up to save your chains and challenge a friend.";

export function nudgeShouldShow({ plays, done, signedIn } = {}) {
  if (signedIn || done) return false;
  return Number(plays) >= NUDGE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Browser UI
// ---------------------------------------------------------------------------

const isBrowser = typeof document !== 'undefined' && typeof window !== 'undefined';

let graphPromise = null;
function loadGraph() {
  if (!graphPromise) {
    graphPromise = fetch('/api/bands')
      .then((r) => { if (!r.ok) throw new Error('bands fetch failed'); return r.json(); })
      .then((payload) => buildGraph(payload));
  }
  return graphPromise;
}

function bandSubtitle(b) {
  const loc = [b.city, b.country].filter(Boolean).join(', ');
  return loc || b.genre || '';
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function initGameUI() {
  const modal = document.getElementById('game-modal');
  if (!modal) return;

  // The game lives in the burger menu only (featured 6° entry at the top of
  // the mobile sheet) so the header stays clean.
  const openBtns = [
    document.getElementById('mobile-game-open-btn'),
  ].filter(Boolean);
  const closeBtn = modal.querySelector('[data-game-close]');
  const backdrop = modal.querySelector('.game-modal-backdrop');
  const modeInputs = [...modal.querySelectorAll('input[name="game-mode"]')];
  const fieldA = document.getElementById('game-band-a');
  const fieldB = document.getElementById('game-band-b');
  const wrapB = document.getElementById('game-field-b-wrap');
  const randomizeBtn = document.getElementById('game-randomize');
  randomizeBtn.addEventListener('click', async () => {
    statusLine.textContent = 'Dealing…';
    result.innerHTML = '';
    try {
      const g = await loadGraph();
      const pair = pickFairPair(g);
      if (!pair) { statusLine.textContent = 'No rawk found.'; return; }
      selected.a = pair.a;
      selected.b = pair.b;
      fieldA.value = g.bands.get(pair.a).name;
      fieldB.value = g.bands.get(pair.b).name;
      statusLine.textContent = '';
      renderMatchup(g, pair.a, pair.b);
    } catch {
      statusLine.textContent = 'Could not load the tree. Check your connection and try again.';
    }
  });
  const runBtn = document.getElementById('game-run');
  const challengeBtn = document.getElementById('game-challenge-btn');
  const acceptBtn = document.getElementById('game-accept-btn');
  const result = document.getElementById('game-result');
  const statusLine = document.getElementById('game-status');

  const selected = { a: null, b: null };

  // --- signup nudge -------------------------------------------------------
  // Logged-out players get one calm card after their third chain reveal
  // ("end of the match"). Logged-in players never see it; once shown or
  // dismissed it never appears again. Not a popup — a quiet card under
  // the result.
  const NUDGE_PLAYS_KEY = 'sdr_chains_played';
  const NUDGE_DONE_KEY = 'sdr_nudge_done';

  function isSignedIn() {
    try {
      const raw = localStorage.getItem('bmft-user');
      if (!raw) return false;
      const p = JSON.parse(raw);
      return !!(p && typeof p.token === 'string' && p.token.length >= 8 && p.email);
    } catch { return false; }
  }

  function authToken() {
    try {
      const raw = localStorage.getItem('bmft-user');
      const p = raw && JSON.parse(raw);
      return p && typeof p.token === 'string' ? p.token : '';
    } catch { return ''; }
  }

  function myUserId() {
    try {
      const raw = localStorage.getItem('bmft-user');
      const p = raw && JSON.parse(raw);
      return p && typeof p.id === 'string' ? p.id : '';
    } catch { return ''; }
  }

  // Player handle ("battle name") — the privacy-safe name shown on
  // challenges and matches instead of the real name. null = unknown yet,
  // '' = signed out or none set.
  let myHandleCache = null;
  async function loadMyHandle() {
    if (!isSignedIn()) { myHandleCache = ''; return ''; }
    if (myHandleCache !== null) return myHandleCache;
    try {
      const res = await fetch('/api/me/handle', {
        headers: { authorization: 'Bearer ' + authToken() },
      });
      const data = await res.json().catch(() => ({}));
      myHandleCache = (res.ok && data.ok && data.handle) ? data.handle : '';
    } catch { myHandleCache = ''; }
    return myHandleCache;
  }

  // Inline battle-name picker. Rendered into the game result area so it
  // works identically in the burger modal and on /game/.
  function showHandlePicker({ title, subtitle, cta, onSaved }) {
    const card = el(`<div class="game-result-card">
      <div class="game-result-meta"><span class="game-hops"></span></div>
      <p class="game-invite-text"></p>
      <label class="game-invite-link-label">Battle name
        <input class="game-invite-link" type="text" maxlength="20" autocomplete="off"
               placeholder="e.g. rawker4821" />
      </label>
      <p class="game-empty-note"></p>
      <div class="game-result-actions"><button type="button" class="game-run-btn" data-save></button></div>
    </div>`);
    card.querySelector('.game-hops').textContent = title;
    card.querySelector('.game-invite-text').textContent = subtitle;
    const input = card.querySelector('input');
    const note = card.querySelector('.game-empty-note');
    const saveBtn = card.querySelector('[data-save]');
    saveBtn.textContent = cta;
    const save = async () => {
      const value = (input.value || '').trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(value)) {
        note.textContent = 'Use 3-20 letters, numbers, or underscores.';
        input.focus();
        return;
      }
      saveBtn.disabled = true;
      note.textContent = 'Saving…';
      try {
        const res = await fetch('/api/me/handle', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken() },
          body: JSON.stringify({ handle: value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok || !data.handle) {
          throw new Error((data && data.error) || 'could not save');
        }
        myHandleCache = data.handle;
        onSaved(data.handle);
      } catch (err) {
        note.textContent = (err && err.message) || 'Could not save. Try again.';
        saveBtn.disabled = false;
      }
    };
    saveBtn.addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    result.innerHTML = '';
    result.appendChild(card);
    setTimeout(() => input.focus(), 60);
  }

  // Runs fn only once the player has a battle name. First-timers get the
  // picker inline ("Pick your battle name"); everyone else sails through.
  async function withHandle(fn) {
    const h = await loadMyHandle();
    if (h) { await fn(); return; }
    statusLine.textContent = '';
    showHandlePicker({
      title: 'Pick your battle name',
      subtitle: 'This is the name opponents see on challenges and matches — not your real name.',
      cta: 'Save and continue',
      onSaved: () => { fn(); },
    });
  }

  function currentFormat() {
    const sel = document.getElementById('game-match-format');
    return (sel && sel.value) || 'quick';
  }

  function formatLabelFor(format) {
    return { best3: 'Best of 3', best5: 'Best of 5', best7: 'Best of 7',
             timed: 'Timed (10 min)', open: 'Open-ended' }[format] || 'Quick challenge';
  }

  function markNudgeDone() {
    try { localStorage.setItem(NUDGE_DONE_KEY, '1'); } catch { /* private mode */ }
  }

  function maybeShowNudge() {
    if (isSignedIn()) return;
    let plays = 0;
    let done = false;
    try {
      plays = Number(localStorage.getItem(NUDGE_PLAYS_KEY)) || 0;
      done = localStorage.getItem(NUDGE_DONE_KEY) === '1';
    } catch { /* private mode: plays stays 0, nudge never fires */ }
    const next = plays + 1;
    try { localStorage.setItem(NUDGE_PLAYS_KEY, String(next)); } catch { /* private mode */ }
    if (!nudgeShouldShow({ plays: next, done, signedIn: false })) return;
    markNudgeDone();
    const card = el(`<div class="game-nudge" role="note">
      <button type="button" class="game-nudge-close" aria-label="Dismiss">&times;</button>
      <p></p>
      <div class="game-result-actions"><button type="button" class="tool-chip" data-nudge-signup>Sign up</button></div>
    </div>`);
    card.querySelector('p').textContent = NUDGE_COPY;
    card.querySelector('.game-nudge-close').addEventListener('click', () => {
      markNudgeDone();
      card.remove();
    });
    card.querySelector('[data-nudge-signup]').addEventListener('click', () => {
      markNudgeDone();
      closeModal();
      // Same funnel as every other signup entry point — no parallel gate.
      if (typeof window.openSignupPopover === 'function') window.openSignupPopover();
      else document.getElementById('add-band-btn')?.click();
    });
    result.appendChild(card);
  }

  function openModal() {
    modal.hidden = false;
    document.body.classList.add('game-modal-open');
    loadGraph().catch(() => {
      statusLine.textContent = 'Could not load the tree. Check your connection and try again.';
    });
    setTimeout(() => fieldA.focus(), 50);
  }
  function closeModal() {
    modal.hidden = true;
    document.body.classList.remove('game-modal-open');
  }
  openBtns.forEach((b) => b.addEventListener('click', () => {
    document.getElementById('mobile-menu-sheet')?.setAttribute('hidden', '');
    document.getElementById('mobile-sheet-backdrop')?.setAttribute('hidden', '');
    openModal();
  }));
  closeBtn?.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // Deep link: ?game=1 (the QR on share cards) or ?game=<id> (a shared chain)
  // opens the game straight away. ?invite=<token> (a head-to-head challenge)
  // does the same and then loads the challenge. The lure only works if there
  // is no friction between tapping the link and playing.
  const inviteToken = (() => {
    try { return new URLSearchParams(window.location.search).get('invite') || ''; }
    catch (_) { return ''; }
  })();
  const matchToken = (() => {
    try { return new URLSearchParams(window.location.search).get('match') || ''; }
    catch (_) { return ''; }
  })();
  try {
    if (new URLSearchParams(window.location.search).has('game') || inviteToken || matchToken) openModal();
  } catch (_) {}

  function currentMode() {
    return (modeInputs.find((i) => i.checked) || {}).value || 'head-to-head';
  }

  function syncModeUI() {
    const mode = currentMode();
    // Daily Chain gets its own panel — no band fields, no run button.
    if (mode === 'daily') {
      document.getElementById('game-field-a-wrap').style.display = 'none';
      wrapB.style.display = 'none';
      randomizeBtn.style.display = 'none';
      runBtn.style.display = 'none';
      if (challengeBtn) challengeBtn.style.display = 'none';
      const formatWrap = document.getElementById('game-format-wrap');
      if (formatWrap) formatWrap.style.display = 'none';
      if (acceptBtn) acceptBtn.style.display = 'none';
      fieldA.disabled = true;
      result.innerHTML = '';
      statusLine.textContent = '';
      renderDailyPanel();
      return;
    }
    fieldA.disabled = false;
    // Solo: only band A is picked; the graph supplies band B.
    // Chaos: the graph supplies both; hide both fields, show randomize.
    document.getElementById('game-field-a-wrap').style.display = mode === 'chaos' ? 'none' : '';
    wrapB.style.display = mode === 'head-to-head' ? '' : 'none';
    randomizeBtn.style.display = mode === 'chaos' ? '' : 'none';
    runBtn.style.display = '';
    runBtn.textContent = mode === 'head-to-head' ? 'Set the matchup' : mode === 'solo' ? 'Challenge me' : 'Deal me a pair';
    // Remote head-to-head lives next to pass-and-play: challenging needs only
    // band A (your pick); the opponent picks band B on their own device.
    // Visible to logged-out players too — tapping it routes through sign-in,
    // which is the growth loop working as intended.
    // On the arena page, a format picker offers structured matches (best-of,
    // timed, open-ended); the burger modal stays quick-challenge only.
    if (challengeBtn) challengeBtn.style.display = mode === 'head-to-head' ? '' : 'none';
    const formatWrap = document.getElementById('game-format-wrap');
    const showFormat = isArenaPage() && mode === 'head-to-head' && !!formatWrap;
    if (formatWrap) formatWrap.style.display = showFormat ? '' : 'none';
    if (challengeBtn && mode === 'head-to-head') {
      challengeBtn.textContent = showFormat && currentFormat() !== 'quick' ? 'Start match' : 'Challenge a friend';
    }
    // The accept button only appears while answering an invite (see
    // handleInvite); a mode switch always stands it down.
    if (acceptBtn) acceptBtn.style.display = 'none';
    fieldA.disabled = false;
    result.innerHTML = '';
    statusLine.textContent = '';
  }
  modeInputs.forEach((i) => i.addEventListener('change', syncModeUI));
  // The format picker re-labels the challenge button (quick vs match).
  // Direct getElementById→addEventListener pair (kept adjacent) so
  // tests/mobile-toolbar-parity.test.mjs sees the dedicated handler —
  // though a <select> is not a .tool-chip, so the test does not require it.
  const formatSelDirect = document.getElementById('game-match-format');
  if (formatSelDirect) formatSelDirect.addEventListener('change', () => {
    if (challengeBtn && currentMode() === 'head-to-head') {
      challengeBtn.textContent = currentFormat() !== 'quick' ? 'Start match' : 'Challenge a friend';
    }
  });

  // --- Daily Chain -----------------------------------------------------------
  // The Wordle-style daily: one band pair per day, same for everyone. The
  // player builds the chain link-by-link from four multiple-choice options
  // per hop. The server is authoritative — option kinds never reach the
  // client, and hops/streaks/credits mutate server-side.
  let dailyStylesDone = false;
  function ensureDailyStyles() {
    if (dailyStylesDone) return;
    dailyStylesDone = true;
    const st = document.createElement('style');
    st.textContent = `
      .game-daily{margin-top:4px}
      .game-daily-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:0 0 4px}
      .game-daily-date{font-size:.85rem;color:#999}
      .game-daily-pair{font-size:1.05rem;font-weight:700;margin:4px 0 8px}
      .game-daily-pair .game-daily-arrow{color:#999;font-weight:400;margin:0 6px}
      .game-daily-econ{font-size:.85rem;color:#bbb;margin:0 0 10px}
      .game-daily-picks{display:flex;gap:6px;align-items:center;margin:8px 0;min-height:26px;flex-wrap:wrap}
      .game-daily-pick{width:20px;height:24px;flex:none}
      .game-daily-current{font-size:.9rem;color:#bbb;margin:8px 0 6px}
      .game-daily-current strong{color:#fff}
      .game-daily-options{display:grid;gap:8px;margin:6px 0 10px}
      .game-daily-option{text-align:left;padding:10px 12px;border:1px solid var(--color-border);border-radius:var(--radius-lg);background:transparent;color:inherit;font-size:.95rem;cursor:pointer}
      .game-daily-option:hover{border-color:rgba(82,174,182,.6)}
      .game-daily-option:disabled{opacity:.55;cursor:default}
      .game-daily-tools{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
      .game-daily-note{font-size:.8rem;color:#999;margin:6px 0}
      .game-daily-share{border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:12px;margin:12px 0 4px}
      .game-daily-share-picks{display:flex;gap:8px;margin:8px 0}
      .game-daily-share-pick{width:34px;height:40px}
      .game-daily-share-line{font-size:.95rem;margin:6px 0}
      .game-daily-archive{margin-top:12px}
      .game-daily-archive summary{cursor:pointer;font-size:.9rem;color:#bbb}
      .game-daily-archive-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--color-divider);font-size:.9rem}
      .game-daily-archive-row .game-daily-archive-date{color:#999;min-width:86px}
      .game-daily-archive-row .game-daily-archive-pair{flex:1}
    `;
    document.head.appendChild(st);
  }

  const DAILY_PICK_HEX = { gold: '#d4a017', robin: '#7fc9c7', black: '#2a2a2a' };
  function pickSvg(color, cls) {
    const hex = DAILY_PICK_HEX[color] || DAILY_PICK_HEX.black;
    const stroke = color === 'black' ? '#555' : 'rgba(0,0,0,.25)';
    return `<svg class="${cls}" viewBox="0 0 24 28" aria-hidden="true">` +
      `<path d="M12 2.5c-5.2 0-9.5 4-9.5 9.3 0 6 5.2 11.6 8.6 14.2.5.4 1.3.4 1.8 0 3.4-2.6 8.6-8.2 8.6-14.2C21.5 6.5 17.2 2.5 12 2.5z" ` +
      `fill="${hex}" stroke="${stroke}" stroke-width="1"/></svg>`;
  }

  let dailyRun = null;      // last run state from the server
  let dailyOptions = [];    // public options: [{id, name}]
  let dailyRevealArmed = false;

  async function dailyFetch(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken(), ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error((data && data.error) || `request failed (${res.status})`);
    }
    return data;
  }

  function renderDailyPanel() {
    ensureDailyStyles();
    if (!isSignedIn()) {
      renderDailyGate();
      return;
    }
    renderDailyBoard({ loading: true });
  }

  // Logged-out: the pair is the lure, playing needs sign-in.
  async function renderDailyGate() {
    result.innerHTML = '';
    const card = el(`<div class="game-result-card game-daily">
      <div class="game-daily-head"><span class="game-hops">Daily Chain</span><span class="game-daily-date"></span></div>
      <p class="game-daily-pair"></p>
      <p class="game-daily-note">One fresh chain every day — same for everyone. Sign in to play, keep your streak, and earn credits.</p>
      <div class="game-result-actions"><button type="button" class="game-run-btn" data-signin>Sign in to play</button></div>
    </div>`);
    result.appendChild(card);
    try {
      const res = await fetch('/api/game-daily');
      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || 'failed');
      card.querySelector('.game-daily-date').textContent = data.date || '';
      const a = document.createElement('span'); a.textContent = (data.band_a && data.band_a.name) || 'Band A';
      const arrow = document.createElement('span'); arrow.className = 'game-daily-arrow'; arrow.textContent = '→';
      const b = document.createElement('span'); b.textContent = (data.band_b && data.band_b.name) || 'Band B';
      const pair = card.querySelector('.game-daily-pair');
      pair.appendChild(a); pair.appendChild(arrow); pair.appendChild(b);
    } catch {
      card.querySelector('.game-daily-note').textContent = 'Could not load today\u2019s chain. Check your connection and try again.';
    }
    card.querySelector('[data-signin]').addEventListener('click', () => {
      if (isArenaPage()) {
        try { sessionStorage.setItem('sdr_pending_daily', '1'); } catch {}
        window.location.href = '/';
      } else if (typeof window.openSignupPopover === 'function') {
        try { sessionStorage.setItem('sdr_pending_daily', '1'); } catch {}
        window.openSignupPopover();
      } else {
        document.getElementById('add-band-btn')?.click();
      }
    });
  }

  async function renderDailyBoard({ loading = false, date } = {}) {
    result.innerHTML = '';
    const card = el(`<div class="game-result-card game-daily">
      <div class="game-daily-head"><span class="game-hops">Daily Chain</span><span class="game-daily-date"></span></div>
      <p class="game-daily-pair"></p>
      <p class="game-daily-econ"></p>
      <div class="game-daily-picks" aria-label="Your picks"></div>
      <div class="game-daily-current"></div>
      <div class="game-daily-options"></div>
      <div class="game-daily-tools"></div>
      <p class="game-daily-note"></p>
      <div class="game-daily-finish"></div>
      <details class="game-daily-archive"><summary>Past days</summary><div class="game-daily-archive-list"></div></details>
    </div>`);
    result.appendChild(card);
    if (loading) {
      card.querySelector('.game-daily-note').textContent = 'Dealing today\u2019s chain…';
    }
    try {
      const data = await dailyFetch('/api/game-daily/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'start', ...(date ? { date } : {}) }),
      });
      dailyRun = data.run;
      dailyOptions = data.options || [];
      paintDailyBoard(card);
    } catch (err) {
      const note = card.querySelector('.game-daily-note');
      if (err && /locked/.test(err.message)) {
        note.textContent = 'That day is locked. Unlock it from Past days below.';
      } else {
        note.textContent = err.message || 'Could not start the run.';
      }
    }
    wireDailyArchive(card);
  }

  function paintDailyBoard(card, completed) {
    const run = dailyRun;
    if (!run) return;
    const q = (sel) => card.querySelector(sel);
    q('.game-daily-date').textContent = run.chain_date || '';
    const pair = q('.game-daily-pair');
    pair.innerHTML = '';
    const mk = (t, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = t; return s; };
    pair.appendChild(mk(run.start_band.name));
    pair.appendChild(mk('→', 'game-daily-arrow'));
    pair.appendChild(mk(run.target.name));

    q('.game-daily-econ').textContent =
      `Streak ${run.streak} · ${run.credits} credits` +
      (run.freeze_count ? ` · ❄ ${run.freeze_count} Seattle Freeze${run.freeze_count === 1 ? '' : 's'}` : '');

    const picksRow = q('.game-daily-picks');
    picksRow.innerHTML = '';
    for (const p of run.picks) {
      const wrap = document.createElement('span');
      wrap.innerHTML = pickSvg(p.color, 'game-daily-pick');
      wrap.title = `${p.name} — ${p.kind === 'optimal' ? 'optimal' : p.kind === 'deadend' ? 'dead end' : 'valid'}`;
      picksRow.appendChild(wrap);
    }

    const note = q('.game-daily-note');
    const tools = q('.game-daily-tools');
    const optsBox = q('.game-daily-options');
    const finish = q('.game-daily-finish');
    optsBox.innerHTML = '';
    tools.innerHTML = '';
    finish.innerHTML = '';
    dailyRevealArmed = false;

    if (completed || run.status === 'complete') {
      q('.game-daily-current').textContent = `Connected in ${run.hops_used} hop${run.hops_used === 1 ? '' : 's'} (par ${run.par}).`;
      paintDailyShare(card, completed || {});
      return;
    }

    const cur = q('.game-daily-current');
    cur.innerHTML = '';
    cur.appendChild(mk('Now at: '));
    const strong = document.createElement('strong');
    strong.textContent = run.current_band.name;
    cur.appendChild(strong);

    for (const o of dailyOptions) {
      const btn = el('<button type="button" class="game-daily-option"></button>');
      btn.textContent = o.name;
      btn.dataset.optionId = o.id;
      btn.addEventListener('click', () => dailyPick(card, o.id, btn));
      optsBox.appendChild(btn);
    }

    const hintsLeft = run.hints_total - run.hints_used;
    if (hintsLeft > 0) {
      const elim = el('<button type="button" class="tool-chip">Eliminate one (−10)</button>');
      elim.addEventListener('click', () => dailyHint(card, 'eliminate'));
      const peek = el('<button type="button" class="tool-chip">Peek at a band (−10)</button>');
      peek.addEventListener('click', () => {
        dailyRevealArmed = true;
        note.textContent = 'Tap a band to check whether it\u2019s on the optimal path. Helpers never solve — this only narrows.';
      });
      tools.appendChild(elim);
      tools.appendChild(peek);
      note.textContent = `${hintsLeft} hint${hintsLeft === 1 ? '' : 's'} left today.`;
    } else {
      note.textContent = 'No hints left today.';
    }

    const last = run.picks[run.picks.length - 1];
    if (last && last.kind === 'deadend') {
      const esc = el('<button type="button" class="tool-chip">Dig out of the dead end (−50)</button>');
      esc.addEventListener('click', () => dailyEscape(card));
      tools.appendChild(esc);
      note.textContent = `Dead end — that hop burned. ${note.textContent}`;
    }

    const econ = el('<button type="button" class="tool-chip">Buy Seattle Freeze (100)</button>');
    econ.addEventListener('click', () => dailyBuyFreeze(card));
    tools.appendChild(econ);
  }

  async function dailyPick(card, optionId, btn) {
    const note = card.querySelector('.game-daily-note');
    if (dailyRevealArmed && btn) {
      // Peek: reveal whether this band is on the optimal path, no pick made.
      dailyRevealArmed = false;
      btn.disabled = true;
      try {
        const data = await dailyFetch('/api/game-daily/play', {
          method: 'POST',
          body: JSON.stringify({ action: 'hint', type: 'reveal', option_id: optionId }),
        });
        dailyRun = data.run;
        dailyOptions = data.options || [];
        paintDailyBoard(card);
        const yes = data.hint && data.hint.on_optimal_path;
        note.textContent = yes
          ? `${data.hint.option.name} is on the optimal path.`
          : `${data.hint.option.name} is not on the optimal path — scenic route at best.`;
      } catch (err) {
        btn.disabled = false;
        note.textContent = err.message;
      }
      return;
    }
    card.querySelectorAll('.game-daily-option').forEach((b) => { b.disabled = true; });
    try {
      const data = await dailyFetch('/api/game-daily/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'pick', option_id: optionId }),
      });
      dailyRun = data.run;
      dailyOptions = data.options || [];
      if (data.completed) {
        paintDailyBoard(card, data.completed);
      } else {
        paintDailyBoard(card);
        if (data.picked && data.picked.deadend) {
          card.querySelector('.game-daily-note').textContent =
            'Dead end — that hop burned, but the run continues.';
        }
      }
    } catch (err) {
      note.textContent = err.message;
      card.querySelectorAll('.game-daily-option').forEach((b) => { b.disabled = false; });
    }
  }

  async function dailyHint(card, type) {
    const note = card.querySelector('.game-daily-note');
    try {
      const data = await dailyFetch('/api/game-daily/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'hint', type }),
      });
      dailyRun = data.run;
      dailyOptions = data.options || [];
      paintDailyBoard(card);
      if (data.hint && data.hint.eliminated) {
        card.querySelector('.game-daily-note').textContent =
          `${data.hint.eliminated.name} is out — not the way through.`;
      }
    } catch (err) {
      note.textContent = err.message;
    }
  }

  async function dailyEscape(card) {
    const note = card.querySelector('.game-daily-note');
    try {
      const data = await dailyFetch('/api/game-daily/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'escape' }),
      });
      dailyRun = data.run;
      dailyOptions = data.options || [];
      paintDailyBoard(card);
      card.querySelector('.game-daily-note').textContent =
        `Dug out — ${data.escaped.name} is off your trail.`;
    } catch (err) {
      note.textContent = err.message;
    }
  }

  async function dailyBuyFreeze(card) {
    const note = card.querySelector('.game-daily-note');
    try {
      const data = await dailyFetch('/api/game-credits', {
        method: 'POST',
        body: JSON.stringify({ action: 'buy_freeze' }),
      });
      dailyRun = { ...dailyRun, credits: data.credits, freeze_count: data.freeze_count, streak: data.streak };
      paintDailyBoard(card);
      card.querySelector('.game-daily-note').textContent =
        'Seattle Freeze stocked — it auto-burns if you miss exactly one day.';
    } catch (err) {
      note.textContent = err.message;
    }
  }

  function paintDailyShare(card, completed) {
    const finish = card.querySelector('.game-daily-finish');
    const picks = completed.picks && completed.picks.length ? completed.picks : dailyRun.picks;
    const share = el(`<div class="game-daily-share">
      <div class="game-daily-share-picks"></div>
      <p class="game-daily-share-line"></p>
      <p class="game-daily-note"></p>
      <div class="game-result-actions"><button type="button" class="tool-chip" data-copy>Copy share text</button></div>
    </div>`);
    const row = share.querySelector('.game-daily-share-picks');
    for (const p of picks) {
      const wrap = document.createElement('span');
      wrap.innerHTML = pickSvg(p.color, 'game-daily-share-pick');
      wrap.title = p.name;
      row.appendChild(wrap);
    }
    const hops = completed.hops_used != null ? completed.hops_used : dailyRun.hops_used;
    const par = dailyRun.par;
    const streak = completed.streak != null ? completed.streak : dailyRun.streak;
    share.querySelector('.game-daily-share-line').textContent =
      `I connected the constellation in ${hops} hops (par ${par}). Streak ${streak}.`;
    share.querySelector('.game-daily-note').textContent =
      'Gold is optimal, robin\u2019s egg is valid, black is lost in space.';
    const copyBtn = share.querySelector('[data-copy]');
    copyBtn.addEventListener('click', async () => {
      const text = completed.share_text ||
        `Daily Chain ${dailyRun.chain_date} — ${hops} hops (par ${par}), streak ${streak}. Play: https://sixdegreesofrock.com/game/`;
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy share text'; }, 2000);
      } catch {
        copyBtn.textContent = 'Copy failed — long-press to copy';
      }
    });
    if (completed.freeze_used) {
      const fz = document.createElement('p');
      fz.className = 'game-daily-note';
      fz.textContent = 'A Seattle Freeze bridged your missed day — streak intact.';
      share.appendChild(fz);
    }
    finish.appendChild(share);
  }

  function wireDailyArchive(card) {
    const details = card.querySelector('.game-daily-archive');
    const list = card.querySelector('.game-daily-archive-list');
    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      list.innerHTML = '<p class="game-daily-note">Loading…</p>';
      try {
        const data = await dailyFetch('/api/game-daily/archive');
        list.innerHTML = '';
        if (!data.days.length) {
          list.innerHTML = '<p class="game-daily-note">No past days yet — the archive starts tomorrow.</p>';
          return;
        }
        for (const d of data.days) {
          const row = el(`<div class="game-daily-archive-row">
            <span class="game-daily-archive-date"></span>
            <span class="game-daily-archive-pair"></span>
            <span class="game-daily-archive-act"></span>
          </div>`);
          row.querySelector('.game-daily-archive-date').textContent = d.date;
          row.querySelector('.game-daily-archive-pair').textContent =
            `${d.band_a} → ${d.band_b}${d.completed ? ' ✓' : ''}`;
          const act = row.querySelector('.game-daily-archive-act');
          if (d.completed || d.unlocked) {
            const play = el('<button type="button" class="tool-chip">Play</button>');
            play.addEventListener('click', () => renderDailyBoard({ date: d.date }));
            act.appendChild(play);
          } else {
            const unlock = el('<button type="button" class="tool-chip">Unlock (75)</button>');
            unlock.addEventListener('click', async () => {
              try {
                await dailyFetch('/api/game-daily/archive', {
                  method: 'POST',
                  body: JSON.stringify({ date: d.date }),
                });
                renderDailyBoard({ date: d.date });
              } catch (err) {
                card.querySelector('.game-daily-note').textContent = err.message;
              }
            });
            act.appendChild(unlock);
          }
          list.appendChild(row);
        }
      } catch (err) {
        list.innerHTML = `<p class="game-daily-note">${err.message}</p>`;
        loaded = false;
      }
    });
  }

  // Resume a daily run interrupted by sign-in (same pattern as challenges).
  (function resumePendingDaily() {
    let pending = null;
    try { pending = sessionStorage.getItem('sdr_pending_daily'); } catch {}
    if (!pending || !isSignedIn()) return;
    try { sessionStorage.removeItem('sdr_pending_daily'); } catch {}
    openModal();
    const dailyInput = [...document.querySelectorAll('input[name="game-mode"]')].find((i) => i.value === 'daily');
    if (dailyInput && !dailyInput.disabled) {
      dailyInput.checked = true;
      syncModeUI();
    }
  })();

  // --- autocomplete ---
  function wireAutocomplete(input, key) {
    const list = document.createElement('div');
    list.className = 'game-ac-list';
    list.hidden = true;
    input.parentElement.appendChild(list);

    let items = [];
    input.addEventListener('input', async () => {
      selected[key] = null;
      // A new pick invalidates whatever matchup/chain is showing — clear it
      // so no stale result lingers under the fresh typing.
      result.innerHTML = '';
      statusLine.textContent = '';
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { list.hidden = true; return; }
      try {
        const g = await loadGraph();
        items = [...g.bands.values()]
          .filter((b) => b.name.toLowerCase().includes(q))
          .slice(0, 8);
      } catch { items = []; }
      list.innerHTML = '';
      if (!items.length) { list.hidden = true; return; }
      for (const b of items) {
        const sub = bandSubtitle(b);
        const row = el(`<button type="button" class="game-ac-item"><span class="game-ac-name"></span>${sub ? '<span class="game-ac-sub"></span>' : ''}</button>`);
        row.querySelector('.game-ac-name').textContent = b.name;
        if (sub) row.querySelector('.game-ac-sub').textContent = sub;
        row.addEventListener('click', () => {
          selected[key] = b.id;
          input.value = b.name;
          list.hidden = true;
        });
        list.appendChild(row);
      }
      list.hidden = false;
    });
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  }
  wireAutocomplete(fieldA, 'a');
  wireAutocomplete(fieldB, 'b');


  runBtn.addEventListener('click', async () => {
    const mode = currentMode();
    result.innerHTML = '';
    statusLine.textContent = 'Running the chain…';
    try {
      const g = await loadGraph();
      let a = selected.a;
      let b = selected.b;
      if (mode === 'solo') {
        if (!a) { statusLine.textContent = 'Pick a band first.'; return; }
        // Graph picks a fair opponent: reachable in 3–5 hops.
        let pair = null;
        for (let i = 0; i < 60 && !pair; i++) {
          const cand = randomBand(g);
          if (cand === a) continue;
          const p = shortestPath(g, a, cand);
          const hops = bandHops(p);
          if (p && hops >= 3 && hops <= 5) pair = { b: cand, path: p };
        }
        if (!pair) { statusLine.textContent = 'No rawk found.'; return; }
        b = pair.b;
        selected.b = b;
      }
      if (!a || !b) { statusLine.textContent = 'Pick both bands first.'; return; }
      if (a === b) { statusLine.textContent = 'Pick two different bands.'; return; }
      statusLine.textContent = '';
      // Matchup first: show both bands and let the player sit with it.
      // The chain only runs when they hit Connect.
      renderMatchup(g, a, b);
    } catch {
      statusLine.textContent = 'Could not load the tree. Check your connection and try again.';
    }
  });

  // --- remote head-to-head -----------------------------------------------
  // Pass-and-play ("Set the matchup") stays untouched. Remote play mints a
  // challenge on the server: you pick band A, the opponent gets a link and
  // picks band B on their own phone. Quiet by design — no emails; the
  // "Your challenges" list below is how anyone learns a challenge moved.

  function bandName(g, ref) {
    return (g && g.bands.get(ref) && g.bands.get(ref).name) || ref;
  }

  // --- invite dialog ------------------------------------------------------
  // A proper dialog for sharing a challenge/match invite: the matchup, the
  // link visible and selectable, Copy + native Share + Done. Replaces the
  // old bare "invite link copied" toast Aaron found abrupt. Styles are
  // injected once so both the burger modal and the arena page get them.
  let inviteDialogStylesDone = false;
  function ensureInviteDialogStyles() {
    if (inviteDialogStylesDone) return;
    inviteDialogStylesDone = true;
    const st = document.createElement('style');
    st.textContent = `
      .game-invite-dialog{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);padding:12px}
      .game-invite-dialog-card{background:#141414;border:1px solid #2a2a2a;border-radius:12px;max-width:420px;width:100%;max-height:92vh;overflow:auto;padding:14px}
      .game-invite-dialog-card .game-result-meta{margin-bottom:6px}
      .game-invite-matchup{font-size:.95rem;font-weight:600;margin:0 0 8px}
      .game-invite-link-label{display:block;font-size:.78rem;color:#999;margin-bottom:8px}
      .game-invite-link{display:block;width:100%;margin-top:4px;padding:8px;font-size:.82rem;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:8px;color:#eee}
      .game-invite-dialog-card .game-result-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
    `;
    document.head.appendChild(st);
  }

  function showInviteDialog({ matchup, inviteUrl, shareText }) {
    ensureInviteDialogStyles();
    const dlg = el(`<div class="game-invite-dialog" role="dialog" aria-modal="true" aria-label="Share your invite">
      <div class="game-invite-dialog-card">
        <div class="game-result-meta"><span class="game-hops">Invite ready</span></div>
        <p class="game-invite-matchup"></p>
        <label class="game-invite-link-label">Invite link
          <input class="game-invite-link" type="text" readonly />
        </label>
        <div class="game-result-actions">
          <button type="button" class="game-run-btn" data-copy>Copy link</button>
          <button type="button" class="tool-chip" data-share>Share…</button>
          <button type="button" class="tool-chip" data-close>Done</button>
        </div>
      </div>
    </div>`);
    dlg.querySelector('.game-invite-matchup').textContent = matchup;
    const input = dlg.querySelector('.game-invite-link');
    input.value = inviteUrl;
    const selectLink = () => { input.focus(); input.select(); };
    input.addEventListener('focus', selectLink);
    input.addEventListener('click', selectLink);
    const close = () => dlg.remove();
    dlg.querySelector('[data-close]').addEventListener('click', close);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    dlg.querySelector('[data-copy]').addEventListener('click', async () => {
      const okCopy = await navigator.clipboard.writeText(inviteUrl).then(() => true).catch(() => false);
      statusLine.textContent = okCopy
        ? 'Invite link copied — send it to your opponent.'
        : 'Copy failed — long-press the link to copy it.';
    });
    dlg.querySelector('[data-share]').addEventListener('click', async () => {
      const shareData = { title: 'Six Degrees of Rock — head-to-head', text: shareText, url: inviteUrl };
      const canNativeShare = typeof navigator.share === 'function' &&
        (typeof navigator.canShare !== 'function' || navigator.canShare(shareData));
      if (canNativeShare) {
        try {
          await navigator.share(shareData);
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return; // user dismissed the sheet
        }
      }
      const okCopy = await navigator.clipboard.writeText(`${shareText} ${inviteUrl}`).then(() => true).catch(() => false);
      statusLine.textContent = okCopy
        ? 'Link copied — paste it to your opponent.'
        : 'Copy failed — long-press the link above to copy it.';
    });
    document.body.appendChild(dlg);
    setTimeout(selectLink, 60);
  }

  // POST /api/game-challenge and show the invite dialog. Shared by the
  // challenge button and one-tap rematches.
  async function createCasualChallenge(bandA) {
    // Battle name first: the picker shows inline only when the player
    // doesn't have one yet.
    await withHandle(async () => {
    statusLine.textContent = 'Making your invite…';
    try {
      const res = await fetch('/api/game-challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken() },
        body: JSON.stringify({ band_a: bandA }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.inviteUrl) throw new Error((data && data.error) || 'request failed');
      const g = await loadGraph();
      statusLine.textContent = '';
      showInviteDialog({
        matchup: `${bandName(g, bandA)} vs ?`,
        inviteUrl: data.inviteUrl,
        shareText: `Head-to-head: I picked ${bandName(g, bandA)}. Think you can stump me?`,
      });
      loadChallenges();
    } catch (err) {
      statusLine.textContent = (err && err.message) || 'Could not make the invite. Check your connection and try again.';
    }
    });
  }

  function setHeadToHead(a, b, g) {
    const hth = modeInputs.find((i) => i.value === 'head-to-head');
    if (hth) { hth.checked = true; syncModeUI(); }
    selected.a = a || null;
    selected.b = b || null;
    fieldA.value = a ? bandName(g, a) : '';
    fieldB.value = b ? bandName(g, b) : '';
  }

  // Direct getElementById→addEventListener pair (kept adjacent) so
  // tests/mobile-toolbar-parity.test.mjs sees the dedicated handler.
  const challengeBtnHandler = document.getElementById('game-challenge-btn');
  if (challengeBtnHandler) challengeBtnHandler.addEventListener('click', async () => {
    if (!isSignedIn()) {
      // Stash the pick so sign-in (which may reload the page via OAuth)
      // resumes right back here with the band still selected, instead of
      // dumping the player at the graph.
      try { sessionStorage.setItem('sdr_pending_challenge', JSON.stringify({ band: selected.a || null })); } catch {}
      if (typeof window.openSignupPopover === 'function' && !isArenaPage()) window.openSignupPopover();
      else if (isArenaPage()) window.location.href = '/';
      else document.getElementById('add-band-btn')?.click();
      return;
    }
    if (currentMode() !== 'head-to-head') return;
    if (!selected.a) { statusLine.textContent = 'Pick your band first.'; fieldA.focus(); return; }
    // Arena page with a match format selected -> structured match.
    // Everywhere else -> the casual quick challenge.
    if (isArenaPage() && currentFormat() !== 'quick') {
      await createMatch(currentFormat(), selected.a);
      return;
    }
    await createCasualChallenge(selected.a);
  });

  // POST /api/game-match and show the invite dialog.
  async function createMatch(format, bandA) {
    await withHandle(async () => {
    statusLine.textContent = 'Starting your match…';
    try {
      const res = await fetch('/api/game-match', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken() },
        body: JSON.stringify({ format, band_a: bandA }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.inviteUrl) throw new Error((data && data.error) || 'request failed');
      const g = await loadGraph();
      statusLine.textContent = '';
      const label = formatLabelFor(format);
      showInviteDialog({
        matchup: `${label} — you served ${bandName(g, bandA)}`,
        inviteUrl: data.inviteUrl,
        shareText: `Six Degrees match (${label}): I served ${bandName(g, bandA)}. Think you can stump me?`,
      });
      loadMatches();
    } catch (err) {
      statusLine.textContent = (err && err.message) || 'Could not start the match. Check your connection and try again.';
    }
    });
  }

  function isArenaPage() {
    try { return /(^|\/)game\/?$/.test(window.location.pathname); }
    catch (_) { return false; }
  }

  async function isMyChallenge(token) {
    try {
      const res = await fetch('/api/game-challenges', { headers: { authorization: 'Bearer ' + authToken() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return false;
      return (data.sent || []).some((c) => c.token === token);
    } catch { return false; }
  }

  // "Already claimed" card: a spectator opened an invite/match link whose
  // opponent slot is taken. Shows who claimed it and offers a fresh start —
  // the link is stripped from the URL so a reload doesn't reopen it.
  function renderClaimedCard({ claimedBy, kind, token, g }) {
    const card = el(`<div class="game-result-card">
      <div class="game-result-meta"><span class="game-hops">Already claimed</span></div>
      <p class="game-invite-text"></p>
      <div class="game-result-actions"><button type="button" class="game-run-btn" data-start>Start your own</button></div>
    </div>`);
    card.querySelector('.game-invite-text').textContent =
      `${claimedBy || 'Someone'} already claimed this one — it's taken. Start your own and put them on notice.`;
    card.querySelector('[data-start]').addEventListener('click', () => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('invite');
        url.searchParams.delete('match');
        window.history.replaceState(null, '', url.pathname + url.search);
      } catch {}
      if (g) setHeadToHead(null, null, g);
      fieldA.disabled = false;
      if (acceptBtn) acceptBtn.style.display = 'none';
      runBtn.style.display = '';
      syncModeUI();
      statusLine.textContent = 'Pick a band, then Challenge a friend.';
      modal.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => fieldA.focus(), 300);
    });
    result.innerHTML = '';
    result.appendChild(card);
    statusLine.textContent = '';
  }

  async function handleInvite(token) {
    statusLine.textContent = 'Loading the challenge…';
    let data;
    try {
      const res = await fetch('/api/game-challenge?token=' + encodeURIComponent(token));
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error((data && data.error) || 'not found');
    } catch {
      statusLine.textContent = 'That invite didn\u2019t land. Ask your challenger for a fresh one.';
      return;
    }
    statusLine.textContent = '';
    const g = await loadGraph().catch(() => null);
    const nameA = bandName(g, data.band_a);

    // Answered already — the two players can reveal it. A spectator who
    // opened a claimed link (e.g. a feed-shared invite) gets the claimed
    // message and a nudge to start their own instead.
    if (data.status === 'answered' && data.band_b) {
      const viewerIsPlayer = data.you_are === 'challenger' || data.you_are === 'invitee';
      if (!viewerIsPlayer) {
        renderClaimedCard({ claimedBy: data.invitee_handle, kind: 'challenge', token, g });
        return;
      }
      if (g) { setHeadToHead(data.band_a, data.band_b, g); renderMatchup(g, data.band_a, data.band_b); }
      else { statusLine.textContent = 'Could not load the tree. Check your connection and try again.'; }
      return;
    }

    if (!isSignedIn()) {
      // The lure before the gate: who challenged you, and with what.
      const card = el(`<div class="game-result-card">
        <div class="game-result-meta"><span class="game-hops">Head-to-head challenge</span></div>
        <p class="game-invite-text"></p>
        <div class="game-result-actions"><button type="button" class="game-run-btn" data-signin>Sign in to accept</button></div>
      </div>`);
      card.querySelector('.game-invite-text').textContent =
        `${data.challenger_handle || 'Someone'} picked ${nameA} and wants to stump you. Sign in to pick your band.`;
      card.querySelector('[data-signin]').addEventListener('click', () => {
        if (isArenaPage()) {
          // The arena has no signup UI of its own — bounce to the main page
          // with the invite intact; after sign-in the modal opens on it.
          window.location.href = '/?invite=' + encodeURIComponent(token);
        } else if (typeof window.openSignupPopover === 'function') {
          window.openSignupPopover();
        } else {
          document.getElementById('add-band-btn')?.click();
        }
      });
      result.innerHTML = '';
      result.appendChild(card);
      return;
    }

    if (await isMyChallenge(token)) {
      // Your own link, opened by you — the waiting room.
      const card = el(`<div class="game-result-card">
        <div class="game-result-meta"><span class="game-hops">Waiting on your opponent</span></div>
        <p class="game-invite-text"></p>
        <div class="game-result-actions"><button type="button" class="tool-chip" data-copy>Copy invite link</button></div>
      </div>`);
      card.querySelector('.game-invite-text').textContent =
        `You picked ${nameA}. Your opponent hasn't answered yet — the moment they do, it shows up under Your challenges.`;
      card.querySelector('[data-copy]').addEventListener('click', async () => {
        const url = `${window.location.origin}/game/?invite=${encodeURIComponent(token)}`;
        const okCopy = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
        statusLine.textContent = okCopy ? 'Invite link copied.' : url;
      });
      result.innerHTML = '';
      result.appendChild(card);
      return;
    }

    // The accept view: band A is locked (the challenger's pick, visible —
    // open picks), you pick band B.
    setHeadToHead(data.band_a, null, g);
    fieldA.disabled = true;
    if (acceptBtn) {
      acceptBtn.style.display = '';
      acceptBtn.onclick = () => acceptChallenge(token);
    }
    runBtn.style.display = 'none';
    if (challengeBtn) challengeBtn.style.display = 'none';
    statusLine.textContent = `${data.challenger_handle || 'Your challenger'} picked ${nameA}. Now pick yours — try to stump them.`;
    setTimeout(() => fieldB.focus(), 60);
  }

  async function acceptChallenge(token) {
    if (!selected.b) { statusLine.textContent = 'Pick your band first.'; fieldB.focus(); return; }
    statusLine.textContent = 'Locking in your pick…';
    try {
      const res = await fetch('/api/game-challenge/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken() },
        body: JSON.stringify({ token, band_b: selected.b }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const err = new Error((data && data.error) || 'request failed');
        err.status = res.status;
        err.claimedBy = data.claimed_by;
        throw err;
      }
      statusLine.textContent = '';
      runBtn.style.display = '';
      if (acceptBtn) acceptBtn.style.display = 'none';
      fieldA.disabled = false;
      const g = await loadGraph();
      renderMatchup(g, data.band_a, data.band_b);
      loadChallenges();
    } catch (err) {
      // 409: someone else claimed the open challenge first (feed-shared
      // link, two tappers). Show the claimed message, not an error.
      if (err && err.status === 409) {
        renderClaimedCard({ claimedBy: err.claimedBy, kind: 'challenge', token, g });
        return;
      }
      statusLine.textContent = (err && err.message) || 'Could not save your pick. Try again.';
    }
  }

  // --- your challenges (the quiet status view; arena page only) ---------------
  async function loadChallenges() {

  // --- structured match play ---------------------------------------------
  // A match is a series of serves. On your serve you pick band A; your
  // opponent defends by picking band B; the revealed chain's hop count is
  // your score for the round. Higher hops takes the round; tie rounds are
  // replayed. Challenger leads odd rounds, tennis-style.

  let matchStylesDone = false;
  function ensureMatchStyles() {
    if (matchStylesDone) return;
    matchStylesDone = true;
    const st = document.createElement('style');
    st.textContent = `
      .game-match-score{margin:12px 0}
      .game-match-score-line{font-size:1.25rem;font-weight:700}
      .game-match-winner{margin:8px 0 0;font-weight:600}
      .game-match-history{margin-top:12px}
      .game-match-history-title{font-size:.9rem;text-transform:uppercase;letter-spacing:.05em;color:#999;margin:0 0 8px}
      .game-match-turn{margin:12px 0}
      .game-match-turn .game-run-btn{margin-top:8px}
    `;
    document.head.appendChild(st);
  }

  function opponentName(m, myId) {
    if (myId && m.challenger_id === myId) return m.invitee_handle || 'Your opponent';
    if (myId && m.invitee_id === myId) return m.challenger_handle || 'Your opponent';
    return m.challenger_handle || 'Your challenger';
  }

  function scoreLine(m, myId) {
    const myWins = (myId && m.challenger_id === myId) ? m.challenger_round_wins : m.invitee_round_wins;
    const opWins = (myId && m.challenger_id === myId) ? m.invitee_round_wins : m.challenger_round_wins;
    return `You ${myWins} — ${opWins} ${opponentName(m, myId)}`;
  }

  function roundHistoryHtml(m, g) {
    if (!m.plays.length) return '<p class="game-empty-note">No rounds played yet.</p>';
    return m.plays.map((p) => {
      const roundPlays = m.plays.filter((x) => x.round === p.round);
      const maxHops = Math.max(...roundPlays.map((x) => x.hops));
      const decided = roundPlays.length >= 2 && !roundPlays.every((x) => x.hops === maxHops);
      const takesIt = decided && p.hops === maxHops;
      return `<div class="game-challenge-row"><span>Round ${p.round}: ${bandName(g, p.band_a)} vs ${bandName(g, p.band_b)} — ${p.hops} hops${takesIt ? ' · takes the round' : ''}</span></div>`;
    }).join('');
  }

  async function handleMatch(token) {
    statusLine.textContent = 'Loading the match…';
    let m;
    try {
      const res = await fetch('/api/game-match?token=' + encodeURIComponent(token));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.match) throw new Error((data && data.error) || 'not found');
      m = data.match;
    } catch (err) {
      statusLine.textContent = 'That match didn\u2019t land. Ask your challenger for a fresh link.';
      return;
    }
    statusLine.textContent = '';
    const g = await loadGraph().catch(() => null);
    if (!g) { statusLine.textContent = 'Could not load the tree. Check your connection and try again.'; return; }

    // Logged out: lure them in. The arena has no signup UI, so bounce to the
    // main page with the match link intact (same pattern as invites).
    if (!isSignedIn()) {
      const card = el(`<div class="game-result-card">
        <div class="game-result-meta"><span class="game-hops"></span></div>
        <p class="game-invite-text"></p>
        <div class="game-result-actions"><button type="button" class="game-run-btn" data-signin>Sign in to play</button></div>
      </div>`);
      card.querySelector('.game-hops').textContent = `${formatLabelFor(m.format)} match`;
      const servedBand = m.pending && m.pending.band_a ? bandName(g, m.pending.band_a) : 'their band';
      card.querySelector('.game-invite-text').textContent =
        `${m.challenger_handle || 'Someone'} started a match and served ${servedBand}. Sign in to pick your band and defend.`;
      card.querySelector('[data-signin]').addEventListener('click', () => {
        if (isArenaPage()) {
          window.location.href = '/?match=' + encodeURIComponent(token);
        } else if (typeof window.openSignupPopover === 'function') {
          window.openSignupPopover();
        } else {
          document.getElementById('add-band-btn')?.click();
        }
      });
      result.innerHTML = '';
      result.appendChild(card);
      return;
    }

    // Spectator of a claimed match (feed-shared link, someone else took the
    // opponent slot): the claimed message, not the match view.
    if (m.invitee_id && m.you_are === 'spectator') {
      renderClaimedCard({ claimedBy: m.invitee_handle, kind: 'match', token, g });
      return;
    }

    renderMatchView(m, g, token);
  }

  function renderMatchView(m, g, token) {
    ensureMatchStyles();
    const myId = myUserId();
    const opp = opponentName(m, myId);
    const isMyServe = m.pending && m.pending.server_id === myId;
    const isMyDefend = m.pending && m.pending.kind === 'defend' && m.pending.server_id !== myId;
    const waitingOnOpp = m.pending && !isMyServe && !isMyDefend && m.status === 'active';

    const card = el(`<div class="game-result-card">
      <div class="game-result-meta">
        <span class="game-hops"></span>
        <span class="game-band-names"></span>
      </div>
      <div class="game-match-score"></div>
      <div class="game-match-turn"></div>
      <div class="game-match-history"></div>
      <div class="game-result-actions">
        <button type="button" class="tool-chip" data-refresh>Refresh</button>
      </div>
    </div>`);
    card.querySelector('.game-hops').textContent = formatLabelFor(m.format);
    card.querySelector('.game-band-names').textContent = m.status === 'complete' ? 'Final' : `Round ${m.current_round}`;
    card.querySelector('.game-match-score').innerHTML =
      `<div class="game-match-score-line"></div>` +
      (m.status === 'complete' && m.winner_id
        ? `<p class="game-match-winner"></p>` : '');
    card.querySelector('.game-match-score-line').textContent = scoreLine(m, myId);
    if (m.status === 'complete' && m.winner_id) {
      card.querySelector('.game-match-winner').textContent =
        m.winner_id === myId ? 'You take the match. \uD83C\uDFC6' : `${opp} takes the match.`;
    }

    const turn = card.querySelector('.game-match-turn');
    if (m.status === 'complete') {
      // Nothing to do — the history below tells the story.
    } else if (m.status === 'open') {
      turn.innerHTML = `<p class="game-empty-note">Waiting for ${opp} to answer your serve…</p>`;
    } else if (isMyDefend) {
      turn.innerHTML = `<p><strong>${opp}</strong> served <strong class="js-served"></strong>. Pick your band to defend — the chain's hop count is their score, yours is next.</p>`;
      turn.querySelector('.js-served').textContent = bandName(g, m.pending.band_a);
      // Reuse band B's picker for the defend; the Defend button posts the play.
      setHeadToHead(m.pending.band_a, null, g);
      const btn = el(`<button type="button" class="game-run-btn" data-defend>Defend</button>`);
      btn.addEventListener('click', async () => {
        if (!selected.b) { statusLine.textContent = 'Pick your band first.'; fieldB.focus(); return; }
        statusLine.textContent = 'Scoring your defend…';
        try {
          const path = await findPath(g, m.pending.band_a, selected.b);
          if (!path) throw new Error('no chain found between those bands');
          const res = await fetch('/api/game-match/play', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken() },
            body: JSON.stringify({ token, band_b: selected.b, hops: path.hops }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            const err = new Error((data && data.error) || 'request failed');
            err.status = res.status;
            err.claimedBy = data.claimed_by;
            throw err;
          }
          statusLine.textContent = '';
          renderMatchView(data.match, g, token);
          loadMatches();
        } catch (err) {
          // 409: someone else defended first and claimed the open match.
          if (err && err.status === 409) {
            renderClaimedCard({ claimedBy: err.claimedBy, kind: 'match', token, g });
            return;
          }
          statusLine.textContent = (err && err.message) || 'Could not save your defend. Try again.';
        }
      });
      turn.appendChild(btn);
    } else if (isMyServe) {
      turn.innerHTML = `<p>Your serve — pick a band that's hard to connect to. The chain's hop count is your score.</p>`;
      setHeadToHead(null, null, g);
      const btn = el(`<button type="button" class="game-run-btn" data-serve>Serve</button>`);
      btn.addEventListener('click', async () => {
        if (!selected.a) { statusLine.textContent = 'Pick your band first.'; fieldA.focus(); return; }
        statusLine.textContent = 'Serving…';
        try {
          const res = await fetch('/api/game-match/serve', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken() },
            body: JSON.stringify({ token, band_a: selected.a }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error((data && data.error) || 'request failed');
          statusLine.textContent = '';
          renderMatchView(data.match, g, token);
          loadMatches();
        } catch (err) {
          statusLine.textContent = (err && err.message) || 'Could not save your serve. Try again.';
        }
      });
      turn.appendChild(btn);
    } else if (waitingOnOpp) {
      turn.innerHTML = `<p class="game-empty-note">Waiting on ${opp}…</p>`;
    }

    card.querySelector('.game-match-history').innerHTML =
      `<h3 class="game-match-history-title">Rounds</h3>` + roundHistoryHtml(m, g);
    card.querySelector('[data-refresh]').addEventListener('click', () => handleMatch(token));

    result.innerHTML = '';
    result.appendChild(card);
  }

  async function loadMatches() {
    const wrap = document.querySelector('[data-matches-wrap]');
    const list = document.getElementById('game-matches');
    if (!wrap || !list) return;
    if (!isSignedIn()) { wrap.hidden = true; return; }
    let data;
    try {
      const res = await fetch('/api/game-matches', {
        headers: { authorization: 'Bearer ' + authToken() },
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return;
    } catch { return; }
    const items = [...(data.sent || []).map((m) => ({ ...m, mine: true })),
                   ...(data.received || []).map((m) => ({ ...m, mine: false }))];
    if (!items.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    list.innerHTML = '';
    const myId = myUserId();
    for (const m of items) {
      const myWins = (m.challenger_id === myId) ? m.challenger_round_wins : m.invitee_round_wins;
      const opWins = (m.challenger_id === myId) ? m.invitee_round_wins : m.challenger_round_wins;
      const opp = (m.challenger_id === myId) ? (m.opponent_handle || 'Your opponent') : (m.opponent_handle || 'Your challenger');
      const turnLabel = m.status === 'complete' ? 'Final'
        : m.pending_kind === 'serve' && m.pending_server_id === myId ? 'Your serve'
        : m.pending_kind === 'defend' && m.pending_server_id !== myId ? 'Your turn to defend'
        : 'Waiting on ' + opp;
      const row = el(`<div class="game-challenge-row">
        <span></span>
        <div class="game-challenge-row-actions"><button type="button" class="tool-chip" data-open>Open</button></div>
      </div>`);
      row.querySelector('span').textContent =
        `${formatLabelFor(m.format)} vs ${opp} — ${myWins}:${opWins} · ${turnLabel}`;
      row.querySelector('[data-open]').addEventListener('click', () => {
        if (isArenaPage()) handleMatch(m.token);
        else window.location.href = '/game/?match=' + encodeURIComponent(m.token);
      });
      list.appendChild(row);
    }
  }
    const list = document.getElementById('game-challenges');
    if (!list) return;
    const wrap = list.closest('[data-challenges-wrap]');
    if (!isSignedIn()) { if (wrap) wrap.hidden = true; return; }
    let data;
    try {
      const res = await fetch('/api/game-challenges', { headers: { authorization: 'Bearer ' + authToken() } });
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error();
    } catch { return; }
    // Battle-name row: shows your handle and offers a change. The picker
    // itself is the same inline card used on first create.
    const handleRow = wrap && wrap.querySelector('[data-handle-row]');
    if (handleRow) {
      const h = await loadMyHandle();
      if (h) {
        handleRow.hidden = false;
        handleRow.querySelector('[data-handle-name]').textContent = h;
        handleRow.querySelector('[data-change-handle]').onclick = () => {
          showHandlePicker({
            title: 'Change your battle name',
            subtitle: 'Opponents see this on challenges and matches — not your real name.',
            cta: 'Save',
            onSaved: (saved) => {
              handleRow.querySelector('[data-handle-name]').textContent = saved;
              result.innerHTML = '';
              statusLine.textContent = 'Battle name updated.';
            },
          });
        };
      } else { handleRow.hidden = true; }
    }
    const g = await loadGraph().catch(() => null);
    list.innerHTML = '';
    let count = 0;

    const row = (text, buttons) => {
      const div = el(`<div class="challenge-row"><span class="challenge-text"></span><span class="challenge-actions"></span></div>`);
      div.querySelector('.challenge-text').textContent = text;
      const actions = div.querySelector('.challenge-actions');
      for (const [label, fn] of buttons) {
        const b = el(`<button type="button" class="tool-chip"></button>`);
        b.textContent = label;
        b.addEventListener('click', fn);
        actions.appendChild(b);
      }
      list.appendChild(div);
      count++;
    };

    const seeChain = (a, b) => async () => {
      const gg = g || await loadGraph().catch(() => null);
      if (!gg) { statusLine.textContent = 'Could not load the tree. Check your connection and try again.'; return; }
      setHeadToHead(a, b, gg);
      renderMatchup(gg, a, b);
      modal.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const copyInvite = (token) => async () => {
      const url = `${window.location.origin}/game/?invite=${encodeURIComponent(token)}`;
      const okCopy = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
      statusLine.textContent = okCopy ? 'Invite link copied.' : url;
    };
    const challengeBack = () => {
      setHeadToHead(null, null, g);
      statusLine.textContent = 'Your turn to deal — pick your band, then Challenge a friend.';
      modal.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => fieldA.focus(), 300);
    };
    // One-tap rematch: a fresh challenge with your previous pick, straight
    // to the invite dialog — no re-picking, no scrolling.
    const rematch = (bandA) => async () => {
      if (!bandA) return;
      if (!isSignedIn()) {
        try { sessionStorage.setItem('sdr_pending_challenge', JSON.stringify({ band: bandA })); } catch {}
        if (typeof window.openSignupPopover === 'function' && !isArenaPage()) window.openSignupPopover();
        else if (isArenaPage()) window.location.href = '/';
        else document.getElementById('add-band-btn')?.click();
        return;
      }
      await createCasualChallenge(bandA);
      modal.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    for (const c of data.sent || []) {
      if (c.status === 'open') {
        row(`You picked ${bandName(g, c.band_a)} — waiting on your opponent.`, [['Copy invite link', copyInvite(c.token)]]);
      } else if (c.band_b) {
        row(`${c.invitee_handle || 'Your opponent'} answered: ${bandName(g, c.band_a)} vs ${bandName(g, c.band_b)}.`,
          [['See the chain', seeChain(c.band_a, c.band_b)], ['Rematch', rematch(c.band_a)]]);
      }
    }
    for (const c of data.received || []) {
      if (c.band_b) {
        row(`${c.challenger_handle || 'Someone'} challenged you: ${bandName(g, c.band_a)} vs ${bandName(g, c.band_b)}.`,
          [['See the chain', seeChain(c.band_a, c.band_b)], ['Challenge back', challengeBack], ['Rematch', rematch(c.band_b)]]);
      }
    }
    if (wrap) wrap.hidden = count === 0;
  }

  if (inviteToken) handleInvite(inviteToken);
  if (matchToken) handleMatch(matchToken);
  loadChallenges();
  if (isArenaPage()) loadMatches();

  // Resume a challenge interrupted by sign-in. OAuth does a full-page
  // redirect, so the modal state is gone on return — the pick was stashed in
  // sessionStorage before the sign-in flow started. Put the player right back
  // where they left off: game open, band still selected, challenge ready.
  (function resumePendingChallenge() {
    let pending = null;
    try {
      const raw = sessionStorage.getItem('sdr_pending_challenge');
      if (raw) pending = JSON.parse(raw);
    } catch {}
    if (!pending || !pending.band || !isSignedIn()) return;
    try { sessionStorage.removeItem('sdr_pending_challenge'); } catch {}
    openModal();
    loadGraph().then((g) => {
      setHeadToHead(pending.band, null, g);
      statusLine.textContent = 'You\u2019re signed in — hit Challenge a friend to send the invite.';
      setTimeout(() => document.getElementById('game-challenge-btn')?.focus(), 120);
    }).catch(() => {});
  })();

  // Matchup view: band A vs band B with a Connect button. No BFS runs here —
  // the chain (or "No rawk found.") only renders after Connect is hit, so
  // the player gets the anticipation beat first.
  function renderMatchup(g, a, b) {
    const nameA = g.bands.get(a)?.name || 'Band A';
    const nameB = g.bands.get(b)?.name || 'Band B';
    const card = el(`<div class="game-result-card">
      <div class="game-result-meta"><span class="game-hops">The matchup</span></div>
      <div class="game-path" role="list">
        <span class="game-node-chip game-node-band" role="listitem"></span>
        <span class="game-path-link">VS</span>
        <span class="game-node-chip game-node-band" role="listitem"></span>
      </div>
      <div class="game-result-actions">
        <button type="button" class="game-run-btn" data-connect>Connect</button>
      </div>
    </div>`);
    const chips = card.querySelectorAll('.game-node-chip');
    chips[0].textContent = nameA;
    chips[1].textContent = nameB;
    card.querySelector('[data-connect]').addEventListener('click', () => {
      runGame(g, a, b);
    });
    result.innerHTML = '';
    result.appendChild(card);
  }

  function runGame(g, a, b) {
    const path = shortestPath(g, a, b);
    const nameA = g.bands.get(a)?.name || 'Band A';
    const nameB = g.bands.get(b)?.name || 'Band B';
    if (!path) renderDeadEnd(nameA, nameB);
    else renderPath(path);
    // A completed reveal — win or dead end — counts toward the match.
    maybeShowNudge();
  }

  function renderPath(path) {
    const hops = bandHops(path);
    const card = el(`<div class="game-result-card">
      <div class="game-result-meta"><span class="game-hops">${hops} hop${hops === 1 ? '' : 's'}</span></div>
      <div class="game-path" role="list"></div>
      <div class="game-result-actions">
        <button type="button" class="tool-chip" data-share>Share the chain</button>
      </div>
    </div>`);
    const lane = card.querySelector('.game-path');
    path.forEach((node, i) => {
      if (i > 0) lane.appendChild(el('<span class="game-path-link" aria-hidden="true">→</span>'));
      const chip = el(`<span class="game-node-chip" role="listitem"></span>`);
      chip.textContent = node.name;
      chip.classList.add(node.kind === 'band' ? 'game-node-band' : 'game-node-member');
      lane.appendChild(chip);
    });
    card.querySelector('[data-share]').addEventListener('click', async () => {
      const text = path.map((n) => n.name).join(' → ');
      const shareText = `Six Degrees of Rock: ${text} — think you can stump me?`;
      // The chain gets its own share card (banner-style, QR included). The link
      // unfurls the card on socials; if saving fails, fall back to the plain
      // origin link rather than failing the share.
      statusLine.textContent = 'Making your share card…';
      let shareUrl = location.origin;
      try {
        const res = await fetch('/api/game-share', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chain: path.map((n) => ({ name: n.name, kind: n.kind === 'band' ? 'band' : 'member' })),
            mode: currentMode(),
            hops,
          }),
        });
        const data = await res.json();
        if (data && data.ok && data.shareUrl) shareUrl = data.shareUrl;
      } catch (_) { /* plain link fallback below */ }
      statusLine.textContent = '';
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Six Degrees of Rock', text: shareText, url: shareUrl });
        } catch (err) {
          if (!err || err.name !== 'AbortError') {
            statusLine.textContent = 'Share failed — copy the link from the card instead.';
          }
        }
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(`${shareText} ${shareUrl}`).then(() => {
          statusLine.textContent = 'Copied — paste it anywhere to brag.';
        });
      }
    });
    result.innerHTML = '';
    result.appendChild(card);
  }

  function renderDeadEnd(nameA, nameB) {
    const card = el(`<div class="game-result-card game-dead-end">
      <div class="game-no-rawk">No rawk found.</div>
      <p class="game-drink-rule">The chain breaks between <strong></strong> and <strong></strong> — take a shot. 🥃</p>
      <p class="game-dead-sub">Know the missing link? Add the connector and this pair works next time.</p>
      <div class="game-result-actions">
        <button type="button" class="tool-chip" data-add-connector>Add the connector</button>
        <button type="button" class="tool-chip" data-share-dead>Challenge your followers</button>
      </div>
    </div>`);
    const strongs = card.querySelectorAll('strong');
    strongs[0].textContent = nameA;
    strongs[1].textContent = nameB;
    card.querySelector('[data-add-connector]').addEventListener('click', () => {
      closeModal();
      // Route through the existing contribution flow (mobile sheet proxies it).
      const mobileAdd = document.getElementById('mobile-add-band-btn');
      const desktopAdd = document.getElementById('add-band-btn');
      (mobileAdd || desktopAdd)?.click();
    });
    card.querySelector('[data-share-dead]').addEventListener('click', () => {
      const shareText = `No rawk found between ${nameA} and ${nameB}. Prove me wrong — sixdegreesofrock.com`;
      if (navigator.share) {
        navigator.share({ title: 'No rawk found', text: shareText, url: location.origin }).catch(() => {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(shareText).then(() => {
          statusLine.textContent = 'Copied — dare your followers to solve it.';
        });
      }
    });
    result.innerHTML = '';
    result.appendChild(card);
  }

  syncModeUI();
}

if (isBrowser) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGameUI);
  } else {
    initGameUI();
  }
}
