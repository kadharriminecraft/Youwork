/* =====================================================================
   YT-ONLY WORKER — a dedicated Cloudflare Worker purpose-built for the
   YT-Only app (the stripped-down YouTube-only player).

   Deploy on YOUR Cloudflare account (free tier is fine):
     1. dash.cloudflare.com → Workers & Pages → Create worker
     2. Name it (e.g. yt-only) → Edit code → paste this whole file
     3. Deploy → copy the URL (https://yt-only.YOU.workers.dev)
     4. In index.html, set WORKER_URL (top of the <script> block) to that URL

   What this worker does:
     - /__yt/health           → version probe ("yt-only-ok/1.0")
     - /__yt/search?q=QUERY   → JSON { videos:[{id,title,channel,thumb,duration,...}] }
     - /__yt/video?id=VID     → JSON { id,title,author,thumb,... } (oEmbed-based)
     - /__yt/home             → JSON { videos:[...] } (trending / home feed)
     - /__yt/channel?id=CID   → JSON { header, videos:[...] }
     - /__yt/img?url=URL       → passthrough image proxy (for thumbnails when blocked)
     - /__yt/proxy?url=URL     → generic CORS proxy (text/html only)

   Why a custom worker (vs. generic CORS proxies):
     - YouTube search/channel pages don't ship CORS headers, so the browser
       can't fetch them directly. The worker fetches them server-side and
       returns CORS-friendly JSON.
     - YouTube's oembed endpoint DOES allow CORS — we use it directly from
       the app for video metadata; this worker only adds the data oembed
       doesn't ship (duration, channel avatar, related videos).
     - Image thumbnails occasionally get blocked by browser privacy
       settings; /__yt/img is a thin transparent proxy that always works.

   Iteration guide:
     - To add a new endpoint: add a route in handleRequest() below.
     - All responses use json()/text() helpers that attach CORS headers.
     - Parsing logic for YouTube HTML is in lib/parse.js (inlined here for
       single-file deploy). Adjust if YouTube changes their HTML structure.
   ===================================================================== */

/* ----- version + config -------------------------------------------- */
const VERSION = '1.0';
const HEALTH_TAG = 'yt-only-ok/' + VERSION;
const YT_HOME = 'https://www.youtube.com';

/* Default request headers sent UP to youtube.com — DESKTOP UA is required:
   mobile UA gets redirected to m.youtube.com which serves a different
   HTML shape without ytInitialData, and our parser would find nothing. */
const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/* ----- CORS -------------------------------------------------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function json(obj, init) {
  return new Response(JSON.stringify(obj), {
    status: (init && init.status) || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}
function text(s, init) {
  return new Response(s, {
    status: (init && init.status) || 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
  });
}

/* ----- main entry -------------------------------------------------- */
export default {
  async fetch(request) {
    return handleRequest(request);
  },
};

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  /* CORS preflight — short-circuit */
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    /* health -------------------------------------------------------- */
    if (path === '/__yt/health') return text(HEALTH_TAG);

    /* search -------------------------------------------------------- */
    if (path === '/__yt/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: 'missing q', videos: [] });
      const html = await fetchUpstream(YT_HOME + '/results?search_query=' + encodeURIComponent(q) + '&hl=en');
      const videos = parseVideoResults(html);
      return json({ query: q, videos });
    }

    /* video metadata (oembed-shaped) -------------------------------- */
    if (path === '/__yt/video') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!id) return json({ error: 'missing id' });
      const data = await fetchVideoMeta(id);
      return json(data);
    }

    /* home feed (trending) ----------------------------------------- */
    if (path === '/__yt/home') {
      const html = await fetchUpstream(YT_HOME + '/feed/trending?hl=en');
      const videos = parseVideoResults(html);
      return json({ videos });
    }

    /* channel page -------------------------------------------------- */
    if (path === '/__yt/channel') {
      const id = (url.searchParams.get('id') || '').trim();
      const handle = (url.searchParams.get('handle') || '').trim();
      if (!id && !handle) return json({ error: 'missing id or handle' });
      const target = handle
        ? YT_HOME + '/' + handle.replace(/^@/, '@') + '/videos?hl=en'
        : YT_HOME + '/channel/' + id + '/videos?hl=en';
      const html = await fetchUpstream(target);
      const data = parseChannel(html);
      return json(data);
    }

    /* image proxy — transparent passthrough for thumbnails ---------- */
    if (path === '/__yt/img') {
      const target = url.searchParams.get('url');
      if (!target || !/^https?:\/\/.+/i.test(target)) {
        return new Response('bad url', { status: 400, headers: CORS });
      }
      const r = await fetch(target, { headers: UPSTREAM_HEADERS });
      const ct = r.headers.get('Content-Type') || 'image/*';
      return new Response(r.body, {
        status: r.status,
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400',
          ...CORS,
        },
      });
    }

    /* generic text proxy (CORS escape hatch) ----------------------- */
    if (path === '/__yt/proxy') {
      const target = url.searchParams.get('url');
      if (!target || !/^https?:\/\/.+/i.test(target)) {
        return new Response('bad url', { status: 400, headers: CORS });
      }
      const r = await fetch(target, { headers: UPSTREAM_HEADERS });
      const ct = r.headers.get('Content-Type') || 'text/plain';
      return new Response(r.body, {
        status: r.status,
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=300',
          ...CORS,
        },
      });
    }

    return text('not found', { status: 404 });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, { status: 500 });
  }
}

