const NS = "fandom";
const MAX_INPUT = 300;
const MAX_TERM = 100;
const MAX_TERM_WORDS = 8;
const MAX_WIKIS = 10;
const MAX_KEYWORDS = 10;
const MAX_KEYWORD_WORDS = 5;
const LOOKUP_TIMEOUT_MS = 4000;
// degoog drops a slot after 10 s, so the card is rendered by 9 s at the latest.
const EXECUTE_BUDGET_MS = 9000;
const HIT_CACHE_MS = 6 * 3600 * 1000;
const MISS_CACHE_MS = 3600 * 1000;
const CACHE_LIMIT = 1000;
const THUMB_WIDTH = 400;
const SUMMARY_MAX = 320;
const FACT_MAX = 120;
const LABEL_MAX = 40;
const FACTS_LIMIT = 10;
const DEFAULT_FACTS = 5;
const MAX_INFOBOX_JSON = 200_000;
const MAX_INFOBOXES = 5;
const MAX_HTML = 5000;
const MAX_PARSE_HTML = 400_000;
// Uncached wiki lookups allowed per minute across all visitors. The slot endpoint is public, so this
// stops a flood of unique searches from turning into a flood of requests to Fandom.
const LOOKUP_BUDGET_PER_MINUTE = 120;
const NAME_MAX = 80;

