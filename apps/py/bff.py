"""Tiny BFF facade stand-in for the pytest heal scenario.

Baseline is green (test calls ``get_menu``). The demo scenario renames this
function (a real contract change) so the test still calls the old name — a
stale *test*, not an app bug, which the healer mechanically updates. It never
edits this file.
"""


def fetch_menu() -> dict:
    """Return the navigation menu payload served to the frontend."""
    return {"items": ["dashboard", "invoices", "reports"]}
