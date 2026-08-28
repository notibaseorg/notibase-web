# @notibase/web

Official browser SDK for [Notibase](https://notibase.com) — web push,
in-app messages, an in-app inbox, and attribution in one small
dependency-free package.

```bash
npm install @notibase/web
```

## Coming from OneSignal, or from raw web push

Notibase is an alternative to OneSignal, and the browser-side model is the
same shape: ask for permission, register the subscription, identify the
person behind it, tag them, send to a segment. Most of a port is renaming
calls. What is arranged differently is that web push, in-app messages, an
in-app inbox, email and SMS are one audience and one API here rather than
several products with separate lists.

If you are doing web push by hand today — VAPID keys, a service worker, an
encrypted payload per subscriber — this replaces all of it, and keeps the
part you cannot buy: the same campaign reaching iOS and Android too.

```ts
import { Notibase } from "@notibase/web";

const nb = new Notibase({
  clientKey: "ck_live_…",              // public by design — powerless beyond register/track
  apiUrl: "https://api.notibase.com",
});

// Web push (call from a user gesture — soft-prompt first)
await nb.subscribeWebPush(VAPID_PUBLIC_KEY);

// Identify (HMAC signature minted by YOUR backend — see docs/security)
await nb.identify("user-42", { signature, attributes: { plan: "pro" } });

// Events → segments. install / session_start are reported for you.
await nb.track("level_complete", { level: 3 });

// Revenue, attributed to whichever campaign link brought this visitor
await nb.trackPurchase(9.99, { productId: "pro_monthly" });

// Persistent in-app inbox
const { items, unread } = await nb.inbox.list();
await nb.inbox.markRead(items.map(i => i.id));

// In-app messages — a rule the SDK caches and this browser evaluates,
// so it still fires for somebody who was offline when you published it
nb.enableInAppMessages();
nb.setTrigger("cart_value", 240);   // a local fact, never sent to us

// Live frames — banners/modals pushed to a tab that is open right now.
// A different thing: nothing is queued for a tab that is closed.
nb.enableLiveMessages();
// or render your own UI:
nb.enableLiveMessages({ onMessage: (m) => { myUI(m); return true; } });
```

### In-app messages vs live frames vs the inbox

Three things with similar names, and picking the wrong one is the most common
mistake here:

| | Reaches | Decided by |
| --- | --- | --- |
| `enableInAppMessages()` | anyone who opens your site after you publish | the browser, from a cached rule |
| `enableLiveMessages()` | only a tab with a socket open at the instant you send | the server |
| `inbox` | anyone, whenever they next look | the server |

In-app messages carry triggers, a display limit and a gap between displays, all
evaluated here — and a button that can ask for push permission, which is the
reason to reach for them first: you get one browser prompt and a block is
permanent, so asking in your own UI first makes a "no" free.
[Full documentation](https://notibase.dev/in-app.html).

### Setup test

Most of what goes wrong is invisible from the browser: VAPID keys that were
never generated, a key belonging to another app, a device this app has never
seen. Run it from the console on the page you are integrating — the result
also shows up in the dashboard under Settings → Push platforms:

```ts
await nb.runSetupTest();
```

### Attribution

A campaign link lands with `?nb_click=…`, which the SDK captures once and
attaches to the `install` / `session_start` it reports for you — so a
campaign gets credit even if the visitor subscribes three pages later.
`init({ autoTrackSessions: false })` turns the automatic events off.
Full model: https://notibase.dev/attribution.html

### Service worker

Put this at `https://yoursite.com/sw.js`:

```js
importScripts("https://api.notibase.com/sdk/sw.js");
```

Docs: https://notibase.dev · Quickstart: https://notibase.dev/index.html

## Security model

The `ck_` client key is public by design: it can register devices, identify
**with an HMAC signature your backend mints**, track events, and read this
device's inbox — nothing else. Server keys (`sk_`) are refused in the
browser with a loud error. Details: https://notibase.dev/security.html
