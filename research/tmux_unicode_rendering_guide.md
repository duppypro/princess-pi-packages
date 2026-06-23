# Terminal Multiplexing, Unicode, and Emoji Rendering Guide
**A Systems Engineering Deep-Dive into Cursor Drift, Width Calculations, and Key Handling**  
*Authored by 👑π🐱 Princess-Pi (inspired by David 'Duppy' Proctor)*

---

## 1. The Core Architecture: Raw Shell vs. tmux Multiplexer
Understanding character rendering issues requires looking at how a bare terminal shell operates compared to a terminal multiplexer like `tmux`.

```
Bare Stream:  [Shell (stdout)] ---------> [SSH Stream] ---------> [Terminal Emulator (Font Engine)]
                                                                  (No 2D tracking by shell)

tmux Stream:  [Shell (stdout)] -> [tmux 2D Virtual Grid] -> [ANSI Escape Coordinates] -> [Terminal Emulator]
                                  (Strict Column tracking)
```

### Raw Shell (The "Dumb" Stream)
When running a standard shell (e.g., `bash` or `zsh`) outside of a multiplexer:
*   The shell behaves as a sequential, one-dimensional stream of bytes. It does not maintain a 2D coordinate grid in memory and is unaware of the cursor's exact row or column.
*   When you print a multi-byte character (like `👑`), the shell streams the UTF-8 bytes to the terminal emulator. The emulator renders the glyph, and the hardware cursor advances to the end of whatever was drawn.
*   Even if the emulator renders the emoji with non-standard width (e.g., 1 cell instead of 2), no cursor tracking breaks because the shell does not use absolute coordinates to position text.

### tmux (The 2D Virtual Grid)
`tmux` is not a simple pass-through pipe; **it is a full-blown terminal emulator running in host memory.**
*   `tmux` maintains a strict, character-cell grid representation of your pane width (e.g., 80 columns wide).
*   To render the status bar, scrollback buffer, and pane splits, `tmux` must know the exact horizontal position of the cursor at all times.
*   To calculate cursor offsets, tmux runs a character-width function (`wcwidth`) over every incoming Unicode codepoint.
*   **The Cursor Drift Bug:** If `tmux` calculates an emoji like `👑` to be **2 cells wide** (per Unicode 15.0), it advances its virtual cursor by 2 columns. But if your terminal emulator (e.g., *Waveterm*) or your selected font renders it as **1 cell wide**, your visual cursor is on column 6 while `tmux`'s virtual cursor is on column 7.
*   Because `tmux` synchronizes screens using absolute ANSI coordinate escapes (e.g., `\x1b[row;colH` - *Move cursor to row Y, column X*), the discrepancy instantly causes the visual display to overlap, clip, or wrap early by exactly the number of drifted columns!

---

## 2. Character Cell Widths & `wcwidth`
How characters map to a grid is governed by standard Unicode specifications:

*   **ASCII Characters:** Always occupy exactly `1` horizontal cell.
*   **CJK & Emojis:** Standardized under Unicode to occupy exactly `2` horizontal cells (double-width).
*   **Ambiguous-Width Characters:** Characters like `π` (Pi), certain bullet points, and special symbols can be categorized as `1` or `2` cells wide depending on the language locale. 
    *   *The Mismatch:* If the multiplexer is compiled with a locale treating `π` as single-width, but your terminal emulator treats it as double-width, your alignment breaks on every instance of that character.

---

## 3. tmux Configuration Evolution: v3.4 vs. 3.5a

As terminal protocols progressed, tmux radically overhauled its UTF-8 configuration directives:

### The Obsolete Way (Pre-v2.2)
Historically, users forced UTF-8 mode inside `.tmux.conf` via:
```tmux
set -g utf8 on
set -g status-utf8 on
```
*   **In tmux v3.4 & v3.5a:** These options are **obsolete** and will throw `"invalid/obsolete option"` warnings on launch. tmux now auto-detects UTF-8 capabilities natively from the system locale.

### The Modern Way (v3.5a+)
Tmux 3.5a relies on **Client Overrides** and **Extended Key Protocols** to synchronize rendering and modifier keys (like `Shift+Enter` or `Ctrl+Enter`) inside TUI applications.

1.  **True Color (24-bit RGB) Support:**
    Modern emulators support 16.7 million colors. We notify tmux of this using the terminal feature `RGB` override:
    ```tmux
    set -as terminal-overrides ",xterm-256color:RGB"
    ```
2.  **Forcing UTF-8 (The `U8` Override):**
    If client-detection fails, we can force tmux to treat all terminal connections as UTF-8 double-width capable using the `U8=1` terminal override:
    ```tmux
    set -as terminal-overrides ',*:U8=1'
    ```
3.  **Extended Keys Protocol (`csi-u`):**
    TUI apps (like Pi Coding Agent) require advanced keyboard tracking to distinguish `Enter` from `Shift+Enter`. tmux 3.5a enables this natively via `extended-keys`:
    ```tmux
    set -s extended-keys on
    set -as terminal-features 'xterm*:extkeys'
    set -g extended-keys-format csi-u
    ```

---

## 4. The Standard Reference Configurations

To guarantee perfect cursor alignment and key handling under modern TUI and SSH environments, deploy the following configurations:

### `~/.config/tmux/tmux.conf`
```tmux
# ==========================================
# COLOR, GRAPHICS & UTF-8 OVERRIDES
# ==========================================
# Upgrade container default terminal for better rendering inside tmux
set -g default-terminal "tmux-256color"

# Inform tmux that outer terminal supports modern 24-bit True Color (RGB)
set -as terminal-overrides ",xterm-256color:RGB"

# Force tmux to treat terminal characters as standard UTF-8 (U8=1)
set -as terminal-overrides ',*:U8=1'

# Propagate standard UTF-8 locale variables into all tmux pane environments
set-environment -g LANG en_US.UTF-8
set-environment -g LC_ALL en_US.UTF-8
set-environment -g LC_CTYPE en_US.UTF-8

# ==========================================
# KEY HANDLING, EXTENDED KEYS & SHORTCUTS
# ==========================================
# Enable Shift+Enter and Ctrl+Enter passthrough inside TUI apps
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
set -g extended-keys-format csi-u

# Bind Shift+Enter to insert a raw newline without executing command in the shell
# (C-q C-j represents standard Control-Q Control-J literal Line Feed sequence)
bind-key -n S-Enter send-keys C-q C-j
```

### `~/.bashrc` (or `~/.zshrc`)
```bash
# Standardize global terminal locale environment
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

# Force tmux to launch in UTF-8 client mode by default
alias tmux="tmux -u"
```

---

## 5. Diagnostic Pipeline (How to Isolate)

To determine which layer of your terminal stack is failing, execute the following **Alignment Test**:

```bash
printf "12345\n👑\n"
```

### Analysis:
*   **Correct Alignment:** The emoji `👑` is visually exactly as wide as `12` combined, and the terminal's solid cursor sits perfectly aligned underneath the `3`.
*   **Cursor Drift Mismatch:** If the emoji is drawn squeezed into 1 column, and the cursor sits underneath the `2`, the **Terminal Emulator or Font** is treating the double-width character as single-width.
    *   *Remedy:* Switch your emulator's default font to a high-quality monospaced font with robust Unicode Glyphs (such as **JetBrains Mono** or **Cascadia Code**) to force the visual canvas to align with the application's math.
