import type { CoworkSlashCommandContext, CoworkSlashCommandModule } from '../types';

const helpCommand: CoworkSlashCommandModule = {
  command: {
    name: 'help',
    description: 'List all supported slash commands.',
    usage: '/help',
  },
  execute(context: CoworkSlashCommandContext) {
    const commands = context.listCommands();
    return {
      ok: true,
      output: [
        'Supported slash commands:',
        ...commands.map((command) => `- ${command.usage}: ${command.description}`),
      ].join('\n'),
      commands,
    };
  },
};

export default helpCommand;
