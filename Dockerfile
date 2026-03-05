FROM node:22-slim

WORKDIR /app

# Install build deps for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ src/
COPY skills/ skills/

RUN npx tsc

# Remove dev dependencies
RUN npm prune --production

# Create data dir
RUN mkdir -p data

EXPOSE 3700

CMD ["node", "dist/index.js"]
