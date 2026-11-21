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
  /** Can the Mac speak (Kokoro loaded)? If not, the phone's built-in voice is used without asking. */
  macVoice: () => boolean;
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
    hint: 'Tilt your head to talk · “what can I say?”',
  };
  let recording: ActiveRecording | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on every new exchange and on cancel, so a late answer from an old one is ignored. */
  let turn = 0;

  const busy = () => hud.state !== 'idle';
  /** One line per step, readable with `adb logcat -s Capacitor/Console`: the headset has no other debug output. */
  const log = (message: string) => console.info(`[voice] ${message}`);

  function fail(message: string) {
    log(`failed: ${message}`);
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
    } catch (e) {
      if (mine !== turn) return;
      const refused = e instanceof Error && e.message === 'HTTP 401';
      fail(refused ? 'The Mac server wants a token. Set Server token in settings (see mac-server/README).' : "Can't reach the Mac server. Is it running, and is USB or Wi-Fi connected?");
      return;
    }
    if (mine !== turn) return;
    log(`reply from ${reply.source} in ${reply.timings?.totalMs ?? '?'} ms: heard "${reply.transcript}", ${reply.actions.length} action(s)${reply.error ? `, error ${reply.error}` : ''}`);
    deps.onExchange?.(reply);
    hud.transcript = reply.transcript || null;
    // The phone words the reply itself where it knows more than the server did (counts, what opened).
    const say = applyActions(reply.actions ?? [], deps.actions) ?? reply.answer;
    hud.answer = say || null;
    hud.state = 'speaking';
    log(`saying "${say}" with ${say === reply.answer && reply.speech ? "the Mac's voice (sent with the reply)" : deps.macVoice() ? "the Mac's voice (fetched)" : "the phone's voice"}`);
    await speak(say, {
      // The server already voiced its own answer; if the phone reworded it, ask for that text instead.
      clip: say === reply.answer ? reply.speech : undefined,
      fetchClip: deps.macVoice() ? (text) => deps.server.speech(text) : undefined,
    });
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

    /** Something on the HUD when voice can't even start (e.g. the Mac server isn't reachable). */
    unavailable(message: string) {
      if (!busy()) fail(message);
    },

    /** Start listening for one question. Ignored while a question is already in progress. */
    async listen() {
      if (busy()) return log('listen ignored: busy');
      log('listening');
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
        log(`recorded ${result.ms} ms, ${Math.round((result.audio.length * 3) / 4 / 1024)} kB ${result.mime}, peak level ${result.peak.toFixed(4)}, speech ${result.heardSpeech ? 'heard' : 'not noticed'}`);
        await exchange({ audio: result.audio, mime: result.mime }, mine);
      } catch (e) {
        recording = null;
        log(`microphone error: ${e instanceof Error ? `${e.name}: ${e.message}` : e}`);
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
