# 5. A JSON file as the database

**Status:** accepted

## Context

State is small: a few dozen apps and domains, settings, and the last 30 deploy records per app. There is exactly one writer, the Homeport process.

## Decision

Keep everything in memory and persist it to `data/db.json`. Writes are serialized and coalesced (a burst of saves becomes one write of the latest state) and atomic (write a temp file, then rename). Deploy logs are separate append-only files.

## Consequences

- No database to install, migrate or back up separately. Backup is copying a folder; the file is readable and diffable.
- Settings gain new fields by merging stored values over defaults on load, so upgrades need no migration step.
- An early version wrote concurrently and occasionally failed the rename under load; serializing writes fixed it, and that is now the only write path.
- This would not scale to many writers or large histories. If that ever matters, the store module is the only place that changes.
