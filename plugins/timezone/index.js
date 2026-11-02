const NS = "timezone";
const MAX_QUERY_LEN = 120;
const MAX_TOKENS = 20;
const MAX_TARGETS = 6;
const MAX_LOOKUP_WORDS = 4;
const GEOCODER_URL = "https://geocoding-api.open-meteo.com/v1/search";
const LOOKUP_TIMEOUT_MS = 4000;
const LOOKUP_CACHE_MS = 24 * 3600 * 1000;
const TIME_FORMATS = new Set(["auto", "12h", "24h"]);

// ---------------------------------------------------------------------------
// Time zone maths. script.js carries a copy of this block so the browser can
// re-render panels for its own zone; keep the two in sync (tests compare them).
// ---------------------------------------------------------------------------

// <shared-core>
const DAY_MS = 86400000;
const MINUTE_MS = 60000;
const TRANSITION_STEP_MS = 4 * DAY_MS;
const FIXED_ZONE_RX = /^([+-])(\d{2}):(\d{2})$/;
const LETTER_ABBR_RX = /^[A-Z]{2,5}$/;
const OFFSET_NAME_RX = /^(?:GMT|UTC)(?:[+\-−]|$)/;
const ABBR_LOCALES = ["en-US", "en-CA", "en-GB", "en-AU", "en-IN", "en-ZA", "en-SG", "ja-JP"];
const KNOWN_ABBR = {
  "Asia/Seoul": ["KST"],
  "Asia/Shanghai": ["CST"],
  "Asia/Taipei": ["CST"],
  "Asia/Hong_Kong": ["HKT"],
  "Asia/Manila": ["PHT"],
  "Asia/Karachi": ["PKT"],
  "Asia/Bangkok": ["ICT"],
  "Asia/Ho_Chi_Minh": ["ICT"],
  "Asia/Saigon": ["ICT"],
  "Asia/Jakarta": ["WIB"],
  "Asia/Makassar": ["WITA"],
  "Asia/Jayapura": ["WIT"],
  "Asia/Kuala_Lumpur": ["MYT"],
  "Asia/Kathmandu": ["NPT"],
  "Asia/Katmandu": ["NPT"],
  "Asia/Yangon": ["MMT"],
  "Asia/Rangoon": ["MMT"],
  "Asia/Riyadh": ["AST"],
  "Asia/Tehran": ["IRST"],
  "Asia/Jerusalem": ["IST", "IDT"],
  "Europe/Dublin": ["GMT", "IST"],
  "Europe/Moscow": ["MSK"],
  "Europe/Istanbul": ["TRT"],
  "Africa/Cairo": ["EET", "EEST"],
  "Africa/Lagos": ["WAT"],
  "Africa/Nairobi": ["EAT"],
  "Africa/Maputo": ["CAT"],
  "America/Sao_Paulo": ["BRT"],
  "America/Argentina/Buenos_Aires": ["ART"],
  "America/Santiago": ["CLT", "CLST"],
  "America/Bogota": ["COT"],
  "America/Lima": ["PET"],
};
const CITY_LABELS = {
  UTC: "UTC",
  "Etc/UTC": "UTC",
  "Asia/Calcutta": "Kolkata",
  "Asia/Saigon": "Ho Chi Minh City",
  "Asia/Ho_Chi_Minh": "Ho Chi Minh City",
  "Asia/Rangoon": "Yangon",
  "Asia/Katmandu": "Kathmandu",
  "Europe/Kiev": "Kyiv",
  "America/Godthab": "Nuuk",
  "Atlantic/Faeroe": "Faroe Islands",
  "Atlantic/Faroe": "Faroe Islands",
  "Pacific/Truk": "Chuuk",
  "Pacific/Ponape": "Pohnpei",
  "Pacific/Enderbury": "Kanton",
  "America/St_Johns": "St. John’s",
  "America/Indiana/Indianapolis": "Indianapolis",
};
const DATE_STYLES = {
  full: { weekday: "long", year: "numeric", month: "long", day: "numeric" },
  medium: { weekday: "short", year: "numeric", month: "short", day: "numeric" },
  short: { weekday: "short", month: "short", day: "numeric" },
};
const RELATIVE_UNITS = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.34524],
  ["month", 12],
  ["year", Infinity],
];
const OFFSET_PARTS = {
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

const dtfCache = new Map();
const offsetFormatters = new Map();
const abbrCache = new Map();
const canonCache = new Map();
const transitionCache = new Map();

const _remember = (cache, key, value, limit) => {
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
};

const _dtf = (locale, options) => {
  const key = `${locale}|${JSON.stringify(options)}`;
  return dtfCache.get(key) || _remember(dtfCache, key, new Intl.DateTimeFormat(locale, options), 400);
};

const _utcMs = (year, monthIndex, day, hours = 0, minutes = 0, seconds = 0) => {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hours, minutes, seconds, 0);
  return date.getTime();
};

const _fixedOffset = (zone) => {
  const match = FIXED_ZONE_RX.exec(String(zone || ""));
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
};

const _canon = (zone) => {
  if (!zone || _fixedOffset(zone) !== null) return zone || "";
  if (canonCache.has(zone)) return canonCache.get(zone);
  let id = zone;
  try {
    id = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    id = zone;
  }
  if (id === "Etc/UTC" || id === "Etc/GMT" || id === "GMT") id = "UTC";
  return _remember(canonCache, zone, id, 200);
};

const _offsetAt = (zone, ms) => {
  const fixed = _fixedOffset(zone);
  if (fixed !== null) return fixed;
  let formatter = offsetFormatters.get(zone);
  if (!formatter) {
    formatter = _remember(
      offsetFormatters,
      zone,
      new Intl.DateTimeFormat("en-US", { ...OFFSET_PARTS, timeZone: zone }),
      200,
    );
  }
  const parts = formatter.formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const wall = _utcMs(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
};

const _zoneParts = (zone, ms) => {
  const date = new Date(ms + _offsetAt(zone, ms) * MINUTE_MS);
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    h: date.getUTCHours(),
    mi: date.getUTCMinutes(),
    wd: date.getUTCDay(),
  };
};

const _hourOptions = (clock) => {
  if (clock === "12h") return { hour12: true };
  if (clock === "24h") return { hourCycle: "h23" };
  return {};
};

const _format = (zone, ms, locale, options) => {
  const fixed = _fixedOffset(zone);
  const date = new Date(fixed === null ? ms : ms + fixed * MINUTE_MS);
  return _dtf(locale, { ...options, timeZone: fixed === null ? zone : "UTC" }).format(date);
};

const _fmtTime = (zone, ms, locale, clock, seconds) =>
  _format(zone, ms, locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    ..._hourOptions(clock),
  });

const _fmtDate = (zone, ms, locale, style) => _format(zone, ms, locale, DATE_STYLES[style] || DATE_STYLES.short);

const _fmtOffset = (minutes) => {
  const abs = Math.abs(minutes);
  const rest = abs % 60;
  return `UTC${minutes < 0 ? "−" : "+"}${Math.floor(abs / 60)}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
};

const _isDst = (zone, ms) => {
  if (_fixedOffset(zone) !== null) return false;
  const year = new Date(ms).getUTCFullYear();
  const january = _offsetAt(zone, _utcMs(year, 0, 1));
  const july = _offsetAt(zone, _utcMs(year, 6, 1));
  if (january === july) return false;
  return _offsetAt(zone, ms) > Math.min(january, july);
};

const _zoneName = (zone, ms, locale, style) => {
  try {
    const name = _dtf(locale, { timeZone: zone, timeZoneName: style })
      .formatToParts(new Date(ms))
      .find((part) => part.type === "timeZoneName")?.value;
    return name && !OFFSET_NAME_RX.test(name) ? name : "";
  } catch {
    return "";
  }
};

const _abbrFor = (zone, ms, locale) => {
  if (!zone || _fixedOffset(zone) !== null) return "";
  if (_canon(zone) === "UTC") return "UTC";
  const dst = _isDst(zone, ms);
  const key = `${zone}|${dst}|${locale}`;
  if (abbrCache.has(key)) return abbrCache.get(key);
  let found = "";
  for (const candidate of [locale, ...ABBR_LOCALES]) {
    try {
      const name = _dtf(candidate, { timeZone: zone, timeZoneName: "short" })
        .formatToParts(new Date(ms))
        .find((part) => part.type === "timeZoneName")?.value;
      if (name && LETTER_ABBR_RX.test(name)) {
        found = name;
        break;
      }
    } catch {
      // Unknown locale or zone: try the next one.
    }
  }
  if (!found) {
    const known = KNOWN_ABBR[zone] || KNOWN_ABBR[_canon(zone)];
    if (known) found = known[dst ? 1 : 0] || known[0];
  }
  return _remember(abbrCache, key, found, 400);
};

const _longName = (zone, ms, locale) => {
  const fixed = _fixedOffset(zone);
  if (fixed !== null) return _fmtOffset(fixed);
  return _zoneName(zone, ms, locale, "long");
};

const _cityLabel = (zone) => {
  const fixed = _fixedOffset(zone);
  if (fixed !== null) return _fmtOffset(fixed);
  if (!zone) return "";
  return CITY_LABELS[zone] || zone.split("/").pop().replace(/_/g, " ");
};

const _amount = (minutes, locale) => {
  const abs = Math.abs(minutes);
  const unit = abs % 60 === 0 || abs > 60 ? "hour" : "minute";
  const value = unit === "hour" ? abs / 60 : abs;
  try {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "long",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value} ${unit === "hour" ? "h" : "min"}`;
  }
};

const _relText = (zone, base, ms, locale, baseLabel, tr) => {
  const delta = _offsetAt(zone, ms) - _offsetAt(base, ms);
  if (!delta) return tr("diff.same", { zone: baseLabel });
  return tr(delta > 0 ? "diff.ahead" : "diff.behind", { amount: _amount(delta, locale), zone: baseLabel });
};

const _headRel = (zone, base, ms, locale, label, baseLabel, tr) => {
  const delta = _offsetAt(zone, ms) - _offsetAt(base, ms);
  if (!delta) return tr("diff.headSame", { zone: label, base: baseLabel });
  return tr(delta > 0 ? "diff.headAhead" : "diff.headBehind", {
    zone: label,
    base: baseLabel,
    amount: _amount(delta, locale),
  });
};

const _dayShift = (zone, base, ms, locale) => {
  const a = _zoneParts(zone, ms);
  const b = _zoneParts(base, ms);
  const days = Math.round((_utcMs(a.y, a.m - 1, a.d) - _utcMs(b.y, b.m - 1, b.d)) / DAY_MS);
  if (!days) return "";
  let text;
  try {
    text = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "long" }).format(Math.abs(days));
  } catch {
    text = `${Math.abs(days)} d`;
  }
  return `${days > 0 ? "+" : "−"}${text}`;
};

const _scanTransitions = (zone, from, to) => {
  if (!zone || _fixedOffset(zone) !== null || _canon(zone) === "UTC") return [];
  const key = `${zone}|${from}|${to}`;
  if (transitionCache.has(key)) return transitionCache.get(key);
  const found = [];
  let t = Math.floor(from / MINUTE_MS) * MINUTE_MS;
  let previous = _offsetAt(zone, t);
  while (t < to) {
    const next = t + TRANSITION_STEP_MS;
    const offset = _offsetAt(zone, next);
    if (offset !== previous) {
      let lo = t;
      let hi = next;
      while (hi - lo > MINUTE_MS) {
        const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
        if (_offsetAt(zone, mid) === previous) lo = mid;
        else hi = mid;
      }
      found.push({ at: hi, from: previous, to: _offsetAt(zone, hi) });
      previous = offset;
    }
    t = next;
  }
  return _remember(transitionCache, key, found, 64);
};

const _windowTransitions = (zone, now) => {
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  return _scanTransitions(zone, day - 400 * DAY_MS, day + 560 * DAY_MS);
};

const _yearTransitions = (zone, year) =>
  _scanTransitions(zone, _utcMs(year, 0, 1) - 2 * DAY_MS, _utcMs(year + 1, 0, 1) + 2 * DAY_MS).filter(
    (change) => _zoneParts(zone, change.at).y === year,
  );

const _formatRelative = (ms, now, locale) => {
  let value = (ms - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, next] of RELATIVE_UNITS) {
    if (Math.abs(value) < next) return rtf.format(Math.round(value), unit);
    value /= next;
  }
  return rtf.format(Math.round(value), "year");
};

const _dstLine = (zone, ms, locale, tr) => {
  const next = _windowTransitions(zone, ms).find((change) => change.at > ms);
  if (!next) return tr("dst.notObserved");
  const date = _fmtDate(zone, next.at, locale, "medium");
  return tr(next.to < next.from ? "dst.until" : "dst.starts", { date });
};

const _changeText = (change, locale, tr) =>
  tr(change.to > change.from ? "dst.forward" : "dst.back", { amount: _amount(change.to - change.from, locale) });