const FANDOM_SUFFIX = ".fandom.com";
const IMAGE_HOSTS = new Set(["static.wikia.nocookie.net", "vignette.wikia.nocookie.net", "images.wikia.com"]);
const GENERIC_WORDS = new Set(["wiki", "fandom"]);
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "vs", "with"]);
const OPERATOR_RX = /(?:^|\s)(?:site|inurl|intitle|intext|allintitle|allinurl|filetype|ext|lang|before|after|cache|related|define):/i;
// Characters MediaWiki never allows in a title. "|" would also split the titles parameter.
const BAD_TITLE_RX = /[#<>[\]|{}]/;
const LANG_PATH_RX = /^[a-z]{2}(?:-[a-z]{2,4})?$/;
const SUBDOMAIN_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DISAMBIG_TEXT_RX = /\bmay (?:also )?refer to\b/i;
const HATNOTE_RXS = [
  /^For\b[^.]{0,200}?,\s*see\b[^.]{0,200}\.\s*/,
  /^(?:This (?:article|page) is about|Not to be confused with)\b[^.]{0,200}\.\s*/,
  /^["“][^"”]{1,400}["”]\s*[—–-]{1,2}\s*[^.]{1,200}\.\s*/,
];

let template = "";
let pluginFetch = null;
let pluginSign = null;
const settings = { wikis: [], bareMatch: true, showImage: true, showFacts: true, maxFacts: DEFAULT_FACTS };

const lookupCache = new Map();
const lookupInflight = new Map();

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

const _int = (value, fallback, min, max) => {
  const text = String(value ?? "").trim();
  if (!/^-?\d{1,6}$/.test(text)) return fallback;
  return Math.min(max, Math.max(min, Number(text)));
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

/** Lowercase tokens for keyword matching: apostrophes removed, whitespace collapsed. */
const _keyTokens = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** Folds a title for loose comparison: case, spaces and punctuation are ignored. */
const _fold = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[\s"“”'‘’:.,;!?\-–—_()/]+/g, "");

// ---------------------------------------------------------------- settings

/** "callofduty", "callofduty.fandom.com/wiki/X", "https://naruto.fandom.com/es/" → wiki base URL, or null. */
const _parseWikiUrl = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 300) return null;
  if (SUBDOMAIN_RX.test(text.toLowerCase())) return { base: `https://${text.toLowerCase()}${FANDOM_SUFFIX}`, sub: text.toLowerCase() };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(FANDOM_SUFFIX)) return null;
  const sub = host.slice(0, -FANDOM_SUFFIX.length);
  if (!SUBDOMAIN_RX.test(sub)) return null;
  const first = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  const lang = LANG_PATH_RX.test(first) ? `/${first}` : "";
  return { base: `https://${host}${lang}`, sub };
};

const _parseKeywords = (raw) => {
  const out = [];
  for (const part of String(raw ?? "").split(",")) {
    const tokens = _keyTokens(part);
    if (!tokens.length || tokens.length > MAX_KEYWORD_WORDS) continue;
    if (tokens.every((token) => GENERIC_WORDS.has(token))) continue;
    if (out.some((kw) => kw.join(" ") === tokens.join(" "))) continue;
    out.push(tokens);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
};

/** The wikis setting arrives as a JSON string of rows ({url, keywords}); arrays are accepted too. */
const _parseWikis = (raw) => {
  let rows = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    try {
      rows = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(rows)) return [];
  const wikis = [];
  for (const row of rows) {
    const source = typeof row === "string" ? { url: row } : row;
    if (!source || typeof source !== "object") continue;
    const parsed = _parseWikiUrl(source.url);
    if (!parsed || wikis.some((wiki) => wiki.base === parsed.base)) continue;
    const keywords = _parseKeywords(source.keywords);
    if (!keywords.some((kw) => kw.length === 1 && kw[0] === parsed.sub)) keywords.push([parsed.sub]);
    wikis.push({ base: parsed.base, host: new URL(parsed.base).hostname, keywords });
    if (wikis.length >= MAX_WIKIS) break;
  }
  return wikis;
};

// ---------------------------------------------------------------- query parsing

const _startsWith = (keys, kw, at = 0) => kw.every((token, i) => keys[at + i] === token);

/**
 * Splits a query into the page title to look up and the wikis to search, or null.
 * Forms: "<title>" (bare, all wikis), "<kw> <title>" and "<title> <kw>" (the keyword's wikis only),
 * "<title> fandom" and "<title> wiki" (all wikis). Returns attempts in priority order.
 */
const _parseQuery = (query) => {
  if (typeof query !== "string" || query.length > MAX_INPUT || !settings.wikis.length) return null;
  let text = query.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  text = text.replace(/[?!]+$/, "").trim();
  if (/\.$/.test(text) && text.indexOf(".") === text.length - 1) text = text.slice(0, -1).trim();
  if (text.length < 2 || text.startsWith("!")) return null;
  if (BAD_TITLE_RX.test(text) || OPERATOR_RX.test(text) || /:\/\/|(?:^|\s)www\./i.test(text)) return null;
  const tokens = text.split(" ");
  if (tokens.length > MAX_TERM_WORDS + MAX_KEYWORD_WORDS + 1) return null;
  const keys = tokens.map((token) => token.toLowerCase().replace(/'/g, ""));
  if (keys.every((key) => GENERIC_WORDS.has(key))) return null;

  let end = keys.length;
  while (end > 1 && GENERIC_WORDS.has(keys[end - 1]) && keys.length - end < 2) end -= 1;
  const generic = end < keys.length;

  // "cod wiki" asks for the wiki itself, not for a page called "cod".
  if (generic && settings.wikis.some((wiki) => wiki.keywords.some((kw) => kw.length === end && _startsWith(keys, kw)))) return null;

  // The longest matching keyword wins, so "star wars" on one wiki beats "star" on another.
  let best = null;
  const scoped = [];
  for (const wiki of settings.wikis) {
    for (const kw of wiki.keywords) {
      let found = null;
      if (kw.length < end && _startsWith(keys, kw)) {
        let start = kw.length;
        if (GENERIC_WORDS.has(keys[start]) && start + 1 < end) start += 1;
        found = tokens.slice(start, end).join(" ");
      } else if (kw.length < end && _startsWith(keys, kw, end - kw.length)) {
        found = tokens.slice(0, end - kw.length).join(" ");
      }
      if (found === null) continue;
      if (!best || kw.length > best.length) {
        best = { length: kw.length, term: found };
        scoped.length = 0;
        scoped.push(wiki);
      } else if (kw.length === best.length && found === best.term && !scoped.includes(wiki)) {
        scoped.push(wiki);
      }
    }
  }

  const attempts = [];
  const add = (candidate, wikis) => {
    if (!candidate || candidate.length < 2 || candidate.length > MAX_TERM) return;
    if (candidate.split(" ").length > MAX_TERM_WORDS || !/\p{L}/u.test(candidate)) return;
    attempts.push({ term: candidate, wikis });
  };
  if (scoped.length) {
    add(best.term, scoped);
    // A keyword can also start a title ("call of duty modern warfare"), so with bare matching on
    // the whole query is tried too, but still only on the keyword's wikis.
    if (settings.bareMatch && !generic) add(text, scoped);
  } else if (generic) add(tokens.slice(0, end).join(" "), settings.wikis);
  else if (settings.bareMatch) add(text, settings.wikis);
  return attempts.length ? attempts : null;
};

// ---------------------------------------------------------------- lookup

const _upperFirst = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** Case variants of a title, most literal first. MediaWiki titles are case-sensitive after the first letter. */
const _variants = (term) => {
  const words = term.split(" ");
  const lower = term.toLowerCase();
  const list = [
    term,
    _upperFirst(term),
    words.map((word, i) => (i > 0 && SMALL_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : _upperFirst(word))).join(" "),
    words.map(_upperFirst).join(" "),
    _upperFirst(lower),
    words.map((word, i) => (i > 0 && SMALL_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : _upperFirst(word.toLowerCase()))).join(" "),
    term.toUpperCase(),
  ];
  return [...new Set(list)];
};

const _baseParams = () => ({
  action: "query",
  format: "json",
  formatversion: "2",
  redirects: "1",
  prop: "info|pageprops|pageimages|categories",
  ppprop: "fandomdescription|infoboxes|disambiguation",
  piprop: "thumbnail",
  pithumbsize: String(THUMB_WIDTH),
  inprop: "url",
  clshow: "!hidden",
  cllimit: "max",
  meta: "siteinfo|filerepoinfo",
  siprop: "general",
});

const _isArticle = (page) => {
  if (!page || typeof page !== "object" || page.ns !== 0 || page.missing || page.invalid) return false;
  if (page.pageprops && "disambiguation" in page.pageprops) return false;
  if (Array.isArray(page.categories) && page.categories.some((cat) => /disambig/i.test(String(cat?.title ?? "")))) return false;
  return !DISAMBIG_TEXT_RX.test(String(page.pageprops?.fandomdescription ?? ""));
};

const _pagesByTitle = (query) => new Map((Array.isArray(query?.pages) ? query.pages : []).map((page) => [page?.title, page]));
const _mapOf = (list) => new Map((Array.isArray(list) ? list : []).map((entry) => [entry?.from, entry?.to]));

/** The first variant, in order, that resolves (through normalisation and redirects) to an article. */
const _pickExact = (query, variants) => {
  const pages = _pagesByTitle(query);
  const normalized = _mapOf(query?.normalized);
  const redirects = _mapOf(query?.redirects);
  for (const variant of variants) {
    let title = normalized.get(variant) ?? variant;
    title = redirects.get(title) ?? title;
    const page = pages.get(title);
    if (page && !page.missing) return _isArticle(page) ? page : null;
  }
  return null;
};

/** A prefix-search result whose own title, or a redirect to it, equals the term apart from case and punctuation. */
const _pickSearch = (query, term) => {
  const target = _fold(term);
  const pages = _pagesByTitle(query);
  const ordered = [...pages.values()].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
  for (const redirect of Array.isArray(query?.redirects) ? query.redirects : []) {
    if (_fold(redirect?.from) !== target) continue;
    const page = pages.get(redirect.to);
    if (_isArticle(page)) return page;
  }
  return ordered.find((page) => _fold(page?.title) === target && _isArticle(page)) ?? null;
};

const _allowedImage = (value) => {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return IMAGE_HOSTS.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
};

/** The full-size file behind a scaled Fandom image URL ("…/revision/latest/scale-to-width-down/400?cb=1"). */
const _originalImage = (url) => (url ? _allowedImage(url.replace(/\/scale-to-width-down\/\d+(?=[/?]|$)/, "")) : null);

/** A full-size infobox image URL, scaled down like the page image thumbnail. */
const _scaled = (url) => (url && /\/revision\/latest(?=\?|$)/.test(url) ? url.replace(/\/revision\/latest(?=\?|$)/, `/revision/latest/scale-to-width-down/${THUMB_WIDTH}`) : url);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const _decode = (text) =>
  text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (match, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });

const BREAK_TAGS = new Set(["br", "li", "/li", "p", "/p", "div", "/div", "tr", "/tr"]);

/** Plain text from a short HTML fragment: tags dropped, line breaks become ", ", references removed. */
const _htmlToText = (html) => {
  const source = String(html ?? "").slice(0, MAX_HTML);
  let out = "";
  let skipUntil = "";
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    const chunk = lt === -1 ? source.slice(i) : source.slice(i, lt);
    if (!skipUntil) out += chunk;
    if (lt === -1) break;
    const gt = source.indexOf(">", lt);
    if (gt === -1) break;
    const name = (/^<\s*(\/?[a-z0-9]+)/i.exec(source.slice(lt, Math.min(gt + 1, lt + 24)))?.[1] ?? "").toLowerCase();
    if (skipUntil) {
      if (name === skipUntil) skipUntil = "";
    } else if (name === "sup" || name === "style" || name === "script") {
      if (source[gt - 1] !== "/") skipUntil = `/${name}`;
    } else if (BREAK_TAGS.has(name)) {
      out += ", ";
    }
    i = gt + 1;
  }
  return _decode(out)
    .replace(/\s+/g, " ")
    .replace(/\s*,(?:\s*,)+/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
};

const _clip = (text, max) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
};

/**
 * The leading complete elements of a JSON array of objects, even when the array itself is cut off.
 * MediaWiki caps page props at 65535 bytes, so pages with many infoboxes get truncated JSON.
 * One linear, string-aware pass.
 */
const _jsonObjects = (raw, limit) => {
  const out = [];
  if (raw[0] !== "[") return out;
  let depth = 0;
  let inString = false;
  let start = -1;
  for (let i = 1; i < raw.length && out.length < limit; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          break;
        }
        start = -1;
      }
    }
  }
  return out;
};

