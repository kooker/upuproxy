// dist/sw.js (UPP Proxy Service Worker - CF Pages Edition v11)

const VERSION = "v1.0.0-PAGES";
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

self.addEventListener("message", (event) => {
    if (event.data?.type === "PURGE_CACHE") {
        caches.delete(DYNAMIC_CACHE).then(() => event.ports[0]?.postMessage({ status: "ok" }));
    }
});

function isProxyRequest(url) { return url.pathname.match(/^\/https?:\//i); }
function getTargetOrigin(url) { try { return new URL(url.pathname.slice(1).replace(/^(https?):\/+/, "$1://")).origin; } catch { return ""; } }

self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);

    if (!isProxyRequest(url)) return;

    // 1. POST/PUT 等带 Body 请求接管
    if (req.method !== "GET" && req.method !== "HEAD") return event.respondWith(handleNonGetRequest(req));
    
    // 2. 流媒体 Range 零拷贝透传引擎
    if (req.headers.has("range")) return event.respondWith(handleRangeStream(req));

    // 3. HTML 与 Sitemap: 网络优先，保障 SEO 与内容时效性
    if (req.destination === "document" || req.mode === "navigate" || url.pathname.endsWith(".xml")) {
        return event.respondWith(handleDocumentRequest(req));
    }

    // 4. 静态资源: SWR 极速缓存
    event.respondWith(handleStaticResource(req));
});

async function handleNonGetRequest(req) {
    const fetchOpts = { method: req.method, headers: req.headers, redirect: "manual", mode: "cors" };
    if (req.body) { fetchOpts.body = req.body; fetchOpts.duplex = "half"; }
    try {
        const response = await fetch(req.url, fetchOpts);
        return processRedirectResponse(response, req.url);
    } catch {
        return new Response(JSON.stringify({ error: "Pass-through Failed" }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
}

async function handleDocumentRequest(req) {
    try {
        const res = await fetch(req, { redirect: "manual" });
        const finalRes = processRedirectResponse(res, req.url);
        if (finalRes.ok) {
            const cache = await caches.open(DYNAMIC_CACHE);
            cache.put(req, finalRes.clone()).catch(()=>{});
            trimCache();
        }
        return finalRes;
    } catch {
        return (await caches.match(req)) || new Response("Proxy Offline", { status: 504 });
    }
}

async function handleStaticResource(req) {
    const cache = await caches.open(DYNAMIC_CACHE);
    const cachedRes = await cache.match(req);
    const networkPromise = fetch(req, { redirect: "manual" }).then(res => {
        const finalRes = processRedirectResponse(res, req.url);
        if (finalRes.ok && finalRes.status === 200) {
            const size = Number(finalRes.headers.get("content-length") || 0);
            if (size > 0 && size < MAX_CACHE_SIZE_MB * 1024 * 1024) {
                cache.put(req, finalRes.clone()).catch(()=>{});
                trimCache();
            }
        }
        return finalRes;
    }).catch(() => null);
    
    return cachedRes || networkPromise || new Response("Unavailable", { status: 503 });
}

async function handleRangeStream(req) {
    const cache = await caches.open(DYNAMIC_CACHE);
    const cachedRes = await cache.match(req, { ignoreSearch: false, ignoreVary: true });
    
    if (cachedRes && cachedRes.status === 200) return createPartialResponseFromCache(req, cachedRes);

    try {
        const streamRequest = new Request(req.url, { method: "GET", headers: req.headers, mode: "cors", redirect: "manual" });
        const networkRes = await fetch(streamRequest);
        if (networkRes.status === 206) return networkRes; 
        if (networkRes.status === 200) {
            const size = Number(networkRes.headers.get("content-length") || 0);
            if (size > 0 && size < MAX_CACHE_SIZE_MB * 1024 * 1024) cache.put(req, networkRes.clone()).catch(()=>{});
        }
        return networkRes;
    } catch { return new Response("Stream Error", { status: 502 }); }
}

function processRedirectResponse(response, reqUrl) {
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
            try {
                const proxyOrigin = new URL(reqUrl).origin;
                const absoluteLoc = new URL(location, getTargetOrigin(new URL(reqUrl))).href;
                return new Response(null, { status: response.status, headers: { "Location": `${proxyOrigin}/${absoluteLoc}` } });
            } catch {}
        }
    }
    return response;
}

async function createPartialResponseFromCache(req, fullResponse) {
    const blob = await fullResponse.blob();
    const totalSize = blob.size;
    const contentType = fullResponse.headers.get("content-type") || "application/octet-stream";
    const rangeHeader = req.headers.get("range");

    let start = 0, end = totalSize - 1;
    if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) { start = parseInt(match[1], 10); if (match[2]) end = parseInt(match[2], 10); }
    }

    if (start >= totalSize || start > end) return new Response("", { status: 416, headers: { "Content-Range": `bytes */${totalSize}` } });
    end = Math.min(end, totalSize - 1);
    const slicedBlob = blob.slice(start, end + 1, contentType);

    const headers = new Headers(fullResponse.headers);
    headers.set("Content-Type", contentType);
    headers.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    headers.set("Content-Length", slicedBlob.size);
    headers.set("Accept-Ranges", "bytes");

    return new Response(slicedBlob, { status: 206, headers: headers });
}

async function trimCache() {
    try {
        const cache = await caches.open(DYNAMIC_CACHE);
        const keys = await cache.keys();
        if (keys.length > MAX_DYNAMIC_ITEMS) await Promise.all(keys.slice(0, keys.length - MAX_DYNAMIC_ITEMS).map(r => cache.delete(r)));
    } catch {}
}
