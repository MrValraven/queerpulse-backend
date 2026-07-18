/**
 * RFC 4180 CSV serialisation for the Art. 20 archive.
 *
 * This is deliberately a pure module, not a provider: it has no dependencies,
 * it is the part most likely to be wrong in a way only a unit test catches, and
 * both the archive builder and its spec want to call it directly.
 *
 * ---------------------------------------------------------------------------
 * FLATTENING RULE
 * ---------------------------------------------------------------------------
 * A category in the archive is an array of records (or, for `profile`, one
 * record). Records are not flat — `profile.openTo` is an array of objects,
 * `profile.identities`/`tags`/`lookingFor` are arrays of strings, and a future
 * embedded `sender`/counterparty object is exactly the shape that turns a naive
 * exporter's cell into `[object Object]`. So every record is flattened to
 * dot/bracket paths before a header is chosen:
 *
 *   scalar                -> the cell             `body`
 *   null / undefined      -> empty cell           `editedAt`
 *   Date                  -> ISO-8601 string      (defensive; the builder
 *                                                  already stringifies dates)
 *   nested object         -> one column per leaf  `sender.id`, `sender.name`
 *   array of scalars      -> ONE cell, `; `-joined
 *                                                 `tags` = "poly; queer"
 *   array of objects      -> one column per leaf, indexed
 *                                                 `openTo[0].label`
 *   empty array / object  -> empty cell
 *
 * The scalar-array vs object-array split is the one real judgement call.
 * Scalar arrays here are tag-like sets: exploding them into `tags[0]`,
 * `tags[1]`… would make the column set a function of the widest row, so one
 * member with 30 tags gives every other row 30 mostly-empty columns, and adding
 * a tag reshapes the whole file. Joining them keeps one stable column, and `; `
 * (not `,`) keeps the joined value readable inside a quoted cell. Object arrays
 * get the opposite treatment because joining them is exactly the `[object
 * Object]` failure we are avoiding — their fields are separate data and have to
 * land in separate columns, and they are bounded in practice (`openTo` is a
 * handful of blurbs).
 *
 * Recursion always terminates at a scalar or an empty container, so no cell can
 * ever be produced by stringifying an object.
 *
 * ---------------------------------------------------------------------------
 * COLUMN ORDER
 * ---------------------------------------------------------------------------
 * The header is the union of every flattened path across every row, in
 * FIRST-SEEN order (rows scanned in payload order, new paths appended). A row
 * missing a path gets an empty cell, so rows stay aligned even when a category
 * mixes shapes — `posts` interleaves `thread` and `reply` records with
 * different fields.
 *
 * First-seen is chosen over alphabetical because it is equally deterministic —
 * the builder orders every category by `createdAt ASC`, so the same data yields
 * the same discovery order and therefore a byte-identical file — while also
 * preserving the authored field order (`id`, `conversationId`, `body`,
 * `sentAt`) that alphabetical would shred.
 */

/**
 * UTF-8 byte-order mark, prepended to every CSV.
 *
 * WHY: Excel on Windows still opens a `.csv` with no BOM using the system ANSI
 * codepage, which renders the seed data's `Anika Kovač` as `Anika KovaÄ` and
 * `Céu Marques` as `CÃ©u Marques`. A leading BOM is the only in-band signal
 * Excel honours. Google Sheets, LibreOffice, `csv-parse` and Python's
 * `utf-8-sig` all strip it; the cost is that a consumer decoding as plain UTF-8
 * without BOM handling sees a stray `\uFEFF` on the first header name. Mangled
 * names for every non-ASCII member is the worse failure, so the BOM stays.
 *
 * The `.json` member of the archive deliberately gets NO BOM — `JSON.parse`
 * throws on a leading BOM and RFC 8259 lets parsers reject it.
 */
export const UTF8_BOM = '\uFEFF';

const DELIMITER = ',';
// RFC 4180 says CRLF, and it is what Excel expects.
const ROW_TERMINATOR = '\r\n';
// `; ` rather than `,` so a joined scalar array stays legible inside its cell.
const SCALAR_ARRAY_JOIN = '; ';

