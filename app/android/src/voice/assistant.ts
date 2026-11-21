// The voice assistant's flow on the phone: listen -> think -> speak, and what the HUD shows meanwhile.
//
//   tilt your head (or dev key V)  ->  beep, record until you stop talking
//   audio + context                ->  Mac server (Whisper, then instant rules or Aivana)
//   { transcript, answer, actions } -> carry out the actions, say the answer

import type { VoiceHud } from '@web/hud';
import { applyActions } from './actions';
import type { ActionDeps } from './actions';
import { beep, record } from './recorder';
import type { ActiveRecording } from './recorder';
import type { AskResponse, MacServer } from './server';
import { speak, stopSpeaking } from './speak';

/** The answer stays on the HUD this long after it has been spoken. */
const ANSWER_LINGER_MS = 5000;
const ERROR_LINGER_MS = 5000;

export type AssistantDeps = {
  server: MacServer;
  /** What's around right now: sent with every question. */
  context: () => unknown;
  actions: ActionDeps;
  /** After each exchange: how long it took and who answered, for the info line. */
  onExchange?: (r: AskResponse) => void;
};

export function createAssistant(deps: AssistantDeps) {
  const hud: VoiceHud = {
    state: 'idle',
    transcript: null,
    answer: null,
    error: null,
    name: 'Bombirdier',
    hint: 'Tilt your head to one side to talk',
  };
  let recording: ActiveRecording | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on every new exchange and on cancel, so a late answer from an old one is ignored. */
  let turn = 0;

  const busy = () => hud.state !== 'idle';

  function fail(message: string) {
    hud.state = 'idle';
    hud.error = message;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => (hud.error = null), ERROR_LINGER_MS);
  }

  async function exchange(body: { audio?: string; mime?: string; text?: string }, mine: number) {
    hud.state = 'thinking';
    let reply: AskResponse;
    try {
      reply = await deps.server.ask({ ...body, context: deps.context() });
    } catch {
      if (mine === turn) fail("Can't reach the Mac server. Is it running, and is USB or Wi-Fi connected?");
      return;
    }
    if (mine !== turn) return;
    deps.onExchange?.(reply);
    hud.transcript = reply.transcript || null;
    // The phone words the reply itself where it knows more than the server did (counts, what opened).
    const say = applyActions(reply.actions ?? [], deps.actions) ?? reply.answer;
    hud.answer = say || null;
    hud.state = 'speaking';
    await speak(say);
    if (mine !== turn) return;
    hud.state = 'idle';
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      hud.answer = null;
      hud.transcript = null;
    }, ANSWER_LINGER_MS);
  }

  return {
    hud: () => hud,
    busy,

    /** Start listening for one question. Ignored while a question is already in progress. */
    async listen() {
      if (busy()) return;
      const mine = ++turn;
      clearTimeout(clearTimer);
      stopSpeaking();
      hud.error = hud.answer = hud.transcript = null;
      hud.state = 'listening';
      beep('start');
      try {
        recording = record();
        const result = await recording.done;
        recording = null;
        if (mine !== turn) return;
        beep('stop');
        if (!result) return fail("I didn't hear anything.");
        await exchange(result, mine);
      } catch {
        recording = null;
        if (mine === turn) fail('The microphone is not available. Allow it in Android Settings → Apps → Bombirdier → Permissions.');
      }
    },

    /** A typed question instead of a spoken one (desktop testing). */
    async askText(text: string) {
      if (busy()) return;
      const mine = ++turn;
      clearTimeout(clearTimer);
      hud.error = hud.answer = null;
      hud.transcript = text;
      await exchange({ text }, mine);
    },

    /** Stop listening and send what's been said so far (dev key, pressed a second time). */
    finish() {
      recording?.stop();
    },

    /** Drop whatever is in progress (leaving the view, going to the background). */
    cancel() {
      turn++;
      recording?.cancel();
      recording = null;
      stopSpeaking();
      clearTimeout(clearTimer);
      hud.state = 'idle';
      hud.error = hud.answer = hud.transcript = null;
    },
  };
}

export type Assistant = ReturnType<typeof createAssistant>;
