// On a feed's player tab, one click on the toolbar button (or the keyboard shortcut) captures it
// straight away, with no popup in between. Everywhere else, and on a tab that is already captured,
// the button opens the popup.
//
// Why a click per tab at all: Chrome lets an extension take a tab's audio only on a tab the user
// has just invoked it on. There is no permission that covers "all my tabs", so "capture everything
// with one click" is not something an extension can do.

importScripts('lib.js');

/** Player tabs get no popup, so that a click reaches onClicked below. (Chrome forgets this when the tab navigates.) */
async function arm(tab) {
  if (!tab?.id || !PLAYER_URL.test(tab.url || '')) return;
  try {
    await chrome.action.setPopup({ tabId: tab.id, popup: '' });
  } catch {
    // The tab went away.
  }
}

async function armAll() {
  for (const tab of await chrome.tabs.query({ url: 'https://www.liveatc.net/*' })) await arm(tab);
}

chrome.runtime.onInstalled.addListener(armAll);
chrome.runtime.onStartup.addListener(armAll);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.status || change.url) arm(tab);
});

async function mark(tabId, text, color, title) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title });
  } catch {
    // The tab went away.
  }
}

/** Shows the popup on this tab from now on, and right now if Chrome allows. */
async function showPopup(tab, problem) {
  if (problem) await chrome.storage.session.set({ problem: { text: problem, tabId: tab.id, at: Date.now() } });
  try {
    await chrome.action.setPopup({ tabId: tab.id, popup: 'popup.html' });
    await chrome.action.openPopup();
  } catch {
    // Couldn't open it by itself: the next click will.
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const page = await findCapturePage();
  const state = await askPage(page, { type: 'status' });
  if (!state) {
    await mark(tab.id, '!', '#c62828', 'Bombirdier: the capture page is not open or not answering');
    return showPopup(tab, NO_PAGE);
  }
  if ((state.captures || []).some((c) => c.tabId === tab.id)) return showPopup(tab);
  const feed = feedForTab(tab, state.feeds || []);
  if (!feed) return showPopup(tab); // can't tell which feed this is: the popup lets you pick
  try {
    await captureTab(tab, feed, page);
    await mark(tab.id, 'ON', '#1a7f37', `Bombirdier: capturing ${feed.name}`);
    // Further clicks on this tab show what is being captured, with Stop.
    await chrome.action.setPopup({ tabId: tab.id, popup: 'popup.html' });
  } catch (e) {
    await mark(tab.id, '!', '#c62828', `Bombirdier: could not capture ${feed.name}`);
    await showPopup(tab, `Could not capture ${feed.name}: ${e?.message ?? e}`);
  }
});
