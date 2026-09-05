from app.services.agents.graph import _format_memory_recommendation


def test_alpha_is_printed_as_percentage_points_not_scaled_again() -> None:
    """compute_realized_return stores alpha in percentage points (+2.5 means
    +2.5%). Formatting it with ``:+.2%`` multiplied by 100 a second time and
    told the trader a past call made +250%."""
    line = _format_memory_recommendation(
        {"rating": "buy", "outcome": "correct", "alpha": 2.5, "text": "lesson"}
    )
    assert "alpha +2.50%" in line
    assert "+250" not in line


def test_missing_alpha_prints_na() -> None:
    line = _format_memory_recommendation({"rating": "hold", "outcome": "?", "alpha": None})
    assert "alpha n/a" in line
