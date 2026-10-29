import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SOURCE_ROOT = join(REPO_ROOT, 'src');

const PURCHASE_TABLES =
  /\b(?:studio_purchases|studio_payment_methods|studio_kept_tracks|studio_purchase_kept_tracks)\b/;

const FILES_ALLOWED_TO_NAME_PURCHASE_TABLES = [
  'src/account/data-export-contributors-studio.ts',
  'src/migrations/1838000000000-AddStudioPurchases.ts',
  'src/storage/storage-maintenance.service.ts',
  'src/studio/entities/studio-kept-track.entity.ts',
  'src/studio/entities/studio-payment-method.entity.ts',
  'src/studio/entities/studio-purchase-kept-track.entity.ts',
  'src/studio/entities/studio-purchase.entity.ts',
  'src/studio/studio-buyer-purchases.service.ts',
  'src/studio/studio-kept-audio.service.ts',
  'src/studio/studio-kept-tracks.ts',
  'src/studio/studio-payment-method-lock.ts',
  'src/studio/studio-payment-methods.service.ts',
  'src/studio/studio-purchase-alerts.listener.ts',
  'src/studio/studio-purchase-expiry.service.ts',
  'src/studio/studio-purchase-library.service.ts',
  'src/studio/studio-purchase-rows.ts',
  'src/studio/studio-purchase-wall.service.ts',
  'src/studio/studio-purchases-erasure.ts',
  'src/studio/studio-purchases-unlink.ts',
  'src/studio/studio-purchases.service.ts',
  'src/studio/studio-sales.service.ts',
];

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(entryPath);
    }
    const isSource =
      entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts');
    return isSource ? [entryPath] : [];
  });
}

function sourceFilesMatching(pattern: RegExp): string[] {
  return collectSourceFiles(SOURCE_ROOT)
    .filter((filePath) => pattern.test(readFileSync(filePath, 'utf8')))
    .map((filePath) => relative(REPO_ROOT, filePath).split('\\').join('/'))
    .sort();
}

describe('purchases privacy', () => {
  it('keeps the purchase tables to the files that serve buyers, artists, the export, erasure, unlink and kept files', () => {
    expect(
      sourceFilesMatching(PURCHASE_TABLES).filter(
        (file) => !FILES_ALLOWED_TO_NAME_PURCHASE_TABLES.includes(file),
      ),
    ).toEqual([]);
  });

  it('lets no admin, moderation or staff file read a purchase table', () => {
    expect(
      sourceFilesMatching(PURCHASE_TABLES).filter((file) =>
        /admin|moderation|staff/.test(file),
      ),
    ).toEqual([]);
  });
});
