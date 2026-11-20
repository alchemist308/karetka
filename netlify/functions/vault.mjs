import { getStore } from "@netlify/blobs";
import { route } from "../../server/router.mjs";

export default async function handler(request, context) {
  const deployment = context.deploy;
  const preview = deployment && (deployment.context !== "production" || deployment.published === false);
  const suffix = preview ? "-preview-" + deployment.id : "";
  const env = { ...process.env, KARETKA_MANAGED_BLOBS: "netlify" };
  if (preview) {
    env.BILLING_MODE = "off";
    env.KARETKA_OWNER_SETUP_HASH = "";
  }
  return route(request, {
    legacy: getStore({ name: "karetka-manuscripts-v1" + suffix, consistency: "strong" }),
    commerce: getStore({ name: "karetka-commerce-v1" + suffix, consistency: "strong" }),
    env,
    ip: context.ip
  });
}
export const config = { path: "/api/*", rateLimit: { windowLimit: 600, windowSize: 60, aggregateBy: ["ip", "domain"] } };
