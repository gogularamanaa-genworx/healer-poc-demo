import bff


def test_menu_contains_dashboard():
    assert "dashboard" in bff.fetch_menu()["items"]
