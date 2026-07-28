# Spec: Keep Generated Preview URLs Un-truncated and Clickable

**RESOLVED (#119).** URLs in card output are now full-width within dynamically-sized boxes. The right-side border `│` is present but modern terminals ignore ANSI/border characters when detecting URLs for click-to-open. The original concern about `│` being appended to clicked links does not reproduce on current terminal emulators.

If a specific terminal shows `│` in the clicked URL, the fix would be to strip the right border from URL lines — but no terminal tested exhibits this behavior.
