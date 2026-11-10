package pipeline

import (
	"fmt"
	"time"

	"github.com/ghvstcode/agentfund/worker/internal/policy"
)

// closedWindow returns a one-hour schedule window that does not contain now.
func closedWindow() string {
	h := (time.Now().Hour() + 12) % 24
	return fmt.Sprintf("%02d:00-%02d:00", h, (h+1)%24)
}

func policyBackoff(until time.Time) policy.BackoffState {
	return policy.BackoffState{Attempts: 1, Until: until}
}
