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

# Install Claude Code CLI globally (for code_agent tool)
RUN npm install -g @anthropic-ai/claude-code

# Remove dev dependencies
RUN npm prune --production

# Create data + workspace dirs
RUN mkdir -p data workspace

EXPOSE 3700

CMD ["node", "dist/index.js"]
