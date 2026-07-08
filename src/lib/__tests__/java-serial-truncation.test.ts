/**
 * Regression tests for truncated Java-serial streams.
 *
 * Bug: `skipAnnotation()` looped on `peekByte()` with no end-of-buffer guard.
 * When a class-descriptor annotation was truncated (stream cut off before
 * TC_ENDBLOCKDATA), `peekByte()` past EOF returned `undefined` (never equal
 * to TC_ENDBLOCKDATA), so it called `readObject()` — which returns `null`
 * WITHOUT advancing `pos` once `pos >= length` — producing an infinite
 * busy loop that wedged the service worker. `skipToEndBlockData()` already
 * had the correct guard; this brings `skipAnnotation` (and a couple of
 * adjacent unguarded reads) up to the same standard: a bad stream now
 * throws instead of hanging, and `deserializeStream`'s per-object
 * try/catch turns that into a graceful stop.
 */
import { describe, it, expect } from 'vitest';
import {
  JavaWriter,
  JavaReader,
  registerType,
  SC_EXTERNALIZABLE,
  SC_SERIALIZABLE,
  type JavaClassDesc,
} from '../java-serial';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('java-serial: truncated stream handling', () => {
  it('THE HANG REGRESSION: throws (does not hang) when a class annotation is cut off before TC_ENDBLOCKDATA', () => {
    const desc: JavaClassDesc = {
      name: 'com.example.Dummy',
      uid: 1n,
      flags: SC_SERIALIZABLE,
      fields: [],
    };

    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeClassDesc(desc);
    const full = w.toBytes();

    // writeClassDesc() emits, in order: TC_CLASSDESC, name, uid, flags,
    // fieldCount(=0, no fields), then the classAnnotation terminator
    // (TC_ENDBLOCKDATA = 0x78), then the superClassDesc (TC_NULL = 0x70,
    // since this desc has no parent). Confirm that tail shape so the
    // splice below is provably targeting the annotation terminator.
    expect(full[full.length - 1]).toBe(0x70); // TC_NULL (no parent)
    expect(full[full.length - 2]).toBe(0x78); // TC_ENDBLOCKDATA

    // Simulate a stream that was cut off INSIDE the (empty) annotation:
    // replace the terminator with one legitimate "annotation object" byte
    // (TC_NULL, 0x70) so skipAnnotation() consumes one real object first,
    // then the stream ends with no TC_ENDBLOCKDATA in sight.
    const truncated = new Uint8Array(full.length - 1);
    truncated.set(full.subarray(0, full.length - 2));
    truncated[full.length - 2] = 0x70; // one throwaway TC_NULL "annotation object"
    // (no TC_ENDBLOCKDATA follows — the stream is truncated here)

    const r = new JavaReader(toArrayBuffer(truncated));
    r.readStreamHeader();

    expect(() => r.readObject()).toThrow(/truncated stream/);
  });

  it('rejects a negative TC_LONGSTRING length instead of reading out of bounds', () => {
    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeByte(0x7C); // TC_LONGSTRING
    w.writeLong(-1n); // declared length: -1
    const bytes = w.toBytes();

    const r = new JavaReader(toArrayBuffer(bytes));
    r.readStreamHeader();

    expect(() => r.readObject()).toThrow(/bad long-string length/);
  });

  it('rejects an oversized TC_LONGSTRING length that exceeds the buffer', () => {
    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeByte(0x7C); // TC_LONGSTRING
    w.writeLong(1_000_000n); // declared length far exceeds the (empty) remaining buffer
    const bytes = w.toBytes();

    const r = new JavaReader(toArrayBuffer(bytes));
    r.readStreamHeader();

    expect(() => r.readObject()).toThrow(/bad long-string length/);
  });

  it('does not throw a TypeError and leaves the stream aligned when an externalizable reader returns nothing', () => {
    const desc: JavaClassDesc = {
      name: 'com.example.NullExternalReturn',
      uid: 1n,
      flags: SC_EXTERNALIZABLE,
      fields: [],
    };
    registerType({ desc, extReader: () => undefined });

    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeByte(0x73); // TC_OBJECT
    w.writeClassDesc(desc);
    w.writeEndBlockData(); // external content is empty, then the terminator
    const bytes = w.toBytes();

    const r = new JavaReader(toArrayBuffer(bytes));
    r.readStreamHeader();

    let result: any;
    expect(() => { result = r.readObject(); }).not.toThrow();
    expect(result?.$class).toBe('com.example.NullExternalReturn');
    // Stream stayed aligned: the terminator was consumed, nothing stranded.
    expect(r.position).toBe(bytes.length);
  });
});
