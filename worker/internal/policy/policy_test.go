package policy

import (
	"testing"
	"time"
)

func p64(v int64) *int64 { return &v }

func at(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04:05", s, time.Local)
	if err != nil {
		panic(err)
	}
	return t
}

func sched(t *testing.T, items ...string) []Window {
	t.Helper()
	ws, err := ParseSchedule(items)
	if err != nil {
		t.Fatal(err)
	}
	return ws
}

func base() Input {
	return Input{
		Now: at("2026-10-07 12:00:00"), // a Wednesday
		Global: Limits{
			TokensPerDay: 10_000_000, TokensPerWeek: 40_000_000, MaxTokensPerTask: 5_000_000,
			NewProjectMaxTokensPerTask: 2_000_000, MaxConcurrent: 1, AllowedGitHosts: []string{"github.com"},
		},
		Trust:     Trust{Tier: TierEstablished},
		MaxTokens: 1_000_000,
		RepoURL:   "https://github.com/example/hello",
	}
}

func TestEvaluateCaps(t *testing.T) {
	cases := []struct {
		name string
		mut  func(in *Input)
		want Code
	}{
		{"allowed", func(in *Input) {}, OK},
		{"zero max_tokens", func(in *Input) { in.MaxTokens = 0 }, InvalidTask},
		{"negative max_tokens", func(in *Input) { in.MaxTokens = -5 }, InvalidTask},

		// Task ceiling boundary.
		{"task at ceiling", func(in *Input) { in.MaxTokens = 5_000_000 }, OK},
		{"task one above ceiling", func(in *Input) { in.MaxTokens = 5_000_001 }, TaskTooLarge},
		{"no ceiling configured", func(in *Input) { in.Global.MaxTokensPerTask = 0; in.MaxTokens = 9_000_000 }, OK},
		{"project ceiling tightens", func(in *Input) { in.Project.MaxTokensPerTask = p64(500_000) }, TaskTooLarge},
		{"project ceiling at boundary", func(in *Input) { in.Project.MaxTokensPerTask = p64(1_000_000) }, OK},
		{"project ceiling cannot loosen global", func(in *Input) {
			in.Project.MaxTokensPerTask = p64(50_000_000)
			in.MaxTokens = 6_000_000
		}, TaskTooLarge},
		{"project ceiling 0 does not remove global", func(in *Input) {
			in.Project.MaxTokensPerTask = p64(0)
			in.MaxTokens = 6_000_000
		}, TaskTooLarge},

		// New-project ceiling.
		{"new project at new ceiling", func(in *Input) { in.Trust.Tier = "new"; in.MaxTokens = 2_000_000 }, OK},
		{"new project above new ceiling", func(in *Input) { in.Trust.Tier = "new"; in.MaxTokens = 2_000_001 }, NewProjectCap},
		{"established project may exceed new ceiling", func(in *Input) { in.MaxTokens = 2_000_001 }, OK},
		{"unknown tier is treated as new", func(in *Input) { in.Trust.Tier = "platinum"; in.MaxTokens = 3_000_000 }, NewProjectCap},
		{"empty tier is treated as new", func(in *Input) { in.Trust.Tier = ""; in.MaxTokens = 3_000_000 }, NewProjectCap},
		{"server cap tighter than donor", func(in *Input) {
			in.Trust = Trust{Tier: "new", MaxTokensPerTask: p64(500_000)}
		}, NewProjectCap},
		{"server cap at boundary", func(in *Input) {
			in.Trust = Trust{Tier: "new", MaxTokensPerTask: p64(1_000_000)}
		}, OK},
		{"server cap looser than donor never loosens", func(in *Input) {
			in.Trust = Trust{Tier: "new", MaxTokensPerTask: p64(900_000_000)}
			in.MaxTokens = 2_000_001
		}, NewProjectCap},
		{"server claims established with huge cap; donor ceiling holds", func(in *Input) {
			in.Trust = Trust{Tier: TierEstablished, MaxTokensPerTask: p64(900_000_000)}
			in.MaxTokens = 5_000_001
		}, TaskTooLarge},
		{"server cap applies to established too", func(in *Input) {
			in.Trust = Trust{Tier: TierEstablished, MaxTokensPerTask: p64(999_999)}
		}, TaskTooLarge},
		{"server cap zero or negative is ignored, donor caps remain", func(in *Input) {
			in.Trust = Trust{Tier: "new", MaxTokensPerTask: p64(0), MaxTokensPerDay: p64(-1)}
			in.MaxTokens = 2_000_000
		}, OK},
		{"new ceiling disabled, global applies", func(in *Input) {
			in.Trust.Tier = "new"
			in.Global.NewProjectMaxTokensPerTask = 0
			in.MaxTokens = 5_000_000
		}, OK},

		// Daily cap boundary (reservation of the whole max_tokens).
		{"daily exactly fills", func(in *Input) { in.GlobalUsage.Day = 9_000_000 }, OK},
		{"daily one over", func(in *Input) { in.GlobalUsage.Day = 9_000_001 }, DailyCap},
		{"daily already exhausted", func(in *Input) { in.GlobalUsage.Day = 10_000_000 }, DailyCap},
		{"daily cap disabled", func(in *Input) { in.Global.TokensPerDay = 0; in.GlobalUsage.Day = 1 << 40 }, OK},
		// Weekly.
		{"weekly exactly fills", func(in *Input) { in.GlobalUsage.Week = 39_000_000 }, OK},
		{"weekly one over", func(in *Input) { in.GlobalUsage.Week = 39_000_001 }, WeeklyCap},
		// Per project.
		{"project daily exactly fills", func(in *Input) { in.Project.TokensPerDay = p64(3_000_000); in.ProjectUsage.Day = 2_000_000 }, OK},
		{"project daily one over", func(in *Input) { in.Project.TokensPerDay = p64(3_000_000); in.ProjectUsage.Day = 2_000_001 }, ProjectDailyCap},
		{"project weekly one over", func(in *Input) { in.Project.TokensPerWeek = p64(3_000_000); in.ProjectUsage.Week = 2_000_001 }, ProjectWeekCap},
		{"project usage irrelevant without project cap", func(in *Input) { in.ProjectUsage = Usage{Day: 9_000_000, Week: 9_000_000} }, OK},
		{"global cap binds before a looser project cap", func(in *Input) {
			in.Project.TokensPerDay = p64(100_000_000)
			in.GlobalUsage.Day = 9_500_000
		}, DailyCap},
		// Server-published daily cap.
		{"server daily cap exactly fills", func(in *Input) { in.Trust.MaxTokensPerDay = p64(4_000_000); in.ProjectUsage.Day = 3_000_000 }, OK},
		{"server daily cap one over", func(in *Input) { in.Trust.MaxTokensPerDay = p64(4_000_000); in.ProjectUsage.Day = 3_000_001 }, ServerDailyCap},

		// Concurrency.
		{"one running, max 1", func(in *Input) { in.Active = 1 }, Concurrency},
		{"one running, max 2", func(in *Input) { in.Active = 1; in.Global.MaxConcurrent = 2 }, OK},
		{"two running, max 2", func(in *Input) { in.Active = 2; in.Global.MaxConcurrent = 2 }, Concurrency},
		{"max_concurrent 0 behaves as 1", func(in *Input) { in.Global.MaxConcurrent = 0; in.Active = 1 }, Concurrency},

		// Git hosts.
		{"host not allowed", func(in *Input) { in.RepoURL = "https://gitlab.com/x/y" }, GitHost},
		{"host case-insensitive", func(in *Input) { in.RepoURL = "https://GitHub.com/x/y" }, OK},
		{"subdomain is a different host", func(in *Input) { in.RepoURL = "https://evil.github.com/x/y" }, GitHost},
		{"suffix trick", func(in *Input) { in.RepoURL = "https://github.com.evil.example/x/y" }, GitHost},
		{"userinfo trick", func(in *Input) { in.RepoURL = "https://github.com@evil.example/x/y" }, GitHost},
		{"credentials in URL", func(in *Input) { in.RepoURL = "https://user:pw@github.com/x/y" }, GitHost},
		{"port keeps host", func(in *Input) { in.RepoURL = "https://github.com:8443/x/y" }, OK},
		{"ssh scheme refused", func(in *Input) { in.RepoURL = "ssh://git@github.com/x/y" }, GitHost},
		{"http scheme refused", func(in *Input) { in.RepoURL = "http://github.com/x/y" }, GitHost},
		{"ext transport refused", func(in *Input) { in.RepoURL = "ext::sh -c id" }, GitHost},
		{"option injection refused", func(in *Input) { in.RepoURL = "--upload-pack=id" }, GitHost},
		{"file URL refused by default", func(in *Input) { in.RepoURL = "file:///tmp/repo" }, GitHost},
		{"file URL allowed explicitly", func(in *Input) {
			in.RepoURL = "file:///tmp/repo"
			in.Global.AllowedGitHosts = []string{"file"}
		}, OK},
		{"file URL with host refused", func(in *Input) {
			in.RepoURL = "file://server/share/repo"
			in.Global.AllowedGitHosts = []string{"file"}
		}, GitHost},
		{"empty allow-list refuses all", func(in *Input) { in.Global.AllowedGitHosts = nil }, GitHost},

		// Backoff.
		{"in backoff", func(in *Input) { in.BackoffUntil = in.Now.Add(time.Second) }, Backoff},
		{"backoff just ended", func(in *Input) { in.BackoffUntil = in.Now }, OK},
		{"backoff long past", func(in *Input) { in.BackoffUntil = in.Now.Add(-time.Hour) }, OK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := base()
			c.mut(&in)
			d := Evaluate(in)
			if d.Code != c.want || d.Allow != (c.want == OK) {
				t.Fatalf("got allow=%v code=%q (%s), want code %q", d.Allow, d.Code, d.Reason, c.want)
			}
			if !d.Allow && d.Reason == "" {
				t.Fatal("refusal without a reason")
			}
		})
	}
}

