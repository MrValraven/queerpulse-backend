import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import {
  KEPT_COPY_ABANDONED_SQL,
  KEPT_COPY_FAILED_SQL,
  KEPT_COPY_KEY_SQL,
  KEPT_COPY_LANDED_SQL,
  KEPT_TRACK_DELETE_SQL,
  ORPHAN_KEPT_TRACKS_SQL,
  ORPHAN_PURCHASES_DELETE_SQL,
  PENDING_KEPT_COPIES_BATCH_SIZE,
  PENDING_KEPT_COPIES_SQL,
  StudioKeptAudioService,
} from './studio-kept-audio.service';

const SOURCE_KEY =
  'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3';
const KEPT_KEY = 'studio-kept-audio/77777777-7777-4888-9999-000000000000.mp3';
const KEPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_KEPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('StudioKeptAudioService', () => {
  let query: jest.Mock;
  let copyStudioAudioForKeeping: jest.Mock;
  let deleteObjectByKey: jest.Mock;
  let warn: jest.SpyInstance;
  let service: StudioKeptAudioService;

  beforeEach(() => {
    query = jest.fn();
    copyStudioAudioForKeeping = jest.fn().mockResolvedValue(KEPT_KEY);
    deleteObjectByKey = jest.fn().mockResolvedValue(undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    service = new StudioKeptAudioService(
      { query } as unknown as DataSource,
      {
        copyStudioAudioForKeeping,
        deleteObjectByKey,
      } as unknown as StorageService,
    );
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('copyPending', () => {
    function answerWith(pendingRows: unknown[], landedCount: number): void {
      query.mockImplementation((sql: string) => {
        if (sql === PENDING_KEPT_COPIES_SQL) {
          return Promise.resolve(pendingRows);
        }
        if (sql === KEPT_COPY_LANDED_SQL) {
          return Promise.resolve([{ landed_count: landedCount }]);
        }
        return Promise.resolve([]);
      });
    }

    it('copies each pending row, records the new key and clears the source', async () => {
      answerWith(
        [
          {
            id: KEPT_ID,
            source_audio_key: SOURCE_KEY,
            audio_content_type: 'audio/mpeg',
          },
          {
            id: SECOND_KEPT_ID,
            source_audio_key: SOURCE_KEY,
            audio_content_type: 'audio/mp4',
          },
        ],
        1,
      );

      await service.copyPending();

      expect(copyStudioAudioForKeeping.mock.calls).toEqual([
        [SOURCE_KEY, 'audio/mpeg'],
        [SOURCE_KEY, 'audio/mp4'],
      ]);
      expect(
        query.mock.calls.filter(([sql]) => sql === KEPT_COPY_LANDED_SQL),
      ).toEqual([
        [KEPT_COPY_LANDED_SQL, [KEPT_ID, KEPT_KEY]],
        [KEPT_COPY_LANDED_SQL, [SECOND_KEPT_ID, KEPT_KEY]],
      ]);
      expect(deleteObjectByKey).not.toHaveBeenCalled();
    });

    it('deletes its own copy when another run landed first', async () => {
      answerWith(
        [
          {
            id: KEPT_ID,
            source_audio_key: SOURCE_KEY,
            audio_content_type: 'audio/mpeg',
          },
        ],
        0,
      );

      await service.retryPendingCopies();

      expect(deleteObjectByKey.mock.calls).toEqual([[KEPT_KEY]]);
    });

    it('counts a failed copy and logs no key, title or id', async () => {
      answerWith(
        [
          {
            id: KEPT_ID,
            source_audio_key: SOURCE_KEY,
            audio_content_type: 'audio/mpeg',
          },
        ],
        1,
      );
      const missingObjectError = Object.assign(new Error(SOURCE_KEY), {
        code: 'NoSuchKey',
      });
      copyStudioAudioForKeeping.mockRejectedValue(missingObjectError);

      await service.copyPending();

      expect(
        query.mock.calls.filter(([sql]) => sql === KEPT_COPY_FAILED_SQL),
      ).toEqual([[KEPT_COPY_FAILED_SQL, [KEPT_ID]]]);
      expect(warn.mock.calls).toEqual([
        ['studio kept audio copy failed: Error (code NoSuchKey)'],
      ]);
    });

    it('deletes its own copy and counts a failure when recording the key fails', async () => {
      query.mockImplementation((sql: string) => {
        if (sql === PENDING_KEPT_COPIES_SQL) {
          return Promise.resolve([
            {
              id: KEPT_ID,
              source_audio_key: SOURCE_KEY,
              audio_content_type: 'audio/mpeg',
            },
          ]);
        }
        if (sql === KEPT_COPY_LANDED_SQL) {
          return Promise.reject(
            Object.assign(new Error('connection lost'), { code: '57P01' }),
          );
        }
        return Promise.resolve([]);
      });

      await service.copyPending();

      expect(deleteObjectByKey.mock.calls).toEqual([[KEPT_KEY]]);
      expect(
        query.mock.calls.filter(([sql]) => sql === KEPT_COPY_FAILED_SQL),
      ).toEqual([[KEPT_COPY_FAILED_SQL, [KEPT_ID]]]);
      expect(warn.mock.calls).toEqual([
        ['studio kept audio copy failed: Error (code 57P01)'],
      ]);
    });

    it('still counts the failure when deleting its unrecorded copy fails', async () => {
      query.mockImplementation((sql: string) => {
        if (sql === PENDING_KEPT_COPIES_SQL) {
          return Promise.resolve([
            {
              id: KEPT_ID,
              source_audio_key: SOURCE_KEY,
              audio_content_type: 'audio/mpeg',
            },
          ]);
        }
        if (sql === KEPT_COPY_LANDED_SQL) {
          return Promise.reject(new Error('landing failed'));
        }
        return Promise.resolve([]);
      });
      deleteObjectByKey.mockRejectedValue(new Error(KEPT_KEY));

      await service.copyPending();

      expect(
        query.mock.calls.filter(([sql]) => sql === KEPT_COPY_FAILED_SQL),
      ).toEqual([[KEPT_COPY_FAILED_SQL, [KEPT_ID]]]);
      expect(warn.mock.calls).toEqual([
        ['studio kept audio copy failed: Error'],
        ['studio kept audio copy cleanup failed: Error'],
      ]);
    });

    it('gives the row its last try at once when the source object is gone', async () => {
      answerWith(
        [
          {
            id: KEPT_ID,
            source_audio_key: SOURCE_KEY,
            audio_content_type: 'audio/mpeg',
          },
        ],
        1,
      );
      copyStudioAudioForKeeping.mockRejectedValue(
        Object.assign(new Error(SOURCE_KEY), { name: 'NoSuchKey' }),
      );

      await service.copyPending();

      expect(
        query.mock.calls.filter(
          ([sql]) =>
            sql === KEPT_COPY_ABANDONED_SQL || sql === KEPT_COPY_FAILED_SQL,
        ),
      ).toEqual([[KEPT_COPY_ABANDONED_SQL, [KEPT_ID]]]);
      expect(KEPT_COPY_ABANDONED_SQL).toContain('"copy_attempts" = 10');
      expect(KEPT_COPY_ABANDONED_SQL).toContain('"audio_key" IS NULL');
    });

    it('keeps its copy when the landing threw after it committed', async () => {
      query.mockImplementation((sql: string) => {
        if (sql === PENDING_KEPT_COPIES_SQL) {
          return Promise.resolve([
            {
              id: KEPT_ID,
              source_audio_key: SOURCE_KEY,
              audio_content_type: 'audio/mpeg',
            },
          ]);
        }
        if (sql === KEPT_COPY_LANDED_SQL) {
          return Promise.reject(new Error('connection lost'));
        }
        if (sql === KEPT_COPY_KEY_SQL) {
          return Promise.resolve([{ audio_key: KEPT_KEY }]);
        }
        return Promise.resolve([]);
      });

      await service.copyPending();

      expect(deleteObjectByKey).not.toHaveBeenCalled();
      expect(
        query.mock.calls.filter(([sql]) => sql === KEPT_COPY_FAILED_SQL),
      ).toEqual([]);
    });

    it('leaves its copy for the orphan sweep when the landing and the re-read both fail', async () => {
      query.mockImplementation((sql: string) => {
        if (sql === PENDING_KEPT_COPIES_SQL) {
          return Promise.resolve([
            {
              id: KEPT_ID,
              source_audio_key: SOURCE_KEY,
              audio_content_type: 'audio/mpeg',
            },
          ]);
        }
        if (sql === KEPT_COPY_LANDED_SQL || sql === KEPT_COPY_KEY_SQL) {
          return Promise.reject(new Error('connection lost'));
        }
        return Promise.resolve([]);
      });

      await service.copyPending();

      expect(deleteObjectByKey).not.toHaveBeenCalled();
      expect(
        query.mock.calls.filter(([sql]) => sql === KEPT_COPY_FAILED_SQL),
      ).toEqual([[KEPT_COPY_FAILED_SQL, [KEPT_ID]]]);
      expect(warn.mock.calls).toEqual([
        ['studio kept audio copy failed: Error'],
        ['studio kept audio copy check failed: Error'],
      ]);
    });

    it('reads batches after the last row until a batch comes back short', async () => {
      const fullBatch = Array.from(
        { length: PENDING_KEPT_COPIES_BATCH_SIZE },
        (_unused, rowIndex) => ({
          id: `kept-${rowIndex}`,
          source_audio_key: SOURCE_KEY,
          audio_content_type: 'audio/mpeg',
          created_at_cursor: `2026-10-28 10:00:00.${String(rowIndex).padStart(6, '0')}+00`,
        }),
      );
      const shortBatch = [
        {
          id: SECOND_KEPT_ID,
          source_audio_key: SOURCE_KEY,
          audio_content_type: 'audio/mpeg',
          created_at_cursor: '2026-10-28 11:00:00.000001+00',
        },
      ];
      let pendingReads = 0;
      query.mockImplementation((sql: string) => {
        if (sql === PENDING_KEPT_COPIES_SQL) {
          pendingReads += 1;
          return Promise.resolve(pendingReads === 1 ? fullBatch : shortBatch);
        }
        if (sql === KEPT_COPY_LANDED_SQL) {
          return Promise.resolve([{ landed_count: 1 }]);
        }
        return Promise.resolve([]);
      });

      await service.copyPending();

      expect(
        query.mock.calls
          .filter(([sql]) => sql === PENDING_KEPT_COPIES_SQL)
          .map(([, parameters]) => parameters),
      ).toEqual([
        [null, null],
        ['2026-10-28 10:00:00.000199+00', 'kept-199'],
      ]);
      expect(copyStudioAudioForKeeping).toHaveBeenCalledTimes(
        PENDING_KEPT_COPIES_BATCH_SIZE + 1,
      );
    });

    it('goes on to the next row after a failed copy', async () => {
      answerWith(
        [
          {
            id: KEPT_ID,
            source_audio_key: SOURCE_KEY,
            audio_content_type: 'audio/mpeg',
          },
          {
            id: SECOND_KEPT_ID,
            source_audio_key: SOURCE_KEY,
            audio_content_type: 'audio/mpeg',
          },
        ],
        1,
      );
      copyStudioAudioForKeeping.mockRejectedValueOnce(new Error('first'));

      await service.copyPending();

      expect(
        query.mock.calls
          .filter(([sql]) => sql === KEPT_COPY_LANDED_SQL)
          .map(([, parameters]) => parameters),
      ).toEqual([[SECOND_KEPT_ID, KEPT_KEY]]);
    });

    it('swallows every failure in the event handler', async () => {
      query.mockRejectedValue(
        Object.assign(new Error('connection lost'), { code: '57P01' }),
      );

      await expect(service.copyPending()).resolves.toBeUndefined();
      expect(warn.mock.calls).toEqual([
        ['studio kept audio copy failed: Error (code 57P01)'],
      ]);
    });
  });

  describe('SQL', () => {
    it('reads the copied rows with WITH so the driver returns rows', () => {
      expect(KEPT_COPY_LANDED_SQL).toMatch(/^WITH /);
    });

    it('limits the pending read to rows still worth a try', () => {
      expect(PENDING_KEPT_COPIES_SQL).toContain('"audio_key" IS NULL');
      expect(PENDING_KEPT_COPIES_SQL).toContain(
        '"source_audio_key" IS NOT NULL',
      );
      expect(PENDING_KEPT_COPIES_SQL).toContain('"copy_attempts" < 10');
      expect(PENDING_KEPT_COPIES_SQL).toContain(
        'ORDER BY "created_at" ASC, "id" ASC',
      );
      expect(PENDING_KEPT_COPIES_SQL).toContain('LIMIT 200');
      expect(PENDING_KEPT_COPIES_SQL).toContain(
        '("created_at", "id") > ($1::timestamptz, $2::uuid)',
      );
    });
  });

  describe('sweepOrphans', () => {
    it('deletes purchases nobody can read, then kept tracks no purchase links, object first', async () => {
      const calls: string[] = [];
      query.mockImplementation((sql: string) => {
        if (sql === ORPHAN_PURCHASES_DELETE_SQL) {
          calls.push('purchases');
          return Promise.resolve([[], 0]);
        }
        if (sql === ORPHAN_KEPT_TRACKS_SQL) {
          calls.push('orphans');
          return Promise.resolve([{ id: KEPT_ID, audio_key: KEPT_KEY }]);
        }
        if (sql === KEPT_TRACK_DELETE_SQL) {
          calls.push('row');
        }
        return Promise.resolve([]);
      });
      deleteObjectByKey.mockImplementation(() => {
        calls.push('object');
        return Promise.resolve();
      });

      await service.sweepOrphans();

      expect(calls).toEqual(['purchases', 'orphans', 'object', 'row']);
      expect(deleteObjectByKey.mock.calls).toEqual([[KEPT_KEY]]);
      expect(
        query.mock.calls.filter(([sql]) => sql === KEPT_TRACK_DELETE_SQL),
      ).toEqual([[KEPT_TRACK_DELETE_SQL, [KEPT_ID]]]);
      expect(ORPHAN_PURCHASES_DELETE_SQL).toContain('"buyer_user_id" IS NULL');
      expect(ORPHAN_PURCHASES_DELETE_SQL).toContain('"subprofile_id" IS NULL');
      expect(ORPHAN_KEPT_TRACKS_SQL).toContain('LIMIT 500');
    });

    it('deletes a kept row that never got a copy without touching storage', async () => {
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql === ORPHAN_KEPT_TRACKS_SQL
            ? [{ id: KEPT_ID, audio_key: null }]
            : [],
        ),
      );

      await service.sweepOrphans();

      expect(deleteObjectByKey).not.toHaveBeenCalled();
      expect(
        query.mock.calls.filter(([sql]) => sql === KEPT_TRACK_DELETE_SQL),
      ).toEqual([[KEPT_TRACK_DELETE_SQL, [KEPT_ID]]]);
    });

    it('keeps a kept row whose object delete failed for the next run', async () => {
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql === ORPHAN_KEPT_TRACKS_SQL
            ? [
                { id: KEPT_ID, audio_key: KEPT_KEY },
                { id: SECOND_KEPT_ID, audio_key: null },
              ]
            : [],
        ),
      );
      deleteObjectByKey.mockRejectedValueOnce(
        Object.assign(new Error(KEPT_KEY), { code: 'AccessDenied' }),
      );

      await service.sweepOrphans();

      expect(
        query.mock.calls
          .filter(([sql]) => sql === KEPT_TRACK_DELETE_SQL)
          .map(([, parameters]) => parameters),
      ).toEqual([[SECOND_KEPT_ID]]);
      expect(warn.mock.calls).toEqual([
        ['studio kept audio sweep failed: Error (code AccessDenied)'],
      ]);
    });
  });
});
