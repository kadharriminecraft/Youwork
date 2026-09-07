/* =====================================================================
   YT-ONLY WORKER v1.4 — a dedicated Cloudflare Worker purpose-built for
   the YT-Only app (the stripped-down YouTube-only player).

   Deploy on YOUR Cloudflare account (free tier is fine):
     1. dash.cloudflare.com → Workers & Pages → Create worker
     2. Name it (e.g. yt-only) → Edit code → paste this whole file
     3. Deploy → copy the URL (https://yt-only.YOU.workers.dev)
     4. In the app: Settings (gear) → paste the URL → Save → Test connection

   What this worker does:
     - /__yt/health           → version probe ("yt-only-ok/1.4")
     - /__yt/search?q=QUERY   → JSON { videos:[...], channels:[...] }
     - /__yt/video?id=VID     → JSON { id,title,description,views,date,channel,related }
     - /__yt/home             → JSON { videos:[...] } (popular feed)
     - /__yt/channel?id=|handle= → JSON { header, videos:[...] }
     - /__yt/dl?id=VID&type=audio|video → streams the file through this
       worker (Content-Disposition: attachment) so the browser downloads
       it directly from YOUR worker — no external site needed.
     - /__yt/img?url=URL      → passthrough image proxy
     - /__yt/proxy?url=URL    → generic CORS proxy

   v1.4 ALSO PROXIES THE EZCONV CONVERTER WEBSITE (same idea as the
   "Relay" proxy browser's super worker, specialized for one site):
     - /__ez/<path>           → https://ezconv.cc/<path>
       The real ezconv.cc page — HTML rewritten so every asset, link and
       SPA route stays inside the proxy. Opens even when ezconv.cc is
       blocked on your network, because it loads from YOUR worker.
     - /__ezapi/<path>        → https://api.ezsrv.net/<path>
       The converter API (attest / convert / status) — proxied and
       CORS-unlocked. The page's own JS is rewritten to call this.
     - /__ezdl/<host>/<path>  → https://<host>/<path> (dl*.ezsrv.net only)
       Download relay for converted files: streams the MP3/MP4 through
       the worker with the original filename + Range support.
     - anything else at root  → 302 into /__ez — so the Next.js SPA's
       own runtime fetches (un-prefixed /_next/…, RSC routes) always
       land back inside the proxy. The worker root IS the converter:
       just open https://YOUR.WORKER/ and ezconv appears, unblocked.

   WHAT CHANGED IN v1.4 (ezconv integration):
     1. EZCONV SITE PROXY — the app's Download button now opens the real
        ezconv.cc converter THROUGH this worker (Relay-style): HTML/JS
        rewriting (assets, links, API base, download hosts), RSC/Next.js
        router passthrough, forced-download relay for converted files.
     2. The video link is copied to the clipboard on the way out AND
        auto-pasted into the converter's input (?url=… prefill script).
     3. All v1.3 YouTube endpoints unchanged — search / video / home /
        channel / dl keep the Piped + innertube fallback chains.

   WHAT CHANGED IN v1.3 (channel reliability + fast reliable downloads):
     1. CHANNELS — ported from the Relay browser app, whose channel code
        was verified working on real devices: Piped's /channel/{id} API
        is now the FIRST source (YouTube serves JS-only shell pages with
        no ytInitialData to datacenter egress — that is why channels
        failed), with @handle resolution through Piped's channel search,
        and the HTML scrape kept only as the last fallback.
     2. PIPED RACING — instances are queried IN PARALLEL now; the first
        valid payload wins. Previously dead instances were walked one by
        one with 10-12s timeouts each, which is why downloads hung for
        60s+ and sometimes 502'd. Worst case is now ~6 seconds total.
     3. /__yt/dl — video tier: muxed MP4 (innertube ANDROID_VR itag 18,
        Piped videoOnly:false) + LBRY mirror as an extra fallback when
        YouTube formats are unavailable. Audio tier unchanged (it worked).
     4. /__yt/video — added oEmbed as a 4th cheap fallback (title +
        channel even when every other source is throttled) and a short
        in-memory cache so repeated visits don't re-hit YouTube.
     5. /__yt/search — response now includes channel results (chips)
        from the same ytInitialData walk + Piped channels filter.

   WHAT CHANGED IN v1.2 (fixes 429 throttling + adds downloads):
     1. YouTube 429-throttles /watch page scrapes from some datacenter
        IPs ("upstream 429" — that's why video details sometimes broke).
        /__yt/video now has a 3-source fallback chain:
          a) youtube.com/watch HTML scrape (best data)
          b) Piped API instances (pipedapi…) — metadata + related
          c) YouTube innertube player API (ANDROID_VR client) — metadata
             + stream URLs; related via the /next endpoint.
        Whichever source answers first wins, so video details now work
        even when YouTube throttles one path.
     2. NEW /__yt/dl endpoint — download the video (MP4 with sound) or
        just the audio (M4A) as a stream piped through this worker.
        Sources: innertube ANDROID_VR direct googlevideo URLs first,
        Piped instance streams as fallback. Range requests supported.
     3. /__yt/search and /__yt/home also gained Piped fallbacks.

   WHAT CHANGED IN v1.1 (fixes channel + video details):
     1. SOCS/CONSENT cookies. YouTube answers datacenter IPs with the
        consent interstitial — a page with NO ytInitialData. That is why
        the old worker returned empty metadata for everything.
     2. ytInitialPlayerResponse no longer carries videoDetails for
        logged-out scrapes ("Sign in to confirm you're not a bot").
        Watch metadata now comes entirely from ytInitialData
        (videoPrimaryInfoRenderer / videoSecondaryInfoRenderer).
     3. YouTube migrated channel grids and related-video lists to
        "lockupViewModel". The old parser only knew videoRenderer /
        compactVideoRenderer / gridVideoRenderer, so channels and
        related videos came back empty. v1.1 parses lockups everywhere.
     4. Channel headers migrated to pageHeaderViewModel +
        channelMetadataRenderer. v1.1 reads title / avatar / handle /
        subscriber count / description / banner from the new shapes.
     5. /feed/trending and the logged-out homepage now ship an EMPTY
        shell. /__yt/home now reads YouTube's official "Most Popular"
        playlist instead.
     6. extractJson: proper string-escape handling (the old escape logic
        could silently fail on JSON containing escaped quotes, e.g.
        video descriptions).

   Iteration guide:
     - To add a new endpoint: add a route in handleRequest() below.
     - All responses use json()/text() helpers that attach CORS headers.
     - Parsing logic for YouTube HTML lives below (single-file deploy).
       If YouTube changes their HTML structure again, this is the only
       file that needs updating.
   ===================================================================== */

/* ----- version + config -------------------------------------------- */
const VERSION = '1.4';
const HEALTH_TAG = 'yt-only-ok/' + VERSION;
const YT_HOME = 'https://www.youtube.com';

/* Home feed source. The logged-out homepage AND /feed/trending now
   return an empty shell (a single feedNudgeRenderer), but playlist
   pages still ship full ytInitialData with 100 video lockups.
   This is YouTube's official "Most Popular" playlist. */
const HOME_PLAYLIST = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';

/* Piped API instances (channels-first tier, v1.3).
   Ported from the Relay browser app — the SAME instances and the SAME
   endpoints its working channel code uses:
     /channel/{id}      → name, avatar, description, latest streams
     /search?filter=channels → @handle → channel-id resolution
   Instances are RACED IN PARALLEL (pipedGet below) — the first one
   that answers with a usable payload wins, so one slow/dead instance
   can no longer stall a request the way the old sequential walk did. */
const PIPED_BASES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.drgns.space',
  'https://piapi.ggtyler.dev',
  'https://pipedapi.ducks.party',
];

/* Race every Piped instance at once; resolve with the first VALID json.
   validate(j) → true means "this payload is usable". 6s timeout per
   instance keeps the whole tier under ~6 seconds worst-case. */
function pipedGet(path, validate, ms) {
  const attempts = PIPED_BASES.map(async (base) => {
    const r = await fetchTimeout(base + path, { headers: { Accept: 'application/json' } }, ms || 6000);
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (!j || (validate && !validate(j))) throw new Error('bad payload');
    return j;
  });
  return new Promise((resolve, reject) => {
    let remaining = attempts.length;
    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };
    /* hard ceiling: even if every fetch hangs, reject at +2s past the
       per-instance timeout so callers never wait forever */
    timer = setTimeout(() => finish(reject, new Error('piped race timeout')), (ms || 6000) + 2000);
    attempts.forEach(p => {
      Promise.resolve(p).then(
        (j) => finish(resolve, j),
        () => { if (--remaining === 0) finish(reject, new Error('all piped instances failed')); }
      );
    });
  });
}

/* innertube ANDROID_VR client — currently the most reliable client
   that returns deciphered (direct) stream URLs without PO tokens. */
const VR_UA = 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; eureka-user Build/SQ3A.220705.004.A1) gzip';
const VR_CONTEXT = {
  client: {
    clientName: 'ANDROID_VR',
    clientVersion: '1.60.19',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    osName: 'Android',
    osVersion: '12',
    androidSdkVersion: 32,
  },
};

/* fetch with timeout — Workers give us setTimeout, so we race it. */
function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

/* Default request headers sent UP to youtube.com — DESKTOP UA is
   required: mobile UA gets redirected to m.youtube.com which serves a
   different HTML shape without ytInitialData.
   The Cookie header is CRITICAL: SOCS/CONSENT bypasses the consent
   interstitial YouTube serves to datacenter (Worker) IPs. Without it,
   every page comes back as a consent form with no ytInitialData. */
