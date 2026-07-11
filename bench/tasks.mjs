/**
 * EC-correctness benchmark task set. Each task is sent verbatim as the chat
 * user message. `kind: 'write'` tasks expect an EC snippet back (verified with
 * ec_preview); `kind: 'explain'` tasks are judged as prose against
 * skills/extended-code/reference.md.
 *
 * `expect` is the reference answer computed live against the Steadfast
 * workspace (2026-07-11) — used by the human judge, never sent to the model.
 * `primer` marks the subset re-run under the workspace-primer config.
 */
export const TASKS = [
  // ── String ops ──
  {
    id: 'str-caseins', category: 'string', kind: 'write',
    prompt: 'Write Extended Code that outputs true when the name of the object with business id 4761 contains the word "register", ignoring case, and false otherwise.',
    expect: 'true — via wildcard compare name = "*register*" (only case-insensitive idiom); toLowerCase()/CONTAINS are traps',
  },
  {
    id: 'str-substr', category: 'string', kind: 'write',
    prompt: 'Write Extended Code that checks whether the string "Control Register" contains the substring "trol" (case-sensitive) and outputs the character index where it starts, or -1 when it is absent.',
    expect: '3 — .indexOf("trol") with .whenMissing(-1); .contains()/.includes() are traps',
  },
  {
    id: 'str-concat', category: 'string', kind: 'write',
    prompt: 'Write Extended Code that outputs a single string of the form "<name> [<businessId>]" for the object with business id 4761. Example shape: Control Register [4761].',
    expect: '"Control Register [4761]" — + concatenation, business id property is .id',
  },
  {
    id: 'str-strip', category: 'string', kind: 'write',
    prompt: 'In Extended Code, a variable holds _s := "  Steadfast Group  ". Write code that removes the leading and trailing whitespace and outputs only the first 5 characters of the trimmed string.',
    expect: '"Stead" — .strip() (not .trim()) then .substring(0, 5) (not .slice)',
  },
  // ── List ops ──
  {
    id: 'list-count', category: 'list', kind: 'write', primer: true,
    prompt: 'Write Extended Code that counts how many Scorecard objects under root.organisation have a name containing "register" (any letter case).',
    expect: '9 — descendants(Scorecard).filter(name = "*register*").size(); lambda filter is a trap',
  },
  {
    id: 'list-join', category: 'list', kind: 'write',
    prompt: 'Write Extended Code that outputs the names of the direct children of root.organisation joined with " | ".',
    expect: 'Steadfast Group | Steadfast Demo | configurator | Sandbox — children().as(name).join(" | ")',
  },
  {
    id: 'list-distinct', category: 'list', kind: 'write',
    prompt: 'Write Extended Code that outputs the distinct classNames of all descendants of root.organisation as one comma-separated string.',
    expect: '35 class names — .as(className).distinct().join(", ")',
  },
  {
    id: 'list-avg', category: 'list', kind: 'write',
    prompt: 'Write Extended Code that computes the average length (in characters) of the names of the direct children of root.organisation.',
    expect: '12 — .calculate(name.size()).avg(); .length is a trap',
  },
  {
    id: 'list-index', category: 'list', kind: 'write',
    prompt: 'Write Extended Code that sorts the Scorecard objects under root.organisation by name and outputs the name of the first, the third, and the last one (label which is which).',
    expect: 'first=Action Register, third=Assessment Register (item(2), 0-based), last=🧪 Demo Sandbox — widget exploration',
  },
  {
    id: 'list-groupby', category: 'list', kind: 'write',
    prompt: 'Using a group-by, write Extended Code that groups all descendants of root.organisation by their className and then outputs how many of them are TextElement objects.',
    expect: '92 — .map(className).get("TextElement").size(); map is group-by, NOT a transform',
  },
  // ── Control flow ──
  {
    id: 'flow-ifvalue', category: 'flow', kind: 'write',
    prompt: 'Write Extended Code that assigns the string "big" to a variable when there are more than 100 Task objects under root.organisation and "small" otherwise, then outputs that variable.',
    expect: '"big" (400 tasks) — needs _n assigned before comparing (no inline .size() > 100 chain), IF-as-value parenthesized, no ternary',
  },
  {
    id: 'flow-foreach', category: 'flow', kind: 'write', primer: true,
    prompt: 'Using a forEach loop, write Extended Code that walks all descendants of root.organisation, counts the objects whose name contains "risk" (ignore letter case), collects those names into one semicolon-separated string, and at the end outputs both the count and the collected names.',
    expect: 'count=66 — forEach(_o: ...) colon syntax, accumulators initialized before loop, wildcard name match',
  },
  {
    id: 'flow-nested', category: 'flow', kind: 'write',
    prompt: 'Write Extended Code that outputs "many" when there are more than 100 CustomVisualization objects under root.organisation, "some" when there are between 51 and 100, and "few" otherwise.',
    expect: '"many" (120 CVOs) — nested IF inside ELSE (no else-if), ENDIF per IF',
  },
  // ── Object refs ──
  {
    id: 'ref-fallback', category: 'refs', kind: 'write',
    prompt: 'Write Extended Code that reads the description property of the object with business id 4761 and outputs "(no description)" when the description is empty or missing.',
    expect: 'description is "" (empty, not MISSING) — whenMissing alone outputs ""; correct answer also tests = "" / .size() = 0',
  },
  {
    id: 'ref-bid', category: 'refs', kind: 'write', primer: true,
    prompt: 'Write Extended Code that outputs the name and the className of the object whose business id is sc_control_register.',
    expect: 'Control Register / Scorecard — t.sc_control_register (never o.<rid>)',
  },
  {
    id: 'ref-exprtext', category: 'refs', kind: 'write',
    prompt: 'The workspace has a stored expression object with business id json_size. Write Extended Code that outputs the raw source code text stored in that expression object, WITHOUT evaluating it.',
    expect: 'output(t.json_size.expression) — bare .expression EVALUATES',
  },
  // ── Class vs template ──
  {
    id: 'tmpl-count-risk', category: 'template', kind: 'write', primer: true,
    prompt: 'How many Risk objects are there under root.organisation? Write Extended Code that counts them.',
    expect: 'descendants(Risk) throws "Type Risk not found"; correct: filter(linkedTo.name = "*risk*") → 43',
  },
  {
    id: 'tmpl-count-control', category: 'template', kind: 'write', primer: true,
    prompt: 'Write Extended Code that counts all objects under root.organisation that were built from a template whose name contains "control".',
    expect: '17 — filter(linkedTo.name = "*control*"); .template returns 0 in this model',
  },
  // ── Append trap ──
  {
    id: 'list-append', category: 'list', kind: 'write',
    prompt: 'Write Extended Code that starts with an empty list, appends the name of each direct child of root.organisation to that list one at a time inside a forEach loop, and finally outputs the list joined with ", ".',
    expect: 'Steadfast Group, Steadfast Demo, configurator, Sandbox — :+ and .push() are traps; _l := _l.union(LIST(x))',
  },
  // ── Explain tasks (prose judged against reference.md) ──
  {
    id: 'explain-map', category: 'explain', kind: 'explain',
    prompt: 'Explain what this Extended Code does, line by line. In particular: what does map return here?\n\n```extended\n_g := root.organisation.descendants().map(className)\n_g.get("Scorecard").size()\n```',
    expect: 'map(prop) is GROUP-BY returning a MAP keyed by className; get("Scorecard") returns the list of Scorecard objects; .size() counts them (45)',
  },
  {
    id: 'explain-exprtext', category: 'explain', kind: 'explain',
    prompt: 'In Extended Code, what is the difference between these two lines? What does each one return?\n\n```extended\noutput(t.json_size.expression)\n```\n\n```extended\nt.json_size.expression\n```',
    expect: 'output(...) returns the raw stored source TEXT; bare .expression EVALUATES the stored code and returns its result',
  },
  {
    id: 'explain-filter', category: 'explain', kind: 'explain',
    prompt: 'Explain what this Extended Code does. Is the name match case-sensitive? And why is _n assigned to a variable first instead of comparing root.organisation.descendants().filter(name = "*risk*").size() > 0 directly in the IF?\n\n```extended\n_n := root.organisation.descendants().filter(name = "*risk*").size()\nIF _n > 0 THEN\n     "found " + _n\nELSE\n     "none"\nENDIF\n```',
    expect: 'wildcard = "*risk*" is case-INsensitive; inline chained-comparison .size() > 0 is a parse error (chaining limit), hence the assignment',
  },
];
