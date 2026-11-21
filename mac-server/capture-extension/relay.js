// Runs inside the Bombirdier capture page (http://localhost:8787/capture) and passes messages
// between the extension's popup and that page. The page does all the work with the audio and is
// the only thing that talks to the server; the extension never makes a network request itself.
// (Chrome puts a permission prompt in front of an extension's requests to a local server, and a
// page of the server's own doesn't need one.)

let nextId = 1;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const id = `${Date.now()}-${nextId++}`;
  let done = false;
  const finish = (reply) => {
    if (done) return;
    done = true;
    window.removeEventListener('message', onReply);
    sendResponse(reply);
  };
  const onReply = (e) => {
    if (e.source !== window || e.data?.source !== 'bombirdier-page' || e.data.id !== id) return;
    finish(e.data.reply ?? null);
  };
  window.addEventListener('message', onReply);
  window.postMessage({ source: 'bombirdier-extension', id, msg }, location.origin);
  // A page that doesn't answer (an old copy still open, or still loading) shouldn't leave the popup hanging.
  setTimeout(() => finish(null), 8000);
  return true; // the answer comes later
});
