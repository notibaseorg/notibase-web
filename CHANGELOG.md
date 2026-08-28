# @notibase/web

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
