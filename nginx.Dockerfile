FROM docker.io/nginx:mainline-alpine

RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache openssl && \
    rm /etc/nginx/conf.d/default.conf && \
    mkdir -p /app/certs

COPY nginx/nginx.conf /etc/nginx/nginx.conf

RUN chown -R nginx:nginx /etc/nginx/nginx.conf /var/cache/nginx /var/log/nginx /etc/nginx/conf.d /app

USER nginx
# Rootless Podman cannot bind privileged ports (<1024); public surface is APP_PORT 8443 only.
EXPOSE 8443

CMD ["nginx", "-g", "daemon off;"]
