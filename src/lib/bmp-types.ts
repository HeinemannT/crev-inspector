/**
 * BMP type registry for Java serialization.
 * Registers all BMP classes needed by the extension with exact
 * serialVersionUIDs and field descriptors from decompiled sources.
 */

import {
  registerType, JavaEnum, BlockDataWriter,
  SC_SERIALIZABLE, SC_EXTERNALIZABLE, SC_BLOCK_DATA, SC_WRITE_METHOD, SC_ENUM,
  type JavaClassDesc, type JavaField, type JavaReader,
} from './java-serial';

// ── Enum Class Descriptors ──────────────────────────────────────

const JAVA_LANG_ENUM: JavaClassDesc = {
  name: 'java.lang.Enum',
  uid: 0n,
  flags: SC_SERIALIZABLE | SC_ENUM,
  fields: [],
  parent: null,
};

const CLIENT_USER_AGENT: JavaClassDesc = {
  name: 'com.corporater.bmp.base.system.auth.ClientUserAgent',
  uid: 0n,
  flags: SC_SERIALIZABLE | SC_ENUM,
  fields: [],
  parent: JAVA_LANG_ENUM,
};

const PRINCIPAL_TYPE: JavaClassDesc = {
  name: 'com.corporater.bmp.base.system.auth.PrincipalType',
  uid: 0n,
  flags: SC_SERIALIZABLE | SC_ENUM,
  fields: [],
  parent: JAVA_LANG_ENUM,
};

const ON_BEHALF_OF_TYPE: JavaClassDesc = {
  name: 'com.corporater.bmp.base.system.auth.OnBehalfOfType',
  uid: 0n,
  flags: SC_SERIALIZABLE | SC_ENUM,
  fields: [],
  parent: JAVA_LANG_ENUM,
};

const CALENDAR_TYPE: JavaClassDesc = {
  name: 'com.corporater.bmp.base.date.CalendarType',
  uid: 0n,
  flags: SC_SERIALIZABLE | SC_ENUM,
  fields: [],
  parent: JAVA_LANG_ENUM,
};

const LOG_TYPE: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.extended.LogType',
  uid: 0n,
  flags: SC_SERIALIZABLE | SC_ENUM,
  fields: [],
  parent: JAVA_LANG_ENUM,
};

const ID_SPACE: JavaClassDesc = {
  name: 'com.corporater.base.generation.system.IdSpace',
  uid: 0n,
  flags: SC_SERIALIZABLE | SC_ENUM,
  fields: [],
  parent: JAVA_LANG_ENUM,
};

// ── Enum Factories ──────────────────────────────────────────────

const Enums = {
  ClientUserAgent: (name: string) => new JavaEnum(CLIENT_USER_AGENT, name),
  PrincipalType: (name: string) => new JavaEnum(PRINCIPAL_TYPE, name),
  OnBehalfOfType: (name: string) => new JavaEnum(ON_BEHALF_OF_TYPE, name),
  CalendarType: (name: string) => new JavaEnum(CALENDAR_TYPE, name),
  LogType: (name: string) => new JavaEnum(LOG_TYPE, name),
  IdSpace: (name: string) => new JavaEnum(ID_SPACE, name),
};

// ── Expression Class Descriptors ────────────────────────────────

/** AbstractCorpoExpression — base class for all expression types.
 *  Implements Persistable (extends Serializable). Parent (AbstractTransformable) is NOT Serializable.
 *  Single field: value (String) — the expression code text. */
const ABSTRACT_CORPO_EXPRESSION: JavaClassDesc = {
  name: 'com.corporater.bmp.base.expression.AbstractCorpoExpression',
  uid: 340n,
  flags: SC_SERIALIZABLE,
  fields: [{ name: 'value', type: 'L', className: 'Ljava/lang/String;' }],
  parent: null,  // AbstractTransformable is NOT Serializable
};

/** CorpoExtendedExpression — concrete type for Extended Code expressions.
 *  Used by ExtendedTable, all chart types, and other HasExtendedExpression types. */
