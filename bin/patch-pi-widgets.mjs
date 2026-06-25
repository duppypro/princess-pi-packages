#!/usr/bin/env node
/**
 * @package princess-pi-packages
 * @command patch-pi-widgets
 * @description Automatically patches the global Pi Coding Agent TUI to preserve custom widget render order on refresh.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function logInfo(msg) {
  console.log(`${BOLD}${CYAN}ℹ️  [Patch Widgets]${RESET} ${msg}`);
}

function logSuccess(msg) {
  console.log(`${BOLD}${GREEN}✅ [Patch Widgets]${RESET} ${msg}`);
}

function logWarning(msg) {
  console.log(`${BOLD}${YELLOW}⚠️  [Patch Widgets]${RESET} ${msg}`);
}

function logError(msg) {
  console.error(`${BOLD}${RED}❌ [Patch Widgets]${RESET} ${msg}`);
}

async function main() {
  logInfo("Locating global Pi Coding Agent installation...");
  let piPath = "";
  try {
    piPath = execSync("which pi", { encoding: "utf8" }).trim();
  } catch (err) {
    logError("Could not locate global 'pi' command on $PATH. Ensure pi is installed globally.");
    process.exit(1);
  }

  const globalNodeModules = path.join(path.dirname(piPath), "..", "lib", "node_modules");
  const targetFile = path.join(
    globalNodeModules,
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "modes",
    "interactive",
    "interactive-mode.js"
  );

  if (!fs.existsSync(targetFile)) {
    logError(`Could not find 'interactive-mode.js' at: ${targetFile}`);
    process.exit(1);
  }

  logInfo(`Found file: ${targetFile}`);
  let code = fs.readFileSync(targetFile, "utf8");

  const alreadyPatched = code.includes("__orderedKeys") || code.includes("isUserTriggered");
  if (alreadyPatched) {
    logSuccess("Pi interactive widgets are already successfully patched! Nothing to do.");
    process.exit(0);
  }

  logInfo("Applying activation-aware rendering order patch...");

  // 1. Patch setExtensionWidget to maintain __orderedKeys and track user-initiated triggers
  const setWidgetOld = `    setExtensionWidget(key, content, options) {
        const placement = options?.placement ?? "aboveEditor";
        const removeExisting = (map) => {
            const existing = map.get(key);
            if (existing?.dispose)
                existing.dispose();
            map.delete(key);
        };
        removeExisting(this.extensionWidgetsAbove);
        removeExisting(this.extensionWidgetsBelow);
        if (content === undefined) {
            this.renderWidgets();
            return;
        }
        let component;
        if (Array.isArray(content)) {
            // Wrap string array in a Container with Text components
            const container = new Container();
            for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
                container.addChild(new Text(line, 1, 0));
            }
            if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
                container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
            }
            component = container;
        }
        else {
            // Factory function - create component
            component = content(this.ui, theme);
        }
        const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
        targetMap.set(key, component);
        this.renderWidgets();
    }`;

  const setWidgetNew = `    setExtensionWidget(key, content, options) {
        const placement = options?.placement ?? "aboveEditor";
        const removeExisting = (map) => {
            const existing = map.get(key);
            if (existing?.dispose)
                existing.dispose();
            map.delete(key);
        };
        removeExisting(this.extensionWidgetsAbove);
        removeExisting(this.extensionWidgetsBelow);
        if (content === undefined) {
            if (this.extensionWidgetsAbove.__orderedKeys) {
                this.extensionWidgetsAbove.__orderedKeys = this.extensionWidgetsAbove.__orderedKeys.filter(k => k !== key);
            }
            if (this.extensionWidgetsBelow.__orderedKeys) {
                this.extensionWidgetsBelow.__orderedKeys = this.extensionWidgetsBelow.__orderedKeys.filter(k => k !== key);
            }
            this.renderWidgets();
            return;
        }
        let component;
        if (Array.isArray(content)) {
            // Wrap string array in a Container with Text components
            const container = new Container();
            for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
                container.addChild(new Text(line, 1, 0));
            }
            if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
                container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
            }
            component = container;
        }
        else {
            // Factory function - create component
            component = content(this.ui, theme);
        }
        const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
        if (!targetMap.__orderedKeys) {
            targetMap.__orderedKeys = [];
        }
        const stack = new Error().stack || "";
        const isUserTriggered = stack.includes("_tryExecuteExtensionCommand") || stack.includes("prompt") || stack.includes("executeSlashCommand");
        
        if (isUserTriggered || !targetMap.__orderedKeys.includes(key)) {
            targetMap.__orderedKeys = [key, ...targetMap.__orderedKeys.filter(k => k !== key)];
        }
        
        targetMap.set(key, component);
        this.renderWidgets();
    }`;

  // 2. Patch renderWidgetContainer to render in custom key order
  const renderContainerOld = `    renderWidgetContainer(container, widgets, spacerWhenEmpty, leadingSpacer) {
        container.clear();
        if (widgets.size === 0) {
            if (spacerWhenEmpty) {
                container.addChild(new Spacer(1));
            }
            return;
        }
        if (leadingSpacer) {
            container.addChild(new Spacer(1));
        }
        for (const component of widgets.values()) {
            container.addChild(component);
        }
    }`;

  // Supporting both our unpatched version AND potentially sorted-by-key (which we set previously)
  const renderContainerOldSorted = `    renderWidgetContainer(container, widgets, spacerWhenEmpty, leadingSpacer) {
        container.clear();
        if (widgets.size === 0) {
            if (spacerWhenEmpty) {
                container.addChild(new Spacer(1));
            }
            return;
        }
        if (leadingSpacer) {
            container.addChild(new Spacer(1));
        }
        // Enforce deterministic rendering order sorted alphabetically by widget key (e.g., rate-limiter, serve-ports, wtft)
        const sortedKeys = Array.from(widgets.keys()).sort();
        for (const key of sortedKeys) {
            const component = widgets.get(key);
            if (component) {
                container.addChild(component);
            }
        }
    }`;

  const renderContainerNew = `    renderWidgetContainer(container, widgets, spacerWhenEmpty, leadingSpacer) {
        container.clear();
        if (widgets.size === 0) {
            if (spacerWhenEmpty) {
                container.addChild(new Spacer(1));
            }
            return;
        }
        if (leadingSpacer) {
            container.addChild(new Spacer(1));
        }
        const ordered = widgets.__orderedKeys || Array.from(widgets.keys());
        for (const key of ordered) {
            const component = widgets.get(key);
            if (component) {
                container.addChild(component);
            }
        }
    }`;

  // Apply replacements
  let replaced = 0;
  
  if (code.includes(setWidgetOld)) {
    code = code.replace(setWidgetOld, setWidgetNew);
    replaced++;
  }

  if (code.includes(renderContainerOld)) {
    code = code.replace(renderContainerOld, renderContainerNew);
    replaced++;
  } else if (code.includes(renderContainerOldSorted)) {
    code = code.replace(renderContainerOldSorted, renderContainerNew);
    replaced++;
  }

  if (replaced < 2) {
    logError("Could not successfully match all code blocks for replacement. The Pi version might be incompatible.");
    process.exit(1);
  }

  try {
    fs.writeFileSync(targetFile, code, "utf8");
    logSuccess("Successfully patched Pi TUI widgets! Restart or reload your Pi session to enjoy a stable layout order.");
  } catch (err) {
    logError(`Failed to write patched file: ${err.message}`);
    process.exit(1);
  }
}

main();
