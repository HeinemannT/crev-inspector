import { KNOWLEDGE } from './knowledge';
import { EC_EDITOR_PERSONA } from './editor-prompt';

export const EC_EDITOR_PROMPT_VARIANTS = [
  'production',
  'standalone-language',
  'standalone-full',
  'structured-editor',
  'negative-contrast',
  'similar-but-different',
  'compact-examples',
] as const;

export type EcEditorPromptVariant = typeof EC_EDITOR_PROMPT_VARIANTS[number];

export const EC_COMPACT_REFERENCE = `# Extended Code specification

Use this as a closed language specification. Existing source identifiers and
exact names supplied by the task are the permitted workspace vocabulary. Keep
them unchanged unless the task explicitly changes one. If a construct is not
defined here, do not invent it.

## Core syntax

- Assignment and named arguments: \`:=\`. Equality: \`=\`; inequality: \`!=\`.
- Missing value: \`MISSING\`. Boolean values: \`TRUE\`, \`FALSE\`.
- Branch: \`IF condition THEN ... ELSE ... ENDIF\`; \`ELSE\` is optional.
  An IF used as a value must be parenthesized.
- Loop: \`list.forEach(_item: ... )\`. Local variables begin with \`_\`.
- The last expression is the result. \`output(x)\` is used when explicitly
  required, including reading stored expression source as text.

## Objects and configuration

- Preserve existing \`t.\`, \`o.\`, and \`r.\` namespaces exactly.
- Preserve a supplied enterprise class-root collection such as
  \`root.CeRiskAssessment.children\`; its \`children\` is a property, not an
  ordinary object \`children()\` method.
- Persist properties with \`object.change(property := value)\`.
- Create with \`parent.add(UnquotedType, id := "stable_id", ...)\`.
- BMP Default card: \`t._defaultCardId\`.
- Responsive widget width is 0–6; 0 is class-dependent, normal authored widths are 1–6, and full width is 6 at each requested breakpoint.
- Bare \`t.id.expression\` evaluates stored code;
  \`output(t.id.expression)\` returns its source text.

## Collections, strings, JSON, and tables

- Filter: \`list.filter(property = value)\`, with a bare element-property
  condition and no iterator variable.
- Loop: \`list.forEach(_item: ... )\`.
- Append while keeping duplicates:
  \`_list := _list.union(LIST(_item))\`.
- Group into a MAP: \`list.map(property)\`. Transform items with
  \`list.calculate(expression)\`.
- Size: \`.size()\`; string trim: \`.strip()\`; text conversion: \`str(x)\`;
  numeric conversion: \`num(text)\`.
- Case-insensitive substring matching uses wildcard equality:
  \`name = "*risk*"\`.
- Parse JSON with uppercase \`JSON(text)\`. Primitive JSON array items are
  wrappers; numeric conversion is \`num(str(_item))\`.
- Do not call a method on the result of a function call. Assign the function
  result to a local variable first when another operation is needed.
- Return tables with \`collection.table(property, ...)\` or
  \`createtable(...)\` plus \`.addRow(...)\`. Table properties are bare
  accessors, not quoted strings.
- Assign a chained result before comparing it: first
  \`_n := list.filter(...).size()\`, then \`IF _n > 0 THEN ... ENDIF\`.

## Edit behavior

Make the smallest valid edit. Preserve every unrequested statement, output,
identifier, literal value, field order, object reference, and indentation.`;

const POSITIVE_EXAMPLES = `# Positive EC patterns

Use these as language patterns, not as templates; keep the actual task's
identifiers and requested behavior.

Task: retain only open rows.
\`\`\`extended
_open := _rows.filter(lifecycleState = t.state_open)
\`\`\`

Task: append the current row to an accumulator.
\`\`\`extended
_selected := _selected.union(LIST(_row))
\`\`\`

Task: persist a visibility change and preserve the existing result.
\`\`\`extended
t.qa_widget.change(visible := FALSE)
output(t.qa_widget)
\`\`\`

Task: sum primitive numbers from a JSON array.
\`\`\`extended
_values := JSON("[2,3]")
_total := 0
_values.forEach(_value:
     _total := _total + num(str(_value))
)
output(_total)
\`\`\``;

const FRAMES: Record<Exclude<EcEditorPromptVariant, 'production'>, string> = {
  'standalone-language': EC_EDITOR_PERSONA,
  'standalone-full': EC_EDITOR_PERSONA,
  'structured-editor': EC_EDITOR_PERSONA,
  'negative-contrast': `You are a one-shot editor for Corporater BMP Extended
Code. EC is NOT JavaScript, Python, or SQL. Never transfer syntax or APIs from
those languages; use only the supplied EC specification. Return only the
requested code artifact.`,
  'similar-but-different': `You are a one-shot editor for Corporater BMP
Extended Code. EC may look superficially similar to JavaScript and expression
languages, but its grammar and APIs differ. Use a familiar-looking construct
only when the supplied EC specification defines that exact form. Return only
the requested code artifact.`,
  'compact-examples': `You are a one-shot editor for Corporater BMP Extended
Code. EC is a standalone proprietary programming language with a closed grammar
and API. Apply the supplied specification and positive patterns exactly. Return
only the requested code artifact.`,
};

export function parseEcEditorPromptVariant(value: string | undefined): EcEditorPromptVariant {
  const candidate = value?.trim() || 'production';
  if ((EC_EDITOR_PROMPT_VARIANTS as readonly string[]).includes(candidate)) {
    return candidate as EcEditorPromptVariant;
  }
  throw new Error(`Unknown EC editor prompt variant: ${candidate}`);
}

export function ecEditorSystemForVariant(
  variant: EcEditorPromptVariant,
  productionSystem: string,
): string {
  if (variant === 'production') return productionSystem;
  if (variant === 'standalone-full') {
    return [FRAMES[variant], KNOWLEDGE.bmpEditor, KNOWLEDGE.ec].join('\n\n---\n\n');
  }
  if (variant === 'structured-editor') {
    return [FRAMES[variant], KNOWLEDGE.bmpEditor, KNOWLEDGE.ecEditor].join('\n\n---\n\n');
  }
  return [
    FRAMES[variant],
    KNOWLEDGE.bmpEditor,
    EC_COMPACT_REFERENCE,
    ...(variant === 'compact-examples' ? [POSITIVE_EXAMPLES] : []),
  ].join('\n\n---\n\n');
}
