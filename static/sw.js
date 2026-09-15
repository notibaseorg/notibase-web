/* Notibase service worker — customers host this at /sw.js (or import it:
 *   importScripts("https://cdn.notibase.com/sdk/sw.js")
 * Hosted delivery lets Notibase ship fixes without customer redeploys
 * (Arch §7 SDK strategy). Keep this file dependency-free.
 */
/* Site settings the page hands over through the Cache API (see init() in the
 * SDK). Read on demand rather than cached in a variable: the worker is
 * restarted freely, and the settings change without a redeploy. */
var NB_CONFIG_CACHE = "notibase-config";
var NB_CONFIG_URL = "/__notibase/config.json";

function nbConfig() {
  return caches
    .open(NB_CONFIG_CACHE)
    .then(function (cache) { return cache.match(NB_CONFIG_URL); })
    .then(function (res) { return res ? res.json() : {}; })
    .catch(function () { return {}; });
}

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: event.data.text() }; }
  const title = payload.title || "Notification";
  const web = payload.web || {};
  const options = {
    body: payload.body || undefined,
    icon: web.icon || payload.icon || undefined,
    badge: web.badge || undefined,
    image: payload.image || undefined,
    requireInteraction: web.requireInteraction === true,
    // Collapse id doubles as the notification tag: a newer message with the
    // same tag replaces the older one in the tray instead of stacking.
    tag: (payload.advanced && payload.advanced.collapseId) || undefined,
    // Notification actions cap at ~2 in every current browser; sending more
    // silently drops the extras, so trim here where it's visible.
    actions: (payload.buttons || []).slice(0, 2).map(function (b) {
      return { action: b.id, title: b.text, icon: b.icon || undefined };
    }),
    data: { url: payload.url, buttons: payload.buttons, ...payload.data },
  };
  // The site default for the icon and for persistence lives in the hosted
  // config; anything set on the message itself outranks it.
  event.waitUntil(
    nbConfig().then(function (cfg) {
      if (!options.icon && cfg.defaultIcon) options.icon = cfg.defaultIcon;
      if (web.requireInteraction === undefined && cfg.persistence === true) {
        options.requireInteraction = true;
      }
      return self.registration.showNotification(title, options);
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // An action button can carry its own destination; falling back to the
  // notification's url keeps a plain body-tap working exactly as before.
  var url = data.url;
  if (event.action && Array.isArray(data.buttons)) {
    for (var i = 0; i < data.buttons.length; i++) {
      if (data.buttons[i] && data.buttons[i].id === event.action && data.buttons[i].url) {
        url = data.buttons[i].url;
      }
    }
  }
  const jobs = [];
  // Click receipt → the delivery log's 'clicked' event + message CTR.
  // nb = { m: messageId, d: deviceId, o: apiOrigin }, embedded per-send.
  const nb = data.nb;
  if (nb && nb.o && nb.m && nb.d) {
    jobs.push(
      fetch(nb.o + "/v1/push/click", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ m: nb.m, d: nb.d }),
        keepalive: true,
      }).catch(function () { /* beacon only — never block the open */ })
    );
  }
  if (url) jobs.push(openTarget(url));
  event.waitUntil(Promise.all(jobs));
});

/* Focus an already-open tab on the same page instead of stacking another
 * copy of it — unless the site turned that off. Matching is by origin +
 * pathname: query strings differ per campaign and would defeat every match,
 * while a different path is genuinely a different destination. */
function openTarget(url) {
  return nbConfig().then(function (cfg) {
    if (cfg.focusExistingTab === false) return clients.openWindow(url);
    var target;
    try { target = new URL(url, self.location.origin); } catch (e) { return clients.openWindow(url); }
    return clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (list) {
        for (var i = 0; i < list.length; i++) {
          var open;
          try { open = new URL(list[i].url); } catch (e) { continue; }
          if (open.origin === target.origin && open.pathname === target.pathname) {
            return list[i].focus();
          }
        }
        return clients.openWindow(url);
      })
      .catch(function () { return clients.openWindow(url); });
  });
}
