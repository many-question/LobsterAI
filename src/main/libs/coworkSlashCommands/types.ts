import type { CoworkConfig, CoworkConfigUpdate, CoworkSession, CoworkSessionSummary } from '../../coworkStore';
import type { CoworkSlashCommandStatusSnapshot } from '../coworkStatus';

export interface CoworkSlashCommandDescriptor {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
}

export interface CoworkSlashParsedOption {
  name: string;
  value: string | boolean;
}

export interface CoworkSlashParsedArgs {
  argv: string[];
  positionals: string[];
  options: Record<string, string | boolean>;
  named: CoworkSlashParsedOption[];
}

export interface CoworkSlashCommandInvocation {
  rawInput: string;
  rawName: string;
  name: string;
  args: string;
  parsed: CoworkSlashParsedArgs;
}

export interface CoworkSlashCommandUiAction {
  type: 'new_chat' | 'stop_current_session' | 'refresh_model_state' | 'refresh_cowork_config' | 'open_session';
  sessionId?: string;
}

export interface CoworkSlashCommandExecutionResult {
  handled: boolean;
  commandName?: string;
  ok?: boolean;
  output?: string;
  actions?: CoworkSlashCommandUiAction[];
  commands?: CoworkSlashCommandDescriptor[];
}

export interface CoworkSlashCommandContext {
  invocation: CoworkSlashCommandInvocation;
  listCommands: () => CoworkSlashCommandDescriptor[];
  currentSessionId: string | null;
  isStreaming: boolean;
  getConfig: () => CoworkConfig | null;
  updateConfig: (config: CoworkConfigUpdate) => void;
  getCurrentSession: () => CoworkSession | null;
  listSessions: () => CoworkSessionSummary[];
  getStatusSnapshot: () => Promise<CoworkSlashCommandStatusSnapshot>;
}

export interface CoworkSlashCommandConfigStore {
  getConfig: () => CoworkConfig;
  setConfig: (config: CoworkConfigUpdate) => void;
  getSession: (sessionId: string) => CoworkSession | null;
  listSessions: () => CoworkSessionSummary[];
}

export interface CoworkSlashCommandModule {
  command: CoworkSlashCommandDescriptor;
  execute: (context: CoworkSlashCommandContext) =>
    Promise<Omit<CoworkSlashCommandExecutionResult, 'handled' | 'commandName'>>
    | Omit<CoworkSlashCommandExecutionResult, 'handled' | 'commandName'>;
}
