import type { CoworkSessionSummary } from '../../../coworkStore';
import type { CoworkSlashCommandContext, CoworkSlashCommandModule } from '../types';

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}${month}${day} ${hours}:${minutes}`;
}

function truncateTitle(title: string, maxLength = 36): string {
  const trimmed = title.trim() || '(untitled)';
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function sortByRecentActivity(sessions: CoworkSessionSummary[]): CoworkSessionSummary[] {
  return [...sessions].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return (right.threadSeq ?? 0) - (left.threadSeq ?? 0);
  });
}

function parseRequestedThreadId(context: CoworkSlashCommandContext): number | null {
  const requested = context.invocation.parsed.positionals[0]?.trim();
  if (!requested || requested.toLowerCase() === 'list') {
    return null;
  }
  if (!/^\d+$/.test(requested)) {
    return Number.NaN;
  }
  return Number.parseInt(requested, 10);
}

const threadCommand: CoworkSlashCommandModule = {
  command: {
    name: 'thread',
    description: 'List available threads or switch to a thread by its short id.',
    usage: '/thread [<id>]',
  },
  execute(context: CoworkSlashCommandContext) {
    const sessions = sortByRecentActivity(
      context.listSessions().filter((session) => session.threadSeq != null)
    );

    if (sessions.length === 0) {
      return {
        ok: true,
        output: 'No saved threads yet.',
      };
    }

    const requestedThreadId = parseRequestedThreadId(context);
    if (requestedThreadId === null) {
      const lines = ['Current thread:'];
      for (const session of sessions) {
        lines.push(`#${session.threadSeq ?? 0} | ${formatTimestamp(session.updatedAt)} | ${truncateTitle(session.title)}`);
        if (session.id === context.currentSessionId) {
          lines.push('--------------------------------');
        }
      }
      return {
        ok: true,
        output: lines.join('\n'),
      };
    }

    if (Number.isNaN(requestedThreadId)) {
      return {
        ok: false,
        output: 'Invalid thread id. Usage: /thread <id>',
      };
    }

    const matched = sessions.find((session) => session.threadSeq === requestedThreadId);
    if (!matched) {
      return {
        ok: false,
        output: `Thread not found: #${requestedThreadId}`,
      };
    }

    if (matched.id === context.currentSessionId) {
      return {
        ok: true,
        output: `Already on thread #${requestedThreadId}.`,
      };
    }

    return {
      ok: true,
      output: `Switched to thread #${requestedThreadId}.`,
      actions: [{ type: 'open_session', sessionId: matched.id }],
    };
  },
};

export default threadCommand;
