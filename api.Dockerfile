# Node 20 has no CVE-2026-111497 fix. 22.23.4 is the fixed 22.x line.
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS production

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
