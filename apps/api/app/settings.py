from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    INTERNAL_BEARER: str = "dev-bearer"
    OPEND_HOST: str = "127.0.0.1"
    OPEND_PORT: int = 11111


def get_settings() -> Settings:
    return Settings()
