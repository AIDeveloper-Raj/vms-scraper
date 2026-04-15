#!/bin/bash
pm2 start dist/index.js --name "vms-scraper" -- --server
pm2 startup
pm2 save
echo "Running at http://localhost:4000"