/** Rows and the first image of one portable infobox. */
const _readInfobox = (box) => {
  const result = { facts: [], image: null };
  if (!box || !Array.isArray(box.data)) return result;
  const seen = new Set();
  let visits = 0;
  const walk = (nodes, depth) => {
    if (!Array.isArray(nodes) || depth > 6) return;
    for (const node of nodes) {
      if (++visits > 500 || result.facts.length >= FACTS_LIMIT) return;
      if (!node || typeof node !== "object") continue;
      const data = node.data;
      if (node.type === "data" && data && typeof data === "object") {
        const label = _clip(_htmlToText(data.label), LABEL_MAX);
        const value = _htmlToText(data.value);
        if (!label || !value || value === "-" || seen.has(label.toLowerCase())) continue;
        seen.add(label.toLowerCase());
        result.facts.push([label, _clip(value, FACT_MAX)]);
      } else if (node.type === "image" && !result.image) {
        const images = Array.isArray(data) ? data : [data];
        result.image = _allowedImage(images.find((img) => img && !img.isVideo)?.url);
      } else if (node.type === "group" || node.type === "section") {
        walk(data?.value, depth + 1);
      } else if (node.type === "panel") {
        // Tabbed panels repeat their rows per tab: only read the first tab.
        walk(Array.isArray(data?.value) ? data.value.slice(0, 1) : [], depth + 1);
      }
    }
  };
  walk(box.data, 0);
  return result;
};

