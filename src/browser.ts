/**
 * Hosted page bundle — what `<script src=".../sdk/notibase.js">` loads.
 *
 * Bundler users import `@notibase/web` and construct `Notibase` themselves.
 * A page that just pastes a snippet cannot do that, because the script is
 * deferred and the callbacks may be queued before it arrives. So this entry
 * creates the singleton, drains whatever the page queued, and replaces the
 * queue with something that runs callbacks immediately from then on.
 */
import { Notibase } from "./index.js";

type Callback = (nb: Notibase) => unknown;

declare global {
  interface Window {
    notibase?: Notibase;
    notibaseDeferred?: Callback[] | { push(cb: Callback): void };
  }
}

// Whatever origin served this file IS the API — that is where /sdk/notibase.js
// lives. Taking it from here means a self-hosted or preview install needs no
// apiUrl in the snippet, exactly like the mobile SDKs need none.
const src = (document.currentScript as HTMLScriptElement | null)?.src;
if (src) {
  try { Notibase.defaultApiUrl = new URL(src).origin; } catch { /* keep the default */ }
}

const nb = window.notibase ?? new Notibase();
window.notibase = nb;

const queued = Array.isArray(window.notibaseDeferred) ? window.notibaseDeferred : [];
window.notibaseDeferred = {
  push(cb: Callback) {
    try { void cb(nb); } catch (err) { console.error("[notibase]", err); }
  },
};
for (const cb of queued) {
  try { void cb(nb); } catch (err) { console.error("[notibase]", err); }
}

export { Notibase };
export default nb;
