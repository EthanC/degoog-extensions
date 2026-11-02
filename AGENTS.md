# AGENTS.md

Guide for agents working in this repository. It holds extensions for [degoog](https://github.com/degoog-org/degoog), a self-hosted search aggregator, and is published as a degoog Store repository.

Read this before writing or changing an extension. The degoog developer docs at https://degoog-org.github.io/docs/developer.html cover the basics but skip much of what is below, which was learned by reading degoog core (v1.1.1) and testing against a live instance.

## Ground rules

- **Work on the checked-out branch.** Commit to whatever branch is checked out, usually `main`. Never create a branch unless the user explicitly asks for one.
- **Commit only when asked, push only when asked.** Use [Conventional Commits](https://www.conventionalcommits.org/) with the extension folder as scope, for example `feat(timestamp): ...` or `fix(timestamp): ...`. Do not add attribution trailers.
- **Never commit instance details.** This repository is meant to be public. Keep LAN addresses, hostnames, passwords, settings tokens and API keys out of every file, including tests, screenshots and this one.
- **Run `npm test` before every commit.** All tests must pass.

## Repository layout

```
package.json            Store manifest (read by degoog) + npm test script
README.md               Human-facing list of extensions
plugins/<name>/         One folder per plugin (see "Plugin anatomy")
tests/<name>*.test.mjs  node:test suites, one or more per extension
```

Other Store types live in sibling top-level folders with the same layout as degoog-org/official-extensions: `engines/`, `themes/`, `transports/`, `autocomplete/`, `shortcuts/` and `favicon/`. Add the matching array to `package.json` when the first one appears.

### Store manifest (`package.json`)

Every extension needs an entry, otherwise the Store never shows it:

```json
{
  "path": "plugins/timestamp",
  "name": "Timestamp",
  "description": "One or two sentences shown on the Store card.",
  "version": "1.0.0",
  "type": "slot",
  "minDegoogVersion": "1.1.0"
}
```

- **`type`** is `slot`, `command` or `interceptor` for plugins. It only labels the Store card. What the module exports decides how it loads.
- **`version`** must be bumped for every change that installs should pick up. The Store shows "update available" whenever the installed version string differs from the repository's.
- **`minDegoogVersion`** only shows a warning on the Store card. It does not block installation.
- **The installed folder** is named `<github-user>-<repo>-<folder>`, lowercased. For the Timestamp plugin that is `<github-user>-degoog-extensions-timestamp`. Renaming an extension's folder therefore orphans every user's settings for it.

## Plugin anatomy

```
plugins/<name>/
  index.js        Entry module. Must be index.js/.ts/.mjs/.cjs, nothing else
  template.html   Optional HTML fragment, available as ctx.template in init()
  style.css       Optional, loaded on every page while the plugin is enabled
  script.js       Optional client script, loaded on every page while enabled
  locales/*.json  Optional translations (en.json at minimum if any)
  author.json     {"name": "<author>", "url": "<author profile URL>"}, same as the other extensions here
  README.md       Shown as in-app documentation and on GitHub
  screenshots/    1.webp, 2.webp, ... shown on the Store card
```

### Choosing the extension type

- **Slot** (`export const slot = {...}`). A panel the user did not explicitly ask for, chosen by `trigger(query)`. Use this for anything "triggered by keywords, not a command". Positions: `at-a-glance`, `above-results`, `below-results`, `full-width-above-results`, `above-sidebar`, `below-sidebar`, `knowledge-panel`. List the allowed ones in `slotPositions` to give users a Position setting.
- **Command** (`export default { trigger: "name", execute(args) }`). A `!bang` the user types on purpose. `naturalLanguagePhrases` adds phrase triggers.
- **Interceptor, search tab, middleware, routes.** See degoog's `src/server/types/extension.ts` for the shapes.

### Slot contract details that are not in the docs

- **Module shape.** The registry accepts `slot`, `slotPlugin` or `default.slot` exports. Validation needs `name`, a valid `position`, and `trigger` and `execute` functions. Export `default { slot }` as well, like the official plugins do.
- **Ids are overwritten.** After loading, degoog sets `slot.id` to the canonical id `<installed-folder>-slot`, for example `<github-user>-degoog-extensions-timestamp-slot`. Settings are stored under that id.
- **Locale lookups for name and settings mostly miss.** degoog looks up `<canonical-id>.name`, `<canonical-id>.description` and `<canonical-id>.settings.<key>.label`. A locale file keyed by a short name like `timestamp` never matches those for Store installs. The English `name`, `description` and `settingsSchema` labels in `index.js` are therefore what users see, so write them properly. Keep the locale `settings` blocks anyway, for parity with the official extensions.
- **Your own strings do translate.** Call `slot.t(key, vars, locale)` (degoog sets `slot.t` from your `locales/`), or put `{{ t:ns.key }}` in returned HTML. Use `context.locale`, which is the first entry of the request's `Accept-Language`. Pick a top-level namespace in your locale files (for example `"timestamp": {...}`) and prefix every key with it.
- **When code runs.** `trigger` runs on every search, so keep it fast and free of network calls. `execute` has a 10-second timeout (`DEGOOG_SLOT_TIMEOUT_MS`). A throw or timeout silently drops the panel. Return `{ title, html }`, and return an empty `html` for no panel.
- **`waitForResults: true`** delays the slot until results exist and passes them in `context.results`. Leave it off for slots that don't need results, so the panel appears immediately.
- **The at-a-glance slot is requested twice.** The client calls `POST /api/slots/glance` before results arrive and again after, so the panel can re-render. Client code must cope with re-mounts.
- **No-JS page.** The `/nojs` page only runs slots with `supportsNojs: true`, and passes `context.nojs`. Leave out JS-only controls in that mode.
- **`isClientExposed`** must be a boolean. Use `false` when all traffic goes through the server. It drives a privacy indicator in settings.
- **Settings.** `settingsSchema` field values arrive in `configure(settings)` as **strings**, toggles included (`"true"`/`"false"`). Parse defensively and clamp. Reserved keys: `disabled`, `slotPosition`, `slotSearchTypes`, `priority`, `score`, `outgoingTransport`, `searchTypeOverride`, `theme`, `shortcuts`.
- **`init(ctx)`.** It runs once, with `ctx.template`, `ctx.fetch` (proxy-aware), `ctx.useCache(ns, ttlMs)`, `ctx.readFile`, `ctx.signProxyUrl` and `ctx.apiBase`.

### Client scripts (`script.js`)

- **Wrapper.** degoog serves the file wrapped as `(function(t){const __PLUGIN_ID__="<installed-folder>";…})(window.scopedT("slots/<id>"))`. So `t("ns.key")` translates with your own locale files, and `__PLUGIN_ID__` builds `/api/plugin/${__PLUGIN_ID__}/...` route URLs. Literal `/plugins/<x>/` and `/api/plugin/<x>/` paths are rewritten to the installed folder.
- **Pages.** It loads on every page, not just when your panel shows. Find panels with a `MutationObserver` and mark them as mounted with a data attribute, so the second glance render is handled correctly.
- **Back-forward cache.** Survive it: pause timers on `pagehide` and resume on `pageshow` when `event.persisted` is true. Never disconnect your observer for good on `pagehide`.
- **Plain-HTTP instances.** On plain-HTTP origins, typical for LAN instances, `navigator.clipboard` is `undefined`. Always keep a fallback that copies through a hidden textarea and `execCommand("copy")`.
- **Labels.** Remember an element's original label before changing it (for example "Copy" to "Copied"). Clear pending reset timers on repeat clicks, or the label sticks.

### Styling

- **Prefix every class** with a short plugin prefix (`tstamp-…`), because `style.css` is global.
- **Use degoog's variables and classes** so themes and light mode keep working: `var(--text-primary)`, `var(--text-secondary)`, `var(--bg-light)`, `var(--bg-hover)`, `var(--border-light)`, `var(--success)`, `.degoog-badge`, `.degoog-icon-btn`. Font Awesome is available (`fa-regular fa-copy`).
- **Match the surrounding design.** No new borders, blur or transparency unless degoog already uses them nearby. At-a-glance panels already sit inside a padded `degoog-panel`.
- **Check both themes and a 390px width.** Stack label/value grids below roughly 480px.

## Writing triggers

A slot that fires on the wrong query hijacks someone's search, so treat false positives as bugs.

- **Normalise first.** Trim, lowercase, collapse whitespace, strip trailing punctuation, and remove apostrophes (`'‘’`) so `what's` becomes `whats` before tokenising.
- **Split keywords into strong and weak.** Strong keywords (`epoch`, `timestamp`, `unix time`) mean intent on their own. Weak ones (`unix`, `to date`, `human readable`) also need strong evidence in the rest of the query, such as a timestamp-sized number or an explicit unit.
- **Don't let unit words become keywords.** If `epoch ms` is matched as a keyword phrase, the `ms` is lost. Parse units as tokens, including attached forms such as `1700000000ms`.
- **Watch non-ASCII in regex.** `\b` never matches next to `µ`, `μ`, `’` or `→`, because they are not word characters in non-unicode JS regex. Use token or `Map` lookups, or explicit `(?:^|\s)`/`(?=\s|$)` boundaries.
- **Respect bare-input toggles.** Give users a toggle for "bare" triggers, such as a lone number or a lone date, but don't let it disable explicit forms like a keyword or a unit.
- **Check `Date.UTC` years.** It maps years 0 to 99 to 1900 to 1999. Build dates with `new Date(0)` plus `setUTCFullYear(y, m, d)` plus `setUTCHours`, and validate by reading the fields back.
- **Return null when unsure.** It's better to show no panel than a wrong one.

## Security and privacy

degoog runs extensions in-process with no sandbox, and some instances are public. Treat every extension like core code.

- **Escape everything you interpolate into HTML**, attributes included. Escape `&`, `<`, `>` and `"`. Also escape `{{` to `&#123;&#123;`, otherwise degoog's `{{ t:… }}` pass can expand user text.
- **Never put user input into `<script>`** or inline event handlers. Use `data-*` attributes plus `script.js`.
- **Make outgoing requests through `ctx.fetch` or `context.fetch`**, never global `fetch`. Proxy and transport settings then still apply, and the visitor's IP never reaches third parties. Prefer extensions that make no network calls at all.
- **Don't log, store or send queries anywhere.** degoog's privacy model allows exactly two places that keep queries: the search cache and the opt-in indexer.
- **Mark secret settings** with `type: "password"` and `secret: true`, so they are never sent to the browser.
- **Plugin routes** (`export const routes`) are public unless you check auth. Never use GET for anything that mutates state.

## Testing

### Unit tests (required)

- **Tooling.** Tests use `node:test` and `node:assert/strict`, with no dependencies. Run them with `npm test` (`node --test tests/`) on Node 20 or newer.
- **Load the plugin like degoog does.** Import `index.js`, set `slot.t` to a small translator over the real `locales/*.json`, and call `slot.init({ template })` with the real `template.html`. Then call `slot.configure()` with the `settingsSchema` defaults as strings.
- **Cover triggers.** Keep a positive list and a negative list. Every bug found in review gets a regression case.
- **Cover rendering.** Assert on `data-*` attributes and field text in the returned HTML, not on exact markup. Check that no `{{` or untranslated `ns.key` strings leak through.
- **Cover locales.** Assert that every locale has the same key set as `en.json`.
- **Test client scripts.** Use `node:vm` with a minimal fake DOM and fake timers. `tests/timestamp-client.test.mjs` is a working example covering mount, copy and back-forward cache behaviour.
- **Check Bun parity.** degoog runs on Bun (`engines.bun` in its package.json). For anything engine-sensitive, such as regex, Intl or BigInt, also run a quick check with a portable Bun build.

### Testing against a live instance

Ask the user for the instance URL and credentials. Never write them into the repository.

- **Slots are public endpoints.** Exercise them with `POST /api/slots/glance` for at-a-glance slots, or `POST /api/slots` for other positions. Send the body `{"query": "...", "type": "web"}` and an `Accept-Language` header. `/api/search` and search-only integrations built on it never return slot panels.
- **Send non-ASCII test queries from Node `fetch`**, not Git Bash `curl`. Git Bash re-encodes arguments for native Windows programs, which turns `µ` and `’` into U+FFFD and looks exactly like a server bug.
- **Don't curl `/search?q=` pages.** degoog's CSS bot trap can strike or ban clients that fetch result pages without loading the page CSS. Use the APIs, or a real browser.
- **Admin routes.** Store install and uninstall need a settings token. Get one from `POST /api/settings/auth {"password": "..."}`, send it as the `x-settings-token` header, keep it in a scratch file, never print it, and delete it when done. The Bearer "API key" only covers search endpoints, not admin.

### Sideloading an uncommitted build

The Store installs only from git URLs that support shallow clones (`git clone --depth 1`). A plain static file server (`python -m http.server`) fails with "dumb http transport does not support shallow capabilities".

1. Copy the repository files into a scratch folder, `git init`, commit, then `git clone --bare` into `<root>/<github-user>/<repo>-dev.git`.
2. Serve that bare repository read-only over git's smart HTTP protocol. A small Node server that pipes requests to `git http-backend` (CGI) works: set `GIT_PROJECT_ROOT` and `GIT_HTTP_EXPORT_ALL`, pass the `HTTP_*` headers through, and refuse `git-receive-pack`. Agent sandboxes usually forbid starting LAN-facing servers, so give the user the command to run.
3. Add it with `POST /api/store/repos {"url"}`, then install with `POST /api/store/install {"repoUrl", "itemPath", "type": "plugin"}`. Because the URL path differs, it installs as a separate plugin (`…-dev-<name>`).
4. **Always clean up.** Uninstall with `POST /api/store/uninstall` using the same body, remove the repository with `DELETE /api/store/repos {"url"}`, and confirm the panel, script and CSS are gone. Otherwise the panel shows twice once the real install exists.

### Visual checks and Store screenshots

- **Browser.** Use a browser-automation tool if your environment provides one. Otherwise drive a local Chromium headless over `--remote-debugging-pipe`, with a throwaway `--user-data-dir` in the scratch folder. That opens no network port. `--screenshot` combined with `--virtual-time-budget` hangs on degoog's open result stream, so wait for a DOM condition instead, for example `[data-tstamp-card][data-tstamp-mounted="1"]`.
- **What to check.** The panel mounts. Dark and light themes are both right (emulate `prefers-color-scheme`). Nothing overflows at 1280px or at 390px. Interactive bits work: the timers tick, and the copy buttons copy the right text and reset. The console shows no errors from the plugin.
- **Screenshot format.** About 1600px-wide WebP, the size of the official listings: a 1280×704 viewport at device scale 1.25, captured with `Page.captureScreenshot {format: "webp", quality: 90}`. Show the search bar, the panel and the first result. Include at least one dark-mode shot, and use that one in the plugin README.
- **Set the emulated time zone** to a neutral one (`Emulation.setTimezoneOverride`, for example `America/New_York`), so screenshots don't reveal the user's real zone. Scan every image for anything else personal before committing.

## Documentation

- **Plugin `README.md`.** Write a one-paragraph summary, then a centered screenshot (`<div align="center"><img width="800" alt="…" src="./screenshots/1.webp" /></div>`). Follow with a trigger table of example queries, then one sentence per setting, and close with privacy and no-JS notes. degoog's in-app documentation viewer only shows absolute `http(s)` images, so relative screenshots appear on GitHub only.
- **Root `README.md`.** Add a row per extension to the table.
- **Keep docs in sync with behaviour.** Every trigger example in a README should have a test.

## Release checklist

1. `npm test` passes, and new behaviour has tests.
2. The `version` in `package.json` is bumped. Bump `minDegoogVersion` only if you used newer core APIs.
3. Locales have matching keys. Every user-facing string in `index.js` goes through `slot.t` or `{{ t:… }}`.
4. If the UI changed, it was checked live, in both themes and at mobile width. Refresh the screenshots if needed.
5. Any dev sideload is uninstalled and its repository removed.
6. Commit with a Conventional Commit message. Push only when the user asks. The GitHub repository must be public for the Store to clone it.
7. `AGENTS.md` is updated if this change taught you anything a future agent would need. See below.

## Maintaining this file

This file is part of the codebase, not a one-off note. Every agent that changes the repository is responsible for keeping it accurate.

- **Update it in the same commit** as the change that taught you something. Use the same Conventional Commit, or a separate `docs(agents): …` commit if the lesson stands on its own.
- **Add a section for each new extension type.** Give the first engine, theme, transport, autocomplete provider, shortcut or favicon provider its own `##` section, mirroring "Plugin anatomy". Cover the folder layout and required files, the export shape the degoog registry matches, contract details that are missing from the official docs, how to test it (unit and live), and screenshot conventions. Also add the type's folder to "Repository layout" and its array to the manifest example, and add any type-specific steps to the release checklist.
- **Keep cross-cutting lessons in the shared sections.** Security, testing infrastructure, Store behaviour and git conventions belong under their existing headings, not in a type section.
- **Only record what you verified.** Read degoog's source, or test against a live instance, before writing a claim down. Name the degoog file or route where it helps, and the degoog version when the behaviour may change. Mark anything unverified as such.
- **Correct, don't append.** When degoog changes or a rule here turns out to be wrong, edit or delete the stale text instead of adding a contradicting note. If a code bug caused the mistake, add a regression test too.
- **Keep it generic and public-safe.** No instance URLs, LAN addresses, credentials, personal usernames, time zones, or names of specific agents and tools. Use placeholders such as `<github-user>` and `<instance>`.
- **Keep it short.** Prefer one-line rules with the reason attached over long narratives. Keep each extension's own details in its README, not here.
