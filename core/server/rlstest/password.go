package rlstest

import (
	"sync"

	"github.com/pocketbase/pocketbase/core"
	"golang.org/x/crypto/bcrypt"
)

// SetPassword sets an auth record's password as record.SetPassword does, but
// hashes each password only once per test binary. Suites create a few users
// per test, and bcrypt at the collection's cost is slow enough under -race to
// push a package of several hundred tests past go test's 10-minute limit.
//
// The hash is a real one at the collection's cost, so ValidatePassword and a
// password sign-in accept the password as before.
func SetPassword(record *core.Record, password string) {
	cost := bcrypt.DefaultCost
	if f, ok := record.Collection().Fields.GetByName(core.FieldNamePassword).(*core.PasswordField); ok && f.Cost > 0 {
		cost = f.Cost
	}
	record.SetRaw(core.FieldNamePassword, &core.PasswordFieldValue{
		Plain: password,
		Hash:  passwordHash(password, cost),
	})
}

type passwordKey struct {
	password string
	cost     int
}

var passwordHashes sync.Map // passwordKey -> func() string

func passwordHash(password string, cost int) string {
	once, _ := passwordHashes.LoadOrStore(passwordKey{password, cost}, sync.OnceValue(func() string {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), cost)
		if err != nil {
			panic("rlstest: hash password: " + err.Error())
		}
		return string(hash)
	}))
	return once.(func() string)()
}
