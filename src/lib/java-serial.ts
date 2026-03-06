/**
 * Targeted Java Object Serialization protocol engine.
 * Implements just enough of the spec to serialize BMP commands
 * and deserialize BMP responses.
 */

// ── Type Codes ──────────────────────────────────────────────────

const TC_NULL          = 0x70;
const TC_REFERENCE     = 0x71;
const TC_CLASSDESC     = 0x72;
const TC_OBJECT        = 0x73;
const TC_STRING        = 0x74;
const TC_ARRAY         = 0x75;
const TC_BLOCKDATA     = 0x77;
const TC_ENDBLOCKDATA  = 0x78;
const TC_BLOCKDATALONG = 0x7A;
const TC_LONGSTRING    = 0x7C;
const TC_ENUM          = 0x7E;

// ── Serialization Flags ─────────────────────────────────────────

export const SC_SERIALIZABLE   = 0x02;
export const SC_EXTERNALIZABLE = 0x04;
export const SC_BLOCK_DATA     = 0x08;
export const SC_WRITE_METHOD   = 0x01;
export const SC_ENUM           = 0x10;

// ── Base Handle ─────────────────────────────────────────────────

const BASE_HANDLE = 0x7E0000;

// ── Types ───────────────────────────────────────────────────────

export interface JavaField {
  name: string;
  type: 'I' | 'J' | 'Z' | 'F' | 'D' | 'B' | 'C' | 'S' | 'L' | '[';
  className?: string; // For L/[ types: "Ljava/lang/String;" etc.
}

export interface JavaClassDesc {
  name: string;
  uid: bigint;
  flags: number;
  fields: JavaField[];
  parent?: JavaClassDesc | null;
}

/** Callback for Externalizable write */
type ExternalWriter = (obj: any, w: JavaWriter) => void;

/** Callback for Externalizable read / SC_WRITE_METHOD annotation read */
type ExternalReader = (r: JavaReader, result?: any) => any;

/** Callback to build field values from an object for writing */
type FieldExtractor = (obj: any) => Record<string, any>;

/** Callback to build an object from deserialized field values */
type ObjectBuilder = (fields: Record<string, any>) => any;

/** Callback for SC_WRITE_METHOD annotation (after default fields) */
type AnnotationWriter = (obj: any, bw: BlockDataWriter) => void;

export interface TypeRegistration {
  desc: JavaClassDesc;
  extWriter?: ExternalWriter;
  extReader?: ExternalReader;
  fieldExtractor?: FieldExtractor;
  objectBuilder?: ObjectBuilder;
  annotationWriter?: AnnotationWriter;
}

// ── Enum Wrapper ────────────────────────────────────────────────

export class JavaEnum {
  constructor(
    public readonly desc: JavaClassDesc,
    public readonly name: string,
  ) {}
}

// ── Type Registry ───────────────────────────────────────────────

const registry = new Map<string, TypeRegistration>();

export function registerType(reg: TypeRegistration) {
  registry.set(reg.desc.name, reg);
}

// ── Modified UTF-8 ──────────────────────────────────────────────

function encodeModifiedUTF8(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) {
      bytes.push(0xC0, 0x80);
    } else if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else {
      bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
  }
  return new Uint8Array(bytes);
}