const CORPO_EXTENDED_EXPRESSION: JavaClassDesc = {
  name: 'com.corporater.bmp.value.type.expression.CorpoExtendedExpression',
  uid: 3060807707032977491n,
  flags: SC_SERIALIZABLE,
  fields: [],
  parent: ABSTRACT_CORPO_EXPRESSION,
};

// ── Class Descriptors ───────────────────────────────────────────

const RID: JavaClassDesc = {
  name: 'com.corporater.base.generation.system.Rid',
  uid: 340n,
  flags: SC_SERIALIZABLE,
  fields: [{ name: 'identifier', type: 'J' }],
  parent: null,
};

const CORPO_TIME: JavaClassDesc = {
  name: 'com.corporater.bmp.base.date.CorpoTime',
  uid: -2082729704767556684n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'ms', type: 'J' },
    { name: 'calendarType', type: 'L', className: 'Lcom/corporater/bmp/base/date/CalendarType;' },
    { name: 'formattedValue', type: 'L', className: 'Ljava/lang/String;' },
  ],
  parent: null,
};

const PERIOD_IMPL: JavaClassDesc = {
  name: 'com.corporater.bmp.base.date.period.PeriodImpl',
  uid: 4664058561047724008n,
  flags: SC_SERIALIZABLE,
  fields: [],
  parent: null,
};

const MONTH: JavaClassDesc = {
  name: 'com.corporater.bmp.base.date.period.Month',
  uid: 7588986724074479258n,
  flags: SC_SERIALIZABLE,
  fields: [],
  parent: PERIOD_IMPL,
};

const DAY: JavaClassDesc = {
  name: 'com.corporater.bmp.base.date.period.Day',
  uid: 4889883387193469455n,
  flags: SC_SERIALIZABLE,
  fields: [],
  parent: PERIOD_IMPL,
};

const QUARTER: JavaClassDesc = {
  name: 'com.corporater.bmp.base.date.period.Quarter',
  uid: 2604480583845996170n,
  flags: SC_SERIALIZABLE,
  fields: [],
  parent: PERIOD_IMPL,
};

const TYPE_KEY: JavaClassDesc = {
  name: 'com.corporater.base.generation.system.TypeKey',
  uid: 0n,
  flags: SC_SERIALIZABLE,
  fields: [{ name: 'typeId', type: 'L', className: 'Ljava/lang/String;' }],
  parent: null,
};

const SIMPLE_CALCULATION_CONTEXT: JavaClassDesc = {
  name: 'com.corporater.bmp.base.context.SimpleCalculationContext',
  uid: 0n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'yearToDate', type: 'Z' },
    { name: 'date', type: 'L', className: 'Lcom/corporater/bmp/base/date/CorpoTime;' },
    { name: 'end', type: 'L', className: 'Lcom/corporater/bmp/base/date/CorpoTime;' },
    { name: 'itemRid', type: 'L', className: 'Lcom/corporater/base/generation/system/Rid;' },
    { name: 'nodeTypeRid', type: 'L', className: 'Lcom/corporater/base/generation/system/Rid;' },
    { name: 'objectRid', type: 'L', className: 'Lcom/corporater/base/generation/system/Rid;' },
    { name: 'orgRid', type: 'L', className: 'Lcom/corporater/base/generation/system/Rid;' },
    { name: 'period', type: 'L', className: 'Lcom/corporater/bmp/base/date/period/Period;' },
  ],
  parent: null,
};

const LOGIN_TICKET: JavaClassDesc = {
  name: 'com.corporater.bmp.base.system.auth.LoginTicket',
  uid: 0n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'key', type: 'J' },
    { name: 'clientUserAgent', type: 'L', className: 'Lcom/corporater/bmp/base/system/auth/ClientUserAgent;' },
    { name: 'onBehalfOfId', type: 'L', className: 'Ljava/lang/String;' },
    { name: 'onBehalfOfType', type: 'L', className: 'Lcom/corporater/bmp/base/system/auth/OnBehalfOfType;' },
    { name: 'principalId', type: 'L', className: 'Ljava/lang/String;' },
    { name: 'principalType', type: 'L', className: 'Lcom/corporater/bmp/base/system/auth/PrincipalType;' },
  ],
  parent: null,
};

