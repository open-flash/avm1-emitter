import { cfgFromBytes } from "avm1-parser";
import { $Cfg, Cfg } from "avm1-tree/cfg";
import chai from "chai";
import fs from "fs";
import { JsonReader } from "kryo/readers/json";
import { JsonValueWriter } from "kryo/writers/json-value";
import sysPath from "path";
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
  "branches/try-catch-finally-ok",
  "branches/try-catch-ok",
  "samples/parse-data-string",
  "samples/try-statements",
  "try/try-catch-err",
  "try/try-catch-finally-err",
  "try/try-catch-finally-ok",
  "try/try-catch-ok",
]);
// `WHITELIST` can be used to only enable a few tests.
const WHITELIST: ReadonlySet<string> = new Set([
  // "hello-world",
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
      } else if (WHITELIST.size > 0 && !WHITELIST.has(testName)) {
        continue;
      }

      const cfgPath: string = sysPath.join(testPath, "cfg.json");

      yield {root: testPath, name, cfgPath};
    }
  }
}

function cfgEquivalent(left: Cfg, right: Cfg) {
  // TODO: Check structural equivalence of the CFGs (e.g. ignore different label names if they have the same positions)
  return $Cfg.equals(left, right);
}
