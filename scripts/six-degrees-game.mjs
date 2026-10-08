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

// ---------------------------------------------------------------------------
// Game analytics (fire-and-forget)
//
// WHY: Cole asked for engagement metrics (Oct 2026): games started per user,
// win/loss/abandon rate, hint clicks, avg moves per game. The ops board
// aggregates these from the game_analytics_events table.
//
// HOW: trackGameEvent() POSTs to /api/analytics/game-event with keepalive so
// it survives page navigation. Never awaited, never retried — if it fails,
// gameplay continues silently. No PII: the server resolves user_id from the
// bearer token if present, NULL otherwise.
// ---------------------------------------------------------------------------

function newGameSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function trackGameEvent(payload) {
  if (!isBrowser) return;
  try {
    fetch('/api/analytics/game-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      // Silent: analytics must never break gameplay
    });
  } catch {
    // fetch itself threw (very old browser) — ignore
  }
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

  // --- invite how-it-works line ---------------------------------------------
  // The invite landing is the game's front door for non-players (Paul's
  // "I don't understand how the game is played", 2026-10-01). A dedicated
  // line above the fields explains the rules once, in plain words — the
  // status line stays free for transient messages. Shown only in the accept
  // view; hidden on every exit path.
  const howtoLine = (() => {
    const p = document.createElement('p');
    p.id = 'game-howto';
    p.className = 'game-howto';
    p.style.display = 'none';
    const wrapA = document.getElementById('game-field-a-wrap');
    if (wrapA && wrapA.parentNode) wrapA.parentNode.insertBefore(p, wrapA);
    if (!document.getElementById('game-howto-style')) {
      const st = document.createElement('style');
      st.id = 'game-howto-style';
      // Quiet register, same as the status line — an explainer, not a banner.
      // 12px floor: the text-legibility CI gate fails anything smaller.
      st.textContent = '.game-howto{font-size:12px;color:var(--color-text-muted,#999);margin:0 0 var(--space-2,8px);line-height:1.5}';
      document.head.appendChild(st);
    }
    return p;
  })();
  function showHowto(text) {
    howtoLine.textContent = text || '';
    howtoLine.style.display = text ? '' : 'none';
  }

  // Paul's call (2026-10-01): in a challenge the mode is already fixed —
  // showing the mode picker invites a tap that wrecks the accept flow.
  // Hidden on challenge entry views, restored on every exit path.
  function setModePickerVisible(v) {
    const picker = document.querySelector('.game-modes');
    if (picker) picker.style.display = v ? '' : 'none';
  }

  const selected = { a: null, b: null };
  // Challenge-back threading (2026-10-01): a "Challenge back" tap records
  // which challenge this is answering; the next create stamps in_reply_to so
  // the opponent's list shows a real incoming row. Cleared on use.
  let pendingReplyTo = null;

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
    // Abandoning the modal abandons any armed challenge-back reply.
    pendingReplyTo = null;
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
    return (modeInputs.find((i) => i.checked) || {}).value || 'daily';
  }

  function syncModeUI() {
    const mode = currentMode();
    // Tab bar description: one line under the tabs naming what this mode does.
    // (Full descriptions live in the label markup for accessibility.)
    const descEl = document.getElementById('game-mode-desc');
    if (descEl) {
      const descs = {
        daily: 'One fresh matchup every day. Same chain for everyone.',
        solo: 'Practice mode. Pick a band, we deal the opponent, you find the chain.',
        'head-to-head': 'Challenge a friend. You pick, they pick, tree settles it.',
        chaos: 'Feeling lucky? We deal two random bands and show you the connection.',
        stakes: 'Put something on it. Winner takes the round.',
      };
      descEl.textContent = descs[mode] || '';
    }
    // Mode-specific subtitle (Aaron, 2026-10-07: "Name two bands" is wrong on Daily).
    // Placed here (before challenge queue loading) so a throw in loadChallenges()
    // can't block the subtitle update.
    try {
      const sub = document.querySelector('.game-modal-sub');
      const subtitles = {
        daily: 'One fresh chain every day — same for everyone. Connect the bands, beat par, build your streak.',
        solo: 'Practice mode. Pick a band, we deal the opponent, you find the chain.',
        'head-to-head': 'Challenge a friend. You pick a band, they pick theirs, the tree decides.',
        chaos: 'Two random bands. Hit Connect and watch the tree work.',
      };
      if (sub && subtitles[mode]) sub.textContent = subtitles[mode];
    } catch {}
    // Any mode change exits the invite accept context.
    showHowto('');
    setModePickerVisible(true);
    // ...and abandons any armed challenge-back reply.
    pendingReplyTo = null;
    // The challenges/matches queues live under the Challenge tab only — the
    // Daily front door stays clean (just the puzzle). Switching to Challenge
    // refreshes the queues; switching away hides them.
    const versusActive = mode === 'head-to-head';
    const chWrap = document.querySelector('[data-challenges-wrap]');
    const mWrap = document.querySelector('[data-matches-wrap]');
    if (!versusActive) {
      if (chWrap) chWrap.hidden = true;
      if (mWrap) mWrap.hidden = true;
    } else {
      loadChallenges();
      loadMatches();
    }
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
    // Head-to-head: opponent picks band B on their own device — band B field
    // stays hidden in challenge mode (2026-10-06).
    document.getElementById('game-field-a-wrap').style.display = mode === 'chaos' ? 'none' : '';
    wrapB.style.display = 'none';
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
      .game-player-line{font-size:.78rem;color:#8a8a8a;margin:0 0 2px}
      .game-chain-pills{display:flex;gap:6px;align-items:center;margin:10px 0;flex-wrap:wrap}
      .game-chain-pill{padding:6px 12px;border-radius:999px;font-size:.82rem;font-weight:600;white-space:nowrap;max-width:170px;overflow:hidden;text-overflow:ellipsis}
      .game-chain-anchor{border:1px solid rgba(82,174,182,.7);background:rgba(82,174,182,.16);color:#fff}
      .game-chain-filled{border:1px solid rgba(82,174,182,.45);background:rgba(82,174,182,.08);color:#fff}
      .game-chain-deadend{border:1px solid rgba(200,90,90,.6);background:rgba(200,90,90,.1);color:#f0b0b0}
      .game-chain-blank{border:1px dashed rgba(255,255,255,.28);background:transparent;color:#777;min-width:44px;text-align:center}
      .game-daily-reveal{font-size:.9rem;color:#bbb;margin:10px 0;line-height:1.7}
      .game-daily-reveal strong{color:#fff;font-weight:600}
      .game-daily-options{display:grid;gap:8px;margin:6px 0 10px}
      .game-daily-option{text-align:left;padding:10px 12px;border:1px solid rgba(82,174,182,.45);border-radius:var(--radius-lg);background:rgba(82,174,182,.08);color:inherit;font-size:.95rem;font-weight:600;cursor:pointer}
      .game-daily-option:hover{border-color:rgba(82,174,182,.8);background:rgba(82,174,182,.14)}
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
      .game-credit-btn{background:none;border:none;padding:0;font:inherit;color:#7fc9c7;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
      .game-credit-sheet{border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:12px;margin:8px 0;font-size:.88rem;line-height:1.6}
      .game-credit-sheet-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
      .game-credit-sheet-head strong{font-size:.95rem}
      .game-credit-sheet-head button{background:none;border:none;color:#999;font-size:1rem;cursor:pointer;padding:4px}
      .game-credit-sheet ul{margin:6px 0 6px 18px;padding:0}
      .game-credit-sheet-balance{font-size:1.02rem;margin:4px 0}
      .game-daily-postmortem{border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:10px 12px;margin:8px 0;font-size:.85rem;line-height:1.7}
      .game-daily-postmortem p{margin:6px 0}
      .game-daily-postmortem .pm-par{color:#d4a017}
      .game-daily-postmortem .pm-you{color:#7fc9c7}
      .game-daily-postmortem .pm-label{color:#999;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em}
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

  // --- Daily Chain share card: a real drawn image with actual guitar picks ---
  const SHARE_W = 1080, SHARE_H = 1350;
  function drawPickCanvas(ctx, cx, cy, s, color) {
    // Same teardrop as pickSvg, translated to absolute canvas path commands.
    const hex = DAILY_PICK_HEX[color] || DAILY_PICK_HEX.black;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s / 24, s / 28);
    ctx.beginPath();
    ctx.moveTo(12, 2.5);
    ctx.bezierCurveTo(6.8, 2.5, 2.5, 6.5, 2.5, 11.8);
    ctx.bezierCurveTo(2.5, 17.8, 7.7, 23.4, 11.1, 26);
    ctx.bezierCurveTo(11.6, 26.4, 12.4, 26.4, 12.9, 26);
    ctx.bezierCurveTo(16.3, 23.4, 21.5, 17.8, 21.5, 11.8);
    ctx.bezierCurveTo(21.5, 6.5, 17.2, 2.5, 12, 2.5);
    ctx.closePath();
    ctx.fillStyle = hex;
    ctx.fill();
    ctx.strokeStyle = color === 'black' ? '#555' : 'rgba(0,0,0,.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
  function fmtChainDate(ds) {
    const parts = String(ds || '').split('-').map(Number);
    if (parts.length < 3) return String(ds || '');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[parts[1] - 1] || ''} ${parts[2]}, ${parts[0]}`;
  }
  function drawDailyShareCard(data) {
    // data: { mode:'win'|'lost', date, startName, targetName, hops, par, streak, picks:[{color}] }
    const c = document.createElement('canvas');
    c.width = SHARE_W; c.height = SHARE_H;
    const ctx = c.getContext('2d');
    const gold = '#d4a017', robin = '#7fc9c7', gray = '#9aa0ae';
    // Arena background.
    const bg = ctx.createLinearGradient(0, 0, 0, SHARE_H);
    bg.addColorStop(0, '#10131a');
    bg.addColorStop(1, '#1b212e');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SHARE_W, SHARE_H);
    const glow = ctx.createRadialGradient(SHARE_W / 2, 300, 60, SHARE_W / 2, 300, 640);
    glow.addColorStop(0, 'rgba(212,160,23,.10)');
    glow.addColorStop(1, 'rgba(212,160,23,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, SHARE_W, SHARE_H);
    const center = (text, y, font, fill) => {
      ctx.font = font; ctx.fillStyle = fill; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, SHARE_W / 2, y, SHARE_W - 120);
    };
    const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    try { ctx.letterSpacing = '8px'; } catch {}
    center('SIX DEGREES OF RAWK', 118, `600 42px ${FONT}`, gold);
    try { ctx.letterSpacing = '2px'; } catch {}
    center(`Daily Chain · ${fmtChainDate(data.date)}`, 172, `400 30px ${FONT}`, gray);
    center(data.mode === 'win' ? 'I connected the constellation' : 'The tree wins today',
      232, `600 36px ${FONT}`, data.mode === 'win' ? gold : gray);
    // Stats.
    const stats = [
      [String(data.hops), 'HOPS'],
      [String(data.par), 'PAR'],
      [String(data.streak), 'STREAK'],
    ];
    stats.forEach(([num, label], i) => {
      const x = SHARE_W / 2 + (i - 1) * 280;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 84px ${FONT}`; ctx.fillStyle = i === 1 ? robin : '#f2f3f5';
      ctx.fillText(num, x, 330);
      try { ctx.letterSpacing = '5px'; } catch {}
      ctx.font = `400 26px ${FONT}`; ctx.fillStyle = gray;
      ctx.fillText(label, x, 392);
      try { ctx.letterSpacing = '2px'; } catch {}
    });
    center(`${data.startName}  →  ${data.targetName}`, 452, `400 30px ${FONT}`, gray);
    // Pick grid — real picks, flowing rows.
    const picks = data.picks || [];
    const MAX_DRAW = 60;
    const shown = picks.slice(0, MAX_DRAW);
    const perRow = 10, s = 64, pitch = 88;
    const rows = Math.ceil(shown.length / perRow);
    const top = 540;
    shown.forEach((p, i) => {
      const r = Math.floor(i / perRow), k = i % perRow;
      const inRow = Math.min(perRow, shown.length - r * perRow);
      const x0 = SHARE_W / 2 - ((inRow - 1) * pitch) / 2;
      drawPickCanvas(ctx, x0 + k * pitch, top + r * pitch, s, p.color);
    });
    let legendY = top + rows * pitch + 24;
    if (picks.length > MAX_DRAW) {
      center(`+${picks.length - MAX_DRAW} more`, legendY - 34, `400 28px ${FONT}`, gray);
    }
    center('Gold is optimal · robin\u2019s egg is valid · black is lost in space',
      legendY, `400 26px ${FONT}`, gray);
    // Footer.
    center('sixdegreesofrock.com/game', SHARE_H - 110, `600 34px ${FONT}`, gold);
    try { ctx.letterSpacing = '4px'; } catch {}
    center('DAILY CHAIN', SHARE_H - 62, `400 24px ${FONT}`, '#5b616e');
    try { ctx.letterSpacing = '0px'; } catch {}
    return c;
  }
  async function shareDailyCard(btn, data) {
    const canvas = drawDailyShareCard(data);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) { btn.textContent = 'Could not draw the card'; return; }
    const file = new File([blob], `daily-chain-${data.date}.png`, { type: 'image/png' });
    // Native image share where supported (phones).
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Daily Chain', text: data.text });
        btn.textContent = 'Shared';
        setTimeout(() => { btn.textContent = 'Share image'; }, 2500);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user dismissed — leave it
      }
    }
    // Fallback: download the PNG and copy the text.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    try { await navigator.clipboard.writeText(data.text); } catch {}
    btn.textContent = 'Image downloaded · text copied';
    setTimeout(() => { btn.textContent = 'Share image'; }, 4000);
  }

  let dailyRun = null;      // last run state from the server
  let dailyOptions = [];    // public options: [{id, name}]
  let dailyRevealArmed = false;

  // Solo Run v2 (Oct 2026): the guessing game. Same server-dealt options as
  // the daily chain, but the tree deals a fresh pair every run (or honors
  // the player's band-A pick) — no date lock, no streaks.
  let soloRun = null;
  let soloOptions = [];
  let soloRevealArmed = false;

  // Analytics session state (per game, reset on each start)
  let analyticsSessionId = null;
  let analyticsGameStartTime = null;
  let analyticsMoveCount = 0;
  let analyticsHintCount = 0;

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
      <div class="game-player-line"></div>
      <p class="game-daily-pair"></p>
      <p class="game-daily-econ"></p>
      <div class="game-daily-picks" aria-label="Your picks"></div>
      <div class="game-daily-current"></div>
      <div class="game-chain-pills"></div>
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
      // Analytics: new game session
      analyticsSessionId = newGameSessionId();
      analyticsGameStartTime = Date.now();
      analyticsMoveCount = 0;
      analyticsHintCount = 0;
      trackGameEvent({
        session_id: analyticsSessionId,
        event_type: 'game_started',
        game_mode: 'daily_chain',
        band_a: dailyRun && dailyRun.start_band ? dailyRun.start_band.name : null,
        band_b: dailyRun && dailyRun.target ? dailyRun.target.name : null,
      });
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

  // Tappable credit balance: what you hold, how it's earned, what's coming.
  // Takes the run so the solo board can reuse it (defaults to the daily run).
  function toggleCreditSheet(card, run) {
    const open = card.querySelector('.game-credit-sheet');
    if (open) { open.remove(); return; }
    const r = run || dailyRun;
    const balance = (r && r.credits != null) ? r.credits : 0;
    const sheet = el(`<div class="game-credit-sheet">
      <div class="game-credit-sheet-head"><strong>Credits</strong><button type="button" aria-label="Close">✕</button></div>
      <p class="game-credit-sheet-balance">Balance: <strong></strong></p>
      <ul>
        <li>Finish the daily chain · <strong>+20</strong></li>
        <li>Match par · <strong>+10</strong></li>
        <li>Replay and beat your best · <strong>+5</strong> per hop</li>
        <li>Beat the tree (shorter than par) · <strong>+50</strong></li>
      </ul>
      <p class="game-daily-note">Cut −10 · Ask −10 · Dig out −50 · Freeze 100 · Archive day 75</p>
      <p class="game-daily-note">Credit packs — coming soon · Redeem Play Points — later</p>
    </div>`);
    sheet.querySelector('.game-credit-sheet-balance strong').textContent = balance;
    sheet.querySelector('[aria-label="Close"]').addEventListener('click', () => sheet.remove());
    card.querySelector('.game-daily-econ').after(sheet);
  }

  // Chain pills: the whole chain as pills — [start][?][?]...[target].
  // Filled pills show picked bands; blank pills show remaining par hops.
  // Each non-optimal pick adds a blank pill, so going over par visibly
  // lengthens the chain. Shared by Daily Chain and Solo (same card).
  function paintChainPills(card, run) {
    const box = card.querySelector('.game-chain-pills');
    if (!box || !run) return;
    box.innerHTML = '';
    const par = run.par || 3;
    const picks = run.picks || [];
    const extra = picks.filter((p) => p.kind && p.kind !== 'optimal' && p.kind !== 'deadend').length;
    let middle = Math.max(par - 1 + extra, picks.length);
    // While the game is active, always show at least one blank pill for the
    // next hop to find (Aaron, 2026-10-07).
    const active = run.status !== 'complete' && run.status !== 'given_up';
    if (active && middle <= picks.length) middle = picks.length + 1;
    // Live distance: if you've wandered, blanks grow to show the true
    // remaining hops (Aaron, 2026-10-07). The backend sends dist_to_target.
    if (active && run.dist_to_target != null && run.dist_to_target > 0) {
      const need = picks.length + run.dist_to_target;
      if (need > middle) middle = need;
    }
    const mkPill = (text, cls, title) => {
      const s = document.createElement('span');
      s.className = 'game-chain-pill ' + cls;
      s.textContent = text;
      if (title) s.title = title;
      return s;
    };
    box.appendChild(mkPill(run.start_band.name, 'game-chain-anchor', 'Start band'));
    for (let i = 0; i < middle; i++) {
      if (i < picks.length) {
        const p = picks[i];
        const dead = p.kind === 'deadend';
        box.appendChild(mkPill(
          p.name,
          dead ? 'game-chain-filled game-chain-deadend' : 'game-chain-filled',
          p.kind === 'optimal' ? 'On the shortest path' : dead ? 'Dead end' : 'Connects, but not the shortest way'
        ));
      } else {
        box.appendChild(mkPill('?', 'game-chain-blank', 'A hop to find'));
      }
    }
    // Don't duplicate the target pill if the last pick already reached it.
    const lastPick = picks[picks.length - 1];
    const reached = lastPick && lastPick.name === run.target.name;
    if (!reached) {
      box.appendChild(mkPill(run.target.name, 'game-chain-anchor', 'Target band'));
    }
  }

  // Persistent player line: "Playing as X · N credits". Credits update on
  // every repaint; the handle fills in async (cached after first load).
  // Also paints the prominent top line under the game title (Aaron, 2026-10-07).
  function paintPlayerLine(card, run) {
    const credits = run && run.credits != null ? run.credits : 0;
    const paintOne = (line) => {
      if (!line) return;
      const seq = (parseInt(line.dataset.seq || '0', 10) + 1);
      line.dataset.seq = String(seq);
      line.textContent = credits + ' credits';
      loadMyHandle().then((h) => {
        if (line.dataset.seq !== String(seq)) return; // a newer paint won
        line.textContent = h ? 'Playing as ' + h + ' \u00b7 ' + credits + ' credits'
                             : credits + ' credits';
      });
    };
    paintOne(card.querySelector('.game-player-line'));
    paintOne(document.getElementById('game-player-line-top'));
  }

  function paintDailyBoard(card, completed, gaveUpInfo) {
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

    const econLine = q('.game-daily-econ');
    econLine.innerHTML = '';
    econLine.appendChild(mk(`Par ${run.par} · Streak ${run.streak} · `));
    const creditBtn = el('<button type="button" class="game-credit-btn"></button>');
    creditBtn.textContent = `${run.credits} credits`;
    creditBtn.setAttribute('aria-label', 'Your credit balance — how credits work');
    creditBtn.addEventListener('click', () => toggleCreditSheet(card));
    econLine.appendChild(creditBtn);
    if (run.freeze_count) econLine.appendChild(mk(` · ❄ ${run.freeze_count}`));
    if (run.best_hops != null) econLine.appendChild(mk(` · Best today: ${run.best_hops}`));

    const picksRow = q('.game-daily-picks');
    picksRow.innerHTML = '';
    for (const p of run.picks) {
      const wrap = document.createElement('span');
      wrap.innerHTML = pickSvg(p.color, 'game-daily-pick');
      wrap.title = `${p.name} — ${p.kind === 'optimal' ? 'optimal' : p.kind === 'deadend' ? 'dead end' : 'valid'}`;
      picksRow.appendChild(wrap);
    }

    // Chain pills replace the old text trail (Aaron: the text was confusing).
    paintChainPills(card, run);
    paintPlayerLine(card, run);

    const note = q('.game-daily-note');
    const tools = q('.game-daily-tools');
    const optsBox = q('.game-daily-options');
    const finish = q('.game-daily-finish');
    optsBox.innerHTML = '';
    tools.innerHTML = '';
    finish.innerHTML = '';
    dailyRevealArmed = false;

    if (run.status === 'given_up') {
      paintDailyGiveUp(card, gaveUpInfo);
      return;
    }

    if (completed || run.status === 'complete') {
      const c = completed || {};
      let line;
      if (c.beat_tree) {
        line = `You beat the tree in ${run.hops_used} hop${run.hops_used === 1 ? '' : 's'} — par was ${c.old_par}.`;
      } else {
        line = `Connected in ${run.hops_used} hop${run.hops_used === 1 ? '' : 's'} (par ${run.par}).`;
        if (run.hops_used === run.par) line += ' The tree nods.';
        if (run.best_hops != null && run.best_hops < run.hops_used) {
          line += ` Best today: ${run.best_hops}.`;
        }
      }
      q('.game-daily-current').textContent = line;
      paintDailyShare(card, c);
      const again = el('<button type="button" class="tool-chip">Play again</button>');
      again.addEventListener('click', () => dailyReplay(card));
      finish.appendChild(again);
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
      const elim = el('<button type="button" class="tool-chip">Cut one option (−10)</button>');
      elim.addEventListener('click', () => dailyHint(card, 'eliminate'));
      const peek = el('<button type="button" class="tool-chip">Ask the tree (−10)</button>');
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
      const esc = el('<button type="button" class="tool-chip"></button>');
      // Bail-out: when a session legend is actually in the room (the server
      // checked the graph), the escape wears his name. Same price, same
      // effect — and yes, it's a Freese/Freeze pun.
      esc.textContent = run.bailout
        ? `${run.bailout} bails you out (−50)`
        : 'Dig out of the dead end (−50)';
      esc.addEventListener('click', () => dailyEscape(card));
      tools.appendChild(esc);
      note.textContent = `Lost in space. ${note.textContent}`;
    }

    const econ = el('<button type="button" class="tool-chip">Freeze my streak (100)</button>');
    econ.addEventListener('click', () => dailyBuyFreeze(card));
    tools.appendChild(econ);

    const giveup = el('<button type="button" class="tool-chip">Show me the chain</button>');
    giveup.addEventListener('click', () => {
      note.innerHTML = '';
      note.appendChild(mk('Today ends and the tree reveals the path. '));
      const yes = el('<button type="button" class="tool-chip">Show me</button>');
      const no = el('<button type="button" class="tool-chip">Keep playing</button>');
      yes.addEventListener('click', () => dailyGiveUp(card));
      no.addEventListener('click', () => paintDailyBoard(card));
      note.appendChild(yes);
      note.appendChild(mk(' '));
      note.appendChild(no);
    });
    tools.appendChild(giveup);
  }

  async function dailyGiveUp(card) {
    const note = card.querySelector('.game-daily-note');
    note.textContent = 'The tree is revealing the path…';
    try {
      const data = await dailyFetch('/api/game-daily/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'giveup' }),
      });
      dailyRun = data.run;
      dailyOptions = [];
      // Analytics: game completed (abandon — player gave up)
      if (analyticsSessionId) {
        const durationSeconds = analyticsGameStartTime
          ? Math.round((Date.now() - analyticsGameStartTime) / 1000)
          : null;
        trackGameEvent({
          session_id: analyticsSessionId,
          event_type: 'game_completed',
          game_mode: 'daily_chain',
          result: 'abandon',
          moves_count: analyticsMoveCount,
          hints_used: analyticsHintCount,
          duration_seconds: durationSeconds,
        });
        analyticsSessionId = null; // session over
      }
      paintDailyBoard(card, null, data.gave_up);
    } catch (err) {
      note.textContent = (err && err.message) || 'Could not show the chain.';
    }
  }

  async function dailyReplay(card) {
    const note = card.querySelector('.game-daily-note');
    note.textContent = 'Dealing a fresh run…';
    try {
      const data = await dailyFetch('/api/game-daily/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'start', replay: true }),
      });
      dailyRun = data.run;
      dailyOptions = data.options || [];
      // Analytics: new game session (replay)
      analyticsSessionId = newGameSessionId();
      analyticsGameStartTime = Date.now();
      analyticsMoveCount = 0;
      analyticsHintCount = 0;
      trackGameEvent({
        session_id: analyticsSessionId,
        event_type: 'game_started',
        game_mode: 'daily_chain',
        band_a: dailyRun && dailyRun.start_band ? dailyRun.start_band.name : null,
        band_b: dailyRun && dailyRun.target ? dailyRun.target.name : null,
      });
      paintDailyBoard(card);
    } catch (err) {
      note.textContent = (err && err.message) || 'Could not start a replay.';
    }
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
        // Analytics: hint used (peek/reveal)
        if (analyticsSessionId) {
          analyticsHintCount++;
          trackGameEvent({
            session_id: analyticsSessionId,
            event_type: 'hint_clicked',
            game_mode: 'daily_chain',
          });
        }
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
      // Analytics: move made
      if (analyticsSessionId) {
        analyticsMoveCount++;
        trackGameEvent({
          session_id: analyticsSessionId,
          event_type: 'move_made',
          game_mode: 'daily_chain',
          move_number: analyticsMoveCount,
        });
      }
      if (data.completed) {
        // Analytics: game completed (win)
        if (analyticsSessionId) {
          const durationSeconds = analyticsGameStartTime
            ? Math.round((Date.now() - analyticsGameStartTime) / 1000)
            : null;
          trackGameEvent({
            session_id: analyticsSessionId,
            event_type: 'game_completed',
            game_mode: 'daily_chain',
            result: 'win',
            moves_count: analyticsMoveCount,
            hints_used: analyticsHintCount,
            duration_seconds: durationSeconds,
          });
          analyticsSessionId = null; // session over
        }
        paintDailyBoard(card, data.completed);
      } else {
        paintDailyBoard(card);
        if (data.picked && data.picked.deadend) {
          card.querySelector('.game-daily-note').textContent = 'Lost in space.';
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
      // Analytics: hint used (eliminate)
      if (analyticsSessionId) {
        analyticsHintCount++;
        trackGameEvent({
          session_id: analyticsSessionId,
          event_type: 'hint_clicked',
          game_mode: 'daily_chain',
        });
      }
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
    const who = dailyRun && dailyRun.bailout;
    try {
      const data = await dailyFetch('/api/game-daily/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'escape' }),
      });
      dailyRun = data.run;
      dailyOptions = data.options || [];
      paintDailyBoard(card);
      card.querySelector('.game-daily-note').textContent = who
        ? `${who.split(' ').pop()} got you out of the black hole.`
        : `Dug out — ${data.escaped.name} is off your trail.`;
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
        'Freeze stocked — it auto-burns if you miss exactly one day.';
    } catch (err) {
      note.textContent = err.message;
    }
  }

  function paintDailyGiveUp(card, gaveUp) {
    const run = dailyRun;
    const mk = (t, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = t; return s; };
    card.querySelector('.game-daily-current').textContent = 'The tree wins today.';
    const finish = card.querySelector('.game-daily-finish');
    const rev = el('<div class="game-daily-reveal"></div>');
    rev.appendChild(mk('The tree reveals the path: '));
    const strong = document.createElement('strong');
    strong.textContent = (run.reveal_path || []).map((b) => b.name).join(' → ');
    rev.appendChild(strong);
    finish.appendChild(rev);

    const hops = run.hops_used;
    const par = run.par;
    const shareText = (gaveUp && gaveUp.share_text) ||
      `Six Degrees Daily Chain — ${run.chain_date}\nThe tree beat me today — par was ${par}, and I was ${hops} hops deep.\nsixdegreesofrock.com/game`;
    const share = el(`<div class="game-daily-share">
      <p class="game-daily-share-line"></p>
      <div class="game-result-actions"><button type="button" class="tool-chip" data-share>Share image</button><button type="button" class="tool-chip" data-copy>Copy share text</button></div>
    </div>`);
    share.querySelector('.game-daily-share-line').textContent =
      `The tree beat me today — par was ${par}, and I was ${hops} hop${hops === 1 ? '' : 's'} deep.`;
    const copyBtn = share.querySelector('[data-copy]');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shareText);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy share text'; }, 2000);
      } catch {
        copyBtn.textContent = 'Copy failed — long-press to copy';
      }
    });
    const shareBtn = share.querySelector('[data-share]');
    shareBtn.addEventListener('click', () => shareDailyCard(shareBtn, {
      mode: 'lost',
      date: run.chain_date,
      startName: run.start_band.name,
      targetName: run.target.name,
      hops, par, streak: run.streak,
      picks: run.picks || [],
      text: shareText,
    }));
    finish.appendChild(share);
  }

  function paintDailyShare(card, completed) {
    const finish = card.querySelector('.game-daily-finish');
    const picks = completed.picks && completed.picks.length ? completed.picks : dailyRun.picks;
    const share = el(`<div class="game-daily-share">
      <div class="game-daily-share-picks"></div>
      <p class="game-daily-share-line"></p>
      <p class="game-daily-note"></p>
      <div class="game-result-actions"><button type="button" class="tool-chip" data-share>Share image</button><button type="button" class="tool-chip" data-copy>Copy share text</button></div>
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
    share.querySelector('.game-daily-share-line').textContent = completed.beat_tree
      ? `I BEAT THE TREE in ${hops} hops (par was ${completed.old_par}). Streak ${streak}.`
      : `I connected the constellation in ${hops} hops (par ${par}). Streak ${streak}.`;
    share.querySelector('.game-daily-note').textContent =
      'Gold is optimal, robin\u2019s egg is valid, black is lost in space.';
    const copyBtn = share.querySelector('[data-copy]');
    const shareText = completed.share_text ||
      `Daily Chain ${dailyRun.chain_date} — ${hops} hops (par ${par}), streak ${streak}. Play: https://sixdegreesofrock.com/game/`;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shareText);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy share text'; }, 2000);
      } catch {
        copyBtn.textContent = 'Copy failed — long-press to copy';
      }
    });
    const shareBtn = share.querySelector('[data-share]');
    shareBtn.addEventListener('click', () => shareDailyCard(shareBtn, {
      mode: 'win',
      date: dailyRun.chain_date,
      startName: dailyRun.start_band.name,
      targetName: dailyRun.target.name,
      hops, par, streak,
      picks,
      text: shareText,
    }));
    if (completed.freeze_used) {
      const fz = document.createElement('p');
      fz.className = 'game-daily-note';
      fz.textContent = 'A Seattle Freeze bridged your missed day — streak intact.';
      share.appendChild(fz);
    }
    finish.appendChild(share);
  }

  // Post-mortem: par path in gold vs your route in blue, for archive days you
  // actually played. The server enforces the two-day gate; this just decides
  // whether to offer the button.
  function pmEligible(dateStr) {
    const day = new Date(String(dateStr) + 'T12:00:00');
    if (Number.isNaN(day.getTime())) return false;
    return Math.floor((Date.now() - day.getTime()) / 86400000) >= 2;
  }
  async function togglePostMortem(row, date) {
    let box = row.querySelector('.game-daily-postmortem');
    if (box) { box.remove(); return; }
    box = el('<div class="game-daily-postmortem"><p class="game-daily-note">Loading…</p></div>');
    row.appendChild(box);
    try {
      const data = await dailyFetch(`/api/game-daily/postmortem?date=${encodeURIComponent(date)}`);
      box.innerHTML = '';
      const parP = el('<p></p>');
      parP.appendChild(mk('Par · '));
      const parSpan = document.createElement('span');
      parSpan.className = 'pm-par';
      parSpan.textContent = (data.par_path || []).join(' → ');
      parP.appendChild(parSpan);
      const youP = el('<p></p>');
      youP.appendChild(mk(`You · ${data.your_hops} hop${data.your_hops === 1 ? '' : 's'} · `));
      const youSpan = document.createElement('span');
      youSpan.className = 'pm-you';
      youSpan.textContent = (data.your_path || []).join(' → ');
      youP.appendChild(youSpan);
      const meta = el('<p class="game-daily-note"></p>');
      meta.textContent = data.outcome === 'complete'
        ? `Completed in ${data.your_hops} vs par ${data.par}.`
        : `Gave up ${data.your_hops} deep — the tree's answer is the gold route.`;
      box.appendChild(parP);
      box.appendChild(youP);
      box.appendChild(meta);
    } catch (err) {
      box.innerHTML = '';
      const p = el('<p class="game-daily-note"></p>');
      p.textContent = err.message;
      box.appendChild(p);
    }
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
          if (d.played && pmEligible(d.date)) {
            const pm = el('<button type="button" class="tool-chip">Post-mortem</button>');
            pm.addEventListener('click', () => togglePostMortem(row, d.date));
            act.appendChild(pm);
          }
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

  // --- Solo Run v2 ---------------------------------------------------------
  // The guessing game (Oct 2026): the tree deals a pair — or honors the
  // player's band-A pick and supplies band B — and the player builds the
  // chain link-by-link from multiple-choice options, Daily Chain style.
  // Free to start; hints and blackhole escapes cost credits.

  function renderSoloGate() {
    ensureDailyStyles();
    result.innerHTML = '';
    const card = el(`<div class="game-result-card game-daily">
      <div class="game-daily-head"><span class="game-hops">Solo Run</span></div>
      <p class="game-daily-note">Pick a band — or let the tree deal both — then guess the chain link by link, just like the Daily Chain. Free to play; sign in to keep your credits.</p>
      <div class="game-result-actions"><button type="button" class="game-run-btn" data-signin>Sign in to play</button></div>
    </div>`);
    result.appendChild(card);
    card.querySelector('[data-signin]').addEventListener('click', () => {
      if (isArenaPage()) {
        try { sessionStorage.setItem('sdr_pending_solo', '1'); } catch {}
        window.location.href = '/';
      } else if (typeof window.openSignupPopover === 'function') {
        try { sessionStorage.setItem('sdr_pending_solo', '1'); } catch {}
        window.openSignupPopover();
      } else {
        document.getElementById('add-band-btn')?.click();
      }
    });
  }

  // Resume a solo run interrupted by sign-in (same pattern as daily).
  (function resumePendingSolo() {
    let pending = null;
    try { pending = sessionStorage.getItem('sdr_pending_solo'); } catch {}
    if (!pending || !isSignedIn()) return;
    try { sessionStorage.removeItem('sdr_pending_solo'); } catch {}
    openModal();
    const soloInput = [...document.querySelectorAll('input[name="game-mode"]')].find((i) => i.value === 'solo');
    if (soloInput && !soloInput.disabled) {
      soloInput.checked = true;
      syncModeUI();
    }
  })();

  async function startSoloRun({ bandA = null, fresh = false } = {}) {
    ensureDailyStyles();
    if (!isSignedIn()) { renderSoloGate(); return; }
    result.innerHTML = '';
    statusLine.textContent = 'Dealing your run…';
    try {
      const data = await dailyFetch('/api/game-solo/play', {
        method: 'POST',
        body: JSON.stringify({
          action: 'start',
          ...(bandA ? { band_a: bandA } : {}),
          ...(fresh ? { fresh: true } : {}),
        }),
      });
      soloRun = data.run;
      soloOptions = data.options || [];
      // Analytics: new solo session (a resume is the same game, not a new one)
      if (!data.resumed) {
        analyticsSessionId = newGameSessionId();
        analyticsGameStartTime = Date.now();
        analyticsMoveCount = 0;
        analyticsHintCount = 0;
        trackGameEvent({
          session_id: analyticsSessionId,
          event_type: 'game_started',
          game_mode: 'solo',
          band_a: soloRun && soloRun.start_band ? soloRun.start_band.name : null,
          band_b: soloRun && soloRun.target ? soloRun.target.name : null,
        });
      }
      statusLine.textContent = '';
      renderSoloBoard();
    } catch (err) {
      statusLine.textContent = '';
      result.innerHTML = '';
      const card = el(`<div class="game-result-card game-daily">
        <div class="game-daily-head"><span class="game-hops">Solo Run</span></div>
        <p class="game-daily-note"></p>
      </div>`);
      card.querySelector('.game-daily-note').textContent = (err && err.message) || 'Could not start a solo run.';
      result.appendChild(card);
    }
  }

  function renderSoloBoard() {
    ensureDailyStyles();
    result.innerHTML = '';
    const card = el(`<div class="game-result-card game-daily">
      <div class="game-daily-head"><span class="game-hops">Solo Run</span><span class="game-daily-date"></span></div>
      <div class="game-player-line"></div>
      <p class="game-daily-pair"></p>
      <p class="game-daily-econ"></p>
      <div class="game-daily-picks" aria-label="Your picks"></div>
      <div class="game-daily-current"></div>
      <div class="game-chain-pills"></div>
      <div class="game-daily-options"></div>
      <div class="game-daily-tools"></div>
      <p class="game-daily-note"></p>
      <div class="game-daily-finish"></div>
    </div>`);
    result.appendChild(card);
    paintSoloBoard(card);
  }

  function paintSoloBoard(card, completed, gaveUpInfo) {
    const run = soloRun;
    if (!run) return;
    const q = (sel) => card.querySelector(sel);
    const mk = (t, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = t; return s; };
    const pair = q('.game-daily-pair');
    pair.innerHTML = '';
    pair.appendChild(mk(run.start_band.name));
    pair.appendChild(mk('→', 'game-daily-arrow'));
    pair.appendChild(mk(run.target.name));

    const econLine = q('.game-daily-econ');
    econLine.innerHTML = '';
    econLine.appendChild(mk(`Par ${run.par} · `));
    const creditBtn = el('<button type="button" class="game-credit-btn"></button>');
    creditBtn.textContent = `${run.credits} credits`;
    creditBtn.setAttribute('aria-label', 'Your credit balance — how credits work');
    creditBtn.addEventListener('click', () => toggleCreditSheet(card, run));
    econLine.appendChild(creditBtn);

    const picksRow = q('.game-daily-picks');
    picksRow.innerHTML = '';
    for (const p of run.picks) {
      const wrap = document.createElement('span');
      wrap.innerHTML = pickSvg(p.color, 'game-daily-pick');
      wrap.title = `${p.name} — ${p.kind === 'optimal' ? 'optimal' : p.kind === 'deadend' ? 'dead end' : 'valid'}`;
      picksRow.appendChild(wrap);
    }

    // Chain pills replace the old text trail (Aaron: the text was confusing).
    paintChainPills(card, run);
    paintPlayerLine(card, run);

    const note = q('.game-daily-note');
    const tools = q('.game-daily-tools');
    const optsBox = q('.game-daily-options');
    const finish = q('.game-daily-finish');
    optsBox.innerHTML = '';
    tools.innerHTML = '';
    finish.innerHTML = '';
    soloRevealArmed = false;

    if (run.status === 'given_up') {
      paintSoloGiveUp(card, gaveUpInfo);
      return;
    }

    if (completed || run.status === 'complete') {
      const c = completed || {};
      let line = `Connected in ${run.hops_used} hop${run.hops_used === 1 ? '' : 's'} (par ${run.par}).`;
      if (c.optimal) line += ' The tree nods.';
      if (c.credits_earned) line += ` +${c.credits_earned} credits.`;
      q('.game-daily-current').textContent = line;
      const again = el('<button type="button" class="tool-chip">New matchup</button>');
      again.addEventListener('click', () => startSoloRun({ fresh: true }));
      finish.appendChild(again);
      return;
    }

    const cur = q('.game-daily-current');
    cur.innerHTML = '';
    cur.appendChild(mk('Now at: '));
    const strong = document.createElement('strong');
    strong.textContent = run.current_band.name;
    cur.appendChild(strong);

    for (const o of soloOptions) {
      const btn = el('<button type="button" class="game-daily-option"></button>');
      btn.textContent = o.name;
      btn.dataset.optionId = o.id;
      btn.addEventListener('click', () => soloPick(card, o.id, btn));
      optsBox.appendChild(btn);
    }

    const hintsLeft = run.hints_total - run.hints_used;
    if (hintsLeft > 0) {
      const elim = el('<button type="button" class="tool-chip">Cut one option (−10)</button>');
      elim.addEventListener('click', () => soloHint(card, 'eliminate'));
      const peek = el('<button type="button" class="tool-chip">Ask the tree (−10)</button>');
      peek.addEventListener('click', () => {
        soloRevealArmed = true;
        note.textContent = 'Tap a band to check whether it\u2019s on the optimal path. Helpers never solve — this only narrows.';
      });
      tools.appendChild(elim);
      tools.appendChild(peek);
      note.textContent = `${hintsLeft} hint${hintsLeft === 1 ? '' : 's'} left this run.`;
    } else {
      note.textContent = 'No hints left this run.';
    }

    const last = run.picks[run.picks.length - 1];
    if (last && last.kind === 'deadend') {
      const esc = el('<button type="button" class="tool-chip"></button>');
      // Same bail-out joke as the daily: a session legend in the room wears
      // the escape's name. Same price, same effect.
      esc.textContent = run.bailout
        ? `${run.bailout} bails you out (−50)`
        : 'Dig out of the dead end (−50)';
      esc.addEventListener('click', () => soloEscape(card));
      tools.appendChild(esc);
      note.textContent = `Lost in space. ${note.textContent}`;
    }

    const freshBtn = el('<button type="button" class="tool-chip">New matchup</button>');
    freshBtn.addEventListener('click', () => startSoloRun({ fresh: true }));
    tools.appendChild(freshBtn);

    const giveup = el('<button type="button" class="tool-chip">Show me the chain</button>');
    giveup.addEventListener('click', () => {
      note.innerHTML = '';
      note.appendChild(mk('This run ends and the tree reveals the path. '));
      const yes = el('<button type="button" class="tool-chip">Show me</button>');
      const no = el('<button type="button" class="tool-chip">Keep playing</button>');
      yes.addEventListener('click', () => soloGiveUp(card));
      no.addEventListener('click', () => paintSoloBoard(card));
      note.appendChild(yes);
      note.appendChild(mk(' '));
      note.appendChild(no);
    });
    tools.appendChild(giveup);
  }

  function paintSoloGiveUp(card, gaveUp) {
    const run = soloRun;
    const mk = (t, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = t; return s; };
    card.querySelector('.game-daily-current').textContent = 'The tree wins this one.';
    const finish = card.querySelector('.game-daily-finish');
    const rev = el('<div class="game-daily-reveal"></div>');
    rev.appendChild(mk('The tree reveals the path: '));
    const strong = document.createElement('strong');
    strong.textContent = (run.reveal_path || []).map((b) => b.name).join(' → ');
    rev.appendChild(strong);
    finish.appendChild(rev);

    const again = el('<button type="button" class="tool-chip">New matchup</button>');
    again.addEventListener('click', () => startSoloRun({ fresh: true }));
    finish.appendChild(again);
  }

  async function soloPick(card, optionId, btn) {
    const note = card.querySelector('.game-daily-note');
    if (soloRevealArmed && btn) {
      // Peek: reveal whether this band is on the optimal path, no pick made.
      soloRevealArmed = false;
      btn.disabled = true;
      try {
        const data = await dailyFetch('/api/game-solo/play', {
          method: 'POST',
          body: JSON.stringify({ action: 'hint', type: 'reveal', option_id: optionId }),
        });
        soloRun = data.run;
        soloOptions = data.options || [];
        // Analytics: hint used (peek/reveal)
        if (analyticsSessionId) {
          analyticsHintCount++;
          trackGameEvent({
            session_id: analyticsSessionId,
            event_type: 'hint_clicked',
            game_mode: 'solo',
          });
        }
        paintSoloBoard(card);
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
      const data = await dailyFetch('/api/game-solo/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'pick', option_id: optionId }),
      });
      soloRun = data.run;
      soloOptions = data.options || [];
      // Analytics: move made
      if (analyticsSessionId) {
        analyticsMoveCount++;
        trackGameEvent({
          session_id: analyticsSessionId,
          event_type: 'move_made',
          game_mode: 'solo',
          move_number: analyticsMoveCount,
        });
      }
      if (data.completed) {
        // Analytics: game completed (win)
        if (analyticsSessionId) {
          const durationSeconds = analyticsGameStartTime
            ? Math.round((Date.now() - analyticsGameStartTime) / 1000)
            : null;
          trackGameEvent({
            session_id: analyticsSessionId,
            event_type: 'game_completed',
            game_mode: 'solo',
            result: 'win',
            moves_count: analyticsMoveCount,
            hints_used: analyticsHintCount,
            duration_seconds: durationSeconds,
          });
          analyticsSessionId = null; // session over
        }
        paintSoloBoard(card, data.completed);
      } else {
        paintSoloBoard(card);
        if (data.picked && data.picked.deadend) {
          card.querySelector('.game-daily-note').textContent = 'Lost in space.';
        }
      }
    } catch (err) {
      note.textContent = err.message;
      card.querySelectorAll('.game-daily-option').forEach((b) => { b.disabled = false; });
    }
  }

  async function soloHint(card, type) {
    const note = card.querySelector('.game-daily-note');
    try {
      const data = await dailyFetch('/api/game-solo/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'hint', type }),
      });
      soloRun = data.run;
      soloOptions = data.options || [];
      // Analytics: hint used (eliminate)
      if (analyticsSessionId) {
        analyticsHintCount++;
        trackGameEvent({
          session_id: analyticsSessionId,
          event_type: 'hint_clicked',
          game_mode: 'solo',
        });
      }
      paintSoloBoard(card);
      if (data.hint && data.hint.eliminated) {
        card.querySelector('.game-daily-note').textContent =
          `${data.hint.eliminated.name} is out — not the way through.`;
      }
    } catch (err) {
      note.textContent = err.message;
    }
  }

  async function soloEscape(card) {
    const note = card.querySelector('.game-daily-note');
    const who = soloRun && soloRun.bailout;
    try {
      const data = await dailyFetch('/api/game-solo/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'escape' }),
      });
      soloRun = data.run;
      soloOptions = data.options || [];
      paintSoloBoard(card);
      card.querySelector('.game-daily-note').textContent = who
        ? `${who.split(' ').pop()} got you out of the black hole.`
        : `Dug out — ${data.escaped.name} is off your trail.`;
    } catch (err) {
      note.textContent = err.message;
    }
  }

  async function soloGiveUp(card) {
    const note = card.querySelector('.game-daily-note');
    note.textContent = 'The tree is revealing the path…';
    try {
      const data = await dailyFetch('/api/game-solo/play', {
        method: 'POST',
        body: JSON.stringify({ action: 'giveup' }),
      });
      soloRun = data.run;
      soloOptions = [];
      // Analytics: game completed (abandon — player gave up)
      if (analyticsSessionId) {
        const durationSeconds = analyticsGameStartTime
          ? Math.round((Date.now() - analyticsGameStartTime) / 1000)
          : null;
        trackGameEvent({
          session_id: analyticsSessionId,
          event_type: 'game_completed',
          game_mode: 'solo',
          result: 'abandon',
          moves_count: analyticsMoveCount,
          hints_used: analyticsHintCount,
          duration_seconds: durationSeconds,
        });
        analyticsSessionId = null; // session over
      }
      paintSoloBoard(card, null, data.gave_up);
    } catch (err) {
      note.textContent = (err && err.message) || 'Could not show the chain.';
    }
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
        // Normalize umlauts/diacritics so "motley" finds "Mötley Crüe",
        // "husker" finds "Hüsker Dü", etc.
        const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const nq = norm(q);
        items = [...g.bands.values()]
          .filter((b) => norm(b.name).includes(nq))
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
    // Solo v2 is server-dealt — no client graph needed. A band-A pick deals
    // a fresh run with your band; no pick resumes the live run (or the tree
    // deals both bands when there's nothing to resume).
    if (mode === 'solo') {
      // If the user typed a band name but didn't pick from autocomplete, it's
      // not in the graph — show No Rawk Found, don't silently deal a random
      // pair (Aaron, 2026-10-07).
      const typedA = (fieldA.value || '').trim();
      if (typedA && !selected.a) {
        statusLine.textContent = '';
        result.innerHTML = '';
        const card = el(`<div class="game-result-card game-daily">
          <div class="game-daily-head"><span class="game-hops">No Rawk Found</span></div>
          <p class="game-daily-note"></p>
          <div style="margin-top:12px"><button class="game-btn game-btn-primary" type="button">Add "${typedA}" to the tree</button></div>
        </div>`);
        card.querySelector('.game-daily-note').textContent =
          `"${typedA}" isn't in the tree yet.`;
        const addBtn = card.querySelector('button');
        if (addBtn) addBtn.addEventListener('click', () => {
          // Close the game modal and open the Add Band flow.
          try { document.getElementById('game-modal-close')?.click(); } catch {}
          setTimeout(() => document.getElementById('add-band-btn')?.click(), 100);
        });
        result.appendChild(card);
        return;
      }
      await startSoloRun(selected.a ? { bandA: selected.a, fresh: true } : {});
      return;
    }
    result.innerHTML = '';
    statusLine.textContent = 'Running the chain…';
    try {
      const g = await loadGraph();
      let a = selected.a;
      let b = selected.b;
      // If the user typed a band name but didn't pick from autocomplete, it's
      // not in the graph — show No Rawk Found (Aaron, 2026-10-07).
      const typedA = (fieldA.value || '').trim();
      const typedB = (fieldB.value || '').trim();
      const missing = (typedA && !a) ? typedA : (typedB && !b) ? typedB : null;
      if (missing) {
        statusLine.textContent = '';
        result.innerHTML = '';
        const card = el(`<div class="game-result-card game-daily">
          <div class="game-daily-head"><span class="game-hops">No Rawk Found</span></div>
          <p class="game-daily-note"></p>
          <div style="margin-top:12px"><button class="game-btn game-btn-primary" type="button">Add "${missing}" to the tree</button></div>
        </div>`);
        card.querySelector('.game-daily-note').textContent =
          `"${missing}" isn't in the tree yet.`;
        const addBtn = card.querySelector('button');
        if (addBtn) addBtn.addEventListener('click', () => {
          try { document.getElementById('game-modal-close')?.click(); } catch {}
          setTimeout(() => document.getElementById('add-band-btn')?.click(), 100);
        });
        result.appendChild(card);
        return;
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
      const shareData = { title: 'Six Degrees of Rock — Challenge', text: shareText, url: inviteUrl };
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
  async function createCasualChallenge(bandA, inReplyTo) {
    // Battle name first: the picker shows inline only when the player
    // doesn't have one yet.
    await withHandle(async () => {
    statusLine.textContent = 'Making your invite…';
    try {
      const reqBody = { band_a: bandA };
      if (inReplyTo) reqBody.in_reply_to = inReplyTo;
      const res = await fetch('/api/game-challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken() },
        body: JSON.stringify(reqBody),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.inviteUrl) throw new Error((data && data.error) || 'request failed');
      const g = await loadGraph();
      statusLine.textContent = '';
      showInviteDialog({
        matchup: `${bandName(g, bandA)} vs ?`,
        inviteUrl: data.inviteUrl,
        shareText: `Challenge: I picked ${bandName(g, bandA)}. Think you can stump me?`,
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
    const typedChallengeA = (fieldA.value || '').trim();
    if (typedChallengeA && !selected.a) {
      statusLine.textContent = `"${typedChallengeA}" isn't in the tree yet. Pick a band from the list, or add it from the main page.`;
      fieldA.focus();
      return;
    }
    if (!selected.a) { statusLine.textContent = 'Pick your band first.'; fieldA.focus(); return; }
    // Arena page with a match format selected -> structured match.
    // Everywhere else -> the casual quick challenge.
    if (isArenaPage() && currentFormat() !== 'quick') {
      await createMatch(currentFormat(), selected.a);
      return;
    }
    const replyTo = pendingReplyTo;
    pendingReplyTo = null;
    await createCasualChallenge(selected.a, replyTo);
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
        <div class="game-result-meta"><span class="game-hops">Challenge</span></div>
        <p class="game-invite-text"></p>
        <div class="game-result-actions"><button type="button" class="game-run-btn" data-signin>Sign in to accept</button></div>
      </div>`);
      card.querySelector('.game-invite-text').textContent =
        `${data.challenger_handle || 'Someone'} picked ${nameA}. ` +
        `You pick a band to stump them \u2014 the tree links bands through shared members ` +
        `and reveals the shortest chain. Sign in to play.`;
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
        // Pretty URL: the card unfurls with challenger + band in texts.
        const url = `${window.location.origin}/invite/${encodeURIComponent(token)}`;
        const okCopy = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
        statusLine.textContent = okCopy ? 'Invite link copied.' : url;
      });
      result.innerHTML = '';
      result.appendChild(card);
      setModePickerVisible(false);
      return;
    }

    // The accept view: band A is locked (the challenger's pick, visible —
    // open picks), you pick band B.
    setHeadToHead(data.band_a, null, g);
    fieldA.disabled = true;
    // setHeadToHead -> syncModeUI hides the band B field in head-to-head
    // mode, but the accept view NEEDS it (you pick band B here). Re-show it.
    wrapB.style.display = '';
    if (acceptBtn) {
      acceptBtn.style.display = '';
      acceptBtn.onclick = () => acceptChallenge(token);
    }
    runBtn.style.display = 'none';
    if (challengeBtn) challengeBtn.style.display = 'none';
    // The front-door explainer (Paul, 2026-10-01): plain-rules, no hype.
    showHowto(
      `${data.challenger_handle || 'Your challenger'} picked ${nameA}. ` +
      `You pick a band \u2014 one you think the tree can't connect to ${nameA}. ` +
      `Bands link through shared members; the tree reveals the shortest chain. Stump them.`
    );
    statusLine.textContent = 'Now pick yours.';
    setModePickerVisible(false);
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
      showHowto('');
      setModePickerVisible(true);
      const g = await loadGraph();
      renderMatchup(g, data.band_a, data.band_b);
      // Turn handoff (Paul, 2026-10-01: "it's not clear that it's now my
      // turn"). After the reveal, a Challenge-back button joins the result
      // actions and the status line names whose turn it is.
      const connectBtn = result.querySelector('[data-connect]');
      if (connectBtn) connectBtn.addEventListener('click', () => {
        const actions = result.querySelector('.game-result-actions');
        if (!actions || actions.querySelector('[data-challenge-back]')) return;
        const backBtn = el('<button type="button" class="tool-chip" data-challenge-back>Challenge back</button>');
        backBtn.addEventListener('click', () => {
          setHeadToHead(null, null, g);
          pendingReplyTo = token;
          statusLine.textContent = 'Your turn to deal — pick your band, then Challenge a friend.';
          modal.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setTimeout(() => fieldA.focus(), 300);
        });
        actions.appendChild(backBtn);
        statusLine.textContent = `It's your turn — challenge ${data.challenger_handle || 'them'} back.`;
      }, { once: true });
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
    // Queues live under the Challenge tab — never un-hide from another mode.
    if (currentMode() !== 'head-to-head') { wrap.hidden = true; return; }
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
      // Pretty invite URL: /invite/<token> serves the challenge card (dynamic
      // og: tags) and hands the recipient off to /game/?invite=. (2026-10-01:
      // the old /game/?invite= link unfurled as a generic webpage share.)
      const url = `${window.location.origin}/invite/${encodeURIComponent(token)}`;
      const okCopy = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
      statusLine.textContent = okCopy ? 'Invite link copied.' : url;
    };
    const challengeBack = (replyToToken) => () => {
      setHeadToHead(null, null, g);
      pendingReplyTo = replyToToken || null;
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
          [['See the chain', seeChain(c.band_a, c.band_b)], ['Challenge back', challengeBack(c.token)], ['Rematch', rematch(c.band_b)]]);
      } else if (c.status === 'open') {
        // Incoming unanswered challenge (reply-stamped via in_reply_to).
        // Aaron's copy call (2026-10-01): make it unmistakable whose turn
        // it is and what they answered with.
        row(`${c.challenger_handle || 'Someone'} challenged you back — he answered with ${bandName(g, c.band_a)}.`,
          [['Accept', () => { window.location.href = `/game/?invite=${encodeURIComponent(c.token)}`; }]]);
      }
    }
    if (wrap) wrap.hidden = count === 0 || currentMode() !== 'head-to-head';
  }

  if (inviteToken) handleInvite(inviteToken);
  if (matchToken) handleMatch(matchToken);
  loadChallenges();
  if (isArenaPage()) { loadMatches(); renderArenaPlayerBadge(); }

  // --- arena player badge ----------------------------------------------------
  // Shows who you're playing as in the arena header — critical when one
  // person has multiple accounts (email, Google, Instagram all land on
  // different rows). Updates once the handle resolves.
  async function renderArenaPlayerBadge() {
    const badge = document.getElementById('arena-player');
    if (!badge) return;
    try {
      if (!isSignedIn()) {
        badge.hidden = false;
        badge.removeAttribute('data-action');
        badge.innerHTML = '';
        const link = document.createElement('a');
        link.href = '/';
        link.textContent = 'Sign in to play';
        link.style.color = 'inherit';
        link.style.textDecoration = 'none';
        badge.appendChild(link);
        return;
      }
      const h = await loadMyHandle();
      badge.hidden = false;
      badge.innerHTML = '';
      if (h) {
        badge.removeAttribute('data-action');
        badge.appendChild(document.createTextNode('Playing as '));
        const strong = document.createElement('strong');
        strong.textContent = h;
        badge.appendChild(strong);
      } else {
        // Signed in but no battle name yet — tap to pick one.
        badge.setAttribute('data-action', 'pick-handle');
        badge.textContent = 'Pick your battle name';
        badge.onclick = () => {
          showHandlePicker({
            title: 'Pick your battle name',
            subtitle: 'This is the name opponents see on challenges and matches — not your real name.',
            cta: 'Save',
            onSaved: () => { myHandleCache = null; renderArenaPlayerBadge(); },
          });
        };
      }
    } catch (_) {
      // Never break the arena for a badge — hide it quietly.
      badge.hidden = true;
    }
  }

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
  // Paint the top player line on load (before any game card renders).
  try {
    const topLine = document.getElementById('game-player-line-top');
    if (topLine) {
      const seq = 1;
      topLine.dataset.seq = String(seq);
      // Fetch handle and credits independently of game board rendering
      // (Aaron, 2026-10-07: show on load, not just after nav).
      // If no handle yet, prompt to choose one (Aaron, 2026-10-07).
      // New players start with 50 credits (DB default).
      const paintTopLine = () => {
        Promise.all([
          loadMyHandle().catch(() => ''),
          fetch('/api/game-credits', {
            headers: { authorization: 'Bearer ' + authToken() },
          }).then((r) => r.json().catch(() => ({}))).catch(() => ({})),
        ]).then(([h, credData]) => {
          if (topLine.dataset.seq !== String(seq)) return;
          const credits = credData && credData.ok && credData.credits != null ? credData.credits : null;
          const signedIn = isSignedIn();
          if (!signedIn) {
            topLine.innerHTML = '<span style="opacity:.7">Sign in to play</span>';
            // Retry in 2s — auth token may not be in localStorage yet on
            // initial page load (Aaron, 2026-10-07).
            setTimeout(() => {
              if (topLine.dataset.seq !== String(seq)) return;
              try {
                const raw = localStorage.getItem('bmft-user');
                if (raw && JSON.parse(raw).token) {
                  paintTopLine();
                }
              } catch {}
            }, 2000);
            return;
          }
          if (!h && credits != null) {
            // No battle name yet — prompt to choose one.
            topLine.innerHTML = '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.style.cssText = 'background:none;border:none;padding:0;font:inherit;color:inherit;cursor:pointer;text-decoration:underline';
            btn.textContent = 'Choose your battle name';
            btn.addEventListener('click', () => {
              if (typeof showHandlePicker === 'function') {
                showHandlePicker({ title: 'Choose your battle name', onSaved: paintTopLine });
              }
            });
            topLine.appendChild(btn);
            topLine.appendChild(document.createTextNode(' \u00b7 ' + credits + ' credits'));
          } else if (h && credits != null) {
            topLine.textContent = 'Playing as ' + h + ' \u00b7 ' + credits + ' credits';
          } else if (h) {
            topLine.textContent = 'Playing as ' + h;
          } else if (credits != null) {
            topLine.textContent = credits + ' credits';
          }
        });
      };
      paintTopLine();
      // Re-paint when auth state changes (e.g., after sign-in).
      window.addEventListener('sdr-auth-changed', paintTopLine);
    }
  } catch {}
}

if (isBrowser) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGameUI);
  } else {
    initGameUI();
  }
}

// V2 defensive re-sync: directly set button visibility on window.load,
// bypassing the event system entirely. The v1 fix dispatched a synthetic
// 'change' event, but if initGameUI() threw before attaching listeners,
// the event had no handler. This version manipulates the DOM directly.
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    try {
      const isArena = /(^|\/)game\/?$/.test(window.location.pathname);
      const checked = document.querySelector('input[name="game-mode"]:checked');
      const mode = (checked || {}).value || 'daily';
      if (mode === 'head-to-head') {
        const btn = document.getElementById('game-challenge-btn');
        if (btn) btn.style.display = '';
        if (isArena) {
          const wrap = document.getElementById('game-format-wrap');
          if (wrap) wrap.style.display = '';
          // Update button text to match format
          const fmt = document.getElementById('game-match-format');
          if (btn && fmt && fmt.value !== 'quick') {
            btn.textContent = 'Start match';
          }
        }
      }
    } catch (_) { /* never break page load */ }
  });
}
