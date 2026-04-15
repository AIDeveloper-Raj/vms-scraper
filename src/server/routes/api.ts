// ─────────────────────────────────────────────────────────────────────────────
// server/routes/api.ts — All REST API endpoints
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import * as fs   from 'fs';
import * as path from 'path';
import {
  getRuns, getAccountStats, getTodayStats, getLastRun, getRunningRun,
} from '../../db/database';
import { isLocked }            from '../../utils/runLock';
import { getActivePages, getMaxPages } from '../../utils/globalConcurrency';
import { logger }              from '../../utils/logger';
import {
  loadAccounts, saveAccounts, upsertAccount, deleteAccount,
  setAccountEnabled, type AccountConfig,
} from '../../config/accountsConfig';

export const router = Router();

// ── GET /api/status ───────────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  const dbStats   = getAccountStats();
  const accounts  = loadAccounts();
  const today     = getTodayStats();

  const enriched = accounts.map((acc) => {
    const stats = dbStats.find((s) => s.account === acc.id);
    return {
      id:          acc.id,
      label:       acc.label,
      username:    acc.username,
      vmsType:     acc.vmsType,
      enabled:     acc.enabled,
      running:     isLocked(acc.id),
      totalRuns:   stats?.total_runs    ?? 0,
      totalRecords:stats?.total_records ?? 0,
      lastRunAt:   stats?.last_run_at   ?? null,
      lastStatus:  stats?.last_status   ?? null,
      avgDuration: stats?.avg_duration  ?? null,
      currentRun:  getRunningRun(acc.id) ?? null,
      lastRun:     getLastRun(acc.id)    ?? null,
    };
  });

  res.json({
    ok: true,
    system: {
      activePages: getActivePages(),
      maxPages:    getMaxPages(),
      runningAccounts: accounts.filter((a) => isLocked(a.id)).map((a) => a.id),
    },
    today,
    accounts: enriched,
  });
});

// ── GET /api/runs ─────────────────────────────────────────────────────────────

router.get('/runs', (req: Request, res: Response) => {
  const account = req.query['account'] as string | undefined;
  const limit   = parseInt((req.query['limit'] as string) ?? '100', 10);
  res.json(getRuns(account, limit));
});

// ── POST /api/run — trigger manual run ───────────────────────────────────────

router.post('/run', (req: Request, res: Response) => {
  const { accountId } = req.body as { accountId: string };

  if (!accountId) {
    res.status(400).json({ ok: false, error: 'accountId is required' });
    return;
  }

  const account = loadAccounts().find((a) => a.id === accountId);
  if (!account) {
    res.status(404).json({ ok: false, error: `Account "${accountId}" not found` });
    return;
  }
  if (!account.enabled) {
    res.status(400).json({ ok: false, error: `Account "${accountId}" is disabled` });
    return;
  }
  if (isLocked(accountId)) {
    res.status(409).json({ ok: false, error: `${account.label} is already running` });
    return;
  }

  logger.info(`[Dashboard] Manual run triggered: ${account.label}`);

  // Fire and forget
  import('../../runner')
    .then(({ runAccount }) => runAccount(accountId))
    .catch((err: Error) => logger.error(`Manual run error: ${err.message}`));

  res.json({ ok: true, message: `Run started for ${account.label}` });
});

// ── GET /api/accounts ─────────────────────────────────────────────────────────

router.get('/accounts', (_req: Request, res: Response) => {
  const accounts = loadAccounts().map((a) => ({
    ...a,
    password: a.password ? '••••••' : '',   // never send real password to browser
  }));
  res.json(accounts);
});

// ── POST /api/accounts — upsert (add or update) ───────────────────────────────

router.post('/accounts', (req: Request, res: Response) => {
  const body = req.body as Partial<AccountConfig>;

  if (!body.id || !body.username) {
    res.status(400).json({ ok: false, error: 'id and username are required' });
    return;
  }

  // If password is the masked placeholder, keep the existing password
  const existing = loadAccounts().find((a) => a.id === body.id);
  const password = (body.password && body.password !== '••••••')
    ? body.password
    : existing?.password ?? '';

  const account: AccountConfig = {
    id:       body.id,
    label:    body.label    || body.id,
    username: body.username,
    password,
    vmsType:  body.vmsType  || 'fieldglass',
    baseUrl:  body.baseUrl  || 'https://www.us.fieldglass.cloud.sap',
    enabled:  body.enabled  !== false,
  };

  upsertAccount(account);
  logger.info(`[Dashboard] Account upserted: ${account.id}`);
  res.json({ ok: true, message: `Account "${account.label}" saved` });
});

