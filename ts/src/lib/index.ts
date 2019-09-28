import { WritableStream } from "@open-flash/stream";
import { Action } from "avm1-types/action";
import { UintSize } from "semantic-types";
import { emitAction } from "./emitters/avm1";

export { emitAction } from "./emitters/avm1";
export { cfgToBytes } from "./cfg-to-bytes";

export class Avm1Emitter {
  private stream: WritableStream;

  constructor() {
    this.stream = new WritableStream();
  }

  getByteOffset(): UintSize {
    return this.stream.bytePos;
  }

  writeAction(action: Action): void {
    emitAction(this.stream, action);
  }

  getBytes(): Uint8Array {
    return this.stream.getBytes();
  }
}
