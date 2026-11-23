import { FindOperator } from 'typeorm';
import {
  memberIdShownOnPeopleListIn,
  memberShownOnPeopleListSql,
} from './persona-creator-gates';

describe('memberIdShownOnPeopleListIn', () => {
  // SEC-21: a credit names a member only while the people lists would.
  it('matches the given ids through the shared people-list rule', () => {
    const operator = memberIdShownOnPeopleListIn(['member-1', 'member-2']);

    expect(operator).toBeInstanceOf(FindOperator);
    expect(operator.type).toBe('raw');
    const parameters = operator.objectLiteralParameters ?? {};
    const parameterNames = Object.keys(parameters);
    expect(parameterNames).toHaveLength(1);
    const [parameterName = ''] = parameterNames;
    expect(parameterName).toMatch(/^shownPeopleListMemberIds\d+$/);
    expect(parameters[parameterName]).toEqual(['member-1', 'member-2']);
    const sql = operator.getSql?.('Profile.userId') ?? '';
    expect(sql).toContain(`(Profile.userId IN (:...${parameterName})`);
    expect(sql).toContain(memberShownOnPeopleListSql('(Profile.userId)'));
  });

  it('binds each call under its own parameter name', () => {
    const first = memberIdShownOnPeopleListIn(['member-1']);
    const second = memberIdShownOnPeopleListIn(['member-2']);

    const firstNames = Object.keys(first.objectLiteralParameters ?? {});
    const secondNames = Object.keys(second.objectLiteralParameters ?? {});
    expect(firstNames).toHaveLength(1);
    expect(secondNames).toHaveLength(1);
    expect(firstNames[0]).not.toBe(secondNames[0]);
  });

  it('reads an active account and no live 24-hour hide', () => {
    const sql = memberShownOnPeopleListSql('"profile"."user_id"');

    expect(sql).toContain(`"people_list_user"."status" = 'active'`);
    expect(sql).toContain(`"people_list_profile"."hidden_until" > now()`);
  });
});
