import { AgentMeter } from "../meter.js";
import type { MeterConfig, RouteOptions } from "../types.js";

export function agentMeter(config: MeterConfig, options?: RouteOptions) {
  const meter = new AgentMeter(config);
  return meter.express(options);
}

export { AgentMeter } from "../meter.js";
export type { MeterConfig, RouteOptions } from "../types.js";
