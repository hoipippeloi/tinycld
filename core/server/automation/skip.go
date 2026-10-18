package automation

import "errors"

// skipError is the error Skip returns. The engine records an action that
// returns it as "skipped" with the reason, not as "error".
type skipError struct {
	reason string
}

func (e *skipError) Error() string { return "skipped: " + e.reason }

// Skip is what an action returns when it chose not to act: the run history
// shows "Skipped" and the reason. A skip is not a failure, so it does not
// count toward auto-disable. The reason is for the rule's owner to read.
// Wrapping it (fmt.Errorf("…: %w", Skip(…))) keeps it a skip.
func Skip(reason string) error {
	return &skipError{reason: reason}
}

// IsSkip reports whether err is, or wraps, a Skip.
func IsSkip(err error) bool {
	_, ok := skipReason(err)
	return ok
}

func skipReason(err error) (string, bool) {
	var skip *skipError
	if errors.As(err, &skip) {
		return skip.reason, true
	}
	return "", false
}
