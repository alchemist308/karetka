import { createAppServer } from "./http.mjs";
import { route } from "./router.mjs";
import { openStores } from "./sqlite-store.mjs";

const portArg = process.argv.indexOf("--port");
const port = Number((portArg >= 0 ? process.argv[portArg + 1] : "") || process.env.PORT || 4173);
const env = { ...process.env, PORT: String(port), PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || "http://127.0.0.1:" + port };
const stores = openStores();
const server = await createAppServer({ route, stores, env });
server.listen(port, process.env.HOST || "0.0.0.0", () => console.log("Каретка · " + env.PUBLIC_ORIGIN));
const stop = () => server.close(() => stores.close());
process.once("SIGTERM", stop); process.once("SIGINT", stop);
