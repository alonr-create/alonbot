FROM node:22-slim

WORKDIR /app

# Install Chromium + build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y \
  python3 make g++ \
  chromium \
  fonts-noto-core fonts-noto-cjk \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc
RUN npm prune --production

# Create data directory (Railway volume mount)
RUN mkdir -p /data

EXPOSE 3000

# Clean stale Chromium locks from previous containers before starting
CMD find /data -name "SingletonLock" -delete -o -name "SingletonSocket" -delete -o -name "SingletonCookie" -delete 2>/dev/null; exec node dist/index.js
