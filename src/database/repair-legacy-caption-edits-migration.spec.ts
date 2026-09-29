// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` both require every `src/migrations/*.ts` file, and
// requiring a spec there throws `describe is not defined` before any
// migration runs.
import { QueryRunner } from 'typeorm';
import { RepairLegacyCaptionEdits1823520000000 } from '../migrations/1823520000000-RepairLegacyCaptionEdits';

/**
 * `RepairLegacyCaptionEdits1823520000000.up()` against a scripted
 * `QueryRunner`: the first query returns the candidate rows, and every later
 * query is one batch `UPDATE` whose three parameter arrays (ids, bodies,
 * attachment JSON) this spec reads back. The row filter itself is SQL, so it
 * is pinned by the text of the candidate query.
 */

interface ScriptedCandidate {
  id: string;
  kind: 'image' | 'document' | 'gif';
  body: string;
  attachment: Record<string, unknown>;
  senderFallbackSample: string | null;
}

interface RecordedBatch {
  ids: string[];
  bodies: string[];
  attachments: Record<string, unknown>[];
}

function scriptedQueryRunner(candidates: ScriptedCandidate[]) {
  const statements: string[] = [];
  const batches: RecordedBatch[] = [];
  const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
    statements.push(sql);
    if (statements.length === 1) return candidates;
    const [ids, bodies, attachments] = parameters as [
      string[],
      string[],
      string[],
    ];
    batches.push({
      ids,
      bodies,
      attachments: attachments.map(
        (json) => JSON.parse(json) as Record<string, unknown>,
      ),
    });
    return [{ repairedCount: ids.length }];
  });
  return {
    queryRunner: { query } as unknown as QueryRunner,
    query,
    statements,
    batches,
  };
}

const PHOTO_ATTACHMENT = {
  url: 'message-image/user-1/photo.jpg',
  previewUrl: 'message-image/user-1/photo.jpg',
  width: 800,
  height: 600,
  provider: 'upload',
};

const DOCUMENT_ATTACHMENT = {
  url: 'message-document/user-1/lease.pdf',
  fileName: 'lease.pdf',
  byteSize: 2048,
  contentType: 'application/pdf',
  provider: 'upload',
};

const GIF_ATTACHMENT = {
  url: 'https://media.example/dance.gif',
  previewUrl: 'https://media.example/dance-small.gif',
  width: 320,
  height: 240,
  provider: 'klipy',
};

function candidate(
  overrides: Partial<ScriptedCandidate> & Pick<ScriptedCandidate, 'id'>,
): ScriptedCandidate {
  return {
    kind: 'image',
    body: 'Edited words',
    attachment: PHOTO_ATTACHMENT,
    senderFallbackSample: null,
    ...overrides,
  };
}

async function runUp(candidates: ScriptedCandidate[]) {
  const scripted = scriptedQueryRunner(candidates);
  await new RepairLegacyCaptionEdits1823520000000().up(scripted.queryRunner);
  return scripted;
}

