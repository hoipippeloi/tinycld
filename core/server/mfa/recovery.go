package mfa

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"strings"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/authfactor"
)

const (
	recoveryCodeCount = 10
	// Lower-case letters and digits without 0/o and 1/l, which people
	// misread when they copy a code from paper.
	recoveryAlphabet   = "abcdefghijkmnpqrstuvwxyz23456789"
	recoveryCodeLength = 10
)

// newRecoveryCodes returns codes for display ("abcde-fghij") and their hashes
// to store. 10 characters from 32 is 50 bits each; with single use and the
// verify rate limit, a fast hash is enough.
func newRecoveryCodes() (display []string, hashes []string, err error) {
	max := big.NewInt(int64(len(recoveryAlphabet)))
	for i := 0; i < recoveryCodeCount; i++ {
		var b strings.Builder
		for j := 0; j < recoveryCodeLength; j++ {
			if j == recoveryCodeLength/2 {
				b.WriteByte('-')
			}
			n, err := rand.Int(rand.Reader, max)
			if err != nil {
				return nil, nil, err
			}
			b.WriteByte(recoveryAlphabet[n.Int64()])
		}
		code := b.String()
		display = append(display, code)
		hashes = append(hashes, hashRecoveryCode(code))
	}
	return display, hashes, nil
}

func hashRecoveryCode(code string) string {
	normalized := strings.ToLower(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(code)))
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}

func setRecoveryCodes(row *core.Record, hashes []string) {
	row.Set("recovery_codes", hashes)
	row.Set("recovery_remaining", len(hashes))
}

// consumeRecoveryCode removes code from row if it is one of the unused codes.
// Every stored hash is compared, so the time taken does not say which one
// matched. Like checkTOTP, the row is re-read inside the transaction so two
// racing requests cannot both spend the same code. row is updated in place.
func consumeRecoveryCode(app core.App, row *core.Record, code string) error {
	return app.RunInTransaction(func(tx core.App) error {
		fresh, err := tx.FindRecordById(authfactor.TOTPCollection, row.Id)
		if err != nil {
			return errBadCode
		}
		var hashes []string
		if err := json.Unmarshal([]byte(fresh.GetString("recovery_codes")), &hashes); err != nil {
			return errBadCode
		}
		want := []byte(hashRecoveryCode(code))
		match := -1
		for i, h := range hashes {
			if subtle.ConstantTimeCompare([]byte(h), want) == 1 {
				match = i
			}
		}
		if match < 0 {
			return errBadCode
		}
		remaining := append(hashes[:match:match], hashes[match+1:]...)
		setRecoveryCodes(fresh, remaining)
		if err := tx.Save(fresh); err != nil {
			return err
		}
		row.Load(fresh.FieldsData())
		return nil
	})
}