/**
 * Facts and image from the page's first infobox that has labelled rows. Navigation boxes
 * ("Original · Reboot · Mobile") come first on some pages and have none.
 */
const _parseInfobox = (raw) => {
  if (typeof raw !== "string" || !raw || raw.length > MAX_INFOBOX_JSON) return { facts: [], image: null };
  let fallback = null;
  for (const box of _jsonObjects(raw.trim(), MAX_INFOBOXES)) {
    const result = _readInfobox(box);
    if (result.facts.length) return { facts: result.facts, image: result.image ?? fallback };
    fallback ??= result.image;
  }
  return { facts: [], image: fallback };
};

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const SKIP_TAGS = new Set(["sup", "style", "script"]);

/**
 * Text of the paragraphs that sit directly in the parser output, which is the lead text. Hatnotes,
 * quotes, infoboxes and galleries all live inside other elements, so they are left out.
 * Linear: one pass over the tags with indexOf.
 */
const _introFromHtml = (html) => {
  const source = String(html ?? "").slice(0, MAX_PARSE_HTML);
  const stack = [];
  const paragraphs = [];
  let leadDepth = 0;
  let current = null;
  let skipDepth = 0;
  let total = 0;
  let i = 0;
  while (i < source.length && total < SUMMARY_MAX * 2) {
    const lt = source.indexOf("<", i);
    if (current !== null && !skipDepth) current += lt === -1 ? source.slice(i) : source.slice(i, lt);
    if (lt === -1) break;
    const gt = source.indexOf(">", lt);
    if (gt === -1) break;
    const match = /^<\s*(\/?)([a-z][a-z0-9]*)/i.exec(source.slice(lt, Math.min(gt + 1, lt + 24)));
    i = gt + 1;
    if (!match) continue;
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (VOID_TAGS.has(name) || source[gt - 1] === "/") {
      if (name === "br" && current !== null) current += " ";
      continue;
    }
    if (!closing) {
      // Paragraphs are direct children of the "mw-parser-output" wrapper, or top level without one.
      if (!leadDepth) leadDepth = /mw-parser-output/.test(source.slice(lt, gt)) ? 2 : 1;
      stack.push(name);
      if (name === "p" && stack.length === leadDepth && current === null) current = "";
      else if (current !== null && SKIP_TAGS.has(name)) skipDepth += 1;
      continue;
    }
    const at = stack.lastIndexOf(name);
    if (at === -1) continue;
    const closed = stack.splice(at);
    if (current !== null && skipDepth) skipDepth = Math.max(0, skipDepth - closed.filter((tag) => SKIP_TAGS.has(tag)).length);
    if (current !== null && stack.length < leadDepth) {
      const text = _decode(current).replace(/\s+/g, " ").trim();
      if (text) {
        paragraphs.push(text);
        total += text.length;
      }
      current = null;
      skipDepth = 0;
    }
  }
  return paragraphs.join(" ");
};

