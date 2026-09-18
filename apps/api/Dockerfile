FROM node:22-alpine AS builder

WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=poduction

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --only=production

RUN apk add --no-cache openssl

COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]