const SERVER_EXCEPTION_RESPONSE: JavaClassDesc = {
  name: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse',
  uid: 4006n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'fatal', type: 'Z' },
    { name: 'isUserMessage', type: 'Z' },
    { name: 'requiresLocalization', type: 'Z' },
    { name: 'message', type: 'L', className: 'Ljava/lang/String;' },
    { name: 'stackTrace', type: 'L', className: 'Ljava/lang/String;' },
  ],
  parent: null,
};

// ── Command Class Descriptors ───────────────────────────────────

const CONTEXT_INTEGRATION_COMMAND: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.ContextIntegrationCommand',
  uid: -2040863406857312980n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'context', type: 'L', className: 'Lcom/corporater/bmp/base/context/SimpleCalculationContext;' },
  ],
  parent: null,
};

const ABSTRACT_INTEGRATION_COMMAND: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.AbstractIntegrationCommand',
  uid: -7114741235727918n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'data', type: 'L', className: 'Lcom/corporater/bmp/dto/ObjectData;' },
  ],
  parent: CONTEXT_INTEGRATION_COMMAND,
};

const INTEGRATION_GET_OBJECT_COMMAND: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.repository.IntegrationGetObjectCommand',
  uid: -2618124967670449045n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'rid', type: 'L', className: 'Lcom/corporater/base/generation/system/Rid;' },
  ],
  parent: CONTEXT_INTEGRATION_COMMAND,
};

const INTEGRATION_UPDATE_COMMAND: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.repository.IntegrationUpdateCommand',
  uid: -4071308193265133922n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'context', type: 'L', className: 'Lcom/corporater/bmp/base/context/SimpleCalculationContext;' },
  ],
  parent: ABSTRACT_INTEGRATION_COMMAND,
};

const GET_BY_SPACE_AND_BID_COMMAND: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.repository.GetBySpaceAndBidCommand',
  uid: 2432607788884430671n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'bid', type: 'L', className: 'Ljava/lang/String;' },
    { name: 'space', type: 'L', className: 'Lcom/corporater/base/generation/system/IdSpace;' },
  ],
  parent: CONTEXT_INTEGRATION_COMMAND,
};

const EXTENDED_EXECUTE_COMMAND: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteCommand',
  uid: -5760775447856129650n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'commandColumn', type: 'I' },
    { name: 'commandLine', type: 'I' },
    { name: 'showResult', type: 'Z' },
    { name: 'transactional', type: 'Z' },
    { name: 'context', type: 'L', className: 'Lcom/corporater/bmp/base/context/SimpleCalculationContext;' },
    { name: 'entity', type: 'L', className: 'Lcom/corporater/bmp/dto/ObjectRefDto;' },
    { name: 'expressionRid', type: 'L', className: 'Lcom/corporater/base/generation/system/Rid;' },
    { name: 'function', type: 'L', className: 'Ljava/lang/String;' },
  ],
  parent: null,
};

// ── Response Class Descriptors ──────────────────────────────────

const INTEGRATION_OBJECT_RESPONSE: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.response.IntegrationObjectResponse',
  uid: 1698316271062164157n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'response', type: 'L', className: 'Ljava/lang/Object;' },
  ],
  parent: null,
};

const LOG_ENTRY: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.extended.LogEntry',
  uid: -4404261606243425876n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'logType', type: 'L', className: 'Lcom/corporater/bmp/dto/command/extended/LogType;' },
    { name: 'message', type: 'L', className: 'Ljava/lang/String;' },
    { name: 'time', type: 'L', className: 'Ljava/lang/Long;' },
  ],
  parent: null,
};

const EXTENDED_EXECUTE_RESULT: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
  uid: 0n,
  flags: SC_SERIALIZABLE,
  fields: [
    { name: 'entries', type: 'L', className: 'Ljava/util/List;' },
  ],
  parent: null,
};

