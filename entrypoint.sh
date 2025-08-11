#!/bin/bash
set -e

echo "Starting Gradient Bot..."

# Clean up any existing PM2 processes
pm2 flush || true
pm2 delete all || true

# Start the application
echo "Starting Node.js application..."
node /app/start.js

# Show PM2 logs
echo "Showing PM2 logs..."
pm2 logs
