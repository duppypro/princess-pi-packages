import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Session Name Display extension.
 *
 * Renders the session name with inverse video + padding in the TUI status bar
 * (pwd line of the footer) without polluting the stored session name with
 * terminal escape codes or padding. Other tools that read getSessionName()
 * see only the clean, unadorned name.
 */

// ---------------------------------------------------------------------------
// Helpers (mirror built-in footer.js)
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function sessionNameDisplayExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Ensure current name is clean (strip any pre-existing escape codes)
    const raw = pi.getSessionName() || "";
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim() || "_ANONYMOUS_";
    pi.setSessionName(clean);

    // -----------------------------------------------------------------------
    // Custom footer — same layout as built-in footer BUT session name on the
    // pwd line is rendered with inverse video and space padding.
    // -----------------------------------------------------------------------
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsubBranch,

        invalidate() {
          /* no cached state to clear */
        },

        render(width: number): string[] {
          // -- token stats ---------------------------------------------------
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;
          let latestCacheHitRate: number | undefined;

          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const m = entry.message as AssistantMessage;
              totalInput += m.usage.input;
              totalOutput += m.usage.output;
              totalCacheRead += m.usage.cacheRead;
              totalCacheWrite += m.usage.cacheWrite;
              totalCost += m.usage.cost.total;
              const latestPromptTokens =
                m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
              latestCacheHitRate =
                latestPromptTokens > 0
                  ? (m.usage.cacheRead / latestPromptTokens) * 100
                  : undefined;
            }
          }

          // -- context usage -------------------------------------------------
          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent =
            contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

          // -- pwd line (with inverted session name) -------------------------
          let pwd = ctx.sessionManager.getCwd() || "";
          // Replace home with ~
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = "~" + pwd.slice(home.length);
          }

          const branch = footerData.getGitBranch();
          if (branch) {
            pwd += ` (${branch})`;
          }

          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) {
            const invertedName = `\x1b[7m ${sessionName} \x1b[27m`;
            pwd += ` • ${theme.fg("thinkingOff", invertedName)}`;
          }

          const pwdLine = truncateToWidth(
            theme.fg("dim", pwd),
            width,
            theme.fg("dim", "..."),
          );

          // -- stats line ----------------------------------------------------
          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
          if (
            (totalCacheRead > 0 || totalCacheWrite > 0) &&
            latestCacheHitRate !== undefined
          ) {
            statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
          }

          // Cost (with "(sub)" indicator for OAuth)
          const usingSubscription =
            ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSubscription) {
            statsParts.push(
              `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
            );
          }

          // Context bar
          let contextPercentDisplay: string;
          if (contextPercent === "?") {
            contextPercentDisplay = `?/${formatTokens(contextWindow)}`;
          } else {
            const barLength = 8;
            const numHashes = Math.ceil(
              contextPercentValue / (100 / barLength),
            );
            const numDots = barLength - numHashes;
            const barStr = `[${"#".repeat(numHashes)}${".".repeat(numDots)}]`;
            const pctRoundedDown = Math.min(99, Math.floor(contextPercentValue));
            contextPercentDisplay = `${barStr} ${pctRoundedDown}% of ${formatTokens(contextWindow)}`;
          }

          let contextPercentStr: string;
          if (contextPercentValue > 90) {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
          } else if (contextPercentValue > 70) {
            contextPercentStr = theme.fg("warning", contextPercentDisplay);
          } else {
            contextPercentStr = contextPercentDisplay;
          }
          statsParts.push(contextPercentStr);

          let statsLeft = statsParts.join(" ");

          // Model name (right side)
          const modelName = ctx.model?.id || "no-model";

          let rightSide = modelName;
          if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${modelName}`;
            if (
              visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <=
              width
            ) {
              rightSide = withProvider;
            }
          }

          // Layout
          const statsLeftWidth = visibleWidth(statsLeft);
          const rightSideWidth = visibleWidth(rightSide);
          const minPadding = 2;

          let statsLine: string;
          if (statsLeftWidth + minPadding + rightSideWidth <= width) {
            const padding = " ".repeat(
              width - statsLeftWidth - rightSideWidth,
            );
            statsLine = statsLeft + padding + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - minPadding;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(
                rightSide,
                availableForRight,
                "",
              );
              const truncatedRightWidth = visibleWidth(truncatedRight);
              const padding = " ".repeat(
                Math.max(0, width - statsLeftWidth - truncatedRightWidth),
              );
              statsLine = statsLeft + padding + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const dimStatsLeft = theme.fg("dim", statsLeft);
          const remainder = statsLine.slice(statsLeft.length);
          const dimRemainder = theme.fg("dim", remainder);
          const lines = [
            pwdLine,
            dimStatsLeft + dimRemainder,
          ];

          // -- extension statuses line ---------------------------------------
          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
            const statusLine = sortedStatuses.join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }

          return lines;
        },
      };
    });
  });

  // Keep the session name clean on every turn (in case /name or external code
  // sets something with escape codes)
  const ensureCleanName = () => {
    const raw = pi.getSessionName() || "";
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
    if (clean !== raw) {
      pi.setSessionName(clean || "_ANONYMOUS_");
    }
  };

  pi.on("turn_start", async () => {
    ensureCleanName();
  });

  pi.on("turn_end", async () => {
    ensureCleanName();
  });
}
