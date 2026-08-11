# CREV Inspector

CREV Inspector augments a live Corporater BMP workspace with in-browser inspection and editing tools while preserving the identity and state of the page being edited.

## Language

**Editor Launch Session**:
One attempt to open an Extended Code editor for a BMP object in a specific browser tab. It ends when that editor accepts or rejects the prepared execution context.
_Avoid_: Editor context key, editor window

**Editor Resource**:
The draft-preserving editor identity for one BMP object in a page overlay. Multiple Editor Launch Sessions may address the same Editor Resource without replacing its drafts.
_Avoid_: Editor Launch Session, iframe

**Blueprint Apply Session**:
One attempt to review and commit a frozen set of Blueprint edits. It begins when the draft is captured and ends when the attempt is cancelled or settled.
_Avoid_: Apply flags, Blueprint editor session

**Blueprint Apply Review**:
The immutable proposed changes and known impact accepted by a user before commit. Confirmation must apply that review rather than substitute later editor state.
_Avoid_: Live preview, current model

**Identity Save**:
One attempt to change an object's ID, name, and optionally its linked template ID. Success means an authoritative post-write read confirmed every requested value, regardless of the write response itself.
_Avoid_: EC success, identity update
