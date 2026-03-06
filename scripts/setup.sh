#!/bin/bash
# AlonBot — Quick Setup Script
# Usage: ./scripts/setup.sh

set -e

echo "=== AlonBot Setup ==="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Error: Node.js not found. Install it from https://nodejs.org/ (v20+)"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "Error: Node.js v20+ required (found v$(node -v))"
  exit 1
fi

echo "Node.js: $(node -v)"
echo "npm: $(npm -v)"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Create .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "Created .env from .env.example"
  echo ""
  echo "IMPORTANT: Edit .env with your API keys before running the bot."
  echo "At minimum you need:"
  echo "  - ANTHROPIC_API_KEY (https://console.anthropic.com/)"
  echo "  - TELEGRAM_BOT_TOKEN (https://t.me/BotFather)"
  echo "  - ALLOWED_TELEGRAM (your Telegram user ID)"
  echo ""
  echo "Run 'npm run dev' when ready."
else
  echo ".env already exists — skipping."
fi

# Create data directory
mkdir -p data

# Build TypeScript
echo ""
echo "Building TypeScript..."
npm run build

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your API keys"
echo "  2. Run: npm run dev"
echo "  3. Message your Telegram bot"
echo ""
