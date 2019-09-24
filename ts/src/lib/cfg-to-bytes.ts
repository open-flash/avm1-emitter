// tslint:disable:restrict-plus-operands

import { WritableByteStream, WritableStream } from "@open-flash/stream";
import { ActionType } from "avm1-tree/action-type";
import { Cfg } from "avm1-tree/cfg";
import { CfgDefineFunction } from "avm1-tree/cfg-actions/cfg-define-function";
import { CfgDefineFunction2 } from "avm1-tree/cfg-actions/cfg-define-function2";
import { CfgBlock } from "avm1-tree/cfg-block";
import { CfgBlockType } from "avm1-tree/cfg-block-type";
import { CfgLabel, NullableCfgLabel } from "avm1-tree/cfg-label";
import { UintSize } from "semantic-types";
import { emitAction } from "./emitters/avm1";

/**
 * Size of the offset in `If` and `Jump` actions (in bytes).
 */
const JUMP_OFFSET_SIZE: UintSize = 2;

export function cfgToBytes(cfg: Cfg): Uint8Array {
  return emitHardCfg(cfg, true);
}

function emitHardCfg(cfg: Cfg, appendEndAction: boolean): Uint8Array {
  const stream: WritableByteStream = new WritableStream();
  const wi: WriteInfo = emitSoftCfg(stream, cfg, null);
  const endOffset: UintSize = stream.bytePos;

  if (appendEndAction) {
    emitEndAction(stream);
  }

  const bytes: Uint8Array = stream.getBytes();

  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [offset, targetLabel] of wi.jumps) {
    const targetOffset: UintSize | undefined = targetLabel === null ? endOffset : wi.blocks.get(targetLabel);
    if (targetOffset === undefined) {
      throw new Error(`LabelNotFound: ${targetLabel}`);
    }
    // tslint:disable-next-line:restrict-plus-operands
    view.setInt16(offset, targetOffset - (offset + JUMP_OFFSET_SIZE), true);
  }
  return bytes;
}

interface WriteInfo {
  jumps: Map<UintSize, NullableCfgLabel>;
  blocks: Map<CfgLabel, UintSize>;
}

function emitSoftCfg(
  stream: WritableByteStream,
  cfg: Cfg,
  fallthroughNext: NullableCfgLabel,
): WriteInfo {
  const jumps: Map<UintSize, NullableCfgLabel> = new Map();
  const blocks: Map<CfgLabel, UintSize> = new Map();

  for (let i: UintSize = 0; i < cfg.blocks.length; i++) {
    const block: CfgBlock = cfg.blocks[i];
    const curNext: NullableCfgLabel = i < cfg.blocks.length - 1 ? cfg.blocks[i + 1].label : fallthroughNext;

    const wi: WriteInfo = emitBlock(stream, block, curNext);
    for (const [offset, target] of wi.jumps) {
      jumps.set(offset, target);
    }
    for (const [label, offset] of wi.blocks) {
      blocks.set(label, offset);
    }
  }

  return {jumps, blocks};
}