/** The page summary without the hatnotes and opening quote Fandom puts first. */
const _summary = (raw) => {
  let text = _decode(String(raw ?? "").slice(0, 4000)).replace(/\s+/g, " ").trim();
  const original = text;
  for (let pass = 0; pass < 6; pass += 1) {
    const before = text;
    for (const rx of HATNOTE_RXS) text = text.replace(rx, "");
    if (text === before) break;
  }
  if (!text) text = original;
  return _clip(text, SUMMARY_MAX);
};

const _siteInfo = (query, wiki) => {
  const general = query?.general ?? {};
  const name = typeof general.sitename === "string" && general.sitename.trim() ? general.sitename.trim().slice(0, NAME_MAX) : wiki.host;
  let favicon = typeof general.favicon === "string" ? general.favicon.trim() : "";
  if (favicon.startsWith("$wgUploadPath")) {
    const local = (Array.isArray(query?.repos) ? query.repos : []).find((repo) => repo?.name === "local");
    const root = _allowedImage(local?.url);
    favicon = root ? `${root.replace(/\/+$/, "")}${favicon.slice("$wgUploadPath".length)}` : "";
  }
  favicon = _allowedImage(favicon);
  if (favicon) {
    const url = new URL(favicon);
    if (url.hostname === "images.wikia.com") url.hostname = "static.wikia.nocookie.net";
    favicon = url.href;
  }
  return { name, favicon };
};

