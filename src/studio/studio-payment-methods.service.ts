import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  normalizeGivingLink,
  normalizeIban,
  normalizeMbwayNumber,
} from '../communities/community-giving-rules';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { ReplaceStudioPaymentMethodsDto } from './dto/replace-studio-payment-methods.dto';
import { StudioPaymentMethodKind } from './entities/studio-payment-method.entity';
import {
  lockPaymentMethodsOf,
  personaHasItemsForSale,
} from './studio-payment-method-lock';
import { StudioOwnershipService } from './studio-ownership.service';
import { STUDIO_PURCHASE_LIMITS } from './studio-purchase-rules';
import type {
  StudioPaymentMethodResponse,
  StudioPaymentMethods,
} from './studio-purchases-response';
import {
  isStudioArtistPersonaKind,
  studioError,
  studioErrorWithDetails,
} from './studio.constants';
import type { StudioErrorCode } from './studio.constants';

/** `$1` persona (subprofile) id. The persona's methods, position ascending. */
export const PERSONA_PAYMENT_METHODS_SQL = `SELECT "method"."id" AS "id",
        "method"."kind"::text AS "kind",
        "method"."label" AS "label",
        "method"."value" AS "value",
        "method"."note" AS "note",
        "method"."position" AS "position",
        "method"."updated_at" AS "updated_at"
   FROM "studio_payment_methods" "method"
  WHERE "method"."subprofile_id" = $1
  ORDER BY "method"."position" ASC, "method"."id" ASC`;

/** `$1` persona (subprofile) id. */
export const PERSONA_KIND_SQL = `SELECT "persona"."kind"::text AS "kind"
   FROM "subprofiles" "persona"
  WHERE "persona"."id" = $1`;

const DELETE_PERSONA_PAYMENT_METHODS_SQL = `DELETE FROM "studio_payment_methods" WHERE "subprofile_id" = $1`;

interface PaymentMethodRow {
  id: string;
  kind: StudioPaymentMethodKind;
  label: string | null;
  value: string;
  note: string | null;
  position: number;
  updated_at: Date;
}

/** A row ready to store: the canonical value and the plain-text label and note. */
interface PaymentMethodDraft {
  kind: StudioPaymentMethodKind;
  label: string | null;
  value: string;
  note: string | null;
}

const NORMALISER_BY_KIND: Record<
  StudioPaymentMethodKind,
  {
    normalise: (value: string) => string | null;
    invalidCode: StudioErrorCode;
  }
> = {
  [StudioPaymentMethodKind.Link]: {
    normalise: normalizeGivingLink,
    invalidCode: 'studio_payment_link_invalid',
  },
  [StudioPaymentMethodKind.Mbway]: {
    normalise: normalizeMbwayNumber,
    invalidCode: 'studio_payment_mbway_invalid',
  },
  [StudioPaymentMethodKind.Iban]: {
    normalise: normalizeIban,
    invalidCode: 'studio_payment_iban_invalid',
  },
};

/** Five parameters per row after the persona id in `$1`. */
const PARAMETERS_PER_ROW = 5;

function insertSqlFor(rowCount: number): string {
  const tuples: string[] = [];
  for (let index = 0; index < rowCount; index++) {
    const first = 2 + index * PARAMETERS_PER_ROW;
    tuples.push(
      `($1, $${first}::studio_payment_method_kind, $${first + 1}, $${first + 2}, $${first + 3}, $${first + 4}::smallint)`,
    );
  }
  return `INSERT INTO "studio_payment_methods" ("subprofile_id", "kind", "label", "value", "note", "position") VALUES ${tuples.join(', ')}`;
}

function toResponseRow(row: PaymentMethodRow): StudioPaymentMethodResponse {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    value: row.value,
    note: row.note,
    position: Number(row.position),
  };
}

function toResponse(
  rows: PaymentMethodRow[],
  hasItemsForSale: boolean,
): StudioPaymentMethods {
  const latest = rows.reduce<Date | null>(
    (newest, row) =>
      newest === null || row.updated_at > newest ? row.updated_at : newest,
    null,
  );
  return {
    methods: rows.map(toResponseRow),
    hasItemsForSale,
    updatedAt: latest === null ? null : latest.toISOString(),
  };
}

