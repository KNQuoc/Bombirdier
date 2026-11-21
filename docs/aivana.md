# Aivana API: what Bombirdier needs to know

A summary of Aivana's developer docs at <https://developers.aivana.ai/docs>, read on 2026-11-20, written for building `mac-server/llm.py` (Phase 3). It is a summary, not a copy: check the source pages before relying on a detail, and re-read them if a request starts failing.

Pages read: Quickstart, API Keys, Generate, Parameters, Structured Outputs, Responses & Usage, Errors & Retries, Rate Limits, Pricing & Billing. Web Search was read and tested on 2026-11-21 (see below). Not read yet: Streaming, Conversations, Files & Documents, Intelligence Trace, SDKs, CLI, Security & Data Handling.

## The short version

- **One endpoint:** `POST https://api.aivana.ai/v1/generate`.
- **Auth:** the key goes in an `X-API-Key` header.
- **It is not OpenAI-compatible.** Different URL, header, request and response shapes. The `openai` SDK with a `base_url` will not work; the build plan's `AIVANA_BASE_URL` and `AIVANA_MODEL` settings have nothing to map to.
- **No model choice.** Aivana picks and combines models itself. The only dial is `effort`.
- **No tool / function calling.** Actions have to come back as structured JSON (see below).

## Request

Send either `prompt` (one question) or `messages`, plus optional settings.

| Field | What it does | Bombirdier use |
|---|---|---|
| `messages` | Up to 40 items, each `{ role, content }` with role `system`, `user` or `assistant`, oldest first | The conversation: context + the transcribed question |
| `system` | Your own instructions (persona, tone, format) | The co-pilot persona and the list of actions |
| `effort` | `auto` (default), `low`, `medium`, `high`: a ceiling on how much reasoning is applied | `low`, for speed |
| `max_tokens` | 1–32,000, caps the answer length | Small (answers are 1–3 sentences) |
| `temperature` | 0.0–2.0 | Leave out, or low |
| `response_format` | `{ "type": "json_schema", "schema": {...} }` for a schema-validated answer | How actions come back |
| `output_shape` | `extract` for best-effort JSON shaped by the prompt | Fallback only |
| `web_search` | `true` searches the web first; off by default for API-key requests | Leave off (slower, costs more) |
| `intelligence_trace` | Adds a report of how the request was handled | Debugging only |

Minimal call:

```sh
curl https://api.aivana.ai/v1/generate \
  -H "X-API-Key: $AIVANA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is a Piper Archer?", "effort": "low"}'
```

## Response

`200` with, among others:

- `answer`: the text (with a strict schema, the same JSON as `structured`, serialized)
- `structured`: the parsed object, when structured output was asked for
- `structured_error`: why best-effort JSON could not be parsed, else null
- `usage`: `input_tokens`, `output_tokens`, `cached_tokens`, `credits`
- `latency_ms`, `finish_reason` (`stop` or `length`), `notices`, `id`, `request_id`

## Getting actions back: JSON Schema (Strict)

With `response_format` set to a JSON Schema, Aivana returns an object that validates against it, or an error. It never returns a non-matching object with a 200. This replaces tool calling for `{ answer, actions: [...] }`.

Constraints that shape the schema:

- The root must be an object, and every schema in it must state its `type`.
- **Supported:** `type` (including nullable lists like `["string", "null"]`), `properties`, `required`, `additionalProperties` (true/false), `items`, `enum`, `const`, `minLength`/`maxLength`, `minimum`/`maximum`, `minItems`/`maxItems`, and descriptive keywords.
- **Not supported:** `$ref`/`$defs`, `oneOf`/`anyOf`/`allOf`, `not`, `if`/`then`/`else`, `pattern`, `format`, and others. An unsupported keyword is refused with a 422 before anything runs.
- Up to 32 KiB of schema, nested at most 10 levels.
- Cannot be combined with streaming, `stop_sequences`, or a non-default `output_shape`.

**Consequence for Bombirdier:** there is no "one of these action shapes". Each action has to be one flat object: a `type` enum (`show_list`, `set_filter`, `open_plane`, `radar_range`, ...) plus every possible argument as an optional or nullable field. The server then validates the combination itself (the list filter already has `sanitizeFilter`).

## Errors

All errors share one envelope: `error.type`, `error.code`, `error.message`, `error.request_id`, and `error.retry_after_ms` when waiting helps.

| Status | Meaning | Do |
|---|---|---|
| 400 / 422 | The request is wrong (422 names the fields) | Fix it; don't retry |
| 401 | Key missing, invalid or expired | Check the header and the key's status |
| 402 | Credit balance empty (`insufficient_credit`) | Add credit |
| 403 | Key not allowed to do this | Check key and endpoint |
| 413 | Request too large | Send less |
| 429 | Rate limit, quota, or your own spend limit (`spend_limit_reached`) | Wait for `Retry-After`, then retry |
| 502 | Aivana could not complete the answer (not charged), including `structured_output_failed` | Safe to retry |
| 504 | Took too long | Retry, perhaps with lower effort |

