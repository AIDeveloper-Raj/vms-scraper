// ─────────────────────────────────────────────────────────────────────────────
// utils/globalConcurrency.ts
// System-wide page limiter — prevents memory exhaustion when multiple
// accounts run simultaneously. All accounts share this single pool.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_GLOBAL_PAGES = parseInt(process.env['MAX_GLOBAL_PAGES'] ?? '6', 10);
let activePages = 0;
const waiters: Array<() => void> = [];

export async function acquirePage(): Promise<void> {
  if (activePages < MAX_GLOBAL_PAGES) {
    activePages++;
    return;
  }
  // Queue the caller until a slot opens
  await new Promise<void>((resolve) => waiters.push(resolve));
  activePages++;
}

export function releasePage(): void {
  activePages = Math.max(0, activePages - 1);
  const next = waiters.shift();
  if (next) next();
}

export function getActivePages(): number {
  return activePages;
}

export function getMaxPages(): number {
  return MAX_GLOBAL_PAGES;
}