const _pageUrl = (page, wiki) => {
  try {
    const url = new URL(String(page.fullurl ?? ""));
    if (url.protocol === "https:" && url.hostname === wiki.host) return url.href;
  } catch {
    // fall through
  }
  return `${wiki.base}/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`;
};

const _toEntry = (page, query, wiki) => {
  const infobox = _parseInfobox(page.pageprops?.infoboxes);
  return {
    title: String(page.title),
    url: _pageUrl(page, wiki),
    description: _summary(page.pageprops?.fandomdescription),
    intro: undefined,
    introPending: null,
    image: _allowedImage(page.thumbnail?.source) ?? _scaled(infobox.image),
    facts: infobox.facts,
    site: _siteInfo(query, wiki),
  };
};

const _request = (wiki, params, fetcher) =>
  _withTimeout(LOOKUP_TIMEOUT_MS, async (signal) => {
    const url = `${wiki.base}/api.php?${new URLSearchParams(params)}`;
    const response = await fetcher(url, { signal, headers: { Accept: "application/json" } });
    if (!response || !response.ok) throw new Error(`status ${response?.status}`);
    const data = await response.json();
    if (!data || typeof data !== "object" || data.error) throw new Error("bad response");
    return data;
  });

/** Lead text of a page from its rendered first section, or null when the request fails. */
const _fetchIntro = async (wiki, title, fetcher) => {
  try {
    const params = { action: "parse", format: "json", formatversion: "2", page: title, prop: "text", section: "0", disablelimitreport: "1", disableeditsection: "1" };
    const data = await _request(wiki, params, fetcher);
    return _introFromHtml(data.parse?.text);
  } catch {
    return null;
  }
};

/**
 * The summary for the shown entry: its lead text, fetched once and kept with the cached entry.
 * Waits only until the deadline; a late intro still lands in the cache for the next search.
 */
const _entrySummary = async (entry, wiki, fetcher, deadline) => {
  if (entry.intro === undefined) {
    entry.introPending ??= _fetchIntro(wiki, entry.title, fetcher).then((intro) => {
      if (intro !== null) entry.intro = intro;
      entry.introPending = null;
      return intro;
    });
    const wait = deadline - Date.now();
    if (wait > 0) {
      let timer;
      await Promise.race([entry.introPending, new Promise((resolve) => (timer = setTimeout(resolve, wait)))]);
      clearTimeout(timer);
    }
  }
  return entry.intro ? _clip(entry.intro, SUMMARY_MAX) : entry.description;
};

const _fetchPage = async (wiki, term, fetcher) => {
  const variants = _variants(term);
  const query = (params) => _request(wiki, params, fetcher).then((data) => data.query ?? {});
  // A failing wiki throws here, so a slow one costs one timeout, not two.
  const exact = await query({ ..._baseParams(), titles: variants.join("|") });
  const exactPage = _pickExact(exact, variants);
  if (exactPage) return _toEntry(exactPage, exact, wiki);
  // The prefix search catches titles whose case or punctuation differ ("ak47" for "AK-47").
  const search = await query({ ..._baseParams(), generator: "prefixsearch", gpssearch: term, gpslimit: "5" });
  const page = _pickSearch(search, term);
  return page ? _toEntry(page, search, wiki) : null;
};

const budget = { start: 0, used: 0 };

const _takeBudget = () => {
  const now = Date.now();
  if (now - budget.start >= 60_000) {
    budget.start = now;
    budget.used = 0;
  }
  if (budget.used >= LOOKUP_BUDGET_PER_MINUTE) return false;
  budget.used += 1;
  return true;
};

/**
 * A page for the term on one wiki, cached. null when there is none, undefined when the lookup
 * failed or the budget is spent. The key keeps the term's case, since the lookup is case-sensitive.
 */
