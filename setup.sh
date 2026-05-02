#!/bin/bash
# ═══════════════════════════════════════════════════════
# OpenYabby — One-Command Setup Script
# ═══════════════════════════════════════════════════════
# Usage:
#   ./setup.sh          # Interactive mode (prompts for docker/local)
#   ./setup.sh docker   # Use Docker Compose for PostgreSQL + Redis
#   ./setup.sh local    # Expect PostgreSQL + Redis already running
# ═══════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $1 ═══${NC}\n"; }

# ── Resolve project directory (where this script lives) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ══════════════════════════════════════════════════════════
# 1. Prerequisites
# ══════════════════════════════════════════════════════════
header "Checking Prerequisites"

# Node.js 20+
if ! command -v node &>/dev/null; then
    error "Node.js is not installed."
    echo "  Install via Homebrew:  brew install node"
    echo "  Or download from:     https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    error "Node.js 20+ is required (found v$(node -v | sed 's/^v//'))"
    echo "  Upgrade via Homebrew:  brew upgrade node"
    exit 1
fi
success "Node.js v$(node -v | sed 's/^v//') detected"

# npm
if ! command -v npm &>/dev/null; then
    error "npm is not installed (should come with Node.js)"
    exit 1
fi
success "npm $(npm -v) detected"

# ══════════════════════════════════════════════════════════
# 2. Select Mode (docker vs local)
# ══════════════════════════════════════════════════════════
header "Infrastructure Mode"

MODE="${1:-}"

if [ -z "$MODE" ]; then
    echo "How would you like to run PostgreSQL and Redis?"
    echo ""
    echo "  ${BOLD}1) docker${NC}  — Use Docker Compose (recommended, zero config)"
    echo "  ${BOLD}2) local${NC}   — Use locally installed PostgreSQL + Redis"
    echo ""
    read -rp "Choose [1/2]: " choice
    case "$choice" in
        1|docker)  MODE="docker" ;;
        2|local)   MODE="local" ;;
        *)         MODE="docker"; warn "Defaulting to docker mode" ;;
    esac
fi

if [ "$MODE" = "docker" ]; then
    info "Mode: Docker Compose (PostgreSQL + Redis in containers)"

    if ! command -v docker &>/dev/null; then
        error "Docker is not installed."
        echo "  Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
        exit 1
    fi
    success "Docker detected"

    # Check if Docker daemon is running
    if ! docker info &>/dev/null 2>&1; then
        error "Docker daemon is not running. Please start Docker Desktop."
        exit 1
    fi
    success "Docker daemon is running"

elif [ "$MODE" = "local" ]; then
    info "Mode: Local (expecting PostgreSQL + Redis already running)"

    # Check PostgreSQL
    if command -v psql &>/dev/null; then
        success "psql client detected"
    else
        warn "psql not found — install via: brew install postgresql@16"
    fi

    # Check Redis
    if command -v redis-cli &>/dev/null; then
        success "redis-cli detected"
    else
        warn "redis-cli not found — install via: brew install redis"
    fi
else
    error "Unknown mode: $MODE (use 'docker' or 'local')"
    exit 1
fi

# ══════════════════════════════════════════════════════════
# 3. Install Node Dependencies
# ══════════════════════════════════════════════════════════
header "Installing Dependencies"

if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
    info "node_modules exists — running npm install to sync..."
fi

npm install
success "Dependencies installed"

# ══════════════════════════════════════════════════════════
# 4. Environment File (.env)
# ══════════════════════════════════════════════════════════
header "Environment Configuration"

if [ -f ".env" ]; then
    success ".env file already exists — skipping creation"
    info "To reconfigure, edit .env manually or delete it and re-run setup"

    # Ensure Docker PG credentials match docker-compose.yml
    if [ "$MODE" = "docker" ]; then
        sed -i.bak "s/^PG_PASSWORD=$/PG_PASSWORD=yabby/" .env
        rm -f .env.bak
        info "Verified PG_PASSWORD is set for Docker mode"
    fi
