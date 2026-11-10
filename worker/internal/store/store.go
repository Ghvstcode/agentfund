// Package store persists the worker's local accounting: token reservations
// and settlements (so day/week caps survive restarts), run history for
// `status`, and rate-limit backoff. It is a single JSON file guarded by an
// advisory file lock, so several worker processes can share it.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	"github.com/ghvstcode/agentfund/worker/internal/policy"
)

// Run statuses beyond the wire report statuses.
const (
	StatusRunning  = "running"
	StatusReleased = "released"
	StatusAborted  = "aborted"
)

// Run is one claimed task as the worker saw it.
type Run struct {
	Claim     string    `json:"claim"`
	Project   string    `json:"project"` // <server>/<slug>
	Task      string    `json:"task"`    // manifest id
	Started   time.Time `json:"started"`
	Finished  time.Time `json:"finished,omitzero"`
	Reserved  int64     `json:"reserved"`
	TokensIn  int64     `json:"tokens_in"`
	TokensOut int64     `json:"tokens_out"`
	Settled   bool      `json:"settled"`
	Status    string    `json:"status"`
	Phase     string    `json:"phase,omitempty"`
	PID       int       `json:"pid,omitempty"`
	Lease     time.Time `json:"lease_expires_at,omitzero"`
	Message   string    `json:"message,omitempty"`
	Branch    string    `json:"branch,omitempty"`
	PRURL     string    `json:"pr_url,omitempty"`
	LogFile   string    `json:"log_file,omitempty"`
	// RetryCleared lifts retry_failed_after for this run (set when the donor re-approves the project).
	RetryCleared bool `json:"retry_cleared,omitempty"`
}

// Counted is how many tokens the run counts against caps: the reservation
// while it is running (or the actual usage if that is somehow larger), the
// actual usage once settled.
func (r Run) Counted() int64 {
	used := r.TokensIn + r.TokensOut
	if r.Settled || used > r.Reserved {
		return used
	}
	return r.Reserved
}

// State is the file content.
type State struct {
	Version int                 `json:"version"`
	Runs    []Run               `json:"runs"`
	Backoff policy.BackoffState `json:"backoff"`
}

// Retention is how long finished runs are kept (must exceed one week).
const Retention = 35 * 24 * time.Hour

// Store is a handle on the state file.
type Store struct{ path string }

// Open returns a store backed by path (created on first write).
func Open(path string) *Store { return &Store{path: path} }

func (s *Store) lock() (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(s.path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, fmt.Errorf("lock state: %w", err)
	}
	return f, nil
}

func (s *Store) read() (*State, error) {
	st := &State{Version: 1}
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, st); err != nil {
		return nil, fmt.Errorf("state file %s is corrupt: %w (move it away to start fresh; caps will reset)", s.path, err)
	}
	return st, nil
}