// The backoff refusal names what started it; older state has no cause.
func TestBackoffReasonNamesTheCause(t *testing.T) {
	for cause, want := range map[string]string{
		"":               "backing off after a rate limit for another 1m0s",
		CauseUnreachable: "backing off after the model API was unreachable for another 1m0s",
	} {
		in := base()
		in.BackoffUntil, in.BackoffCause = in.Now.Add(time.Minute), cause
		if d := Evaluate(in); d.Code != Backoff || d.Reason != want {
			t.Errorf("cause %q: %s %q", cause, d.Code, d.Reason)
		}
	}
}

func TestSchedule(t *testing.T) {
	night := sched(t, "02:00-06:00")
	wrap := sched(t, "22:00-06:00")
	two := sched(t, "02:00-06:00", "12:30-13:00")
	cases := []struct {
		name string
		ws   []Window
		at   string
		in   bool
	}{
		{"empty = always", nil, "2026-10-07 15:00:00", true},
		{"before window", night, "2026-10-07 01:59:59", false},
		{"window start inclusive", night, "2026-10-07 02:00:00", true},
		{"inside", night, "2026-10-07 04:30:00", true},
		{"last minute", night, "2026-10-07 05:59:59", true},
		{"window end exclusive", night, "2026-10-07 06:00:00", false},
		{"after window", night, "2026-10-07 23:00:00", false},
		{"wrap: before start", wrap, "2026-10-07 21:59:59", false},
		{"wrap: at start", wrap, "2026-10-07 22:00:00", true},
		{"wrap: just before midnight", wrap, "2026-10-07 23:59:59", true},
		{"wrap: at midnight", wrap, "2026-10-08 00:00:00", true},
		{"wrap: early morning", wrap, "2026-10-08 05:59:00", true},
		{"wrap: at end", wrap, "2026-10-08 06:00:00", false},
		{"wrap: midday", wrap, "2026-10-08 12:00:00", false},
		{"two windows: second", two, "2026-10-07 12:45:00", true},
		{"two windows: between", two, "2026-10-07 09:00:00", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			now := at(c.at)
			if got := InSchedule(c.ws, now); got != c.in {
				t.Fatalf("InSchedule = %v, want %v", got, c.in)
			}
			in := base()
			in.Now, in.Global.Schedule = now, c.ws
			d := Evaluate(in)
			if d.Allow != c.in {
				t.Fatalf("Evaluate allow=%v (%s)", d.Allow, d.Reason)
			}
			if !c.in {
				if d.Code != OutsideSchedule || d.RetryAfter <= 0 || d.RetryAfter > 24*time.Hour {
					t.Fatalf("bad refusal: %+v", d)
				}
				if !InSchedule(c.ws, now.Add(d.RetryAfter)) {
					t.Fatalf("schedule is still closed after RetryAfter %s", d.RetryAfter)
				}
			}
		})
	}
	// A project schedule replaces the global one.
	in := base()
	in.Now = at("2026-10-07 12:00:00")
	in.Global.Schedule = night
	open := sched(t, "11:00-13:00")
	in.Project.Schedule = &open
	if d := Evaluate(in); !d.Allow {
		t.Fatalf("project schedule should apply: %s", d.Reason)
	}
	empty := []Window{}
	in.Project.Schedule = &empty
	if d := Evaluate(in); !d.Allow {
		t.Fatalf("empty project schedule means always: %s", d.Reason)
	}

	for _, bad := range []string{"", "02:00", "2:00-6:00", "02:00-25:00", "02:60-03:00", "aa:bb-cc:dd", "02:00-02:00", "02:00_06:00", "24:01-01:00"} {
		if _, err := ParseWindow(bad); err == nil {
			t.Errorf("ParseWindow(%q) accepted", bad)
		}
	}
	if w, err := ParseWindow("00:00-24:00"); err == nil {
		t.Errorf("00:00-24:00 is an empty window after normalisation, got %+v", w)
	}
	if w, err := ParseWindow(" 22:00 - 06:00 "); err != nil || w != (Window{22 * 60, 6 * 60}) {
		t.Errorf("whitespace tolerant parse: %+v %v", w, err)
	}
}

