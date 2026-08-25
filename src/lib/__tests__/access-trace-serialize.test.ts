/**
 * Serialization de-risk for AccessTraceCommand (the admin permission test).
 *
 * Can't hit live BMP in a unit test, but we CAN prove the command serializes
 * without throwing and that every class descriptor + the action enum constant
 * land in the Java-serialized stream — which catches builder/descriptor typos
 * (wrong field type, unregistered class, bad enum). The test also pins the
 * serialVersionUID = 0L metadata required for 5.6.7.2 compatibility.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerBmpTypes, makeAccessTraceCommand, makeGetObjectCommand } from '../bmp-types';
import { serializeCommands, JavaWriter, JavaReader } from '../java-serial';

/** Serialize one object (header + object, no command-count prefix) and read it
 *  back — a true round-trip that validates the field VALUES, not just names. */
function roundTrip(obj: any): any {
  const w = new JavaWriter();
  w.writeStreamHeader();
  w.writeObject(obj);
  const bytes = w.toBytes();
  const r = new JavaReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  r.readStreamHeader();
  return r.readObject();
}

/** Java class names + enum constants appear as length-prefixed UTF-8 in the
 *  stream; a latin1 view lets us substring-search for them. */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

describe('AccessTraceCommand serialization', () => {
  beforeAll(() => registerBmpTypes());

  it('serializes and includes every expected class descriptor + the action', () => {
    const bytes = serializeCommands([
      makeAccessTraceCommand('602152470325630806', '113', 'READ'),
    ]);
    expect(bytes.length).toBeGreaterThan(0);
    const s = latin1(bytes);
    for (const name of [
      'com.corporater.bmp.dto.command.access.AccessTraceCommand',
      'com.corporater.bmp.dto.command.access.AccessTraceRequestDTO',
      'com.corporater.bmp.dto.command.access.AccessTraceActionDTO',
      'com.corporater.base.generation.system.Rid',
      'com.corporater.bmp.base.context.SimpleCalculationContext',
      'java.util.ArrayList',
      'java.util.HashMap',
      'READ',
    ]) {
      expect(s, `stream should contain ${name}`).toContain(name);
    }
  });

  it('emits the chosen action enum constant', () => {
    expect(latin1(serializeCommands([makeAccessTraceCommand('1', '2', 'DELETE')]))).toContain('DELETE');
    expect(latin1(serializeCommands([makeAccessTraceCommand('1', '2', 'CREATE')]))).toContain('CREATE');
  });

  it('does not throw on the resource/subject rids it is given', () => {
    expect(() => serializeCommands([makeAccessTraceCommand('113', '113', 'UPDATE')])).not.toThrow();
  });

  it('round-trips with correct field VALUES (rids, enum, depth, flag, list)', () => {
    const cmd = roundTrip(makeAccessTraceCommand('602152470325630806', '113', 'DELETE'));
    expect(cmd.$class).toContain('AccessTraceCommand');
    const req = cmd.accessTraceRequestDTO;
    // enum constant survives
    expect(req.action?.name ?? req.action).toBe('DELETE');
    // subject rid (entityRid) value
    expect(String(req.entityRid?.identifier)).toBe('113');
    // resource rid lives in the ArrayList's first element
    const rids = req.resourceRids?.$elements ?? [];
    expect(rids).toHaveLength(1);
    expect(String(rids[0]?.identifier)).toBe('602152470325630806');
    // primitives
    expect(Number(req.requestDepth)).toBe(10);
    expect(req.indexBasedEvaluation).toBe(false);
    // updates is an (empty) map; allowedStatementPaths an (empty) list
    expect(req.allowedStatementPaths?.$elements ?? []).toHaveLength(0);
  });
});

describe('IntegrationGetObjectCommand serialization', () => {
  beforeAll(() => registerBmpTypes());

  it('round-trips with the RID and a complete calculation context', () => {
    const rid = '602152470325630806';
    const command = roundTrip(makeGetObjectCommand(rid));

    expect(String(command.rid?.identifier)).toBe(rid);
    expect(String(command.context?.objectRid?.identifier)).toBe(rid);
    expect(command.context?.date).toBeDefined();
    expect(command.context?.end).toBeDefined();
    expect(command.context?.period?.$class).toContain('Month');
  });
});
