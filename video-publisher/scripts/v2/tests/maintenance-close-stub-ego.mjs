import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

let script = "";
for await (const chunk of process.stdin) script += chunk;
if (/page\.goto|newPage\s*\(|claimTaskSpace|\/publish\/publish/.test(script)) {
  console.error("close script contains a forbidden call");
  process.exit(2);
}
if ((script.match(/await taskSpace\s*\(/g) || []).length !== 1) {
  console.error("close script must call taskSpace once");
  process.exit(2);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-close-stub-"));
const program = path.join(dir, "run.mjs");
fs.writeFileSync(program, `
globalThis.profiles = async () => JSON.parse(process.env.STUB_PROFILES);
let listCount = 0;
const calls = [];
globalThis.listTaskSpaces = async () => {
  listCount += 1;
  calls.push(["list"]);
  return JSON.parse(listCount === 1 ? process.env.STUB_SPACES : process.env.STUB_SPACES_AFTER);
};
globalThis.taskSpace = async (id, options) => {
  calls.push(["taskSpace", id, options === undefined]);
  if (process.env.STUB_TASK === "throw") throw new Error(process.env.STUB_TASK_ERROR || "boom");
  const handle = JSON.parse(process.env.STUB_HANDLE);
  return {
    spaceId: handle.spaceId,
    name: handle.name,
    ownership: handle.ownership,
    async finish(arg) {
      calls.push(["finish", JSON.stringify(arg)]);
      if (process.env.STUB_FINISH === "throw") throw new Error("finish failed");
      if (process.env.STUB_FINISH === "drop") process.exit(0);
    },
  };
};
${script}
const fsMod = await import("node:fs");
fsMod.writeFileSync(process.env.STUB_CALLS, JSON.stringify(calls));
`);
const child = spawn(process.execPath, [program], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
child.on("close", code => process.exit(code ?? 1));
