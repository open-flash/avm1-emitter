import * as stream from "@open-flash/stream";
import { WritableByteStream as ByteStream } from "@open-flash/stream";
import { ActionType } from "avm1-types/lib/action-type.js";
import { CatchTarget } from "avm1-types/lib/catch-target.js";
import { CatchTargetType } from "avm1-types/lib/catch-targets/_type.js";
import { GetUrl2Method } from "avm1-types/lib/get-url2-method.js";
import { PushValueType } from "avm1-types/lib/push-value-type.js";
import { PushValue } from "avm1-types/lib/push-value.js";
import { Action as RawAction } from "avm1-types/lib/raw/action.js";
import * as actions from "avm1-types/lib/raw/actions/index.js";
import incident from "incident";
import { Uint16, Uint2, Uint8, UintSize } from "semantic-types";

export interface ActionHeader {
  actionCode: Uint8;
  length: Uint16;
}

export function emitActionHeader(byteStream: ByteStream, value: ActionHeader): void {
  byteStream.writeUint8(value.actionCode);
  if (value.length > 0) {
    byteStream.writeUint16LE(value.length);
  }
}

// tslint:disable-next-line:cyclomatic-complexity
export function emitAction(byteStream: ByteStream, value: RawAction): void {
  if (value.action === ActionType.Error) {
    throw new Error("NotImplemented");
  } else if (value.action === ActionType.Raw) {
    throw new Error("NotImplemented");
  }

  type ActionEmitter = number | [(byteStream: ByteStream, value: RawAction) => void | UintSize, number];

  const ACTION_TYPE_TO_EMITTER: Map<ActionType, ActionEmitter> = new Map<ActionType, ActionEmitter>(<any[]> [
    [ActionType.Add, 0x0a],
    [ActionType.Add2, 0x47],
    [ActionType.And, 0x10],
    [ActionType.AsciiToChar, 0x33],
    [ActionType.BitAnd, 0x60],
    [ActionType.BitLShift, 0x63],
    [ActionType.BitOr, 0x61],
    [ActionType.BitRShift, 0x64],
    [ActionType.BitURShift, 0x65],
    [ActionType.BitXor, 0x62],
    [ActionType.Call, 0x9e],
    [ActionType.CallFunction, 0x3d],
    [ActionType.CallMethod, 0x52],
    [ActionType.CastOp, 0x2b],
    [ActionType.CharToAscii, 0x32],
    [ActionType.CloneSprite, 0x24],
    [ActionType.ConstantPool, [emitConstantPoolAction, 0x88]],
    [ActionType.Decrement, 0x51],
    [ActionType.DefineFunction, [emitDefineFunctionAction, 0x9b]],
    [ActionType.DefineFunction2, [emitDefineFunction2Action, 0x8e]],
    [ActionType.DefineLocal, 0x3c],
    [ActionType.DefineLocal2, 0x41],
    [ActionType.Delete, 0x3a],
    [ActionType.Delete2, 0x3b],
    [ActionType.Divide, 0x0d],
    [ActionType.End, 0x00],
    [ActionType.EndDrag, 0x28],
    [ActionType.Enumerate, 0x46],
    [ActionType.Enumerate2, 0x55],
    [ActionType.Equals, 0x0e],
    [ActionType.Equals2, 0x49],
    [ActionType.Extends, 0x69],
    [ActionType.FsCommand2, 0x2d],
    [ActionType.GetMember, 0x4e],
    [ActionType.GetProperty, 0x22],
    [ActionType.GetTime, 0x34],
    [ActionType.GetUrl, [emitGetUrlAction, 0x83]],
    [ActionType.GetUrl2, [emitGetUrl2Action, 0x9a]],
    [ActionType.GetVariable, 0x1c],
    [ActionType.GotoFrame, [emitGotoFrameAction, 0x81]],
    [ActionType.GotoFrame2, [emitGotoFrame2Action, 0x9f]],
    [ActionType.GotoLabel, [emitGotoLabelAction, 0x8c]],
    [ActionType.Greater, 0x67],
    [ActionType.If, [emitIfAction, 0x9d]],
    [ActionType.ImplementsOp, 0x2c],
    [ActionType.Increment, 0x50],
    [ActionType.InitArray, 0x42],
    [ActionType.InitObject, 0x43],
    [ActionType.InstanceOf, 0x54],
    [ActionType.Jump, [emitJumpAction, 0x99]],
    [ActionType.Less, 0x0f],
    [ActionType.Less2, 0x48],
    [ActionType.MbAsciiToChar, 0x37],
    [ActionType.MbCharToAscii, 0x36],
    [ActionType.MbStringExtract, 0x35],
    [ActionType.MbStringLength, 0x31],
    [ActionType.Modulo, 0x3f],
    [ActionType.Multiply, 0x0c],
    [ActionType.NewMethod, 0x53],
    [ActionType.NewObject, 0x40],
    [ActionType.NextFrame, 0x04],
    [ActionType.Not, 0x12],
    [ActionType.Or, 0x11],
    [ActionType.Play, 0x06],
    [ActionType.Pop, 0x17],
    [ActionType.PreviousFrame, 0x05],
    [ActionType.Push, [emitPushAction, 0x96]],
    [ActionType.PushDuplicate, 0x4c],
    [ActionType.RandomNumber, 0x30],
    [ActionType.Raw, ],
    [ActionType.Return, 0x3e],
    [ActionType.RemoveSprite, 0x25],
    [ActionType.SetMember, 0x4f],
    [ActionType.SetProperty, 0x23],
    [ActionType.SetTarget, [emitSetTargetAction, 0x8b]],
    [ActionType.SetTarget2, 0x20],
    [ActionType.SetVariable, 0x1d],
    [ActionType.StackSwap, 0x4d],
    [ActionType.StartDrag, 0x27],
    [ActionType.Stop, 0x07],
    [ActionType.StopSounds, 0x09],
    [ActionType.StoreRegister, [emitStoreRegisterAction, 0x87]],
    [ActionType.StrictEquals, 0x66],
    [ActionType.StrictMode, [emitStrictModeAction, 0x89]],
    [ActionType.StringAdd, 0x21],
    [ActionType.StringEquals, 0x13],
    [ActionType.StringExtract, 0x15],
    [ActionType.StringGreater, 0x68],
    [ActionType.StringLength, 0x14],
    [ActionType.StringLess, 0x29],
    [ActionType.Subtract, 0x0b],
    [ActionType.TargetPath, 0x45],
    [ActionType.Throw, 0x2a],
    [ActionType.ToInteger, 0x18],
    [ActionType.ToNumber, 0x4a],
    [ActionType.ToString, 0x4b],
    [ActionType.ToggleQuality, 0x08],
    [ActionType.Trace, 0x26],
    [ActionType.Try, [emitTryAction, 0x8f]],
    [ActionType.TypeOf, 0x44],
    [ActionType.WaitForFrame, [emitWaitForFrameAction, 0x8a]],
    [ActionType.WaitForFrame2, [emitWaitForFrame2Action, 0x8d]],
    [ActionType.With, [emitWithAction, 0x94]],
  ]);

  const actionEmitter: ActionEmitter | undefined = ACTION_TYPE_TO_EMITTER.get(value.action);

  if (actionEmitter === undefined) {
    throw new incident.Incident("UnexpectedAction", {type: value.action, typeName: ActionType[value.action]});
  }

  if (typeof actionEmitter === "number") {
    emitActionHeader(byteStream, {actionCode: actionEmitter, length: 0});
    return;
  }

  const actionStream: stream.WritableStream = new stream.WritableStream();
  actionEmitter[0](actionStream, value);
  emitActionHeader(
    byteStream,
    {
      actionCode: actionEmitter[1],
      length: actionStream.bytePos,
    },
  );
  byteStream.write(actionStream);
}

