// Social/streaming links for bands (Phase 3).
//
// One shared module for everything link-shaped so the allowlist, the domain
// validation, and the permission rule live in exactly one place:
//   - migrate.mjs creates the band_links table (platform CHECK mirrors
//     LINK_PLATFORMS below — keep the two in sync).
//   - bands_create.mjs / bands_edit.mjs validate + write through here.
//   - index.html mirrors the domain lists client-side for inline form
//     validation (see linkUrlValidForPlatform); the server is the enforcer.
//
// Permission rule ("loosened ladder", plan): whoever created the band
// (bands.added_by) may manage its links, as may an admin. "Admin" here
// means the same thing it means everywhere else in this codebase: holder
// of the ADMIN_TOKEN env var, presented as the x-admin-token header
// (see migrate.mjs / patch_members.mjs). There is no user-level admin
// flag. A non-creator without the admin token is rejected outright.

export const LINK_PLATFORMS = [
  'spotify',
  'apple_music',
  'youtube',
  'bandcamp',
  'instagram',
  'tiktok',
  'facebook',
  'x',
  'website',
];

export const PLATFORM_LABELS = {
  spotify: 'Spotify',
  apple_music: 'Apple Music',
  youtube: 'YouTube',
  bandcamp: 'Bandcamp',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  x: 'X',
  website: 'Website',
};

// Hostname allowlists, matched as exact-or-subdomain (so www./m./open.
// prefixes pass). bandcamp artists live on <artist>.bandcamp.com, hence
// the bare 'bandcamp.com' entry covering every subdomain. website accepts
// any host — it is the band's own site, not a platform slot.
const PLATFORM_HOSTS = {
  spotify: ['spotify.com', 'open.spotify.com'],
  apple_music: ['music.apple.com'],
  youtube: ['youtube.com', 'youtu.be'],
  bandcamp: ['bandcamp.com'],
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  facebook: ['facebook.com', 'fb.com'],
  x: ['x.com', 'twitter.com'],
  website: null,
};

export const MAX_LINK_URL_LENGTH = 500;

// Validate one platform slot. Returns { ok:true, url } where url is the
// trimmed input, or null when the input was empty (empty = "remove this
// link" — the caller turns null into a DELETE). Returns { ok:false, error }
// when the URL is malformed or lands on the wrong domain.
export function validateLinkUrl(platform, rawUrl) {
  if (!LINK_PLATFORMS.includes(platform)) {
    return { ok: false, error: `unknown platform "${platform}"` };
  }
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) return { ok: true, url: null };
  if (url.length > MAX_LINK_URL_LENGTH) {
    return { ok: false, error: 'link is too long' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'link must be a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'link must start with http:// or https://' };
  }
  // No credentials in links — a pasted "https://user:pass@host/..." is
  // either a mistake or a phishing lure, never an official page URL.
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'link must not contain credentials' };
  }
  const hosts = PLATFORM_HOSTS[platform];
  if (hosts) {
    const host = parsed.hostname.toLowerCase();
    const allowed = hosts.some((d) => host === d || host.endsWith('.' + d));
    if (!allowed) {
      return { ok: false, error: `link must be a ${PLATFORM_LABELS[platform]} URL` };
    }
  }
  return { ok: true, url };
}

// Validate the whole `links` object from a request body ({ platform: url }).
// Unknown platforms and domain mismatches are 400s. Missing/empty input
// means "no link changes". Returns { ok:true, links } with null values
// marking removals, or { ok:false, error, field }.
export function normalizeLinksInput(raw) {
  if (raw == null) return { ok: true, links: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'links must be an object mapping platform to URL', field: 'links' };
  }
  const links = {};
  for (const [platform, value] of Object.entries(raw)) {
    if (!LINK_PLATFORMS.includes(platform)) {
      return { ok: false, error: `unknown platform "${platform}"`, field: 'links' };
    }
    // Non-string values are rejected rather than coerced: validateLinkUrl
    // treats them as removals, and silently turning a client bug (e.g. a
    // number) into a link deletion would be a footgun.
    if (typeof value !== 'string') {
      return { ok: false, error: 'link must be a string URL (empty string removes it)', field: `links.${platform}` };
    }
    const v = validateLinkUrl(platform, value);
    if (!v.ok) {
      return { ok: false, error: v.error, field: `links.${platform}` };
    }
    links[platform] = v.url;
  }
  return { ok: true, links };
}

// Build the write queries for a band's link map WITHOUT executing them, so
// callers can fold them into an existing transaction (bands_edit's metadata
// UPDATE runs atomically with its link changes). Non-empty values upsert;
// null values delete. Returns an array of sql`` promises.
export function bandLinkWriteQueries(sql, bandId, links) {
  const queries = [];
  for (const [platform, url] of Object.entries(links || {})) {
    if (!LINK_PLATFORMS.includes(platform)) continue; // validated upstream; skip defensively
    if (url) {
      queries.push(sql`
        insert into band_links (band_id, platform, url)
        values (${bandId}, ${platform}, ${url})
        on conflict (band_id, platform)
        do update set url = excluded.url, updated_at = now()
      `);
    } else {
      queries.push(sql`
        delete from band_links where band_id = ${bandId} and platform = ${platform}
      `);
    }
  }
  return queries;
}

// Standalone write: upsert + delete a band's links in one transaction.
// No-op when the map is empty.
export async function writeBandLinks(sql, bandId, links) {
  const queries = bandLinkWriteQueries(sql, bandId, links);
  if (queries.length) await sql.transaction(queries);
}

// Compare a band's current link rows against a desired map ({ platform:
// url|null }). Returns the subset that actually changed (same shape), so
// callers can tell a real link edit from a no-op resubmission. currentRows
// are { platform, url } rows as selected from band_links.
export function diffBandLinks(currentRows, desired) {
  const current = new Map((currentRows || []).map((r) => [r.platform, r.url]));
  const changed = {};
  for (const [platform, url] of Object.entries(desired || {})) {
    if (!LINK_PLATFORMS.includes(platform)) continue;
    const before = current.has(platform) ? current.get(platform) : undefined;
    const after = url || null;
    if ((before || null) !== after) changed[platform] = after;
  }
  return changed;
}

const ADMIN_TOKEN_HEADER = 'x-admin-token';

// Same admin-token check as migrate.mjs / patch_members.mjs: the request
// carries the ADMIN_TOKEN env var as the x-admin-token header.
export function requestHasAdminToken(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = (req.headers && typeof req.headers.get === 'function')
    ? req.headers.get(ADMIN_TOKEN_HEADER) || ''
    : '';
  return provided === expected;
}

// The Phase 3 permission rule: the band's creator, or an admin-token
// holder. Everyone else is rejected. bandAddedBy may be null for legacy
// rows — then only the admin token opens the gate.
export function canManageBandLinks({ bandAddedBy, userId, req }) {
  if (requestHasAdminToken(req)) return true;
  if (userId && bandAddedBy && userId === bandAddedBy) return true;
  return false;
}