// Update applies fn to the state under the file lock and writes it back atomically.
func (s *Store) Update(fn func(st *State) error) error {
	lk, err := s.lock()
	if err != nil {
		return err
	}
	defer lk.Close()
	st, err := s.read()
	if err != nil {
		return err
	}
	if err := fn(st); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Snapshot returns a copy of the state.
func (s *Store) Snapshot() (*State, error) {
	lk, err := s.lock()
	if err != nil {
		return nil, err
	}
	defer lk.Close()
	return s.read()
}

// UsageOf computes day/week usage at now, globally and for one project, plus
// the number of unsettled (running) runs.
func UsageOf(st *State, now time.Time, project string) (global, proj policy.Usage, active int) {
	day, week := policy.DayStart(now), policy.WeekStart(now)
	for _, r := range st.Runs {
		if !r.Settled {
			active++
		}
		n := r.Counted()
		if !r.Started.Before(week) {
			global.Week += n
			if r.Project == project {
				proj.Week += n
			}
		}
		if !r.Started.Before(day) {
			global.Day += n
			if r.Project == project {
				proj.Day += n
			}
		}
	}
	return
}

// ErrRefused wraps a policy refusal returned by Reserve's check.
type ErrRefused struct{ Decision policy.Decision }

func (e *ErrRefused) Error() string { return "policy: " + e.Decision.Reason }

// Reserve atomically evaluates the policy against current usage and, when it
// allows, records the run with its full reservation. decide receives the
// usage and the number of running tasks excluding this one.
func (s *Store) Reserve(run Run, now time.Time, decide func(global, proj policy.Usage, active int, backoff policy.BackoffState) policy.Decision) error {
	return s.Update(func(st *State) error {
		prune(st, now)
		for _, r := range st.Runs {
			if r.Claim == run.Claim {
				return fmt.Errorf("claim %s is already recorded", run.Claim)
			}
		}
		g, p, active := UsageOf(st, now, run.Project)
		if d := decide(g, p, active, st.Backoff); !d.Allow {
			return &ErrRefused{Decision: d}
		}
		run.Started, run.Status, run.Settled = now, StatusRunning, false
		st.Runs = append(st.Runs, run)
		return nil
	})
}

func find(st *State, claim string) *Run {
	for i := range st.Runs {
		if st.Runs[i].Claim == claim {
			return &st.Runs[i]
		}
	}
	return nil
}

// Progress records cumulative usage, phase and lease of a running claim.
func (s *Store) Progress(claim string, in, out int64, phase string, lease time.Time) error {
	return s.Update(func(st *State) error {
		r := find(st, claim)
		if r == nil || r.Settled {
			return nil
		}
		r.TokensIn, r.TokensOut = in, out
		if phase != "" {
			r.Phase = phase
		}
		if !lease.IsZero() {
			r.Lease = lease
		}
		return nil
	})
}

// Settle replaces the reservation with the actual usage and final status.
func (s *Store) Settle(claim string, now time.Time, fin Run) error {
	return s.Update(func(st *State) error {
		r := find(st, claim)
		if r == nil {
			return fmt.Errorf("claim %s is not recorded", claim)
		}
		r.TokensIn, r.TokensOut = fin.TokensIn, fin.TokensOut
		r.Settled, r.Finished, r.Phase = true, now, ""
		r.Status, r.Message, r.Branch, r.PRURL = fin.Status, fin.Message, fin.Branch, fin.PRURL
		if fin.LogFile != "" {
			r.LogFile = fin.LogFile
		}
		return nil
	})
}

// SetBackoff stores the rate-limit backoff state.
func (s *Store) SetBackoff(b policy.BackoffState) error {
	return s.Update(func(st *State) error { st.Backoff = b; return nil })
}

// RecoverStale settles runs left "running" by processes that no longer exist
// (crash, kill -9). They are settled at the usage last recorded.
func (s *Store) RecoverStale(now time.Time, alive func(pid int) bool) ([]Run, error) {
	var recovered []Run
	err := s.Update(func(st *State) error {
		for i := range st.Runs {
			r := &st.Runs[i]
			if r.Settled || (r.PID != 0 && alive(r.PID)) {
				continue
			}
			r.Settled, r.Finished, r.Status, r.Phase = true, now, StatusAborted, ""
			r.Message = "worker process exited without settling this run"
			recovered = append(recovered, *r)
		}
		return nil
	})
	return recovered, err
}

func prune(st *State, now time.Time) {
	keep := st.Runs[:0]
	for _, r := range st.Runs {
		if !r.Settled || now.Sub(r.Started) < Retention {
			keep = append(keep, r)
		}
	}
	st.Runs = keep
	sort.SliceStable(st.Runs, func(i, j int) bool { return st.Runs[i].Started.Before(st.Runs[j].Started) })
}

// PIDAlive reports whether a process with the given pid exists.
func PIDAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// LastFailure returns when this machine last finished the given task of a
// project with an outcome that will repeat if nothing changes (failed, timed
// out, over budget, discarded), and that outcome.
func LastFailure(st *State, project, task string) (time.Time, string) {
	var when time.Time
	status := ""
	for _, r := range st.Runs {
		if r.Project != project || r.Task != task || !r.Settled || r.RetryCleared {
			continue
		}
		switch r.Status {
		case "failed", "verification_failed", "budget_exceeded", "timeout":
			if r.Finished.After(when) {
				when, status = r.Finished, r.Status
			}
		}
	}
	return when, status
}

// ClearRetries lifts the retry cooldown of every finished run of a project.
// Token accounting is untouched.
func (s *Store) ClearRetries(project string) (int, error) {
	n := 0
	err := s.Update(func(st *State) error {
		for i := range st.Runs {
			r := &st.Runs[i]
			if r.Project == project && r.Settled && !r.RetryCleared {
				if when, _ := LastFailure(&State{Runs: []Run{*r}}, project, r.Task); !when.IsZero() {
					r.RetryCleared = true
					n++
				}
			}
		}
		return nil
	})
	return n, err
}
