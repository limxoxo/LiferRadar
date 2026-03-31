/**
 * Cloudflare Worker — eBird API CORS Proxy
 *
 * Forwards requests to the eBird API and adds CORS headers so the
 * browser can call it directly. The user's API key is passed through
 * as-is (never stored).
 *
 * Deploy: npx wrangler deploy
 * Or paste into Cloudflare Dashboard → Workers & Pages → Create Worker
 */

const EBIRD_BASE = "https://api.ebird.org/v2";

// Allowed eBird API paths (whitelist to prevent abuse)
const ALLOWED_PATHS = [
  "/ref/hotspot/geo",
  "/ref/taxonomy/ebird",
  "/data/obs/geo/recent",
  "/data/obs/geo/recent/notable",
];

function isAllowedPath(path) {
  // Allow exact matches and paths that start with allowed prefixes
  // (e.g., /data/obs/L12345/recent)
  return ALLOWED_PATHS.some(p => path === p || path.startsWith(p)) ||
    /^\/data\/obs\/[A-Za-z0-9-]+\/recent/.test(path) ||
    /^\/ref\/hotspot\//.test(path);
}

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    const url = new URL(request.url);
    const ebirdPath = url.pathname;

    // Validate path
    if (!isAllowedPath(ebirdPath)) {
      return jsonResponse({ error: "Path not allowed" }, 403);
    }

    // Forward query params and API key header
    const ebirdUrl = `${EBIRD_BASE}${ebirdPath}${url.search}`;
    const apiKey = request.headers.get("X-eBirdApiToken") || url.searchParams.get("key");

    if (!apiKey) {
      return jsonResponse({ error: "Missing API key" }, 400);
    }

    try {
      const resp = await fetch(ebirdUrl, {
        headers: {
          "X-eBirdApiToken": apiKey,
        },
      });

      const body = await resp.text();

      return new Response(body, {
        status: resp.status,
        headers: {
          "Content-Type": resp.headers.get("Content-Type") || "application/json",
          ...corsHeaders(),
        },
      });
    } catch (err) {
      return jsonResponse({ error: err.message }, 502);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-eBirdApiToken",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}
