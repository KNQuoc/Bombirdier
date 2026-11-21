// Shared by the popup and the background script.

const CAPTURE_PAGE = 'http://localhost:8787/capture';
/** A feed's player tab: on these, one click on the toolbar button captures (no popup first). */
const PLAYER_URL = /^https:\/\/www\.liveatc\.net\/hlisten\.php/;

/** The Bombirdier capture page's tab, or null if it isn't open. */
async function findCapturePage() {
  const found = await chrome.tabs.query({ url: `${CAPTURE_PAGE}*` });
  return found[0] ?? null;
}

/**
 * Asks the capture page something (through relay.js). null = it isn't there, or didn't answer.
 *
 * Chrome only puts relay.js into the page when the page loads, and cuts it off whenever the
 * extension is reloaded or updated. So if nobody answers, relay.js is put in again from here and
 * the question asked once more: the page never has to be reloaded for the extension's sake.
 */
async function askPage(page, message) {
  if (!page) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await chrome.tabs.sendMessage(page.id, message);
      if (reply != null) return reply;
    } catch {
      // Nobody listening in that tab.
    }
    if (attempt === 0) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: page.id }, files: ['relay.js'] });
      } catch {
        return null; // the tab is gone, still loading, or not ours to script
      }
    }
  }
  return null;
}

const sameAddress = (a, b) => !!a && !!b && a.split('#')[0].replace(/\/$/, '') === b.split('#')[0].replace(/\/$/, '');

/** The feed a tab is playing: by its player's address, else by the feed's name in the tab's title. */
function feedForTab(tab, feeds) {
  const title = (tab?.title || '').toLowerCase();
  return (
    feeds.find((f) => sameAddress(f.player, tab?.url)) ??
    feeds.find((f) => f.listenTo && title.includes(String(f.listenTo).toLowerCase())) ??
    null
  );
}

/**
 * Hands a tab's audio to the capture page as `feed`. Throws with a readable reason if it can't.
 * Chrome only allows this for a tab the extension was just invoked on (toolbar button or shortcut).
 */
async function captureTab(tab, feed, page) {
  // The tab's audio as an id that only the capture page's tab may redeem.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id, consumerTabId: page.id });
  const started = await askPage(page, { type: 'start', feedId: feed.id, streamId, tabId: tab.id });
  if (!started?.ok) throw new Error(started?.error || 'the capture page did not answer (reload it and try again)');
}

const NO_PAGE = 'The capture page is not answering. Open http://localhost:8787/capture in a tab (or reload it if it is open). If it will not load, start the server with mac-server/run.sh.';
