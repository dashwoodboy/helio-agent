// Sign the CLI bundle for self-update: writes <file>.sha256 (shasum format)
// and <file>.sig (base64 ed25519 signature over the file bytes).
//
//   AGENT_SIGNING_KEY="$(cat scripts/agent-signing-key.private.pem)" \
//     node scripts/sign-cli.mjs agent/release/helio-agent-cli.cjs
//
// The matching public key is embedded in agent/src/cli/selfUpdate.ts. To
// rotate: generate a new ed25519 keypair, replace the embedded public key,
// update the AGENT_SIGNING_KEY repository secret, release a new version
// (old agents still verify it with... the OLD key — so rotation needs one
// release signed with both; avoid rotating unless the key leaked).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/sign-cli.mjs <path/to/helio-agent-cli.cjs>");
  process.exit(1);
}
const keyPem = process.env.AGENT_SIGNING_KEY;
if (!keyPem) {
  console.error("AGENT_SIGNING_KEY is not set (the ed25519 private key PEM)");
  process.exit(1);
}

const bundle = fs.readFileSync(file);
const sha256 = crypto.createHash("sha256").update(bundle).digest("hex");
const signature = crypto
  .sign(null, bundle, crypto.createPrivateKey(keyPem))
  .toString("base64");

fs.writeFileSync(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`);
fs.writeFileSync(`${file}.sig`, signature + "\n");
console.log(`signed ${file}`);
console.log(`  sha256: ${sha256}`);
