/**
 * @notibase/web — browser SDK (Arch §7 SDK spec: this file IS the reference
 * implementation the iOS/Android/Flutter SDKs conform to).
 *
 * Ships a CLIENT key (ck_*) — public by design, powerless beyond
 * register/track (Arch §4.9 publishable-key model).
 */

export interface NotibaseConfig {
  clientKey: string;
  /** Defaults to `Notibase.defaultApiUrl` — you only pass this when you are
   *  running against a self-hosted or preview API. */
  apiUrl?: string;
  /** Path to the service worker. Default: /sw.js (customer-hosted or proxied). */
  serviceWorkerPath?: string;
}

export interface InitOptions extends NotibaseConfig {
  /** Register the worker but never ask on our own — you call promptForPush(). */
  autoPrompt?: boolean;
  /** Report install / session_start for attribution. Default: true. */
  autoTrackSessions?: boolean;
  serviceWorkerScope?: string;
  /** Pin the key instead of taking it from the hosted config. Rarely needed. */
  vapidPublicKey?: string;
  /** Accent colour for the soft prompt and live messages. */
  accent?: string;
}

/** The slice of site configuration the browser is allowed to see. */
export interface RuntimePrompt {
  style: "slide" | "native" | "none";
  delaySeconds: number;
  pageviews: number;
  title: string;
  message: string;
  accept: string;
  cancel: string;
}

export interface RuntimeConfig {
  vapidPublicKey: string | null;
  siteName: string;
  defaultIcon: string;
  serviceWorkerPath: string;
  serviceWorkerScope: string;
  autoResubscribe: boolean;
  focusExistingTab: boolean;
  persistence: boolean;
  prompt: RuntimePrompt;
}

const DEFAULT_RUNTIME: RuntimeConfig = {
  vapidPublicKey: null,
  siteName: "",
  defaultIcon: "",
  serviceWorkerPath: "/sw.js",
  serviceWorkerScope: "/",
  autoResubscribe: true,
  focusExistingTab: true,
  persistence: false,
  prompt: {
    style: "slide",
    delaySeconds: 5,
    pageviews: 1,
    title: "",
    message: "",
    accept: "Allow",
    cancel: "Not now",
  },
};

/** One line of the setup test's answer. */
export interface SetupCheck {
  id: string;
  level: "pass" | "warn" | "fail";
  title: string;
  /** What to do about it. Absent for a pass. */
  detail?: string;
}

export interface IdentifyOptions {
  /** HMAC signature from YOUR server: hex(hmac_sha256(identify_secret, external_id)).
   *  Without it, identifying as an existing user is refused server-side
   *  once identity verification is enforced (Arch §4.9). */
  signature?: string;
  attributes?: Record<string, unknown>;
}

/**
 * How long `init()` may wait for the hosted config before giving up on it.
 *
 * It is a soft dependency — DEFAULT_RUNTIME covers every field — but it is
 * fetched before the service worker is registered, because the config is
 * allowed to name a different worker path and registering the wrong one
 * would be worse than waiting. Five seconds bounds that ordering; without a
 * bound, a black-holed host stalled the entire sequence for as long as the
 * browser's own network timeout, which is minutes.
 */
const CONFIG_TIMEOUT_MS = 5_000;

/** How long a realtime socket must hold before its backoff is forgiven. */
const STABLE_MS = 30_000;

const STORAGE_KEY = "nb_device_id";
const CLICK_KEY = "nb_click";
const INSTALL_KEY = "nb_install_reported";
const PAGEVIEW_KEY = "nb_pv";
const DISMISS_KEY = "nb_prompt_dismissed";
/** How long a "Not now" is respected before the soft prompt may reappear. */
const DISMISS_DAYS = 7;
/** How often each in-app message has been shown here, and when last. */
const IAM_STATE_KEY = "nb_iam";
/** Sessions counted on this browser, for the session_count trigger. */
const IAM_SESSIONS_KEY = "nb_iam_sessions";

export class Notibase {
  /**
   * Fallback API origin when a caller passes none — which is the normal case,
   * matching the Node, iOS, Android and Flutter SDKs, all of which default the
   * same way. The hosted page bundle overwrites this with the origin that
   * served it, so a self-hosted or preview install needs no configuration
   * either.
   */
  static defaultApiUrl = "https://api.notibase.com";

  private config: Required<NotibaseConfig> | null = null;
  private deviceId: string | null = null;
  private runtime: RuntimeConfig = DEFAULT_RUNTIME;
  private accent = "#4f46e5";
  private registration: ServiceWorkerRegistration | null = null;
  /** Failure kinds already said out loud on this page load. See reportFailure. */
  private readonly warned = new Set<string>();
  private prompting = false;
  private sessionReported = false;
  /**
   * Report `install` once per browser and `session_start` once per page load,
   * so campaign links can be credited with what they drove (Arch §7.3).
   * `init({ autoTrackSessions: false })` turns it off.
   */
  autoTrackSessions = true;

  /** `new Notibase(config)` for bundler users; `new Notibase()` + `init()`
   *  for the hosted page script, which must exist before the config does. */
  constructor(config?: NotibaseConfig) {
    if (config) this.applyConfig(config);
    this.deviceId = safeLocalStorageGet(STORAGE_KEY);
    // Attribution (Arch §7.3): /l/… redirects land with ?nb_click=<id>.
    // Capture it once so install/session_start events match deterministically
    // even if the user signs up three pages later.
    try {
      const fromUrl = new URLSearchParams(window.location.search).get("nb_click");
      if (fromUrl && /^\d+$/.test(fromUrl)) safeLocalStorageSet(CLICK_KEY, fromUrl);
    } catch { /* non-browser environment */ }
  }

