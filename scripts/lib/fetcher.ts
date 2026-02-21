/**
 * Rate-limited HTTP client for CyLaw (www.cylaw.org).
 *
 * CyLaw pages are typically served in Windows-1253 encoding.
 * This client decodes content correctly and enforces polite request pacing.
 */

const USER_AGENT = 'Ansvar-Law-MCP/1.0 (+https://github.com/Ansvar-Systems/Cypriot-law-mcp)';
const MIN_DELAY_MS = 1200;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enforceRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

function detectCharset(url: string, contentType: string | null, bytes: Uint8Array): string {
  const charsetFromHeader = contentType?.match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase();
  if (charsetFromHeader) return charsetFromHeader;

  const sample = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString('latin1');
  const charsetFromMeta = sample.match(/charset\s*=\s*['\"]?([^'\"\s>]+)/i)?.[1]?.toLowerCase();
  if (charsetFromMeta) return charsetFromMeta;

  if (url.includes('cylaw.org')) {
    return 'windows-1253';
  }

  return 'utf-8';
}

function decodeBody(url: string, contentType: string | null, bytes: Uint8Array): string {
  const charset = detectCharset(url, contentType, bytes);

  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1253').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

export interface FetchResult {
  status: number;
  body: string;
  contentType: string;
  url: string;
}

/**
 * Fetch a URL with rate limiting and retries for transient errors.
 */
export async function fetchWithRateLimit(url: string, maxRetries = 3): Promise<FetchResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await enforceRateLimit();

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
      const backoffMs = Math.min(8000, 1000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const contentType = response.headers.get('content-type') ?? '';
    const body = decodeBody(url, contentType, bytes);

    return {
      status: response.status,
      body,
      contentType,
      url: response.url,
    };
  }

  throw new Error(`Failed to fetch ${url} after ${maxRetries + 1} attempts`);
}