/* ----- upstream fetch --------------------------------------------- */
async function fetchUpstream(u) {
  const r = await fetch(u, { headers: UPSTREAM_HEADERS, redirect: 'follow' });
  if (!r.ok) throw new Error('upstream ' + r.status + ' for ' + u);
  return r.text();
}

/* ----- HTML → JSON parsing -----------------------------------------
   YouTube embeds a JSON blob named ytInitialData in the page HTML. We
   fish it out with a regex and walk it to find video renderers.

   The non-greedy match against `;</script>` works because YouTube's
   own server escapes any literal `</script>` inside JSON strings as
   `<\/script>` (standard XSS defense).

   If YouTube changes their HTML structure, this is the only place
   that needs updating. */
function extractYtInitialData(html) {
  /* Pattern 1: ytInitialData = {...};</script>  (desktop HTML) */
  const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/);
  if (m) {
    try { return JSON.parse(m[1]); } catch (e) {}
  }
  /* Pattern 2: "ytInitialData":{...}  (script-acquired JSON shape) */
  const m2 = html.match(/"ytInitialData"\s*:\s*(\{[\s\S]*?\})\s*,\s*"ytInitialPlayerResponse"/);
  if (m2) {
    try { return JSON.parse(m2[1]); } catch (e) {}
  }
  /* Pattern 3: window["ytInitialData"] = {...}; */
  const m3 = html.match(/window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (m3) {
    try { return JSON.parse(m3[1]); } catch (e) {}
  }
  return null;
}
function extractYtInitialPlayerResponse(html) {
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
  return null;
}

/* Walk ytInitialData and pull out every video renderer we can find. */
function parseVideoResults(html) {
  const data = extractYtInitialData(html);
  if (!data) return [];
  const out = [];
  const seen = {};

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    /* videoRenderer is the search-results shape */
    if (node.videoRenderer) {
      const v = extractVideoRenderer(node.videoRenderer);
      if (v && !seen[v.id]) { seen[v.id] = 1; out.push(v); }
    }
    /* compactVideoRenderer is the "up next" / channel list shape */
    if (node.compactVideoRenderer) {
      const v = extractVideoRenderer(node.compactVideoRenderer);
      if (v && !seen[v.id]) { seen[v.id] = 1; out.push(v); }
    }
    /* gridVideoRenderer is the channel-page grid shape */
    if (node.gridVideoRenderer) {
      const v = extractVideoRenderer(node.gridVideoRenderer);
      if (v && !seen[v.id]) { seen[v.id] = 1; out.push(v); }
    }
    /* playlistVideoRenderer (rare in our paths) */
    if (node.playlistVideoRenderer) {
      const v = extractVideoRenderer(node.playlistVideoRenderer);
      if (v && !seen[v.id]) { seen[v.id] = 1; out.push(v); }
    }
    for (const k in node) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') visit(v);
    }
  }
  visit(data);
  return out;
}

