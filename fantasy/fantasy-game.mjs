// Fantasy Band Game — v1 solo draft and score.
// Client for /fantasy/ on sixdegreesofrock.com. Follows the Daily page's
// house patterns: same arena look, same bmft-user bearer token, same
// copy-first-then-share, same /?signin=game sign-in handoff.
//
// SCORING (spec v1, Gold line locked 69 on 2026-11-07; sim-verified):
//   provisional = sum(V) + connection bonus
//   connection bonus = +4 per pair sharing at least one band, capped +16
//   final (at settle) = sum(V) + bonus + sum over each pick of
//     V_i * (1 / (1 + 0.5 * share_i) - 1), share_i = fraction of the day's
//     drafters who picked them. Win iff final > 69 (strictly greater).
//   NOTE: "or a link within a few degrees" in the spec is NOT implemented
//   in v1 — the sim and the verified prototype both use shared-band only.
//   Tiebreakers: connection bonus first, then earliest submission.
// FIREWALL: this page only READS pool data. Fantasy value, price and
//   results never feed back into graph weight, ordering or node size.
//
// The pure functions below are exported so tests/fantasy-scoring.test.mjs
// can import them under node --test. The DOM wiring at the bottom only
// runs in a browser (guarded by typeof document).

import { fantasyResultCode } from '../scripts/fantasy-result.mjs';

export const GOLD_LINE = 69;
export const SALARY_CAP = 100;
export const CONNECTION_PER_PAIR = 4;
export const CONNECTION_CAP = 16;
export const CROWD_HALF = 0.5;
export const WINS_GOLD = 10;
export const WINS_PLATINUM = 25;
export const SLOTS = ['V', 'G', 'B', 'D', 'W'];
export const SLOT_LABELS = {
  V: 'Vocalist',
  G: 'Guitar',
  B: 'Bass',
  D: 'Drums',
  W: 'Wild card',
};
export const SLOT_LETTER_WORDS = { V: 'Vocals', G: 'Guitar', B: 'Bass', D: 'Drums' };

// --- pure scoring ---------------------------------------------------------

// Every unordered pair among the picks that share at least one band.
// picks: [{ name, all_bands: [...] }]. band = first shared band, alphabetical
// so the result is stable regardless of all_bands order.
export function connectionPairs(picks) {
  const pairs = [];
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i];
      const b = picks[j];
      const shared = (a.all_bands || []).filter((band) => (b.all_bands || []).includes(band)).sort();
      if (shared.length) pairs.push({ a: a.name, b: b.name, band: shared[0] });
    }
  }
  return pairs;
}

export function connectionBonus(pairs) {
  return Math.min(CONNECTION_PER_PAIR * pairs.length, CONNECTION_CAP);
}

// Provisional score at submit: sum(V) + connection bonus. Crowd-split is
// NOT in the provisional score; it applies at settle.
export function provisionalScore(picks) {
  const pairs = connectionPairs(picks);
  const bonus = connectionBonus(pairs);
  const value = picks.reduce((sum, p) => sum + (p.V || 0), 0);
  return { value: round2(value), connectionBonus: bonus, pairs, total: round2(value + bonus) };
}

// Final score at settle. shares: { member_id: share } with share in [0, 1].
// Missing share = 0 (nobody else picked them). Returns the per-player
// crowd-split breakdown so the settle display can show it.
export function finalScore(picks, shares) {
  const prov = provisionalScore(picks);
  const perPlayer = picks.map((p) => {
    const share = clamp01((shares || {})[p.member_id] ?? 0);
    const adjusted = (p.V || 0) / (1 + CROWD_HALF * share);
    return {
      member_id: p.member_id,
      name: p.name,
      V: p.V,
      share,
      adjustedV: round2(adjusted),
      crowdDelta: round2(adjusted - (p.V || 0)),
    };
  });
  const crowdDelta = round2(perPlayer.reduce((s, p) => s + p.crowdDelta, 0));
  const final = round2(prov.value + prov.connectionBonus + crowdDelta);
  return { ...prov, perPlayer, crowdDelta, final, win: final > GOLD_LINE };
}