function decodeModifiedUTF8(data: Uint8Array, offset: number, length: number): string {
  const chars: string[] = [];
  let i = offset;
  const end = offset + length;
  while (i < end) {
    const b = data[i++];
    if ((b & 0x80) === 0) {
      chars.push(String.fromCharCode(b));
    } else if ((b & 0xE0) === 0xC0) {
      const b2 = data[i++];
      chars.push(String.fromCharCode(((b & 0x1F) << 6) | (b2 & 0x3F)));
    } else if ((b & 0xF0) === 0xE0) {
      const b2 = data[i++];
      const b3 = data[i++];
      chars.push(String.fromCharCode(((b & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)));
    }
  }
  return chars.join('');
}

// ── JavaWriter ──────────────────────────────────────────────────

export class JavaWriter {
  private buf: number[] = [];
  private handles = new Map<string, number>();
  private nextHandle = BASE_HANDLE;

  /** Write stream header: AC ED 00 05 */
  writeStreamHeader() {
    this.buf.push(0xAC, 0xED, 0x00, 0x05);
  }

  /** Write raw byte */
  writeByte(b: number) {
    this.buf.push(b & 0xFF);
  }

  /** Write raw 16-bit short (big-endian) */
  writeShort(n: number) {
    this.buf.push((n >> 8) & 0xFF, n & 0xFF);
  }

  /** Write raw 32-bit int (big-endian) */
  writeInt(n: number) {
    this.buf.push((n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF);
  }

  /** Write raw 64-bit long (big-endian) */
  writeLong(n: bigint) {
    const hi = Number((n >> 32n) & 0xFFFFFFFFn);
    const lo = Number(n & 0xFFFFFFFFn);
    this.writeInt(hi);
    this.writeInt(lo);
  }

  /** Write raw boolean */
  writeBoolean(b: boolean) {
    this.buf.push(b ? 1 : 0);
  }

  /** Write raw float (big-endian IEEE 754) */
  writeFloat(f: number) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, f);
    const bytes = new Uint8Array(buf);
    this.buf.push(bytes[0], bytes[1], bytes[2], bytes[3]);
  }

  /** Write raw modified UTF-8 (2-byte length prefix + bytes) */
  writeRawUTF(s: string) {
    const bytes = encodeModifiedUTF8(s);
    this.writeShort(bytes.length);
    for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i]);
  }

  /** Write TC_BLOCKDATA with raw bytes */
  writeBlockData(data: number[] | Uint8Array) {
    if (data.length <= 255) {
      this.buf.push(TC_BLOCKDATA, data.length);
    } else {
      this.buf.push(TC_BLOCKDATALONG);
      this.writeInt(data.length);
    }
    for (let i = 0; i < data.length; i++) this.buf.push(data[i]);
  }

  /** Write TC_BLOCKDATA containing a single int */
  writeBlockInt(n: number) {
    this.writeBlockData([(n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]);
  }

  /** Write TC_ENDBLOCKDATA */
  writeEndBlockData() {
    this.buf.push(TC_ENDBLOCKDATA);
  }

  /** Write TC_NULL */
  writeNull() {
    this.buf.push(TC_NULL);
  }

  /** Write a string as TC_STRING (with handle tracking) or TC_REFERENCE */
  writeString(s: string): number {
    const key = `str:${s}`;
    const existing = this.handles.get(key);
    if (existing !== undefined) {
      this.writeReference(existing);
      return existing;
    }
    const bytes = encodeModifiedUTF8(s);
    if (bytes.length <= 0xFFFF) {
      this.buf.push(TC_STRING);
      const handle = this.assignHandle(key);
      this.writeShort(bytes.length);
      for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i]);
      return handle;
    } else {
      this.buf.push(TC_LONGSTRING);
      const handle = this.assignHandle(key);
      this.writeLong(BigInt(bytes.length));
      for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i]);
      return handle;
    }
  }

  /** Write TC_REFERENCE */
  writeReference(handle: number) {
    this.buf.push(TC_REFERENCE);
    this.writeInt(handle);
  }

  /** Write a class descriptor (or reference if already written) */
  writeClassDesc(desc: JavaClassDesc | null | undefined) {
    if (!desc) {
      this.writeNull();
      return;
    }
    const key = `cls:${desc.name}`;
    const existing = this.handles.get(key);
    if (existing !== undefined) {
      this.writeReference(existing);
      return;
    }
    this.buf.push(TC_CLASSDESC);
    this.assignHandle(key);
    this.writeRawUTF(desc.name);
    this.writeLong(desc.uid);
    this.writeByte(desc.flags);
    this.writeShort(desc.fields.length);
    for (const f of desc.fields) {
      this.writeByte(f.type.charCodeAt(0));
      this.writeRawUTF(f.name);
      if (f.type === 'L' || f.type === '[') {
        this.writeString(f.className!);
      }
    }
    this.writeEndBlockData(); // classAnnotation
    this.writeClassDesc(desc.parent); // superClassDesc
  }

  /** Write a full serialized object (TC_OBJECT + classDesc + field data) */
  writeObject(obj: any) {
    if (obj === null || obj === undefined) {
      this.writeNull();
      return;
    }
    if (typeof obj === 'string') {
      this.writeString(obj);
      return;
    }
    if (obj instanceof JavaEnum) {
      this.writeEnum(obj);
      return;
    }
    // Get type info from $type property
    const typeName: string = obj.$type;
    if (!typeName) throw new Error('Object missing $type property');

    const reg = registry.get(typeName);
    if (!reg) throw new Error(`Unknown type: ${typeName}`);

    if (reg.desc.flags & SC_EXTERNALIZABLE) {
      this.writeExternalizable(obj, reg);
      return;
    }

    this.buf.push(TC_OBJECT);
    this.writeClassDesc(reg.desc);
    this.assignHandle(`obj:${this.nextHandle}`);
    this.writeFieldValues(reg.desc, obj, reg.fieldExtractor);
  }

  /** Write field values for a class hierarchy (parent-first) */
  private writeFieldValues(desc: JavaClassDesc, obj: any, extractor?: FieldExtractor) {
    // Collect hierarchy (parent first)
    const chain: JavaClassDesc[] = [];
    let d: JavaClassDesc | null | undefined = desc;
    while (d) {
      chain.unshift(d);
      d = d.parent;
    }

    const values = extractor ? extractor(obj) : obj;

    for (const cls of chain) {
      for (const field of cls.fields) {
        this.writeFieldValue(field, values[field.name]);
      }
      if (cls.flags & SC_WRITE_METHOD) {
        // Call annotation writer if registered, then TC_ENDBLOCKDATA
        const reg = registry.get(cls.name);
        if (reg?.annotationWriter) {
          const bw = new BlockDataWriter(this);
          reg.annotationWriter(obj, bw);
          bw.flush();
        }
        this.writeEndBlockData();
      }
    }
  }

  /** Write a single field value based on type */
  private writeFieldValue(field: JavaField, value: any) {
    switch (field.type) {
      case 'I': this.writeInt(value ?? 0); break;
      case 'J': this.writeLong(value != null ? BigInt(value) : 0n); break;
      case 'Z': this.writeBoolean(value ?? false); break;
      case 'F': this.writeFloat(value ?? 0); break;
      case 'S': this.writeShort(value ?? 0); break;
      case 'B': this.writeByte(value ?? 0); break;
      case 'L': case '[':
        this.writeObject(value);
        break;
    }
  }

  /** Write an Externalizable object */
  private writeExternalizable(obj: any, reg: TypeRegistration) {
    this.buf.push(TC_OBJECT);
    this.writeClassDesc(reg.desc);
    this.assignHandle(`obj:${this.nextHandle}`);
    if (reg.extWriter) {
      reg.extWriter(obj, this);
    }
    this.writeEndBlockData();
  }

  /** Write an enum constant */
  writeEnum(e: JavaEnum) {
    const key = `enum:${e.desc.name}:${e.name}`;
    const existing = this.handles.get(key);
    if (existing !== undefined) {
      this.writeReference(existing);
      return;
    }
    this.buf.push(TC_ENUM);
    this.writeClassDesc(e.desc);
    this.assignHandle(key);
    this.writeString(e.name);
  }

  private assignHandle(key: string): number {
    const handle = this.nextHandle++;
    this.handles.set(key, handle);
    return handle;
  }

  /** Get the serialized bytes */
  toBytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

