package mfa

import (
	"crypto/subtle"
	"errors"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"

	"tinycld.org/core/authfactor"
)

const (
	totpPeriod = 30
	totpDigits = otp.DigitsSix
	// totpSkew accepts the code of the step before and after the current one,
	// for a phone clock that is up to 30 seconds off.
	totpSkew = 1
)

var errBadCode = errors.New("mfa: code is not valid")

// Messages the sign-in and settings screens show as they are.
const (
	msgNoTOTP       = "Start the authenticator app setup first."
	msgAlreadyOn    = "The authenticator app is already on."
	msgNotConfirmed = "The authenticator app is not on."
	msgBadCode      = "That code is not correct. Check your app and try again."
)

// newTOTPKey makes a new secret. issuer is the server's host name, so an
// authenticator that holds codes for several servers labels each one.
func newTOTPKey(issuer, account string) (*otp.Key, error) {
	return totp.Generate(totp.GenerateOpts{
		Issuer:      issuer,
		AccountName: account,
		Period:      totpPeriod,
		Digits:      totpDigits,
		Algorithm:   otp.AlgorithmSHA1,
	})
}

// matchStep returns the time step whose code equals code, within the skew.
// SHA-1, six digits and 30 seconds are what every authenticator app supports;
// anything else breaks Google Authenticator and others.
func matchStep(secret, code string, now time.Time) (int64, bool) {
	if len(code) != int(totpDigits) {
		return 0, false
	}
	current := now.Unix() / totpPeriod
	for offset := int64(-totpSkew); offset <= totpSkew; offset++ {
		step := current + offset
		want, err := totp.GenerateCodeCustom(secret, time.Unix(step*totpPeriod, 0), totp.ValidateOpts{
			Period:    totpPeriod,
			Digits:    totpDigits,
			Algorithm: otp.AlgorithmSHA1,
		})
		if err != nil {
			return 0, false
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// findTOTP returns the user's enrollment row, confirmed or not.
func findTOTP(app core.App, userID string) (*core.Record, error) {
	return app.FindFirstRecordByFilter(authfactor.TOTPCollection, "user = {:user}", map[string]any{"user": userID})
}

// checkTOTP verifies code against row and records its step, so the same code
// cannot be used twice: an attacker who sees a code over someone's shoulder
// cannot replay it in the seconds it stays valid.
//
// The row is re-read inside the transaction. PocketBase runs write
// transactions one at a time, so two requests racing with the same code
// cannot both read the old last_step and both pass. row is updated in place.
func checkTOTP(app core.App, row *core.Record, code string, now time.Time) error {
	return app.RunInTransaction(func(tx core.App) error {
		fresh, err := tx.FindRecordById(authfactor.TOTPCollection, row.Id)
		if err != nil {
			return errBadCode
		}
		step, ok := matchStep(fresh.GetString("secret"), code, now)
		if !ok || step <= int64(fresh.GetInt("last_step")) {
			return errBadCode
		}
		fresh.Set("last_step", step)
		if err := tx.Save(fresh); err != nil {
			return err
		}
		row.Load(fresh.FieldsData())
		return nil
	})
}

func isConfirmed(row *core.Record) bool {
	return !row.GetDateTime("enabled_at").IsZero()
}
