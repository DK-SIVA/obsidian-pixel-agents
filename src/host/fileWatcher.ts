import * as fs from 'fs';
import type { AgentState, IpcBridge } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS } from './constants.js';

export function startFileWatching(
  agentId: number,
  filePath: string,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  bridge: IpcBridge | undefined,
): void {
  // Primary: fs.watch
  try {
    const watcher = fs.watch(filePath, () => {
      readNewLines(agentId, agents, waitingTimers, permissionTimers, bridge);
    });
    fileWatchers.set(agentId, watcher);
  } catch (e) {
    console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
  }

  // Backup: poll every 2s
  const interval = setInterval(() => {
    if (!agents.has(agentId)) { clearInterval(interval); return; }
    readNewLines(agentId, agents, waitingTimers, permissionTimers, bridge);
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export function readNewLines(
  agentId: number,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  bridge: IpcBridge | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    const buf = Buffer.alloc(stat.size - agent.fileOffset);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset = stat.size;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some(l => l.trim());
    if (hasLines) {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      if (agent.permissionSent) {
        agent.permissionSent = false;
        bridge?.send('agentToolPermissionClear', { id: agentId });
      }
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, bridge);
    }
  } catch (e) {
    console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
  }
}

export function stopFileWatching(
  agentId: number,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) { clearInterval(pt); }
  pollingTimers.delete(agentId);
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
}
