import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * ZIP archives, written and read.
 *
 * Small on purpose, and both halves are stricter than a general-purpose tool.
 * The writer uses one fixed timestamp and keeps entries in the order given, so
 * the same files are the same archive byte for byte. The reader is for
 * archives that arrive from outside: it refuses anything it was not told to
 * expect — a path that climbs out, an entry larger than it claims, more data
 * than the caller allowed — rather than trusting what a header says.
 *
 * ponytail: no ZIP64, so under 4 GB and 65,535 entries. A session is not near.
 */

/** One file of an archive: its path inside it, and its content. */
export interface ArchiveFile {
  readonly path: string;
  readonly data: Uint8Array | string;
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

const bytes = (value: Uint8Array | string): Uint8Array =>
  typeof value === 'string' ? Buffer.from(value, 'utf8') : value;

/** 2000-01-01, the date every reproducible output here is given, as a ZIP stores one. */
const ZIP_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

export function zip(files: readonly ArchiveFile[]): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const data = bytes(file.data);
    const packed = deflateRawSync(data, { level: 9 });

    // Shared by both headers: version, flags (UTF-8 names), deflate, time, date, crc, sizes.
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0);
    fields.writeUInt16LE(0x0800, 2);
    fields.writeUInt16LE(8, 4);
    fields.writeUInt16LE(0, 6);
    fields.writeUInt16LE(ZIP_DATE, 8);
    fields.writeUInt32LE(crc32(data), 10);
    fields.writeUInt32LE(packed.byteLength, 14);
    fields.writeUInt32LE(data.byteLength, 18);
    fields.writeUInt16LE(name.byteLength, 22);
    fields.writeUInt16LE(0, 24);

    const header = Buffer.alloc(4);
    header.writeUInt32LE(LOCAL, 0);
    local.push(header, fields, name, packed);

    const entry = Buffer.alloc(6);
    entry.writeUInt32LE(CENTRAL, 0);
    entry.writeUInt16LE(20, 4);
    // Comment length, disk, internal and external attributes, then where the entry starts.
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10);
    central.push(entry, fields, tail, name);

    offset += 4 + fields.byteLength + name.byteLength + packed.byteLength;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export interface UnzipLimits {
  /** The most entries the archive may hold. */
  readonly maxEntries: number;
  /** The most bytes all entries may unpack to, together. */
  readonly maxBytes: number;
}

/** A path that names a file inside the archive and nowhere else. */
// eslint-disable-next-line no-control-regex
const SAFE_PATH = /^(?!\/)(?!.*(^|\/)\.{1,2}(\/|$))[^\\:*?"<>|\u0000-\u001f]+$/;

/**
 * Reads an archive into memory.
 *
 * Every entry is checked before and after it is unpacked: its path must stay
 * inside the archive, it must be stored or deflated, it must unpack to exactly
 * the size and checksum its header states, and the total must stay within what
 * the caller allowed — so an archive that expands without end is stopped at
 * the limit rather than at the machine's memory.
 */
export function unzip(archive: Uint8Array, limits: UnzipLimits): Map<string, Uint8Array> {
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  // The end record is the last 22 bytes of an archive with no comment, which is all `zip` writes;
  // one with a comment is found by searching back for the signature.
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== END) end -= 1;
  if (end < 0) throw new ArchiveError('this is not a ZIP archive');

  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  if (count > limits.maxEntries) {
    throw new ArchiveError(
      `the archive holds ${String(count)} entries; at most ${String(limits.maxEntries)} are accepted`,
    );
  }

  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL) {
      throw new ArchiveError('the archive directory is damaged');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const packedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const path = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (path.endsWith('/')) continue; // a directory entry holds nothing
    if (!SAFE_PATH.test(path)) throw new ArchiveError(`not a path inside the archive: ${path}`);
    if (files.has(path)) throw new ArchiveError(`the archive names ${path} twice`);
    if (method !== 0 && method !== 8) {
      throw new ArchiveError(`${path} is compressed in a way this reader does not accept`);
    }
    total += size;
    if (total > limits.maxBytes) {
      throw new ArchiveError(`the archive unpacks to more than ${String(limits.maxBytes)} bytes`);
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) {
      throw new ArchiveError(`${path} is not where the archive says it is`);
    }
    const start =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    const packed = buffer.subarray(start, start + packedSize);
    if (packed.length !== packedSize) throw new ArchiveError(`${path} is cut short`);

    let data: Buffer;
    try {
      // The size it claimed is the most it is allowed to become.
      data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) });
    } catch {
      throw new ArchiveError(`${path} does not unpack to what its header states`);
    }
    if (data.length !== size || crc32(data) !== checksum) {
      throw new ArchiveError(`${path} does not unpack to what its header states`);
    }
    files.set(path, data);
  }
  return files;
}
