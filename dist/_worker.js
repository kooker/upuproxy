// dist/_worker.js (Cloudflare Pages Worker - Industrial Final v20)

const MAX_REWRITE_SIZE = 15 * 1024 * 1024;

export default {
    async fetch(request, env, ctx) {
        try { return await handleRequest(request, env); } 
        catch (err) { return new Response("Gateway Error\n" + err.stack, { status: 502 }); }
    }
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    let pathAndQuery = request.url.slice(url.origin.length);
    let clean = pathAndQuery.replace(/^\/+/, "");

    if (clean === "") return homepage(url);
    if (clean === "robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    if (clean === "sw.js" || clean === "favicon.ico") return env.ASSETS.fetch(request);

    clean = clean.replace(/^(https?):\/+/, "$1://");
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
        if (clean.match(/^([a-zA-Z0-9.-]+)(:\d+)?(\/.*)?$/)) clean = "https://" + clean;
        else return new Response("Invalid Target URL", { status: 400 });
    }

    let target;
    try { target = new URL(clean); } catch { return new Response("Invalid Target URL format", { status: 400 }); }

    // 【规避 1003 物理拦截】拦截 Cloudflare 核心网络物理层不支持的端口
    if (target.port) {
        const portNum = Number(target.port);
        const CF_SUPPORTED_PORTS =[80, 443, 8080, 8443, 8880, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096];
        if (!CF_SUPPORTED_PORTS.includes(portNum)) {
            return new Response(
                `Gateway Connection Rejected\n\nCloudflare network strictly prohibits proxying to non-standard port[${portNum}].\nThis is a Cloudflare physical network limit, not a proxy bug.\nPlease use one of the supported ports: ${CF_SUPPORTED_PORTS.join(', ')}`, 
                { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } }
            );
        }
    }

    if (request.method === "OPTIONS") {
        let origin = request.headers.get("Origin");
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": origin || "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
                "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
                "Access-Control-Max-Age": "86400",
                "Access-Control-Allow-Credentials": "true"
            }
        });
    }

    const headers = new Headers(request.headers);

    let trueOrigin = target.origin;
    // 针对 YouTube 严苛的防盗链与心跳 API 进行伪装
    if (target.hostname.includes('youtube.com') || target.hostname.includes('googlevideo.com')) {
        headers.set("Origin", "https://www.youtube.com");
        headers.set("Referer", "https://www.youtube.com/");
    } else {
        const clientReferer = request.headers.get("Referer");
        if (clientReferer) {
            try {
                const parsedClientRef = new URL(clientReferer);
                let refPath = clientReferer.slice(parsedClientRef.origin.length).replace(/^\/+/, "").replace(/^(https?):\/+/, "$1://");
                if (refPath.startsWith("http")) { headers.set("Referer", refPath); trueOrigin = new URL(refPath).origin; } 
                else { headers.set("Referer", target.href); }
            } catch { headers.set("Referer", target.href); }
        } else { headers.set("Referer", target.href); }
        headers.set("Origin", trueOrigin);
    }
    
    headers.set("X-Forwarded-Host", target.host);
    headers.set("X-Forwarded-Proto", target.protocol.replace(':', ''));
    ;["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip"].forEach(h => headers.delete(h));

    const fetchOpts = { method: request.method, headers, redirect: "manual" };
    if (!["GET", "HEAD"].includes(request.method) && request.body) {
        fetchOpts.body = request.body; fetchOpts.duplex = "half"; 
    }

    const response = await fetch(target, fetchOpts);
    const newHeaders = new Headers(response.headers);
    
    let contentType = newHeaders.get("content-type") || "";
    let contentLength = Number(newHeaders.get("content-length") || 0);

    const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    const isCSS = contentType.includes("text/css");
    const isXML = contentType.includes("xml") || clean.endsWith(".xml") || clean.endsWith("robots.txt");
    const isJS = contentType.includes("javascript") || clean.endsWith(".js");
    const shouldRewriteBody = (isHTML || isCSS || isXML || isJS) && contentLength < MAX_REWRITE_SIZE;

    sanitizeAndExposeHeaders(newHeaders, request, shouldRewriteBody);
    rewriteLocation(response, newHeaders, url, target);
    rewriteCookies(newHeaders, url);

    if (request.headers.get("Upgrade") === "websocket") {
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    // 【核心修复】强制穿透 CF Edge Cache，赋予正确的跨域凭证，绝不缓存视频分片
    if (target.pathname.includes("videoplayback") || clean.includes("live=1") || clean.includes("m3u8")) {
        newHeaders.set('Cache-Control', 'no-store, no-cache, no-transform, must-revalidate');
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    if (!shouldRewriteBody || contentType.includes("application/json")) {
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    if (isHTML) return rewriteHTML(response, newHeaders, url, target);
    if (isXML) return rewriteTextResource(response, newHeaders, url, target);
    if (isCSS) return rewriteCSSResponse(response, newHeaders, url, target);
    if (isJS) return rewriteJSResponse(response, newHeaders, url, target);

    return new Response(response.body, { status: response.status, headers: newHeaders });
}

function sanitizeAndExposeHeaders(headers, request, shouldRewriteBody) {
    ;["content-security-policy", "content-security-policy-report-only", "x-frame-options", "clear-site-data", "cross-origin-embedder-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"].forEach(h => headers.delete(h));
    if (shouldRewriteBody) { headers.delete("content-encoding"); headers.delete("content-length"); }
    let exposedHeaders =[]; headers.forEach((v, k) => exposedHeaders.push(k));
    headers.set("Access-Control-Expose-Headers", exposedHeaders.join(", "));
    let origin = request.headers.get("Origin");
    headers.set("Access-Control-Allow-Origin", origin || "*");
    if (origin) headers.set("Access-Control-Allow-Credentials", "true");
}

function rewriteLocation(response, headers, proxy, target) {
    let loc = response.headers.get("location");
    if (!loc) return;
    try {
        let absoluteLoc = new URL(loc, target).href;
        if (!absoluteLoc.startsWith(proxy.origin)) headers.set("location", proxy.origin + "/" + absoluteLoc);
    } catch {}
}

function rewriteCookies(headers, proxy) {
    if (typeof headers.getSetCookie === 'function') {
        const cookies = headers.getSetCookie();
        if (cookies.length === 0) return;
        headers.delete("set-cookie");
        for (let cookie of cookies) {
            let newCookie = cookie.replace(/domain=[^;]+/gi, "Domain=" + new URL(proxy.origin).hostname).replace(/path=[^;]+/gi, "Path=/");
            if (!/SameSite/i.test(newCookie)) newCookie += "; SameSite=None";
            if (!/Secure/i.test(newCookie)) newCookie += "; Secure";
            headers.append("set-cookie", newCookie);
        }
    }
}

async function rewriteTextResource(res, headers, proxy, target) {
    let text = await res.text();
    const targetOriginRegex = new RegExp(target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    text = text.replace(targetOriginRegex, proxy.origin + "/" + target.origin);
    return new Response(text, { status: res.status, headers });
}

async function rewriteCSSResponse(res, headers, proxy, target) {
    let css = await res.text();
    css = css.replace(/url\((.*?)\)/gi, (m, p) => {
        let u = p.replace(/['"]/g, "").trim();
        if (/^(data:|blob:|#)/i.test(u) || u.startsWith(proxy.origin + '/http')) return m;
        try { return `url('${proxy.origin}/${new URL(u, target).href}')`; } catch { return m; }
    });
    return new Response(css, { status: res.status, headers });
}

// 【Web Worker 无损挂载】：只解决 Worker 内置 51 秒断流，同时确保 Request 解析 100% 健壮
async function rewriteJSResponse(res, headers, proxy, target) {
    let js = await res.text();
    const hookCode = `
;(function(){
    if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope && !self.__UP_HOOKED) {
        self.__UP_HOOKED = true;
        const __ProxyOrigin = "${proxy.origin}";
        const __TargetOrigin = "${target.origin}";
        function toProxyUrl(urlStr) {
            if (!urlStr) return urlStr;
            let str = urlStr.toString();
            if (str.startsWith(__ProxyOrigin + '/http')) return str;
            if (str.startsWith(__ProxyOrigin + '/')) {
                let path = str.slice(__ProxyOrigin.length);
                if (!path.startsWith('/http')) { try { return __ProxyOrigin + '/' + new URL(path, __TargetOrigin).href; } catch(e){} } 
                else return str;
            }
            try { return __ProxyOrigin + "/" + new URL(str, __TargetOrigin).href; } catch(e) { return str; }
        }
        const _fetch = self.fetch;
        self.fetch = async function(resource, options) {
            try { 
                if (typeof resource === 'string' || resource instanceof URL) {
                    resource = toProxyUrl(resource);
                } else if (resource instanceof Request) {
                    const newUrl = toProxyUrl(resource.url);
                    const overrideOpts = {
                        method: resource.method, headers: resource.headers,
                        mode: resource.mode === 'navigate' ? 'cors' : resource.mode,
                        credentials: 'include', cache: resource.cache, redirect: resource.redirect
                    };
                    if (resource.method !== 'GET' && resource.method !== 'HEAD') {
                        try { overrideOpts.body = await resource.clone().blob(); } catch(e) {}
                    }
                    resource = new Request(newUrl, overrideOpts);
                }
            } catch(e) {}
            if (options) { options.credentials = "include"; } else { options = { credentials: "include" }; }
            return _fetch(resource, options);
        };
        const _open = self.XMLHttpRequest.prototype.open;
        self.XMLHttpRequest.prototype.open = function(m, u, ...r) {
            try { u = toProxyUrl(u); } catch(e) {} return _open.call(this, m, u, ...r);
        };
        const _send = self.XMLHttpRequest.prototype.send;
        self.XMLHttpRequest.prototype.send = function(b) { this.withCredentials = true; return _send.call(this, b); };
    }
})();
`;
    return new Response(hookCode + js, { status: res.status, headers });
}

function rewriteHTML(res, headers, proxy, target) {
    return new HTMLRewriter()
        .on("head", new InjectSandbox(proxy, target))
        .on("script, link", new RemoveIntegrity())
        .on("link[rel='canonical'], link[rel='alternate'], base[href]", new URLRewriter(proxy, target, "href"))
        .on("meta[property='og:url'], meta[property='og:image'], meta[name='twitter:url'], meta[name='twitter:image']", new URLRewriter(proxy, target, "content"))
        .on("a[href], link[href]", new URLRewriter(proxy, target, "href"))
        .on("img[src], iframe[src], script[src], source[src]", new URLRewriter(proxy, target, "src"))
        .on("img[srcset], source[srcset]", new SrcsetRewriter(proxy, target))
        .on("form[action]", new URLRewriter(proxy, target, "action"))
        .on("[data-src],[data-url],[data-href],[data-video],[data-aff],[data-poster]", new DataAttributeRewriter(proxy, target))
        .transform(new Response(res.body, { status: res.status, headers }));
}

class RemoveIntegrity { element(el) { el.removeAttribute("integrity"); } }
class URLRewriter {
    constructor(proxy, target, attr) { this.proxy = proxy; this.target = target; this.attr = attr; }
    element(el) {
        let val = el.getAttribute(this.attr);
        if (!val || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(val.trim()) || val.startsWith(this.proxy.origin + '/http')) return;
        try { el.setAttribute(this.attr, this.proxy.origin + "/" + new URL(val, this.target).href); } catch {}
    }
}
class DataAttributeRewriter {
    constructor(proxy, target) { this.proxy = proxy; this.target = target; }
    element(el) {['data-src', 'data-url', 'data-href', 'data-video', 'data-aff', 'data-poster'].forEach(attr => {
            let val = el.getAttribute(attr);
            if (val && !/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(val.trim()) && !val.startsWith(this.proxy.origin + '/http')) {
                try { el.setAttribute(attr, this.proxy.origin + "/" + new URL(val, this.target).href); } catch {}
            }
        });
    }
}
class SrcsetRewriter {
    constructor(proxy, target) { this.proxy = proxy; this.target = target; }
    element(el) {
        let val = el.getAttribute("srcset");
        if (!val) return;
        let out = val.split(",").map(p => {
            let [url, size] = p.trim().split(/\s+/);
            if(url.startsWith(this.proxy.origin + '/http')) return p;
            try { return this.proxy.origin + "/" + new URL(url, this.target).href + (size ? " " + size : ""); } catch { return p; }
        }).join(", ");
        el.setAttribute("srcset", out);
    }
}

function homepage(url) {
    return new Response(`
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>UPP Proxy Node</title></head><body style="font-family:sans-serif;text-align:center;padding:10vh 20px;">
<h2>UPP Proxy Pages Engine</h2><p>Gateway is Active.</p>
<div style="background:#f4f4f4;padding:15px;border-radius:8px;display:inline-block;margin-top:20px;">Usage: <code>${url.origin}/https://example.com</code></div></body></html>`, 
    { headers: { "content-type": "text/html;charset=utf-8" } });
}

// 【终极纯净 Sandbox】: 取消主页面的 fetch/XHR 破坏性挂载，交由 Service Worker 自动管理
class InjectSandbox {
    constructor(proxy, target) { this.proxy = proxy; this.target = target; }
    element(el) {
        el.prepend(`
<script>
(function() {
    const __ProxyOrigin = "${this.proxy.origin}";
    const __TargetOrigin = "${this.target.origin}";
    window.__UP_TARGET = __TargetOrigin;

    function toProxyUrl(urlStr) {
        if (!urlStr) return urlStr;
        let str = urlStr.toString();
        if (str.startsWith(__ProxyOrigin + '/http')) return str;
        if (str.startsWith(__ProxyOrigin + '/')) {
            let path = str.slice(__ProxyOrigin.length);
            if (!path.startsWith('/http')) { try { return __ProxyOrigin + '/' + new URL(path, __TargetOrigin).href; } catch(e){} } 
            else { return str; }
        }
        try { return __ProxyOrigin + "/" + new URL(str, __TargetOrigin).href; } catch(e) { return str; }
    }

    // 仅针对 ServiceWorker 无法接管的 WebSocket 进行 Hook
    const _WebSocket = window.WebSocket;
    if (_WebSocket) {
        window.WebSocket = function(url, protocols) {
            try { 
                let wsUrl = new URL(url.toString(), __TargetOrigin);
                if (wsUrl.protocol === 'ws:' || wsUrl.protocol === 'wss:') {
                    let targetUrl = (wsUrl.protocol === 'ws:' ? 'http:' : 'https:') + '//' + wsUrl.host + wsUrl.pathname + wsUrl.search;
                    url = __ProxyOrigin.replace('http', 'ws') + '/' + targetUrl;
                }
            } catch(e) {}
            return protocols ? new _WebSocket(url, protocols) : new _WebSocket(url);
        };
    }

    // 修复无刷新框架的 URL 突变
    const _push = history.pushState;
    history.pushState = function(state, title, url) {
        if (url) { try { url = toProxyUrl(url); } catch(e){} } return _push.call(this, state, title, url);
    };
    const _replace = history.replaceState;
    history.replaceState = function(state, title, url) {
        if (url) { try { url = toProxyUrl(url); } catch(e){} } return _replace.call(this, state, title, url);
    };

    // 兜底 DOM 动态生成渲染
    const observer = new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(n => {
                if (n.nodeType === 1) { 
                    const fixAttr = (node) => {
                        ['href', 'src', 'action'].forEach(attr => {
                            if (node.hasAttribute && node.hasAttribute(attr)) {
                                let val = node.getAttribute(attr);
                                if (val && !val.startsWith('javascript:') && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith(__ProxyOrigin + '/http')) {
                                    try { node.setAttribute(attr, toProxyUrl(val)); } catch(e){}
                                }
                            }
                        });
                    };
                    fixAttr(n);
                    if (n.querySelectorAll) n.querySelectorAll('[href],[src],[action]').forEach(fixAttr);
                }
            });
        });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    if("serviceWorker" in navigator) { window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => 0)); }
})();
</script>`, { html: true });
    }
}