func TestDayAndWeekStart(t *testing.T) {
	cases := []struct{ now, day, week string }{
		{"2026-10-07 12:34:56", "2026-10-07 00:00:00", "2026-10-05 00:00:00"}, // Wednesday
		{"2026-10-05 00:00:00", "2026-10-05 00:00:00", "2026-10-05 00:00:00"}, // Monday midnight
		{"2026-10-04 23:59:59", "2026-10-04 00:00:00", "2026-09-28 00:00:00"}, // Sunday belongs to the previous Monday
		{"2026-10-11 23:59:59", "2026-10-11 00:00:00", "2026-10-05 00:00:00"},
		{"2026-10-12 00:00:00", "2026-10-12 00:00:00", "2026-10-12 00:00:00"}, // rollover
		{"2027-01-01 08:00:00", "2027-01-01 00:00:00", "2026-12-28 00:00:00"}, // week spans the year
	}
	for _, c := range cases {
		if got := DayStart(at(c.now)); !got.Equal(at(c.day)) {
			t.Errorf("DayStart(%s) = %s, want %s", c.now, got, c.day)
		}
		if got := WeekStart(at(c.now)); !got.Equal(at(c.week)) {
			t.Errorf("WeekStart(%s) = %s, want %s", c.now, got, c.week)
		}
	}
	// Across a DST change the day still starts at local midnight.
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	dst := time.Date(2026, 10, 25, 12, 0, 0, 0, loc) // clocks go back this night
	if d := DayStart(dst); d.Hour() != 0 || d.Day() != 25 {
		t.Errorf("DayStart across DST: %s", d)
	}
	if w := WeekStart(dst.AddDate(0, 0, 1)); w.Weekday() != time.Monday || w.Hour() != 0 || w.Day() != 26 {
		t.Errorf("WeekStart after DST: %s", w)
	}
}

