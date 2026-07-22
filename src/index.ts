import { EmailMessage } from 'cloudflare:email';
import * as PostalMimeMod from './vendor/postal-mime-node.js';
// @ts-ignore — plain JS module
import { normalizeEmailDomains, createInboxAddress, pickEmailDomain } from './email-domain.js';
import {
    resolveEffectiveTimeZone,
    createTimeZoneFormatter,
    formatUtcTimestampForTimeZone,
} from './timezone.js';
import { extractDuckDuckGoAlias, resolveForwardedTo } from './forwarded-to.js';
// @ts-ignore — plain JS module
import { serializeHeaders, parseStoredHeaders } from './headers-debug.js';
// @ts-ignore — plain JS module
import {
    createAccessToken,
    createAddressToken,
    getAccessTokenPrefix,
    hashAccessToken,
    verifyAddressToken,
} from './access-token.js';

// Minimal SVG envelope icon for favicon fallback
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="black"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`;

export interface Env {
    DB: D1Database;
    forward_address: string;
    email_domain: string;
    GHPAGE?: string;
    UI_URL?: string;
    DEV?: boolean | string;
    JWT_SECRET?: string;
    SPONSOR_CURRENCY?: string;
    SPONSOR_RECEIVE_HASH?: string;
    PASSWORD?: string;
}

interface Ctx { }

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-admin-password,x-admin-auth,x-custom-auth',
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

let emailSchemaReady = false;
let accessTokenSchemaReady = false;
let addressSchemaReady = false;

const ADMIN_PASSWORD_HEADER = 'x-admin-password';
const COMPAT_ADMIN_PASSWORD_HEADER = 'x-admin-auth';

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text();
    if (!text.trim()) return {};

    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Request body must be a JSON object');
    }

    return body as Record<string, unknown>;
}

function constantTimeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder();
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    let diff = left.length ^ right.length;
    const length = Math.max(left.length, right.length);

    for (let i = 0; i < length; i++) {
        diff |= (left[i] || 0) ^ (right[i] || 0);
    }

    return diff === 0;
}

function getConfiguredPassword(env: Env): string | null {
    const password = (env.PASSWORD || '').trim();
    return password || null;
}

function getAddressTokenSecret(env: Env): string {
    return (env.JWT_SECRET || env.PASSWORD || '').trim();
}

function readAdminPassword(request: Request, body?: Record<string, unknown>): string {
    const fromHeader =
        request.headers.get(ADMIN_PASSWORD_HEADER)
        || request.headers.get(COMPAT_ADMIN_PASSWORD_HEADER);
    if (fromHeader) return fromHeader;

    const fromBody = body?.password;
    return typeof fromBody === 'string' ? fromBody : '';
}

function sanitizeTokenName(value: unknown): string {
    const name = typeof value === 'string' ? value.trim() : '';
    return (name || 'Access token').slice(0, 80);
}

function parsePositiveId(raw: string | undefined): number | null {
    const id = Number.parseInt(raw || '', 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sanitizeAddressName(value: unknown): string {
    return String(typeof value === 'string' ? value : '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._+-]/g, '')
        .slice(0, 64);
}

function createCompatRandomPart(body: Record<string, unknown>): string | undefined {
    const name = sanitizeAddressName(body.name);
    if (!name) return undefined;

    if (body.enablePrefix) {
        return `${name}_${Math.random().toString(36).substring(2, 10)}`;
    }

    return name;
}

function normalizeCompatAddress(value: unknown): string | null {
    const address = String(typeof value === 'string' ? value : '')
        .trim()
        .toLowerCase();

    if (!address || address.length > 320) return null;
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) return null;

    return address;
}

function validateConfiguredAddress(address: unknown, env: Env): string | null {
    const normalized = normalizeCompatAddress(address);
    if (!normalized) return null;

    const domain = normalized.split('@').pop();
    if (!domain) return null;

    try {
        pickEmailDomain(normalizeEmailDomains(env.email_domain), domain);
        return normalized;
    } catch {
        return null;
    }
}

async function requireAdminPassword(
    request: Request,
    env: Env,
    body?: Record<string, unknown>
): Promise<Response | null> {
    const configured = getConfiguredPassword(env);
    if (!configured) {
        return jsonResponse({
            success: false,
            error: 'PASSWORD is not configured',
        }, { status: 500 });
    }

    const supplied = readAdminPassword(request, body);
    if (!supplied || !constantTimeEqual(supplied, configured)) {
        return jsonResponse({
            success: false,
            error: 'Invalid password',
        }, { status: 401 });
    }

    return null;
}

function readBearerToken(request: Request): string {
    const auth = request.headers.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function addColumnIfMissing(env: Env, sql: string): Promise<void> {
    try {
        await env.DB.prepare(sql).run();
    } catch (error: any) {
        const message = String(error?.message ?? error ?? '').toLowerCase();
        if (!message.includes('duplicate column') && !message.includes('already exists')) {
            throw error;
        }
    }
}

async function ensureEmailSchema(env: Env): Promise<void> {
    if (emailSchemaReady) return;
    await addColumnIfMissing(env, 'ALTER TABLE Email ADD COLUMN forwarded_to VARCHAR(255)');
    await addColumnIfMissing(env, 'ALTER TABLE Email ADD COLUMN headers TEXT');
    emailSchemaReady = true;
}

async function ensureAccessTokenSchema(env: Env): Promise<void> {
    if (accessTokenSchemaReady) return;

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS AccessToken (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name VARCHAR(80) NOT NULL,
            token_hash VARCHAR(64) NOT NULL UNIQUE,
            token_prefix VARCHAR(16) NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            lastUsedAt DATETIME,
            revokedAt DATETIME
        )
    `).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_access_token_hash ON AccessToken(token_hash)').run();
    accessTokenSchemaReady = true;
}

