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
// Daily Chain — Wordle-style rules and sharing (pure, unit-tested)
// ---------------------------------------------------------------------------

// The header's "🎮 Ways to play" switcher (Solo / Challenge / Explore /
// Stakes). Off for launch so first-time visitors land on the Daily Chain and
// nothing else (Cole, 2026-10-08). Everything behind it — the sheet, the
// radios, every mode — still works; flip to true to bring it back.
export const SHOW_MODE_SWITCHER = false;

// Moves you get beyond par before the tree wins. Client-side rule: running
// out calls the existing `giveup` action, so the server stays authoritative.
export const DAILY_EXTRA_MOVES = 3;
export function dailyMoveLimit(par) {
  return Math.max(1, Number(par) || 3) + DAILY_EXTRA_MOVES;
}

// "#9" in the share text: day one of the Daily Chain was 2026-09-30.
export const DAILY_EPOCH = '2026-09-30';
export function dailyPuzzleNumber(date) {
  const day = (s) => Date.UTC(...String(s).split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)));
  const n = Math.round((day(date) - day(DAILY_EPOCH)) / 86400000) + 1;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Wordle's tile colors, mapped onto a pick's kind.
export function dailyPickSquare(kind) {
  if (kind === 'optimal') return '🟩';
  if (kind === 'deadend') return '🟥';
  return '🟨';
}

// A dead end costs a move but isn't a link in the chain, so "hops" (links
// you built) and "moves" (taps you spent) differ by the dead ends. Reporting
// moves as hops read as an off-by-one (Ramones → 4 bands → Megadeth "6 hops").
export function dailyChainCounts(picks = []) {
  const deadEnds = picks.filter((p) => p.kind === 'deadend').length;
  return { hops: picks.length - deadEnds, deadEnds, moves: picks.length };
}

// Seconds until the next daily chain: midnight in America/Los_Angeles, which
// is when pacificDate() rolls over on the server. A countdown is right in
// every timezone, unlike "midnight Pacific" or "midnight local" copy.
export function secondsToNextChain(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const h = Number(parts.hour) % 24; // some engines print midnight as "24"
  return 86400 - (h * 3600 + Number(parts.minute) * 60 + Number(parts.second));
}

