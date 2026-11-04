import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const NS = "qrscan";
const VERSION = "1.0.0";
const DECODER_FILE = "vendor/jsQR.js";
const MAX_URL_LENGTH = 2048;
const MAX_DATA_URL_LENGTH = 4 * 1024 * 1024;
const MAX_QUERY_TOKENS = 12;

// Words that make a query about QR codes. "code" and its translations only count next to "qr".
const CORE_WORDS = new Set(["qr", "qrcode", "qrcodes", "qr-code", "qr-codes"]);
const CODE_WORDS = new Set(["code", "codes", "codice", "codici"]);

// Words that ask for a scanner. One of these, or an image URL, triggers even when a plain "qr" is turned off.
const ACTION_WORDS = new Set([
  "scan",
  "scans",
  "scanner",
  "scanners",
  "scanning",
  "read",
  "reader",
  "readers",
  "reading",
  "decode",
  "decoder",
  "decoding",
  // German
  "scannen",
  "lesen",
  "leser",
  "auslesen",
  "dekodieren",
  "decodieren",
  // French
  "scanneur",
  "lecteur",
  "lire",
  "décoder",
  "décodeur",
  // Italian
  "lettore",
  "leggere",
  "leggi",
  "scansiona",
  "scansionare",
  "scansione",
  "decodifica",
  "decodificare",
]);

// Grammar words that may surround the keywords without changing what is asked.
const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "my",
  "this",
  "from",
  "image",
  "picture",
  "photo",
  "screenshot",
  "online",
  // German
  "ein",
  "einen",
  "den",
  "der",
  "die",
  "das",
  "von",
  "aus",
  "bild",
  "foto",
  // French
  "un",
  "une",
  "le",
  "la",
  "de",
  "du",
  "en",
  "ligne",
  // Italian
  "il",
  "lo",
  "uno",
  "una",
  "da",
  "di",
  "immagine",
]);

let template = "";
let apiBase = "";
let readFile = null;
let signProxy = null;
let decoderSource = null;
const slotSettings = { bareQr: true, imageUrls: true };
const commandSettings = { imageUrls: true };

// Tokens let the /image route sign URLs only for panels this server rendered recently.
const TOKEN_SECRET = randomBytes(32);
const TOKEN_TTL_MS = 60 * 60 * 1000;

// Image types degoog's image proxy passes (src/server/routes/proxy.ts, v1.1.1).
const IMAGE_PATH_RX = /\.(?:png|jpe?g|gif|webp|svg|avif|ico)$/i;

// <shared-core>
// Kept identical in index.js and script.js; tests/qr-scanner.test.mjs checks that the copies match.
// Everything in here is linear in the length of its input, because it runs on whole search queries.
const MIN_BASE64_LENGTH = 32;
const SVG_PROLOG_WINDOW = 4096;
const SVG_PROLOG_PARTS = 16;

/** The image type of decoded leading bytes: PNG, JPEG or GIF, or "". */
const sniffImageType = (head) => {
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  return "";
};

