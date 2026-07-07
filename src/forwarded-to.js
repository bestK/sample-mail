/** Extract original alias address from DuckDuckGo forwarded email HTML. */
export function extractDuckDuckGoAlias(html) {
    const m = String(html || '').match(
        /https:\/\/duckduckgo\.com\/email\/addresses\/([A-Za-z0-9_=+\/\-]+)/
    );
    if (!m) return null;
    try {
        const raw = m[1];
        const padded = raw + '=='.slice(0, (4 - (raw.length % 4)) % 4);
        const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
        const addr = JSON.parse(decoded)?.address;
        if (typeof addr !== 'string' || !addr) return null;
        const lower = addr.toLowerCase();
        return lower.includes('@') ? lower : `${lower}@duck.com`;
    } catch {
        return null;
    }
}

function firstHeader(headers, names) {
    for (const name of names) {
        const lower = String(name).toLowerCase();
        const item = (headers || []).find((h) => String(h?.key || h?.name || '').toLowerCase() === lower);
        if (item?.value) return String(item.value).trim();
    }
    return null;
}

function extractEmail(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const m = text.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
    return m ? m[0].toLowerCase() : null;
}

/** Resolve original forwarded-to address from headers, falling back to HTML body parsing. */
export function resolveForwardedTo(headers, html) {
    // Gmail/Cloudflare forwarding commonly preserves the original recipient in these headers.
    const headerValue = firstHeader(headers, [
        'delivered-to',
        'to',
        'x-original-to',
        'envelope-to',
        'x-envelope-to',
        'original-recipient',
        'resent-to',
        'x-forwarded-to',
    ]);
    const headerEmail = extractEmail(headerValue);
    if (headerEmail) return headerEmail;

    if (html) return extractDuckDuckGoAlias(html);
    return null;
}
