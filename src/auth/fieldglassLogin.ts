// ─────────────────────────────────────────────────────────────────────────────
// auth/fieldglassLogin.ts — SAP Fieldglass login
// Selectors confirmed from real HTML analysis of FG_Source_Login_1.html
// ─────────────────────────────────────────────────────────────────────────────

import type { Page } from 'playwright';
import { config } from '../config';
import { logger } from '../utils/logger';
import { humanType, microDelay } from '../utils/humanDelay';

export async function loginFieldglass(page: Page): Promise<void> {
  const { baseUrl, username, password } = config.fieldglass;
  const loginUrl = `${baseUrl}/login.do`;

  logger.info(`[FG Login] Navigating to ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  // ── Dismiss TrustArc cookie banner via JS (overlay blocks pointer clicks) ──
  try {
    await page.waitForSelector('#truste-consent-button', { timeout: 8_000 });
    await page.evaluate(() => {
      const btn = document.getElementById('truste-consent-button');
      if (btn) btn.click();
    });
    logger.debug('[FG Login] Cookie consent dismissed via JS click');
    await page.waitForSelector('#trustarc-banner-overlay',
      { state: 'hidden', timeout: 5_000 }
    ).catch(() => undefined);
  } catch {
    logger.debug('[FG Login] No cookie banner found — continuing');
  }

  await page.waitForTimeout(500);

  // ── Fill credentials ────────────────────────────────────────────────────
  await page.click('input#usernameId_new');
  await humanType((char) => page.keyboard.type(char), username);
  logger.debug('[FG Login] Username filled');

  await microDelay();
  await page.click('input#passwordId_new');
  await humanType((char) => page.keyboard.type(char), password);
  logger.debug('[FG Login] Password filled');

  await page.click('button.formLoginButton_new');
  logger.info('[FG Login] Submitted — waiting for dashboard…');

  // ── Wait for any post-login indicator ──────────────────────────────────
  // FG can land on several different URLs after login — cast a wide net
  await Promise.race([
    page.waitForURL('**/home.do**', { timeout: 30_000 }),
    page.waitForURL('**/buyer/home**', { timeout: 30_000 }),
    page.waitForURL('**/time_sheet_list**', { timeout: 30_000 }),
    page.waitForURL('**/fg/**', { timeout: 30_000 }),
    page.waitForSelector('#topNavBarNew', { timeout: 30_000 }),
    page.waitForSelector('.fgNavBar', { timeout: 30_000 }),
    page.waitForSelector('a[href*="time_sheet_list"]', { timeout: 30_000 }),
    page.waitForSelector('#primaryNav', { timeout: 30_000 }),
    page.waitForSelector('.topnav', { timeout: 30_000 }),
    // Fallback: any URL change away from login page
    page.waitForFunction(
      () => !window.location.href.includes('/login.do'),
      { timeout: 30_000 }
    ),
  ]).catch(() => {
    throw new Error('FG login failed — still on login page after 30s');
  });

  const currentUrl = page.url();
  logger.info(`[FG Login] ✓ Login successful — landed on: ${currentUrl}`);
}