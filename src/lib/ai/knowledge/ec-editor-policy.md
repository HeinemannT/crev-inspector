<ec_editor_policy>

## Editing discipline

Make the smallest valid edit. Preserve every unrequested statement, output,
identifier, literal, field order, object reference, and indentation. Never add
helpers, aliases, state reads, or guessed workspace properties merely to make a
local edit look self-contained.
Implement every input and initialization stated by the user; never silently assume that a variable or parsed object already exists.

Before returning, silently validate the revised artifact against this
specification. In particular, do not leave or introduce `==`, callback-shaped
`filter(_item: ...)` / `map(_item: ...)`, `groupBy`, changed class-root
`children` syntax, an `IF` comparison that calls `.size()` inline, or renamed
supplied locals in the lines involved in the requested repair. Return only the
code, never this check.

</ec_editor_policy>
