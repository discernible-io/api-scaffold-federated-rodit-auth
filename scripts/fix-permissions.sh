#!/usr/bin/env bash
# Fix ownership, permissions, and SELinux labels for api-idc rootless Podman volumes
# Usage: ./fix-permissions.sh [APP_DIR]
# If APP_DIR is not provided, defaults to "$HOME/api-idc-app"

set -euo pipefail

APP_DIR=${1:-"${HOME}/api-idc-app"}
LOG_DIR="${APP_DIR}/logs"
DATA_DIR="${APP_DIR}/data"
CERTS_DIR="${APP_DIR}/certs"
NGINX_DIR="${APP_DIR}/nginx"

# Container runtime expectations
# API container runs as non-root user (uid=1000 assumed for alpine adduser)
API_UID=1000
API_GID=1000
# Nginx reads certs as user "nginx" but only needs world-readable files

mkdir -p "${LOG_DIR}" "${DATA_DIR}" "${CERTS_DIR}" "${NGINX_DIR}" "${LOG_DIR}/nginx"

# Permissions
# - logs: writable by API -> 0775 on dir, 0664 on files
# - data: writable by API only -> 0770 on dir, 0660 on files
# - certs: world-readable (but keep keys restricted if present)
chmod -R u+rwX,g+rwX,o-rwx "${DATA_DIR}" || true
chmod -R u+rwX,g+rwX,o+rX "${LOG_DIR}" || true
find "${LOG_DIR}" -type d -exec chmod 0775 {} + 2>/dev/null || true
find "${LOG_DIR}" -type f -exec chmod 0664 {} + 2>/dev/null || true
find "${DATA_DIR}" -type d -exec chmod 0770 {} + 2>/dev/null || true
find "${DATA_DIR}" -type f -exec chmod 0660 {} + 2>/dev/null || true

# Certs: default 0644, private keys 0640 if pattern matches
if [ -d "${CERTS_DIR}" ]; then
  find "${CERTS_DIR}" -type f -not -name "*.key" -exec chmod 0644 {} + 2>/dev/null || true
  find "${CERTS_DIR}" -type f -name "*.key" -exec chmod 0640 {} + 2>/dev/null || true
  find "${CERTS_DIR}" -type d -exec chmod 0755 {} + 2>/dev/null || true
fi

# Use podman user-namespace mapping to set ownership visible to containers
# This does not require root; it uses the rootless user namespace.
if command -v podman >/dev/null 2>&1; then
  echo "Applying userns ownership via podman unshare..."
  podman unshare chown -R ${API_UID}:${API_GID} "${LOG_DIR}" || true
  podman unshare chown -R ${API_UID}:${API_GID} "${DATA_DIR}" || true
else
  echo "Warning: podman not found. Skipping userns chown step." >&2
fi

# Apply SELinux labels if available (for Fedora/CentOS/RHEL). :Z on mounts also relabels,
# but this ensures labels are correct even before starting containers.
if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
  echo "Applying SELinux labels (container_file_t)..."
  chcon -R -t container_file_t "${LOG_DIR}" 2>/dev/null || true
  chcon -R -t container_file_t "${DATA_DIR}" 2>/dev/null || true
  chcon -R -t container_file_t "${CERTS_DIR}" 2>/dev/null || true
fi

# Final summary
cat <<EOF
Fixed permissions for: ${APP_DIR}
- logs: $(stat -c "%A %U:%G" "${LOG_DIR}" 2>/dev/null || echo "exists")
- data: $(stat -c "%A %U:%G" "${DATA_DIR}" 2>/dev/null || echo "exists")
- certs: $(stat -c "%A %U:%G" "${CERTS_DIR}" 2>/dev/null || echo "exists")
EOF
