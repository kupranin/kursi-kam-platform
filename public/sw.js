// Shows a notification, then opens the page the note points at.
// It does not cache the desk or any other page.

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function safePath(path) {
  if (typeof path !== "string") return "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("://")) return "/";
  return path;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "kursi";
  const body = typeof payload.body === "string" ? payload.body : "";
  const path = safePath(payload.path);
  const tag = typeof payload.tag === "string" ? payload.tag : "";
  const lang = payload.lang === "en" ? "en" : "ka";

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const focused = windows.some((client) => client.focused);
    if (focused) return;
    await self.registration.showNotification(title, {
      body,
      lang,
      tag: tag || undefined,
      icon: new URL("/icon-192.png", self.location.origin).href,
      data: { path },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.path);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(openPath(target, path));
});

async function openPath(target, path) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    let origin = "";
    try {
      origin = new URL(client.url).origin;
    } catch {
      continue;
    }
    if (origin !== self.location.origin) continue;
    if (typeof client.focus === "function") {
      try { await client.focus(); } catch { /* still try to open the path */ }
    }
    if (typeof client.navigate === "function") {
      try {
        await client.navigate(target);
        return;
      } catch {
        /* the page will follow the message */
      }
    }
    client.postMessage({ type: "kursi-push-open", path });
    return;
  }
  if (self.clients.openWindow) await self.clients.openWindow(target);
}
