# syntax=docker/dockerfile:1
FROM node:22-slim

WORKDIR /app

# Copy manifests first so npm ci is cached independently of source changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    COPILOTKIT_TELEMETRY_DISABLED=true

# A worker, not a server: it dials out to the CopilotKit gateway and listens on
# no port, so there is nothing to EXPOSE and no health check to serve.
CMD ["npx", "tsx", "src/index.tsx"]
