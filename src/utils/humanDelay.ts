// ─────────────────────────────────────────────────────────────────────────────
// utils/humanDelay.ts — Randomised delays to mimic human browsing patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait a random amount of time between min and max milliseconds.
 * Used between page navigations to avoid bot detection.
 */
export function randomDelay(minMs = 1500, maxMs = 4000): Promise<void> {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shorter delay — used between small actions like form fills.
 */
export function microDelay(minMs = 80, maxMs = 220): Promise<void> {
    return randomDelay(minMs, maxMs);
}

/**
 * Type text character by character with random keystroke delays.
 * Much more human-like than page.fill() which dumps text instantly.
 */
export async function humanType(
    typeFunc: (char: string) => Promise<void>,
    text: string,
): Promise<void> {
    for (const char of text) {
        await typeFunc(char);
        await randomDelay(40, 120);
    }
}