  /**
   * One call for the common case: pull the site's hosted configuration,
   * register the service worker, restore an existing subscription, and —
   * unless `autoPrompt: false` — ask for permission the way the dashboard
   * says to ask.
   *
   * Safe to call on every page load; it is idempotent and never throws into
   * the host page. A site that is not configured for web push yet simply
   * ends up with a registered worker and no prompt.
   */
  async init(opts?: InitOptions): Promise<void> {
    if (opts) this.applyConfig(opts);
    if (opts?.accent) this.accent = opts.accent;
    if (opts?.autoTrackSessions !== undefined) this.autoTrackSessions = opts.autoTrackSessions;
    const config = this.requireConfig();
    if (typeof window === "undefined") return;
    // A browser that subscribed on an earlier visit already has a device, so
    // this page load is a session. A brand-new visitor reports as soon as
    // subscribing gives them one.
    void this.reportLifecycle();

    const remote = await this.fetchRuntime();
    if (!remote) {
      // Loud on purpose, once. Without the hosted config there is no VAPID
      // key, so no browser that is not already subscribed can subscribe —
      // and every other symptom of that is invisible: the prompt copy
      // reverts to defaults, the subscribe rate goes to zero, and nothing
      // anywhere says why. A customer staring at a flat graph deserves this
      // line in their console.
      console.warn(
        "[notibase] could not reach %s/v1/web/config — running on defaults. " +
        "Browsers already subscribed keep working; new subscriptions cannot be " +
        "created until it is reachable, unless you pass vapidPublicKey to init(). " +
        "https://notibase.dev/outages.html",
        this.requireConfig().apiUrl
      );
    }
    const rc: RuntimeConfig = {
      ...DEFAULT_RUNTIME,
      ...(remote ?? {}),
      prompt: { ...DEFAULT_RUNTIME.prompt, ...(remote?.prompt ?? {}) },
    };
    // A locally-passed value always wins: the customer typed it into their
    // own page, so overriding it from the server would be a surprise.
    if (opts?.serviceWorkerPath) rc.serviceWorkerPath = opts.serviceWorkerPath;
    if (opts?.serviceWorkerScope) rc.serviceWorkerScope = opts.serviceWorkerScope;
    if (opts?.vapidPublicKey) rc.vapidPublicKey = opts.vapidPublicKey;
    this.runtime = rc;
    config.serviceWorkerPath = rc.serviceWorkerPath;

    if (!pushSupported()) return;
    // The worker needs focusExistingTab, and it may be restarted long after
    // this page is gone — so the config goes through the Cache API, which
    // survives restarts, rather than postMessage, which does not.
    await publishWorkerConfig(rc);

    let registration: ServiceWorkerRegistration;
    try {
      registration = await this.register();
    } catch {
      return; // wrong path, wrong scope, or file:// — nothing else can work
    }

    if (Notification.permission === "granted") {
      // Chrome can silently drop a subscription (storage pressure, key
      // change). Re-subscribing on return is what keeps the device alive.
      if (rc.autoResubscribe || !this.deviceId) {
        await this.subscribeWith(registration).catch(() => null);
      }
      return;
    }
    if (Notification.permission === "denied") return;

    const views = bumpPageviews();
    if (opts?.autoPrompt === false) return;
    if (rc.prompt.style === "none") return;
    if (views < rc.prompt.pageviews) return;
    if (dismissedRecently()) return;

    window.setTimeout(() => { void this.promptForPush(); }, rc.prompt.delaySeconds * 1000);
  }

  /**
   * Ask for permission now. With the slide style the soft prompt is shown
   * first and the browser is only asked once the visitor says yes — a "Not
   * now" costs nothing, a browser-level "Block" is permanent.
   *
   * Returns the device on success, or null if the visitor (or the browser)
   * said no. Never throws.
   */
  async promptForPush(): Promise<{ deviceId: string } | null> {
    if (!pushSupported()) return null;
    if (this.prompting) return null;
    const rc = this.runtime;

    if (Notification.permission === "denied") return null;
    if (Notification.permission === "granted") {
      const reg = await this.register().catch(() => null);
      return reg ? this.subscribeWith(reg).catch(() => null) : null;
    }

    this.prompting = true;
    try {
      if (rc.prompt.style === "slide") {
        const accepted = await showSlidePrompt(rc, this.accent);
        if (!accepted) {
          safeLocalStorageSet(DISMISS_KEY, String(nowMs()));
          return null;
        }
      }
      const reg = await this.register().catch(() => null);
      if (!reg) return null;
      // Requested from inside the Allow click for the slide style, which is
      // what Safari requires — it refuses a permission request that is not
      // tied to a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return null;
      return await this.subscribeWith(reg).catch(() => null);
    } finally {
      this.prompting = false;
    }
  }

  /** Ask permission (call from a user gesture — soft-prompt first!) and
   *  register the push subscription as a device.
   *
   *  Kept for callers that manage their own VAPID key; `init()` +
   *  `promptForPush()` is the path that honours the dashboard settings. */
  async subscribeWebPush(vapidPublicKey?: string): Promise<{ deviceId: string }> {
    if (!pushSupported()) throw new Error("web push is not supported in this browser");
    const key = vapidPublicKey ?? this.runtime.vapidPublicKey;
    if (!key) throw new Error("no VAPID public key — call init() first, or pass one");
    const registration = await this.register();
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(`notification permission: ${permission}`);
    return this.subscribeWith(registration, key);
  }

