#!/bin/bash
# ═══════════════════════════════════════════════════════
# Ensure PostgreSQL + Redis are running before Yabby starts
# ═══════════════════════════════════════════════════════
# Detects the environment (Homebrew / Docker) and starts
# the services if they're not already up. Idempotent.

set -e

# Check Redis
if ! redis-cli ping > /dev/null 2>&1; then
  echo "⚠️  Redis not running — attempting to start..."
  if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q "^redis"; then
    brew services start redis > /dev/null 2>&1 || true
    # Wait up to 5s for Redis to come up
    for i in {1..10}; do
      sleep 0.5
      redis-cli ping > /dev/null 2>&1 && break
    done
  elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -q '^yabby-redis$'; then
    docker start yabby-redis > /dev/null 2>&1 || true
    sleep 2
  fi

  if redis-cli ping > /dev/null 2>&1; then
    echo "✅ Redis started"
  else
    echo "❌ Redis failed to start — install via: brew install redis && brew services start redis"
    exit 1
  fi
else
  echo "✅ Redis already running"
fi

# Check PostgreSQL
PG_DB="${PG_DATABASE:-yabby}"
PG_USER_NAME="${PG_USER:-yabby}"

if ! pg_isready -q > /dev/null 2>&1; then
  echo "⚠️  PostgreSQL not running — attempting to start..."
  if command -v brew >/dev/null 2>&1; then
    # 1) Prefer a version that was already running before (has "started" status)
    # 2) Otherwise, prefer the version that actually holds the yabby database
    #    (check each version's data dir via pg_ctl before touching brew services)
    # 3) Fallback: first installed version in the standard order
    PG_TO_START=""

    # Check if any version has "started" state (was running previously)
    PG_TO_START=$(brew services list 2>/dev/null | awk '$2=="started" && $1 ~ /^postgresql/ {print $1; exit}')

    # If none was started, find the one holding the yabby DB by scanning data dirs
    if [ -z "$PG_TO_START" ]; then
      for pg_version in postgresql@14 postgresql@15 postgresql@16 postgresql@17 postgresql; do
        if brew services list 2>/dev/null | grep -q "^${pg_version} "; then
          data_dir="$(brew --prefix)/var/${pg_version}"
          # postgresql@14 default data dir
          [ ! -d "$data_dir" ] && data_dir="$(brew --prefix)/var/postgres"
          if [ -d "$data_dir" ] && [ -f "$data_dir/base" ] || ls "$data_dir"/base 2>/dev/null | grep -q .; then
            # This version has data — prefer it
            PG_TO_START="$pg_version"
            break
          fi
        fi
      done
    fi

    # Last resort: first installed version
    if [ -z "$PG_TO_START" ]; then
      PG_TO_START=$(brew services list 2>/dev/null | awk '$1 ~ /^postgresql/ {print $1; exit}')
    fi

    if [ -n "$PG_TO_START" ]; then
      echo "   Starting $PG_TO_START..."
      brew services start "$PG_TO_START" > /dev/null 2>&1 || true
    fi

    # Wait up to 10s for PG to come up
    for i in {1..20}; do
      sleep 0.5
      pg_isready -q > /dev/null 2>&1 && break
    done
  elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -q '^yabby-postgres$'; then
    docker start yabby-postgres > /dev/null 2>&1 || true
    sleep 3
  fi

  if pg_isready -q > /dev/null 2>&1; then
    echo "✅ PostgreSQL started"
  else
    echo "❌ PostgreSQL failed to start — install via: brew install postgresql@14 && brew services start postgresql@14"
    exit 1
  fi
else
  echo "✅ PostgreSQL already running"
fi

# Ensure the yabby role exists (try both current user and postgres super)
ROLE_EXISTS=$(psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER_NAME'" postgres 2>/dev/null || \
              psql -U "$(whoami)" -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER_NAME'" postgres 2>/dev/null)
if [ "$ROLE_EXISTS" != "1" ]; then
  echo "⚠️  Role '$PG_USER_NAME' not found — creating..."
  createuser -s "$PG_USER_NAME" 2>/dev/null || echo "   (createuser failed — may need manual setup)"
fi

# Ensure the yabby database exists (best-effort, ignore if already exists)
if ! psql -U "$PG_USER_NAME" -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$PG_DB"; then
  echo "⚠️  Database '$PG_DB' not found — creating..."
  createdb -O "$PG_USER_NAME" "$PG_DB" 2>/dev/null || echo "   (createdb failed — may need manual setup)"
fi

echo "🚀 Services ready"