async function ensureAddressSchema(env: Env): Promise<void> {
    if (addressSchemaReady) return;

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS Address (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name VARCHAR(255) NOT NULL UNIQUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_address_name ON Address(name)').run();
    addressSchemaReady = true;
}

async function rememberAddress(env: Env, address: string): Promise<number> {
    await ensureAddressSchema(env);
    await env.DB
        .prepare('INSERT OR IGNORE INTO Address (name) VALUES (?)')
        .bind(address)
        .run();

    const result = await env.DB
        .prepare('SELECT id FROM Address WHERE lower(name) = lower(?)')
        .bind(address)
        .run();
    const row = Array.isArray(result.results) ? result.results[0] as Record<string, unknown> | undefined : undefined;
    const id = typeof row?.id === 'number' ? row.id : Number.parseInt(String(row?.id || ''), 10);

    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

async function findActiveAccessToken(env: Env, token: string): Promise<Record<string, unknown> | null> {
    if (!token) {
        return null;
    }

    await ensureAccessTokenSchema(env);
    const tokenHash = await hashAccessToken(token);
    const result = await env.DB
        .prepare('SELECT id, revokedAt FROM AccessToken WHERE token_hash = ?')
        .bind(tokenHash)
        .run();
    const row = Array.isArray(result.results) ? result.results[0] as Record<string, unknown> | undefined : undefined;

    return row && !row.revokedAt ? row : null;
}

async function touchAccessToken(env: Env, id: unknown): Promise<void> {
    await env.DB
        .prepare('UPDATE AccessToken SET lastUsedAt = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(id)
        .run();
}

async function requireAccessToken(request: Request, env: Env): Promise<Response | null> {
    const token = readBearerToken(request);
    if (!token) {
        return jsonResponse({
            success: false,
            error: 'Access token required',
        }, { status: 401 });
    }

    const row = await findActiveAccessToken(env, token);
    if (!row) {
        return jsonResponse({
            success: false,
            error: 'Invalid access token',
        }, { status: 401 });
    }

    await touchAccessToken(env, row.id);

    return null;
}

async function resolveAddressToken(token: string, env: Env): Promise<string | null> {
    const payload = await verifyAddressToken(token, getAddressTokenSecret(env));
    if (!payload) return null;

    return validateConfiguredAddress((payload as Record<string, unknown>).address, env);
}

async function requireMailApiAuth(
    request: Request,
    env: Env
): Promise<Response | { address: string | null }> {
    const token = readBearerToken(request);
    if (!token) {
        return jsonResponse({
            success: false,
            error: 'Access token required',
        }, { status: 401 });
    }

    const row = await findActiveAccessToken(env, token);
    if (row) {
        await touchAccessToken(env, row.id);
        return { address: null };
    }

    const address = await resolveAddressToken(token, env);
    if (address) {
        return { address };
    }

    return jsonResponse({
        success: false,
        error: 'Invalid access token',
    }, { status: 401 });
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

function toCompatMailRow(item: Record<string, unknown>): Record<string, unknown> {
    const forwardedTo = item.forwarded_to
        || (typeof item.html === 'string' ? extractDuckDuckGoAlias(item.html) : null);
    const recipient = forwardedTo || item.to || null;

    // 构建 raw 字段（用于 OTP 提取）
    const html = item.html || '';
    const text = item.text || '';
    const raw = html || text || '';

    return {
        id: item.id,
        address: recipient,
        recipient,
        subject: item.subject || '',
        from: item.from || '',
        sender: item.from || '',
        to: item.to || '',
        forwarded_to: forwardedTo,
        headers: parseStoredHeaders(item.headers),
        html: html,
        text: text,
        raw: raw,
        createdAt: item.createdAt,
        created_at: item.createdAt,
    };
}

async function listCompatMails(
    env: Env,
    options: { address?: string | null; limit: number; offset: number }
): Promise<{ rows: Record<string, unknown>[]; count: number; success: boolean; meta?: unknown }> {
    await ensureEmailSchema(env);

    const requestedAddress = typeof options.address === 'string' && options.address.trim()
        ? options.address
        : null;
    const filterAddress = requestedAddress ? validateConfiguredAddress(requestedAddress, env) : null;
    if (requestedAddress && !filterAddress) {
        return { rows: [], count: 0, success: true };
    }
    const whereSql = filterAddress
        ? 'WHERE lower("to") = lower(?) OR lower("forwarded_to") = lower(?)'
        : '';
    const filterParams = filterAddress ? [filterAddress, filterAddress] : [];

    const countResult = await env.DB
        .prepare(`SELECT count(*) AS count FROM Email ${whereSql}`)
        .bind(...filterParams)
        .run();
    const countRow = Array.isArray(countResult.results)
        ? countResult.results[0] as Record<string, unknown> | undefined
        : undefined;
    const count = Number.parseInt(String(countRow?.count ?? 0), 10) || 0;

    const result = await env.DB
        .prepare(`
            SELECT "id", "subject", "from", "to", "forwarded_to", headers, "html", "text", "createdAt"
            FROM Email
            ${whereSql}
            ORDER BY createdAt DESC
            LIMIT ? OFFSET ?
        `)
        .bind(...filterParams, options.limit, options.offset)
        .run();

    return {
        rows: Array.isArray(result.results)
            ? result.results.map((item: Record<string, unknown>) => toCompatMailRow(item))
            : [],
        count,
        success: result.success,
        meta: result.meta,
    };
}


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

register('POST', '/admin/login', async (request, env, ctx, params) => {
    let body: Record<string, unknown>;
    try {
        body = await readJsonObject(request);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message || 'Invalid JSON body' }, { status: 400 });
    }

    const authError = await requireAdminPassword(request, env, body);
    if (authError) return authError;

    return jsonResponse({ success: true });
});

register('GET', '/admin/tokens', async (request, env, ctx, params) => {
    const authError = await requireAdminPassword(request, env);
    if (authError) return authError;

    await ensureAccessTokenSchema(env);
    const { results, success, meta } = await env.DB
        .prepare(`
            SELECT id, name, token_prefix AS prefix, createdAt, lastUsedAt, revokedAt
            FROM AccessToken
            ORDER BY createdAt DESC, id DESC
            LIMIT 100
        `)
        .run();

    if (!success) {
        console.error('D1 token list failed:', meta);
        return jsonResponse({ success: false, error: 'Failed to list access tokens' }, { status: 500 });
    }

    return jsonResponse({ success: true, data: Array.isArray(results) ? results : [] });
});

register('POST', '/admin/tokens', async (request, env, ctx, params) => {
    let body: Record<string, unknown>;
    try {
        body = await readJsonObject(request);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message || 'Invalid JSON body' }, { status: 400 });
    }

    const authError = await requireAdminPassword(request, env, body);
    if (authError) return authError;

    await ensureAccessTokenSchema(env);
    const name = sanitizeTokenName(body.name);
    const token = createAccessToken();
    const tokenHash = await hashAccessToken(token);
    const tokenPrefix = getAccessTokenPrefix(token);

    const result = await env.DB
        .prepare('INSERT INTO AccessToken (name, token_hash, token_prefix) VALUES (?, ?, ?)')
        .bind(name, tokenHash, tokenPrefix)
        .run();

    return jsonResponse({
        success: true,
        data: {
            id: result.meta?.last_row_id ?? null,
            name,
            token,
            prefix: tokenPrefix,
        },
    }, { status: 201 });
});

