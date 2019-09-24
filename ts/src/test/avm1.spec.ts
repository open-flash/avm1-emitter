import { toAasm } from "avm1-asm/to-aasm";
import { cfgFromBytes } from "avm1-parser";
import { ActionType } from "avm1-tree/action-type";
import { $CatchTarget } from "avm1-tree/catch-target";
import { $Cfg, Cfg } from "avm1-tree/cfg";
import { $CfgAction, CfgAction } from "avm1-tree/cfg-action";
import { CfgBlock } from "avm1-tree/cfg-block";
import { CfgBlockType } from "avm1-tree/cfg-block-type";
import { CfgLabel, NullableCfgLabel } from "avm1-tree/cfg-label";
import { $Parameter, Parameter } from "avm1-tree/parameter";
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
  "avm1-bytes/corrupted-push",  // Requires error support
  "avm1-bytes/misaligned-jump",  // Requires normalization
  "samples/delta-of-dir", // Requires normalization
  "samples/parse-data-string", // Requires normalization
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

      const actualCfg: Cfg = cfgFromBytes(actualAvm1);
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
  if (left.blocks.length !== right.blocks.length) {
    return false;
  }
  for (let bi: UintSize = 0; bi < left.blocks.length; bi++) {
    const leftBlock: CfgBlock = left.blocks[bi];
    const rightBlock: CfgBlock = right.blocks[bi];
    if (leftBlock.type !== rightBlock.type) {
      return false;
    }
    if (!lblEq(leftBlock.label, rightBlock.label)) {
      return false;
    }
    if (leftBlock.actions.length !== rightBlock.actions.length) {
      return false;
    }
    for (let ai: UintSize = 0; ai < leftBlock.actions.length; ai++) {
      const leftAction: CfgAction = leftBlock.actions[ai];
      const rightAction: CfgAction = rightBlock.actions[ai];

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
          if (!$CfgAction.equals(leftAction, rightAction)) {
            return false;
          }
          break;
      }
    }

    switch (leftBlock.type) {
      case CfgBlockType.If:
        if (
          rightBlock.type !== CfgBlockType.If
          || !lblEq(leftBlock.ifTrue, rightBlock.ifTrue)
          || !lblEq(leftBlock.ifFalse, rightBlock.ifFalse)
        ) {
          return false;
        }
        break;
      case CfgBlockType.Simple:
        if (rightBlock.type !== CfgBlockType.Simple || !lblEq(leftBlock.next, rightBlock.next)) {
          return false;
        }
        break;
      case CfgBlockType.Try:
        if (rightBlock.type !== CfgBlockType.Try) {
          return false;
        }
        if (!softCfgEquivalent(leftBlock.try, rightBlock.try, lblEq)) {
          return false;
        }
        if (leftBlock.catch !== undefined || rightBlock.catch !== undefined) {
          if (leftBlock.catch === undefined || rightBlock.catch === undefined) {
            return false;
          }
          if (!$CatchTarget.equals(leftBlock.catchTarget, rightBlock.catchTarget)) {
            return false;
          }
          if (!softCfgEquivalent(leftBlock.catch, rightBlock.catch, lblEq)) {
            return false;
          }
        }
        if (leftBlock.finally !== undefined || rightBlock.finally !== undefined) {
          if (leftBlock.finally === undefined || rightBlock.finally === undefined) {
            return false;
          }
          if (!softCfgEquivalent(leftBlock.finally, rightBlock.finally, lblEq)) {
            return false;
          }
        }
        break;
      case CfgBlockType.With:
        if (rightBlock.type !== CfgBlockType.With) {
          return false;
        }
        if (!softCfgEquivalent(leftBlock.with, rightBlock.with, lblEq)) {
          return false;
        }
        break;
      default:
        if (leftBlock.type !== rightBlock.type) {
          return false;
        }
        break;
    }
  }
  return true;
}

function getHardCfgLabels(hardCfg: Cfg): CfgLabel[] {
  const result: CfgLabel[] = [];

  function visit(cfg: Cfg): void {
    for (const block of cfg.blocks) {
      result.push(block.label);
      switch (block.type) {
        case CfgBlockType.Try:
          visit(block.try);
          if (block.catch !== undefined) {
            visit(block.catch);
          }
          if (block.finally !== undefined) {
            visit(block.finally);
          }
          break;
        case CfgBlockType.With:
          visit(block.with);
          break;
        default:
          break;
      }
    }
  }

  visit(hardCfg);

  return result;
}
