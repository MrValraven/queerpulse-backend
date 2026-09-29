// Install path: src/database/repair-legacy-caption-edits-migration.postgres.spec.ts
// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` both require every `src/migrations/*.ts` file, and
// requiring a spec there throws `describe is not defined` before any
// migration runs.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { RepairLegacyCaptionEdits1823520000000 } from '../migrations/1823520000000-RepairLegacyCaptionEdits';

/**
 * `RepairLegacyCaptionEdits1823520000000.up()` on real Postgres, so the
 * candidate query and the batch `UPDATE` are parsed and planned by the
 * database itself. The first run repairs the seeded rows inside a
 * transaction, as the migration runner does; the second run finds nothing
 * left to do, which proves the repair is idempotent.
 *
 * Repaired: an edited photo, a photo whose visible caption the edit
 * replaces, a Portuguese sender's document (whose newer forwarded English
 * photo must not sway the language), a GIF, a photo whose moderation was
 * lifted, an edit longer than the caption cap, and an edit whose 1000th
 * character is an emoji (its surrogate pair must reach `jsonb` whole).
 * Left alone: an unedited
 * photo, an edited photo whose body still holds a label, a document holding
 * the raw catalog key, a soft-deleted photo, a moderator-hidden photo, an
 * erased sender's evidence row, a sticker and a text message.
 *
 * It runs against a real database and is skipped unless
 * `REPAIR_LEGACY_CAPTION_EDITS_DATABASE_URL` names one. It builds the schema
 * with `synchronize` after dropping every table, so it refuses any database
 * whose name does not end in `_test`. Run it with, for example:
 *
 *   REPAIR_LEGACY_CAPTION_EDITS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/caption_repair_test \
 *     npx jest src/database/repair-legacy-caption-edits-migration.postgres.spec.ts
 */
const DATABASE_URL = process.env.REPAIR_LEGACY_CAPTION_EDITS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const CONVERSATION = '40000000-0000-4000-8000-000000000001';

const ENGLISH_SENDER = '10000000-0000-4000-8000-000000000001';
const PORTUGUESE_SENDER = '10000000-0000-4000-8000-000000000002';
const SAMPLELESS_SENDER = '10000000-0000-4000-8000-000000000003';
const ERASED_SENDER_REF = '10000000-0000-4000-8000-000000000004';

// Language samples: unedited, live, sent by the member themselves.
const ENGLISH_SAMPLE = '20000000-0000-4000-8000-000000000001';
const PORTUGUESE_SAMPLE = '20000000-0000-4000-8000-000000000002';
// Newer than PORTUGUESE_SAMPLE, but a forward, so it is no sample.
const PORTUGUESE_SENDER_FORWARD = '20000000-0000-4000-8000-000000000003';

// Repaired.
const EDITED_PHOTO = '30000000-0000-4000-8000-000000000001';
const CAPTIONED_PHOTO = '30000000-0000-4000-8000-000000000002';
const PORTUGUESE_DOCUMENT = '30000000-0000-4000-8000-000000000003';
const EDITED_GIF = '30000000-0000-4000-8000-000000000004';
const LIFTED_MODERATION_PHOTO = '30000000-0000-4000-8000-000000000005';
const LONG_EDIT_PHOTO = '30000000-0000-4000-8000-000000000006';
const EMOJI_BOUNDARY_PHOTO = '30000000-0000-4000-8000-000000000007';

// Left alone.
const LABEL_BODY_EDITED_PHOTO = '50000000-0000-4000-8000-000000000001';
const RAW_KEY_DOCUMENT = '50000000-0000-4000-8000-000000000002';
const DELETED_PHOTO = '50000000-0000-4000-8000-000000000003';
const HIDDEN_PHOTO = '50000000-0000-4000-8000-000000000004';
const EVIDENCE_PHOTO = '50000000-0000-4000-8000-000000000005';
const EDITED_STICKER = '50000000-0000-4000-8000-000000000006';
const EDITED_TEXT = '50000000-0000-4000-8000-000000000007';

const PHOTO_ATTACHMENT = {
  url: 'message-image/sender/photo.jpg',
  previewUrl: 'message-image/sender/photo.jpg',
  width: 800,
  height: 600,
  provider: 'upload',
};

