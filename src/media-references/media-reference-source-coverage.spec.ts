import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  MEDIA_REFERENCE_SOURCES,
  RULED_OUT_IMAGE_FIELDS,
} from './media-reference-sources';

/**
 * The completeness tripwire: every `@IsImageReference` DTO field discovered
 * under `src/**\/dto/*.ts` must map (via `DTO_FIELD_TO_SOURCE_FIELD` below) to
 * either a wired `MediaReferenceSource` in `MEDIA_REFERENCE_SOURCES` or an
 * explicit `RULED_OUT_IMAGE_FIELDS` entry. A brand-new image-upload field with
 * neither fails this test — that is the point: it forces the resolver (or the
 * allowlist) to be updated in the SAME change that adds the field, so
 * "no references" stays a safe signal to delete on.
 *
 * Maintained by hand alongside the DTOs (small, deliberately not derived from
 * anything mechanical) — key is `<DtoClassName>.<propertyName>` as it appears
 * in the DTO source, value is the `field` string of the `MediaReferenceSource`
 * (or `RULED_OUT_IMAGE_FIELDS` entry) that owns the underlying entity column.
 */
const DTO_FIELD_TO_SOURCE_FIELD: Record<string, string> = {
  'CreateTitleDto.coverImageUrl': 'CinemaTitle.coverImageUrl',
  'CreateHousingListingDto.gallery': 'HousingListing.gallery',
  'UpdateHousingListingDto.gallery': 'HousingListing.gallery',
  'CreatePostDto.image': 'CommunityPost.image',
  'UpdatePostDto.image': 'CommunityPost.image',
  'CreateCommunityDto.coverImageUrl': 'Community.coverImageUrl',
  'CreateLandlordDto.photo': 'Landlord.photo',
  'UpdateLandlordDto.photo': 'Landlord.photo',
  'ListingPhotoSetDto.wide': 'Listing.photos',
  'ListingPhotoSetDto.d1': 'Listing.photos',
  'ListingPhotoSetDto.d2': 'Listing.photos',
  'ListingPhotoSetDto.vibe': 'Listing.photos',
  'UpdateSubprofileDTO.avatarUrl': 'Subprofile.avatarUrl',
  'UpdateSubprofileDTO.coverUrl': 'Subprofile.coverUrl',
  'SubprofileItemInputDTO.imageUrl': 'SubprofileItem.imageUrl',
  'WorkItemDto.imageUrl': 'WorkItem.imageUrl',
  'UpdateProfileDto.avatarUrl': 'Profile.avatarUrl',
  'CreateEventDto.coverImageUrl': 'Event.coverImageUrl',
  'CreateGroupDto.avatarUrl': 'Conversation.avatarUrl',
  'UpdateConversationDto.avatarUrl': 'Conversation.avatarUrl',
  'CompanyWorkItemDto.imageUrl': 'Company.work[].imageUrl',
  'CreateChangemakerDto.imageUrl': 'Changemaker.imageUrl',
};

/** Recursively lists every `.ts` file under a `dto/` directory beneath `root`
 *  (excluding `.spec.ts`). Walks the whole `src` tree looking for `dto`
 *  directories rather than assuming a fixed depth, since feature modules
 *  nest `dto/` directly under `src/<feature>/dto/`. */
function listDtoFiles(root: string): string[] {
  const dtoFiles: string[] = [];
  const directoryEntries = readdirSync(root, { withFileTypes: true });
  for (const directoryEntry of directoryEntries) {
    const entryPath = join(root, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      if (directoryEntry.name === 'node_modules') continue;
      if (directoryEntry.name === 'dto') {
        const dtoDirectoryEntries = readdirSync(entryPath, {
          withFileTypes: true,
        });
        for (const dtoDirectoryEntry of dtoDirectoryEntries) {
          if (
            dtoDirectoryEntry.isFile() &&
            dtoDirectoryEntry.name.endsWith('.ts') &&
            !dtoDirectoryEntry.name.endsWith('.spec.ts')
          ) {
            dtoFiles.push(join(entryPath, dtoDirectoryEntry.name));
          }
        }
        continue;
      }
      dtoFiles.push(...listDtoFiles(entryPath));
    }
  }
  return dtoFiles;
}

