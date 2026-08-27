# @notibase/web

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
