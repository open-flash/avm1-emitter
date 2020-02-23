import { toAasm } from "avm1-asm/to-aasm";
import { parseCfg } from "avm1-parser";
import { ActionType } from "avm1-types/action-type";
import { $CatchTarget } from "avm1-types/catch-target";
import { $Action, Action } from "avm1-types/cfg/action";
import { $Cfg, Cfg } from "avm1-types/cfg/cfg";
import { CfgBlock } from "avm1-types/cfg/cfg-block";
import { CfgFlow } from "avm1-types/cfg/cfg-flow";
import { CfgFlowType } from "avm1-types/cfg/cfg-flow-type";
import { CfgLabel, NullableCfgLabel } from "avm1-types/cfg/cfg-label";
import { $Parameter, Parameter } from "avm1-types/parameter";
import chai from "chai";
import fs from "fs";
import { JsonReader } from "kryo/readers/json";
import { JsonValueWriter } from "kryo/writers/json-value";
import sysPath from "path";
import { UintSize } from "semantic-types";
import { cfgToBytes } from "../lib";
import meta from "./meta.js";
import { readTextFile, writeFile, writeTextFile } from "./utils";

const PROJECT_ROOT: string = sysPath.join(meta.dirname, "..", "..", "..");
const REPO_ROOT: string = sysPath.join(PROJECT_ROOT, "..");
const AVM1_SAMPLES_ROOT: string = sysPath.join(REPO_ROOT, "tests", "avm1");

const JSON_READER: JsonReader = new JsonReader();
const JSON_VALUE_WRITER: JsonValueWriter = new JsonValueWriter();
// `BLACKLIST` can be used to forcefully skip some tests.
const BLACKLIST: ReadonlySet<string> = new Set([
  "avm1-bytes/misaligned-jump",  // Requires normalization
  "samples/delta-of-dir", // Requires normalization
  "samples/parse-data-string", // Requires normalization
  "try/try-empty-catch-overlong-finally-err", // TODO: Check why it fails
  "try/try-nested-return", // TODO: Check why it fails
  "wait-for-frame/homestuck-beta2", // Requires normalization
  "wait-for-frame/ready-increments", // Requires normalization
  "wait-for-frame/ready-jump-increments", // Requires normalization
  "wait-for-frame/wff2-ready-increments", // Requires normalization
]);
// `WHITELIST` can be used to only enable a few tests.
const WHITELIST: ReadonlySet<string> = new Set([
  // "branches/switch-default",
]);

describe("avm1", function () {
  this.timeout(300000); // The timeout is this high due to CI being extremely slow

  for (const sample of getSamples()) {
    it(sample.name, async function () {
      const inputJson: string = await readTextFile(sample.cfgPath);
      const inputCfg: Cfg = $Cfg.read(JSON_READER, inputJson);

      const actualAvm1: Uint8Array = cfgToBytes(inputCfg);
      await writeFile(sysPath.join(sample.root, "local-main.ts.avm1"), actualAvm1);

      const actualCfg: Cfg = parseCfg(actualAvm1);
      const actualCfgJson: string = JSON.stringify($Cfg.write(JSON_VALUE_WRITER, actualCfg), null, 2);
      await writeTextFile(sysPath.join(sample.root, "local-cfg.ts.json"), `${actualCfgJson}\n`);

      try {
        const aasm1: string = toAasm(actualCfg);
        await writeTextFile(sysPath.join(sample.root, "local-main.ts.aasm1"), `${aasm1}\n`);
      } catch (e) {
        console.warn(e);
      }

      chai.assert.isTrue(hardCfgEquivalent(actualCfg, inputCfg), "expected round-tripped CFG to be equivalent");
    });
  }
});

interface Sample {
  root: string;
  name: string;
  cfgPath: string;
}

