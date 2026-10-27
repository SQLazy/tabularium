import { memory } from "./memory";
import type { Service } from "../core/service";

// Every service on the platform. Order is the order of /menu, /openapi.json and /llms.txt. Ids never change.
export const SERVICES: Service[] = [memory];
