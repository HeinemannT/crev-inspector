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
  // ── Advanced synthetic programs ──
  // These do not depend on mutable workspace counts. Their reference programs
  // are live-previewed on Steadfast and executable by verify-bench.mjs.
  {
    id: 'advanced-string-delimiters', category: 'string', kind: 'write', advanced: true,
    prompt: 'Write Extended Code that starts with the exact string "  Alpha||beta||Gamma  ", strips only the outside whitespace, splits it on the two-character delimiter || without using any nonexistent split/trim/replace method, and outputs the three fields joined as "Alpha > beta > Gamma".',
    expect: 'Alpha > beta > Gamma — indexOf + substring with intermediate variables; .split() is a runtime trap',
    resultIncludes: ['Alpha > beta > Gamma'],
    forbidCode: ['.split(', '.trim(', '.replace(', 't.str_split.expression'],
    referenceCode: `_s := "  Alpha||beta||Gamma  "
_s := _s.strip()
_i1 := _s.indexOf("||")
_first := _s.substring(0, _i1)
_rest := _s.substring(_i1 + 2, _s.size())
_i2 := _rest.indexOf("||")
_second := _rest.substring(0, _i2)
_third := _rest.substring(_i2 + 2, _rest.size())
LIST(_first, _second, _third).join(" > ")`,
  },
  {
    id: 'advanced-json-primitive-sum', category: 'json', kind: 'write', advanced: true,
    prompt: 'Write Extended Code that parses the JSON number array [7, 11, 13, 17], sums only values greater than 10, and outputs 41. Account for the runtime representation of primitive JSON array items.',
    expect: '41 — each primitive item must be converted with num(str(item)) before arithmetic',
    resultIncludes: ['Result : 41'],
    forbidCode: ['.sum(', '.reduce(', '=>'],
    requireCode: ['JSON('],
    referenceCode: `_numbers := JSON("[7, 11, 13, 17]")
_total := 0
_numbers.forEach(_wrapped:
     _text := str(_wrapped)
     _value := num(_text)
     IF _value > 10 THEN
          _total := _total + _value
     ENDIF
)
_total`,
  },
  {
    id: 'advanced-json-string-array', category: 'json', kind: 'write', advanced: true,
    prompt: 'Write Extended Code that parses the JSON string array ["Alpha", "Beta", "Gamma"] and outputs Alpha|Beta|Gamma without quote characters. Handle the wrapped primitive-string representation explicitly.',
    expect: 'Alpha|Beta|Gamma — str(item) retains surrounding quotes, so remove them with substring before joining',
    resultIncludes: ['Alpha|Beta|Gamma'],
    forbidCode: ['.replace(', '.map(', '=>'],
    requireCode: ['JSON('],
    referenceCode: `_tags := JSON("[\\"Alpha\\", \\"Beta\\", \\"Gamma\\"]")
_clean := LIST()
_tags.forEach(_wrapped:
     _raw := str(_wrapped)
     _value := _raw.substring(1, _raw.size() - 1)
     _clean := _clean.union(LIST(_value))
)
_clean.join("|")`,
  },
  {
    id: 'advanced-json-nested-aggregate', category: 'json', kind: 'write', advanced: true,
    prompt: 'Write Extended Code for this JSON value: [{"name":"North","values":[3,5,8]},{"name":"South","values":[2,7]}]. Sum each nested values array and output exactly North=16; South=9. Use distinct iterator variables and do not assume JSON primitive numbers are native EC numbers.',
    expect: 'North=16; South=9 — nested colon-forEach loops, num(str(item)), and a list accumulator',
    resultIncludes: ['North=16; South=9'],
    forbidCode: ['.sum(', '.reduce(', '=>', ':+'],
    requireCode: ['JSON('],
    referenceCode: `_groups := JSON("[{\\"name\\":\\"North\\",\\"values\\":[3,5,8]},{\\"name\\":\\"South\\",\\"values\\":[2,7]}]")
_summary := LIST()
_groups.forEach(_group:
     _total := 0
     _group.values.forEach(_wrapped:
          _raw := str(_wrapped)
          _total := _total + num(_raw)
     )
     _line := _group.name + "=" + _total
     _summary := _summary.union(LIST(_line))
)
_summary.join("; ")`,
  },
  {
    id: 'advanced-json-mutation', category: 'json', kind: 'write', advanced: true,
    prompt: 'Write Extended Code that starts with JSON object {"id":"B","score":20}, adds status="review" without losing the existing fields, appends the updated object to [{"id":"A","score":10}], and outputs the final JSON array. The Steadfast utility expressions json_set and json_append are available and may be used with their documented scope variables.',
    expect: '[{"id":"A","score":10}, {"id":"B","score":20,"status":"review"}] — json_set scope _x/_k/_v, then json_append scope _arr/_new',
    resultIncludes: ['{"id":"A","score":10}', '{"id":"B","score":20,"status":"review"}'],
    forbidCode: ['.push(', ':+', '.set('],
    requireCode: ['JSON(', 't.json_set.expression', 't.json_append.expression'],
    referenceCode: `_x := JSON("{\\"id\\":\\"B\\",\\"score\\":20}")
_k := "status"
_v := "review"
_updated := t.json_set.expression
_arr := JSON("[{\\"id\\":\\"A\\",\\"score\\":10}]")
_new := _updated
_result := t.json_append.expression
str(_result)`,
  },
  {
    id: 'advanced-json-filtered-table', category: 'table', kind: 'write', advanced: true,
    prompt: 'Write Extended Code that parses [{"id":"A","score":82,"active":true},{"id":"B","score":91,"active":false},{"id":"C","score":88,"active":true}], keeps only active rows, sorts them by score descending, and returns a rendered table. Preserve the rows despite the known JSON filter→table quirk.',
    expect: 'Table rows C/88/true then A/82/true — reparse the filtered value with JSON(str(filtered)) before table()',
    resultIncludes: ['id score active', 'C 88 true', 'A 82 true'],
    forbidCode: ['.filter(_', '=>'],
    requireCode: ['JSON(str(', '.table('],
    referenceCode: `_rows := JSON("[{\\"id\\":\\"A\\",\\"score\\":82,\\"active\\":true},{\\"id\\":\\"B\\",\\"score\\":91,\\"active\\":false},{\\"id\\":\\"C\\",\\"score\\":88,\\"active\\":true}]")
_active := _rows.filter(active = TRUE)
_safe := JSON(str(_active))
_safe.sortReverse(score).table()`,
  },
  {
    id: 'advanced-list-union-merge', category: 'list', kind: 'write', advanced: true,
    prompt: 'Write Extended Code using _a := LIST("A", "B", "A") and _b := LIST("B", "C"). Output both combinations exactly as union=A,B,A,B,C; merge=A,B,C. Do not assume union and merge have their conventional set meanings.',
    expect: 'union keeps duplicates; merge deduplicates',
    resultIncludes: ['union=A,B,A,B,C; merge=A,B,C'],
    forbidCode: ['.concat(', '.push(', ':+'],
    referenceCode: `_a := LIST("A", "B", "A")
_b := LIST("B", "C")
_union := _a.union(_b)
_merge := _a.merge(_b)
"union=" + _union.join(",") + "; merge=" + _merge.join(",")`,
  },
  {
    id: 'advanced-map-aggregate-table', category: 'table', kind: 'write', advanced: true,
    prompt: 'Write Extended Code that builds a MAP with Q1 -> LIST(10,20,30) and Q2 -> LIST(15,25), aggregates each list to its total, and returns a table with headers Quarter and Total. The result must show Q1=60 and Q2=40.',
    expect: 'MAP(...).sum().table("Quarter", "Total") — aggregate methods work on list-valued maps',
    resultIncludes: ['Quarter Total', 'Q1 60.00', 'Q2 40.00'],
    forbidCode: ['.keys(', '.forEach('],
    requireCode: ['MAP(', '.sum(', '.table('],
    referenceCode: `_byQuarter := MAP("Q1"; LIST(10, 20, 30), "Q2"; LIST(15, 25))
_totals := _byQuarter.sum()
_totals.table("Quarter", "Total")`,
  },
  {
    id: 'advanced-table-explicit-rows', category: 'table', kind: 'write', advanced: true,
    prompt: 'Write Extended Code that parses [{"id":"A","label":"Alpha","amount":12.5},{"id":"B","label":"Beta","amount":7.25}] and returns a table with headers ID, Label, Amount and one row per JSON object. Use an explicit table and rows rather than relying on property-bound columns.',
    expect: 'createtable + forEach + addRow; rows A/Alpha/12.50 and B/Beta/7.25',
    resultIncludes: ['ID Label Amount', 'A Alpha 12.50', 'B Beta 7.25'],
    forbidCode: ['createTable(', '=>'],
    requireCode: ['JSON(', 'createtable(', '.addRow('],
    referenceCode: `_rows := JSON("[{\\"id\\":\\"A\\",\\"label\\":\\"Alpha\\",\\"amount\\":12.5},{\\"id\\":\\"B\\",\\"label\\":\\"Beta\\",\\"amount\\":7.25}]")
_table := createtable("ID", "Label", "Amount")
_rows.forEach(_row:
     _table.addRow(str(_row.id), str(_row.label), _row.amount)
)
_table`,
  },
  {
    id: 'advanced-table-heterogeneous', category: 'table', kind: 'write', advanced: true,
    prompt: 'On Steadfast, build one heterogeneous list containing t.json_size (ExtendedExpression) and t.cat_exp_json (Category), then return a table showing className, id, name, and parent.name for both. Avoid the typed addColumn path that fails across concrete classes.',
    expect: 'LIST(...).table(className, id, name, parent.name) — two rows, ExtendedExpression/json_size and Category/cat_exp_json',
    resultIncludes: ['ClassName ID Name Parent', 'ExtendedExpression json_size', 'Category cat_exp_json'],
    forbidCode: ['.addColumn('],
    requireCode: ['.table(className, id, name,'],
    referenceCode: `_all := LIST(t.json_size, t.cat_exp_json)
_all.table(className, id, name, parent.name)`,
  },
  {
    id: 'advanced-flow-scalar-result', category: 'flow', kind: 'write', advanced: true,
    prompt: 'Write Extended Code that parses {"name":"Alpha"}, reads its missing description, assigns "(no description)" for missing or blank text, and returns that as a scalar string. Structure the code so a multi-statement IF branch cannot become the final list-shaped result.',
    expect: '(no description) as a scalar — assign _result in branches and put bare _result after ENDIF',
    resultIncludes: ['Result : (no description)'],
    forbidCode: ['return ', '=='],
    requireCode: ['JSON('],
    referenceCode: `_record := JSON("{\\"name\\":\\"Alpha\\"}")
_description := _record.description
_result := ""
IF _description = MISSING THEN
     _result := "(no description)"
ELSE
     _clean := _description.strip()
     IF _clean = "" THEN
          _result := "(no description)"
     ELSE
          _result := _clean
     ENDIF
ENDIF
_result`,
  },
  {
    id: 'advanced-json-escape', category: 'json', kind: 'write', advanced: true,
    prompt: 'Write Extended Code that takes a string containing a real newline, double quotes, and a backslash (Line 1, then newline, then "quoted" \\ path), JSON-escapes it character by character, embeds it as message in an object, reparses it with JSON(), and outputs the round-tripped object. Do not call a stored json_escape helper.',
    expect: '{"message":"Line 1\\n\\"quoted\\" \\\\ path"} round-trips successfully; use a bounded range, substring, and explicit escapes',
    resultIncludes: ['{"message":"Line 1', 'quoted', 'path"}'],
    forbidCode: ['t.json_escape.expression', '.replace(', '=>'],
    requireCode: ['JSON(', '.substring('],
    referenceCode: `_raw := "Line 1\\n\\"quoted\\" \\\\ path"
_BS := JSON("{\\"c\\":\\"\\\\\\\\\\"}").c
_DQ := JSON("{\\"c\\":\\"\\\\\\\"\\"}").c
_n := _raw.size()
_range := LIST("")
_range := _range.union(_range)
_range := _range.union(_range)
_range := _range.union(_range)
_range := _range.union(_range)
_range := _range.union(_range)
_range := _range.first(_n)
_escaped := ""
_pos := 0
_range.forEach(_:
     _ch := _raw.substring(_pos, _pos + 1)
     IF _ch = _DQ THEN
          _escaped := _escaped + _BS + _DQ
     ELSE
          IF _ch = _BS THEN
               _escaped := _escaped + _BS + _BS
          ELSE
               IF _ch = "\\n" THEN
                    _escaped := _escaped + _BS + "n"
               ELSE
                    _escaped := _escaped + _ch
               ENDIF
          ENDIF
     ENDIF
     _pos := _pos + 1
)
_payload := JSON("{\\"message\\":\\"" + _escaped + "\\"}")
str(_payload)`,
  },
];
