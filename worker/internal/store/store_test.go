package store

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/agentfund/agentfund/worker/internal/policy"
)

func at(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", s, time.Local)
	if err != nil {
		panic(err)
	}
	return t
}

// decider applies a daily and weekly cap the way the pipeline does.
func decider(now time.Time, day, week, max int64, maxConc int) func(g, p policy.Usage, active int, b policy.BackoffState) policy.Decision {
	return func(g, p policy.Usage, active int, b policy.BackoffState) policy.Decision {
		return policy.Evaluate(policy.Input{
			Now: now, GlobalUsage: g, ProjectUsage: p, Active: active, BackoffUntil: b.Until,
			Global:    policy.Limits{TokensPerDay: day, TokensPerWeek: week, MaxConcurrent: maxConc, AllowedGitHosts: []string{"github.com"}},
			Trust:     policy.Trust{Tier: policy.TierEstablished},
			MaxTokens: max, RepoURL: "https://github.com/a/b",
		})
	}
}

func refusedWith(t *testing.T, err error, code policy.Code) {
	t.Helper()
	var r *ErrRefused
	if !errors.As(err, &r) || r.Decision.Code != code {
		t.Fatalf("want refusal %q, got %v", code, err)
	}
}

func TestReservationAndSettlement(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "state.json"))
	now := at("2026-10-07 10:00") // Wednesday
	const day, week = 3_000_000, 5_000_000

	// Reserve 1M: counts fully while running.
	if err := s.Reserve(Run{Claim: "clm_a", Project: "p", Task: "t1", Reserved: 1_000_000}, now, decider(now, day, week, 1_000_000, 4)); err != nil {
		t.Fatal(err)
	}
	st, _ := s.Snapshot()
	g, p, active := UsageOf(st, now, "p")
	if g.Day != 1_000_000 || g.Week != 1_000_000 || p.Day != 1_000_000 || active != 1 {
		t.Fatalf("after reserve: %+v %+v active=%d", g, p, active)
	}
	// Heartbeat progress below the reservation does not change what is counted.
	if err := s.Progress("clm_a", 200_000, 50_000, "agent", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	st, _ = s.Snapshot()
	if g, _, _ := UsageOf(st, now, "p"); g.Day != 1_000_000 {
		t.Fatalf("progress changed the reservation: %+v", g)
	}

	// A second and third reservation fill the day exactly; a fourth is refused.
	for _, c := range []string{"clm_b", "clm_c"} {
		if err := s.Reserve(Run{Claim: c, Project: "p", Reserved: 1_000_000}, now, decider(now, day, week, 1_000_000, 4)); err != nil {
			t.Fatal(err)
		}
	}
	refusedWith(t, s.Reserve(Run{Claim: "clm_d", Project: "p", Reserved: 1_000_000}, now, decider(now, day, week, 1_000_000, 4)), policy.DailyCap)
	refusedWith(t, s.Reserve(Run{Claim: "clm_d", Project: "p", Reserved: 1}, now, decider(now, day, week, 1, 4)), policy.DailyCap)
	st, _ = s.Snapshot()
	if len(st.Runs) != 3 {
		t.Fatalf("refused reservation was recorded: %d runs", len(st.Runs))
	}

	// Settling to the actual usage frees the difference.
	if err := s.Settle("clm_a", now.Add(time.Minute), Run{TokensIn: 240_000, TokensOut: 60_000, Status: "completed"}); err != nil {
		t.Fatal(err)
	}
	st, _ = s.Snapshot()
	g, _, active = UsageOf(st, now, "p")
	if g.Day != 2_300_000 || active != 2 {
		t.Fatalf("after settle: %+v active=%d", g, active)
	}
	if err := s.Reserve(Run{Claim: "clm_e", Project: "p", Reserved: 700_000}, now, decider(now, day, week, 700_000, 4)); err != nil {
		t.Fatalf("freed budget should be usable: %v", err)
	}
	refusedWith(t, s.Reserve(Run{Claim: "clm_f", Project: "p", Reserved: 1000}, now, decider(now, day, week, 1000, 4)), policy.DailyCap)

	// A run that overshot its reservation counts at its actual usage even before settlement.
	if err := s.Progress("clm_b", 1_200_000, 100_000, "agent", time.Time{}); err != nil {
		t.Fatal(err)
	}
	st, _ = s.Snapshot()
	if g, _, _ := UsageOf(st, now, "p"); g.Day != 300_000+1_300_000+1_000_000+700_000 {
		t.Fatalf("overshoot not counted: %+v", g)
	}

	// Duplicate claim ids are rejected.
	if err := s.Reserve(Run{Claim: "clm_e", Project: "p", Reserved: 1}, now, decider(now, 0, 0, 1, 9)); err == nil {
		t.Fatal("duplicate claim accepted")
	}
	// Settling an unknown claim is an error.
	if err := s.Settle("clm_zzz", now, Run{}); err == nil {
		t.Fatal("settled an unknown claim")
	}
}

