#!/usr/bin/env bash
# Database initialization script for api-idc
# 
# This script creates the SQLite database and initializes all tables for both
# development and production deployment environments.
#
# IMPORTANT NOTES:
# ================
# 1. Sessions Table: The 'sessions' table is NOT created by this script!
#    - connect-sqlite3 auto-creates the sessions table on first use
#    - Manual creation causes schema conflicts ("no such column: expired" errors)
#    - Let connect-sqlite3 manage its own table schema
#
# 2. Deployment vs Development:
#    - Development: Uses ./data/database.sqlite (local testing)
#    - Deployment: Uses ~/syntheticlc-app/data/database.sqlite (container volume)
#    - Ownership: Container runs as UID 100999 (nodeuser via podman unshare)
#    - Permissions: 664 (rw-rw-r--) for proper container access
#
# 3. Volume Mounting:
#    - Container mounts: ~/syntheticlc-app/data -> /app/data
#    - Database must exist in deployment directory BEFORE container starts
#    - Wrong path = container uses old/incorrect database
#
# Usage:
#   ./scripts/init-database.sh              # Development mode (./data/)
#   ./scripts/init-database.sh --deployment # Deployment mode (~/syntheticlc-app/data/)

set -euo pipefail

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Determine mode: development or deployment
DEPLOYMENT_MODE=false
if [[ "${1:-}" == "--deployment" ]]; then
    DEPLOYMENT_MODE=true
    DATA_DIR="${HOME}/syntheticlc-app/data"
    LOGS_DIR="${HOME}/syntheticlc-app/logs"
    echo "Starting database initialization for api-idc (DEPLOYMENT MODE)"
else
    DATA_DIR="${PROJECT_ROOT}/data"
    LOGS_DIR="${PROJECT_ROOT}/logs"
    echo "Starting database initialization for api-idc (DEVELOPMENT MODE)"
fi

NGINX_LOGS_DIR="${LOGS_DIR}/nginx"
DB_PATH="${DATA_DIR}/database.sqlite"

echo "  WARNING: This will DELETE and RECREATE the database"
echo "  Database path: ${DB_PATH}"

# Create directories with proper permissions
echo "  Creating directory structure..."
mkdir -p "${DATA_DIR}" "${LOGS_DIR}" "${NGINX_LOGS_DIR}"
chmod 755 "${DATA_DIR}" "${LOGS_DIR}" 2>/dev/null || echo "⚠️  Could not set directory permissions (may be owned by container user)"
chmod 775 "${NGINX_LOGS_DIR}" 2>/dev/null || echo "⚠️  Could not set nginx log permissions (may be owned by container user)"

echo "✓ Created directories:"
echo "  - Data: ${DATA_DIR}"
echo "  - Logs: ${LOGS_DIR}"
echo "  - Nginx logs: ${NGINX_LOGS_DIR}"

# Check if we can access the data directory
if [ ! -r "${DATA_DIR}" ] && [ "$DEPLOYMENT_MODE" = true ]; then
    echo ""
    echo "⚠️  Cannot access deployment directory: ${DATA_DIR}"
    echo "💡 Directory is owned by container user (UID 100999)"
    echo ""
    echo "🔧 To initialize the deployment database, run:"
    echo "    sudo ./scripts/init-database.sh --deployment"
    echo ""
    echo "Or manually:"
    echo "    sudo rm -f ${DB_PATH}"
    echo "    sudo chown 100999:100999 ${DATA_DIR}"
    echo "    sudo ./scripts/init-database.sh --deployment"
    exit 1
fi

# Remove existing database if present
if [ -f "${DB_PATH}" ]; then
    echo "🗑️  Removing existing database at ${DB_PATH}..."
    rm -f "${DB_PATH}"
    echo "✅ Existing database removed"
fi

# Initialize SQLite database with standardized schema
echo "🗄️  Initializing SQLite database at ${DB_PATH}..."

# Create the database and tables using sqlite3 command
sqlite3 "${DB_PATH}" <<EOF
-- Comments table for CRUDA operations (using standardized 'comment' field)
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment TEXT NOT NULL,
    author TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table will be auto-created by connect-sqlite3 on first use
-- Do not create it manually to avoid schema conflicts

-- Insert a test comment to verify schema
INSERT INTO comments (comment, author) VALUES ('Database initialized successfully', 'system');

-- Verify tables were created
SELECT 'Tables created:' as status;
.tables
EOF

# Set proper permissions and ownership for database file
chmod 664 "${DB_PATH}"  # Read/write for owner and group
echo "✓ Set database file permissions (664)"

# Set ownership for deployment mode (container user)
if [ "$DEPLOYMENT_MODE" = true ]; then
    echo "🔐 Setting ownership for container access..."
    # Container runs as UID 100999 (nodeuser via podman unshare)
    # This is the mapped UID for user 1000 inside the container
    if command -v podman &> /dev/null; then
        podman unshare chown 1000:1000 "${DB_PATH}" 2>/dev/null || \
            chown 100999:100999 "${DB_PATH}" 2>/dev/null || \
            echo "⚠️  Could not set ownership - run with sudo or as podman user"
    else
        chown 100999:100999 "${DB_PATH}" 2>/dev/null || \
            echo "⚠️  Could not set ownership - run with sudo"
    fi
    echo "✓ Ownership set for container user (UID 100999/1000)"
fi

# Verify database was created successfully
if [ -f "${DB_PATH}" ] && [ -s "${DB_PATH}" ]; then
    DB_SIZE=$(stat -c%s "${DB_PATH}")
    echo "✅ Database initialization completed successfully!"
    echo "📊 Database details:"
    echo "  - File: ${DB_PATH}"
    echo "  - Size: ${DB_SIZE} bytes"
    echo "  - Permissions: $(stat -c%A "${DB_PATH}")"
    
    # Verify all tables were created
    echo ""
    echo "📋 Tables created:"
    sqlite3 "${DB_PATH}" ".tables" | tr '\t' '\n' | sed 's/^/  - /'
    
    # Test each table
    echo ""
    echo "🧪 Testing tables:"
    COMMENTS_COUNT=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM comments;" 2>/dev/null || echo "ERROR")
    
    echo "  - comments: ${COMMENTS_COUNT} rows"
    echo "  - sessions: (will be auto-created by connect-sqlite3)"
    
    if [ "$COMMENTS_COUNT" != "ERROR" ]; then
        echo ""
        echo "🎉 All tables verified and ready for use!"
        echo ""
        echo "📝 Important Notes:"
        echo "  • Sessions table: Will be auto-created by connect-sqlite3 on first use"
        echo "  • Sessions persist: All sessions survive container restarts"
        echo "  • Schema managed by: connect-sqlite3 library (do not manually modify)"
        
        if [ "$DEPLOYMENT_MODE" = true ]; then
            echo ""
            echo "🚀 Deployment Mode Active:"
            echo "  • Container mount: ~/syntheticlc-app/data -> /app/data"
            echo "  • Container user: nodeuser (UID 1000 -> host UID 100999)"
            echo "  • Restart container to pick up new database"
            echo ""
            echo "📦 To apply changes:"
            echo "    podman restart syntheticlc-container"
        else
            echo ""
            echo "💻 Development Mode Active:"
            echo "  • Database location: ${DB_PATH}"
            echo "  • Start app: npm start"
        fi
    else
        echo "❌ One or more table tests failed"
        exit 1
    fi
else
    echo "❌ Database creation failed"
    exit 1
fi

echo ""
echo "✅ Database initialization complete!"