// Cells needing quoting: the delimiter, a quote, either newline, or leading /
// trailing whitespace (which some parsers silently trim).
const NEEDS_QUOTING = /[",\r\n]/;

// Leading characters Excel / Google Sheets treat as the start of a formula.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
// …except when the whole cell is just a number, where a leading `-` is a sign,
// not an operator. Neutralising `-5` into `'-5` would break every numeric
// column for no security gain.
const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function isContainer(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

function scalarToString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    // `NaN`/`Infinity` have no CSV representation and are not valid JSON
    // either, so they cannot reach here from a `jsonb` payload — but a blank
    // cell beats the literal text "NaN" if they ever do.
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Symbols/functions cannot survive `jsonb`; treat as absent rather than
  // risking a stringification artefact.
  return '';
}

function flatten(
  value: unknown,
  path: string,
  cells: Map<string, string>,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      cells.set(path, '');
      return;
    }
    if (!value.some(isContainer)) {
      cells.set(path, value.map(scalarToString).join(SCALAR_ARRAY_JOIN));
      return;
    }
    value.forEach((element, index) =>
      flatten(element, `${path}[${index}]`, cells),
    );
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      cells.set(path, '');
      return;
    }
    for (const [key, nested] of entries) {
      flatten(nested, `${path}.${key}`, cells);
    }
    return;
  }
  cells.set(path, scalarToString(value));
}

/**
 * Defuse spreadsheet formula injection.
 *
 * Nearly every string in this archive is attacker-influenced: a message body, a
 * vouch note, a bio, a forum title. A cell beginning `=`, `+`, `-`, `@` or a
 * control character is evaluated as a formula the moment the member opens the
 * file — which is the entire point of the CSV format — so `=HYPERLINK(...)`
 * smuggled into a message becomes a live payload in the recipient's export.
 *
 * The mitigation costs fidelity: the cell gains a leading apostrophe. That is
 * acceptable here specifically because CSV is the *spreadsheet* rendering of
 * the archive, not its canonical form — the `json` and `both` formats carry the
 * values byte-exact, and `both` ships them side by side.
 */
function neutralizeFormula(value: string): string {
  if (!FORMULA_LEAD.test(value) || NUMERIC.test(value)) {
    return value;
  }
  return `'${value}`;
}

function escapeCell(raw: string): string {
  const value = neutralizeFormula(raw);
  if (value === '') {
    return '';
  }
  if (NEEDS_QUOTING.test(value) || value !== value.trim()) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// A category is either an array of records (`messages`) or a single record
// (`profile`, which is also allowed to be `null` for a user row that vanished).
function normalizeRows(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((row) =>
      isPlainObject(row) ? row : { value: row as unknown },
    );
  }
  if (isPlainObject(value)) {
    return [value];
  }
  return [{ value }];
}

/**
 * Render one archive category as an RFC 4180 CSV document.
 *
 * A category with no rows yields a BOM and nothing else. That is intentional
 * and unambiguous: `build()` only writes a key for a category the member
 * actually requested, and the builder only writes files for keys that are
 * present — so inside the zip, "file missing" means not requested and "file
 * empty" means requested with no data. There is no column set to invent for
 * zero rows.
 */
export function toCsv(value: unknown): string {
  const rows = normalizeRows(value);
  const columns: string[] = [];
  const seen = new Set<string>();
  const flattened = rows.map((row) => {
    const cells = new Map<string, string>();
    for (const [key, nested] of Object.entries(row)) {
      flatten(nested, key, cells);
    }
    for (const path of cells.keys()) {
      if (!seen.has(path)) {
        seen.add(path);
        columns.push(path);
      }
    }
    return cells;
  });

  if (columns.length === 0) {
    return UTF8_BOM;
  }

  const lines = [columns.map(escapeCell).join(DELIMITER)];
  for (const cells of flattened) {
    lines.push(
      columns.map((path) => escapeCell(cells.get(path) ?? '')).join(DELIMITER),
    );
  }
  return UTF8_BOM + lines.join(ROW_TERMINATOR) + ROW_TERMINATOR;
}
