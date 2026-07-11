// Retrieve widget visibility from config file
import { loadConfig } from "../config.js";

export function getVisibility(_ctx?: any): boolean {
	const cfg = loadConfig("serve", { visible: true });
	return cfg.visible !== false;
}