const _shiftText = (change, locale, clock, tr) =>
  tr("dst.localShift", {
    from: _fmtTime("UTC", change.at + change.from * MINUTE_MS, locale, clock, false),
    to: _fmtTime("UTC", change.at + change.to * MINUTE_MS, locale, clock, false),
  });

const _zoneSummary = (zone, ms, locale) =>
  [_fmtOffset(_offsetAt(zone, ms)), _abbrFor(zone, ms, locale)].filter(Boolean).join(", ");

const _dstModel = (zone, label, now, opts, locale, clock, tr) => {
  const summary = _zoneSummary(zone, now, locale);
  const nowRow = {
    label: tr("labels.now"),
    value: `${tr(_isDst(zone, now) ? "dst.inEffect" : "dst.standard")} · ${summary}`,
  };
  const dated = (change) => `${_fmtDate(zone, change.at, locale, "medium")} · ${_changeText(change, locale, tr)}`;

  if (opts.year) {
    const year = String(opts.year);
    const changes = _yearTransitions(zone, opts.year);
    if (!changes.length) {
      return { headline: tr("dst.noneYear", { zone: label, year }), sub: tr("dst.allYear", { offset: summary }), rows: [] };
    }
    return {
      headline: tr("dst.yearTitle", { zone: label, year }),
      sub: "",
      rows: changes.map((change) => ({
        label: _fmtDate(zone, change.at, locale, "medium"),
        value: `${_changeText(change, locale, tr)} · ${_shiftText(change, locale, clock, tr)}`,
      })),
    };
  }

  const changes = _windowTransitions(zone, now);
  const future = changes.filter((change) => change.at > now);
  const past = changes.filter((change) => change.at <= now);
  if (!future.length) {
    return {
      headline: tr(opts.status ? "dst.statusNone" : "dst.none", { zone: label }),
      sub: tr("dst.allYear", { offset: summary }),
      rows: [],
    };
  }

  if (opts.status) {
    const rows = [nowRow];
    if (past.length) rows.push({ label: tr("labels.since"), value: dated(past[past.length - 1]) });
    rows.push({ label: tr("labels.next"), value: dated(future[0]) });
    return {
      headline: tr(_isDst(zone, now) ? "dst.statusYes" : "dst.statusNo", { zone: label }),
      sub: "",
      rows,
    };
  }

  const wanted =
    opts.direction === "forward"
      ? future.find((change) => change.to > change.from)
      : opts.direction === "back"
        ? future.find((change) => change.to < change.from)
        : future[0];
  const pick = wanted || future[0];
  return {
    headline: tr("dst.headline", {
      change: _changeText(pick, locale, tr),
      date: _fmtDate(zone, pick.at, locale, "full"),
    }),
    sub: `${_shiftText(pick, locale, clock, tr)} · ${_formatRelative(pick.at, now, locale)}`,
    rows: [
      ...future.slice(0, 2).map((change, index) => ({
        label: tr(index ? "labels.then" : "labels.next"),
        value: dated(change),
      })),
      nowRow,
    ],
  };
};

const _localToInstant = (zone, year, month, day, hour, minute) => {
  const wall = _utcMs(year, month - 1, day, hour, minute);
  const fixed = _fixedOffset(zone);
  if (fixed !== null) return { ms: wall - fixed * MINUTE_MS, kind: "normal" };
  const before = _offsetAt(zone, wall - DAY_MS);
  const after = _offsetAt(zone, wall + DAY_MS);
  const early = wall - before * MINUTE_MS;
  const earlyOk = _offsetAt(zone, early) === before;
  if (before === after) return { ms: early, kind: "normal" };
  const late = wall - after * MINUTE_MS;
  const lateOk = _offsetAt(zone, late) === after;
  if (earlyOk && lateOk && early !== late) {
    return { ms: Math.min(early, late), kind: "ambiguous", gap: Math.abs(before - after) };
  }
  if (earlyOk) return { ms: early, kind: "normal" };
  if (lateOk) return { ms: late, kind: "normal" };
  return { ms: early, kind: "gap", gap: Math.abs(before - after) };
};

const _resolveDate = (spec, zone, now, hour, minute) => {
  const today = _zoneParts(zone, now);
  const base = _utcMs(today.y, today.m - 1, today.d);
  const read = (ms) => {
    const date = new Date(ms);
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  };
  const [kind, a = "", b = "", c = ""] = String(spec || "rel:0").split(":");
  if (kind === "rel") return read(base + Number(a) * DAY_MS);
  if (kind === "wd") {
    let delta = (Number(a) - today.wd + 7) % 7;
    if (delta === 0 && (b === "1" || hour * 60 + minute <= today.h * 60 + today.mi)) delta = 7;
    return read(base + delta * DAY_MS);
  }
  if (kind === "abs") {
    const month = Number(b);
    const day = Number(c);
    let year = a ? Number(a) : today.y;
    if (!a && (month < today.m || (month === today.m && day < today.d))) year += 1;
    const check = read(_utcMs(year, month - 1, day));
    return check.y === year && check.m === month && check.d === day ? check : null;
  }
  return null;
};

const TRANSLATED_FORMATS = new Set(["rel", "headrel", "dst"]);

const _fmtValue = (kind, c, tr) => {
  switch (kind) {
    case "time":
      return _fmtTime(c.zone, c.at, c.locale, c.clock, c.sec);
    case "date":
      return _fmtDate(c.zone, c.at, c.locale, c.style);
    case "abbr":
      return _abbrFor(c.zone, c.at, c.locale);
    case "offset":
      return _fmtOffset(_offsetAt(c.zone, c.at));
    case "long":
      return _longName(c.zone, c.at, c.locale);
    case "label":
      return c.label || _cityLabel(c.zone);
    case "rel":
      return _relText(c.zone, c.base, c.at, c.locale, c.baseLabel || _cityLabel(c.base), tr);
    case "headrel":
      return _headRel(c.zone, c.base, c.at, c.locale, c.label || _cityLabel(c.zone), c.baseLabel || _cityLabel(c.base), tr);
    case "day":
      return _dayShift(c.zone, c.base, c.at, c.locale);
    case "dst":
      return _dstLine(c.zone, c.at, c.locale, tr);
    default:
      return null;
  }
};

const _copyValue = (time, abbr, date) => `${[time, abbr].filter(Boolean).join(" ")}${date ? `, ${date}` : ""}`;
// </shared-core>

// ---------------------------------------------------------------------------
// Lexicon: abbreviations, zone names, places and IANA cities.
// ---------------------------------------------------------------------------

const NY = "America/New_York";
const CHI = "America/Chicago";
const DEN = "America/Denver";
const LA = "America/Los_Angeles";

// [key, zone, season, alternatives]. Alternatives are only mentioned when
// their offset differs from the chosen zone at the instant being shown.
const ABBREVIATIONS = [
  ["utc", "UTC"],
  ["gmt", "UTC", null, ["Europe/London"]],
  ["zulu", "UTC"],
  ["est", NY, "std"],
  ["edt", NY, "dst"],
  ["cst", CHI, "std", ["Asia/Shanghai"]],
  ["cdt", CHI, "dst"],
  ["mst", DEN, "std", ["America/Phoenix"]],
  ["mdt", DEN, "dst"],
  ["pst", LA, "std"],
  ["pdt", LA, "dst"],
  ["akst", "America/Anchorage", "std"],
  ["akdt", "America/Anchorage", "dst"],
  ["hst", "Pacific/Honolulu"],
  ["ast", "America/Halifax", "std", ["Asia/Riyadh"]],
  ["adt", "America/Halifax", "dst"],
  ["nst", "America/St_Johns", "std"],
  ["ndt", "America/St_Johns", "dst"],
  ["bst", "Europe/London", "dst"],
  ["ist", "Asia/Kolkata", null, ["Asia/Jerusalem", "Europe/Dublin"]],
  ["cet", "Europe/Berlin", "std"],
  ["cest", "Europe/Berlin", "dst"],
  ["eet", "Europe/Athens", "std"],
  ["eest", "Europe/Athens", "dst"],
  ["msk", "Europe/Moscow"],
  ["pkt", "Asia/Karachi"],
  ["jst", "Asia/Tokyo"],
  ["kst", "Asia/Seoul"],
  ["hkt", "Asia/Hong_Kong"],
  ["pht", "Asia/Manila"],
  ["wib", "Asia/Jakarta"],
  ["wita", "Asia/Makassar"],
  ["wit", "Asia/Jayapura"],
  ["gst", "Asia/Dubai"],
  ["aest", "Australia/Sydney", "std", ["Australia/Brisbane"]],
  ["aedt", "Australia/Sydney", "dst"],
  ["aet", "Australia/Sydney"],
  ["acst", "Australia/Adelaide", "std", ["Australia/Darwin"]],
  ["acdt", "Australia/Adelaide", "dst"],
  ["awst", "Australia/Perth"],
  ["nzst", "Pacific/Auckland", "std"],
  ["nzdt", "Pacific/Auckland", "dst"],
  ["nzt", "Pacific/Auckland"],
  ["sast", "Africa/Johannesburg"],
  ["brt", "America/Sao_Paulo"],
  ["clt", "America/Santiago", "std"],
  ["clst", "America/Santiago", "dst"],
  ["myt", "Asia/Kuala_Lumpur"],
  ["npt", "Asia/Kathmandu"],
  ["trt", "Europe/Istanbul"],
  ["irst", "Asia/Tehran"],
  ["idt", "Asia/Jerusalem", "dst"],
];

// Abbreviations that are also ordinary words or initials. They only count
// next to a time, a connector or a clear "current time" question.
const PENDING_ABBREVIATIONS = [
  ["et", NY],
  ["ct", CHI],
  ["mt", DEN],
  ["pt", LA],
  ["art", "America/Argentina/Buenos_Aires"],
  ["eat", "Africa/Nairobi"],
  ["cat", "Africa/Maputo"],
  ["wat", "Africa/Lagos"],
  ["ict", "Asia/Bangkok"],
  ["sgt", "Asia/Singapore"],
  ["cot", "America/Bogota"],
  ["pet", "America/Lima"],
];
const US_PENDING = new Set(["et", "ct", "mt", "pt"]);

// Zone names. Entries marked dst also start a daylight saving question
// ("when does british summer time start").
const LONG_NAMES = [
  ["eastern time|us eastern time|eastern standard time", NY],
  ["eastern daylight time", NY, true],
  ["central time|us central time|central standard time", CHI],
  ["central daylight time", CHI, true],
  ["mountain time|mountain standard time", DEN],
  ["mountain daylight time", DEN, true],
  ["pacific time|pacific standard time", LA],
  ["pacific daylight time", LA, true],
  ["alaska standard time", "America/Anchorage"],
  ["alaska daylight time", "America/Anchorage", true],
  ["hawaii standard time|hawaii aleutian time|hawaii aleutian standard time", "Pacific/Honolulu"],
  ["atlantic time|atlantic standard time", "America/Halifax"],
  ["atlantic daylight time", "America/Halifax", true],
  ["newfoundland time|newfoundland standard time", "America/St_Johns"],
  ["coordinated universal time|universal coordinated time|universal time|zulu time|greenwich mean time", "UTC"],
  ["british summer time", "Europe/London", true],
  ["western european time", "Europe/Lisbon"],
  ["western european summer time", "Europe/Lisbon", true],
  ["central european time|central european standard time", "Europe/Berlin"],
  ["central european summer time", "Europe/Berlin", true],
  ["eastern european time", "Europe/Athens"],
  ["eastern european summer time", "Europe/Athens", true],
  ["moscow standard time", "Europe/Moscow"],
  ["india standard time|indian standard time", "Asia/Kolkata"],
  ["pakistan standard time", "Asia/Karachi"],
  ["china standard time|beijing time", "Asia/Shanghai"],
  ["japan standard time", "Asia/Tokyo"],
  ["korea standard time|korean standard time", "Asia/Seoul"],
  ["singapore standard time", "Asia/Singapore"],
  ["philippine time|philippine standard time", "Asia/Manila"],
  ["indochina time", "Asia/Bangkok"],
  ["western indonesia time", "Asia/Jakarta"],
  ["gulf standard time", "Asia/Dubai"],
  ["arabia standard time|arabian standard time", "Asia/Riyadh"],
  ["israel standard time", "Asia/Jerusalem"],
  ["israel daylight time", "Asia/Jerusalem", true],
  ["irish standard time", "Europe/Dublin", true],
  ["south africa standard time|south african standard time", "Africa/Johannesburg"],
  ["central africa time", "Africa/Maputo"],
  ["east africa time", "Africa/Nairobi"],
  ["west africa time", "Africa/Lagos"],
  ["australian eastern time|australian eastern standard time", "Australia/Sydney"],
  ["australian eastern daylight time", "Australia/Sydney", true],
  ["australian central time|australian central standard time", "Australia/Adelaide"],
  ["australian central daylight time", "Australia/Adelaide", true],
  ["australian western time|australian western standard time", "Australia/Perth"],
  ["new zealand standard time", "Pacific/Auckland"],
  ["new zealand daylight time", "Pacific/Auckland", true],
  ["brasilia time|brasilia standard time", "America/Sao_Paulo"],
  ["argentina time", "America/Argentina/Buenos_Aires"],
  ["chile standard time", "America/Santiago"],
  ["chile summer time", "America/Santiago", true],
  ["iran standard time", "Asia/Tehran"],
  ["nepal time", "Asia/Kathmandu"],
];