// ── ObjectData (Externalizable) ─────────────────────────────────

const OBJECT_DATA: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.ObjectData',
  uid: 1n,
  flags: SC_EXTERNALIZABLE | SC_BLOCK_DATA,
  fields: [],
  parent: null,
};

// ── Standard Java Types ─────────────────────────────────────────

const JAVA_UTIL_ARRAYLIST: JavaClassDesc = {
  name: 'java.util.ArrayList',
  uid: 8683452581122892189n,
  flags: SC_SERIALIZABLE | SC_WRITE_METHOD,
  fields: [{ name: 'size', type: 'I' }],
  parent: null,
};

const JAVA_UTIL_HASHMAP: JavaClassDesc = {
  name: 'java.util.HashMap',
  uid: 362498820763181265n,
  flags: SC_SERIALIZABLE | SC_WRITE_METHOD,
  fields: [
    { name: 'loadFactor', type: 'F' },
    { name: 'threshold', type: 'I' },
  ],
  parent: null,
};

const JAVA_UTIL_HASHSET: JavaClassDesc = {
  name: 'java.util.HashSet',
  uid: -5024744406713321676n,
  flags: SC_SERIALIZABLE | SC_WRITE_METHOD,
  fields: [],
  parent: null,
};

// ── Helpers ─────────────────────────────────────────────────────

/** Build a Rid object for serialization */
function makeRid(id: bigint | number | string): any {
  const n = typeof id === 'string' ? BigInt(id) : typeof id === 'number' ? BigInt(id) : id;
  return { $type: 'com.corporater.base.generation.system.Rid', identifier: n };
}

/** Build a CorpoTime for "now" */
function makeCorpoTimeNow(): any {
  const now = Date.now();
  const d = new Date(now);
  const formatted = d.toISOString().slice(0, 10); // yyyy-MM-dd
  return {
    $type: 'com.corporater.bmp.base.date.CorpoTime',
    ms: BigInt(now),
    calendarType: Enums.CalendarType('ISO'),
    formattedValue: formatted,
  };
}

/** Build a SimpleCalculationContext with sensible defaults */
function makeContext(opts?: {
  orgRid?: bigint;
  objectRid?: bigint;
  itemRid?: bigint;
  period?: string;
}): any {
  const zeroRid = makeRid(0n);
  const now = makeCorpoTimeNow();
  // Default period: Month
  const period = { $type: 'com.corporater.bmp.base.date.period.Month' };
  return {
    $type: 'com.corporater.bmp.base.context.SimpleCalculationContext',
    yearToDate: false,
    date: now,
    end: now,
    itemRid: opts?.itemRid ? makeRid(opts.itemRid) : (opts?.objectRid ? makeRid(opts.objectRid) : zeroRid),
    nodeTypeRid: zeroRid,
    objectRid: opts?.objectRid ? makeRid(opts.objectRid) : zeroRid,
    orgRid: opts?.orgRid ? makeRid(opts.orgRid) : zeroRid,
    period,
  };
}

/** Build an IntegrationGetObjectCommand */
export function makeGetObjectCommand(rid: string): any {
  return {
    $type: 'com.corporater.bmp.dto.command.repository.IntegrationGetObjectCommand',
    context: null,
    rid: makeRid(rid),
  };
}

/** Properties that require CorpoExtendedExpression wrapping in binary serialization.
 *  CVO html/javascript are plain Strings — no wrapping needed. */
const EXPRESSION_PROPS = new Set(['expression']);

/** Wrap a value in CorpoExtendedExpression if the property requires it */
function wrapExpressionValue(property: string, value: any): any {
  if (EXPRESSION_PROPS.has(property) && typeof value === 'string') {
    return {
      $type: 'com.corporater.bmp.value.type.expression.CorpoExtendedExpression',
      value,
    };
  }
  return value;
}

