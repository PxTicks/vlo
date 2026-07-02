import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { startVloBridge } from "./bridge-core.mjs";

const SINGLETON_KEY = Symbol.for("vlo.bridge.runtime.v2");

if (!window[SINGLETON_KEY]) {
  window[SINGLETON_KEY] = startVloBridge({ app, api, windowObject: window });
}
