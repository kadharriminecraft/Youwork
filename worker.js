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

    /* video metadata — full /watch page parse ------------------- */
    if (path === '/__yt/video') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!id) return json({ error: 'missing id' });
      const html = await fetchUpstream(YT_HOME + '/watch?v=' + encodeURIComponent(id) + '&hl=en');
      const data = parseWatchPage(html, id);
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
   YouTube embeds JSON blobs (ytInitialData, ytInitialPlayerResponse) in
   the page HTML. We use a brace-balanced extractor instead of a regex —
   regexes fail on the watch page because the JSON contains nested
   objects with `}` characters that confuse non-greedy matching.

   If YouTube changes their HTML structure, this is the only place
   that needs updating. */
function extractJson(html, varName){
  const startPat = new RegExp(varName + '\\s*=\\s*');
  const sm = html.match(startPat);
  if (!sm) return null;
  let i = sm.index + sm[0].length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== '{') return null;
  let depth = 0, start = i, inStr = false, esc = false, quote = '';
  while (i < html.length){
    const c = html[i];
    if (inStr){
      if (esc) esc = false;
      else if (c === '\\\\') esc = true;
      else if (c === quote) inStr = false;
    } else {
      if (c === '"' || c === "'"){ inStr = true; quote = c; }
      else if (c === '{') depth++;
      else if (c === '}'){
        depth--;
        if (depth === 0){ try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; } }
      }
    }
    i++;
  }
  return null;
}
function extractYtInitialData(html){
  return extractJson(html, 'ytInitialData');
}
function extractYtInitialPlayerResponse(html){
  return extractJson(html, 'ytInitialPlayerResponse');
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

/* ----- video metadata via full /watch page parse ----------------- *
 * Returns: { id, title, description, views, date, duration, thumb,
 *           channel: { id, name, avatar, url },
 *           related: [video, video, ...] }
 *
 * Two JSON blobs drive this:
 *   - ytInitialPlayerResponse.videoDetails — title, description, views,
 *     duration, channel name + id
 *   - ytInitialData.contents.twoColumnWatchNextResults — channel avatar,
 *     date, related videos (newer shape uses lockupViewModel) */
function parseWatchPage(html, videoId) {
  const result = {
    id: videoId,
    title: '',
    description: '',
    views: '',
    date: '',
    duration: '',
    thumb: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg',
    channel: { id: '', name: '', avatar: '', url: '' },
    related: [],
  };

  const player = extractYtInitialPlayerResponse(html);
  if (player && player.videoDetails){
    const vd = player.videoDetails;
    result.title = vd.title || '';
    result.description = vd.shortDescription || '';
    if (vd.viewCount) result.views = parseInt(vd.viewCount, 10).toLocaleString() + ' views';
    if (vd.lengthSeconds){
      const s = parseInt(vd.lengthSeconds, 10) || 0;
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      result.duration = h > 0
        ? h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0')
        : m + ':' + String(sec).padStart(2,'0');
    }
    result.channel.id = vd.channelId || '';
    result.channel.name = vd.author || '';
    if (vd.thumbnail && vd.thumbnail.thumbnails && vd.thumbnail.thumbnails.length){
      result.thumb = vd.thumbnail.thumbnails.slice(-1)[0].url;
    }
  }

  const data = extractYtInitialData(html);
  if (data){
    const wr = data.contents && data.contents.twoColumnWatchNextResults;
    if (wr){
      /* Channel avatar + date live in results.contents */
      if (wr.results && wr.results.results && wr.results.results.contents){
        for (const item of wr.results.results.contents){
          const si = item.videoSecondaryInfoRenderer || item.slimVideoMetadataRenderer;
          if (si && si.owner && si.owner.videoOwnerRenderer){
            const owner = si.owner.videoOwnerRenderer;
            if (owner.thumbnail && owner.thumbnail.thumbnails && owner.thumbnail.thumbnails.length){
              result.channel.avatar = owner.thumbnail.thumbnails.slice(-1)[0].url;
            }
            if (owner.title && owner.title.runs){
              result.channel.name = owner.title.runs.map(r => r.text).join('') || result.channel.name;
            }
            if (owner.navigationEndpoint && owner.navigationEndpoint.browseEndpoint){
              result.channel.id = owner.navigationEndpoint.browseEndpoint.browseId || result.channel.id;
            }
            if (owner.subscriberCountText){
              result.channel.subs = owner.subscriberCountText.simpleText ||
                (owner.subscriberCountText.runs && owner.subscriberCountText.runs.map(r => r.text).join('')) || '';
            }
          }
          if (item.videoPrimaryInfoRenderer || item.compositeVideoPrimaryInfoRenderer){
            const pi = item.videoPrimaryInfoRenderer || (item.compositeVideoPrimaryInfoRenderer && item.compositeVideoPrimaryInfoRenderer.content && item.compositeVideoPrimaryInfoRenderer.content.videoPrimaryInfoRenderer);
            if (pi){
              if (pi.viewCount && pi.viewCount.videoViewCountRenderer && pi.viewCount.videoViewCountRenderer.viewCount){
                result.views = pi.viewCount.videoViewCountRenderer.viewCount.simpleText || result.views;
              }
              if (pi.dateText){
                result.date = pi.dateText.simpleText ||
                  (pi.dateText.runs && pi.dateText.runs.map(r => r.text).join('')) || '';
              }
            }
          }
        }
      }
      /* Related videos live in secondaryResults. Newer YouTube serves
         them inside an itemSectionRenderer.contents[] as lockupViewModel.
         Older shape: results[] as compactVideoRenderer. Handle both. */
      if (wr.secondaryResults && wr.secondaryResults.secondaryResults && wr.secondaryResults.secondaryResults.results){
        const items = wr.secondaryResults.secondaryResults.results;
        const related = [];
        for (const item of items){
          /* Old shape */
          if (item.compactVideoRenderer){
            const v = extractVideoRenderer(item.compactVideoRenderer);
            if (v) related.push(v);
          }
          /* Autoplay wrapper (old shape) */
          if (item.compactAutoplayRenderer && item.compactAutoplayRenderer.contents){
            for (const inner of item.compactAutoplayRenderer.contents){
              if (inner.compactVideoRenderer){
                const v = extractVideoRenderer(inner.compactVideoRenderer);
                if (v) related.push(v);
              }
            }
          }
          /* New shape: itemSectionRenderer.contents[].lockupViewModel */
          if (item.itemSectionRenderer && item.itemSectionRenderer.contents){
            for (const inner of item.itemSectionRenderer.contents){
              if (inner.lockupViewModel){
                const v = extractLockupViewModel(inner.lockupViewModel);
                if (v) related.push(v);
              }
              if (inner.compactVideoRenderer){
                const v = extractVideoRenderer(inner.compactVideoRenderer);
                if (v) related.push(v);
              }
            }
          }
        }
        result.related = related;
      }
    }
  }

  if (result.channel.id) result.channel.url = 'https://www.youtube.com/channel/' + result.channel.id;
  return result;
}

/* Parse the newer lockupViewModel shape into our standard video record. */
function extractLockupViewModel(vm){
  try {
    if (!vm) return null;
    let id = vm.contentId || '';
    const md = vm.metadata && vm.metadata.lockupMetadataViewModel;
    if (!id && md){
      /* fallback: extract from thumbnail URL */
    }
    if (!id){
      const img = vm.contentImage && vm.contentImage.thumbnailViewModel && vm.contentImage.thumbnailViewModel.image;
      const src = img && img.sources && img.sources.length && img.sources[0].url;
      if (src){
        const m = src.match(/\/vi\/([A-Za-z0-9_-]{11})\//);
        if (m) id = m[1];
      }
    }
    if (!id) return null;
    const title = md && md.title && md.title.content || '';
    const img = vm.contentImage && vm.contentImage.thumbnailViewModel && vm.contentImage.thumbnailViewModel.image;
    const thumb = img && img.sources && img.sources.length ? img.sources.slice(-1)[0].url : '';
    /* Channel name + avatar live in metadata.lockupMetadataViewModel.image.decoratedAvatarViewModel */
    let channel = '', channelAvatar = '', channelId = '';
    if (md && md.image && md.image.decoratedAvatarViewModel && md.image.decoratedAvatarViewModel.avatar && md.image.decoratedAvatarViewModel.avatar.avatarViewModel){
      const av = md.image.decoratedAvatarViewModel.avatar.avatarViewModel;
      if (av.image && av.image.sources && av.image.sources.length) channelAvatar = av.image.sources.slice(-1)[0].url;
      /* a11yLabel is like "Go to channel NAME" */
      if (md.image.decoratedAvatarViewModel.a11yLabel){
        const m = /Go to channel (.+)$/i.exec(md.image.decoratedAvatarViewModel.a11yLabel);
        if (m) channel = m[1];
      }
    }
    /* Duration: hunt for thumbnailBadgeViewModel in overlays */
    let duration = '';
    if (vm.contentImage && vm.contentImage.thumbnailViewModel && vm.contentImage.thumbnailViewModel.overlays){
      for (const ov of vm.contentImage.thumbnailViewModel.overlays){
        if (ov.thumbnailBottomOverlayViewModel && ov.thumbnailBottomOverlayViewModel.badges){
          for (const b of ov.thumbnailBottomOverlayViewModel.badges){
            if (b.thumbnailBadgeViewModel && b.thumbnailBadgeViewModel.text){
              duration = b.thumbnailBadgeViewModel.text;
              break;
            }
          }
        }
      }
    }
    /* Channel ID: buried deep in rendererContext or commandContext — best-effort */
    const json = JSON.stringify(vm);
    const cidm = /"browseId":"([A-Za-z0-9_-]+)"/.exec(json);
    if (cidm) channelId = cidm[1];
    return { id, title, thumb, channel, channelId, duration, views:'', date:'', description:'' };
  } catch (e){ return null; }
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

/* ----- video metadata via oEmbed (legacy, unused — kept for reference) */
async function fetchVideoMeta(id) {
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
