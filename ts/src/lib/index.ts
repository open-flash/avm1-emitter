import { WritableStream } from "@open-flash/stream";
import { Action } from "avm1-tree";
import { UintSize } from "semantic-types";
import { emitAction } from "./emitters/avm1";

export { emitAction } from "./emitters/avm1";

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

  getBytess(): Uint8Array {
    return this.stream.getBytes();
  }
}
