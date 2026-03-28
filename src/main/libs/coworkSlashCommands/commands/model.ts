import {
  getCurrentModelSelection,
  listAvailableConfiguredModels,
} from '../../claudeSettings';
import type { AvailableModelDescriptor } from '../../claudeSettings';
import type { CoworkSlashCommandContext, CoworkSlashCommandModule } from '../types';

type ModelCommandEntry = {
  numericId: number;
  model: AvailableModelDescriptor;
};

function buildModelCatalog(): {
  current: ModelCommandEntry | null;
  entries: ModelCommandEntry[];
} {
  const current = getCurrentModelSelection();
  const available = listAvailableConfiguredModels();
  const entries = available.map((model, index) => ({
    numericId: index + 1,
    model,
  }));

  const currentEntry = current == null
    ? null
    : (entries.find((entry) => (
      entry.model.id === current.id
      && entry.model.providerKey === current.providerKey
    )) ?? null);

  return {
    current: currentEntry,
    entries,
  };
}

function buildModelListOutput(): string {
  const catalog = buildModelCatalog();
  const lines = [
    catalog.current
      ? `Current model: #${catalog.current.numericId} ${catalog.current.model.name} (${catalog.current.model.providerKey})`
      : 'Current model: not configured',
    'Available models:',
  ];

  if (catalog.entries.length === 0) {
    lines.push('- none');
    return lines.join('\n');
  }

  for (const entry of catalog.entries) {
    const prefix = catalog.current?.numericId === entry.numericId ? '* ' : '- ';
    lines.push(`${prefix}#${entry.numericId} ${entry.model.name} (${entry.model.providerKey})`);
  }

  lines.push('');
  lines.push('Usage: /model <number>');
  lines.push('Usage: /model <rawModelId>');
  lines.push('Usage: /model --provider <providerKey> <rawModelId>');
  return lines.join('\n');
}

const modelCommand: CoworkSlashCommandModule = {
  command: {
    name: 'model',
    description: 'List available models or switch the active model.',
    usage: '/model [<number>|<rawModelId>]',
  },
  async execute(context: CoworkSlashCommandContext) {
    const { positionals, options } = context.invocation.parsed;
    const requestedValue = positionals[0]?.trim();
    const providerKey = typeof options.provider === 'string'
      ? options.provider.trim()
      : (typeof options.p === 'string' ? options.p.trim() : undefined);

    if (!requestedValue) {
      return {
        ok: true,
        output: buildModelListOutput(),
      };
    }

    const catalog = buildModelCatalog();
    let modelId = requestedValue;
    let resolvedProviderKey = providerKey;

    if (/^\d+$/.test(requestedValue)) {
      const entry = catalog.entries.find((item) => item.numericId === Number.parseInt(requestedValue, 10));
      if (!entry) {
        return {
          ok: false,
          output: `Model number not found: ${requestedValue}`,
        };
      }
      modelId = entry.model.id;
      resolvedProviderKey = entry.model.providerKey;
    }

    const { selected, error } = await context.setModelSelection({
      modelId,
      providerKey: resolvedProviderKey,
    });

    if (!selected) {
      return {
        ok: false,
        output: error || 'Failed to switch model.',
        actions: [{ type: 'refresh_model_state' }],
      };
    }

    return {
      ok: true,
      output: `Switched model to ${selected.name} (${selected.providerKey})`,
      actions: [{ type: 'refresh_model_state' }],
    };
  },
};

export default modelCommand;