export function isWin(final) {
  return final > GOLD_LINE;
}

export function capTotal(picks) {
  return picks.reduce((sum, p) => sum + (p.price0 || 0), 0);
}

// --- draft rules ----------------------------------------------------------

// slots: { V: member_id|null, G, B, D, W }. W accepts ANY pool member;
// V/G/B/D accept only players whose eligible includes that letter.
// Picking a player for a second slot MOVES them there (last choice wins).
export function movePick(slots, slot, memberId) {
  const next = { ...slots };
  for (const s of SLOTS) if (next[s] === memberId) next[s] = null;
  next[slot] = memberId;
  return next;
}

export function removePick(slots, slot) {
  return { ...slots, [slot]: null };
}

export function canFillSlot(player, slot) {
  if (slot === 'W') return true;
  return (player.eligible || []).includes(slot);
}

// Full validation of a draft against the pool. Returns { ok, errors[] }.
export function validateDraft(slots, poolById) {
  const errors = [];
  const picked = SLOTS.map((s) => slots[s]).filter(Boolean);
  if (picked.length < SLOTS.length) errors.push('Fill all five slots before submitting.');
  if (new Set(picked).size !== picked.length) errors.push('One musician fills exactly one slot.');
  for (const s of SLOTS) {
    const id = slots[s];
    if (!id) continue;
    const player = poolById[id];
    if (!player) { errors.push(`Unknown player in the ${SLOT_LABELS[s]} slot.`); continue; }
    if (!canFillSlot(player, s)) errors.push(`${player.name} cannot play ${SLOT_LABELS[s]}.`);
  }
  const total = picked.reduce((sum, id) => sum + ((poolById[id] && poolById[id].price0) || 0), 0);
  if (total > SALARY_CAP) errors.push(`$${total} is $${total - SALARY_CAP} over the $100 cap.`);
  return { ok: errors.length === 0, errors, total };
}

// Submit button stays ghosted/disabled until all five slots are filled AND
// total price is <= $100.
export function canSubmit(slots, poolById) {
  return validateDraft(slots, poolById).ok;
}

// Leaderboard order: final score desc, connection bonus desc, earliest
// submission first. submittedAt is an ISO string (or epoch ms); ties on
// all three keep input order (stable sort).
export function sortLeaderboard(entries) {
  return [...entries].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.connectionBonus || 0) !== (a.connectionBonus || 0)) return (b.connectionBonus || 0) - (a.connectionBonus || 0);
    const ta = Date.parse(a.submittedAt || 0) || 0;
    const tb = Date.parse(b.submittedAt || 0) || 0;
    return ta - tb;
  });
}

// --- card display ---------------------------------------------------------

// Plays line from real slot eligibility, e.g. "Bass · Vocals". A player
// whose eligibility is wild-card only (Ray Manzarek, keyboards) shows
// their instrument instead — "Keyboards" is not a draft slot.
export function playsLine(player) {
  const words = (player.eligible || [])
    .filter((letter) => SLOT_LETTER_WORDS[letter])
    .map((letter) => SLOT_LETTER_WORDS[letter]);
  if (words.length) return words.join(' · ');
  const inst = String(player.inst || '').split('/')[0].trim();
  return inst ? titleCase(inst) : 'Wild card';
}

