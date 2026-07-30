# Database Initialization Guide

> **Before editing:** Review [`documentation-standard.md`](../docs/documentation-standard.md).

**Created:** 2025-10-01

## Overview

The `init-database.sh` script initializes the SQLite database for the api-idc application. It handles both development and production deployment scenarios.

## Quick Start

```bash
# Development (local testing)
./scripts/init-database.sh

# Production deployment (container volume)
sudo ./scripts/init-database.sh --deployment
```

## Important Concepts

### 1. Sessions Table Management

**⚠️ CRITICAL: Do NOT manually create the sessions table!**

- The sessions table is **automatically created** by `connect-sqlite3` on first use
- Manual creation causes schema conflicts: `SQLITE_ERROR: no such column: expired`
- The library manages its own schema: `sid`, `expired`, `sess` (no type declarations)

**Why this matters:**
- We previously created the sessions table with explicit types (`TEXT`, `INTEGER`)
- This caused incompatibility with connect-sqlite3's expected schema
- Letting the library create its own table prevents all schema conflicts

### 2. Development vs Deployment Paths

| Mode | Database Path | Owner | Purpose |
|------|--------------|-------|---------|
| Development | `./data/database.sqlite` | Your user | Local testing |
| Deployment | `~/syntheticlc-app/data/database.sqlite` | UID 100999 | Container volume |

**Why different paths?**
- Container mounts: `~/syntheticlc-app/data` → `/app/data`
- The container ONLY sees the deployment path
- Using wrong path = container uses old/incorrect database

### 3. File Ownership & Permissions

**Container User Mapping:**
- Inside container: user `nodeuser` (UID 1000)
- Outside container: mapped to UID 100999 (via podman unshare)
- Database must be owned by UID 100999 for container write access

**Permissions:**
- Directories: `755` (rwxr-xr-x)
- Database file: `664` (rw-rw-r--)

## Database Schema

### Tables Created by init-database.sh

```sql
-- Comments table (CRUDA operations)
CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment TEXT NOT NULL,
    author TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Metrics table (performance tracking)
CREATE TABLE metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT,
    method TEXT,
    response_time INTEGER,
    status_code INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tables Auto-Created by connect-sqlite3

```sql
-- Sessions table (created by connect-sqlite3 on first use)
CREATE TABLE sessions (
    sid PRIMARY KEY,
    expired,
    sess
);
```

## Common Issues & Solutions

### Issue 1: "setExpressSessionStore is not a function"

**Cause:** SDK version missing session storage exports

**Solution:**
```bash
# Update SDK to v2.6.8 or higher
npm install @rodit/rodit-auth-be@latest
```

**Required SDK package.json:**
```json
{
  "peerDependencies": {
    "express-session": "^1.17.0 || ^1.18.0"
  }
}
```

### Issue 2: "SQLITE_ERROR: no such column: expired"

**Cause:** Manually created sessions table with wrong schema

**Solution:**
```bash
# Remove old sessions table and let connect-sqlite3 create it
sudo sqlite3 ~/syntheticlc-app/data/database.sqlite "DROP TABLE IF EXISTS sessions;"
podman restart syntheticlc-container
```

### Issue 3: "SQLITE_READONLY: attempt to write a readonly database"

**Cause:** Wrong file ownership

**Solution:**
```bash
# Fix ownership for deployment
sudo chown 100999:100999 ~/syntheticlc-app/data/database.sqlite
sudo chmod 664 ~/syntheticlc-app/data/database.sqlite
```

### Issue 4: Container uses old database after re-initialization

**Cause:** Container was not restarted after database recreation

**Solution:**
```bash
# Reinitialize and restart container
sudo ./scripts/init-database.sh --deployment
podman restart syntheticlc-container
```

## Troubleshooting

### Verify Database Location

```bash
# Check deployment database
sudo ls -lh ~/syntheticlc-app/data/database.sqlite

# Check container is using correct database
podman exec syntheticlc-container ls -lh /app/data/database.sqlite
```

### Inspect Database Schema

```bash
# List all tables
sudo sqlite3 ~/syntheticlc-app/data/database.sqlite ".tables"

# Check sessions table schema (should exist after first use)
sudo sqlite3 ~/syntheticlc-app/data/database.sqlite "PRAGMA table_info(sessions);"

# Expected output:
# 0|sid||0||1
# 1|expired||0||0
# 2|sess||0||0
```

### Check Container Logs

```bash
# Look for errors
podman logs --tail 50 syntheticlc-container | grep -i "error\|sqlite"

# Verify sessions table creation
podman logs syntheticlc-container | grep -i "session"
```

## Deployment Workflow

### Initial Deployment

```bash
# 1. Initialize deployment database
sudo ./scripts/init-database.sh --deployment

# 2. Deploy application (via GitHub Actions or manually)
git push origin main

# 3. Verify container started successfully
podman ps | grep syntheticlc-container

# 4. Check sessions table was auto-created
sudo sqlite3 ~/syntheticlc-app/data/database.sqlite ".tables"
# Should show: comments  metrics  sessions
```

### Updating Database Schema

```bash
# 1. Stop container
podman stop syntheticlc-container

# 2. Backup existing database
sudo cp ~/syntheticlc-app/data/database.sqlite \
     ~/syntheticlc-app/data/database.sqlite.backup.$(date +%Y%m%d)

# 3. Reinitialize database
sudo ./scripts/init-database.sh --deployment

# 4. Restart container
podman restart syntheticlc-container
```

## GitHub Actions Integration

The deployment workflow (`.github/workflows/deploy.yml`) handles database initialization automatically:

```yaml
# Ensure logs and data directories exist with correct permissions
mkdir -p ~/syntheticlc-app/logs ~/syntheticlc-app/data
podman unshare chown -R 1000:1000 ~/syntheticlc-app/logs ~/syntheticlc-app/data
podman unshare chmod g+w ~/syntheticlc-app/data
```

**Note:** The workflow does NOT run `init-database.sh` automatically. You must initialize the database manually on first deployment.

## Security Considerations

1. **File Permissions**: Database is readable by group (664) for backup purposes
2. **Container Isolation**: Container runs as non-root user (nodeuser)
3. **Volume Mounting**: Read-only mounts for sensitive directories (certs)
4. **Session Persistence**: Sessions survive container restarts but not database re-initialization

## Related Files

- `scripts/init-database.sh` - Database initialization script
- `.github/workflows/deploy.yml` - Automated deployment workflow
- `api.Dockerfile` - Container image definition
- `src/app.js` - Session storage configuration
- `src/protected/cruda.js` - Database access for CRUD operations

## Support

If you encounter issues not covered here:

1. Check container logs: `podman logs syntheticlc-container`
2. Verify database ownership: `sudo ls -lhn ~/syntheticlc-app/data/`
3. Test database access: `sudo sqlite3 ~/syntheticlc-app/data/database.sqlite ".tables"`
4. Review this guide's troubleshooting section
