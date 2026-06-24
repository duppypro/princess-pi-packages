import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function sessionNameDisplayExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // If the session has no name, set it to _ANONYMOUS_
    // This will automatically reflect in the footer and session selector!
    if (!pi.getSessionName()) {
      pi.setSessionName("_ANONYMOUS_");
    }
  });

  // Also catch if a user clears the name during the session
  pi.on("turn_start", async (_event, ctx) => {
    if (!pi.getSessionName()) {
      pi.setSessionName("_ANONYMOUS_");
    }
  });
}
