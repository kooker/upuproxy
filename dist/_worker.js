// dist/_worker.js (Cloudflare Pages Worker - Google & YouTube Ultimate v13)

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

    // 【关键修复 1】：拦截并伪造 CORS OPTIONS 预检请求 (解决 YouTube 留言 API 被浏览器拦截)
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
                "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
                "Access-Control-Max-Age": "86400",
                "Access-Control-Allow-Credentials": "true"
            }
        });
    }

    const headers = new Headers(request.headers);
    headers.set("Host", target.host);
    headers.set("Origin", target.origin);

    const clientReferer = request.headers.get("Referer");
    if (clientReferer) {
        try {
            const parsedClientRef = new URL(clientReferer);
            let refPath = clientReferer.slice(parsedClientRef.origin.length).replace(/^\/+/, "");
            refPath = refPath.replace(/^(https?):\/+/, "$1://");
            if (refPath.startsWith("http")) headers.set("Referer", refPath);
            else headers.set("Referer", target.href);
        } catch { headers.set("Referer", target.href); }
    } else {
        headers.set("Referer", target.href);
    }
    
    ;["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip"].forEach(h => headers.delete(h));

    const fetchOpts = { method: request.method, headers, redirect: "manual" };
    if (!["GET", "HEAD"].includes(request.method) && request.body) {
        fetchOpts.body = request.body;
        fetchOpts.duplex = "half"; 
    }

    const response = await fetch(target, fetchOpts);
    const newHeaders = new Headers(response.headers);
    
    sanitizeHeaders(newHeaders, request);
    rewriteLocation(response, newHeaders, url, target);
    rewriteCookies(newHeaders, url);

    if (request.headers.get("Upgrade") === "websocket") {
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    const fetchDest = request.headers.get("sec-fetch-dest");
    if (["image", "video", "audio", "font", "style", "script"].includes(fetchDest) || target.pathname.includes("avatar.php") || target.pathname.includes("captcha")) {
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    let contentType = newHeaders.get("content-type") || "";
    let contentLength = Number(newHeaders.get("content-length") || 0);

    // 对于 YouTube 和 Google API 返回的 JSON，无需浪费 CPU 进行 HTML 重写，直接放行提升性能
    if (contentType.includes("application/json")) {
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
        return rewriteHTML(response, newHeaders, url, target);
    }
    if ((contentType.includes("xml") || clean.endsWith(".xml") || clean.endsWith("robots.txt")) && contentLength < MAX_REWRITE_SIZE) {
        return rewriteTextResource(response, newHeaders, url, target);
    }
    if (contentType.includes("text/css") && contentLength < MAX_REWRITE_SIZE) {
        return rewriteCSSResponse(response, newHeaders, url, target);
    }

    return new Response(response.body, { status: response.status, headers: newHeaders });
}

function sanitizeHeaders(headers, request) {
    ;["content-security-policy", "content-security-policy-report-only", "x-frame-options", "clear-site-data", "content-encoding", "content-length"].forEach(h => headers.delete(h));
    headers.set("Access-Control-Allow-Origin", request.headers.get("Origin") || "*");
    headers.set("Access-Control-Allow-Credentials", "true"); // 允许跨站凭证（Google 登录必备）
}

function rewriteLocation(response, headers, proxy, target) {
    let loc = response.headers.get("location");
    if (!loc) return;
    try { headers.set("location", proxy.origin + "/" + new URL(loc, target).href); } catch {}
}

// 【关键修复 2】：强制注入 SameSite=None 和 Secure，保证 Google/YouTube Cookie 不被浏览器拦截
function rewriteCookies(headers, proxy) {
    if (typeof headers.getSetCookie === 'function') {
        const cookies = headers.getSetCookie();
        if (cookies.length === 0) return;
        headers.delete("set-cookie");
        for (let cookie of cookies) {
            let newCookie = cookie.replace(/domain=[^;]+/gi, "Domain=" + new URL(proxy.origin).hostname).replace(/path=[^;]+/gi, "Path=/");
            // 解决跨站授权（Google Auth）被 Chrome 屏蔽的问题
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
        .on("meta[http-equiv='refresh']", new MetaRefreshRewriter(proxy, target))
        .on("script[type='application/ld+json']", new TextNodeRewriter(proxy, target))
        .on("a[href], link[href]", new URLRewriter(proxy, target, "href"))
        .on("img[src], iframe[src], script[src], source[src]", new URLRewriter(proxy, target, "src"))
        .on("img[srcset], source[srcset]", new SrcsetRewriter(proxy, target))
        .on("form[action]", new URLRewriter(proxy, target, "action"))
        .on("[data-src], [data-url],[data-href], [data-video],[data-aff], [data-poster]", new DataAttributeRewriter(proxy, target))
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

// 【关键修复 3】：注入脚本强制携带 credentials 凭证给 Fetch API
class InjectSandbox {
    constructor(proxy, target) { this.proxy = proxy; this.target = target; }
    element(el) {
        el.prepend(`
<script>
window.__UP_TARGET="${this.target.origin}";

const _fetch=window.fetch;
window.fetch=async(u,opt)=>{
    try{
        if(typeof u==="string"||u instanceof URL){let ur=new URL(u.toString(),window.__UP_TARGET);if(ur.protocol.startsWith('http'))u=location.origin+"/"+ur.href;}
        else if(u instanceof Request){let ur=new URL(u.url,window.__UP_TARGET);if(ur.protocol.startsWith('http'))u=new Request(location.origin+"/"+ur.href,u);}
    }catch(e){}
    // YouTube / Google 需要强制发送 Cookie 凭据
    if(opt && !opt.credentials) opt.credentials="include";
    else if(!opt) opt={credentials:"include"};
    return _fetch(u,opt);
};

const _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u,...r){
    if(typeof u==="string"){try{let p=new URL(u,window.__UP_TARGET);if(p.protocol.startsWith('http'))u=location.origin+"/"+p.href;}catch(e){}}
    return _open.call(this,m,u,...r);
};
// XHR 强制发送凭证
const _send=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send=function(b){
    this.withCredentials=true;
    return _send.call(this,b);
};

const _openWin=window.open;
window.open=function(u,t,f){if(typeof u==="string"){try{let p=new URL(u,window.__UP_TARGET);if(p.protocol.startsWith('http'))u=location.origin+"/"+p.href;}catch(e){}}return _openWin.call(window,u,t,f);};

if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>0));
</script>`, { html: true });
    }
}
