import { WritableByteStream, WritableStream } from "@open-flash/stream";
import { ActionType } from "avm1-tree/action-type";
import { Cfg } from "avm1-tree/cfg";
import { CfgDefineFunction } from "avm1-tree/cfg-actions/cfg-define-function";
import { CfgDefineFunction2 } from "avm1-tree/cfg-actions/cfg-define-function2";
import { CfgTry } from "avm1-tree/cfg-actions/cfg-try";
import { CfgWith } from "avm1-tree/cfg-actions/cfg-with";
import { CfgBlock } from "avm1-tree/cfg-block";
import { CfgBlockType } from "avm1-tree/cfg-block-type";
import { CfgLabel } from "avm1-tree/cfg-label";
import { UintSize } from "semantic-types";
import { emitAction } from "./emitters/avm1";

/**
 * Size of the offset in `If` and `Jump` actions (in bytes).
 */
const JUMP_OFFSET_SIZE: UintSize = 2;

export function cfgToBytes(cfg: Cfg, withEndOfActions: boolean = true): Uint8Array {
  const byteStream: WritableStream = new WritableStream();
  const blockOffsets: Map<CfgLabel, UintSize> = new Map();
  const branches: Map<UintSize, CfgLabel | null> = new Map();

  for (let blockIndex: UintSize = 0; blockIndex < cfg.blocks.length; blockIndex++) {
    const block: CfgBlock = cfg.blocks[blockIndex];
    const next: CfgBlock | undefined = blockIndex < cfg.blocks.length ? cfg.blocks[blockIndex + 1] : undefined;
    blockOffsets.set(block.label, byteStream.bytePos);
    const curBranches: ReadonlyMap<UintSize, CfgLabel> = emitBlock(byteStream, block);
    for (const [offset, target] of curBranches) {
      branches.set(offset, target);
    }
    switch (block.type) {
      case CfgBlockType.End:
        if (next !== undefined) {
          // Force jump to end
          branches.set(emitJumpAction(byteStream), null);
        }
        // Else: We already are the last block
        break;
      case CfgBlockType.Return:
        emitAction(byteStream, {action: ActionType.Return});
        break;
      case CfgBlockType.Simple:
        if (next === undefined || next.label !== block.next) {
          // Prevent fall-through by forcing a jump to the next block
          branches.set(emitJumpAction(byteStream), block.next);
        }
        // Else: the next block matches the next label so we let the fall-through
        break;
      case CfgBlockType.Throw:
        emitAction(byteStream, {action: ActionType.Throw});
        break;
      default:
        throw new Error("UnexpectedCfgBlockType");
    }
  }

  const endOffset: UintSize = byteStream.bytePos;
  if (withEndOfActions) {
    byteStream.writeUint8(0);
  }
  const bytes: Uint8Array = byteStream.getBytes();
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [offset, targetLabel] of branches) {
    const targetOffset: UintSize | undefined = targetLabel === null ? endOffset : blockOffsets.get(targetLabel);
    if (targetOffset === undefined) {
      throw new Error(`LabelNotFound: ${targetLabel}`);
    }
    // tslint:disable-next-line:restrict-plus-operands
    view.setInt16(offset, targetOffset - (offset + JUMP_OFFSET_SIZE), true);
  }
  return bytes;
}

function emitCfg(byteStream: WritableByteStream, cfg: Cfg): void {
  byteStream.writeBytes(cfgToBytes(cfg, false));
}

function emitBlock(byteStream: WritableByteStream, block: CfgBlock): Map<UintSize, CfgLabel> {
  const branches: Map<UintSize, CfgLabel> = new Map();
  for (const action of block.actions) {
    switch (action.action) {
      case ActionType.DefineFunction:
        emitDefineFunctionAction(byteStream, action);
        break;
      case ActionType.DefineFunction2:
        emitDefineFunction2Action(byteStream, action);
        break;
      case ActionType.If:
        branches.set(emitIfAction(byteStream), action.target);
        break;
      case ActionType.Jump:
        branches.set(emitJumpAction(byteStream), action.target);
        break;
      case ActionType.Try:
        emitTryAction(byteStream, action);
        break;
      case ActionType.With:
        emitWithAction(byteStream, action);
        break;
      default:
        emitAction(byteStream, action);
        break;
    }
  }
  return branches;
}

function emitDefineFunctionAction(byteStream: WritableByteStream, action: CfgDefineFunction): void {
  const bodyStream: WritableStream = new WritableStream();
  emitCfg(bodyStream, action.body);
  const body: Uint8Array = bodyStream.getBytes();
  emitAction(byteStream, {...action, body});
}

function emitDefineFunction2Action(byteStream: WritableByteStream, action: CfgDefineFunction2): void {
  const bodyStream: WritableStream = new WritableStream();
  emitCfg(bodyStream, action.body);
  const body: Uint8Array = bodyStream.getBytes();
  emitAction(byteStream, {...action, body});
}

function emitIfAction(byteStream: WritableByteStream): UintSize {
  emitAction(byteStream, {action: ActionType.If, offset: 0});
  return byteStream.bytePos - JUMP_OFFSET_SIZE;
}

function emitJumpAction(byteStream: WritableByteStream): UintSize {
  emitAction(byteStream, {action: ActionType.Jump, offset: 0});
  return byteStream.bytePos - JUMP_OFFSET_SIZE;
}

function emitTryAction(byteStream: WritableByteStream, action: CfgTry): void {
  const tryStream: WritableStream = new WritableStream();
  emitCfg(tryStream, action.try);
  const tryBody: Uint8Array = tryStream.getBytes();

  let catchBody: Uint8Array | undefined;
  if (action.catch !== undefined) {
    const catchStream: WritableStream = new WritableStream();
    emitCfg(catchStream, action.catch);
    catchBody = catchStream.getBytes();
  }

  let finallyBody: Uint8Array | undefined;
  if (action.finally !== undefined) {
    const finallyStream: WritableStream = new WritableStream();
    emitCfg(finallyStream, action.finally);
    finallyBody = finallyStream.getBytes();
  }

  emitAction(
    byteStream,
    {
      action: ActionType.Try,
      try: tryBody,
      catchTarget: action.catchTarget,
      catch: catchBody,
      finally: finallyBody,
    },
  );
}

function emitWithAction(byteStream: WritableByteStream, action: CfgWith): void {
  const bodyStream: WritableStream = new WritableStream();
  emitCfg(bodyStream, action.with);
  const body: Uint8Array = bodyStream.getBytes();
  emitAction(byteStream, {action: ActionType.With, with: body});
}