/** Build an IntegrationUpdateCommand */
export function makeUpdateCommand(rid: string, type: string, properties: Record<string, any>): any {
  return {
    $type: 'com.corporater.bmp.dto.command.repository.IntegrationUpdateCommand',
    // ContextIntegrationCommand.context
    context: null,
    // AbstractIntegrationCommand.data
    data: makeObjectData(rid, type, properties),
    // IntegrationUpdateCommand.context (shadows parent)
    // This field is also named 'context' — comes after 'data' in serialization order
  };
}

/** Build an ObjectData for update commands */
function makeObjectData(rid: string, type: string, properties: Record<string, any>): any {
  const props: Record<string, any> = {
    _rid: makeRid(rid),
    _type: { $type: 'com.corporater.base.generation.system.TypeKey', typeId: type },
  };
  for (const [k, v] of Object.entries(properties)) {
    props[k] = wrapExpressionValue(k, v);
  }
  return {
    $type: 'com.corporater.bmp.dto.ObjectData',
    references: {},
    props,
    overridden: new Set<string>(),
    mutated: new Set(Object.keys(properties)),
  };
}

/** Build an ExtendedExecuteCommand */
export function makeExtendedExecuteCommand(
  code: string,
  opts?: { objectRid?: bigint; transactional?: boolean },
): any {
  const ctx = makeContext(opts?.objectRid ? { objectRid: opts.objectRid } : undefined);
  return {
    $type: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteCommand',
    commandColumn: 0,
    commandLine: 0,
    showResult: true,
    transactional: opts?.transactional ?? false,
    context: ctx,
    entity: null,
    expressionRid: null,
    function: code,
  };
}

// ── Response Parsers ────────────────────────────────────────────

interface ParsedObjectData {
  rid?: string;
  type?: string;
  properties: Record<string, any>;
}

/** Extract useful data from a deserialized ObjectData */
export function parseObjectData(raw: any): ParsedObjectData | null {
  if (!raw) return null;
  const props: Record<string, any> = {};
  let rid: string | undefined;
  let type: string | undefined;

  const rawProps = raw.props || raw;
  for (const [k, v] of Object.entries(rawProps)) {
    if (k === '_rid' && v && typeof v === 'object') {
      rid = String((v as any).identifier ?? '');
    } else if (k === '_type' && v && typeof v === 'object') {
      type = String((v as any).typeId ?? '');
    } else if (k === '$type' || k === '$class') {
      // Skip metadata
    } else {
      // Unwrap JavaEnum to string
      if (v instanceof JavaEnum) {
        props[k] = v.name;
      } else if (v && typeof v === 'object' && '$class' in (v as any)) {
        const cls = (v as any).$class as string;
        // Unwrap CorpoExpression objects to their string value
        if (cls.includes('Expression') && typeof (v as any).value === 'string') {
          props[k] = (v as any).value;
        } else {
          props[k] = v;
        }
      } else {
        props[k] = v;
      }
    }
  }

  return { rid, type, properties: props };
}

interface ParsedEcResult {
  ok: boolean;
  log: string;
  hasError: boolean;
  hasWarning: boolean;
  error?: string;
}

/** Parse EC streaming response objects */
export function parseEcResults(objects: any[]): ParsedEcResult {
  const lines: string[] = [];
  let hasError = false;
  let hasWarning = false;
  const errors: string[] = [];

  for (const obj of objects) {
    if (!obj) continue;
    const cls = obj.$class ?? '';

    if (cls === 'com.corporater.bmp.base.system.exception.ServerExceptionResponse') {
      errors.push(obj.message ?? 'Server error');
      hasError = true;
      continue;
    }

    if (cls === 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult') {
      const raw = obj.entries;
      // entries may be a native array, a deserialized ArrayList ({$elements: [...]}),
      // or a SeqListImpl ({delegate: {$elements: [...]}}) as seen in BMP 5.6.7.2
      const entries = Array.isArray(raw) ? raw
        : raw?.$elements           // plain ArrayList
        ?? raw?.delegate?.$elements // SeqListImpl → delegate → ArrayList
        ?? raw?.delegate;           // SeqListImpl → delegate is native array
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!entry) continue;
          const logType = entry.logType instanceof JavaEnum ? entry.logType.name : String(entry.logType ?? '');
          let message = entry.message ?? '';
          // BMP wraps last-expression output with "Result : " prefix
          if (message.startsWith('Result : ')) {
            message = message.slice(9); // 'Result : '.length === 9
          }
          if (logType === 'ERROR') hasError = true;
          if (logType === 'WARNING') hasWarning = true;
          lines.push(message);
        }
      }
      continue;
    }

    // Unknown object — try to extract useful info
    if (typeof obj === 'string') {
      if (obj === 'END') continue;
      lines.push(obj);
    }
  }

  return {
    ok: !hasError && errors.length === 0,
    log: lines.join('\n'),
    hasError,
    hasWarning,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}

