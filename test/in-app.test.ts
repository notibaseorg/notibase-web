/**
 * The half of in-app messages that runs on the device.
 *
 * The server hands over rules it has already filtered; everything decided
 * here is decided because the server could not decide it — has the
 * trigger fired, has this person seen it enough times, has the gap
 * elapsed. Those three are the whole of the runtime, and each of them
 * fails in a way a customer would experience as the same message
 * appearing every single launch.
 *
 * The DOM is a stub rather than jsdom, matching outage.test.ts: what the
 * renderer needs from a page is six methods, and writing them down is a
 * better record of that than a dependency providing four hundred. It also
 * makes the assertion this file most needs trivial — every string from a
 * message reaches `textContent` and nothing ever touches `innerHTML`,
 * which a real DOM would let pass silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notibase, type InAppRule } from "../src/index.js";

// ── a page, in about forty lines ───────────────────────────────────────

class El {
  readonly children: El[] = [];
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  readonly style: Record<string, string> = { cssText: "" };
  textContent = "";
  /** Never assigned by the renderer. Asserted below. */
  innerHTML = "";
  src = ""; alt = ""; type = ""; href = "";
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  appendChild(c: El) { this.children.push(c); return c; }
  removeChild(c: El) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  remove() { /* detached in the stub */ }
  addEventListener(name: string, fn: (e: unknown) => void) {
    (this.listeners[name] ??= []).push(fn);
  }
  fire(name: string, e: unknown = {}) { for (const fn of this.listeners[name] ?? []) fn(e); }
  /** Every element in this subtree, the renderer's output flattened. */
  all(): El[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}

let body: El;
let docListeners: Record<string, ((e: unknown) => void)[]>;
let store: Record<string, string>;

function fakePage(): void {
  body = new El("body");
  docListeners = {};
  (globalThis as Record<string, unknown>)["document"] = {
    body,
    hidden: false,
    createElement: (tag: string) => new El(tag),
    addEventListener: (n: string, fn: (e: unknown) => void) => { (docListeners[n] ??= []).push(fn); },
    removeEventListener: (n: string, fn: (e: unknown) => void) => {
      docListeners[n] = (docListeners[n] ?? []).filter((f) => f !== fn);
    },
  };
  (globalThis as Record<string, unknown>)["window"] = {
    location: { search: "" },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    open: vi.fn(),
  };
  store = {};
  (globalThis as Record<string, unknown>)["localStorage"] = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  };
}

const DEVICE = "11111111-1111-4111-8111-111111111111";

/** Every request the SDK made, in order. */
let calls: { url: string; body: Record<string, unknown> | null }[];