const PLACE_ZONES = {
  [NY]:
    "new york|nyc|new york city|ny|manhattan|brooklyn|washington dc|dc|washington|boston|philadelphia|atlanta|miami|baltimore|pittsburgh|charlotte|orlando|tampa|cleveland|columbus|raleigh|richmond|buffalo|newark|jacksonville|portland|cambridge|virginia|massachusetts|pennsylvania|ohio|michigan|north carolina|south carolina|connecticut|new jersey|maryland|maine|vermont|new hampshire|rhode island|delaware|west virginia|east coast|florida|nueva york",
  [CHI]:
    "dallas|houston|austin|san antonio|minneapolis|st louis|kansas city|new orleans|nashville|memphis|milwaukee|oklahoma city|birmingham|illinois|minnesota|missouri|iowa|wisconsin|louisiana|alabama|mississippi|arkansas|oklahoma|kansas|nebraska|texas|tennessee|midwest",
  [DEN]: "salt lake city|albuquerque|el paso|colorado|utah|new mexico|montana|wyoming|idaho",
  "America/Phoenix": "arizona|tucson|scottsdale",
  [LA]: "la|san francisco|sf|san diego|san jose|seattle|las vegas|sacramento|oakland|silicon valley|bay area|hollywood|california|oregon|washington state|nevada|west coast",
  "America/Anchorage": "alaska",
  "Pacific/Honolulu": "hawaii",
  "America/Puerto_Rico": "san juan",
  "America/Toronto": "canada|ottawa|quebec|quebec city|montreal|ontario",
  "America/Edmonton": "calgary|alberta",
  "America/Vancouver": "british columbia",
  "America/Winnipeg": "manitoba",
  "America/Regina": "saskatchewan",
  "America/Halifax": "nova scotia",
  "America/St_Johns": "newfoundland",
  "America/Mexico_City": "mexico|cdmx|guadalajara",
  "America/Sao_Paulo": "brazil|rio|rio de janeiro|brasilia",
  "America/Argentina/Buenos_Aires": "argentina",
  "America/Santiago": "chile",
  "America/Bogota": "colombia|medellin",
  "America/Lima": "peru",
  "America/Caracas": "venezuela",
  "America/Guayaquil": "ecuador|quito",
  "America/La_Paz": "bolivia",
  "America/Montevideo": "uruguay",
  "America/Asuncion": "paraguay",
  "Europe/London":
    "uk|the uk|united kingdom|england|britain|great britain|scotland|wales|northern ireland|manchester|liverpool|leeds|edinburgh|glasgow|bristol|cardiff|oxford|londres|londra",
  "Europe/Dublin": "ireland|cork|galway",
  "Europe/Berlin": "germany|munich|munchen|hamburg|frankfurt|cologne|koln|stuttgart|dusseldorf|berlino",
  "Europe/Paris": "france|lyon|marseille|toulouse|bordeaux|parigi",
  "Europe/Madrid": "spain|barcelona|valencia|seville",
  "Europe/Rome": "italy|milan|florence|venice|naples|turin|mailand",
  "Europe/Amsterdam": "netherlands|the netherlands|holland|rotterdam|the hague",
  "Europe/Brussels": "belgium|bruxelles",
  "Europe/Zurich": "switzerland|geneva|basel|genf",
  "Europe/Vienna": "austria|wien",
  "Europe/Warsaw": "poland|krakow|warschau",
  "Europe/Prague": "czech republic|czechia|prag",
  "Europe/Budapest": "hungary",
  "Europe/Stockholm": "sweden",
  "Europe/Oslo": "norway",
  "Europe/Copenhagen": "denmark|kopenhagen",
  "Europe/Helsinki": "finland",
  "Europe/Lisbon": "portugal|porto|lissabon",
  "Europe/Athens": "greece|athen",
  "Europe/Istanbul": "turkey|turkiye|ankara",
  "Europe/Moscow": "russia|st petersburg|saint petersburg|moskau|moscou|mosca",
  "Europe/Kyiv": "ukraine|kyiv|kiev",
  "Europe/Bucharest": "romania",
  "Atlantic/Reykjavik": "iceland",
  "Asia/Jerusalem": "israel|tel aviv",
  "Asia/Dubai": "uae|united arab emirates|abu dhabi",
  "Asia/Riyadh": "saudi arabia|saudi|mecca|jeddah",
  "Asia/Qatar": "qatar",
  "Africa/Cairo": "egypt",
  "Africa/Johannesburg": "south africa|cape town|pretoria|durban",
  "Africa/Lagos": "nigeria|abuja",
  "Africa/Nairobi": "kenya",
  "Africa/Casablanca": "morocco",
  "Asia/Tehran": "iran",
  "Asia/Baghdad": "iraq",
  "Asia/Beirut": "lebanon",
  "Asia/Amman": "jordan",
  "Africa/Accra": "ghana",
  "Asia/Kolkata":
    "india|mumbai|bombay|delhi|new delhi|bangalore|bengaluru|chennai|hyderabad|pune|kolkata|calcutta",
  "Asia/Karachi": "pakistan|lahore|islamabad",
  "Asia/Dhaka": "bangladesh",
  "Asia/Colombo": "sri lanka",
  "Asia/Kathmandu": "nepal|kathmandu",
  "Asia/Shanghai": "china|beijing|peking|shenzhen|guangzhou|chengdu|hangzhou",
  "Asia/Tokyo": "japan|osaka|kyoto|tokio",
  "Asia/Seoul": "south korea|korea|busan",
  "Asia/Taipei": "taiwan",
  "Asia/Manila": "philippines",
  "Asia/Ho_Chi_Minh": "vietnam|hanoi|ho chi minh city|ho chi minh|saigon",
  "Asia/Bangkok": "thailand|phuket",
  "Asia/Jakarta": "indonesia",
  "Asia/Makassar": "bali",
  "Asia/Kuala_Lumpur": "malaysia",
  "Asia/Yangon": "myanmar|yangon|rangoon",
  "Asia/Almaty": "kazakhstan",
  "Asia/Kabul": "afghanistan",
  "Australia/Sydney": "australia|canberra|nsw|new south wales",
  "Australia/Melbourne": "victoria",
  "Australia/Brisbane": "queensland|gold coast",
  "Australia/Adelaide": "south australia",
  "Australia/Perth": "western australia",
  "Australia/Hobart": "tasmania",
  "Australia/Darwin": "northern territory",
  "Pacific/Auckland": "new zealand|nz|wellington|christchurch",
  "America/Nuuk": "nuuk|greenland",
  "Indian/Christmas": "christmas island",
  "Pacific/Easter": "easter island",
  "Atlantic/Canary": "canary islands",
  "Pacific/Norfolk": "norfolk island",
  "Indian/Reunion": "reunion island",
};

// Places that span several zones. The current time lists them all; other
// answers use the first and say so.
const MULTI_ZONES = {
  usa: [NY, CHI, DEN, LA, "America/Anchorage", "Pacific/Honolulu"],
  australia: ["Australia/Sydney", "Australia/Brisbane", "Australia/Adelaide", "Australia/Darwin", "Australia/Perth"],
  canada: ["America/Toronto", "America/Halifax", "America/St_Johns", "America/Winnipeg", "America/Edmonton", "America/Vancouver"],
  russia: ["Europe/Moscow", "Asia/Yekaterinburg", "Asia/Novosibirsk", "Asia/Vladivostok"],
  brazil: ["America/Sao_Paulo", "America/Manaus"],
  mexico: ["America/Mexico_City", "America/Tijuana", "America/Cancun"],
  indonesia: ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"],
  europe: ["Europe/London", "Europe/Berlin", "Europe/Athens"],
  texas: [CHI, DEN],
  florida: [NY, CHI],
  tennessee: [CHI, NY],
  idaho: [DEN, LA],
};
const MULTI_KEYS = {
  usa: "usa|united states|the us|the usa|the states|america|united states of america",
  europe: "europe|eu",
};

const PLACE_ALTERNATIVES = {
  washington: [[LA, "Washington State"]],
  portland: [[LA, "Portland, Oregon"]],
  cambridge: [["Europe/London", "Cambridge, UK"]],
  birmingham: [["Europe/London", "Birmingham, UK"]],
  victoria: [["America/Vancouver", "Victoria, BC"]],
};

const REGION_CODES = {
  usa: "US", "united states": "US", "the us": "US", "the usa": "US", "the states": "US", america: "US",
  "united states of america": "US", uk: "GB", "the uk": "GB", "united kingdom": "GB", "great britain": "GB",
  britain: "GB", ireland: "IE", germany: "DE", france: "FR", spain: "ES", italy: "IT", netherlands: "NL",
  "the netherlands": "NL", holland: "NL", belgium: "BE", switzerland: "CH", austria: "AT", poland: "PL",
  "czech republic": "CZ", czechia: "CZ", hungary: "HU", sweden: "SE", norway: "NO", denmark: "DK",
  finland: "FI", portugal: "PT", greece: "GR", turkey: "TR", turkiye: "TR", russia: "RU", ukraine: "UA",
  romania: "RO", iceland: "IS", israel: "IL", uae: "AE", "united arab emirates": "AE", "saudi arabia": "SA",
  saudi: "SA", qatar: "QA", egypt: "EG", "south africa": "ZA", nigeria: "NG", kenya: "KE", morocco: "MA",
  iran: "IR", iraq: "IQ", lebanon: "LB", jordan: "JO", ghana: "GH", india: "IN", pakistan: "PK",
  bangladesh: "BD", "sri lanka": "LK", nepal: "NP", china: "CN", japan: "JP", "south korea": "KR",
  korea: "KR", taiwan: "TW", philippines: "PH", vietnam: "VN", thailand: "TH", indonesia: "ID",
  malaysia: "MY", myanmar: "MM", kazakhstan: "KZ", afghanistan: "AF", australia: "AU", "new zealand": "NZ",
  nz: "NZ", canada: "CA", mexico: "MX", brazil: "BR", argentina: "AR", chile: "CL", colombia: "CO",
  peru: "PE", venezuela: "VE", ecuador: "EC", bolivia: "BO", uruguay: "UY", paraguay: "PY", greenland: "GL",
};

const DISPLAY_NAMES = {
  nyc: "New York City", ny: "New York", la: "Los Angeles", sf: "San Francisco", dc: "Washington, D.C.",
  "washington dc": "Washington, D.C.", nsw: "New South Wales", cdmx: "Mexico City", eu: "Europe",
  "st louis": "St. Louis", "st petersburg": "St. Petersburg", "saint petersburg": "St. Petersburg",
  munchen: "München", koln: "Köln", "nueva york": "Nueva York", rio: "Rio de Janeiro",
};

const RENAMED_ZONES = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
};

// IANA city names that are mostly ordinary English words or ambiguous.
const EXCLUDED_CITIES = new Set(
  (
    "easter|wake|center|christmas|canary|casey|davis|palmer|knox|troll|resolute|midway|nome|oral|jersey|" +
    "norfolk|reunion|beulah|marengo|vevay|winamac|vincennes|petersburg|tell city|new salem|monticello|" +
    "creston|truk|ponape|enderbury|san juan|dawson|stanley|macquarie|mawson|vostok|syowa|rothera|thule|" +
    "johnston|chatham|cocos|mahe|eucla|regina|victoria|lower princes|guernsey|isle of man|vatican|general"
  ).split("|"),
);

// ---------------------------------------------------------------------------
// Grammar word lists.
// ---------------------------------------------------------------------------

const CONNECTORS = new Map([
  ["to", "to"],
  ["into", "to"],
  ["as", "to"],
  ["in", "in"],
  ["at", "in"],
  ["from", "from"],
  ["and", "and"],
  [",", "and"],
]);
const ANCHORS = new Set([
  "time",
  "timezone",
  "tz",
  "now",
  "current",
  "currently",
  "what",
  "whats",
  "difference",
  "diff",
  "ahead",
  "behind",
  "vs",
  "versus",
  "between",
  "convert",
  "conversion",
]);
const DIFF_ANCHORS = ["difference", "diff", "ahead", "behind", "vs", "versus", "between"];
const FILLERS = new Set([
  "is",
  "it",
  "the",
  "right",
  "please",
  "of",
  "for",
  "hours",
  "hour",
  "how",
  "many",
  "much",
  "far",
  "which",
  "does",
  "do",
  "there",
  "my",
  "me",
  "tell",
  "clock",
  "oclock",
  "than",
  "on",
  "are",
  "we",
  "am",
  "i",
  "zone",
]);
const DST_WORDS = new Map([
  ...["start", "starts", "starting", "started", "begin", "begins", "beginning", "kick", "kicks"].map((w) => [w, "forward"]),
  ...["end", "ends", "ending", "ended", "over", "finish", "finishes", "stop", "stops"].map((w) => [w, "back"]),
  ...[
    "when",
    "did",
    "will",
    "go",
    "goes",
    "effect",
    "date",
    "dates",
    "next",
    "happen",
    "happens",
    "until",
    "till",
    "observe",
    "observes",
    "observed",
    "have",
    "has",
    "use",
    "uses",
    "still",
    "this",
    "year",
    "change",
    "changes",
    "changed",
    "day",
    "last",
    "occur",
    "occurs",
    "get",
    "gets",
    "come",
    "comes",
    "take",
    "takes",
    "us",
  ].map((w) => [w, ""]),
]);

