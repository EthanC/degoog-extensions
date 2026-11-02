# degoog-extensions

Extensions for [degoog](https://github.com/degoog-org/degoog) search.

## Install

1. Open **Settings → Store** on your degoog instance.
2. Add this repository: `https://github.com/EthanC/degoog-extensions`
3. Install the extension you want from the list.

## Extensions

### Plugins

| Name | Type | Description |
| --- | --- | --- |
| [Timestamp](plugins/timestamp) | slot | Converts Unix timestamps into human readable UTC and local dates, and dates back into timestamps. Triggers on bare timestamps, ISO dates and keywords such as `epoch` or `unix time`. |
| [Time zone](plugins/timezone) | slot | Current time anywhere, time zone conversions and daylight saving dates, from plain questions such as `time in tokyo`, `5pm ET to PT` or `when do the clocks change`. |

## Development

Tests run on Node 20 or newer, no dependencies required:

```sh
npm test
```

Each extension lives in its own folder with an `index.js` entry, an `author.json`, optional `template.html`, `style.css`, `script.js`, `locales/` and a `README.md` that the Store shows as documentation. The root `package.json` is the Store manifest.
