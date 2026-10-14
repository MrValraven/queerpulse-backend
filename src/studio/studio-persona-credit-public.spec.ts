import {
  RELEASE_CREDIT_SUMMARY_SQL,
  TRACK_PUBLIC_CREDITS_SQL,
  toPublicTrackCredits,
  toReleaseCreditSummary,
} from './studio-persona-credit-public';
import { episodeReleasedSql } from './studio-episode-rule';
import { playableTrackAudioSql } from './studio-playlist-visibility';

const personaColumns = (personaId: string, kind = 'dj') => ({
  persona_id: personaId,
  persona_handle: `handle-${personaId}`,
  persona_display_name: `Persona ${personaId}`,
  persona_kind: kind,
  persona_avatar_url: null,
});

describe('Studio public persona credits', () => {
  it('reads public credits through the listenable persona rule and the block filter on the credited persona', () => {
    for (const sql of [TRACK_PUBLIC_CREDITS_SQL, RELEASE_CREDIT_SUMMARY_SQL]) {
      expect(sql).toContain(`"credit"."status" = 'accepted'`);
      expect(sql).toContain(`"persona"."status" = 'published'`);
      expect(sql).toContain(`"persona"."visibility" = 'open'`);
      expect(sql).toContain('"persona"."removed_at" IS NULL');
      expect(sql).toContain('content_moderation');
      expect(sql).toContain('FROM "blocks" "credited_block"');
      expect(sql).not.toContain('"persona"."user_id" AS');
      expect(sql).toContain(`(${playableTrackAudioSql('track', 'release')})`);
      expect(sql).toContain('"track"."audio_key" IS NOT NULL');
    }
    expect(TRACK_PUBLIC_CREDITS_SQL).toContain('"credit"."track_id" = $2');
    expect(RELEASE_CREDIT_SUMMARY_SQL).toContain('"track"."release_id" = $2');
    expect(RELEASE_CREDIT_SUMMARY_SQL).toContain(
      'ORDER BY "track"."position" ASC',
    );
  });

  it('orders a track by role vocabulary, then by request order, and drops unknown roles', () => {
    const credits = toPublicTrackCredits([
      { role: 'mixing', ...personaColumns('first') },
      { role: 'featured', ...personaColumns('second', 'visual_artist') },
      { role: 'mixing', ...personaColumns('third') },
      { role: 'drums', ...personaColumns('fourth') },
    ]);
    expect(credits.map((credit) => [credit.role, credit.persona.id])).toEqual([
      ['featured', 'second'],
      ['mixing', 'first'],
      ['mixing', 'third'],
    ]);
    expect(credits[0]?.persona.isListenable).toBe(false);
    expect(credits[1]?.persona.isListenable).toBe(true);
  });

  it('summarises a release as one row per persona, by the first track that credits it, roles in vocabulary order', () => {
    const summary = toReleaseCreditSummary([
      { role: 'producer', ...personaColumns('river') },
      { role: 'featured', ...personaColumns('lia') },
      { role: 'featured', ...personaColumns('river') },
      { role: 'producer', ...personaColumns('river') },
    ]);
    expect(summary.map((row) => [row.persona.id, row.roles])).toEqual([
      ['river', ['featured', 'producer']],
      ['lia', ['featured']],
    ]);
  });

  // Studio artist kinds: a credit on a draft episode names nobody yet.
  it('reads credits of published episodes only, through the playable arm', () => {
    for (const sql of [TRACK_PUBLIC_CREDITS_SQL, RELEASE_CREDIT_SUMMARY_SQL]) {
      expect(sql).toContain(episodeReleasedSql('track', 'release'));
    }
  });
});
