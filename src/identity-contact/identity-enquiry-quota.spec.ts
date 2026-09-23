import {
  COLD_IDENTITY_ENQUIRY_MESSAGES_SQL,
  COLD_LISTING_ENQUIRY_ROWS_SQL,
  coldEnquiryMailboxKey,
  evaluateIdentityEnquiryQuota,
  IDENTITY_ENQUIRY_WINDOW_MS,
  loadColdEnquiries,
} from './identity-enquiry-quota';

const HOUR_MS = 60 * 60 * 1000;

const rows = (conversationId: string, hoursAgo: number[]) =>
  hoursAgo.map((hours) => ({
    mailboxKey: coldEnquiryMailboxKey({ conversationId }),
    createdAt: new Date(Date.now() - hours * HOUR_MS),
  }));

const newestFirst = (
  ...rowSets: Array<Array<{ mailboxKey: string; createdAt: Date }>>
) =>
  rowSets
    .flat()
    .sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );

const THIS_MAILBOX = coldEnquiryMailboxKey({ conversationId: 'this-thread' });

describe('evaluateIdentityEnquiryQuota', () => {
  it('counts only this mailbox’s thread toward the per-mailbox cap', () => {
    expect(
      evaluateIdentityEnquiryQuota(
        newestFirst(rows('this-thread', [1, 2]), rows('other-thread', [3])),
        THIS_MAILBOX,
      ),
    ).toEqual({ hasReachedLimit: false });
  });

  it('counts nothing toward the per-mailbox cap before a thread exists', () => {
    expect(
      evaluateIdentityEnquiryQuota(rows('other-thread', [1, 2, 3]), null),
    ).toEqual({ hasReachedLimit: false });
  });

  it('names the per-mailbox cap when both bite and gives the later release', () => {
    const mailboxRows = rows('this-thread', [23, 22.5, 22]);
    const elsewhereRows = rows(
      'other-thread',
      Array.from({ length: 17 }, (unused, index) => index + 1),
    );
    const quota = evaluateIdentityEnquiryQuota(
      newestFirst(mailboxRows, elsewhereRows),
      THIS_MAILBOX,
    );
    expect(quota).toMatchObject({
      hasReachedLimit: true,
      reason: 'wrote_to_this_mailbox_today',
    });
    const twentiethNewest = newestFirst(mailboxRows, elsewhereRows)[19]!;
    expect(quota.hasReachedLimit && quota.clearsAt.getTime()).toBe(
      twentiethNewest.createdAt.getTime() + IDENTITY_ENQUIRY_WINDOW_MS,
    );
  });
});

describe('loadColdEnquiries', () => {
  it('merges directory rows and persona or company messages newest first, keyed by what they were sent to', async () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
    const runner = {
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql === COLD_LISTING_ENQUIRY_ROWS_SQL
            ? [
                { listingId: 'listing-1', createdAt: hoursAgo(1) },
                { listingId: 'listing-2', createdAt: hoursAgo(5) },
              ]
            : [{ conversationId: 'persona-thread', createdAt: hoursAgo(3) }],
        ),
      ),
    };

    const merged = await loadColdEnquiries(runner, 'member-1');

    expect(merged.map((row) => row.mailboxKey)).toEqual([
      'listing:listing-1',
      'conversation:persona-thread',
      'listing:listing-2',
    ]);
    expect(runner.query).toHaveBeenCalledTimes(2);
  });
});

describe('the cold-enquiry reads', () => {
  it('counts the member’s own messages in threads they started with a persona or company, before the first reply', () => {
    const sql = COLD_IDENTITY_ENQUIRY_MESSAGES_SQL;
    expect(sql).toContain('"cold_message"."sender_id" = $1');
    expect(sql).toContain('"enquiry_conversation"."initiator_user_id" = $1');
    expect(sql).toContain(
      '"cold_message"."created_at" < "enquiry_conversation"."opened_at"',
    );
    expect(sql).toContain(
      `"mailbox_identity"."kind" IN ('subprofile', 'company')`,
    );
    expect(sql).toContain('LIMIT $3');
  });

  it('reads the member’s own directory enquiry rows in the window, bounded', () => {
    const sql = COLD_LISTING_ENQUIRY_ROWS_SQL;
    expect(sql).toContain('"listing_enquiry"."sender_id" = $1');
    expect(sql).toContain('"listing_enquiry"."created_at" > $2');
    expect(sql).toContain('ORDER BY "listing_enquiry"."created_at" DESC');
    expect(sql).toContain('LIMIT $3');
  });
});