function serveRules(rules: InAppRule[]): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url.includes("/v1/in-app?")) {
      return Promise.resolve(new Response(JSON.stringify({ messages: rules }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  fakePage();
  calls = [];
  store["nb_device_id"] = DEVICE;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["document", "window", "localStorage"]) delete (globalThis as Record<string, unknown>)[k];
  vi.restoreAllMocks();
});

// ── fixtures ───────────────────────────────────────────────────────────

function rule(over: Partial<InAppRule> = {}): InAppRule {
  return {
    id: over.id ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    layout: "center",
    content: {
      blocks: [{ type: "text", text: "Hello", size: 16, weight: "normal", align: "center" }],
      style: { bg: "#fff", radius: 16, padding: 24 },
      dismissible: true,
    },
    trigger: { kind: "app_open" },
    max_displays: null,
    min_gap_seconds: 0,
    ...over,
  };
}

const nb = () => new Notibase({ clientKey: "ck_test", apiUrl: "https://api.test" });
const shown = () => calls.filter((c) => c.body?.["event"] === "shown");
const dialogs = () => body.children.length;

/** Let the runtime's fetch + evaluate settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ── the three decisions the device owns ────────────────────────────────

describe("the trigger", () => {
  it("holds a message back until the app puts the value in front of it", async () => {
    serveRules([rule({ trigger: { kind: "event", key: "cart_value", op: "gt", value: 100 } })]);
    const n = nb();
    n.enableInAppMessages();
    await settle();
    expect(dialogs(), "showed before the condition was true").toBe(0);

    n.setTrigger("cart_value", 40);
    await settle();
    expect(dialogs(), "40 is not over 100").toBe(0);

    n.setTrigger("cart_value", 240);
    await settle();
    expect(dialogs()).toBe(1);
    expect(shown()).toHaveLength(1);
  });

  it("does not compare across types", async () => {
    // A customer whose numbers sometimes arrive as strings should find
    // out from a message that did not fire, not from one that fired for
    // the wrong people.
    serveRules([rule({ trigger: { kind: "event", key: "cart_value", op: "gt", value: 100 } })]);
    const n = nb();
    n.enableInAppMessages();
    await settle();
    n.setTrigger("cart_value", "240");
    await settle();
    expect(dialogs()).toBe(0);
  });

  it("counts sessions across page loads", async () => {
    serveRules([rule({ trigger: { kind: "session_count", op: "gte", value: 3 } })]);
    for (const expected of [0, 0, 1]) {
      fakePageKeepingStorage();
      calls = [];
      nb().enableInAppMessages();
      await settle();
      expect(dialogs()).toBe(expected);
    }
  });

  it("refuses a trigger kind it does not understand", async () => {
    // A message authored by a newer console. Showing it would mean
    // ignoring a condition somebody deliberately set, so it waits for an
    // SDK that can read it.
    serveRules([rule({ trigger: { kind: "phase_of_moon" } as unknown as InAppRule["trigger"] })]);
    nb().enableInAppMessages();
    await settle();
    expect(dialogs()).toBe(0);
  });
});

describe("how often somebody sees it", () => {
  it("stops at the display limit, on this device, without asking us", async () => {
    serveRules([rule({ max_displays: 2 })]);
    for (const expectedTotal of [1, 2, 2]) {
      fakePageKeepingStorage();
      nb().enableInAppMessages();
      await settle();
      expect(shown()).toHaveLength(expectedTotal);
    }
  });

  it("waits out the gap between displays", async () => {
    serveRules([rule({ min_gap_seconds: 3600 })]);
    fakePageKeepingStorage();
    nb().enableInAppMessages();
    await settle();
    expect(shown()).toHaveLength(1);

    fakePageKeepingStorage();
    nb().enableInAppMessages();
    await settle();
    expect(shown(), "showed again inside the hour").toHaveLength(1);

    // Rewind the recorded display by two hours: the same thing time does.
    const state = JSON.parse(store["nb_iam"]!) as Record<string, { count: number; lastAt: number }>;
    for (const v of Object.values(state)) v.lastAt -= 2 * 3600_000;
    store["nb_iam"] = JSON.stringify(state);

    fakePageKeepingStorage();
    nb().enableInAppMessages();
    await settle();
    expect(shown()).toHaveLength(2);
  });

  it("counts a display before rendering it, not after", async () => {
    // Somebody who closes the tab the instant a modal appears has still
    // seen it. A counter that only advances on a clean dismissal shows
    // the same message every launch to whoever closes it fastest.
    serveRules([rule({ max_displays: 1 })]);
    nb().enableInAppMessages();
    await settle();
    const state = JSON.parse(store["nb_iam"]!) as Record<string, { count: number }>;
    expect(Object.values(state)[0]!.count).toBe(1);
  });

  it("shows one message, not every eligible one", async () => {
    // Two modals at once is the failure mode this feature has.
    serveRules([
      rule({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" }),
      rule({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2" }),
    ]);
    nb().enableInAppMessages();
    await settle();
    expect(dialogs()).toBe(1);
    expect(shown()).toHaveLength(1);
  });
});

// ── what the renderer does with the content ────────────────────────────

describe("rendering", () => {
  it("puts message copy in a text node and never in markup", async () => {
    serveRules([rule({
      content: {
        blocks: [
          { type: "text", text: "<img src=x onerror=alert(1)>", size: 16, weight: "normal", align: "center" },
          { type: "button", label: "<b>ok</b>", action: { kind: "dismiss" }, radius: 8 },
        ],
        style: { bg: "#fff", radius: 16, padding: 24 },
        dismissible: true,
      },
    })]);
    nb().enableInAppMessages();
    await settle();

    const all = body.children.flatMap((c) => c.all());
    const texts = all.map((e) => e.textContent).filter(Boolean);
    expect(texts).toContain("<img src=x onerror=alert(1)>");
    expect(texts).toContain("<b>ok</b>");
    // The whole reason the content is a block document and not the HTML
    // somebody typed into a console.
    expect(all.every((e) => e.innerHTML === ""), "the renderer wrote markup").toBe(true);
  });

  it("gives an undismissable message no close button", async () => {
    serveRules([rule({
      content: {
        blocks: [{ type: "button", label: "Continue", action: { kind: "dismiss" }, radius: 8 }],
        style: { bg: "#fff", radius: 16, padding: 24 },
        dismissible: false,
      },
    })]);
    nb().enableInAppMessages();
    await settle();
    const all = body.children.flatMap((c) => c.all());
    expect(all.some((e) => e.attrs["aria-label"] === "Close")).toBe(false);
  });
});

// ── what a button does ─────────────────────────────────────────────────

describe("click actions", () => {
  const withButton = (action: InAppRule["content"]["blocks"][number]) => rule({
    content: {
      blocks: [action],
      style: { bg: "#fff", radius: 16, padding: 24 },
      dismissible: true,
    },
  });

  it("asks the browser for push only after the person said yes to us", async () => {
    serveRules([withButton({ type: "button", label: "Yes please", action: { kind: "prompt_push" }, radius: 8 })]);
    const n = nb();
    const prompt = vi.spyOn(n, "promptForPush").mockResolvedValue(null);
    n.enableInAppMessages();
    await settle();
    expect(prompt, "asked before the button was pressed").not.toHaveBeenCalled();

    const button = body.children.flatMap((c) => c.all()).find((e) => e.tag === "button" && e.textContent === "Yes please");
    button!.fire("click");
    await settle();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("reports the tag key and never its value", async () => {
    serveRules([withButton({
      type: "button", label: "Deals please", radius: 8,
      action: { kind: "tag_user", key: "wants_deals", value: true },
    })]);
    nb().enableInAppMessages();
    await settle();
    body.children.flatMap((c) => c.all()).find((e) => e.tag === "button")!.fire("click");
    await settle();

    const click = calls.find((c) => c.body?.["event"] === "clicked");
    expect(click!.body!["tag"]).toBe("wants_deals");
    // The value is the campaign's to decide, not the device's — so it is
    // not on the wire at all, and a tampered client cannot choose it.
    expect(JSON.stringify(click!.body)).not.toContain("true");
  });

  it("opens a link in a new tab with the opener severed", async () => {
    serveRules([withButton({
      type: "button", label: "Read more", radius: 8,
      action: { kind: "open_url", url: "https://notibase.com/blog" },
    })]);
    nb().enableInAppMessages();
    await settle();
    body.children.flatMap((c) => c.all()).find((e) => e.tag === "button")!.fire("click");
    await settle();
    const open = (globalThis as unknown as { window: { open: ReturnType<typeof vi.fn> } }).window.open;
    expect(open).toHaveBeenCalledWith("https://notibase.com/blog", "_blank", "noopener,noreferrer");
  });
});

// ── failure ────────────────────────────────────────────────────────────

describe("when we are unreachable", () => {
  it("shows nothing and says nothing to the page", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const n = nb();
    n.enableInAppMessages();
    await settle();
    expect(dialogs()).toBe(0);
    // Once, like every other failure in this SDK — not once per open.
    n.enableInAppMessages();
    await settle();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

/** A new page load for the same browser: fresh DOM, same localStorage. */
function fakePageKeepingStorage(): void {
  const kept = store;
  fakePage();
  store = kept;
  (globalThis as Record<string, unknown>)["localStorage"] = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  };
}
