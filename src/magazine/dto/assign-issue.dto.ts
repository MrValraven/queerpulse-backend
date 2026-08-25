import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsUUID,
  ValidateIf,
} from 'class-validator';

/** The desk's bulk selection is a hand-checked list of visible rows, so a
 *  page of pieces is the realistic ceiling. Matches `PIECE_PAGE_SIZE_MAX`
 *  (`list-pieces.query.ts`) — you cannot select more rows than one page of
 *  the pipeline can render. */
export const ASSIGN_ISSUE_MAX_PIECES = 200;

/**
 * `PATCH /magazine/admin/pieces/assign-issue` body: move a batch of pieces
 * onto one issue, or detach them all back to the unassigned pool with
 * `issueId: null`. Single-piece assignment keeps using the existing
 * `PATCH /magazine/admin/pieces/:id` (`UpdatePieceDto.issueId`); this route
 * exists so the desk's bulk bar is ONE request instead of N, which also
 * makes the whole batch land or fail together.
 */
export class AssignIssueDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ASSIGN_ISSUE_MAX_PIECES)
  @IsUUID(undefined, { each: true })
  pieceIds!: string[];

  /**
   * `null` detaches every listed piece back to the unassigned pool, mirroring
   * `UpdatePieceDto.issueId`'s widened type. `ValidateIf` skips `@IsUUID` for
   * an explicit `null` so both a uuid and `null` validate; the field is
   * required (never `@IsOptional`) because an omitted target would make the
   * caller's intent ambiguous between "detach" and "no-op".
   */
  @ValidateIf((dto: AssignIssueDto) => dto.issueId !== null)
  @IsUUID()
  issueId!: string | null;
}
