/* =====================================================================
   YT-ONLY WORKER v1.2 — a dedicated Cloudflare Worker purpose-built for
   the YT-Only app (the stripped-down YouTube-only player).

   Deploy on YOUR Cloudflare account (free tier is fine):
     1. dash.cloudflare.com → Workers & Pages → Create worker
     2. Name it (e.g. yt-only) → Edit code → paste this whole file
     3. Deploy → copy the URL (https://yt-only.YOU.workers.dev)
     4. In the app: Settings (gear) → paste the URL → Save → Test connection

   What this worker does:
     - /__yt/health           → version probe ("yt-only-ok/1.2")
     - /__yt/search?q=QUERY   → JSON { videos:[{id,title,channel,thumb,duration,...}] }
     - /__yt/video?id=VID     → JSON { id,title,description,views,date,channel,related }
     - /__yt/home             → JSON { videos:[...] } (popular feed)
     - /__yt/channel?id=|handle= → JSON { header, videos:[...] }
     - /__yt/dl?id=VID&type=audio|video → streams the file through this
       worker (Content-Disposition: attachment) so the browser downloads
       it directly from YOUR worker — no external site needed.
     - /__yt/img?url=URL      → passthrough image proxy
     - /__yt/proxy?url=URL    → generic CORS proxy

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
const VERSION = '1.2';
const HEALTH_TAG = 'yt-only-ok/' + VERSION;
const YT_HOME = 'https://www.youtube.com';

/* Home feed source. The logged-out homepage AND /feed/trending now
   return an empty shell (a single feedNudgeRenderer), but playlist
   pages still ship full ytInitialData with 100 video lockups.
   This is YouTube's official "Most Popular" playlist. */
const HOME_PLAYLIST = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';

/* Piped API instances, tried in order (video metadata fallback chain
   + download fallback). Public community instances; availability
   varies, so the worker walks the list until one answers. */
const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.drgns.space',
  'https://piapi.ggtyler.dev',
  'https://pipedapi.ducks.party',
];

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
      try {
        const html = await fetchUpstream(YT_HOME + '/results?search_query=' + encodeURIComponent(q) + '&hl=en&gl=US');
        const videos = collectVideos(extractYtInitialData(html));
        if (videos.length) return json({ query: q, videos });
      } catch (e) { /* fall through to Piped */ }
      const pv = await pipedSearch(q);
      return json({ query: q, videos: pv });
    }

    /* video metadata — full /watch page parse, with fallback chain -- */
    if (path === '/__yt/video') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!id) return json({ error: 'missing id' });
      let data = null, lastErr = null;
      /* 1) HTML scrape (richest data: banner, exact dates, subs) */
      try {
        const html = await fetchUpstream(YT_HOME + '/watch?v=' + encodeURIComponent(id) + '&hl=en');
        data = parseWatchPage(html, id);
      } catch (e) { lastErr = e; }
      /* 2) Piped API — works even when YouTube throttles our IP */
      if (!data || !data.title) {
        try {
          const pd = await pipedStreams(id);
          if (pd && pd.title) data = pipedToVideo(pd, id);
        } catch (e) { /* keep going */ }
      }
      /* 3) innertube ANDROID_VR player (metadata) + /next (related) */
      if (!data || !data.title) {
        try {
          const iv = await innertubePlayer(id);
          if (iv && iv.videoDetails && iv.videoDetails.title) {
            data = await innertubeToVideo(iv, id);
          }
        } catch (e) { /* keep going */ }
      }
      if (data && (data.title || data.id)) return json(data);
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

    /* channel page -------------------------------------------------- */
    if (path === '/__yt/channel') {
      const id = (url.searchParams.get('id') || '').trim();
      const handle = (url.searchParams.get('handle') || '').trim();
      if (!id && !handle) return json({ error: 'missing id or handle' });
      const target = handle
        ? YT_HOME + '/' + (handle.startsWith('@') ? handle : '@' + handle) + '/videos?hl=en'
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

/* Piped: GET /streams/{id} from the first instance that answers. */
async function pipedStreams(videoId) {
  for (const base of PIPED_INSTANCES) {
    try {
      const r = await fetchTimeout(base + '/streams/' + encodeURIComponent(videoId), { headers: { Accept: 'application/json' } }, 10000);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && (j.title || j.relatedStreams)) return j;
    } catch (e) { /* try next instance */ }
  }
  return null;
}

/* Piped: GET /search?q=...&filter=videos */
async function pipedSearch(q) {
  for (const base of PIPED_INSTANCES) {
    try {
      const r = await fetchTimeout(base + '/search?q=' + encodeURIComponent(q) + '&filter=videos', { headers: { Accept: 'application/json' } }, 10000);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.items) && j.items.length) {
        return j.items.filter(x => x && (x.url || '').includes('watch?v=')).map(pipedItemToVideo).slice(0, 40);
      }
    } catch (e) { /* try next instance */ }
  }
  return [];
}

/* Piped: GET /trending?region=US */
async function pipedTrending() {
  for (const base of PIPED_INSTANCES) {
    try {
      const r = await fetchTimeout(base + '/trending?region=US', { headers: { Accept: 'application/json' } }, 10000);
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j) && j.length) {
        return j.filter(x => x && (x.url || '').includes('watch?v=')).map(pipedItemToVideo);
      }
    } catch (e) { /* try next instance */ }
  }
  return [];
}

/* innertube: ANDROID_VR player call. Returns the raw player response
   (videoDetails + streamingData with direct URLs). */
async function innertubePlayer(videoId) {
  const r = await fetchTimeout('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': VR_UA },
    body: JSON.stringify({ context: VR_CONTEXT, videoId, contentCheckOk: true, racyCheckOk: true }),
  }, 12000);
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

  /* 1) innertube ANDROID_VR — direct googlevideo URLs (deciphered). */
  try {
    const iv = await innertubePlayer(id);
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
        /* progressive = audio+video muxed. adaptiveFormats are
           video-only (can't be downloaded alone as a watchable file). */
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

  /* 2) Piped instance streams (their proxy URLs work cross-IP). */
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
          }
        } else {
          const prog = (pd.videoStreams || []).filter(v => v.videoOnly === false && (v.mimeType || '').includes('mp4'));
          if (prog.length) {
            const v = prog.sort((a, b) => (b.quality || 0) - (a.quality || 0))[0];
            stream = { url: v.url, mime: 'video/mp4', title };
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

  /* fetch upstream, passing the browser's Range header through */
  const upHeaders = {};
  const range = request && request.headers.get('Range');
  if (range) upHeaders['Range'] = range;
  const r = await fetch(stream.url, { headers: upHeaders });
  if (!r.ok && r.status !== 206) {
    return json({ error: 'stream fetch failed (' + r.status + ') — try again' }, { status: 502 });
  }

  const out = new Headers({
    'Content-Type': stream.mime || 'application/octet-stream',
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
