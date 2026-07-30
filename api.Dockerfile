FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

FROM node:20-alpine AS production

ARG NODE_ENV=main
ENV NODE_ENV=${NODE_ENV}

RUN apk add --no-cache tini \
    && adduser -D -H -s /sbin/nologin nodeuser \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY --from=builder --chown=nodeuser:nodeuser /app ./

USER nodeuser
EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/app.js"]