const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'SOCS=CAI; CONSENT=YES+cb.20210328-17-p0.en+FX+419',
};

/* ----- ezconv.cc proxy config (v1.4) -------------------------------- *
 * The converter the app's Download button opens. Three upstreams:
 *   EZ_SITE  — the Next.js website (pages, assets, RSC routes)
 *   EZ_API   — the conversion API (attest/convert/status/notice)
 *   EZ_DL_RE — download CDNs (dl1/dl2/… .ezsrv.net) for converted files
 * The page's JS chunks are rewritten so every fetch it makes lands on
 * this worker; JSON responses have their downloadUrl rewritten the
 * same way. Everything else (fonts, turnstile) stays direct. */
const EZ_SITE = 'https://ezconv.cc';
const EZ_API = 'https://api.ezsrv.net';
const EZ_DL_HOST_RE = /^[a-z0-9.-]*\.ezsrv\.net$/i;
const EZ_PREFIX = '/__ez';
const EZ_API_PREFIX = '/__ezapi';
const EZ_DL_PREFIX = '/__ezdl';
/* headers forwarded between the browser and the two ezconv upstreams —
 * includes the full Next.js RSC set so client-side navigation works */
const EZ_FORWARD_REQ = new Set([
  'accept', 'accept-language', 'range', 'if-none-match', 'if-modified-since',
  'content-type', 'rsc', 'next-router-state-tree', 'next-router-prefetch',
  'next-router-segment-prefetch', 'next-url', 'next-action', 'next-test-data',
]);

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
let EZ_CTX = null; /* execution context (waitUntil) for cache writes */

export default {
  async fetch(request, env, ctx) {
    EZ_CTX = ctx || null;
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
      if (!q) return json({ error: 'missing q', videos: [], channels: [] });
      /* 1) youtube.com/results scrape (videos + channel renderers) */
      try {
        const html = await fetchUpstream(YT_HOME + '/results?search_query=' + encodeURIComponent(q) + '&hl=en&gl=US');
        const data = extractYtInitialData(html);
        const videos = collectVideos(data);
        if (videos.length) {
          const channels = collectChannels(data);
          return json({ query: q, videos, channels });
        }
      } catch (e) { /* fall through to Piped */ }
      /* 2) Piped — videos + channels raced in parallel */
      const pv = await pipedSearch(q);
      let pc = [];
      try {
        const jc = await pipedGet('/search?q=' + encodeURIComponent(q) + '&filter=channels', j => j && Array.isArray(j.items) && j.items.length);
        pc = (jc.items || []).map(pipedItemToChannel).filter(Boolean).slice(0, 6);
      } catch (e) { /* channels are optional */ }
      return json({ query: q, videos: pv, channels: pc });
    }

    /* video metadata — full /watch page parse, with fallback chain -- */
    if (path === '/__yt/video') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!id) return json({ error: 'missing id' });
      const cacheKey = 'video:' + id;
      const hit = cacheGet(cacheKey);
      if (hit) return json(hit);
      let data = null, lastErr = null;
      /* 1) HTML scrape (richest data: banner, exact dates, subs) */
      try {
        const html = await fetchUpstream(YT_HOME + '/watch?v=' + encodeURIComponent(id) + '&hl=en');
        data = parseWatchPage(html, id);
      } catch (e) { lastErr = e; }
      /* 2) search-by-ID scrape — KEY v1.3 insight: YouTube 429-throttles
         /watch pages from datacenter IPs but NOT /results pages. Searching
         the video id itself returns the video as the first result with
         title, channelId, views, date, duration; the remaining results
         serve as "Up next". This keeps metadata loading when /watch is
         blocked. */
      if (!data || !data.title) {
        try {
          const html = await fetchUpstream(YT_HOME + '/results?search_query=' + encodeURIComponent(id) + '&hl=en&gl=US');
          data = parseSearchVideoMeta(extractYtInitialData(html), id);
        } catch (e) { /* keep going */ }
      }
      /* 3) Piped API — works even when YouTube throttles our IP */
      if (!data || !data.title) {
        try {
          const pd = await pipedStreams(id);
          if (pd && pd.title) data = pipedToVideo(pd, id);
        } catch (e) { /* keep going */ }
      }
      /* 4) innertube ANDROID_VR player (metadata) + /next (related) */
      if (!data || !data.title) {
        try {
          const iv = await innertubePlayer(id);
          if (iv && iv.videoDetails && iv.videoDetails.title) {
            data = await innertubeToVideo(iv, id);
          }
        } catch (e) { /* keep going */ }
      }
      /* 5) oEmbed — nearly always up, gives at least title + channel */
      if (!data || !data.title) {
        try {
          data = await oembedVideo(id);
        } catch (e) { /* keep going */ }
      }
      if (data && (data.title || data.id)) {
        cacheSet(cacheKey, data, 180000);
        return json(data);
      }
      return json({ error: 'video unavailable: ' + (lastErr ? lastErr.message : 'no source answered') }, { status: 502 });
    }

    /* download — stream video (MP4 with audio) or audio (M4A) ------- */
    if (path === '/__yt/dl') {
      return await handleDownload(url, request);
    }

    /* home feed (popular playlist) ---------------------------------- */
    if (path === '/__yt/home') {
      try {
        const html = await fetchUpstream(YT_HOME + '/playlist?list=' + HOME_PLAYLIST + '&hl=en');
        const videos = collectVideos(extractYtInitialData(html), null, 40);
        if (videos.length) return json({ videos });
      } catch (e) { /* fall through to Piped trending */ }
      const tv = await pipedTrending();
      return json({ videos: tv.slice(0, 40) });
    }

    /* channel page -------------------------------------------------- *
     * v1.3: two sources run IN PARALLEL and merge:
     *   - Piped /channel/{id}  → header (name/avatar/banner/desc/subs)
     *     is reliable even when YouTube shells pages to datacenter IPs.
     *     (Relay-app architecture.)
     *   - youtube.com /channel/{id}/videos scrape → the VIDEOS (lockups).
     *     Channel grids scrape fine from datacenter IPs most of the time
     *     — it's /watch that gets 429'd hard. When the scrape dies,
     *     Piped's relatedStreams/nextpage fill in what they can.
     * @handle requests resolve to a UC id through Piped's channel search
     * first, then fall back to scraping /@handle/videos directly. */
    if (path === '/__yt/channel') {
      const idParam = (url.searchParams.get('id') || '').trim();
      const handleParam = (url.searchParams.get('handle') || '').trim();
      if (!idParam && !handleParam) return json({ error: 'missing id or handle' });

      const cacheKey = 'channel:' + (idParam || handleParam);
      const hit = cacheGet(cacheKey);
      if (hit) return json(hit);

      let resolvedId = idParam; /* may be filled in by handle resolution */
      let pipedHeader = null;   /* header from Piped */

      /* -- resolve @handle → UC id (Piped first, fast) ---------------- */
      if (!resolvedId && handleParam) {
        try { resolvedId = await pipedResolveHandle(handleParam); } catch (e) { /* scrape fallback below */ }
      }

      /* -- Piped header tier (also carries videos when the instance
            still returns them inline) ---------------------------------- */
      let pipedVideos = [];
      if (resolvedId) {
        try {
          const j = await pipedGet('/channel/' + encodeURIComponent(resolvedId), jj => jj && (jj.name || Array.isArray(jj.relatedStreams)));
          const pc = pipedToChannel(j, resolvedId);
          pipedHeader = pc.header;
          pipedVideos = pc.videos || [];
          /* newer Piped builds moved videos to a continuation token */
          if (!pipedVideos.length && j && j.nextpage) {
            try {
              /* the token carries the full request — try each base
                 until one accepts it (usually the issuing instance) */
              for (const b of PIPED_BASES) {
                try {
                  const r = await fetchTimeout(b + '/nextpage/channel/' + encodeURIComponent(resolvedId) + '?nextpage=' + encodeURIComponent(j.nextpage), { headers: { Accept: 'application/json' } }, 5000);
                  if (!r.ok) continue;
                  const j2 = await r.json();
                  const rs = (j2 && j2.relatedStreams) || [];
                  if (rs.length) { pipedVideos = rs.map(pipedItemToVideo).filter(v => v && v.id).slice(0, 30); break; }
                } catch (e2) { /* next base */ }
              }
            } catch (e) { /* pagination unavailable */ }
          }
        } catch (e) { /* Piped tier down — scrape still covers us */ }
      }

      /* -- scrape tier: videos (primary) + header (fallback) ---------- */
      const scrapeTarget = resolvedId
        ? YT_HOME + '/channel/' + encodeURIComponent(resolvedId) + '/videos?hl=en'
        : YT_HOME + '/' + (handleParam.startsWith('@') ? handleParam : '@' + handleParam) + '/videos?hl=en';
      let scraped = null;
      try {
        const html = await fetchUpstream(scrapeTarget);
        const parsed = parseChannel(html);
        if (parsed && (parsed.header.title || (parsed.videos || []).length)) scraped = parsed;
      } catch (e) { /* scrape down — Piped result is the answer */ }

      /* -- merge: Piped header wins on freshness, scrape wins on videos,
            each fills the other's gaps ---------------------------------- */
      let out = null;
      if (pipedHeader || scraped) {
        const h = Object.assign({}, (scraped && scraped.header) || {}, pipedHeader || {});
        /* scrape-only extras that Piped never provides (Object.assign
           above overwrites them with '' — restore the real values) */
        if (scraped && scraped.header) {
          for (const k of ['banner', 'handle', 'videosCount', 'desc']) {
            if (scraped.header[k] && !h[k]) h[k] = scraped.header[k];
          }
          if (!h.subs && scraped.header.subs) h.subs = scraped.header.subs;
        }
        const videos = ((scraped && scraped.videos) || []).length
          ? (scraped && scraped.videos)
          : pipedVideos;
        /* channel attribution on every card (lockups carry none) */
        for (const v of (videos || [])) {
          if (!v.channel) v.channel = h.title || '';
          if (!v.channelId) v.channelId = h.id || '';
        }
        out = {
          source: pipedHeader ? 'piped+scrape' : 'scrape',
          header: h,
          videos: (videos || []).slice(0, 30),
        };
      }

      if (out && (out.header.title || (out.videos || []).length)) {
        cacheSet(cacheKey, out, 300000);
        return json(out);
      }
      return json({ error: 'channel unavailable — both the Piped tier and the youtube.com scrape failed. Try again in a moment.' }, { status: 502 });
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

    /* =============================================================== *
     * ezconv.cc converter proxy (v1.4) — Relay-style, single-site.
     * See the ezProxy section near the bottom for the rewriting logic.
     * =============================================================== */
    /* API tier: /__ezapi/<path> → https://api.ezsrv.net/<path> */
    if (path === EZ_API_PREFIX || path.startsWith(EZ_API_PREFIX + '/')) {
      return await ezApiProxy(url, request);
    }
    /* download tier: /__ezdl/<host>/<path> → https://<host>/<path> */
    if (path === EZ_DL_PREFIX || path.startsWith(EZ_DL_PREFIX + '/')) {
      return await ezDlProxy(url, request);
    }
    /* site tier: /__ez/<path> → https://ezconv.cc/<path> */
    if (path === EZ_PREFIX || path.startsWith(EZ_PREFIX + '/')) {
      return await ezSiteProxy(url, request);
    }

    /* root catch-all → the converter (v1.4).
     * The worker has no content outside /__yt and /__ez*, so ANY other
     * GET (or HEAD) is a Next.js runtime fetch that lost its /__ez
     * prefix — an un-rewritten <a href>, an RSC route the router built
     * from the flight payload, a webpack chunk load at /_next/….
     * 302 it back inside the proxy so the SPA never falls out.
     * Non-GET (server actions POSTs) keep their method via 307. */
    if (path !== '/' && !path.startsWith('/__yt') && !path.startsWith('/__ez')) {
      const dest = EZ_PREFIX + path + (url.search || '');
      return new Response(null, {
        status: (request.method === 'GET' || request.method === 'HEAD') ? 302 : 307,
        headers: {
          'Location': dest,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    }
    /* bare "/" → the converter home (ezconv.cc/ 307s to /en/k7x2) */
    if (path === '/') {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': EZ_PREFIX + '/en/k7x2',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    }

    return text('not found', { status: 404 });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, { status: 500 });
  }
}

/* ----- upstream fetch --------------------------------------------- *
 * Retries with backoff — YouTube intermittently throttles bursts of
 * datacenter-IP requests (429) or answers with a redirect-to-consent.
 * Waiting and retrying resolves the vast majority of those. */
async function fetchUpstream(u) {
  const DELAYS = [0, 500, 1300];
  let lastErr = null;
  for (let attempt = 0; attempt < DELAYS.length; attempt++) {
    if (DELAYS[attempt]) await new Promise(res => setTimeout(res, DELAYS[attempt]));
    try {
      const r = await fetch(u, { headers: UPSTREAM_HEADERS, redirect: 'follow' });
      if (r.ok) return r.text();
      lastErr = new Error('upstream ' + r.status + ' for ' + u);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('upstream failed for ' + u);
}

/* ----- HTML → JSON parsing -----------------------------------------
   YouTube embeds JSON blobs (ytInitialData, ytInitialPlayerResponse) in
   the page HTML. We use a brace-balanced extractor instead of a regex —
   regexes fail because the JSON contains nested objects with `}`
   characters that confuse non-greedy matching.

   v1.1 note: escape handling inside strings is now correct (the old
   version mis-handled escaped quotes, which broke any blob containing
   `\"` — video descriptions, titles with quotes, etc). */
function extractJson(html, varName) {
  const sm = new RegExp(varName + '\\s*=\\s*').exec(html);
  if (!sm) return null;
  let i = sm.index + sm[0].length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== '{') return null;
  let depth = 0, start = i, inStr = false, esc = false;
  while (i < html.length) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    i++;
  }
  return null;
}
function extractYtInitialData(html) {
  return extractJson(html, 'ytInitialData');
}
function extractYtInitialPlayerResponse(html) {
  return extractJson(html, 'ytInitialPlayerResponse');
}

/* ----- generic helpers -------------------------------------------- */
function isValidVideoId(s) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(s || ''));
}
/* Normalize any text node shape (simpleText | runs | content | string). */
function textOf(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return String(t);
  if (t.simpleText) return t.simpleText;
  if (t.content) return t.content;
  if (t.runs) return t.runs.map(r => r.text).join('');
  if (t.text) return textOf(t.text);
  return '';
}
/* Find the first node stored under `key` anywhere in the tree. */
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
/* Pick a reasonable thumbnail from a sources array (prefer ~360px wide). */
function pickThumb(sources) {
  if (!sources || !sources.length) return '';
  let best = sources[sources.length - 1];
  for (const s of sources) {
    if (s.width && s.width >= 320) { best = s; break; }
  }
  return best.url || '';
}

