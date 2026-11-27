# SoundBoarder

A fast, offline soundboard that installs to your home screen. Load MP3s from your device and fire them instantly by tap, click or keyboard.

Built for iPad and phone first; works on a laptop too. No App Store, no account, no server: everything stays on the device.

## Using it

1. Open the app and tap **Tap to start** (iOS needs a tap before any sound can play).
2. Tap an empty pad, or press **Edit** then tap any pad, to choose an MP3 and set its name, colour, volume, loop, fade in/out and keyboard key.
3. Tap a pad to play it. Tapping a playing pad restarts it. Pads can play at the same time.
4. **Stop all** (or `Esc`) fades everything out using each pad's fade-out; press it again to cut immediately. A playing pad also shows a small ■ to stop just that pad (or `Shift` + its key).
5. **Search online** (in a pad's editor) finds free sound effects from Freesound and Wikimedia Commons. Tap ▶ to hear one, **Use** to put it on the pad. It's downloaded once and stored like an MP3 you chose, so it fires instantly and works offline. Each one keeps its licence and credit: in Edit mode, **Sound credits** lists them and copies them for a show or stream description. "Only sounds I can use commercially" is on by default; turn it off to include non-commercial sounds (marked in yellow).
6. **Pads** chooses how many pads (1 to 12) are shown. Hidden pads keep their sounds.

Default keys are `Q W E R / A S D F / Z X C V`, matching the 4 × 3 layout.

### Install on iPad / iPhone

Open the site in Safari, tap Share, then **Add to Home Screen**. After the first visit it works fully offline.

## How it works

- Plain HTML, CSS and JavaScript; no build step, no dependencies.
- `audio.js`: Web Audio engine. Every sound is decoded into memory when the app opens, so a trigger just starts a ready buffer (no loading at trigger time). Per-voice gain handles volume and fades.
- `db.js`: IndexedDB storage for pad settings, the original audio files and the pad count.
- `search.js`: online sound search through the [Openverse](https://openverse.org) API (free, no key or account). Results are direct audio files under Creative Commons or public-domain licences. The `/sfx/*` rewrites in `netlify.toml` are a fallback for hosts that don't allow direct downloads from the browser.
- `app.js`: board, layout, editor and keyboard shortcuts.
- `sw.js`: service worker that caches the app for offline use. Bump `VERSION` when any file changes so devices pick up the update.

## Running locally

Any static file server works, for example:

```sh
python3 -m http.server 8000
```

then open <http://localhost:8000>. Installing as an app and offline mode need HTTPS (or localhost).

## Hosting

Hosted on Netlify (site `soundboarder-app`, linked to this repository):

- `main` is the live app: <https://soundboarder-app.netlify.app>
- Every pull request gets its own preview at `https://deploy-preview-<PR number>--soundboarder-app.netlify.app`, so changes can be tried on a real iPad before merging.

There is no build step; `netlify.toml` publishes the repository root as-is.