Retry only 429, 502, 504 and network failures, a few times, with backoff. For a voice assistant one quick retry is the most that makes sense: after that, say it didn't work.

## Limits and cost

- **Rate limits** are per workspace (requests, input tokens and output tokens per minute, concurrent requests) and rise with purchased credit. The tier table on the docs page loads dynamically and was not captured; `GET /v1/quotas` reports the current limits and usage.
- **Price:** input $1 per million tokens, cached input $0.30, output $4. A voice question with about 1,500 tokens of context and a 60-token answer costs roughly a fifth of a cent.
- **Prepaid:** requests are refused with 402 when the balance is empty. Promotional tokens are spent first.
- **Spend limit:** you can cap what the account, or a single key, may spend per day, week or month. Worth setting on Bombirdier's key in case of a bug that loops.
- A request that fails on Aivana's side is not charged.

## Keys

- Created in AI Studio under API Keys. The secret is shown once.
- Keys from AI Studio start with `ai_live_` and work against `api.aivana.ai`. A key starting `ai_test_` belongs to another environment and will be rejected.
- The docs are explicit that a key must stay server-side: never in browser or mobile code. For Bombirdier that means **only in `mac-server/.env`** (gitignored), never in the Android app, never in the repo.

## What this changes in the build plan

| Plan says | Reality | What we'll do |
|---|---|---|
| "If Aivana is OpenAI-compatible, use the `openai` SDK with `base_url`" | It isn't | Plain `httpx` POST (already a planned dependency). There is an official `aivana` Python SDK, unread so far, as an alternative |
| `.env`: `AIVANA_API_KEY`, `AIVANA_BASE_URL`, `AIVANA_MODEL` | No model to choose; one fixed URL | `AIVANA_API_KEY`, plus optional `AIVANA_EFFORT` (default `low`) |
| "If Aivana supports tool/function calling, use it. If not, strict JSON" | No tool calling; strict JSON Schema exists | `response_format` with a flat `{ answer, actions[] }` schema |
| Answer in under ~3 s | Unknown. Aivana may consult several models per request; the docs' own example shows about 2 s for a trivial prompt, and strict responses are not streamed | Use `effort: low` and a small `max_tokens`, **measure with a real key**, and handle the instant commands (mute, next page, close list) with keyword rules on the phone as the plan already suggests |

## Web search, tested (2026-11-21)

`"web_search": true` makes a request search the web first ([docs](https://developers.aivana.ai/docs/web-search)). It works, and the Intelligence Trace confirms it (`fresh_data: enabled`, `sources_used: 1-4`). Measured with `effort: low`:

| Asked | Took | What came back | Right? |
|---|---|---|---|
| American 2760, in the air over Ohio at the time | 8.4 s | Boston to Los Angeles, scheduled 6:45 PM to 10:30 PM, "has not yet departed" | Route right. Status wrong: it described that evening's flight, not the plane in the sky |
| Southwest 1151, in the air at the time | 9.1 s | "Not scheduled to operate today" | Wrong |
| Current weather at Toledo Express | 10.7 s | A METAR issued 00:52Z: 10 miles, clear, 7 °C | Six hours stale. The current report (06:52Z) was 5 miles in mist, 3 °C |
| Rain or snow at Bowling Green in the next 12 hours | 6.2 s | No, 0% chance | Plausible, not checked |
| The first question with search off | 5.1 s | "I cannot access live flight data" | Honest |

A searched request cost about 0.006 credits against 0.0004 without (roughly 15 times: every token of the search is charged, about 2,500 input tokens each).

**Reading one given page** (asked 2026-11-21: "can it search a specific website and bring back its JSON or HTML?"): not in these tests. Given an exact address and told to return what it holds, with `web_search: true`, it answered "I could not open the exact URL" for a JSON address and for an ordinary Wikipedia page, and returned nothing for a plain-text address. The trace showed no source used and no search made. And where a site does offer JSON, the Mac can fetch it itself in a fraction of a second for nothing, which is what `flightinfo.py` and `forecast.py` do.

**What this means for Bombirdier:** not a source for departure or arrival times of the plane you are looking at (it finds the route and a published schedule, then guesses the wrong day's flight), and worse than what is already built for weather (`flightinfo.py` gets the current METAR straight from aviationweather.gov in under a second). It is usable for look-it-up questions where a few seconds and an approximate answer are fine.

## Open questions to settle with a real key

1. Latency for a typical question with plane context at `effort: low`, with and without a strict schema.
2. Whether `system` plus `messages` both apply, or `system` should be the first message.
3. The rate-limit tier a new account starts on.
4. What the Security & Data Handling page says about retention, since plane positions and transcribed speech are sent.
