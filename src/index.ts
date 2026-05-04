import { EmailMessage } from 'cloudflare:email';
import * as PostalMimeMod from './vendor/postal-mime-node.js';
// @ts-ignore — plain JS module
import { normalizeEmailDomains, createInboxAddress } from './email-domain.js';
import {
    resolveEffectiveTimeZone,
    createTimeZoneFormatter,
    formatUtcTimestampForTimeZone,
} from './timezone.js';
import { extractDuckDuckGoAlias, resolveForwardedTo } from './forwarded-to.js';

// Minimal SVG envelope icon for favicon fallback
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="black"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`;

export interface Env {
    DB: D1Database;
    forward_address: string;
    email_domain: string;
    GHPAGE?: string;
    UI_URL?: string;
    DEV?: boolean | string;
    SPONSOR_CURRENCY?: string;
    SPONSOR_RECEIVE_HASH?: string;
}

interface Ctx { }

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        ...init,
        headers: {
            'content-type': 'application/json',
            ...CORS_HEADERS,
            ...(init?.headers ?? {}),
        },
    });
}

function parseLimit(raw: string | null, defaultValue = 10, min = 1, max = 50): number {
    if (!raw) return defaultValue;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.min(max, Math.max(min, n));
}

function firstString(value: unknown): string | undefined {
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value)) {
        for (const v of value) {
            if (typeof v === 'string' && v) return v;
        }
    }
    return undefined;
}

const DEFAULT_UI_URL = 'https://bestk.github.io/sample-mail/';

function getUiUrl(env: Env): string {
    return env.GHPAGE || env.UI_URL || DEFAULT_UI_URL;
}

async function serveUiFromUrl(env: Env): Promise<Response> {
    const uiUrl = getUiUrl(env);

    try {
        const upstream = await fetch(uiUrl);
        const headers = new Headers(upstream.headers);
        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers,
        });
    } catch (error: any) {
        return new Response(
            JSON.stringify({ success: false, error: 'Failed to load UI', details: error?.message ?? String(error) }),
            { status: 502, headers: { 'content-type': 'application/json', ...CORS_HEADERS } }
        );
    }
}

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number): Promise<Uint8Array> {
    const result = new Uint8Array(streamSize);
    let bytesRead = 0;
    const reader = stream.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result.set(value, bytesRead);
        bytesRead += value.length;
    }
    return result;
}

function resolvePostalMimeCtor(mod: any): any {
    const candidates = [
        mod,
        mod?.default,
        mod?.postalMime,
        mod?.default?.postalMime,
        mod?.postalMime?.default,
        mod?.default?.postalMime?.default,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'function') return candidate;
    }

    throw new Error('Failed to resolve PostalMime constructor');
}

const PostalMimeCtor: any = resolvePostalMimeCtor(PostalMimeMod as any);


// --- 简易路由系统 ---
type Handler = (request: Request, env: Env, ctx: Ctx, params: Record<string, string>) => Promise<Response>;
const routes: { method: string; path: string; handler: Handler }[] = [];

function register(method: string, path: string, handler: Handler) {
    routes.push({ method, path, handler });
}

function matchRoute(method: string, url: string): { handler: Handler, params: Record<string, string> } | null {
    for (const route of routes) {
        if (route.method !== method) continue;

        const routeParts = route.path.split('/').filter(Boolean);
        const urlParts = url.split('/').filter(Boolean);

        if (routeParts.length !== urlParts.length) continue;

        const params: Record<string, string> = {};
        let matched = true;

        for (let i = 0; i < routeParts.length; i++) {
            if (routeParts[i].startsWith(':')) {
                params[routeParts[i].substring(1)] = decodeURIComponent(urlParts[i]);
            } else if (routeParts[i] !== urlParts[i]) {
                matched = false;
                break;
            }
        }

        if (matched) return { handler: route.handler, params };
    }
    return null;
}

// --- 路由处理逻辑 ---

// 创建 Email 地址（不再按地址动态创建 Cloudflare Email Routing 规则）
// 前置要求：Cloudflare 邮件路由中需有一条兜底规则把邮件交给本 Worker（例如 *@EMAIL_DOMAIN -> sample-mail）
register('GET', '/email/create', async (request, env, ctx, params) => {
    try {
        const domains = normalizeEmailDomains(env.email_domain);
        const url = new URL(request.url);
        const requestedDomain = url.searchParams.get('domain') || undefined;
        const address = createInboxAddress(domains, { requestedDomain });

        return jsonResponse({
            success: true,
            data: {
                fetch_endpoint: `/email/${address}`,
                address,
                mode: 'catch_all_worker_rule',
            },
        });
    } catch (e: any) {
        return jsonResponse({
            success: false,
            error: e.message || 'Failed to create inbox',
        }, { status: 500 });
    }
});

// email/:address 路由处理
register('GET', '/email/:address', async (request, env, ctx, params) => {
    const { address } = params; // 获取 :address 部分
    const url = new URL(request.url);

    // 获取查询参数 'limit'
    const limit = url.searchParams.get('limit');
    const timeZone = resolveEffectiveTimeZone(
        url.searchParams.get('timezone'),
        request.cf?.timezone ?? null
    );

    const maxResults = parseLimit(limit);
    const formatter = createTimeZoneFormatter(timeZone);

    try {
        const { results, success, meta } = await env.DB
            .prepare('SELECT "id", "subject", "from", "to", "forwarded_to", "html", "text", "createdAt" FROM Email WHERE lower("to") = lower(?) ORDER BY createdAt DESC LIMIT ?')
            .bind(address, maxResults)
            .run();

        if (success) {
            const data = Array.isArray(results)
                ? results.map((item: Record<string, unknown>) => ({
                    ...item,
                    forwarded_to: item.forwarded_to || (typeof item.html === 'string' ? extractDuckDuckGoAlias(item.html) : null),
                    createdAt: formatUtcTimestampForTimeZone(item.createdAt, formatter),
                }))
                : results;

            return jsonResponse({ success: true, data });
        } else {
            console.error("D1 query failed:", meta);
            return jsonResponse({ success: false, error: 'Failed to retrieve emails' }, { status: 500 });
        }
    } catch (e: any) {
        console.error("Error fetching from D1:", e);
        return jsonResponse({ success: false, error: 'Query error', details: e.message }, { status: 500 });
    }
});

register('POST', '/admin/new_address', async (request, env, ctx, params) => {
    try {
        const body: any = await request.json().catch(() => ({}));
        const domains = normalizeEmailDomains(env.email_domain);
        const requestedDomain = body?.domain || undefined;
        const name: string | undefined = body?.name || undefined;

        let randomPart: string | undefined;
        if (name && body?.enablePrefix) {
            randomPart = `${name}_${Math.random().toString(36).substring(2, 10)}`;
        }

        const address = createInboxAddress(domains, { requestedDomain, randomPart });
        return jsonResponse({ address, jwt: address });
    } catch (e: any) {
        return jsonResponse({ error: e.message || 'Failed to create address' }, { status: 500 });
    }
});

register('GET', '/api/mails', async (request, env, ctx, params) => {
    try {
        const url = new URL(request.url);
        const limit = parseLimit(url.searchParams.get('limit'), 10, 1, 50);
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

        const { results, success } = await env.DB
            .prepare('SELECT "id", "subject", "from", "to", "forwarded_to", "html", "text", "createdAt" FROM Email ORDER BY createdAt DESC LIMIT ? OFFSET ?')
            .bind(limit, offset)
            .run();

        const data = (success && Array.isArray(results)) ? results : [];
        return jsonResponse({ results: data });
    } catch (e: any) {
        return jsonResponse({ error: e.message || 'Failed to fetch mails' }, { status: 500 });
    }
});

register('GET', '/sponsor/info', async (request, env, ctx, params) => {
    const currency = (env.SPONSOR_CURRENCY || '').trim();
    const receiveHash = (env.SPONSOR_RECEIVE_HASH || '').trim();

    const channels = (currency && receiveHash)
        ? [{
            name: `${currency} Transfer`,
            currency,
            receive_hash: receiveHash,
        }]
        : [];

    return jsonResponse({
        success: true,
        data: {
            channels,
        },
    });
});




// The static UI fallback
register('GET', '/', async (request, env, ctx, params) => {
    // If assets feature fails or is bypassed, we proxy the configured UI URL
    return serveUiFromUrl(env);
});

// Built-in favicon to avoid 404 errors in production
register('GET', '/favicon.ico', async () => {
    return new Response(FAVICON_SVG, {
        headers: { 
            'content-type': 'image/svg+xml',
            'cache-control': 'public, max-age=86400',
            ...CORS_HEADERS
        }
    });
});

register('GET', '/favicon.png', async () => {
    return new Response(FAVICON_SVG, {
        headers: { 
            'content-type': 'image/svg+xml',
            ...CORS_HEADERS
        }
    });
});


export default {
    async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const match = matchRoute(request.method, url.pathname);
        if (match) {
            return await match.handler(request, env, ctx, match.params);
        }

        return new Response(JSON.stringify({
            error: 'Invalid path. Use /email/create, /email/:address, or /sponsor/info'
        }), { status: 404, headers: { 'content-type': 'application/json', ...CORS_HEADERS } });
    },

    async email(message: EmailMessage, env: Env, ctx: Ctx): Promise<void> {
        try {
            const rawEmail = await streamToArrayBuffer(message.raw, Number(message.rawSize));
            const parser = new PostalMimeCtor();
            const parsedEmail: any = await parser.parse(rawEmail);

            const msgTo = firstString((message as any).to);
            const msgFrom = firstString((message as any).from);
            const envelopeTo = msgTo || parsedEmail.to?.[0]?.address || 'None';
            const envelopeFrom = msgFrom || parsedEmail.from?.address || 'None';

            // D1 does not accept `undefined` bind values
            const html = parsedEmail.html ?? null;
            const text = parsedEmail.text ?? null;

            const headers: Array<{ key: string; value: string }> = parsedEmail.headers || [];
            const forwardedTo = resolveForwardedTo(headers, html);

            await env.DB.prepare(
                `INSERT INTO Email ("subject", "from", "to", "forwarded_to", "html", "text") VALUES (?, ?, ?, ?, ?, ?)`
            )
                .bind(
                    parsedEmail.subject ?? 'None',
                    envelopeFrom,
                    envelopeTo,
                    forwardedTo,
                    html,
                    text
                )
                .run();
        } catch (error) {
            console.error('Insert email error:', (error as any)?.message ?? error);
        } finally {
            const list = (env.forward_address || '')
                .split(';')
                .map((address) => address.trim())
                .filter(Boolean);

            for (const address of list) {
                try {
                    await message.forward(address);
                } catch (error: any) {
                    console.error('Forward email error:', address, error?.message ?? error);
                }
            }
        }
    },
};