  /**
   * Opt this browser out. Records the suppression on our side — which the send
   * pipeline honours for every future campaign — and tears down the local push
   * subscription so the browser stops receiving even in-flight sends.
   *
   * Call it from your own "unsubscribe" control. Coming back is
   * `promptForPush()`, but a server-side resubscribe is needed first if you
   * want the suppression lifted.
   */
  async unsubscribe(reason = "user_request"): Promise<boolean> {
    if (!this.deviceId) return false;
    try {
      await this.api("/v1/unsubscribe", { device_id: this.deviceId, reason });
    } catch {
      return false;   // never throw out of an opt-out control
    }
    if (pushSupported()) {
      const reg = await navigator.serviceWorker.getRegistration(this.runtime.serviceWorkerPath)
        .catch(() => null);
      const sub = await reg?.pushManager.getSubscription().catch(() => null);
      await sub?.unsubscribe().catch(() => null);
    }
    return true;
  }

  /** Is this browser subscribed right now? Cheap enough to call on render. */
  async isSubscribed(): Promise<boolean> {
    if (!pushSupported() || Notification.permission !== "granted") return false;
    const reg = await navigator.serviceWorker.getRegistration(this.runtime.serviceWorkerPath)
      .catch(() => null);
    if (!reg) return false;
    return Boolean(await reg.pushManager.getSubscription().catch(() => null));
  }

  private applyConfig(config: NotibaseConfig): void {
    if (config.clientKey?.startsWith("sk_")) {
      // Refuse server keys in the browser — loudly (Arch §4.9).
      throw new Error(
        "NEVER use a server key (sk_*) in the browser. Create a client key (ck_*) in the dashboard."
      );
    }
    if (!config.clientKey) throw new Error("notibase: clientKey is required");
    this.config = {
      serviceWorkerPath: this.config?.serviceWorkerPath ?? "/sw.js",
      ...config,
      apiUrl: (config.apiUrl ?? this.config?.apiUrl ?? Notibase.defaultApiUrl).replace(/\/$/, ""),
    };
  }

  private requireConfig(): Required<NotibaseConfig> {
    if (!this.config) throw new Error("notibase: call init({ clientKey }) first");
    return this.config;
  }

  /**
   * Hosted site config. Failure is not fatal — defaults still work.
   *
   * Bounded, because `init()` waits for it and everything after it —
   * registering the service worker, subscribing, prompting — is sequenced
   * behind. A fetch with no timeout is not slow when a host is down, it is
   * slow when a host is *black-holed*: the connection is accepted and never
   * answered, and the browser's own timeout is minutes. For that whole
   * window nothing here would have run.
   *
   * `AbortController` rather than `AbortSignal.timeout` — the latter is
   * young enough that a browser old enough to matter for push would throw
   * on it, and the whole point of this function is not to throw.
   */
  private async fetchRuntime(): Promise<Partial<RuntimeConfig> | null> {
    const config = this.requireConfig();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CONFIG_TIMEOUT_MS);
    try {
      const res = await fetch(`${config.apiUrl}/v1/web/config`, {
        headers: { authorization: `Bearer ${config.clientKey}` },
        signal: abort.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as Partial<RuntimeConfig>;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async register(): Promise<ServiceWorkerRegistration> {
    if (this.registration) return this.registration;
    const config = this.requireConfig();
    this.registration = await navigator.serviceWorker.register(config.serviceWorkerPath, {
      scope: this.runtime.serviceWorkerScope || "/",
    });
    await navigator.serviceWorker.ready;
    return this.registration;
  }

  private async subscribeWith(
    registration: ServiceWorkerRegistration,
    vapidPublicKey?: string
  ): Promise<{ deviceId: string }> {
    const key = vapidPublicKey ?? this.runtime.vapidPublicKey;
    const existing = await registration.pushManager.getSubscription();
    if (!existing && !key) throw new Error("no VAPID public key configured for this app");
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key as string).buffer as ArrayBuffer,
      }));

