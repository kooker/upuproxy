// dist/_worker.js (Cloudflare Pages Worker - Industrial Ultimate SPA v15)

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
    if (!clean.startsWith("http")) return new Response("Not Found", { status: 404 });

    let target;
    try { target = new URL(clean); } catch { return new Response("Invalid Target URL", { status: 400 }); }

    // 【解决 YouTube 留言/登录 CORS 问题】
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

    // 【解决媒体服务器鉴权拒绝】动态提取真实 Origin 和 Referer
    const clientReferer = request.headers.get("Referer");
    let trueOrigin = target.origin;
    if (clientReferer) {
        try {
            const parsedClientRef = new URL(clientReferer);
            let refPath = clientReferer.slice(parsedClientRef.origin.length).replace(/^\/+/, "").replace(/^(https?):\/+/, "$1://");
            if (refPath.startsWith("http")) {
                headers.set("Referer", refPath);
                trueOrigin = new URL(refPath).origin; // 骗过媒体服务器，声称我们来自 youtube.com
            } else { headers.set("Referer", target.href); }
        } catch { headers.set("Referer", target.href); }
    } else { headers.set("Referer", target.href); }
    headers.set("Origin", trueOrigin);
    
    ;["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip"].forEach(h => headers.delete(h));

    const fetchOpts = { method: request.method, headers, redirect: "manual" };
    if (!["GET", "HEAD"].includes(request.method) && request.body) {
        fetchOpts.body = request.body;
        fetchOpts.duplex = "half"; 
    }

    const response = await fetch(target, fetchOpts);
    const newHeaders = new Headers(response.headers);
    
    let contentType = newHeaders.get("content-type") || "";
    let contentLength = Number(newHeaders.get("content-length") || 0);
    const fetchDest = request.headers.get("sec-fetch-dest");

    // 判断是否需要进行 Body 重写
    const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    const isCSS = contentType.includes("text/css");
    const isXML = contentType.includes("xml") || clean.endsWith(".xml") || clean.endsWith("robots.txt");
    const shouldRewriteBody = (isHTML || isCSS || isXML) && contentLength < MAX_REWRITE_SIZE;

    // 【解决视频 1 分钟断流】：分离式清洗头。如果是视频，绝对保留 content-length！
    sanitizeHeaders(newHeaders, request, shouldRewriteBody);
    rewriteLocation(response, newHeaders, url, target); // 解决 Typecho 死循环的核心
    rewriteCookies(newHeaders, url);

    if (request.headers.get("Upgrade") === "websocket") {
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    // 遇到视频、图片、JSON，直接原样下发管道！
    if (!shouldRewriteBody) {
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    if (isHTML) return rewriteHTML(response, newHeaders, url, target);
    if (isXML) return rewriteTextResource(response, newHeaders, url, target);
    if (isCSS) return rewriteCSSResponse(response, newHeaders, url, target);

    return new Response(response.body, { status: response.status, headers: newHeaders });
}

function sanitizeHeaders(headers, request, shouldRewriteBody) {
    ;["content-security-policy", "content-security-policy-report-only", "x-frame-options", "clear-site-data"].forEach(h => headers.delete(h));
    
    // 如果修改了内容，才删除长度和压缩标示；否则保留（对流媒体至关重要）
    if (shouldRewriteBody) {
        headers.delete("content-encoding");
        headers.delete("content-length");
    }

    let origin = request.headers.get("Origin");
    headers.set("Access-Control-Allow-Origin", origin || "*");
    if (origin) headers.set("Access-Control-Allow-Credentials", "true");
}

function rewriteLocation(response, headers, proxy, target) {
    let loc = response.headers.get("location");
    if (!loc) return;
    try {
        let absoluteLoc = new URL(loc, target).href;
        // 如果源站返回的已经是我们的代理格式，不要再嵌套（防死循环终极保险）
        if (!absoluteLoc.startsWith(proxy.origin)) {
            headers.set("location", proxy.origin + "/" + absoluteLoc);
        }
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
        if (/^(data:|blob:|#)/i.test(u)) return m;
        try { return `url('${proxy.origin}/${new URL(u, target).href}')`; } catch { return m; }
    });
    return new Response(css, { status: res.status, headers });
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
        if (!val || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(val.trim())) return;
        try { el.setAttribute(this.attr, this.proxy.origin + "/" + new URL(val, this.target).href); } catch {}
    }
}

class DataAttributeRewriter {
    constructor(proxy, target) { this.proxy = proxy; this.target = target; }
    element(el) {['data-src', 'data-url', 'data-href', 'data-video', 'data-aff', 'data-poster'].forEach(attr => {
            let val = el.getAttribute(attr);
            if (val && !/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(val.trim())) {
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

// 【解决 YouTube 侧栏 SPA 动态路由加载脱离问题的终极杀器】
class InjectSandbox {
    constructor(proxy, target) { this.proxy = proxy; this.target = target; }
    element(el) {
        el.prepend(`
<script>
window.__UP_TARGET="${this.target.origin}";

// 1. Fetch 与 XHR 拦截 (防 API 逃脱，保证 Credentials)
const _fetch=window.fetch;
window.fetch=async(u,opt)=>{
    try{
        if(typeof u==="string"||u instanceof URL){let ur=new URL(u.toString(),window.__UP_TARGET);if(ur.protocol.startsWith('http'))u=location.origin+"/"+ur.href;}
        else if(u instanceof Request){let ur=new URL(u.url,window.__UP_TARGET);if(ur.protocol.startsWith('http'))u=new Request(location.origin+"/"+ur.href,u);}
    }catch(e){}
    if(opt && typeof opt === 'object' && !opt.credentials) opt.credentials="include";
    else if(!opt) opt={credentials:"include"};
    return _fetch(u,opt);
};

const _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u,...r){
    if(typeof u==="string"){try{let p=new URL(u,window.__UP_TARGET);if(p.protocol.startsWith('http'))u=location.origin+"/"+p.href;}catch(e){}}
    return _open.call(this,m,u,...r);
};
const _send=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send=function(b){this.withCredentials=true; return _send.call(this,b);};

// 2. 拦截 History API (修复 YouTube SPA 单页跳转防逃脱)
const _push = history.pushState;
history.pushState = function(state, title, url) {
    if (url) {
        try {
            let p = new URL(url, window.__UP_TARGET);
            if (p.protocol.startsWith('http')) url = location.origin + "/" + p.href;
        } catch(e){}
    }
    return _push.call(this, state, title, url);
};
const _replace = history.replaceState;
history.replaceState = function(state, title, url) {
    if (url) {
        try {
            let p = new URL(url, window.__UP_TARGET);
            if (p.protocol.startsWith('http')) url = location.origin + "/" + p.href;
        } catch(e){}
    }
    return _replace.call(this, state, title, url);
};

// 3. DOM 动态嗅探器 (修复 YouTube 侧栏 JS 延迟渲染导致节点无法被 Worker 重写的致命 Bug)
const observer = new MutationObserver(mutations => {
    mutations.forEach(m => {
        m.addedNodes.forEach(n => {
            if (n.nodeType === 1) { // 如果是元素节点
                const fixAttr = (node) => {
                    ['href', 'src', 'action'].forEach(attr => {
                        if (node.hasAttribute && node.hasAttribute(attr)) {
                            let val = node.getAttribute(attr);
                            if (val && !val.startsWith('javascript:') && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith(location.origin)) {
                                try {
                                    let abs = new URL(val, window.__UP_TARGET);
                                    if (abs.protocol.startsWith('http')) {
                                        node.setAttribute(attr, location.origin + "/" + abs.href);
                                    }
                                } catch(e){}
                            }
                        }
                    });
                };
                fixAttr(n);
                if (n.querySelectorAll) {
                    n.querySelectorAll('[href], [src],[action]').forEach(fixAttr);
                }
            }
        });
    });
});
observer.observe(document.documentElement, { childList: true, subtree: true });

const _openWin=window.open;
window.open=function(u,t,f){if(typeof u==="string"){try{let p=new URL(u,window.__UP_TARGET);if(p.protocol.startsWith('http'))u=location.origin+"/"+p.href;}catch(e){}}return _openWin.call(window,u,t,f);};

if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>0));
</script>`, { html: true });
    }
}
