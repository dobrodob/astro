---
'astro': patch
---

Fixes `astro preview` incorrectly starting as a background daemon when an AI coding agent environment is detected. The `--background` flag is now required to opt into background mode, matching the documented behavior.
