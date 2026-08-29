# Privacy

Family System is local-first. The core plugin reads and writes only files inside the current Obsidian Vault through Obsidian APIs. It has no account system, analytics, telemetry, advertisements, remote service, CloudKit integration, bank connection, or embedded AI.

Apple integration is optional, disabled by default, and distributed separately as Beta software. Only after explicit user opt-in may the plugin contact `127.0.0.1:41729`. The pairing credential is session-only and must not be written to the Vault, plugin settings, source code, logs, backups, or release archives.

Portable backups contain the user's selected authority and runtime data and therefore may include sensitive household information. They remain inside the configured Life Core backup directory unless the user moves them.

Uninstalling or disabling the plugin does not delete household data or Apple Reminders. Files removed by plugin workflows use Obsidian's trash interface.

When reporting a problem, use artificial test data. Never attach a real Vault, portable backup, companion `state.json`, pairing credential, personal path, identity document, account reference, transaction, address, or health record.
