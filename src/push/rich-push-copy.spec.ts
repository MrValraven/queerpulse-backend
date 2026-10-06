import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RICH_PUSH_COPY_PT,
  localizeRichPayload,
  rendersIdentically,
} from './rich-push-copy';
import type { PushPayload } from './push.service';

function makePayload(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    title: 'New connection request',
    body: 'Mariana wants to connect with you.',
    tag: 'notification:1',
    data: { url: '/connections' },
    l10n: {
      titleKey: 'push:connection.request.title',
      bodyKey: 'push:connection.request.body',
      params: { name: 'Mariana' },
    },
    ...overrides,
  };
}

describe('localizeRichPayload (PRD-325)', () => {
  it('renders the title and body from the Portuguese catalog, interpolating the params', () => {
    const localized = localizeRichPayload(makePayload(), RICH_PUSH_COPY_PT);

    expect(localized.title).toBe('Novo pedido de conexão');
    expect(localized.body).toBe('Mariana quer ligar-se a ti.');
  });

  it('keeps the l10n keys and every other field as they were', () => {
    const payload = makePayload({ icon: 'https://images.example/a.jpg' });

    const localized = localizeRichPayload(payload, RICH_PUSH_COPY_PT);

    expect(localized.l10n).toEqual(payload.l10n);
    expect(localized.tag).toBe(payload.tag);
    expect(localized.data).toEqual(payload.data);
    expect(localized.icon).toBe(payload.icon);
  });

  it('keeps the English text for a field whose key is absent or unknown', () => {
    const payload = makePayload({
      title: 'Mariana',
      body: 'are you still coming on Thursday?',
      l10n: { bodyKey: 'push:unknown.key' },
    });

    const localized = localizeRichPayload(payload, RICH_PUSH_COPY_PT);

    expect(localized.title).toBe('Mariana');
    expect(localized.body).toBe('are you still coming on Thursday?');
    expect(rendersIdentically(payload, localized)).toBe(true);
  });

  it('keeps the English title when a title token stays unresolved', () => {
    const payload = makePayload({
      title: 'Casa Rosa',
      body: 'hello',
      l10n: {
        titleKey: 'push:messages.staffTitle',
        params: { name: 'Rui' },
      },
    });

    const localized = localizeRichPayload(payload, RICH_PUSH_COPY_PT);

    expect(localized.title).toBe('Casa Rosa');
  });

  it('localizes an action label that carries a titleKey', () => {
    const payload = makePayload({
      actions: [
        {
          action: 'view',
          title: 'Details',
          titleKey: 'push:event.reminder.actionDetails',
        },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    });

    const localized = localizeRichPayload(payload, RICH_PUSH_COPY_PT);

    expect(localized.actions).toEqual([
      {
        action: 'view',
        title: 'Detalhes',
        titleKey: 'push:event.reminder.actionDetails',
      },
      { action: 'dismiss', title: 'Dismiss' },
    ]);
  });

  it('reports a translated payload as rendering differently', () => {
    const payload = makePayload();

    expect(
      rendersIdentically(
        payload,
        localizeRichPayload(payload, RICH_PUSH_COPY_PT),
      ),
    ).toBe(false);
  });
});

/**
 * Every rich push key a listener sends must have Portuguese copy, or a
 * Portuguese member's iPhone prints the English text. The keys are read from
 * the listener sources themselves, so a new push picks this check up without
 * anyone remembering to list it here.
 */
describe('RICH_PUSH_COPY_PT coverage of the push listeners (PRD-325)', () => {
  const LISTENER_SOURCES = [
    join(__dirname, 'push-notification.listener.ts'),
    join(__dirname, 'push.listener.ts'),
    join(__dirname, '..', 'events', 'event-reminders.service.ts'),
  ];
  const QUOTED_PUSH_KEY = /'(push:[A-Za-z0-9_.]+)'/g;
  const TEMPLATED_PUSH_KEY = /`push:[^`]*`/g;
  const HOUSING_DECISION_TITLE_TEMPLATE =
    '`push:housing.decision.${copy.key}.title`';
  const HOUSING_DECISION_BODY_TEMPLATE =
    '`push:housing.decision.${copy.key}.body`';

  const sources = LISTENER_SOURCES.map((path) => readFileSync(path, 'utf8'));

  /** `pushHousingDecision` builds its keys from each decision's `key`, so
   *  those are read from its own `COPY` table and expanded here. */
  function housingDecisionKeys(): string[] {
    const listenerSource = sources[0] ?? '';
    const start = listenerSource.indexOf('private async pushHousingDecision(');
    const end = listenerSource.indexOf(HOUSING_DECISION_TITLE_TEMPLATE, start);
    const copyTable = listenerSource.slice(start, end);
    const decisionKeys = [...copyTable.matchAll(/key: '(\w+)'/g)].map(
      (match) => match[1] ?? '',
    );
    return decisionKeys.flatMap((decisionKey) => [
      `push:housing.decision.${decisionKey}.title`,
      `push:housing.decision.${decisionKey}.body`,
    ]);
  }

  it('reads the listener sources (a scan that matched nothing would pass vacuously)', () => {
    const quotedKeys = new Set(
      sources.flatMap((source) =>
        [...source.matchAll(QUOTED_PUSH_KEY)].map((match) => match[1]),
      ),
    );
    expect(quotedKeys.size).toBeGreaterThan(80);
    expect(housingDecisionKeys()).toHaveLength(8);
  });

  it('only builds keys from a template in the one place this check expands', () => {
    const templatedKeys = sources.flatMap((source) =>
      [...source.matchAll(TEMPLATED_PUSH_KEY)].map((match) => match[0]),
    );
    // A new templated key needs its own expansion above; add it there and
    // to this list together.
    expect(templatedKeys.sort()).toEqual(
      [HOUSING_DECISION_BODY_TEMPLATE, HOUSING_DECISION_TITLE_TEMPLATE].sort(),
    );
  });

  it('has Portuguese copy for every rich push key a listener sends', () => {
    const listenerKeys = new Set([
      ...sources.flatMap((source) =>
        [...source.matchAll(QUOTED_PUSH_KEY)].map((match) => match[1] ?? ''),
      ),
      ...housingDecisionKeys(),
    ]);

    const missingKeys = [...listenerKeys].filter(
      (key) => RICH_PUSH_COPY_PT[key] === undefined,
    );

    expect(missingKeys).toEqual([]);
  });
});