const _lookup = async (wiki, term, fetcher) => {
  const key = `${wiki.base}|${term}`;
  const cached = lookupCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (lookupInflight.has(key)) return lookupInflight.get(key);
  if (!_takeBudget()) return undefined;
  const pending = (async () => {
    try {
      const value = await _fetchPage(wiki, term, fetcher);
      _remember(lookupCache, key, { value, expires: Date.now() + (value ? HIT_CACHE_MS : MISS_CACHE_MS) }, CACHE_LIMIT);
      return value;
    } catch {
      return undefined;
    } finally {
      lookupInflight.delete(key);
    }
  })();
  lookupInflight.set(key, pending);
  return pending;
};

// ---------------------------------------------------------------- rendering

/** The first truthy result in list order, as soon as every earlier promise has settled. */
const _firstInOrder = (promises) =>
  new Promise((resolve) => {
    const values = new Array(promises.length);
    const settled = new Array(promises.length).fill(false);
    let next = 0;
    let done = false;
    const advance = () => {
      while (!done && next < promises.length && settled[next]) {
        if (values[next]) {
          done = true;
          resolve({ index: next, value: values[next] });
          return;
        }
        next += 1;
      }
      if (!done && next >= promises.length) {
        done = true;
        resolve(null);
      }
    };
    promises.forEach((promise, i) =>
      Promise.resolve(promise)
        .catch(() => undefined)
        .then((value) => {
          values[i] = value;
          settled[i] = true;
          advance();
        }),
    );
    advance();
  });

const _sign = (url, sign) => {
  if (!url || typeof sign !== "function") return "";
  try {
    const signed = sign(url);
    return typeof signed === "string" ? signed : "";
  } catch {
    return "";
  }
};

const _renderEntry = (entry, summary, wiki, locale, sign) => {
  const image = settings.showImage ? _sign(entry.image, sign) : "";
  // The link opens the full-size image through degoog's image proxy too, so visitors never contact Fandom.
  const fullImage = image ? _sign(_originalImage(entry.image), sign) || image : "";
  const openImage = _esc(_t("openImage", undefined, locale));
  const favicon = _sign(entry.site.favicon, sign);
  const facts = settings.showFacts ? entry.facts.slice(0, settings.maxFacts) : [];
  const html = _render({
    wiki: _esc(wiki.host),
    url: _esc(entry.url),
    title: _esc(entry.title),
    image: image
      ? `<a class="fandom-thumb-link" href="${_esc(fullImage)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label="${openImage}" title="${openImage}" data-fandom-open-image>` +
        `<img class="fandom-thumb" src="${_esc(image)}" alt="${_esc(_t("imageAlt", { title: entry.title }, locale))}" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fandom-image></a>`
      : "",
    summary: summary ? `<p class="fandom-summary" data-fandom-summary>${_esc(summary)}</p>` : "",
    facts: facts.length
      ? `<dl class="fandom-facts" data-fandom-facts>${facts
          .map(
            ([label, value], i) =>
              `<div class="fandom-fact" data-fandom-row="${i}"><dt class="fandom-label">${_esc(label)}</dt><dd class="fandom-value">${_esc(value)}</dd></div>`,
          )
          .join("")}</dl>`
      : "",
    favicon: favicon
      ? `<img class="fandom-favicon" src="${_esc(favicon)}" alt="" width="16" height="16" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fandom-favicon>`
      : "",
    more: _esc(_t("readMore", { wiki: entry.site.name }, locale)),
  });
  return { title: entry.title, html };
};

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

