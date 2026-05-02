# End-to-End Tests for OpenYabby

## Overview

This directory contains comprehensive Playwright E2E tests covering the entire OpenYabby project generation workflow, voice sessions, and task spawning functionality.

## Test Suites

### 1. Project Generation Tests (`project-generation.spec.js`)

**14 Tests** covering complete project lifecycle:

1. ✅ **Create new project with lead agent** - Validates project creation flow, lead agent auto-creation
2. ✅ **Spawn discovery task for new project** - Verifies automatic discovery phase initiation
3. ✅ **Handle plan review workflow** - Tests plan submission, approval/revision flow
4. ✅ **Create and manage sub-agents** - Validates hierarchical agent creation and parent-child relationships
5. ✅ **Handle project sandbox creation** - Verifies sandbox directory initialization
6. ✅ **Track task completion and update project status** - Monitors task lifecycle and status updates
7. ✅ **Handle discovery questions workflow** - Tests voice/modal/connector question types
8. ✅ **Handle agent heartbeats and status updates** - Validates real-time agent progress tracking
9. ✅ **Handle multiple projects concurrently** - Tests concurrent project creation (3 projects)
10. ✅ **Archive project and cleanup resources** - Verifies soft delete and resource cleanup
11. ✅ **Handle project with connectors integration** - Tests connector catalog and project scoping
12. ✅ **Validate project name requirements** - Tests form validation and error handling
13. ✅ **Handle task dependencies correctly** - Verifies dependency chain (`depends_on` array)
14. ✅ **Handle presentation creation workflow** - Tests presentation API and storage

### 2. Voice Session Tests (`voice-sessions.spec.js`)

**10 Tests** covering voice interaction features:

1. ✅ **Display voice panel on homepage** - UI component verification
2. ✅ **Show disconnected status initially** - Initial state validation
3. ✅ **Fetch voice instructions on page load** - API endpoint testing
4. ✅ **Request microphone permission** - Permission flow validation
5. ✅ **Display conversation history** - Turn display verification
6. ✅ **Load memory profile on initialization** - Mem0 integration check
7. ✅ **Handle wake word detection UI** - Wake word status indicator
8. ✅ **Display speaker verification status** - Speaker biometric UI
9. ✅ **Show voice controls** - Mute/stop button validation
10. ✅ **Handle session switch to agent** - Agent voice config switching

### 3. Task Spawning Tests (`task-spawning.spec.js`)

**14 Tests** covering task execution engine:

1. ✅ **Spawn task via API endpoint** - Basic task creation via `/api/tasks/start`
2. ✅ **Generate unique task IDs** - Concurrent spawning validation (3 parallel tasks)
3. ✅ **Track task status lifecycle** - `running` → `done`/`error` transitions
4. ✅ **Pass environment variables** - ENV propagation to child processes
5. ✅ **Create task logs** - Activity log generation
6. ✅ **Handle task spawning with dependencies** - `depends_on` array validation
7. ✅ **Support task priority levels** - Priority field (0-10) validation
8. ✅ **Handle task pausing and resuming** - SIGTERM/SIGCONT lifecycle
9. ✅ **Handle task killing/cancellation** - SIGKILL and status update
10. ✅ **Spawn tasks with custom session IDs** - Session ID override
11. ✅ **Generate MCP config for tasks** - `.mcp.json` creation verification
12. ✅ **Handle orphaned task recovery** - Startup orphan detection
13. ✅ **Emit SSE events for task lifecycle** - Real-time event streaming
14. ✅ **Associate tasks with correct agent context** - Agent/project binding

## Total Coverage

- **38 E2E Tests** across 3 test suites
- **Coverage Areas:**
  - Project creation and management
  - Multi-agent orchestration
  - Task execution engine
  - Voice/WebRTC sessions
  - Real-time updates (SSE/WebSocket)
  - Plan review workflow
  - Discovery questions
  - Connectors integration
  - Memory extraction (Mem0)
  - Speaker verification

## Running Tests

### Run all E2E tests
```bash
npm run test:e2e
```

### Run in UI mode (interactive)
```bash
npm run test:e2e:ui
```

### Run in debug mode
```bash
npm run test:e2e:debug
```

### Run with browser visible (headed)
```bash
npm run test:e2e:headed
```

### Run specific test file
```bash
npx playwright test tests/e2e/project-generation.spec.js
```

### Run specific test
```bash
npx playwright test -g "Should create a new project with lead agent"
```

## Test Configuration

See [playwright.config.js](../../playwright.config.js) for:
- Timeout settings (120s per test)
- Browser configuration (Chromium)
- Screenshot/video capture on failure
- Base URL configuration
- Auto-start server before tests

## Prerequisites

1. **PostgreSQL** running with `yabby` database
2. **Redis** running on localhost:6379
3. **OpenAI API key** in `.env` file
4. **Claude CLI** installed (for task spawning tests)

## CI/CD Integration

Tests are designed to run in CI with:
- Sequential execution (avoid DB conflicts)
- Automatic retries (2 retries on CI)
- Screenshot/video capture on failure
- HTML report generation

## Test Data Cleanup

Tests use:
- Timestamped naming (`Test Project ${Date.now()}`)
- Soft delete (status='archived')
- Default conversation reset after each test

**Note:** Some tests may leave data in DB. Run cleanup periodically:
```sql
DELETE FROM projects WHERE name LIKE 'Test%' OR name LIKE '%Test%';
DELETE FROM agents WHERE name LIKE 'Test%';
DELETE FROM tasks WHERE id IN (SELECT id FROM tasks WHERE created_at < NOW() - INTERVAL '1 day');
```

## Troubleshooting

### Server not starting
- Check if port 3000 is available: `lsof -ti :3000`
- Verify `.env` contains required keys
- Check PostgreSQL/Redis are running

### Tests timing out
- Increase timeout in `playwright.config.js`
- Check network connectivity
- Verify API endpoints are responding

### Browser not launching
- Run `npx playwright install chromium --with-deps`
- Check system dependencies installed

### Database conflicts
- Ensure tests run sequentially (`workers: 1`)
- Check unique constraints on test data
- Verify test cleanup in `afterEach`

## Future Enhancements

- [ ] Add visual regression tests
- [ ] Add load/stress testing with k6
- [ ] Add accessibility (a11y) audits
- [ ] Add performance metrics collection
- [ ] Add cross-browser testing (Firefox, WebKit)
- [ ] Add mobile viewport testing
- [ ] Add API contract testing
- [ ] Add webhook/SSE event validation
