# Bombirdier radio capture (Chrome extension)

Captures the sound of a tab playing a radio feed **without Chrome's "Sharing … to this tab" bars**, and hands it to the Bombirdier capture page, which sends it to the server as before.

Without the extension, the capture page uses Chrome's screen-sharing, and Chrome puts one bar per shared tab across the top of the page. An extension is allowed to capture a tab's audio another way, which only puts a small marker on the captured tab.

## Install (once)

1. In Chrome, open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Press **Load unpacked** and choose this folder: `mac-server/capture-extension`.
4. Pin it: the puzzle-piece button in the toolbar, then the pin next to "Bombirdier radio capture".

## Use

1. Start the server (`mac-server/run.sh`) and open <http://localhost:8787/capture> in a tab. If that page was already open before you installed the extension, reload it once.
2. Go to a tab that is playing a feed (LiveATC's "Listening to: …" player).
3. Click the extension's toolbar button. It suggests the feed from the tab's title; press **Capture this tab**.
4. Repeat on each player tab. Each tab needs its own click, once: clicking the button is what lets an extension touch that tab's audio.

The popup lists what is being captured, with a level meter and a Stop for each. The capture page shows the same, plus the calls as they are written down. Leave the capture page and the player tabs open.

A tab captured this way is silent on the Mac's speakers. To keep hearing feeds, tick the box at the top of the capture page before capturing.

## How it works

`popup.js` asks Chrome for the tab's audio as an id that only the capture page's tab may redeem (`chrome.tabCapture.getMediaStreamId` with `consumerTabId`) and passes it to the page through `relay.js`, a small script the extension runs inside `http://localhost:8787/capture`. The page turns the id into the audio and does everything else. The extension makes no network requests of its own and can only see pages on `localhost:8787`.

If the server runs on another port, change `8787` in `manifest.json`, `popup.js` and reload the extension.

## Status

Checked: the extension loads in Chrome 149 and Chrome hands it a tab's audio id; the capture page's side (taking audio from the extension, level, stop) with a stand-in audio stream. **Not yet checked: the two together in a real Chrome**, because the test browser on this Mac would not load local pages.
