/// <reference path="../pb_data/types.d.ts" />
//
// A person signs in with their username, or with an address a package hosts
// (core/server/authidentity resolves it). The account email is for reaching
// the person — invites and password resets — and stops being a sign-in name:
// the deployment does not own that address and the person may change it.
migrate(
    app => {
        const users = app.findCollectionByNameOrId('users')
        users.passwordAuth.identityFields = ['username']
        app.save(users)
    },
    app => {
        const users = app.findCollectionByNameOrId('users')
        users.passwordAuth.identityFields = ['username', 'email']
        app.save(users)
    }
)
