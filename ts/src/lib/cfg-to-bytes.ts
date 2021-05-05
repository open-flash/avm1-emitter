// tslint:disable:restrict-plus-operands

import * as stream from "@open-flash/stream";
import { WritableByteStream } from "@open-flash/stream";
import { ActionType } from "avm1-types/lib/action-type.js";
import { DefineFunction as CfgDefineFunction } from "avm1-types/lib/cfg/actions/define-function.js";
import { DefineFunction2 as CfgDefineFunction2 } from "avm1-types/lib/cfg/actions/define-function2.js";
import { CfgBlock } from "avm1-types/lib/cfg/cfg-block.js";
import { CfgFlowType } from "avm1-types/lib/cfg/cfg-flow-type.js";
import { CfgFlow } from "avm1-types/lib/cfg/cfg-flow.js";
import { CfgLabel, NullableCfgLabel } from "avm1-types/lib/cfg/cfg-label.js";
import { Cfg } from "avm1-types/lib/cfg/cfg.js";
import { Try as RawTry } from "avm1-types/lib/raw/actions/try.js";
import { CatchBlock as RawCatchBlock } from "avm1-types/lib/raw/catch-block.js";
import { UintSize } from "semantic-types";

import { emitAction } from "./emitters/avm1.js";

/**
 * Size of the offset in `If` and `Jump` actions (in bytes).
 */
const JUMP_OFFSET_SIZE: UintSize = 2;

export function cfgToBytes(cfg: Cfg): Uint8Array {
  return emitHardCfg(cfg, true);
}