else
    info "Creating .env from .env.example..."
    cp .env.example .env

    # Prompt for OpenAI API key
    echo ""
    echo -e "${BOLD}OpenAI API Key${NC}"
    echo "  Required for: voice (Realtime API), transcription (Whisper), memory (Mem0)"
    echo "  Get one at: https://platform.openai.com/api-keys"
    echo ""
    read -rp "Enter your OPENAI_API_KEY (or press Enter to skip): " openai_key

    if [ -n "$openai_key" ]; then
        # Use a delimiter that won't conflict with API key characters
        sed -i.bak "s|OPENAI_API_KEY=sk-\.\.\.|OPENAI_API_KEY=${openai_key}|" .env
        rm -f .env.bak
        success "OpenAI API key saved to .env"
    else
        warn "No OpenAI API key provided — you can set it later in the UI onboarding wizard"
    fi

    # Set Docker-specific PG credentials if in docker mode
    if [ "$MODE" = "docker" ]; then
        sed -i.bak "s/^PG_USER=postgres$/PG_USER=yabby/" .env
        sed -i.bak "s/^PG_PASSWORD=$/PG_PASSWORD=yabby/" .env
        rm -f .env.bak
        info "Set PG_USER=yabby and PG_PASSWORD=yabby (matching docker-compose.yml)"
    fi

    success ".env file created"
fi

# ══════════════════════════════════════════════════════════
# 5. Start Infrastructure
# ══════════════════════════════════════════════════════════
header "Starting Infrastructure"

if [ "$MODE" = "docker" ]; then
    # Check if local PG + Redis are already running on the target ports
    PG_ALREADY_LOCAL=false
    REDIS_ALREADY_LOCAL=false

    if lsof -i :5432 &>/dev/null 2>&1 && ! docker compose ps postgres --format '{{.State}}' 2>/dev/null | grep -q running; then
        PG_ALREADY_LOCAL=true
    fi
    if lsof -i :6379 &>/dev/null 2>&1 && ! docker compose ps redis --format '{{.State}}' 2>/dev/null | grep -q running; then
        REDIS_ALREADY_LOCAL=true
    fi

    if [ "$PG_ALREADY_LOCAL" = true ] && [ "$REDIS_ALREADY_LOCAL" = true ]; then
        warn "PostgreSQL and Redis are already running locally on the default ports"
        info "Skipping Docker — using local services instead"
        MODE="local"
    else
        info "Starting PostgreSQL + Redis via Docker Compose..."

        # Only start postgres and redis (not the yabby service — we run that natively)
        docker compose up -d postgres redis

    info "Waiting for services to be healthy..."
    # Wait for PostgreSQL
    RETRIES=0
    MAX_RETRIES=30
    until docker compose exec -T postgres pg_isready -U yabby &>/dev/null 2>&1; do
        RETRIES=$((RETRIES + 1))
        if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
            error "PostgreSQL failed to start after ${MAX_RETRIES} attempts"
            echo "  Check logs: docker compose logs postgres"
            exit 1
        fi
        sleep 1
    done
    success "PostgreSQL is ready"

    # Wait for Redis
    RETRIES=0
    until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do
        RETRIES=$((RETRIES + 1))
        if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
            error "Redis failed to start after ${MAX_RETRIES} attempts"
            echo "  Check logs: docker compose logs redis"
            exit 1
        fi
        sleep 1
    done
    success "Redis is ready"
    fi

