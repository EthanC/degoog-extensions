const NS = "prospero";
const SITE_URL = "https://prosperopatches.com";
const API_URL = `${SITE_URL}/api/lookup`;
const ART_HOST = "cdn.prosperopatches.com";
const LOOKUP_TIMEOUT_MS = 5000;
const ART_TIMEOUT_MS = 8000;
const FOUND_CACHE_MS = 6 * 3600 * 1000;
const MISSING_CACHE_MS = 3600 * 1000;
const ART_CACHE_MS = 6 * 3600 * 1000;
const LOOKUP_CACHE_LIMIT = 500;
const ART_CACHE_LIMIT = 24;
const MAX_ART_BYTES = 5 * 1024 * 1024;
const ART_KINDS = new Set(["icon", "background", "logo"]);
const ICON_FILE_RX = /\/icon0\.webp$/;

// A PS5 (Prospero) title ID: "PPSA" and five digits, with or without a hyphen.
const QUERY_RX = /^ppsa-?(\d{5})$/i;
const CANONICAL_RX = /^PPSA\d{5}$/;

let template = "";
let pluginFetch = null;
let apiBase = "";
const settings = { showIcon: true, showBackground: true, showLogo: true, showDetails: true };

const lookupCache = new Map();
const lookupInflight = new Map();
const artCache = new Map();
const artInflight = new Map();

