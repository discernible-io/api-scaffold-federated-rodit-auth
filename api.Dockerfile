FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

FROM node:20-alpine AS production

RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache tini 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0' \
    && adduser -D -H -s /sbin/nologin nodeuser \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY --from=builder --chown=nodeuser:nodeuser /app ./

USER nodeuser
EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/app.js"]
