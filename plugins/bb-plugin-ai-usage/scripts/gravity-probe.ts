// Prints the Antigravity model list, quota buckets and quota summary this machine's sign-in returns,
// with secrets removed, so the quota parsing can be checked against the live shape. Needs an
// Antigravity or Gemini CLI sign-in on this machine; without one it exits with a message.
import { gravityBucketProbe, gravityQuotaProbe, gravityReason, gravitySummaryProbe } from "../src/local-providers";

const models = gravityBucketProbe();
const quota = gravityQuotaProbe();
const summary = gravitySummaryProbe();
if (models === null && quota === null && summary === null) {
  console.error(
    "No Antigravity access token on this machine, so there is nothing to probe. Sign in to Antigravity (or the Gemini CLI) here, " +
      "and check the OAuth client config (AI_USAGE_ANTIGRAVITY_CLIENT_ID and AI_USAGE_ANTIGRAVITY_CLIENT_SECRET, or antigravity-oauth.json)." +
      (gravityReason() === null ? "" : ` Reason: ${gravityReason()}.`),
  );
  process.exit(1);
}
console.log(JSON.stringify({ reason: gravityReason(), models, quota, summary }, null, 2));
