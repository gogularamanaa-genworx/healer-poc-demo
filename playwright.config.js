const { defineConfig } = require('@playwright/test');

// Scoped to tests/playwright so Playwright's default *.test.js matcher never
// picks up the vitest specs living under tests/vitest.
module.exports = defineConfig({
  testDir: './tests/playwright',
  fullyParallel: true,
  retries: 0,
  reporter: [['json', { outputFile: 'results.json' }], ['line']],
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'npx http-server apps/web -p 4173 -s',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
  },
});
