import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

export default function sessionNameDisplayExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const name = pi.getSessionName() || "";
    const plainName = stripAnsi(name).trim() || "_ANONYMOUS_";
    // Use "thinkingOff" (the exact color of the inactive prompt borders) + \x1b[7m (inverse) to match perfectly
    const styledName = ctx.ui.theme.fg("thinkingOff", `\x1b[7m ${plainName} \x1b[27m`);
    pi.setSessionName(styledName);
  });

  // Also catch if a user clears the name during the session
  pi.on("turn_start", async (_event, ctx) => {
    const name = pi.getSessionName() || "";
    const plainName = stripAnsi(name).trim() || "_ANONYMOUS_";
    const styledName = ctx.ui.theme.fg("thinkingOff", `\x1b[7m ${plainName} \x1b[27m`);
    pi.setSessionName(styledName);
  });
}
