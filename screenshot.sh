#!/bin/bash
# Screenshot helper: captures localhost:3000 pages using Playwright
# Usage: ./screenshot.sh [output_path] [url_hash]
# Examples:
#   ./screenshot.sh /tmp/yabby.png
#   ./screenshot.sh /tmp/yabby.png "#/settings"

OUTPUT="${1:-/tmp/yabby-screenshot.png}"
URL_HASH="${2:-}"
FULL_URL="http://localhost:3000/${URL_HASH}"

# Determine wait selector based on the page
WAIT_SELECTOR=".main-content"
case "$URL_HASH" in
  *settings*) WAIT_SELECTOR=".settings-section" ;;
  *login*) WAIT_SELECTOR=".login-card" ;;
  *tasks*) WAIT_SELECTOR=".tm-view" ;;
  *agents*) WAIT_SELECTOR=".ad-view" ;;
  *projects*) WAIT_SELECTOR=".card-grid,.project-detail" ;;
  *) WAIT_SELECTOR=".dash-stats" ;;
esac

npx --yes playwright screenshot \
  --browser chromium \
  --wait-for-selector "$WAIT_SELECTOR" \
  --viewport-size "1280,800" \
  "$FULL_URL" "$OUTPUT" 2>/dev/null

echo "Screenshot saved to $OUTPUT"
