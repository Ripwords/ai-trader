from fastapi import Depends, Header, HTTPException, status

from app.settings import Settings, get_settings


def require_internal_bearer(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    expected = f"Bearer {settings.INTERNAL_BEARER}"
    if authorization != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bearer")
