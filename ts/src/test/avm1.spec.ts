import { toAasm } from "avm1-asm/to-aasm";
import { cfgFromBytes } from "avm1-parser";
import { ActionType } from "avm1-tree/action-type";
import { $CatchTarget } from "avm1-tree/catch-target";
import { $Cfg, Cfg } from "avm1-tree/cfg";
import { $CfgAction, CfgAction } from "avm1-tree/cfg-action";
import { CfgIf } from "avm1-tree/cfg-actions/cfg-if";
import { CfgWith } from "avm1-tree/cfg-actions/cfg-with";
import { CfgBlock } from "avm1-tree/cfg-block";
import { CfgBlockType } from "avm1-tree/cfg-block-type";
import { CfgSimpleBlock } from "avm1-tree/cfg-blocks/cfg-simple-block";
import { CfgLabel } from "avm1-tree/cfg-label";
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
  "avm1-bytes/misaligned-jump",
  "haxe/hello-world",
  "samples/parse-data-string",
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

      chai.assert.isTrue(cfgEquivalent(actualCfg, inputCfg), "expected round-tripped CFG to be equivalent");
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
// tslint:disable-next-line:cyclomatic-complexity
function cfgEquivalent(left: Cfg, right: Cfg) {
  if (left.blocks.length !== right.blocks.length) {
    return false;
  }
  const leftLabelToIndex: Map<CfgLabel, UintSize> = new Map();
  for (const [i, block] of left.blocks.entries()) {
    leftLabelToIndex.set(block.label, i);
  }
  const rightLabelToIndex: Map<CfgLabel, UintSize> = new Map();
  for (const [i, block] of right.blocks.entries()) {
    rightLabelToIndex.set(block.label, i);
  }

  function labelEquivalent(leftLabel: CfgLabel, rightLabel: CfgLabel): boolean {
    const leftIndex: UintSize | undefined = leftLabelToIndex.get(leftLabel);
    const rightIndex: UintSize | undefined = rightLabelToIndex.get(rightLabel);
    return leftIndex === rightIndex;
  }

  for (let i: UintSize = 0; i < left.blocks.length; i++) {
    const leftBlock: CfgBlock = left.blocks[i];
    const rightBlock: CfgBlock = right.blocks[i];
    if (leftBlock.type !== rightBlock.type) {
      return false;
    }
    if (!labelEquivalent(leftBlock.label, rightBlock.label)) {
      return false;
    }
    if (leftBlock.type === CfgBlockType.Simple) {
      if (!labelEquivalent(leftBlock.next, (rightBlock as CfgSimpleBlock).next)) {
        return false;
      }
    }
    if (leftBlock.actions.length !== rightBlock.actions.length) {
      return false;
    }
    for (let a: UintSize = 0; a < leftBlock.actions.length; a++) {
      const leftAction: CfgAction = leftBlock.actions[a];
      const rightAction: CfgAction = rightBlock.actions[a];
      if (leftAction.action !== rightAction.action) {
        return false;
      }
      switch (leftAction.action) {
        case ActionType.If:
          if (!labelEquivalent(leftAction.target, (rightAction as CfgIf).target)) {
            return false;
          }
          break;
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
          if (!cfgEquivalent(leftAction.body, rightAction.body)) {
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
          if (!cfgEquivalent(leftAction.body, rightAction.body)) {
            return false;
          }
          break;
        case ActionType.Try:
          if (rightAction.action !== ActionType.Try) {
            return false;
          }
          if (!$CatchTarget.equals(leftAction.catchTarget, rightAction.catchTarget)) {
            return false;
          }
          if (!cfgEquivalent(leftAction.try, rightAction.try)) {
            return false;
          }
          if ((leftAction.catch === undefined) !== (rightAction.catch === undefined)) {
            return false;
          }
          if (leftAction.catch !== undefined) {
            if (!cfgEquivalent(leftAction.catch, rightAction.catch!)) {
              return false;
            }
          }
          if ((leftAction.finally === undefined) !== (rightAction.finally === undefined)) {
            return false;
          }
          if (leftAction.finally !== undefined) {
            if (!cfgEquivalent(leftAction.finally, rightAction.finally!)) {
              return false;
            }
          }
          break;
        case ActionType.With:
          if (!cfgEquivalent(leftAction.with, (rightAction as CfgWith).with)) {
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
  }
  return true;
}
