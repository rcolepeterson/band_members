// Signup attribution: "how did they get here?" for every email signup.
// One shared module (loaded by Rawkle, Cards, Daily, /remind/ and the graph)
// so the rule never drifts between surfaces. Pages call
// window.signupAttribution() at signup time; handlers guard for its absence
// so a missed upload can never break a signup.
//
// Rule (last campaign touch wins):
//   1. UTM params on the current URL win and overwrite the stored touch.
//   2. Otherwise the touch stored earlier in this session wins.
//   3. Otherwise a ?s=1 share link counts as share/social (matching the
//      pages' own GA page_location rewrite for shared links).
//   4. Otherwise the referrer host, else empty strings (organic/direct).
// Nothing here is a secret: sources are marketing params, not identifiers.

const STORE_KEY = 'sdr-signup-source';

function clean(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 128);
}

export function parseSignupAttribution(search, referrer, stored) {
  try {
    const q = new URLSearchParams(search || '');
    const utm = clean(q.get('utm_source'));
    if (utm) {
      return {
        source: utm,
        medium: clean(q.get('utm_medium')),
        campaign: clean(q.get('utm_campaign')),
      };
    }
    if (q.get('s') === '1') return { source: 'share', medium: 'social', campaign: '' };
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed.source === 'string') {
        return {
          source: clean(parsed.source),
          medium: clean(parsed.medium),
          campaign: clean(parsed.campaign),
        };
      }
    }
    if (referrer) {
      try {
        return { source: new URL(referrer).hostname, medium: '', campaign: '' };
      } catch (_) { /* fall through */ }
    }
  } catch (_) { /* fall through */ }
  return { source: '', medium: '', campaign: '' };
}

export function signupAttribution() {
  try {
    const q = new URLSearchParams(window.location.search);
    // A UTM landing overwrites: the ad clicked most recently is the touch
    // that brought this signup, even mid-session.
    if (q.get('utm_source')) {
      const current = parseSignupAttribution(window.location.search, '', null);
      try { window.sessionStorage.setItem(STORE_KEY, JSON.stringify(current)); } catch (_) {}
      return current;
    }
    let stored = null;
    try { stored = window.sessionStorage.getItem(STORE_KEY); } catch (_) {}
    return parseSignupAttribution(window.location.search, document.referrer, stored);
  } catch (_) {
    return { source: '', medium: '', campaign: '' };
  }
}

if (typeof window !== 'undefined') window.signupAttribution = signupAttribution;
