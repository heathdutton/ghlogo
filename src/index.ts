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

const ALLOWED_RATIOS: Record<string, [number, number]> = {
  "3:2": [3, 2],
  "4:3": [4, 3],
};

// --- PNG utilities for aspect-ratio padding ---

const crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (data: Uint8Array, start = 0, end = data.length): number => {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

interface PngChunk {
  type: string;
  data: Uint8Array;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const parsePngChunks = (buf: Uint8Array): PngChunk[] => {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 8; // skip signature
  const chunks: PngChunk[] = [];
  while (offset < buf.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...buf.subarray(offset + 4, offset + 8));
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length; // 4 len + 4 type + data + 4 crc
  }
  return chunks;
};

const buildPng = (chunks: PngChunk[]): Uint8Array => {
  let totalSize = 8; // signature
  for (const c of chunks) totalSize += 12 + c.data.length;
  const out = new Uint8Array(totalSize);
  out.set(PNG_SIGNATURE);
  let offset = 8;
  for (const c of chunks) {
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(offset, c.data.length);
    const typeBytes = new Uint8Array([
      c.type.charCodeAt(0),
      c.type.charCodeAt(1),
      c.type.charCodeAt(2),
      c.type.charCodeAt(3),
    ]);
    out.set(typeBytes, offset + 4);
    out.set(c.data, offset + 8);
    const crcVal = crc32(out, offset + 4, offset + 8 + c.data.length);
    view.setUint32(offset + 8 + c.data.length, crcVal);
    offset += 12 + c.data.length;
  }
  return out;
};

const zlibDecompress = async (data: Uint8Array): Promise<Uint8Array> => {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const reader = ds.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.length;
  }
  return result;
};

const zlibCompress = async (data: Uint8Array): Promise<Uint8Array> => {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const reader = cs.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.length;
  }
  return result;
};

const padPng = async (
  pngBytes: Uint8Array,
  ratioW: number,
  ratioH: number,
): Promise<Uint8Array | null> => {
  // Verify PNG signature
  for (let i = 0; i < 8; i++) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) return null;
  }

  const chunks = parsePngChunks(pngBytes);
  const ihdrChunk = chunks.find((c) => c.type === "IHDR");
  if (!ihdrChunk || ihdrChunk.data.length < 13) return null;

  const ihdr = new DataView(ihdrChunk.data.buffer, ihdrChunk.data.byteOffset, ihdrChunk.data.byteLength);
  const width = ihdr.getUint32(0);
  const height = ihdr.getUint32(4);
  const bitDepth = ihdr.getUint8(8);
  const colorType = ihdr.getUint8(9);
  const interlace = ihdr.getUint8(12);

  // Bail on interlaced or indexed-color PNGs
  if (interlace !== 0 || colorType === 3) return null;
  // Only support 8-bit depth
  if (bitDepth !== 8) return null;

  const targetHeight = Math.ceil((width * ratioH) / ratioW);
  if (height >= targetHeight) return null; // already tall enough

  const paddingRows = targetHeight - height;

  // Bytes per pixel based on color type
  let bpp: number;
  switch (colorType) {
    case 0: bpp = 1; break; // grayscale
    case 2: bpp = 3; break; // RGB
    case 4: bpp = 2; break; // grayscale + alpha
    case 6: bpp = 4; break; // RGBA
    default: return null;
  }

  const rowBytes = 1 + width * bpp; // filter byte + pixel data

  // Concatenate all IDAT data
  const idatParts: Uint8Array[] = [];
  for (const c of chunks) {
    if (c.type === "IDAT") idatParts.push(c.data);
  }
  let idatTotal = 0;
  for (const p of idatParts) idatTotal += p.length;
  const idatConcat = new Uint8Array(idatTotal);
  let off = 0;
  for (const p of idatParts) {
    idatConcat.set(p, off);
    off += p.length;
  }

  const decompressed = await zlibDecompress(idatConcat);

  // White padding row for the top
  const whitePadRow = new Uint8Array(rowBytes);
  whitePadRow[0] = 0; // None filter
  whitePadRow.fill(0xff, 1);

  // Split padding: white on top, stretched last row on bottom
  const topRows = Math.ceil(paddingRows / 2);
  const bottomRows = paddingRows - topRows;

  // Unfilter all rows to recover raw pixel values for the last row.
  // PNG filters encode each byte relative to neighbors, so we must
  // decode sequentially from the top to get correct values.
  const pixelBytes = width * bpp;
  const unfiltered = new Uint8Array(height * pixelBytes);

  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };

  for (let row = 0; row < height; row++) {
    const filterType = decompressed[row * rowBytes];
    const srcOff = row * rowBytes + 1;
    const dstOff = row * pixelBytes;
    const prevOff = (row - 1) * pixelBytes;

    for (let i = 0; i < pixelBytes; i++) {
      const raw = decompressed[srcOff + i];
      const a = i >= bpp ? unfiltered[dstOff + i - bpp] : 0;
      const b = row > 0 ? unfiltered[prevOff + i] : 0;
      const c = row > 0 && i >= bpp ? unfiltered[prevOff + i - bpp] : 0;

      switch (filterType) {
        case 0: unfiltered[dstOff + i] = raw; break;
        case 1: unfiltered[dstOff + i] = (raw + a) & 0xff; break;
        case 2: unfiltered[dstOff + i] = (raw + b) & 0xff; break;
        case 3: unfiltered[dstOff + i] = (raw + ((a + b) >>> 1)) & 0xff; break;
        case 4: unfiltered[dstOff + i] = (raw + paeth(a, b, c)) & 0xff; break;
        default: unfiltered[dstOff + i] = raw; break;
      }
    }
  }

  // Re-encode all rows as filter=None using unfiltered pixel data.
  // We can't mix filtered original data with new rows because filters
  // reference neighboring rows, which would be wrong after insertion.
  const lastRowPixels = unfiltered.subarray((height - 1) * pixelBytes, height * pixelBytes);

  const totalRows = topRows + height + bottomRows;
  const newData = new Uint8Array(totalRows * rowBytes);
  let pos = 0;

  // Top white padding
  for (let r = 0; r < topRows; r++) {
    newData.set(whitePadRow, pos);
    pos += rowBytes;
  }
  // Original image rows (unfiltered)
  for (let r = 0; r < height; r++) {
    newData[pos] = 0; // None filter
    newData.set(unfiltered.subarray(r * pixelBytes, (r + 1) * pixelBytes), pos + 1);
    pos += rowBytes;
  }
  // Bottom: stretch last row
  for (let r = 0; r < bottomRows; r++) {
    newData[pos] = 0; // None filter
    newData.set(lastRowPixels, pos + 1);
    pos += rowBytes;
  }

  const compressed = await zlibCompress(newData);

  // Rebuild chunks: update IHDR height, replace IDAT(s) with single new IDAT
  const newIhdrData = new Uint8Array(ihdrChunk.data);
  const newIhdrView = new DataView(newIhdrData.buffer, newIhdrData.byteOffset, newIhdrData.byteLength);
  newIhdrView.setUint32(4, targetHeight);

  const newChunks: PngChunk[] = [];
  let idatInserted = false;
  for (const c of chunks) {
    if (c.type === "IHDR") {
      newChunks.push({ type: "IHDR", data: newIhdrData });
    } else if (c.type === "IDAT") {
      if (!idatInserted) {
        newChunks.push({ type: "IDAT", data: compressed });
        idatInserted = true;
      }
      // skip subsequent IDAT chunks
    } else {
      newChunks.push(c);
    }
  }

  return buildPng(newChunks);
};

