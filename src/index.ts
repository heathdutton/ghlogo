/**
 * GitHub Logo Redirect Worker
 * Redirects to the og:image of a GitHub repository, organization, or user.
 */

interface CacheEntry {
  url: string;
  expires: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const OG_IMAGE_REGEX = /<meta\s+property="og:image"\s+content="([^"]+)"/i;
const ALT_OG_IMAGE_REGEX = /<meta\s+content="([^"]+)"\s+property="og:image"/i;

// In-memory cache persists for worker lifetime
const cache = new Map<string, CacheEntry>();

const getCached = (path: string): string | null => {
  const entry = cache.get(path);
  if (entry && Date.now() < entry.expires) {
    return entry.url;
  }
  if (entry) {
    cache.delete(path);
  }
  return null;
};

const setCache = (path: string, url: string): void => {
  cache.set(path, { url, expires: Date.now() + CACHE_TTL_MS });
};

const extractOgImage = (html: string): string | null => {
  const match = html.match(OG_IMAGE_REGEX) ?? html.match(ALT_OG_IMAGE_REGEX);
  return match?.[1] ?? null;
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

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Root path returns simple info
    if (path === "/" || path === "") {
      return new Response(
        `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ghlogo</title></head>
<body style="font-family:system-ui;max-width:600px;margin:2rem auto;padding:0 1rem">
<h1>ghlogo</h1>
<p>Redirect to GitHub og:image</p>
<p><strong>Usage:</strong> <code>/{owner}</code> or <code>/{owner}/{repo}</code></p>
<p><a href="https://github.com/heathdutton/ghlogo">GitHub</a></p>
</body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // Validate path format: /owner or /owner/repo
    const segments = path.split("/").filter(Boolean);
    if (segments.length < 1 || segments.length > 2) {
      return new Response("Invalid path. Use /{owner} or /{owner}/{repo}", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Check cache first
    const cached = getCached(path);
    if (cached) {
      return Response.redirect(cached, 302);
    }

    // Fetch from GitHub
    const ogImage = await fetchGitHubOgImage(path);
    if (!ogImage) {
      return new Response("Not found or no og:image available", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Cache and redirect
    setCache(path, ogImage);
    return Response.redirect(ogImage, 302);
  },
} satisfies ExportedHandler;
