# Admin Recovery Runbook

**Scope:** what to do when the platform has **zero reachable Admins** — the
sole Admin account is locked out, deleted, or its Google account is
compromised. There is no in-app recovery path for this: `/genesis`
(`src/genesis/`) is architecturally single-use and self-disabling after the
first real member exists (see `GenesisService.mintGenesisInvite` — it 404s
once `realMemberCount > 0`), so it cannot be reused to mint a second admin.
Recovery from this state is a direct database write. This document is that
procedure.

**Before you do anything here:** the ordinary safeguards
(`AdminMembersService.updateRole` refuses to demote the last Admin;
`AccountService.deactivate` / `requestDeletion` refuse to let the last Admin
lock themselves out — see `AccountService.assertNotSoleAdmin`) mean this
situation should only be reachable through something those guards don't cover:
a compromised or lost Google account behind the sole Admin's login, a manual
DB mistake, or a bug. Confirm you're actually in that state before writing to
prod — see §1.

---

## 1. Confirm there is no reachable Admin

Connect to the production database (`DATABASE_URL`, same as
`docs/ops/backup-restore.md`) and run:

```sql
SELECT u.id, u.role, u.status, u.is_system, p.slug, p.first_name, p.last_name
FROM users u
LEFT JOIN profiles p ON p.user_id = u.id
WHERE u.role = 'admin';
```

- **Zero rows**, or every row has `status <> 'active'` (suspended/deactivated)
  or `is_system = true` (the house account's `role` is always `member` —
  see `User.isSystem` — so it can never appear here anyway): there is no
  reachable Admin. Proceed to §2.
- **A row with `status = 'active'` and `is_system = false`**: that account can
  still sign in and use the console normally. This is not a lost-admin
  situation — do not proceed. If the concern is "that person is unreachable"
  rather than "the account can't sign in", that's an offboarding problem, not
  a recovery one: have any working Admin grant a second Admin the normal way
  (`PATCH /admin/members/:id/role`), which does not require this runbook.

---

## 2. Identify who to promote

Confirm, **out-of-band** (a call, a known secondary contact method — not just
a claim in a support ticket or DM), that the person you're about to promote is
actually who they say they are and actually wants Admin access. This is the
single highest-power account type on the platform: `Roles(UserRole.Admin)`
gates every admin console surface, including granting Admin to anyone else.

Find their `user_id` by their profile slug (the `/members/<slug>` handle) or
email:

```sql
-- by profile slug
SELECT u.id, u.role, u.status
FROM users u
JOIN profiles p ON p.user_id = u.id
WHERE p.slug = '<their-profile-slug>';

-- by email (users.email is select:false in the app, but a raw SQL session
-- reads it like any other column)
SELECT id, role, status FROM users WHERE email = '<their-email>';
```

Confirm `status = 'active'` before promoting — promoting a suspended or
deactivated account gives them Admin the moment they're unblocked, with no
review at that point.

---

## 3. Promote them to Admin

```sql
BEGIN;

UPDATE users
SET role = 'admin'
WHERE id = '<user-id>'
RETURNING id, role;  -- confirm exactly one row, role = 'admin'

COMMIT;
```

`role` is the `users_role_enum` column (`member` / `moderator` / `admin`) —
see `User.role` in `src/users/entities/user.entity.ts`. There is no other
column or table to touch; role is not cached anywhere server-side (every
request re-reads it via `RolesGuard`), so the change takes effect on the
member's next request with no restart or cache-bust needed. Their **current
session's JWT** does not carry role as a claim it needs to change (`RolesGuard`
reads the DB row, not the token — confirm this hasn't drifted before relying
on it if the auth strategy changes), so no forced re-login should be required,
but ask them to reload the admin console and check they can see it.

---

## 4. Write the audit trail by hand

**This bypasses `mod_audit_logs` entirely — the app's normal audit trail for
a role change (`AdminMembersService.updateRole`) never runs, because you wrote
`users.role` directly.** Anyone reviewing the audit log later will see this
Admin's `role_changed` history has a gap. Close it by inserting the row the
app would have written, so the trail stays honest about what happened and who
did it:

```sql
INSERT INTO mod_audit_logs
  (id, report_id, actor_id, target_user_id, target_name, action, reason_code, note, duration, created_at)
VALUES
  (
    uuid_generate_v4(),
    NULL,
    NULL, -- the person running this SQL is very likely not themselves a
          -- member row you can cite as actor_id; NULL renders as "Deleted
          -- member" in the audit feed today, which is honest — nobody
          -- acting through the app did this. If you DO have a real admin
          -- user_id to attribute it to (e.g. a surviving admin authorized
          -- the recovery), use it instead of NULL.
    '<user-id>',
    '<their first + last name, exactly as shown in §2>',
    'role_changed',
    NULL,
    'member → admin (manual DB recovery — see docs/ADMIN_RECOVERY_RUNBOOK.md)',
    NULL,
    now()
  );
```

This shows up in the admin governance Audit tab (`GET /mod/audit`) like any
other `role_changed` row, with the note flagging it as a manual recovery
rather than a console action.

---

## 5. After recovery

- Have the new Admin sign in and confirm they can reach `/admin` and see
  themselves listed with the Admin role (Members → their profile → Role &
  permissions, or the staff roster at `/admin/staff`).
- If the previous sole Admin's account was compromised (not just lost),
  suspend or deactivate it from the console once the new Admin can act —
  don't leave a compromised account holding whatever role it had before.
- If this happened because the sole Admin deactivated/deleted their own
  account, note that `AccountService.assertNotSoleAdmin` (added alongside
  this runbook) should have blocked exactly that path going forward for any
  *future* sole Admin — if it didn't, that's a regression worth filing, not
  something to route around with this runbook again.
