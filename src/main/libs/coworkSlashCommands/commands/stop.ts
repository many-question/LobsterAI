import type { CoworkSlashCommandContext, CoworkSlashCommandModule } from '../types';

const stopCommand: CoworkSlashCommandModule = {
  command: {
    name: 'stop',
    description: 'Stop the current agent run or command execution.',
    usage: '/stop',
  },
  execute(context: CoworkSlashCommandContext) {
    if (!context.currentSessionId) {
      return {
        ok: false,
        output: 'No active cowork session to stop.',
      };
    }

    return {
      ok: true,
      output: context.isStreaming
        ? 'Stopping the current cowork run.'
        : 'The current session is not running, but a stop request was sent.',
      actions: [{ type: 'stop_current_session' }],
    };
  },
};

export default stopCommand;
