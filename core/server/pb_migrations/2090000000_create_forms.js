/// <reference path="../pb_data/types.d.ts" />
// Form definitions a package's records carry (see
// docs/superpowers/specs/2026-10-14-forms-engine-design.md).
//
// List and view need a session. A package whose screens render a form for an
// anonymous visitor (a share link) registers the clause that vouches for that
// visitor (forms.RegisterPublicReader), and core composes it into these two
// rules on serve. Core cannot name the package, so it cannot write that
// clause here. SIGNED_IN must equal signedInReadRule in
// core/server/forms/public_readers.go: a boot with no clause then saves
// nothing, and a test holds the two equal.
const SIGNED_IN = '@request.auth.id != "" && @request.auth.disabled != true'
const ADMIN = `${SIGNED_IN} && (@request.auth.role = "owner" || @request.auth.role = "admin")`

migrate(
    app => {
        const forms = new Collection({
            id: 'pbc_forms_01',
            name: 'forms',
            type: 'base',
            system: false,
            listRule: SIGNED_IN,
            viewRule: SIGNED_IN,
            createRule: ADMIN,
            updateRule: ADMIN,
            deleteRule: ADMIN,
            fields: [
                { id: 'forms_host', name: 'host', type: 'text', required: true, max: 120 },
                { id: 'forms_name', name: 'name', type: 'text', required: true, max: 120 },
                { id: 'forms_slug', name: 'slug', type: 'text', required: true, max: 60, pattern: '^[a-z][a-z0-9_-]*$' },
                { id: 'forms_definition', name: 'definition', type: 'json', required: true, maxSize: 1000000 },
                { id: 'forms_is_default', name: 'is_default', type: 'bool' },
                { id: 'forms_archived', name: 'archived', type: 'bool' },
                { id: 'forms_order', name: 'order', type: 'number' },
                { id: 'forms_created', name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
                { id: 'forms_updated', name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
            ],
            indexes: [
                'CREATE UNIQUE INDEX `idx_forms_host_slug` ON `forms` (`host`, `slug`)',
                'CREATE INDEX `idx_forms_host_order` ON `forms` (`host`, `order`)',
            ],
        })
        app.save(forms)
    },
    app => {
        try {
            app.delete(app.findCollectionByNameOrId('forms'))
        } catch (e) {
            // may not exist
        }
    }
)