/* ----- video collection --------------------------------------------
   Walk the ENTIRE ytInitialData tree and pull out every video we can
   find, regardless of which renderer shape YouTube wraps it in.

   Shapes handled (2025):
     - videoRenderer          → search results
     - compactVideoRenderer   → legacy "up next" lists
     - gridVideoRenderer      → legacy channel grids
     - playlistVideoRenderer  → legacy playlist pages
     - lockupViewModel        → NEW: search, channel grids, playlists,
                                watch related videos ("lockup" migration)
     - shortsLockupViewModel  → shorts shelves

   `excludeId` drops the current video (used by the watch endpoint).
   `limit` caps the result count (0 = unlimited). */
function collectVideos(data, excludeId, limit) {
  if (!data) return [];
  const out = [];
  const seen = {};

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (limit && out.length >= limit) return;

    let v = null;
    if (node.videoRenderer) v = extractVideoRenderer(node.videoRenderer);
    else if (node.compactVideoRenderer) v = extractVideoRenderer(node.compactVideoRenderer);
    else if (node.gridVideoRenderer) v = extractVideoRenderer(node.gridVideoRenderer);
    else if (node.playlistVideoRenderer) v = extractVideoRenderer(node.playlistVideoRenderer);
    else if (node.lockupViewModel) v = extractLockupViewModel(node.lockupViewModel);
    else if (node.shortsLockupViewModel) v = extractShortsLockup(node.shortsLockupViewModel);

    if (v && v.id && v.id !== excludeId && !seen[v.id]) {
      seen[v.id] = 1;
      out.push(v);
    }

    for (const k in node) {
      const val = node[k];
      if (val && typeof val === 'object') visit(val);
    }
  }
  visit(data);
  return out;
}

/* Walk ytInitialData collecting CHANNEL results (search page chips).
   Handles both the desktop (channelRenderer) and mobile
   (compactChannelRenderer) shapes — same approach the Relay app uses. */
function collectChannels(data) {
  if (!data) return [];
  const out = [];
  const seen = {};
  const MAX = 8;

  function pickAvatar(thumbs) {
    const u = pickThumb(thumbs);
    return u || '';
  }

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (out.length >= MAX) return;

    let c = null;
    try {
      if (node.channelRenderer) {
        const r = node.channelRenderer;
        c = {
          id: r.channelId || '',
          name: textOf(r.title),
          subs: textOf(r.subscriberCountText) || textOf(r.videoCountText) || '',
          avatar: pickAvatar(r.thumbnail && r.thumbnail.thumbnails),
          desc: textOf(r.descriptionSnippet).slice(0, 120),
        };
      } else if (node.compactChannelRenderer) {
        const r = node.compactChannelRenderer;
        c = {
          id: r.channelId || '',
          name: textOf(r.displayName),
          subs: textOf(r.subscriberCountText) || textOf(r.videoCountText) || '',
          avatar: pickAvatar(r.thumbnail && r.thumbnail.thumbnails),
          desc: '',
        };
      }
    } catch (e) { c = null; }

    if (c && c.id && c.name && !seen[c.id]) {
      seen[c.id] = 1;
      out.push(c);
    }

    for (const k in node) {
      const val = node[k];
      if (val && typeof val === 'object') visit(val);
    }
  }
  visit(data);
  return out;
}

/* Classic renderer (search results, legacy layouts). */
function extractVideoRenderer(r) {
  try {
    const id = r.videoId;
    if (!id) return null;
    const title = textOf(r.title);
    const thumb = pickThumb(r.thumbnail && r.thumbnail.thumbnails)
      || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg');
    const channel = textOf(r.ownerText) || textOf(r.shortBylineText) || textOf(r.longBylineText) || '';
    const channelId = (r.ownerText && r.ownerText.runs && r.ownerText.runs[0] &&
      r.ownerText.runs[0].navigationEndpoint && r.ownerText.runs[0].navigationEndpoint.browseEndpoint &&
      r.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId)
      || r.channelId || '';
    const duration = textOf(r.lengthText);
    const views = textOf(r.viewCountText);
    const date = textOf(r.publishedTimeText);
    const description = (r.detailedMetadataSnippets && r.detailedMetadataSnippets[0] &&
      textOf(r.detailedMetadataSnippets[0].snippetText)) || '';
    return { id, title, thumb, channel, channelId, duration, views, date, description };
  } catch (e) {
    return null;
  }
}

