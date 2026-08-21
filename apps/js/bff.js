// Tiny BFF facade stand-in for the vitest heal scenario.
//
// Baseline is green (test calls getMenu). The demo scenario renames this
// function (a real contract change) so the test still calls the old name — a
// stale *test*, not an app bug, which the healer mechanically updates. It
// never edits this file.

export function getMenu() {
  return { items: ['dashboard', 'invoices', 'reports'] };
}
