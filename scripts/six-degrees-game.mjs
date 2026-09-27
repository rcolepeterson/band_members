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
// native share on wins, an after-3-chains signup nudge for logged-out
// players, and the sponsor ribbon ("This week's game is brought to you by").

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
// Signup nudge + sponsor ribbon (pure helpers, Node-testable)
// ---------------------------------------------------------------------------

// The nudge fires exactly once, after the third chain reveal ("end of the
// match"). Copy is deliberately quiet: no hype, no exclamation marks.
export const NUDGE_THRESHOLD = 3;
export const NUDGE_COPY = "That's the match — sign up to save your chains and challenge a friend.";

export function nudgeShouldShow({ plays, done, signedIn } = {}) {
  if (signedIn || done) return false;
  return Number(plays) >= NUDGE_THRESHOLD;
}

// Sponsor ribbon copy. The placeholder is an invitation, not an empty ad slot.
export const SPONSOR_LABEL = "This week's game is brought to you by";
export const SPONSOR_PLACEHOLDER = 'your brand here';
export const MAX_SPONSORS = 7;

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

  // --- sponsor ribbon ------------------------------------------------------
  // "This week's game is brought to you by" + up to MAX_SPONSORS icons from
  // /api/game-sponsors. Empty list or a failed fetch shows the tasteful
  // "your brand here" placeholder — the ribbon never breaks the game.
  let sponsorRibbon = null;

  async function loadSponsors() {
    try {
      const res = await fetch('/api/game-sponsors', { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.sponsors)) return null;
      return data.sponsors.slice(0, MAX_SPONSORS);
    } catch {
      return null;
    }
  }

  function renderSponsorRibbon(sponsors) {
    if (sponsorRibbon) sponsorRibbon.remove();
    const card = modal.querySelector('.game-modal-card');
    if (!card) return;
    sponsorRibbon = el(`<div class="game-sponsor-ribbon">
      <span class="game-sponsor-label"></span>
      <div class="game-sponsor-icons"></div>
    </div>`);
    sponsorRibbon.querySelector('.game-sponsor-label').textContent = SPONSOR_LABEL;
    const icons = sponsorRibbon.querySelector('.game-sponsor-icons');
    if (sponsors && sponsors.length) {
      for (const s of sponsors) {
        const name = String((s && s.name) || 'Sponsor');
        const wrap = s && s.link_url ? el('<a target="_blank" rel="noopener"></a>') : el('<span class="game-sponsor-icon"></span>');
        if (s && s.link_url) wrap.setAttribute('href', String(s.link_url));
        wrap.setAttribute('title', name);
        const img = document.createElement('img');
        img.src = String(s.icon_url);
        img.alt = name;
        img.loading = 'lazy';
        img.addEventListener('error', () => wrap.remove());
        wrap.appendChild(img);
        icons.appendChild(wrap);
      }
    } else {
      const ph = el('<button type="button" class="game-sponsor-placeholder"></button>');
      ph.textContent = SPONSOR_PLACEHOLDER;
      ph.addEventListener('click', () => {
        closeModal();
        // The site's contact path is the feedback popover; fall back to the
        // site root if its trigger isn't on the page.
        const fb = document.getElementById('send-feedback-btn')
          || document.getElementById('mobile-send-feedback-btn');
        if (fb) fb.click();
        else window.location.href = '/';
      });
      icons.appendChild(ph);
    }
    const anchor = modal.querySelector('.game-modal-sub');
    if (anchor && anchor.parentElement === card) anchor.after(sponsorRibbon);
    else card.prepend(sponsorRibbon);
  }

  function openModal() {
    modal.hidden = false;
    document.body.classList.add('game-modal-open');
    // Placeholder first (the common case: no sponsors yet), then upgrade to
    // real icons if the endpoint has any. Never blocks the game.
    renderSponsorRibbon(null);
    loadSponsors().then((sponsors) => {
      if (sponsors && sponsors.length) renderSponsorRibbon(sponsors);
    });
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
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // Deep link: ?game=1 (the QR on share cards) or ?game=<id> (a shared chain)
  // opens the game straight away. The lure only works if there is no friction
  // between tapping the link and playing.
  try {
    if (new URLSearchParams(window.location.search).has('game')) openModal();
  } catch (_) {}

  function currentMode() {
    return (modeInputs.find((i) => i.checked) || {}).value || 'head-to-head';
  }

  function syncModeUI() {
    const mode = currentMode();
    // Solo: only band A is picked; the graph supplies band B.
    // Chaos: the graph supplies both; hide both fields, show randomize.
    document.getElementById('game-field-a-wrap').style.display = mode === 'chaos' ? 'none' : '';
    wrapB.style.display = mode === 'head-to-head' ? '' : 'none';
    randomizeBtn.style.display = mode === 'chaos' ? '' : 'none';
    runBtn.textContent = mode === 'head-to-head' ? 'Set the matchup' : mode === 'solo' ? 'Challenge me' : 'Deal me a pair';
    result.innerHTML = '';
    statusLine.textContent = '';
  }
  modeInputs.forEach((i) => i.addEventListener('change', syncModeUI));

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
        navigator.share({ title: 'Six Degrees of Rock', text: shareText, url: shareUrl }).catch(() => {});
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
