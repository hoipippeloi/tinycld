/// <reference path="../pb_data/types.d.ts" />
// Offboarding writes one summary row per leaver (offboard.writeOffboardAudit).
// The action select did not list these values, so the save failed and the
// offboard left no trace in the log.
const OFFBOARD_ACTIONS = [
    'account_offboard.delete_data',
    'account_offboard.reassign',
    'account_offboard.keep',
]

migrate(
    app => {
        const collection = app.findCollectionByNameOrId('audit_logs')
        const field = collection.fields.getById('al_action')
        field.values = [...field.values.filter(v => !OFFBOARD_ACTIONS.includes(v)), ...OFFBOARD_ACTIONS]
        app.save(collection)
    },
    app => {
        const collection = app.findCollectionByNameOrId('audit_logs')
        const field = collection.fields.getById('al_action')
        field.values = field.values.filter(v => !OFFBOARD_ACTIONS.includes(v))
        app.save(collection)
    }
)
