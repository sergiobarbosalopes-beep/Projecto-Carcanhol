const DEFAULT_MAX_FRAME_LENGTH = 512 * 1024;

export class NdjsonFrameDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private readonly maxFrameLength: number;

  constructor(maxFrameLength = DEFAULT_MAX_FRAME_LENGTH) {
    this.maxFrameLength = maxFrameLength;
  }

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): string[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const parts = this.buffer.split("\n");
    this.buffer = final ? "" : (parts.pop() ?? "");
    const frames = parts;

    if (final && frames.at(-1) === "") {
      frames.pop();
    }

    for (const frame of frames) {
      if (frame.length > this.maxFrameLength) {
        throw new Error("NDJSON frame exceeded limit.");
      }
    }

    if (!final && this.buffer.length > this.maxFrameLength) {
      throw new Error("NDJSON frame exceeded limit.");
    }

    return frames.filter((frame) => frame.trim().length > 0);
  }
}
