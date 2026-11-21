"""The one place that talks to Aivana (docs/aivana.md). Swap this file to change the LLM.

Aivana is one endpoint, POST /v1/generate, with the key in X-API-Key. It has no tool calling, so
when the caller wants actions it passes a JSON Schema and Aivana returns an object that validates
against it (response_format json_schema), or an error.
"""
import asyncio

import httpx

import config

# One slow answer is worse than none in a headset: don't wait forever.
TIMEOUT_S = 20.0
RETRY_STATUSES = {429, 502, 504}


class LLMError(Exception):
    """Aivana could not answer. `code` is Aivana's error code when it sent one."""

    def __init__(self, message: str, code: str = "", status: int = 0):
        super().__init__(message)
        self.code = code
        self.status = status


def available() -> bool:
    return bool(config.AIVANA_API_KEY)


async def complete(messages: list[dict], system: str = "", schema: dict | None = None, max_tokens: int = 220) -> dict:
    """Returns {"answer": str, "structured": dict | None, "latency_ms": int, "credits": float}.

    `messages` is [{role, content}], oldest first. With `schema`, `structured` is the validated object.
    Retries once on the errors Aivana says are safe to retry.
    """
    if not available():
        raise LLMError("No Aivana API key in mac-server/.env", code="no_key")
    body: dict = {"messages": messages[-40:], "effort": config.AIVANA_EFFORT, "max_tokens": max_tokens}
    if system:
        body["system"] = system
    if schema:
        body["response_format"] = {"type": "json_schema", "schema": schema}
    headers = {"X-API-Key": config.AIVANA_API_KEY, "User-Agent": config.USER_AGENT}

    last: LLMError | None = None
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        for attempt in range(2):
            try:
                r = await client.post(config.AIVANA_URL, json=body, headers=headers)
            except httpx.TimeoutException:
                last = LLMError(f"Aivana did not answer within {TIMEOUT_S:.0f} s", code="timeout")
                break  # a second wait that long is no use to someone who asked out loud
            except httpx.HTTPError as e:
                last = LLMError(f"Could not reach Aivana: {e.__class__.__name__}", code="network")
            else:
                if r.status_code == 200:
                    data = r.json()
                    usage = data.get("usage") or {}
                    return {
                        "answer": data.get("answer") or "",
                        "structured": data.get("structured"),
                        "latency_ms": data.get("latency_ms") or 0,
                        "credits": usage.get("credits") or 0,
                    }
                try:
                    err = r.json().get("error") or {}
                except ValueError:
                    err = {}
                last = LLMError(err.get("message") or f"Aivana answered {r.status_code}", err.get("code", ""), r.status_code)
                if r.status_code not in RETRY_STATUSES:
                    break
                # A rate limit that wants a long wait isn't worth holding a spoken question for.
                wait_ms = err.get("retry_after_ms") or 600
                if wait_ms > 2500:
                    break
                await asyncio.sleep(wait_ms / 1000)
                continue
            if attempt == 0:
                await asyncio.sleep(0.4)
    raise last or LLMError("Aivana did not answer")
