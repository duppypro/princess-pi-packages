import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Extension to add '/nn' command for starting a new named session instantly.
 */
export default function newSessionExtension(pi: ExtensionAPI) {
  pi.registerCommand("nn", {
    description: "Start a new session with an optional display name",
    handler: async (args, ctx) => {
      // Create a new session
      await ctx.newSession({
        withSession: async (newCtx) => {
          if (args) {
            // Parse name from argument string
            let name = args.trim();
            if (name.startsWith("-n ")) {
              name = name.slice(3).trim();
            } else if (name.startsWith("--name ")) {
              name = name.slice(7).trim();
            }

            // Strip surrounding quotes if present
            if (
              (name.startsWith('"') && name.endsWith('"')) ||
              (name.startsWith("'") && name.endsWith("'"))
            ) {
              name = name.slice(1, -1);
            }

            // Set the session name
            pi.setSessionName(name);
            newCtx.ui.notify(`Started new session: "${name}"`, "success");
          } else {
            newCtx.ui.notify("Started new unnamed session", "info");
          }
        },
      });
    },
  });
}
