import { HousingGroup } from './entities/housing-group.entity';
import { UpdateGroupDto } from './dto/update-group.dto';

/** The scalar fields an audit note quotes old and new, in full. */
const QUOTED_FIELDS = [
  'slug',
  'name',
  'nameEm',
  'city',
  'isAccessGated',
  'published',
] as const;

/** The list fields an audit note summarises by size, since their text is long. */
const LISTED_FIELDS = ['norms', 'screeningQuestions'] as const;

/** `Housing group <id> "<name>" (<slug>)`, the head every group audit note shares. */
export function describeHousingGroup(group: {
  id: string;
  name: string;
  slug: string;
}): string {
  return `Housing group ${group.id} "${group.name}" (${group.slug})`;
}

/**
 * The fields an update really changes, one short phrase each, for the audit
 * note (ENG-602). A field the body repeats with its current value is left out,
 * so the note lists what moved. The screening questions and norms change who
 * is let into a vetted group, so their count and a changed flag are named.
 */
export function describeHousingGroupChanges(
  before: HousingGroup,
  dto: UpdateGroupDto,
): string[] {
  const changes: string[] = [];
  for (const field of QUOTED_FIELDS) {
    const next = dto[field];
    if (next === undefined || next === before[field]) continue;
    changes.push(
      `${field} ${JSON.stringify(before[field])} to ${JSON.stringify(next)}`,
    );
  }
  for (const field of LISTED_FIELDS) {
    const next = dto[field];
    if (next === undefined) continue;
    const previous = before[field];
    if (JSON.stringify(next) === JSON.stringify(previous)) continue;
    changes.push(`${field} (${previous.length} to ${next.length} entries)`);
  }
  if (dto.blurb !== undefined && dto.blurb !== before.blurb) {
    changes.push('blurb');
  }
  return changes;
}
