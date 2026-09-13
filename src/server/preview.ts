import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { ActionError, type PreviewTarget } from "./actions.ts";

/** Files above this size are refused outright. */
export const PREVIEW_MAX_FILE_BYTES = 1024 * 1024;
/** At most this many bytes are read; larger files are reported as truncated. */
export const PREVIEW_READ_BYTES = 256 * 1024;

export interface ResourcePreview {
  encoding: "utf-8";
  /** Unmodified text; when truncated it ends on a complete UTF-8 sequence. */
  content: string;
  empty: boolean;
  truncated: boolean;
  /** Size of the file on disk in bytes. */
  size: number;
  /** Bytes represented by `content`. */
  readBytes: number;
  lineCount: number;
}

/**
 * Reads a bounded plain-text preview of a file that the action inventory
 * validated moments ago. The recorded canonical path is opened directly
 * (never through the discovered symlink) without following a final symlink,
 * and the opened handle must still be the exact device and inode recorded at
 * scan time. A replaced or redirected target fails closed.
 */
export async function readPreview(target: PreviewTarget): Promise<ResourcePreview> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      target.canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new ActionError(
        "preview_unreadable",
        "The discovered resource cannot be read with the current permissions.",
      );
    }
    throw new ActionError(
      "resource_missing",
      "The discovered resource no longer exists.",
    );
  }

  try {
    const file = await handle.stat({ bigint: true });
    if (!file.isFile() || file.dev !== target.device || file.ino !== target.inode) {
      throw new ActionError(
        "resource_replaced",
        "The discovered resource changed after the scan. Scan again before previewing it.",
      );
    }
    const size = Number(file.size);
    if (size > PREVIEW_MAX_FILE_BYTES) {
      throw new ActionError(
        "preview_too_large",
        `The file is larger than ${PREVIEW_MAX_FILE_BYTES / 1024 / 1024} MiB and is not previewed.`,
      );
    }
    if (size === 0) {
      return {
        encoding: "utf-8",
        content: "",
        empty: true,
        truncated: false,
        size: 0,
        readBytes: 0,
        lineCount: 0,
      };
    }

    const truncated = size > PREVIEW_READ_BYTES;
    const buffer = Buffer.alloc(Math.min(size, PREVIEW_READ_BYTES));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    const sample = buffer.subarray(0, filled);
    if (sample.includes(0)) {
      throw new ActionError(
        "preview_not_text",
        "The file contains binary data and is not previewed.",
      );
    }
    const decoded = decodeUtf8(sample, truncated);
    if (decoded === undefined) {
      throw new ActionError(
        "preview_not_text",
        "The file is not UTF-8 text and is not previewed.",
      );
    }
    return {
      encoding: "utf-8",
      content: decoded.content,
      empty: false,
      truncated,
      size,
      readBytes: decoded.bytes,
      lineCount: countLines(decoded.content),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Decodes strictly. A truncated read can end inside a multi-byte sequence, so
 * up to three trailing bytes are dropped before giving up.
 */
function decodeUtf8(
  sample: Buffer,
  truncated: boolean,
): { content: string; bytes: number } | undefined {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const attempts = truncated ? Math.min(4, sample.length + 1) : 1;
  for (let drop = 0; drop < attempts; drop += 1) {
    const slice = sample.subarray(0, sample.length - drop);
    try {
      return { content: decoder.decode(slice), bytes: slice.length };
    } catch {
      continue;
    }
  }
  return undefined;
}

function countLines(content: string): number {
  if (content === "") {
    return 0;
  }
  const newlines = content.split("\n").length - 1;
  return content.endsWith("\n") ? newlines : newlines + 1;
}