// ── Block Data Helper for Externalizable writes ─────────────────

/**
 * Buffers primitive writes and flushes as TC_BLOCKDATA before object writes.
 * Used within ExternalWriter callbacks.
 */
export class BlockDataWriter {
  private primBuf: number[] = [];

  constructor(private w: JavaWriter) {}

  /** Buffer an int for block data */
  writeInt(n: number) {
    this.primBuf.push((n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF);
  }

  /** Buffer a float for block data (big-endian IEEE 754) */
  writeFloat(f: number) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, f);
    const bytes = new Uint8Array(buf);
    this.primBuf.push(bytes[0], bytes[1], bytes[2], bytes[3]);
  }

  /** Buffer a UTF string for block data */
  writeUTF(s: string) {
    const bytes = encodeModifiedUTF8(s);
    this.primBuf.push((bytes.length >> 8) & 0xFF, bytes.length & 0xFF);
    for (let i = 0; i < bytes.length; i++) this.primBuf.push(bytes[i]);
  }

  /** Flush buffered primitives as TC_BLOCKDATA, then write an object */
  writeObject(obj: any) {
    this.flush();
    this.w.writeObject(obj);
  }

  /** Flush remaining block data */
  flush() {
    if (this.primBuf.length > 0) {
      this.w.writeBlockData(this.primBuf);
      this.primBuf = [];
    }
  }
}

