# Pane App Store kit

The App Store listing for **Pane - Remote CLI Code Agents** (`com.dcouple.pane.mobile`), laid out for `fastlane deliver`.

| Path | What it is |
| --- | --- |
| `metadata/en-US/*.txt` | Name, subtitle, promotional text, keywords, release notes and URLs |
| `metadata/*.txt` | Categories and copyright |
| `screenshots/en-US/` | 6 iPhone 6.9" (1320x2868) and 6 iPad 13" (2064x2752) PNGs, sRGB, no alpha |
| `screenshots-src/` | The generator for those screenshots |
| `review_information.md` | App Review notes and what the reviewer needs |
| `app_privacy.md` | App Privacy answers with evidence |
| `age_rating.md` | Age rating questionnaire answers |

The description is left out on purpose. It is maintained in App Store Connect, so `deliver` keeps the live one.

## Upload

Only the release owner uploads. This kit never submits for review.

```bash
fastlane deliver --app_identifier com.dcouple.pane.mobile \
  --metadata_path native/store/metadata --screenshots_path native/store/screenshots \
  --skip_binary_upload --submit_for_review false --overwrite_screenshots
```

## Rebuild the screenshots

`screenshots-src/shots.json` holds each screenshot's headline, subhead and capture file. `template.html` draws the page in the runpane.com style: the site's colors, Sora and Geist Mono fonts, logo, world map and ASCII rain, copied from the website repo. `render.mjs` renders every shot for each device that has captures, and writes a contact sheet to `screenshots-src/contact-sheet.png`.

```bash
node native/store/screenshots-src/render.mjs            # everything
node native/store/screenshots-src/render.mjs --only 04-terminal
```

It uses the system Google Chrome through Playwright. Set `PANE_STORE_CHROMIUM` to point at another Chromium binary.

When the UI changes, retake the captures and rerun the script:

1. Start an isolated demo host (see `native/README.md`, "Point it at a host") with a neutral `PANE_DIR` such as `/tmp/pane-demo.noindex`, label it `Workstation`, and seed it with a demo repository and panes. Launch shell panes with `--tool-command "env PS1='demo % ' bash --norc"` so no real user or host name shows.
2. Run a Release simulator build on an iPhone 17 Pro Max and an iPad Pro 13-inch in dark mode, with the status bar overridden: `xcrun simctl status_bar <udid> override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3`.
3. Save each screen with `xcrun simctl io <udid> screenshot` to `screenshots-src/captures/<iphone|ipad>/<capture>.png`, using the file names in `shots.json`.
