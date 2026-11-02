const NS = "timestamp";
const MAX_QUERY_LEN = 160;
const MAX_EXTRA_ZONES = 6;
const MAX_DATE_MS = 8.64e15;
const MIN_BARE_DIGITS = 9;
const DAY_MS = 86400000;
const TIME_FORMATS = new Set(["auto", "12h", "24h"]);

const UNIT_DIVISOR = { microseconds: 1000n, nanoseconds: 1000000n };
const UNIT_WORDS = new Map([
  ...["s", "sec", "secs", "second", "seconds"].map((w) => [w, "seconds"]),
  ...["ms", "msec", "msecs", "milli", "millis", "millisec", "millisecs", "millisecond", "milliseconds"].map((w) => [w, "milliseconds"]),
  ...["us", "µs", "μs", "usec", "usecs", "micro", "micros", "microsec", "microsecs", "microsecond", "microseconds"].map((w) => [w, "microseconds"]),
  ...["ns", "nsec", "nsecs", "nano", "nanos", "nanosec", "nanosecs", "nanosecond", "nanoseconds"].map((w) => [w, "nanoseconds"]),
]);
const ATTACHED_UNIT_RX = /^(@?-?\d[\d,_]*(?:\.\d+)?)([a-zµμ]+)$/;

const STRONG_KEYWORD_RX =
  /\b(?:unix\s*(?:time(?:stamp)?|epoch)|unixtime|unixtimestamp|epoch(?:\s*(?:time(?:stamp)?|converter))?|time_?stamp|time_t|posix\s*time|zeitstempel|unixzeit|horodatage|marca\s+(?:de\s+)?tiempo|marca\s+temporal)\b/g;
const WEAK_KEYWORD_RX =
  /\b(?:unix|(?:to|as|in|into)\s+(?:a\s+)?(?:human[\s-]*readable\s*|readable\s*)?(?:date(?:time)?|utc|gmt|iso(?:\s*8601)?|time)|human[\s-]*readable)\b/g;
const FILLER_RX =
  /\b(?:to|in|as|into|from|for|of|the|a|an|is|was|its|what|whats|convert|converter|conversion|converted|current|now|today|human|readable|date|datetime|time|local|string|format|value|number|since|equals|equal|means|mean|this)\b/g;
