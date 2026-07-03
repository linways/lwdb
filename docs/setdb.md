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
  "output": "/var/www/html/linways/.lwdb/active-db.php",
  "verify": true,
  "includeInto": [
    "/path/to/your/app/conf.php",
    "/path/to/your/app/professional-db-conf.php",
    "/path/to/your/app/ams-autonomous-db-conf.php"
  ]
}
```
- `group` — which lwdb connection group the picker offers (`lwdb servers`).
- `output` — absolute path of the `active-db.php` file to write. **It must be readable by
  whatever user runs the app.** For a web-served Linways app (Apache/nginx/php-fpm as
  `www-data`), put it in a project-level **`.lwdb/`** folder inside the web root, e.g.
  `/var/www/html/linways/.lwdb/active-db.php`. Do **not** use `~/.lwdb/` or any home dir:
  home dirs are `700`, so the web user can't traverse them and the include fails with
  `Permission denied`. A `~/.lwdb/dev/…` path only works if you run the PHP purely from
  the CLI as yourself. `setdb` creates the directory if needed.
- `verify` — check the db exists on the server before writing.
- `includeInto` — the config files you must add the include to (used by `setdb --init`).

**`~/.lwdb/college-codes.json`** — optional `{ "KEY": "CODE" }` map to auto-fill the
college code. (Legacy fallback: `~/.config/linways/college-codes.json`.)

> A repo-committed `.setdb.json` (found by walking up from the cwd) overrides the home
> config if you prefer per-repo config — but the home config is the default and keeps
> the app tree clean.

## One-time setup

1. Have lwdb with your servers: `lwdb servers` (import shared ones with `lwdb import <file.json>`).
2. `~/.lwdb/setdb.json` + `~/.lwdb/college-codes.json` are **seeded automatically** by
   `lwdb install`/`lwdb update` (never overwriting an edited config). Open
   `~/.lwdb/setdb.json` and set two machine-specific things: **`output`** to a
   web-readable project path (e.g. `/var/www/html/linways/.lwdb/active-db.php` — see the
   permission note above; the seeded `~/.lwdb/dev/…` default only works for CLI-run PHP),
   and **`includeInto`** to your app's conf-file paths.
3. Wire the include — run `setdb --init`. It creates the target file and prints the
   exact full-path line to paste into each config file:
   ```php
   include "/var/www/html/linways/.lwdb/active-db.php";
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
plaintext password — gitignore the project `.lwdb/` (or at least `.lwdb/active-db.php`) so
it never lands in version control.
