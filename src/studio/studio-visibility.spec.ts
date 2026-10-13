import { listenablePersonaSql } from './studio-visibility';

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
});
