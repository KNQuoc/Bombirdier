// The little window you get from the toolbar icon. Open it on a tab that is playing a radio feed
// and press "Capture this tab": the tab's sound is handed to the Bombirdier capture page
// (http://localhost:8787/capture), which sends it to the server on this Mac. Captured this way,
// Chrome shows no "Sharing ... to this tab" bars.
//
// Clicking the icon is what lets the extension touch that tab's audio (Chrome's rule), so each tab
// needs its own click, once. The capture page has to stay open: this opens it if it isn't.

const CAPTURE_PAGE = 'http://localhost:8787/capture';

const $tab = document.getElementById('tab');
const $here = document.getElementById('here');
const $msg = document.getElementById('msg');
const $list = document.getElementById('list');

let tab = null; // the tab the popup was opened on
let page = null; // the capture page's tab
let feeds = [];
let captures = [];

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function say(text, isError) {
  $msg.textContent = text || '';
  $msg.classList.toggle('error', !!isError);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Asks the capture page something. null = it isn't there, or didn't answer. */
async function ask(message) {
  if (!page) return null;
  try {
    return (await chrome.tabs.sendMessage(page.id, message)) ?? null;
  } catch {
    return null;
  }
}

/** The capture page's tab, opened in the background (and pinned, so it's hard to close by accident) if there is none. */
async function capturePage(openIfMissing) {
  const found = await chrome.tabs.query({ url: `${CAPTURE_PAGE}*` });
  if (found.length) return found[0];
  if (!openIfMissing) return null;
  const made = await chrome.tabs.create({ url: CAPTURE_PAGE, active: false, pinned: true });
  // Give it a moment to load and to start answering.
  for (let i = 0; i < 40; i++) {
    await wait(250);
    try {
      if (await chrome.tabs.sendMessage(made.id, { type: 'status' })) return made;
    } catch {
      // not ready yet
    }
  }
  return made;
}

async function refresh() {
  const state = await ask({ type: 'status' });
  if (state) {
    feeds = Array.isArray(state.feeds) ? state.feeds : [];
    captures = Array.isArray(state.captures) ? state.captures : [];
    if (state.problem) say(state.problem, true);
  }
  render();
}

/** The feed a tab is most likely playing: the one whose name on its own site is in the tab's title. */
function guessFeed() {
  const title = (tab?.title || '').toLowerCase();
  return feeds.find((f) => f.listenTo && title.includes(String(f.listenTo).toLowerCase())) ?? null;
}

function renderHere() {
  $here.replaceChildren();
  if (tab && page && tab.id === page.id) {
    $here.append(el('div', 'note', 'This is the capture page itself. Open this window on the tab that is playing a feed.'));
    return;
  }
  const mine = captures.find((c) => c.tabId === tab?.id);
  if (mine) {
    $here.append(el('div', '', `This tab is being captured as ${mine.feedName}.`));
    return;
  }
  if (!feeds.length) return;
  const select = el('select');
  const guess = guessFeed();
  for (const f of feeds) {
    const taken = captures.some((c) => c.feedId === f.id);
    const option = el('option', '', `${f.name}${taken ? ' (already captured)' : ''}`);
    option.value = f.id;
    if (guess && guess.id === f.id) option.selected = true;
    select.append(option);
  }
  const button = el('button', 'go', 'Capture this tab');
  button.addEventListener('click', () => capture(select.value, button));
  $here.append(select, button);
  if (!guess) $here.append(el('div', 'note', 'I could not tell from the tab’s title which feed this is: pick it above.'));
}

function renderList() {
  $list.replaceChildren();
  if (!captures.length) {
    $list.append(el('div', 'empty', 'Nothing yet.'));
    return;
  }
  for (const c of captures) {
    const row = el('div', 'row' + (c.failing ? ' bad' : ''));
    const name = el('div', 'name' + (c.tabId === tab?.id ? ' here' : ''), c.feedName);
    name.title = c.failing ? 'Not reaching the server' : c.quietS >= 20 ? `Silent for ${c.quietS} s` : 'Sound is coming through';
    const meter = el('div', 'meter');
    const bar = el('i');
    // Speech on a radio feed peaks well under full scale, so stretch it.
    bar.style.width = c.failing ? '100%' : `${Math.min(100, Math.round(Math.sqrt(c.level || 0) * 130))}%`;
    meter.append(bar);
    const stop = el('button', '', 'Stop');
    stop.addEventListener('click', async () => {
      await ask({ type: 'stop', feedId: c.feedId });
      refresh();
    });
    row.append(name, meter, stop);
    $list.append(row);
  }
}

function render() {
  renderHere();
  renderList();
}

async function capture(feedId, button) {
  const feed = feeds.find((f) => f.id === feedId);
  if (!feed || !tab || !page) return;
  button.disabled = true;
  say('Starting…');
  try {
    // Chrome hands out the tab's audio as an id that only the capture page's tab may redeem.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id, consumerTabId: page.id });
    const started = await ask({ type: 'start', feedId: feed.id, streamId, tabId: tab.id });
    if (!started?.ok) throw new Error(started?.error || 'the capture page did not answer (reload it and try again)');
    say(`Capturing ${feed.name}. You can close this window; leave this tab and the capture page open.`);
  } catch (e) {
    say(`Could not capture this tab: ${e?.message ?? e}`, true);
  }
  await refresh();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $tab.textContent = tab?.title ? `This tab: ${tab.title}` : '';
  page = await capturePage(true);
  const state = await ask({ type: 'status' });
  if (!state) {
    say('The capture page is not answering. Open http://localhost:8787/capture in a tab, or reload it if it is already open (it has to be loaded after this extension was installed), then click this button again. If it will not load, start the server with mac-server/run.sh.', true);
  }
  await refresh();
  setInterval(refresh, 500);
}

init();
