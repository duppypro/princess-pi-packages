import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function sessionNameDisplayExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    let name = pi.getSessionName();
    if (!name) {
      name = "_ANONYMOUS_";
    }
    // Only style if it isn't already styled to prevent runaway ANSI wrapping
    if (!name.includes("\x1b[")) {
      const styledName = ctx.ui.theme.fg("borderMuted", `\x1b[7m ${name} \x1b[27m`);
      pi.setSessionName(styledName);
    }
  });

  // Also catch if a user clears the name during the session
  pi.on("turn_start", async (_event, ctx) => {
    let name = pi.getSessionName();
    if (!name || name === "_ANONYMOUS_") {
      name = "_ANONYMOUS_";
    }
    if (!name.includes("\x1b[")) {
      const styledName = ctx.ui.theme.fg("borderMuted", `\x1b[7m ${name} \x1b[27m`);
      pi.setSessionName(styledName);
    }
  });
}
