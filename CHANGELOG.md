# @notibase/web

## 0.6.0

- **`logout()` — sign a device out without opting it out.** Signing out and
  opting out are different things, and until now an app only had the second
  one. So "stop sending my ex-user's notifications to this browser" was
  answered with `unsubscribe()`, which records a durable opt-out against the
  push subscription: it survives sign-in, reinstall and re-registration, and is
  lifted only from your own backend with a server key. Reaching for it on
  sign-out silenced the browser for whoever signed in next, permanently, with
  nothing in the app able to undo it.

  `logout()` is the call for that case. The device stays registered and push
  keeps working — the app is still installed and permission is still
  granted. It simply stops belonging to anybody: a campaign aimed at a
  person no longer reaches it, the inbox stops returning the last person's
  messages (which matters on a shared browser), and the next `identify()`
  attaches it again. Triggers are cleared with it, because a trigger is a
  fact about the person in front of you. How often each in-app message has
  been shown is kept, because that is a property of the device.

- **An opt-out now survives the next launch.** Server-side, registering a
  device wrote `token_status = 'active'` unconditionally, and every SDK
  re-registers its cached token on every launch — so the bookkeeping came
  back the moment the person next opened the app. Delivery had always
  stopped correctly; what returned was the audience count, which meant
  somebody who had opted out was reported as reachable and targeted by every
  send, then dropped again at delivery. The same bug lived in a second write
  path: an imported opt-out was recorded as a suppression beside a device row
  that still said 'active', so a customer migrating an audience saw everyone
  who had already left counted as reachable from the moment the file landed.
  Both paths now read the opt-out back rather than assuming it. Nothing to change in your app.

## 0.5.0

- **`SDK_VERSION`, exported, and sent with every setup test.** This package had
  no version string anywhere in its source: no user agent, no `sdk_version` in
  the setup-test report, nothing. It was invisible to version telemetry, and —
  because there was no string to compare — outside what
  `scripts/check-sdk-versions.mjs` could watch. So "which build is this
  customer on" had no answer at all for the SDK that runs in the most places.
  That script now watches it.

## 0.4.1

- No API change. Published so npm re-reads the package: the description now
  says what it sends, and the keywords include the words somebody moving
  from another provider would actually type into a search box.

## 0.4.0

- **In-app messages.** `nb.enableInAppMessages()` fetches the rules this
  device is eligible for, caches them, and evaluates them itself — on every
  foreground, and whenever you call `nb.setTrigger(key, value)`. A message
  therefore still fires for somebody who was offline when you published it,
  which is the thing `enableLiveMessages()` cannot do: a live frame reaches
  only a tab with a socket open at the instant of the send.

  Three checks run in the browser, because no server can make them
  honestly: has the trigger fired, has this person seen it enough times,
  has the gap between displays elapsed. The counts are per browser, so a
  cleared site data forgets and two browsers count separately.

  A message renders as text, image and button blocks into real DOM nodes —
  no `innerHTML` anywhere, so message copy can never become script on your
  page.
- `nb.setTrigger(key, value)` / `removeTrigger` / `clearTriggers`. A trigger
  is a local fact for messages to test against and never leaves the browser.
  Values are not coerced across types: the string `"240"` does not satisfy
  a rule configured for `over 100`.
- A button on a message can ask for push permission, open a link, tag the
  person, or record a named press. The permission one is the reason to
  reach for this first — you get one browser prompt and a block is
  permanent, so asking in your own UI first makes a "no" free.

## 0.3.0

- **`track`, `trackPurchase` and `identify` no longer reject.** They resolve
  `true` when the call landed and `false` when it did not. Nobody writes
  `.catch()` on an analytics call, so an unreachable API used to produce
  unhandled rejections at page-view rate, and anybody who wrote
  `await nb.track(...)` inside a click handler got our problem thrown into
  their own. A failure says so in the console once per kind, not once per
  call. A missing or server key still throws — that one is a bug and will not
  fix itself.
- The hosted-config fetch is bounded at 5 seconds. It had no timeout of any
  kind and gated service-worker registration, so a host that accepted the
  connection and never answered stalled the whole of `init()` for as long as
  the browser's own timeout, which is minutes.
- When that config cannot be reached, the SDK says so and names the
  consequence: no new browser can subscribe without a VAPID key. It used to
  be silent, which made a subscribe rate falling to zero look exactly like a
  quiet week.
- The realtime socket's backoff is no longer reset on every `open`. A load
  balancer that accepted the upgrade and dropped it reconnected once a second
  forever, from every open tab, at the moment we could least afford it.

## 0.2.0

Web push, in-app inbox, live messages and attribution.