// Daylight saving phrases. weak ones need more evidence, such as a zone,
// a year or another daylight saving word.
const DST_PHRASE_LIST = [
  ["dst|daylight saving|daylight savings|daylight saving time|daylight savings time|daylight savings times", ""],
  ["clock change|clock changes|clocks change|clocks changing|clock changing|change the clocks|change the clock|change clocks", ""],
  ["time change|time changes|time changing|the clocks change", ""],
  ["clocks go back|clock go back|clocks back|clocks fall back|turn the clocks back|turn clocks back|set the clocks back|set clocks back|time go back|time goes back|fall back", "back"],
  ["clocks go forward|clock go forward|clocks go ahead|clocks forward|clocks spring forward|set the clocks forward|set clocks forward|time go forward|time goes forward|spring forward|spring ahead", "forward"],
  ["zeitumstellung|changement dheure|cambio dellora|cambio ora", ""],
  ["sommerzeit|heure dete|ora legale", "forward"],
  ["winterzeit|heure dhiver|ora solare", "back"],
];
const WEAK_DST_PHRASES = [
  ["summer time|daylight time", "forward"],
  ["winter time|standard time", "back"],
];
const DST_FILL_PHRASES = [
  ["into effect|go into effect|come into effect|take effect|takes effect", "forward"],
  ["in effect", ""],
];

const MONTHS = new Map(
  Object.entries({
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6,
    june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
  }),
);
const WEEKDAYS = new Map(
  Object.entries({
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
  }),
);
const RELATIVE_DAYS = new Map([
  ["today", 0],
  ["tonight", 0],
  ["tomorrow", 1],
  ["tmrw", 1],
  ["yesterday", -1],
]);

const APOSTROPHE_RX = /['‘’`´]/g;
const NON_ASCII_RX = /[^\x00-\x7f]/;
const COMBINING_RX = /[̀-ͯ]/g;
const TRAILING_PUNCT_RX = /[?!.,;:]+$/;
const DAY_NUMBER_RX = /^(\d{1,2})(?:st|nd|rd|th)?$/;
const YEAR_RX = /^(?:19|20)\d{2}$/;
const ISO_DATE_RX = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_TOKEN_RX = /^(?:utc|gmt)([+-])(\d{1,2})(?::?(\d{2}))?$/;
const SIGNED_OFFSET_RX = /^[+-]\d{1,2}(?::?\d{2})?$/;
const SIMPLE_NUMBER_RX = /^\d{1,2}(?:[:.]\d{2})?$/;
const TIME_12H_RX = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$/;
const TIME_24H_RX = /^(\d{1,2}):(\d{2})(z)?$/;
const TIME_FRENCH_RX = /^(\d{1,2})h(\d{2})$/;
const TIME_MILITARY_RX = /^([01]\d|2[0-3])([0-5]\d)(z)?$/;

// ---------------------------------------------------------------------------
// Index construction (once, at module load).
// ---------------------------------------------------------------------------

const _isValidTimeZone = (zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const _keyOf = (text) => {
  let key = String(text).toLowerCase().replace(APOSTROPHE_RX, "");
  if (NON_ASCII_RX.test(key)) key = key.normalize("NFD").replace(COMBINING_RX, "");
  return key.replace(/[_-]+/g, " ").replace(/\./g, "").replace(/\s+/g, " ").trim();
};

const _modernZone = (zone) => {
  const modern = RENAMED_ZONES[zone];
  return modern && _isValidTimeZone(modern) ? modern : zone;
};

const _supportedZones = () => {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
};

const ZONE_INDEX = new Map();
const ZONE_IDS = new Map();
const DST_PHRASES = new Map();

const _addZoneKey = (key, entry) => {
  const normal = _keyOf(key);
  if (normal) ZONE_INDEX.set(normal, { ...entry, key: normal });
};

const _buildIndex = () => {
  for (const id of _supportedZones()) {
    if (id.startsWith("Etc/") || id.startsWith("SystemV/") || !id.includes("/")) continue;
    const zone = _modernZone(id);
    ZONE_IDS.set(id.toLowerCase(), zone);
    ZONE_IDS.set(zone.toLowerCase(), zone);
    for (const source of new Set([id, zone])) {
      const key = _keyOf(source.split("/").pop());
      if (!EXCLUDED_CITIES.has(key) && !ZONE_INDEX.has(key)) _addZoneKey(key, { zone, kind: "city" });
    }
  }
  ZONE_IDS.set("utc", "UTC");
  ZONE_IDS.set("etc/utc", "UTC");

  for (const [zone, keys] of Object.entries(PLACE_ZONES)) {
    const id = _modernZone(zone);
    for (const key of keys.split("|")) {
      const entry = { zone: id, kind: "place" };
      if (REGION_CODES[key]) entry.region = REGION_CODES[key];
      if (DISPLAY_NAMES[key]) entry.display = DISPLAY_NAMES[key];
      if (PLACE_ALTERNATIVES[key]) entry.alts = PLACE_ALTERNATIVES[key];
      if (MULTI_ZONES[key]) entry.multi = MULTI_ZONES[key];
      _addZoneKey(key, entry);
    }
  }
  for (const [group, keys] of Object.entries(MULTI_KEYS)) {
    const zones = MULTI_ZONES[group];
    for (const key of keys.split("|")) {
      _addZoneKey(key, {
        zone: zones[0],
        kind: "place",
        multi: zones,
        region: REGION_CODES[key],
        display: DISPLAY_NAMES[key],
      });
    }
  }
  for (const [keys, zone, dstName] of LONG_NAMES) {
    for (const key of keys.split("|")) _addZoneKey(key, { zone: _modernZone(zone), kind: "name", dstName: !!dstName });
  }
  for (const [key, zone, season, alts] of ABBREVIATIONS) {
    _addZoneKey(key, {
      zone,
      kind: "abbr",
      season: season || "",
      alts: alts ? alts.map((alt) => [alt, ""]) : undefined,
    });
  }
  for (const [key, zone] of PENDING_ABBREVIATIONS) _addZoneKey(key, { zone, kind: "pending" });

  for (const key of [...ZONE_INDEX.keys()]) {
    if (key.startsWith("st ")) {
      const saint = `saint ${key.slice(3)}`;
      if (!ZONE_INDEX.has(saint)) ZONE_INDEX.set(saint, { ...ZONE_INDEX.get(key), key: saint });
    }
  }

  for (const [list, kind, weak] of [
    [DST_PHRASE_LIST, "dst", false],
    [WEAK_DST_PHRASES, "dst", true],
    [DST_FILL_PHRASES, "dstfill", false],
  ]) {
    for (const [keys, dir] of list) {
      for (const key of keys.split("|")) DST_PHRASES.set(key, { kind, dir, weak });
    }
  }
};

_buildIndex();

const US_STATES = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California", co: "Colorado",
  ct: "Connecticut", de: "Delaware", dc: "District of Columbia", fl: "Florida", ga: "Georgia", hi: "Hawaii",
  id: "Idaho", il: "Illinois", ia: "Iowa", ks: "Kansas", ky: "Kentucky", la: "Louisiana", me: "Maine",
  md: "Maryland", ma: "Massachusetts", mi: "Michigan", mn: "Minnesota", ms: "Mississippi", mo: "Missouri",
  mt: "Montana", ne: "Nebraska", nv: "Nevada", nh: "New Hampshire", nj: "New Jersey", nm: "New Mexico",
  ny: "New York", nc: "North Carolina", nd: "North Dakota", oh: "Ohio", ok: "Oklahoma", or: "Oregon",
  pa: "Pennsylvania", ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota", tn: "Tennessee",
  tx: "Texas", ut: "Utah", vt: "Vermont", va: "Virginia", wa: "Washington", wv: "West Virginia",
  wi: "Wisconsin", wy: "Wyoming", pr: "Puerto Rico",
};
const CA_PROVINCES = {
  ab: "Alberta", bc: "British Columbia", mb: "Manitoba", nb: "New Brunswick", nl: "Newfoundland and Labrador",
  ns: "Nova Scotia", nt: "Northwest Territories", nu: "Nunavut", on: "Ontario", pe: "Prince Edward Island",
  qc: "Quebec", sk: "Saskatchewan", yt: "Yukon",
};
const STATE_CODES = Object.fromEntries(
  [...Object.entries(US_STATES), ...Object.entries(CA_PROVINCES)].map(([code, name]) => [_keyOf(name), code.toUpperCase()]),
);
const COUNTRY_ALIASES = { usa: "US", "united states": "US", america: "US", uk: "GB", england: "GB", scotland: "GB", wales: "GB", uae: "AE" };

// "in" (Indiana) and "on" (Ontario) are left out: they are connectors.
const QUALIFIERS = new Map();
const _addQualifier = (key, qualifier) => {
  const normal = _keyOf(key);
  if (!normal || QUALIFIERS.has(normal)) return;
  const zoneEntry = ZONE_INDEX.get(normal);
  QUALIFIERS.set(normal, { ...qualifier, zoneEntry: zoneEntry && zoneEntry.kind !== "pending" ? zoneEntry : null });
};
const _buildQualifiers = () => {
  for (const [code, name] of Object.entries(US_STATES)) {
    if (code !== "in") _addQualifier(code, { cc: "US", admin1: name });
    _addQualifier(name, { cc: "US", admin1: name });
  }
  _addQualifier("indiana", { cc: "US", admin1: "Indiana" });
  for (const [code, name] of Object.entries(CA_PROVINCES)) {
    if (code !== "on") _addQualifier(code, { cc: "CA", admin1: name });
    _addQualifier(name, { cc: "CA", admin1: name });
  }
  for (const [key, cc] of Object.entries(COUNTRY_ALIASES)) _addQualifier(key, { cc });
  let names = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    names = null;
  }
  if (!names) return;
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const cc = String.fromCharCode(a, b);
      let name = "";
      try {
        name = names.of(cc);
      } catch {
        name = "";
      }
      if (name && name !== cc && !/unknown/i.test(name)) _addQualifier(name, { cc });
    }
  }
};
_buildQualifiers();

const _maxWords = (map) => Math.max(...[...map.keys()].map((key) => key.split(" ").length));
const MAX_ZONE_WORDS = _maxWords(ZONE_INDEX);
const MAX_PHRASE_WORDS = _maxWords(DST_PHRASES);

// ---------------------------------------------------------------------------
// Parser.
// ---------------------------------------------------------------------------

const _squash = (text) => text.replace(/\s+/g, " ").trim();

