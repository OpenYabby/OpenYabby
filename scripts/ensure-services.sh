#!/bin/bash
# ═══════════════════════════════════════════════════════
# Ensure PostgreSQL + Redis are running before Yabby starts
# ═══════════════════════════════════════════════════════
# Honors .env so it probes the *configured* server with the
# *configured* credentials — not just whatever happens to be
# listening on the default ports. This prevents silently
# hijacking a different Postgres that doesn't have our role.

set -e

# ── Resolve project root (script lives in scripts/) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Load .env so we use the configured ports/creds ──
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env 2>/dev/null || true
  set +a
fi

PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5433}"
PG_DB="${PG_DATABASE:-yabby}"
PG_USER_NAME="${PG_USER:-yabby}"
REDIS_URL_VAL="${REDIS_URL:-redis://localhost:6380}"
REDIS_HOST=$(echo "$REDIS_URL_VAL" | sed 's|redis://||' | cut -d: -f1)
REDIS_PORT=$(echo "$REDIS_URL_VAL" | sed 's|redis://||' | cut -d: -f2 | cut -d/ -f1)

# Who's holding a TCP port? (best-effort, macOS/Linux)
who_owns_port() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'
}

# ── Redis ──
if ! redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping > /dev/null 2>&1; then
  echo "⚠️  Redis not reachable at ${REDIS_HOST}:${REDIS_PORT} — attempting to start..."

  # Prefer the Docker container yabby provisioned
  if command -v docker >/dev/null 2>&1 && docker compose ps redis 2>/dev/null | grep -q redis; then
    docker compose up -d redis > /dev/null 2>&1 || true
    sleep 2
  elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -q '^yabby-redis$'; then
    docker start yabby-redis > /dev/null 2>&1 || true
    sleep 2
  elif command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q "^redis"; then
    brew services start redis > /dev/null 2>&1 || true
    for i in {1..10}; do sleep 0.5; redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping > /dev/null 2>&1 && break; done
  fi

  if ! redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping > /dev/null 2>&1; then
    OWNER=$(who_owns_port "$REDIS_PORT")
    echo "❌ Redis failed to start at ${REDIS_HOST}:${REDIS_PORT}"
    if [ -n "$OWNER" ]; then
      echo "   Port $REDIS_PORT is held by: $OWNER (but not responding to PING)"
    fi
    echo ""
    echo "   Fix one of:"
    echo "     - Start the Docker container:  ./setup.sh docker"
    echo "     - Or point .env REDIS_URL at your own Redis instance"
    exit 1
  fi
fi
echo "✅ Redis ${REDIS_HOST}:${REDIS_PORT} ready"

# ── PostgreSQL: reachability ──
if ! pg_isready -h "$PG_HOST" -p "$PG_PORT" -q > /dev/null 2>&1; then
  echo "⚠️  PostgreSQL not reachable at ${PG_HOST}:${PG_PORT} — attempting to start..."

  # Prefer Docker if compose knows about a postgres service
  if command -v docker >/dev/null 2>&1 && docker compose ps postgres 2>/dev/null | grep -q postgres; then
    docker compose up -d postgres > /dev/null 2>&1 || true
    for i in {1..30}; do sleep 0.5; pg_isready -h "$PG_HOST" -p "$PG_PORT" -q > /dev/null 2>&1 && break; done
  elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -q '^yabby-postgres$'; then
    docker start yabby-postgres > /dev/null 2>&1 || true
    for i in {1..30}; do sleep 0.5; pg_isready -h "$PG_HOST" -p "$PG_PORT" -q > /dev/null 2>&1 && break; done
  fi

  if ! pg_isready -h "$PG_HOST" -p "$PG_PORT" -q > /dev/null 2>&1; then
    OWNER=$(who_owns_port "$PG_PORT")
    echo "❌ PostgreSQL failed to start at ${PG_HOST}:${PG_PORT}"
    if [ -n "$OWNER" ]; then
      echo "   Port $PG_PORT is held by: $OWNER (but not responding to pg_isready)"
    fi
    echo ""
    echo "   Fix one of:"
    echo "     - Start the Docker container:  ./setup.sh docker"
    echo "     - Or point .env PG_HOST/PG_PORT at your own Postgres"
    exit 1
  fi
fi

# ── PostgreSQL: authentication ──
# A listener answering pg_isready isn't enough — verify the *configured* user
# can actually authenticate. This catches the common case where a different
# Postgres (e.g. brew Postgres on 5432) is squatting on the port but has no
# matching role.
AUTH_OK=$(PGPASSWORD="${PG_PASSWORD:-}" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER_NAME" -d postgres -tAc 'SELECT 1' 2>&1 || true)

if [ "$AUTH_OK" != "1" ]; then
  # Try to auto-create the role and DB if we're talking to a local Postgres
  # where the current shell user is a superuser (common dev setup).
  echo "⚠️  PostgreSQL at ${PG_HOST}:${PG_PORT} doesn't accept '$PG_USER_NAME' — attempting auto-fix..."
  createuser -h "$PG_HOST" -p "$PG_PORT" -s "$PG_USER_NAME" 2>/dev/null || true
  if [ -n "${PG_PASSWORD:-}" ]; then
    psql -h "$PG_HOST" -p "$PG_PORT" -d postgres -c "ALTER USER \"$PG_USER_NAME\" WITH PASSWORD '$PG_PASSWORD'" >/dev/null 2>&1 || true
  fi
  createdb -h "$PG_HOST" -p "$PG_PORT" -O "$PG_USER_NAME" "$PG_DB" 2>/dev/null || true

  AUTH_OK=$(PGPASSWORD="${PG_PASSWORD:-}" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER_NAME" -d postgres -tAc 'SELECT 1' 2>&1 || true)
fi

if [ "$AUTH_OK" != "1" ]; then
  OWNER=$(who_owns_port "$PG_PORT")
  echo ""
  echo "❌ PostgreSQL on ${PG_HOST}:${PG_PORT} won't accept user '$PG_USER_NAME'."
  if [ -n "$OWNER" ]; then
    echo "   Port $PG_PORT is held by: $OWNER"
    echo "   Likely a different Postgres is squatting on the port and doesn't have the '$PG_USER_NAME' role."
  fi
  echo ""
  echo "   Fix one of:"
  echo "     1) Use Docker Postgres (recommended):    ./setup.sh docker"
  echo "     2) Create the role manually:             createuser -s $PG_USER_NAME && createdb -O $PG_USER_NAME $PG_DB"
  echo "     3) Edit .env to use your existing user:  PG_USER=$(whoami) PG_PASSWORD=<your-pwd>"
  exit 1
fi

# ── Ensure the target database exists (best-effort) ──
DB_EXISTS=$(PGPASSWORD="${PG_PASSWORD:-}" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER_NAME" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" 2>/dev/null || true)
if [ "$DB_EXISTS" != "1" ]; then
  echo "⚠️  Database '$PG_DB' not found — creating..."
  PGPASSWORD="${PG_PASSWORD:-}" createdb -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER_NAME" -O "$PG_USER_NAME" "$PG_DB" 2>/dev/null \
    || echo "   (createdb failed — server will retry on startup)"
fi

echo "✅ PostgreSQL ${PG_HOST}:${PG_PORT} accepting '$PG_USER_NAME'"
echo "🚀 Services ready"