    const res = await this.api("/v1/devices", {
      platform: "web",
      token: JSON.stringify(subscription.toJSON()),
      locale: navigator.language?.slice(0, 5),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    this.deviceId = (res as { id: string }).id;
    safeLocalStorageSet(STORAGE_KEY, this.deviceId);
    // The first moment this browser has a device, which is the first moment
    // anything about it can be attributed to a campaign.
    void this.reportLifecycle();
    return { deviceId: this.deviceId };
  }

  /**
   * Report `install` once per browser and `session_start` once per page load,
   * so a campaign link gets credit for what it drove.
   *
   * Nothing to report until a device exists — on the web that means someone
   * subscribed, because an event with no device cannot be attributed to
   * anything. `autoTrackSessions: false` turns it off.
   */
  private async reportLifecycle(): Promise<void> {
    if (!this.autoTrackSessions) return;
    if (!this.deviceId) return;
    if (safeLocalStorageGet(INSTALL_KEY)) {
      if (this.sessionReported) return;
      this.sessionReported = true;
      await this.track("session_start");
      return;
    }
    safeLocalStorageSet(INSTALL_KEY, "1");
    await this.track("install");
  }

  /**
   * Record a purchase, with the revenue it earned.
   *
   * `purchase` is one of the three reserved event names, and its `value` is
   * what the attribution report rolls up per campaign — so which property the
   * money goes in is worth not leaving to memory.
   */
  async trackPurchase(
    value: number,
    opts: { currency?: string; productId?: string; properties?: Record<string, unknown> } = {}
  ): Promise<boolean> {
    return this.track("purchase", {
      ...(opts.properties ?? {}),
      value,
      currency: opts.currency ?? "USD",
      ...(opts.productId ? { product_id: opts.productId } : {}),
    });
  }

  /**
   * Link this device to your user. Pass the HMAC signature from your server.
   *
   * Returns whether it landed. **It does not reject** — see `track`.
   */
  async identify(externalId: string, opts: IdentifyOptions = {}): Promise<boolean> {
    try {
      await this.api("/v1/identify", {
        external_id: externalId,
        signature: opts.signature,
        attributes: opts.attributes ?? {},
        device_id: this.deviceId,
      });
      return true;
    } catch (e) {
      this.reportFailure("identify", e);
      return false;
    }
  }

  /** Track a custom event (batched flush lands with the ingest edge).
   *  Reserved names (install, session_start, purchase) feed attribution —
   *  a captured nb_click is attached automatically. */
  async track(name: string, properties: Record<string, unknown> = {}): Promise<boolean> {
    if ((name === "install" || name === "session_start") && properties["nb_click"] === undefined) {
      const click = safeLocalStorageGet(CLICK_KEY);
      if (click) properties = { ...properties, nb_click: click };
    }
    try {
      await this.api("/v1/events", { name, properties, device_id: this.deviceId });
      return true;
    } catch (e) {
      this.reportFailure(`track(${name})`, e);
      return false;
    }
  }

  /**
   * A call that could not reach us, said once and never thrown.
   *
   * These three — track, trackPurchase, identify — are sprinkled through a
   * customer's app and nobody writes `.catch()` on an analytics call. They
   * used to reject, so during an outage a page produced unhandled rejections
   * at page-view rate, and anybody who wrote `await nb.track(...)` inside a
   * click handler got a throw in the middle of their own checkout. That is
   * our problem arriving in their stack trace.
   *
   * Once per kind per page load. A hundred identical lines during an outage
   * is not more informative than one, and it buries whatever else the
   * customer is debugging.
   */
  private reportFailure(what: string, err: unknown): void {
    if (this.warned.has(what)) return;
    this.warned.add(what);
    console.warn(`[notibase] ${what} did not reach us —`, err,
      "\nFurther failures of this call are silent. https://notibase.dev/outages.html");
  }

  /**
   * Check the integration and print what is wrong with it.
   *
   * Run it from the console on the page you are integrating. Most of what
   * goes wrong is invisible from the browser — VAPID keys that were never
   * generated, a key belonging to another app, a device this app has never
   * seen — so this reports what the page can see and prints what the server
   * makes of it.
   *
   *   await notibase.runSetupTest();
   */
  async runSetupTest(): Promise<SetupCheck[]> {
    const config = this.requireConfig();
    const report: Record<string, unknown> = {
      platform: "web",
      sdk: "@notibase/web",
      device_id: this.deviceId,
      bundle_id: typeof location === "undefined" ? null : location.origin,
      has_push_token: false,
    };
    if (typeof Notification !== "undefined") {
      report["push_permission"] =
        Notification.permission === "default" ? "not_determined" : Notification.permission;
    }
    if (pushSupported()) {
      const registration = await navigator.serviceWorker
        .getRegistration(this.runtime.serviceWorkerPath).catch(() => null);
      const subscription = await registration?.pushManager.getSubscription().catch(() => null);
      report["has_push_token"] = Boolean(subscription);
    }

    let checks: SetupCheck[];
    try {
      checks = ((await this.api("/v1/setup-test", report)) as { checks: SetupCheck[] }).checks ?? [];
    } catch (e) {
      // The one failure the server cannot report on: it was never reached.
      console.error(`[notibase] setup test could not reach ${config.apiUrl} —`, e);
      return [];
    }
    console.group("[notibase] setup test");
    for (const c of checks) {
      const line = `${c.level === "pass" ? "✔" : c.level === "warn" ? "!" : "✘"} ${c.title}`;
      if (c.level === "fail") console.error(line, c.detail ?? "");
      else if (c.level === "warn") console.warn(line, c.detail ?? "");
      else console.info(line);
    }
    if (!checks.some((c) => c.level === "fail")) console.info("nothing blocking");
    console.groupEnd();
    return checks;
  }

  // ── inbox (Arch §4.5) ──

  readonly inbox = {
    /** List this user's inbox (device must be identified). */
    list: async (opts: { cursor?: string; limit?: number } = {}): Promise<{
      items: { id: string; content: { title: string; body?: string; url?: string }; read_at: string | null; created_at: string }[];
      unread: number;
    }> => {
      if (!this.deviceId) throw new Error("subscribe/identify first — no device on this browser");
      const params = new URLSearchParams({ device_id: this.deviceId });
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit) params.set("limit", String(opts.limit));
      const config = this.requireConfig();
      const res = await fetch(`${config.apiUrl}/v1/inbox?${params}`, {
        headers: { authorization: `Bearer ${config.clientKey}` },
      });
      if (!res.ok) throw new Error(`inbox list → ${res.status}`);
      return res.json();
    },

    markRead: async (ids: string[]): Promise<void> => {
      if (!this.deviceId) throw new Error("no device on this browser");
      await this.api("/v1/inbox/read", { device_id: this.deviceId, ids });
    },
  };

  /**
   * Live in-app messages (Arch §4.5): banners/modals/toasts pushed to THIS
   * open tab the instant a campaign sends. Zero-dependency renderer; all
   * text goes through textContent (never innerHTML) so message content can
   * never inject markup. Returns a disconnect function.
   *
   * enableLiveMessages()                    — built-in renderer
   * enableLiveMessages({ onMessage })       — render yourself (return true to
   *                                           suppress the built-in UI)
   */
  enableLiveMessages(opts: {
    onMessage?: (msg: LiveMessage) => boolean | void;
    /** Accent color for CTA + border. Default #4f46e5. */
    accent?: string;
  } = {}): () => void {
    return this.connectRealtime((frame) => {
      if (frame.type !== "live.show") return;
      const msg = frame.payload as LiveMessage;
      if (opts.onMessage && opts.onMessage(msg) === true) return;
      renderLive(msg, opts.accent ?? this.accent, {
        onCta: () => { void this.track("live_click", { message_id: msg.message_id }); },
        onDismiss: () => { void this.track("live_dismiss", { message_id: msg.message_id }); },
      });
    });
  }

