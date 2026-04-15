// ─────────────────────────────────────────────────────────────────────────────
// server/websocket.ts — Live log broadcasting to connected dashboard clients
// ─────────────────────────────────────────────────────────────────────────────

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { logger } from '../utils/logger';

let wss: WebSocketServer | null = null;

export interface WsMessage {
  type:    'log' | 'status' | 'progress';
  account?: string;
  level?:  string;
  message: string;
  ts:      string;
}

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    logger.debug('[WS] Client connected');
    ws.send(JSON.stringify({ type: 'log', message: 'Connected to VMS Scraper', ts: new Date().toISOString() }));

    ws.on('error', () => undefined);
    ws.on('close', () => logger.debug('[WS] Client disconnected'));
  });

  logger.info('[WS] WebSocket server ready on /ws');
}

export function broadcast(msg: WsMessage): void {
  if (!wss) return;
  const payload = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

export function broadcastLog(level: string, message: string, account?: string): void {
  broadcast({ type: 'log', level, message, account, ts: new Date().toISOString() });
}

export function broadcastStatus(account: string, status: string): void {
  broadcast({ type: 'status', account, message: status, ts: new Date().toISOString() });
}