function* getSamples(): IterableIterator<Sample> {
  for (const dirEnt of fs.readdirSync(AVM1_SAMPLES_ROOT, {withFileTypes: true})) {
    if (!dirEnt.isDirectory() || dirEnt.name.startsWith(".")) {
      continue;
    }

    const groupName: string = dirEnt.name;
    const groupPath: string = sysPath.join(AVM1_SAMPLES_ROOT, groupName);

    for (const dirEnt of fs.readdirSync(groupPath, {withFileTypes: true})) {
      if (!dirEnt.isDirectory()) {
        continue;
      }
      const testName: string = dirEnt.name;
      const testPath: string = sysPath.join(groupPath, testName);

      const name: string = `${groupName}/${testName}`;

      if (BLACKLIST.has(name)) {
        continue;
      } else if (WHITELIST.size > 0 && !WHITELIST.has(name)) {
        continue;
      }

      const cfgPath: string = sysPath.join(testPath, "cfg.json");

      yield {root: testPath, name, cfgPath};
    }
  }
}

// Checks structural equivalence between the blocks.
// The main difference with `$Cfg.equals` is that it allows different labels if
// they still represent the same positions.
function hardCfgEquivalent(left: Cfg, right: Cfg): boolean {
  const leftLabels: CfgLabel[] = getHardCfgLabels(left);
  const rightLabels: CfgLabel[] = getHardCfgLabels(right);

  function labelEquivalent(leftLabel: NullableCfgLabel, rightLabel: NullableCfgLabel): boolean {
    if (leftLabel === null || rightLabel === null) {
      return leftLabel === rightLabel; // Check if both are `null`
    }
    return leftLabels.indexOf(leftLabel) === rightLabels.indexOf(rightLabel);
  }

  return softCfgEquivalent(left, right, labelEquivalent);
}

