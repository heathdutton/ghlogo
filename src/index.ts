/**
 * GitHub Logo Redirect Worker
 * Redirects to the og:image of a GitHub repository, organization, or user.
 */

interface CacheEntry {
  url: string | null; // null = cached 404
  expires: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_404_TTL_MS = 5 * 60 * 1000; // 5 minutes for 404s
const CACHE_TTL_SECONDS = 3600;
const OG_IMAGE_REGEX = /<meta\s+property="og:image"\s+content="([^"]+)"/i;
const ALT_OG_IMAGE_REGEX = /<meta\s+content="([^"]+)"\s+property="og:image"/i;

// In-memory cache persists for worker isolate lifetime
const memoryCache = new Map<string, CacheEntry>();

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&#x2F;": "/",
};

const decodeHtmlEntities = (str: string): string =>
  str.replace(/&(?:amp|lt|gt|quot|#39|#x27|#x2F);/g, (m) => HTML_ENTITIES[m] ?? m);

const normalizePath = (path: string): string => {
  // Remove trailing slashes, normalize to lowercase
  return path.replace(/\/+$/, "").toLowerCase() || "/";
};

const getCached = (path: string): CacheEntry | null => {
  const entry = memoryCache.get(path);
  if (entry && Date.now() < entry.expires) {
    return entry;
  }
  if (entry) {
    memoryCache.delete(path);
  }
  return null;
};

const setCache = (path: string, url: string | null): void => {
  const ttl = url ? CACHE_TTL_MS : CACHE_404_TTL_MS;
  memoryCache.set(path, { url, expires: Date.now() + ttl });
};

const extractOgImage = (html: string): string | null => {
  const match = html.match(OG_IMAGE_REGEX) ?? html.match(ALT_OG_IMAGE_REGEX);
  return match?.[1] ? decodeHtmlEntities(match[1]) : null;
};

const fetchGitHubOgImage = async (path: string): Promise<string | null> => {
  const response = await fetch(`https://github.com${path}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ghlogo/1.0)",
      Accept: "text/html",
    },
  });

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  return extractOgImage(html);
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
};

const cacheHeaders = {
  "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
  ...corsHeaders,
};

const noCacheHeaders = {
  "Cache-Control": "public, max-age=300", // 5 min for errors
  ...corsHeaders,
};

const buildRedirectResponse = (url: string, status: 301 | 302 = 302): Response => {
  return new Response(null, {
    status,
    headers: {
      Location: url,
      ...cacheHeaders,
    },
  });
};

const build404Response = (): Response => {
  return new Response("Not found or no og:image available", {
    status: 404,
    headers: { "Content-Type": "text/plain", ...noCacheHeaders },
  });
};

export default {
  async fetch(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only allow GET and HEAD
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { "Content-Type": "text/plain", ...corsHeaders },
      });
    }

    const url = new URL(request.url);
    const rawPath = url.pathname;
    const path = normalizePath(rawPath);

    // Root path returns simple info
    if (path === "/") {
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ghlogo</title></head>
<body style="font-family:system-ui;max-width:600px;margin:2rem auto;padding:0 1rem">
<h1>ghlogo</h1>
<p>Redirect to GitHub og:image</p>
<p><strong>Usage:</strong> <code>/{owner}</code> or <code>/{owner}/{repo}</code></p>
<p><a href="https://github.com/heathdutton/ghlogo">GitHub</a></p>
</body></html>`;
      const response = new Response(method === "HEAD" ? null : html, {
        headers: { "Content-Type": "text/html", ...cacheHeaders },
      });
      return response;
    }

    // Validate path format: /owner or /owner/repo
    const segments = path.split("/").filter(Boolean);
    if (segments.length < 1 || segments.length > 2) {
      return new Response("Invalid path. Use /{owner} or /{owner}/{repo}", {
        status: 400,
        headers: { "Content-Type": "text/plain", ...noCacheHeaders },
      });
    }

    // Check in-memory cache
    const memoryCached = getCached(path);
    if (memoryCached) {
      return memoryCached.url
        ? buildRedirectResponse(memoryCached.url)
        : build404Response();
    }

    // Fetch from GitHub
    const ogImage = await fetchGitHubOgImage(path);

    // Cache the result (including 404s)
    setCache(path, ogImage);

    return ogImage ? buildRedirectResponse(ogImage) : build404Response();
  },
} satisfies ExportedHandler;
