/**
 * A minimal, dependency-free reader for the POSIX ustar tar format `npm
 * pack` actually emits, plus the safety predicates `test/pack.test.ts`
 * checks the real packed tarball against.
 *
 * Not a `*.test.` file itself (see `scripts/run-tests.mjs`'s own
 * `TEST_FILE_PATTERN` - only a `.test.` infix makes something a discovered
 * suite), so this is a plain helper module `test/pack.test.ts` imports,
 * exactly like `test/helpers/spawnServer.ts` is for `test/harness.ts`.
 *
 * Why a hand-rolled reader instead of a `tar` npm package: this repo has
 * no `tar` dependency anywhere in its tree today (confirmed via `npm ls
 * tar --all`), and adding one only to read back an archive this same
 * toolchain just produced is more footprint than the format needs. A
 * gzip-compressed POSIX ustar tarball is a well-defined, fixed-layout
 * binary format - 512-byte header blocks at fixed field offsets, data
 * rounded up to the next 512-byte boundary, two all-zero blocks marking
 * the end - and `node:zlib`'s built-in `gunzipSync` is all the
 * decompression this needs.
 *
 * Verified directly against a real `npm pack` output before being relied
 * on here (not assumed from the tar spec alone): the real tarball's first
 * header carries magic bytes `"ustar\0"` + version `"00"` (POSIX ustar,
 * not GNU or a pax-extended archive), typeflag `"0"` (plain regular
 * file) for every entry `npm pack` produced, and this reader's own entry
 * count and per-entry sizes matched the system `tar -tv`/`npm pack
 * --json` output exactly on that real artifact. `UNSUPPORTED_TYPEFLAGS`
 * below is what happens if a *future* npm version ever emits pax extended headers
 * (e.g. for a path or a size the ustar fixed fields can't represent) -
 * this reader fails LOUD on that rather than silently reading a stale or
 * truncated name/size, since silently ignoring a header type that can
 * override a later entry's own path is exactly the kind of blind spot a
 * safety scan must not have.
 */
import { gunzipSync } from "node:zlib";

const HEADER_SIZE = 512;

/** Byte offsets for the ustar header fields this reader actually uses. */
const FIELD = {
  name: [0, 100],
  mode: [100, 108],
  size: [124, 136],
  typeflag: [156, 157],
  linkname: [157, 257],
  magic: [257, 263],
  prefix: [345, 500],
} as const;

export interface TarEntry {
  /** The entry's full path as recorded in the header (e.g. `package/dist/index.js`). */
  readonly path: string;
  /** The single-character type flag (`"0"`/`"\0"` regular file, `"1"` hardlink, `"2"` symlink, `"5"` directory, ...). */
  readonly typeflag: string;
  /** Permission bits only (e.g. `0o644`), parsed from the header's octal mode field. */
  readonly mode: number;
  /** Declared entry size in bytes (0 for non-regular-file entries in every archive `npm pack` produces). */
  readonly size: number;
  /** The link target, for a hardlink/symlink entry; empty string otherwise. */
  readonly linkname: string;
  /** Byte offset of this entry's OWN data within the buffer `parseTarball` was given - what `readEntryContent` slices from. Equal to the entry's own header offset + 512 for every entry this reader accepts (a plain ustar header is always exactly one block). */
  readonly dataOffset: number;
}

export interface ParsedTarball {
  readonly entries: readonly TarEntry[];
  /** Sum of every REGULAR file entry's own declared size - what actually lands on disk once unpacked. */
  readonly totalUnpackedSize: number;
  /** The decompressed buffer every entry's `dataOffset` is relative to - kept alongside the entries so `readEntryContent` needs no second decompression pass. */
  readonly rawBuffer: Buffer;
}

/** Slices one entry's own raw file content out of the buffer it was parsed from (see `ParsedTarball.rawBuffer`). Only meaningful for a regular-file entry (`typeflag` `"0"`/`"\0"`) - every other type has a declared `size` of 0 in every archive this reader accepts, so this always returns an empty buffer for one. */
export function readEntryContent(parsed: ParsedTarball, entry: TarEntry): Buffer {
  return parsed.rawBuffer.subarray(entry.dataOffset, entry.dataOffset + entry.size);
}

/** Type flags this reader refuses to silently pass through - a header type that can override a later entry's own recorded name/size, and that this reader does not itself interpret. */
const UNSUPPORTED_TYPEFLAGS = new Set(["x", "g", "L", "K"]);

function parseOctalField(header: Buffer, [start, end]: readonly [number, number]): number {
  const text = header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "").trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) {
    throw new Error(`archive-scan: unparseable octal tar header field: ${JSON.stringify(text)}`);
  }
  return value;
}

function parseTextField(header: Buffer, [start, end]: readonly [number, number]): string {
  return header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
}

