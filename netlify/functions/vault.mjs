import { getStore } from "@netlify/blobs";
import { vault } from "../../server/vault.mjs";
export default async function handler(request) {
  return vault(request, getStore({ name: "karetka-manuscripts-v1", consistency: "strong" }));
}

export const config = {
  path: "/api/vault",
  rateLimit: { windowLimit: 600, windowSize: 60, aggregateBy: ["ip", "domain"] }
};
