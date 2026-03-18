// dist/_worker.js (Cloudflare Pages Worker - Industrial Final v26)

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

    if (clean === target.origin && !request.url.endsWith('/')) {
        return Response.redirect(`${url.origin}/${clean}/`, 301);
    }

    if (target.port) {
        const portNum = Number(target.port);
        const CF_SUPPORTED_PORTS =[80, 443, 8080, 8443, 8880, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096];
        if (!CF_SUPPORTED_PORTS.includes(portNum)) {
            return new Response(
                `Gateway Connection Rejected\n\nCloudflare network strictly prohibits proxying to non-standard port[${portNum}].\nPlease use one of the supported ports: ${CF_SUPPORTED_PORTS.join(', ')}`, 
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
    headers.set("Host", target.host);

    // ==========================================
    // 【终极黑科技：Elite Proxy 高匿模式开启】
    // 抹除一切代理指纹，让 Whoer 侦测失效，让 YouTube 机器人防护网彻底瞎眼！
    // ==========================================
    const proxyHeaders =[
        "x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto",
        "cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "via", "forwarded"
    ];
    proxyHeaders.forEach(h => headers.delete(h));

    // 智能动态镜像来源（替换原版的写死方案，完美兼容 YouTube SPA 动态单页路由验证）
    let reqOrigin = headers.get("Origin");
    if (reqOrigin && reqOrigin.includes(url.host)) {
        headers.set("Origin", reqOrigin.replace(url.origin, target.origin));
    } else if (!reqOrigin && request.method !== 'GET') {
        headers.set("Origin", target.origin);
    }

    let reqReferer = headers.get("Referer");
    if (reqReferer && reqReferer.includes(url.host)) {
        headers.set("Referer", reqReferer.replace(url.origin, target.origin));
    } else {
        headers.set("Referer", target.href);
    }

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
            let newCookie = cookie.replace(/;\s*Domain=[^;]+/ig, "").replace(/;\s*Path=[^;]+/ig, "");
            newCookie += `; Domain=${new URL(proxy.origin).hostname}; Path=/`;
            if (!/;\s*SameSite/i.test(newCookie)) newCookie += "; SameSite=None";
            if (!/;\s*Secure/i.test(newCookie)) newCookie += "; Secure";
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

async function rewriteJSResponse(res, headers, proxy, target) {
    let js = await res.text();
    let trimmed = js.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return new Response(js, { status: res.status, headers });
    
    if (target.hostname.includes("accounts.google.com") || target.hostname.includes("myaccount.google.com")) {
        return new Response(js, { status: res.status, headers });
    }

    const hookCode = `
;(function(){
    if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope && !self.__UP_HOOKED) {
        self.__UP_HOOKED = true;
        const __ProxyOrigin = "${proxy.origin}";
        const __TargetOrigin = "${target.origin}";
        function toProxyUrl(urlStr) {
            if (!urlStr) return urlStr; let str = urlStr.toString();
            if (str.startsWith(__ProxyOrigin + '/http')) return str;
            if (str.startsWith(__ProxyOrigin + '/')) {
                let path = str.slice(__ProxyOrigin.length);
                if (!path.startsWith('/http')) { try { return __ProxyOrigin + '/' + new URL(path, __TargetOrigin).href; } catch(e){} } else return str;
            }
            try { return __ProxyOrigin + "/" + new URL(str, __TargetOrigin).href; } catch(e) { return str; }
        }
        const _fetch = self.fetch;
        self.fetch = async function(resource, options) {
            try {
                let isReq = resource instanceof Request;
                let origUrl = isReq ? resource.url : resource.toString();
                let pUrl = toProxyUrl(origUrl);
                
                if (pUrl === origUrl) {
                    if (options) { options.credentials = "include"; return _fetch(resource, options); }
                    return _fetch(resource, { credentials: "include" });
                }

                if (isReq) {
                    let newInit = options || {};
                    newInit.credentials = newInit.credentials || "include";
                    return _fetch(new Request(pUrl, resource), newInit);
                } else {
                    if (!options) options = {};
                    options.credentials = options.credentials || "include";
                    return _fetch(pUrl, options);
                }
            } catch (e) {
                return _fetch(resource, options);
            }
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
    let rewriter = new HTMLRewriter();
    if (!target.hostname.includes("accounts.google.com") && !target.hostname.includes("myaccount.google.com")) {
        rewriter = rewriter.on("head", new InjectSandbox(proxy, target));
    }

    return rewriter
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
        if (!urlStr) return urlStr; let str = urlStr.toString();
        if (str.startsWith(__ProxyOrigin + '/http')) return str;
        if (str.startsWith(__ProxyOrigin + '/')) {
            let path = str.slice(__ProxyOrigin.length);
            if (!path.startsWith('/http')) { try { return __ProxyOrigin + '/' + new URL(path, __TargetOrigin).href; } catch(e){} } else { return str; }
        }
        try { return __ProxyOrigin + "/" + new URL(str, __TargetOrigin).href; } catch(e) { return str; }
    }

    const origInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (origInnerHTML) {
        Object.defineProperty(Element.prototype, 'innerHTML', {
            get: function() { return origInnerHTML.get.call(this); },
            set: function(val) {
                if (typeof val === 'string') {
                    val = val.replace(/(src|href|action)\\s*=\\s*(['"])(?!http|data:|javascript:|#|\\/\\/)([^'"]+)\\2/ig, (match, attr, quote, path) => {
                        try { return attr + '=' + quote + toProxyUrl(path) + quote; } catch(e) { return match; }
                    });
                }
                return origInnerHTML.set.call(this, val);
            }
        });
    }

    const hookProperty = (proto, prop) => {
        if (!proto) return;
        let desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || !desc.set) return;
        Object.defineProperty(proto, prop, {
            get: function() { return desc.get.call(this); },
            set: function(val) {
                if (val && typeof val === 'string' && !val.startsWith('javascript:') && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith(__ProxyOrigin + '/http')) {
                    try { val = toProxyUrl(val); } catch(e){}
                }
                return desc.set.call(this, val);
            }
        });
    };
    hookProperty(HTMLImageElement.prototype, 'src');
    hookProperty(HTMLScriptElement.prototype, 'src');
    hookProperty(HTMLAnchorElement.prototype, 'href');
    hookProperty(HTMLFormElement.prototype, 'action');
    hookProperty(HTMLIFrameElement.prototype, 'src');

    // 【原生 Request 完美复刻】彻底解决导致 YouTube "Playback ID" 错误的 ReadableStream 克隆失败问题
    const _fetch = window.fetch;
    window.fetch = async function(resource, options) {
        try {
            let isReq = resource instanceof Request;
            let origUrl = isReq ? resource.url : resource.toString();
            let pUrl = toProxyUrl(origUrl);
            
            if (pUrl === origUrl) {
                if (options) { options.credentials = "include"; return _fetch(resource, options); }
                return _fetch(resource, { credentials: "include" });
            }

            if (isReq) {
                let newInit = options || {};
                newInit.credentials = newInit.credentials || "include";
                // 使用原 Request 作为底本直接实例化，由浏览器底层无损转移数据流状态，绝生死锁
                return _fetch(new Request(pUrl, resource), newInit);
            } else {
                if (!options) options = {};
                options.credentials = options.credentials || "include";
                return _fetch(pUrl, options);
            }
        } catch(e) {
            return _fetch(resource, options);
        }
    };

    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u, ...r) {
        try { u = toProxyUrl(u); } catch(e) {} return _open.call(this, m, u, ...r);
    };
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(b) { this.withCredentials = true; return _send.call(this, b); };

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

    const _push = history.pushState;
    history.pushState = function(state, title, url) {
        if (url) { try { url = toProxyUrl(url); } catch(e){} } return _push.call(this, state, title, url);
    };
    const _replace = history.replaceState;
    history.replaceState = function(state, title, url) {
        if (url) { try { url = toProxyUrl(url); } catch(e){} } return _replace.call(this, state, title, url);
    };

    const observer = new MutationObserver(mutations => {
        mutations.forEach(m => {
            if (m.type === 'attributes') {
                const attr = m.attributeName;
                if (['href', 'src', 'action'].includes(attr)) {
                    let val = m.target.getAttribute(attr);
                    if (val && !val.startsWith('javascript:') && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith(__ProxyOrigin + '/http')) {
                        try { m.target.setAttribute(attr, toProxyUrl(val)); } catch(e){}
                    }
                }
            }
            if (m.type === 'childList') {
                m.addedNodes.forEach(n => {
                    if (n.nodeType === 1) { 
                        const fixAttr = (node) => {['href', 'src', 'action'].forEach(attr => {
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
            }
        });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter:['src', 'href', 'action'] });

    if("serviceWorker" in navigator) { window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => 0)); }
})();
</script>`, { html: true });
    }
}
