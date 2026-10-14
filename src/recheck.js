// The rules for "send what I have, check first, or build", as pure functions so they can be tested to the letter.
//
//   no saved copy .................................... build
//   copy verified less than RECHECK_AFTER ago ......... send it as it is        (unless the same person just asked for it)
//   older, or the same person asks again .............. check the site first
//        unchanged ................................... send it   "Checked just now, nothing changed"
//        changed ..................................... build, silently, and it costs the person no quota
//        unknown (site slow/unreachable/unverifiable) .. send it with an honest label; if they asked AGAIN, build
//   an admin forcing a rebuild ........................ build
export function decideFreshness({ prev, now, recheckAfterMs, staleMaxMs, repeat = false, force = false }) {
  if (force || !prev) return { action: 'build', why: force ? 'forced' : 'no-copy' };
  const builtAge = now - prev.at;
  if (builtAge > staleMaxMs) return { action: 'build', why: 'too-old' };
  const verifiedAge = now - (prev.checkedAt ?? prev.at);
  if (!repeat && verifiedAge < recheckAfterMs) return { action: 'send', label: 'cache', why: 'fresh-enough', verifiedAge };
  return { action: 'check', why: repeat ? 'asked-again' : 'due', verifiedAge };
}

export function afterCheck(verdict, { repeat = false, reason = '', verifiedAgeMs = 0, unverifiableMaxMs = Infinity } = {}) {
  if (verdict === 'unchanged') return { action: 'send', label: 'unchanged', free: false };
  if (verdict === 'changed') return { action: 'build', free: true };            // the person did not ask for a rebuild: it is free
  if (repeat) return { action: 'build', free: false };                           // they asked again: they want a new one
  // a copy that can NEVER be verified (browser-rendered sites) must not be served for days: after a while it is rebuilt
  if (reason === 'no-baseline' && verifiedAgeMs > unverifiableMaxMs) return { action: 'build', free: false };
  return { action: 'send', label: 'unverified', free: false };                   // site slow or unreachable: the saved copy, honestly labelled
}
