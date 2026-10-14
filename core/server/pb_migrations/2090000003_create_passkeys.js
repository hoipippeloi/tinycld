/// <reference path="../pb_data/types.d.ts" />
//
// Passkeys (WebAuthn credentials), one row per registered authenticator. A
// passkey signs in on its own and also counts as the account's second factor.
//
// Rows are created only by /api/account/passkeys/register/finish, after the
// server has checked the attestation. `credential` holds the go-webauthn
// credential (public key, sign count, flags) and `credential_id` the lookup
// key; both are hidden and cannot be written through the API. The owner may
// rename (`name`) or remove a passkey.
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
        const renameOnly =
            `${own} && @request.body.user:isset = false && @request.body.credential:isset = false && ` +
            '@request.body.credential_id:isset = false && @request.body.last_used:isset = false'

        const collection = new Collection({
            id: 'pbc_passkeys_01',
            name: 'passkeys',
            type: 'base',
            system: false,
            listRule: `(${own}) || (${adminOver})`,
            viewRule: `(${own}) || (${adminOver})`,
            createRule: null,
            updateRule: renameOnly,
            deleteRule: `(${own}) || (${adminOver})`,
            fields: [
                {
                    id: 'passkeys_user',
                    name: 'user',
                    type: 'relation',
                    required: true,
                    collectionId: '_pb_users_auth_',
                    cascadeDelete: true,
                    maxSelect: 1,
                },
                { id: 'passkeys_name', name: 'name', type: 'text', required: true, min: 1, max: 100 },
                { id: 'passkeys_credential_id', name: 'credential_id', type: 'text', required: true, hidden: true },
                { id: 'passkeys_credential', name: 'credential', type: 'json', required: true, hidden: true, maxSize: 20000 },
                { id: 'passkeys_last_used', name: 'last_used', type: 'date', required: false },
                { id: 'passkeys_created', name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
                { id: 'passkeys_updated', name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
            ],
            indexes: [
                'CREATE UNIQUE INDEX `idx_passkeys_credential_id` ON `passkeys` (`credential_id`)',
                'CREATE INDEX `idx_passkeys_user` ON `passkeys` (`user`)',
            ],
        })
        app.save(collection)
    },
    app => {
        try {
            app.delete(app.findCollectionByNameOrId('passkeys'))
        } catch (e) {
            // may not exist
        }
    }
)