func TestBackoff(t *testing.T) {
	now := at("2026-10-07 12:00:00")
	var s BackoffState
	prev := time.Duration(0)
	for i := 1; i <= 12; i++ {
		s = NextBackoff(s, now, time.Time{}, 0.5) // 0.5 = no jitter
		d := s.Until.Sub(now)
		if s.Attempts != i || d < prev || d > BackoffMax {
			t.Fatalf("attempt %d: delay %s (prev %s)", i, d, prev)
		}
		prev = d
	}
	if prev != BackoffMax {
		t.Fatalf("delay should saturate at %s, got %s", BackoffMax, prev)
	}
	first := NextBackoff(BackoffState{}, now, time.Time{}, 0.5).Until.Sub(now)
	if first != BackoffBase {
		t.Fatalf("first delay %s", first)
	}
	lo := NextBackoff(BackoffState{}, now, time.Time{}, 0).Until.Sub(now)
	hi := NextBackoff(BackoffState{}, now, time.Time{}, 0.999).Until.Sub(now)
	if lo >= first || hi <= first || lo < BackoffBase*8/10 || hi > BackoffBase*12/10 {
		t.Fatalf("jitter out of ±20%%: %s .. %s", lo, hi)
	}
	// A provider-supplied reset time is a floor.
	reset := now.Add(3 * time.Hour)
	if got := NextBackoff(BackoffState{}, now, reset, 0.5).Until; got.Before(reset) {
		t.Fatalf("backoff %s ends before the reset %s", got, reset)
	}
	if got := NextBackoff(BackoffState{}, now, now.Add(-time.Hour), 0.5).Until.Sub(now); got != BackoffBase {
		t.Fatalf("past reset time must be ignored, got %s", got)
	}
}