/** Parse a command response (Collection<IntegrationResponse>) */
export function parseCommandResponse(raw: any): any[] {
  // Response is typically an ArrayList
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    // If it's an ArrayList-like with elements
    if (raw.$elements) return raw.$elements;
    // IntegrationObjectResponse
    if (raw.response !== undefined) return [raw.response];
  }
  return [raw];
}

// ── Registration ────────────────────────────────────────────────

export function registerBmpTypes() {
  // Simple value types
  registerType({ desc: RID });
  registerType({ desc: CORPO_TIME });
  registerType({ desc: TYPE_KEY });
  registerType({ desc: PERIOD_IMPL });
  registerType({ desc: MONTH });
  registerType({ desc: DAY });
  registerType({ desc: QUARTER });

  // Expression types (for reading AND writing code properties via binary serialization)
  registerType({ desc: ABSTRACT_CORPO_EXPRESSION });
  registerType({ desc: CORPO_EXTENDED_EXPRESSION });

  // Context
  registerType({ desc: SIMPLE_CALCULATION_CONTEXT });

  // Auth
  registerType({
    desc: LOGIN_TICKET,
    objectBuilder: (fields) => fields,
  });

  // Error
  registerType({
    desc: SERVER_EXCEPTION_RESPONSE,
    objectBuilder: (fields) => fields,
  });

  // Commands — no fieldExtractors needed; obj properties match field names directly
  registerType({ desc: INTEGRATION_GET_OBJECT_COMMAND });
  registerType({ desc: CONTEXT_INTEGRATION_COMMAND });
  registerType({ desc: ABSTRACT_INTEGRATION_COMMAND });
  registerType({ desc: INTEGRATION_UPDATE_COMMAND });
  registerType({ desc: GET_BY_SPACE_AND_BID_COMMAND });
  registerType({ desc: EXTENDED_EXECUTE_COMMAND });

  // Responses
  registerType({
    desc: INTEGRATION_OBJECT_RESPONSE,
    objectBuilder: (fields) => fields,
  });

  registerType({
    desc: LOG_ENTRY,
    objectBuilder: (fields) => fields,
  });

  registerType({
    desc: EXTENDED_EXECUTE_RESULT,
    objectBuilder: (fields) => fields,
  });

  // ObjectData (Externalizable)
  registerType({
    desc: OBJECT_DATA,
    extWriter: (obj, w) => {
      const bw = new BlockDataWriter(w);
      // 1. writeObject(references) — HashMap
      bw.writeObject(makeHashMap(obj.references ?? {}));
      // 2. writeInt(props.size())
      const props = obj.props ?? {};
      const entries = Object.entries(props);
      bw.writeInt(entries.length);
      // 3. For each prop: writeUTF(key), writeObject(value)
      for (const [key, value] of entries) {
        bw.writeUTF(key);
        bw.writeObject(value);
      }
      // 4. writeObject(overridden) — HashSet
      bw.writeObject(makeHashSet(obj.overridden ?? new Set()));
      // 5. writeObject(mutated) — HashSet
      bw.writeObject(makeHashSet(obj.mutated ?? new Set()));
      bw.flush();
    },
    extReader: (r: JavaReader) => {
      // Read ObjectData external content
      const references = r.blockReadObject(); // HashMap
      const propsCount = r.blockReadInt();
      const props: Record<string, any> = {};
      for (let i = 0; i < propsCount; i++) {
        const key = r.blockReadUTF();
        const value = r.blockReadObject();
        props[key] = value;
      }
      const overridden = r.blockReadObject(); // HashSet
      const mutated = r.blockReadObject(); // HashSet
      return { props, references, overridden, mutated };
    },
  });

  // Standard Java types
  registerType({
    desc: JAVA_UTIL_ARRAYLIST,
    fieldExtractor: (obj) => ({ size: obj.$elements?.length ?? obj.size ?? 0 }),
    annotationWriter: (obj, bw) => {
      const elements = obj.$elements ?? [];
      bw.writeInt(elements.length); // capacity
      for (const elem of elements) {
        bw.writeObject(elem);
      }
    },
    extReader: (r: JavaReader, result?: any) => {
      const size = result?.size ?? 0;
      const capacity = r.blockReadInt();
      const elements: any[] = [];
      for (let i = 0; i < size; i++) {
        elements.push(r.blockReadObject());
      }
      if (result) {
        result.$elements = elements;
        result.length = size;
      }
      return result ?? { $elements: elements, length: size };
    },
  });

  registerType({
    desc: JAVA_UTIL_HASHMAP,
    fieldExtractor: (obj) => ({
      loadFactor: obj.loadFactor ?? 0.75,
      threshold: obj.threshold ?? 12,
    }),
    annotationWriter: (obj, bw) => {
      bw.writeInt(obj.$capacity ?? 16); // bucket count
      bw.writeInt(obj.$size ?? 0);      // entry count
      const entries: [any, any][] = obj.$entries ?? [];
      for (const [key, value] of entries) {
        bw.writeObject(key);
        bw.writeObject(value);
      }
    },
    extReader: (r: JavaReader, result?: any) => {
      const capacity = r.blockReadInt();
      const size = r.blockReadInt();
      const map: Record<string, any> = {};
      for (let i = 0; i < size; i++) {
        const key = r.blockReadObject();
        const value = r.blockReadObject();
        const keyStr = key instanceof JavaEnum ? key.name : String(key ?? '');
        map[keyStr] = value;
      }
      if (result) {
        result.$map = map;
        result.$size = size;
      }
      return result ?? { $map: map, $size: size };
    },
  });

  registerType({
    desc: JAVA_UTIL_HASHSET,
    annotationWriter: (obj, bw) => {
      bw.writeInt(obj.$capacity ?? 16);     // capacity
      bw.writeFloat(obj.$loadFactor ?? 0.75); // loadFactor
      bw.writeInt(obj.$size ?? 0);           // size
      const elements: any[] = obj.$elements ?? [];
      for (const elem of elements) {
        bw.writeObject(elem);
      }
    },
    extReader: (r: JavaReader, result?: any) => {
      const capacity = r.blockReadInt();
      const loadFactor = r.blockReadInt(); // readFloat as 4 raw bytes
      const size = r.blockReadInt();
      const elements: any[] = [];
      for (let i = 0; i < size; i++) {
        elements.push(r.blockReadObject());
      }
      if (result) {
        result.$elements = elements;
        result.$size = size;
      }
      return result ?? { $elements: elements, $size: size };
    },
  });
}

// ── HashMap / HashSet Construction ──────────────────────────────

function makeHashMap(obj: Record<string, any>): any {
  const entries = Object.entries(obj);
  return {
    $type: 'java.util.HashMap',
    loadFactor: 0.75,
    threshold: 12,
    $entries: entries,
    $size: entries.length,
    $capacity: 16,
  };
}

function makeHashSet(set: Set<string> | string[]): any {
  const elements = set instanceof Set ? [...set] : set;
  return {
    $type: 'java.util.HashSet',
    $elements: elements,
    $size: elements.length,
    $capacity: 16,
    $loadFactor: 0.75,
  };
}

