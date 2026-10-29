/// <reference path="../pb_data/types.d.ts" />
//
// An automatic update whose build fails changes nothing and is tried again in
// the next window, so without a record nobody hears of it. A `failed` row
// remembers the version set that failed and when the owners were last told.
migrate(
    app => {
        const state = app.findCollectionByNameOrId('autoupgrade_state')
        state.fields.getByName('kind').values = ['pause', 'blocked', 'failed']
        app.save(state)
    },
    app => {
        app.db().newQuery("DELETE FROM autoupgrade_state WHERE kind = 'failed'").execute()
        const state = app.findCollectionByNameOrId('autoupgrade_state')
        state.fields.getByName('kind').values = ['pause', 'blocked']
        app.save(state)
    }
)
