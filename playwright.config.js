const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  reporter: [['json', { outputFile: 'results.json' }], ['line']],
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'npx http-server . -p 4173 -s',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
  },
});
