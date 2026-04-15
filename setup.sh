#!/bin/bash
echo "=== VMS Scraper Setup ==="
npm install -g pm2
npx playwright install chromium
[ ! -f accounts.json ] && cp accounts.example.json accounts.json && echo "Created accounts.json — add credentials"
[ ! -f .env ] && cp .env.example .env && echo "Created .env — review settings"
echo "=== Done — edit accounts.json and .env then run ./start.sh ==="
