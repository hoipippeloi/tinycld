# Audit Log

Server-side Go hooks automatically record create, update, and delete events for auditable collections. Logs are written to the `audit_logs` PocketBase collection and visible to org admins at **Settings > Audit Log**.

## What gets logged

Every API-driven create, update, or delete on the collections below produces an audit entry. System-initiated changes (e.g. Go hooks that bypass the API) are not captured.

### Core

| Collection | Label shown | Notes |
|---|---|---|
| `users` | user email | Role/disabled changes and demo-flag flips, written by dedicated hooks (`users_guard.go`) rather than the generic registration so routine profile edits don't spam the log |
| `labels` | label name | |
| `label_assignments` | — | Label applied/removed from a record |
| `settings` | `app:key` | Settings key-value changes |
| `org_pkg_access` | — | Per-member package access overrides |
| `org_pkg_enabled` | — | Package enabled/disabled |

### Contacts

| Collection | Label shown |
|---|---|
| `contacts` | contact name |

### Calendar

| Collection | Label shown |
|---|---|
| `calendar_calendars` | calendar name |
| `calendar_events` | event title |
| `calendar_members` | — |

### Drive

| Collection | Label shown |
|---|---|
| `drive_items` | file/folder name |
| `drive_item_state` | — |
| `drive_shares` | — |

### Mail

| Collection | Label shown |
|---|---|
| `mail_domains` | domain |
| `mail_mailboxes` | email address |
| `mail_messages` | subject |
| `mail_thread_state` | folder |
| `mail_mailbox_members` | — |

## What each entry contains

| Field | Description |
|---|---|
| `org` | The organization the action belongs to |
| `actor` | The user who performed the action (empty for system actions) |
| `action` | `created`, `updated`, or `deleted` |
| `resource_type` | Collection name (e.g. `contacts`, `drive_items`) |
| `resource_id` | The ID of the affected record |
| `resource_label` | Human-readable name (contact name, file name, email subject, etc.) |
| `changes` | For updates: field-level diffs as `{"field": {"before": old, "after": new}}` |
| `snapshot` | For deletes: full record data at time of deletion |
| `ip_address` | Client IP from the request |
| `user_agent` | Browser/client user agent string |
| `metadata` | Extra context (e.g. `{"source": "system"}` for non-request actions) |

## Redacted fields

Sensitive values are never included in diffs or snapshots. If a redacted field changes, the change is still logged, and the diff entry is `{"before": "[redacted]", "after": "[redacted]", "redacted": true}`; a delete snapshot shows `"[redacted]"` for the field. The Audit Log screen shows `[redacted]` in place of the values. A field is redacted when it is:

- hidden (the API never returns it, so the audit log must not either)
- one of `password`, `passwordConfirm`, `tokenKey`, `keys`
- listed in the collection's `CollectionConfig.Redact`

## API rules

- **List/View**: any authenticated user (`@request.auth.id != ""`)
- **Create**: server-only (null) — entries are written by Go hooks, not client code
- **Update**: null — audit logs are append-only
- **Delete**: null — audit logs cannot be deleted through the API

## Architecture

The audit system is a shared Go package at `server/audit/` (`tinycld.org/core/audit`). Each package owns its own audit registration — core collections are registered in `server/audit.go`, and each package registers its collections in its own server module's `Register()` function.

This means packages don't need to modify any central file to add audit logging.

## Adding a new collection to the audit log

In your package's `Register()` function, call `audit.RegisterCollection`:

```go
import "tinycld.org/core/audit"

func Register(app *pocketbase.PocketBase) {
    audit.RegisterCollection(app, "my_collection", &audit.CollectionConfig{
        ExtractLabel: audit.LabelFromField("name"),
    })

    // Pass nil to take the default label extractor.
    audit.RegisterCollection(app, "my_child_collection", nil)
}
```

### API

- **`audit.RegisterCollection(app, name, config)`** — registers create/update/delete hooks for one collection
- **`audit.RegisterCollections(app, names, config)`** — registers the same config for multiple collections
- **`audit.CollectionConfig`** — optional config with:
  - `ExtractLabel` — `func(record *core.Record) string` to extract a display label. If nil, tries `name`, `title`, `label`, `address`. The label is not redacted, so it must not read a `Redact` field.
  - `Redact` — `[]string` of field names whose values stay out of the log (see Redacted fields).
- **`audit.LabelFromField("name")`** — returns a LabelExtractor for a single field
- **`audit.LabelFromFields("app", "key")`** — returns a LabelExtractor that joins fields with `:`

### Steps

1. Add `tinycld.org/core v0.0.0` to your package's `go.mod` with a replace directive (the audit subpackage lives inside core):
   ```
   require tinycld.org/core v0.0.0
   replace tinycld.org/core => ../../../server
   ```
2. Call `audit.RegisterCollection` in your `Register()` function.
3. Run `go mod tidy` and `go build ./...` to verify.
