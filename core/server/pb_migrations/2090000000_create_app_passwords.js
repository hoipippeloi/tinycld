/// <reference path="../pb_data/types.d.ts" />
//
// App passwords: generated, per-device passwords for protocol clients (IMAP,
// SMTP, CalDAV, CardDAV, WebDAV). Those clients cannot answer a second-factor
// prompt, so once an account has one they sign in with an app password and
// the account password stops working for them.
//
// Rows are created only by POST /api/account/app-passwords, which returns the
// plaintext once; `hash` is hidden so it never leaves the server.
migrate(
    app => {
        const own = '@request.auth.id != "" && @request.auth.disabled != true && user = @request.auth.id'

        const collection = new Collection({
            id: 'pbc_app_passwords_01',
            name: 'app_passwords',
            type: 'base',
            system: false,
            listRule: own,
            viewRule: own,
            createRule: null,
            updateRule: null,
            deleteRule: own,
            fields: [
                {
                    id: 'app_passwords_user',
                    name: 'user',
                    type: 'relation',
                    required: true,
                    collectionId: '_pb_users_auth_',
                    cascadeDelete: true,
                    maxSelect: 1,
                },
                { id: 'app_passwords_name', name: 'name', type: 'text', required: true, min: 1, max: 100 },
                { id: 'app_passwords_hash', name: 'hash', type: 'text', required: true, hidden: true },
                { id: 'app_passwords_last_used', name: 'last_used', type: 'date', required: false },
                { id: 'app_passwords_created', name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
                { id: 'app_passwords_updated', name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
            ],
            indexes: [
                'CREATE UNIQUE INDEX `idx_app_passwords_hash` ON `app_passwords` (`hash`)',
                'CREATE INDEX `idx_app_passwords_user` ON `app_passwords` (`user`)',
            ],
        })
        app.save(collection)
    },
    app => {
        try {
            app.delete(app.findCollectionByNameOrId('app_passwords'))
        } catch (e) {
            // may not exist
        }
    }
)
