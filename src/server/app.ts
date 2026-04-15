import 'dotenv/config';
import express          from 'express';
import { createServer } from 'http';
import * as path        from 'path';
import { router }       from './routes/api';
import { initWebSocket } from './websocket';
import { logger }       from '../utils/logger';

const PORT = parseInt(process.env['DASHBOARD_PORT'] ?? '4000', 10);

export function startServer(): void {
  const app    = express();
  const server = createServer(app);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Basic auth
  const DASH_USER = process.env['DASHBOARD_USER'] ?? '';
  const DASH_PASS = process.env['DASHBOARD_PASS'] ?? '';
  if (DASH_USER && DASH_PASS) {
    app.use((req, res, next) => {
      if (req.path === '/health') return next();
      const auth = req.headers['authorization'];
      if (!auth) { res.setHeader('WWW-Authenticate','Basic realm="VMS Scraper"'); res.status(401).send('Auth required'); return; }
      const [,enc] = auth.split(' ');
      const [u,p]  = Buffer.from(enc??'','base64').toString().split(':');
      if (u === DASH_USER && p === DASH_PASS) return next();
      res.setHeader('WWW-Authenticate','Basic realm="VMS Scraper"'); res.status(401).send('Invalid credentials');
    });
  }

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', router);

  // Serve screenshots statically so browser can load them in popup
  const outputDir = path.resolve(process.env['OUTPUT_DIR'] ?? './output');
  app.use('/screenshots', express.static(path.join(outputDir, 'screenshots')));

  // Dashboard
  const dashPath = path.resolve(__dirname, '..', 'dashboard', 'index.html');
  app.get('*', (_req, res) => res.sendFile(dashPath));

  initWebSocket(server);

  server.listen(PORT, () => {
    logger.info(`╔══════════════════════════════════════╗`);
    logger.info(`║  Dashboard: http://localhost:${PORT}     ║`);
    logger.info(`╚══════════════════════════════════════╝`);
  });
}