const DOCUMENT_ATTACHMENT = {
  url: 'message-document/sender/contract.pdf',
  fileName: 'contract.pdf',
  byteSize: 4096,
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

const STICKER_ATTACHMENT = {
  url: 'sticker/pride.png',
  previewUrl: 'sticker/pride.png',
  width: 256,
  height: 256,
  provider: 'sticker',
  stickerId: '60000000-0000-4000-8000-000000000001',
  label: 'Pride heart',
};

const HOUR_MS = 60 * 60 * 1000;
const BASE_TIME = new Date('2026-09-01T09:00:00.000Z').getTime();
const atHour = (hour: number) => new Date(BASE_TIME + hour * HOUR_MS);

interface SeededMessage {
  id: string;
  senderId: string | null;
  kind: 'user' | 'gif' | 'image' | 'document' | 'sticker';
  body: string;
  attachment?: Record<string, unknown> | null;
  createdAtHour: number;
  isEdited?: boolean;
  isDeleted?: boolean;
  isForwarded?: boolean;
  erasedSenderRef?: string | null;
}

async function insertMessage(
  dataSource: DataSource,
  message: SeededMessage,
): Promise<void> {
  const createdAt = atHour(message.createdAtHour);
  const editedAt = message.isEdited
    ? new Date(createdAt.getTime() + 60 * 1000)
    : null;
  await dataSource.query(
    `INSERT INTO "messages" (
       "id", "conversation_id", "sender_id", "erased_sender_ref", "body",
       "kind", "attachment", "forwarded", "created_at", "edited_at",
       "deleted_at"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      message.id,
      CONVERSATION,
      message.senderId,
      message.erasedSenderRef ?? null,
      message.body,
      message.kind,
      message.attachment ? JSON.stringify(message.attachment) : null,
      message.isForwarded ?? false,
      createdAt,
      editedAt,
      message.isDeleted ? editedAt : null,
    ],
  );
}

async function seedFixture(dataSource: DataSource): Promise<void> {
  const messages: SeededMessage[] = [
    {
      id: ENGLISH_SAMPLE,
      senderId: ENGLISH_SENDER,
      kind: 'image',
      body: 'Photo',
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 1,
    },
    {
      id: PORTUGUESE_SAMPLE,
      senderId: PORTUGUESE_SENDER,
      kind: 'image',
      body: 'Foto',
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 1,
    },
    {
      id: PORTUGUESE_SENDER_FORWARD,
      senderId: PORTUGUESE_SENDER,
      kind: 'image',
      body: 'Photo',
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 5,
      isForwarded: true,
    },
    {
      id: EDITED_PHOTO,
      senderId: ENGLISH_SENDER,
      kind: 'image',
      body: 'Sunset at the pier',
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 2,
      isEdited: true,
    },
    {
      id: CAPTIONED_PHOTO,
      senderId: ENGLISH_SENDER,
      kind: 'image',
      body: 'The newer words',
      attachment: {
        ...PHOTO_ATTACHMENT,
        caption: 'The words it was sent with',
      },
      createdAtHour: 2,
      isEdited: true,
    },
    {
      id: PORTUGUESE_DOCUMENT,
      senderId: PORTUGUESE_SENDER,
      kind: 'document',
      body: 'Contrato assinado',
      attachment: DOCUMENT_ATTACHMENT,
      createdAtHour: 2,
      isEdited: true,
    },
    {
      id: EDITED_GIF,
      senderId: PORTUGUESE_SENDER,
      kind: 'gif',
      body: 'Nós na sexta',
      attachment: GIF_ATTACHMENT,
      createdAtHour: 2,
      isEdited: true,
    },
    {
      id: LIFTED_MODERATION_PHOTO,
      senderId: SAMPLELESS_SENDER,
      kind: 'image',
      body: 'Back up again',
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 2,
      isEdited: true,
    },
    {
      id: LONG_EDIT_PHOTO,
      senderId: SAMPLELESS_SENDER,
      kind: 'image',
      body: 'a'.repeat(1200),
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 2,
      isEdited: true,
    },
    {
      id: EMOJI_BOUNDARY_PHOTO,
      senderId: SAMPLELESS_SENDER,
      kind: 'image',
      body: `${'a'.repeat(999)}\u{1F308}tail`,
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 2,
      isEdited: true,
    },
    {
      id: LABEL_BODY_EDITED_PHOTO,
      senderId: ENGLISH_SENDER,
      kind: 'image',
      body: 'Foto',
      attachment: { ...PHOTO_ATTACHMENT, caption: 'Kept caption' },
      createdAtHour: 3,
      isEdited: true,
    },
    {
      id: RAW_KEY_DOCUMENT,
      senderId: ENGLISH_SENDER,
      kind: 'document',
      body: 'messages:attachments.documentFallbackText',
      attachment: DOCUMENT_ATTACHMENT,
      createdAtHour: 3,
      isEdited: true,
    },
    {
      id: DELETED_PHOTO,
      senderId: ENGLISH_SENDER,
      kind: 'image',
      body: 'Deleted words',
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 3,
      isEdited: true,
      isDeleted: true,
    },
    {
      id: HIDDEN_PHOTO,
      senderId: ENGLISH_SENDER,
      kind: 'image',
      body: 'Hidden words',
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 3,
      isEdited: true,
    },
    {
      id: EVIDENCE_PHOTO,
      senderId: null,
      erasedSenderRef: ERASED_SENDER_REF,
      kind: 'image',
      body: 'Reported words',
      attachment: PHOTO_ATTACHMENT,
      createdAtHour: 3,
      isEdited: true,
    },
    {
      id: EDITED_STICKER,
      senderId: ENGLISH_SENDER,
      kind: 'sticker',
      body: 'Sticker words',
      attachment: STICKER_ATTACHMENT,
      createdAtHour: 3,
      isEdited: true,
    },
    {
      id: EDITED_TEXT,
      senderId: ENGLISH_SENDER,
      kind: 'user',
      body: 'Plain edited text',
      attachment: null,
      createdAtHour: 3,
      isEdited: true,
    },
  ];
  for (const message of messages) {
    await insertMessage(dataSource, message);
  }

  await dataSource.query(
    `INSERT INTO "content_moderation" ("subject_type", "subject_id", "hidden_at")
     VALUES ('message', $1, now())`,
    [HIDDEN_PHOTO],
  );
  // A lifted takedown: the row remains with both timestamps cleared.
  await dataSource.query(
    `INSERT INTO "content_moderation" ("subject_type", "subject_id")
     VALUES ('message', $1)`,
    [LIFTED_MODERATION_PHOTO],
  );
}

interface StoredMessage {
  body: string;
  attachment: Record<string, unknown> | null;
  edited_at: Date | null;
}

describeWithDatabase(
  'RepairLegacyCaptionEdits1823520000000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;
    let logSpy: jest.SpyInstance;
    let firstRunLog: string;
    let secondRunLog: string;
    const snapshotBeforeRun = new Map<string, StoredMessage>();

    const storedMessage = async (id: string): Promise<StoredMessage> => {
      const rows = await dataSource.query<StoredMessage[]>(
        `SELECT "body", "attachment", "edited_at" FROM "messages" WHERE "id" = $1`,
        [id],
      );
      return rows[0]!;
    };

    const runInTransaction = async (): Promise<string> => {
      logSpy.mockClear();
      await queryRunner.startTransaction();
      await new RepairLegacyCaptionEdits1823520000000().up(queryRunner);
      await queryRunner.commitTransaction();
      return String((logSpy.mock.calls as unknown[][])[0]?.[0]);
    };

    beforeAll(async () => {
      const databaseName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!databaseName.endsWith('_test')) {
        throw new Error(
          `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
        );
      }
      dataSource = new DataSource({
        type: 'postgres',
        url: DATABASE_URL,
        entities: [`${__dirname}/../**/*.entity.ts`],
        namingStrategy: new SnakeNamingStrategy(),
        dropSchema: true,
        synchronize: true,
      });
      await dataSource.initialize();
      await seedFixture(dataSource);
      for (const id of [
        LABEL_BODY_EDITED_PHOTO,
        RAW_KEY_DOCUMENT,
        DELETED_PHOTO,
        HIDDEN_PHOTO,
        EVIDENCE_PHOTO,
        EDITED_STICKER,
        EDITED_TEXT,
        ENGLISH_SAMPLE,
        PORTUGUESE_SAMPLE,
        PORTUGUESE_SENDER_FORWARD,
      ]) {
        snapshotBeforeRun.set(id, await storedMessage(id));
      }

      logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      queryRunner = dataSource.createQueryRunner();
      firstRunLog = await runInTransaction();
      secondRunLog = await runInTransaction();
    }, 120000);

    afterAll(async () => {
      logSpy?.mockRestore();
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('logs every repaired row, the visible caption it replaced and the captions it cut', () => {
      expect(firstRunLog).toBe(
        '[RepairLegacyCaptionEdits] repaired 7 message(s), replaced 1 visible caption(s), cut 2 caption(s) to 1000 characters',
      );
    });

    it('finds nothing left to repair on a second run', () => {
      expect(secondRunLog).toBe(
        '[RepairLegacyCaptionEdits] repaired 0 message(s), replaced 0 visible caption(s), cut 0 caption(s) to 1000 characters',
      );
    });

    it('moves an edited photo body into its caption and restores the English label', async () => {
      const message = await storedMessage(EDITED_PHOTO);
      expect(message.body).toBe('Photo');
      expect(message.attachment).toEqual({
        ...PHOTO_ATTACHMENT,
        caption: 'Sunset at the pier',
      });
      expect(message.edited_at).not.toBeNull();
    });

    it('replaces the caption a photo was sent with', async () => {
      const message = await storedMessage(CAPTIONED_PHOTO);
      expect(message.body).toBe('Photo');
      expect(message.attachment).toEqual({
        ...PHOTO_ATTACHMENT,
        caption: 'The newer words',
      });
    });

    it("restores the Portuguese label from the sender's own sample, ignoring a newer forward", async () => {
      const message = await storedMessage(PORTUGUESE_DOCUMENT);
      expect(message.body).toBe('Ficheiro');
      expect(message.attachment).toEqual({
        ...DOCUMENT_ATTACHMENT,
        caption: 'Contrato assinado',
      });
    });

    it('restores "GIF" for a GIF whatever the language', async () => {
      const message = await storedMessage(EDITED_GIF);
      expect(message.body).toBe('GIF');
      expect(message.attachment).toEqual({
        ...GIF_ATTACHMENT,
        caption: 'Nós na sexta',
      });
    });

    it('repairs a photo whose takedown was lifted, in English when the sender has no sample', async () => {
      const message = await storedMessage(LIFTED_MODERATION_PHOTO);
      expect(message.body).toBe('Photo');
      expect(message.attachment).toEqual({
        ...PHOTO_ATTACHMENT,
        caption: 'Back up again',
      });
    });

    it('cuts an edit longer than the caption cap at 1000 characters', async () => {
      const message = await storedMessage(LONG_EDIT_PHOTO);
      expect(message.body).toBe('Photo');
      expect(message.attachment?.caption).toBe('a'.repeat(1000));
    });

    it('keeps an emoji whole when the cut lands on it', async () => {
      const message = await storedMessage(EMOJI_BOUNDARY_PHOTO);
      expect(message.body).toBe('Photo');
      expect(message.attachment?.caption).toBe(`${'a'.repeat(999)}\u{1F308}`);
    });

    it.each([
      ['an edited photo whose body is still a label', LABEL_BODY_EDITED_PHOTO],
      ['a document holding the raw catalog key', RAW_KEY_DOCUMENT],
      ['a soft-deleted photo', DELETED_PHOTO],
      ['a photo a moderator hid', HIDDEN_PHOTO],
      ["an erased sender's evidence row", EVIDENCE_PHOTO],
      ['a sticker', EDITED_STICKER],
      ['a text message', EDITED_TEXT],
      ['an unedited English photo', ENGLISH_SAMPLE],
      ['an unedited Portuguese photo', PORTUGUESE_SAMPLE],
      ['a forwarded photo', PORTUGUESE_SENDER_FORWARD],
    ])('leaves %s exactly as it was', async (_description, id) => {
      expect(await storedMessage(id)).toEqual(snapshotBeforeRun.get(id));
    });
  },
);