/**
 * Parses a gzip-compressed ustar tarball buffer (exactly what `npm pack`
 * writes to disk) into its full entry list. Reads every 512-byte header
 * block in sequence, following each one's declared size to skip its
 * data blocks (rounded up to the next 512-byte boundary, per the ustar
 * spec), and stops at the first all-zero header block (the archive's own
 * end-of-archive marker) or the buffer's end, whichever comes first.
 *
 * Throws on any entry whose typeflag this reader does not itself
 * interpret (pax extended/global headers, GNU long-name/long-link
 * entries) rather than silently skipping it - one of those can override
 * a LATER entry's own recorded name, so silently ignoring it is exactly
 * the kind of blind spot a safety scan must not have. `npm pack` has
 * never been observed to emit one for this package (verified against a
 * real build - see this file's header), so this is a fail-loud guard
 * against a future toolchain change, not a case this reader is expected
 * to hit in practice.
 */
export function parseTarball(buffer: Buffer): ParsedTarball {
  const entries: TarEntry[] = [];
  let offset = 0;
  let totalUnpackedSize = 0;

  while (offset + HEADER_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + HEADER_SIZE);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker

    const typeflag = parseTextField(header, FIELD.typeflag) || "0";
    if (UNSUPPORTED_TYPEFLAGS.has(typeflag)) {
      throw new Error(
        `archive-scan: unsupported tar header type ${JSON.stringify(typeflag)} at byte offset ${offset} - ` +
          "this reader only understands plain ustar headers (see this file's own header doc)"
      );
    }

    const name = parseTextField(header, FIELD.name);
    const prefix = parseTextField(header, FIELD.prefix);
    const entryPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const mode = parseOctalField(header, FIELD.mode) & 0o7777;
    const size = parseOctalField(header, FIELD.size);
    const linkname = parseTextField(header, FIELD.linkname);
    const magic = parseTextField(header, FIELD.magic);

    if (!magic.startsWith("ustar")) {
      throw new Error(
        `archive-scan: header at byte offset ${offset} is not a ustar header (magic bytes: ${JSON.stringify(magic)})`
      );
    }

    const dataOffset = offset + HEADER_SIZE;
    entries.push({ path: entryPath, typeflag, mode, size, linkname, dataOffset });
    if (typeflag === "0" || typeflag === "\0") totalUnpackedSize += size;

    offset += HEADER_SIZE + Math.ceil(size / HEADER_SIZE) * HEADER_SIZE;
  }

  return { entries, totalUnpackedSize, rawBuffer: buffer };
}

/** Decompresses and parses a real `.tgz` file's bytes in one step. */
export function parseTarballGzip(gzipBuffer: Buffer): ParsedTarball {
  return parseTarball(gunzipSync(gzipBuffer));
}

// ---------------------------------------------------------------------------
// Archive safety predicates - each returns every VIOLATION it finds, never
// a bare boolean, so a failing assertion names exactly which entries are
// the problem instead of forcing a re-run under a debugger.
// ---------------------------------------------------------------------------

const HARDLINK_TYPEFLAG = "1";
const SYMLINK_TYPEFLAG = "2";
/** The only two permission-bit patterns this package's own tarball ever ships: read-only, and the executable bin's own mode. */
const ALLOWED_MODES: ReadonlySet<number> = new Set([0o644, 0o755]);

/** Every entry whose path is absolute, or escapes `package/` via a `..` segment - either would let extraction write outside the target directory. */
export function findPathTraversalViolations(entries: readonly TarEntry[]): TarEntry[] {
  return entries.filter((entry) => {
    if (entry.path.startsWith("/")) return true;
    const segments = entry.path.split("/");
    return segments.includes("..");
  });
}

/** Every entry that does not live under a top-level `package/` directory - `npm pack`'s own documented wrapper, and the one prefix extraction ever writes under. */
export function findEntriesOutsidePackagePrefix(entries: readonly TarEntry[]): TarEntry[] {
  return entries.filter((entry) => entry.path !== "package" && !entry.path.startsWith("package/"));
}

/** Every symlink or hardlink entry - neither is ever permitted in the tarball this story ships. */
export function findLinkEntries(entries: readonly TarEntry[]): TarEntry[] {
  return entries.filter(
    (entry) => entry.typeflag === SYMLINK_TYPEFLAG || entry.typeflag === HARDLINK_TYPEFLAG
  );
}

/** Every entry whose permission bits fall outside the exact `{0644, 0755}` allow-list. */
export function findDisallowedModeEntries(entries: readonly TarEntry[]): TarEntry[] {
  return entries.filter((entry) => !ALLOWED_MODES.has(entry.mode));
}

/** Every `.map` file entry - the source-map policy this story freezes at zero. */
export function findSourceMapEntries(entries: readonly TarEntry[]): TarEntry[] {
  return entries.filter((entry) => entry.path.endsWith(".map"));
}
