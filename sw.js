/*
 * Service worker Tokyo Detailing Studio.
 *
 * Что он делает:
 *  - при установке сохраняет офлайн-страницу и иконки;
 *  - статику (скрипты, стили, шрифты, 3D-модель, изображения) отдаёт из кэша,
 *    поэтому повторные визиты быстрые, а главная открывается без сети;
 *  - страницы всегда запрашивает из сети; без сети показывает сохранённую главную
 *    или офлайн-страницу.
 *
 * Чего он намеренно не делает:
 *  - не кэширует страницы с личными данными (запись, гараж, профиль);
 *  - не трогает отправку форм и серверные действия — заявка без сети не «отправляется».
 *
 * Уведомления (Web Push): показывает присланное сервером уведомление, по нажатию
 * открывает «Мой гараж», при смене подписки браузером сохраняет новую на сервере.
 *
 * Обновление: новая версия скачивается в фоне и ждёт. Страница показывает предложение
 * обновиться (не во время заполнения заявки и мойки) и по согласию присылает SKIP_WAITING.
 * Сразу активируется только самая первая установка — ей не с чем конфликтовать.
 * Кэши привязаны к VERSION: после активации старые удаляются целиком, поэтому
 * новый интерфейс не смешивается со старыми скриптами.
 */
// Демо-копия на GitHub Pages живёт по адресу /m-detail/: все пути считаются от области service worker.
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const VERSION = "tokyo-v1";
const STATIC = `md-static-${VERSION}`;
const PAGES = `md-pages-${VERSION}`;
const OFFLINE_URL = `${BASE}/offline.html`;
const PRECACHE = [OFFLINE_URL, `${BASE}/icons/icon-192.png`, `${BASE}/icons/icon-512.png`];

/** Страницы без личных данных — их можно показать из кэша, если сети нет. */
const CACHEABLE_PAGES = new Set([`${BASE}/`, `${BASE}/privacy/`, OFFLINE_URL]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGES)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => {
        if (!self.registration.active) return self.skipWaiting();
      }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== STATIC && k !== PAGES).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

const isStatic = (url) =>
  url.pathname.startsWith(`${BASE}/_next/static/`) ||
  url.pathname.startsWith(`${BASE}/models/`) ||
  url.pathname.startsWith(`${BASE}/images/`) ||
  url.pathname.startsWith(`${BASE}/icons/`);

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Частичные ответы (206) в Cache Storage положить нельзя.
  if (response.ok && response.status === 200) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok && response.status === 200) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || fresh;
}

async function page(request, url) {
  try {
    const response = await fetch(request);
    if (response.ok && CACHEABLE_PAGES.has(url.pathname)) {
      const cache = await caches.open(PAGES);
      cache.put(url.pathname, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(PAGES);
    return (
      (CACHEABLE_PAGES.has(url.pathname) && (await cache.match(url.pathname))) ||
      (await cache.match(OFFLINE_URL)) ||
      new Response("Нет подключения к интернету", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(page(request, url));
    return;
  }
  // Данные для переходов внутри приложения (RSC) всегда свежие.
  if (request.headers.has("RSC") || url.searchParams.has("_rsc")) return;

  if (isStatic(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.pathname.startsWith(`${BASE}/`) && /\.(?:js|css|woff2?|png|webp|svg|glb)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// ---------- Уведомления ----------

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : `${BASE}/garage/`;
  // Уведомление показывается всегда: браузеры требуют этого для каждого push.
  event.waitUntil(
    self.registration.showNotification(data.title || "Tokyo Detailing Studio", {
      body: data.body || "Обновление по вашей заявке",
      icon: `${BASE}/icons/icon-192.png`,
      badge: `${BASE}/icons/icon-192.png`,
      tag: data.tag || "m-detail",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || `${BASE}/garage/`, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === url.origin);
      if (open) return open.focus().then((c) => (c && "navigate" in c ? c.navigate(url.href) : c));
      return self.clients.openWindow(url.href);
    }),
  );
});
