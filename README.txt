VMS Scraper — Setup Guide

1. Run setup:     chmod +x setup.sh && ./setup.sh
2. Edit files:    accounts.json  (add credentials)
                  .env           (set DASHBOARD_USER + DASHBOARD_PASS)
3. Build:         npm run build
4. Start:         chmod +x start.sh && ./start.sh
5. Open:          http://localhost:4000

To stop:  ./stop.sh
Logs:     pm2 logs vms-scraper