// dist/sw.js (UPP Proxy Service Worker - Industrial Final v18)

const VERSION = "v1.0.0-202603162221";
const CACHE_NAME = "upp-core-v22";

self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// 核心：处理相对路径和丢失的代理前缀
self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);

    // 静态资源直连
    if (url.origin === self.location.origin && (url.pathname === '/sw.js' || url.pathname.startsWith('/_assets/'))) return;

    event.respondWith((async () => {
        // 捕获所有漏网之鱼的请求
        if (url.origin === self.location.origin && !url.pathname.match(/^\/https?:\/\//i)) {
            // 通过 Referer 或 Client 历史溯源原始目标
            const targetOrigin = await getTargetOrigin(req);
            if (targetOrigin) {
                const newTarget = `${self.location.origin}/${targetOrigin}${url.pathname}${url.search}`;
                return proxyFetch(req, newTarget);
            }
        }
        
        // 如果是第三方请求，强制代理化
        if (url.origin !== self.location.origin && !url.pathname.match(/^\/https?:\/\//i)) {
            return proxyFetch(req, `${self.location.origin}/${url.href}`);
        }

        return proxyFetch(req, req.url);
    })());
});

async function getTargetOrigin(req) {
    // 1. 从 Referer 提取
    if (req.referrer) {
        const m = req.referrer.match(/\/https?:\/\/([^\/]+)/);
        if (m) return m[0].slice(1);
    }
    // 2. 从当前控制的 Client 提取
    const client = await clients.get(req.clientId);
    if (client && client.url) {
        const m = client.url.match(/\/https?:\/\/([^\/]+)/);
        if (m) return m[0].slice(1);
    }
    return null;
}

async function proxyFetch(req, target) {
    const headers = new Headers(req.headers);
    // 再次确保 AJAX 头部存在，防止移动端验证码报错
    if (!headers.has("X-Requested-With")) headers.set("X-Requested-With", "XMLHttpRequest");

    const options = {
        method: req.method,
        headers: headers,
        credentials: "include",
        redirect: "manual", // 由 Worker 处理跳转重写
        mode: "cors"
    };

    if (req.body && !['GET', 'HEAD'].includes(req.method)) {
        options.body = await req.blob();
        options.duplex = 'half';
    }

    try {
        const res = await fetch(target, options);
        // 如果是 301/302，在 SW 层再次确保 Location 被代理
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("Location");
            if (loc && !loc.startsWith(self.location.origin)) {
                const originTarget = target.match(/\/https?:\/\/([^\/]+)/)[0].slice(1);
                const newLoc = `${self.location.origin}/${new URL(loc, originTarget).href}`;
                return new Response(null, { status: res.status, headers: { "Location": newLoc } });
            }
        }
        return res;
    } catch (e) {
        return new Response("Network Error", { status: 480 });
    }
}
