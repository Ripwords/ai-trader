"""Who a run decides for.

The web app sends the owner's position and totals as data. This module turns
them into the text the debate reads. How the deciding agents must rule for
this owner is a prompt, ``owner_mandate``, that the owner edits in Settings;
nothing about their intent is fixed here beyond that prompt's default.
"""

from __future__ import annotations

from app.schemas.agents import OwnerContext, OwnerPosition

from . import prompts as prompts_mod

OWNER_MANDATE_PROMPT = "owner_mandate"

# Appended as plain text, never run through ``str.format``.
OWNER_MANDATE_DEFAULT = """## Owner Mandate
The Owner Context above describes the one investor this decision is for. Rule for them, not for a short-term trading desk. Where these rules conflict with your other instructions, these rules win.

- The owner accumulates for the long term, over years, and adds new money every month. Judge the business, the price against fair value, and the size of the position. Do not judge the next few weeks of price action.
- Their concentration in US technology is a deliberate choice. State the position weight as a fact when you size. Do not recommend selling only to diversify.
- They do not trade with stop-losses, tranche ladders, price-trigger exits or options. Do not propose any of them.
- Answer one question: what should this owner do with this stock now? The answer is ADD (put new money in now), HOLD (keep the position, add nothing now), TRIM (reduce the position), or DO NOT ADD AT THIS SIZE (the position is already as large as it should be, or the stock is not worth opening a position in at this price). HOLD and TRIM apply only when the owner holds the stock.
- HOLD and DO NOT ADD AT THIS SIZE are complete answers. Any instruction to avoid Hold does not apply to this owner.
- Short-term timing alone must not decide between ADD and HOLD. The owner buys every month, so the choice turns on valuation and position size, which change slowly.
- Give the reasons in the owner's terms: price against fair value, the position weight before and after adding, and what would change your mind.
- State the verdict on its own line, exactly once, as `OWNER VERDICT: ADD`, `OWNER VERDICT: HOLD`, `OWNER VERDICT: TRIM` or `OWNER VERDICT: DO NOT ADD AT THIS SIZE`. Keep those words in English.
- If your instructions also require a FINAL TRANSACTION PROPOSAL line, keep it and make it agree: BUY for ADD, HOLD for HOLD and for DO NOT ADD AT THIS SIZE, SELL for TRIM."""


def owner_mandate() -> str:
    """This run's mandate text: the saved override, or the default."""
    override = prompts_mod.get_override(OWNER_MANDATE_PROMPT)
    return OWNER_MANDATE_DEFAULT if override is None else override


def _amount(value: float) -> str:
    return f"{value:,.0f}"


def _quantity(value: float) -> str:
    return f"{value:,.4f}".rstrip("0").rstrip(".")


def _position_line(position: OwnerPosition, symbol: str) -> str:
    if position.status == "unknown":
        return (
            f"- The owner's position in {symbol} could not be read for this run. "
            "Do not assume they hold it, and do not assume they do not."
        )
    if position.status == "not_held":
        return f"- The owner does not hold {symbol}."
    parts = ["- The owner holds"]
    if position.quantity is not None:
        parts.append(f"{_quantity(position.quantity)} shares of {symbol}")
    else:
        parts.append(symbol)
    if position.market_value is not None:
        parts.append(f"worth {_amount(position.market_value)} {position.currency or ''}".rstrip())
    line = " ".join(parts)
    if position.weight_pct is not None:
        line += f", {position.weight_pct:.1f}% of investable assets"
    line += "."
    if position.unrealized_pnl_pct is not None:
        line += f" Unrealised gain or loss: {position.unrealized_pnl_pct:+.1f}%."
    return line


def format_owner_context(owner: OwnerContext, symbol: str) -> str:
    """The owner section every debate prompt carries."""
    currency = owner.base_currency or ""
    lines = [
        "## Owner Context",
        "Facts about the investor this run is for, read from their accounts when the run started.",
        _position_line(owner.position, symbol),
    ]
    if owner.investable_total is not None:
        lines.append(f"- Investable assets: {_amount(owner.investable_total)} {currency}".rstrip() + ".")
    if owner.base_currency:
        lines.append(f"- Base currency: {owner.base_currency}.")
    if owner.monthly_contribution:
        lines.append(
            f"- They add about {_amount(owner.monthly_contribution)} {currency}".rstrip()
            + " of new money every month."
        )
    if owner.notes:
        lines.append("- What the owner has asked to be remembered about them:")
        lines.extend(f"  - {note}" for note in owner.notes)
    return "\n".join(lines)
