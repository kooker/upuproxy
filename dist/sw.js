// dist/sw.js (UPP Proxy Service Worker - Industrial Final v16)

const VERSION = "v1.0.0-202603142214";
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

    // 1. 本地静态资源放行 (如 /sw.js)
    if (url.origin === self.location.origin && !isProxyRequest(url)) {
        return;
    }

    // 2. 【终极逃逸捕获网】拦截 Web Worker、JS 相对路径、隐藏 API 发起的脱离代理请求
    if (!isProxyRequest(url) && url.origin !== self.location.origin) {
        let correctUrl = `${self.location.origin}/${url.href}`;
        if (req.mode === 'navigate') {
            return event.respondWith(Response.redirect(correctUrl, 302));
        }
        const fetchOpts = {
            method: req.method,
            headers: req.headers,
            redirect: "manual",
            mode: req.mode === 'navigate' ? 'cors' : req.mode,
            credentials: req.credentials
        };
        if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOpts.body = req.body;
            fetchOpts.duplex = 'half';
        }
        return event.respondWith(fetch(correctUrl, fetchOpts).then(res => processRedirectResponse(res, correctUrl)));
    }

    // 3. 【解决 59 秒断流与提交死循环】媒体流与非 GET 请求，绝对不拆包，纯管道直通！
    if (req.method !== "GET" && req.method !== "HEAD") {
        return event.respondWith(fetch(req).then(res => processRedirectResponse(res, req.url)));
    }
    if (req.headers.has("range") || url.pathname.includes("videoplayback")) {
        return event.respondWith(fetch(req).then(res => processRedirectResponse(res, req.url)));
    }

    // 4. HTML 与 XML：网络优先
    if (req.destination === "document" || req.mode === "navigate" || url.pathname.endsWith(".xml")) {
        return event.respondWith(handleDocumentRequest(req));
    }

    // 5. 静态资源：极速缓存
    event.respondWith(handleStaticResource(req));
});

// 处理重定向死循环：确保 302/301 跳转被正确控制在代理域内
function processRedirectResponse(response, reqUrl) {
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
            const proxyOrigin = new URL(reqUrl).origin;
            // 如果后端返回的 Location 已经是代理地址，直接返回防止无限嵌套
            if (location.startsWith(proxyOrigin + "/http")) {
                return response;
            }
            try {
                const absoluteLoc = new URL(location, getTargetOrigin(new URL(reqUrl))).href;
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
        if (processed.ok) {
            caches.open(DYNAMIC_CACHE).then(c => { c.put(req, processed.clone()).catch(()=>{}); trimCache(); });
        }
        return processed;
    } catch { 
        return (await caches.match(req)) || new Response("Proxy Offline", { status: 504 }); 
    }
}

async function handleStaticResource(req) {
    const cache = await caches.open(DYNAMIC_CACHE);
    const cachedRes = await cache.match(req);
    const networkPromise = fetch(req).then(res => {
        const processed = processRedirectResponse(res, req.url);
        if (processed.ok && processed.status === 200) {
            const size = Number(processed.headers.get("content-length") || 0);
            if (size > 0 && size < MAX_CACHE_SIZE_MB * 1024 * 1024) {
                cache.put(req, processed.clone()).catch(()=>{});
                trimCache();
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
