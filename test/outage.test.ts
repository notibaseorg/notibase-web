/**
 * What this SDK does to a customer's page when Notibase is unreachable.
 *
 * The rule: our outage must never become theirs. A page that embeds our
 * script keeps rendering, keeps working, and does not fill its console with
 * our problems — and the one thing that genuinely stops working, new push
 * subscriptions, says so out loud instead of silently going to zero.
 *
 * These are the properties most easily lost by accident. An `await` with no
 * timeout looks like every other await; a `throw` on a non-2xx looks like
 * correct error handling right up until it lands in somebody else's click
 * handler at page-view rate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notibase } from "../src/index.js";

/** A fetch that never settles — an accepted connection that never answers. */
function blackHoleFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      // Honour the abort signal, exactly as the platform does. Without this
      // the test could not tell "the SDK set a timeout" from "the SDK hung".
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as unknown as typeof fetch;
}

/** A fetch that fails the way DNS does: immediately and without a Response. */
function deadFetch(): typeof fetch {
  return (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
}

/** A fetch that answers every request with the same status. */
function statusFetch(status: number): typeof fetch {
  return (() =>
    Promise.resolve(new Response("{}", { status }))) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

/**
 * The smallest thing `init()` will accept as a browser.
 *
 * Deliberately a stub rather than jsdom: what the SDK needs from a page is
 * two properties, and writing them down here is a better record of that
 * than a dependency that provides four hundred. `pushSupported()` returns
 * false against it, which is correct — this is a browser with no service
 * worker, and `init()` is expected to reach the config fetch, warn, and
 * then stop cleanly rather than try to subscribe.
 */
function fakeBrowser(): void {
  (globalThis as { window?: unknown }).window = {
    location: { search: "" },
    setTimeout: globalThis.setTimeout.bind(globalThis),
  };
}

beforeEach(() => { vi.useFakeTimers(); fakeBrowser(); });
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
  vi.restoreAllMocks();
});

describe("the analytics calls never reject into the page", () => {
  // Nobody writes `.catch()` on an analytics call, and plenty of people
  // write `await nb.track(...)` inside a click handler. These used to
  // reject, so an outage produced unhandled rejections at page-view rate
  // and threw into the middle of other people's checkout flows.
  for (const [label, f] of [
    ["a network failure", deadFetch()],
    ["a 500", statusFetch(500)],
    ["a 401 — a real bug, but still not ours to throw", statusFetch(401)],
  ] as const) {
    it(`track() resolves false on ${label}`, async () => {
      globalThis.fetch = f;
      const nb = new Notibase({ clientKey: "ck_test", apiUrl: "https://api.test" });
      await expect(nb.track("checkout_started")).resolves.toBe(false);
    });

    it(`identify() resolves false on ${label}`, async () => {
      globalThis.fetch = f;
      const nb = new Notibase({ clientKey: "ck_test", apiUrl: "https://api.test" });
      await expect(nb.identify("user-42")).resolves.toBe(false);
    });
  }

  it("trackPurchase() resolves false rather than throwing", async () => {
    globalThis.fetch = deadFetch();
    const nb = new Notibase({ clientKey: "ck_test", apiUrl: "https://api.test" });
    await expect(nb.trackPurchase(9.99, { productId: "pro_monthly" })).resolves.toBe(false);
  });

  it("says so once, not once per call", async () => {
    // A hundred identical lines during an outage is not more informative
    // than one, and it buries whatever else is being debugged.
    globalThis.fetch = deadFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nb = new Notibase({ clientKey: "ck_test", apiUrl: "https://api.test" });
    for (let i = 0; i < 20; i++) await nb.track("page_view");
    expect(warn).toHaveBeenCalledTimes(1);
    // …but a different call is a different fact, and gets its own line.
    await nb.track("signup");
    await nb.identify("user-1");
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("still resolves true when we are up", async () => {
    globalThis.fetch = statusFetch(200);
    const nb = new Notibase({ clientKey: "ck_test", apiUrl: "https://api.test" });
    await expect(nb.track("page_view")).resolves.toBe(true);
    await expect(nb.identify("user-42")).resolves.toBe(true);
  });
});

describe("the hosted config is bounded and its absence is audible", () => {
  it("gives up on a black-holed config fetch instead of waiting forever", async () => {
    // The failure that matters is not a host that refuses — that fails in
    // milliseconds. It is a host that accepts the connection and never
    // answers, where the browser's own timeout is minutes, and everything
    // sequenced behind this call waits out every one of them.
    globalThis.fetch = blackHoleFetch();
    const nb = new Notibase({ clientKey: "ck_test", apiUrl: "https://api.test" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let settled = false;
    const done = nb.init().then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled, "must not have given up before its own timeout").toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(settled).toBe(true);
  });

  it("warns that new subscriptions cannot be created", async () => {
    // Everything else about this failure is invisible: prompt copy reverts
    // to defaults, the subscribe rate goes to zero, and nothing anywhere
    // says why. A customer staring at a flat graph deserves this line.
    globalThis.fetch = deadFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nb = new Notibase({ clientKey: "ck_test", apiUrl: "https://api.test" });
    await nb.init();
    const said = warn.mock.calls.map((c) => String(c[0])).join(" ");
    expect(said).toContain("web/config");
    expect(said).toContain("new subscriptions");
  });

  it("says nothing when the config arrives", async () => {
    globalThis.fetch = statusFetch(200);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nb = new Notibase({ clientKey: "ck_test", apiUrl: "https://api.test" });
    await nb.init();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a key that is wrong is still worth throwing over", () => {
  // The point of the changes above is that *our* failures stay ours. A
  // server key pasted into a browser is the customer's failure, it will
  // never fix itself, and it is a security problem — so it still throws.
  it("refuses a server key loudly", () => {
    expect(() => new Notibase({ clientKey: "sk_live_oops" })).toThrow(/server key/i);
  });

  it("refuses no key at all", () => {
    expect(() => new Notibase({ clientKey: "" })).toThrow(/clientKey is required/);
  });
});
