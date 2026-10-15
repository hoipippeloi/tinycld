package passkey

import (
	"encoding/base64"
	"encoding/json"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"tinycld.org/core/authfactor"
)

const usersCollection = "users"

// account adapts a users record and its passkey rows to webauthn.User.
//
// The user handle is the record id. It is random, not personal data, and it
// lets a discoverable login find the account without a username.
type account struct {
	record *core.Record
	rows   []*core.Record
	creds  []webauthn.Credential
}

func loadAccount(app core.App, user *core.Record) (*account, error) {
	rows, err := app.FindAllRecords(authfactor.PasskeysCollection, userFilter(user.Id))
	if err != nil {
		return nil, err
	}
	a := &account{record: user, rows: rows}
	for _, row := range rows {
		var cred webauthn.Credential
		if err := json.Unmarshal([]byte(row.GetString("credential")), &cred); err != nil {
			log.Warn("unreadable passkey credential skipped", "id", row.Id, "err", err)
			continue
		}
		a.creds = append(a.creds, cred)
	}
	return a, nil
}

func (a *account) WebAuthnID() []byte                         { return []byte(a.record.Id) }
func (a *account) WebAuthnName() string                       { return a.record.GetString("email") }
func (a *account) WebAuthnCredentials() []webauthn.Credential { return a.creds }

func (a *account) WebAuthnDisplayName() string {
	if name := a.record.GetString("name"); name != "" {
		return name
	}
	return a.record.GetString("email")
}

func (a *account) descriptors() []protocol.CredentialDescriptor {
	out := make([]protocol.CredentialDescriptor, 0, len(a.creds))
	for _, c := range a.creds {
		out = append(out, c.Descriptor())
	}
	return out
}

// rowFor returns the passkey row that holds credential id.
func (a *account) rowFor(id []byte) *core.Record {
	want := encodeID(id)
	for _, row := range a.rows {
		if row.GetString("credential_id") == want {
			return row
		}
	}
	return nil
}

// recordUse stores the authenticator's new sign count and the time of use.
func recordUse(app core.App, row *core.Record, cred *webauthn.Credential) error {
	row.Set("credential", cred)
	row.Set("last_used", types.NowDateTime())
	return app.Save(row)
}

func encodeID(id []byte) string {
	return base64.RawURLEncoding.EncodeToString(id)
}
