// Package policy is the donor's policy engine: a pure function from caps,
// usage, time and task facts to an allow/refuse decision. It is the second
// security boundary (spec/manifest.md §4 step 5): nothing a server or a repo
// says can make it more permissive than the donor configured.
package policy

import (
	"fmt"
	"math/rand"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ghvstcode/agentfund/worker/internal/tokfmt"
)

// Code names the reason for a refusal.
type Code string

// Refusal codes.
const (
	OK              Code = ""
	OutsideSchedule Code = "outside-schedule"
	Backoff         Code = "rate-limit-backoff"
	Concurrency     Code = "max-concurrent"
	GitHost         Code = "git-host-not-allowed"
	TaskTooLarge    Code = "task-ceiling"
	NewProjectCap   Code = "new-project-ceiling"
	DailyCap        Code = "daily-cap"
	WeeklyCap       Code = "weekly-cap"
	ProjectDailyCap Code = "project-daily-cap"
	ProjectWeekCap  Code = "project-weekly-cap"
	ServerDailyCap  Code = "server-daily-cap"
	InvalidTask     Code = "invalid-task"
)

// Window is a daily local-time window [Start, End) in minutes after midnight.
// End < Start wraps past midnight.
type Window struct{ Start, End int }

// ParseWindow parses "HH:MM-HH:MM".
func ParseWindow(s string) (Window, error) {
	a, b, ok := strings.Cut(strings.TrimSpace(s), "-")
	if !ok {
		return Window{}, fmt.Errorf("schedule window %q: want HH:MM-HH:MM", s)
	}
	start, err1 := parseClock(a)
	end, err2 := parseClock(b)
	if err1 != nil || err2 != nil {
		return Window{}, fmt.Errorf("schedule window %q: want HH:MM-HH:MM", s)
	}
	if start == end {
		return Window{}, fmt.Errorf("schedule window %q is empty (start equals end); use [] for \"always\"", s)
	}
	return Window{Start: start, End: end}, nil
}

func parseClock(s string) (int, error) {
	h, m, ok := strings.Cut(strings.TrimSpace(s), ":")
	if !ok || len(h) != 2 || len(m) != 2 {
		return 0, fmt.Errorf("bad clock %q", s)
	}
	hh, err1 := strconv.Atoi(h)
	mm, err2 := strconv.Atoi(m)
	if err1 != nil || err2 != nil || hh < 0 || mm < 0 || mm > 59 || hh > 24 || (hh == 24 && mm != 0) {
		return 0, fmt.Errorf("bad clock %q", s)
	}
	return (hh*60 + mm) % (24 * 60), nil
}

