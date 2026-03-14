// dist/_worker.js (Cloudflare Pages Advanced Worker - SEO Edition v11)

const MAX_REWRITE_SIZE = 15 * 1024 * 1024; // 15MB

export default {
    async fetch(request, env, ctx) {
        try {
            return await handleRequest(request, env);
        } catch (err) {
            return new Response("Proxy Gateway Error\n\n" + err.stack, { status: 502 });
        }
    }
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    let pathAndQuery = request.url.slice(url.origin.length);
    let clean = pathAndQuery.replace(/^\/+/, "");

    // 1. 根路由与基础 SEO
    if (clean === "") return homepage(url);
    if (clean === "robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // 2. CF Pages 静态资源回退 (兜底，虽然 _routes.json 已经排除了 sw.js)
    if (clean === "sw.js" || clean === "favicon.ico") {
        return env.ASSETS.fetch(request);
    }

    // 3. 目标 URL 解析
    clean = clean.replace(/^(https?):\/+/, "$1://");
    if (!clean.startsWith("http")) return new Response("Not Found", { status: 404 });

    let target;
    try { target = new URL(clean); } catch { return new Response("Invalid Target URL", { status: 400 }); }

    // 4. 请求头伪装
    const headers = new Headers(request.headers);
    headers.set("Host", target.host);
    headers.set("Referer", target.origin);
    headers.set("Origin", target.origin);
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

    sanitizeHeaders(newHeaders);
    rewriteLocation(response, newHeaders, url, target);
    rewriteCookies(newHeaders, url);

    if (request.headers.get("Upgrade") === "websocket") {
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    // 5. SEO / HTML / CSS 重写引擎
    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
        return rewriteHTML(response, newHeaders, url, target);
    }
    if (contentType.includes("xml") || clean.endsWith(".xml")) {
        if (contentLength < MAX_REWRITE_SIZE) return rewriteTextResource(response, newHeaders, url, target);
    }
    if (contentType.includes("text/plain") && clean.endsWith("robots.txt")) {
        if (contentLength < MAX_REWRITE_SIZE) return rewriteTextResource(response, newHeaders, url, target);
    }
    if (contentType.includes("text/css") && contentLength < MAX_REWRITE_SIZE) {
        return rewriteCSSResponse(response, newHeaders, url, target);
    }

    return new Response(response.body, { status: response.status, headers: newHeaders });
}

function sanitizeHeaders(headers) {
    ;["content-security-policy", "content-security-policy-report-only", "x-frame-options", "clear-site-data", "content-encoding", "content-length"].forEach(h => headers.delete(h));
    headers.set("Access-Control-Allow-Origin", "*");
}

function rewriteLocation(response, headers, proxy, target) {
    let loc = response.headers.get("location");
    if (!loc) return;
    try { headers.set("location", proxy.origin + "/" + new URL(loc, target).href); } catch {}
}

function rewriteCookies(headers, proxy) {
    if (typeof headers.getSetCookie === 'function') {
        const cookies = headers.getSetCookie();
        if (cookies.length === 0) return;
        headers.delete("set-cookie");
        for (let cookie of cookies) {
            headers.append("set-cookie", cookie.replace(/domain=[^;]+/gi, "Domain=" + new URL(proxy.origin).hostname).replace(/path=[^;]+/gi, "Path=/"));
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
        .on("meta[http-equiv='refresh']", new MetaRefreshRewriter(proxy, target))
        .on("script[type='application/ld+json']", new TextNodeRewriter(proxy, target))
        .on("a[href], link[href]", new URLRewriter(proxy, target, "href"))
        .on("img[src], iframe[src], script[src], source[src]", new URLRewriter(proxy, target, "src"))
        .on("img[srcset], source[srcset]", new SrcsetRewriter(proxy, target))
        .on("form[action]", new URLRewriter(proxy, target, "action"))
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

class MetaRefreshRewriter {
    constructor(proxy, target) { this.proxy = proxy; this.target = target; }
    element(el) {
        let val = el.getAttribute("content");
        if (!val) return;
        let match = val.match(/^(\d+;\s*url=)(.+)$/i);
        if (match) {
            try { el.setAttribute("content", match[1] + this.proxy.origin + "/" + new URL(match[2].replace(/['"]/g, "").trim(), this.target).href); } catch {}
        }
    }
}

class TextNodeRewriter {
    constructor(proxy, target) { 
        this.proxy = proxy; this.target = target; 
        this.regex = new RegExp(target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        this.replacement = proxy.origin + "/" + target.origin;
    }
    text(chunk) {
        if (chunk.text && chunk.text.includes(this.target.origin)) {
            chunk.replace(chunk.text.replace(this.regex, this.replacement), { html: false });
        }
    }
}

function homepage(url) {
    return new Response(`
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>UPP Proxy Node</title>
<meta name="robots" content="index, follow"></head><body style="font-family:sans-serif;text-align:center;padding:10vh 20px;">
<h2>UPP Proxy Pages Engine</h2><p>Gateway is Active.</p>
<div style="background:#f4f4f4;padding:15px;border-radius:8px;display:inline-block;margin-top:20px;">
Usage: <code>${url.origin}/https://example.com</code></div></body></html>`, 
    { headers: { "content-type": "text/html;charset=utf-8" } });
}

class InjectSandbox {
    constructor(proxy, target) { this.proxy = proxy; this.target = target; }
    element(el) {
        el.prepend(`
<script>
window.__UP_TARGET="${this.target.origin}";
window.UPP_PROXY={purgeCache:()=>navigator.serviceWorker?.controller?new Promise(r=>{let c=new MessageChannel();c.port1.onmessage=e=>r(e.data);navigator.serviceWorker.controller.postMessage({type:"PURGE_CACHE"},[c.port2])}):Promise.resolve("No SW")};

const _fetch=window.fetch;
window.fetch=async(u,opt)=>{try{
    if(typeof u==="string"||u instanceof URL){let ur=new URL(u.toString(),window.__UP_TARGET);if(ur.protocol.startsWith('http'))u=location.origin+"/"+ur.href;}
    else if(u instanceof Request){let ur=new URL(u.url,window.__UP_TARGET);if(ur.protocol.startsWith('http'))u=new Request(location.origin+"/"+ur.href,u);}
}catch(e){}return _fetch(u,opt);};

const _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u,...r){if(typeof u==="string"){try{let p=new URL(u,window.__UP_TARGET);if(p.protocol.startsWith('http'))u=location.origin+"/"+p.href;}catch(e){}}return _open.call(this,m,u,...r);};

const _WS=window.WebSocket;
window.WebSocket=function(u,p){try{
    let pur=new URL(u,window.__UP_TARGET);
    if(pur.protocol==='ws:'||pur.protocol==='wss:'){
        let tgt=(pur.protocol==='wss:'?'https:':'http:')+"//"+pur.host+pur.pathname+pur.search;
        let pxy=(location.protocol==='https:'?'wss:':'ws:')+"//"+location.host+"/"+tgt;
        return p?new _WS(pxy,p):new _WS(pxy);
    }
}catch(e){}return p?new _WS(u,p):new _WS(u);};

if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>0));
</script>`, { html: true });
    }
}
