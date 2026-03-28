import type { CoworkSlashCommandContext, CoworkSlashCommandModule } from '../types';

function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : (value >= 10 ? 1 : 2);
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatBoolean(value: boolean): string {
  return value ? 'yes' : 'no';
}

function shouldShowDetail(context: CoworkSlashCommandContext): boolean {
  const { positionals, options } = context.invocation.parsed;
  const firstPositional = positionals[0]?.trim().toLowerCase();
  return firstPositional === 'detail'
    || options.detail === true
    || options.d === true;
}

const statusCommand: CoworkSlashCommandModule = {
  command: {
    name: 'status',
    description: 'Show the current model, thread, workspace, system, and agent status.',
    usage: '/status [detail]',
  },
  async execute(context: CoworkSlashCommandContext) {
    const snapshot = await context.getStatusSnapshot();
    const modelLabel = snapshot.model.name
      ? `${snapshot.model.name} (${snapshot.model.providerKey ?? 'unknown'})`
      : 'not configured';
    const threadId = snapshot.thread.threadSeq != null ? `#${snapshot.thread.threadSeq}` : 'n/a';

    if (!shouldShowDetail(context)) {
      return {
        ok: true,
        output: [
          `Model: ${modelLabel}`,
          `Thread: ${(snapshot.thread.title ?? 'unavailable')} (${threadId})`,
          `Messages: ${snapshot.thread.messageCount}, ~${snapshot.thread.estimatedContextTokens.toLocaleString()} ctx tokens`,
          `Mode: ${snapshot.workspace.executionMode ?? snapshot.workspace.configuredExecutionMode ?? 'unavailable'}`,
        ].join('\n'),
      };
    }

    return {
      ok: true,
      output: [
        `Model: ${modelLabel}`,
        `- Model ID: ${snapshot.model.id ?? 'unavailable'}`,
        'Thread',
        `- Title: ${snapshot.thread.title ?? 'unavailable'}`,
        `- Local session ID: ${snapshot.thread.sessionId ?? 'unavailable'}`,
        `- Thread short ID: ${threadId}`,
        `- Claude thread ID: ${snapshot.thread.claudeSessionId ?? 'not established'}`,
        `- Session status: ${snapshot.thread.status ?? 'unavailable'}`,
        `- Context: ${snapshot.thread.messageCount} messages, ${snapshot.thread.contextChars.toLocaleString()} chars, ~${snapshot.thread.estimatedContextTokens.toLocaleString()} tokens`,
        'Workspace',
        `- Active mode: ${snapshot.workspace.executionMode ?? 'unavailable'}`,
        `- Configured mode: ${snapshot.workspace.configuredExecutionMode ?? 'unavailable'}`,
        `- Current cwd: ${snapshot.workspace.cwd ?? 'unavailable'}`,
        `- Configured working directory: ${snapshot.workspace.configuredWorkingDirectory ?? 'unavailable'}`,
        'Agent',
        `- Active: ${formatBoolean(snapshot.agent.active)}`,
        `- Connected: ${formatBoolean(snapshot.agent.connected)}`,
        `- Confirmation mode: ${snapshot.agent.confirmationMode ?? 'unavailable'}`,
        'System',
        `- Platform: ${snapshot.system.platform}, uptime=${Math.round(snapshot.system.uptimeSeconds).toLocaleString()}s`,
        `- CPU cores: ${snapshot.system.cpu.coreCount}, load=${snapshot.system.cpu.loadAverage.map((value) => value.toFixed(2)).join(', ') || 'unavailable'}`,
        `- Memory: ${formatBytes(snapshot.system.memory.usedBytes)} / ${formatBytes(snapshot.system.memory.totalBytes)} used, app RSS=${formatBytes(snapshot.system.memory.appRssBytes)}`,
        `- GPU acceleration: ${formatBoolean(snapshot.system.gpu.hardwareAccelerationEnabled)}`,
        `- Network addresses: ${snapshot.system.network.addresses.join(', ') || 'unavailable'}`,
      ].join('\n'),
    };
  },
};

export default statusCommand;