describe('RepairLegacyCaptionEdits1823520000000', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe('the candidate query', () => {
    async function candidateSql(): Promise<string> {
      const { statements } = await runUp([]);
      return statements[0]!;
    }

    it('selects only edited, live photo, document and GIF messages', async () => {
      const sql = await candidateSql();

      expect(sql).toContain(`"m"."kind" IN ('image', 'document', 'gif')`);
      expect(sql).toContain('"m"."edited_at" IS NOT NULL');
      expect(sql).toContain('"m"."deleted_at" IS NULL');
    });

    it("skips an erased sender's message held as report evidence", async () => {
      const sql = await candidateSql();

      expect(sql).toContain('"m"."erased_sender_ref" IS NULL');
    });

    it('skips every body that still holds a known fallback label', async () => {
      const sql = await candidateSql();

      expect(sql).toContain(
        `"m"."body" NOT IN ('Photo', 'Foto', 'File', 'Ficheiro', 'GIF', 'Document', 'messages:attachments.fallbackText', 'messages:attachments.documentFallbackText')`,
      );
    });

    it('skips a row with no object attachment or a sticker-shaped one', async () => {
      const sql = await candidateSql();

      expect(sql).toContain('"m"."attachment" IS NOT NULL');
      expect(sql).toContain(`jsonb_typeof("m"."attachment") = 'object'`);
      expect(sql).toContain(`NOT ("m"."attachment" ? 'stickerId')`);
    });

    it('skips a message a moderator hid or removed', async () => {
      const sql = await candidateSql();

      expect(sql).toMatch(
        /NOT EXISTS \(\s*SELECT 1 FROM "content_moderation" "cm"\s*WHERE "cm"\."subject_type" = 'message'\s*AND "cm"\."subject_id" = "m"\."id"::text\s*AND \("cm"\."hidden_at" IS NOT NULL OR "cm"\."removed_at" IS NOT NULL\)/,
      );
    });

    it("samples the sender's newest unedited, live, own photo or document label", async () => {
      const sql = await candidateSql();

      expect(sql).toContain('"sample"."sender_id" = "m"."sender_id"');
      expect(sql).toContain(`"sample"."kind" IN ('image', 'document')`);
      expect(sql).toContain('"sample"."edited_at" IS NULL');
      expect(sql).toContain('"sample"."deleted_at" IS NULL');
      expect(sql).toContain('"sample"."forwarded" = false');
      expect(sql).toContain(
        `"sample"."body" IN ('Photo', 'Foto', 'File', 'Ficheiro')`,
      );
      expect(sql).toContain('ORDER BY "sample"."created_at" DESC');
    });

    it('locks the rows it is about to rewrite', async () => {
      const sql = await candidateSql();

      expect(sql).toContain('FOR UPDATE OF "m"');
    });
  });

  it('moves the edited body into the caption and restores the English label for each kind', async () => {
    const { batches } = await runUp([
      candidate({ id: 'photo', kind: 'image', body: 'Sunset at the pier' }),
      candidate({
        id: 'document',
        kind: 'document',
        body: 'Signed copy',
        attachment: DOCUMENT_ATTACHMENT,
      }),
      candidate({
        id: 'gif',
        kind: 'gif',
        body: 'Us on Friday',
        attachment: GIF_ATTACHMENT,
      }),
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0]!.ids).toEqual(['photo', 'document', 'gif']);
    expect(batches[0]!.bodies).toEqual(['Photo', 'File', 'GIF']);
    expect(batches[0]!.attachments).toEqual([
      { ...PHOTO_ATTACHMENT, caption: 'Sunset at the pier' },
      { ...DOCUMENT_ATTACHMENT, caption: 'Signed copy' },
      { ...GIF_ATTACHMENT, caption: 'Us on Friday' },
    ]);
  });

  it("restores the Portuguese label when the sender's own sample is Portuguese", async () => {
    const { batches } = await runUp([
      candidate({ id: 'photo', senderFallbackSample: 'Foto' }),
      candidate({
        id: 'document',
        kind: 'document',
        attachment: DOCUMENT_ATTACHMENT,
        senderFallbackSample: 'Foto',
      }),
      candidate({
        id: 'photo-from-document-sample',
        senderFallbackSample: 'Ficheiro',
      }),
      candidate({
        id: 'gif',
        kind: 'gif',
        attachment: GIF_ATTACHMENT,
        senderFallbackSample: 'Ficheiro',
      }),
      candidate({ id: 'english-sample', senderFallbackSample: 'File' }),
    ]);

    expect(batches[0]!.bodies).toEqual([
      'Foto',
      'Ficheiro',
      'Foto',
      'GIF',
      'Photo',
    ]);
  });

  it('replaces a caption the row already had with the edited text', async () => {
    const { batches } = await runUp([
      candidate({
        id: 'photo',
        body: 'The newer words',
        attachment: {
          ...PHOTO_ATTACHMENT,
          caption: 'The words it was sent with',
        },
      }),
    ]);

    expect(batches[0]!.attachments[0]).toEqual({
      ...PHOTO_ATTACHMENT,
      caption: 'The newer words',
    });
  });

  it('counts only the visible captions whose text it changes', async () => {
    await runUp([
      candidate({
        id: 'replaced',
        body: 'New words',
        attachment: { ...PHOTO_ATTACHMENT, caption: 'Old words' },
      }),
      candidate({
        id: 'cleared',
        body: '\u0001',
        attachment: { ...PHOTO_ATTACHMENT, caption: 'Old words' },
      }),
      candidate({
        id: 'same-text',
        body: 'Same words',
        attachment: { ...PHOTO_ATTACHMENT, caption: 'Same words' },
      }),
      candidate({
        id: 'blank-before',
        body: 'New words',
        attachment: { ...PHOTO_ATTACHMENT, caption: '   ' },
      }),
      candidate({ id: 'none-before', body: 'New words' }),
    ]);

    expect(logSpy).toHaveBeenCalledWith(
      '[RepairLegacyCaptionEdits] repaired 5 message(s), replaced 2 visible caption(s), cut 0 caption(s) to 1000 characters',
    );
  });

  it('normalises line breaks, strips control bytes and tabs, and trims the caption', async () => {
    const { batches } = await runUp([
      candidate({
        id: 'photo',
        body: '  first line\r\nsecond\rthird\u0007\tend\u007f  ',
      }),
    ]);

    expect(batches[0]!.attachments[0]!.caption).toBe(
      'first line\nsecond\nthirdend',
    );
  });

  it('keeps ordinary chat text the HTML pass would delete', async () => {
    const { batches } = await runUp([
      candidate({
        id: 'photo',
        body: 'x<y and y>z, see <https://example.com>',
      }),
    ]);

    expect(batches[0]!.attachments[0]!.caption).toBe(
      'x<y and y>z, see <https://example.com>',
    );
  });

  it('leaves no caption when the edited text cleans down to nothing, and still restores the label', async () => {
    const { batches } = await runUp([
      candidate({
        id: 'photo',
        body: '\u0001\u0002',
        attachment: { ...PHOTO_ATTACHMENT, caption: 'Old caption' },
      }),
    ]);

    expect(batches[0]!.bodies).toEqual(['Photo']);
    expect(batches[0]!.attachments[0]).toEqual(PHOTO_ATTACHMENT);
    expect(batches[0]!.attachments[0]).not.toHaveProperty('caption');
  });

  it('cuts a caption at 1000 characters and reports the cut in the log', async () => {
    const { batches } = await runUp([
      candidate({ id: 'long', body: 'a'.repeat(1200) }),
      candidate({ id: 'short', body: 'fits' }),
    ]);

    expect(batches[0]!.attachments[0]!.caption).toBe('a'.repeat(1000));
    expect(batches[0]!.attachments[1]!.caption).toBe('fits');
    expect(logSpy).toHaveBeenCalledWith(
      '[RepairLegacyCaptionEdits] repaired 2 message(s), replaced 0 visible caption(s), cut 1 caption(s) to 1000 characters',
    );
  });

  it('keeps an emoji whole when it is the 1000th character', async () => {
    const { batches } = await runUp([
      candidate({ id: 'emoji', body: `${'a'.repeat(999)}\u{1F308}tail` }),
    ]);

    const caption = batches[0]!.attachments[0]!.caption as string;
    expect(caption).toBe(`${'a'.repeat(999)}\u{1F308}`);
    expect(caption).toHaveLength(1001);
    expect(caption).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(logSpy).toHaveBeenCalledWith(
      '[RepairLegacyCaptionEdits] repaired 1 message(s), replaced 0 visible caption(s), cut 1 caption(s) to 1000 characters',
    );
  });

  it('keeps 1000 emoji uncut, counting each as one character', async () => {
    const thousandEmoji = '\u{1F308}'.repeat(1000);
    const { batches } = await runUp([
      candidate({ id: 'emoji-only', body: thousandEmoji }),
    ]);

    expect(batches[0]!.attachments[0]!.caption).toBe(thousandEmoji);
    expect(logSpy).toHaveBeenCalledWith(
      '[RepairLegacyCaptionEdits] repaired 1 message(s), replaced 0 visible caption(s), cut 0 caption(s) to 1000 characters',
    );
  });

  it('keeps an emoji presentation selector with the last kept character', async () => {
    const { batches } = await runUp([
      candidate({
        id: 'heart',
        body: `${'a'.repeat(999)}\u2764\uFE0Fmore`,
      }),
    ]);

    expect(batches[0]!.attachments[0]!.caption).toBe(
      `${'a'.repeat(999)}\u2764\uFE0F`,
    );
  });

  it('writes in batches of 500 and logs the summed count', async () => {
    const candidates = Array.from({ length: 1201 }, (_, index) =>
      candidate({ id: `row-${index}` }),
    );

    const { batches } = await runUp(candidates);

    expect(batches.map((batch) => batch.ids.length)).toEqual([500, 500, 201]);
    expect(logSpy).toHaveBeenCalledWith(
      '[RepairLegacyCaptionEdits] repaired 1201 message(s), replaced 0 visible caption(s), cut 0 caption(s) to 1000 characters',
    );
  });

  it('writes nothing and logs zero when no row needs repair', async () => {
    const { statements } = await runUp([]);

    expect(statements).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      '[RepairLegacyCaptionEdits] repaired 0 message(s), replaced 0 visible caption(s), cut 0 caption(s) to 1000 characters',
    );
  });

  it('sets body and attachment by id in each batch update', async () => {
    const { statements } = await runUp([candidate({ id: 'photo' })]);

    expect(statements[1]).toContain('UPDATE "messages" "m"');
    expect(statements[1]).toContain('SET "body" = "fix"."body"');
    expect(statements[1]).toContain('"attachment" = "fix"."attachment"::jsonb');
    expect(statements[1]).toContain(
      'unnest($1::uuid[], $2::text[], $3::text[])',
    );
    expect(statements[1]).toContain('WHERE "m"."id" = "fix"."id"');
    expect(statements[1]).not.toContain('edited_at');
  });

  it('has a down that changes nothing', async () => {
    const { query, statements } = scriptedQueryRunner([]);

    await new RepairLegacyCaptionEdits1823520000000().down();

    expect(statements).toHaveLength(0);
    expect(query).not.toHaveBeenCalled();
  });
});
