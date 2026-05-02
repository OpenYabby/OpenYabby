/* ═══════════════════════════════════════════════════════
   YABBY — Tool Suggestions System
   ═══════════════════════════════════════════════════════
   Contextual suggestions after tool execution.
   Improves command discoverability for the LLM.
*/

/**
 * Mapping: tool → contextual suggestions
 * Format: { toolName: { nextSteps: [tools], tips: "contextual message" } }
 */
export const TOOL_SUGGESTIONS = {
  // Projects
  create_project: {
    nextSteps: ['assign_agent', 'project_status', 'list_agents'],
    tips: "Project created. You can now assign specialized agents or check the project status."
  },

  list_projects: {
    nextSteps: ['project_status', 'create_project', 'delete_project'],
    tips: "Use project_status to see details of a specific project."
  },

  project_status: {
    nextSteps: ['assign_agent', 'list_agents', 'list_recent_tasks'],
    tips: "You can assign new agents or check the project's recent tasks."
  },

  rename_project: {
    nextSteps: ['project_status', 'list_projects'],
    tips: "Project renamed successfully!"
  },

  delete_project: {
    nextSteps: ['list_projects', 'create_project'],
    tips: "Project archived. It is no longer active but remains accessible in the archives."
  },

  // Plans & Questions
  approve_plan: {
    nextSteps: ['project_status', 'list_agents', 'list_recent_tasks'],
    tips: "Plan approved! Agents will start working. Check the project status to track progress."
  },

  revise_plan: {
    nextSteps: ['open_plan_modal', 'project_status'],
    tips: "Revisions sent to the agent. It will update the plan and resubmit."
  },

  cancel_plan: {
    nextSteps: ['list_projects', 'delete_project'],
    tips: "Plan cancelled. The project is pending deletion."
  },

  defer_plan_review: {
    nextSteps: ['open_plan_modal', 'list_projects'],
    tips: "Plan deferred. You can review it later via open_plan_modal or notifications."
  },

  open_plan_modal: {
    nextSteps: ['approve_plan', 'revise_plan', 'cancel_plan', 'defer_plan_review'],
    tips: "Plan opened! You can approve, request revisions, or defer."
  },

  list_pending_questions: {
    nextSteps: ['answer_project_question'],
    tips: "Use answer_project_question to respond to pending questions from project leads."
  },

  answer_project_question: {
    nextSteps: ['list_pending_questions'],
    tips: "Answer recorded! The project lead will receive your response and may ask the next question."
  },

  // Agents
  assign_agent: {
    nextSteps: ['talk_to_agent', 'agent_queue_status', 'switch_to_agent'],
    tips: "Agent created! You can talk to it directly with switch_to_agent or send an instruction with talk_to_agent."
  },

  list_agents: {
    nextSteps: ['assign_agent', 'remove_agent', 'switch_to_agent'],
    tips: "Use assign_agent to create new agents or switch_to_agent to talk to an existing one."
  },

  switch_to_agent: {
    nextSteps: ['back_to_yabby'],
    tips: "You are now talking to the agent. To return to Yabby, say 'back to Yabby' or use back_to_yabby."
  },

  back_to_yabby: {
    nextSteps: ['list_agents', 'project_status', 'list_recent_tasks'],
    tips: "Back with Yabby! What can I do for you?"
  },

  talk_to_agent: {
    nextSteps: ['agent_queue_status', 'switch_to_agent', 'check_tasks'],
    tips: "Instruction sent to the agent. Use agent_queue_status to check its queue."
  },

  agent_queue_status: {
    nextSteps: ['talk_to_agent', 'switch_to_agent'],
    tips: "Check the queue to see if the agent is busy before sending a new instruction."
  },

  remove_agent: {
    nextSteps: ['list_agents', 'assign_agent'],
    tips: "Agent removed. Its running tasks have been terminated."
  },

  create_agent_thread: {
    nextSteps: ['switch_to_agent', 'talk_to_agent'],
    tips: "WhatsApp thread created! Open WhatsApp and find the group to chat with the agent."
  },

  // Tasks
  start_task: {
    nextSteps: ['check_tasks', 'get_task_detail', 'pause_task', 'kill_task'],
    tips: "Task started asynchronously. Use check_tasks to verify its status and get the result."
  },

  check_tasks: {
    nextSteps: ['continue_task', 'get_task_detail', 'get_task_logs'],
    tips: "For more details on a task, use get_task_detail. To continue a task, use continue_task."
  },

  continue_task: {
    nextSteps: ['check_tasks', 'pause_task', 'get_task_detail'],
    tips: "Task continued with previous context. Use check_tasks to see the result."
  },

  pause_task: {
    nextSteps: ['continue_task', 'kill_task', 'check_tasks'],
    tips: "Task paused. Use continue_task to resume it with the same context."
  },

  kill_task: {
    nextSteps: ['list_recent_tasks', 'start_task'],
    tips: "Task stopped permanently. It cannot be resumed."
  },

  yabby_execute: {
    nextSteps: ['check_tasks', 'list_recent_tasks'],
    tips: "Instruction delegated. The task is running asynchronously."
  },

  get_task_detail: {
    nextSteps: ['get_task_logs', 'continue_task', 'check_tasks'],
    tips: "Use get_task_logs to see full execution details, or continue_task to proceed."
  },

  search_tasks: {
    nextSteps: ['get_task_detail', 'continue_task'],
    tips: "Use get_task_detail with a task_id for more details."
  },

  list_recent_tasks: {
    nextSteps: ['get_task_detail', 'get_task_stats', 'check_tasks'],
    tips: "Use get_task_detail to see details of a specific task."
  },

  get_task_stats: {
    nextSteps: ['list_recent_tasks', 'search_tasks'],
    tips: "Use list_recent_tasks to see recent tasks or search_tasks to search by keywords."
  },

  get_task_logs: {
    nextSteps: ['continue_task', 'get_task_detail'],
    tips: "Detailed logs displayed. Use continue_task if you want to proceed with this task."
  },

  list_llm_limit_tasks: {
    nextSteps: ['resume_llm_limit_tasks'],
    tips: "These tasks are paused because an LLM limit was reached. They can be resumed when the limit window resets."
  },

  resume_llm_limit_tasks: {
    nextSteps: ['list_llm_limit_tasks', 'check_tasks'],
    tips: "Tasks resumed! Use check_tasks to see their progress."
  },

  // Scheduling
  create_scheduled_task: {
    nextSteps: ['list_scheduled_tasks', 'trigger_scheduled_task'],
    tips: "Scheduled task created! It will run automatically on schedule. Use trigger_scheduled_task to run it manually."
  },

  list_scheduled_tasks: {
    nextSteps: ['trigger_scheduled_task', 'delete_scheduled_task', 'create_scheduled_task'],
    tips: "Use trigger_scheduled_task to run a task immediately, or delete_scheduled_task to stop it."
  },

  delete_scheduled_task: {
    nextSteps: ['list_scheduled_tasks', 'create_scheduled_task'],
    tips: "Scheduled task deleted. It will no longer run automatically."
  },

  trigger_scheduled_task: {
    nextSteps: ['list_scheduled_tasks', 'check_tasks'],
    tips: "Scheduled task triggered manually. Use check_tasks to see the result."
  },

  // Connectors
  list_connectors: {
    nextSteps: ['link_connector_to_project', 'request_connector'],
    tips: "Use link_connector_to_project to link a connector to a project, or request_connector to request a new one."
  },

  link_connector_to_project: {
    nextSteps: ['list_connectors', 'project_status'],
    tips: "Connector linked to project! Agents can now use it."
  },

  request_connector: {
    nextSteps: ['list_connectors'],
    tips: "Connector request sent. You can approve the request in notifications or via the web interface."
  },

  // Skills
  list_skills: {
    nextSteps: ['add_skill_to_agent'],
    tips: "Use add_skill_to_agent to give a skill to an agent."
  },

  add_skill_to_agent: {
    nextSteps: ['list_skills', 'list_agents'],
    tips: "Skill added! The agent can now use this capability."
  },

  // Inter-agent messages
  send_agent_message: {
    nextSteps: ['agent_queue_status', 'list_agents'],
    tips: "Message sent to the target agent. It will be processed in its queue."
  },

  // Presentation
  create_presentation: {
    nextSteps: ['project_status', 'list_projects'],
    tips: "Presentation created! It is accessible via the Presentations tab in the web interface."
  },
};

/**
 * Get suggestions for a given tool
 * @param {string} toolName
 * @returns {object|null}
 */
export function getSuggestionsForTool(toolName) {
  return TOOL_SUGGESTIONS[toolName] || null;
}

/**
 * Format suggestions as text for the AI
 * @param {object} suggestions - { nextSteps, tips }
 * @returns {string}
 */
export function formatSuggestions(suggestions) {
  if (!suggestions) return '';

  const { nextSteps, tips } = suggestions;
  let text = '';

  if (tips) {
    text += `💡 ${tips}`;
  }

  if (nextSteps && nextSteps.length > 0) {
    text += `\n\n📌 Useful commands: ${nextSteps.join(', ')}`;
  }

  return text;
}
