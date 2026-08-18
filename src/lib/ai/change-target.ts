/**
 * Prompt-owned policy for selecting an EC mutation receiver from public,
 * structural layout facts. There is intentionally no second route resolver:
 * duplicating the decision in code made explicit off-page targets impossible
 * and forced the model to reconcile two competing sources of truth.
 */
export const CHANGE_TARGET_PROMPT_CONTRACT = `<change-target-policy>
An exact target or receiver named by the user is authoritative. Preserve it byte-for-byte and do not run layout discovery merely because a current page exists. A value such as “set it to t.xy” is not a mutation target.

When the user identifies the subject contextually and read_layout supplies structural facts, select the mutation object as follows:
- Existing widget: if linkedTemplateRid exists, change lookup("linkedTemplateRid") by default because that is the shared widget definition. Use lookup("rid") only when the user explicitly asks for this/local/one copy. If linkedTemplateRid is absent, the widget rid is the local definition.
- Page-level change or add: use pageTemplateRid when present; otherwise use pageOwnerRid. The viewedRid is browser context, not automatically the configuration owner.
- Enterprise page: pageOwnerRid is its EnterpriseTemplate owner. The viewed enterprise instance does not own its rendered widgets.
- Existing tab or container: use that node's rid. storage=portal-shared means it is a globally shared portal object, not an instance-only object.
- Create or move: use the selected destination container node's rid as the placement receiver.

RID-derived EC receivers must use lookup("RID") with the RID quoted; BMP RIDs are Java long values and may exceed JavaScript's safe integer range. Put [[object:RID]] for that same selected RID in the ticket target. Never turn a RID into t.RID, substitute the first object shown, or invent _page.

For a linked-template default, briefly state that the change affects the shared template and therefore its linked instances. Do not volunteer a local override. For other targets, describe only the requested visible outcome. Never expose internal field names or routing labels in the summary.
</change-target-policy>`;