const buildPaddedImageResponse = async (
  ogImageUrl: string,
  ratioW: number,
  ratioH: number,
): Promise<Response> => {
  try {
    const imgResp = await fetch(ogImageUrl);
    if (!imgResp.ok) return buildRedirectResponse(ogImageUrl);

    const contentType = imgResp.headers.get("content-type") ?? "";
    if (!contentType.includes("png")) return buildRedirectResponse(ogImageUrl);

    const buf = new Uint8Array(await imgResp.arrayBuffer());
    const padded = await padPng(buf, ratioW, ratioH);
    if (!padded) return buildRedirectResponse(ogImageUrl);

    return new Response(padded, {
      headers: {
        "Content-Type": "image/png",
        ...cacheHeaders,
      },
    });
  } catch {
    return buildRedirectResponse(ogImageUrl);
  }
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

    // Parse optional ratio param
    const ratioParam = url.searchParams.get("ratio");
    const ratio = ratioParam ? ALLOWED_RATIOS[ratioParam] ?? null : null;

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
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }
  .checkbox-row input[type="checkbox"] {
    width: 1rem;
    height: 1rem;
    accent-color: #58a6ff;
  }
  .checkbox-row label {
    margin: 0;
    font-size: 0.875rem;
    color: #8b949e;
    cursor: pointer;
  }
</style>
</head>
<body>
<h1>ghlogo</h1>
<p class="subtitle">Redirect to GitHub og:image &middot; <a href="https://github.com/heathdutton/ghlogo">Source</a></p>

<label for="input">Owner or Owner/Repo</label>
<input type="text" id="input" value="microsoft/vscode" placeholder="microsoft/vscode" autocomplete="off" spellcheck="false">

<div class="checkbox-row">
  <input type="checkbox" id="ratio-toggle">
  <label for="ratio-toggle">Normalize Aspect Ratio (3:2)</label>
</div>

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
  const ratioToggle = document.getElementById('ratio-toggle');
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
    const qs = ratioToggle.checked ? '?ratio=3:2' : '';
    const fullUrl = baseUrl + '/' + path + qs;

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
  ratioToggle.addEventListener('change', update);
  update();

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
      if (!memoryCached.url) return build404Response();
      if (ratio) return buildPaddedImageResponse(memoryCached.url, ratio[0], ratio[1]);
      return buildRedirectResponse(memoryCached.url);
    }

    // Fetch from GitHub
    const ogImage = await fetchGitHubOgImage(path);

    // Cache the result (including 404s)
    setCache(path, ogImage);

    if (!ogImage) return build404Response();
    if (ratio) return buildPaddedImageResponse(ogImage, ratio[0], ratio[1]);
    return buildRedirectResponse(ogImage);
  },
} satisfies ExportedHandler;
