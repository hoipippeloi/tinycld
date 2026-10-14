/// <reference path="../pb_data/types.d.ts" />
// Second-factor, passkey and admin password changes are audited as events, not as collection
// writes: the routes that make them check a code or a WebAuthn signature first,
// and the log should say what happened ("MFA turned on"), not which row moved.
const SECURITY_ACTIONS = [
    'mfa.enabled',
    'mfa.disabled',
    'mfa.recovery_used',
    'mfa.recovery_regenerated',
    'passkey.added',
    'password.set_by_admin',
    'password.reset_sent',
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