function emitHardCfg(cfg: Cfg, appendEndAction: boolean): Uint8Array {
  const s: WritableByteStream = new stream.WritableStream();
  const wi: WriteInfo = emitSoftCfg(s, cfg, null);
  const endOffset: UintSize = s.bytePos;

  if (appendEndAction) {
    emitEndAction(s);
  }

  const bytes: Uint8Array = s.getBytes();

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

  const blockList: ReadonlyArray<CfgBlock> = cfg.blocks;

  for (let i: UintSize = 0; i < blockList.length; i++) {
    const block: CfgBlock = blockList[i];
    const curNext: NullableCfgLabel = i < blockList.length - 1 ? blockList[i + 1].label : fallthroughNext;

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
  outStream: WritableByteStream,
  block: CfgBlock,
  fallthroughNext: NullableCfgLabel,
): WriteInfo {
  const jumps: Map<UintSize, NullableCfgLabel> = new Map();
  const blocks: Map<CfgLabel, UintSize> = new Map();

  blocks.set(block.label, outStream.bytePos);

  for (const action of block.actions) {
    switch (action.action) {
      case ActionType.DefineFunction:
        emitDefineFunctionAction(outStream, action);
        break;
      case ActionType.DefineFunction2:
        emitDefineFunction2Action(outStream, action);
        break;
      default:
        emitAction(outStream, action);
        break;
    }
  }
  const flow: CfgFlow = block.flow;
  switch (flow.type) {
    case CfgFlowType.Error:
      emitError(outStream);
      break;
    case CfgFlowType.If:
      jumps.set(emitIfAction(outStream), flow.trueTarget);
      if (fallthroughNext !== flow.falseTarget) {
        if (flow.falseTarget === null) {
          emitEndAction(outStream);
        } else {
          jumps.set(emitJumpAction(outStream), flow.falseTarget);
        }
      }
      break;
    case CfgFlowType.Simple:
      if (fallthroughNext !== flow.next) {
        if (flow.next === null) {
          emitEndAction(outStream);
        } else {
          jumps.set(emitJumpAction(outStream), flow.next);
        }
      }
      break;
    case CfgFlowType.Return:
      emitAction(outStream, {action: ActionType.Return});
      break;
    case CfgFlowType.Throw:
      emitAction(outStream, {action: ActionType.Throw});
      break;
    case CfgFlowType.Try: {
      const finallyNext: NullableCfgLabel = fallthroughNext;
      const catchNext: NullableCfgLabel = flow.finally !== undefined
        ? flow.finally.blocks[0].label
        : finallyNext;
      const tryNext: NullableCfgLabel = flow.catch !== undefined
        ? flow.catch.body.blocks[0].label
        : catchNext;

      const tryStream: WritableByteStream = new stream.WritableStream();
      const tryWi: WriteInfo = emitSoftCfg(tryStream, flow.try, tryNext);

      const catchStream: WritableByteStream = new stream.WritableStream();
      let rawCatch: {block: RawCatchBlock; info: WriteInfo} | undefined;
      if (flow.catch !== undefined) {
        const info: WriteInfo = emitSoftCfg(catchStream, flow.catch.body, catchNext);
        const block: RawCatchBlock = {
          target: flow.catch.target,
          size: catchStream.bytePos,
        };
        rawCatch = {block, info};
      }

      const finallyStream: WritableByteStream = new stream.WritableStream();
      let finallyWi: WriteInfo | undefined;
      if (flow.finally !== undefined) {
        finallyWi = emitSoftCfg(finallyStream, flow.finally, finallyNext);
      }

      const rawTry: RawTry = {
        action: ActionType.Try,
        try: tryStream.bytePos,
        catch: rawCatch !== undefined ? rawCatch.block : undefined,
        finally: finallyWi !== undefined ? finallyStream.bytePos : undefined,
      };

      emitAction(outStream, rawTry);

      for (const [offset, target] of tryWi.jumps) {
        jumps.set(outStream.bytePos + offset, target);
      }
      for (const [label, offset] of tryWi.blocks) {
        blocks.set(label, outStream.bytePos + offset);
      }
      outStream.write(tryStream);

      if (rawCatch !== undefined) {
        for (const [offset, target] of rawCatch.info.jumps) {
          jumps.set(outStream.bytePos + offset, target);
        }
        for (const [label, offset] of rawCatch.info.blocks) {
          blocks.set(label, outStream.bytePos + offset);
        }
        outStream.write(catchStream);
      }

      if (finallyWi !== undefined) {
        for (const [offset, target] of finallyWi.jumps) {
          jumps.set(outStream.bytePos + offset, target);
        }
        for (const [label, offset] of finallyWi.blocks) {
          blocks.set(label, outStream.bytePos + offset);
        }
        outStream.write(finallyStream);
      }
      break;
    }
    case CfgFlowType.WaitForFrame:
      emitAction(outStream, {action: ActionType.WaitForFrame, frame: flow.frame, skip: 1});
      jumps.set(emitJumpAction(outStream), flow.readyTarget);
      jumps.set(emitJumpAction(outStream), flow.loadingTarget);
      break;
    case CfgFlowType.WaitForFrame2:
      emitAction(outStream, {action: ActionType.WaitForFrame2, skip: 1});
      jumps.set(emitJumpAction(outStream), flow.readyTarget);
      jumps.set(emitJumpAction(outStream), flow.loadingTarget);
      break;
    case CfgFlowType.With: {
      const withStream: WritableByteStream = new stream.WritableStream();
      const withWi: WriteInfo = emitSoftCfg(withStream, flow.body, fallthroughNext);
      emitAction(outStream, {action: ActionType.With, size: withStream.bytePos});
      for (const [offset, target] of withWi.jumps) {
        jumps.set(outStream.bytePos + offset, target);
      }
      for (const [label, offset] of withWi.blocks) {
        blocks.set(label, outStream.bytePos + offset);
      }
      outStream.write(withStream);
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

function emitDefineFunction2Action(
  byteStream: WritableByteStream,
  action: CfgDefineFunction2,
): void {
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

function emitError(byteStream: WritableByteStream): void {
  byteStream.writeUint8(0x96); // push code
  byteStream.writeUint16LE(0x0001); // data length (1)
  byteStream.writeUint8(0xff); // invalid push value type code (0xff)
}
