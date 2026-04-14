// ─────────────────────────────────────────────────────────────────────────────
// auth/login.ts — Handles Beeline authentication
// ─────────────────────────────────────────────────────────────────────────────

import type { Page } from 'playwright';
import type { VMSStructure } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

async function findAndFill(page: Page, selectors: string[], value: string, label: string): Promise<void> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) === 0) continue;
      await el.fill(value);
      logger.debug(`Filled ${label} using selector: ${sel}`);
      return;
    } catch { /* try next */ }
  }
  throw new LoginError(`Could not find ${label} field with any known selector`);
}

async function findAndClick(page: Page, selectors: string[], label: string): Promise<void> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) === 0) continue;
      await el.click();
      logger.debug(`Clicked ${label} using selector: ${sel}`);
      return;
    } catch { /* try next */ }
  }
  throw new LoginError(`Could not find ${label} button with any known selector`);
}

async function waitForSuccessIndicator(page: Page, selectors: string[]): Promise<void> {
  const checks = selectors.map((sel) =>
    page.waitForSelector(sel, { timeout: 20_000 }).then(() => sel).catch(() => null),
  );

  const result = await Promise.race(checks);
  if (!result) {
    throw new LoginError('Login appears to have failed — no success indicator found after submit');
  }
  logger.debug(`Login confirmed by indicator: ${result}`);
}

export async function login(page: Page, structure: VMSStructure): Promise<void> {
  const ls = structure.loginSelectors;

  logger.info(`Navigating to login page: ${config.beeline.url}`);
  await page.goto(config.beeline.url, { waitUntil: 'domcontentloaded' });

  // Small wait for JS to mount the form
  await page.waitForTimeout(1_500);

  logger.info('Filling credentials…');
  await findAndFill(page, ls.usernameField, config.beeline.username, 'username');
  await findAndFill(page, ls.passwordField, config.beeline.password, 'password');

  logger.info('Submitting login form…');
  await findAndClick(page, ls.submitButton, 'submit button');

  logger.info('Waiting for dashboard…');
  await waitForSuccessIndicator(page, ls.successIndicator);

  logger.info('✓ Login successful');
}
