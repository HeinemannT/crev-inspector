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
import { describe, it, expect, vi } from 'vitest';
import {
  JavaWriter,
  JavaReader,
  registerType,
  deserializeStream,
  SC_EXTERNALIZABLE,
  SC_SERIALIZABLE,
  type JavaClassDesc,
} from '../java-serial';
import { log } from '../logger';

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

  it('BUG-01 THE HANG REGRESSION: throws (does not hang) on a negative TC_BLOCKDATALONG length in skipToEndBlockData', () => {
    // Externalizable object with no registered extReader: readNewObject()
    // falls straight into skipToEndBlockData() to skip the external content
    // (java-serial.ts ~line 734), which is the unguarded site this bug fixes.
    const desc: JavaClassDesc = {
      name: 'com.example.CorruptBlockDataLong',
      uid: 1n,
      flags: SC_EXTERNALIZABLE,
      fields: [],
    };

    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeByte(0x73); // TC_OBJECT
    w.writeClassDesc(desc);
    w.writeByte(0x7A); // TC_BLOCKDATALONG marker, at offset P
    // Length -5: pre-fix, `this.pos += len` after reading this 4-byte int
    // (pos == P+5) lands exactly back on P — peekByte() sees 0x7A again,
    // and the loop re-reads the identical marker+length forever. This is
    // the precise byte pattern that hung the service worker.
    w.writeInt(-5);
    const bytes = w.toBytes();

    const r = new JavaReader(toArrayBuffer(bytes));
    r.readStreamHeader();

    // Synchronous call that must return (by throwing) instead of spinning
    // forever — proof it doesn't hang.
    expect(() => r.readObject()).toThrow(/bad block-data length/);
  });

  it('A1 THE HANG REGRESSION: throws (does not hang) on a classDesc whose superClassDesc references itself (cyclic parent chain)', () => {
    // Craft a TC_OBJECT whose classDesc's superClassDesc is a TC_REFERENCE back
    // to the classDesc itself. The reader registers the desc's handle
    // (BASE_HANDLE = 0x7E0000, the first handle in this stream) in
    // readClassDescBody BEFORE it reads the superClassDesc, so this
    // self-reference resolves to desc.parent === desc. Pre-fix, buildClassChain's
    // `while (d) { chain.unshift(d); d = d.parent }` never terminated and unshift
    // grew unbounded — a service-worker hang/OOM on a malformed /cs/command
    // response, the same class MAX_READ_DEPTH does not cover (it bounds
    // readObject recursion, not this iterative parent walk).
    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeByte(0x73); // TC_OBJECT
    w.writeByte(0x72); // TC_CLASSDESC -> desc registered at handle 0x7E0000 (first handle)
    w.writeRawUTF('X'); // class name
    w.writeLong(0n); // serialVersionUID
    w.writeByte(SC_SERIALIZABLE); // flags: regular serializable -> reaches buildClassChain
    w.writeShort(0); // fieldCount = 0
    w.writeByte(0x78); // TC_ENDBLOCKDATA (empty classAnnotation)
    w.writeReference(0x7E0000); // superClassDesc = TC_REFERENCE to desc itself -> cycle
    const bytes = w.toBytes();

    const r = new JavaReader(toArrayBuffer(bytes));
    r.readStreamHeader();

    // Synchronous call that must return (by throwing) instead of spinning forever.
    expect(() => r.readObject()).toThrow(/cyclic classDesc parent chain/);
  });

  it('BUG-02: deserializeStream logs the swallowed error and returns only the objects parsed before the corruption', () => {
    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeString('first-object'); // TC_STRING — a clean, complete first object
    // Second "object": externalizable whose block data has the same
    // corrupt negative TC_BLOCKDATALONG length as BUG-01.
    w.writeByte(0x73); // TC_OBJECT
    w.writeClassDesc({
      name: 'com.example.CorruptSecondObject',
      uid: 1n,
      flags: SC_EXTERNALIZABLE,
      fields: [],
    });
    w.writeByte(0x7A); // TC_BLOCKDATALONG
    w.writeInt(-5);
    const bytes = w.toBytes();

    const swallowSpy = vi.spyOn(log, 'swallow');
    try {
      const results = deserializeStream(toArrayBuffer(bytes));

      expect(results).toEqual(['first-object']);
      expect(swallowSpy).toHaveBeenCalledWith('javaSerial:deserializeStream', expect.any(Error));
    } finally {
      swallowSpy.mockRestore();
    }
  });
});
