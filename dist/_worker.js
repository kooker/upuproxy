// dist/_worker.js (Industrial Ultimate v19 - Fix: Typecho & Discuz)

const MAX_REWRITE_SIZE = 10 * 1024 * 1024; // 适度缩小以提升性能

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
    if (!clean.startsWith("http")) {
        if (clean.match(/^([a-zA-Z0-9.-]+)(:\d+)?(\/.*)?$/)) clean = "https://" + clean;
        else return new Response("Invalid Target URL", { status: 400 });
    }

    const target = new URL(clean);

    // 【1. 协议层安全伪装】移除所有可能导致 CMS 安全拦截的 Sec- 头部
    const headers = new Headers(request.headers);
    headers.set("Host", target.host);
    
    // 强制模拟同源请求，解决 Typecho 登出及 Discuz 验证码校验
    const clientReferer = request.headers.get("Referer");
    if (clientReferer) {
        try {
            const refUrl = new URL(clientReferer);
            if (refUrl.origin === url.origin) {
                // 如果是从代理页面跳过来的，提取原始目标作为 Referer
                let refPath = refUrl.pathname.slice(1).replace(/^(https?):\/+/, "$1://");
                headers.set("Referer", refPath || target.origin);
            }
        } catch { headers.set("Referer", target.origin); }
    } else {
        headers.set("Referer", target.origin);
    }

    // 抹除代理痕迹：Discuz 极其看重这些
    ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip", "x-ca-fingerprint", 
     "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user"].forEach(h => headers.delete(h));
    
    // 注入 AJAX 标识（Discuz 验证码必看）
    if (!headers.has("X-Requested-With")) headers.set("X-Requested-With", "XMLHttpRequest");

    const fetchOpts = { method: request.method, headers, redirect: "manual" };
    if (!["GET", "HEAD"].includes(request.method) && request.body) {
        fetchOpts.body = request.body; fetchOpts.duplex = "half"; 
    }

    const response = await fetch(target, fetchOpts);
    const newHeaders = new Headers(response.headers);
    
    // 【2. 响应头净化】
    let contentType = newHeaders.get("content-type") || "";
    const isRewritable = (contentType.includes("text/") || contentType.includes("javascript") || contentType.includes("xml"));
    
    sanitizeHeaders(newHeaders, request);
    rewriteLocation(response, newHeaders, url, target);
    rewriteCookies(newHeaders, url, target);

    if (request.headers.get("Upgrade") === "websocket") return new Response(response.body, { status: response.status, headers: newHeaders });

    // 流媒体优化
    if (target.pathname.includes("videoplayback") || clean.includes("m3u8")) {
        newHeaders.set('Cache-Control', 'no-store');
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    if (!isRewritable || response.status === 204) return new Response(response.body, { status: response.status, headers: newHeaders });

    // 【3. 内容重写】
    if (contentType.includes("text/html")) return rewriteHTML(response, newHeaders, url, target);
    
    let text = await response.text();
    // 简单全局替换：针对 JS/CSS 中的绝对路径
    const targetOriginExp = new RegExp(target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    text = text.replace(targetOriginExp, url.origin + "/" + target.origin);
    
    return new Response(text, { status: response.status, headers: newHeaders });
}

function sanitizeHeaders(headers, request) {
    ["content-security-policy", "x-frame-options", "content-length", "content-encoding"].forEach(h => headers.delete(h));
    let origin = request.headers.get("Origin");
    headers.set("Access-Control-Allow-Origin", origin || "*");
    headers.set("Access-Control-Allow-Credentials", "true");
}

function rewriteLocation(res, headers, proxy, target) {
    let loc = res.headers.get("location");
    if (!loc) return;
    try {
        let absoluteLoc = new URL(loc, target).href;
        headers.set("location", proxy.origin + "/" + absoluteLoc);
    } catch {}
}

function rewriteCookies(headers, proxy, target) {
    const cookies = headers.getSetCookie();
    if (cookies.length === 0) return;
    headers.delete("set-cookie");
    cookies.forEach(cookie => {
        // 核心修复：抹掉 Domain，强制 Path 为根，确保代理端能正确存取
        let nc = cookie.replace(/Domain=[^;]+/gi, `Domain=${proxy.hostname}`)
                       .replace(/Path=[^;]+/gi, "Path=/")
                       .replace(/SameSite=[^;]+/gi, "SameSite=None");
        if (!/Secure/i.test(nc)) nc += "; Secure";
        headers.append("set-cookie", nc);
    });
}

function rewriteHTML(res, headers, proxy, target) {
    return new HTMLRewriter()
        .on("head", new InjectSandbox(proxy, target))
        .on("a, link, form, script, img, iframe, source", {
            element(el) {
                ["href", "src", "action", "data-src", "srcset"].forEach(attr => {
                    let val = el.getAttribute(attr);
                    if (val && !val.startsWith("data:") && !val.startsWith("#") && !val.startsWith("javascript:")) {
                        try { el.setAttribute(attr, proxy.origin + "/" + new URL(val, target).href); } catch {}
                    }
                });
                el.removeAttribute("integrity");
            }
        })
        .transform(new Response(res.body, { status: res.status, headers }));
}

class InjectSandbox {
    constructor(proxy, target) { this.proxy = proxy; this.target = target; }
    element(el) {
        el.prepend(`<script>
        (function() {
            window.__UP_TARGET = "${this.target.origin}";
            const proxy = "${this.proxy.origin}";
            const _fetch = window.fetch;
            window.fetch = async (u, opt = {}) => {
                if (typeof u === 'string' && !u.startsWith('http') && !u.startsWith('/')) u = new URL(u, window.location.href).href;
                if (typeof u === 'string' && !u.startsWith(proxy)) u = proxy + "/" + new URL(u, window.__UP_TARGET).href;
                opt.credentials = "include";
                return _fetch(u, opt);
            };
            const _open = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(m, u, ...r) {
                if (typeof u === 'string' && !u.startsWith(proxy)) u = proxy + "/" + new URL(u, window.__UP_TARGET).href;
                this.withCredentials = true;
                return _open.call(this, m, u, ...r);
            };
            // 解决 Discuz 验证码弹窗的 Domain 限制
            try { Object.defineProperty(document, 'domain', { get() { return new URL(window.__UP_TARGET).hostname; } }); } catch(e) {}
        })();</script>`, { html: true });
    }
}

function homepage(url) {
    return new Response('<html><head><title>UPP Node</title></head><body style="font-family:sans-serif;text-align:center;margin-top:20%;"><h2>UPP Industrial Proxy</h2><input type="text" placeholder="https://..." id="u" style="width:300px;padding:10px;"><button onclick="location.href=\'/\'+document.getElementById(\'u\').value" style="padding:10px;">Go</button></body></html>', { headers: { "content-type": "text/html;charset=utf-8" } });
}
