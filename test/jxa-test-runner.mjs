// Linux fallback for the updater's JXA test. Execute the actual extraction script
// with only Foundation file reading stubbed; macOS tests use real osascript.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const [, , flag, language, evaluate, script, ...args] = process.argv;
if (flag !== "-l" || language !== "JavaScript" || evaluate !== "-e") throw new Error("unexpected osascript call");
const result = runInNewContext(`${script}\nrun(args)`, {
  args,
  ObjC: { import() {}, unwrap: (value) => value },
  $: { NSString: { stringWithContentsOfFileEncodingError: (file) => readFileSync(file, "utf8") } },
});
if (result) process.stdout.write(`${result}\n`);
