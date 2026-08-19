/**
 * Prompt-owned policy for selecting an EC mutation receiver from public,
 * structural layout facts. There is intentionally no second route resolver:
 * duplicating the decision in code made explicit off-page targets impossible
 * and forced the model to reconcile two competing sources of truth.
 */
export const CHANGE_TARGET_PROMPT_CONTRACT = `<change-target-policy>
An exact target or receiver supplied by the user or verified context is authoritative, including a numeric-looking symbolic reference. Preserve it byte-for-byte and do not run layout discovery merely because a current page exists. A value such as “set it to t.xy” is not a mutation target.

When the user identifies the subject contextually and read_layout supplies structural facts, select the mutation object as follows:
- Existing widget: if linkedTemplateRid exists, change lookup("linkedTemplateRid") by default because that is the shared widget definition. Use lookup("rid") only when the user explicitly asks for this/local/one copy. If linkedTemplateRid is absent, the widget rid is the local definition.
- Page-level change/add: use pageTemplateRid when present, otherwise pageOwnerRid. The viewedRid is context, not automatically the configuration owner.
- Enterprise page: pageOwnerRid is its EnterpriseTemplate owner. The viewed enterprise instance does not own its rendered widgets.
- Existing tab or container: use that node's rid. storage=portal-shared means it is a globally shared portal object, not an instance-only object.
- For a new page widget, call \`add(...)\` on the resolved page/template. Pass \`container := ...\` only when placement was requested or verified; a Container is never the \`add\` receiver. If no placement was requested, the verified page/template may own the widget directly. Call \`moveBefore\`/\`moveAfter\` on the new widget only when sibling ordering was requested.

Use verified references exactly. [[object:RID]] is display syntax for ticket targets and prose; executable EC uses the supplied symbolic reference or lookup("RID"), with the RID quoted. BMP RIDs are Java long values and may exceed JavaScript's safe integer range. Never synthesize t.RID or o.RID from a raw RID, substitute the first object shown, or invent _page; this never overrides an exact supplied symbolic receiver.
Structural keys such as pageTemplateRid, pageOwnerRid, linkedTemplateRid, and rid name JSON fields; they are not symbolic EC references. Use a returned ecRef or lookup("the field's RID value"), never t.pageTemplateRid, t.rid, or lookup("rid":...).

For a linked-template default, briefly state that the change affects the shared template and therefore its linked instances. Do not volunteer a local override. For other targets, describe only the requested visible outcome. Never expose internal field names or routing labels in the summary.
</change-target-policy>`;