export function fmtCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// Musician names on a chain connector. Compact for the scrolling chain row
// ("Tom Morello +2"); full for sentences ("Tom Morello, Tim Commerford and
// Brad Wilk").
export function fmtMembersShort(names = []) {
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}
export function fmtMembersLong(names = []) {
  if (names.length <= 1) return names[0] || '';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

export function fmtElapsed(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Spoiler-free share text, Wordle-style (Cole, 2026-10-08): no slogan,
// no timer (the clock counted idle hours, e.g. "194m"), just the score,
// the squares and the link.
//   Six Degrees of Rock #17 🎸 5/4      (X/4 on a loss)
//   Rage Against the Machine ➡️ 🟩🟥🟨🟩🟩 ➡️ Pearl Jam
//   sixdegreesofrock.com/game
// One square per move, so the squares always match the score.
export function dailyShareResultText({ date, start, target, picks = [], moves = picks.length, par, won }) {
  const num = dailyPuzzleNumber(date);
  const score = `${won ? moves : 'X'}/${par}`;
  const squares = picks.map((p) => dailyPickSquare(p.kind)).join('');
  return [
    `Six Degrees of Rock${num ? ` #${num}` : ''} 🎸 ${score}`,
    [start, ...(squares ? [squares] : []), target].join(' ➡️ '),
    'sixdegreesofrock.com/game',
  ].join('\n');
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
      statusLine.textContent = 'Could not load the band data. Check your connection and try again.';
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
    // The header's 🎮 switcher stands in for the tucked-away pills.
    const btn = document.getElementById('game-modes-btn');
    if (btn) btn.style.display = v && SHOW_MODE_SWITCHER ? '' : 'none';
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

  // Guest session ID (2026-10-08): persistent anonymous ID for guests.
  function getGuestSessionId() {
    try {
      let id = localStorage.getItem('sdr-guest-session');
      if (!id) {
        id = 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
        localStorage.setItem('sdr-guest-session', id);
      }
      return id;
    } catch { return 'g_fallback_' + Date.now(); }
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
    // Paint the top player line when the modal opens (the div may not exist
    // at page-load init time if the modal HTML is injected later).
    // (Aaron, 2026-10-07: root fix for player line on initial load.)
    try {
      const topLine = document.getElementById('game-player-line-top');
      if (topLine) {
        // No credits for launch (Cole, 2026-10-08): just who you are. The
        // daily board adds your streak once it loads (paintPlayerLine).
        (typeof loadMyHandle === 'function' ? loadMyHandle() : Promise.resolve(''))
          .catch(() => '')
          .then((h) => { if (h && !topLine.textContent) topLine.textContent = 'Playing as ' + h; });
      }
    } catch {}
    loadGraph().catch(() => {
      statusLine.textContent = 'Could not load the band data. Check your connection and try again.';
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
    syncModesButton();
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
      // Daily explains itself on the board (Cole, 2026-10-08: the same
      // tagline was printed three times above the puzzle).
      descEl.style.display = mode === 'daily' ? 'none' : '';
    }
    // Mode-specific subtitle (Aaron, 2026-10-07: "Name two bands" is wrong on Daily).
    // Placed here (before challenge queue loading) so a throw in loadChallenges()
    // can't block the subtitle update.
    try {
      const sub = document.querySelector('.game-modal-sub');
      const subtitles = {
        daily: 'One fresh chain every day — same for everyone. Connect the bands, beat par, build your streak.',
        solo: 'Practice mode. Pick a band, we deal the opponent, you find the chain.',
        'head-to-head': 'Challenge a friend. You pick a band, they pick theirs, the shortest chain decides.',
        chaos: 'Two random bands. Hit Connect and see how they link.',
      };
      if (sub && subtitles[mode]) sub.textContent = subtitles[mode];
      if (sub) sub.style.display = mode === 'daily' ? 'none' : '';
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
      // Empty action row + status line left a gap above the board.
      const actionsRow = document.querySelector('.game-actions');
      if (actionsRow) actionsRow.style.display = 'none';
      statusLine.style.display = 'none';
      renderDailyPanel();
      return;
    }
    {
      const actionsRow = document.querySelector('.game-actions');
      if (actionsRow) actionsRow.style.display = '';
      statusLine.style.display = '';
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

  // "Ways to play" sheet (Cole, 2026-10-08): the five pills crowded the top
  // of the card, so they're tucked away and this sheet drives the same
  // radios. Daily stays the front door; the rest are one tap off.
  function modeLabelOf(input) {
    const strong = input.closest('label')?.querySelector('strong');
    return strong ? strong.textContent.trim() : input.value;
  }
  function syncModesButton() {
    const btn = document.getElementById('game-modes-btn');
    const cur = modeInputs.find((i) => i.checked);
    if (!btn || !cur) return;
    const label = modeLabelOf(cur);
    const slot = btn.querySelector('[data-mode-label]');
    if (slot) slot.textContent = label;
    btn.setAttribute('aria-label', `Ways to play: ${label}`);
  }
  function openModesSheet() {
    openSdModal((c) => {
      c.appendChild(el('<h2>Ways to play</h2>'));
      const list = el('<div class="sd-mode-list"></div>');
      for (const input of modeInputs) {
        const row = el('<button type="button" class="sd-mode"><strong></strong><span></span></button>');
        row.querySelector('strong').textContent = modeLabelOf(input);
        const desc = input.closest('label')?.querySelector('strong + span');
        row.querySelector('span').textContent = input.disabled
          ? 'Coming soon'
          : (desc ? desc.textContent.trim() : '');
        if (input.checked) row.setAttribute('aria-current', 'true');
        if (input.disabled) row.disabled = true;
        row.addEventListener('click', () => {
          closeSdModal();
          if (input.checked) return;
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        list.appendChild(row);
      }
      c.appendChild(list);
    });
  }
  const modesBtn = document.getElementById('game-modes-btn');
  if (modesBtn) {
    modesBtn.addEventListener('click', openModesSheet);
    if (!SHOW_MODE_SWITCHER) modesBtn.style.display = 'none';
  }
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

      /* --- Daily board, Wordle-simple (Cole, 2026-10-08) -------------------
         One goal, one chain, one question, four big buttons. Everything else
         (hints, streak, credits, past days) sits in quiet drawers below. */
      .sd-board,.sd-modal,.sd-toast{--sd-good:#3fa36b;--sd-ok:#c9a83a;--sd-bad:#c8584f}
      .sd-topbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px}
      .sd-topbar .game-daily-head{margin:0}
      .sd-icon{flex:none;width:36px;height:36px;border-radius:999px;border:1px solid var(--color-border);background:transparent;color:inherit;font:inherit;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
      .sd-icon:hover{border-color:rgba(82,174,182,.8)}
      .sd-board .game-player-line{display:none}
      .sd-goal{text-align:center;margin:10px 0 4px}
      .sd-goal-label{font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--color-text-muted)}
      .sd-goal .game-daily-pair{font-family:var(--font-display);font-size:clamp(1.3rem,1rem + 1.8vw,1.9rem);line-height:1.2;margin:6px 0 4px}
      .sd-goal .game-daily-arrow{color:var(--accent);margin:0 .3em}
      .sd-goal-meta{font-size:.9rem;color:var(--color-text-muted);margin:0}
      .sd-goal-meta strong{color:var(--color-text)}
      .sd-board .game-chain-pills{position:relative;flex-wrap:nowrap;overflow-x:auto;justify-content:safe center;padding:6px 6px 8px;margin:10px 0 4px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
      .sd-board .game-chain-pills::-webkit-scrollbar{display:none}
      .sd-board .game-chain-pill{flex:none;max-width:150px}
      /* Full band names, never "The Flowers of Ro…" (Cole, 2026-10-08):
         long names wrap to a second line inside the pill. */
      .sd-board .game-chain-pill,.sd-modal .game-chain-pill{white-space:normal;overflow:visible;text-overflow:clip;text-align:center;line-height:1.25;border-radius:14px;overflow-wrap:break-word}
      .sd-countdown{text-align:center;font-size:.85rem;color:var(--color-text-muted);margin:8px 0 0}
      .sd-countdown strong{color:var(--color-text);font-variant-numeric:tabular-nums;letter-spacing:.04em}
      .sd-link{flex:none;color:var(--color-text-faint);font-size:.8rem}
      .sd-via{display:inline-flex;flex-direction:column;align-items:center;gap:1px;line-height:1.1;max-width:110px;text-align:center}
      .sd-ico{width:1.05em;height:1.05em;flex:none;vertical-align:-0.18em}
      .sd-ico-text{display:inline-flex;align-items:center;gap:.4em}
      .sd-modal h2 .sd-ico-text,.sd-gameover-title .sd-ico-text{gap:.35em}
      .sd-result-pick{width:18px;height:21px;vertical-align:-4px;margin:0 2px}
      .tool-chip .sd-ico{margin-right:4px}
      /* Chain timeline: a 2px rail through the dot centers (dot 12px wide,
         so its center is 6px in), band pills 14px right of the dots, and
         "via" lines indented to the same 26px so everything lines up. */
      .sd-chain-list{position:relative;list-style:none;margin:8px auto 14px;padding:0;display:flex;flex-direction:column;align-items:flex-start;gap:6px;width:fit-content;max-width:100%;text-align:left}
      .sd-chain-list::before{content:'';position:absolute;left:5px;top:16px;bottom:16px;width:2px;border-radius:2px;background:rgba(143,232,246,.22)}
      .sd-chain-node{display:flex;align-items:center;gap:14px;position:relative}
      .sd-chain-dot{flex:none;width:12px;height:12px;border-radius:50%;background:var(--color-bg);border:2px solid var(--sd-good);position:relative;z-index:1}
      .sd-chain-node.is-anchor .sd-chain-dot{border-color:var(--color-primary);background:var(--color-primary)}
      .sd-chain-list .game-chain-pill{max-width:none;margin:0}
      .sd-chain-via{padding-left:26px;font-size:.82rem;line-height:1.35;max-width:100%}
      .sd-chain-via-label{color:var(--color-text-faint);font-weight:500}
      .sd-chain-via-names{color:var(--color-text);font-weight:600}
      .sd-stat strong{display:flex;align-items:center;justify-content:center;gap:.2em;min-height:1.15em}
      .sd-stat strong .sd-ico{width:.7em;height:.7em}
      .sd-modal-close:focus:not(:focus-visible){outline:none;box-shadow:none}
      .sd-modal-close:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
      .sd-map-link{display:flex;align-items:center;justify-content:center;gap:8px;margin:12px auto 0;width:fit-content;max-width:100%;font-size:.9rem;font-weight:600;color:var(--color-primary);text-decoration:none;text-align:center}
      .sd-map-link:hover span{text-decoration:underline;text-underline-offset:3px}
      .sd-map-link--modal{margin-top:14px}
      .sd-misses{text-align:center;font-size:.82rem;color:#f0b8b2;margin:-4px 0 8px}
      .sd-via-name{font-size:.68rem;font-style:italic;color:var(--color-text-muted);white-space:normal}
      .game-chain-good{border-color:var(--sd-good);background:color-mix(in srgb,var(--sd-good) 22%,transparent)}
      .game-chain-ok{border-color:var(--sd-ok);background:color-mix(in srgb,var(--sd-ok) 20%,transparent)}
      .sd-board .game-chain-deadend,.sd-modal .game-chain-deadend{border-color:var(--sd-bad);background:color-mix(in srgb,var(--sd-bad) 18%,transparent);color:#f3c4bf;text-decoration:line-through;text-decoration-thickness:1px}
      .game-chain-current{box-shadow:0 0 0 2px var(--color-bg),0 0 0 4px var(--color-primary)}
      .sd-pop{animation:sd-pop .45s cubic-bezier(.2,1.4,.4,1)}
      .sd-prompt{text-align:center;font-size:1.02rem;color:var(--color-text);margin:14px 0 10px;line-height:1.45}
      .sd-prompt strong{color:var(--color-primary)}
      .sd-board .game-daily-options{gap:10px;margin:0 0 6px}
      .sd-board .game-daily-option{min-height:56px;padding:12px 16px;text-align:center;font-size:1.05rem;border-radius:14px;transition:transform .12s,background-color .15s,border-color .15s;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
      .sd-board .game-daily-option:active{transform:scale(.98)}
      .sd-board .game-daily-option:disabled{opacity:1;cursor:default}
      .sd-board .game-daily-options.is-busy .game-daily-option:not(.is-pending){opacity:.45}
      .sd-board .game-daily-option.is-pending{border-color:var(--color-primary)}
      .game-daily-option.is-good{border-color:var(--sd-good);background:var(--sd-good);color:#fff}
      .game-daily-option.is-ok{border-color:var(--sd-ok);background:var(--sd-ok);color:#16130a}
      .game-daily-option.is-bad{border-color:var(--sd-bad);background:var(--sd-bad);color:#fff;animation:sd-shake .4s}
      .sd-board .game-daily-note{text-align:center;min-height:1.2em}
      .sd-finish-line{text-align:center;font-size:1.02rem;margin:14px 0 8px}
      .sd-finish-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:6px 0}
      .sd-drawers{display:flex;flex-direction:column;gap:2px;margin-top:14px;border-top:1px solid var(--color-divider);padding-top:6px}
      .sd-drawer>summary,.sd-board .game-daily-archive>summary{cursor:pointer;font-size:.9rem;color:var(--color-text-muted);padding:8px 0;list-style-position:inside}
      .sd-board .game-daily-archive{margin-top:0}
      .sd-drawer .game-daily-tools{margin:2px 0 8px}
      .sd-hints .tool-chip:disabled{opacity:.4;cursor:not-allowed}
      .sd-drawer .game-daily-econ{margin:2px 0 8px}
      .sd-toast{position:fixed;left:50%;top:84px;transform:translate(-50%,-8px);z-index:1100;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:#f2f6f9;color:#0f1319;font-weight:700;font-size:.95rem;box-shadow:0 10px 30px rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;text-align:center}
      .sd-toast.is-on{opacity:1;transform:translate(-50%,0);pointer-events:auto;cursor:pointer}
      .sd-result{text-align:center;font-size:.95rem;line-height:1.45;padding:9px 14px;margin:8px 0 0;border-radius:12px;border:1px solid transparent}
      .sd-result.is-good{border-color:color-mix(in srgb,var(--sd-good) 60%,transparent);background:color-mix(in srgb,var(--sd-good) 14%,transparent);color:#cdeedb}
      .sd-result.is-ok{border-color:color-mix(in srgb,var(--sd-ok) 60%,transparent);background:color-mix(in srgb,var(--sd-ok) 14%,transparent);color:#f1e3b4}
      .sd-result.is-bad{border-color:color-mix(in srgb,var(--sd-bad) 60%,transparent);background:color-mix(in srgb,var(--sd-bad) 14%,transparent);color:#f6cdc8}
      .sd-toast.is-bad{background:var(--sd-bad);color:#fff}
      .sd-toast.is-good{background:var(--sd-good);color:#fff}
      .sd-modal{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:16px}
      .sd-modal-backdrop{position:absolute;inset:0;background:rgba(2,5,9,.74);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
      .sd-modal-card{position:relative;width:100%;max-width:420px;max-height:calc(100dvh - 32px);overflow:auto;background:#0b131c;border:1px solid var(--color-border);border-radius:var(--radius-xl);padding:28px 20px 20px;box-shadow:var(--shadow-lg);animation:sd-rise .22s ease-out;color:var(--color-text)}
      .sd-modal-close{position:absolute;top:10px;right:10px;width:40px;height:40px;border-radius:999px;border:none;background:transparent;color:var(--color-text-muted);font-size:1.3rem;cursor:pointer}
      .sd-modal-close:hover{color:var(--color-text)}
      .sd-modal h2{font-family:var(--font-display);font-size:1.55rem;line-height:1.2;margin:0 32px 6px 0}
      .sd-modal p{margin:6px 0;line-height:1.5}
      .sd-modal ul{margin:8px 0 12px 20px;padding:0;line-height:1.55}
      .sd-modal-sub{color:var(--color-text-muted)}
      .sd-howto-ex{display:flex;flex-direction:column;gap:12px;margin:14px 0;padding:14px 0;border-top:1px solid var(--color-divider);border-bottom:1px solid var(--color-divider)}
      .sd-howto-ex .game-chain-pill{display:inline-block;margin-bottom:4px}
      .sd-howto-ex p{margin:0;font-size:.9rem;color:var(--color-text-muted)}
      .sd-result-chain{text-align:center;font-size:1rem;line-height:1.9;margin:14px 0 6px;word-break:break-word}
      .sd-result-stats{display:flex;flex-wrap:wrap;justify-content:center;gap:12px 24px;margin:14px 0 18px}
      .sd-stat{text-align:center}
      .sd-stat strong{display:block;font-size:1.8rem;line-height:1.1}
      .sd-stat > span{font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:var(--color-text-muted)}
      .sd-reveal{font-size:.9rem;color:var(--color-text-muted);text-align:center}
      .sd-reveal strong{color:var(--color-text)}
      .sd-primary{display:block;width:100%;min-height:52px;border-radius:999px;border:none;background:var(--color-primary);color:var(--color-text-inverse);font:inherit;font-weight:700;font-size:1.05rem;cursor:pointer}
      .sd-primary:hover{background:var(--color-primary-hover)}
      .sd-secondary{display:block;width:100%;min-height:46px;margin-top:10px;border-radius:999px;border:1px solid var(--color-border);background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
      .sd-guest{margin-top:16px;text-align:center;font-size:.88rem;color:var(--color-text-muted)}
      .sd-linkbtn{background:none;border:none;padding:0;font:inherit;color:var(--color-primary);text-decoration:underline;text-underline-offset:2px;cursor:pointer}
      .sd-board .game-daily-options.is-asking .game-daily-option{border-color:var(--color-primary);box-shadow:inset 0 0 0 1px var(--color-primary);animation:sd-glow 1.1s ease-in-out infinite alternate}
      @keyframes sd-glow{from{background:rgba(143,232,246,.06)}to{background:rgba(143,232,246,.16)}}
      .sd-giveup{display:block;margin:14px auto 0;font-size:.85rem;color:var(--color-text-muted)}
      .sd-giveup:hover{color:var(--color-text)}
      .sd-danger{border-color:color-mix(in srgb,var(--sd-bad) 70%,transparent);color:#f6cdc8}
      .sd-danger:hover{background:color-mix(in srgb,var(--sd-bad) 18%,transparent)}
      .sd-gameover{text-align:center;margin:14px 0 6px}
      /* Finished boards: the question, choices and note areas are empty;
         don't let their margins push the game-over block down. */
      .sd-board.is-over .sd-prompt:empty,.sd-board.is-over .game-daily-options:empty,.sd-board.is-over .game-daily-note:empty{display:none}
      .sd-gameover-title{font-family:var(--font-display);font-size:clamp(1.5rem,1.1rem + 1.6vw,2rem);font-weight:700;letter-spacing:.02em;margin:0;line-height:1.15}
      .sd-gameover-sub{color:var(--color-text-muted);font-size:1rem;margin:4px 0 0}
      .sd-reveal-label{text-align:center;font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--color-text-muted);margin:12px 0 4px}
      .sd-reveal-chain{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:6px;margin:0 0 10px}
      .sd-mode-list{display:grid;gap:8px;margin-top:14px}
      .sd-mode{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;padding:12px 14px;border:1px solid var(--color-border);border-radius:14px;background:transparent;color:inherit;font:inherit;cursor:pointer}
      .sd-mode strong{font-size:1rem}
      .sd-mode span{font-size:.85rem;color:var(--color-text-muted);line-height:1.4}
      .sd-mode:hover:not(:disabled){border-color:rgba(143,232,246,.55)}
      .sd-mode[aria-current]{border-color:var(--color-primary);background:rgba(143,232,246,.08)}
      .sd-mode:disabled{opacity:.5;cursor:default}
      @keyframes sd-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
      @keyframes sd-pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}
      @keyframes sd-rise{0%{transform:translateY(12px);opacity:0}100%{transform:none;opacity:1}}
      @media (prefers-reduced-motion:reduce){
        .sd-pop,.game-daily-option.is-bad,.sd-modal-card,.sd-board .game-daily-options.is-asking .game-daily-option{animation:none}
        .sd-toast{transition:none}
      }
    `;
    document.head.appendChild(st);
  }

  // Pick colors follow the board's traffic lights (Cole, 2026-10-08): green
  // is the shortest path, yellow the long way round, red a dead end. The
  // server still names them gold/robin/black; only the paint changed.
  const DAILY_PICK_HEX = { gold: '#3fa36b', robin: '#c9a83a', black: '#c8584f' };
  // Same mapping as the server's pickColor(kind).
  function pickColor(kind) {
    if (kind === 'optimal') return 'gold';
    if (kind === 'deadend') return 'black';
    return 'robin';
  }

  // Line icons drawn like the main site's header/menu icons, replacing the
  // emoji the team found "cutesy" (2026-10-08). Emoji stay in share text.
  const LINE_ICONS = {
    hint: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
    flame: '<path d="M12 3c.6 3 3.6 4.6 3.6 8.6a3.6 3.6 0 0 1-7.2 0c0-1.4.6-2.4 1.4-3.2.2 1.4 1 2.1 1.8 2.1 0-2.9-1.2-5.2.4-7.5z"/><path d="M6.4 13.5A5.6 5.6 0 0 0 12 21a5.6 5.6 0 0 0 5.6-5.6"/>',
    share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4"/><path d="M16 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4"/><path d="M8 21h8"/><path d="M10 17h4"/>',
    tree: '<path d="M12 21v-5"/><path d="M8 16h8a4 4 0 0 0 1-7.9A5 5 0 0 0 7 8.1 4 4 0 0 0 8 16z"/>',
    map: '<path d="M3 6.5l6-3 6 3 6-3v14l-6 3-6-3-6 3z"/><path d="M9 3.5v14"/><path d="M15 6.5v14"/>',
  };
  function lineIcon(name) {
    return `<svg class="sd-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LINE_ICONS[name] || ''}</svg>`;
  }
  // The guitar pick, outlined, as an icon (the game-over headline).
  function pickIcon() {
    return '<svg class="sd-ico" viewBox="0 0 24 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5c-5.2 0-9.5 4-9.5 9.3 0 6 5.2 11.6 8.6 14.2.5.4 1.3.4 1.8 0 3.4-2.6 8.6-8.2 8.6-14.2C21.5 6.5 17.2 2.5 12 2.5z"/></svg>';
  }
  // Icon + text, built safely (text never parsed as HTML).
  function iconText(iconHtml, text) {
    const span = el(`<span class="sd-ico-text">${iconHtml}<span></span></span>`);
    span.lastChild.textContent = text;
    return span;
  }
  function pickSvg(color, cls) {
    const hex = DAILY_PICK_HEX[color] || DAILY_PICK_HEX.black;
    const stroke = color === 'black' ? '#555' : 'rgba(0,0,0,.25)';
    return `<svg class="${cls}" viewBox="0 0 24 28" aria-hidden="true">` +
      `<path d="M12 2.5c-5.2 0-9.5 4-9.5 9.3 0 6 5.2 11.6 8.6 14.2.5.4 1.3.4 1.8 0 3.4-2.6 8.6-8.2 8.6-14.2C21.5 6.5 17.2 2.5 12 2.5z" ` +
      `fill="${hex}" stroke="${stroke}" stroke-width="1"/></svg>`;
  }

  function fmtChainDate(ds) {
    const parts = String(ds || '').split('-').map(Number);
    if (parts.length < 3) return String(ds || '');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[parts[1] - 1] || ''} ${parts[2]}, ${parts[0]}`;
  }

  let dailyRun = null;      // last run state from the server
  let dailyOptions = [];    // public options: [{id, name}]
  let dailyRevealArmed = false;
  // The last move's result, shown on the board until the next tap
  // (Cole, 2026-10-08: the toast vanished before anyone could read it).
  let dailyLastMove = null; // { kind, name, from }

  // Practice mode: a permanent product feature, not a test hook (Cole,
  // 2026-10-08). /game?practice=1 plays the same board against the Solo
  // endpoint with a fresh famous pair every time, and the daily's reveal
  // screen links here so players can keep playing. It's purely for fun:
  // no streak, no hints. The Daily Chain is where streaks and hints live.
  // game_solo_play.mjs enforces this too.
  const practiceMode = (() => {
    try { return isArenaPage() && new URLSearchParams(window.location.search).get('practice') === '1'; }
    catch { return false; }
  })();
  function practicePath(dailyPath) {
    return practiceMode ? '/api/game-solo/play' : dailyPath;
  }

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
    // Guest play: inject guest_session_id into JSON bodies when not signed in.
    let body = opts.body;
    if (body && typeof body === 'string' && !isSignedIn()) {
      try {
        const parsed = JSON.parse(body);
        parsed.guest_session_id = getGuestSessionId();
        body = JSON.stringify(parsed);
      } catch {}
    }
    const res = await fetch(path, {
      ...opts,
      body,
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
    // Guest play (2026-10-08): no sign-in gate. Guests play free;
    // backend creates a guest user row from guest_session_id.
    renderDailyBoard({ loading: true });
  }

  // Guest win prompt (Cole, 2026-10-08): "You won! Create a free account
  // to save your stats and daily streak." Shown after a guest completes a game.
  function showGuestWinPrompt(card) {
    try {
      if (!card || card.querySelector('[data-guest-win-prompt]')) return;
      const prompt = el(`<div data-guest-win-prompt style="
        margin-top:16px;padding:16px;border-radius:12px;
        background:linear-gradient(135deg,rgba(45,212,191,.15),rgba(45,212,191,.05));
        border:1px solid rgba(45,212,191,.3);text-align:center;">
        <p style="margin:0 0 8px;font-weight:700;font-size:1.1rem;">You won! 🎉</p>
        <p style="margin:0 0 12px;color:var(--color-text-muted);">
          Create a free account to save your stats and daily streak.
        </p>
        <button type="button" data-guest-signup
          style="background:var(--color-accent);color:#000;border:none;
          padding:10px 24px;border-radius:8px;font-weight:700;cursor:pointer;">
          Create free account
        </button>
      </div>`);
      card.appendChild(prompt);
      const btn = prompt.querySelector('[data-guest-signup]');
      if (btn) {
        btn.addEventListener('click', () => {
          if (typeof showSignInModal === 'function') {
            showSignInModal();
          } else {
            window.dispatchEvent(new CustomEvent('sdr-guest-signup-request'));
          }
        });
      }
    } catch {}
  }

  // Logged-out: the pair is the lure, playing needs sign-in.
  async function renderDailyGate() {
    result.innerHTML = '';
    const card = el(`<div class="game-result-card game-daily">
      <div class="game-daily-head"><span class="game-hops">Daily Chain</span><span class="game-daily-date"></span></div>
      <p class="game-daily-pair"></p>
      <p class="game-daily-note">One fresh chain every day — same for everyone. Sign in to play and keep your streak.</p>
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
    dailyLastMove = null;
    // A toast from the last puzzle must not narrate the new one.
    clearTimeout(sdToastTimer);
    document.querySelector('.sd-toast')?.classList.remove('is-on');
    // Wordle-simple layout (Cole, 2026-10-08): goal, chain, question, four
    // big buttons. Hints, streak/credits and past days live in drawers.
    const card = el(`<div class="game-result-card game-daily sd-board">
      <div class="sd-topbar">
        <div class="game-daily-head"><span class="game-hops">Daily Chain</span><span class="game-daily-date"></span></div>
        <button type="button" class="sd-icon" data-howto aria-label="How to play">?</button>
      </div>
      <div class="game-player-line"></div>
      <div class="sd-goal">
        <div class="sd-goal-label">Connect</div>
        <p class="game-daily-pair"></p>
        <p class="sd-goal-meta"></p>
      </div>
      <div class="game-chain-pills"></div>
      <p class="sd-result" aria-live="polite" hidden></p>
      <p class="game-daily-current sd-prompt"></p>
      <div class="game-daily-options"></div>
      <p class="game-daily-note" role="status"></p>
      <div class="game-daily-finish"></div>
      <div class="sd-drawers">
        <details class="sd-drawer sd-hints"><summary>Get a hint</summary><div class="game-daily-tools"></div></details>
        <details class="sd-drawer sd-stats" hidden><summary>Stats</summary><p class="game-daily-econ"></p><div class="game-daily-tools sd-stats-actions"></div></details>
        <details class="game-daily-archive"><summary>Past days</summary><div class="game-daily-archive-list"></div></details>
      </div>
    </div>`);
    result.appendChild(card);
    card.querySelector('[data-howto]').addEventListener('click', openHowToPlay);
    if (practiceMode) {
      card.querySelector('.game-hops').textContent = 'Practice';
      card.querySelector('.sd-stats').hidden = true;
      card.querySelector('.game-daily-archive').hidden = true;
      const back = el('<p class="game-daily-note" style="text-align:center;margin:10px 0 0">Just for fun: no streaks or hints. <a href="/game">Play today\u2019s Daily Chain</a></p>');
      card.querySelector('.sd-drawers').after(back);
    }
    if (loading) {
      card.querySelector('.game-daily-note').textContent = 'Dealing today’s chain…';
    }
    try {
      const data = await dailyFetch(practicePath('/api/game-daily/play'), {
        method: 'POST',
        body: JSON.stringify(practiceMode
          ? { action: 'start', fresh: true, famous: true }
          : { action: 'start', ...(date ? { date } : {}) }),
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
        game_mode: practiceMode ? 'practice' : 'daily_chain',
        band_a: dailyRun && dailyRun.start_band ? dailyRun.start_band.name : null,
        band_b: dailyRun && dailyRun.target ? dailyRun.target.name : null,
      });
      card.querySelector('.game-daily-note').textContent = '';
      paintDailyBoard(card);
      // First visit: show the rules once, the way Wordle does.
      if (dailyRun && dailyRun.status === 'active' && dailyRun.hops_used === 0) {
        let seen = true;
        try { seen = !!localStorage.getItem('sdr-howto-seen'); localStorage.setItem('sdr-howto-seen', '1'); } catch {}
        if (!seen) openHowToPlay();
      }
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

  // --- Wordle-simple board helpers (Cole, 2026-10-08) ------------------------

  let sdToastTimer = null;
  function showToast(text, tone) {
    let t = document.querySelector('.sd-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'sd-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.remove('is-good', 'is-bad', 'is-on');
    if (tone) t.classList.add('is-' + tone);
    void t.offsetWidth; // restart the fade when toasts arrive back to back
    t.classList.add('is-on');
    clearTimeout(sdToastTimer);
    sdToastTimer = setTimeout(() => t.classList.remove('is-on'), 3000);
    t.onclick = () => { clearTimeout(sdToastTimer); t.classList.remove('is-on'); };
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }
  function pause(ms) {
    return new Promise((r) => setTimeout(r, reducedMotion() ? Math.min(ms, 150) : ms));
  }

  // One modal at a time. Escape, the ✕ and the backdrop all close it, and
  // focus returns to whatever opened it.
  function openSdModal(build) {
    closeSdModal();
    ensureDailyStyles();
    const opener = document.activeElement;
    const modal = el(`<div class="sd-modal" role="dialog" aria-modal="true">
      <div class="sd-modal-backdrop" data-close></div>
      <div class="sd-modal-card"><button type="button" class="sd-modal-close" data-close aria-label="Close">✕</button></div>
    </div>`);
    const body = modal.querySelector('.sd-modal-card');
    build(body);
    const h = body.querySelector('h2');
    if (h) { h.id = 'sd-modal-title'; modal.setAttribute('aria-labelledby', 'sd-modal-title'); }
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() {
      modal.remove();
      document.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    }
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    document.addEventListener('keydown', onKey);
    modal.sdClose = close;
    document.body.appendChild(modal);
    modal.querySelector('.sd-modal-close').focus();
    return close;
  }
  function closeSdModal() {
    const open = document.querySelector('.sd-modal');
    if (open && open.sdClose) open.sdClose();
  }

  function openHowToPlay() {
    openSdModal((c) => {
      c.appendChild(el('<h2>How to play</h2>'));
      c.appendChild(el('<p class="sd-modal-sub">Connect the two bands in as few moves as you can.</p>'));
      const ul = el('<ul></ul>');
      for (const line of [
        'Each move, tap a band that shares a member with the band you’re on.',
        `"Shortest path" is the fewest hops it can be done in. You get ${DAILY_EXTRA_MOVES} extra moves on top.`,
        'Every band you tap fills the next slot in your chain.',
      ]) {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      }
      c.appendChild(ul);
      const ex = el('<div class="sd-howto-ex"><p><strong>Say you’re on Nirvana:</strong></p></div>');
      for (const [cls, name, says] of [
        ['game-chain-good', 'Foo Fighters', 'Green: shares a member and it’s on the shortest path.'],
        ['game-chain-ok', 'Sweet 75', 'Yellow: shares a member, but it’s the long way round.'],
        ['game-chain-deadend', 'Pearl Jam', 'Red: no shared member. A dead end, and it costs a move.'],
      ]) {
        const row = el(`<div><span class="game-chain-pill game-chain-filled ${cls}"></span><p></p></div>`);
        row.querySelector('span').textContent = name;
        row.querySelector('p').textContent = says;
        ex.appendChild(row);
      }
      c.appendChild(ex);
      c.appendChild(el('<p class="sd-modal-sub">A new chain every day. Same chain for everyone.</p>'));
      const play = el('<button type="button" class="sd-primary" style="margin-top:14px">Play</button>');
      play.addEventListener('click', closeSdModal);
      c.appendChild(play);
    });
  }

  // Timer for the share text: starts when a fresh run is first seen, stops
  // when the results open. Lives in localStorage so a reload doesn't reset it.
  function dailyClockKey(run) {
    return practiceMode ? `sdr-practice-clock:${run.id}` : `sdr-daily-clock:${run.chain_date}:${run.run_number || 1}`;
  }
  function dailyClockMark(run) {
    if (!run || run.status !== 'active' || run.hops_used !== 0) return;
    try {
      const k = dailyClockKey(run);
      if (!localStorage.getItem(k)) localStorage.setItem(k, String(Date.now()));
    } catch {}
  }
  function dailyElapsed(run) {
    try {
      const k = dailyClockKey(run);
      const start = Number(localStorage.getItem(k));
      if (!start) return null;
      let end = Number(localStorage.getItem(k + ':end'));
      if (!end) { end = Date.now(); localStorage.setItem(k + ':end', String(end)); }
      return (end - start) / 1000;
    } catch { return null; }
  }

  // Guests reach sign-up the same way the old daily gate did: the main page
  // owns the sign-up flow, and sdr_pending_daily brings them back here.
  function requestDailySignup() {
    try { sessionStorage.setItem('sdr_pending_daily', '1'); } catch {}
    if (isArenaPage()) window.location.href = '/';
    else if (typeof window.openSignupPopover === 'function') window.openSignupPopover();
    else document.getElementById('add-band-btn')?.click();
  }

  async function shareDailyText(btn, text) {
    const label = btn.textContent;
    // Phones get the share sheet; everywhere else copies, like Wordle.
    let coarse = false;
    try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch {}
    if (coarse && navigator.share) {
      try { await navigator.share({ text }); return; } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied results to clipboard', 'good');
      btn.textContent = 'Copied!';
    } catch {
      btn.textContent = 'Copy failed. Long-press the chain to copy.';
    }
    setTimeout(() => { btn.textContent = label; }, 2200);
  }

  // The share text for the current run: one source for the results modal
  // and the board's Share result button.
  function dailyResultShareText(won, completed = {}) {
    const run = dailyRun;
    const picks = completed.picks && completed.picks.length ? completed.picks : (run.picks || []);
    return dailyShareResultText({
      date: run.chain_date, start: run.start_band.name, target: run.target.name,
      picks,
      moves: completed.hops_used != null ? completed.hops_used : run.hops_used,
      par: completed.beat_tree ? completed.old_par : run.par,
      won,
    });
  }

  function openDailyResults({ won, completed = {} }) {
    const run = dailyRun;
    if (!run) return;
    const picks = completed.picks && completed.picks.length ? completed.picks : (run.picks || []);
    const hops = completed.hops_used != null ? completed.hops_used : run.hops_used; // moves spent
    const counts = dailyChainCounts(picks);
    const par = completed.beat_tree ? completed.old_par : run.par;
    const streak = practiceMode ? null : completed.streak != null ? completed.streak : run.streak;
    const seconds = dailyElapsed(run);
    const text = dailyResultShareText(won, completed);
    openSdModal((c) => {
      const h = document.createElement('h2');
      const hopsWord = `${counts.hops} hop${counts.hops === 1 ? '' : 's'}`;
      h.appendChild(iconText(won ? lineIcon('trophy') : pickIcon(), !won ? dailyGameOverText(run).title
        : completed.beat_tree ? `You beat the shortest path in ${hopsWord}!`
        : `Chain completed in ${hopsWord}!`));
      c.appendChild(h);
      const sub = el('<p class="sd-modal-sub"></p>');
      const missNote = counts.deadEnds
        ? ` ${hops} moves, including ${counts.deadEnds} dead end${counts.deadEnds === 1 ? '' : 's'}.`
        : '';
      sub.textContent = !won ? `${dailyGameOverText(run).sub} Here\u2019s the shortest chain.`
        : completed.beat_tree ? `The shortest path was ${par} hops. You found an even shorter one!${missNote}`
        : hops === par ? `You matched the shortest path!${missNote}`
        : `The shortest path is ${par} hops.${missNote}`;
      c.appendChild(sub);
      // Your chain, band by band (Cole, 2026-10-08): the share TEXT stays
      // spoiler-free, but the player gets to see exactly what they built.
      const start = { id: run.start_band.id, name: run.start_band.name, anchor: true };
      // Real links only, each with who connects them; dead ends get their own
      // line so a name never looks like it came out of a dead end.
      const mine = picks.filter((p) => p.kind !== 'deadend').map((p) => ({ id: p.band_id, name: p.name, kind: p.kind }));
      const misses = picks.filter((p) => p.kind === 'deadend').map((p) => p.name);
      if (won && mine.length) mine[mine.length - 1].anchor = true; // the last pick is the target
      if (mine.length || won) {
        c.appendChild(el(`<p class="sd-reveal-label">${won ? 'Your chain' : 'Your attempt'}</p>`));
        c.appendChild(chainListEl([start, ...mine], run.connections || {}));
      }
      if (misses.length) {
        const m = el('<p class="sd-misses"></p>');
        m.textContent = `✗ Dead end${misses.length === 1 ? '' : 's'}: ${misses.join(', ')}`;
        c.appendChild(m);
      }
      if (!won && run.reveal_path && run.reveal_path.length) {
        c.appendChild(el('<p class="sd-reveal-label">The shortest chain</p>'));
        c.appendChild(chainListEl(run.reveal_path.map((b, i, a) => ({
          id: b.id, name: b.name, kind: 'optimal', anchor: i === 0 || i === a.length - 1,
        })), run.connections || {}));
      }
      // The score line in guitar picks (the copied share text keeps emoji
      // squares, since chat apps have no pick emoji).
      const chainLine = el('<p class="sd-result-chain"></p>');
      // One pick per move (dead ends included), matching the Moves count.
      chainLine.appendChild(document.createTextNode(run.start_band.name + ' '));
      for (const p of picks) {
        const w = document.createElement('span');
        w.innerHTML = pickSvg(pickColor(p.kind), 'sd-result-pick');
        chainLine.appendChild(w.firstChild);
      }
      chainLine.appendChild(document.createTextNode(' ' + (won ? '' : '✗ ') + run.target.name));
      c.appendChild(chainLine);
      const stats = el('<div class="sd-result-stats"></div>');
      const time = fmtElapsed(seconds);
      // The headline already says the hops; the row says what you spent
      // and what was possible (no more "5 · 5 · 5").
      const statRows = [
        [hops, 'Moves'],
        [par, 'Shortest'],
        ...(streak != null ? [[streak, 'Streak']] : []),
        ...(time ? [[time, 'Time']] : []),
      ];
      for (const [num, label] of statRows) {
        const s = el('<div class="sd-stat"><strong></strong><span></span></div>');
        if (label === 'Streak') s.querySelector('strong').appendChild(iconText(lineIcon('flame'), String(num)));
        else s.querySelector('strong').textContent = String(num);
        s.querySelector(':scope > span').textContent = label; // not the icon's inner span
        stats.appendChild(s);
      }
      c.appendChild(stats);
      const shareBtn = el('<button type="button" class="sd-primary">Share result</button>');
      shareBtn.addEventListener('click', () => shareDailyText(shareBtn, text));
      c.appendChild(shareBtn);
      const mapLink = musicMapLinkEl(run);
      mapLink.classList.add('sd-map-link--modal');
      c.appendChild(mapLink);
      if (completed.freeze_used) {
        c.appendChild(el('<p class="sd-modal-sub">A Seattle Freeze bridged your missed day. Streak intact.</p>'));
      }
      if (!isSignedIn()) {
        const nudge = el('<p class="sd-guest"><button type="button" class="sd-linkbtn">Create a free account</button> to save your streak and stats!</p>');
        nudge.querySelector('button').addEventListener('click', requestDailySignup);
        c.appendChild(nudge);
      }
    });
  }

  function dailyMoveText({ kind, name, from, members = [], extra = null }) {
    if (kind === 'deadend') return `✗ ${name} is a dead end: no shared member with ${from}. −1 move.`;
    const via = members.length ? ` ${fmtMembersLong(members)} played in both.` : '';
    if (kind === 'optimal') return `✓ ${name} connects. You\u2019re on the shortest path!${via}`;
    // The long way round costs at least one move; say exactly how many.
    const cost = extra > 0 ? ` (+${extra} extra move${extra === 1 ? '' : 's'})` : '';
    return `✓ Valid connection! But a shorter route exists${cost}.${via}`;
  }

  // The arrow between two bands, with WHO links them above it (Cole,
  // 2026-10-08: the trivia payoff). No names: a plain arrow.
  function connectorEl(names) {
    if (!names || !names.length) return el('<span class="sd-link" aria-hidden="true">→</span>');
    const c = el('<span class="sd-link sd-via"><span class="sd-via-name"></span><span aria-hidden="true">→</span></span>');
    c.querySelector('.sd-via-name').textContent = fmtMembersShort(names);
    c.title = fmtMembersLong(names);
    c.setAttribute('aria-label', `linked by ${fmtMembersLong(names)}`);
    return c;
  }

  // A chain drawn as pills: [start] → link → link → [target]. Links are
  // colored by kind; dead ends are crossed out but kept, so your own chain
  // shows where you went wrong. Connectors name the shared musicians.
  function chainRowEl(nodes, connections = {}) {
    const row = el('<div class="sd-reveal-chain"></div>');
    let prevId = null;
    nodes.forEach((n, i) => {
      if (i) {
        const names = n.kind !== 'deadend' && prevId && n.id ? connections[`${prevId}|${n.id}`] : null;
        row.appendChild(connectorEl(names));
      }
      if (n.id && n.kind !== 'deadend') prevId = n.id;
      const cls = n.anchor ? 'game-chain-anchor'
        : n.kind === 'deadend' ? 'game-chain-filled game-chain-deadend'
        : n.kind === 'optimal' ? 'game-chain-filled game-chain-good' : 'game-chain-filled game-chain-ok';
      const pill = el(`<span class="game-chain-pill ${cls}"></span>`);
      pill.textContent = n.name;
      row.appendChild(pill);
    });
    return row;
  }

  // The game-over copy (Cole, 2026-10-08: the old "tree" line read like
  // developer text). Two ways to lose, and the subtext must not lie about
  // which: running out of moves, or giving up with moves left.
  function dailyGameOverText(run) {
    const ranOut = run && run.hops_used >= dailyMoveLimit(run.par);
    return {
      title: 'Show\u2019s over!',
      sub: ranOut ? 'You ran out of moves.' : 'You gave up on this one.',
    };
  }

  // "Next chain in 03:12:45", ticking. Stops itself once removed from the page.
  function nextChainCountdownEl() {
    const p = el('<p class="sd-countdown">Next daily chain in <strong></strong></p>');
    const out = p.querySelector('strong');
    const tick = () => {
      if (!p.isConnected && timer) { clearInterval(timer); return; }
      out.textContent = fmtCountdown(secondsToNextChain());
    };
    let timer = null;
    tick();
    timer = setInterval(tick, 1000);
    return p;
  }

  // The chain as a top-to-bottom list for the results modal (Cole,
  // 2026-10-08: the wrapping rows snaked right-to-left). Each step says who
  // links it, in a readable pill rather than tiny italics over an arrow:
  //   [Rage Against the Machine]
  //     └ Brad Wilk, Tim Commerford and Tom Morello → [Audioslave]
  function chainListEl(nodes, connections = {}) {
    // A timeline: one continuous rail, a dot per band, every band name on
    // the same left edge, and "via <musicians>" between two bands lined up
    // with the names (Cole, 2026-10-08: make it look pro).
    const list = el('<ol class="sd-chain-list"></ol>');
    nodes.forEach((n, i) => {
      if (i) {
        const names = connections[`${nodes[i - 1].id}|${n.id}`];
        if (names && names.length) {
          const via = el('<li class="sd-chain-via"><span class="sd-chain-via-label">via</span> <span class="sd-chain-via-names"></span></li>');
          via.querySelector('.sd-chain-via-names').textContent = fmtMembersLong(names);
          list.appendChild(via);
        }
      }
      const li = el(`<li class="sd-chain-node${n.anchor ? ' is-anchor' : ''}"><span class="sd-chain-dot" aria-hidden="true"></span></li>`);
      const cls = n.anchor ? 'game-chain-anchor' : n.kind === 'optimal' ? 'game-chain-filled game-chain-good' : 'game-chain-filled game-chain-ok';
      const pill = el(`<span class="game-chain-pill ${cls}"></span>`);
      pill.textContent = n.name;
      li.appendChild(pill);
      list.appendChild(li);
    });
    return list;
  }

  // After a game: the hook into the main site (Cole, 2026-10-08). The
  // header no longer has "Back to the tree" (a new player has no idea what
  // "the tree" is); the invitation comes once they're done, centered on
  // today's starting band (the map takes one ?band= anchor).
  function musicMapLinkEl(run) {
    const a = el(`<a class="sd-map-link">${lineIcon('map')}<span></span></a>`);
    a.href = '/?band=' + encodeURIComponent(run.start_band.name);
    a.querySelector('span').textContent = `Explore ${run.start_band.name} on the music map →`;
    return a;
  }

  // The newest link lands in the chain with a little pop.
  function popNewestPill(card) {
    const filled = card.querySelectorAll('.game-chain-filled');
    const last = filled[filled.length - 1];
    if (last) last.classList.add('sd-pop');
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
        <li>Beat the shortest path · <strong>+50</strong></li>
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
    const startPill = mkPill(run.start_band.name, 'game-chain-anchor', 'Start band');
    startPill.dataset.bandId = run.start_band.id;
    box.appendChild(startPill);
    // The band you're standing on gets a ring: the start, or your last
    // pick that actually connected (dead ends leave you where you were).
    const curId = run.current_band ? String(run.current_band.id) : null;
    let currentPill = startPill;
    for (let i = 0; i < middle; i++) {
      if (i < picks.length) {
        const p = picks[i];
        const dead = p.kind === 'deadend';
        const pill = mkPill(
          p.name,
          dead ? 'game-chain-filled game-chain-deadend'
            : p.kind === 'optimal' ? 'game-chain-filled game-chain-good' : 'game-chain-filled game-chain-ok',
          p.kind === 'optimal' ? 'On the shortest path' : dead ? 'Dead end' : 'Connects, but not the shortest way'
        );
        pill.dataset.bandId = p.band_id;
        if (dead) pill.dataset.dead = '1';
        box.appendChild(pill);
        if (!dead && curId && String(p.band_id) === curId) currentPill = pill;
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
    // Wordle-simple board: connectors between links (naming the musician
    // who links them), a ring on where you are, and the row scrolled so that
    // ring is in view on a phone.
    if (card.classList.contains('sd-board')) {
      // A name only sits on a connector whose left-hand pill is the band
      // you came from; after a crossed-out dead end it would read as if the
      // dead end led on, so that arrow stays plain.
      const pillsNow = [...box.children];
      pillsNow.forEach((pill, i) => {
        if (!i) return;
        const left = pillsNow[i - 1];
        const names = !pill.dataset.dead && !left.dataset.dead && left.dataset.bandId && pill.dataset.bandId
          ? (run.connections || {})[`${left.dataset.bandId}|${pill.dataset.bandId}`] : null;
        box.insertBefore(connectorEl(names), pill);
      });
      if (active) {
        currentPill.classList.add('game-chain-current');
        currentPill.setAttribute('aria-current', 'step');
        requestAnimationFrame(() => {
          box.scrollLeft = currentPill.offsetLeft - box.clientWidth / 2 + currentPill.offsetWidth / 2;
        });
      }
    }
  }

  // Persistent player line: "Playing as X · [flame] 3-day streak". (Credits were
  // removed for launch, 2026-10-08.) The streak updates on
  // every repaint; the handle fills in async (cached after first load).
  // Also paints the prominent top line under the game title (Aaron, 2026-10-07).
  function paintPlayerLine(card, run) {
    const streak = !practiceMode && run && run.streak > 0 ? `${run.streak}-day streak` : '';
    const paintOne = (line) => {
      if (!line) return;
      const seq = (parseInt(line.dataset.seq || '0', 10) + 1);
      line.dataset.seq = String(seq);
      line.replaceChildren(streak ? iconText(lineIcon('flame'), streak) : '');
      loadMyHandle().then((h) => {
        if (line.dataset.seq !== String(seq)) return; // a newer paint won
        line.replaceChildren(...(h ? ['Playing as ' + h] : []), ...(h && streak ? [' \u00b7 '] : []), ...(streak ? [iconText(lineIcon('flame'), streak)] : []));
      });
    };
    paintOne(card.querySelector('.game-player-line'));
    paintOne(document.getElementById('game-player-line-top'));
  }

  function paintDailyBoard(card, completed, gaveUpInfo) {
    const run = dailyRun;
    if (!run) return;
    const q = (sel) => card.querySelector(sel);
    const mk = (t, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = t; return s; };
    const active = run.status === 'active';
    card.classList.toggle('is-over', !active);
    q('.game-daily-date').textContent = practiceMode ? 'New puzzle every time' : fmtChainDate(run.chain_date);

    // The goal, big: Start → Target, then par and moves left.
    const pair = q('.game-daily-pair');
    pair.innerHTML = '';
    pair.appendChild(mk(run.start_band.name));
    pair.appendChild(mk('→', 'game-daily-arrow'));
    pair.appendChild(mk(run.target.name));
    const meta = q('.sd-goal-meta');
    meta.innerHTML = '';
    meta.appendChild(mk(`Shortest path: ${run.par} hops`));
    if (active) {
      const left = Math.max(0, dailyMoveLimit(run.par) - run.hops_used);
      meta.appendChild(mk(' · '));
      const strong = document.createElement('strong');
      strong.textContent = `${left} move${left === 1 ? '' : 's'} left`;
      meta.appendChild(strong);
    }

    // No credits drawer (removed for launch, 2026-10-08): the streak shows in
    // the header and on the results screen; streak freezes can't be bought.
    // Chain pills replace the old text trail (Aaron: the text was confusing).
    paintChainPills(card, run);
    paintPlayerLine(card, run);
    dailyClockMark(run);

    // What your last tap did, in words, until the next tap.
    const resultLine = q('.sd-result');
    const showResult = !!(active && dailyLastMove);
    resultLine.hidden = !showResult;
    if (showResult) {
      const k = dailyLastMove.kind;
      resultLine.className = 'sd-result is-' + (k === 'deadend' ? 'bad' : k === 'optimal' ? 'good' : 'ok');
      resultLine.textContent = dailyMoveText(dailyLastMove);
    }

    const note = q('.game-daily-note');
    const tools = q('.sd-hints .game-daily-tools');
    const optsBox = q('.game-daily-options');
    const finish = q('.game-daily-finish');
    const prompt = q('.sd-prompt');
    optsBox.innerHTML = '';
    optsBox.classList.remove('is-busy', 'is-asking');
    tools.innerHTML = '';
    finish.innerHTML = '';
    prompt.innerHTML = '';
    note.textContent = '';
    q('.sd-hints').hidden = !active;
    dailyRevealArmed = false;

    if (run.status === 'given_up') {
      paintDailyGiveUp(card, gaveUpInfo);
      return;
    }

    if (completed || run.status === 'complete') {
      const c = completed || {};
      let line;
      const ct = dailyChainCounts(run.picks || []);
      const hopsWord = `${ct.hops} hop${ct.hops === 1 ? '' : 's'}`;
      const miss = ct.deadEnds ? ` ${run.hops_used} moves with ${ct.deadEnds} dead end${ct.deadEnds === 1 ? '' : 's'}.` : '';
      if (c.beat_tree) {
        line = `You beat the shortest path: ${hopsWord} (it was ${c.old_par}).${miss}`;
      } else {
        line = `Connected in ${hopsWord} (shortest path: ${run.par}).${miss}`;
        if (run.hops_used === run.par) line += ' You matched it!';
        if (run.best_hops != null && run.best_hops < run.hops_used) {
          line += ` Best today: ${run.best_hops}.`;
        }
      }
      finish.appendChild(el('<p class="sd-finish-line"></p>')).textContent = line;
      const actions = el('<div class="sd-finish-actions"></div>');
      // One tap shares, like Wordle (the results modal opened on its own at the finish).
      const results = el(`<button type="button" class="tool-chip">${lineIcon('share')} Share result</button>`);
      results.addEventListener('click', () => shareDailyText(results, dailyResultShareText(true, c)));
      const again = el('<button type="button" class="tool-chip"></button>');
      again.textContent = practiceMode ? 'New puzzle' : 'Play again';
      again.addEventListener('click', () => dailyReplay(card));
      actions.appendChild(results);
      actions.appendChild(again);
      finish.appendChild(actions);
      if (!practiceMode) finish.appendChild(nextChainCountdownEl());
      finish.appendChild(musicMapLinkEl(run));
      return;
    }

    // Out of moves: no more choices on the board. dailyPick asks the tree
    // for the answer right away; this also covers a reload or a failed
    // giveup, which used to leave live buttons at "0 moves left".
    if (run.hops_used >= dailyMoveLimit(run.par)) {
      q('.sd-hints').hidden = true;
      prompt.textContent = 'You ran out of moves.';
      const actions = el('<div class="sd-finish-actions"></div>');
      const reveal = el('<button type="button" class="tool-chip">Show me the chain</button>');
      reveal.addEventListener('click', () => dailyGiveUp(card, { outOfMoves: true }));
      actions.appendChild(reveal);
      finish.appendChild(actions);
      return;
    }

    // The question, in words: what to tap and why.
    prompt.appendChild(mk('Who shares a band member with '));
    const strong = document.createElement('strong');
    strong.textContent = run.current_band.name;
    prompt.appendChild(strong);
    prompt.appendChild(mk('?'));

    for (const o of dailyOptions) {
      const btn = el('<button type="button" class="game-daily-option"></button>');
      btn.textContent = o.name;
      btn.dataset.optionId = o.id;
      btn.addEventListener('click', () => dailyPick(card, o.id, btn));
      optsBox.appendChild(btn);
    }

    // Free hints (no credits, 2026-10-08): the per-game budget is the limit
    // (1 at par 3, 2 at par 4). At zero the buttons stay, grayed out.
    const hintsLeft = Math.max(0, run.hints_total - run.hints_used);
    q('.sd-hints > summary').replaceChildren(iconText(lineIcon('hint'), hintsLeft > 0
      ? `Get a hint (${hintsLeft} left today)`
      : 'No hints left today'));
    const elim = el('<button type="button" class="tool-chip">Cut one option</button>');
    elim.addEventListener('click', () => dailyHint(card, 'eliminate'));
    const peek = el('<button type="button" class="tool-chip">Check a band</button>');
    peek.addEventListener('click', () => armDailyAsk(card));
    elim.disabled = peek.disabled = hintsLeft === 0;
    tools.appendChild(elim);
    tools.appendChild(peek);

    // Practice is for fun: no hints (Cole, 2026-10-08).
    q('.sd-hints').hidden = practiceMode || !run.hints_total;

    // Giving up is not a hint (Cole, 2026-10-08): a quiet link under the
    // board, confirmed once in a modal that says plainly what it costs.
    const giveup = el('<button type="button" class="sd-linkbtn sd-giveup">Give up &amp; reveal the chain</button>');
    giveup.addEventListener('click', () => confirmDailyGiveUp(card));
    finish.appendChild(giveup);
  }

  // "Ask the tree" arms a check; nothing is charged until you tap a band.
  // It used to only print a line below the fold, so it looked like the
  // button did nothing (Cole's bug list, 2026-10-08).
  function armDailyAsk(card) {
    dailyRevealArmed = true;
    const drawer = card.querySelector('.sd-hints');
    if (drawer) drawer.open = false;
    card.querySelector('.game-daily-options').classList.add('is-asking');
    const prompt = card.querySelector('.sd-prompt');
    prompt.textContent = 'Check a band: tap one to see if it\u2019s on the shortest path. ';
    const cancel = el('<button type="button" class="sd-linkbtn">Cancel</button>');
    cancel.addEventListener('click', () => paintDailyBoard(card));
    prompt.appendChild(cancel);
    showToast('Tap a band to check it');
    try { prompt.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch {}
  }

  function confirmDailyGiveUp(card) {
    const run = dailyRun;
    openSdModal((c) => {
      c.appendChild(el('<h2>Give up and reveal the chain?</h2>'));
      const body = el('<p class="sd-modal-sub"></p>');
      if (practiceMode) {
        body.textContent = 'This ends this practice puzzle and shows the shortest chain. It doesn\u2019t count toward anything.';
      } else if (run && run.streak > 0) {
        body.textContent = `This ends today\u2019s game and shows the shortest chain. Today won\u2019t count, so your ${run.streak}-day streak resets`
          + (run.freeze_count ? ' (your streak freeze covers one missed day).' : '.');
      } else {
        body.textContent = 'This ends today\u2019s game and shows the shortest chain. You can\u2019t play today\u2019s chain again.';
      }
      c.appendChild(body);
      const keep = el('<button type="button" class="sd-primary" style="margin-top:14px">Keep playing</button>');
      keep.addEventListener('click', closeSdModal);
      const quit = el('<button type="button" class="sd-secondary sd-danger">Give up &amp; show the chain</button>');
      quit.addEventListener('click', () => { closeSdModal(); dailyGiveUp(card); });
      c.appendChild(keep);
      c.appendChild(quit);
    });
  }

  // In-run actions name the run's day. Without it the server assumes today,
  // so a past day opened from the archive would act on today's chain.
  function dailyDate() {
    if (practiceMode) return {};
    return dailyRun && dailyRun.chain_date ? { date: dailyRun.chain_date } : {};
  }

  async function dailyGiveUp(card, { outOfMoves = false } = {}) {
    const note = card.querySelector('.game-daily-note');
    note.textContent = outOfMoves ? 'Out of moves. Revealing the shortest chain…' : 'Revealing the shortest chain…';
    try {
      const data = await dailyFetch(practicePath('/api/game-daily/play'), {
        method: 'POST',
        body: JSON.stringify({ action: 'giveup', ...dailyDate() }),
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
          game_mode: practiceMode ? 'practice' : 'daily_chain',
          result: 'abandon',
          moves_count: analyticsMoveCount,
          hints_used: analyticsHintCount,
          duration_seconds: durationSeconds,
        });
        analyticsSessionId = null; // session over
      }
      paintDailyBoard(card, null, data.gave_up);
      openDailyResults({ won: false });
    } catch (err) {
      note.textContent = (err && err.message) || 'Could not show the chain.';
    }
  }

  async function dailyReplay(card) {
    if (practiceMode) { renderDailyBoard({ loading: true }); return; }
    const note = card.querySelector('.game-daily-note');
    note.textContent = 'Dealing a fresh run…';
    dailyLastMove = null;
    try {
      const data = await dailyFetch(practicePath('/api/game-daily/play'), {
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
        game_mode: practiceMode ? 'practice' : 'daily_chain',
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
        const data = await dailyFetch(practicePath('/api/game-daily/play'), {
          method: 'POST',
          body: JSON.stringify({ action: 'hint', type: 'reveal', option_id: optionId, ...dailyDate() }),
        });
        dailyRun = data.run;
        dailyOptions = data.options || [];
        // Analytics: hint used (peek/reveal)
        if (analyticsSessionId) {
          analyticsHintCount++;
          trackGameEvent({
            session_id: analyticsSessionId,
            event_type: 'hint_clicked',
            game_mode: practiceMode ? 'practice' : 'daily_chain',
          });
        }
        paintDailyBoard(card);
        const yes = data.hint && data.hint.on_optimal_path;
        const answer = yes
          ? `${data.hint.option.name} is on the shortest path.`
          : `${data.hint.option.name} is not on the shortest path.`;
        const line = card.querySelector('.sd-result');
        line.hidden = false;
        line.className = 'sd-result is-' + (yes ? 'good' : 'ok');
        line.replaceChildren(iconText(lineIcon('tree'), answer));
        showToast(answer, yes ? 'good' : null);
      } catch (err) {
        btn.disabled = false;
        note.textContent = err.message;
      }
      return;
    }
    const optsBox = card.querySelector('.game-daily-options');
    const fromName = dailyRun && dailyRun.current_band ? dailyRun.current_band.name : '';
    const fromId = dailyRun && dailyRun.current_band ? dailyRun.current_band.id : null;
    const distBefore = dailyRun ? dailyRun.dist_to_target : null;
    const pickedName = btn ? btn.textContent : '';
    optsBox.classList.add('is-busy');
    if (btn) btn.classList.add('is-pending');
    card.querySelectorAll('.game-daily-option').forEach((b) => { b.disabled = true; });
    try {
      const data = await dailyFetch(practicePath('/api/game-daily/play'), {
        method: 'POST',
        body: JSON.stringify({ action: 'pick', option_id: optionId, ...dailyDate() }),
      });
      dailyRun = data.run;
      dailyOptions = data.options || [];
      // Analytics: move made
      if (analyticsSessionId) {
        analyticsMoveCount++;
        trackGameEvent({
          session_id: analyticsSessionId,
          event_type: 'move_made',
          game_mode: practiceMode ? 'practice' : 'daily_chain',
          move_number: analyticsMoveCount,
        });
      }
      // Feedback first: the tapped button turns green, yellow or red (and
      // shakes on a dead end), then the board moves on.
      const picks = dailyRun.picks || [];
      const kind = (data.picked && data.picked.kind) || (picks.length ? picks[picks.length - 1].kind : null);
      if (btn) btn.classList.add(kind === 'deadend' ? 'is-bad' : kind === 'optimal' ? 'is-good' : 'is-ok');
      // Extra moves a long-way pick cost: you spent 1 and got (before − after) closer.
      const distAfter = dailyRun.dist_to_target;
      const extra = distBefore != null && distAfter != null ? distAfter + 1 - distBefore : null;
      const members = (dailyRun.connections || {})[`${fromId}|${optionId}`] || [];
      dailyLastMove = data.completed ? null : { kind, name: pickedName, from: fromName, members, extra };
      if (!data.completed) {
        showToast(
          kind === 'deadend' ? '✗ Dead end. No shared member. −1 move'
            : kind === 'optimal' ? '✓ Connected. Shortest path!'
            : '✓ Connected, but the long way round',
          kind === 'deadend' ? 'bad' : 'good',
        );
      }
      await pause(kind === 'deadend' ? 1000 : 800);
      if (data.completed) {
        // Analytics: game completed (win)
        if (analyticsSessionId) {
          const durationSeconds = analyticsGameStartTime
            ? Math.round((Date.now() - analyticsGameStartTime) / 1000)
            : null;
          trackGameEvent({
            session_id: analyticsSessionId,
            event_type: 'game_completed',
            game_mode: practiceMode ? 'practice' : 'daily_chain',
            result: 'win',
            moves_count: analyticsMoveCount,
            hints_used: analyticsHintCount,
            duration_seconds: durationSeconds,
          });
          analyticsSessionId = null; // session over
        }
        paintDailyBoard(card, data.completed);
        popNewestPill(card);
        // The results modal carries the guest sign-up nudge (Cole, 2026-10-08).
        openDailyResults({ won: true, completed: data.completed });
      } else {
        paintDailyBoard(card);
        popNewestPill(card);
        // Out of moves: show's over. Uses the existing giveup action, so
        // the server still decides what a finished day means.
        if (dailyRun.status === 'active' && dailyRun.hops_used >= dailyMoveLimit(dailyRun.par)) {
          showToast('Show\u2019s over! You ran out of moves.', 'bad');
          await pause(900);
          await dailyGiveUp(card, { outOfMoves: true });
        }
      }
    } catch (err) {
      note.textContent = err.message;
      optsBox.classList.remove('is-busy');
      if (btn) btn.classList.remove('is-pending');
      card.querySelectorAll('.game-daily-option').forEach((b) => { b.disabled = false; });
    }
  }

  async function dailyHint(card, type) {
    const note = card.querySelector('.game-daily-note');
    try {
      const data = await dailyFetch(practicePath('/api/game-daily/play'), {
        method: 'POST',
        body: JSON.stringify({ action: 'hint', type, ...dailyDate() }),
      });
      dailyRun = data.run;
      dailyOptions = data.options || [];
      // Analytics: hint used (eliminate)
      if (analyticsSessionId) {
        analyticsHintCount++;
        trackGameEvent({
          session_id: analyticsSessionId,
          event_type: 'hint_clicked',
          game_mode: practiceMode ? 'practice' : 'daily_chain',
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

  function paintDailyGiveUp(card) {
    const run = dailyRun;
    const finish = card.querySelector('.game-daily-finish');
    // One chain on this screen: the answer. Your own row ended with the
    // target bubble, so on a loss it read as if you'd connected (Cole,
    // 2026-10-08). Your attempt, dead ends and all, is in the results modal.
    card.querySelector('.game-chain-pills').style.display = 'none';
    const over = dailyGameOverText(run);
    const head = el('<div class="sd-gameover"><p class="sd-gameover-title"></p><p class="sd-gameover-sub"></p></div>');
    head.querySelector('.sd-gameover-title').appendChild(iconText(pickIcon(), over.title));
    head.querySelector('.sd-gameover-sub').textContent = over.sub;
    finish.appendChild(head);
    // The answer, drawn the way the game draws chains: green links in a row.
    if (run.reveal_path && run.reveal_path.length) {
      finish.appendChild(el('<p class="sd-reveal-label">The shortest chain</p>'));
      finish.appendChild(chainListEl(run.reveal_path.map((b, i, a) => ({
        id: b.id, name: b.name, kind: 'optimal', anchor: i === 0 || i === a.length - 1,
      })), run.connections || {}));
    }
    const actions = el('<div class="sd-finish-actions"></div>');
    const results = el(`<button type="button" class="tool-chip">${lineIcon('share')} Share result</button>`);
    results.addEventListener('click', () => shareDailyText(results, dailyResultShareText(false)));
    actions.appendChild(results);
    const again = el('<button type="button" class="tool-chip"></button>');
    if (practiceMode) {
      again.textContent = 'New puzzle';
      again.addEventListener('click', () => dailyReplay(card));
    } else {
      again.textContent = 'Play a practice puzzle';
      again.addEventListener('click', () => { window.location.href = '/game/?practice=1'; });
    }
    actions.appendChild(again);
    finish.appendChild(actions);
    if (!practiceMode) {
      finish.appendChild(nextChainCountdownEl());
    }
    finish.appendChild(musicMapLinkEl(run));
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
      parP.appendChild(mk('Shortest path · '));
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
        ? `Completed in ${data.your_hops} vs a shortest path of ${data.par}.`
        : `Gave up ${data.your_hops} deep — the shortest chain is in gold.`;
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
            const unlock = el('<button type="button" class="tool-chip">Play</button>');
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
      <p class="game-daily-note">Pick a band (or let us deal both), then find the chain link by link, just like the Daily Chain.</p>
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
    // Guest play (2026-10-08): no sign-in gate for Solo either.
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
      if (c.optimal) line += ' You matched the shortest path!';
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
      const peek = el('<button type="button" class="tool-chip">Check a band</button>');
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
      note.appendChild(mk('This run ends and the shortest chain is revealed. '));
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
    card.querySelector('.game-daily-current').textContent = 'Show\u2019s over!';
    const finish = card.querySelector('.game-daily-finish');
    const rev = el('<div class="game-daily-reveal"></div>');
    rev.appendChild(mk('The shortest chain: '));
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
        // Guest win prompt (Cole, 2026-10-08).
        if (!isSignedIn()) {
          showGuestWinPrompt(card);
        }
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
    note.textContent = 'Revealing the shortest chain…';
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
          <div style="margin-top:12px"><button class="game-btn game-btn-primary" type="button">Add "${typedA}" to the map</button></div>
        </div>`);
        card.querySelector('.game-daily-note').textContent =
          `"${typedA}" isn't on the map yet.`;
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
          <div style="margin-top:12px"><button class="game-btn game-btn-primary" type="button">Add "${missing}" to the map</button></div>
        </div>`);
        card.querySelector('.game-daily-note').textContent =
          `"${missing}" isn't on the map yet.`;
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
      statusLine.textContent = 'Could not load the band data. Check your connection and try again.';
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
      statusLine.textContent = `"${typedChallengeA}" isn't on the map yet. Pick a band from the list, or add it from the main page.`;
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
      else { statusLine.textContent = 'Could not load the band data. Check your connection and try again.'; }
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
        `You pick a band to stump them \u2014 bands link through shared members ` +
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
      `You pick a band \u2014 one you think can't be connected to ${nameA}. ` +
      `Bands link through shared members; the shortest chain is revealed at the end. Stump them.`
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
    if (!g) { statusLine.textContent = 'Could not load the band data. Check your connection and try again.'; return; }

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

  async function loadChallenges() {
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
      if (!gg) { statusLine.textContent = 'Could not load the band data. Check your connection and try again.'; return; }
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
        // Guest play (2026-10-08): show "Guest" instead of "Sign in to play"
        // when a guest session exists.
        let hasGuestSession = false;
        try {
          hasGuestSession = !!localStorage.getItem('sdr-guest-session');
        } catch {}
        const link = document.createElement('a');
        link.href = '/';
        link.textContent = hasGuestSession ? 'Playing as Guest' : 'Sign in to play';
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
            // Guest play (2026-10-08): if a guest session exists, we're loading
            // guest credits — don't flash "Sign in to play".
            let hasGuestSession = false;
            try {
              hasGuestSession = !!localStorage.getItem('sdr-guest-session');
            } catch {}
            if (hasGuestSession) {
              topLine.innerHTML = '<span style="opacity:.5">Loading…</span>';
            } else {
              topLine.innerHTML = '<span style="opacity:.7">Sign in to play</span>';
            }
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
