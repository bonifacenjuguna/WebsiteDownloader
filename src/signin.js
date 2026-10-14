// Pages behind a sign-in all lead to the same place: the sign-in page. What a visitor sees at /account is that page, so
// that is what the copy keeps: saved ONCE, with every link to a protected page opening it. (The bot never signs in.)
export function createSignInTracker() {
  const alias = new Map(); // key of the protected page -> key of the sign-in page it led to
  return {
    add(protectedKey, signInKey) { alias.set(protectedKey, signInKey); },
    // the saved page a link to `key` should open, or undefined when it is not a protected page (or its sign-in page was left out)
    localFor(key, pages) { const k = alias.get(key); return k ? pages.get(k)?.local : undefined; },
    get count() { return alias.size; },
    signInKeys() { return new Set(alias.values()); },
  };
}
