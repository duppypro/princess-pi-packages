import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

export default function sessionNameDisplayExtension(pi: ExtensionAPI) {
  // Wrap sessionManager to handle automatic styling and prevent normalization warnings
  const wrapSessionManager = (ctx: any) => {
    const sessionManager = ctx.sessionManager;
    if (sessionManager && !sessionManager.__isSessionNameDisplayWrapped) {
      const originalAppend = sessionManager.appendSessionInfo;
      if (typeof originalAppend === "function") {
        sessionManager.appendSessionInfo = function (this: any, name: string) {
          const plainName = stripAnsi(name).trim() || "_ANONYMOUS_";
          const styledName = ctx.ui.theme.fg("thinkingOff", `\x1b[7m ${plainName} \x1b[27m`);
          return originalAppend.call(this, styledName);
        };
      }

      const originalGetSessionName = sessionManager.getSessionName;
      if (typeof originalGetSessionName === "function") {
        sessionManager.getSessionName = function (this: any, ...args: any[]) {
          const name = originalGetSessionName.apply(this, args);
          // Strip colors when checked by handleNameCommand to avoid "normalized" warnings
          if (name && new Error().stack?.includes("handleNameCommand")) {
            return stripAnsi(name).trim();
          }
          return name;
        };
      }

      sessionManager.__isSessionNameDisplayWrapped = true;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    wrapSessionManager(ctx);
    const name = pi.getSessionName() || "";
    const plainName = stripAnsi(name).trim() || "_ANONYMOUS_";
    // Use "thinkingOff" (the exact color of the inactive prompt borders) + \x1b[7m (inverse) to match perfectly
    const styledName = ctx.ui.theme.fg("thinkingOff", `\x1b[7m ${plainName} \x1b[27m`);
    pi.setSessionName(styledName);
  });

  // Also catch if a user clears/updates the name during the session
  pi.on("turn_start", async (_event, ctx) => {
    wrapSessionManager(ctx);
    const name = pi.getSessionName() || "";
    const plainName = stripAnsi(name).trim() || "_ANONYMOUS_";
    const styledName = ctx.ui.theme.fg("thinkingOff", `\x1b[7m ${plainName} \x1b[27m`);
    pi.setSessionName(styledName);
  });

  pi.on("turn_end", async (_event, ctx) => {
    wrapSessionManager(ctx);
    const name = pi.getSessionName() || "";
    const plainName = stripAnsi(name).trim() || "_ANONYMOUS_";
    const styledName = ctx.ui.theme.fg("thinkingOff", `\x1b[7m ${plainName} \x1b[27m`);
    pi.setSessionName(styledName);
  });
}
