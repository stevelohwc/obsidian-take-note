// Copy the built plugin into each vault and make sure it is listed as enabled.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Usage: VAULTS="/path/to/Vault One:/path/to/Vault Two" npm run deploy
if (!process.env.VAULTS) {
  console.error('Set VAULTS to one or more vault folders separated by ":", e.g.\n  VAULTS="$HOME/Documents/My Vault" npm run deploy');
  process.exit(1);
}
const vaults = process.env.VAULTS.split(":").map((v) => path.resolve(v.replace(/^~/, os.homedir())));
const id = JSON.parse(fs.readFileSync("manifest.json", "utf8")).id;

for (const vault of vaults) {
  const cfg = path.join(vault, ".obsidian");
  if (!fs.existsSync(cfg)) {
    console.warn(`skip (not a vault): ${vault}`);
    continue;
  }
  const dest = path.join(cfg, "plugins", id);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(f, path.join(dest, f));
  const listFile = path.join(cfg, "community-plugins.json");
  const list = fs.existsSync(listFile) ? JSON.parse(fs.readFileSync(listFile, "utf8")) : [];
  if (!list.includes(id)) {
    list.push(id);
    fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
  }
  console.log(`installed -> ${dest}`);
}