export function emitConstantPoolAction(byteStream: ByteStream, value: actions.ConstantPool): void {
  byteStream.writeUint16LE(value.pool.length);
  for (const constant of value.pool) {
    byteStream.writeNulUtf8(constant);
  }
}

/**
 * Emits a DefineFunction action.
 *
 * @param byteStream The bytestream used to emit the action.
 * @param value DefineFunction action to emit.
 * @returns The length for the action header (excluding the function body).
 */
export function emitDefineFunctionAction(byteStream: ByteStream, value: actions.DefineFunction): void {
  byteStream.writeNulUtf8(value.name);
  byteStream.writeUint16LE(value.parameters.length);
  for (const parameter of value.parameters) {
    byteStream.writeNulUtf8(parameter);
  }

  byteStream.writeUint16LE(value.bodySize);
}

/**
 * Emits a DefineFunction2 action.
 *
 * @param byteStream The bytestream used to emit the action.
 * @param value DefineFunction2 action to emit.
 */
export function emitDefineFunction2Action(byteStream: ByteStream, value: actions.DefineFunction2): void {
  byteStream.writeNulUtf8(value.name);
  byteStream.writeUint16LE(value.parameters.length);
  byteStream.writeUint8(value.registerCount);

  const flags: Uint16 = 0
    | (value.preloadThis ? 1 << 0 : 0)
    | (value.suppressThis ? 1 << 1 : 0)
    | (value.preloadArguments ? 1 << 2 : 0)
    | (value.suppressArguments ? 1 << 3 : 0)
    | (value.preloadSuper ? 1 << 4 : 0)
    | (value.suppressSuper ? 1 << 5 : 0)
    | (value.preloadRoot ? 1 << 6 : 0)
    | (value.preloadParent ? 1 << 7 : 0)
    | (value.preloadGlobal ? 1 << 8 : 0);
  byteStream.writeUint16LE(flags);

  for (const parameter of value.parameters) {
    byteStream.writeUint8(parameter.register);
    byteStream.writeNulUtf8(parameter.name);
  }

  byteStream.writeUint16LE(value.bodySize);
}

