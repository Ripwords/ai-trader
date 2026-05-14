import secrets
from functools import lru_cache

from fastapi import Depends, Header, HTTPException, status

from app.services.opend import OpendAdapter
from app.settings import Settings, get_settings


def require_internal_bearer(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    expected = f"Bearer {settings.INTERNAL_BEARER}"
    if not secrets.compare_digest(authorization or "", expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bearer")


@lru_cache(maxsize=1)
def _build_adapter(host: str, port: int, rsa_key_path: str | None) -> OpendAdapter:
    return OpendAdapter(host=host, port=port, rsa_key_path=rsa_key_path)


def get_opend(settings: Settings = Depends(get_settings)) -> OpendAdapter:
    return _build_adapter(settings.OPEND_HOST, settings.OPEND_PORT, settings.OPEND_RSA_KEY_PATH)
