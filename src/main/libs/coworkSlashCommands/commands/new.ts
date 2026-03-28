import type { CoworkSlashCommandModule } from '../types';

const newCommand: CoworkSlashCommandModule = {
  command: {
    name: 'new',
    description: 'Create a new empty cowork context.',
    usage: '/new',
  },
  execute() {
    return {
      ok: true,
      output: 'Opened a new context.',
      actions: [{ type: 'new_chat' }],
    };
  },
};

export default newCommand;