export function emitGetUrlAction(byteStream: ByteStream, value: actions.GetUrl): void {
  byteStream.writeNulUtf8(value.url);
  byteStream.writeNulUtf8(value.target);
}

export function emitGetUrl2Action(byteStream: ByteStream, value: actions.GetUrl2): void {
  const METHOD_TO_CODE: Map<GetUrl2Method, Uint2> = new Map([
    [GetUrl2Method.None, 0 as Uint2],
    [GetUrl2Method.Get, 1 as Uint2],
    [GetUrl2Method.Post, 2 as Uint2],
  ]);
  const methodCode: Uint2 | undefined = METHOD_TO_CODE.get(value.method);
  if (methodCode === undefined) {
    throw new incident.Incident("UnexpectedGetUrl2Method");
  }

  const flags: Uint8 = 0
    | (value.loadVariables ? 1 << 0 : 0)
    | (value.loadTarget ? 1 << 1 : 0)
    | (methodCode << 6);

  byteStream.writeUint8(flags);
}

export function emitGotoFrameAction(byteStream: ByteStream, value: actions.GotoFrame): void {
  byteStream.writeUint16LE(value.frame);
}

export function emitGotoFrame2Action(byteStream: ByteStream, value: actions.GotoFrame2): void {
  const hasSceneBias: boolean = value.sceneBias !== 0;
  const flags: Uint8 = 0
    | (value.play ? 1 << 0 : 0)
    | (hasSceneBias ? 1 << 1 : 0);
  // Skip 6 bits
  byteStream.writeUint8(flags);
  if (hasSceneBias) {
    byteStream.writeUint16LE(value.sceneBias);
  }
}

export function emitGotoLabelAction(byteStream: ByteStream, value: actions.GotoLabel): void {
  byteStream.writeNulUtf8(value.label);
}

export function emitIfAction(byteStream: ByteStream, value: actions.If): void {
  byteStream.writeSint16LE(value.offset);
}

