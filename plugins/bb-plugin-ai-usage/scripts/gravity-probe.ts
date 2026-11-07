// Prints the Antigravity model list and quota buckets this machine's sign-in returns, with secrets
// removed, so the quota parsing can be checked against the live shape. Needs an Antigravity or
// Gemini CLI sign-in on this machine; without one it exits with a message.
import { gravityBucketProbe, gravityQuotaProbe } from "../src/local-providers";

const models = gravityBucketProbe();
const quota = gravityQuotaProbe();
if (models === null && quota === null) {
  console.error(
    "No Antigravity access token on this machine, so there is nothing to probe. Sign in to Antigravity (or the Gemini CLI) here, " +
      "and check the OAuth client config (AI_USAGE_ANTIGRAVITY_CLIENT_ID and AI_USAGE_ANTIGRAVITY_CLIENT_SECRET, or antigravity-oauth.json).",
  );
  process.exit(1);
}
console.log(JSON.stringify({ models, quota }, null, 2));
