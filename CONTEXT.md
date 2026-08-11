# CREV Inspector

CREV Inspector augments a live Corporater BMP workspace with in-browser inspection and editing tools while preserving the identity and state of the page being edited.

## Language

**Editor Launch Session**:
One attempt to open an Extended Code editor for a BMP object in a specific browser tab. It ends when that editor accepts or rejects the prepared execution context.
_Avoid_: Editor context key, editor window

**Editor Resource**:
The draft-preserving editor identity for one BMP object in a page overlay. Multiple Editor Launch Sessions may address the same Editor Resource without replacing its drafts.
_Avoid_: Editor Launch Session, iframe
