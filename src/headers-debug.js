export function serializeHeaders(headers) {
  return JSON.stringify((headers || []).map((h) => ({ key: h?.key ?? h?.name ?? '', value: h?.value ?? '' })));
}

export function parseStoredHeaders(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
