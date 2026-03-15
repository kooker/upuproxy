// dist/sw.js (UPP Proxy Service Worker - Industrial Final v20)

const VERSION = "v1.0.0-202603152317";
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

self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);

    // 1. 本地框架资源白名单
    if (url.origin === self.location.origin && !isProxyRequest(url)) {
        const p = url.pathname;
        if (p === '/' || p === '/sw.js' || p === '/favicon.ico' || p.startsWith('/_assets/')) return; 
        
        const targetOrigin = getTargetOriginFromReferrer(req);
        if (targetOrigin) {
            const correctUrl = `${self.location.origin}/${targetOrigin}${url.pathname}${url.search}`;
            if (req.mode === 'navigate') return event.respondWith(Response.redirect(correctUrl, 302));
            return event.respondWith(proxyNetworkFetch(req, correctUrl));
        }
        return; 
    }

    // 2. 第三方跨域及绝对路径脱逃请求代理拦截
    if (!isProxyRequest(url) && url.origin !== self.location.origin) {
        let correctUrl = `${self.location.origin}/${url.href}`;
        if (req.mode === 'navigate') return event.respondWith(Response.redirect(correctUrl, 302));
        return event.respondWith(proxyNetworkFetch(req, correctUrl));
    }

    // 3. 【核心修复】视频流/音频流/直播流直通隧道 (彻底修复 0:00 报错与 51 秒断流)
    // 强制使用纯管道直通，绝对不允许进入 Cache 缓存层，防止内存与流管道死锁！
    if (req.headers.has('range') || url.pathname.includes('videoplayback') || url.pathname.includes('live=1')) {
        return event.respondWith(proxyNetworkFetch(req, req.url));
    }

    // 4. 文档优先及静态缓存
    if (req.destination === "document" || req.mode === "navigate" || url.pathname.endsWith(".xml")) {
        return event.respondWith(handleDocumentRequest(req));
    }
    event.respondWith(handleStaticResource(req));
});

// 安全纯净的网络代理转发
async function proxyNetworkFetch(req, targetUrl) {
    const fetchOpts = {
        method: req.method, headers: req.headers, redirect: "manual",
        mode: req.mode === 'navigate' ? 'cors' : (req.mode === 'no-cors' ? 'no-cors' : 'cors'),
        credentials: "include" 
    };
    if (req.body && !['GET', 'HEAD'].includes(req.method)) {
        fetchOpts.body = req.body; fetchOpts.duplex = 'half';
    }
    try {
        const res = await fetch(targetUrl, fetchOpts);
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
