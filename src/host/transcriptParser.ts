import * as path from 'path';
import type { AgentState, IpcBridge } from './types.js';
import {
  cancelWaitingTimer,
  startWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  cancelPermissionTimer,
} from './timerManager.js';
import {
  TOOL_DONE_DELAY_MS,
  TEXT_IDLE_DELAY_MS,
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from './constants.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'AskUserQuestion']);

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
  switch (toolName) {
    case 'Read': return `Reading ${base(input.file_path)}`;
    case 'Edit': return `Editing ${base(input.file_path)}`;
    case 'Write': return `Writing ${base(input.file_path)}`;
    case 'Bash': {
      const cmd = (input.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob': return 'Searching files';
    case 'Grep': return 'Searching code';
    case 'WebFetch': return 'Fetching web content';
    case 'WebSearch': return 'Searching the web';
    case 'Task': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}` : 'Running subtask';
    }
    case 'AskUserQuestion': return 'Waiting for your answer';
    case 'EnterPlanMode': return 'Planning';
    case 'NotebookEdit': return 'Editing notebook';
    default: return `Using ${toolName}`;
  }
}

/** Format a Codex tool call into a human-readable status string */
function formatCodexToolStatus(toolName: string, args: string): string {
  switch (toolName) {
    case 'exec_command': {
      try {
        const parsed = JSON.parse(args);
        const cmd = (parsed.cmd as string) || '';
        return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
      } catch {
        return 'Running command';
      }
    }
    case 'apply_patch': {
      const match = args.match(/Update File:\s*(\S+)/);
      if (match) return `Editing ${path.basename(match[1])}`;
      const createMatch = args.match(/Create File:\s*(\S+)/);
      if (createMatch) return `Creating ${path.basename(createMatch[1])}`;
      return 'Applying patch';
    }
    default: return `Using ${toolName}`;
  }
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  bridge: IpcBridge | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const record = JSON.parse(line);

    // Dispatch based on agent type
    if (agent.agentType === 'codex') {
      processCodexRecord(agentId, record, agents, waitingTimers, permissionTimers, bridge);
      return;
    }

    // Claude Code format
    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      const blocks = record.message.content as Array<{
        type: string; id?: string; name?: string; input?: Record<string, unknown>;
      }>;
      const hasToolUse = blocks.some(b => b.type === 'tool_use');

      if (hasToolUse) {
        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        bridge?.send('agentStatus', { id: agentId, status: 'active' });
        let hasNonExemptTool = false;
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            const status = formatToolStatus(toolName, block.input || {});
            console.log(`[Pixel Agents] Agent ${agentId} tool start: ${block.id} ${status}`);
            agent.activeToolIds.add(block.id);
            agent.activeToolStatuses.set(block.id, status);
            agent.activeToolNames.set(block.id, toolName);
            if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
              hasNonExemptTool = true;
            }
            bridge?.send('agentToolStart', {
              id: agentId,
              toolId: block.id,
              status,
            });
          }
        }
        if (hasNonExemptTool) {
          startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, bridge);
        }
      } else if (blocks.some(b => b.type === 'text') && !agent.hadToolsInTurn) {
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, bridge);
      }
    } else if (record.type === 'progress') {
      processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers, bridge);
    } else if (record.type === 'user') {
      const content = record.message?.content;
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; tool_use_id?: string }>;
        const hasToolResult = blocks.some(b => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              console.log(`[Pixel Agents] Agent ${agentId} tool done: ${block.tool_use_id}`);
              const completedToolId = block.tool_use_id;
              if (agent.activeToolNames.get(completedToolId) === 'Task') {
                agent.activeSubagentToolIds.delete(completedToolId);
                agent.activeSubagentToolNames.delete(completedToolId);
                bridge?.send('subagentClear', {
                  id: agentId,
                  parentToolId: completedToolId,
                });
              }
              agent.activeToolIds.delete(completedToolId);
              agent.activeToolStatuses.delete(completedToolId);
              agent.activeToolNames.delete(completedToolId);
              const toolId = completedToolId;
              setTimeout(() => {
                bridge?.send('agentToolDone', { id: agentId, toolId });
              }, TOOL_DONE_DELAY_MS);
            }
          }
          if (agent.activeToolIds.size === 0) {
            agent.hadToolsInTurn = false;
          }
        } else {
          cancelWaitingTimer(agentId, waitingTimers);
          clearAgentActivity(agent, agentId, permissionTimers, bridge);
          agent.hadToolsInTurn = false;
        }
      } else if (typeof content === 'string' && content.trim()) {
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, permissionTimers, bridge);
        agent.hadToolsInTurn = false;
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);

      if (agent.activeToolIds.size > 0) {
        agent.activeToolIds.clear();
        agent.activeToolStatuses.clear();
        agent.activeToolNames.clear();
        agent.activeSubagentToolIds.clear();
        agent.activeSubagentToolNames.clear();
        bridge?.send('agentToolsClear', { id: agentId });
      }

      agent.isWaiting = true;
      agent.permissionSent = false;
      agent.hadToolsInTurn = false;
      bridge?.send('agentStatus', { id: agentId, status: 'waiting' });
    }
  } catch {
    // Ignore malformed lines
  }
}

// ── Codex JSONL parsing ──────────────────────────────────────

function processCodexRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  bridge: IpcBridge | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const recordType = record.type as string;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) return;

  const payloadType = payload.type as string;

  if (recordType === 'event_msg') {
    if (payloadType === 'task_started') {
      // New turn started — previous turn is done
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);

      if (agent.activeToolIds.size > 0) {
        agent.activeToolIds.clear();
        agent.activeToolStatuses.clear();
        agent.activeToolNames.clear();
        bridge?.send('agentToolsClear', { id: agentId });
      }

      agent.isWaiting = false;
      agent.permissionSent = false;
      agent.hadToolsInTurn = false;
      bridge?.send('agentStatus', { id: agentId, status: 'active' });
    } else if (payloadType === 'agent_reasoning') {
      // Agent is thinking — mark active
      cancelWaitingTimer(agentId, waitingTimers);
      agent.isWaiting = false;
      bridge?.send('agentStatus', { id: agentId, status: 'active' });
    } else if (payloadType === 'user_message') {
      // User sent a message — agent will be waiting until task_started
      agent.isWaiting = true;
      bridge?.send('agentStatus', { id: agentId, status: 'waiting' });
    }
  } else if (recordType === 'response_item') {
    if (payloadType === 'function_call') {
      // Tool invocation: exec_command, etc.
      const callId = payload.call_id as string;
      const toolName = payload.name as string || '';
      const args = payload.arguments as string || '';

      if (!callId) return;

      const status = formatCodexToolStatus(toolName, args);
      console.log(`[Pixel Agents] Codex agent ${agentId} tool start: ${callId} ${status}`);

      cancelWaitingTimer(agentId, waitingTimers);
      agent.isWaiting = false;
      agent.hadToolsInTurn = true;
      agent.activeToolIds.add(callId);
      agent.activeToolStatuses.set(callId, status);
      agent.activeToolNames.set(callId, toolName);

      bridge?.send('agentStatus', { id: agentId, status: 'active' });
      bridge?.send('agentToolStart', { id: agentId, toolId: callId, status });

      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, bridge);
    } else if (payloadType === 'function_call_output') {
      // Tool result for exec_command
      const callId = payload.call_id as string;
      if (!callId) return;

      console.log(`[Pixel Agents] Codex agent ${agentId} tool done: ${callId}`);
      agent.activeToolIds.delete(callId);
      agent.activeToolStatuses.delete(callId);
      agent.activeToolNames.delete(callId);

      const toolId = callId;
      setTimeout(() => {
        bridge?.send('agentToolDone', { id: agentId, toolId });
      }, TOOL_DONE_DELAY_MS);

      if (agent.activeToolIds.size === 0) {
        agent.hadToolsInTurn = false;
      }
    } else if (payloadType === 'custom_tool_call') {
      // Tool invocation: apply_patch, etc.
      const callId = payload.call_id as string;
      const toolName = payload.name as string || 'custom_tool';
      const input = payload.input as string || '';

      if (!callId) return;

      const status = formatCodexToolStatus(toolName, input);
      console.log(`[Pixel Agents] Codex agent ${agentId} tool start: ${callId} ${status}`);

      cancelWaitingTimer(agentId, waitingTimers);
      agent.isWaiting = false;
      agent.hadToolsInTurn = true;
      agent.activeToolIds.add(callId);
      agent.activeToolStatuses.set(callId, status);
      agent.activeToolNames.set(callId, toolName);

      bridge?.send('agentStatus', { id: agentId, status: 'active' });
      bridge?.send('agentToolStart', { id: agentId, toolId: callId, status });

      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, bridge);
    } else if (payloadType === 'custom_tool_call_output') {
      // Tool result for apply_patch, etc.
      const callId = payload.call_id as string;
      if (!callId) return;

      console.log(`[Pixel Agents] Codex agent ${agentId} tool done: ${callId}`);
      agent.activeToolIds.delete(callId);
      agent.activeToolStatuses.delete(callId);
      agent.activeToolNames.delete(callId);

      const toolId = callId;
      setTimeout(() => {
        bridge?.send('agentToolDone', { id: agentId, toolId });
      }, TOOL_DONE_DELAY_MS);

      if (agent.activeToolIds.size === 0) {
        agent.hadToolsInTurn = false;
      }
    } else if (payloadType === 'message') {
      // Text message — agent responding without tools
      const role = payload.role as string;
      if (role === 'assistant' && !agent.hadToolsInTurn) {
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, bridge);
      }
    }
  }
}

// ── Claude Code progress records (subagent tracking) ─────────

function processProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  bridge: IpcBridge | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return;

  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId)) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, bridge);
    }
    return;
  }

  if (agent.activeToolNames.get(parentToolId) !== 'Task') return;

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return;

  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return;

  if (msgType === 'assistant') {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        const toolName = block.name || '';
        const status = formatToolStatus(toolName, block.input || {});
        console.log(`[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`);

        let subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(parentToolId, subTools);
        }
        subTools.add(block.id);

        let subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(parentToolId, subNames);
        }
        subNames.set(block.id, toolName);

        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExemptSubTool = true;
        }

        bridge?.send('subagentToolStart', {
          id: agentId,
          parentToolId,
          toolId: block.id,
          status,
        });
      }
    }
    if (hasNonExemptSubTool) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, bridge);
    }
  } else if (msgType === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        console.log(`[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`);

        const subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (subTools) {
          subTools.delete(block.tool_use_id);
        }
        const subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (subNames) {
          subNames.delete(block.tool_use_id);
        }

        const toolId = block.tool_use_id;
        setTimeout(() => {
          bridge?.send('subagentToolDone', { id: agentId, parentToolId, toolId });
        }, TOOL_DONE_DELAY_MS);
      }
    }
    let stillHasNonExempt = false;
    for (const [, subNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subNames) {
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) break;
    }
    if (stillHasNonExempt) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, bridge);
    }
  }
}
