/// <reference path="../pb_data/types.d.ts" />
// Second-factor and passkey changes are audited as events, not as collection
// writes: the routes that make them check a code or a WebAuthn signature first,
// and the log should say what happened ("MFA turned on"), not which row moved.
const SECURITY_ACTIONS = [
    'mfa.enabled',
    'mfa.disabled',
    'mfa.recovery_used',
    'mfa.recovery_regenerated',
    'mfa.reset',
    'passkey.added',
]

migrate(
    app => {
        const collection = app.findCollectionByNameOrId('audit_logs')
        const field = collection.fields.getById('al_action')
        field.values = [...field.values.filter(v => !SECURITY_ACTIONS.includes(v)), ...SECURITY_ACTIONS]
        app.save(collection)
    },
    app => {
        const collection = app.findCollectionByNameOrId('audit_logs')
        const field = collection.fields.getById('al_action')
        field.values = field.values.filter(v => !SECURITY_ACTIONS.includes(v))
        app.save(collection)
    }
)
