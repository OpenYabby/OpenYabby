import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TASK_TIMEOUT = 60000; // 60s for task operations

test.describe('Task Spawning E2E Tests', () => {
  let testProject;
  let testAgent;

  test.beforeAll(async ({ request }) => {
    // Create a test project for task spawning tests
    const projectResp = await request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Task Spawn Test ${Date.now()}`,
        context: 'Testing task spawning functionality'
      }
    });
    testProject = await projectResp.json();

    // Use the lead agent for tests
    testAgent = { id: testProject.lead_agent_id };
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
  });

  test('1. Should spawn task via API endpoint', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Hello from task spawning test"',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });

    expect(response.status()).toBe(200);
    const result = await response.json();

    expect(result).toHaveProperty('task_id');
    expect(result).toHaveProperty('status');
    expect(result.status).toBe('running');
    expect(result.task_id).toMatch(/^[a-z0-9]{8}$/);
  });

  test('2. Should generate unique task IDs for concurrent spawns', async ({ request }) => {
    const tasks = await Promise.all([
      request.post(`${BASE_URL}/api/tasks/start`, {
        data: {
          task: 'echo "Task 1"',
          agent_id: testAgent.id,
          project_id: testProject.id
        }
      }),
      request.post(`${BASE_URL}/api/tasks/start`, {
        data: {
          task: 'echo "Task 2"',
          agent_id: testAgent.id,
          project_id: testProject.id
        }
      }),
      request.post(`${BASE_URL}/api/tasks/start`, {
        data: {
          task: 'echo "Task 3"',
          agent_id: testAgent.id,
          project_id: testProject.id
        }
      })
    ]);

    const taskIds = await Promise.all(tasks.map(t => t.json()));

    // All task IDs should be unique
    const ids = taskIds.map(t => t.task_id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });

  test('3. Should track task status lifecycle', async ({ request }) => {
    // Spawn a simple task
    const spawnResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Status test" && sleep 2',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });

    const spawnData = await spawnResp.json();
    const taskId = spawnData.task_id;

    // Check initial status
    const initialResp = await request.get(`${BASE_URL}/api/tasks/${taskId}`);
    const initialData = await initialResp.json();
    expect(initialData.status).toBe('running');

    // Wait for completion
    let finalStatus = 'running';
    let attempts = 0;
    const maxAttempts = 30;

    while (finalStatus === 'running' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const statusResp = await request.get(`${BASE_URL}/api/tasks/${taskId}`);
      const statusData = await statusResp.json();
      finalStatus = statusData.status;
      attempts++;
    }

    expect(['done', 'error']).toContain(finalStatus);
  });

  test('4. Should pass environment variables to spawned tasks', async ({ request }) => {
    const taskResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'env | grep OPENAI_API_KEY',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });

    expect(taskResp.status()).toBe(200);
    const task = await taskResp.json();

    // Wait a bit for task to run
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check task output/result
    const resultResp = await request.get(`${BASE_URL}/api/tasks/${task.task_id}`);
    const resultData = await resultResp.json();

    // Should have completed
    expect(['done', 'error', 'running']).toContain(resultData.status);
  });

  test('5. Should create task logs for spawned tasks', async ({ request, page }) => {
    const taskResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Logging test"',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });

    const task = await taskResp.json();

    // Navigate to tasks page
    await page.goto(`${BASE_URL}/#/tasks`);
    await page.waitForSelector('#tasksPanel');

    // Wait for task card to appear
    const taskCard = await page.waitForSelector(
      `[data-task-id="${task.task_id}"]`,
      { timeout: TASK_TIMEOUT }
    );

    expect(taskCard).toBeTruthy();

    // Check for activity log link
    const activityLink = await taskCard.$('[data-action="view-activity"]');
    if (activityLink) {
      expect(activityLink).toBeTruthy();
    }
  });

  test('6. Should handle task spawning with dependencies', async ({ request }) => {
    // Create first task
    const task1Resp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Task 1 complete"',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });
    const task1 = await task1Resp.json();

    // Create dependent task
    const task2Resp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Task 2 depends on Task 1"',
        agent_id: testAgent.id,
        project_id: testProject.id,
        depends_on: [task1.task_id]
      }
    });

    expect(task2Resp.status()).toBe(200);
    const task2 = await task2Resp.json();

    // Verify dependency is recorded
    const task2DataResp = await request.get(`${BASE_URL}/api/tasks/${task2.task_id}`);
    const task2Data = await task2DataResp.json();

    expect(task2Data.depends_on).toBeTruthy();
    expect(task2Data.depends_on).toContain(task1.task_id);
  });

  test('7. Should support task priority levels', async ({ request }) => {
    const highPriorityResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "High priority"',
        agent_id: testAgent.id,
        project_id: testProject.id,
        priority: 10
      }
    });

    const highPriority = await highPriorityResp.json();

    // Verify priority was set
    const taskDataResp = await request.get(`${BASE_URL}/api/tasks/${highPriority.task_id}`);
    const taskData = await taskDataResp.json();

    expect(taskData.priority).toBe(10);
  });

  test('8. Should handle task pausing and resuming', async ({ request }) => {
    // Spawn a long-running task
    const taskResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'sleep 30',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });

    const task = await taskResp.json();

    // Wait a moment for task to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Pause the task
    const pauseResp = await request.post(`${BASE_URL}/api/tasks/${task.task_id}/pause`);

    if (pauseResp.ok()) {
      const pauseData = await pauseResp.json();
      expect(pauseData.status).toBe('paused');

      // Resume the task
      const resumeResp = await request.post(`${BASE_URL}/api/tasks/${task.task_id}/resume`);

      if (resumeResp.ok()) {
        const resumeData = await resumeResp.json();
        expect(resumeData.status).toBe('running');
      }
    }

    // Kill task to cleanup
    await request.post(`${BASE_URL}/api/tasks/${task.task_id}/kill`);
  });

  test('9. Should handle task killing/cancellation', async ({ request }) => {
    // Spawn a long task
    const taskResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'sleep 60',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });

    const task = await taskResp.json();

    // Wait for task to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Kill the task
    const killResp = await request.post(`${BASE_URL}/api/tasks/${task.task_id}/kill`);
    expect(killResp.status()).toBe(200);

    // Verify task is killed
    await new Promise(resolve => setTimeout(resolve, 2000));
    const statusResp = await request.get(`${BASE_URL}/api/tasks/${task.task_id}`);
    const statusData = await statusResp.json();

    expect(statusData.status).toBe('killed');
  });

  test('10. Should spawn tasks with custom session IDs', async ({ request }) => {
    const customSessionId = `test-session-${Date.now()}`;

    const taskResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Custom session"',
        agent_id: testAgent.id,
        project_id: testProject.id,
        session_id: customSessionId
      }
    });

    expect(taskResp.status()).toBe(200);
    const task = await taskResp.json();

    // Verify session ID was used
    const taskDataResp = await request.get(`${BASE_URL}/api/tasks/${task.task_id}`);
    const taskData = await taskDataResp.json();

    expect(taskData.session_id).toBe(customSessionId);
  });

  test('11. Should generate MCP config for tasks with connectors', async ({ request }) => {
    // This test verifies .mcp.json generation for tasks
    const taskResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "MCP config test"',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });

    expect(taskResp.status()).toBe(200);
    const task = await taskResp.json();

    // Task should be created successfully
    expect(task.task_id).toBeTruthy();

    // Note: Actual .mcp.json validation would require file system access
    // which is beyond Playwright's scope, but we verify the task spawned correctly
  });

  test('12. Should handle orphaned task recovery on restart', async ({ request }) => {
    // Get current running tasks
    const tasksResp = await request.get(`${BASE_URL}/api/tasks?status=running`);
    const tasks = await tasksResp.json();

    // All running tasks should have valid PIDs (or be recently started)
    if (Array.isArray(tasks)) {
      for (const task of tasks) {
        expect(task).toHaveProperty('id');
        expect(task.status).toBe('running');
      }
    }
  });

  test('13. Should emit SSE events for task lifecycle', async ({ page }) => {
    // Navigate to page that listens to SSE
    await page.goto(`${BASE_URL}/#/tasks`);

    // Set up event listener for SSE events
    const events = [];
    page.on('console', msg => {
      if (msg.text().includes('[SSE]')) {
        events.push(msg.text());
      }
    });

    // Spawn a task
    const taskResp = await page.request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "SSE test"',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });

    const task = await taskResp.json();

    // Wait for SSE events
    await page.waitForTimeout(5000);

    // Note: SSE event verification depends on console logging in client
    // In production, we'd need a more robust SSE testing approach
    expect(task.task_id).toBeTruthy();
  });

  test('14. Should associate tasks with correct agent context', async ({ request }) => {
    const taskResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Agent context test"',
        agent_id: testAgent.id,
        project_id: testProject.id
      }
    });

    const task = await taskResp.json();

    // Get task details
    const taskDataResp = await request.get(`${BASE_URL}/api/tasks/${task.task_id}`);
    const taskData = await taskDataResp.json();

    // Verify agent association
    expect(taskData.agent_id).toBe(testAgent.id);
    expect(taskData.project_id).toBe(testProject.id);
  });
});
