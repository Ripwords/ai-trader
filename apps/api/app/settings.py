from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_HERE = Path(__file__).resolve().parent.parent  # → apps/api/


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_HERE / ".env", extra="ignore")

    INTERNAL_BEARER: str = "dev-bearer"
    OPEND_HOST: str = "127.0.0.1"
    OPEND_PORT: int = 11111
    # postgresql://user:pass@host:port/db — points at the same DB the web
    # app uses (Drizzle owns the schema; algo persistence reads/writes via asyncpg).
    DATABASE_URL: str = ""


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
