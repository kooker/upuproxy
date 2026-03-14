// dist/sw.js (UPP Proxy Service Worker - CF Pages Edition v12)

const VERSION = "v1.0.0-2026031420";
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

    // 【工业级防逃逸修复】拦截通过 JS location.href 等导致的非代理链接跳转
    if (!isProxyRequest(url)) {
        if (req.referrer) {
            try {
                let refUrl = new URL(req.referrer);
                if (isProxyRequest(refUrl)) {
                    // 如果上一页是代理页，说明由于相对路径引发了脱离代理的跳出
                    let targetBaseOrigin = getTargetOrigin(refUrl);
                    if (targetBaseOrigin) {
                        let correctUrl = `${url.origin}/${targetBaseOrigin}${url.pathname}${url.search}${url.hash}`;
                        // 如果是页面跳转，直接 302 强制拉回代理
                        if (req.mode === 'navigate') {
                            return event.respondWith(Response.redirect(correctUrl, 302));
                        } else {
                            // API 或资源强行拉回
                            const fetchOpts = { method: req.method, headers: req.headers, redirect: "manual" };
                            if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
                                fetchOpts.body = req.body;
                                fetchOpts.duplex = "half";
                            }
                            return event.respondWith(fetch(correctUrl, fetchOpts).then(res => processRedirectResponse(res, correctUrl)));
                        }
                    }
                }
            } catch (e) {}
        }
        return; // 交给系统默认处理（比如获取 /sw.js 本身）
    }

    if (req.method !== "GET" && req.method !== "HEAD") return event.respondWith(handleNonGetRequest(req));
    if (req.headers.has("range")) return event.respondWith(handleRangeStream(req));
    if (req.destination === "document" || req.mode === "navigate" || url.pathname.endsWith(".xml")) {
        return event.respondWith(handleDocumentRequest(req));
    }
    event.respondWith(handleStaticResource(req));
});

async function handleNonGetRequest(req) {
    const fetchOpts = { method: req.method, headers: req.headers, redirect: "manual", mode: "cors" };
    if (req.body) { fetchOpts.body = req.body; fetchOpts.duplex = "half"; }
    try {
        const response = await fetch(req.url, fetchOpts);
        return processRedirectResponse(response, req.url);
    } catch {
        return new Response(JSON.stringify({ error: "Pass-through Failed" }), { status: 502 });
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