const _esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\{\{/g, "&#123;&#123;");

const _t = (key, vars, locale) => {
  const translate = slot.t;
  if (typeof translate !== "function") return key;
  return String(translate(`${NS}.${key}`, vars, locale));
};

const _render = (data) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");

const _safeLocale = (locale) => {
  const candidate = String(locale || "").trim();
  if (!candidate) return "en";
  try {
    new Intl.NumberFormat(candidate);
    return candidate;
  } catch {
    return "en";
  }
};

const _remember = (cache, key, value, limit) => {
  cache.delete(key);
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
};

const _flag = (value, fallback) => {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return fallback;
};

/** "PPSA01628", "ppsa-01628" → "PPSA01628"; anything else → null. */
const _parseQuery = (query) => {
  if (typeof query !== "string" || query.length > 32) return null;
  const match = QUERY_RX.exec(query.trim());
  return match ? `PPSA${match[1]}` : null;
};

const _withTimeout = async (ms, work) => {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error("timeout"));
    }, ms);
  });
  try {
    return await Promise.race([work(controller?.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const _artUrl = (value) => {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === ART_HOST ? url.href : null;
  } catch {
    return null;
  }
};

/** The API has no logo field, but titles with a logo keep logo.webp next to icon0.webp on the CDN. */
const _logoNextTo = (iconUrl) => (iconUrl && ICON_FILE_RX.test(iconUrl) ? _artUrl(iconUrl.replace(ICON_FILE_RX, "/logo.webp")) : null);

const _text = (value) => (typeof value === "string" ? value.trim() : "");

const _bytes = (value) => {
  const n = typeof value === "number" ? value : /^\d{1,20}$/.test(String(value ?? "").trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Reads an Prospero Patches lookup response. Returns a title, null for "not found", or throws. */
const _parseLookup = (id, data) => {
  if (!data || typeof data !== "object") throw new Error("bad response");
  if (data.success !== true) {
    if (data.code === 1 || data.code === 2) return null;
    throw new Error("lookup failed");
  }
  const meta = data.metadata;
  const name = _text(meta?.name);
  if (!name) return null;
  const icon = _artUrl(meta.icon);
  return {
    id,
    name,
    region: _text(meta.region),
    version: _text(meta.currentVersion),
    patchSize: _bytes(meta.latestPatch?.size),
    art: { icon, background: _artUrl(meta.background), logo: _artUrl(meta.logo) || _logoNextTo(icon) },
  };
};

const _fetchLookup = async (id, fetcher) => {
  const url = `${API_URL}?${new URLSearchParams({ titleid: id })}`;
  return _withTimeout(LOOKUP_TIMEOUT_MS, async (signal) => {
    const response = await fetcher(url, { signal, headers: { Accept: "application/json" } });
    if (!response) throw new Error("no response");
    // Unknown and malformed ids come back as 200 with success:false, but accept 404 the same way.
    if (!response.ok && response.status !== 404) throw new Error(`status ${response.status}`);
    return _parseLookup(id, await response.json());
  });
};

/** Title metadata for a canonical id, cached. null when unknown, undefined when the lookup failed. */
const _lookup = async (id, fetcher) => {
  const cached = lookupCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (lookupInflight.has(id)) return lookupInflight.get(id);
  const pending = (async () => {
    try {
      const value = await _fetchLookup(id, fetcher);
      const ttl = value ? FOUND_CACHE_MS : MISSING_CACHE_MS;
      _remember(lookupCache, id, { value, expires: Date.now() + ttl }, LOOKUP_CACHE_LIMIT);
      return value;
    } catch {
      return undefined;
    } finally {
      lookupInflight.delete(id);
    }
  })();
  lookupInflight.set(id, pending);
  return pending;
};

/** The CDN sends no Content-Type, so the type comes from the file's magic bytes. */
const _sniffImage = (bytes) => {
  const at = (i) => bytes[i];
  const ascii = (start, text) => [...text].every((ch, i) => at(start + i) === ch.charCodeAt(0));
  if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (bytes.length >= 8 && at(0) === 0x89 && ascii(1, "PNG")) return "image/png";
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  return null;
};

const _downloadArt = (url, fetcher) =>
  _withTimeout(ART_TIMEOUT_MS, async (signal) => {
    const response = await fetcher(url, { signal, headers: { Accept: "image/webp,image/*;q=0.8" } });
    if (!response) return { value: null, missing: false };
    if (response.status === 404 || response.status === 403) return { value: null, missing: true };
    if (!response.ok) return { value: null, missing: false };
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (length > MAX_ART_BYTES) return { value: null, missing: true };
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = bytes.length && bytes.length <= MAX_ART_BYTES ? _sniffImage(bytes) : null;
    return type ? { value: { bytes, type }, missing: false } : { value: null, missing: true };
  }).catch(() => ({ value: null, missing: false }));

/** Image bytes and type for a CDN URL, or null. Found and missing images are cached, failures are not. */
const _fetchArt = async (url, fetcher) => {
  const cached = artCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (artInflight.has(url)) return artInflight.get(url);
  const pending = (async () => {
    try {
      const { value, missing } = await _downloadArt(url, fetcher);
      if (value || missing) {
        const ttl = value ? ART_CACHE_MS : MISSING_CACHE_MS;
        _remember(artCache, url, { value, expires: Date.now() + ttl }, ART_CACHE_LIMIT);
      }
      return value;
    } finally {
      artInflight.delete(url);
    }
  })();
  artInflight.set(url, pending);
  return pending;
};

// degoog's ctx.apiBase leaves out the DEGOOG_BASE_URL path (v1.1.1), so add it here.
const _basePath = () => {
  const raw = String(globalThis.process?.env?.DEGOOG_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return raw;
  try {
    const path = new URL(raw).pathname.replace(/\/+$/, "");
    return path === "/" ? "" : path;
  } catch {
    return "";
  }
};

const _routeUrl = (id, kind) => {
  if (!apiBase) return "";
  const base = _basePath();
  const prefix = base && !apiBase.startsWith(`${base}/`) ? `${base}${apiBase}` : apiBase;
  return `${prefix}/art?${new URLSearchParams({ id, kind })}`;
};

const _formatSize = (bytes, locale) => {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit >= 3 ? 2 : unit === 0 ? 0 : 1,
  }).format(value);
};

const _detail = (key, value, locale) =>
  `<div class="prospero-detail" data-prospero-row="${key}">` +
  `<dt class="prospero-label">${_esc(_t(`labels.${key}`, undefined, locale))}</dt>` +
  `<dd class="prospero-value">${_esc(value)}</dd></div>`;

/** Opening tag of a link to the image itself, served by the art route like the <img>. */
const _artLink = (kind, url, locale, cls) => {
  const label = _esc(_t(`openArt.${kind}`, undefined, locale));
  return `<a class="${cls}" href="${_esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${label}" title="${label}" data-prospero-open="${kind}">`;
};

const _renderTitle = (title, locale, hasLogo) => {
  const pageUrl = `${SITE_URL}/${title.id}`;
  const iconUrl = settings.showIcon && title.art.icon ? _routeUrl(title.id, "icon") : "";
  const backgroundUrl = settings.showBackground && title.art.background ? _routeUrl(title.id, "background") : "";
  const logoUrl = backgroundUrl && hasLogo ? _routeUrl(title.id, "logo") : "";
  const details = settings.showDetails
    ? [
        title.region ? _detail("region", title.region, locale) : "",
        title.version ? _detail("version", title.version, locale) : "",
        title.patchSize ? _detail("patchSize", _formatSize(title.patchSize, locale), locale) : "",
      ].join("")
    : "";
  const html = _render({
    id: _esc(title.id),
    name: _esc(title.name),
    url: _esc(pageUrl),
    platform: _esc(_t("platform", undefined, locale)),
    background: backgroundUrl
      ? `<div class="prospero-banner">` +
        _artLink("background", backgroundUrl, locale, "prospero-banner-link") +
        `<img class="prospero-background" src="${_esc(backgroundUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-prospero-art="background"></a>` +
        (logoUrl
          ? _artLink("logo", logoUrl, locale, "prospero-logo-link") +
            `<img class="prospero-logo" src="${_esc(logoUrl)}" alt="" decoding="async" referrerpolicy="no-referrer" data-prospero-art="logo"></a>`
          : "") +
        "</div>"
      : "",
    icon: iconUrl
      ? _artLink("icon", iconUrl, locale, "prospero-icon-link") +
        `<img class="prospero-icon" src="${_esc(iconUrl)}" alt="${_esc(_t("iconAlt", { name: title.name }, locale))}" width="96" height="96" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-prospero-art="icon"></a>`
      : "",
    details: details ? `<dl class="prospero-details">${details}</dl>` : "",
    link: _esc(_t("viewPage", undefined, locale)),
  });
  // No panel title: degoog then skips the header row above the card.
  return { title: "", html };
};

const _artEnabled = (kind) =>
  kind === "icon" ? settings.showIcon : kind === "background" ? settings.showBackground : settings.showLogo && settings.showBackground;

const _plain = (status, text) =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

export const routes = [
  {
    method: "get",
    path: "/art",
    rateLimit: true,
    async handler(request) {
      const params = new URL(request.url).searchParams;
      const id = String(params.get("id") || "");
      const kind = String(params.get("kind") || "");
      if (!CANONICAL_RX.test(id) || !ART_KINDS.has(kind)) return _plain(400, "Bad request");
      if (!_artEnabled(kind)) return _plain(404, "Not found");
      if (typeof pluginFetch !== "function") return _plain(503, "Unavailable");
      const title = await _lookup(id, pluginFetch);
      if (title === undefined) return _plain(502, "Lookup failed");
      const url = title?.art?.[kind];
      if (!url) return _plain(404, "Not found");
      const art = await _fetchArt(url, pluginFetch);
      if (!art) return _plain(502, "Art unavailable");
      return new Response(art.bytes, {
        status: 200,
        headers: {
          "Content-Type": art.type,
          "Content-Length": String(art.bytes.length),
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    },
  },
];

export const slot = {
  id: "prospero-patches",
  name: "Prospero Patches",
  description:
    "Looks up PlayStation 5 title IDs such as PPSA01628 or PPSA-01628 on PROSPEROPatches and shows the game's name, art and a link to its patch page.",
  isClientExposed: false,
  supportsNojs: true,
  position: "at-a-glance",
  slotPositions: ["at-a-glance", "above-results", "above-sidebar", "below-sidebar"],

  settingsSchema: [
    {
      key: "showIcon",
      label: "Show icon",
      type: "toggle",
      default: "true",
      description: "Show the game's icon. Art is fetched by your degoog server, so visitors never contact PROSPEROPatches.",
    },
    {
      key: "showBackground",
      label: "Show background art",
      type: "toggle",
      default: "true",
      description: "Show the game's background art as a banner above the title.",
    },
    {
      key: "showLogo",
      label: "Show logo",
      type: "toggle",
      default: "true",
      description:
        "Show the game's logo on the background art, for titles that have one on PROSPEROPatches. Needs the background art turned on.",
    },
    {
      key: "showDetails",
      label: "Show details",
      type: "toggle",
      default: "true",
      description: "List the region, current version and size of the latest patch.",
    },
  ],

  init(ctx) {
    template = ctx?.template || "";
    pluginFetch = typeof ctx?.fetch === "function" ? ctx.fetch : null;
    apiBase = typeof ctx?.apiBase === "string" ? ctx.apiBase.replace(/\/+$/, "") : "";
  },

  configure(next) {
    settings.showIcon = _flag(next?.showIcon, true);
    settings.showBackground = _flag(next?.showBackground, true);
    settings.showLogo = _flag(next?.showLogo, true);
    settings.showDetails = _flag(next?.showDetails, true);
  },

  trigger(query) {
    return _parseQuery(query) !== null;
  },

  async execute(query, context) {
    const id = _parseQuery(query);
    if (!id) return { title: "", html: "" };
    const fetcher = typeof context?.fetch === "function" ? context.fetch : pluginFetch;
    if (typeof fetcher !== "function") return { title: "", html: "" };
    try {
      const title = await _lookup(id, fetcher);
      if (!title) return { title: "", html: "" };
      const wantsLogo = _artEnabled("logo") && title.art.background && title.art.logo && apiBase;
      const hasLogo = wantsLogo ? Boolean(await _fetchArt(title.art.logo, fetcher)) : false;
      return _renderTitle(title, _safeLocale(context?.locale), hasLogo);
    } catch {
      return { title: "", html: "" };
    }
  },
};

export const _internals = {
  parseQuery: _parseQuery,
  parseLookup: _parseLookup,
  sniffImage: _sniffImage,
  logoNextTo: _logoNextTo,
  formatSize: _formatSize,
  clearCaches: () => {
    lookupCache.clear();
    lookupInflight.clear();
    artCache.clear();
    artInflight.clear();
  },
};

export default { slot, routes };
