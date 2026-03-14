// dist/sw.js (UPP Proxy Service Worker - Industrial Final v14)

const VERSION = "v1.0.0-202603142136";
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

    // 【防逃逸引擎】拦截 JS 相对路径跳转导致的脱离代理
    if (!isProxyRequest(url)) {
        if (req.referrer) {
            try {
                let refUrl = new URL(req.referrer);
                if (isProxyRequest(refUrl)) {
                    let targetBaseOrigin = getTargetOrigin(refUrl);
                    if (targetBaseOrigin) {
                        let correctUrl = `${url.origin}/${targetBaseOrigin}${url.pathname}${url.search}${url.hash}`;
                        if (req.mode === 'navigate') return event.respondWith(Response.redirect(correctUrl, 302));
                        const newReq = new Request(correctUrl, req);
                        return event.respondWith(fetch(newReq));
                    }
                }
            } catch (e) {}
        }
        return;
    }

    // 【核心修复 1】: 表单提交 (POST/PUT) 与 媒体流 (Range) 绝对直通！
    // 彻底解决 Typecho 评论 302 无限重定向死循环，以及 YouTube 视频播放 1 分钟断流问题！
    if (req.method !== "GET" && req.method !== "HEAD") {
        return event.respondWith(fetch(req));
    }
    if (req.headers.has("range") || url.pathname.includes("videoplayback")) {
        return event.respondWith(fetch(req));
    }

    // HTML 与 Sitemap: 网络优先，保障 SEO 与内容时效性
    if (req.destination === "document" || req.mode === "navigate" || url.pathname.endsWith(".xml")) {
        return event.respondWith(handleDocumentRequest(req));
    }

    // 静态资源: SWR 极速缓存
    event.respondWith(handleStaticResource(req));
});

async function handleDocumentRequest(req) {
    try {
        const res = await fetch(req); // 依靠浏览器原生机制处理 Worker 下发的完美重定向
        if (res.ok) {
            caches.open(DYNAMIC_CACHE).then(c => { c.put(req, res.clone()).catch(()=>{}); trimCache(); });
        }
        return res;
    } catch { 
        return (await caches.match(req)) || new Response("Proxy Offline", { status: 504 }); 
    }
}

async function handleStaticResource(req) {
    const cache = await caches.open(DYNAMIC_CACHE);
    const cachedRes = await cache.match(req);
    const networkPromise = fetch(req).then(res => {
        if (res.ok && res.status === 200) {
            const size = Number(res.headers.get("content-length") || 0);
            if (size > 0 && size < MAX_CACHE_SIZE_MB * 1024 * 1024) {
                cache.put(req, res.clone()).catch(()=>{});
                trimCache();
            }
        }
        return res;
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
