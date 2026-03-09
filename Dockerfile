FROM node:22-slim

WORKDIR /app

# Install build dependencies for better-sqlite3 native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc
RUN npm prune --production

# Create data directory (will be overridden by Railway volume mount)
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "dist/index.js"]
