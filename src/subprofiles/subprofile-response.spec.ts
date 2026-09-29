import { toCardDTO, toItemView } from './subprofile-response';
import { SubprofileItem } from './entities/subprofile-item.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';

describe('toItemView', () => {
  it('exposes createdAt as an ISO string', () => {
    const item = Object.assign(new SubprofileItem(), {
      id: 'item-1',
      section: 'poems',
      title: 'Pecado',
      structured: { poem: [] },
      createdAt: new Date('2025-07-14T09:32:00.000Z'),
    });
    const view = toItemView(item, new Map());
    expect(view.createdAt).toBe('2025-07-14T09:32:00.000Z');
  });
});

describe('toCardDTO table summary', () => {
  // A Quest persona (game master), built the way this file builds its other
  // entity fixtures (`Object.assign(new ..., {...})`, only the fields
  // `toCardDTO` actually reads).
  const questRow = Object.assign(new Subprofile(), {
    id: 'sp-quest-1',
    handle: 'thedm',
    kind: SubprofileKind.GameMaster,
    displayName: 'The DM',
    avatarUrl: null,
    coverUrl: null,
    tagline: null,
    accent: null,
    availability: null,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    slug: 'thedm',
  });

  it('carries the table summary only when one is passed', () => {
    const card = toCardDTO(questRow, 0, [], 0, null, new Map(), null, {
      format: 'online',
      vibe: ['queer_led'],
    });
    expect(card.table).toEqual({ format: 'online', vibe: ['queer_led'] });
    expect(toCardDTO(questRow).table).toBeUndefined();
  });
});
