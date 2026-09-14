import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';
import { MAX_REORDERABLE_PERSONAS } from '../subprofile-validation';

// Body of `PUT /subprofiles/order`: the caller's personas in the order they
// want them under their own profile, top first.
//
// A WHOLE-LIST PERMUTATION, never a patch. The endpoint writes
// `position = index` onto every one of the caller's `subprofile_members`
// rows, so the array has to name all of them exactly once. That completeness
// check lives in `SubprofilesService.reorderMine`, which is the only place
// that knows what the caller actually belongs to; this DTO narrows the shape
// ahead of it so a malformed body is a field-level 400 rather than a service
// round trip.
//
// `ArrayMaxSize(MAX_REORDERABLE_PERSONAS)` is a guard against an absurd body,
// rejected before any query runs. It is deliberately NOT `MAX_SUBPROFILES`:
// that cap counts personas a member CREATED, while this array names every
// `subprofile_members` row, co-owned personas included, and nothing bounds
// how many invites a member may accept. See the constant's own note. The real
// length check stays the equality against the caller's own membership count
// in the service.
//
// No `@ArrayNotEmpty()`, unlike `ReorderPressKitDto`: a member who holds no
// personas has an empty list to reorder, and `[]` is the correct (no-op)
// permutation of it. The service rejects an empty array from a member who
// does hold personas on the length check, which is the same rule applied
// where the membership set is actually known.
export class ReorderSubprofilesDTO {
  @IsArray()
  @ArrayMaxSize(MAX_REORDERABLE_PERSONAS)
  @IsUUID('4', { each: true })
  ids!: string[];
}