register('DELETE', '/admin/tokens/:id', async (request, env, ctx, params) => {
    const authError = await requireAdminPassword(request, env);
    if (authError) return authError;

    const id = parsePositiveId(params.id);
    if (!id) {
        return jsonResponse({ success: false, error: 'Invalid access token id' }, { status: 400 });
    }

    await ensureAccessTokenSchema(env);
    await env.DB
        .prepare('UPDATE AccessToken SET revokedAt = CURRENT_TIMESTAMP WHERE id = ? AND revokedAt IS NULL')
        .bind(id)
        .run();

    return jsonResponse({ success: true });
});

register('GET', '/admin/mails', async (request, env, ctx, params) => {
    const authError = await requireAdminPassword(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get('limit'), 20, 1, 100);
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const address = url.searchParams.get('address');

    const { rows, count, success, meta } = await listCompatMails(env, { address, limit, offset });
    if (!success) {
        console.error('D1 admin mail list failed:', meta);
        return jsonResponse({ success: false, error: 'Failed to list mails' }, { status: 500 });
    }

    return jsonResponse({ results: rows, count });
});

register('POST', '/admin/mails', async (request, env, ctx, params) => {
    let body: Record<string, unknown>;
    try {
        body = await readJsonObject(request);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message || 'Invalid JSON body' }, { status: 400 });
    }

    const authError = await requireAdminPassword(request, env, body);
    if (authError) return authError;

    const limit = parseLimit(String(body.limit || ''), 20, 1, 100);
    const offset = Math.max(0, Number.parseInt(String(body.offset || '0'), 10) || 0);
    const address = typeof body.address === 'string' ? body.address : null;

    const { rows, count, success, meta } = await listCompatMails(env, { address, limit, offset });
    if (!success) {
        console.error('D1 admin mail list failed:', meta);
        return jsonResponse({ success: false, error: 'Failed to list mails' }, { status: 500 });
    }

    return jsonResponse({ results: rows, count });
});

