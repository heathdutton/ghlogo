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

    // Root path returns interactive landing page
    if (path === "/") {
      const baseUrl = url.origin;
      const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ghlogo - GitHub Logo Redirect</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 640px;
    margin: 0 auto;
    padding: 2rem 1rem;
    background: #0d1117;
    color: #e6edf3;
    min-height: 100vh;
  }
  h1 { margin: 0 0 0.5rem; font-size: 2rem; }
  .subtitle { color: #8b949e; margin-bottom: 2rem; }
  .subtitle a { color: #58a6ff; text-decoration: none; }
  .subtitle a:hover { text-decoration: underline; }
  label { display: block; font-weight: 500; margin-bottom: 0.5rem; }
  input[type="text"] {
    width: 100%;
    padding: 0.75rem;
    font-size: 1rem;
    border: 1px solid #30363d;
    border-radius: 6px;
    background: #161b22;
    color: #e6edf3;
    margin-bottom: 1.5rem;
  }
  input[type="text"]:focus {
    outline: none;
    border-color: #58a6ff;
    box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.3);
  }
  .output-group { margin-bottom: 1rem; }
  .output-label {
    font-size: 0.875rem;
    color: #8b949e;
    margin-bottom: 0.25rem;
  }
  .output-row {
    display: flex;
    gap: 0.5rem;
  }
  .output-box {
    flex: 1;
    padding: 0.625rem 0.75rem;
    font-family: ui-monospace, monospace;
    font-size: 0.875rem;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e6edf3;
    overflow-x: auto;
    white-space: nowrap;
  }
  .copy-btn {
    padding: 0.625rem 1rem;
    font-size: 0.875rem;
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e6edf3;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .copy-btn:hover { background: #30363d; }
  .copy-btn.copied { background: #238636; border-color: #238636; }
  .preview-section {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid #30363d;
  }
  .preview-label { font-weight: 500; margin-bottom: 0.75rem; }
  .preview-container {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 1rem;
    min-height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .preview-container img {
    max-width: 100%;
    max-height: 300px;
    border-radius: 6px;
  }
  .preview-placeholder {
    color: #8b949e;
    font-style: italic;
  }
  .preview-error {
    color: #f85149;
  }
</style>
</head>
<body>
<h1>ghlogo</h1>
<p class="subtitle">Redirect to GitHub og:image &middot; <a href="https://github.com/heathdutton/ghlogo">Source</a></p>

<label for="input">Owner or Owner/Repo</label>
<input type="text" id="input" placeholder="microsoft/vscode" autocomplete="off" spellcheck="false">

<div class="output-group">
  <div class="output-label">URL</div>
  <div class="output-row">
    <div class="output-box" id="url-output">${baseUrl}/microsoft/vscode</div>
    <button class="copy-btn" data-target="url-output">Copy</button>
  </div>
</div>

<div class="output-group">
  <div class="output-label">HTML</div>
  <div class="output-row">
    <div class="output-box" id="html-output">&lt;img src="${baseUrl}/microsoft/vscode" alt="microsoft/vscode"&gt;</div>
    <button class="copy-btn" data-target="html-output">Copy</button>
  </div>
</div>

<div class="output-group">
  <div class="output-label">Markdown</div>
  <div class="output-row">
    <div class="output-box" id="md-output">![microsoft/vscode](${baseUrl}/microsoft/vscode)</div>
    <button class="copy-btn" data-target="md-output">Copy</button>
  </div>
</div>

<div class="preview-section">
  <div class="preview-label">Preview</div>
  <div class="preview-container" id="preview">
    <span class="preview-placeholder">Enter an owner or repo to preview</span>
  </div>
</div>

<script>
(function() {
  const baseUrl = '${baseUrl}';
  const input = document.getElementById('input');
  const urlOut = document.getElementById('url-output');
  const htmlOut = document.getElementById('html-output');
  const mdOut = document.getElementById('md-output');
  const preview = document.getElementById('preview');
  let debounceTimer;

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function update() {
    const raw = input.value.trim().replace(/^[\\/@]+/, '').replace(/\\/+$/, '');
    const path = raw || 'microsoft/vscode';
    const fullUrl = baseUrl + '/' + path;

    urlOut.textContent = fullUrl;
    htmlOut.innerHTML = escapeHtml('<img src="' + fullUrl + '" alt="' + path + '">');
    mdOut.textContent = '![' + path + '](' + fullUrl + ')';

    clearTimeout(debounceTimer);
    if (raw) {
      debounceTimer = setTimeout(function() { loadPreview(fullUrl); }, 400);
    } else {
      preview.innerHTML = '<span class="preview-placeholder">Enter an owner or repo to preview</span>';
    }
  }

  function loadPreview(url) {
    preview.innerHTML = '<span class="preview-placeholder">Loading...</span>';
    const img = new Image();
    img.onload = function() { preview.innerHTML = ''; preview.appendChild(img); };
    img.onerror = function() { preview.innerHTML = '<span class="preview-error">Not found or no image available</span>'; };
    img.src = url;
  }

  input.addEventListener('input', update);

  document.querySelectorAll('.copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const target = document.getElementById(btn.dataset.target);
      const text = target.textContent;
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function() {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  });
})();
</script>
</body>
</html>`;
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
