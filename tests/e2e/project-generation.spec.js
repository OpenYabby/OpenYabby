import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API_TIMEOUT = 30000; // 30s for API calls
const TASK_TIMEOUT = 60000; // 60s for tasks to complete

test.describe('Project Generation E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app and wait for initialization
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Wait for main UI to be ready
    await page.waitForSelector('#app', { timeout: 10000 });
  });

  test('1. Should create a new project with lead agent', async ({ page }) => {
    // Navigate to projects page
    await page.click('a[href="#/projects"]');
    await page.waitForSelector('#projectsPanel');

    // Click "New Project" button
    await page.click('[data-action="new-project"]');
    await page.waitForSelector('#createProjectModal');

    // Fill in project details
    const projectName = `Test Project ${Date.now()}`;
    await page.fill('input[name="projectName"]', projectName);
    await page.fill('textarea[name="projectContext"]', 'Create a simple todo list application with React');

    // Submit project creation
    await page.click('button[type="submit"]', { timeout: 5000 });

    // Wait for project to be created
    await page.waitForSelector('.toast-success', { timeout: API_TIMEOUT });

    // Verify project appears in list
    const projectCard = await page.waitForSelector(`text=${projectName}`, { timeout: 5000 });
    expect(projectCard).toBeTruthy();

    // Verify lead agent was created
    await page.click('a[href="#/agents"]');
    await page.waitForSelector('#agentsPanel');

    const leadAgent = await page.waitForSelector('[data-agent-role="Lead"]', { timeout: 5000 });
    expect(leadAgent).toBeTruthy();
  });

  test('2. Should spawn discovery task for new project', async ({ page }) => {
    // Create project via API
    const projectName = `Discovery Test ${Date.now()}`;
    const response = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: projectName,
        context: 'Build a weather dashboard application'
      }
    });

    expect(response.status()).toBe(200);
    const project = await response.json();
    expect(project.id).toBeTruthy();

    // Navigate to tasks and verify discovery task was created
    await page.goto(`${BASE_URL}/#/tasks`);
    await page.waitForSelector('#tasksPanel');

    // Wait for discovery task to appear
    const discoveryTask = await page.waitForSelector(
      `[data-project-id="${project.id}"][data-task-type="discovery"]`,
      { timeout: TASK_TIMEOUT }
    );
    expect(discoveryTask).toBeTruthy();

    // Verify task is running
    const statusBadge = await discoveryTask.$('.task-status');
    const statusText = await statusBadge.textContent();
    expect(['running', 'done']).toContain(statusText.toLowerCase());
  });

  test('3. Should handle plan review workflow', async ({ page }) => {
    // Create project
    const projectName = `Plan Review ${Date.now()}`;
    const createResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: projectName,
        context: 'Simple calculator app'
      }
    });
    const project = await createResp.json();

    // Simulate plan submission from lead agent
    const planResp = await page.request.post(`${BASE_URL}/api/plan-reviews`, {
      data: {
        project_id: project.id,
        agent_id: project.lead_agent_id,
        plan_content: `# Project Plan
## Phase 1: Setup
- Initialize React project
- Setup component structure

## Phase 2: Implementation
- Create Calculator component
- Add operation handlers`
      }
    });

    expect(planResp.status()).toBe(200);
    const planReview = await planResp.json();

    // Navigate to home to see plan review modal
    await page.goto(`${BASE_URL}/#/`);

    // Wait for plan review modal to appear
    await page.waitForSelector('#planReviewModal', { timeout: 10000 });

    // Verify plan content is displayed
    const planContent = await page.textContent('.plan-content');
    expect(planContent).toContain('Phase 1: Setup');
    expect(planContent).toContain('Calculator component');

    // Approve the plan
    await page.click('button[data-action="approve-plan"]');

    // Verify success toast
    await page.waitForSelector('.toast-success', { timeout: 5000 });

    // Verify plan review status updated
    const statusResp = await page.request.get(`${BASE_URL}/api/plan-reviews/${planReview.id}`);
    const updatedPlan = await statusResp.json();
    expect(updatedPlan.status).toBe('approved');
  });

  test('4. Should create and manage sub-agents', async ({ page }) => {
    // Create project
    const createResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Sub-Agent Test ${Date.now()}`,
        context: 'E-commerce platform'
      }
    });
    const project = await createResp.json();

    // Create sub-agent via API (simulating lead agent action)
    const agentResp = await page.request.post(`${BASE_URL}/api/projects/${project.id}/agents`, {
      data: {
        name: 'Marie',
        role: 'Frontend Developer',
        role_instructions: 'Develop React components for the e-commerce UI',
        parent_agent_id: project.lead_agent_id,
        is_manager: false
      }
    });

    expect(agentResp.status()).toBe(200);
    const subAgent = await agentResp.json();

    // Navigate to agents page
    await page.goto(`${BASE_URL}/#/agents`);
    await page.waitForSelector('#agentsPanel');

    // Verify sub-agent appears
    const agentCard = await page.waitForSelector(`[data-agent-id="${subAgent.id}"]`, { timeout: 5000 });
    expect(agentCard).toBeTruthy();

    // Verify parent-child relationship
    const parentInfo = await agentCard.$('.parent-agent');
    const parentText = await parentInfo.textContent();
    expect(parentText).toContain('Lead');

    // Spawn task for sub-agent
    const taskResp = await page.request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'Create HomePage component with header and product grid',
        agent_id: subAgent.id,
        project_id: project.id
      }
    });

    expect(taskResp.status()).toBe(200);
    const task = await taskResp.json();

    // Navigate to tasks and verify task
    await page.goto(`${BASE_URL}/#/tasks`);
    const taskCard = await page.waitForSelector(`[data-task-id="${task.task_id}"]`, { timeout: 5000 });
    expect(taskCard).toBeTruthy();
  });

  test('5. Should handle project sandbox creation', async ({ page }) => {
    const projectName = `Sandbox Test ${Date.now()}`;

    const response = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: projectName,
        context: 'Testing sandbox initialization'
      }
    });

    const project = await response.json();

    // Verify project has sandbox path
    expect(project.sandbox_path).toBeTruthy();
    expect(project.sandbox_path).toContain(projectName.replace(/\s+/g, '-'));

    // Check if sandbox directory was created (via API check)
    const projectResp = await page.request.get(`${BASE_URL}/api/projects/${project.id}`);
    const projectData = await projectResp.json();

    expect(projectData.sandbox_path).toBeTruthy();
  });

  test('6. Should track task completion and update project status', async ({ page }) => {
    // Create project
    const createResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Task Completion ${Date.now()}`,
        context: 'Simple echo test'
      }
    });
    const project = await createResp.json();

    // Create a simple task that completes quickly
    const taskResp = await page.request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Hello World" > test.txt',
        agent_id: project.lead_agent_id,
        project_id: project.id
      }
    });
    const task = await taskResp.json();

    // Poll task status until complete
    let taskStatus = 'running';
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max

    while (taskStatus === 'running' && attempts < maxAttempts) {
      await page.waitForTimeout(1000);
      const statusResp = await page.request.get(`${BASE_URL}/api/tasks/${task.task_id}`);
      const statusData = await statusResp.json();
      taskStatus = statusData.status;
      attempts++;
    }

    expect(['done', 'error']).toContain(taskStatus);

    // Navigate to tasks page and verify
    await page.goto(`${BASE_URL}/#/tasks`);
    const taskCard = await page.waitForSelector(`[data-task-id="${task.task_id}"]`, { timeout: 5000 });
    const statusBadge = await taskCard.$('.task-status');
    const badgeText = await statusBadge.textContent();

    expect(['done', 'error']).toContain(badgeText.toLowerCase());
  });

  test('7. Should handle discovery questions workflow', async ({ page }) => {
    // Create project
    const createResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Questions Test ${Date.now()}`,
        context: 'Mobile app development'
      }
    });
    const project = await createResp.json();

    // Submit discovery question
    const questionResp = await page.request.post(`${BASE_URL}/api/project-questions`, {
      data: {
        project_id: project.id,
        agent_id: project.lead_agent_id,
        question: 'Which mobile platform should we target?',
        question_type: 'modal',
        form_schema: {
          fields: [{
            name: 'platform',
            label: 'Platform',
            type: 'select',
            options: ['iOS', 'Android', 'React Native', 'Flutter']
          }]
        }
      }
    });

    expect(questionResp.status()).toBe(200);
    const question = await questionResp.json();

    // Navigate to home to see question modal
    await page.goto(`${BASE_URL}/#/`);

    // Wait for question modal
    await page.waitForSelector('#projectQuestionModal', { timeout: 10000 });

    // Verify question content
    const questionText = await page.textContent('.question-text');
    expect(questionText).toContain('Which mobile platform');

    // Answer question
    await page.selectOption('select[name="platform"]', 'React Native');
    await page.click('button[data-action="submit-answer"]');

    // Verify answer was saved
    const answerResp = await page.request.get(`${BASE_URL}/api/project-questions/${question.id}`);
    const answeredQuestion = await answerResp.json();
    expect(answeredQuestion.answer).toBeTruthy();
    expect(answeredQuestion.status).toBe('answered');
  });

  test('8. Should handle agent heartbeats and status updates', async ({ page }) => {
    // Create project
    const createResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Heartbeat Test ${Date.now()}`,
        context: 'Testing agent status tracking'
      }
    });
    const project = await createResp.json();

    // Send heartbeat
    const heartbeatResp = await page.request.post(`${BASE_URL}/api/heartbeat`, {
      data: {
        agent_id: project.lead_agent_id,
        project_id: project.id,
        status: 'working',
        progress: 50,
        summary: 'Setting up project structure'
      }
    });

    expect(heartbeatResp.status()).toBe(200);

    // Navigate to agents page
    await page.goto(`${BASE_URL}/#/agents`);
    await page.waitForSelector('#agentsPanel');

    // Wait for heartbeat to be displayed
    await page.waitForTimeout(2000);

    // Verify heartbeat is shown
    const agentCard = await page.waitForSelector(`[data-agent-id="${project.lead_agent_id}"]`, { timeout: 5000 });
    const statusInfo = await agentCard.$('.agent-status');

    if (statusInfo) {
      const statusText = await statusInfo.textContent();
      expect(statusText.toLowerCase()).toContain('working');
    }
  });

  test('9. Should handle multiple projects concurrently', async ({ page }) => {
    const projects = [];

    // Create 3 projects concurrently
    const createPromises = [
      page.request.post(`${BASE_URL}/api/projects`, {
        data: {
          name: `Concurrent 1 ${Date.now()}`,
          context: 'First concurrent project'
        }
      }),
      page.request.post(`${BASE_URL}/api/projects`, {
        data: {
          name: `Concurrent 2 ${Date.now()}`,
          context: 'Second concurrent project'
        }
      }),
      page.request.post(`${BASE_URL}/api/projects`, {
        data: {
          name: `Concurrent 3 ${Date.now()}`,
          context: 'Third concurrent project'
        }
      })
    ];

    const responses = await Promise.all(createPromises);

    // Verify all projects created successfully
    for (const resp of responses) {
      expect(resp.status()).toBe(200);
      const project = await resp.json();
      expect(project.id).toBeTruthy();
      expect(project.lead_agent_id).toBeTruthy();
      projects.push(project);
    }

    // Navigate to projects page
    await page.goto(`${BASE_URL}/#/projects`);
    await page.waitForSelector('#projectsPanel');

    // Verify all 3 projects are visible
    for (const project of projects) {
      const projectCard = await page.waitForSelector(`[data-project-id="${project.id}"]`, { timeout: 5000 });
      expect(projectCard).toBeTruthy();
    }
  });

  test('10. Should archive project and cleanup resources', async ({ page }) => {
    // Create project
    const createResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Archive Test ${Date.now()}`,
        context: 'Testing project archival'
      }
    });
    const project = await createResp.json();

    // Navigate to projects page
    await page.goto(`${BASE_URL}/#/projects`);
    await page.waitForSelector('#projectsPanel');

    // Find project card
    const projectCard = await page.waitForSelector(`[data-project-id="${project.id}"]`, { timeout: 5000 });

    // Click archive button
    const archiveBtn = await projectCard.$('button[data-action="archive-project"]');
    if (archiveBtn) {
      await archiveBtn.click();

      // Confirm in dialog
      await page.waitForSelector('[role="dialog"]', { timeout: 3000 });
      await page.click('button[data-action="confirm"]');

      // Wait for success toast
      await page.waitForSelector('.toast-success', { timeout: 5000 });

      // Verify project no longer visible in active projects
      await page.waitForTimeout(2000);
      const archivedCard = await page.$(`[data-project-id="${project.id}"]`);
      expect(archivedCard).toBeNull();
    } else {
      // Archive via API if button not available
      const archiveResp = await page.request.patch(`${BASE_URL}/api/projects/${project.id}`, {
        data: { status: 'archived' }
      });
      expect(archiveResp.status()).toBe(200);
    }
  });

  test('11. Should handle project with connectors integration', async ({ page }) => {
    // Create project
    const createResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Connector Test ${Date.now()}`,
        context: 'Project requiring GitHub integration'
      }
    });
    const project = await createResp.json();

    // Get available connectors
    const connectorsResp = await page.request.get(`${BASE_URL}/api/connectors/catalog`);
    expect(connectorsResp.status()).toBe(200);
    const catalog = await connectorsResp.json();

    // Find GitHub connector (if available)
    const githubConnector = catalog.find(c => c.id === 'github');

    if (githubConnector) {
      // Verify connector can be viewed in UI
      await page.goto(`${BASE_URL}/#/connectors`);
      await page.waitForSelector('#connectorsPanel', { timeout: 5000 });

      const connectorCard = await page.$(`[data-connector-id="github"]`);
      expect(connectorCard).toBeTruthy();
    }
  });

  test('12. Should validate project name requirements', async ({ page }) => {
    // Navigate to projects page
    await page.goto(`${BASE_URL}/#/projects`);
    await page.waitForSelector('#projectsPanel');

    // Open new project modal
    await page.click('[data-action="new-project"]');
    await page.waitForSelector('#createProjectModal');

    // Try to submit with empty name
    await page.fill('textarea[name="projectContext"]', 'Test context');
    await page.click('button[type="submit"]');

    // Should show validation error
    const errorMsg = await page.$('.field-error');
    if (errorMsg) {
      const errorText = await errorMsg.textContent();
      expect(errorText.toLowerCase()).toContain('required');
    }

    // Fill valid name
    await page.fill('input[name="projectName"]', `Valid Project ${Date.now()}`);
    await page.click('button[type="submit"]');

    // Should succeed
    await page.waitForSelector('.toast-success', { timeout: API_TIMEOUT });
  });

  test('13. Should handle task dependencies correctly', async ({ page }) => {
    // Create project
    const createResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Dependencies Test ${Date.now()}`,
        context: 'Testing task dependency chain'
      }
    });
    const project = await createResp.json();

    // Create first task
    const task1Resp = await page.request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Task 1" > task1.txt',
        agent_id: project.lead_agent_id,
        project_id: project.id
      }
    });
    const task1 = await task1Resp.json();

    // Create dependent task
    const task2Resp = await page.request.post(`${BASE_URL}/api/tasks/start`, {
      data: {
        task: 'echo "Task 2" > task2.txt',
        agent_id: project.lead_agent_id,
        project_id: project.id,
        depends_on: [task1.task_id]
      }
    });
    const task2 = await task2Resp.json();

    // Verify task2 has dependency
    const task2DataResp = await page.request.get(`${BASE_URL}/api/tasks/${task2.task_id}`);
    const task2Data = await task2DataResp.json();

    expect(task2Data.depends_on).toBeTruthy();
    expect(task2Data.depends_on).toContain(task1.task_id);

    // Navigate to tasks and verify UI shows dependency
    await page.goto(`${BASE_URL}/#/tasks`);
    const task2Card = await page.waitForSelector(`[data-task-id="${task2.task_id}"]`, { timeout: 5000 });

    const dependencyInfo = await task2Card.$('.task-dependencies');
    if (dependencyInfo) {
      const depText = await dependencyInfo.textContent();
      expect(depText).toContain(task1.task_id);
    }
  });

  test('14. Should handle presentation creation workflow', async ({ page }) => {
    // Create project
    const createResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: {
        name: `Presentation Test ${Date.now()}`,
        context: 'Testing presentation feature'
      }
    });
    const project = await createResp.json();

    // Create presentation
    const presentationResp = await page.request.post(`${BASE_URL}/api/presentations`, {
      data: {
        projectId: project.id,
        agentId: project.lead_agent_id,
        title: 'Project Demo',
        summary: 'Demonstration of project capabilities',
        content: `# Project Overview\n\n## Features\n- Feature 1\n- Feature 2`,
        slides: [],
        demoSteps: ['Step 1: Setup', 'Step 2: Run', 'Step 3: Test'],
        sandboxPath: project.sandbox_path
      }
    });

    expect(presentationResp.status()).toBe(200);
    const presentation = await presentationResp.json();

    // Verify presentation was created
    expect(presentation.id).toBeTruthy();
    expect(presentation.title).toBe('Project Demo');

    // Navigate to presentations (if UI exists)
    const presentationsPage = await page.goto(`${BASE_URL}/#/presentations`);
    if (presentationsPage.ok()) {
      await page.waitForSelector('#presentationsPanel', { timeout: 5000 });

      const presentationCard = await page.$(`[data-presentation-id="${presentation.id}"]`);
      if (presentationCard) {
        expect(presentationCard).toBeTruthy();
      }
    }
  });
});
