import {
  DataExportFormat,
  DataExportJob,
  DataExportStatus,
} from './entities/data-export-job.entity';
import { describeExportDownload } from './export-archive';

const generatedAt = new Date('2026-07-15T12:00:00.000Z');

function job(
  format: DataExportFormat,
  data: Record<string, unknown>,
): DataExportJob {
  return {
    id: 'job-1',
    userId: 'u1',
    status: DataExportStatus.Ready,
    categories: Object.keys(data).filter((k) => k !== 'manifest'),
    format,
    requestedAt: generatedAt,
    generatedAt,
    data,
    error: null,
  };
}

const payload = {
  manifest: {
    exportedAt: generatedAt.toISOString(),
    schemaVersion: '1.0',
    categories: ['profile', 'messages'],
  },
  profile: { email: 'a@b.com', name: 'Anika Kovač' },
  messages: [{ id: 'm1', body: 'hi, there', sentAt: 'z', editedAt: null }],
};

describe('describeExportDownload', () => {
  describe("format 'json'", () => {
    it('serves a single pretty-printed .json, unchanged from before CSV support', () => {
      const result = describeExportDownload(
        job(DataExportFormat.Json, payload),
      );
      expect(result.kind).toBe('json');
      if (result.kind !== 'json') {
        throw new Error('expected json');
      }
      expect(result.contentType).toBe('application/json');
      expect(result.filename).toBe('queerpulse-export-job-1.json');
      expect(result.body.toString('utf8')).toBe(
        JSON.stringify(payload, null, 2),
      );
    });

    it('emits no BOM — JSON.parse throws on one', () => {
      const result = describeExportDownload(
        job(DataExportFormat.Json, payload),
      );
      if (result.kind !== 'json') {
        throw new Error('expected json');
      }
      const text = result.body.toString('utf8');
      expect(text.startsWith('\uFEFF')).toBe(false);
      expect(() => JSON.parse(text) as unknown).not.toThrow();
    });

    it('falls back to the .json path for an unrecognised format value', () => {
      // A legacy or corrupt enum value must degrade to a working download
      // rather than to an empty zip.
      const result = describeExportDownload(
        job('xml' as DataExportFormat, payload),
      );
      expect(result.kind).toBe('json');
    });
  });

  describe("format 'csv'", () => {
    it('serves a .zip of one CSV per present category, plus the manifest', () => {
      const result = describeExportDownload(job(DataExportFormat.Csv, payload));
      expect(result.kind).toBe('zip');
      if (result.kind !== 'zip') {
        throw new Error('expected zip');
      }
      expect(result.contentType).toBe('application/zip');
      expect(result.filename).toBe('queerpulse-export-job-1.zip');
      expect(result.entries.map((e) => e.name)).toEqual([
        'manifest.json',
        'profile.csv',
        'messages.csv',
      ]);
    });

    it('omits a category the member never requested', () => {
      // `build()` writes no key at all for an unrequested category, so no file
      // is produced — distinguishing "not requested" from "requested, empty".
      const result = describeExportDownload(
        job(DataExportFormat.Csv, { manifest: {}, profile: { email: 'x' } }),
      );
      if (result.kind !== 'zip') {
        throw new Error('expected zip');
      }
      expect(result.entries.map((e) => e.name)).toEqual([
        'manifest.json',
        'profile.csv',
      ]);
    });

    it('emits an empty (BOM-only) CSV for a requested category with no rows', () => {
      const result = describeExportDownload(
        job(DataExportFormat.Csv, { messages: [] }),
      );
      if (result.kind !== 'zip') {
        throw new Error('expected zip');
      }
      const messages = result.entries.find((e) => e.name === 'messages.csv');
      expect(messages).toBeDefined();
      expect(messages?.content).toBe('\uFEFF');
    });

    it('uses the archive key, not the request category id, for the filename', () => {
      // `forumPosts` -> posts.csv and `activityLog` -> activity.csv, matching
      // AccountExportService.build.
      const result = describeExportDownload(
        job(DataExportFormat.Csv, { posts: [], activity: [] }),
      );
      if (result.kind !== 'zip') {
        throw new Error('expected zip');
      }
      expect(result.entries.map((e) => e.name)).toEqual([
        'posts.csv',
        'activity.csv',
      ]);
    });

    it('does NOT include the full .json', () => {
      const result = describeExportDownload(job(DataExportFormat.Csv, payload));
      if (result.kind !== 'zip') {
        throw new Error('expected zip');
      }
      expect(result.entries.map((e) => e.name)).not.toContain(
        'queerpulse-export-job-1.json',
      );
    });
  });

  describe("format 'both'", () => {
    it('serves the CSVs and the full .json in one zip', () => {
      const result = describeExportDownload(
        job(DataExportFormat.Both, payload),
      );
      if (result.kind !== 'zip') {
        throw new Error('expected zip');
      }
      expect(result.filename).toBe('queerpulse-export-job-1.zip');
      expect(result.entries.map((e) => e.name)).toEqual([
        'manifest.json',
        'profile.csv',
        'messages.csv',
        'queerpulse-export-job-1.json',
      ]);
      const json = result.entries.at(-1);
      expect(json?.content).toBe(JSON.stringify(payload, null, 2));
    });
  });

  it('pins every entry to the job generation time so a zip is reproducible', () => {
    const result = describeExportDownload(job(DataExportFormat.Csv, payload));
    if (result.kind !== 'zip') {
      throw new Error('expected zip');
    }
    // Left to archiver's default this would be `new Date()` per entry, so the
    // same job would produce a different file on every download.
    expect(result.modifiedAt).toEqual(generatedAt);
  });
});
