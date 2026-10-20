import {
  creatorDraftViewedNote,
  parseCreatorDraftViewedNote,
  recordCreatorDraftViewed,
} from './creator-draft-audit';

describe('creator draft audit', () => {
  it('writes one creator_draft_viewed row with no report, no reason and no target', async () => {
    const writeAuditLog = jest.fn().mockResolvedValue('audit-1');
    await recordCreatorDraftViewed(
      { writeAuditLog },
      'admin-1',
      'persona',
      'persona-1',
      'creator_drafts',
    );
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledWith(
      null,
      'admin-1',
      'creator_draft_viewed',
      undefined,
      '{"v":1,"kind":"persona","draftId":"persona-1","surface":"creator_drafts"}',
    );
  });

  it('reads the kind back out of a note and refuses anything else', () => {
    expect(
      parseCreatorDraftViewedNote(
        creatorDraftViewedNote('event', 'draft-1', 'creator_drafts'),
      ),
    ).toEqual({ kind: 'event' });
    expect(parseCreatorDraftViewedNote('{"v":1,"kind":"nope"}')).toBeNull();
    expect(parseCreatorDraftViewedNote('not json')).toBeNull();
    expect(parseCreatorDraftViewedNote(null)).toBeNull();
  });
});
