"use strict";

const MUSIC_SEARCH_QUERY = "StoriesCreateMusicSelectorMainPageQuery";

const STOP_WORDS = new Set([
  "the", "a", "an", "of", "in", "on", "to", "me", "my", "and", "feat",
  "ft", "with", "for", "by", "from", "is", "it", "at", "as",
]);

function normalize(value) {
  return String(value === undefined || value === null ? "" : value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedEditDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function tokenMatches(queryToken, candidateToken) {
  if (!queryToken || !candidateToken) return false;
  if (queryToken === candidateToken) return true;
  if (queryToken.length >= 4 && candidateToken.startsWith(queryToken)) return true;
  if (candidateToken.length >= 4 && queryToken.startsWith(candidateToken)) return true;
  const shortest = Math.min(queryToken.length, candidateToken.length);
  if (shortest < 5) return false;
  const allowed = queryToken.length >= 8 ? 2 : 1;
  return boundedEditDistance(queryToken, candidateToken, allowed) <= allowed;
}

function tokenInField(token, field) {
  if (!field) return false;
  if (field.includes(token)) return true;
  for (const candidate of field.split(" ")) {
    if (tokenMatches(token, candidate)) return true;
  }
  return false;
}

function scoreTrack(query, track) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;
  const title = normalize(track.title);
  const artist = normalize(track.artist);
  const album = normalize(track.album);
  if (!title && !artist && !album) return 0;

  if (title && title === normalizedQuery) return 1;
  let score = 0;
  if (title && title.includes(normalizedQuery)) score = Math.max(score, 0.95);
  if (artist && artist.includes(normalizedQuery)) score = Math.max(score, 0.9);
  if (album && album.includes(normalizedQuery)) score = Math.max(score, 0.85);

  const queryTokens = normalizedQuery.split(" ").filter((token) => token.length >= 2);
  const significant = queryTokens.filter((token) => !STOP_WORDS.has(token));
  const tokens = significant.length ? significant : queryTokens;
  if (!tokens.length) return score;

  let titleHits = 0;
  let anyHits = 0;
  for (const token of tokens) {
    const inTitle = tokenInField(token, title);
    const inArtistOrAlbum = tokenInField(token, artist) || tokenInField(token, album);
    if (inTitle) titleHits++;
    if (inTitle || inArtistOrAlbum) anyHits++;
  }
  const coverage = anyHits / tokens.length;
  const titleCoverage = titleHits / tokens.length;
  const tokenScore = 0.6 * coverage + 0.3 * titleCoverage + (coverage === 1 ? 0.1 : 0);
  return Math.max(score, Math.min(1, tokenScore));
}

function normalizeTrack(item) {
  const artwork = item.display_image || item.cover_artwork || {};
  const downloads = Array.isArray(item.progressive_download) ? item.progressive_download : [];
  const tags = Array.isArray(item.tags)
    ? item.tags.map((tag) => ({ type: tag && tag.type, name: tag && tag.name, id: tag && tag.id }))
    : [];
  return {
    id: String(item.display_id || item.id || ""),
    title: (item.title && item.title.text) || (item.display_title && item.display_title.text) || "",
    artist: (item.display_artist && item.display_artist.text) || "",
    album: item.album_title || "",
    duration: item.duration_in_ms === undefined || item.duration_in_ms === null ? null : Number(item.duration_in_ms),
    image: artwork.uri || null,
    url: (downloads[0] && downloads[0].url) || null,
    isSaved: Boolean(item.is_saved_by_viewer),
    tags,
    raw: item,
  };
}

function extractEdges(response) {
  const container = response && response.data && response.data.xfb_music_picker_connection_container;
  const items = container && container.items;
  const edges = (items && items.edges) || [];
  return {
    edges,
    pageInfo: (items && items.page_info) || {},
  };
}

function rankResults(query, edges, options) {
  const exact = options.exact !== false;
  const scored = [];
  for (const edge of edges) {
    const item = edge && edge.node && edge.node.item;
    if (!item) continue;
    const track = normalizeTrack(item);
    track.score = Number(scoreTrack(query, track).toFixed(4));
    scored.push(track);
  }
  scored.sort((a, b) => b.score - a.score);
  if (!exact) return scored;
  const best = scored.length ? scored[0].score : 0;
  const threshold = options.threshold !== undefined ? Number(options.threshold) : Math.max(0.35, 0.5 * best);
  if (best >= 0.55) return scored.filter((track) => track.score >= threshold);
  return scored.filter((track) => track.score > 0);
}

async function searchMusic(client, query, options = {}) {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("searchMusic: query must be a non-empty string");
  }
  const exact = options.exact !== false;
  const first = Number.isFinite(options.first) ? options.first : exact ? 30 : 20;
  const limit = Number.isFinite(options.limit) ? options.limit : 20;
  const variables = {
    params: { first },
    product: options.product || "FB_CAMERA",
  };
  variables.params.search_text = query.trim();
  if (options.after || options.cursor) variables.params.after = String(options.after || options.cursor);

  const response = await client.makeGraphQLRequest(MUSIC_SEARCH_QUERY, variables);
  if (!response || (response.errors && response.errors.length)) {
    const err = new Error("searchMusic: music search query failed");
    err.res = response;
    throw err;
  }
  const { edges, pageInfo } = extractEdges(response);
  const ranked = rankResults(query, edges, options);
  const results = ranked.slice(0, limit);
  results.cursor = pageInfo.end_cursor || null;
  results.hasMore = Boolean(pageInfo.has_next_page);
  return results;
}

module.exports = {
  searchMusic,
  scoreTrack,
  normalize,
  tokenMatches,
  boundedEditDistance,
  normalizeTrack,
  rankResults,
  MUSIC_SEARCH_QUERY,
};
