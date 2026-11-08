import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

let script = "";
for await (const chunk of process.stdin) script += chunk;
const statusOnly = script.includes("VIDEO_PUBLISHER_MAINTENANCE_STATUS:");
const mutates = /await taskSpace\s*\(|handle\.finish\s*\(|page\.goto|uploadFile|releaseForConfirmedPublish|\/publish\/publish/.test(script);
if (statusOnly && mutates) {
  console.error("status script contains a mutation");
  process.exit(2);
}
if (!statusOnly && !script.includes("await taskSpace(")) {
  console.error("diagnose script did not contain taskSpace");
  process.exit(2);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-stub-ego-"));
const program = path.join(dir, "run.mjs");
const prelude = statusOnly ? "" : `
const calls = [];
let currentText = "";
var document = { body: { innerText: "" } };
const page = {
  async goto(url) {
    calls.push(["goto", String(url)]);
    if (String(url).includes("/publish/")) throw new Error("publish url refused");
    currentText = String(url).endsWith("/new/home") ? process.env.HOME_TEXT : process.env.NOTES_TEXT;
  },
  async waitForTimeout() {},
  async evaluate(fn) {
    document.body.innerText = currentText;
    return fn();
  },
  async screenshot(options) {
    calls.push(["screenshot", options && options.path]);
    if (options && options.path) {
      const fsMod = await import("node:fs");
      fsMod.mkdirSync(path.dirname(options.path), { recursive: true });
      fsMod.writeFileSync(options.path, "png");
    }
  },
};
globalThis.taskSpace = async (name, options) => {
  calls.push(["taskSpace", String(name), options && options.profileId]);
  return {
    name,
    spaceId: 321,
    ownership: "agent",
    async newPage() { calls.push(["newPage"]); return page; },
    async finish(arg) { calls.push(["finish", JSON.stringify(arg)]); },
  };
};
`;
const trailer = statusOnly ? "" : `
const fsMod = await import("node:fs");
fsMod.writeFileSync(process.env.STUB_CALLS, JSON.stringify(calls));
`;
fs.writeFileSync(program, `
globalThis.profiles = async () => JSON.parse(process.env.STUB_PROFILES);
globalThis.listTaskSpaces = async () => JSON.parse(process.env.STUB_SPACES);
${prelude}
${script}
${trailer}
`);
const child = spawn(process.execPath, [program], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
child.on("close", code => process.exit(code ?? 1));
