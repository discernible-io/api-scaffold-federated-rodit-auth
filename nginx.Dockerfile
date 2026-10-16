FROM docker.io/nginx:1.31.7-alpine@sha256:892bb2152464f0c5d8972593a5f5afaf8054552580b699d95f8ff4af08c2d33d

RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache openssl 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0' && \
    rm /etc/nginx/conf.d/default.conf && \
    mkdir -p /app/certs

COPY nginx/nginx.conf /etc/nginx/nginx.conf

RUN chown -R nginx:nginx /etc/nginx/nginx.conf /var/cache/nginx /var/log/nginx /etc/nginx/conf.d /app

USER nginx
# Rootless Podman cannot bind privileged ports (<1024); public surface is APP_PORT 8443 only.
EXPOSE 8443

CMD ["nginx", "-g", "daemon off;"]
