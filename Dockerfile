FROM node:22-slim

WORKDIR /app

# Install build deps + useful tools for shell access
RUN apt-get update && apt-get install -y python3 make g++ curl git jq && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ src/
COPY skills/ skills/

RUN npx tsc

# Copy non-TS assets that tsc doesn't emit
COPY src/views/ dist/views/


# Remove dev dependencies
RUN npm prune --production

# Create data + workspace dirs
RUN mkdir -p data workspace

EXPOSE 3700

CMD ["node", "dist/index.js"]
