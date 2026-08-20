import bff


def test_menu_contains_dashboard():
    assert "dashboard" in bff.get_menu()["items"]
