# Bombirdier radio capture (Chrome extension)

Captures the sound of a tab playing a radio feed **without Chrome's "Sharing … to this tab" bars**, and hands it to the Bombirdier capture page, which sends it to the server as before.

Without the extension, the capture page uses Chrome's screen-sharing, and Chrome puts one bar per shared tab across the top of the page. An extension is allowed to capture a tab's audio another way, which only puts a small marker on the captured tab.

## Install (once)

1. In Chrome, open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Press **Load unpacked** and choose this folder: `mac-server/capture-extension`.
4. Pin it: the puzzle-piece button in the toolbar, then the pin next to "Bombirdier radio capture".

## Use

1. Start the server (`mac-server/run.sh`) and open <http://localhost:8787/capture> in a tab. If that page was open before you installed or updated the extension, reload it once.
2. Click the extension's toolbar button (on any tab that isn't a player) and press **Open all feeds**. It opens each feed's player tab in the background. Check each player says "playing"; if Chrome held one back, press Play on it.
3. Go to each player tab and **click the toolbar button once**, or press **Option+Shift+C**. On a player tab that captures it straight away, with no popup: the button gets a green "ON".

That last step is one click per tab, and it can't be fewer: Chrome lets an extension take a tab's audio only on a tab you have just invoked the extension on. No permission covers "all my tabs".

The popup (from any other tab, or from a tab that is already captured) lists every feed: captured ones with a level meter and Stop, open ones with **Go to tab**, the rest with **Open**. The capture page shows the same, plus the calls as they are written down. Leave the capture page and the player tabs open.

A tab captured this way is silent on the Mac's speakers. To keep hearing feeds, tick the box at the top of the capture page before capturing.

After changing the extension's files, press the reload arrow on its card in `chrome://extensions`.

## How it works

- `background.js` handles the click on a player tab: it works out which feed the tab is (by the player's address in `feeds.json`, else by the feed's name in the tab's title) and captures it.
- `lib.js` (shared with the popup) asks Chrome for the tab's audio as an id that only the capture page's tab may redeem (`chrome.tabCapture.getMediaStreamId` with `consumerTabId`) and passes it to the page through `relay.js`, a small script the extension runs inside `http://localhost:8787/capture`. The page turns the id into the audio and does everything else.
- The extension makes no network requests of its own. It can see pages on `localhost:8787`, and the address and title of tabs on `www.liveatc.net` (to recognize the players); it runs nothing in LiveATC's pages.
- Each feed's player page is a bookmark in `feeds.json` (`"player"`): the page LiveATC's own LISTEN link leads to.

If the server runs on another port, change `8787` in `manifest.json` and `lib.js` and reload the extension.

## Status

Checked: the extension loads in Chrome 149, its background script runs, it recognizes player tabs, the popup renders its list, and Chrome hands it a tab's audio id; the capture page's side (taking audio from the extension, level, stop) with a stand-in audio stream. **Not yet checked: the whole thing together in a real Chrome**, including whether players opened in the background start playing by themselves.