/** Finds the `export class <Name>` that most closely precedes `matchIndex`
 *  in the same file — i.e. the class the decorated property belongs to. */
function findEnclosingClassName(
  fileContent: string,
  matchIndex: number,
): string | null {
  const classDeclarationPattern = /export class (\w+)/g;
  let enclosingClassName: string | null = null;
  let classMatch: RegExpExecArray | null;
  while ((classMatch = classDeclarationPattern.exec(fileContent)) !== null) {
    if (classMatch.index > matchIndex) break;
    const capturedClassName = classMatch[1];
    if (capturedClassName !== undefined) enclosingClassName = capturedClassName;
  }
  return enclosingClassName;
}

/** Scans every DTO file for `@IsImageReference(...)` decorators and returns
 *  the set of `<ClassName>.<propertyName>` fields they guard. */
function discoverImageReferenceFields(srcRoot: string): string[] {
  const discoveredFields = new Set<string>();
  const decoratorPattern = /@IsImageReference\([^)]*\)\s*(\w+)[?!]?\s*:/g;
  for (const dtoFilePath of listDtoFiles(srcRoot)) {
    const fileContent = readFileSync(dtoFilePath, 'utf8');
    let decoratorMatch: RegExpExecArray | null;
    decoratorPattern.lastIndex = 0;
    while ((decoratorMatch = decoratorPattern.exec(fileContent)) !== null) {
      const propertyName = decoratorMatch[1];
      if (propertyName === undefined) continue; // regex always captures group 1 on a match
      const enclosingClassName = findEnclosingClassName(
        fileContent,
        decoratorMatch.index,
      );
      if (!enclosingClassName) {
        throw new Error(
          `Found @IsImageReference on "${propertyName}" in ${dtoFilePath} with no enclosing "export class" — update the coverage-spec parser.`,
        );
      }
      discoveredFields.add(`${enclosingClassName}.${propertyName}`);
    }
  }
  return [...discoveredFields];
}

describe('media reference source coverage (tripwire)', () => {
  it('maps every @IsImageReference DTO field to a wired source or the ruled-out allowlist', () => {
    const srcRoot = join(__dirname, '..');
    const discoveredFields = discoverImageReferenceFields(srcRoot);

    // Sanity: the walker actually found DTOs — an empty result would make
    // every assertion below vacuously true and silently defeat the tripwire.
    expect(discoveredFields.length).toBeGreaterThan(0);

    const coveredSourceFields = new Set(
      MEDIA_REFERENCE_SOURCES.map((source) => source.field),
    );
    const ruledOutFields = new Set(RULED_OUT_IMAGE_FIELDS);

    for (const discoveredField of discoveredFields) {
      const mappedSourceField = DTO_FIELD_TO_SOURCE_FIELD[discoveredField];
      if (!mappedSourceField) {
        throw new Error(
          `"${discoveredField}" is a new @IsImageReference DTO field with no entry in DTO_FIELD_TO_SOURCE_FIELD (media-reference-source-coverage.spec.ts). Add one, and wire a MediaReferenceSource (or RULED_OUT_IMAGE_FIELDS entry) for it.`,
        );
      }
      const isCovered =
        coveredSourceFields.has(mappedSourceField) ||
        ruledOutFields.has(mappedSourceField);
      if (!isCovered) {
        throw new Error(
          `"${discoveredField}" maps to "${mappedSourceField}", which is neither a wired MediaReferenceSource nor a RULED_OUT_IMAGE_FIELDS entry.`,
        );
      }
    }
  });
});
