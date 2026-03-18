// dist/sw.js (UPP Proxy Service Worker - Industrial Final v21)

const VERSION = "v1.0.0-202603162221";
const CACHE_PREFIX = "upp-cache-";
const DYNAMIC_CACHE = `${CACHE_PREFIX}dynamic-${VERSION}`;
const MAX_DYNAMIC_ITEMS = 120;
const MAX_CACHE_SIZE_MB = 100; 

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

function isProxyRequest(url) { return url.pathname.match(/^\/https?:\/\//i); }
function getTargetOrigin(url) { 
    try { 
        let clean = url.pathname.slice(1).replace(/^(https?):\/+/, "$1://");
        if (!clean.startsWith("http")) clean = "https://" + clean;
        return new URL(clean).origin; 
    } catch { return ""; } 
}

function getTargetOriginFromReferrer(request) {
    try {
        const ref = request.referrer;
        if (!ref) return null;
        const refUrl = new URL(ref);
        if (isProxyRequest(refUrl)) return getTargetOrigin(refUrl);
    } catch (e) {}
    return null;
}

// 【黑科技：时空回溯】解决 Discuz / DuckDuckGo 丢失 Referrer 的绝杀方案
async function getTargetOriginFromClient(clientId) {
    if (!clientId) return null;
    try {
        const client = await clients.get(clientId);
        if (client && client.url) {
            const url = new URL(client.url);
            if (isProxyRequest(url)) return getTargetOrigin(url);
        }
    } catch(e) {}
    return null;
}

self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);

    // 绝对旁路：视频/音频/直播流直接交由浏览器 C++ 底层处理，绝生死锁与 0:00 播放错误
    if (req.destination === 'video' || req.destination === 'audio') {
        return; 
    }

    event.respondWith((async () => {
        // 1. 本地框架与相对路径遗漏兜底
        if (url.origin === self.location.origin && !isProxyRequest(url)) {
            const p = url.pathname;
            if (p === '/' || p === '/sw.js' || p === '/favicon.ico' || p.startsWith('/_assets/')) return fetch(req); 
            
            let targetOrigin = getTargetOriginFromReferrer(req);
            // Referrer 丢失时，通过 Client ID 强行回溯宿主页面环境！
            if (!targetOrigin && req.clientId) {
                targetOrigin = await getTargetOriginFromClient(req.clientId);
            }

            if (targetOrigin) {
                const correctUrl = `${self.location.origin}/${targetOrigin}${url.pathname}${url.search}`;
                if (req.mode === 'navigate') return Response.redirect(correctUrl, 302);
                return proxyNetworkFetch(req, correctUrl);
            }
            return fetch(req); 
        }

        // 2. 第三方跨域及脱逃绝对路径
        if (!isProxyRequest(url) && url.origin !== self.location.origin) {
            let correctUrl = `${self.location.origin}/${url.href}`;
            if (req.mode === 'navigate') return Response.redirect(correctUrl, 302);
            return proxyNetworkFetch(req, correctUrl);
        }

        // 3. 动态切片直通隧道
        if (req.headers.has('range') || url.pathname.includes('videoplayback') || url.pathname.includes('live=1')) {
            return proxyNetworkFetch(req, req.url);
        }

        // 4. 文档优先及静态缓存
        if (req.destination === "document" || req.mode === "navigate" || url.pathname.endsWith(".xml")) {
            return handleDocumentRequest(req);
        }
        return handleStaticResource(req);
    })());
});

async function proxyNetworkFetch(req, targetUrl) {
    const fetchOpts = {
        method: req.method, headers: req.headers, 
        redirect: req.redirect || "follow", // 修复 AJAX 框架遇到 302 跳转崩溃的问题
        mode: req.mode === 'navigate' ? 'cors' : (req.mode === 'no-cors' ? 'no-cors' : 'cors'),
        credentials: "include" 
    };
    if (req.body && !['GET', 'HEAD'].includes(req.method)) {
        fetchOpts.body = req.body; fetchOpts.duplex = 'half';
    }
    try {
        const res = await fetch(targetUrl, fetchOpts);
        if (res.redirected) return res; 
        return processRedirectResponse(res, targetUrl);
    } catch (e) {
        return new Response("Proxy Gateway Offline", { status: 504 });
    }
}

function processRedirectResponse(response, reqUrl) {
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
            const proxyOrigin = new URL(reqUrl).origin;
            if (location.startsWith(proxyOrigin + "/http")) return response;
            try {
                const targetOrigin = getTargetOrigin(new URL(reqUrl));
                const absoluteLoc = new URL(location, targetOrigin).href;
                return new Response(null, { status: response.status, headers: { "Location": `${proxyOrigin}/${absoluteLoc}` } });
            } catch {}
        }
    }
    return response;
}

async function handleDocumentRequest(req) {
    try {
        const res = await fetch(req);
        const processed = processRedirectResponse(res, req.url);
        if (processed.ok) { caches.open(DYNAMIC_CACHE).then(c => { c.put(req, processed.clone()).catch(()=>{}); trimCache(); }); }
        return processed;
    } catch { return (await caches.match(req)) || new Response("Proxy Offline", { status: 504 }); }
}

async function handleStaticResource(req) {
    const cache = await caches.open(DYNAMIC_CACHE);
    const cachedRes = await cache.match(req);
    const networkPromise = fetch(req).then(res => {
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
