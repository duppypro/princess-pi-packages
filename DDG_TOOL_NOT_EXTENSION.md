# Prompt: Convert `ddg-search` into a Global Tool / Pure Standalone Tool / Skill

Use this prompt in your other `pi` session to instruct it on how to convert the `ddg-search` project-local extension into your preferred target format.

---

```markdown
Hi! I want you to help me convert my local `ddg-search.ts` extension (located at `./git-projects/does-it-glider-juice-my-extensions/.pi/extensions/ddg-search.ts`) into a different architectural format. 

Currently, it is loaded as a project-local extension that registers a custom tool `search_web`. I would like you to analyze the current implementation and help me convert it into one of the following formats depending on my needs.

Please read the existing code of `./git-projects/does-it-glider-juice-my-extensions/.pi/extensions/ddg-search.ts` and present the converted code/configuration for the following three options:

---

### OPTION A: Convert to a Global Custom Tool (Global Extension)
I want this tool to be available in every directory and session globally, rather than just locally in this project.
1. Show me the exact file changes (if any) and instruct me on how to move/copy it to the global extension directory at `~/.pi/agent/extensions/ddg-search.ts`.
2. Explain how to hot-reload the session using `/reload` to activate it globally.

### OPTION B: Convert to a Pure Standalone SDK Tool Definition (For Programmatic SDK Usage)
I am building a programmatic agent using the `@earendil-works/pi-coding-agent` SDK and want to import and pass this tool directly via `createAgentSession({ customTools: [searchWebTool] })` without loading it through the default extension loader.
1. Provide the code for `ddg-search-tool.ts` where the tool is exported directly using `defineTool` without the `export default function (pi: ExtensionAPI)` wrapper.
2. Provide a short TypeScript example showing how to import it and pass it to `createAgentSession`.

### OPTION C: Convert to a Native Pi Skill (Conforming to `agentskills.io` Standard)
I want to completely replace the compiled TypeScript extension and custom tool with a progressive-disclosure **Skill** under `.pi/skills/ddg-search/`. This will allow other skill-aware frameworks (like Claude Code) to use the exact same capability, using the core `bash` tool to run the pre-installed `ddgr` binary under the hood.
1. Provide the directory structure and file contents for `.pi/skills/ddg-search/SKILL.md` with appropriate frontmatter (`name`, `description`).
2. Provide clear instructions inside the skill on how the AI should call `ddgr` inside a bash session to parse the search results.

---

Please start by reading the local `ddg-search.ts` file, and then output the code and instructions for all three options clearly so I can choose the best one!
```
