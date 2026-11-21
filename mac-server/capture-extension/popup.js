// The little window from the toolbar button. It opens every feed's player tab with one button,
// shows what is being captured (level meter, Stop), and takes you to the tabs that still need
// capturing. On a player tab itself the button doesn't open this at all: one click captures.
//
// The audio goes to the Bombirdier capture page (http://localhost:8787/capture), which has to be
// open, and from there to the server on this Mac. Captured this way, Chrome shows no sharing bars.

const $tab = document.getElementById('tab');
const $here = document.getElementById('here');
const $msg = document.getElementById('msg');
const $list = document.getElementById('list');
const $openAll = document.getElementById('open-all');
const $hint = document.getElementById('hint');

let tab = null; // the tab the popup was opened on
let page = null; // the capture page's tab
let feeds = [];
let captures = [];
let playerTabs = []; // open tabs of the feeds' site
let shortcut = '';

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
const tabOf = (feed) => playerTabs.find((t) => feedForTab(t, [feed])) ?? null;
const captureOf = (feed) => captures.find((c) => c.feedId === feed.id) ?? null;

async function refresh() {
  const state = await askPage(page, { type: 'status' });
  if (state) {
    feeds = Array.isArray(state.feeds) ? state.feeds : [];
    captures = Array.isArray(state.captures) ? state.captures : [];
  }
  playerTabs = await chrome.tabs.query({ url: 'https://www.liveatc.net/*' });
  render();
}

function renderHere() {
  $here.replaceChildren();
  if (tab && page && tab.id === page.id) return;
  const mine = captures.find((c) => c.tabId === tab?.id);
  if (mine) {
    $here.append(el('div', '', `This tab is being captured as ${mine.feedName}.`));
    return;
  }
  // A tab that plays something but isn't one of the known player pages: pick the feed by hand.
  if (!feeds.length || !tab || tab.audible !== true) return;
  const select = el('select');
  const guess = feedForTab(tab, feeds);
  for (const f of feeds) {
    const option = el('option', '', `${f.name}${captureOf(f) ? ' (already captured)' : ''}`);
    option.value = f.id;
    if (guess && guess.id === f.id) option.selected = true;
    select.append(option);
  }
  const button = el('button', 'go', 'Capture this tab');
  button.addEventListener('click', async () => {
    button.disabled = true;
    const feed = feeds.find((f) => f.id === select.value);
    try {
      await captureTab(tab, feed, page);
      say(`Capturing ${feed.name}.`);
    } catch (e) {
      say(`Could not capture this tab: ${e?.message ?? e}`, true);
    }
    refresh();
  });
  $here.append(select, button);
}

function renderList() {
  $list.replaceChildren();
  if (!feeds.length) {
    $list.append(el('div', 'empty', 'No feeds yet.'));
    return;
  }
  for (const feed of feeds) {
    const c = captureOf(feed);
    const open = tabOf(feed);
    const row = el('div', 'row' + (c?.failing ? ' bad' : ''));
    const name = el('div', 'name' + (c && c.tabId === tab?.id ? ' here' : ''), feed.name);
    row.append(name);
    if (c) {
      name.title = c.failing ? 'Not reaching the server' : c.quietS >= 20 ? `Silent for ${c.quietS} s` : 'Sound is coming through';
      const meter = el('div', 'meter');
      const bar = el('i');
      // Speech on a radio feed peaks well under full scale, so stretch it.
      bar.style.width = c.failing ? '100%' : `${Math.min(100, Math.round(Math.sqrt(c.level || 0) * 130))}%`;
      meter.append(bar);
      const stop = el('button', '', 'Stop');
      stop.addEventListener('click', async () => {
        await askPage(page, { type: 'stop', feedId: feed.id });
        if (c.tabId != null) chrome.action.setBadgeText({ tabId: c.tabId, text: '' }).catch(() => {});
        refresh();
      });
      row.append(meter, stop);
    } else if (open) {
      row.append(el('div', 'state', 'open, not captured'));
      const go = el('button', '', 'Go to tab');
      go.title = 'Switches to its tab. Click this toolbar button there once to capture it.';
      go.addEventListener('click', () => chrome.tabs.update(open.id, { active: true }));
      row.append(go);
    } else if (feed.player) {
      row.append(el('div', 'state', 'not open'));
      const openIt = el('button', '', 'Open');
      openIt.addEventListener('click', async () => {
        await chrome.tabs.create({ url: feed.player, active: false });
        await wait(600);
        refresh();
      });
      row.append(openIt);
    } else {
      row.append(el('div', 'state', 'no player page set'));
    }
    $list.append(row);
  }
}

function render() {
  renderHere();
  renderList();
  const closed = feeds.filter((f) => f.player && !captureOf(f) && !tabOf(f));
  const waiting = feeds.filter((f) => !captureOf(f) && tabOf(f));
  $openAll.hidden = !closed.length;
  $openAll.textContent = closed.length === feeds.length ? 'Open all feeds' : `Open the other ${closed.length}`;
  const key = shortcut ? ` or press ${shortcut}` : '';
  $hint.textContent = waiting.length
    ? `${waiting.length} open tab${waiting.length === 1 ? '' : 's'} not captured yet. Go to each and click this toolbar button once${key}: on a player tab that captures it straight away. Chrome only lets an extension capture a tab you have clicked it on, so it can't be done for all of them at once.`
    : '';
}

async function openAll() {
  $openAll.disabled = true;
  const closed = feeds.filter((f) => f.player && !captureOf(f) && !tabOf(f));
  for (const feed of closed) await chrome.tabs.create({ url: feed.player, active: false });
  await wait(800);
  $openAll.disabled = false;
  say(`Opened ${closed.length} tab${closed.length === 1 ? '' : 's'}. Check each player says "playing".`);
  refresh();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $tab.textContent = tab?.title ? `This tab: ${tab.title}` : '';
  $openAll.addEventListener('click', openAll);
  try {
    const commands = await chrome.commands.getAll();
    shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut || '';
  } catch {
    shortcut = '';
  }
  // Something the background script wanted said (a capture that failed without a popup to say it in).
  const { problem } = await chrome.storage.session.get('problem');
  if (problem && Date.now() - problem.at < 60_000) say(problem.text, true);
  await chrome.storage.session.remove('problem');

  page = await findCapturePage();
  if (!page) {
    // Open it in the background, pinned so it's hard to close by accident, and wait for it to answer.
    page = await chrome.tabs.create({ url: CAPTURE_PAGE, active: false, pinned: true });
    for (let i = 0; i < 40 && !(await askPage(page, { type: 'status' })); i++) await wait(250);
  }
  if (!(await askPage(page, { type: 'status' }))) say(NO_PAGE, true);
  await refresh();
  setInterval(refresh, 700);
}

init();