register('GET', '/admin/mails/:id', async (request, env, ctx, params) => {
    const authError = await requireAdminPassword(request, env);
    if (authError) return authError;

    const id = parsePositiveId(params.id);
    if (!id) {
        return jsonResponse({ success: false, error: 'Invalid mail id' }, { status: 400 });
    }

    await ensureEmailSchema(env);
    const result = await env.DB
        .prepare('SELECT "id", "subject", "from", "to", "forwarded_to", headers, "html", "text", "createdAt" FROM Email WHERE id = ?')
        .bind(id)
        .run();
    const row = Array.isArray(result.results) ? result.results[0] as Record<string, unknown> | undefined : undefined;

    return jsonResponse(row ? toCompatMailRow(row) : null);
});

register('DELETE', '/admin/mails/:id', async (request, env, ctx, params) => {
    const authError = await requireAdminPassword(request, env);
    if (authError) return authError;

    const id = parsePositiveId(params.id);
    if (!id) {
        return jsonResponse({ success: false, error: 'Invalid mail id' }, { status: 400 });
    }

    const result = await env.DB
        .prepare('DELETE FROM Email WHERE id = ?')
        .bind(id)
        .run();

    return jsonResponse({ success: result.success });
});

// 创建 Email 地址（不再按地址动态创建 Cloudflare Email Routing 规则）
// 前置要求：Cloudflare 邮件路由中需有一条兜底规则把邮件交给本 Worker（例如 *@EMAIL_DOMAIN -> sample-mail）
register('GET', '/email/create', async (request, env, ctx, params) => {
    try {
        const authError = await requireAccessToken(request, env);
        if (authError) return authError;

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
        const authError = await requireAccessToken(request, env);
        if (authError) return authError;

        await ensureEmailSchema(env);
        const { results, success, meta } = await env.DB
            .prepare('SELECT "id", "subject", "from", "to", "forwarded_to", headers, "html", "text", "createdAt" FROM Email WHERE lower("to") = lower(?) OR lower("forwarded_to") = lower(?) ORDER BY createdAt DESC LIMIT ?')
            .bind(address, address, maxResults)
            .run();

        if (success) {
            const data = Array.isArray(results)
                ? results.map((item: Record<string, unknown>) => ({
                    ...item,
                    forwarded_to: item.forwarded_to || (typeof item.html === 'string' ? extractDuckDuckGoAlias(item.html) : null),
                    headers: parseStoredHeaders(item.headers),
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
    let body: Record<string, unknown>;
    try {
        body = await readJsonObject(request);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message || 'Invalid JSON body' }, { status: 400 });
    }

    try {
        const authError = await requireAdminPassword(request, env, body);
        if (authError) return authError;

        const domains = normalizeEmailDomains(env.email_domain);
        const requestedDomain = typeof body.domain === 'string' ? body.domain : undefined;
        const randomPart = createCompatRandomPart(body);
        const address = createInboxAddress(domains, { requestedDomain, randomPart });
        const addressId = await rememberAddress(env, address);
        const jwt = await createAddressToken(address, addressId, getAddressTokenSecret(env));

        return jsonResponse({ address, jwt, address_id: addressId });
    } catch (e: any) {
        return jsonResponse({ error: e.message || 'Failed to create address' }, { status: 500 });
    }
});

register('POST', '/api/new_address', async (request, env, ctx, params) => {
    let body: Record<string, unknown>;
    try {
        body = await readJsonObject(request);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message || 'Invalid JSON body' }, { status: 400 });
    }

    try {
        const authError = await requireAccessToken(request, env);
        if (authError) return authError;

        const domains = normalizeEmailDomains(env.email_domain);
        const requestedDomain = typeof body.domain === 'string' ? body.domain : undefined;
        const randomPart = createCompatRandomPart(body);
        const address = createInboxAddress(domains, { requestedDomain, randomPart });
        const addressId = await rememberAddress(env, address);
        const jwt = await createAddressToken(address, addressId, getAddressTokenSecret(env));

        return jsonResponse({ address, jwt, address_id: addressId });
    } catch (e: any) {
        return jsonResponse({ error: e.message || 'Failed to create address' }, { status: 500 });
    }
});

register('GET', '/api/mails', async (request, env, ctx, params) => {
    try {
        const auth = await requireMailApiAuth(request, env);
        if (auth instanceof Response) return auth;

        const url = new URL(request.url);
        const limit = parseLimit(url.searchParams.get('limit'), 10, 1, 100);
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const { rows, count, success, meta } = await listCompatMails(env, {
            address: auth.address,
            limit,
            offset,
        });

        if (!success) {
            console.error('D1 compat mail list failed:', meta);
            return jsonResponse({ error: 'Failed to fetch mails' }, { status: 500 });
        }

        return jsonResponse({ results: rows, count });
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
            ...CORS_HEADERS,
        },
    });
});

register('GET', '/favicon.png', async () => {
    return new Response(FAVICON_SVG, {
        headers: {
            'content-type': 'image/svg+xml',
            ...CORS_HEADERS,
        },
    });
});

register('GET', '/ui', async (request, env, ctx, params) => {
    return serveUiFromUrl(env);
});

register('GET', '/admin', async (request, env, ctx, params) => {
    return serveUiFromUrl(env);
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
            error: 'Invalid path. Use /email/create, /email/:address, /admin/tokens, or /sponsor/info'
        }), { status: 404, headers: { 'content-type': 'application/json', ...CORS_HEADERS } });
    },

    async email(message: EmailMessage, env: Env, ctx: Ctx): Promise<void> {
        try {
            await ensureEmailSchema(env);
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
            const headersJson = serializeHeaders(headers);

            await env.DB.prepare(
                `INSERT INTO Email ("subject", "from", "to", "forwarded_to", "headers", "html", "text") VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
                .bind(
                    parsedEmail.subject ?? 'None',
                    envelopeFrom,
                    envelopeTo,
                    forwardedTo,
                    headersJson,
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
