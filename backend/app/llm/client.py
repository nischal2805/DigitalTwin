"""OpenAI-compatible JSON chat over httpx. Provider chain: primary -> other -> (caller falls back to templates)."""
from __future__ import annotations

import json
import time

import httpx
from pydantic import BaseModel, ValidationError

from app import config

PROVIDERS = {
    "groq": {"base": "https://api.groq.com/openai/v1", "model": "llama-3.3-70b-versatile", "key": lambda: config.GROQ_API_KEY},
    "xai": {"base": "https://api.x.ai/v1", "model": "grok-3-mini", "key": lambda: config.XAI_API_KEY},
}


class LLMUnavailable(RuntimeError):
    pass


def chain() -> list[str]:
    if config.LLM_PROVIDER not in PROVIDERS:
        return []
    order = [config.LLM_PROVIDER] + [p for p in PROVIDERS if p != config.LLM_PROVIDER]
    return [p for p in order if PROVIDERS[p]["key"]()]


def status() -> dict:
    c = chain()
    return {"provider": config.LLM_PROVIDER, "chain": c, "available": bool(c),
            "model": _model(c[0]) if c else None}


def _model(p: str) -> str:
    return (config.LLM_MODEL if p == config.LLM_PROVIDER and config.LLM_MODEL else PROVIDERS[p]["model"])


def _base(p: str) -> str:
    return (config.LLM_BASE_URL if p == config.LLM_PROVIDER and config.LLM_BASE_URL else PROVIDERS[p]["base"]).rstrip("/")


async def chat_json(system: str, user: str, schema: type[BaseModel], timeout: float | None = None,
                    max_tokens: int = 900) -> tuple[BaseModel, str, float]:
    """Returns (validated object, 'provider/model', latency_s). One retry per provider on invalid JSON."""
    errors = []
    for p in chain():
        msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        for attempt in range(2):
            t0 = time.perf_counter()
            try:
                async with httpx.AsyncClient(timeout=timeout or config.LLM_TIMEOUT_S) as cli:
                    r = await cli.post(f"{_base(p)}/chat/completions",
                                       headers={"Authorization": f"Bearer {PROVIDERS[p]['key']()}"},
                                       json={"model": _model(p), "messages": msgs, "temperature": 0.2,
                                             "max_tokens": max_tokens, "response_format": {"type": "json_object"}})
                r.raise_for_status()
                text = r.json()["choices"][0]["message"]["content"]
                obj = schema.model_validate(json.loads(text))
                return obj, f"{p}/{_model(p)}", time.perf_counter() - t0
            except (ValidationError, json.JSONDecodeError, KeyError) as e:
                errors.append(f"{p}: invalid JSON ({str(e)[:120]})")
                msgs = msgs + [{"role": "user", "content": "Your last reply was not valid JSON for the schema. Reply with JSON only."}]
            except Exception as e:  # noqa: BLE001 — network/HTTP errors: move to next provider
                errors.append(f"{p}: {type(e).__name__} {str(e)[:120]}")
                break
    raise LLMUnavailable("; ".join(errors) or "no LLM provider configured")
