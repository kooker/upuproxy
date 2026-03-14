// dist/sw.js (UPP Proxy Service Worker - Industrial Final v17)

const VERSION = "v1.0.0-202603142234";
const CACHE_PREFIX = "upp-cache-";
const DYNAMIC_CACHE = `${CACHE_PREFIX}dynamic-${VERSION}`;
const MAX_DYNAMIC_ITEMS = 80;
const MAX_CACHE_SIZE_MB = 50; 

self.addEventListener("install", (event) => self.skipWaiting());
self.addEventListener("activate", (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys => Promise.all(
                keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== DYNAMIC_CACHE).map(k => caches.delete(k))
            ))
        ])
    );
});

function isProxyRequest(url) { return url.pathname.match(/^\/https?:\//i); }
function getTargetOrigin(url) { try { return new URL(url.pathname.slice(1).replace(/^(https?):\/+/, "$1://")).origin; } catch { return ""; } }

self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);

    if (url.origin === self.location.origin && !isProxyRequest(url)) return;

    // 【防逃逸网】拦截 YouTube/Google 动态注入的脱离代理请求
    if (!isProxyRequest(url) && url.origin !== self.location.origin) {
        let correctUrl = `${self.location.origin}/${url.href}`;
        if (req.mode === 'navigate') return event.respondWith(Response.redirect(correctUrl, 302));
        const fetchOpts = { method: req.method, headers: req.headers, redirect: "manual", mode: req.mode === 'navigate' ? 'cors' : req.mode, credentials: req.credentials };
        if (req.body && !["GET", "HEAD"].includes(req.method)) { fetchOpts.body = req.body; fetchOpts.duplex = 'half'; }
        return event.respondWith(fetch(correctUrl, fetchOpts).then(res => processRedirectResponse(res, correctUrl)));
    }

    // 【解决 59 秒断流与 Typecho 表单】强制 Manual 截断，禁止浏览器盲目重定向
    if (req.method !== "GET" && req.method !== "HEAD") {
        const fetchOpts = { method: req.method, headers: req.headers, redirect: "manual" };
        if (req.body) { fetchOpts.body = req.body; fetchOpts.duplex = 'half'; }
        return event.respondWith(fetch(req.url, fetchOpts).then(res => processRedirectResponse(res, req.url)));
    }
    if (req.headers.has("range") || url.pathname.includes("videoplayback")) {
        const fetchOpts = { method: req.method, headers: req.headers, redirect: "manual" };
        return event.respondWith(fetch(req.url, fetchOpts).then(res => processRedirectResponse(res, req.url)));
    }

    if (req.destination === "document" || req.mode === "navigate" || url.pathname.endsWith(".xml")) {
        return event.respondWith(handleDocumentRequest(req));
    }

    event.respondWith(handleStaticResource(req));
});

// 【核心修复】：拦截 301/302 时，完美保留 Set-Cookie 等所有原始响应头！绝不丢失登录/登出状态！
function processRedirectResponse(response, reqUrl) {
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
            const proxyOrigin = new URL(reqUrl).origin;
            if (location.startsWith(proxyOrigin + "/http")) return response;
            try {
                const absoluteLoc = new URL(location, getTargetOrigin(new URL(reqUrl))).href;
                // 必须使用 new Headers 复制全部原始头（包括 Typecho 删除 Cookie 的关键指令）
                const newHeaders = new Headers(response.headers);
                newHeaders.set("Location", `${proxyOrigin}/${absoluteLoc}`);
                return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
            } catch {}
        }
    }
    return response;
}

async function handleDocumentRequest(req) {
    try {
        const fetchOpts = { method: req.method, headers: req.headers, redirect: "manual" };
        const res = await fetch(req.url, fetchOpts);
        const processed = processRedirectResponse(res, req.url);
        if (processed.ok) caches.open(DYNAMIC_CACHE).then(c => { c.put(req, processed.clone()).catch(()=>{}); trimCache(); });
        return processed;
    } catch { return (await caches.match(req)) || new Response("Proxy Offline", { status: 504 }); }
}

async function handleStaticResource(req) {
    const cache = await caches.open(DYNAMIC_CACHE);
    const cachedRes = await cache.match(req);
    const fetchOpts = { method: req.method, headers: req.headers, redirect: "manual" };
    const networkPromise = fetch(req.url, fetchOpts).then(res => {
        const processed = processRedirectResponse(res, req.url);
        if (processed.ok && processed.status === 200) {
            const size = Number(processed.headers.get("content-length") || 0);
            if (size > 0 && size < MAX_CACHE_SIZE_MB * 1024 * 1024) {
                cache.put(req, processed.clone()).catch(()=>{}); trimCache();
            }
        }
        return processed;
    }).catch(() => null);
    return cachedRes || networkPromise || new Response("Unavailable", { status: 503 });
}

async function trimCache() {
    try {
        const cache = await caches.open(DYNAMIC_CACHE);
        const keys = await cache.keys();
        if (keys.length > MAX_DYNAMIC_ITEMS) await Promise.all(keys.slice(0, keys.length - MAX_DYNAMIC_ITEMS).map(r => cache.delete(r)));
    } catch {}
}
