import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import {
  EXPORT_WITHHELD_TEXT_KEYS,
  NEW_DOMAIN_EXPORT_CONTRIBUTORS,
} from './data-export-contributors';
import { PersonaPostsExportContributor } from './data-export-contributors-persona-posts';
import { EXPORT_CSV_CATEGORIES } from './export-archive';

const USER_ID = '73000000-0000-4000-8000-000000000001';

describe('PersonaPostsExportContributor', () => {
  let query: jest.Mock;
  let contributor: PersonaPostsExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new PersonaPostsExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('rides on the subprofiles category under its own archive key', () => {
    expect(contributor.category).toBe('subprofiles');
    expect(contributor.archiveKey).toBe('personaPosts');
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      PersonaPostsExportContributor,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    expect(csvKeys.indexOf('personaPosts')).toBe(
      csvKeys.indexOf('studioReleaseReminders') + 1,
    );
  });

  it('writes the posts the member wrote, with the persona name and both dates', async () => {
    query.mockResolvedValueOnce([
      {
        persona_name: 'Night Shift',
        body: 'New single out Friday',
        link_url: 'https://nightshift.bandcamp.com',
        created_at: new Date('2026-10-13T09:00:00.000Z'),
        edited_at: new Date('2026-10-13T10:00:00.000Z'),
      },
      {
        persona_name: 'Night Shift',
        body: 'Thank you Lisbon',
        link_url: null,
        created_at: new Date('2026-10-14T09:00:00.000Z'),
        edited_at: null,
      },
    ]);

    expect(await contributor.buildContribution(USER_ID)).toEqual([
      {
        personaName: 'Night Shift',
        body: 'New single out Friday',
        linkUrl: 'https://nightshift.bandcamp.com',
        createdAt: '2026-10-13T09:00:00.000Z',
        editedAt: '2026-10-13T10:00:00.000Z',
      },
      {
        personaName: 'Night Shift',
        body: 'Thank you Lisbon',
        linkUrl: null,
        createdAt: '2026-10-14T09:00:00.000Z',
        editedAt: null,
      },
    ]);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"post"."author_user_id" = $1');
    expect(parameters).toEqual([USER_ID]);
  });

  it('withholds the post excerpt from a follower exported notifications', () => {
    expect(EXPORT_WITHHELD_TEXT_KEYS[NotificationType.PersonaPost]).toEqual([
      'excerpt',
    ]);
  });
});