/** Whether the stored rows equal the drafts in order (kind, label, value, note). */
function isUnchanged(
  stored: PaymentMethodRow[],
  drafts: PaymentMethodDraft[],
): boolean {
  return (
    stored.length === drafts.length &&
    stored.every((row, index) => {
      const draft = drafts[index];
      return (
        draft !== undefined &&
        row.kind === draft.kind &&
        row.label === draft.label &&
        row.value === draft.value &&
        row.note === draft.note
      );
    })
  );
}

/**
 * The persona's own list of where to get paid (purchases contract 2.2 and
 * 2.3). Values are validated by the community giving normalisers and never
 * appear in a log or an error: a refusal names its reason code and the row
 * index only.
 */
@Injectable()
export class StudioPaymentMethodsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
  ) {}

  /** The persona's methods for a member of that persona. */
  async getMethods(
    userId: string,
    subprofileId: string,
  ): Promise<StudioPaymentMethods> {
    await this.assertMember(userId, subprofileId);
    const rows: PaymentMethodRow[] = await this.dataSource.query(
      PERSONA_PAYMENT_METHODS_SQL,
      [subprofileId],
    );
    const hasItemsForSale = await personaHasItemsForSale(
      this.dataSource,
      subprofileId,
    );
    return toResponse(rows, hasItemsForSale);
  }

  /** Replaces the whole list in array order (contract 2.3). */
  replaceMethods(
    userId: string,
    subprofileId: string,
    body: ReplaceStudioPaymentMethodsDto,
  ): Promise<StudioPaymentMethods> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertMember(userId, subprofileId);
      await this.assertArtistKind(manager, subprofileId);
      if (body.methods.length > STUDIO_PURCHASE_LIMITS.paymentMethodsMax) {
        throw studioError('studio_payment_methods_limit');
      }
      const drafts = body.methods.map((input, index) =>
        this.toDraft(input, index),
      );

      await lockPaymentMethodsOf(manager, subprofileId);
      const hasItemsForSale = await personaHasItemsForSale(
        manager,
        subprofileId,
      );
      if (drafts.length === 0 && hasItemsForSale) {
        throw studioError('studio_payment_methods_needed_for_sale');
      }

      const stored = await this.readRows(manager, subprofileId);
      if (isUnchanged(stored, drafts)) {
        return toResponse(stored, hasItemsForSale);
      }

      await manager.query(DELETE_PERSONA_PAYMENT_METHODS_SQL, [subprofileId]);
      if (drafts.length > 0) {
        await manager.query(
          insertSqlFor(drafts.length),
          drafts.flatMap((draft, position) => [
            draft.kind,
            draft.label,
            draft.value,
            draft.note,
            position,
          ]),
        );
      }
      const fresh = await this.readRows(manager, subprofileId);
      return toResponse(fresh, hasItemsForSale);
    });
  }

  private readRows(
    manager: EntityManager,
    subprofileId: string,
  ): Promise<PaymentMethodRow[]> {
    return manager.query(PERSONA_PAYMENT_METHODS_SQL, [subprofileId]);
  }

  private async assertMember(
    userId: string,
    subprofileId: string,
  ): Promise<void> {
    if (!(await this.ownership.isPersonaMember(userId, subprofileId))) {
      throw studioError('studio_persona_not_found');
    }
  }

  private async assertArtistKind(
    manager: EntityManager,
    subprofileId: string,
  ): Promise<void> {
    const rows: { kind: string }[] = await manager.query(PERSONA_KIND_SQL, [
      subprofileId,
    ]);
    const kind = rows[0]?.kind;
    if (kind === undefined) throw studioError('studio_persona_not_found');
    if (!isStudioArtistPersonaKind(kind)) {
      throw studioError('studio_persona_kind_not_allowed');
    }
  }

  /** One input row through its kind's normaliser. A failure names the row. */
  private toDraft(
    input: ReplaceStudioPaymentMethodsDto['methods'][number],
    index: number,
  ): PaymentMethodDraft {
    const { normalise, invalidCode } = NORMALISER_BY_KIND[input.kind];
    const value = normalise(input.value);
    if (value === null) {
      throw studioErrorWithDetails(invalidCode, { index });
    }
    return {
      kind: input.kind,
      label: toStoredPlainTextOrNull(input.label),
      value,
      note: toStoredPlainTextOrNull(input.note),
    };
  }
}
