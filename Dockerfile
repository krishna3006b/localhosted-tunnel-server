# Use Node.js 20 LTS
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source & build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── Production image ─────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JS
COPY --from=builder /app/dist ./dist

# Railway injects PORT env var
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/server.js"]