/** Raw base64 of a PNG, JPEG or GIF (whitespace and URL-safe characters allowed) → { type, base64 }, else null. */
const parseBase64Image = (text) => {
  const compact = String(text ?? "").replace(/\s+/g, "");
  if (compact.length < MIN_BASE64_LENGTH || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
  const base64 = compact.replace(/-/g, "+").replace(/_/g, "/");
  let head = "";
  try {
    head = atob(base64.slice(0, 16));
  } catch {
    return null;
  }
  const type = sniffImageType(head);
  return type ? { type, base64 } : null;
};

/**
 * Finds SVG markup with plain string searches: from the first <svg tag, widened to take in an XML declaration,
 * comments or a doctype right before it, up to the last </svg>. Returns { start, open, end } (open is where
 * the <svg tag itself starts) or null.
 */
const findSvgMarkup = (text) => {
  const lower = String(text ?? "").toLowerCase();
  let open = -1;
  for (let i = lower.indexOf("<svg"); i >= 0; i = lower.indexOf("<svg", i + 4)) {
    const next = lower.charAt(i + 4);
    if (next === ">" || /\s/.test(next)) {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  const close = lower.lastIndexOf("</svg>");
  if (close < open) return null;
  let start = open;
  for (let part = 0; part < SVG_PROLOG_PARTS; part += 1) {
    let end = start;
    while (end > 0 && /\s/.test(lower.charAt(end - 1))) end -= 1;
    if (end === 0 || lower.charAt(end - 1) !== ">") break;
    const from = Math.max(0, end - SVG_PROLOG_WINDOW);
    const recent = lower.slice(from, end);
    const at = Math.max(recent.lastIndexOf("<?xml"), recent.lastIndexOf("<!--"), recent.lastIndexOf("<!doctype"));
    if (at < 0) break;
    const piece = recent.slice(at);
    const complete = piece.startsWith("<!--") ? piece.endsWith("-->") : piece.startsWith("<?xml") ? piece.endsWith("?>") : true;
    if (!complete) break;
    start = from + at;
  }
  return { start, open, end: close + 6 };
};
// </shared-core>

const _esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\{\{/g, "&#123;&#123;");

const _render = (data) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");

const _flag = (value, fallback) => {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return fallback;
};

const DATA_URL_RX = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=._+-]+)*,\S*$/i;

const _isDataUrl = (url) => /^data:/i.test(url);

/** An http(s) URL or an image data URL, normalised. Anything else → null. */
const _imageUrl = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (_isDataUrl(text)) return text.length <= MAX_DATA_URL_LENGTH && DATA_URL_RX.test(text) ? text : null;
  if (text.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
};

const _count = (text, ch) => text.split(ch).length - 1;

/** Drops sentence punctuation after a web URL, and closing brackets that the URL itself didn't open. */
const _trimUrl = (part) => {
  let url = part;
  for (;;) {
    const last = url.charAt(url.length - 1);
    if (".,;:!?".includes(last) && last) url = url.slice(0, -1);
    else if (last === ")" && _count(url, ")") > _count(url, "(")) url = url.slice(0, -1);
    else if (last === "]" && _count(url, "]") > _count(url, "[")) url = url.slice(0, -1);
    else return url;
  }
};

const _hasImagePath = (url) => {
  try {
    return IMAGE_PATH_RX.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/** Raw base64 of a PNG, JPEG or GIF → a data URL, or null. */
const _base64Image = (value) => {
  const parsed = parseBase64Image(value);
  if (!parsed || parsed.base64.length > MAX_DATA_URL_LENGTH - 32) return null;
  return `data:${parsed.type};base64,${parsed.base64}`;
};

const _base64Utf8 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

// Stands in for SVG markup while only deciding whether to trigger, so trigger() never encodes anything.
const SVG_PENDING = "data:image/svg+xml;base64,";

/** Pulls SVG markup out of text: { url, rest }, with url null when the markup is too large. null without SVG. */
const _extractSvg = (text, encode = true) => {
  const found = findSvgMarkup(text);
  if (!found) return null;
  const length = found.end - found.start;
  // Base64 grows the markup by a third.
  const url = (length * 4) / 3 + 32 > MAX_DATA_URL_LENGTH ? null : encode ? `${SVG_PENDING}${_base64Utf8(text.slice(found.start, found.end))}` : SVG_PENDING;
  return { url, rest: `${text.slice(0, found.start)} ${text.slice(found.end)}` };
};

/** One whitespace-free token as an image source: a URL or raw base64. "" for a plain word, null for a bad URL. */
const _imageToken = (part) => {
  if (/^(?:https?:\/\/|data:)/i.test(part)) return _imageUrl(_isDataUrl(part) ? part : _trimUrl(part));
  return _base64Image(part) ?? "";
};

const _normalise = (text) =>
  text
    .toLowerCase()
    .replace(/['‘’`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?!.,;:]+$/, "");

/**
 * Reads a natural-language query. Returns { url, bare } when it asks for a QR scanner, else null.
 * `url` is the image from the query (a web URL with its case kept, or a data URL for data URLs, raw base64
 * and SVG markup), or "" when there is none. `bare` is true when the query is only "qr" or "qr code".
 * With `encode` off, SVG markup is detected but not encoded, which is all trigger() needs.
 */
const _parseQuery = (query, { encode = true, imageUrls = true } = {}) => {
  if (typeof query !== "string") return null;
  let raw = query.trim();
  if (!raw || raw.length > MAX_DATA_URL_LENGTH + 256) return null;
  let url = "";
  const svg = _extractSvg(raw, encode);
  if (svg) {
    if (!svg.url) return null;
    url = svg.url;
    raw = svg.rest;
  }
  const words = [];
  for (const part of raw.split(/\s+/).filter(Boolean)) {
    const candidate = _imageToken(part);
    if (candidate === "") {
      words.push(part);
      continue;
    }
    if (!candidate || url) return null;
    url = candidate;
  }
  const tokens = _normalise(words.join(" ")).split(" ").filter(Boolean);
  if (!tokens.length || tokens.length > MAX_QUERY_TOKENS) return null;

  let core = false;
  let action = false;
  let filler = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (CORE_WORDS.has(token)) {
      core = true;
    } else if (CODE_WORDS.has(token)) {
      // "qr code", "code qr", "codice qr": only right next to "qr".
      if (tokens[i - 1] !== "qr" && tokens[i + 1] !== "qr") return null;
    } else if (ACTION_WORDS.has(token)) {
      action = true;
    } else if (FILLER_WORDS.has(token)) {
      filler = true;
    } else {
      return null;
    }
  }
  if (!core) return null;
  if (url && !_isDataUrl(url)) {
    if (!imageUrls) return null;
    // "qr code https://example.com" asks for a code for that site. A link only means "scan this" when it
    // points at an image file or the query says scan, read or decode.
    if (!action && !_hasImagePath(url)) return null;
  }
  const bare = !action && !url;
  // "free qr code" or "qr code online" usually means a generator, so extra words need an action word or a URL.
  if (bare && filler) return null;
  return { url, bare };
};

/** Bang arguments → { url, text }. `text` is what was typed when it holds no image. */
const _parseArgs = (args) => {
  const raw = String(args ?? "").trim();
  if (!raw) return { url: "", text: "" };
  const svg = _extractSvg(raw);
  if (svg?.url) return { url: svg.url, text: "" };
  const direct = _imageUrl(raw) || _base64Image(raw);
  if (direct) return { url: direct, text: "" };
  for (const part of raw.split(/\s+/)) {
    const candidate = _imageToken(part);
    if (candidate) return { url: candidate, text: "" };
  }
  return { url: "", text: raw.slice(0, MAX_URL_LENGTH) };
};

/** A short key for a search, so a scan only carries over to the second render of the same search. */
const _searchKey = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${hash.toString(36)}`;
};

// degoog's ctx.apiBase leaves out the DEGOOG_BASE_URL path (v1.1.1), so add it here.
const _basePath = () => {
  const value = String(globalThis.process?.env?.DEGOOG_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const path = new URL(value).pathname.replace(/\/+$/, "");
    return path === "/" ? "" : path;
  } catch {
    return "";
  }
};

const _routeUrl = (route) => {
  if (!apiBase) return "";
  const base = _basePath();
  const prefix = base && !apiBase.startsWith(`${base}/`) ? `${base}${apiBase}` : apiBase;
  return `${prefix}${route}`;
};

const _tokenMac = (expires, source) =>
  createHmac("sha256", TOKEN_SECRET).update(`qrscan:${source}:${expires}`).digest("base64url").slice(0, 32);

/** A token for the /image route, issued with each panel: which entry rendered it, and until when it is valid. */
const _issueToken = (source, now = Date.now()) => {
  const expires = (now + TOKEN_TTL_MS).toString(36);
  return `${source}.${expires}.${_tokenMac(expires, source)}`;
};

/** The entry ("s" for the slot, "c" for the command) a valid, unexpired token was issued by, or null. */
const _checkToken = (token, now = Date.now()) => {
  const match = /^([sc])\.([0-9a-z]{1,12})\.([\w-]{32})$/.exec(String(token ?? ""));
  if (!match) return null;
  const [, source, expires, mac] = match;
  if (parseInt(expires, 36) < now) return null;
  const expected = Buffer.from(_tokenMac(expires, source));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? source : null;
};

const _imageUrlsOn = (source) => (source === "s" ? slotSettings.imageUrls : commandSettings.imageUrls);

/** Where the browser loads the image from: degoog's signed image proxy for http(s), the data URL itself otherwise. */
const _sourceFor = (url, sign) => {
  if (!url) return "";
  if (_isDataUrl(url)) return url;
  const signer = typeof sign === "function" ? sign : signProxy;
  if (typeof signer !== "function") return "";
  try {
    const signed = signer(url);
    return typeof signed === "string" ? signed : "";
  } catch {
    return "";
  }
};

// Messages the browser shows while scanning. They are rendered here so they follow the request's locale.
const CLIENT_MESSAGES = [
  ["loading", "status.loading"],
  ["decoding", "status.decoding"],
  ["nocode", "status.noCode"],
  ["loadfailed", "status.loadFailed"],
  ["notimage", "status.notImage"],
  ["toolarge", "status.tooLarge"],
  ["badurl", "status.badUrl"],
  ["urlsoff", "status.urlsOff"],
  ["expired", "status.expired"],
  ["foundmany", "status.foundMany"],
  ["copy", "copy"],
  ["copied", "copied"],
  ["open", "open"],
];

/** The panel HTML. `tr(key)` must return text that is already safe inside HTML. */
const _panel = (tr, { url, text, sign, source, key }) => {
  const urlsOn = _imageUrlsOn(source);
  const webUrl = url && !_isDataUrl(url);
  const src = webUrl && !urlsOn ? "" : _sourceFor(url, sign);
  const note = text
    ? tr("status.badUrl")
    : webUrl && !urlsOn
      ? tr("status.urlsOff")
      : url && !src
        ? tr("status.loadFailed")
        : "";
  const signUrl = urlsOn && apiBase ? _routeUrl(`/image?${new URLSearchParams({ t: _issueToken(source) })}`) : "";
  return _render({
    src: _esc(src),
    signUrl: _esc(signUrl),
    decoderUrl: _esc(_routeUrl(`/decoder.js?v=${VERSION}`)),
    key: _esc(key),
    messages: CLIENT_MESSAGES.map(([attr, k]) => `data-qrscan-msg-${attr}="${tr(k)}"`).join(" "),
    dropLabel: tr("drop.label"),
    dropTitle: tr("drop.title"),
    dropHint: tr("drop.hint"),
    browse: tr("browse"),
    urlLabel: tr("url.label"),
    urlPlaceholder: tr("url.placeholder"),
    urlValue: _esc(text || (_isDataUrl(url) ? "" : url)),
    scan: tr("scan"),
    status: note,
    statusKind: note ? "error" : "",
    previewAlt: tr("previewAlt"),
    again: tr("again"),
  });
};

/** Slots translate on the server, in the request's locale. */
const _slotTranslator = (locale) => (key) => {
  const translate = slot.t;
  return _esc(typeof translate === "function" ? translate(`${NS}.${key}`, undefined, locale) : key);
};

// Commands get no locale in 1.1.1. degoog translates {{ t:… }} in their HTML before sending it, without
// escaping, so the locale files must not contain characters that need escaping (a test checks this).
const _placeholder = (key) => `{{ t:${NS}.${key} }}`;

const _plain = (status, text) =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

// init() runs once for the slot and once for the command. Both share this module's state.
const _init = (ctx) => {
  if (typeof ctx?.template === "string" && ctx.template) template = ctx.template;
  if (typeof ctx?.apiBase === "string" && ctx.apiBase) apiBase = ctx.apiBase.replace(/\/+$/, "");
  if (typeof ctx?.readFile === "function") readFile = ctx.readFile;
  if (typeof ctx?.signProxyUrl === "function") signProxy = ctx.signProxyUrl;
};

const _loadDecoder = async () => {
  if (decoderSource) return decoderSource;
  if (typeof readFile !== "function") return null;
  const source = await readFile(DECODER_FILE);
  if (typeof source !== "string" || !source) return null;
  decoderSource = source;
  return decoderSource;
};

const IMAGE_URLS_SETTING = {
  key: "imageUrls",
  label: "Scan image links",
  type: "toggle",
  default: "true",
  description:
    "Load images from links through degoog’s image proxy, which refuses private addresses and anything that isn’t an image. Turn this off on a public instance to keep visitors from using the proxy for arbitrary images. Files, pasted images, SVG and base64 still work.",
};

export const routes = [
  {
    // jsQR is ~250 KB, so it is only fetched the first time a browser has to decode without BarcodeDetector.
    method: "get",
    path: "/decoder.js",
    rateLimit: true,
    async handler() {
      const source = await _loadDecoder().catch(() => null);
      if (!source) return _plain(503, "Unavailable");
      return new Response(source, {
        status: 200,
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=604800, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  },
  {
    // Signs an image link the visitor pasted into a panel and redirects to degoog's image proxy, which blocks
    // private addresses, caps the size and only passes images. It needs the token issued with the panel.
    method: "get",
    path: "/image",
    rateLimit: true,
    async handler(request) {
      const params = new URL(request.url).searchParams;
      const source = _checkToken(params.get("t"));
      if (!source) return _plain(403, "Forbidden");
      if (!_imageUrlsOn(source)) return _plain(404, "Not found");
      const url = _imageUrl(params.get("url") || "");
      if (!url || _isDataUrl(url)) return _plain(400, "Bad request");
      const target = _sourceFor(url);
      if (!target) return _plain(503, "Unavailable");
      return new Response(null, {
        status: 302,
        headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      });
    },
  },
];

export const slot = {
  id: "qr-scanner",
  name: "QR Code Scanner",
  description:
    "Reads QR codes from an image you browse for, paste, drag in or link to, when you search for something like “qr code reader”.",
  isClientExposed: false,
  supportsNojs: false,
  position: "at-a-glance",
  slotPositions: ["at-a-glance", "above-results", "above-sidebar", "below-sidebar"],

  settingsSchema: [
    {
      key: "bareQr",
      label: "Show for a plain “qr”",
      type: "toggle",
      default: "true",
      description:
        "Show the scanner when the whole search is just “qr” or “qr code”. Searches such as “qr code reader” or “scan qr” always show it.",
    },
    IMAGE_URLS_SETTING,
  ],

  init(ctx) {
    _init(ctx);
  },

  configure(next) {
    slotSettings.bareQr = _flag(next?.bareQr, true);
    slotSettings.imageUrls = _flag(next?.imageUrls, true);
  },

  // Runs on every search, so it never encodes SVG markup; execute() does that once.
  trigger(query) {
    const parsed = _parseQuery(query, { encode: false, imageUrls: slotSettings.imageUrls });
    return Boolean(parsed) && (!parsed.bare || slotSettings.bareQr);
  },

  async execute(query, context) {
    const parsed = _parseQuery(query, { imageUrls: slotSettings.imageUrls });
    if (!parsed || (parsed.bare && !slotSettings.bareQr)) return { title: "", html: "" };
    const tr = _slotTranslator(context?.locale);
    const html = _panel(tr, {
      url: parsed.url,
      text: "",
      sign: context?.signProxyUrl,
      source: "s",
      key: _searchKey(`s:${String(query).trim()}`),
    });
    return { title: tr("title"), html };
  },
};

const COMMAND_TITLE = "QR Code Scanner";

const command = {
  name: COMMAND_TITLE,
  description: "Reads a QR code from an image URL, or opens a scanner for an image you browse for, paste or drop.",
  trigger: "qrscan",
  aliases: ["qrread", "qrdecode"],
  isClientExposed: false,
  supportsNojs: false,
  settingsSchema: [IMAGE_URLS_SETTING],

  init(ctx) {
    _init(ctx);
  },

  configure(next) {
    commandSettings.imageUrls = _flag(next?.imageUrls, true);
  },

  async execute(args, context) {
    const { url, text } = _parseArgs(args);
    const html = _panel(_placeholder, {
      url,
      text,
      sign: context?.signProxyUrl,
      source: "c",
      key: _searchKey(`c:${String(args ?? "").trim()}`),
    });
    // degoog 1.1.1 only translates {{ t:… }} in a command's html, not its title, and gives commands no locale.
    return { title: COMMAND_TITLE, html: `<div class="command-result qrscan-command">${html}</div>` };
  },
};

export const _internals = {
  parseQuery: _parseQuery,
  parseArgs: _parseArgs,
  imageUrl: _imageUrl,
  trimUrl: _trimUrl,
  findSvgMarkup,
  issueToken: _issueToken,
  checkToken: _checkToken,
  resetDecoder: () => {
    decoderSource = null;
  },
};

// The command registry takes the default export, so it has to be the command (degoog 1.1.1).
// The slot and route registries read the named `slot` and `routes` exports.
export default command;