elif [ "$MODE" = "local" ]; then
    # Local mode — validate connections
    info "Validating local PostgreSQL connection..."

    # Source .env for connection details
    if [ -f ".env" ]; then
        set -a
        # shellcheck disable=SC1091
        source .env 2>/dev/null || true
        set +a
    fi

    PG_HOST="${PG_HOST:-localhost}"
    PG_PORT="${PG_PORT:-5432}"
    PG_DATABASE="${PG_DATABASE:-yabby}"
    PG_USER="${PG_USER:-postgres}"

    # Check PostgreSQL connectivity
    if command -v pg_isready &>/dev/null; then
        if pg_isready -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" &>/dev/null; then
            success "PostgreSQL is reachable at ${PG_HOST}:${PG_PORT}"
        else
            error "Cannot connect to PostgreSQL at ${PG_HOST}:${PG_PORT}"
            echo "  Make sure PostgreSQL is running:"
            echo "    brew services start postgresql@16"
            echo "  Or check your .env settings (PG_HOST, PG_PORT, PG_USER, PG_PASSWORD)"
            exit 1
        fi
    else
        warn "pg_isready not found — skipping PostgreSQL connectivity check"
    fi

    # Ensure the 'yabby' database exists
    if command -v psql &>/dev/null; then
        if psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$PG_DATABASE"; then
            success "Database '${PG_DATABASE}' exists"
        else
            info "Creating database '${PG_DATABASE}'..."
            if createdb -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" "$PG_DATABASE" 2>/dev/null; then
                success "Database '${PG_DATABASE}' created"
            else
                warn "Could not create database '${PG_DATABASE}' — the server will attempt to use it anyway"
            fi
        fi
    fi

    # Check Redis connectivity
    REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
    REDIS_HOST=$(echo "$REDIS_URL" | sed 's|redis://||' | cut -d: -f1)
    REDIS_PORT=$(echo "$REDIS_URL" | sed 's|redis://||' | cut -d: -f2 | cut -d/ -f1)

    if command -v redis-cli &>/dev/null; then
        if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; then
            success "Redis is reachable at ${REDIS_HOST}:${REDIS_PORT}"
        else
            error "Cannot connect to Redis at ${REDIS_HOST}:${REDIS_PORT}"
            echo "  Make sure Redis is running:"
            echo "    brew services start redis"
            echo "  Or check REDIS_URL in your .env"
            exit 1
        fi
    else
        warn "redis-cli not found — skipping Redis connectivity check"
    fi
fi

# ══════════════════════════════════════════════════════════
# 6. Database Migration Check
# ══════════════════════════════════════════════════════════
header "Database Migrations"

info "Migrations run automatically when the server starts (all idempotent)"
info "Base schema + 31 numbered migrations will be applied on first boot"

# ══════════════════════════════════════════════════════════
# 7. Create logs directory
# ══════════════════════════════════════════════════════════
mkdir -p logs
success "logs/ directory ready"

# ══════════════════════════════════════════════════════════
# 8. Start the Server
# ══════════════════════════════════════════════════════════
header "Starting OpenYabby"

PORT="${PORT:-3000}"

# Kill any process on the target port
if lsof -ti :"$PORT" &>/dev/null 2>&1; then
    warn "Port $PORT is in use — stopping existing process..."
    lsof -ti :"$PORT" | xargs kill 2>/dev/null || true
    sleep 1
fi

info "Starting server on port ${PORT}..."
echo ""

# Start the server in the foreground so the user sees logs
# Migrations, config loading, and onboarding all happen automatically
node server.js &
SERVER_PID=$!

# Wait for the server to become responsive
RETRIES=0
MAX_RETRIES=30
until curl -sf "http://localhost:${PORT}/api/health" &>/dev/null 2>&1; do
    # Check if server process is still alive
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo ""
        error "Server process exited unexpectedly"
        echo "  Check the output above for errors"
        echo "  Common issues:"
        echo "    - PostgreSQL not reachable (check PG_HOST/PG_PORT in .env)"
        echo "    - Redis not running (check REDIS_URL in .env)"
        echo "    - Port ${PORT} already in use"
        exit 1
    fi

    RETRIES=$((RETRIES + 1))
    if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
        warn "Server is taking longer than expected to start — it may still be running migrations"
        break
    fi
    sleep 1
done

echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}   OpenYabby is running!${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Local URL:${NC}      http://localhost:${PORT}"
echo -e "  ${BOLD}Mode:${NC}           ${MODE}"
echo -e "  ${BOLD}Server PID:${NC}     ${SERVER_PID}"
echo ""
echo -e "  The onboarding wizard will guide you through:"
echo -e "    - Language & name setup"
echo -e "    - Workspace directory"
echo -e "    - Task runner selection (Claude CLI, Codex, etc.)"
echo -e "    - API keys configuration"
echo -e "    - Voice settings & speaker verification"
echo ""
echo -e "  ${CYAN}Useful commands:${NC}"
echo -e "    Stop server:          ${BOLD}kill ${SERVER_PID}${NC}"
if [ "$MODE" = "docker" ]; then
echo -e "    Stop infrastructure:  ${BOLD}docker compose down${NC}"
echo -e "    View DB logs:         ${BOLD}docker compose logs postgres${NC}"
fi
echo -e "    View server logs:     ${BOLD}tail -f logs/*.log${NC}"
echo -e "    Run unit tests:       ${BOLD}npx vitest${NC}"
echo ""

# Bring server to foreground so Ctrl+C works
wait "$SERVER_PID"
