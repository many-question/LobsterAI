import { app } from 'electron';
import os from 'os';
import type { CoworkConfig, CoworkExecutionMode, CoworkMessage, CoworkSession, CoworkSessionStatus } from '../coworkStore';
import type { CoworkRuntime } from './agentEngine/types';
import { getCurrentModelSelection } from './claudeSettings';

export interface CoworkStatusModelSnapshot {
  name: string | null;
  id: string | null;
  providerKey: string | null;
  supportsImage: boolean | null;
  supportsTools: boolean | null;
}

export interface CoworkStatusThreadSnapshot {
  title: string | null;
  sessionId: string | null;
  threadSeq: number | null;
  claudeSessionId: string | null;
  status: CoworkSessionStatus | null;
  messageCount: number;
  contextChars: number;
  estimatedContextTokens: number;
}

export interface CoworkStatusWorkspaceSnapshot {
  executionMode: CoworkExecutionMode | null;
  configuredExecutionMode: CoworkExecutionMode | null;
  cwd: string | null;
  configuredWorkingDirectory: string | null;
}

export interface CoworkStatusSystemSnapshot {
  collectedAt: number;
  platform: NodeJS.Platform;
  uptimeSeconds: number;
  cpu: {
    usagePercent: number | null;
    loadAverage: number[];
    coreCount: number;
    model: string | null;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    appRssBytes: number;
    appHeapUsedBytes: number;
    appHeapTotalBytes: number;
  };
  gpu: {
    hardwareAccelerationEnabled: boolean;
    featureStatus: Record<string, string>;
    adapters: Array<{
      active: boolean;
      name: string;
      vendor: string | null;
      driverVendor: string | null;
      driverVersion: string | null;
      videoMemoryBytes: number | null;
    }>;
  };
  network: {
    online: boolean | null;
    interfaceCount: number;
    addresses: string[];
    totalRxBytes: number | null;
    totalTxBytes: number | null;
    rxRateBytesPerSecond: number | null;
    txRateBytesPerSecond: number | null;
    sampleWindowMs: number | null;
  };
}

export interface CoworkStatusAgentSnapshot {
  active: boolean;
  connected: boolean;
  isStreamingText: boolean;
  isStreamingThinking: boolean;
  streamingBlockType: 'thinking' | 'text' | null;
  pendingPermission: boolean;
  confirmationMode: 'modal' | 'text' | null;
  executionMode: CoworkExecutionMode | null;
  lastTurnUsage: {
    observedAt: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadInputTokens: number | null;
    cacheCreationInputTokens: number | null;
  } | null;
}

export interface CoworkSlashCommandStatusSnapshot {
  model: CoworkStatusModelSnapshot;
  thread: CoworkStatusThreadSnapshot;
  workspace: CoworkStatusWorkspaceSnapshot;
  system: CoworkStatusSystemSnapshot;
  agent: CoworkStatusAgentSnapshot;
}

function estimateTokenCountForText(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function estimateTokenCountForMessages(messages: CoworkMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokenCountForText(message.content), 0);
}

function getContextChars(messages: CoworkMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function getExternalNetworkAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (record.internal) continue;
      addresses.push(record.address);
    }
  }

  return addresses;
}

async function getGpuSnapshot(): Promise<CoworkStatusSystemSnapshot['gpu']> {
  const hardwareAccelerationEnabled =
    typeof app.isHardwareAccelerationEnabled === 'function'
      ? app.isHardwareAccelerationEnabled()
      : true;
  const featureStatus = typeof app.getGPUFeatureStatus === 'function'
    ? app.getGPUFeatureStatus()
    : {};

  let adapters: CoworkStatusSystemSnapshot['gpu']['adapters'] = [];
  if (typeof app.getGPUInfo === 'function') {
    try {
      const info = await app.getGPUInfo('basic') as Record<string, unknown>;
      const rawDevices = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
      adapters = rawDevices.map((device) => {
        const record = device as Record<string, unknown>;
        const videoMemoryMb = Number(record.video_memory ?? record.videoMemory ?? NaN);
        return {
          active: Boolean(record.active),
          name: typeof record.deviceString === 'string' ? record.deviceString : 'Unknown GPU',
          vendor: typeof record.vendorString === 'string' ? record.vendorString : null,
          driverVendor: typeof record.driverVendor === 'string' ? record.driverVendor : null,
          driverVersion: typeof record.driverVersion === 'string' ? record.driverVersion : null,
          videoMemoryBytes: Number.isFinite(videoMemoryMb) ? Math.round(videoMemoryMb * 1024 * 1024) : null,
        };
      });
    } catch {
      adapters = [];
    }
  }

  return {
    hardwareAccelerationEnabled,
    featureStatus,
    adapters,
  };
}

