import { test, expect } from 'vitest';
import * as bff from '../../apps/js/bff.js';

test('menu contains dashboard', () => {
  expect(bff.getMenu().items).toContain('dashboard');
});
