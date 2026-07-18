from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_HERE = Path(__file__).resolve().parent.parent  # → apps/api/


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_HERE / ".env", extra="ignore")

    INTERNAL_BEARER: str = "dev-bearer"
    OPEND_HOST: str = "127.0.0.1"
    OPEND_PORT: int = 11111
    # Path to the RSA-1024 PKCS#1 private key shared with OpenD. Required for
    # trade RPCs when api connects from a non-loopback host (e.g. the Docker
    # bridge); quote RPCs work without it. Leave unset for in-process /
    # 127.0.0.1 dev.
    OPEND_RSA_KEY_PATH: str | None = None
    # postgresql://user:pass@host:port/db — points at the same DB the web
    # app uses (Drizzle owns the schema; algo persistence reads/writes via asyncpg).
    DATABASE_URL: str = ""

    # TradingAgents LLM config. Production overrides via env; default keeps
    # `Settings()` instantiable in tests/dev without exporting a value.
    LLM_MODEL: str = "anthropic/claude-sonnet-4-6"
    LLM_MODEL_QUICK: str | None = None
    ANTHROPIC_API_KEY: str | None = None
    OPENAI_API_KEY: str | None = None
    GOOGLE_GENERATIVE_AI_API_KEY: str | None = None
    DEEPSEEK_API_KEY: str | None = None
    AGENTS_DAILY_COST_USD_CAP: float = 5.00
    WEB_INTERNAL_BASE_URL: str = "http://web:3000"

    # --- Live trading safety rails (server-side defense in depth; the web
    # layer separately requires a typed confirmation phrase for REAL trades).
    # When False, any REAL place/modify/cancel is refused with 403.
    ALLOW_LIVE_TRADING: bool = False
    # Max summed notional (qty * price, USD-equivalent) of today's REAL
    # orders, including the one being placed. Conservative: non-USD notional
    # is counted 1:1 as USD rather than converted.
    MAX_DAILY_LIVE_NOTIONAL_USD: float = 1000.0

    # --- Agents cost-cap fallback pricing. Used when the configured model has
    # no entry in the pricing table: charge these conservative rates rather
    # than 0.0 so an unknown model can never bypass the daily cap.
    AGENTS_FALLBACK_INPUT_USD_PER_1M: float = 15.00
    AGENTS_FALLBACK_OUTPUT_USD_PER_1M: float = 75.00


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