// ── JavaReader ──────────────────────────────────────────────────

export class JavaReader {
  private data: DataView;
  private bytes: Uint8Array;
  private pos: number;
  private handles: any[] = [];
  // Block data mode
  private blockRemaining = 0;

  constructor(buffer: ArrayBuffer) {
    this.data = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.pos = 0;
  }

  get position(): number { return this.pos; }
  get remaining(): number { return this.bytes.length - this.pos; }

  /** Read and validate stream header (uses unsigned reads — magic 0xACED exceeds signed int16 range) */
  readStreamHeader() {
    const magic = this.data.getUint16(this.pos); this.pos += 2;
    const version = this.data.getUint16(this.pos); this.pos += 2;
    if (magic !== 0xACED) throw new Error(`Bad magic: 0x${magic.toString(16)}`);
    if (version !== 5) throw new Error(`Bad version: ${version}`);
  }

  // ── Raw reads (no block data awareness) ──

  readRawByte(): number {
    return this.bytes[this.pos++];
  }

  readRawShort(): number {
    const v = this.data.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  readRawUnsignedShort(): number {
    const v = this.data.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  readRawInt(): number {
    const v = this.data.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  readRawLong(): bigint {
    const hi = BigInt(this.data.getInt32(this.pos));
    const lo = BigInt(this.data.getUint32(this.pos + 4));
    this.pos += 8;
    return (hi << 32n) | lo;
  }

  readRawBoolean(): boolean {
    return this.readRawByte() !== 0;
  }

  readRawFloat(): number {
    const v = this.data.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }

  readRawUTF(): string {
    const len = this.readRawUnsignedShort();
    const s = decodeModifiedUTF8(this.bytes, this.pos, len);
    this.pos += len;
    return s;
  }

  // ── Block data reads ──

  /** Read int from block data stream */
  blockReadInt(): number {
    this.ensureBlockData(4);
    this.blockRemaining -= 4;
    return this.readRawInt();
  }

  /** Read long from block data stream */
  blockReadLong(): bigint {
    this.ensureBlockData(8);
    this.blockRemaining -= 8;
    return this.readRawLong();
  }

  /** Read boolean from block data stream */
  blockReadBoolean(): boolean {
    this.ensureBlockData(1);
    this.blockRemaining -= 1;
    return this.readRawBoolean();
  }

  /** Read UTF from block data stream */
  blockReadUTF(): string {
    this.ensureBlockData(2);
    const len = this.readRawUnsignedShort();
    this.blockRemaining -= 2;
    this.ensureBlockData(len);
    const s = decodeModifiedUTF8(this.bytes, this.pos, len);
    this.pos += len;
    this.blockRemaining -= len;
    return s;
  }

  /** Read an object from the stream (exits block data mode) */
  blockReadObject(): any {
    // Skip remaining block data in current chunk
    if (this.blockRemaining > 0) {
      this.pos += this.blockRemaining;
      this.blockRemaining = 0;
    }
    return this.readObject();
  }

  private ensureBlockData(needed: number) {
    while (this.blockRemaining < needed) {
      const tc = this.peekByte();
      if (tc === TC_BLOCKDATA) {
        this.pos++; // consume TC_BLOCKDATA
        this.blockRemaining += this.readRawByte(); // 1-byte length
      } else if (tc === TC_BLOCKDATALONG) {
        this.pos++;
        this.blockRemaining += this.readRawInt(); // 4-byte length
      } else {
        throw new Error(`Expected block data, got 0x${tc.toString(16)} at pos ${this.pos}`);
      }
    }
  }

  peekByte(): number {
    return this.bytes[this.pos];
  }

  // ── Object reads ──

  /** Read any content element from the stream */
  readObject(): any {
    if (this.pos >= this.bytes.length) return null;
    const tc = this.readRawByte();
    switch (tc) {
      case TC_NULL: return null;
      case TC_REFERENCE: return this.readReference();
      case TC_OBJECT: return this.readNewObject();
      case TC_STRING: return this.readNewString();
      case TC_LONGSTRING: return this.readLongString();
      case TC_ENUM: return this.readNewEnum();
      case TC_ARRAY: return this.readNewArray();
      case TC_CLASSDESC: return this.readNewClassDescObj();
      case TC_BLOCKDATA: return this.readBlockDataContent();
      case TC_BLOCKDATALONG: return this.readBlockDataLongContent();
      case TC_ENDBLOCKDATA: return { $endBlockData: true };
      default:
        throw new Error(`Unknown type code 0x${tc.toString(16)} at pos ${this.pos - 1}`);
    }
  }

  /** Try to read an object; returns null on EOF */
  tryReadObject(): any {
    if (this.pos >= this.bytes.length) return null;
    return this.readObject();
  }

  private readReference(): any {
    const handle = this.readRawInt();
    const idx = handle - BASE_HANDLE;
    if (idx < 0 || idx >= this.handles.length) {
      throw new Error(`Bad handle reference: 0x${handle.toString(16)}`);
    }
    return this.handles[idx];
  }

  private addHandle(obj: any): number {
    const handle = BASE_HANDLE + this.handles.length;
    this.handles.push(obj);
    return handle;
  }

  private readNewString(): string {
    const s = this.readRawUTF();
    this.addHandle(s);
    return s;
  }

  private readLongString(): string {
    const len = Number(this.readRawLong());
    const s = decodeModifiedUTF8(this.bytes, this.pos, len);
    this.pos += len;
    this.addHandle(s);
    return s;
  }

  private readNewEnum(): any {
    const desc = this.readClassDescElement();
    const handle = this.addHandle(null); // placeholder
    const name = this.readObject() as string;
    const enumObj = new JavaEnum(desc, name);
    this.handles[handle - BASE_HANDLE] = enumObj;
    return enumObj;
  }

  private readNewClassDescObj(): JavaClassDesc {
    return this.readClassDescBody();
  }

  /** Read a classDesc element (TC_CLASSDESC, TC_NULL, or TC_REFERENCE) */
  readClassDescElement(): JavaClassDesc {
    const tc = this.readRawByte();
    switch (tc) {
      case TC_CLASSDESC: return this.readClassDescBody();
      case TC_NULL: return null as any;
      case TC_REFERENCE: return this.readReference();
      default:
        throw new Error(`Expected classDesc, got 0x${tc.toString(16)} at pos ${this.pos - 1}`);
    }
  }

  private readClassDescBody(): JavaClassDesc {
    const name = this.readRawUTF();
    const uid = this.readRawLong();
    const desc: JavaClassDesc = { name, uid, flags: 0, fields: [] };
    this.addHandle(desc);
    desc.flags = this.readRawByte();
    const fieldCount = this.readRawUnsignedShort();
    for (let i = 0; i < fieldCount; i++) {
      const typeCode = String.fromCharCode(this.readRawByte());
      const fieldName = this.readRawUTF();
      let className: string | undefined;
      if (typeCode === 'L' || typeCode === '[') {
        className = this.readObject() as string;
      }
      desc.fields.push({ name: fieldName, type: typeCode as JavaField['type'], className });
    }
    // classAnnotation: read until TC_ENDBLOCKDATA
    this.skipAnnotation();
    // superClassDesc
    desc.parent = this.readClassDescElement();
    return desc;
  }

  /** Skip annotation content until TC_ENDBLOCKDATA */
  private skipAnnotation() {
    while (true) {
      const tc = this.peekByte();
      if (tc === TC_ENDBLOCKDATA) {
        this.pos++; // consume it
        return;
      }
      // Read and discard
      this.readObject();
    }
  }

  private readNewObject(): any {
    const desc = this.readClassDescElement();
    if (!desc) return null;

    // Check registered type
    const reg = registry.get(desc.name);

    const result: Record<string, any> = { $class: desc.name };
    const handle = this.addHandle(result);

    if (desc.flags & SC_EXTERNALIZABLE) {
      // Read external content
      if (reg?.extReader) {
        const obj = reg.extReader(this);
        obj.$class = desc.name;
        this.handles[handle - BASE_HANDLE] = obj;
        // Consume TC_ENDBLOCKDATA
        this.skipToEndBlockData();
        return obj;
      }
      // Skip external content
      this.skipToEndBlockData();
      return result;
    }

    // Regular serializable object — read field values for each class in hierarchy
    const chain = this.buildClassChain(desc);
    for (const cls of chain) {
      this.readClassFieldValues(cls, result);
      if (cls.flags & SC_WRITE_METHOD) {
        // Read annotation data (object annotations from writeObject)
        this.readWriteMethodAnnotation(cls, result);
      }
    }

    if (reg?.objectBuilder) {
      const built = reg.objectBuilder(result);
      built.$class = desc.name;
      this.handles[handle - BASE_HANDLE] = built;
      return built;
    }

    return result;
  }

  /** Build class hierarchy chain (parent first) from a class desc */
  private buildClassChain(desc: JavaClassDesc): JavaClassDesc[] {
    const chain: JavaClassDesc[] = [];
    let d: JavaClassDesc | null | undefined = desc;
    while (d) {
      chain.unshift(d);
      d = d.parent;
    }
    return chain;
  }

  /** Read field values for a single class level */
  private readClassFieldValues(desc: JavaClassDesc, result: Record<string, any>) {
    for (const field of desc.fields) {
      result[field.name] = this.readFieldValue(field);
    }
  }

  /** Read a single field value */
  private readFieldValue(field: JavaField): any {
    switch (field.type) {
      case 'I': return this.readRawInt();
      case 'J': return this.readRawLong();
      case 'Z': return this.readRawBoolean();
      case 'F': return this.readRawFloat();
      case 'S': return this.readRawShort();
      case 'B': return this.readRawByte();
      case 'D': {
        const v = this.data.getFloat64(this.pos);
        this.pos += 8;
        return v;
      }
      case 'L': case '[':
        return this.readObject();
      default:
        throw new Error(`Unknown field type: ${field.type}`);
    }
  }

  /** Read writeObject annotation (SC_WRITE_METHOD) */
  private readWriteMethodAnnotation(desc: JavaClassDesc, result: Record<string, any>) {
    const reg = registry.get(desc.name);
    if (reg?.extReader) {
      // Use custom reader for writeObject content
      reg.extReader.call(null, this, result);
      // Drain any unread block data left by the extReader
      if (this.blockRemaining > 0) {
        this.pos += this.blockRemaining;
        this.blockRemaining = 0;
      }
    }
    // Always consume remaining annotation content + TC_ENDBLOCKDATA
    this.skipToEndBlockData();
  }

  /** Skip all content until TC_ENDBLOCKDATA */
  private skipToEndBlockData() {
    while (true) {
      if (this.pos >= this.bytes.length) return;
      const tc = this.peekByte();
      if (tc === TC_ENDBLOCKDATA) {
        this.pos++; // consume it
        return;
      }
      if (tc === TC_BLOCKDATA) {
        this.pos++;
        const len = this.readRawByte();
        this.pos += len;
      } else if (tc === TC_BLOCKDATALONG) {
        this.pos++;
        const len = this.readRawInt();
        this.pos += len;
      } else {
        // Could be a nested object — read and discard
        this.readObject();
      }
    }
  }

  private readNewArray(): any {
    const desc = this.readClassDescElement();
    const handle = this.addHandle([]);
    const count = this.readRawInt();
    const arr: any[] = [];
    this.handles[handle - BASE_HANDLE] = arr;

    if (!desc) return arr;

    // Determine element type from class name (e.g., "[B" for byte[], "[Ljava.lang.String;" for String[])
    const elemType = desc.name.length >= 2 ? desc.name[1] : 'L';

    for (let i = 0; i < count; i++) {
      switch (elemType) {
        case 'I': arr.push(this.readRawInt()); break;
        case 'J': arr.push(this.readRawLong()); break;
        case 'Z': arr.push(this.readRawBoolean()); break;
        case 'B': arr.push(this.readRawByte()); break;
        case 'F': arr.push(this.readRawFloat()); break;
        case 'S': arr.push(this.readRawShort()); break;
        case 'D': {
          const v = this.data.getFloat64(this.pos);
          this.pos += 8;
          arr.push(v);
          break;
        }
        default: arr.push(this.readObject()); break;
      }
    }
    return arr;
  }

  /** Read TC_BLOCKDATA content as raw bytes, return as marker */
  private readBlockDataContent(): any {
    const len = this.readRawByte();
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, len);
    this.pos += len;
    return { $blockData: true, length: len, view };
  }

  private readBlockDataLongContent(): any {
    const len = this.readRawInt();
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, len);
    this.pos += len;
    return { $blockData: true, length: len, view };
  }
}

// ── Convenience ─────────────────────────────────────────────────

/** Serialize one or more BMP commands into a binary payload */
export function serializeCommands(commands: any[]): Uint8Array {
  const w = new JavaWriter();
  w.writeStreamHeader();
  w.writeBlockInt(commands.length);
  for (const cmd of commands) {
    w.writeObject(cmd);
  }
  return w.toBytes();
}

/** Deserialize a BMP response (login ticket or command response) */
export function deserializeResponse(buffer: ArrayBuffer): any {
  const r = new JavaReader(buffer);
  r.readStreamHeader();
  return r.readObject();
}

/** Deserialize a streaming response (ExtendedExecuteCommand) — reads all objects until EOF */
export function deserializeStream(buffer: ArrayBuffer): any[] {
  const r = new JavaReader(buffer);
  r.readStreamHeader();
  const results: any[] = [];
  while (r.remaining > 0) {
    try {
      const obj = r.tryReadObject();
      if (obj === null) break;
      if (obj?.$endBlockData) continue;
      if (obj?.$blockData) {
        // Top-level block data — extract int if present
        const view = obj.view as DataView;
        if (view.byteLength === 4) {
          // Command count echo or similar — skip
        }
        continue;
      }
      results.push(obj);
    } catch {
      break;
    }
  }
  return results;
}
