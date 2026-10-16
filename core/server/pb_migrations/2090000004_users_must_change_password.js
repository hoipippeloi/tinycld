/// <reference path="../pb_data/types.d.ts" />
//
// Set when an owner or admin gives a member a temporary password; the next
// sign-in then asks the member for a new one before it issues a session.
// Only the server writes it (the users field guard allows no client write):
// an admin password change sets it, and the member's own password change or
// password reset clears it.
migrate(
    app => {
        const users = app.findCollectionByNameOrId('users')
        users.fields.add(
            new Field({
                id: 'users_must_change_password',
                name: 'must_change_password',
                type: 'bool',
            })
        )
        app.save(users)
    },
    app => {
        const users = app.findCollectionByNameOrId('users')
        users.fields.removeById('users_must_change_password')
        app.save(users)
    }
)
