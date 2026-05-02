import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:3000';

test.describe('Basic API Tests', () => {
  test('API is responding', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/conversation-state`);
    expect(response.ok()).toBeTruthy();
  });

  test('Can create project', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Test Project ${Date.now()}`,
        context: 'Simple test project'
      }
    });

    expect(response.status()).toBe(200);
    const project = await response.json();
    expect(project.id).toBeTruthy();
    expect(project.status).toBe('active');
  });

  test('Can spawn task', async ({ request }) => {
    // Create project first
    const projResp = await request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Task Test ${Date.now()}`,
        context: 'Test'
      }
    });
    const project = await projResp.json();

    // Get project details to find lead agent
    const projectResp = await request.get(`${BASE_URL}/api/projects/${project.id}`);
    const projectDetails = await projectResp.json();

    // Spawn task
    const taskResp = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "test"',
        agent_id: projectDetails.lead_agent_id,
        project_id: project.id
      }
    });

    expect(taskResp.status()).toBe(200);
    const task = await taskResp.json();
    expect(task.task_id).toBeTruthy();
  });

  test('Canonical and legacy task endpoints both work', async ({ request }) => {
    const projectResp = await request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Endpoint Parity ${Date.now()}`,
        context: 'Endpoint parity check'
      }
    });
    const project = await projectResp.json();

    const detailsResp = await request.get(`${BASE_URL}/api/projects/${project.id}`);
    const details = await detailsResp.json();
    const leadId = details.lead_agent_id;

    const canonicalStart = await request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "canonical"',
        agent_id: leadId,
        project_id: project.id
      }
    });
    expect(canonicalStart.status()).toBe(200);
    const canonicalTask = await canonicalStart.json();
    expect(canonicalTask.task_id).toBeTruthy();

    const legacyStart = await request.post(`${BASE_URL}/claude/start`, {
      data: {
        task: 'echo "legacy"',
        agent_id: leadId,
        project_id: project.id
      }
    });
    expect(legacyStart.status()).toBe(200);
    const legacyTask = await legacyStart.json();
    expect(legacyTask.task_id).toBeTruthy();

    // Ensure check endpoints return immediately (they block while tasks run).
    await request.post(`${BASE_URL}/api/tasks/kill`, {
      data: { task_id: canonicalTask.task_id }
    });
    await request.post(`${BASE_URL}/claude/kill`, {
      data: { task_id: legacyTask.task_id }
    });

    const canonicalCheck = await request.post(`${BASE_URL}/api/tasks/check`, {
      data: { task_ids: [canonicalTask.task_id, legacyTask.task_id] }
    });
    expect(canonicalCheck.status()).toBe(200);
    const canonicalCheckData = await canonicalCheck.json();
    expect(Array.isArray(canonicalCheckData.tasks)).toBeTruthy();

    const legacyCheck = await request.post(`${BASE_URL}/claude/check`, {
      data: { task_ids: [canonicalTask.task_id] }
    });
    expect(legacyCheck.status()).toBe(200);
    const legacyCheckData = await legacyCheck.json();
    expect(Array.isArray(legacyCheckData.tasks)).toBeTruthy();
  });
});
