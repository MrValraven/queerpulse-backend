import {
  BADGED_STAFF_ROLE_IDS,
  STAFF_ROLE_IDS,
  STAFF_ROLES,
  isBadgedStaffRoleId,
  isStaffRoleId,
} from './staff-roles.registry';

describe('staff roles registry: music_manager_producer', () => {
  it('registers music_manager_producer with a public staff badge', () => {
    expect(STAFF_ROLE_IDS).toContain('music_manager_producer');
    expect(STAFF_ROLES.music_manager_producer.hasPublicStaffBadge).toBe(true);
    expect(BADGED_STAFF_ROLE_IDS).toContain('music_manager_producer');
  });

  it('derives the badged list from the flag', () => {
    expect(BADGED_STAFF_ROLE_IDS).toEqual(
      STAFF_ROLE_IDS.filter(
        (staffRoleId) => STAFF_ROLES[staffRoleId].hasPublicStaffBadge,
      ),
    );
  });

  it('keeps the five unbadged grants unbadged', () => {
    const unbadgedRoleIds = [
      'magazine_writer',
      'partnerships',
      'product_manager',
      'cultural_producer',
      'vj_operator',
    ] as const;
    expect(
      unbadgedRoleIds.map(
        (staffRoleId) => STAFF_ROLES[staffRoleId].hasPublicStaffBadge,
      ),
    ).toEqual([false, false, false, false, false]);
  });

  it('states the house scope and the three refusals in its grants', () => {
    const joinedGrants = STAFF_ROLES.music_manager_producer.grants.join('\n');
    expect(joinedGrants).toContain('admin/music-events');
    expect(joinedGrants).toContain('Studio artists');
    expect(joinedGrants).toContain('NOT a member');
    expect(joinedGrants).toContain('NOT delete an event');
    expect(joinedGrants).toContain('NOT co-host');
  });

  it('opens Studio home curation and keeps the Studio page closed', () => {
    const joinedGrants = STAFF_ROLES.music_manager_producer.grants.join('\n');
    expect(joinedGrants).toContain('admin/studio/curation');
    expect(joinedGrants).toContain('admin/studio/scenes');
    expect(joinedGrants).toContain('admin/studio/spotlight');
    expect(joinedGrants).toContain('Artist of the month');
    expect(joinedGrants).toContain('New stars');
    expect(joinedGrants).toContain('NOT the Studio page');
    expect(joinedGrants).toContain('Waiting for Studio');
  });

  it('opens the leads directory', () => {
    const joinedGrants = STAFF_ROLES.music_manager_producer.grants.join('\n');
    expect(joinedGrants).toContain('admin/leads');
    expect(joinedGrants).toContain('link a lead to a persona');
  });

  it('accepts the new id through isStaffRoleId and isBadgedStaffRoleId', () => {
    expect(isStaffRoleId('music_manager_producer')).toBe(true);
    expect(isBadgedStaffRoleId('music_manager_producer')).toBe(true);
  });
});

describe('staff roles registry: vj_operator', () => {
  it('registers vj_operator last and without a public staff badge', () => {
    expect(STAFF_ROLE_IDS.at(-1)).toBe('vj_operator');
    expect(STAFF_ROLES.vj_operator.hasPublicStaffBadge).toBe(false);
    expect(BADGED_STAFF_ROLE_IDS).not.toContain('vj_operator');
    expect(isStaffRoleId('vj_operator')).toBe(true);
    expect(isBadgedStaffRoleId('vj_operator')).toBe(false);
  });

  it('opens the VJ library, the screen and the remote, and states what stays closed', () => {
    const joinedGrants = STAFF_ROLES.vj_operator.grants.join('\n');
    expect(joinedGrants).toContain('admin/vj');
    expect(joinedGrants).toContain('`/vj` socket');
    expect(joinedGrants).toContain('vj_clip, vj_thumbnail and vj_preview');
    expect(joinedGrants).toContain('NOT the title or start of a linked event');
    expect(joinedGrants).toContain('NOT the socket during a platform lockdown');
    expect(joinedGrants).toContain('NOT any other admin surface');
  });
});