  // ── in-app messages ──────────────────────────────────────────────────
  //
  // Different from everything above it in this file, and the difference
  // is worth stating once: nothing here waits for the server to say
  // "now". The rules are fetched, cached, and evaluated on this device,
  // because the moment they exist to act on — the app opening, the cart
  // crossing a number — is one the server never sees.

  /**
   * Values this app has put in front of the SDK for messages to test.
   *
   * `setTrigger("cart_value", 240)` and a campaign configured for
   * `cart_value > 100` fires on the next evaluation. It never leaves the
   * browser: a trigger is a local fact, not an event to report.
   */
  private readonly triggers = new Map<string, string | number | boolean>();
  private inAppRules: InAppRule[] = [];
  private inAppShowing = false;
  private inAppStop: (() => void) | null = null;

  /**
   * Start showing in-app messages.
   *
   * Fetches the rules this device is eligible for, evaluates them now,
   * and again whenever the tab comes back to the foreground — which is
   * what "app open" means on the web — or whenever a trigger changes.
   *
   * Returns a function that stops it. Calling it twice replaces the
   * first runtime rather than running two.
   */
  enableInAppMessages(opts: {
    /** Render it yourself. Return true to suppress the built-in UI. */
    onMessage?: (msg: InAppRule) => boolean | void;
  } = {}): () => void {
    this.inAppStop?.();
    if (typeof document === "undefined") return () => { /* not a browser */ };

    // One per page load. A tab that has been in the background for three
    // days and comes forward is a new session by any reading a customer
    // would recognise; a tab switched away from for four seconds is not,
    // and this deliberately does not try to tell them apart — the
    // trigger it feeds is "how many times has this person been here",
    // and being slightly generous with that is better than a heuristic
    // nobody can predict.
    const sessions = Number(safeLocalStorageGet(IAM_SESSIONS_KEY) ?? "0") + 1;
    safeLocalStorageSet(IAM_SESSIONS_KEY, String(sessions));

    const onVisible = () => { if (!document.hidden) void this.refreshInApp(opts.onMessage); };
    document.addEventListener("visibilitychange", onVisible);
    this.inAppRender = opts.onMessage ?? null;
    void this.refreshInApp(opts.onMessage);

    const stop = () => {
      document.removeEventListener("visibilitychange", onVisible);
      this.inAppRules = [];
      this.inAppRender = null;
      this.inAppStop = null;
    };
    this.inAppStop = stop;
    return stop;
  }

  private inAppRender: ((msg: InAppRule) => boolean | void) | null = null;

  /**
   * Put a value in front of the SDK for messages to test against.
   *
   * Evaluates immediately, so a campaign keyed on the value fires in the
   * same turn the app sets it — which is the point, and the reason this
   * is not an event that travels to a server first.
   */
  setTrigger(key: string, value: string | number | boolean): void {
    this.triggers.set(key, value);
    void this.evaluateInApp();
  }

  removeTrigger(key: string): void { this.triggers.delete(key); }
  clearTriggers(): void { this.triggers.clear(); }

  private async refreshInApp(onMessage?: (msg: InAppRule) => boolean | void): Promise<void> {
    if (!this.deviceId) return;                    // nothing to be eligible as
    const config = this.requireConfig();
    try {
      const res = await fetch(
        `${config.apiUrl}/v1/in-app?device_id=${encodeURIComponent(this.deviceId)}`,
        { headers: { authorization: `Bearer ${config.clientKey}` } });
      if (!res.ok) return;
      this.inAppRules = ((await res.json()) as { messages: InAppRule[] }).messages ?? [];
    } catch (e) {
      // A campaign that does not appear is not worth a console error on
      // somebody's checkout page. Said once, like every other failure here.
      this.reportFailure("in-app fetch", e);
      return;
    }
    await this.evaluateInApp(onMessage);
  }

  /**
   * Show the first rule this device is allowed to show, or nothing.
   *
   * First, not all of them: two modals at once is the failure mode this
   * feature has, and "the newest one wins" is a rule nobody can predict.
   * The server returns them oldest first, so the oldest eligible campaign
   * shows and the rest wait for the next open.
   */
  private async evaluateInApp(onMessage?: (msg: InAppRule) => boolean | void): Promise<void> {
    if (this.inAppShowing) return;
    const state = readIamState();
    const sessions = Number(safeLocalStorageGet(IAM_SESSIONS_KEY) ?? "1");

    for (const rule of this.inAppRules) {
      const seen = state[rule.id] ?? { count: 0, lastAt: 0 };
      if (rule.max_displays !== null && seen.count >= rule.max_displays) continue;
      if (rule.min_gap_seconds > 0 && nowMs() - seen.lastAt < rule.min_gap_seconds * 1000) continue;
      if (!triggerSatisfied(rule.trigger, this.triggers, sessions)) continue;

      this.inAppShowing = true;
      // Written before it is shown, not after. A person who closes the
      // tab the instant a modal appears has still seen it, and a counter
      // that only advances on a clean dismissal is a counter that shows
      // the same message every launch to whoever closes it fastest.
      state[rule.id] = { count: seen.count + 1, lastAt: nowMs() };
      writeIamState(state);
      void this.reportInApp(rule.id, "shown");

      const done = () => { this.inAppShowing = false; };
      const render = onMessage ?? this.inAppRender;
      if (render && render(rule) === true) { done(); return; }
      renderInApp(rule, {
        onAction: (action) => { void this.runInAppAction(rule, action); },
        onDismiss: () => { void this.reportInApp(rule.id, "dismissed"); done(); },
        onClose: done,
      });
      return;
    }
  }