export const slot = {
  id: "fandom",
  name: "Fandom",
  description:
    "Shows a summary card with an image, key facts and a link when a search matches a page on one of the Fandom wikis you add, such as callofduty.fandom.com.",
  isClientExposed: false,
  supportsNojs: true,
  position: "knowledge-panel",
  slotPositions: ["knowledge-panel", "above-sidebar", "below-sidebar", "at-a-glance", "above-results"],

  settingsSchema: [
    {
      key: "wikis",
      label: "Wikis",
      type: "list",
      default: "[]",
      addLabel: "Add wiki",
      description:
        "Fandom wikis to search, in order of priority. Searches that pass a quick check are looked up on each wiki by your degoog server.",
      itemSchema: [
        {
          key: "url",
          label: "Wiki URL",
          type: "url",
          required: true,
          placeholder: "https://callofduty.fandom.com",
          description: "Address of a wiki on fandom.com. Language wikis such as https://naruto.fandom.com/es work too.",
        },
        {
          key: "keywords",
          label: "Keywords",
          type: "text",
          placeholder: "cod, call of duty",
          description:
            "Optional, comma separated. A search starting or ending with one, such as \"cod ghost\", only looks on this wiki. The wiki's subdomain always works.",
        },
      ],
    },
    {
      key: "bareMatch",
      label: "Match page titles on their own",
      type: "toggle",
      default: "true",
      description:
        "Show a card when the whole search is a page title, such as \"simon riley\". Turn off to need a keyword, or \"wiki\" or \"fandom\" at the end.",
    },
    {
      key: "showImage",
      label: "Show image",
      type: "toggle",
      default: "true",
      description: "Show the page's main image. Images are loaded through degoog's image proxy.",
    },
    {
      key: "showFacts",
      label: "Show facts",
      type: "toggle",
      default: "true",
      description: "List rows from the page's infobox.",
    },
    {
      key: "maxFacts",
      label: "Number of facts",
      type: "number",
      default: String(DEFAULT_FACTS),
      min: "1",
      max: String(FACTS_LIMIT),
      description: `How many infobox rows to show, from 1 to ${FACTS_LIMIT}.`,
    },
  ],

  init(ctx) {
    template = ctx?.template || "";
    pluginFetch = typeof ctx?.fetch === "function" ? ctx.fetch : null;
    pluginSign = typeof ctx?.signProxyUrl === "function" ? ctx.signProxyUrl : null;
  },

  configure(next) {
    settings.wikis = _parseWikis(next?.wikis);
    settings.bareMatch = _flag(next?.bareMatch, true);
    settings.showImage = _flag(next?.showImage, true);
    settings.showFacts = _flag(next?.showFacts, true);
    settings.maxFacts = _int(next?.maxFacts, DEFAULT_FACTS, 1, FACTS_LIMIT);
  },

  trigger(query) {
    return _parseQuery(query) !== null;
  },

  async execute(query, context) {
    const empty = { title: "", html: "" };
    const deadline = Date.now() + EXECUTE_BUDGET_MS;
    const attempts = _parseQuery(query);
    if (!attempts) return empty;
    const fetcher = typeof context?.fetch === "function" ? context.fetch : pluginFetch;
    if (typeof fetcher !== "function") return empty;
    const sign = typeof context?.signProxyUrl === "function" ? context.signProxyUrl : pluginSign;
    try {
      // Every attempt and wiki is looked up at once; the first in priority order wins.
      const jobs = attempts.flatMap(({ term, wikis }) => wikis.map((wiki) => ({ term, wiki })));
      const hit = await _firstInOrder(jobs.map(({ term, wiki }) => _lookup(wiki, term, fetcher)));
      if (!hit) return empty;
      const { wiki } = jobs[hit.index];
      const summary = await _entrySummary(hit.value, wiki, fetcher, deadline);
      return _renderEntry(hit.value, summary, wiki, _safeLocale(context?.locale), sign);
    } catch {
      return empty;
    }
  },
};

export const _internals = {
  parseQuery: _parseQuery,
  parseWikiUrl: _parseWikiUrl,
  parseWikis: _parseWikis,
  variants: _variants,
  fold: _fold,
  summary: _summary,
  parseInfobox: _parseInfobox,
  htmlToText: _htmlToText,
  originalImage: _originalImage,
  introFromHtml: _introFromHtml,
  jsonObjects: _jsonObjects,
  siteInfo: _siteInfo,
  settings: () => settings,
  firstInOrder: _firstInOrder,
  budgetPerMinute: LOOKUP_BUDGET_PER_MINUTE,
  clearCaches: () => {
    budget.start = 0;
    budget.used = 0;
    lookupCache.clear();
    lookupInflight.clear();
  },
};

export default { slot };