function extractVideoRenderer(r) {
  try {
    const id = r.videoId;
    if (!id) return null;
    const titleNode = r.title && (r.title.runs && r.title.runs[0] || r.title.simpleText);
    const title = (titleNode && (titleNode.text || titleNode)) || '';
    const thumb = (r.thumbnail && r.thumbnail.thumbnails && r.thumbnail.thumbnails.slice(-1)[0].url) || '';
    const channel = (r.ownerText && r.ownerText.runs && r.ownerText.runs[0] && r.ownerText.runs[0].text)
      || (r.shortBylineText && r.shortBylineText.runs && r.shortBylineText.runs[0] && r.shortBylineText.runs[0].text)
      || '';
    const channelId = (r.ownerText && r.ownerText.runs && r.ownerText.runs[0] && r.ownerText.runs[0].navigationEndpoint && r.ownerText.runs[0].navigationEndpoint.browseEndpoint && r.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId)
      || (r.channelId) || '';
    const duration = (r.lengthText && r.lengthText.simpleText) || (r.lengthText && r.lengthText.accessibility && r.lengthText.accessibility.accessibilityData && r.lengthText.accessibility.accessibilityData.label) || '';
    const views = (r.viewCountText && r.viewCountText.simpleText) || '';
    const date = (r.publishedTimeText && r.publishedTimeText.simpleText) || '';
    const description = (r.detailedMetadataSnippets && r.detailedMetadataSnippets[0] && r.detailedMetadataSnippets[0].snippetText && r.detailedMetadataSnippets[0].snippetText.runs && r.detailedMetadataSnippets[0].snippetText.runs.map(x=>x.text).join('')) || '';
    return { id, title, thumb, channel, channelId, duration, views, date, description };
  } catch (e) {
    return null;
  }
}

function parseChannel(html) {
  const data = extractYtInitialData(html);
  if (!data) return { header: {}, videos: [] };
  let header = {};
  try {
    const c = findFirst(data, 'c4TabbedHeaderRenderer') || findFirst(data, 'pageHeaderRenderer');
    if (c) {
      header = {
        id: c.channelId || (c.metadata && c.metadata.channelMetadataRenderer && c.metadata.channelMetadataRenderer.externalId) || '',
        title: c.title || '',
        avatar: (c.avatar && c.avatar.thumbnails && c.avatar.thumbnails.slice(-1)[0].url) || '',
        subs: (c.subscriberCountText && c.subscriberCountText.simpleText) || '',
        handle: '',
      };
    }
  } catch (e) {}
  const videos = parseVideoResults(html);
  return { header, videos };
}

function findFirst(node, key) {
  if (!node || typeof node !== 'object') return null;
  if (node[key]) return node[key];
  for (const k in node) {
    const v = node[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        const r = findFirst(item, key);
        if (r) return r;
      }
    } else if (v && typeof v === 'object') {
      const r = findFirst(v, key);
      if (r) return r;
    }
  }
  return null;
}

/* ----- video metadata via oEmbed ---------------------------------- */
async function fetchVideoMeta(id) {
  /* oEmbed ships CORS headers itself, but going through the worker
     means the app can fetch a single uniform endpoint without
     worrying about origin. */
  const watchUrl = YT_HOME + '/watch?v=' + id;
  const oembedUrl = YT_HOME + '/oembed?url=' + encodeURIComponent(watchUrl) + '&format=json';
  const r = await fetch(oembedUrl, { headers: UPSTREAM_HEADERS });
  if (!r.ok) {
    return { id, title: 'Video', author: '', thumb: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' };
  }
  const j = await r.json();
  return {
    id,
    title: j.title || 'Video',
    author: j.author_name || '',
    authorUrl: j.author_url || '',
    thumb: j.thumbnail_url || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'),
  };
}