const _normalize = (query) => {
  let text = String(query ?? "").toLowerCase().replace(APOSTROPHE_RX, "");
  if (NON_ASCII_RX.test(text)) {
    text = text
      .replace(/[→⇒⟶]/g, " to ")
      .replace(/[−–]/g, "-")
      .replace(/—/g, " ")
      .normalize("NFD")
      .replace(COMBINING_RX, "");
  }
  text = text
    .replace(/["“”()¿¡]/g, " ")
    .replace(/(?:->|=>|=)/g, " to ")
    .replace(/&/g, " and ")
    .replace(/(^|[\s\d])([ap])\.m\.?(?=\s|$)/g, "$1$2m")
    .replace(/([a-z])\.(?=\s|$)/g, "$1")
    .replace(/([a-z])-(?=[a-z])/g, "$1 ");
  text = _squash(text).replace(TRAILING_PUNCT_RX, "");
  return _squash(text.replace(/,/g, " , "));
};

const _tokenize = (text) => {
  const raw = text.split(" ");
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    const next = raw[i + 1];
    if (SIMPLE_NUMBER_RX.test(token) && (next === "am" || next === "pm")) {
      out.push(token + next);
      i++;
    } else if ((token === "utc" || token === "gmt") && next && SIGNED_OFFSET_RX.test(next)) {
      out.push(token + next);
      i++;
    } else if (token === "12" && (next === "noon" || next === "midnight")) {
      out.push(next);
      i++;
    } else if (token === "time" && next === "zone") {
      out.push("timezone");
      i++;
    } else if (token) {
      out.push(token);
    }
  }
  return out;
};

const _matchLongest = (map, tokens, i, maxWords) => {
  for (let len = Math.min(maxWords, tokens.length - i); len >= 1; len--) {
    const key = len === 1 ? tokens[i] : tokens.slice(i, i + len).join(" ");
    const value = map.get(key);
    if (value) return { value, len, key };
  }
  return null;
};

const _matchOffset = (token) => {
  const match = OFFSET_TOKEN_RX.exec(token);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  if (hours > 14 || ![0, 15, 30, 45].includes(minutes) || (hours === 14 && minutes)) return null;
  if (!hours && !minutes) return { zone: "UTC", kind: "abbr", key: "utc" };
  const zone = `${match[1]}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return { zone, kind: "offset", key: token };
};

const _matchTime = (tokens, i) => {
  const token = tokens[i];
  if (token === "noon" || token === "midday") return { h: 12, mi: 0, word: true };
  if (token === "midnight") return { h: 0, mi: 0, word: true };
  let match = TIME_12H_RX.exec(token);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) return null;
    return { h: (hour % 12) + (match[3] === "pm" ? 12 : 0), mi: minute };
  }
  match = TIME_24H_RX.exec(token) || TIME_FRENCH_RX.exec(token);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return { h: hour, mi: minute, zulu: match[3] === "z" };
  }
  match = TIME_MILITARY_RX.exec(token);
  if (match && (match[3] === "z" || ["utc", "gmt", "zulu"].includes(tokens[i + 1]))) {
    return { h: Number(match[1]), mi: Number(match[2]), zulu: match[3] === "z" };
  }
  return null;
};

const _validDay = (month, day) => day >= 1 && day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

const _matchDate = (tokens, i) => {
  const token = tokens[i];
  const next = tokens[i + 1];
  if (RELATIVE_DAYS.has(token)) return { spec: `rel:${RELATIVE_DAYS.get(token)}`, len: 1 };
  if ((token === "next" || token === "this") && WEEKDAYS.has(next)) {
    return { spec: `wd:${WEEKDAYS.get(next)}:${token === "next" ? 1 : 0}`, len: 2 };
  }
  if (WEEKDAYS.has(token)) return { spec: `wd:${WEEKDAYS.get(token)}:0`, len: 1 };
  const iso = ISO_DATE_RX.exec(token);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (year < 1970 || year > 2099 || month < 1 || month > 12 || !_validDay(month, day)) return null;
    return { spec: `abs:${year}:${month}:${day}`, len: 1 };
  }
  let month;
  let day;
  let len;
  if (MONTHS.has(token) && DAY_NUMBER_RX.test(next || "")) {
    month = MONTHS.get(token);
    day = Number(DAY_NUMBER_RX.exec(next)[1]);
    len = 2;
  } else if (DAY_NUMBER_RX.test(token)) {
    const ofSkip = next === "of" ? 1 : 0;
    const monthToken = tokens[i + 1 + ofSkip];
    if (!MONTHS.has(monthToken)) return null;
    month = MONTHS.get(monthToken);
    day = Number(DAY_NUMBER_RX.exec(token)[1]);
    len = 2 + ofSkip;
  } else {
    return null;
  }
  if (!_validDay(month, day)) return null;
  const comma = tokens[i + len] === "," ? 1 : 0;
  const yearToken = tokens[i + len + comma];
  if (yearToken && /^\d{4}$/.test(yearToken)) {
    const year = Number(yearToken);
    if (year < 1970 || year > 2099) return null;
    return { spec: `abs:${year}:${month}:${day}`, len: len + comma + 1 };
  }
  return { spec: `abs::${month}:${day}`, len };
};

const PLACE_WORD_RX = /^[a-z][a-z.-]*$/;

const _classify = (tokens) => {
  const items = [];
  let i = 0;
  const push = (item, len = 1) => {
    item.from = i;
    item.to = i + len;
    items.push(item);
    i += len;
  };
  while (i < tokens.length) {
    const token = tokens[i];
    const zone = _matchLongest(ZONE_INDEX, tokens, i, MAX_ZONE_WORDS);
    const phrase = _matchLongest(DST_PHRASES, tokens, i, MAX_PHRASE_WORDS);
    if (zone && (!phrase || zone.len >= phrase.len)) {
      push({ type: zone.value.kind === "pending" ? "pending" : "zone", entry: zone.value }, zone.len);
      continue;
    }
    if (phrase) {
      push({ type: phrase.value.kind, dir: phrase.value.dir, weak: phrase.value.weak }, phrase.len);
      continue;
    }
    if (token.includes("/")) {
      const id = ZONE_IDS.get(token);
      if (!id) return null;
      push({ type: "zone", entry: { zone: id, kind: "city", key: token } });
      continue;
    }
    const offset = _matchOffset(token);
    if (offset) {
      push({ type: "zone", entry: offset });
      continue;
    }
    const time = _matchTime(tokens, i);
    if (time) {
      push({ type: "time", ...time });
      if (time.zulu) {
        items.push({ type: "zone", entry: { zone: "UTC", kind: "abbr", key: "utc" }, implicit: true, from: i, to: i });
      }
      continue;
    }
    const date = _matchDate(tokens, i);
    if (date) {
      push({ type: "date", spec: date.spec }, date.len);
      continue;
    }
    if (YEAR_RX.test(token)) push({ type: "year", year: Number(token) });
    else if (CONNECTORS.has(token)) push({ type: "conn", conn: CONNECTORS.get(token), raw: token });
    else if (token === "local") push({ type: "local" });
    else if (ANCHORS.has(token)) push({ type: "anchor", word: token });
    else if (FILLERS.has(token)) push({ type: "filler", word: token });
    else if (DST_WORDS.has(token)) push({ type: "dstword", word: token, dir: DST_WORDS.get(token) });
    else if (PLACE_WORD_RX.test(token)) push({ type: "word", word: token });
    else return null;
  }
  return items;
};

// Matches a state, province or country written after a place name
// ("springfield il", "foster city, ca", "paris texas"). Qualifiers must line up
// with whole items.
const _matchQualifier = (items, tokens, k, allowComma) => {
  let first = k;
  const comma = allowComma && items[first]?.type === "conn" && items[first].raw === ",";
  if (comma) first++;
  if (!items[first]) return null;
  for (let last = Math.min(items.length - 1, first + 2); last >= first; last--) {
    const text = tokens.slice(items[first].from, items[last].to).join(" ");
    const qualifier = QUALIFIERS.get(text);
    if (qualifier) return { qualifier, next: last + 1, comma };
  }
  return null;
};

const _groupPlaces = (items, tokens) => {
  const out = [];
  let k = 0;
  while (k < items.length) {
    const item = items[k];
    const known = item.type === "zone" && ["city", "place"].includes(item.entry.kind) && !item.entry.multi;
    if (item.type === "word" || known) {
      let next = k + 1;
      let text = known ? item.entry.key : item.word;
      if (!known) {
        while (items[next]?.type === "word") next++;
        // Leave trailing words that spell a state or country for the qualifier.
        for (let split = k + 1; split < next; split++) {
          const tail = _matchQualifier(items, tokens, split, false);
          if (tail && tail.next >= next) {
            next = split;
            break;
          }
        }
        if (next - k > MAX_LOOKUP_WORDS) return null;
        text = items
          .slice(k, next)
          .map((word) => word.word)
          .join(" ");
      }
      let qualified = _matchQualifier(items, tokens, next, true);
      // "london, new york and tokyo" is a list of places, not London in New York.
      if (known && qualified?.comma && _isConn(items[qualified.next], "and")) qualified = null;
      if (!known || qualified) {
        const qualifier = qualified?.qualifier || null;
        const fallback = known ? qualifier?.zoneEntry || null : null;
        out.push({
          type: "zone",
          from: item.from,
          to: qualified ? items[qualified.next - 1].to : items[next - 1].to,
          entry: { kind: "lookup", key: text, qualifier, fallback },
        });
        k = qualified ? qualified.next : next;
        continue;
      }
    }
    out.push(item);
    k++;
  }
  return out;
};

const _isZoneLike = (item) => item && (item.type === "zone" || item.type === "pending");
const _isAnchor = (item, ...words) => item?.type === "anchor" && words.includes(item.word);
const _isConn = (item, ...conns) => item?.type === "conn" && conns.includes(item.conn);

const _resolvePending = (items, anchors) => {
  const nowStrong =
    items.some((item) => item.type === "local") ||
    (anchors.has("time") && ["what", "whats", "current", "currently", "now"].some((word) => anchors.has(word)));
  const pending = items.filter((item) => item.type === "pending");
  if (!pending.length) return true;
  const hasTime = items.some((item) => item.type === "time");
  const allPending = !items.some((item) => item.type === "zone");
  for (const item of pending) {
    const k = items.indexOf(item);
    const prev = items[k - 1];
    const next = items[k + 1];
    const earlier = items.slice(0, Math.max(0, k - 1));
    const ok =
      prev?.type === "time" ||
      next?.type === "time" ||
      _isConn(prev, "from") ||
      (_isConn(prev, "to", "in", "and") && earlier.some((x) => _isZoneLike(x) || x.type === "time")) ||
      (_isAnchor(prev, "vs", "versus") && earlier.some(_isZoneLike)) ||
      ((_isConn(next, "to", "and") || _isAnchor(next, "vs", "versus")) && _isZoneLike(items[k + 2])) ||
      (nowStrong && (_isAnchor(prev, "time", "now") || _isConn(prev, "in")));
    if (!ok) return false;
  }
  if (allPending && !hasTime && !nowStrong) {
    const pairing =
      items.some((item) => _isConn(item, "to")) || ["vs", "versus", "between", "difference", "diff"].some((w) => anchors.has(w));
    if (!pairing || !pending.every((item) => US_PENDING.has(item.entry.key))) return false;
  }
  for (const item of pending) item.type = "zone";
  return true;
};

const _nowStrong = (items, anchors) =>
  items.some((item) => item.type === "local") ||
  (anchors.has("time") && ["what", "whats", "current", "currently", "now"].some((word) => anchors.has(word)));

// Place names that are not in the built-in tables need an online lookup, so
// they are only accepted where the rest of the query clearly asks about time.
const _gateLookups = (items, anchors) => {
  const network = items.filter((item) => item.type === "zone" && item.entry.kind === "lookup" && !item.entry.fallback);
  if (!network.length) return true;
  if (!settings.onlineLookup || network.length > 2) return false;
  const timeAfter = (item) => _isAnchor(items[items.indexOf(item) + 1], "time", "timezone");
  // Two lookups only when each place is spelled out with a state or country,
  // or followed by "time" ("springfield il time to foster city ca time").
  if (network.length === 2 && !network.every((item) => item.entry.qualifier || timeAfter(item))) return false;
  const hasTime = items.some((item) => item.type === "time");
  const hasDst = items.some((item) => item.type === "dst");
  const explicitDiff = ["difference", "diff", "ahead", "behind", "between"].some((word) => anchors.has(word));
  const nowStrong = _nowStrong(items, anchors);
  const tzQuestion = anchors.has("timezone") && (anchors.has("what") || anchors.has("whats"));
  const pairing =
    items.filter((item) => item.type === "zone").length >= 2 &&
    items.some((item) => _isConn(item, "to") || _isAnchor(item, "vs", "versus"));
  const symmetric = items.filter((item) => item.type === "zone").every(timeAfter);
  const filler = (item, ...words) => item?.type === "filler" && words.includes(item.word);
  return network.every((item) => {
    const k = items.indexOf(item);
    const prev = items[k - 1];
    const next = items[k + 1];
    // "flight time to melbourne" must stay a normal search, so every place needs
    // its own "time", or this one needs a state or country.
    if (!hasTime && !hasDst && pairing && timeAfter(item) && (symmetric || item.entry.qualifier)) return true;
    if (hasTime) {
      const adjacent = prev?.type === "time" || next?.type === "time";
      return (adjacent && items.some((x) => _isConn(x, "to", "in"))) || _isConn(prev, "to", "in", "from", "and");
    }
    if (hasDst) return _isConn(prev, "in") || filler(prev, "for");
    if (explicitDiff) {
      return (
        _isConn(prev, "and", "to", "from") ||
        _isAnchor(prev, "between", "vs", "versus", "ahead", "behind") ||
        filler(prev, "of", "than", "is") ||
        _isConn(next, "and", "to")
      );
    }
    if (tzQuestion) return filler(prev, "is") || _isConn(prev, "in") || _isAnchor(prev, "timezone");
    return nowStrong && (_isAnchor(prev, "time", "now") || _isConn(prev, "in"));
  });
};

const _nextSignificant = (items, k) => {
  for (let j = k + 1; j < items.length; j++) if (items[j].type !== "filler") return items[j];
  return null;
};

const _prevSignificant = (items, k) => {
  for (let j = k - 1; j >= 0; j--) if (items[j].type !== "filler") return items[j];
  return null;
};

const _decideDst = (items, anchors, zones, dates, years) => {
  if (items.some((item) => item.type === "time" || _isConn(item, "to", "from"))) return null;
  if (["convert", "conversion", ...DIFF_ANCHORS].some((word) => anchors.has(word))) return null;
  if (zones.length > 1 || years.length > 1) return null;
  if (dates.some((date) => date.spec !== "rel:0")) return null;
  const words = items.filter((item) => item.type === "dstword");
  const phrases = items.filter((item) => item.type === "dst" || item.type === "dstfill");
  const strong = items.some((item) => item.type === "dst" && !item.weak);
  if (!strong && !zones.length && !years.length && !words.length) {
    const statusOnly = items[0]?.type === "filler" && ["is", "are", "am"].includes(items[0].word);
    if (!statusOnly) return null;
  }
  const dirs = new Set(
    [...words, ...phrases.filter((item) => item.type !== "dst" || !item.weak)].map((item) => item.dir).filter(Boolean),
  );
  const direction = dirs.size === 1 ? [...dirs][0] : "any";
  const first = items[0];
  const status =
    (first?.type === "filler" && ["is", "are", "am", "do", "does"].includes(first.word) && !years.length && !words.some((w) => w.word === "when")) ||
    anchors.has("now") ||
    anchors.has("currently") ||
    dates.length > 0 ||
    words.some((word) => word.word === "still");
  return {
    intent: "dst",
    zone: zones[0]?.entry || null,
    year: years[0]?.year || 0,
    direction,
    status: status && !years.length,
  };
};

const _decideConvert = (items, anchors, time, dates) => {
  if (["now", "current", "currently", ...DIFF_ANCHORS].some((word) => anchors.has(word))) return null;
  if (dates.length > 1) return null;
  const segments = [{ conn: null, zones: [] }];
  for (const item of items) {
    if (item.type === "conn") segments.push({ conn: item.conn, zones: [] });
    else if (item.type === "zone") segments[segments.length - 1].zones.push(item.entry);
    else if (item.type === "local") segments[segments.length - 1].zones.push(null);
    else if (item.type === "year") return null;
  }
  if (segments.some((segment) => segment.zones.length > 1)) return null;
  if (!segments.some((segment) => segment.zones.length)) return null;

  let source;
  let hasSource = false;
  const targets = [];
  let role = null;
  for (const segment of segments) {
    let segmentRole;
    if (segment.conn === null) segmentRole = segment.zones.length ? "source" : null;
    else if (segment.conn === "from") segmentRole = "source";
    else if (segment.conn === "to") segmentRole = "target";
    else if (segment.conn === "in") segmentRole = hasSource ? "target" : "source";
    else segmentRole = role;
    if (segment.zones.length) {
      if (segmentRole === "source") {
        if (hasSource) return null;
        source = segment.zones[0];
        hasSource = true;
      } else if (segmentRole === "target") {
        targets.push(segment.zones[0]);
      } else {
        return null;
      }
    }
    role = segmentRole;
  }
  if (time.word) {
    const sourceKind = hasSource && source ? source.kind : "";
    const hasTo = items.some((item) => _isConn(item, "to"));
    if (!hasTo && !["abbr", "pending", "offset"].includes(sourceKind)) return null;
  }
  return {
    intent: "convert",
    h: time.h,
    mi: time.mi,
    date: dates[0]?.spec || "",
    source: hasSource ? source : null,
    targets,
  };
};

const _decideDiff = (items, anchors, zones) => {
  const diffAnchor = DIFF_ANCHORS.some((word) => anchors.has(word));
  const hasTo = items.some((item) => _isConn(item, "to"));
  if (zones.length === 1) {
    if (!["ahead", "behind", "difference", "diff"].some((word) => anchors.has(word))) return null;
    return { intent: "diff", base: null, targets: [zones[0].entry] };
  }
  const explicitDiff = ["difference", "diff", "ahead", "behind", "between"].some((word) => anchors.has(word));
  if (!explicitDiff) {
    const versus = anchors.has("vs") || anchors.has("versus");
    if (!hasTo && !versus) return null;
    const typed = zones.some((item) => ["abbr", "pending", "name", "offset"].includes(item.entry.kind));
    if (!typed && !anchors.has("time")) return null;
  }
  for (let j = 1; j < zones.length; j++) {
    const between = items.slice(items.indexOf(zones[j - 1]) + 1, items.indexOf(zones[j]));
    const joined = between.some((item) => item.type === "conn" || _isAnchor(item, "vs", "versus"));
    if (!joined && !diffAnchor) return null;
    if (between.some((item) => _isConn(item, "in"))) return null;
  }
  let baseIndex = 0;
  if (anchors.has("ahead") || anchors.has("behind")) {
    const last = zones[zones.length - 1];
    const before = _prevSignificant(items, items.indexOf(last)) || items[items.indexOf(last) - 1];
    const marker = items[items.indexOf(last) - 1];
    if (
      (marker?.type === "filler" && (marker.word === "of" || marker.word === "than")) ||
      _isConn(before, "from")
    ) {
      baseIndex = zones.length - 1;
    }
  }
  const base = zones[baseIndex].entry;
  return { intent: "diff", base, targets: zones.filter((_, j) => j !== baseIndex).map((item) => item.entry) };
};

const _decideNow = (items, anchors, zones, dates, settingsBare) => {
  if (items.some((item) => _isConn(item, "to", "from"))) return null;
  if (["convert", "conversion", ...DIFF_ANCHORS].some((word) => anchors.has(word))) return null;
  if (dates.some((date) => date.spec !== "rel:0")) return null;
  const local = items.some((item) => item.type === "local");
  const time = anchors.has("time");
  const tz = anchors.has("timezone") || anchors.has("tz");
  const question = anchors.has("what") || anchors.has("whats");
  const is = items.some((item) => item.type === "filler" && item.word === "is");
  const nowWord = anchors.has("now") || anchors.has("current") || anchors.has("currently");

  for (let j = 1; j < zones.length; j++) {
    const between = items.slice(items.indexOf(zones[j - 1]) + 1, items.indexOf(zones[j]));
    if (!between.some((item) => _isConn(item, "and"))) return null;
  }

  if (!zones.length) {
    const my = items.some((item) => item.type === "filler" && (item.word === "my" || item.word === "i"));
    if (tz && (my || question)) return { intent: "now", zones: [], tzQuestion: true };
    if (time && ((question && is) || anchors.has("whats") || nowWord || local)) {
      return { intent: "now", zones: [], tzQuestion: false };
    }
    return null;
  }

  const entries = zones.map((item) => item.entry);
  const significant = items.filter((item) => item.type !== "filler");
  const inBeforeZone = items.some(
    (item, k) => _isConn(item, "in") && _nextSignificant(items, k)?.type === "zone",
  );
  const kinds = entries.map((entry) => entry.kind);
  const strong =
    (time && (question || nowWord || local)) ||
    (time && inBeforeZone) ||
    (tz && significant.length > 2) ||
    (local && significant.length >= 2) ||
    kinds.includes("name") ||
    (kinds.includes("abbr") && nowWord) ||
    (significant.length === 1 && ["utc", "gmt"].includes(entries[0].key)) ||
    (question && is && entries.length === 1 && ["abbr", "name", "offset"].includes(kinds[0]) && !time && !tz);
  const bare =
    settingsBare &&
    significant.length === 2 &&
    (time || tz) &&
    ["city", "place", "abbr", "offset"].includes(kinds[0]);
  if (!strong && !bare) return null;
  return { intent: "now", zones: entries, tzQuestion: tz && !time };
};

const _decide = (items) => {
  const anchors = new Set(items.filter((item) => item.type === "anchor").map((item) => item.word));
  if (!_resolvePending(items, anchors)) return null;
  if (!_gateLookups(items, anchors)) return null;
  const zones = items.filter((item) => item.type === "zone");
  const times = items.filter((item) => item.type === "time");
  const dates = items.filter((item) => item.type === "date");
  const years = items.filter((item) => item.type === "year");
  const hasDstWords = items.some((item) => item.type === "dstword" || item.type === "dstfill");
  const hasDst =
    items.some((item) => item.type === "dst") ||
    (hasDstWords && zones.some((item) => item.entry.dstName) && !times.length);

  if (hasDst) return _decideDst(items, anchors, zones, dates, years);
  if (hasDstWords || years.length || times.length > 1) return null;
  if (times.length) {
    return zones.length || items.some((item) => item.type === "local")
      ? _decideConvert(items, anchors, times[0], dates)
      : null;
  }
  if (DIFF_ANCHORS.some((word) => anchors.has(word)) || (zones.length >= 2 && items.some((item) => _isConn(item, "to")))) {
    return zones.length ? _decideDiff(items, anchors, zones) : null;
  }
  if (dates.length > 1) return null;
  return _decideNow(items, anchors, zones, dates, settings.bareTriggers);
};

let lastQuery = null;
let lastParse = null;

const _parseQuery = (query) => {
  const raw = String(query ?? "");
  if (raw === lastQuery) return lastParse;
  let result = null;
  const text = _normalize(raw);
  if (text && text.length <= MAX_QUERY_LEN) {
    const tokens = _tokenize(text);
    if (tokens.length && tokens.length <= MAX_TOKENS) {
      const classified = _classify(tokens);
      const items = classified && _groupPlaces(classified, tokens);
      result = items ? _decide(items) : null;
    }
  }
  lastQuery = raw;
  lastParse = result;
  return result;
};

// ---------------------------------------------------------------------------
// Settings.
// ---------------------------------------------------------------------------

const _serverZone = () => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && _isValidTimeZone(zone) ? _canon(zone) : "UTC";
  } catch {
    return "UTC";
  }
};

const settings = {
  homeZone: _serverZone(),
  timeFormat: "auto",
  showSeconds: true,
  bareTriggers: true,
  browserZone: true,
  onlineLookup: true,
};

const _resolveHomeZone = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return _serverZone();
  if (raw.includes("/")) {
    const id = ZONE_IDS.get(raw.toLowerCase()) || (_isValidTimeZone(raw) ? raw : null);
    return id || _serverZone();
  }
  const key = _keyOf(raw);
  const offset = _matchOffset(key.replace(/\s+/g, ""));
  if (offset) return offset.zone;
  const entry = ZONE_INDEX.get(key);
  return entry ? entry.zone : _serverZone();
};

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

let template = "";

const _esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\{\{/g, "&#123;&#123;");

const _t = (key, vars, locale) => {
  const translate = slot.t;
  if (typeof translate !== "function") return `${NS}.${key}`;
  return String(translate(`${NS}.${key}`, vars, locale));
};

const _render = (data) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");

const _safeLocale = (locale) => {
  const candidate = String(locale || "").trim();
  if (!candidate) return "en";
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([candidate]).length ? candidate : "en";
  } catch {
    return "en";
  }
};

const _attrs = (attrs) =>
  Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => (value === true ? ` data-tz-${name}` : ` data-tz-${name}="${_esc(value)}"`))
    .join("");

const _titleCase = (text) => text.replace(/(^|\s)([a-z])/g, (_, space, letter) => space + letter.toUpperCase());

const regionNames = new Map();
const _regionName = (code, locale) => {
  try {
    let names = regionNames.get(locale);
    if (!names) names = _remember(regionNames, locale, new Intl.DisplayNames([locale], { type: "region" }), 20);
    return names.of(code) || "";
  } catch {
    return "";
  }
};

const _entryLabel = (entry, locale, ms) => {
  if (!entry) return "";
  if (entry.kind === "offset") return _cityLabel(entry.zone);
  if (entry.kind === "abbr" || entry.kind === "pending" || entry.kind === "name") {
    if (_canon(entry.zone) === "UTC") return "UTC";
    return _zoneName(entry.zone, ms, locale, "longGeneric") || _cityLabel(entry.zone);
  }
  if (entry.region) return _regionName(entry.region, locale) || _titleCase(entry.key);
  if (entry.display) return entry.display;
  if (entry.kind === "city") return _cityLabel(entry.zone);
  return _titleCase(entry.key);
};

const _term = (entry) => {
  if (!entry) return "";
  if (entry.kind === "lookup") return _titleCase(entry.key);
  if (["abbr", "pending"].includes(entry.kind)) return entry.key.toUpperCase();
  if (entry.region || entry.display) return entry.display || _titleCase(entry.key);
  return _titleCase(entry.key);
};

const _list = (items, locale) => {
  try {
    return new Intl.ListFormat(locale, { type: "disjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
};

const _entryNotes = (entry, ctx, ms, { usedSingly = true } = {}) => {
  if (!entry) return [];
  const notes = [];
  const label = _entryLabel(entry, ctx.locale, ms);
  const offset = _offsetAt(entry.zone, ms);
  if (entry.alts) {
    const differing = entry.alts.filter(([zone]) => _offsetAt(zone, ms) !== offset);
    if (differing.length) {
      notes.push(
        ctx.tr("note.ambiguous", {
          term: _term(entry),
          zone: label,
          alternatives: _list(
            differing.map(([zone, name]) => name || _zoneName(zone, ms, ctx.locale, "longGeneric") || _cityLabel(zone)),
            ctx.locale,
          ),
        }),
      );
    }
  }
  if (entry.multi && usedSingly) {
    notes.push(
      ctx.tr("note.multiZone", {
        place: label,
        zone: _cityLabel(entry.zone),
        alternatives: _list(entry.multi.slice(1).map(_cityLabel), ctx.locale),
      }),
    );
  }
  const year = new Date(ms).getUTCFullYear();
  const seasonal = _offsetAt(entry.zone, _utcMs(year, 0, 1)) !== _offsetAt(entry.zone, _utcMs(year, 6, 1));
  if (entry.season && seasonal && (entry.season === "dst") !== _isDst(entry.zone, ms)) {
    const actual = _abbrFor(entry.zone, ms, ctx.locale);
    const offsetText = _fmtOffset(offset);
    notes.push(
      ctx.tr("note.abbrSeason", {
        abbr: entry.key.toUpperCase(),
        zone: label,
        actual: actual ? `${actual} (${offsetText})` : offsetText,
      }),
    );
  }
  return notes;
};

const _homeRef = (ctx) => ({ zone: ctx.home, label: _cityLabel(ctx.home), home: true });

const _refFor = (entry, ctx, ms) =>
  entry ? { zone: entry.zone, label: _entryLabel(entry, ctx.locale, ms), home: false, entry } : _homeRef(ctx);

const _sameZone = (a, b) => _canon(a) === _canon(b);

const _fmt = (kind, c, ctx) => _fmtValue(kind, { locale: ctx.locale, clock: ctx.clock, ...c }, ctx.tr) ?? "";

const _span = (kind, c, ctx, { cls = "", attrs = {} } = {}) =>
  `<span${cls ? ` class="${cls}"` : ""} data-tz-fmt="${kind}"${_attrs(attrs)}>${_esc(_fmt(kind, attrs.sec === "1" ? { ...c, sec: true } : c, ctx))}</span>`;

const _zoneAttrs = (ref) => ({ zone: ref.zone, label: ref.label, home: ref.home ? "1" : undefined });

const _baseAttrs = (base) =>
  base ? { base: base.zone, "base-label": base.label, "base-home": base.home ? "1" : undefined } : {};

const _copyButton = (value, ctx) => {
  if (ctx.nojs) return "";
  const label = _esc(ctx.tr("copy"));
  return (
    `<button type="button" class="tz-copy degoog-icon-btn" data-tz-copy="${_esc(value)}" aria-label="${label}" title="${label}">` +
    `<i class="fa-regular fa-copy" aria-hidden="true"></i></button>`
  );
};

const _tag = (ref, ctx) => {
  if (ctx.nojs && !ref.home) return "";
  const text = ref.home ? ctx.tr("labels.home") : "";
  return `<span class="tz-tag" data-tz-tag${ref.home ? "" : " hidden"}>${_esc(text)}</span>`;
};

const _zoneRow = (ref, ctx, { at, role, base = null, hidden = false, sec = false }) => {
  const c = { zone: ref.zone, label: ref.label, at, sec };
  const time = _fmt("time", c, ctx);
  const abbr = _fmt("abbr", c, ctx);
  const date = _fmt("date", { ...c, style: "short" }, ctx);
  const baseC = base ? { ...c, base: base.zone, baseLabel: base.label } : null;
  const showRel = base && !_sameZone(base.zone, ref.zone);
  return (
    `<div class="tz-row" data-tz-row="${role === "local" ? "local" : "zone"}" data-tz-role="${role}"` +
    `${_attrs(_zoneAttrs(ref))}${hidden ? " hidden" : ""}>` +
    `<dt class="tz-label"><span class="tz-place" data-tz-fmt="label">${_esc(ref.label)}</span>${_tag(ref, ctx)}</dt>` +
    `<dd class="tz-value" data-tz-copy-scope>` +
    `<span class="tz-time" data-tz-fmt="time"${sec ? ' data-tz-sec="1"' : ""}>${_esc(time)}</span>` +
    `<span class="tz-abbr" data-tz-fmt="abbr">${_esc(abbr)}</span>` +
    `<span class="tz-meta"><span data-tz-fmt="date" data-tz-style="short">${_esc(date)}</span>` +
    (base
      ? _span("day", baseC, ctx, { attrs: _baseAttrs(base) }) +
        (showRel || role === "local" ? _span("rel", baseC, ctx, { attrs: _baseAttrs(base) }) : "")
      : "") +
    `</span>${_copyButton(_copyValue(time, abbr, date), ctx)}</dd></div>`
  );
};

const _localRow = (ctx, at, base) => {
  if (!ctx.browser) return "";
  const empty = { zone: "", label: "", home: false };
  const baseAttrs = _baseAttrs(base);
  return (
    `<div class="tz-row tz-row--pending" data-tz-row="local" data-tz-role="local" data-tz-zone="" data-tz-label="" hidden>` +
    `<dt class="tz-label"><span class="tz-place" data-tz-fmt="label"></span>${_tag(empty, ctx)}</dt>` +
    `<dd class="tz-value" data-tz-copy-scope>` +
    `<span class="tz-time" data-tz-fmt="time"></span><span class="tz-abbr" data-tz-fmt="abbr"></span>` +
    `<span class="tz-meta"><span data-tz-fmt="date" data-tz-style="short"></span>` +
    (base ? `<span data-tz-fmt="day"${_attrs(baseAttrs)}></span><span data-tz-fmt="rel"${_attrs(baseAttrs)}></span>` : "") +
    `</span>${_copyButton("", ctx)}</dd></div>`
  );
};

const _infoRow = (labelKey, body, ctx, { row = "info", hidden = false, attrs = {} } = {}) =>
  `<div class="tz-row" data-tz-row="${row}"${_attrs(attrs)}${hidden ? " hidden" : ""}>` +
  `<dt class="tz-label">${_esc(ctx.tr(labelKey))}</dt><dd class="tz-value">${body}</dd></div>`;

const _notes = (notes, { homeNote = false } = {}) =>
  [...new Set(notes.filter(Boolean))]
    .map((note) => `<p class="tz-note"${homeNote ? " data-tz-home-note" : ""}>${_esc(note)}</p>`)
    .join("");

const _card = (ctx, data) =>
  _render({
    mode: data.mode,
    at: data.at,
    locale: _esc(ctx.locale),
    clock: ctx.clock,
    seconds: ctx.seconds ? "1" : "0",
    browser: ctx.browser ? "1" : "0",
    rootAttrs: _attrs(data.rootAttrs || {}),
    kicker: _esc(ctx.tr(`kicker.${data.kicker || data.mode}`)),
    badge: data.badge || "",
    headline: data.headline || "",
    sub: data.sub || "",
    rows: (data.rows || []).join(""),
    notes: data.notes || "",
  });

const _badge = (kind, c, ctx) => _span(kind, c, ctx, { cls: "tz-badge degoog-badge" });

const _renderNow = (parsed, ctx) => {
  const at = ctx.now;
  const home = _homeRef(ctx);
  const refs = [];
  for (const entry of parsed.zones) {
    if (entry.multi) {
      for (const zone of entry.multi) refs.push({ zone, label: _cityLabel(zone), home: false });
    } else {
      refs.push(_refFor(entry, ctx, at));
    }
  }
  const primary = refs[0] || home;
  const c = { zone: primary.zone, label: primary.label, at };
  const live = !ctx.nojs;
  const atAttr = live ? "now" : String(at);
  const notes = parsed.zones.flatMap((entry) => _entryNotes(entry, ctx, at, { usedSingly: false }));
  const rows = [];

  let headline;
  let sub;
  if (parsed.tzQuestion) {
    headline = _span("long", c, ctx) || "";
    sub =
      _span("offset", c, ctx) +
      `<span class="tz-sep"> · </span>` +
      _span("time", c, ctx, { attrs: { sec: ctx.seconds && live ? "1" : undefined } });
  } else {
    headline = _span("time", c, ctx, { cls: "tz-clock", attrs: { sec: ctx.seconds && live ? "1" : undefined } });
    sub =
      _span("date", { ...c, style: "full" }, ctx, { attrs: { style: "full" } }) +
      `<span class="tz-sep"> · </span>` +
      _span("label", c, ctx, { cls: "tz-place" });
  }

  if (refs.length > 1) {
    for (const ref of refs.slice(1)) rows.push(_zoneRow(ref, ctx, { at, role: "other", base: home }));
  } else {
    if (!parsed.tzQuestion) rows.push(_infoRow("labels.zone", _span("long", c, ctx), ctx));
    rows.push(_infoRow("labels.offset", _span("offset", c, ctx), ctx));
    rows.push(_infoRow("labels.dst", _span("dst", c, ctx), ctx));
    if (refs.length === 1) {
      const sameAsHome = _sameZone(primary.zone, home.zone);
      rows.push(
        _infoRow("labels.difference", _span("rel", { ...c, base: home.zone, baseLabel: home.label }, ctx, { attrs: _baseAttrs(home) }), ctx, {
          row: "diff",
          hidden: sameAsHome,
          attrs: { base: home.zone, "base-home": "1" },
        }),
      );
    }
  }
  if (refs.length) {
    const shown = refs.some((ref) => _sameZone(ref.zone, home.zone));
    rows.push(_zoneRow(home, ctx, { at, role: "home", hidden: shown }));
  }
  rows.push(_localRow(ctx, at, refs.length ? home : null));

  return {
    title: ctx.tr(parsed.tzQuestion ? "title.zone" : "title.now"),
    html: _card(ctx, {
      mode: "now",
      kicker: parsed.tzQuestion ? "zone" : "now",
      at: atAttr,
      rootAttrs: { ..._zoneAttrs(primary), live: live ? "1" : undefined },
      badge: _badge("abbr", c, ctx),
      headline,
      sub,
      rows,
      notes: _notes(notes),
    }),
  };
};

const _renderConvert = (parsed, ctx) => {
  const sourceRef = _refFor(parsed.source, ctx, ctx.now);
  const date = _resolveDate(parsed.date, sourceRef.zone, ctx.now, parsed.h, parsed.mi);
  if (!date) return null;
  const instant = _localToInstant(sourceRef.zone, date.y, date.m, date.d, parsed.h, parsed.mi);
  const at = instant.ms;
  const source = { ..._refFor(parsed.source, ctx, at) };
  const targets = [];
  const notes = [..._entryNotes(parsed.source, ctx, at)];
  const seen = new Set();
  for (const entry of parsed.targets.length ? parsed.targets : [null]) {
    const zones = entry?.multi ? entry.multi.map((zone) => ({ zone, label: _cityLabel(zone), home: false })) : [_refFor(entry, ctx, at)];
    if (entry) notes.push(..._entryNotes(entry, ctx, at, { usedSingly: false }));
    for (const ref of zones) {
      const key = `${_canon(ref.zone)}|${ref.home}`;
      if (seen.has(key) || targets.length >= MAX_TARGETS) continue;
      seen.add(key);
      targets.push(ref);
    }
  }
  if (instant.kind !== "normal") {
    const wall = _utcMs(date.y, date.m - 1, date.d, parsed.h, parsed.mi);
    const vars = {
      time: _fmtTime("UTC", wall, ctx.locale, ctx.clock, false),
      zone: source.label,
      date: _fmtDate("UTC", wall, ctx.locale, "medium"),
      amount: _amount(instant.gap, ctx.locale),
      shown: _copyValue(_fmtTime(source.zone, at, ctx.locale, ctx.clock, false), _abbrFor(source.zone, at, ctx.locale), ""),
    };
    notes.push(ctx.tr(instant.kind === "gap" ? "note.gapTime" : "note.ambiguousTime", vars));
  }
  const first = targets[0];
  const fc = { zone: first.zone, label: first.label, at };
  const wrap = (inner) => `<span class="tz-bind"${_attrs(_zoneAttrs(first))}>${inner}</span>`;
  const headline = wrap(
    _span("time", fc, ctx, { cls: "tz-clock" }) + _span("abbr", fc, ctx, { cls: "tz-head-abbr" }),
  );
  const sub = wrap(
    _span("date", { ...fc, style: "full" }, ctx, { attrs: { style: "full" } }) +
      `<span class="tz-sep"> · </span>` +
      _span("label", fc, ctx, { cls: "tz-place" }),
  );
  const rows = [
    _zoneRow(source, ctx, { at, role: "source" }),
    ...targets.map((ref) => _zoneRow(ref, ctx, { at, role: "target", base: source })),
    _localRow(ctx, at, source),
  ];
  return {
    title: ctx.tr("title.convert"),
    html: _card(ctx, {
      mode: "convert",
      at: String(at),
      rootAttrs: {
        ..._zoneAttrs(source),
        wall: `${String(parsed.h).padStart(2, "0")}:${String(parsed.mi).padStart(2, "0")}`,
        date: parsed.date || "rel:0",
      },
      badge: "",
      headline,
      sub,
      rows,
      notes: _notes(notes),
    }),
  };
};

const _renderDiff = (parsed, ctx) => {
  const at = ctx.now;
  const base = _refFor(parsed.base, ctx, at);
  const targets = [];
  for (const entry of parsed.targets) {
    if (entry.multi) {
      for (const zone of entry.multi) targets.push({ zone, label: _cityLabel(zone), home: false });
    } else {
      targets.push(_refFor(entry, ctx, at));
    }
  }
  const limited = targets.slice(0, MAX_TARGETS);
  const first = limited[0];
  const notes = [..._entryNotes(parsed.base, ctx, at), ...parsed.targets.flatMap((entry) => _entryNotes(entry, ctx, at, { usedSingly: false }))];
  const live = !ctx.nojs;

  const upcoming = [base.zone, first.zone]
    .flatMap((zone) => _windowTransitions(zone, at).filter((change) => change.at > at))
    .sort((a, b) => a.at - b.at);
  const changeNotes = [];
  const gap = (ms) => _offsetAt(first.zone, ms) - _offsetAt(base.zone, ms);
  const before = gap(at);
  // Zones that change on the same day (New York and Los Angeles, hours apart)
  // keep their difference, so judge each change a day after it settles.
  const change = upcoming.find((candidate) => gap(candidate.at + DAY_MS) !== before);
  if (change) {
    const when = change.at;
    const after = gap(when + DAY_MS);
    const key = after > 0 ? "diff.changesAhead" : after < 0 ? "diff.changesBehind" : "diff.changesSame";
    changeNotes.push(
      ctx.tr(key, {
        date: _fmtDate(first.zone, when, ctx.locale, "medium"),
        zone: first.label,
        base: base.label,
        amount: _amount(after, ctx.locale),
      }),
    );
  }
  const fc = { zone: first.zone, label: first.label, at, base: base.zone, baseLabel: base.label };
  const headline = `<span class="tz-bind"${_attrs(_zoneAttrs(first))}>${_span("headrel", fc, ctx, { attrs: _baseAttrs(base) })}</span>`;
  const rows = [
    _zoneRow(base, ctx, { at, role: "base" }),
    ...limited.map((ref) => _zoneRow(ref, ctx, { at, role: "target", base })),
    _localRow(ctx, at, base),
  ];
  return {
    title: ctx.tr("title.diff"),
    html: _card(ctx, {
      mode: "diff",
      at: live ? "now" : String(at),
      rootAttrs: { ..._zoneAttrs(base), live: live ? "1" : undefined },
      badge: "",
      headline,
      sub: "",
      rows,
      notes: _notes(notes) + _notes(changeNotes, { homeNote: base.home }),
    }),
  };
};

const _dstRows = (model) =>
  model.rows
    .map(
      (row) =>
        `<div class="tz-row" data-tz-row="dst"><dt class="tz-label">${_esc(row.label)}</dt>` +
        `<dd class="tz-value"><span class="tz-text">${_esc(row.value)}</span></dd></div>`,
    )
    .join("");

const _renderDst = (parsed, ctx) => {
  const at = ctx.now;
  const ref = _refFor(parsed.zone, ctx, at);
  const opts = { year: parsed.year, direction: parsed.direction, status: parsed.status };
  const model = _dstModel(ref.zone, ref.label, at, opts, ctx.locale, ctx.clock, ctx.tr);
  const notes = _entryNotes(parsed.zone, ctx, at);
  return {
    title: ctx.tr("title.dst"),
    html: _card(ctx, {
      mode: "dst",
      kicker: "dst",
      at: String(at),
      rootAttrs: {
        ..._zoneAttrs(ref),
        dir: opts.direction,
        year: opts.year ? String(opts.year) : undefined,
        status: opts.status ? "1" : undefined,
      },
      badge: _badge("label", { zone: ref.zone, label: ref.label, at }, ctx),
      headline: `<span data-tz-dst-headline>${_esc(model.headline)}</span>`,
      sub: `<span data-tz-dst-sub>${_esc(model.sub)}</span>`,
      rows: [_dstRows(model)],
      notes: _notes(notes),
    }),
  };
};

let pluginFetch = null;
const lookupCache = new Map();

const _placeLabel = (result, locale) => {
  const code = result.country_code === "US" || result.country_code === "CA" ? STATE_CODES[_keyOf(result.admin1 || "")] : "";
  const where = code || _regionName(result.country_code, locale) || result.country || "";
  return where ? `${result.name}, ${where}` : result.name;
};

const _geocode = async (entry, fetcher) => {
  const qualifier = entry.qualifier;
  const cacheKey = `${entry.key}|${qualifier?.cc || ""}|${qualifier?.admin1 || ""}`;
  const cached = lookupCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.matches;
  const params = new URLSearchParams({ name: entry.key, count: "20", language: "en", format: "json" });
  if (qualifier?.cc) params.set("countryCode", qualifier.cc);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error("timeout"));
      }, LOOKUP_TIMEOUT_MS);
    });
    const response = await Promise.race([
      fetcher(`${GEOCODER_URL}?${params}`, { signal: controller?.signal, headers: { Accept: "application/json" } }),
      timeout,
    ]);
    if (!response || !response.ok) return null;
    const data = await Promise.race([response.json(), timeout]);
    const wanted = _keyOf(entry.key);
    const matches = (Array.isArray(data?.results) ? data.results : [])
      .filter(
        (result) =>
          result &&
          _keyOf(result.name || "") === wanted &&
          /^PPL/.test(result.feature_code || "") &&
          typeof result.timezone === "string" &&
          _isValidTimeZone(result.timezone) &&
          (!qualifier?.cc || result.country_code === qualifier.cc) &&
          (!qualifier?.admin1 || _keyOf(result.admin1 || "") === _keyOf(qualifier.admin1)),
      )
      .sort((a, b) => (b.population || 0) - (a.population || 0));
    _remember(lookupCache, cacheKey, { matches, expires: Date.now() + LOOKUP_CACHE_MS }, 500);
    return matches;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const _resolveEntry = async (entry, ctx) => {
  if (!entry || entry.kind !== "lookup") return entry;
  const fallback = entry.fallback
    ? { ...entry.fallback, kind: "place", region: undefined, multi: undefined, display: _titleCase(entry.key), key: entry.key }
    : null;
  if (!settings.onlineLookup || typeof ctx.fetch !== "function") return fallback;
  const matches = await _geocode(entry, ctx.fetch);
  if (!matches || !matches.length) return fallback;
  const [top, ...rest] = matches;
  const floor = Math.max(1000, (top.population || 0) / 10);
  const alts = entry.qualifier?.admin1
    ? []
    : rest
        .filter((result) => (result.population || 0) >= floor)
        .slice(0, 3)
        .map((result) => [result.timezone, _placeLabel(result, ctx.locale)]);
  return {
    zone: top.timezone,
    kind: "lookup",
    key: entry.key,
    display: _placeLabel(top, ctx.locale),
    alts: alts.length ? alts : undefined,
  };
};

const _resolveParsed = async (parsed, ctx) => {
  const one = async (entry) => {
    const resolved = await _resolveEntry(entry, ctx);
    if (entry && !resolved) throw new Error("unresolved");
    return resolved;
  };
  const many = (entries) => Promise.all(entries.map(one));
  try {
    if (parsed.intent === "now") return { ...parsed, zones: await many(parsed.zones) };
    if (parsed.intent === "convert") {
      return { ...parsed, source: await one(parsed.source), targets: await many(parsed.targets) };
    }
    if (parsed.intent === "diff") return { ...parsed, base: await one(parsed.base), targets: await many(parsed.targets) };
    return { ...parsed, zone: await one(parsed.zone) };
  } catch {
    return null;
  }
};

const RENDERERS = { now: _renderNow, convert: _renderConvert, diff: _renderDiff, dst: _renderDst };

export const slot = {
  id: "timezone",
  name: "Time zone",
  description:
    "Current time anywhere, time zone conversions and daylight saving dates, from plain questions such as “time in tokyo”, “5pm ET to PT” or “when do the clocks change”.",
  isClientExposed: false,
  supportsNojs: true,
  position: "at-a-glance",
  slotPositions: ["at-a-glance", "above-results", "above-sidebar", "below-sidebar"],

  settingsSchema: [
    {
      key: "homeZone",
      label: "Home time zone",
      type: "text",
      default: "",
      placeholder: "America/New_York",
      description:
        "Used when a question names no zone, such as “5pm ET” or “when does the time change”. Accepts an IANA zone, a city or an abbreviation. Blank uses the server's zone. Visitors' browsers replace it with their own zone unless “Use the visitor's time zone” is off.",
    },
    {
      key: "timeFormat",
      label: "Clock format",
      type: "select",
      options: ["auto", "12h", "24h"],
      default: "auto",
      description: "12-hour, 24-hour, or follow the visitor's language when set to auto.",
    },
    {
      key: "showSeconds",
      label: "Show seconds",
      type: "toggle",
      default: "true",
      description: "Show seconds on the live clock.",
    },
    {
      key: "bareTriggers",
      label: "Answer short queries",
      type: "toggle",
      default: "true",
      description:
        "Show the current time for two-word queries such as “tokyo time” or “london timezone”. Full questions such as “time in tokyo” always work.",
    },
    {
      key: "browserZone",
      label: "Use the visitor's time zone",
      type: "toggle",
      default: "true",
      description:
        "Let the browser add the visitor's own time and use their zone instead of the home time zone. Nothing is sent to the server.",
    },
    {
      key: "onlineLookup",
      label: "Look up other places online",
      type: "toggle",
      default: "true",
      description:
        "Find places that are not built in, such as “current time foster city” or “current time springfield il”, with the Open-Meteo geocoding service. Only the place name, and a country code when one is given, is sent, through degoog's outgoing connection. Off keeps every lookup on the server.",
    },
  ],

  init(ctx) {
    template = ctx?.template || "";
    pluginFetch = typeof ctx?.fetch === "function" ? ctx.fetch : null;
  },

  configure(next) {
    settings.homeZone = _resolveHomeZone(next?.homeZone);
    const format = String(next?.timeFormat || "auto").toLowerCase();
    settings.timeFormat = TIME_FORMATS.has(format) ? format : "auto";
    settings.showSeconds = String(next?.showSeconds ?? "true") !== "false";
    settings.bareTriggers = String(next?.bareTriggers ?? "true") !== "false";
    settings.browserZone = String(next?.browserZone ?? "true") !== "false";
    settings.onlineLookup = String(next?.onlineLookup ?? "true") !== "false";
    lastQuery = null;
    lastParse = null;
  },

  trigger(query) {
    return _parseQuery(query) !== null;
  },

  async execute(query, context) {
    const parsed = _parseQuery(query);
    if (!parsed) return { title: "", html: "" };
    const locale = _safeLocale(context?.locale);
    const nojs = context?.nojs === true;
    const ctx = {
      locale,
      nojs,
      now: Number.isFinite(context?.now) ? context.now : Date.now(),
      clock: settings.timeFormat,
      seconds: settings.showSeconds,
      browser: settings.browserZone && !nojs,
      home: settings.homeZone,
      tr: (key, vars) => _t(key, vars, locale),
      fetch: typeof context?.fetch === "function" ? context.fetch : pluginFetch,
    };
    try {
      const resolved = await _resolveParsed(parsed, ctx);
      if (!resolved) return { title: "", html: "" };
      const result = RENDERERS[resolved.intent](resolved, ctx);
      return result || { title: "", html: "" };
    } catch {
      return { title: "", html: "" };
    }
  },
};

export const _internals = {
  parse: _parseQuery,
  normalize: _normalize,
  offsetAt: _offsetAt,
  transitions: _windowTransitions,
  yearTransitions: _yearTransitions,
  localToInstant: _localToInstant,
  resolveDate: _resolveDate,
  abbrFor: _abbrFor,
  fmtValue: _fmtValue,
  dstModel: _dstModel,
  zoneIndex: ZONE_INDEX,
  grammarWords: () => [
    ...CONNECTORS.keys(),
    ...ANCHORS,
    ...FILLERS,
    ...DST_WORDS.keys(),
    ...MONTHS.keys(),
    ...WEEKDAYS.keys(),
    ...RELATIVE_DAYS.keys(),
    "local",
    "noon",
    "midday",
    "midnight",
    "next",
    "this",
  ],
  tableZones: () => [
    ...ABBREVIATIONS.flatMap(([, zone, , alts]) => [zone, ...(alts || [])]),
    ...PENDING_ABBREVIATIONS.map(([, zone]) => zone),
    ...LONG_NAMES.map(([, zone]) => zone),
    ...Object.keys(PLACE_ZONES),
    ...Object.values(MULTI_ZONES).flat(),
    ...Object.values(PLACE_ALTERNATIVES).flat().map(([zone]) => zone),
    ...Object.keys(KNOWN_ABBR),
  ],
};

export default { slot };