/* NEW lockup shape (channel grids, playlist pages, related videos).
   A lockup is a generic card — check contentType so we only keep
   VIDEO lockups (not playlists / channels / posts). */
function extractLockupViewModel(vm) {
  try {
    if (!vm) return null;
    const ctype = vm.contentType || '';
    if (ctype && !/VIDEO/i.test(ctype)) return null;

    let id = vm.contentId || '';
    if (!isValidVideoId(id)) {
      /* contentId can be a playlist id (PL…) — only accept video ids */
      const md0 = vm.metadata && vm.metadata.lockupMetadataViewModel;
      const src0 = md0 && md0.image && ''; /* no-op guard */
      const tv0 = vm.contentImage && vm.contentImage.thumbnailViewModel;
      const src = tv0 && tv0.image && pickThumb(tv0.image.sources);
      if (src) {
        const m = /\/vi\/([A-Za-z0-9_-]{11})\//.exec(src);
        if (m) id = m[1];
      }
    }
    if (!isValidVideoId(id)) return null;

    const md = vm.metadata && vm.metadata.lockupMetadataViewModel;
    const title = (md && md.title && md.title.content) || '';

    const tv = vm.contentImage && vm.contentImage.thumbnailViewModel;
    const thumb = (tv && tv.image && pickThumb(tv.image.sources))
      || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg');

    /* Metadata rows: [channel], then [views, date] — but on channel
       pages there is no channel row, just [views, date].
       Parts carry accessibilityLabel ("132 thousand views",
       "11 years ago") which disambiguates the compact texts. */
    let channel = '', channelId = '', views = '', date = '';
    const rows = md && md.metadata && md.metadata.contentMetadataViewModel &&
      md.metadata.contentMetadataViewModel.metadataRows || [];
    for (const row of rows) {
      for (const p of (row.metadataParts || [])) {
        const label = p.accessibilityLabel || '';
        const t = p.text ? textOf(p.text) : '';
        if (!t && !label) continue;
        if (/views?$/i.test(t) || /\bviews\b/i.test(label)) { if (!views) views = t; }
        else if (/ago$/i.test(t) || /streamed|premiere/i.test(t) || /\bago\b/i.test(label)) { if (!date) date = t; }
        else if (!channel) channel = t;
        /* channel link + browseId inside commandRuns */
        if (!channelId && p.text && p.text.commandRuns) {
          for (const cr of p.text.commandRuns) {
            const be = cr && cr.onTap && cr.onTap.browseEndpoint;
            if (be && be.browseId && /^UC[A-Za-z0-9_-]{20,}$/.test(be.browseId)) channelId = be.browseId;
          }
        }
      }
    }

    /* Channel avatar (search-related lockups) */
    let channelAvatar = '';
    if (md && md.image && md.image.decoratedAvatarViewModel && md.image.decoratedAvatarViewModel.avatar) {
      const av = md.image.decoratedAvatarViewModel.avatar.avatarViewModel;
      if (av && av.image && av.image.sources) channelAvatar = pickThumb(av.image.sources);
    }

    /* best-effort channelId via regex (related-video lockups) */
    if (!channelId) {
      try {
        const cidm = /"browseId":"(UC[A-Za-z0-9_-]{20,})"/.exec(JSON.stringify(vm));
        if (cidm) channelId = cidm[1];
      } catch (e) {}
    }

    /* Duration: thumbnail badge inside overlays ("12:28") */
    let duration = '';
    if (tv && tv.overlays) {
      const badges = [];
      (function hunt(n) {
        if (!n || typeof n !== 'object') return;
        if (n.thumbnailBadgeViewModel && n.thumbnailBadgeViewModel.text) {
          badges.push(typeof n.thumbnailBadgeViewModel.text === 'string'
            ? n.thumbnailBadgeViewModel.text
            : textOf(n.thumbnailBadgeViewModel.text));
        }
        for (const k in n) { const v = n[k]; if (v && typeof v === 'object') hunt(v); }
      })(tv.overlays);
      for (const b of badges) {
        if (/^\d+(:\d+)+$/.test(b) || /^LIVE$/i.test(b)) { duration = b; break; }
      }
    }

    return { id, title, thumb, channel, channelId, channelAvatar, duration, views, date, description: '' };
  } catch (e) {
    return null;
  }
}

/* Shorts shelf item. entityId like "shorts-shorts-item-VIDEOID". */
function extractShortsLockup(sl) {
  try {
    if (!sl) return null;
    const id = String(sl.entityId || '').split('-').pop();
    if (!isValidVideoId(id)) return null;
    const om = sl.overlayMetadata || {};
    const title = (om.primaryText && textOf(om.primaryText)) ||
      String(sl.accessibilityText || '').split('|')[0].trim() || '';
    const views = (om.secondaryText && textOf(om.secondaryText)) || '';
    const tv = sl.thumbnailViewModel;
    const thumb = (tv && tv.image && pickThumb(tv.image.sources))
      || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg');
    return { id, title, thumb, channel: '', channelId: '', duration: '', views, date: '', description: '' };
  } catch (e) {
    return null;
  }
}

/* ----- channel page ------------------------------------------------ *
 * Modern channel pages (2024/2025):
 *   - data.metadata.channelMetadataRenderer → canonical id, title,
 *     avatar, description, vanity handle
 *   - data.header.pageHeaderRenderer.content.pageHeaderViewModel →
 *     title, avatar, metadata rows: ["@handle", "1.2M subscribers",
 *     "1.8K videos"], description preview
 *   - videos tab: richItemRenderer → lockupViewModel (VIDEO only)
 *   - legacy fallback: c4TabbedHeaderRenderer + gridVideoRenderer */