// tslint:disable-next-line:cyclomatic-complexity
function softCfgEquivalent(
  left: Cfg,
  right: Cfg,
  lblEq: (l: NullableCfgLabel, r: NullableCfgLabel) => boolean,
): boolean {
  const leftBlocks: ReadonlyArray<CfgBlock> = left.blocks;
  const rightBlocks: ReadonlyArray<CfgBlock> = right.blocks;
  if (leftBlocks.length !== rightBlocks.length) {
    return false;
  }
  for (let bi: UintSize = 0; bi < leftBlocks.length; bi++) {
    const leftBlock: CfgBlock = leftBlocks[bi];
    const rightBlock: CfgBlock = rightBlocks[bi];
    if (leftBlock.flow.type !== rightBlock.flow.type) {
      return false;
    }
    if (!lblEq(leftBlock.label, rightBlock.label)) {
      return false;
    }
    if (leftBlock.actions.length !== rightBlock.actions.length) {
      return false;
    }
    for (let ai: UintSize = 0; ai < leftBlock.actions.length; ai++) {
      const leftAction: Action = leftBlock.actions[ai];
      const rightAction: Action = rightBlock.actions[ai];

      switch (leftAction.action) {
        case ActionType.DefineFunction:
          if (rightAction.action !== ActionType.DefineFunction) {
            return false;
          }
          if (
            leftAction.name !== rightAction.name
            || leftAction.parameters.length !== rightAction.parameters.length
          ) {
            return false;
          }
          for (let p: UintSize = 0; p < leftAction.parameters.length; p++) {
            const leftParam: string = leftAction.parameters[p];
            const rightParam: string = rightAction.parameters[p];
            if (leftParam !== rightParam) {
              return false;
            }
          }
          if (!hardCfgEquivalent(leftAction.body, rightAction.body)) {
            return false;
          }
          break;
        case ActionType.DefineFunction2:
          if (rightAction.action !== ActionType.DefineFunction2) {
            return false;
          }
          if (
            leftAction.name !== rightAction.name
            || leftAction.preloadParent !== rightAction.preloadParent
            || leftAction.preloadRoot !== rightAction.preloadRoot
            || leftAction.suppressSuper !== rightAction.suppressSuper
            || leftAction.preloadSuper !== rightAction.preloadSuper
            || leftAction.suppressArguments !== rightAction.suppressArguments
            || leftAction.preloadArguments !== rightAction.preloadArguments
            || leftAction.suppressThis !== rightAction.suppressThis
            || leftAction.preloadThis !== rightAction.preloadThis
            || leftAction.preloadGlobal !== rightAction.preloadGlobal
            || leftAction.registerCount !== rightAction.registerCount
            || leftAction.parameters.length !== rightAction.parameters.length
          ) {
            return false;
          }
          for (let p: UintSize = 0; p < leftAction.parameters.length; p++) {
            const leftParam: Parameter = leftAction.parameters[p];
            const rightParam: Parameter = rightAction.parameters[p];
            if (!$Parameter.equals(leftParam, rightParam)) {
              return false;
            }
          }
          if (!hardCfgEquivalent(leftAction.body, rightAction.body)) {
            return false;
          }
          break;
        default:
          if (!$Action.equals(leftAction, rightAction)) {
            return false;
          }
          break;
      }
    }

    const leftFlow: CfgFlow = leftBlock.flow;
    const rightFlow: CfgFlow = rightBlock.flow;

    switch (leftFlow.type) {
      case CfgFlowType.Error:
        if (rightFlow.type !== CfgFlowType.Error) {
          return false;
        }
        break;
      case CfgFlowType.If:
        if (
          rightFlow.type !== CfgFlowType.If
          || !lblEq(leftFlow.trueTarget, rightFlow.trueTarget)
          || !lblEq(leftFlow.falseTarget, rightFlow.falseTarget)
        ) {
          return false;
        }
        break;
      case CfgFlowType.Return:
        if (rightFlow.type !== CfgFlowType.Return) {
          return false;
        }
        break;
      case CfgFlowType.Simple:
        if (rightFlow.type !== CfgFlowType.Simple || !lblEq(leftFlow.next, rightFlow.next)) {
          return false;
        }
        break;
      case CfgFlowType.Throw:
        if (rightFlow.type !== CfgFlowType.Throw) {
          return false;
        }
        break;
      case CfgFlowType.Try:
        if (rightFlow.type !== CfgFlowType.Try) {
          return false;
        }
        if (!softCfgEquivalent(leftFlow.try, rightFlow.try, lblEq)) {
          return false;
        }
        if (leftFlow.catch !== undefined || rightFlow.catch !== undefined) {
          if (leftFlow.catch === undefined || rightFlow.catch === undefined) {
            return false;
          }
          if (!$CatchTarget.equals(leftFlow.catch.target, rightFlow.catch.target)) {
            return false;
          }
          if (!softCfgEquivalent(leftFlow.catch.body, rightFlow.catch.body, lblEq)) {
            return false;
          }
        }
        if (leftFlow.finally !== undefined || rightFlow.finally !== undefined) {
          if (leftFlow.finally === undefined || rightFlow.finally === undefined) {
            return false;
          }
          if (!softCfgEquivalent(leftFlow.finally, rightFlow.finally, lblEq)) {
            return false;
          }
        }
        break;
      case CfgFlowType.WaitForFrame:
        if (
          rightFlow.type !== CfgFlowType.WaitForFrame
          || leftFlow.frame !== rightFlow.frame
          || !lblEq(leftFlow.readyTarget, rightFlow.readyTarget)
          || !lblEq(leftFlow.loadingTarget, rightFlow.loadingTarget)
        ) {
          return false;
        }
        break;
      case CfgFlowType.WaitForFrame2:
        if (
          rightFlow.type !== CfgFlowType.WaitForFrame2
          || !lblEq(leftFlow.readyTarget, rightFlow.readyTarget)
          || !lblEq(leftFlow.loadingTarget, rightFlow.loadingTarget)
        ) {
          return false;
        }
        break;
      case CfgFlowType.With:
        if (rightFlow.type !== CfgFlowType.With) {
          return false;
        }
        if (!softCfgEquivalent(leftFlow.body, rightFlow.body, lblEq)) {
          return false;
        }
        break;
      default:
        throw new Error("AssertionError: Unexpected flow type");
    }
  }
  return true;
}

function getHardCfgLabels(hardCfg: Cfg): CfgLabel[] {
  const result: CfgLabel[] = [];

  function visit(cfg: Cfg): void {
    for (const block of cfg.blocks) {
      result.push(block.label);
      const flow: CfgFlow = block.flow;
      switch (flow.type) {
        case CfgFlowType.Try:
          visit(flow.try);
          if (flow.catch !== undefined) {
            visit(flow.catch.body);
          }
          if (flow.finally !== undefined) {
            visit(flow.finally);
          }
          break;
        case CfgFlowType.With:
          visit(flow.body);
          break;
        default:
          break;
      }
    }
  }

  visit(hardCfg);

  return result;
}
