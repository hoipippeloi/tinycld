/// <reference path="../pb_data/types.d.ts" />
//
// Authenticator-app (TOTP) enrollment, at most one row per user. A row with an
// empty `enabled_at` is a setup the user started but has not confirmed with a
// code; it does not count as a second factor.
//
// Every create and update goes through /api/account/mfa/*, which checks a code
// first. The only open write is an owner or admin removing another member's
// row (see adminOver). `secret`, `recovery_codes` and `last_step` are hidden:
// the owner can see that MFA is on and how many recovery codes are left, but
// the secret itself never leaves the server after setup.
migrate(
    app => {
        const own = '@request.auth.id != "" && @request.auth.disabled != true && user = @request.auth.id'
        // An owner or admin may see and remove another member's rows, for a
        // member who lost their phone or recovery codes. Never their own (that
        // goes through the routes that ask for a code), and an admin never an
        // owner's, so an admin cannot take over an owner account.
        const adminOver =
            '@request.auth.id != "" && @request.auth.disabled != true && user != @request.auth.id && ' +
            '(@request.auth.role = "owner" || (@request.auth.role = "admin" && user.role != "owner"))'

        const collection = new Collection({
            id: 'pbc_mfa_totp_01',
            name: 'mfa_totp',
            type: 'base',
            system: false,
            listRule: `(${own}) || (${adminOver})`,
            viewRule: `(${own}) || (${adminOver})`,
            createRule: null,
            updateRule: null,
            deleteRule: adminOver,
            fields: [
                {
                    id: 'mfa_totp_user',
                    name: 'user',
                    type: 'relation',
                    required: true,
                    collectionId: '_pb_users_auth_',
                    cascadeDelete: true,
                    maxSelect: 1,
                },
                { id: 'mfa_totp_secret', name: 'secret', type: 'text', required: true, hidden: true },
                { id: 'mfa_totp_recovery_codes', name: 'recovery_codes', type: 'json', hidden: true, maxSize: 4000 },
                { id: 'mfa_totp_recovery_remaining', name: 'recovery_remaining', type: 'number', onlyInt: true, min: 0 },
                { id: 'mfa_totp_last_step', name: 'last_step', type: 'number', onlyInt: true, min: 0, hidden: true },
                { id: 'mfa_totp_enabled_at', name: 'enabled_at', type: 'date', required: false },
                { id: 'mfa_totp_created', name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
                { id: 'mfa_totp_updated', name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
            ],
            indexes: ['CREATE UNIQUE INDEX `idx_mfa_totp_user` ON `mfa_totp` (`user`)'],
        })
        app.save(collection)
    },
    app => {
        try {
            app.delete(app.findCollectionByNameOrId('mfa_totp'))
        } catch (e) {
            // may not exist
        }
    }
)
