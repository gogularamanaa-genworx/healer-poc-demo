import bff


def test_menu_contains_dashboard():
    assert "dashboard" in bff.list_menu()["items"]
