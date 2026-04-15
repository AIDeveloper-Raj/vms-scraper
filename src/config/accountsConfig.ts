// ─────────────────────────────────────────────────────────────────────────────
// config/accountsConfig.ts
// Reads and writes accounts.json — the only place account credentials live.
// Sits outside the compiled binary alongside .env.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface AccountConfig {
  id:       string;   // unique slug — used as lock key, DB key, log prefix
  label:    string;   // friendly display name
  username: string;
  password: string;
  vmsType:  'fieldglass' | 'beeline';
  baseUrl:  string;
  enabled:  boolean;
}

// accounts.json lives next to the binary / package.json — never inside src/
const ACCOUNTS_PATH = path.resolve(process.cwd(), 'accounts.json');
const EXAMPLE_PATH  = path.resolve(process.cwd(), 'accounts.example.json');

// ── Read ──────────────────────────────────────────────────────────────────────

export function loadAccounts(): AccountConfig[] {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    // First run — copy example file and warn
    if (fs.existsSync(EXAMPLE_PATH)) {
      fs.copyFileSync(EXAMPLE_PATH, ACCOUNTS_PATH);
      logger.warn('[Accounts] accounts.json not found — copied from accounts.example.json. Please update credentials.');
    } else {
      logger.error('[Accounts] accounts.json not found. Create one based on accounts.example.json.');
      return [];
    }
  }

  try {
    const raw      = fs.readFileSync(ACCOUNTS_PATH, 'utf-8');
    const accounts = JSON.parse(raw) as AccountConfig[];
    const enabled  = accounts.filter((a) => a.enabled);
    logger.debug(`[Accounts] Loaded ${accounts.length} accounts (${enabled.length} enabled)`);
    return accounts;
  } catch (err) {
    logger.error(`[Accounts] Failed to parse accounts.json: ${(err as Error).message}`);
    return [];
  }
}

export function getAccount(id: string): AccountConfig | undefined {
  return loadAccounts().find((a) => a.id === id);
}

export function getEnabledAccounts(): AccountConfig[] {
  return loadAccounts().filter((a) => a.enabled);
}

// ── Write ─────────────────────────────────────────────────────────────────────

export function saveAccounts(accounts: AccountConfig[]): void {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2) + '\n', 'utf-8');
  logger.info('[Accounts] accounts.json saved');
}

export function upsertAccount(account: AccountConfig): void {
  const all = loadAccounts();
  const idx = all.findIndex((a) => a.id === account.id);
  if (idx >= 0) {
    all[idx] = account;
  } else {
    all.push(account);
  }
  saveAccounts(all);
}

export function deleteAccount(id: string): void {
  const all = loadAccounts().filter((a) => a.id !== id);
  saveAccounts(all);
}

export function setAccountEnabled(id: string, enabled: boolean): void {
  const all = loadAccounts();
  const acc = all.find((a) => a.id === id);
  if (acc) {
    acc.enabled = enabled;
    saveAccounts(all);
  }
}
