import { personaCreatorActiveSql } from '../subprofiles/persona-creator-gates';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import {
  isReleaseWithdrawnForListeners,
  listenablePersonaSql,
  listenablePersonaStateSql,
  previewablePersonaSql,
  withdrawnReleaseSql,
} from './studio-visibility';

describe('listenablePersonaSql', () => {
  const predicate = listenablePersonaSql('persona');

  it('needs a published, unremoved, open persona with a handle', () => {
    expect(predicate).toContain(`"persona"."status" = 'published'`);
    expect(predicate).toContain(`"persona"."removed_at" IS NULL`);
    expect(predicate).toContain(`"persona"."handle" IS NOT NULL`);
    expect(predicate).toContain(`"persona"."visibility" = 'open'`);
  });

  it('leaves out network and private personas', () => {
    expect(predicate).not.toContain(`'network'`);
    expect(predicate).not.toContain(`'private'`);
    expect(predicate).not.toContain(`"visibility" <>`);
  });

  it('drops a persona under a hidden or removed moderator takedown, keyed by its uuid as text', () => {
    expect(predicate).toContain(`"subject_type" = 'subprofile'`);
    expect(predicate).toContain(`= "persona"."id"::text`);
    expect(predicate).toContain(`"hidden_at" IS NOT NULL`);
    expect(predicate).toContain(`"removed_at" IS NOT NULL`);
  });

  it('quotes the alias it is given', () => {
    expect(listenablePersonaSql('artist')).toContain(`"artist"."status"`);
  });

  // SEC-33: a suspended, banned, paused or erasure-pending creator's persona
  // leaves every listener read, as `/p/<handle>` answers 404.
  it('needs the persona creator account to be active', () => {
    expect(predicate).toContain(personaCreatorActiveSql('persona'));
    expect(predicate).toContain(`"persona_creator"."id" = "persona"."user_id"`);
    expect(predicate).toContain(`"persona_creator"."status" = 'active'`);
  });

  it('is the persona state rule plus the creator account rule', () => {
    expect(predicate).toContain(listenablePersonaStateSql('persona'));
  });
});

describe('listenablePersonaStateSql', () => {
  const predicate = listenablePersonaStateSql('persona');

  it('keeps the persona rules', () => {
    expect(predicate).toContain(`"persona"."status" = 'published'`);
    expect(predicate).toContain(`"persona"."removed_at" IS NULL`);
    expect(predicate).toContain(`"persona"."handle" IS NOT NULL`);
    expect(predicate).toContain(`"persona"."visibility" = 'open'`);
    expect(predicate).toContain(`= "persona"."id"::text`);
  });

  it('leaves the creator account out', () => {
    expect(predicate).not.toContain(personaCreatorActiveSql('persona'));
    expect(predicate).not.toContain('"users"');
  });
});

describe('withdrawnReleaseSql', () => {
  const predicate = withdrawnReleaseSql('release', 'persona');

  it('needs a taken-down release that was live when it came down', () => {
    expect(predicate).toContain(`"release"."status" = 'taken_down'`);
    expect(predicate).toContain(`"release"."published_at" IS NOT NULL`);
  });

  it('needs a persona listeners can still hear', () => {
    expect(predicate).toContain(listenablePersonaSql('persona'));
  });

  it('quotes the aliases it is given', () => {
    expect(withdrawnReleaseSql('saved_release', 'artist')).toContain(
      `"saved_release"."status"`,
    );
    expect(withdrawnReleaseSql('saved_release', 'artist')).toContain(
      `"artist"."status"`,
    );
  });
});

describe('isReleaseWithdrawnForListeners', () => {
  const publishedAt = new Date('2026-10-01T09:00:00.000Z');

  it('reads a release taken down while live as withdrawn', () => {
    expect(
      isReleaseWithdrawnForListeners({
        status: StudioReleaseStatus.TakenDown,
        publishedAt,
      }),
    ).toBe(true);
  });

  it('reads a draft taken down, and every other status, as plain unavailable', () => {
    expect(
      isReleaseWithdrawnForListeners({
        status: StudioReleaseStatus.TakenDown,
        publishedAt: null,
      }),
    ).toBe(false);
    expect(
      isReleaseWithdrawnForListeners({
        status: StudioReleaseStatus.Published,
        publishedAt,
      }),
    ).toBe(false);
    expect(
      isReleaseWithdrawnForListeners({
        status: StudioReleaseStatus.Draft,
        publishedAt: null,
      }),
    ).toBe(false);
  });
});

describe('previewablePersonaSql', () => {
  const predicate = previewablePersonaSql('persona');

  it('needs a persona its owners have not removed and staff have not taken down', () => {
    expect(predicate).toContain(`"persona"."removed_at" IS NULL`);
    expect(predicate).toContain(`"subject_type" = 'subprofile'`);
    expect(predicate).toContain(`= "persona"."id"::text`);
  });

  it('lets a draft or private persona preview a release', () => {
    expect(predicate).not.toContain(`"status" = 'published'`);
    expect(predicate).not.toContain(`"visibility"`);
  });
});