// tslint:disable-next-line:cyclomatic-complexity
function emitBlock(
  stream: WritableByteStream,
  block: CfgBlock,
  fallthroughNext: NullableCfgLabel,
): WriteInfo {
  const jumps: Map<UintSize, NullableCfgLabel> = new Map();
  const blocks: Map<CfgLabel, UintSize> = new Map();

  blocks.set(block.label, stream.bytePos);

  for (const action of block.actions) {
    switch (action.action) {
      case ActionType.DefineFunction:
        emitDefineFunctionAction(stream, action);
        break;
      case ActionType.DefineFunction2:
        emitDefineFunction2Action(stream, action);
        break;
      default:
        emitAction(stream, action);
        break;
    }
  }
  switch (block.type) {
    case CfgBlockType.Error:
      throw new Error("NotImplemented: Support for `Error` CFG blocks");
    case CfgBlockType.If:
      jumps.set(emitIfAction(stream), block.ifTrue);
      if (fallthroughNext !== block.ifFalse) {
        if (block.ifFalse === null) {
          emitEndAction(stream);
        } else {
          jumps.set(emitJumpAction(stream), block.ifFalse);
        }
      }
      break;
    case CfgBlockType.Simple:
      if (fallthroughNext !== block.next) {
        if (block.next === null) {
          emitEndAction(stream);
        } else {
          jumps.set(emitJumpAction(stream), block.next);
        }
      }
      break;
    case CfgBlockType.Return:
      emitAction(stream, {action: ActionType.Return});
      break;
    case CfgBlockType.Throw:
      emitAction(stream, {action: ActionType.Throw});
      break;
    case CfgBlockType.Try: {
      const finallyNext: NullableCfgLabel = fallthroughNext;
      const catchNext: NullableCfgLabel = block.finally !== undefined && block.finally.blocks.length > 0
        ? block.finally.blocks[0].label
        : finallyNext;
      const tryNext: NullableCfgLabel = block.catch !== undefined && block.catch.blocks.length > 0
        ? block.catch.blocks[0].label
        : catchNext;

      const tryStream: WritableByteStream = new WritableStream();
      const tryWi: WriteInfo = emitSoftCfg(tryStream, block.try, tryNext);

      const catchStream: WritableByteStream = new WritableStream();
      let catchWi: WriteInfo | undefined;
      if (block.catch !== undefined) {
        catchWi = emitSoftCfg(catchStream, block.catch, catchNext);
      }

      const finallyStream: WritableByteStream = new WritableStream();
      let finallyWi: WriteInfo | undefined;
      if (block.finally !== undefined) {
        finallyWi = emitSoftCfg(finallyStream, block.finally, finallyNext);
      }

      emitAction(
        stream,
        {
          action: ActionType.Try,
          trySize: tryStream.bytePos,
          catchSize: catchWi !== undefined ? catchStream.bytePos : undefined,
          catchTarget: block.catchTarget,
          finallySize: finallyWi !== undefined ? finallyStream.bytePos : undefined,
        },
      );

      for (const [offset, target] of tryWi.jumps) {
        jumps.set(stream.bytePos + offset, target);
      }
      for (const [label, offset] of tryWi.blocks) {
        blocks.set(label, stream.bytePos + offset);
      }
      stream.write(tryStream);

      if (catchWi !== undefined) {
        for (const [offset, target] of catchWi.jumps) {
          jumps.set(stream.bytePos + offset, target);
        }
        for (const [label, offset] of catchWi.blocks) {
          blocks.set(label, stream.bytePos + offset);
        }
        stream.write(catchStream);
      }

      if (finallyWi !== undefined) {
        for (const [offset, target] of finallyWi.jumps) {
          jumps.set(stream.bytePos + offset, target);
        }
        for (const [label, offset] of finallyWi.blocks) {
          blocks.set(label, stream.bytePos + offset);
        }
        stream.write(finallyStream);
      }
      break;
    }
    case CfgBlockType.WaitForFrame:
      emitAction(stream, {action: ActionType.WaitForFrame, frame: block.frame, skipCount: 1});
      jumps.set(emitJumpAction(stream), block.ifLoaded);
      jumps.set(emitJumpAction(stream), block.ifNotLoaded);
      break;
    case CfgBlockType.WaitForFrame2:
      emitAction(stream, {action: ActionType.WaitForFrame2, skipCount: 1});
      jumps.set(emitJumpAction(stream), block.ifLoaded);
      jumps.set(emitJumpAction(stream), block.ifNotLoaded);
      break;
    case CfgBlockType.With: {
      const withStream: WritableByteStream = new WritableStream();
      const withWi: WriteInfo = emitSoftCfg(withStream, block.with, fallthroughNext);
      emitAction(stream, {action: ActionType.With, withSize: withStream.bytePos});
      for (const [offset, target] of withWi.jumps) {
        jumps.set(stream.bytePos + offset, target);
      }
      for (const [label, offset] of withWi.blocks) {
        blocks.set(label, stream.bytePos + offset);
      }
      stream.write(withStream);
      break;
    }
    default:
      throw new Error("UnexpectedCfgBlockType");
  }
  return {jumps, blocks};
}

function emitDefineFunctionAction(byteStream: WritableByteStream, action: CfgDefineFunction): void {
  const body: Uint8Array = emitHardCfg(action.body, false);
  emitAction(byteStream, {...action, bodySize: body.length});
  byteStream.writeBytes(body);
}

function emitDefineFunction2Action(byteStream: WritableByteStream, action: CfgDefineFunction2): void {
  const body: Uint8Array = emitHardCfg(action.body, false);
  emitAction(byteStream, {...action, bodySize: body.length});
  byteStream.writeBytes(body);
}

function emitEndAction(byteStream: WritableByteStream): void {
  byteStream.writeUint8(0x00);
}

function emitIfAction(byteStream: WritableByteStream): UintSize {
  emitAction(byteStream, {action: ActionType.If, offset: 0});
  return byteStream.bytePos - JUMP_OFFSET_SIZE;
}

function emitJumpAction(byteStream: WritableByteStream): UintSize {
  emitAction(byteStream, {action: ActionType.Jump, offset: 0});
  return byteStream.bytePos - JUMP_OFFSET_SIZE;
}
