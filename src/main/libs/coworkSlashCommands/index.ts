import helpCommand from './commands/help';
import modelCommand from './commands/model';
import newCommand from './commands/new';
import statusCommand from './commands/status';
import stopCommand from './commands/stop';
import threadCommand from './commands/thread';
import type {
  CoworkSlashCommandConfigStore,
  CoworkSlashCommandContext,
  CoworkSlashCommandDescriptor,
  CoworkSlashCommandExecutionResult,
  CoworkSlashCommandInvocation,
  CoworkSlashCommandModule,
  CoworkSlashParsedArgs,
  CoworkSlashParsedOption,
} from './types';

const BUILTIN_COMMANDS: CoworkSlashCommandModule[] = [
  helpCommand,
  modelCommand,
  newCommand,
  statusCommand,
  stopCommand,
  threadCommand,
];

function normalizeCommandName(value: string): string {
  return value.trim().replace(/^\/+/, '').toLowerCase();
}

function tokenizeCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += '\\';
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function parseCommandArgs(argsText: string): CoworkSlashParsedArgs {
  const argv = tokenizeCommandArgs(argsText);
  const positionals: string[] = [];
  const named: CoworkSlashParsedOption[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    const normalized = token.replace(/^-+/, '');
    if (!normalized) {
      positionals.push(token);
      continue;
    }

    const eqIndex = normalized.indexOf('=');
    if (eqIndex >= 0) {
      const optionName = normalized.slice(0, eqIndex);
      const optionValue = normalized.slice(eqIndex + 1);
      options[optionName] = optionValue;
      named.push({ name: optionName, value: optionValue });
      continue;
    }

    const nextToken = argv[index + 1];
    const hasValue = typeof nextToken === 'string' && (!nextToken.startsWith('-') || nextToken === '-');
    const optionValue = hasValue ? nextToken : true;
    options[normalized] = optionValue;
    named.push({ name: normalized, value: optionValue });
    if (hasValue) {
      index += 1;
    }
  }

  return {
    argv,
    positionals,
    options,
    named,
  };
}

function parseSlashCommandInvocation(input: string): CoworkSlashCommandInvocation | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const match = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return {
      rawInput: trimmed,
      rawName: '',
      name: '',
      args: '',
      parsed: { argv: [], positionals: [], options: {}, named: [] },
    };
  }

  const args = match[2]?.trim() ?? '';
  return {
    rawInput: trimmed,
    rawName: match[1],
    name: normalizeCommandName(match[1]),
    args,
    parsed: parseCommandArgs(args),
  };
}

function dedupeDescriptors(commands: CoworkSlashCommandModule[]): CoworkSlashCommandDescriptor[] {
  const seen = new Set<string>();
  const descriptors: CoworkSlashCommandDescriptor[] = [];

  for (const module of commands) {
    const normalizedName = normalizeCommandName(module.command.name);
    if (seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    descriptors.push({
      name: normalizedName,
      aliases: module.command.aliases?.map(normalizeCommandName).filter(Boolean),
      description: module.command.description.trim(),
      usage: module.command.usage.trim(),
    });
  }

  return descriptors.sort((left, right) => left.name.localeCompare(right.name));
}

function findCommandModule(
  modules: CoworkSlashCommandModule[],
  commandName: string
): CoworkSlashCommandModule | null {
  for (const module of modules) {
    if (normalizeCommandName(module.command.name) === commandName) {
      return module;
    }
    if (module.command.aliases?.some((alias) => normalizeCommandName(alias) === commandName)) {
      return module;
    }
  }
  return null;
}

export async function executeCoworkSlashCommand(input: string, options: {
  currentSessionId?: string | null;
  isStreaming?: boolean;
  configStore?: CoworkSlashCommandConfigStore | null;
  getStatusSnapshot?: () => Promise<import('../coworkStatus').CoworkSlashCommandStatusSnapshot>;
} = {}): Promise<CoworkSlashCommandExecutionResult> {
  const invocation = parseSlashCommandInvocation(input);
  if (!invocation) {
    return { handled: false };
  }

  const commands = dedupeDescriptors(BUILTIN_COMMANDS);
  if (!invocation.name) {
    return {
      handled: true,
      commandName: '',
      ok: false,
      output: 'Invalid slash command. Use /help to see supported commands.',
      commands,
    };
  }

  const commandModule = findCommandModule(BUILTIN_COMMANDS, invocation.name);
  if (!commandModule) {
    return {
      handled: true,
      commandName: invocation.name,
      ok: false,
      output: `Unknown slash command: /${invocation.rawName || invocation.name}\nUse /help to see supported commands.`,
      commands,
    };
  }

  const context: CoworkSlashCommandContext = {
    invocation,
    listCommands: () => commands,
    currentSessionId: options.currentSessionId ?? null,
    isStreaming: options.isStreaming ?? false,
    getConfig: () => options.configStore?.getConfig() ?? null,
    updateConfig: (config) => {
      options.configStore?.setConfig(config);
    },
    getCurrentSession: () => {
      const currentSessionId = options.currentSessionId ?? null;
      if (!currentSessionId) return null;
      return options.configStore?.getSession(currentSessionId) ?? null;
    },
    listSessions: () => options.configStore?.listSessions() ?? [],
    getStatusSnapshot: () => {
      if (options.getStatusSnapshot) {
        return options.getStatusSnapshot();
      }
      throw new Error('Status snapshot provider is unavailable.');
    },
  };

  const executed = await commandModule.execute(context);
  return {
    handled: true,
    commandName: normalizeCommandName(commandModule.command.name),
    ok: executed.ok,
    output: executed.output,
    actions: executed.actions,
    commands: executed.commands ?? commands,
  };
}
