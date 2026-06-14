/**
 * @package princess-pi-packages
 * @spec docs/EXT_SMUSH.html
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text, DynamicBorder } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as path from "path";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("smush", {
    description: "Assimilate local repository rules (CLAUDE.md) into AGENTS.md interactively",
    handler: async (_args, ctx) => {
      const cwd = process.cwd();
      const filesToScout = ["CLAUDE.md", "CONTRIBUTING.md", "README.md", "AGENTS.md"];
      const foundRules: string[] = [];
      let foundFiles = 0;

      // 1. Read files and heuristically parse rules
      for (const file of filesToScout) {
        const filePath = path.join(cwd, file);
        if (fs.existsSync(filePath)) {
          foundFiles++;
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Match markdown bullet points (- or *) that seem like actionable rules
            if ((line.startsWith("- ") || line.startsWith("* ")) && line.length > 10) {
              // Strip bullet
              let rule = line.substring(2).trim();
              
              // Remove markdown bolding if it's the start
              rule = rule.replace(/^\*\*(.*?)\*\*(:|-)?\s*/, "$1: ");
              
              // Only add if not entirely duplicated
              if (!foundRules.includes(rule) && foundRules.length < 50) {
                foundRules.push(rule);
              }
            }
          }
        }
      }

      if (foundRules.length === 0) {
        if (foundFiles === 0) {
          ctx.ui.notify("No CLAUDE.md or CONTRIBUTING.md found to smush.", "warning");
        } else {
          ctx.ui.notify("Found files, but couldn't parse any bullet-point rules.", "warning");
        }
        return;
      }

      // 2. Build SettingItems for the TUI
      // By default, turn them all "on" except anything that looks suspicious
      const items: SettingItem[] = foundRules.map((rule, idx) => ({
        id: `rule_${idx}`,
        label: rule.length > 60 ? rule.substring(0, 57) + "..." : rule,
        currentValue: "on",
        values: ["on", "off"],
      }));

      // 3. Mount the TUI
      const result = await ctx.ui.custom<{ id: string; val: string }[] | undefined>((tui, theme, _kb, done) => {
        const container = new Container();

        // Top Border & Title
        container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold(` 👑π🐱 The Smush Room: Select rules to assimilate into ${path.basename(cwd)}/AGENTS.md`)), 1, 1));
        container.addChild(new Text("", 1, 0)); // spacer

        // Track state locally inside the UI closure
        const selectedState = items.map(i => ({ id: i.id, val: i.currentValue }));

        // SettingsList
        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            const stateItem = selectedState.find(s => s.id === id);
            if (stateItem) stateItem.val = newValue;
          },
          () => done(undefined) // Escaped
        );

        // Override standard Enter behavior to "submit" the list instead of just toggling
        // Wait, SettingsList toggles on Enter usually. We will add a custom input handler override
        const defaultHandleInput = settingsList.handleInput.bind(settingsList);
        settingsList.handleInput = (data: Buffer) => {
          // If "Enter" (carriage return = 13 or newline = 10) or 's' for save
          // Actually, in SettingsList, Enter toggles the value. Let's use 's' to save.
          if (data.length === 1 && data[0] === 115) { // 's'
             done(selectedState);
             return;
          }
          defaultHandleInput(data);
        };

        container.addChild(settingsList);

        // Footer
        container.addChild(new Text("", 1, 0)); // spacer
        container.addChild(new Text(theme.fg("dim", "  ↑↓ navigate • enter/space toggle • 's' to Save & Smush • esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
             settingsList.handleInput?.(data);
             tui.requestRender();
          },
        };
      });

      // 4. Handle Save
      if (result) {
        const activeRules = result
          .filter(r => r.val === "on")
          .map(r => {
             // Map back to original rule text
             const idx = parseInt(r.id.split("_")[1]);
             return foundRules[idx];
          });

        if (activeRules.length > 0) {
          const agentsPath = path.join(cwd, "AGENTS.md");
          let newContent = `# Project Instructions (${path.basename(cwd)})\n\nThese instructions override or append to the global standards for this specific repository.\n\n## Assimilated Rules\n`;
          
          for (const rule of activeRules) {
            newContent += `- ${rule}\n`;
          }

          fs.writeFileSync(agentsPath, newContent, "utf-8");
          ctx.ui.notify(`Successfully smushed ${activeRules.length} rules into AGENTS.md`, "success");

          // Ask to backup CLAUDE.md
          if (fs.existsSync(path.join(cwd, "CLAUDE.md"))) {
             const backup = await ctx.ui.confirm("Backup CLAUDE.md?", "Rename to CLAUDE.md.bak to prevent double-loading rules?");
             if (backup) {
               fs.renameSync(path.join(cwd, "CLAUDE.md"), path.join(cwd, "CLAUDE.md.bak"));
             }
          }
        } else {
          ctx.ui.notify("No rules selected. AGENTS.md not modified.", "info");
        }
      }
    },
  });
}
