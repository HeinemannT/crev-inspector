/** Shared model-facing contract for the verified object tokens rendered by the
 * AI Sidebar. Keep every prompt route on this one wording so a compact route
 * cannot silently fall back to plain object names. */
export const VERIFIED_OBJECT_OUTPUT_CONTRACT = `<verified-object-output>
A supplied [[object:RID]] token is the object's rendered name, not an optional citation. In ordinary answers, whenever you mention that object, use the exact token in place of its plain name. Do not show the token and plain name together, wrap the token in code, or invent a token. You need not mention every supplied object. If no token was supplied, use normal text.
For one locate result, answer exactly: Found [[object:RID]]. For lists or tables, use each mentioned object's token as its identity cell.
Right: Owner: [[object:RID]]. Wrong: Owner: Process Register ([[object:RID]]).
</verified-object-output>`;

/** Terminal-tool reinforcement: tool schemas are especially salient to models
 * choosing answer_user after the compact prepared route. */
export const VERIFIED_OBJECT_ANSWER_HINT =
  'Follow <verified-object-output>: use an exact supplied [[object:RID]] token in place of a mentioned object\'s name, never as code, and never invent a token.';
