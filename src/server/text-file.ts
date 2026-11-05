import fs from 'node:fs';

export const MAX_TEXT_BYTES = 256 * 1024;

/** Read at most the preview limit plus one byte, including files that grow while open. */
export async function readTextFile(filePath: string): Promise<string> {
  const fail = (status: number, message: string): never => {
    throw Object.assign(new Error(message), { status });
  };
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail(415, 'Only regular text files can be previewed');
    if (stat.size > MAX_TEXT_BYTES) fail(413, 'File exceeds the 256 KiB preview limit');
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_TEXT_BYTES) fail(413, 'File exceeds the 256 KiB preview limit');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { return fail(415, 'Preview supports UTF-8 text files only'); }
    if (/[\x00-\x08\x0e-\x1f]/.test(text)) fail(415, 'Binary files cannot be previewed as text');
    return text;
  } finally {
    await handle.close();
  }
}