const ZONE_WORD_RX = /\b(?:utc|gmt)\b/g;
const ARROW_RX = /(?:^|\s)[→=>-]+(?=\s|$)/g;
const NOW_RX = /\b(?:now|current|today|currently)\b/;
const NUMBER_RX = /^@?-?\d[\d,_]*(?:\.\d+)?$/;
const BARE_NUMBER_RX = /^@?-?\d+(?:\.\d+)?$/;
const TRAILING_PUNCT_RX = /[?!.,;:]+$/;
const APOSTROPHE_RX = /['‘’]/g;

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const TIME_PART = "(?:[t\\s]\\s*(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:[.,](\\d{1,9}))?)?\\s*(am|pm)?)?";
const ZONE_PART = "(?:\\s*(z|utc|gmt|[+-]\\d{2}(?::?\\d{2})?))?";
const DATE_PATTERNS = [
  { rx: new RegExp(`^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})${TIME_PART}${ZONE_PART}$`), order: "ymd" },
  { rx: new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+([a-z]{3,9})\\.?,?\\s+(\\d{4})${TIME_PART}${ZONE_PART}$`), order: "dMy" },
  { rx: new RegExp(`^([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${TIME_PART}${ZONE_PART}$`), order: "Mdy" },
  { rx: new RegExp(`^(\\d{1,2})([/.])(\\d{1,2})\\2(\\d{4})${TIME_PART}${ZONE_PART}$`), order: "slash" },
];
const BARE_ISO_RX = /^\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?\s*(?:z|utc|gmt|[+-]\d{2}(?::?\d{2})?)?)?$/;
const WEEKDAY_RX = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/;

const RELATIVE_UNITS = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.34524],
  ["month", 12],
  ["year", Infinity],
];

const ROW_ORDER = {
  number: ["local", "iso", "seconds", "millis"],
  date: ["millis", "iso", "utc", "local"],
  now: ["millis", "iso", "utc", "local"],
};
const PLAIN_ROWS = {
  iso: { label: "iso", value: (date) => _isoString(date) },
  seconds: { label: "seconds", value: (date) => String(Math.floor(date.getTime() / 1000)) },
  millis: { label: "milliseconds", value: (date) => String(date.getTime()) },
};

const settings = {
  bareNumbers: true,
  bareDates: true,
  timeFormat: "auto",
  extraTimeZones: [],
};

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
  if (typeof translate !== "function") return key;
  return String(translate(`${NS}.${key}`, vars, locale));
};

const _render = (data) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");

const _squash = (text) => text.replace(/\s+/g, " ").trim();

const _normalize = (query) =>
  _squash(String(query ?? "").toLowerCase().replace(APOSTROPHE_RX, ""))
    .replace(TRAILING_PUNCT_RX, "")
    .trim();

const _hasMatch = (rx, text) => {
  rx.lastIndex = 0;
  const hit = rx.test(text);
  rx.lastIndex = 0;
  return hit;
};

const _isValidTimeZone = (zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const _safeLocale = (locale) => {
  const candidate = String(locale || "").trim();
  if (!candidate) return "en";
  try {
    new Intl.DateTimeFormat(candidate);
    return candidate;
  } catch {
    return "en";
  }
};

const _hourOptions = () => {
  if (settings.timeFormat === "12h") return { hour12: true };
  if (settings.timeFormat === "24h") return { hour12: false };
  return {};
};

const _utcMs = (year, monthIndex, day, hours = 0, minutes = 0, seconds = 0, millis = 0) => {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hours, minutes, seconds, millis);
  return date.getTime();
};

const _digitCount = (text) =>
  text.replace(/^@?-?/, "").split(".")[0].replace(/[,_]/g, "").replace(/^0+(?=\d)/, "").length;

const _detectUnit = (digits) => {
  if (digits >= 18) return "nanoseconds";
  if (digits >= 15) return "microseconds";
  if (digits >= 12) return "milliseconds";
  return "seconds";
};

const _extractUnitHint = (text) => {
  let unit = null;
  const tokens = [];
  for (const token of text.split(" ")) {
    if (!unit && UNIT_WORDS.has(token)) {
      unit = UNIT_WORDS.get(token);
      continue;
    }
    const attached = unit ? null : token.match(ATTACHED_UNIT_RX);
    if (attached && UNIT_WORDS.has(attached[2])) {
      unit = UNIT_WORDS.get(attached[2]);
      tokens.push(attached[1]);
      continue;
    }
    tokens.push(token);
  }
  return { unit, text: tokens.join(" ") };
};

const _parseNumber = (raw, unitHint) => {
  const cleaned = raw.replace(/^@/, "").replace(/[,_]/g, "");
  const match = cleaned.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const [, sign, intPart, fracPart = ""] = match;
  const forcedSeconds = raw.startsWith("@");
  const significant = intPart.replace(/^0+(?=\d)/, "");
  const unit = unitHint ?? (forcedSeconds ? "seconds" : _detectUnit(significant.length));
  const integer = BigInt(significant);
  let ms;
  if (unit === "seconds") {
    ms = integer * 1000n + BigInt((fracPart + "000").slice(0, 3));
  } else if (unit === "milliseconds") {
    ms = integer;
  } else {
    ms = integer / UNIT_DIVISOR[unit];
  }
  if (sign === "-") ms = -ms;
  const msNumber = Number(ms);
  return {
    unit,
    ms: msNumber,
    inRange: Number.isSafeInteger(msNumber) && Math.abs(msNumber) <= MAX_DATE_MS,
    input: `${sign}${significant}${fracPart ? `.${fracPart}` : ""}`,
    hinted: Boolean(unitHint) || forcedSeconds,
  };
};

const _numberResult = (raw, unitHint) => {
  const number = _parseNumber(raw, unitHint);
  return number ? { mode: "number", number } : null;
};

const _zoneOffsetMinutes = (zone) => {
  if (!zone || zone === "z" || zone === "utc" || zone === "gmt") return 0;
  const match = zone.match(/^([+-])(\d{2}):?(\d{2})?$/);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? "0");
  return match[1] === "-" ? -minutes : minutes;
};

const _monthNumber = (token) => {
  if (/^\d+$/.test(token)) return Number(token);
  return MONTHS[token] ?? null;
};

const _buildDate = (parts) => {
  const { year, month, day, hour, minute, second, fraction, meridiem, zone } = parts;
  if (!month || month < 1 || month > 12 || !day || day < 1 || day > 31) return null;
  let h = hour;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (h < 0 || h > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const millis = Number((fraction + "000").slice(0, 3));
  const utc = _utcMs(year, month - 1, day, h, minute, second, millis);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  const offset = _zoneOffsetMinutes(zone);
  if (offset === null) return null;
  return { ms: utc - offset * 60000, assumedUtc: !zone };
};

const _parseDate = (raw) => {
  const text = raw.replace(WEEKDAY_RX, "").trim();
  for (const { rx, order } of DATE_PATTERNS) {
    const m = text.match(rx);
    if (!m) continue;
    let year;
    let month;
    let day;
    let rest;
    if (order === "ymd") {
      year = Number(m[1]);
      month = Number(m[2]);
      day = Number(m[3]);
      rest = m.slice(4);
    } else if (order === "dMy") {
      day = Number(m[1]);
      month = _monthNumber(m[2]);
      year = Number(m[3]);
      rest = m.slice(4);
    } else if (order === "Mdy") {
      month = _monthNumber(m[1]);
      day = Number(m[2]);
      year = Number(m[3]);
      rest = m.slice(4);
    } else {
      const first = Number(m[1]);
      const second = Number(m[3]);
      year = Number(m[4]);
      const dayFirst = first > 12 || (second <= 12 && m[2] === ".");
      day = dayFirst ? first : second;
      month = dayFirst ? second : first;
      rest = m.slice(5);
    }
    if (!month) return null;
    const [hour, minute, second, fraction, meridiem, zone] = rest;
    return _buildDate({
      year,
      month,
      day,
      hour: Number(hour ?? "0"),
      minute: Number(minute ?? "0"),
      second: Number(second ?? "0"),
      fraction: fraction ?? "",
      meridiem: meridiem ?? "",
      zone: zone ?? "",
    });
  }
  return null;
};

const _dateResult = (text) => {
  const date = _parseDate(text);
  if (date) return { mode: "date", date };
  const zoneless = _squash(text.replace(ZONE_WORD_RX, " "));
  if (zoneless === text) return null;
  const fallback = _parseDate(zoneless);
  return fallback ? { mode: "date", date: { ...fallback, assumedUtc: false } } : null;
};

const _keywordQuery = (q) => {
  const hint = _extractUnitHint(q);
  const strong = _hasMatch(STRONG_KEYWORD_RX, hint.text);
  const weak = _hasMatch(WEAK_KEYWORD_RX, hint.text);

  if (!strong && !weak) {
    const value = hint.text;
    if (!hint.unit || !NUMBER_RX.test(value)) return null;
    if (!value.startsWith("@") && _digitCount(value) < MIN_BARE_DIGITS) return null;
    return _numberResult(value, hint.unit);
  }

  const stripped = hint.text.replace(STRONG_KEYWORD_RX, " ").replace(WEAK_KEYWORD_RX, " ");
  const wantsNow = NOW_RX.test(stripped);
  const rest = _squash(stripped.replace(FILLER_RX, " ").replace(ARROW_RX, " "));
  const zoneless = _squash(rest.replace(ZONE_WORD_RX, " "));

  if (!zoneless) return strong || wantsNow || hint.unit ? { mode: "now" } : null;
  if (NUMBER_RX.test(zoneless)) {
    const deliberate = strong || hint.unit || zoneless.startsWith("@");
    if (!deliberate && _digitCount(zoneless) < MIN_BARE_DIGITS) return null;
    return _numberResult(zoneless, hint.unit);
  }
  return _dateResult(rest);
};

const _parseQuery = (query) => {
  const q = _normalize(query);
  if (!q || q.length > MAX_QUERY_LEN) return null;

  if (BARE_NUMBER_RX.test(q)) {
    if (!q.startsWith("@") && (!settings.bareNumbers || _digitCount(q) < MIN_BARE_DIGITS)) return null;
    return _numberResult(q, null);
  }

  if (BARE_ISO_RX.test(q)) return settings.bareDates ? _dateResult(q) : null;

  return _keywordQuery(q);
};

const _formatZone = (date, zone, locale) =>
  new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    dateStyle: "full",
    timeStyle: "long",
    ..._hourOptions(),
  }).format(date);

const _formatRelative = (ms, locale, now = Date.now()) => {
  let value = (ms - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, next] of RELATIVE_UNITS) {
    if (Math.abs(value) < next) return rtf.format(Math.round(value), unit);
    value /= next;
  }
  return rtf.format(Math.round(value), "year");
};

const _isoWeek = (date) => {
  const d = new Date(_utcMs(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = _utcMs(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
};

const _dayOfYear = (date) =>
  Math.floor((date.getTime() - _utcMs(date.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;

const _isoString = (date) => date.toISOString().replace(/\.000Z$/, "Z");

const _copyButton = (value, locale, nojs) => {
  if (nojs) return "";
  const label = _esc(_t("copy", undefined, locale));
  return (
    `<button type="button" class="tstamp-copy degoog-icon-btn" data-tstamp-copy="${_esc(value)}" aria-label="${label}" title="${label}">` +
    `<i class="fa-regular fa-copy" aria-hidden="true"></i></button>`
  );
};

const _row = ({ key, label, value, copy, mono, zone, hidden }, locale, nojs) => {
  const classes = hidden ? "tstamp-row tstamp-row--pending" : "tstamp-row";
  const zoneAttr = zone ? ` data-tstamp-zone="${_esc(zone)}"` : "";
  const textClass = mono ? "tstamp-text tstamp-mono" : "tstamp-text";
  return (
    `<div class="${classes}"${hidden ? " hidden" : ""}>` +
    `<dt class="tstamp-label">${label}</dt>` +
    `<dd class="tstamp-value">` +
    `<span class="${textClass}" data-tstamp-field="${_esc(key)}"${zoneAttr}>${_esc(value)}</span>` +
    (copy === undefined ? "" : _copyButton(copy, locale, nojs)) +
    `</dd></div>`
  );
};

const _label = (key, locale) => _esc(_t(`labels.${key}`, undefined, locale));

const _zoneRow = (date, zone, label, locale, nojs) => {
  const value = _formatZone(date, zone, locale);
  return _row({ key: "zone", label, value, copy: value, zone }, locale, nojs);
};

const _valueRow = (key, date, locale, nojs) => {
  if (key === "local") {
    return nojs
      ? ""
      : _row({ key: "local", label: _label("local", locale), value: "", copy: "", hidden: true }, locale, nojs);
  }
  if (key === "utc") return _zoneRow(date, "UTC", _label("utc", locale), locale, nojs);
  const plain = PLAIN_ROWS[key];
  const value = plain.value(date);
  return _row({ key, label: _label(plain.label, locale), value, copy: value, mono: true }, locale, nojs);
};

const _rows = (mode, date, locale, nojs) => [
  ...ROW_ORDER[mode].map((key) => _valueRow(key, date, locale, nojs)),
  ...settings.extraTimeZones.map((zone) =>
    _zoneRow(date, zone, _esc(zone.replace(/_/g, " ")), locale, nojs),
  ),
];

const _metaLine = (date, locale) =>
  [
    _t("meta.week", { week: _isoWeek(date) }, locale),
    _t("meta.dayOfYear", { day: _dayOfYear(date), year: date.getUTCFullYear() }, locale),
  ].join(" · ");

const _card = (data, locale) =>
  _render({
    mode: data.mode,
    ms: data.ms === undefined ? "" : String(data.ms),
    live: data.live ? "true" : "false",
    clock: settings.timeFormat,
    kicker: _esc(_t(`kicker.${data.mode}`, undefined, locale)),
    headline: _esc(data.headline),
    headField: _esc(data.headField),
    headMono: data.headMono ? " tstamp-mono" : "",
    badge: data.badge ? `<span class="tstamp-badge degoog-badge">${_esc(data.badge)}</span>` : "",
    subline: _esc(data.subline ?? ""),
    rows: (data.rows ?? []).join(""),
    note: data.note ? `<p class="tstamp-note">${_esc(data.note)}</p>` : "",
  });

const _renderNumber = ({ number }, locale, nojs) => {
  const badge = _t(`units.${number.unit}`, undefined, locale);
  if (!number.inRange) {
    return _card(
      {
        mode: "number",
        headline: number.input,
        headField: "input",
        headMono: true,
        badge,
        note: _t("note.outOfRange", undefined, locale),
      },
      locale,
    );
  }
  const date = new Date(number.ms);
  const guessed = !number.hinted && number.unit !== "seconds";
  return _card(
    {
      mode: "number",
      ms: number.ms,
      headline: _formatZone(date, "UTC", locale),
      headField: "zone",
      badge,
      subline: `${_formatRelative(number.ms, locale)} · ${_metaLine(date, locale)}`,
      rows: _rows("number", date, locale, nojs),
      note: guessed ? _t("note.assumedUnit", { unit: badge }, locale) : "",
    },
    locale,
  );
};

const _renderInstant = (mode, ms, locale, nojs, { live = false, note = "" } = {}) => {
  const date = new Date(ms);
  const meta = _metaLine(date, locale);
  return _card(
    {
      mode,
      ms,
      live,
      headline: String(Math.floor(ms / 1000)),
      headField: "seconds",
      headMono: true,
      badge: _t("units.seconds", undefined, locale),
      subline: live ? meta : `${_formatRelative(ms, locale)} · ${meta}`,
      rows: _rows(mode, date, locale, nojs),
      note,
    },
    locale,
  );
};

const _renderDate = ({ date }, locale, nojs) => {
  if (!Number.isFinite(date.ms) || Math.abs(date.ms) > MAX_DATE_MS) return "";
  const note = date.assumedUtc ? _t("note.assumedUtc", undefined, locale) : "";
  return _renderInstant("date", date.ms, locale, nojs, { note });
};

const _renderNow = (locale, nojs) =>
  _renderInstant("now", Date.now(), locale, nojs, { live: true });

export const slot = {
  id: "timestamp",
  name: "Timestamp",
  description:
    "Converts Unix timestamps into human readable UTC and local dates, and dates back into timestamps. Triggers on bare timestamps, ISO dates and keywords such as epoch or unix time.",
  isClientExposed: false,
  supportsNojs: true,
  position: "at-a-glance",
  slotPositions: ["at-a-glance", "above-results", "above-sidebar", "below-sidebar"],

  settingsSchema: [
    {
      key: "bareNumbers",
      label: "Convert bare numbers",
      type: "toggle",
      default: "true",
      description:
        "Show the panel when the whole query is a number with at least 9 digits, even without a keyword. Keyword queries such as “epoch 86400” always work.",
    },
    {
      key: "bareDates",
      label: "Convert bare dates",
      type: "toggle",
      default: "true",
      description:
        "Show the panel when the whole query is an ISO 8601 date such as 2024-01-15 or 2024-01-15T10:30:00Z, even without a keyword.",
    },
    {
      key: "timeFormat",
      label: "Clock format",
      type: "select",
      options: ["auto", "12h", "24h"],
      default: "auto",
      description: "12-hour, 24-hour, or follow the locale when set to auto.",
    },
    {
      key: "extraTimeZones",
      label: "Extra time zones",
      type: "text",
      default: "",
      placeholder: "America/New_York, Europe/Berlin",
      description:
        "Comma-separated IANA time zones to list alongside UTC and your local time. Unknown zones are ignored.",
    },
  ],

  init(ctx) {
    template = ctx?.template || "";
  },

  configure(next) {
    settings.bareNumbers = String(next?.bareNumbers ?? "true") !== "false";
    settings.bareDates = String(next?.bareDates ?? "true") !== "false";
    const format = String(next?.timeFormat || "auto").toLowerCase();
    settings.timeFormat = TIME_FORMATS.has(format) ? format : "auto";
    settings.extraTimeZones = String(next?.extraTimeZones || "")
      .split(/[,;\n]+/)
      .map((zone) => zone.trim())
      .filter((zone) => zone && zone.toUpperCase() !== "UTC" && _isValidTimeZone(zone))
      .slice(0, MAX_EXTRA_ZONES);
  },

  trigger(query) {
    return _parseQuery(query) !== null;
  },

  async execute(query, context) {
    const parsed = _parseQuery(query);
    if (!parsed) return { title: "", html: "" };
    const locale = _safeLocale(context?.locale);
    const nojs = context?.nojs === true;
    if (parsed.mode === "now") {
      return { title: _t("titleNow", undefined, locale), html: _renderNow(locale, nojs) };
    }
    const html =
      parsed.mode === "number"
        ? _renderNumber(parsed, locale, nojs)
        : _renderDate(parsed, locale, nojs);
    return { title: _t("title", undefined, locale), html };
  },
};

export default { slot };