export function emitJumpAction(byteStream: ByteStream, value: actions.Jump): void {
  byteStream.writeSint16LE(value.offset);
}

export function emitPushAction(byteStream: ByteStream, value: actions.Push): void {
  for (const pushed of value.values) {
    emitActionValue(byteStream, pushed);
  }
}

export function emitActionValue(byteStream: ByteStream, value: PushValue): void {
  switch (value.type) {
    case PushValueType.Boolean:
      byteStream.writeUint8(5);
      byteStream.writeUint8(value.value ? 1 : 0);
      break;
    case PushValueType.Constant:
      if (value.value > 0xff) {
        byteStream.writeUint8(9);
        byteStream.writeUint16LE(value.value);
      } else {
        byteStream.writeUint8(8);
        byteStream.writeUint8(value.value as Uint8);
      }
      break;
    case PushValueType.String:
      byteStream.writeUint8(0);
      byteStream.writeNulUtf8(value.value);
      break;
    case PushValueType.Sint32:
      byteStream.writeUint8(7);
      byteStream.writeSint32LE(value.value);
      break;
    case PushValueType.Float32:
      byteStream.writeUint8(1);
      byteStream.writeFloat32LE(value.value);
      break;
    case PushValueType.Float64:
      byteStream.writeUint8(6);
      byteStream.writeFloat64LE32(value.value);
      break;
    case PushValueType.Null:
      byteStream.writeUint8(2);
      break;
    case PushValueType.Register:
      byteStream.writeUint8(4);
      byteStream.writeUint8(value.value);
      break;
    case PushValueType.Undefined:
      byteStream.writeUint8(3);
      break;
    default:
      throw new incident.Incident("UnexpectedValueType");
  }
}

export function emitSetTargetAction(byteStream: ByteStream, value: actions.SetTarget): void {
  byteStream.writeNulUtf8(value.targetName);
}

export function emitStoreRegisterAction(byteStream: ByteStream, value: actions.StoreRegister): void {
  byteStream.writeUint8(value.register);
}

export function emitStrictModeAction(byteStream: ByteStream, value: actions.StrictMode): void {
  byteStream.writeUint8(value.isStrict ? 1 : 0);
}

export function emitTryAction(byteStream: ByteStream, value: actions.Try): void {
  const catchInRegister: boolean = value.catch !== undefined
    && value.catch.target.type === CatchTargetType.Register;

  const flags: Uint8 = 0
    | (value.catch !== undefined ? 1 << 0 : 0)
    | (value.finally !== undefined ? 1 << 1 : 0)
    | (catchInRegister ? 1 << 2 : 0);
  // (Skip 5 bits)
  byteStream.writeUint8(flags);

  byteStream.writeUint16LE(value.try);
  byteStream.writeUint16LE(value.catch !== undefined ? value.catch.size : 0);
  byteStream.writeUint16LE(value.finally !== undefined ? value.finally : 0);
  emitCatchTarget(
    byteStream,
    value.catch !== undefined ? value.catch.target : {type: CatchTargetType.Register, target: 0},
  );
}

function emitCatchTarget(byteStream: ByteStream, value: CatchTarget): void {
  if (value.type === CatchTargetType.Register) {
    byteStream.writeUint8(value.target);
  } else {
    byteStream.writeNulUtf8(value.target);
  }
}

export function emitWaitForFrameAction(byteStream: ByteStream, value: actions.WaitForFrame): void {
  byteStream.writeUint16LE(value.frame);
  byteStream.writeUint8(value.skip);
}

export function emitWaitForFrame2Action(byteStream: ByteStream, value: actions.WaitForFrame2): void {
  byteStream.writeUint8(value.skip);
}

/**
 * Emits a With action.
 *
 * @param byteStream The bytestream used to emit the action.
 * @param value With action to emit.
 * @returns The length for the action header (excluding the with body).
 */
export function emitWithAction(byteStream: ByteStream, value: actions.With): void {
  byteStream.writeUint16LE(value.size);
}