// ── DELETE /api/accounts/:id ──────────────────────────────────────────────────

router.delete('/accounts/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  if (isLocked(id)) {
    res.status(409).json({ ok: false, error: 'Cannot delete a running account' });
    return;
  }
  deleteAccount(id);
  logger.info(`[Dashboard] Account deleted: ${id}`);
  res.json({ ok: true });
});

// ── PATCH /api/accounts/:id/toggle ───────────────────────────────────────────

router.patch('/accounts/:id/toggle', (req: Request, res: Response) => {
  const { id }      = req.params;
  const { enabled } = req.body as { enabled: boolean };
  setAccountEnabled(id, enabled);
  res.json({ ok: true });
});

// ── GET /api/logs ─────────────────────────────────────────────────────────────

router.get('/logs', (_req: Request, res: Response) => {
  const logFile = path.resolve(
    process.env['OUTPUT_DIR'] ?? './output', 'logs', 'scraper.log',
  );
  if (!fs.existsSync(logFile)) { res.json({ lines: [] }); return; }

  const lines = fs.readFileSync(logFile, 'utf-8')
    .trim().split('\n').slice(-200)
    .map((l) => { try { return JSON.parse(l); } catch { return { message: l }; } });

  res.json({ lines });
});

// ── GET /api/settings ─────────────────────────────────────────────────────────

router.get('/settings', (_req: Request, res: Response) => {
  const envPath = path.resolve(process.cwd(), '.env');
  const get     = (key: string) => {
    if (!fs.existsSync(envPath)) return '';
    const raw = fs.readFileSync(envPath, 'utf-8');
    return raw.split('\n')
      .find((l) => l.startsWith(`${key}=`))
      ?.split('=').slice(1).join('=') ?? '';
  };

  res.json({
    maxConcurrency:  get('MAX_CONCURRENCY')  || '2',
    maxGlobalPages:  get('MAX_GLOBAL_PAGES') || '6',
    maxRecords:      get('MAX_RECORDS')      || '0',
    scheduleHours:   get('SCHEDULE_HOURS')   || '2',
    dashboardPort:   get('DASHBOARD_PORT')   || '4000',
    dashboardUser:   get('DASHBOARD_USER')   || '',
  });
});

// ── POST /api/settings ────────────────────────────────────────────────────────

router.post('/settings', (req: Request, res: Response) => {
  const envPath = path.resolve(process.cwd(), '.env');
  let raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

  const set = (key: string, value: string) => {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    raw = regex.test(raw) ? raw.replace(regex, `${key}=${value}`) : raw + `\n${key}=${value}`;
  };

  const body = req.body as Record<string, string>;
  const allowed = ['MAX_CONCURRENCY','MAX_GLOBAL_PAGES','MAX_RECORDS','SCHEDULE_HOURS',
                   'DASHBOARD_PORT','DASHBOARD_USER','DASHBOARD_PASS'];
  for (const key of allowed) {
    if (body[key] !== undefined) set(key, body[key]);
  }

  fs.writeFileSync(envPath, raw.trim() + '\n', 'utf-8');
  logger.info('[Dashboard] Settings updated');
  res.json({ ok: true, message: 'Settings saved. Restart required.' });
});

// ── GET /api/records ──────────────────────────────────────────────────────────

import { getRecords, getRecordByTsId, getFlagStats } from '../../db/database';
import * as fsSync from 'fs';

router.get('/records', (req: Request, res: Response) => {
  const { account, flag, status, search, limit, offset } = req.query as Record<string, string>;
  const result = getRecords({
    account, flag, status, search,
    limit:  limit  ? parseInt(limit,  10) : 100,
    offset: offset ? parseInt(offset, 10) : 0,
  });
  res.json(result);
});

router.get('/records/flags', (req: Request, res: Response) => {
  const account = req.query['account'] as string | undefined;
  res.json(getFlagStats(account));
});

router.get('/records/:tsId', (req: Request, res: Response) => {
  const { tsId }  = req.params;
  const account   = req.query['account'] as string;
  const dbRecord  = getRecordByTsId(tsId, account);

  if (!dbRecord) { res.status(404).json({ ok: false, error: 'Record not found' }); return; }

  // Load full JSON from disk
  const outputDir = path.resolve(process.env['OUTPUT_DIR'] ?? './output');
  const jsonPath  = path.join(outputDir, 'json', `${tsId}.json`);

  let fullData = null;
  if (fsSync.existsSync(jsonPath)) {
    try { fullData = JSON.parse(fsSync.readFileSync(jsonPath, 'utf-8')); } catch { /* ignore */ }
  }

  res.json({ record: dbRecord, fullData });
});
