# `lwdb setdb` — switch the local Linways app DB in one command

`setdb` points your **local** Linways app at a chosen server + database by writing a
single PHP include, `active-db.php`, from a connection in your lwdb store. Include
that one file in the app's config once, and switching DB becomes a single command
instead of hand-editing several config files.

Credentials come from your lwdb store — never from files in the app repo.

## Config lives in `~/.lwdb/` (not in the app repo)

Everything `setdb` needs lives under lwdb's home, so it works from any directory and
nothing app-specific leaks into the codebase. The **only** file it writes into the app
tree is the generated `active-db.php` (the PHP app has to `include` it from there).

**`~/.lwdb/setdb.json`** — your target config (absolute paths; each dev writes their own):
```json
{
  "group": "linways",
  "output": "/home/you/.lwdb/dev/active-db.php",
  "verify": true,
  "includeInto": [
    "/path/to/your/app/conf.php",
    "/path/to/your/app/professional-db-conf.php",
    "/path/to/your/app/ams-autonomous-db-conf.php"
  ]
}
```
- `group` — which lwdb connection group the picker offers (`lwdb servers`).
- `output` — absolute path of the `active-db.php` file to write. Keep it **inside
  `~/.lwdb/`** (e.g. `~/.lwdb/dev/active-db.php`) so nothing setdb-related lives in the
  app repo. `setdb` creates the directory if needed.
- `verify` — check the db exists on the server before writing.
- `includeInto` — the config files you must add the include to (used by `setdb --init`).

**`~/.lwdb/college-codes.json`** — optional `{ "KEY": "CODE" }` map to auto-fill the
college code. (Legacy fallback: `~/.config/linways/college-codes.json`.)

> A repo-committed `.setdb.json` (found by walking up from the cwd) overrides the home
> config if you prefer per-repo config — but the home config is the default and keeps
> the app tree clean.

## One-time setup

1. Have lwdb with your servers: `lwdb servers` (import shared ones with `lwdb import <file.json>`).
2. Write `~/.lwdb/setdb.json` with your absolute paths (above).
3. Wire the include — run `setdb --init`. It creates the target file and prints the
   exact line to paste into each config file (the **full path**, since the file lives in
   `~/.lwdb/`, not next to the conf files):
   ```php
   include "/home/you/.lwdb/dev/active-db.php";
   ```
   **It must be the LAST db-config statement in each file** — otherwise a later
   `$DB_NAME = ...` / `$HOST = ...` in that file overrides the values `active-db.php` set.
4. (Optional) add a `setdb` shim on your PATH so you don't type `lwdb`:
   ```sh
   printf '#!/usr/bin/env sh\nexec lwdb setdb "$@"\n' > ~/.local/bin/setdb && chmod +x ~/.local/bin/setdb
   ```

## Usage

```sh
setdb                            # interactive: pick server, type db, college code
setdb V4-server3378 mydb         # direct
setdb V4-server3378 mydb SJC     # with college code
setdb --json V4-server3378 mydb SJC   # agents: JSON out, no prompts, strict exit codes
setdb --status                   # show the current active target
setdb --print V4-server3378 mydb # render to stdout without writing (dry run)
setdb --init                     # create active-db.php + print the include line to paste
setdb --no-verify ...            # skip checking the db exists on the server
```

## How it works

`active-db.php` defines the variable contract the Linways config files consume
(`$DB_NAME`/`$AMS_AUTONOMOUS_DB_NAME`, `$COLLEGE_CODE`, and the `$HOST`/`$USER`/`$PASSWD`
trios). `setdb` renders it from a chosen lwdb connection with proper PHP escaping, so
passwords containing `$`, `%`, or `'` are safe. `active-db.php` is generated and holds a
plaintext password — keeping it under `~/.lwdb/` (outside any repo) avoids the leak risk
entirely; if you point `output` back into a repo, gitignore it.
