#!/bin/bash
pm2 stop vms-scraper
pm2 delete vms-scraper
echo "Stopped"