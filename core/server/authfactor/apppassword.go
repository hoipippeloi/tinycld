// Package authfactor holds the credential checks that more than one sign-in
// path shares: app passwords, and "does this account have a second factor?".
//
// It is a leaf so davauth (protocol logins), the MFA gate and the passkey
// routes can all depend on it without a cycle.
package authfactor

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// AppPasswordsCollection holds one row per generated app password.
const AppPasswordsCollection = "app_passwords"

const (
	appPasswordLength   = 16
	appPasswordAlphabet = "abcdefghijklmnopqrstuvwxyz"
	appPasswordGroup    = 4
	lastUsedResolution  = time.Hour
)

// GenerateAppPassword returns a new app password for display (four groups of
// four letters) and the hash to store.
//
// Letters only, so a user can type it from a phone screen into a desktop mail
// client. 16 letters is ~75 bits from crypto/rand: too much entropy to guess,
// so a fast SHA-256 is enough and a lookup by hash needs no per-row bcrypt.
func GenerateAppPassword() (display string, hash string, err error) {
	var b strings.Builder
	max := big.NewInt(int64(len(appPasswordAlphabet)))
	for i := 0; i < appPasswordLength; i++ {
		if i > 0 && i%appPasswordGroup == 0 {
			b.WriteByte(' ')
		}
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", "", err
		}
		b.WriteByte(appPasswordAlphabet[n.Int64()])
	}
	display = b.String()
	return display, HashAppPassword(display), nil
}

// HashAppPassword normalizes the password the way a user may type it (any
// case, with or without the group separators) and returns its stored hash.
func HashAppPassword(password string) string {
	sum := sha256.Sum256([]byte(normalizeAppPassword(password)))
	return hex.EncodeToString(sum[:])
}

// MatchAppPassword reports whether password is one of userID's app passwords.
// A match updates the row's last_used, at most once per hour so a busy IMAP
// client does not write on every connection.
func MatchAppPassword(app core.App, userID, password string) bool {
	if userID == "" || !looksLikeAppPassword(password) {
		return false
	}
	row, err := app.FindFirstRecordByFilter(
		AppPasswordsCollection,
		"user = {:user} && hash = {:hash}",
		map[string]any{"user": userID, "hash": HashAppPassword(password)},
	)
	if err != nil || row == nil {
		return false
	}
	touchLastUsed(app, row)
	return true
}

func touchLastUsed(app core.App, row *core.Record) {
	now := time.Now().UTC()
	last := row.GetDateTime("last_used")
	if !last.IsZero() && now.Sub(last.Time()) < lastUsedResolution {
		return
	}
	row.Set("last_used", types.NowDateTime())
	if err := app.SaveNoValidate(row); err != nil {
		log.Warn("could not record app password use", "id", row.Id, "err", err)
	}
}

func normalizeAppPassword(password string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(password) {
		if r == ' ' || r == '-' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func looksLikeAppPassword(password string) bool {
	normalized := normalizeAppPassword(password)
	if len(normalized) != appPasswordLength {
		return false
	}
	for _, r := range normalized {
		if r < 'a' || r > 'z' {
			return false
		}
	}
	return true
}

// RevokeAppPasswords deletes every app password of userID. Called when the
// account's credentials are reset (password change, sign-out everywhere, an
// admin MFA reset): an app password made from a stolen session must not
// outlive the reset that ends that session.
func RevokeAppPasswords(app core.App, userID string) error {
	rows, err := app.FindAllRecords(AppPasswordsCollection, dbx.HashExp{"user": userID})
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := app.Delete(row); err != nil {
			return err
		}
	}
	return nil
}
