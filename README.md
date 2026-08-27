# @notibase/web

Official browser SDK for [Notibase](https://notibase.com) — web push,
in-app inbox, live in-app messages, and attribution in one small
dependency-free package.

```bash
npm install @notibase/web
```

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

// Live in-app messages — banners/modals pushed to the open tab instantly
nb.enableLiveMessages();
// or render your own UI:
nb.enableLiveMessages({ onMessage: (m) => { myUI(m); return true; } });
```

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
