# VMS Timesheet Scraper — POC

Production-grade TypeScript scraper for Beeline VMS with 3-level fallback extraction.

---

## Quick Start

```bash
# 1. Copy and fill credentials
cp .env.example .env
# edit .env with your BEELINE_USERNAME, BEELINE_PASSWORD, ANTHROPIC_API_KEY

# 2. Install dependencies
npm install

# 3. Install Playwright browser (one-time)
npm run setup:browsers

# 4. Run (debug mode — watch the browser)
HEADLESS=false npm run dev

# 5. Run in production mode
npm run dev
```

---

## Output Structure

```
output/
  json/               ← one JSON per timesheet
    TS-12345.json
    TS-12346.json
  screenshots/        ← full-page PNG per timesheet
  html/               ← raw HTML backup per timesheet
  logs/
    scraper.log       ← full debug log
    errors.log        ← errors only
  summary.json        ← run-level stats
```

### Sample timesheet JSON

```json
{
  "metadata": {
    "timesheetId": "TS-12345",
    "employeeName": "Jane Smith",
    "period": "01/01/2024 - 01/07/2024",
    "periodStart": "2024-01-01",
    "periodEnd": "2024-01-07",
    "status": "Approved",
    "client": "Acme Corp",
    "url": "https://app2.beeline.com/timesheets/TS-12345",
    "scrapedAt": "2024-01-10T14:32:00.000Z"
  },
  "entries": [
    { "date": "2024-01-01", "hours": 8, "type": "REG", "rawType": "Regular" },
    { "date": "2024-01-02", "hours": 10, "type": "OT", "rawType": "Overtime" }
  ],
  "totals": { "regular": 40, "ot": 5, "dt": 0, "total": 45 },
  "confidence": 0.94,
  "fallbackUsed": "none"
}
```

---

## How Extraction Works

Extraction runs in 3 levels — each level only activates if the previous scored below threshold:

```
Level 1: Selector waterfall (fastest, ~100ms/page)
  → Reads beeline_v1.json for 4-6 CSS selector candidates per field
  → Picks first match
  → Scores confidence

Level 2: OCR fallback (~3-8s/page)
  → Runs Tesseract on the full-page screenshot
  → Parses raw text with heuristics
  → Merges best results with Level 1

Level 3: LLM fallback (~5-15s/page + API cost)
  → Sends screenshot + HTML to Claude
  → Gets structured JSON back
  → Merges best results
```

Confidence is scored on:
- Required metadata fields present (employee name, period, status)
- Hours in entries sum to reported total
- Entries exist and dates are valid

---

## Updating Selectors (Zero Code Changes)

If Beeline updates their DOM, open `src/parsers/structures/beeline_v1.json` and add the new selector to the **front** of the relevant array. The engine always tries selectors in order.

```json
"employeeName": {
  "selectors": [
    ".new-selector-after-redesign",   ← add new one here
    ".employee-name",                  ← existing ones stay as fallbacks
    "[data-field='employeeName']"
  ]
}
```

To support a new VMS portal entirely, create a new structure file (e.g. `fieldglass_v1.json`) and pass it to the runner.

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `BEELINE_URL` | `https://app2.beeline.com` | Portal base URL |
| `BEELINE_USERNAME` | required | Login username |
| `BEELINE_PASSWORD` | required | Login password |
| `ANTHROPIC_API_KEY` | optional | Enables LLM fallback |
| `MAX_CONCURRENCY` | `3` | Parallel detail pages |
| `CONFIDENCE_THRESHOLD` | `0.80` | Score below this triggers fallback |
| `MAX_RETRIES` | `3` | Retries per timesheet |
| `DATE_FROM` | _(all)_ | Filter start date `YYYY-MM-DD` |
| `DATE_TO` | _(all)_ | Filter end date `YYYY-MM-DD` |
| `HEADLESS` | `true` | Set `false` to watch browser |
| `OUTPUT_DIR` | `./output` | Where to write results |

---

## Project Structure

```
src/
  index.ts                      ← entry point
  config.ts                     ← env-driven config
  types.ts                      ← all TypeScript interfaces
  browser/
    browserManager.ts           ← Playwright lifecycle + stealth
  auth/
    login.ts                    ← multi-selector login flow
  parsers/
    parserEngine.ts             ← selector-waterfall engine
    dateParser.ts               ← normalises messy date strings
    structures/
      beeline_v1.json           ← THE config — edit this, not TypeScript
  fallback/
    ocrParser.ts                ← Tesseract.js extraction
    llmParser.ts                ← Claude vision extraction
  scrapers/
    timesheetList.ts            ← paginated list extraction
    timesheetDetail.ts          ← detail page + fallback orchestration
  tasks/
    taskQueue.ts                ← concurrency-capped async queue
    taskRunner.ts               ← parallel orchestration + retry
  output/
    writer.ts                   ← JSON files + console summary
  utils/
    confidence.ts               ← scoring engine
    earningsNormalizer.ts       ← raw labels → REG/OT/DT/…
    logger.ts                   ← Winston (console + file)
    retry.ts                    ← exponential backoff + jitter
```

---

## Calibrating Selectors for Your Beeline Instance

1. Set `HEADLESS=false` in your `.env`
2. Run `npm run dev` — the browser window opens
3. When it reaches a timesheet detail page, pause with DevTools (`F12`)
4. Inspect the elements you want and note the CSS selectors
5. Add them to the **front** of the relevant array in `beeline_v1.json`
6. Re-run — selector hits will be logged at `debug` level

---

## Troubleshooting

**Login fails**
- Check credentials in `.env`
- Set `HEADLESS=false` to see what's happening
- Inspect login page HTML and update `loginSelectors` in `beeline_v1.json`

**No timesheets found**
- Check `navigation.timesheetListUrl` in the JSON — it may differ per Beeline instance
- Try setting `DATE_FROM` / `DATE_TO` filters
- Set `HEADLESS=false` and watch navigation

**Confidence always low**
- Open a screenshot from `output/screenshots/` to verify the page loaded
- Check `output/logs/scraper.log` for which selectors matched
- Update `detailPage` selectors in `beeline_v1.json`

**LLM fallback not running**
- Ensure `ANTHROPIC_API_KEY` is set in `.env`
- Lower `CONFIDENCE_THRESHOLD` to `0.5` temporarily to force it