// ParseSchedule parses a list of windows. An empty list means "always".
func ParseSchedule(items []string) ([]Window, error) {
	out := make([]Window, 0, len(items))
	for _, s := range items {
		w, err := ParseWindow(s)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, nil
}

// Contains reports whether the local wall-clock time of t is inside the window.
func (w Window) Contains(t time.Time) bool {
	m := t.Hour()*60 + t.Minute()
	if w.Start < w.End {
		return m >= w.Start && m < w.End
	}
	return m >= w.Start || m < w.End
}

// InSchedule reports whether t falls in any window (no windows = always).
func InSchedule(ws []Window, t time.Time) bool {
	if len(ws) == 0 {
		return true
	}
	for _, w := range ws {
		if w.Contains(t) {
			return true
		}
	}
	return false
}

// NextOpen returns how long until the schedule next opens (0 when open now).
func NextOpen(ws []Window, t time.Time) time.Duration {
	if InSchedule(ws, t) {
		return 0
	}
	now := t.Hour()*60 + t.Minute()
	best := 24 * 60
	for _, w := range ws {
		d := (w.Start - now + 24*60) % (24 * 60)
		if d < best {
			best = d
		}
	}
	return time.Duration(best)*time.Minute - time.Duration(t.Second())*time.Second
}

// DayStart returns local midnight of t's calendar day.
func DayStart(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}

// WeekStart returns local midnight of the Monday of t's week.
func WeekStart(t time.Time) time.Time {
	d := DayStart(t)
	back := (int(d.Weekday()) + 6) % 7 // Monday = 0
	return d.AddDate(0, 0, -back)
}

// Limits is an effective set of caps. Zero means "no cap" for token amounts.
type Limits struct {
	TokensPerDay               int64
	TokensPerWeek              int64
	MaxTokensPerTask           int64
	NewProjectMaxTokensPerTask int64
	Schedule                   []Window
	MaxConcurrent              int
	AllowedGitHosts            []string
}

// ProjectLimits are the optional per-project overrides (nil = inherit).
type ProjectLimits struct {
	TokensPerDay     *int64
	TokensPerWeek    *int64
	MaxTokensPerTask *int64
	Schedule         *[]Window
}

// Usage is tokens already counted in the current day and week. Reserved
// (not yet settled) tokens of running tasks are included.
type Usage struct{ Day, Week int64 }

// Trust is what the server publishes about the project (protocol.md §8).
// Unknown tiers are treated as "new".
type Trust struct {
	Tier             string
	MaxTokensPerTask *int64
	MaxTokensPerDay  *int64
}

// TierEstablished is the only tier that lifts the new-project ceiling.
const TierEstablished = "established"

// Input is everything a decision depends on.
type Input struct {
	Now          time.Time
	Global       Limits
	Project      ProjectLimits
	GlobalUsage  Usage
	ProjectUsage Usage
	Active       int // tasks currently running (not counting the one being decided)
	BackoffUntil time.Time
	BackoffCause string // what started the backoff, e.g. "a rate limit"; "" = a rate limit
	Trust        Trust
	// Task facts.
	MaxTokens int64
	RepoURL   string
}

// Decision is the outcome.
type Decision struct {
	Allow  bool
	Code   Code
	Reason string
	// RetryAfter hints when the same decision might change (schedule/backoff); 0 = unknown.
	RetryAfter time.Duration
}

func refuse(code Code, retry time.Duration, format string, a ...any) Decision {
	return Decision{Code: code, Reason: fmt.Sprintf(format, a...), RetryAfter: retry}
}

func minPos(vals ...int64) int64 {
	var out int64
	for _, v := range vals {
		if v > 0 && (out == 0 || v < out) {
			out = v
		}
	}
	return out
}

func deref(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// Sources of a cap, as named in refusal messages.
const (
	SrcGlobalTask  = "global.max_tokens_per_task"
	SrcProjectTask = "this project's max_tokens_per_task"
	SrcNewProject  = "global.new_project_max_tokens_per_task"
	SrcServerTask  = "the cap the server publishes for this project (trust.max_tokens_per_task)"
)

// TaskCeiling returns the effective per-task ceiling (0 = none) and whether
// the new-project ceiling is what binds.
func TaskCeiling(in Input) (ceiling int64, newProject bool) {
	c, src := TaskCeilingSource(in)
	return c, src == SrcNewProject || (in.Trust.Tier != TierEstablished && src == SrcServerTask) || (in.Trust.Tier != TierEstablished && c == 0)
}

// TaskCeilingSource returns the effective per-task ceiling and which setting
// it comes from. A per-project ceiling can only tighten the global one (an
// explicit 0 override does not remove it); the new-project ceiling applies
// unless the server reports the project as established; a server-published
// cap only ever tightens.
func TaskCeilingSource(in Input) (ceiling int64, source string) {
	type cand struct {
		v   int64
		src string
	}
	cands := []cand{{in.Global.MaxTokensPerTask, SrcGlobalTask}, {deref(in.Project.MaxTokensPerTask), SrcProjectTask}}
	if in.Trust.Tier != TierEstablished {
		cands = append(cands, cand{in.Global.NewProjectMaxTokensPerTask, SrcNewProject})
	}
	cands = append(cands, cand{serverCap(in.Trust.MaxTokensPerTask), SrcServerTask})
	for _, c := range cands {
		if c.v > 0 && (ceiling == 0 || c.v < ceiling) {
			ceiling, source = c.v, c.src
		}
	}
	return ceiling, source
}

// serverCap sanitises a server-published cap: only positive values tighten.
func serverCap(p *int64) int64 {
	if p == nil || *p <= 0 {
		return 0
	}
	return *p
}

// GitHostOf extracts the host a repo URL would contact. file:// URLs map to
// the pseudo-host "file", which must be allowed explicitly.
func GitHostOf(repoURL string) (string, error) {
	u, err := url.Parse(repoURL)
	if err != nil {
		return "", fmt.Errorf("unparsable repo URL")
	}
	switch u.Scheme {
	case "https":
		if u.Hostname() == "" || u.User != nil {
			return "", fmt.Errorf("repo URL must be https://host/path without credentials")
		}
		return strings.ToLower(u.Hostname()), nil
	case "file":
		if u.Host != "" && u.Host != "localhost" {
			return "", fmt.Errorf("file:// repo URL must not name a host")
		}
		return "file", nil
	}
	return "", fmt.Errorf("repo URL scheme %q is not allowed (https only)", u.Scheme)
}

// HostAllowed reports whether the repo URL's host is in the allow-list.
func HostAllowed(allowed []string, repoURL string) (string, bool) {
	h, err := GitHostOf(repoURL)
	if err != nil {
		return "", false
	}
	for _, a := range allowed {
		if strings.ToLower(strings.TrimSpace(a)) == h {
			return h, true
		}
	}
	return h, false
}

// Evaluate decides whether a task with the given facts may start now. The
// task's full max_tokens is what is checked against the remaining budget
// (reservation); settle the actual usage afterwards.
func Evaluate(in Input) Decision {
	if in.MaxTokens <= 0 {
		return refuse(InvalidTask, 0, "task has no positive max_tokens")
	}
	if !in.BackoffUntil.IsZero() && in.Now.Before(in.BackoffUntil) {
		d := in.BackoffUntil.Sub(in.Now)
		cause := in.BackoffCause
		if cause == "" {
			cause = CauseRateLimit
		}
		return refuse(Backoff, d, "backing off after %s for another %s", cause, d.Round(time.Second))
	}
	sched := in.Global.Schedule
	if in.Project.Schedule != nil {
		sched = *in.Project.Schedule
	}
	if !InSchedule(sched, in.Now) {
		wait := NextOpen(sched, in.Now)
		return refuse(OutsideSchedule, wait, "outside the schedule (global.schedule, or this project's schedule, or --schedule); next window opens in %s", wait.Round(time.Minute))
	}
	maxc := in.Global.MaxConcurrent
	if maxc < 1 {
		maxc = 1
	}
	if in.Active >= maxc {
		return refuse(Concurrency, 0, "%d task(s) already running (global.max_concurrent %d)", in.Active, maxc)
	}
	if h, ok := HostAllowed(in.Global.AllowedGitHosts, in.RepoURL); !ok {
		return refuse(GitHost, 0, "git host %q of %q is not in global.allowed_git_hosts", h, in.RepoURL)
	}
	if ceiling, src := TaskCeilingSource(in); ceiling > 0 && in.MaxTokens > ceiling {
		code := TaskTooLarge
		if _, isNew := TaskCeiling(in); isNew {
			code = NewProjectCap
		}
		return refuse(code, 0, "task max_tokens %s exceeds %s (%s)", tokfmt.Format(in.MaxTokens), src, tokfmt.Format(ceiling))
	}
	type capCheck struct {
		code  Code
		name  string
		limit int64
		used  int64
		reset time.Time
	}
	tomorrow := DayStart(in.Now).AddDate(0, 0, 1)
	nextWeek := WeekStart(in.Now).AddDate(0, 0, 7)
	checks := []capCheck{
		{DailyCap, "global.tokens_per_day", in.Global.TokensPerDay, in.GlobalUsage.Day, tomorrow},
		{WeeklyCap, "global.tokens_per_week", in.Global.TokensPerWeek, in.GlobalUsage.Week, nextWeek},
		{ProjectDailyCap, "this project's tokens_per_day", deref(in.Project.TokensPerDay), in.ProjectUsage.Day, tomorrow},
		{ProjectWeekCap, "this project's tokens_per_week", deref(in.Project.TokensPerWeek), in.ProjectUsage.Week, nextWeek},
		{ServerDailyCap, "the daily cap the server publishes for this project (trust.max_tokens_per_day)", serverCap(in.Trust.MaxTokensPerDay), in.ProjectUsage.Day, tomorrow},
	}
	for _, c := range checks {
		if c.limit <= 0 {
			continue
		}
		if c.used+in.MaxTokens > c.limit {
			return refuse(c.code, c.reset.Sub(in.Now),
				"reserving %s tokens would exceed %s (%s used of %s)", tokfmt.Format(in.MaxTokens), c.name, tokfmt.Exact(c.used), tokfmt.Format(c.limit))
		}
	}
	return Decision{Allow: true}
}

// BackoffState tracks consecutive rate limits and unreachable-API runs; both
// mean "not now" for every task, so they share one backoff.
type BackoffState struct {
	Attempts int
	Until    time.Time
	// Cause is what started the latest backoff (CauseRateLimit or
	// CauseUnreachable); empty in state files written before it existed.
	Cause string `json:",omitempty"`
}

// Backoff causes, phrased to follow "backing off after".
const (
	CauseRateLimit   = "a rate limit"
	CauseUnreachable = "the model API was unreachable"
)

// Backoff bounds.
const (
	BackoffBase = 5 * time.Minute
	BackoffMax  = 4 * time.Hour
)

// NextBackoff returns the state after another rate limit at now. The delay
// doubles per consecutive hit, is capped, never ends before resetAt when the
// provider told us when the limit resets, and carries ±20% jitter (rnd in [0,1)).
func NextBackoff(prev BackoffState, now, resetAt time.Time, rnd float64) BackoffState {
	attempts := prev.Attempts + 1
	d := BackoffBase
	for i := 1; i < attempts && d < BackoffMax; i++ {
		d *= 2
	}
	if d > BackoffMax {
		d = BackoffMax
	}
	jitter := time.Duration((rnd*0.4 - 0.2) * float64(d))
	until := now.Add(d + jitter)
	if resetAt.After(now) {
		floor := resetAt.Add(time.Duration(rnd * float64(time.Minute)))
		if floor.After(until) {
			until = floor
		}
	}
	return BackoffState{Attempts: attempts, Until: until}
}

// Jitter returns a random number in [0,1) for NextBackoff.
func Jitter() float64 { return rand.Float64() }