// Top-3 bands as "Band (Role)" lines. General rule: if a player's own
// band is in all_bands but not in top3, append it as "(Founder)". "Own
// band" is eponymous: the band name equals the player's name (Stevie
// Nicks — already in her top3, so nothing appends) or the player's
// surname (Newsted — Jason Newsted's band "Newsted" is not his full
// name, so a same-name-only check would miss it). In the v1 pool that
// fires for Jason Newsted only: his 4th line reads "Newsted (Founder)".
export function displayBands(player) {
  const lines = (player.top3 || []).map(([/* value */, band, role]) => `${band} (${role})`);
  const topNames = (player.top3 || []).map(([, band]) => band);
  const surname = String(player.name || '').trim().split(/\s+/).pop();
  const own = (player.all_bands || []).find(
    (band) => !topNames.includes(band) && (band === player.name || band === surname),
  );
  if (own) lines.push(`${own} (Founder)`);
  return lines;
}

export function tierFor(wins) {
  if (wins >= WINS_PLATINUM) return 'Platinum';
  if (wins >= WINS_GOLD) return 'Gold';
  return null;
}

export function winsToNextTier(wins) {
  if (wins >= WINS_PLATINUM) return 0;
  if (wins >= WINS_GOLD) return WINS_PLATINUM - wins;
  return WINS_GOLD - wins;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- share text (Daily's copy-first-then-share pattern) -------------------

export function fantasyShareText({ date, picks, provisional, final, win, handle }) {
  const lines = picks.map((p) => `${p.name} — $${p.price0}`);
  const scoreLine = final != null
    ? (win ? `I beat the Gold line — ${final} (line is 69).` : `Scored ${final} — the Gold line is 69.`)
    : `Provisional score ${provisional} — settles tonight.`;
  return [
    `Fantasy Band Game — ${date}`,
    ...lines,
    scoreLine,
    `${handle || 'a rawker'} · sixdegreesofrock.com/fantasy`,
  ].join('\n');
}

// Share text for a SETTLED day: title line with date and final score,
// won/beat-the-Gold-line line, then the five pick names.
export function fantasyResultsShareText({ date, picks, finalScore, win, handle }) {
  const scoreLine = win
    ? `I beat the Gold line — ${finalScore} (line is 69).`
    : `Scored ${finalScore} — the Gold line is 69.`;
  return [
    `Fantasy Band Game — ${date} · ${finalScore}`,
    scoreLine,
    ...picks.map((p) => p.name),
    `${handle || 'a rawker'} · sixdegreesofrock.com/fantasy`,
  ].join('\n');
}

// --- browser wiring (skipped under node) ----------------------------------

if (typeof document !== 'undefined') {
  initFantasyPage();
}

function pacificDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
}

function authToken() {
  try {
    const raw = localStorage.getItem('bmft-user');
    const p = raw && JSON.parse(raw);
    return p && typeof p.token === 'string' ? p.token : '';
  } catch { return ''; }
}

function isSignedIn() {
  try {
    const raw = localStorage.getItem('bmft-user');
    const p = raw && JSON.parse(raw);
    return !!(p && typeof p.token === 'string' && p.token.length >= 8 && p.email);
  } catch { return false; }
}

function myHandle() {
  try {
    const raw = localStorage.getItem('bmft-user');
    const p = raw && JSON.parse(raw);
    return (p && (p.handle || p.name)) || '';
  } catch { return ''; }
}

async function initFantasyPage() {
  const today = pacificDateStr();
  const state = {
    pool: [],
    byId: {},
    slots: { V: null, G: null, B: null, D: null, W: null },
    activeSlot: 'V',
    filter: 'ALL',
    query: '',
    submitted: null, // server lineup once submitted / loaded
    todayData: null,
    backendDown: false,
  };
  const $ = (id) => document.getElementById(id);
  const els = {
    date: $('fantasy-date'), player: $('arena-player'), signinNote: $('fantasy-signin-note'),
    capFill: $('cap-fill'), capText: $('cap-text'), provValue: $('prov-value'),
    provBonus: $('prov-bonus'), provTotal: $('prov-total'), pairs: $('fantasy-pairs'),
    submit: $('fantasy-submit'), status: $('fantasy-status'), slots: $('fantasy-slots'),
    pool: $('fantasy-pool'), filterRow: $('fantasy-filters'), search: $('fantasy-search'),
    result: $('fantasy-result'), card: $('fantasy-card'), shareBtn: $('fantasy-share'),
    copyBtn: $('fantasy-copy'), boardDaily: $('board-daily'), boardWeekly: $('board-weekly'),
    boardTabs: document.querySelectorAll('[data-board-scope]'),
    career: $('fantasy-career'), yesterday: $('fantasy-yesterday'),
  };

  // Header player chip + sign-in note, Daily's pattern.
  if (isSignedIn()) {
    const handle = myHandle();
    if (handle && els.player) {
      els.player.hidden = false;
      els.player.innerHTML = '';
      const strong = document.createElement('strong');
      strong.textContent = handle;
      els.player.append('Playing as ', strong);
    }
  } else if (els.signinNote) {
    els.signinNote.hidden = false;
  }
  if (els.date) els.date.textContent = new Date(`${today}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Load the pool. pool.json ships with the page, so drafting works even
  // if every API endpoint is down.
  try {
    const res = await fetch('./pool.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`pool.json HTTP ${res.status}`);
    state.pool = await res.json();
  } catch (err) {
    console.error('fantasy pool failed to load', err);
    if (els.status) els.status.textContent = 'The player pool could not be loaded. Check your connection and reload.';
    return;
  }
  state.byId = Object.fromEntries(state.pool.map((p) => [p.member_id, p]));

  // Restore today's local draft (signed-out drafting, and the draft a
  // player was building before signing in).
  try {
    const saved = JSON.parse(localStorage.getItem('sdr-fantasy-draft') || 'null');
    if (saved && saved.date === today && saved.slots) {
      const clean = { V: null, G: null, B: null, D: null, W: null };
      for (const s of SLOTS) if (saved.slots[s] && state.byId[saved.slots[s]]) clean[s] = saved.slots[s];
      state.slots = clean;
    }
  } catch {}

  renderAll();

  // Today's server state (lineup, settle, leaderboard, career). Any
  // failure here is a degraded state, never a crash: the page keeps
  // working as a local draft board.
  loadToday().catch(() => { state.backendDown = true; renderBoardsUnavailable(); });

  async function loadToday() {
    const headers = {};
    const token = authToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch('/api/fantasy-play', { headers });
    if (!res.ok) throw new Error(`fantasy-play HTTP ${res.status}`);
    const data = await res.json();
    state.todayData = data;
    if (data.lineup) {
      state.submitted = data;
      state.slots = { ...data.lineup };
    }
    renderResult();
    renderCareer();
    renderBoards(data.leaderboard || []);
    loadWeekly().catch(() => {});
  }

  async function loadWeekly() {
    const headers = {};
    const token = authToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`/api/fantasy-leaderboard?scope=weekly&date=${today}`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    renderBoards(data.leaderboard || data.entries || [], 'weekly');
  }

  function saveDraft() {
    try { localStorage.setItem('sdr-fantasy-draft', JSON.stringify({ date: today, slots: state.slots })); } catch {}
  }

  function pickedPlayers() {
    return SLOTS.map((s) => state.slots[s]).filter(Boolean).map((id) => state.byId[id]).filter(Boolean);
  }

  function renderAll() {
    renderSlots();
    renderPool();
    renderScores();
    renderSubmit();
  }

  function renderSlots() {
    if (!els.slots) return;
    els.slots.innerHTML = '';
    for (const s of SLOTS) {
      const id = state.slots[s];
      const player = id ? state.byId[id] : null;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `fantasy-slot${state.activeSlot === s ? ' is-active' : ''}${player ? ' is-filled' : ''}`;
      btn.setAttribute('aria-pressed', state.activeSlot === s ? 'true' : 'false');
      const label = document.createElement('span');
      label.className = 'fantasy-slot-label';
      label.textContent = SLOT_LABELS[s];
      const name = document.createElement('span');
      name.className = 'fantasy-slot-name';
      name.textContent = player ? player.name : 'Tap a player below';
      const meta = document.createElement('span');
      meta.className = 'fantasy-slot-meta';
      meta.textContent = player ? `${playsLine(player)} · $${player.price0}` : (s === 'W' ? 'Any musician in the pool' : `Any ${SLOT_LABELS[s].toLowerCase()} in the pool`);
      btn.append(label, name, meta);
      btn.addEventListener('click', () => {
        if (player && state.activeSlot === s) {
          state.slots = removePick(state.slots, s);
          saveDraft(); renderAll();
          return;
        }
        state.activeSlot = s;
        state.filter = s === 'W' ? 'ALL' : s;
        renderAll();
        if (els.search) els.search.focus({ preventScroll: true });
      });
      els.slots.appendChild(btn);
    }
  }

  function visiblePool() {
    const q = state.query.trim().toLowerCase();
    return state.pool.filter((p) => {
      if (state.filter !== 'ALL') {
        if (state.filter === 'W') { /* wild card shows the whole pool */ }
        else if (!canFillSlot(p, state.filter)) return false;
      }
      if (q && !(p.name.toLowerCase().includes(q) || (p.all_bands || []).some((b) => b.toLowerCase().includes(q)))) return false;
      return true;
    }).sort((a, b) => b.price0 - a.price0 || a.name.localeCompare(b.name));
  }

  function renderPool() {
    if (!els.pool) return;
    if (els.filterRow) {
      els.filterRow.querySelectorAll('[data-filter]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.filter === state.filter);
        b.setAttribute('aria-pressed', b.dataset.filter === state.filter ? 'true' : 'false');
      });
    }
    els.pool.innerHTML = '';
    const list = visiblePool();
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'fantasy-empty';
      empty.textContent = 'No players match that search.';
      els.pool.appendChild(empty);
      return;
    }
    const pickedIds = new Set(Object.values(state.slots).filter(Boolean));
    for (const p of list) {
      const card = document.createElement('article');
      card.className = `fantasy-card-player${pickedIds.has(p.member_id) ? ' is-picked' : ''}`;
      const name = document.createElement('h3');
      name.className = 'fantasy-card-name';
      name.textContent = p.name;
      const plays = document.createElement('p');
      plays.className = 'fantasy-card-plays';
      plays.textContent = playsLine(p);
      const bands = document.createElement('p');
      bands.className = 'fantasy-card-bands';
      bands.textContent = displayBands(p).join(' · ');
      const foot = document.createElement('div');
      foot.className = 'fantasy-card-foot';
      const price = document.createElement('span');
      price.className = 'fantasy-card-price';
      price.textContent = `$${p.price0}`;
      const value = document.createElement('span');
      value.className = 'fantasy-card-value';
      value.textContent = `Value ${p.V}`;
      const draftBtn = document.createElement('button');
      draftBtn.type = 'button';
      draftBtn.className = 'fantasy-draft-btn';
      const alreadyIn = pickedIds.has(p.member_id);
      draftBtn.textContent = alreadyIn ? 'In your band' : `Draft to ${SLOT_LABELS[state.activeSlot]}`;
      draftBtn.disabled = alreadyIn || !canFillSlot(p, state.activeSlot);
      if (!alreadyIn && !canFillSlot(p, state.activeSlot)) {
        draftBtn.title = `${p.name} cannot play ${SLOT_LABELS[state.activeSlot]}.`;
      }
      draftBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        draftPlayer(p);
      });
      foot.append(price, value, draftBtn);
      card.append(name, plays, bands, foot);
      card.addEventListener('click', () => draftPlayer(p));
      els.pool.appendChild(card);
    }
  }

  function draftPlayer(p) {
    if (!canFillSlot(p, state.activeSlot)) {
      if (els.status) els.status.textContent = `${p.name} cannot play ${SLOT_LABELS[state.activeSlot]} — pick a ${SLOT_LABELS[state.activeSlot].toLowerCase()} or switch slots.`;
      return;
    }
    state.slots = movePick(state.slots, state.activeSlot, p.member_id);
    saveDraft();
    if (els.status) els.status.textContent = '';
    renderAll();
  }

  function renderScores() {
    const picks = pickedPlayers();
    const total = capTotal(picks);
    if (els.capFill) {
      els.capFill.style.width = `${Math.min(100, (total / SALARY_CAP) * 100)}%`;
      els.capFill.classList.toggle('is-over', total > SALARY_CAP);
    }
    if (els.capText) {
      els.capText.textContent = total > SALARY_CAP
        ? `$${total} of $100 — $${total - SALARY_CAP} over the cap`
        : `$${total} of $100 — $${SALARY_CAP - total} left`;
    }
    const prov = provisionalScore(picks);
    if (els.provValue) els.provValue.textContent = prov.value.toFixed(2);
    if (els.provBonus) els.provBonus.textContent = `+${prov.connectionBonus}`;
    if (els.provTotal) els.provTotal.textContent = prov.total.toFixed(2);
    if (els.pairs) {
      els.pairs.innerHTML = '';
      if (!prov.pairs.length) {
        const li = document.createElement('li');
        li.textContent = 'No shared bands yet — pick musicians who played together for +4 a pair.';
        els.pairs.appendChild(li);
      } else {
        for (const pair of prov.pairs) {
          const li = document.createElement('li');
          li.textContent = `${pair.a} + ${pair.b} — ${pair.band} (+4)`;
          els.pairs.appendChild(li);
        }
        if (prov.pairs.length >= 4) {
          const li = document.createElement('li');
          li.textContent = 'Connection bonus capped at +16.';
          els.pairs.appendChild(li);
        }
      }
    }
  }

  function renderSubmit() {
    if (!els.submit) return;
    const check = validateDraft(state.slots, state.byId);
    els.submit.disabled = !check.ok || !!state.submitted;
    els.submit.textContent = state.submitted
      ? 'Band submitted for today'
      : check.ok ? 'Submit my band' : 'Fill all five slots within $100 to submit';
    els.submit.title = check.ok ? '' : check.errors.join(' ');
  }

  function renderResult() {
    if (!els.result || !state.todayData) return;
    const d = state.todayData;
    const picks = SLOTS.map((s) => d.lineup && d.lineup[s]).filter(Boolean).map((id) => state.byId[id]).filter(Boolean);
    if (!picks.length) return;
    const prov = d.provisional != null ? d.provisional : provisionalScore(picks).total;
    els.result.hidden = false;
    const title = els.result.querySelector('[data-result-title]');
    const body = els.result.querySelector('[data-result-body]');
    if (d.settled && d.final != null) {
      const f = finalScore(picks, d.shares || {});
      if (title) title.textContent = f.win ? `You beat the Gold line — ${f.final}` : `Settled at ${f.final} — the Gold line is 69`;
      if (body) {
        body.innerHTML = '';
        const lines = [
          `Career value ${f.value.toFixed(2)} + connection bonus ${f.connectionBonus} + crowd-split ${f.crowdDelta >= 0 ? '+' : ''}${f.crowdDelta.toFixed(2)} = ${f.final.toFixed(2)}.`,
          ...f.perPlayer.map((pp) => `${pp.name}: ${pp.V} → ${pp.adjustedV} (picked by ${Math.round(pp.share * 100)}% today)`),
        ];
        for (const line of lines) {
          const p = document.createElement('p');
          p.textContent = line;
          body.appendChild(p);
        }
      }
      renderShareResults(picks, f);
    } else {
      if (title) title.textContent = `Provisional score ${Number(prov).toFixed(2)} — settles tonight`;
      if (body) {
        body.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = 'Crowd-split applies at settle, when the day\'s pick shares are known. Your band is in for today.';
        body.appendChild(p);
      }
      removeShareResults();
    }
    renderBandCard(picks, d);
  }

  // Settled only: "Share results" button under the result body, next to
  // the existing band-card UI. Built once, re-wired on every render; the
  // encoder returns null on bad input, in which case no button shows.
  // picks are already in slot order V, G, B, D, W (see renderResult).
  function renderShareResults(picks, f) {
    if (!els.result) return;
    const old = els.result.querySelector('[data-share-results]');
    const code = fantasyResultCode({
      date: today,
      finalScore: f.final,
      won: isWin(f.final),
      picks: picks.map((p) => p.member_id),
    });
    if (!code) { if (old) old.remove(); return; }
    const text = fantasyResultsShareText({
      date: today, picks, finalScore: f.final, win: isWin(f.final), handle: myHandle(),
    });
    const url = `https://sixdegreesofrock.com/fantasy?s=1&r=${code}`;
    let btn = old;
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-chip';
      btn.setAttribute('data-share-results', '');
      btn.textContent = 'Share results';
      const body = els.result.querySelector('[data-result-body]');
      if (body) body.after(btn);
      else els.result.appendChild(btn);
    }
    btn.onclick = () => shareResults(text, url);
  }

  function removeShareResults() {
    const old = els.result && els.result.querySelector('[data-share-results]');
    if (old) old.remove();
  }

  // Same copy-first flow as shareBandCard, with the result link as its
  // own url field and no image file.
  async function shareResults(text, url) {
    const copied = await copyText(text);
    try {
      if (navigator.share) {
        await navigator.share({ text, url });
        if (els.status) els.status.textContent = 'Shared!';
        return;
      }
    } catch {}
    if (els.status) els.status.textContent = copied
      ? 'Shared! If the app dropped the text, just paste — it is copied.'
      : 'Copy the card below and paste it where you share.';
  }

  function renderBandCard(picks, d) {
    if (!els.card) return;
    const prov = provisionalScore(picks);
    const final = d && d.settled && d.final != null ? d.final : null;
    const win = final != null ? final > GOLD_LINE : null;
    const text = fantasyShareText({
      date: today, picks, provisional: prov.total, final, win, handle: myHandle(),
    });
    els.card.hidden = false;
    const pre = els.card.querySelector('[data-card-text]');
    if (pre) pre.textContent = text;
    if (els.shareBtn) els.shareBtn.onclick = () => shareBandCard(text);
    if (els.copyBtn) els.copyBtn.onclick = async () => {
      await copyText(text);
      if (els.status) els.status.textContent = 'Band card copied — paste it anywhere.';
    };
  }

  // Daily/Rawkle share pattern: copy to clipboard FIRST, then try the
  // native share sheet; the message says the copy is the rescue.
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch { return false; }
  }

  async function shareBandCard(text) {
    const copied = await copyText(text);
    try {
      if (navigator.share) {
        await navigator.share({ text, url: 'https://sixdegreesofrock.com/fantasy?s=1' });
        if (els.status) els.status.textContent = 'Shared!';
        return;
      }
    } catch {}
    if (els.status) els.status.textContent = copied
      ? 'Shared! If the app dropped the text, just paste — it is copied.'
      : 'Copy the card below and paste it where you share.';
  }

  function renderCareer() {
    const d = state.todayData;
    if (!els.career || !d || !d.career) return;
    const wins = d.career.wins || 0;
    const tier = tierFor(wins);
    els.career.hidden = false;
    const el = els.career.querySelector('[data-career-text]');
    if (el) {
      el.textContent = tier
        ? `${wins} career wins — ${tier} tier. ${winsToNextTier(wins) === 0 ? 'Top tier reached.' : `${winsToNextTier(wins)} more to ${tier === 'Gold' ? 'Platinum' : 'Gold'}.`}`
        : `${wins} career wins — ${winsToNextTier(wins)} more to Gold (10 wins).`;
    }
    if (els.yesterday && d.yesterdayWinner) {
      els.yesterday.hidden = false;
      const y = els.yesterday.querySelector('[data-yesterday-text]');
      if (y) y.textContent = `Yesterday's winner: ${d.yesterdayWinner}`;
    }
  }

  function renderBoards(entries, scope = 'daily') {
    const target = scope === 'weekly' ? els.boardWeekly : els.boardDaily;
    if (!target) return;
    target.innerHTML = '';
    const ranked = sortLeaderboard(entries || []);
    if (!ranked.length) {
      const li = document.createElement('li');
      li.textContent = scope === 'weekly' ? 'No drafts this week yet.' : 'No drafts today yet — yours could be the first.';
      target.appendChild(li);
      return;
    }
    for (const [i, e] of ranked.entries()) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${i + 1}. ${e.name || 'A rawker'}`;
      const score = document.createElement('span');
      score.textContent = `${Number(e.score).toFixed(2)} (+${e.connectionBonus || 0} connections)`;
      li.append(name, score);
      target.appendChild(li);
    }
  }

  function renderBoardsUnavailable() {
    for (const target of [els.boardDaily, els.boardWeekly]) {
      if (!target) continue;
      target.innerHTML = '';
      const li = document.createElement('li');
      li.textContent = 'Leaderboard unavailable right now — your draft still works below.';
      target.appendChild(li);
    }
  }

  if (els.filterRow) {
    els.filterRow.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      state.filter = b.dataset.filter;
      if (state.filter !== 'ALL' && state.filter !== 'W') state.activeSlot = state.filter;
      renderAll();
    });
  }
  if (els.search) {
    els.search.addEventListener('input', () => { state.query = els.search.value; renderPool(); });
  }
  if (els.boardTabs) {
    els.boardTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        els.boardTabs.forEach((t) => t.classList.toggle('is-active', t === tab));
        const scope = tab.dataset.boardScope;
        if (els.boardDaily) els.boardDaily.hidden = scope !== 'daily';
        if (els.boardWeekly) els.boardWeekly.hidden = scope !== 'weekly';
      });
    });
  }
  if (els.submit) {
    els.submit.addEventListener('click', async () => {
      const check = validateDraft(state.slots, state.byId);
      if (!check.ok) {
        if (els.status) els.status.textContent = check.errors.join(' ');
        return;
      }
      // Signed-out visitors draft locally; submitting needs a sign-in.
      // Same handoff as Daily: /?signin=game, draft kept in localStorage.
      if (!isSignedIn()) {
        try { sessionStorage.setItem('sdr_pending_fantasy', '1'); } catch {}
        saveDraft();
        window.location.href = '/?signin=game';
        return;
      }
      els.submit.disabled = true;
      if (els.status) els.status.textContent = 'Submitting your band…';
      try {
        const res = await fetch('/api/fantasy-play', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken()}` },
          body: JSON.stringify({ slots: { ...state.slots } }),
        });
        if (!res.ok) throw new Error(`fantasy-play HTTP ${res.status}`);
        const data = await res.json();
        state.submitted = { lineup: { ...state.slots }, provisional: data.provisional };
        state.todayData = { ...state.todayData, lineup: { ...state.slots }, provisional: data.provisional, settled: false };
        try { localStorage.removeItem('sdr-fantasy-draft'); } catch {}
        if (els.status) els.status.textContent = '';
        renderResult();
        renderSubmit();
        if (data.leaderboard) renderBoards(data.leaderboard);
      } catch (err) {
        console.error('fantasy submit failed', err);
        els.submit.disabled = false;
        if (els.status) els.status.textContent = 'Could not reach the server — your band is saved on this device. Try submitting again in a moment.';
      }
    });
  }
}
