# Fast cancellation-detection worker — built from the repo root:
#   fly deploy --config worker/fly.toml --dockerfile worker/Dockerfile
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY worker ./worker

CMD ["npx", "tsx", "worker/poller.ts"]