func TestDayAndWeekRollover(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "state.json"))
	add := func(claim, when string, tokens int64) {
		t.Helper()
		now := at(when)
		if err := s.Reserve(Run{Claim: claim, Project: "p", Reserved: tokens}, now, decider(now, 0, 0, tokens, 99)); err != nil {
			t.Fatal(err)
		}
		if err := s.Settle(claim, now, Run{TokensIn: tokens, Status: "completed"}); err != nil {
			t.Fatal(err)
		}
	}
	add("clm_sun", "2026-10-04 23:30", 100) // Sunday of the previous week
	add("clm_mon", "2026-10-05 00:00", 200) // Monday 00:00 starts the week
	add("clm_tue", "2026-10-06 23:59", 400)
	add("clm_wed", "2026-10-07 00:00", 800)
	add("clm_oth", "2026-10-07 09:00", 1600)
	if err := s.Update(func(st *State) error { st.Runs[len(st.Runs)-1].Project = "other"; return nil }); err != nil {
		t.Fatal(err)
	}

	st, _ := s.Snapshot()
	check := func(when string, wantDay, wantWeek, wantProjDay, wantProjWeek int64) {
		t.Helper()
		g, p, _ := UsageOf(st, at(when), "p")
		if g.Day != wantDay || g.Week != wantWeek || p.Day != wantProjDay || p.Week != wantProjWeek {
			t.Errorf("%s: global %+v project %+v, want day=%d week=%d pday=%d pweek=%d", when, g, p, wantDay, wantWeek, wantProjDay, wantProjWeek)
		}
	}
	check("2026-10-07 12:00", 2400, 3000, 800, 1400) // Wednesday: Mon+Tue+Wed(+other)
	check("2026-10-08 00:00", 0, 3000, 0, 1400)      // day rolled over, week did not
	check("2026-10-11 23:59", 0, 3000, 0, 1400)      // Sunday, same week
	check("2026-10-12 00:00", 0, 0, 0, 0)            // Monday: week rolled over

	// The weekly cap binds across days and resets on Monday.
	now := at("2026-10-09 10:00")
	refusedWith(t, s.Reserve(Run{Claim: "clm_x", Project: "p", Reserved: 1001}, now, decider(now, 0, 4000, 1001, 9)), policy.WeeklyCap)
	if err := s.Reserve(Run{Claim: "clm_x", Project: "p", Reserved: 1000}, now, decider(now, 0, 4000, 1000, 9)); err != nil {
		t.Fatalf("exactly filling the week must be allowed: %v", err)
	}
	now = at("2026-10-12 00:00")
	if err := s.Reserve(Run{Claim: "clm_y", Project: "p", Reserved: 4000}, now, decider(now, 0, 4000, 4000, 9)); err != nil {
		t.Fatalf("new week should have a fresh budget: %v", err)
	}
}

func TestStateSurvivesReopenAndPrunes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	now := at("2026-10-07 10:00")
	s := Open(path)
	if err := s.Reserve(Run{Claim: "clm_old", Project: "p", Reserved: 5}, now.Add(-Retention-time.Hour), decider(now, 0, 0, 5, 9)); err != nil {
		t.Fatal(err)
	}
	_ = s.Settle("clm_old", now, Run{TokensIn: 5, Status: "completed"})
	if err := s.Reserve(Run{Claim: "clm_new", Project: "p", Reserved: 7}, now, decider(now, 0, 0, 7, 9)); err != nil {
		t.Fatal(err)
	}
	if err := s.SetBackoff(policy.BackoffState{Attempts: 2, Until: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	st, err := Open(path).Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Runs) != 1 || st.Runs[0].Claim != "clm_new" || st.Backoff.Attempts != 2 {
		t.Fatalf("unexpected state after reopen: %+v", st)
	}
	// Backoff persisted in the store refuses reservations.
	refusedWith(t, Open(path).Reserve(Run{Claim: "clm_z", Project: "p", Reserved: 1}, now, decider(now, 0, 0, 1, 9)), policy.Backoff)
}

func TestRecoverStale(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "state.json"))
	now := at("2026-10-07 10:00")
	_ = s.Reserve(Run{Claim: "clm_dead", Project: "p", Reserved: 1000, PID: 111}, now, decider(now, 0, 0, 1000, 9))
	_ = s.Reserve(Run{Claim: "clm_live", Project: "p", Reserved: 1000, PID: 222}, now, decider(now, 0, 0, 1000, 9))
	_ = s.Progress("clm_dead", 30, 12, "agent", time.Time{})
	rec, err := s.RecoverStale(now, func(pid int) bool { return pid == 222 })
	if err != nil || len(rec) != 1 || rec[0].Claim != "clm_dead" {
		t.Fatalf("recovered %+v err %v", rec, err)
	}
	st, _ := s.Snapshot()
	g, _, active := UsageOf(st, now, "p")
	if g.Day != 42+1000 || active != 1 {
		t.Fatalf("after recovery: %+v active=%d", g, active)
	}
}

// Concurrent reservations must never overshoot the cap.
func TestConcurrentReservationsRespectCap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	now := at("2026-10-07 10:00")
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			err := Open(path).Reserve(Run{Claim: "clm_" + string(rune('a'+i)), Project: "p", Reserved: 1000}, now, decider(now, 5000, 0, 1000, 99))
			if err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if ok != 5 {
		t.Fatalf("%d reservations succeeded, want exactly 5", ok)
	}
}