async function getSystemSnapshot(): Promise<CoworkStatusSystemSnapshot> {
  const addresses = getExternalNetworkAddresses();
  const memoryUsage = process.memoryUsage();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();

  return {
    collectedAt: Date.now(),
    platform: process.platform,
    uptimeSeconds: os.uptime(),
    cpu: {
      usagePercent: null,
      loadAverage: os.loadavg(),
      coreCount: os.cpus().length,
      model: os.cpus()[0]?.model ?? null,
    },
    memory: {
      totalBytes,
      freeBytes,
      usedBytes: totalBytes - freeBytes,
      appRssBytes: memoryUsage.rss,
      appHeapUsedBytes: memoryUsage.heapUsed,
      appHeapTotalBytes: memoryUsage.heapTotal,
    },
    gpu: await getGpuSnapshot(),
    network: {
      online: addresses.length > 0 ? true : null,
      interfaceCount: Object.keys(os.networkInterfaces()).length,
      addresses: addresses.slice(0, 4),
      totalRxBytes: null,
      totalTxBytes: null,
      rxRateBytesPerSecond: null,
      txRateBytesPerSecond: null,
      sampleWindowMs: null,
    },
  };
}

function buildModelSnapshot(): CoworkStatusModelSnapshot {
  const selection = getCurrentModelSelection();
  return {
    name: selection?.name ?? null,
    id: selection?.id ?? null,
    providerKey: selection?.providerKey ?? null,
    supportsImage: selection?.supportsImage ?? null,
    supportsTools: selection?.supportsTools ?? null,
  };
}

function buildThreadSnapshot(session: CoworkSession | null): CoworkStatusThreadSnapshot {
  const messages = session?.messages ?? [];
  return {
    title: session?.title ?? null,
    sessionId: session?.id ?? null,
    threadSeq: session?.threadSeq ?? null,
    claudeSessionId: session?.claudeSessionId ?? null,
    status: session?.status ?? null,
    messageCount: messages.length,
    contextChars: getContextChars(messages),
    estimatedContextTokens: estimateTokenCountForMessages(messages),
  };
}

function buildWorkspaceSnapshot(session: CoworkSession | null, config: CoworkConfig | null): CoworkStatusWorkspaceSnapshot {
  return {
    executionMode: session?.executionMode ?? config?.executionMode ?? null,
    configuredExecutionMode: config?.executionMode ?? null,
    cwd: session?.cwd ?? config?.workingDirectory ?? null,
    configuredWorkingDirectory: config?.workingDirectory ?? null,
  };
}

function buildAgentSnapshot(runtime: CoworkRuntime | null, session: CoworkSession | null): CoworkStatusAgentSnapshot {
  const sessionId = session?.id ?? null;
  const active = sessionId ? runtime?.isSessionActive(sessionId) ?? false : false;

  return {
    active,
    connected: active,
    isStreamingText: false,
    isStreamingThinking: false,
    streamingBlockType: null,
    pendingPermission: false,
    confirmationMode: sessionId ? runtime?.getSessionConfirmationMode(sessionId) ?? null : null,
    executionMode: session?.executionMode ?? null,
    lastTurnUsage: null,
  };
}

export async function getCoworkSlashCommandStatusSnapshot(options: {
  config: CoworkConfig | null;
  session: CoworkSession | null;
  runtime: CoworkRuntime | null;
}): Promise<CoworkSlashCommandStatusSnapshot> {
  return {
    model: buildModelSnapshot(),
    thread: buildThreadSnapshot(options.session),
    workspace: buildWorkspaceSnapshot(options.session, options.config),
    system: await getSystemSnapshot(),
    agent: buildAgentSnapshot(options.runtime, options.session),
  };
}