  /** What a button does. Every branch is a thing the device can do alone. */
  private async runInAppAction(rule: InAppRule, action: InAppAction): Promise<void> {
    await this.reportInApp(rule.id, "clicked", action.kind === "tag_user" ? action.key : undefined);
    switch (action.kind) {
      case "open_url":
        window.open(action.url, "_blank", "noopener,noreferrer");
        break;
      case "prompt_push":
        // The reason this whole feature earns its place. The browser is
        // asked only after the person said yes to us, so a "no" here
        // costs nothing and can be asked again next week — where a
        // browser-level Block is permanent.
        await this.promptForPush();
        break;
      case "track":
        await this.track(action.name, { in_app_message: rule.id });
        break;
      case "tag_user":
      case "dismiss":
        break;                                     // already handled above
    }
  }

  private async reportInApp(id: string, event: string, tag?: string): Promise<void> {
    if (!this.deviceId) return;
    try {
      await this.api("/v1/in-app/event",
        { device_id: this.deviceId, id, event, ...(tag ? { tag } : {}) });
    } catch {
      // An impression that fails to report is a number slightly low. It
      // is never worth surfacing on a customer's page.
    }
  }

  /** Live inbox events over WebSocket. Returns a disconnect function.
   *  Frames: {type:"inbox.new",payload:{id,content,created_at}} ·
   *  {type:"inbox.read",payload:{ids}} · {type:"live.show",payload:LiveMessage} */
  connectRealtime(onFrame: (frame: { type: string; payload: unknown }) => void): () => void {
    if (!this.deviceId) throw new Error("subscribe/identify first — no device on this browser");
    const config = this.requireConfig();
    const url = new URL(`${config.apiUrl}/v1/realtime`);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("key", config.clientKey);
    url.searchParams.set("device_id", this.deviceId);
    let ws: WebSocket | null = null;
    let closed = false;
    let retryMs = 1000;
    let openedAt = 0;
    const open = () => {
      ws = new WebSocket(url.toString());
      ws.onmessage = (ev) => {
        try { onFrame(JSON.parse(String(ev.data))); } catch { /* ignore junk */ }
      };
      ws.onopen = () => { openedAt = Date.now(); };
      ws.onclose = () => {
        if (closed) return;
        // The backoff resets only for a connection that actually *held*.
        // Resetting it in `onopen` meant the shape of failure that matters
        // most — a load balancer that accepts the upgrade and drops it, a
        // backend restarting in a loop — reconnected once a second forever,
        // with the backoff below never engaging. That hammers us at exactly
        // the moment we are already struggling, from every open tab.
        if (openedAt && Date.now() - openedAt >= STABLE_MS) retryMs = 1000;
        openedAt = 0;
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
    };
    open();
    return () => { closed = true; ws?.close(); };
  }

  private async api(path: string, body: unknown): Promise<unknown> {
    const config = this.requireConfig();
    const res = await fetch(`${config.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.clientKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`notibase api ${path} → ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.json();
  }
}

// ── in-app messages: the wire shape, the rules, the renderer ───────────

export type InAppAction =
  | { kind: "dismiss" }
  | { kind: "open_url"; url: string }
  | { kind: "prompt_push" }
  | { kind: "tag_user"; key: string; value: string | number | boolean }
  | { kind: "track"; name: string };

export type InAppBlock =
  | { type: "text"; text: string; size: number; weight: "normal" | "bold"; align: "left" | "center" | "right"; color?: string }
  | { type: "image"; url: string; alt: string; height?: number }
  | { type: "button"; label: string; action: InAppAction; bg?: string; color?: string; radius: number }
  | { type: "spacer"; height: number };

export type InAppTrigger =
  | { kind: "app_open" }
  | { kind: "session_count"; op: string; value: number }
  | { kind: "event"; key: string; op: string; value?: string | number | boolean };

/** One rule, exactly as the API hands it over. */
export interface InAppRule {
  id: string;
  layout: "top" | "center" | "bottom" | "full";
  content: { blocks: InAppBlock[]; style: { bg: string; radius: number; padding: number }; dismissible: boolean };
  trigger: InAppTrigger;
  max_displays: number | null;
  min_gap_seconds: number;
}

interface IamSeen { count: number; lastAt: number }

function readIamState(): Record<string, IamSeen> {
  try { return JSON.parse(safeLocalStorageGet(IAM_STATE_KEY) ?? "{}") as Record<string, IamSeen>; }
  catch { return {}; }
}
function writeIamState(state: Record<string, IamSeen>): void {
  safeLocalStorageSet(IAM_STATE_KEY, JSON.stringify(state));
}

/**
 * Compare, the same way the console offered to.
 *
 * Deliberately does not coerce across types: a trigger set to the string
 * "100" does not satisfy `> 100`, because a customer whose numbers
 * sometimes arrive as strings should find that out from a message that
 * did not fire, not from one that fired for the wrong people.
 */
function compare(left: unknown, op: string, right: unknown): boolean {
  if (op === "exists") return left !== undefined && left !== null;
  if (left === undefined || left === null) return false;
  if (op === "eq") return left === right;
  if (op === "neq") return left !== right;
  if (typeof left !== "number" || typeof right !== "number") return false;
  if (op === "gt") return left > right;
  if (op === "gte") return left >= right;
  if (op === "lt") return left < right;
  if (op === "lte") return left <= right;
  return false;
}

function triggerSatisfied(
  trigger: InAppTrigger, values: Map<string, string | number | boolean>, sessions: number
): boolean {
  if (!trigger || typeof trigger !== "object") return false;
  if (trigger.kind === "app_open") return true;
  if (trigger.kind === "session_count") return compare(sessions, trigger.op, trigger.value);
  if (trigger.kind === "event") return compare(values.get(trigger.key), trigger.op, trigger.value);
  // An unknown kind is a message authored by a newer console than this
  // SDK. Not showing it is the only safe reading: showing it would mean
  // ignoring a condition somebody deliberately set.
  return false;
}

/**
 * The built-in renderer. Inline styles, `textContent` only, no innerHTML
 * anywhere — which is the reason the content is a block document and not
 * the HTML a customer wrote.
 */
function renderInApp(
  rule: InAppRule,
  hooks: { onAction: (a: InAppAction) => void; onDismiss: () => void; onClose: () => void }
): void {
  if (typeof document === "undefined") return;
  const { blocks, style, dismissible } = rule.content;
  const full = rule.layout === "full";

  const scrim = document.createElement("div");
  scrim.style.cssText =
    "position:fixed;inset:0;z-index:2147482999;background:rgba(0,0,0,.45);" +
    "display:flex;padding:16px;box-sizing:border-box;" +
    `align-items:${full ? "stretch" : rule.layout === "top" ? "flex-start" : rule.layout === "bottom" ? "flex-end" : "center"};` +
    "justify-content:center;";

  const card = document.createElement("div");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.style.cssText =
    `position:relative;background:${style.bg};border-radius:${full ? 0 : style.radius}px;` +
    `padding:${style.padding}px;box-sizing:border-box;` +
    "font:15px/1.5 system-ui,-apple-system,sans-serif;color:#111;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.22);overflow:auto;" +
    (full ? "width:100%;height:100%;" : "max-width:420px;width:100%;max-height:88vh;");

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.remove();
    document.removeEventListener("keydown", onKey);
    hooks.onClose();
  };
  const dismiss = () => { if (!closed) { hooks.onDismiss(); close(); } };
  // Escape closes anything that has a close button. A message the author
  // made unescapable stays unescapable, which is why the API refuses the
  // combination that would make that a trap.
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && dismissible) dismiss(); };

  for (const b of blocks) {
    if (b.type === "text") {
      const el = document.createElement("p");
      el.textContent = b.text;
      el.style.cssText =
        `margin:0 0 10px;font-size:${b.size}px;font-weight:${b.weight === "bold" ? 700 : 400};` +
        `text-align:${b.align};${b.color ? `color:${b.color};` : ""}`;
      card.appendChild(el);
    } else if (b.type === "image") {
      const el = document.createElement("img");
      el.src = b.url;
      el.alt = b.alt;
      el.style.cssText =
        `display:block;max-width:100%;margin:0 auto 12px;border-radius:8px;` +
        (b.height ? `height:${b.height}px;object-fit:cover;` : "");
      card.appendChild(el);
    } else if (b.type === "spacer") {
      const el = document.createElement("div");
      el.style.height = `${b.height}px`;
      card.appendChild(el);
    } else {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = b.label;
      el.style.cssText =
        `display:block;width:100%;margin:8px 0 0;padding:11px 16px;cursor:pointer;` +
        `border:0;border-radius:${b.radius}px;font:inherit;font-weight:600;` +
        `background:${b.bg ?? "#111"};color:${b.color ?? "#fff"};`;
      el.addEventListener("click", () => {
        hooks.onAction(b.action);
        // Every press closes the message. A modal that stays open behind
        // a permission dialog is a modal the person then has to close
        // twice, and nobody reads it the second time.
        close();
      });
      card.appendChild(el);
    }
  }

  if (dismissible) {
    const x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.textContent = "×";
    x.style.cssText =
      "position:absolute;top:8px;right:12px;border:0;background:none;cursor:pointer;" +
      "font-size:22px;line-height:1;color:#888;padding:2px;";
    x.addEventListener("click", dismiss);
    card.appendChild(x);
    scrim.addEventListener("click", (e) => { if (e.target === scrim) dismiss(); });
  }

  document.addEventListener("keydown", onKey);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
}