function parseChannel(html) {
  const data = extractYtInitialData(html);
  if (!data) return { header: {}, videos: [] };

  const header = {};

  /* 1. channelMetadataRenderer — the canonical source */
  try {
    const md = data.metadata && data.metadata.channelMetadataRenderer;
    if (md) {
      header.id = md.externalId || '';
      header.title = md.title || '';
      header.desc = md.description || '';
      if (md.avatar && md.avatar.thumbnails) header.avatar = pickThumb(md.avatar.thumbnails);
      if (md.vanityChannelUrl) {
        const m = /\/(@[^\/\?#]+)/.exec(md.vanityChannelUrl);
        if (m) header.handle = m[1];
      }
      if (md.channelUrl) {
        const m = /channel\/([A-Za-z0-9_-]+)/.exec(md.channelUrl);
        if (m && !header.id) header.id = m[1];
      }
    }
  } catch (e) {}

  /* 2. pageHeaderViewModel — subs / videos count / avatar / handle */
  try {
    const phv = findFirst(data, 'pageHeaderViewModel');
    if (phv) {
      if (!header.title) {
        header.title = textOf(phv.title && (phv.title.dynamicTextViewModel ?
          phv.title.dynamicTextViewModel.text : phv.title)) || '';
      }
      if (!header.avatar) {
        const av = findFirst(phv, 'avatarViewModel');
        if (av && av.image && av.image.sources) header.avatar = pickThumb(av.image.sources);
      }
      if (!header.desc) {
        const dp = phv.description && phv.description.descriptionPreviewViewModel;
        if (dp && dp.description) header.desc = dp.description.content || '';
      }
      const rows = phv.metadata && phv.metadata.contentMetadataViewModel &&
        phv.metadata.contentMetadataViewModel.metadataRows || [];
      for (const row of rows) {
        for (const p of (row.metadataParts || [])) {
          const t = p.text ? textOf(p.text) : '';
          if (!t) continue;
          if (/subscriber/i.test(t) && !header.subs) header.subs = t;
          else if (/videos$/i.test(t) && !header.videosCount) header.videosCount = t;
          else if (t.indexOf('@') === 0 && !header.handle) header.handle = t;
        }
      }
    }
  } catch (e) {}

  /* 3. legacy c4TabbedHeaderRenderer fallback */
  try {
    const c4 = findFirst(data, 'c4TabbedHeaderRenderer');
    if (c4) {
      if (!header.id && c4.channelId) header.id = c4.channelId;
      if (!header.title && c4.title) header.title = c4.title;
      if (!header.avatar && c4.avatar && c4.avatar.thumbnails) header.avatar = pickThumb(c4.avatar.thumbnails);
      if (!header.subs && c4.subscriberCountText) header.subs = textOf(c4.subscriberCountText);
    }
  } catch (e) {}

  /* 4. banner (best-effort, both shapes) */
  try {
    const banner = findFirst(data, 'imageBannerViewModel');
    if (banner && banner.image && banner.image.sources) header.banner = pickThumb(banner.image.sources);
    if (!header.banner) {
      const b2 = findFirst(data, 'banner');
      if (b2 && b2.thumbnails) header.banner = pickThumb(b2.thumbnails);
    }
  } catch (e) {}

  if (header.id) header.url = 'https://www.youtube.com/channel/' + header.id;

  /* 5. videos — walk the whole tree (lockups + legacy renderers).
     Filter to VIDEO lockups happens inside extractLockupViewModel,
     so playlist lockups (shown on no-video channels) are skipped. */
  const videos = collectVideos(data, null, 60);

  /* On channel pages the lockups carry no channel row — inject the
     header info so the frontend cards show the right channel. */
  if (header.title || header.id) {
    for (const v of videos) {
      if (!v.channel) v.channel = header.title || '';
      if (!v.channelId) v.channelId = header.id || '';
    }
  }

  return { header, videos };
}

/* ----- video metadata via full /watch page parse ------------------- *
 * Returns: { id, title, description, views, date, duration, thumb,
 *           channel: { id, name, avatar, url, subs, handle },
 *           related: [video, video, ...] }
 *
 * IMPORTANT (2025): ytInitialPlayerResponse comes back with
 * playabilityStatus LOGIN_REQUIRED ("Sign in to confirm you're not a
 * bot") for logged-out scrapes — videoDetails is GONE. All metadata
 * now comes from ytInitialData:
 *   - videoPrimaryInfoRenderer   → title, viewCount, dateText
 *   - videoSecondaryInfoRenderer → owner (avatar/name/id/subs),
 *                                  attributedDescription */
function parseWatchPage(html, videoId) {
  const result = {
    id: videoId,
    title: '',
    description: '',
    views: '',
    date: '',
    duration: '',
    thumb: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg',
    channel: { id: '', name: '', avatar: '', url: '', subs: '', handle: '' },
    related: [],
  };

  const data = extractYtInitialData(html);
  if (!data) {
    /* last-resort: try player response (works on some pages) */
    const player = extractYtInitialPlayerResponse(html);
    if (player && player.videoDetails) applyVideoDetails(result, player.videoDetails);
    return result;
  }

  /* --- primary info: title / views / date --- */
  try {
    const pi = findFirst(data, 'videoPrimaryInfoRenderer');
    if (pi) {
      if (!result.title) result.title = textOf(pi.title);
      const vc = pi.viewCount && pi.viewCount.videoViewCountRenderer;
      if (vc && vc.viewCount) result.views = textOf(vc.viewCount) || result.views;
      if (pi.dateText) result.date = textOf(pi.dateText);
      if (pi.relativeDateText && !result.date) result.date = textOf(pi.relativeDateText);
    }
  } catch (e) {}

  /* --- secondary info: channel owner + description --- */
  try {
    const owner = findFirst(data, 'videoOwnerRenderer');
    if (owner) {
      if (owner.thumbnail && owner.thumbnail.thumbnails) {
        result.channel.avatar = pickThumb(owner.thumbnail.thumbnails);
      }
      if (owner.title && owner.title.runs) {
        result.channel.name = owner.title.runs.map(r => r.text).join('') || result.channel.name;
        const run0 = owner.title.runs[0];
        const nep = run0 && run0.navigationEndpoint;
        const be = nep && nep.browseEndpoint;
        if (be && be.browseId) result.channel.id = be.browseId;
        if (be && be.canonicalBaseUrl && String(be.canonicalBaseUrl).indexOf('/@') === 0) {
          result.channel.handle = be.canonicalBaseUrl.slice(1);
        }
      }
      if (owner.subscriberCountText) {
        result.channel.subs = textOf(owner.subscriberCountText);
      }
    }
  } catch (e) {}

  try {
    const si = findFirst(data, 'videoSecondaryInfoRenderer');
    if (si && si.attributedDescription && si.attributedDescription.content) {
      result.description = si.attributedDescription.content;
    } else if (si && si.description) {
      result.description = textOf(si.description);
    }
  } catch (e) {}

  /* --- player response: still try videoDetails (works when YouTube
         serves a full player response; harmless when it doesn't) --- */
  try {
    const player = extractYtInitialPlayerResponse(html);
    if (player && player.videoDetails) applyVideoDetails(result, player.videoDetails);
    const mf = player && player.microformat && player.microformat.playerMicroformatRenderer;
    if (mf) {
      if (!result.date) result.date = mf.publishDate || mf.uploadDate || '';
      if (!result.channel.id && mf.externalChannelId) result.channel.id = mf.externalChannelId;
    }
  } catch (e) {}

  /* --- related videos: walk the whole tree (lockups + compact +
         shorts shelves), excluding the current video --- */
  result.related = collectVideos(data, videoId, 24);

  if (result.channel.id) result.channel.url = 'https://www.youtube.com/channel/' + result.channel.id;
  return result;
}

function applyVideoDetails(result, vd) {
  if (!result.title) result.title = vd.title || '';
  if (!result.description) result.description = vd.shortDescription || '';
  if (!result.views && vd.viewCount) result.views = parseInt(vd.viewCount, 10).toLocaleString('en-US') + ' views';
  if (!result.channel.id) result.channel.id = vd.channelId || '';
  if (!result.channel.name) result.channel.name = vd.author || '';
  if (vd.thumbnail && vd.thumbnail.thumbnails && vd.thumbnail.thumbnails.length) {
    result.thumb = vd.thumbnail.thumbnails[vd.thumbnail.thumbnails.length - 1].url;
  }
}

/* Metadata from a /results?search_query={videoId} page — the fallback
   that keeps working when /watch is 429-throttled. Finds the exact
   videoRenderer for our id (title/channelId/views/date/duration);
   the other search results become the related list. */
function parseSearchVideoMeta(data, videoId) {
  const result = {
    id: videoId,
    title: '',
    description: '',
    views: '',
    date: '',
    duration: '',
    thumb: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg',
    channel: { id: '', name: '', avatar: '', url: '', subs: '', handle: '' },
    related: [],
    minimal: true,
  };
  if (!data) return result;

  /* exact video card for this id */
  let mine = null;
  const q = [data];
  while (q.length && !mine) {
    const n = q.shift();
    if (!n || typeof n !== 'object') continue;
    if (n.videoRenderer && n.videoRenderer.videoId === videoId) { mine = n.videoRenderer; break; }
    if (n.compactVideoRenderer && n.compactVideoRenderer.videoId === videoId) { mine = n.compactVideoRenderer; break; }
    for (const k in n) if (n[k] && typeof n[k] === 'object') q.push(n[k]);
  }
  if (!mine) return result;

  try {
    const v = extractVideoRenderer(mine);
    if (v) {
      result.title = v.title || '';
      result.views = v.views || '';
      result.date = v.date || '';
      result.duration = v.duration || '';
      result.channel.id = v.channelId || '';
      result.channel.name = v.channel || '';
      if (result.channel.id) result.channel.url = 'https://www.youtube.com/channel/' + result.channel.id;
    }
  } catch (e) {}

  /* the rest of the results as "Up next" */
  result.related = collectVideos(data, videoId, 24);
  return result;
}

/* =====================================================================
   v1.2 — FALLBACK SOURCES (Piped + innertube) + DOWNLOADS
   =====================================================================
   YouTube 429-throttles /watch scrapes from many datacenter IPs. When
   that happens we get our data from elsewhere instead of failing:

     - Piped API instances: metadata, related videos, search, trending,
       and (on some instances) downloadable stream URLs.
     - YouTube innertube API, ANDROID_VR client: videoDetails +
       DECIPHERED direct googlevideo stream URLs (works without PO
       tokens). Also /next for related videos.

   Everything below maps those sources onto the SAME response shapes
   the app already consumes, so the frontend needs no changes. */

/* Piped: GET /streams/{id} — parallel race (first valid payload wins) */
async function pipedStreams(videoId) {
  try {
    return await pipedGet('/streams/' + encodeURIComponent(videoId),
      j => j && (j.title || j.relatedStreams), 6000);
  } catch (e) { return null; }
}

/* Piped: GET /search?q=...&filter=videos */
async function pipedSearch(q) {
  try {
    const j = await pipedGet('/search?q=' + encodeURIComponent(q) + '&filter=videos',
      jj => jj && Array.isArray(jj.items) && jj.items.length, 6000);
    return j.items
      .filter(x => x && (x.url || '').includes('watch?v='))
      .map(pipedItemToVideo)
      .slice(0, 40);
  } catch (e) { return []; }
}

/* Piped: GET /trending?region=US */
async function pipedTrending() {
  try {
    const j = await pipedGet('/trending?region=US', Array.isArray, 6000);
    return j.filter(x => x && (x.url || '').includes('watch?v=')).map(pipedItemToVideo);
  } catch (e) { return []; }
}

/* ----- Piped channel tier (ported from the Relay app) -------------- *
 * pipedResolveHandle: @handle / vanity name → UC channel id, via
 * Piped's channel search (filter=channels). Mirrors Relay's
 * pipedChannelByHandle: exact/prefix name match, else first hit. */
async function pipedResolveHandle(handleRaw) {
  const handle = String(handleRaw || '')
    .replace(/^https?:\/\/[^\/]+\//i, '')
    .replace(/^(c\/|user\/|channel\/)/i, '')
    .replace(/^@/, '')
    .replace(/\/$/, '')
    .trim();
  if (!handle) return null;
  const j = await pipedGet('/search?q=' + encodeURIComponent(handle) + '&filter=channels',
    jj => jj && Array.isArray(jj.items) && jj.items.length, 6000);
  const items = (j && j.items) || [];
  const want = handle.toLowerCase().replace(/\s+/g, '');
  const hit = items.find(it => {
    const nm = String((it && it.name) || '').toLowerCase().replace(/\s+/g, '');
    return nm === want || nm.indexOf(want) === 0;
  }) || items[0];
  if (!hit) return null;
  const m = /\/channel\/(UC[A-Za-z0-9_-]{18,30})/.exec(String(hit.url || ''));
  return m ? m[1] : null;
}

/* Map a Piped /channel/{id} payload onto the app's channel-page shape.
 * Same response contract as parseChannel(): { header, videos }. */
function pipedToChannel(j, chId) {
  const chUrl = 'https://www.youtube.com/channel/' + chId;
  const videos = (j.relatedStreams || [])
    .map(it => {
      const v = pipedItemToVideo(it);
      if (!v.id) return null;
      if (!v.channel) v.channel = j.name || '';
      if (!v.channelId) v.channelId = chId;
      return v;
    })
    .filter(Boolean)
    .slice(0, 30);
  return {
    source: 'piped',
    header: {
      id: chId,
      title: j.name || '',
      subs: fmtSubs(j.subscriberCount),
      avatar: j.avatarUrl || '',
      desc: String(j.description || '').slice(0, 400),
      handle: '',
      banner: '',
      url: chUrl,
    },
    videos,
  };
}

/* Map a Piped search-with-channels-filter item onto a channel chip. */
function pipedItemToChannel(it) {
  if (!it) return null;
  const m = /\/channel\/(UC[A-Za-z0-9_-]{18,30})/.exec(String(it.url || ''));
  if (!m) return null;
  return {
    id: m[1],
    name: it.name || '',
    subs: fmtSubs(it.subscribers),
    avatar: it.thumbnail || '',
    desc: String(it.description || '').slice(0, 120),
  };
}

/* oEmbed — the cheapest metadata source on YouTube (no auth, no
 * throttling). Gives title + channel name/url + thumbnail; enough to
 * render a working watch page when everything else fails. */
async function oembedVideo(id) {
  const r = await fetchTimeout(
    'https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id) + '&format=json',
    { headers: { Accept: 'application/json' } }, 5000);
  if (!r.ok) throw new Error('oembed http ' + r.status);
  const j = await r.json();
  if (!j || !j.title) throw new Error('oembed empty');
  const chUrl = j.author_url || '';
  const m = /\/channel\/(UC[A-Za-z0-9_-]{18,30})/.exec(chUrl);
  return {
    id,
    title: j.title,
    description: '',
    views: '',
    date: '',
    duration: '',
    thumb: j.thumbnail_url || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'),
    channel: {
      id: m ? m[1] : '',
      name: j.author_name || '',
      avatar: '',
      subs: '',
      handle: '',
      url: chUrl,
    },
    related: [],
    minimal: true,
  };
}

/* ----- tiny in-memory TTL cache (per isolate) ---------------------- *
 * Softens repeated hammering of the same video/channel within a few
 * minutes (back navigation, subs refresh). Cheap Map + size cap. */
const MEM_CACHE = new Map();
const MEM_CACHE_MAX = 120;
function cacheGet(key) {
  const e = MEM_CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { MEM_CACHE.delete(key); return null; }
  return e.val;
}
function cacheSet(key, val, ttlMs) {
  try {
    if (MEM_CACHE.size >= MEM_CACHE_MAX) {
      /* drop the oldest entry (insertion order = roughly oldest first) */
      const firstKey = MEM_CACHE.keys().next().value;
      MEM_CACHE.delete(firstKey);
    }
    MEM_CACHE.set(key, { val, exp: Date.now() + (ttlMs || 60000) });
  } catch (e) { /* cache must never break a response */ }
}

/* innertube: ANDROID_VR player call. Returns the raw player response
   (videoDetails + streamingData with direct URLs). `ms` caps the
   wait (downloads pass a tighter budget so fallbacks engage fast). */
async function innertubePlayer(videoId, ms) {
  const r = await fetchTimeout('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': VR_UA },
    body: JSON.stringify({ context: VR_CONTEXT, videoId, contentCheckOk: true, racyCheckOk: true }),
  }, ms || 12000);
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

/* innertube: /next (related videos) with the same VR client. */
async function innertubeNext(videoId) {
  try {
    const r = await fetchTimeout('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': VR_UA },
      body: JSON.stringify({ context: VR_CONTEXT, videoId }),
    }, 12000);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/* Map a Piped /streams response onto the app's watch-page shape. */
function pipedToVideo(pd, id) {
  const chId = chIdFromPipedUrl(pd.uploaderUrl);
  const related = (pd.relatedStreams || [])
    .filter(x => x && (x.url || '').includes('watch?v='))
    .map(pipedItemToVideo)
    .slice(0, 24);
  return {
    id,
    title: pd.title || '',
    description: pd.description || '',
    views: typeof pd.views === 'number' ? pd.views.toLocaleString('en-US') + ' views' : '',
    date: pd.uploadDate || pd.uploadedDate || '',
    duration: fmtDuration(pd.duration),
    thumb: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
    channel: {
      id: chId,
      name: pd.uploader || '',
      avatar: pd.uploaderAvatar || '',
      subs: fmtSubs(pd.uploaderSubscriberCount),
      url: chId ? 'https://www.youtube.com/channel/' + chId : '',
    },
    related,
  };
}

/* Map a Piped feed item (search result / related stream / trending)
   onto the app's video-card shape. */
function pipedItemToVideo(x) {
  const id = videoIdFromPipedUrl(x.url);
  const chId = chIdFromPipedUrl(x.uploaderUrl);
  return {
    id,
    title: x.title || '',
    thumb: x.thumbnail && /^https?:/.test(x.thumbnail)
      ? 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'
      : 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
    channel: x.uploader || '',
    channelId: chId,
    duration: fmtDuration(x.duration),
    views: typeof x.views === 'number' ? x.views.toLocaleString('en-US') + ' views' : (x.views > 0 ? x.views + ' views' : ''),
    date: x.uploadedDate || (typeof x.uploaded === 'number' ? new Date(x.uploaded).toLocaleDateString('en-US') : ''),
  };
}

/* Map innertube videoDetails + /next related onto the watch shape. */
async function innertubeToVideo(iv, id) {
  const vd = iv.videoDetails || {};
  const chId = vd.channelId || '';
  let related = [];
  const nx = await innertubeNext(id);
  if (nx) related = collectVideos(nx, id, 24);
  return {
    id,
    title: vd.title || '',
    description: vd.shortDescription || '',
    views: vd.viewCount ? parseInt(vd.viewCount, 10).toLocaleString('en-US') + ' views' : '',
    date: (iv && iv.microformat && iv.microformat.playerMicroformatRenderer &&
      (iv.microformat.playerMicroformatRenderer.publishDate || iv.microformat.playerMicroformatRenderer.uploadDate)) || '',
    duration: fmtDuration(parseInt(vd.lengthSeconds || '0', 10)),
    thumb: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
    channel: {
      id: chId,
      name: vd.author || '',
      avatar: '',
      subs: '',
      url: chId ? 'https://www.youtube.com/channel/' + chId : '',
    },
    related,
  };
}

/* ----- /__yt/dl — download handler -------------------------------- *
 * Streams the media THROUGH this worker so the user's browser only
 * ever talks to the worker domain (the direct URLs are unreachable
 * for many users). Range requests are passed through so resumable
 * downloads and media seeking keep working. */
async function handleDownload(url, request) {
  const id = (url.searchParams.get('id') || '').trim();
  const type = (url.searchParams.get('type') || 'video').trim().toLowerCase();
  const titleParam = url.searchParams.get('title') || '';
  if (!id) return json({ error: 'missing id' }, { status: 400 });
  if (type !== 'audio' && type !== 'video') return json({ error: 'type must be audio or video' }, { status: 400 });

  let stream = null; /* { url, mime, title } */
  let why = '';

  /* 1) innertube ANDROID_VR — direct googlevideo URLs (deciphered).
     8s cap: this normally answers in well under a second; when YouTube
     throttles it we want the Piped tier to take over QUICKLY (the old
     12s cap + sequential Piped walk is why downloads hung for a minute). */
  try {
    const iv = await innertubePlayer(id, 8000);
    if (iv && iv.streamingData) {
      const title = (iv.videoDetails && iv.videoDetails.title) || titleParam || 'video';
      const formats = [
        ...((iv.streamingData.formats || [])),
        ...((iv.streamingData.adaptiveFormats || [])),
      ].filter(f => f && f.url);
      if (type === 'audio') {
        const audio = formats
          .filter(f => (f.mimeType || '').startsWith('audio'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const m4a = audio.find(f => (f.mimeType || '').includes('audio/mp4'));
        const pick = m4a || audio[0];
        if (pick) stream = { url: pick.url, mime: 'audio/mp4', title };
        else why = 'innertube returned no audio formats';
      } else {
        /* progressive = audio+video muxed (itag 18 = 360p, sometimes 22
           = 720p). adaptiveFormats are video-only (unwatchable alone). */
        const prog = (iv.streamingData.formats || [])
          .filter(f => f.url && (f.mimeType || '').startsWith('video/') && (f.mimeType || '').includes('mp4'))
          .sort((a, b) => (b.width || 0) - (a.width || 0));
        const pick = prog[0];
        if (pick) stream = { url: pick.url, mime: 'video/mp4', title };
        else why = 'innertube returned no progressive MP4';
      }
    } else {
      why = 'innertube player unavailable (age/music-restricted or throttled)';
    }
  } catch (e) { why = 'innertube error: ' + (e && e.message); }

  /* 2) Piped instance streams — RACED IN PARALLEL (v1.3), ~6s worst
     case. Piped proxy URLs work cross-IP; LBRY mirrors (odycdn) are
     muxed MP4s that keep video downloads working even when YouTube
     serves no muxed format to datacenter IPs. */
  if (!stream) {
    try {
      const pd = await pipedStreams(id);
      if (pd) {
        const title = pd.title || titleParam || 'video';
        if (type === 'audio') {
          const audio = (pd.audioStreams || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (audio.length) {
            const a = audio.find(x => (x.mimeType || '').includes('audio/mp4')) || audio[0];
            stream = { url: a.url, mime: (a.mimeType || 'audio/mp4').split(';')[0], title };
          } else if (pd.hls) {
            /* some instances fold audio into HLS only — not downloadable */
            why = 'piped returned HLS only';
          }
        } else {
          const qn = (v) => parseInt(String(v.quality || '').replace(/[^0-9]/g, ''), 10) || 0;
          const muxed = (pd.videoStreams || [])
            .filter(v => v.videoOnly === false && (v.mimeType || '').includes('mp4'))
            .sort((a, b) => qn(b) - qn(a));
          if (muxed.length) {
            stream = { url: muxed[0].url, mime: 'video/mp4', title };
          } else {
            /* LBRY mirror — muxed mp4 hosted on odycdn, cross-IP OK */
            const lbry = (pd.videoStreams || []).find(v =>
              (v.videoOnly === false) &&
              /mp4/i.test(v.mimeType || '') &&
              /odycdn|lbry/i.test(v.url || ''));
            if (lbry) stream = { url: lbry.url, mime: 'video/mp4', title };
            else why = why || 'no muxed mp4 on any source';
          }
        }
      }
    } catch (e) { /* fall through */ }
  }

  if (!stream) {
    return json({
      error: type === 'audio'
        ? 'No audio-only stream available for this video (YouTube requires sign-in for it). Try the Video download — it includes sound.'
        : 'No downloadable video stream found for this video. ' + why,
    }, { status: 502 });
  }

  /* filename: sanitized title + extension from mime */
  const ext = (stream.mime || '').includes('audio') ? '.m4a' : '.mp4';
  const filename = sanitizeFilename(stream.title || titleParam || 'download') + ext;

  /* fetch upstream, passing the browser's Range header through.
     CRITICAL v1.3 fix: googlevideo THROTTLES rangeless adaptive-audio
     requests to ~16KB/s (the download "hang"). Always asking for
     "bytes=0-" — even when the browser sent no Range — makes
     googlevideo serve the full file at full speed (206 + Content-Range
     pass straight through to the client). 25s cap on the first byte. */
  const upHeaders = { Range: 'bytes=0-' };
  const range = request && request.headers.get('Range');
  if (range) upHeaders['Range'] = range;
  const r = await fetchTimeout(stream.url, { headers: upHeaders, redirect: 'follow' }, 25000);
  if (!r.ok && r.status !== 206) {
    /* one retry — googlevideo occasionally 403s a first hit */
    let r2 = null;
    try { r2 = await fetchTimeout(stream.url, { headers: upHeaders, redirect: 'follow' }, 25000); } catch (e2) { r2 = null; }
    if (!r2 || (!r2.ok && r2.status !== 206)) {
      return json({ error: 'stream fetch failed (' + (r2 ? r2.status : r.status) + ') — try again' }, { status: 502 });
    }
    return streamResponse(r2, stream.mime, filename);
  }
  return streamResponse(r, stream.mime, filename);
}

function streamResponse(r, mime, filename) {
  const out = new Headers({
    'Content-Type': mime || 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control': 'no-store',
  });
  for (const h of ['Content-Length', 'Content-Range', 'Accept-Ranges']) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const [k, v] of Object.entries(CORS)) out.set(k, v);
  /* let the app read these cross-origin (download progress / filename) */
  out.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition, Accept-Ranges');

  /* stream the body straight through the worker */
  return new Response(r.body, { status: r.status, headers: out });
}

/* ----- small format helpers --------------------------------------- */
function videoIdFromPipedUrl(u) {
  if (!u) return '';
  const m = /[?&]v=([\w-]{6,})/.exec(u) || /^\/?watch\?v=([\w-]{6,})/.exec(u);
  return m ? m[1] : '';
}
function chIdFromPipedUrl(u) {
  if (!u) return '';
  const m = /^\/?(?:channel\/)?(UC[\w-]{20,})/.exec(u);
  return m ? m[1] : '';
}
function fmtDuration(sec) {
  sec = parseInt(sec, 10);
  if (!sec || sec < 0) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
       : m + ':' + String(s).padStart(2, '0');
}
function fmtSubs(n) {
  if (typeof n === 'string') return n; /* already formatted text */
  if (typeof n !== 'number' || n <= 0) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B subscribers';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M subscribers';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K subscribers';
  return n + ' subscribers';
}
function sanitizeFilename(name) {
  return String(name)
    .replace(/[\r\n\/\\]+/g, ' ')
    .replace(/[^\w\s.\-()&'\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'download';
}

/* =================================================================== *
 * EZCONV PROXY (v1.4) — the Relay-style single-site proxy browser.
 * The app's Download button opens /__ez/en/k7x2?url=<video link> on
 * this worker; the real ezconv.cc boots, entirely through the worker:
 *
 *   /__ez/<path>      → EZ_SITE pages/assets  (HTML + JS rewritten)
 *   /__ezapi/<path>   → EZ_API                (attest/convert/status)
 *   /__ezdl/<h>/<p>   → dl*.ezsrv.net         (converted file download)
 *   /<anything else>  → 302 → /__ez/…         (SPA safety net, above)
 *
 * Rewriting rules, in order:
 *   HTML  — src="/x" / href="/x"  → prefixed with /__ez
 *           https://ezconv.cc/x   → /__ez/x
 *           + a ?url= prefill script (pastes the video link into the
 *             converter input for the user)
 *   JS    — "https://api.ezsrv.net"     → <origin>/__ezapi
 *           "https://ezconv.cc"         → <origin>/__ez
 *           (turnstile + fonts + oembed stay direct — they must)
 *   JSON  — "https://dl2.ezsrv.net/…"   → <origin>/__ezdl/dl2.ezsrv.net/…
 *           so the Download button on the page hits the worker, which
 *           relays the bytes as a real attachment.
 * =================================================================== */

/* build the upstream request for an ezconv upstream, forwarding the
 * Next.js RSC headers + body so SPA navigation and POSTs survive */
function ezUpstreamInit(url, request, origin, referer) {
  const headers = new Headers();
  for (const name of EZ_FORWARD_REQ) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set('User-Agent', request.headers.get('user-agent') ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  headers.set('Origin', origin);
  if (referer) headers.set('Referer', referer);
  if (!headers.get('Accept')) headers.set('Accept', '*/*');
  if (!headers.get('Accept-Language')) headers.set('Accept-Language', 'en-US,en;q=0.9');
  const init = {
    method: (request.method === 'OPTIONS') ? 'GET' : request.method,
    headers,
    redirect: 'manual',
    credentials: 'omit',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
    init.body = request.body;
    init.duplex = 'half';
  }
  return init;
}

/* rebuild a proxied response: strip frame-blocking / cache-busting
 * headers, add permissive CORS, keep the content intact */
function ezRebuild(res, extra) {
  const out = new Headers();
  const STRIP = new Set([
    'content-security-policy', 'content-security-policy-report-only',
    'x-frame-options', 'strict-transport-security', 'report-to', 'nel',
    'set-cookie', 'set-cookie2', 'alt-svc', 'cross-origin-opener-policy',
    'cross-origin-embedder-policy', 'cross-origin-resource-policy',
    'content-encoding', 'content-length', 'transfer-encoding',
    'permissions-policy', 'feature-policy', 'x-content-type-options',
    'cf-ray', 'cf-cache-status', 'server', 'reporting-endpoints',
  ]);
  res.headers.forEach((v, k) => { if (!STRIP.has(k.toLowerCase())) out.set(k, v); });
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  out.set('Access-Control-Allow-Headers', '*');
  if (extra) for (const k in extra) out.set(k, extra[k]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

/* ---- the prefill script injected into served HTML ---------------- *
 * The app opens /__ez/en/k7x2?url=<youtube link>. This script waits
 * for the converter's <input> to exist, sets its value the way React
 * needs (native setter + input event), and KEEPS RE-DISPATCHING until
 * React actually ingests it — the input exists in the SSR HTML before
 * hydration, so a single early event is swallowed and the Convert
 * button stays disabled. We stop as soon as the Convert button turns
 * enabled (state caught up), or after ~20s. The link is also in the
 * clipboard; this just saves the paste entirely. */
const EZ_PREFILL = [
  '<script>(function(){try{',
  'var m=/[?&]url=([^&]+)/.exec(location.search);if(!m)return;',
  'var u=decodeURIComponent(m[1]);if(!/^https?:\\/\\//.test(u))return;',
  'var n=0,ok=false;var t=setInterval(function(){n++;',
  'var inp=document.querySelector(\'input[inputmode="url"],input[placeholder*="youtube"],input[placeholder*="paste"]\');',
  'if(inp){try{',
  'var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,\'value\').set;',
  'if(inp.value!==u)set.call(inp,u);',
  'inp.dispatchEvent(new Event(\'input\',{bubbles:true}));',
  'inp.dispatchEvent(new Event(\'change\',{bubbles:true}));',
  'var bs=document.querySelectorAll(\'button[type="submit"]\');',
  'for(var i=0;i<bs.length;i++){var b=bs[i];',
  'if(/convert|download|start/i.test(b.textContent||b.innerText||\'\')&&!b.disabled){ok=true;break}}',
  '}catch(e){try{inp.value=u}catch(e2){}}',
  'if(ok||n>80)clearInterval(t);',
  '}else if(n>80){clearInterval(t)}},250);',
  '}catch(e){}})();</' + 'script>',
].join('');

/* prefix root-relative attribute URLs in served HTML.
 * Only matches real attribute syntax (src=" / href=" / action=") — the
 * escaped JSON inside self.__next_f payloads uses \" so it never
 * matches, and full URLs / data: / # stay untouched. */
function ezRewriteHtml(html, origin) {
  let out = html;
  const rootAttr = /(\s(?:src|href|action|poster)=")(\/(?!\/)[^"]*)(")/g;
  out = out.replace(rootAttr, (m, a, p, q) => a + EZ_PREFIX + p + q);
  /* absolute ezconv.cc URLs → inside the proxy (canonical, og:url,
     any router-level redirects baked into the HTML) */
  out = out.split(EZ_SITE + '/').join(origin + EZ_PREFIX + '/');
  out = out.split('"' + EZ_SITE + '"').join('"' + origin + EZ_PREFIX + '"');
  /* inject the prefill helper right after <head> so it runs first */
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + EZ_PREFILL);
  else out = EZ_PREFILL + out;
  return out;
}

/* rewrite the site's JS so the runtime calls land on this worker.
 *  - the API base constant ("https://api.ezsrv.net") → /__ezapi
 *  - absolute ezconv.cc references                → /__ez
 * Turnstile (challenges.cloudflare.com), fonts, and YouTube oembed
 * stay DIRECT on purpose: they need the real browser, and the oembed
 * endpoint reflects any origin so it works from the worker page. */
function ezRewriteJs(txt, origin) {
  let out = txt;
  out = out.split('"' + EZ_API + '"').join('"' + origin + EZ_API_PREFIX + '"');
  out = out.split("'" + EZ_API + "'").join("'" + origin + EZ_API_PREFIX + "'");
  out = out.split('"' + EZ_SITE + '"').join('"' + origin + EZ_PREFIX + '"');
  out = out.split("'" + EZ_SITE + "'").join("'" + origin + EZ_PREFIX + "'");
  return out;
}

/* rewrite JSON bodies (convert/status): point downloadUrl at the relay */
function ezRewriteJson(txt, origin) {
  let out = txt;
  /* dl2.ezsrv.net/download?sig=… → /__ezdl/dl2.ezsrv.net/download?sig=…
   * (any dl* host; plus a generic catch for other ezsrv download CDNs.
   *  api.ezsrv.net must NOT be caught here — that tier lives at /__ezapi) */
  out = out.replace(/https?:\/\/(dl[a-z0-9-]*\.ezsrv\.net)\//gi,
    (m, host) => origin + EZ_DL_PREFIX + '/' + host.toLowerCase() + '/');
  out = out.replace(/https?:\/\/([a-z0-9.-]+\.ezsrv\.net)\/(download|file|get)\//gi,
    (m, host, seg) => origin + EZ_DL_PREFIX + '/' + host.toLowerCase() + '/' + seg + '/');
  return out;
}

/* ---- site tier: /__ez/<path> → https://ezconv.cc/<path> ---------- *
 * Serves pages, /_next assets, the manifest, favicon — everything.
 * HTML and JS get rewritten; RSC responses (text/x-component) pass
 * through untouched because the router parses them verbatim. */
async function ezSiteProxy(url, request) {
  const origin = url.origin;
  const sub = url.pathname.slice(EZ_PREFIX.length) || '/'; /* "/en/k7x2" */
  const target = EZ_SITE + sub + (url.search || '');

  /* hop through ezconv.cc's own redirects (e.g. / → /en/k7x2) */
  let res, hops = 0, finalPath = sub;
  let next = target;
  while (hops < 5) {
    res = await fetch(next, ezUpstreamInit(url, request, EZ_SITE, EZ_SITE + '/'));
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      let abs;
      try { abs = new URL(loc, next); } catch (e) { break; }
      if (abs.origin !== EZ_SITE) {
        /* off-site redirect (shouldn't happen) — just follow it */
        res = await fetch(abs.href, ezUpstreamInit(url, request, EZ_SITE, EZ_SITE + '/'));
        break;
      }
      finalPath = abs.pathname;
      next = EZ_SITE + abs.pathname + abs.search;
      hops++;
      continue;
    }
    break;
  }
  /* if the final path differs, redirect the browser to the matching
     proxied URL so relative asset resolution stays correct */
  if (finalPath !== sub && request.method === 'GET') {
    return new Response(null, {
      status: 302,
      headers: { Location: EZ_PREFIX + finalPath + (url.search || ''), 'Access-Control-Allow-Origin': '*' },
    });
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const isHtml = ct.includes('text/html');
  const isJs = ct.includes('javascript') || ct.includes('ecmascript') || /\.m?js$/i.test(sub);

  /* cache static assets on the edge (the relay's trick: chunked Next.js
   * builds are content-hashed, so caching is safe and instant) */
  const cacheable = request.method === 'GET' && res.status === 200 &&
    (ct.startsWith('image/') || ct.startsWith('font/') || ct.startsWith('audio/') ||
     ct.startsWith('video/') || isJs || ct.includes('text/css'));

  if (cacheable) {
    try {
      if (typeof caches !== 'undefined' && caches.default) {
        const hit = await caches.default.match(url.href);
        if (hit) {
          const hd = new Headers(hit.headers);
          hd.set('x-ez-cache', 'HIT');
          return new Response(hit.body, { status: hit.status, headers: hd });
        }
      }
    } catch (e) { /* cache API unavailable */ }
  }

  let out = res;
  if ((isHtml || isJs) && res.status === 200) {
    try {
      const txt = await res.text();
      const patched = isHtml ? ezRewriteHtml(txt, origin) : ezRewriteJs(txt, origin);
      const hdrs = new Headers();
      res.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (lk !== 'content-length' && lk !== 'content-encoding' && lk !== 'transfer-encoding') hdrs.set(k, v);
      });
      hdrs.set('Access-Control-Allow-Origin', '*');
      if (patched !== txt) hdrs.set('x-ez-rewritten', isHtml ? 'html' : 'js');
      out = new Response(patched, { status: res.status, statusText: res.statusText, headers: hdrs });
      if (cacheable && typeof caches !== 'undefined' && caches.default) {
        try {
          const put = caches.default.put(url.href, out.clone()).catch(() => {});
          if (EZ_CTX && EZ_CTX.waitUntil) { try { EZ_CTX.waitUntil(put); } catch (eW) {} }
          else void put;
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* body unreadable — serve as-is */ }
  } else {
    out = ezRebuild(res, {
      'Cache-Control': cacheable ? 'public, max-age=3600' : (res.headers.get('cache-control') || 'no-store'),
    });
    if (out.headers.get('content-type') === null) out.headers.set('Content-Type', 'application/octet-stream');
    if (cacheable && typeof caches !== 'undefined' && caches.default) {
      try {
        const put = caches.default.put(url.href, out.clone()).catch(() => {});
        if (EZ_CTX && EZ_CTX.waitUntil) { try { EZ_CTX.waitUntil(put); } catch (eW) {} }
        else void put;
      } catch (e) { /* ignore */ }
    }
  }
  if (isHtml && out.headers.get('cache-control') !== 'no-store') {
    out.headers.set('Cache-Control', 'no-store'); /* pages always fresh */
  }
  return out;
}

/* ---- API tier: /__ezapi/<path> → https://api.ezsrv.net/<path> ----- *
 * POST attest/convert, GET status — body passthrough, JSON download
 * URLs rewritten to the /__ezdl relay, CORS wide open. */
async function ezApiProxy(url, request) {
  const origin = url.origin;
  const sub = url.pathname.slice(EZ_API_PREFIX.length) || '/'; /* "/api/convert" */
  const target = EZ_API + sub + (url.search || '');

  const res = await fetch(target, ezUpstreamInit(url, request, EZ_SITE, EZ_SITE + '/'));
  const ct = (res.headers.get('content-type') || '').toLowerCase();

  if (res.status === 200 && ct.includes('application/json')) {
    try {
      const txt = await res.text();
      const patched = ezRewriteJson(txt, origin);
      const hdrs = new Headers();
      res.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (lk !== 'content-length' && lk !== 'content-encoding' && lk !== 'transfer-encoding') hdrs.set(k, v);
      });
      hdrs.set('Content-Type', 'application/json; charset=utf-8');
      hdrs.set('Access-Control-Allow-Origin', '*');
      hdrs.set('Cache-Control', 'no-store');
      if (patched !== txt) hdrs.set('x-ez-rewritten', 'json');
      return new Response(patched, { status: res.status, statusText: res.statusText, headers: hdrs });
    } catch (e) { /* fall through to passthrough */ }
  }
  return ezRebuild(res, { 'Cache-Control': 'no-store' });
}

/* ---- download tier: /__ezdl/<host>/<path> ------------------------- *
 * Streams converted MP3/MP4 files from dl*.ezsrv.net through the
 * worker: Range passthrough (seekable), Content-Disposition preserved
 * (the real filename), CORS open so the page can trigger the save.
 * Only *.ezsrv.net hosts are allowed — this is not an open proxy. */
async function ezDlProxy(url, request) {
  const rest = url.pathname.slice(EZ_DL_PREFIX.length + 1); /* "dl2.ezsrv.net/download" */
  const slash = rest.indexOf('/');
  if (slash < 1) return json({ error: 'expected /__ezdl/<host>/<path>' }, { status: 400 });
  const host = rest.slice(0, slash).toLowerCase();
  const pathPart = rest.slice(slash);
  if (!EZ_DL_HOST_RE.test(host)) {
    return json({ error: 'only ezsrv.net download hosts are proxied' }, { status: 403 });
  }
  const target = 'https://' + host + pathPart + (url.search || '');

  const headers = new Headers();
  for (const name of ['range', 'accept', 'accept-language']) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  headers.set('Referer', EZ_SITE + '/');

  const res = await fetch(target, { headers, redirect: 'follow', credentials: 'omit' });
  const out = new Headers();
  res.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk !== 'content-encoding' && lk !== 'transfer-encoding' && lk !== 'content-length' &&
        lk !== 'set-cookie' && lk !== 'strict-transport-security' && lk !== 'report-to' && lk !== 'nel') {
      out.set(k, v);
    }
  });
  /* keep the download an attachment no matter what upstream says */
  if (!out.get('Content-Disposition')) {
    const fn = decodeURIComponent((pathPart.split('/').pop() || 'download').split('?')[0]).slice(0, 120) || 'download';
    out.set('Content-Disposition', 'attachment; filename="' + fn.replace(/[\r\n"\\/]/g, '_') + '"');
  }
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
  out.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
