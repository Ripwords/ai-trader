from pydantic import BaseModel


class WatchlistItem(BaseModel):
    code: str
    name: str | None = None
    group: str = "All"


class WatchlistGroups(BaseModel):
    items: list[WatchlistItem]