export interface LiveMessage {
  message_id: string;
  display: "banner" | "modal" | "toast";
  title: string;
  body?: string;
  url?: string;
  cta?: string;
  duration_ms?: number;
}

/** Built-in live renderer — inline styles only, textContent only (XSS-safe). */
function renderLive(
  msg: LiveMessage,
  accent: string,
  hooks: { onCta: () => void; onDismiss: () => void }
): void {
  if (typeof document === "undefined") return; // non-DOM environment
  const box = document.createElement("div");
  box.setAttribute("role", msg.display === "modal" ? "dialog" : "status");
  box.style.cssText =
    "position:fixed;z-index:2147483000;background:#fff;color:#111;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.18);border-radius:12px;padding:16px 18px;" +
    "font:14px/1.45 system-ui,sans-serif;max-width:380px;" +
    `border-left:4px solid ${accent};`;
  if (msg.display === "banner") box.style.cssText += "top:16px;left:50%;transform:translateX(-50%);";
  else if (msg.display === "toast") box.style.cssText += "bottom:16px;right:16px;";
  else box.style.cssText += "top:50%;left:50%;transform:translate(-50%,-50%);max-width:440px;";

  let overlay: HTMLElement | null = null;
  if (msg.display === "modal") {
    overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147482999;background:rgba(0,0,0,.4);";
    document.body.appendChild(overlay);
  }

  const close = () => { box.remove(); overlay?.remove(); };

  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;margin-bottom:2px;padding-right:20px;";
  title.textContent = msg.title;
  box.appendChild(title);
  if (msg.body) {
    const body = document.createElement("div");
    body.style.cssText = "color:#444;";
    body.textContent = msg.body;
    box.appendChild(body);
  }
  if (msg.cta && msg.url) {
    const cta = document.createElement("a");
    cta.href = msg.url;
    cta.target = "_blank";
    cta.rel = "noopener noreferrer";
    cta.textContent = msg.cta;
    cta.style.cssText =
      `display:inline-block;margin-top:10px;background:${accent};color:#fff;` +
      "padding:7px 14px;border-radius:8px;text-decoration:none;font-weight:600;";
    cta.addEventListener("click", () => { hooks.onCta(); close(); });
    box.appendChild(cta);
  }
  const x = document.createElement("button");
  x.setAttribute("aria-label", "Dismiss");
  x.textContent = "×";
  x.style.cssText =
    "position:absolute;top:6px;right:10px;border:0;background:none;cursor:pointer;" +
    "font-size:18px;color:#999;line-height:1;padding:2px;";
  x.addEventListener("click", () => { hooks.onDismiss(); close(); });
  box.appendChild(x);
  overlay?.addEventListener("click", () => { hooks.onDismiss(); close(); });

  document.body.appendChild(box);
  const ttl = msg.duration_ms ?? (msg.display === "toast" ? 6000 : 0);
  if (ttl > 0) setTimeout(close, ttl);
}

