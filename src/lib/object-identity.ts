import { validateBusinessId } from './ec-guards';

export interface DisplayIdentityInput {
  rid?: string;
  businessId?: string;
  templateBusinessId?: string;
}

export type PrimaryIdentityKind = 'template' | 'instance' | 'rid' | 'missing';

export interface DisplayIdentity {
  /** Template when available, otherwise the concrete instance id, then RID. */
  primary: string;
  primaryKind: PrimaryIdentityKind;
  primaryLabel: 'Template ID' | 'ID' | 'RID';
  /** Concrete instance id retained as secondary context when template is primary. */
  secondary?: string;
  templateId?: string;
  instanceId?: string;
  rid?: string;
}

/** Product-wide display policy: reusable definitions are the primary identity.
 *
 * The concrete instance remains available as secondary context and continues to
 * drive instance-scoped references and mutations. Older BMP versions cannot
 * resolve template IDs, so the policy degrades to the instance ID without
 * inventing a placeholder. */
export function resolveDisplayIdentity(input: DisplayIdentityInput): DisplayIdentity {
  const templateId = input.templateBusinessId?.trim() || undefined;
  const instanceId = input.businessId?.trim() || undefined;
  const rid = input.rid?.trim() || undefined;

  if (templateId) {
    return {
      primary: templateId,
      primaryKind: 'template',
      primaryLabel: 'Template ID',
      ...(instanceId && instanceId !== templateId ? { secondary: instanceId } : {}),
      templateId,
      ...(instanceId ? { instanceId } : {}),
      ...(rid ? { rid } : {}),
    };
  }
  if (instanceId) {
    return {
      primary: instanceId,
      primaryKind: 'instance',
      primaryLabel: 'ID',
      instanceId,
      ...(rid ? { rid } : {}),
    };
  }
  return {
    primary: rid ?? '',
    primaryKind: rid ? 'rid' : 'missing',
    primaryLabel: 'RID',
    ...(rid ? { rid } : {}),
  };
}

export interface IdentityEditInput {
  businessId: string;
  name: string;
  templateBusinessId?: string;
}

export type IdentityField = 'businessId' | 'name' | 'templateBusinessId';

export type IdentityValidationResult =
  | { ok: true; value: IdentityEditInput }
  | { ok: false; field: IdentityField; error: string };
type IdentityValidationError = Extract<IdentityValidationResult, { ok: false }>;

export interface IdentitySaveResult {
  ok: boolean;
  businessId?: string;
  name?: string;
  templateBusinessId?: string;
  field?: IdentityField;
  error?: string;
}

export interface IdentityChangeSet {
  businessId?: string;
  name?: string;
  templateBusinessId?: string;
}

function validateId(
  value: string,
  field: Extract<IdentityField, 'businessId' | 'templateBusinessId'>,
): IdentityValidationError | null {
  if (!value) {
    return {
      ok: false,
      field,
      error: field === 'businessId' ? 'ID is required.' : 'Template ID is required.',
    };
  }
  try {
    validateBusinessId(value);
    return null;
  } catch {
    return {
      ok: false,
      field,
      error: field === 'businessId'
        ? 'Use letters, numbers, and underscores for the ID.'
        : 'Use letters, numbers, and underscores for the template ID.',
    };
  }
}

/** Normalize identity form values and return field-addressable validation. */
export function normalizeAndValidateIdentity(input: IdentityEditInput): IdentityValidationResult {
  const businessId = input.businessId.trim();
  const name = input.name.trim();
  const hasTemplate = input.templateBusinessId !== undefined;
  const templateBusinessId = input.templateBusinessId?.trim();

  const idError = validateId(businessId, 'businessId');
  if (idError) return idError;
  if (!name) return { ok: false, field: 'name', error: 'Name is required.' };
  if (hasTemplate) {
    const templateError = validateId(templateBusinessId ?? '', 'templateBusinessId');
    if (templateError) return templateError;
  }

  return {
    ok: true,
    value: {
      businessId,
      name,
      ...(hasTemplate ? { templateBusinessId } : {}),
    },
  };
}

/** Field-level business-ID validation for staged expanded-view edits. */
export function identityBusinessIdError(
  value: string,
  field: Extract<IdentityField, 'businessId' | 'templateBusinessId'> = 'businessId',
): string | null {
  return validateId(value.trim(), field)?.error ?? null;
}