/**
 * The soft prompt. Dependency-free, inline-styled, textContent only, and
 * resolved by a real click — which is what makes the browser accept the
 * permission request that follows on Safari.
 */
function showSlidePrompt(rc: RuntimeConfig, accent: string): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  const site = rc.siteName || location.hostname;
  const title = rc.prompt.title || `${site} would like to send you notifications`;
  const message = rc.prompt.message || "You can turn them off at any time.";

  return new Promise<boolean>((resolve) => {
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Notification permission");
    box.style.cssText =
      "position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-140%);" +
      "z-index:2147483000;background:#fff;color:#111;display:flex;gap:12px;align-items:flex-start;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.18);border-radius:12px;padding:14px 16px;" +
      "font:14px/1.45 system-ui,-apple-system,sans-serif;max-width:440px;width:calc(100% - 32px);" +
      "transition:transform .22s ease-out;";

    if (rc.defaultIcon) {
      const icon = document.createElement("img");
      icon.src = rc.defaultIcon;
      icon.alt = "";
      icon.style.cssText = "width:40px;height:40px;border-radius:8px;flex:0 0 auto;object-fit:cover;";
      box.appendChild(icon);
    }

    const text = document.createElement("div");
    text.style.cssText = "flex:1 1 auto;min-width:0;";
    const h = document.createElement("div");
    h.style.cssText = "font-weight:600;";
    h.textContent = title;
    const p = document.createElement("div");
    p.style.cssText = "color:#555;margin-top:2px;";
    p.textContent = message;
    text.appendChild(h);
    text.appendChild(p);

    const row = document.createElement("div");
    row.style.cssText = "margin-top:10px;display:flex;gap:8px;";
    const no = document.createElement("button");
    no.type = "button";
    no.textContent = rc.prompt.cancel || "Not now";
    no.style.cssText =
      "border:1px solid #d4d4d8;background:#fff;color:#3f3f46;border-radius:8px;" +
      "padding:7px 14px;cursor:pointer;font:inherit;font-weight:500;";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.textContent = rc.prompt.accept || "Allow";
    yes.style.cssText =
      `border:0;background:${accent};color:#fff;border-radius:8px;` +
      "padding:8px 15px;cursor:pointer;font:inherit;font-weight:600;";
    row.appendChild(no);
    row.appendChild(yes);
    text.appendChild(row);
    box.appendChild(text);

    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      box.style.transform = "translateX(-50%) translateY(-140%)";
      setTimeout(() => box.remove(), 240);
      resolve(accepted);
    };
    no.addEventListener("click", () => finish(false));
    yes.addEventListener("click", () => finish(true));

    document.body.appendChild(box);
    // Next frame, so the transition has a start value to animate from.
    requestAnimationFrame(() => { box.style.transform = "translateX(-50%) translateY(0)"; });
  });
}

/** Cache-API handoff to the service worker (see init()). */
const WORKER_CONFIG_CACHE = "notibase-config";
const WORKER_CONFIG_URL = "/__notibase/config.json";

async function publishWorkerConfig(rc: RuntimeConfig): Promise<void> {
  try {
    const cache = await caches.open(WORKER_CONFIG_CACHE);
    await cache.put(
      new Request(WORKER_CONFIG_URL),
      new Response(JSON.stringify({
        focusExistingTab: rc.focusExistingTab,
        persistence: rc.persistence,
        defaultIcon: rc.defaultIcon,
      }), { headers: { "content-type": "application/json" } })
    );
  } catch { /* Cache API unavailable — the worker falls back to defaults */ }
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

function nowMs(): number {
  return new Date().getTime();
}

/** Count views in this browser so "ask on the 3rd page" can mean something. */
function bumpPageviews(): number {
  const next = Number(safeLocalStorageGet(PAGEVIEW_KEY) ?? "0") + 1;
  safeLocalStorageSet(PAGEVIEW_KEY, String(next));
  return next;
}

function dismissedRecently(): boolean {
  const at = Number(safeLocalStorageGet(DISMISS_KEY) ?? "0");
  if (!at) return false;
  return nowMs() - at < DISMISS_DAYS * 86_400_000;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function safeLocalStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}
